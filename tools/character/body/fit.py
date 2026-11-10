"""Passning av mallen mot en AI-kropp: landmärken -> grov passning med strålar -> icke-stel ICP med utjämning.

  .venv/bin/python tools/fit.py <kropp.glb> <namn> [--height 1.80] [--sym]

1. Kroppen skalas till längden (--height) och snittas vågrätt var centimeter; delarna i varje snitt (ben, armar,
   bål) ger landmärkena: gren, armhåla, halsens smalaste ställe, fingertoppar, fotled, häl och tå.
2. Skelettet (axlar per del) läggs i landmärkena, och varje mallhörn får sin plats med en stråle från delens axel
   (rad t, vinkel runt axeln, kåpvinkel psi) till första träffen på AI-kroppen. Armhålens slingor skjuts ut från
   axelleden, benöppningarna från bålen och grenbryggan läggs mellan dem.
3. Icke-stel ICP på nivå 3 och sedan nivå 6: närmaste punkt på AI-kroppen (med normalkontroll) dras mot, med en
   Laplace-term som håller mallens lokala form; vikten för formen sänks steg för steg.
4. --sym gör passningen spegelsymmetrisk (medel av hörnet och dess spegelhörn).
Skriver build/fit/<namn>.npz (hörn per nivå 6, landmärken) och build/fit/<namn>.json (mätvärden per del)."""
import argparse, json, sys, time
from pathlib import Path

import numpy as np
import open3d as o3d
import scipy.sparse as sp
import scipy.sparse.linalg as spla
import trimesh
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from template import Template, FINE, HOLE_ROWS, HOLE_COLS_L, TORSO_T  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
T_CHIN = 0.24   # hakans rad i huvudet (andel av halssöm -> hjässa)
KNUCKLE = 0.52  # knogarna som andel av handled -> fingertopp


# ---------- AI-kroppen ----------
def upright(m):
    """Ställer en stående kropp upprätt: längsta huvudaxeln blir Y (huvudänden, den smalare, uppåt), bredden X
    (armarna ut) och djupet Z, med framsidan mot +Z (tårna sticker ut framåt från underbenen)."""
    V = np.asarray(m.vertices)
    c = V.mean(0)
    w, U = np.linalg.eigh(np.cov((V - c).T))
    up, wide, deep = U[:, 2], U[:, 1], U[:, 0]
    h = (V - c) @ up
    lo, hi = h < np.percentile(h, 8), h > np.percentile(h, 92)
    spread = lambda sel: np.ptp((V[sel] - c) @ wide)
    if spread(hi) > spread(lo):
        up = -up
        h = -h
    feet = h < np.percentile(h, 3)
    shins = (h > np.percentile(h, 5)) & (h < np.percentile(h, 12))
    if ((V[feet] - c) @ deep).mean() < ((V[shins] - c) @ deep).mean():
        deep = -deep
    wide = np.cross(up, deep)
    R = np.stack([wide, up, deep])
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = -R @ c
    m.apply_transform(M)
    m.metadata["M"] = M
    return m


def load_target(path, height):
    m = upright(trimesh.load(path, force="mesh"))
    M = m.metadata["M"]
    k = height / (m.bounds[1, 1] - m.bounds[0, 1])
    m.apply_scale(k)
    t = np.array([-(m.bounds[0, 0] + m.bounds[1, 0]) / 2, -m.bounds[0, 1], 0])
    m.apply_translation(t)
    S = np.eye(4)
    S[:3, :3] *= k
    S[:3, 3] = t
    m.metadata["M"] = S @ M     # hela flytten från AI-filen till passningens rum
    return m


def export_target(glb, M, out):
    """AI-kroppen med sin textur, flyttad till passningens rum (för bakningen)."""
    sc = trimesh.load(glb)
    sc.apply_transform(M)
    sc.export(out)


class Surface:
    """AI-ytan för strålar och närmaste punkt (Open3D)."""

    def __init__(self, m, faces=None):
        self.m = m
        F = np.asarray(m.faces if faces is None else m.faces[faces], np.int32)
        self.fsel = np.arange(len(m.faces)) if faces is None else np.asarray(faces)
        tm = o3d.t.geometry.TriangleMesh(o3d.core.Tensor(np.asarray(m.vertices, np.float32)), o3d.core.Tensor(F))
        self.scene = o3d.t.geometry.RaycastingScene()
        self.scene.add_triangles(tm)
        self.fn = np.asarray(m.face_normals)

    def ray(self, o, d, miss_r=0.08):
        """Avstånd till första träffen; missar får avståndet till närmaste ytpunkt från o + miss_r d."""
        r = np.concatenate([o, d], 1).astype(np.float32)
        ans = self.scene.cast_rays(o3d.core.Tensor(r))
        t = ans["t_hit"].numpy().astype(float)
        miss = ~np.isfinite(t)
        if miss.any():
            p = o[miss] + miss_r * d[miss]
            q, _ = self.closest(p)
            t[miss] = np.einsum("ij,ij->i", q - o[miss], d[miss]).clip(0.005, None)
        return t

    def closest(self, p):
        ans = self.scene.compute_closest_points(o3d.core.Tensor(p.astype(np.float32)))
        q = ans["points"].numpy().astype(float)
        n = self.fn[self.fsel[ans["primitive_ids"].numpy()]]
        return q, n

    def unsigned(self, p):
        return self.scene.compute_distance(o3d.core.Tensor(p.astype(np.float32))).numpy()


# ---------- landmärken ----------
def slices(P, step=0.01, res=0.006):
    out = []
    for y in np.arange(step, P[:, 1].max(), step):
        sl = P[np.abs(P[:, 1] - y) < step * 0.6]
        if len(sl) < 10:
            continue
        ij = np.floor((sl[:, [0, 2]] + 1) / res).astype(int)
        img = np.zeros((int(2 / res) + 2,) * 2, bool)
        img[ij[:, 0], ij[:, 1]] = 1
        img = ndimage.binary_closing(ndimage.binary_dilation(img, iterations=2), iterations=2)
        lab, nc = ndimage.label(img)
        comps = []
        for c in range(1, nc + 1):
            ii = np.argwhere(lab == c) * res - 1
            if len(ii) < 30:
                continue
            comps.append(dict(x0=ii[:, 0].min(), x1=ii[:, 0].max(), z0=ii[:, 1].min(), z1=ii[:, 1].max(),
                              cx=(ii[:, 0].min() + ii[:, 0].max()) / 2, cz=(ii[:, 1].min() + ii[:, 1].max()) / 2))
        out.append((y, sorted(comps, key=lambda c: c["cx"])))
    return out


def landmarks(m, surf=None):
    P, _ = trimesh.sample.sample_surface_even(m, 400000, seed=1)
    H = P[:, 1].max()
    S = slices(P)
    central = lambda comps: min(comps, key=lambda c: abs(c["cx"]))
    # gren: lägsta snittet ovanför knäna där en mittdel går över x = 0
    crotch = crotch0 = next(y for y, c in S if y > 0.3 * H and any(k["x0"] < 0 < k["x1"] and k["x1"] - k["x0"] > 0.12 * H / 1.8 for k in c))
    # snitten sluter smala glipor; grenen är där en punkt mitt i kroppen har kött åt båda sidor (strålar i sidled)
    if surf is not None:
        for y in np.arange(crotch - 0.04, crotch + 0.2, 0.004):
            cc = central(min(S, key=lambda yc: abs(yc[0] - y))[1])
            o = np.array([[0, y, cc["cz"]]] * 2)
            if surf.ray(o, np.array([[1.0, 0, 0], [-1.0, 0, 0]])).min() > 0.05 * H / 1.8:
                crotch = y
                break
    # armhåla: högsta snittet under axlarna med minst tre delar (bål och två armar)
    armpit = max(y for y, c in S if crotch < y < 0.85 * H and len(c) >= 3)
    # armarna: delen längst ut på var sida, från armhålan ned till fingertopparna
    arms = {"L": [], "R": []}
    for y, c in S:
        if y > armpit:
            continue
        mid = [k for k in c if k["x0"] < 0 < k["x1"]] if y > crotch else []
        legs = sorted(c, key=lambda k: abs(k["cx"]))[:2] if y <= crotch else []
        inner = max([max(abs(k["x0"]), abs(k["x1"])) for k in mid + legs] or [0])
        for side, sgn in (("L", 1), ("R", -1)):
            cand = [k for k in c if sgn * k["cx"] > 0 and min(abs(k["x0"]), abs(k["x1"])) > inner - 0.005 and k not in mid + legs]
            if cand:
                k = max(cand, key=lambda k: sgn * k["cx"])
                arms[side].append((y, k["cx"], k["cz"]))
    # hjässa: högsta snittet där mittdelen är bredare än en hästsvans eller knut (8 cm); håret ovanför räknas inte
    crown = max(y for y, c in S if y > 0.8 * H and any(abs(k["cx"]) < 0.06 * H / 1.8 and k["x1"] - k["x0"] > 0.08 * H / 1.8 for k in c))
    # hals: smalaste mittsnittet mellan axlar och huvud
    band = [(y, central(c)) for y, c in S if armpit + 0.12 * H / 1.8 < y < crown - 0.12 * H / 1.8]
    neck_min = min(band, key=lambda yc: yc[1]["x1"] - yc[1]["x0"])[0]
    # halssömmen strax ovanför nyckelbenen: under halsens smalaste ställe och högst 14 % av längden under hjässan,
    # så att den hamnar på samma ställe hos en tjocknackad kropp (där halsen är smalast vid käken)
    neck = min(neck_min - 0.02 * H / 1.8, 0.86 * crown)
    # benen: de två delarna närmast mitten under grenen
    legs = {"L": [], "R": []}
    for y, c in S:
        if y >= crotch0:   # benens mittlinjer bara där snitten skiljer benen åt; ovanför förlängs de
            break
        for k in sorted(c, key=lambda k: abs(k["cx"]))[:2]:
            legs["L" if k["cx"] > 0 else "R"].append((y, k["cx"], k["cz"], k["z1"] - k["z0"]))
    # fotled: lägsta höjd (ovanför fotsulan) där benets snitt är mindre än halva fotlängden framifrån-bakåt
    low = P[(P[:, 1] < 0.04 * H) & (P[:, 0] > 0)]
    foot_len = np.ptp(low[:, 2])
    ankle = next(l[0] for l in legs["L"] if l[0] > 0.035 * H and l[3] < 0.5 * foot_len)
    lm = dict(H=H, crown=crown, crotch=crotch, armpit=armpit, neck=neck, neck_min=neck_min, ankle=ankle, P=P)
    # bålens axel: mittdelens mitt per höjd
    # haka: där framprofilen (punkter nära x = 0) hoppar framåt från halsen till hakan, i nedre halvan av huvudet
    fr = P[(np.abs(P[:, 0]) < 0.012) & (P[:, 1] > neck)]
    ys = np.arange(max(neck, neck_min - 0.02 * H / 1.8), neck + 0.5 * (crown - neck), 0.003)
    zf = np.array([fr[np.abs(fr[:, 1] - y) < 0.002, 2].max() if (np.abs(fr[:, 1] - y) < 0.002).any() else np.nan for y in ys])
    zf = np.interp(np.arange(len(ys)), np.where(np.isfinite(zf))[0], zf[np.isfinite(zf)])
    lm["chin"] = float(ys[int(np.argmax(np.gradient(ndimage.uniform_filter1d(zf, 3))))])
    lm["torso_axis"] = [(y, central(c)["cx"], central(c)["cz"]) for y, c in S if crotch - 0.03 <= y <= H]
    lm["arms"], lm["legs"] = {s: np.array(v) for s, v in arms.items()}, {s: np.array(v)[:, :3] for s, v in legs.items()}
    # fötterna: häl, tå och mitt ur punkterna under fotleden
    for side, sgn in (("L", 1), ("R", -1)):
        F = P[(P[:, 1] < ankle) & (sgn * P[:, 0] > 0)]
        toe = F[F[:, 2] > F[:, 2].max() - 0.04]
        lm[f"heel_{side}"] = float(F[:, 2].min())
        # tåns höjd ur tårna själva (de främsta 4 cm), inte hela foten: platta tår ligger under fotens 30-percentil
        lm[f"toe_{side}"] = np.array([toe[:, 0].mean(), min(np.percentile(F[:, 1], 30), np.median(toe[:, 1])), F[:, 2].max()])
    head = P[(P[:, 1] > crown - 0.05 * H / 1.8) & (P[:, 1] < crown)]
    lm["top"] = np.array([head[:, 0].mean(), crown, head[:, 2].mean()])
    return lm


def interp_axis(axis, y):
    a = np.array(axis)
    o = np.argsort(a[:, 0])
    a = a[o]
    k = 5
    sm = np.stack([ndimage.uniform_filter1d(a[:, i], k, mode="nearest") for i in (1, 2)], 1)
    y = np.asarray(y, float)
    return np.stack([np.interp(y, a[:, 0], sm[:, 0]), y, np.interp(y, a[:, 0], sm[:, 1])], -1)


def skeleton(lm):
    """Lederna ur landmärkena. Armarnas leder läggs längs armens mittlinje: axelled strax ovanför armhålan,
    armbåge och handled som andelar av längden axelled -> fingertopp."""
    H = lm["H"]
    sk = {}
    for side in "LR":
        a = lm["arms"][side]
        a = a[np.argsort(-a[:, 0])]
        tip = np.array([a[-1, 1], a[-1, 0], a[-1, 2]])
        up = a[a[:, 0] > a[0, 0] - 0.25 * H / 1.8]          # överarmens del av mittlinjen
        cx, cz = np.polyfit(up[:, 0], up[:, 1], 1), np.polyfit(up[:, 0], up[:, 2], 1)
        yS = lm["armpit"] + 0.06 * H / 1.8
        S = np.array([np.polyval(cx, yS), yS, np.polyval(cz, yS)])
        S[0] -= np.sign(S[0]) * 0.03 * H / 1.8           # leden sitter innanför armens mittlinje vid armhålan
        L = np.linalg.norm(tip - S)
        pts = np.array([[x, y, z] for y, x, z in a])

        def along(f):
            # punkt på mittlinjen på avståndet f*L från S (mittlinjen är en polylinje ned till toppen)
            chain = np.vstack([S, pts[pts[:, 1] < S[1] - 0.02], tip])
            d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(chain, axis=0), axis=1))]
            d = d / d[-1] * L
            return np.array([np.interp(f * L, d, chain[:, i]) for i in range(3)])
        # handleden: där armen är smalast (median av avståndet till linjen S -> fingertopp) mellan 66 och 80 %
        Pa = lm["P"]
        ax = (tip - S) / L
        s_ = (Pa - S) @ ax
        r_ = np.linalg.norm(Pa - S - s_[:, None] * ax, axis=1)
        near = r_ < 0.08 * H / 1.8
        fr = np.linspace(0.66, 0.80, 15)
        prof = [np.median(r_[near & (np.abs(s_ - f * L) < 0.008)]) if (near & (np.abs(s_ - f * L) < 0.008)).sum() > 20 else 1 for f in fr]
        fw = fr[int(np.argmin(prof))]
        sk[f"shoulder_{side}"], sk[f"elbow_{side}"], sk[f"wrist_{side}"], sk[f"tip_{side}"] = S, along(0.42 / 0.76 * fw), along(fw), tip
        g = lm["legs"][side]
        sk[f"leglist_{side}"] = g
        ank = g[np.argmin(np.abs(g[:, 0] - lm["ankle"]))]
        A = np.array([ank[1], lm["ankle"], ank[2]])
        sk[f"ankle_{side}"] = A
        toe = lm[f"toe_{side}"]
        heel = lm[f"heel_{side}"]
        sk[f"footctrl_{side}"] = np.array([A[0] * 0.5 + toe[0] * 0.5, 0.35 * lm["ankle"], A[2] - 0.15 * (A[2] - heel)])
        sk[f"toe_{side}"] = np.array([toe[0], min(0.4 * lm["ankle"], toe[1]), toe[2] - 0.01])
    sk["neck"] = interp_axis(lm["torso_axis"], lm["neck"])
    sk["top"] = lm["top"]
    return sk


# ---------- AI-kroppen i delar ----------
RADIUS = {"torso": 0.15, "head": 0.10, "upperarm": 0.05, "forearm": 0.045, "hand": 0.04, "leg": 0.07, "foot": 0.045}
SCENES = {"torso": ("torso", "head", "upperarm", "leg"), "head": ("head", "torso"), "shoulder": ("torso", "upperarm"),
          "upperarm": ("upperarm", "forearm"), "forearm": ("forearm", "upperarm", "hand"), "hand": ("hand", "forearm"),
          "leg": ("leg", "torso", "foot"), "foot": ("foot", "leg")}


def bones(lm, sk):
    """Skelettets segment per del (polylinjer), för att dela AI-kroppen."""
    b = {"torso": np.array([interp_axis(lm["torso_axis"], y) for y in np.linspace(lm["crotch"], lm["neck"], 12)]),
         "head": np.array([sk["neck"], sk["top"] - np.array([0, 0.06, 0]) * lm["H"] / 1.8])}
    for s_ in "LR":
        b[f"upperarm_{s_}"] = np.array([sk[f"shoulder_{s_}"], sk[f"elbow_{s_}"]])
        b[f"forearm_{s_}"] = np.array([sk[f"elbow_{s_}"], sk[f"wrist_{s_}"]])
        b[f"hand_{s_}"] = np.array([sk[f"wrist_{s_}"], sk[f"tip_{s_}"]])
        g = sk[f"leglist_{s_}"]
        g = g[(g[:, 0] < lm["crotch"]) & (g[:, 0] > lm["ankle"])][::-1]
        b[f"leg_{s_}"] = np.array([[x, y, z] for y, x, z in g])
        b[f"foot_{s_}"] = bezier(sk[f"ankle_{s_}"], sk[f"footctrl_{s_}"], sk[f"toe_{s_}"], np.linspace(0, 1, 8))
    return b


def seg_dist(P, poly):
    d = np.full(len(P), np.inf)
    for a, b in zip(poly[:-1], poly[1:]):
        ab = b - a
        t = np.clip(((P - a) @ ab) / (ab @ ab + 1e-12), 0, 1)
        d = np.minimum(d, np.linalg.norm(P - (a + t[:, None] * ab), axis=1))
    return d


def label_target(m, lm, sk):
    """Varje AI-triangel får delen vars ben ligger närmast (avstånd delat med delens typiska radie)."""
    C = m.triangles_center
    names = list(bones(lm, sk).items())
    D = np.stack([seg_dist(C, poly) / RADIUS[n.split("_")[0]] for n, poly in names], 1)
    order = np.argsort(D, 1)
    lab = order[:, 0].copy()
    # Lösa bitar (låret intill handen får handens etikett): per del behålls bara den största sammanhängande biten,
    # och övriga bitar får etiketten hos närmaste triangel utanför biten. En bit av låret hänger ihop med låret och
    # blir ben; lösa tår (en egen bit i AI-nätet) ligger an mot foten och förblir fot.
    import networkx as nx
    from scipy.spatial import cKDTree
    adj = m.face_adjacency
    for k in range(len(names)):
        sel = np.where(lab == k)[0]
        if not len(sel):
            continue
        e = adj[(lab[adj[:, 0]] == k) & (lab[adj[:, 1]] == k)]
        G = nx.Graph()
        G.add_nodes_from(sel)
        G.add_edges_from(e)
        comps = sorted(nx.connected_components(G), key=len, reverse=True)
        if len(comps) < 2:
            continue
        stray = np.concatenate([np.fromiter(c, int) for c in comps[1:]])
        out = np.setdiff1d(np.arange(len(C)), stray)
        d, j = cKDTree(C[out]).query(C[stray])
        best = dict(zip(stray, zip(d, lab[out[j]])))
        for c in comps[1:]:
            c = np.fromiter(c, int)
            lab[c] = min((best[i] for i in c), key=lambda t: t[0])[1]
    return np.array([n for n, _ in names])[lab]


def label_from_fit(m, X6):
    """AI-trianglarna etiketterade med delen hos närmaste triangel i en färdig passning (nivå 6)."""
    T6 = Template(6)
    tris, tpart = T6.triangles()
    mm = o3d.t.geometry.TriangleMesh(o3d.core.Tensor(X6.astype(np.float32)), o3d.core.Tensor(tris.astype(np.int32)))
    sc = o3d.t.geometry.RaycastingScene()
    sc.add_triangles(mm)
    ans = sc.compute_closest_points(o3d.core.Tensor(m.triangles_center.astype(np.float32)))
    return tpart[ans["primitive_ids"].numpy()]


def part_scenes(m, lab):
    out = {}
    for side in ("", "_L", "_R"):
        for key, members in SCENES.items():
            want = {p + (side if p not in ("torso", "head") else "") for p in members}
            if side == "" and key not in ("torso", "head"):
                continue
            if side and key in ("torso", "head"):
                continue
            if key == "torso":   # bålen ser båda armarnas överarmar och båda benen
                want = {"torso", "head", "upperarm_L", "upperarm_R", "leg_L", "leg_R"}
            out[key + side] = Surface(m, np.where(np.isin(lab, list(want)))[0])
    return out


# ---------- grov passning ----------
def frame(axis, lateral):
    a = axis / np.linalg.norm(axis)
    f = np.array([0, 0, 1.0]) - a[2] * a
    if np.linalg.norm(f) < 0.3:   # axeln pekar framåt (tårna): "fram" blir uppåt
        f = np.array([0, 1.0, 0]) - a[1] * a
    f /= np.linalg.norm(f)
    l = lateral - (lateral @ a) * a - (lateral @ f) * f
    l /= np.linalg.norm(l)
    return a, f, l


def bezier(p0, p1, p2, t):
    t = np.asarray(t)[..., None]
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2


def shoot(scene, o, d, clamp=2.5, miss_r=0.08):
    """Strålar mot en dels yta; träffar längre bort än clamp gånger medianen (strålen gick genom en glipa) kortas."""
    o = np.broadcast_to(o, d.shape).copy()
    t = scene.ray(o, d, miss_r)
    med = np.median(t)
    t = np.where(t > clamp * med, med, t)
    return o + d * t[:, None]


def turn(phi):
    """Riktningen (+1/-1) som en sluten slinga av vinklar går runt axeln."""
    return np.sign(np.angle(np.exp(1j * np.diff(np.r_[phi, phi[0]]))).sum())


def loop_tube(T, X, A, island, P0, P1, lat, scene, blend=0.3, center=None, miss_r=0.08):
    """Ett rör vars första slinga redan har läge: vinklarna tas ur slingan runt axeln P0 -> P1 och jämnas ut mot lika
    steg fram till t = blend; varje ring skjuts ut från axeln (eller från center(t), en mittlinje genom AI-delen)."""
    rings = T.rings[island]
    loop = rings[0]
    a, f, l = frame(P1 - P0, lat)
    rel = X[loop] - P0
    phi = np.arctan2(rel @ l, rel @ f)
    K2, tr = len(loop), turn(phi)
    uni = phi[0] + tr * 2 * np.pi * np.arange(K2) / K2
    phic = phi[0] + tr * np.cumsum(np.r_[0, np.abs(np.angle(np.exp(1j * np.diff(phi))))])
    for ring in rings[1:]:
        tt, psi = A["t"][ring[0]], np.radians(A["psi"][ring[0]])
        o = P0 + tt * (P1 - P0) if center is None else center(tt)
        if len(ring) == 1:
            d = a[None]
        else:
            w = min(1, tt / blend)
            ph = (1 - w) * phic + w * uni
            d = np.cos(psi) * (np.cos(ph)[:, None] * f + np.sin(ph)[:, None] * l) + np.sin(psi) * a
        X[ring] = shoot(scene, o, d, miss_r=miss_r)


def coarse(T, sc, lm, sk):
    """Grov passning: varje hörn får en stråle (origo, riktning) ur delens axel och flyttas till första träffen
    på sin egen del av AI-kroppen (sc: ytor per del)."""
    A = T.arrays()
    N = len(A["key"])
    O, D = np.zeros((N, 3)), np.zeros((N, 3))
    n = T.n
    K = 32 * n
    tor_axis = lm["torso_axis"]
    t_hole = TORSO_T[HOLE_ROWS[0]]

    def torso_y(t):
        return np.where(t <= t_hole, lm["crotch"] + t / t_hole * (lm["armpit"] - lm["crotch"]),
                        lm["armpit"] + (t - t_hole) / (1 - t_hole) * (lm["neck"] - lm["armpit"]))
    # bål: vågräta strålar ur bålens axel; nedersta raderna lyfts vid höfterna (benöppningen)
    idx = np.where(A["part"] == "torso")[0]
    idx = idx[A["ring"][idx] >= 0]
    th = 2 * np.pi * A["col"][idx] / K
    t = A["t"][idx]
    lift = (0.03 + 0.12 * np.sin(th) ** 2) * np.clip(1 - t / 0.3, 0, 1)
    y = torso_y(t + lift)
    O[idx] = interp_axis(tor_axis, y)
    D[idx] = np.stack([np.sin(th), 0 * th, np.cos(th)], 1)
    # huvud: ur axeln hals -> hjässa; kåpan ur huvudets mitt
    idx = np.where(A["part"] == "head")[0]
    N0, top = sk["neck"], sk["top"]
    ax = top - N0
    th = 2 * np.pi * A["col"][idx] / K
    t, psi = A["t"][idx], np.radians(A["psi"][idx])
    # raderna fördelas med hakan som ankare: t = T_CHIN ligger vid hakan hos alla kroppar
    y = np.where(t < T_CHIN, N0[1] + t / T_CHIN * (lm["chin"] - N0[1]),
                 lm["chin"] + (t - T_CHIN) / (1 - T_CHIN) * (top[1] - lm["chin"]))
    O[idx] = N0 + ((y - N0[1]) / ax[1])[:, None] * ax
    a = ax / np.linalg.norm(ax)
    rad = np.stack([np.sin(th), 0 * th, np.cos(th)], 1)
    rad -= (rad @ a)[:, None] * a
    rad /= np.linalg.norm(rad, axis=1, keepdims=True)
    D[idx] = np.cos(psi)[:, None] * rad + np.sin(psi)[:, None] * a
    # ringen 0 (halsen) tillhör bålen; sätt alla hörn som saknar stråle senare
    X = np.full((N, 3), np.nan)
    for p in ("torso", "head"):
        sel = np.where((A["part"] == p) & (np.linalg.norm(D, axis=1) > 0))[0]
        rows = A["ring"][sel]
        for r in np.unique(rows):
            v = sel[rows == r]
            X[v] = shoot(sc[p], O[v], D[v], clamp=1.8 if p == "torso" else 2.5)

    # armhålens slingor: strålar ur axelleden vinkelrätt mot överarmen
    g = T.rings["torso"]
    h0, h1 = HOLE_ROWS[0] * n, HOLE_ROWS[1] * n
    c0, c1 = HOLE_COLS_L[0] * n, HOLE_COLS_L[1] * n
    ic, jc, hh, hw = (h0 + h1) / 2, (c0 + c1) / 2, (h1 - h0) / 2, (c1 - c0) / 2
    loopL = T.seams["shoulder_L"]
    rowcol = {v: (i, j) for i, r in enumerate(g) for j, v in enumerate(r) if v is not None}
    bu = np.array([((rowcol[v][1] - jc) / hw, (rowcol[v][0] - ic) / hh) for v in loopL])   # (bakåt, uppåt)
    phi_loop = np.arctan2(bu[:, 1], -bu[:, 0])
    for side, sgn in (("L", 1), ("R", -1)):
        S, E, W, F = sk[f"shoulder_{side}"], sk[f"elbow_{side}"], sk[f"wrist_{side}"], sk[f"tip_{side}"]
        lat = np.array([sgn, 0, 0.0])
        loop = T.seams[f"shoulder_{side}"]
        a, f, l = frame(E - S, lat + np.array([0, 0.5, 0]))
        d = np.cos(phi_loop)[:, None] * f + np.sin(phi_loop)[:, None] * l
        o = np.repeat(S[None], len(loop), 0)
        X[loop] = shoot(sc[f"shoulder_{side}"], o, d)
        K2 = len(loop)
        uni = phi_loop[0] + turn(phi_loop) * 2 * np.pi * np.arange(K2) / K2
        # handflatans mittlinje: medelpunkten av AI-handens punkter i skivor längs handled -> fingertopp
        ah = (F - W) / np.linalg.norm(F - W)
        Ph = sc[f"hand_{side}"].m.triangles_center[sc[f"hand_{side}"].fsel]
        sh = (Ph - W) @ ah
        Lh = np.linalg.norm(F - W)

        def hcenter(x, Ph=Ph, sh=sh, Lh=Lh, W=W, ah=ah):
            near = np.abs(sh - x) < 0.05 * Lh
            return Ph[near].mean(0) if near.sum() > 20 else W + x * ah
        kf = sk.get(f"knuckle_{side}", KNUCKLE)
        Kn = hcenter(kf * Lh)   # knogarna
        for part, P0, P1 in ((f"upperarm_{side}", S, E), (f"forearm_{side}", E, W), (f"hand_{side}", W, Kn)):
            a, f, l = frame(P1 - P0, lat + np.array([0, 0.5, 0]))
            for r, ring in enumerate(T.rings[part]):
                if r == 0:
                    continue
                for j, v in enumerate(ring):
                    if v is None:   # tummens hål i handflatan
                        continue
                    tt, psi = A["t"][v], np.radians(A["psi"][v])
                    if part.startswith("upperarm"):
                        w = min(1, tt / 0.35)
                        ph = (1 - w) * np.unwrap(phi_loop)[j] + w * uni[j]
                    else:
                        ph = uni[j]
                    rad = np.cos(ph) * f + np.sin(ph) * l
                    if len(ring) == 1:
                        dd = a
                    else:
                        dd = np.cos(psi) * rad + np.sin(psi) * a
                    oo = P0 + tt * (P1 - P0) if not part.startswith("hand") else hcenter(tt * kf * Lh)
                    O[v], D[v] = oo, dd
            for ring in T.rings[part][1:]:
                ring = [v for v in ring if v is not None]
                X[ring] = shoot(sc[part], O[ring], D[ring])
        # fingrar: AI-handens punkter bortom knogarna delas i fyra band tvärs över handen (framkanten = pekfingret);
        # varje band ger en fingeraxel (huvudaxeln genom bandets punkter), från knogarna till bandets spets
        hand = sc[f"hand_{side}"]
        lat5 = lat + np.array([0, 0.5, 0])
        a, f, l = frame(F - W, lat5)
        knuck = kf * Lh
        fing = Ph[sh > knuck + 0.3 * (Lh - knuck)]
        u = (fing - Kn) @ f
        cent = np.percentile(u, [87.5, 62.5, 37.5, 12.5])
        for _ in range(20):
            lab_ = np.argmin(np.abs(u[:, None] - cent[None]), 1)
            cent = np.array([u[lab_ == i].mean() if (lab_ == i).any() else cent[i] for i in range(4)])
        # bryggorna mellan fingrarna: rakt genom handen från handryggen till handflatan, sedan till närmaste yta
        for i in (1, 2, 3):
            b, web, p_ = T.webs[(side, i)]
            fr = (np.arange(len(web)) + 1)[:, None] / (len(web) + 1)
            X[web], _ = hand.closest(X[b] * (1 - fr) + X[p_] * fr + 0.004 * a)
        Ph_all = Ph[sh > knuck]
        u_all = (Ph_all - Kn) @ f
        lab_all = np.argmin(np.abs(u_all[:, None] - cent[None]), 1)
        fsel_all = hand.fsel[sh > knuck]
        for i in range(4):
            Q = Ph_all[lab_all == i]
            # riktningen från fingrets bas till spetsen (huvudaxeln pekar tvärs över korta, breda fingrar)
            sa = (Q - W) @ a
            base_, tip_ = Q[sa < np.percentile(sa, 20)].mean(0), Q[sa > np.percentile(sa, 85)].mean(0)
            dirn = (tip_ - base_) / np.linalg.norm(tip_ - base_)
            c_ = Q.mean(0)
            sq = (Q - c_) @ dirn
            s0, s1 = (Kn - c_) @ dirn, sq.max()
            Ki = c_ + s0 * dirn
            # mittlinjen: medelpunkten av fingrets punkter i skivor längs fingret
            bins = np.linspace(s0, s1, 12)
            mids = [Q[np.abs(sq - b) < (s1 - s0) / 10].mean(0) if (np.abs(sq - b) < (s1 - s0) / 10).sum() > 10 else c_ + b * dirn
                    for b in bins]
            mids = np.array(mids)
            center = lambda t, mids=mids: np.array([np.interp(t, np.linspace(0, 1, len(mids)), mids[:, k]) for k in range(3)])
            scn = Surface(hand.m, fsel_all[lab_all == i])
            sc[f"finger{i}_{side}"] = scn
            loop_tube(T, X, A, f"finger{i}_{side}", Ki, c_ + s1 * dirn, lat5, scn, center=center, miss_r=0.006)
        # tummen: AI-punkterna framför pekfingret, nära handflatan; axeln från hålet mot tummens spets
        base = X[T.seams[f"thumb_{side}"]].mean(0) + 0.008 * l
        uu = (Ph - Kn) @ f
        thumb_sel = (uu > cent[0] + 0.5 * (cent[0] - cent[1])) & (sh > 0.15 * Lh)
        th = Ph[thumb_sel]
        if len(th) > 30:
            tip_t = th[np.argmax((th - base) @ a + 0.5 * (th - base) @ f)]
            sc[f"thumb_{side}"] = Surface(hand.m, hand.fsel[thumb_sel | (sh < knuck)])
        else:
            dt = a * np.cos(np.radians(35)) + f * np.sin(np.radians(35)) - 0.2 * l
            tip_t = base + dt / np.linalg.norm(dt) * 0.5 * Lh
            sc[f"thumb_{side}"] = hand
        loop_tube(T, X, A, f"thumb_{side}", base, tip_t, lat5, sc[f"thumb_{side}"])

    # grenbryggan: mellan bålens nedersta hörn mitt fram och mitt bak, sänkt till grenen
    front, back = X[g[0][0]], X[g[0][K // 2]]
    kb = len(T.bridge)
    for m_, v in enumerate(T.bridge):
        f_ = (m_ + 1) / (kb + 1)
        p = front * (1 - f_) + back * f_
        p[1] = min(p[1], lm["crotch"] - 0.005) if 0.2 < f_ < 0.8 else p[1]
        X[v] = p
    X[T.bridge], _ = sc["torso"].closest(X[T.bridge])

    # ben: strålar ur benets mittlinje; vinklarna börjar i benöppningens hörn och jämnas ut nedåt
    for side, sgn in (("L", 1), ("R", -1)):
        leg = sk[f"leglist_{side}"]
        def legpt(y):
            return np.array([np.interp(y, leg[:, 0], leg[:, 1]), y, np.interp(y, leg[:, 0], leg[:, 2])])
        loop = T.seams[f"hip_{side}"]
        c = legpt(lm["crotch"] - 0.02)
        a, f, l = frame(legpt(lm["crotch"] - 0.1) - legpt(lm["crotch"] - 0.02), np.array([sgn, 0, 0.0]))
        rel = X[loop] - c
        phi = np.arctan2(rel @ l, rel @ f)
        K2 = len(loop)
        uni = phi[0] + turn(phi) * 2 * np.pi * np.arange(K2) / K2
        phi = phi[0] + turn(phi) * np.cumsum(np.r_[0, np.abs(np.angle(np.exp(1j * np.diff(phi))))])
        rings = T.rings[f"leg_{side}"]
        for r, ring in enumerate(rings[1:], 1):
            tt = A["t"][ring[0]]
            y = lm["crotch"] + tt * (lm["ankle"] - lm["crotch"])
            o = legpt(y)
            a, f, l = frame(legpt(y - 0.03) - legpt(y + 0.03), np.array([sgn, 0, 0.0]))
            w = min(1, tt / 0.2)
            ph = (1 - w) * phi + w * uni
            d = np.cos(ph)[:, None] * f + np.sin(ph)[:, None] * l
            O[ring], D[ring] = o, d
            X[ring] = shoot(sc[f"leg_{side}"], o, d)
        # fot: längs en böjd mittlinje fotled -> häl/fotvalv -> tå
        P0, P1, P2 = sk[f"ankle_{side}"], sk[f"footctrl_{side}"], sk[f"toe_{side}"]
        for r, ring in enumerate(T.rings[f"foot_{side}"][1:], 1):
            tt, psi = A["t"][ring[0]], np.radians(A["psi"][ring[0]])
            o = bezier(P0, P1, P2, tt)
            tan = bezier(P0, P1, P2, min(tt + 0.02, 1)) - bezier(P0, P1, P2, max(tt - 0.02, 0))
            a, f, l = frame(tan, np.array([sgn, 0, 0.0]))
            if len(ring) == 1:
                d = a[None]
            else:
                rad = np.cos(uni)[:, None] * f + np.sin(uni)[:, None] * l
                d = np.cos(psi) * rad + np.sin(psi) * a
            X[ring] = shoot(sc[f"foot_{side}"], o, d) if len(ring) > 1 else o + d * sc[f"foot_{side}"].ray(o[None], d)[:, None]
    return X


# ---------- utjämning och icke-stel ICP ----------
def laplacian(T):
    N = len(T.key)
    rows, cols = [], []
    for f in T.faces:
        for a, b in zip(f, f[1:] + f[:1]):
            rows += [a, b]; cols += [b, a]
    A = sp.coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(N, N)).tocsr()
    A.data[:] = 1
    deg = np.asarray(A.sum(1)).ravel()
    return sp.eye(N) - sp.diags(1 / deg) @ A


def fill_and_smooth(X, L, iters=20, fix=None):
    """Hörn utan träff (nan) får grannarnas medel; sedan några steg Laplace-utjämning."""
    bad = ~np.isfinite(X).all(1)
    X = np.where(bad[:, None], 0, X)
    M = sp.eye(L.shape[0]) - L   # grannmedel
    for _ in range(200):
        if not bad.any():
            break
        nb = M @ np.where(bad[:, None], 0, X)
        cnt = M @ (~bad).astype(float)
        ok = bad & (cnt > 0)
        X[ok] = nb[ok] / cnt[ok, None]
        bad &= ~ok
    for _ in range(iters):
        Y = M @ X
        X = 0.5 * X + 0.5 * Y if fix is None else np.where(fix[:, None], X, 0.5 * X + 0.5 * Y)
    return X


def closest_parts(X, vpart, sc):
    """Närmaste punkt för varje hörn på dess dels AI-yta (fingrar och tumme har egna ytor, se coarse)."""
    c, cn = np.zeros_like(X), np.zeros_like(X)
    for p in np.unique(vpart):
        sel = vpart == p
        c[sel], cn[sel] = sc[p].closest(X[sel])
    return c, cn


def fit_parts(T, sc):
    """Vilken AI-yta varje hörn passas mot: UV-ön om den har en egen yta (fingrar, tumme), annars delen."""
    return np.array([i if i in sc else p for p, i in zip(T.vpart, T.visland)])


def nicp(X, L, sc, vpart, alphas, iters=4, dmax=0.04, fixed=None, label=""):
    """Icke-stel ICP: (W + a L'L) x = W c + a L'L x_ref, där c är närmaste punkt på AI-ytan och x_ref formen när steget
    började. Korrespondenser med normaler som pekar åt olika håll eller som ligger långt bort får vikt 0."""
    LtL = (L.T @ L).tocsc()
    for a in alphas:
        ref = X.copy()
        b_ref = LtL @ ref
        for it in range(iters):
            c, cn = closest_parts(X, vpart, sc)
            vn = vertex_normals(X, L)
            d = np.linalg.norm(c - X, axis=1)
            w = ((d < dmax) & ((vn * cn).sum(1) > 0.3)).astype(float)
            if fixed is not None:
                w[fixed] = 10.0
                c[fixed] = X[fixed]
            Wm = sp.diags(w)
            X = spla.spsolve((Wm + a * LtL).tocsc(), Wm @ c + a * b_ref)
            print(f"  {label} a={a:g} it={it} mean={d[w > 0].mean() * 1000:.2f}mm used={w.mean():.3f}", flush=True)
    return X


_FACES = {}


def vertex_normals(X, L):
    F = _FACES["tris"]
    fn = np.cross(X[F[:, 1]] - X[F[:, 0]], X[F[:, 2]] - X[F[:, 0]])
    vn = np.zeros_like(X)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    return vn / (np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12)


def mirror_index(T):
    idx = T.index
    Kf = 32 * FINE
    out = np.zeros(len(T.key), int)
    for i, k in enumerate(T.key):
        p = k[0]
        if p in ("torso", "head"):
            m = (p, k[1], (Kf - k[2]) % Kf)
        elif p.endswith("_L") or p.endswith("_R"):
            m = (p[:-1] + ("R" if p.endswith("L") else "L"), k[1], k[2])
        else:
            m = k
        out[i] = idx[m]
    return out


def upsample(Tc, Xc, Tf, Xf_init, Lf):
    """Nivå c -> nivå f: hörn som finns på båda tar den grova passningen; övriga löses harmoniskt (L x = L x_init)."""
    known = np.array([Tf.index[k] for k in Tc.key])
    Xf = Xf_init.copy()
    Xf[known] = Xc
    unk = np.setdiff1d(np.arange(len(Tf.key)), known)
    Luu = Lf[unk][:, unk].tocsc()
    rhs = -(Lf[unk][:, known] @ Xc)
    Xf[unk] = spla.spsolve(Luu.T @ Luu, Luu.T @ rhs)
    return Xf


def part_metrics(T, X, surf, target):
    """Avstånd per del: från mallen till AI-ytan och från AI-ytan till mallen (punkter som ligger närmast delen)."""
    tris, tpart = T.triangles()
    mm = o3d.t.geometry.TriangleMesh(o3d.core.Tensor(X.astype(np.float32)), o3d.core.Tensor(tris.astype(np.int32)))
    sc = o3d.t.geometry.RaycastingScene()
    sc.add_triangles(mm)
    P, _ = trimesh.sample.sample_surface_even(target, 200000, seed=2)
    ans = sc.compute_closest_points(o3d.core.Tensor(P.astype(np.float32)))
    back = np.linalg.norm(ans["points"].numpy() - P, axis=1)
    ppart = tpart[ans["primitive_ids"].numpy()]
    A = T.arrays()
    fwd = surf.unsigned(X)
    out = {}
    for p in sorted(set(T.vpart)):
        sel = A["part"] == p
        b = back[ppart == p]
        out[p] = {"to_ai_mean_mm": round(float(fwd[sel].mean()) * 1000, 2), "to_ai_p95_mm": round(float(np.percentile(fwd[sel], 95)) * 1000, 2),
                  "from_ai_mean_mm": round(float(b.mean()) * 1000, 2) if len(b) else None,
                  "from_ai_p95_mm": round(float(np.percentile(b, 95)) * 1000, 2) if len(b) else None}
    out["all"] = {"to_ai_mean_mm": round(float(fwd.mean()) * 1000, 2), "from_ai_mean_mm": round(float(back.mean()) * 1000, 2),
                  "from_ai_p95_mm": round(float(np.percentile(back, 95)) * 1000, 2)}
    return out


def knuckle_fraction(Ph, W, F, lat, res=0.002):
    """Var fingrarna skiljs åt: lägsta andel av handled -> fingertopp där en skiva tvärs över handen har minst tre
    glipor (tomma fack längs handens bredd). Utan glipor (hopväxta fingrar) blir det KNUCKLE."""
    a, f, _ = frame(F - W, lat)
    L = np.linalg.norm(F - W)
    s_, u = (Ph - W) @ a, (Ph - W) @ f
    for fr in np.arange(0.4, 0.85, 0.01):
        sl = u[np.abs(s_ - fr * L) < 0.004]
        if len(sl) < 20:
            continue
        h = np.histogram(sl, bins=np.arange(sl.min(), sl.max() + res, res))[0] > 0
        gaps = np.sum(np.diff(h.astype(int)) == -1)
        if gaps >= 3:
            # krökta fingrar som ligger an mot varandra vid roten skiljs först nära topparna; knogarna sitter ändå
            # på 50-60 % av handens längd
            return float(min(fr, 0.6))
    return KNUCKLE


def run_pass(T3, T6, sc, lm, sk, tag):
    """Grov passning på nivå 3 och 6, ICP på nivå 3, uppsampling till nivå 6 och ICP där."""
    T, X = T3, coarse(T3, sc, lm, sk)
    X6 = coarse(T6, sc, lm, sk)
    L3 = laplacian(T)
    _FACES["tris"] = T.triangles()[0]
    X = fill_and_smooth(X, L3, iters=10)
    if signed_volume(X, _FACES["tris"]) < 0:   # mallens varvordning är konsekvent men kan vara inåtvänd: vänd alla
        for TT in (T3, T6):
            TT.faces = [f[::-1] for f in TT.faces]
            TT.fuv = [u[::-1] for u in TT.fuv]
        _FACES["tris"] = T.triangles()[0]
        print("ytorna vända utåt", flush=True)
    X3 = nicp(X, L3, sc, fit_parts(T, sc), alphas=[30, 10, 3, 1], iters=3, label=f"L3/{tag}")
    # nivå 6: börja i nivå 3:s passning, sedan ICP med lägre vikt för formen
    L6 = laplacian(T6)
    _FACES["tris"] = T6.triangles()[0]
    X6 = fill_and_smooth(X6, L6, iters=5)
    X6 = upsample(T3, X3, T6, X6, L6)
    X6 = nicp(X6, L6, sc, fit_parts(T6, sc), alphas=[10, 3, 1, 0.3], iters=2, dmax=0.02, label=f"L6/{tag}")
    return X3, X6


def fit(glb, name, height, sym):
    t0 = time.time()
    target = load_target(glb, height)
    surf = Surface(target)
    lm = landmarks(target, surf)
    sk = skeleton(lm)
    print("landmärken:", {k: round(float(v), 3) for k, v in lm.items() if np.isscalar(v)}, flush=True)
    T3, T6 = Template(3), Template(6)
    # Omgång 1: AI-kroppen etiketterad efter skelettet (grovt vid händerna, som hänger intill låren)
    sc = part_scenes(target, label_target(target, lm, sk))
    X3, X6 = run_pass(T3, T6, sc, lm, sk, "1")
    # Omgång 2: etiketterna ur omgång 1 (närmaste malltriangel), och handens axel genom AI-handens punkter
    lab = label_from_fit(target, X6)
    sc = part_scenes(target, lab)
    for side in "LR":
        W = X6[T6.seams[f"wrist_{side}"]].mean(0)
        Ph = target.triangles_center[lab == f"hand_{side}"]
        a = np.linalg.svd(Ph - Ph.mean(0))[2][0]
        a = a if (Ph.mean(0) - W) @ a > 0 else -a
        sk[f"wrist_{side}"], sk[f"tip_{side}"] = W, W + a * ((Ph - W) @ a).max()
        sk[f"knuckle_{side}"] = knuckle_fraction(Ph, W, sk[f"tip_{side}"], lat=np.array([1.0 if side == "L" else -1.0, 0.5, 0]))
    X3, X6 = run_pass(T3, T6, sc, lm, sk, "2")
    if sym:
        mi = mirror_index(T6)
        Xm = X6[mi] * np.array([-1, 1, 1])
        X6 = (X6 + Xm) / 2
    met = part_metrics(T6, X6, surf, target)
    d = HERE / "build/fit"
    d.mkdir(parents=True, exist_ok=True)
    np.savez(d / f"{name}.npz", X6=X6, keys=np.array([str(k) for k in T6.key]), M=target.metadata["M"])
    export_target(glb, target.metadata["M"], d / f"{name}_ai.glb")
    rec = {"name": name, "src": str(glb), "height": height, "sym": sym, "seconds": round(time.time() - t0, 1),
           "landmarks": {k: round(float(v), 4) for k, v in lm.items() if np.isscalar(v)},
           "skeleton": {k: [round(float(x), 4) for x in np.ravel(v)] for k, v in sk.items() if not k.startswith("leglist")},
           "metrics": met}
    json.dump(rec, open(d / f"{name}.json", "w"), indent=1)
    print(json.dumps(met["all"]))
    return T6, X6, target


def signed_volume(X, F):
    return float(np.einsum("ij,ij->i", X[F[:, 0]], np.cross(X[F[:, 1]], X[F[:, 2]])).sum() / 6)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("name")
    ap.add_argument("--height", type=float, default=1.8)
    ap.add_argument("--sym", action="store_true")
    a = ap.parse_args()
    fit(a.glb, a.name, a.height, a.sym)
