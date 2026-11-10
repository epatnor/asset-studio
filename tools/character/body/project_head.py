"""Projicerar närbilder (fram, sidor, bak) på ett Pixal3D-huvud med hår, och ersätter hela Pixal3D:s textur.

  .venv/bin/python tools/project_head.py '{"glb": "build/nora_head/nora_head_mv.glb", "out": "build/nora_head/proj", "export": "build/nora_head/nora_head_proj.glb", "views": [{"img": ..., "yaw": 0, "name": "front", "bias": 8}]}'

yaw: kamerans vinkel runt Y. 0 = framifrån (+Z), 90 = från +X (ansiktet åt vänster i bilden), -90 = från -X, 180 = bakifrån.
Varje bild passas (affint) mot nätet: nätets bakade textur mot bilden, och nätet ska ligga inne i figuren. Allt räknas per texel
utan triangelloop, så att 500 000 trianglar går snabbt. Det ingen bild ser (under hästsvansen, näsborrar) får färgen från närmaste
sedda punkt i 3D, så att inget av Pixal3D:s utsmetade ansikte blir kvar. Normalkartan tas bort: formen finns i nätet.
Skriver basecolor.png, owner.png och en rad JSON."""
import json, sys
from pathlib import Path

import cv2
import numpy as np
import scipy.sparse as sp
import trimesh
from PIL import Image
from scipy import ndimage, optimize
from scipy.spatial import cKDTree

r = json.loads(sys.argv[1])
out = Path(r["out"])
out.mkdir(parents=True, exist_ok=True)
S = r.get("size", 4096)
g = trimesh.load(r["glb"], force="scene").to_geometry()
V, F, UV = np.asarray(g.vertices), np.asarray(g.faces), np.asarray(g.visual.uv)
mat = g.visual.material
base = np.asarray(mat.baseColorTexture.convert("RGB").resize((S, S), Image.BILINEAR)).astype(np.float32) / 255
smooth = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))

# Normaler över UV-sömmarna: hörnen svetsas efter läge.
_, weld = np.unique(np.round(V, 5), axis=0, return_inverse=True)
weld = weld.ravel()
# Pixal3D gör målade ögonskuggor och bryn till former i nätet. De jämnas ut här, innan projektionen ritar dem igen.
if r.get("smooth"):
    Vw = np.zeros((weld.max() + 1, 3))
    Vw[weld] = V
    fw = weld[F]
    n = len(Vw)
    ij = np.r_[fw[:, 0], fw[:, 1], fw[:, 2], fw[:, 1], fw[:, 2], fw[:, 0]]
    ji = np.r_[fw[:, 1], fw[:, 2], fw[:, 0], fw[:, 0], fw[:, 1], fw[:, 2]]
    L = sp.coo_matrix((np.ones(len(ij)), (ij, ji)), shape=(n, n)).tocsr()
    L.data[:] = 1
    deg = np.asarray(L.sum(1)).ravel() + 1e-9
    for sm in r["smooth"]:
        e_ = np.sqrt((((Vw - np.array(sm["c"])) / np.array(sm["r"])) ** 2).sum(1))
        w_ = smooth(1.0, 0.6, e_)[:, None] * sm.get("lambda", 0.6)
        for _ in range(sm.get("iters", 40)):
            Vw += w_ * ((L @ Vw) / deg[:, None] - Vw)
    V = Vw[weld]
fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
Nw = np.zeros((weld.max() + 1, 3))
for i in range(3):
    np.add.at(Nw, weld[F[:, i]], fn)
N = Nw[weld] / (np.linalg.norm(Nw[weld], axis=1, keepdims=True) + 1e-12)

# Vilken triangel varje texel tillhör, och läge och normal i texeln.
uvpx = np.stack([UV[:, 0] * S, (1 - UV[:, 1]) * S], 1)
tid = np.full((S, S), -1, np.int32)
pts = np.round((uvpx[F] - 0.5) * 16).astype(np.int32)
for i, p in enumerate(pts):
    cv2.fillConvexPoly(tid, p, i, lineType=cv2.LINE_8, shift=4)
ty, tx = np.where(tid >= 0)
t = tid[ty, tx]
A, B, C_ = uvpx[F[t, 0]], uvpx[F[t, 1]], uvpx[F[t, 2]]
px, py = tx + 0.5, ty + 0.5
d = (B[:, 1] - C_[:, 1]) * (A[:, 0] - C_[:, 0]) + (C_[:, 0] - B[:, 0]) * (A[:, 1] - C_[:, 1])
d = np.where(np.abs(d) < 1e-9, 1e-9, d)
ba = ((B[:, 1] - C_[:, 1]) * (px - C_[:, 0]) + (C_[:, 0] - B[:, 0]) * (py - C_[:, 1])) / d
bb = ((C_[:, 1] - A[:, 1]) * (px - C_[:, 0]) + (A[:, 0] - C_[:, 0]) * (py - C_[:, 1])) / d
bary = np.clip(np.stack([ba, bb, 1 - ba - bb], 1), 0, 1)
bary /= bary.sum(1, keepdims=True)
pos = (V[F[t]] * bary[..., None]).sum(1).astype(np.float32)
nor = (N[F[t]] * bary[..., None]).sum(1).astype(np.float32)
nor /= np.linalg.norm(nor, axis=1, keepdims=True) + 1e-9
col0 = base[ty, tx]
del tid, A, B, C_, ba, bb, bary, d, t
C = np.array([np.median(V[:, 0]), 0, 0.0])
n0, n1 = r.get("facing", [0.08, 0.5])
power = r.get("power", 6)
nf0, nf1 = r.get("neck_fade", [0.2, 0.24])
GRID = 0.0015
ymin, ymax = V[:, 1].min(), V[:, 1].max()
EXT = float(np.abs(V[:, [0, 2]]).max()) + 0.02


def figure_mask(img):
    """Bakgrunden: det som hänger ihop med bildens kant och liknar kantens färg."""
    edge = np.concatenate([img[:12].reshape(-1, 3), img[:, :12].reshape(-1, 3), img[:, -12:].reshape(-1, 3)])
    lab, _ = ndimage.label(np.abs(img - np.median(edge, 0)).sum(2) < r.get("bg_tol", 0.13))
    keep = np.unique(np.concatenate([lab[0], lab[:, 0], lab[:, -1], lab[-1]]))
    return ~np.isin(lab, keep[keep > 0])


inner = hair_zone = None
if r.get("inner"):
    q = r["inner"]
    e_ = np.sqrt((((pos - np.array(q["c"])) / np.array(q["r"])) ** 2).sum(1))
    inner = (smooth(1.0, 0.8, e_) * (pos[:, 2] > q.get("z_min", 0.05))).astype(np.float32)
if r.get("hair_zone"):
    q = r["hair_zone"]
    e_ = (((pos - np.array(q["c"])) / np.array(q["r"])) ** 2).sum(1)
    hair_zone = ((pos[:, 1] > q["neck_y"]) & (e_ > 1) & (pos[:, 2] < 0)) | ((pos[:, 1] <= q["neck_y"]) & (pos[:, 2] < q["neck_z"]))

views, results = [], []
prior = None
for view in r["views"]:
    th = np.radians(view["yaw"])
    rx, cd = np.array([np.cos(th), 0, -np.sin(th)]), np.array([np.sin(th), 0, np.cos(th)])
    X, Z = (pos - C) @ rx, (pos - C) @ cd
    Y = pos[:, 1]
    bx = ((X + EXT) / GRID).astype(np.int32)
    by = ((ymax + 0.02 - Y) / GRID).astype(np.int32)
    zb = np.full((by.max() + 1, bx.max() + 1), -1e9, np.float32)
    np.maximum.at(zb, (by, bx), Z)
    vis = Z >= zb[by, bx] - r.get("depth_tol", 0.012)
    facing = nor @ cd.astype(np.float32)

    img = np.asarray(Image.open(view["img"]).convert("RGB")).astype(np.float32) / 255
    IH, IW = img.shape[:2]
    mask = figure_mask(img)
    k = 4
    gray = cv2.resize(img.mean(2), (IW // k, IH // k), interpolation=cv2.INTER_AREA)
    msk = cv2.resize(mask.astype(np.float32), (IW // k, IH // k), interpolation=cv2.INTER_AREA)
    # Stickprov ovanför halsens snitt: bilderna skär av halsen olika.
    cand = np.where(vis & (facing > 0.3) & (Y > nf1))[0]
    pick = cand[np.linspace(0, len(cand) - 1, min(len(cand), 16000)).astype(int)]
    sx, sy, sc = X[pick], Y[pick], col0[pick].mean(1)

    def score(p, im=gray, ms=msk, f=k):
        a, b_, c, d_, tx_, ty_ = p
        u, v = (a * sx + b_ * sy + tx_) / f, (c * sx + d_ * sy + ty_) / f
        ins = (u >= 0) & (u < im.shape[1] - 1) & (v >= 0) & (v < im.shape[0] - 1)
        if ins.mean() < 0.9:
            return 1.0
        s = ndimage.map_coordinates(im, [v[ins], u[ins]], order=1)
        fig = ndimage.map_coordinates(ms, [v[ins], u[ins]], order=1).mean()
        q = sc[ins]
        n = ((s - s.mean()) * (q - q.mean())).mean() / (s.std() * q.std() + 1e-9)
        return -float(n + 1.5 * fig * ins.mean())

    best = (9.0, None)
    ys_, xs_ = np.where(mask)
    if prior is None or "scale" not in view:
        # Första vyn: bred sökning. Den ger skalan och ögonlinjens höjd i nätet åt de andra.
        for s in np.geomspace(900, 2600, 16):
            for tx_ in np.arange(xs_.min(), xs_.max(), 30):
                for top in np.arange(ys_.min() - 160, ys_.min() + 200, 30):
                    p = (s, 0.0, 0.0, -s, tx_, top + s * ymax)
                    v_ = score(p)
                    if v_ < best[0]:
                        best = (v_, p)
        objective = score
        s0 = None
    else:
        # Vyerna byggdes med samma skala och ögonlinje (compose_head_views), så sökningen hålls nära det.
        s0 = prior["s"] / view["scale"] * prior["scale"]
        for s in s0 * np.linspace(0.95, 1.05, 7):
            for tx_ in view["axis_x"] + np.arange(-80, 81, 10):
                for ey in view["eye_y"] + np.arange(-30, 31, 10):
                    p = (s, 0.0, 0.0, -s, tx_, ey + s * prior["eye"])
                    v_ = score(p)
                    if v_ < best[0]:
                        best = (v_, p)
        objective = lambda p: score(p) + 4 * max(abs(np.hypot(p[0], p[2]) / s0 - 1) - 0.05, 0)
    res = optimize.minimize(objective, best[1], method="Powell", options={"xtol": 1e-3, "ftol": 1e-4, "maxiter": 30})
    a, b_, c, d_, tx_, ty_ = res.x
    if prior is None and "eye_y" in view:
        prior = {"s": float(np.hypot(a, c)), "scale": view.get("scale", 1.0), "eye": float((view["eye_y"] - ty_) / d_)}
    u, v = a * X + b_ * Y + tx_, c * X + d_ * Y + ty_

    # Hur väl konturen stämmer ovanför halsen: nätets ruta mot bildens figur.
    ok = (u >= 0) & (u < IW) & (v >= 0) & (v < IH)
    shadow = np.zeros((IH // k, IW // k), bool)
    shadow[(v[ok] / k).astype(int).clip(0, IH // k - 1), (u[ok] / k).astype(int).clip(0, IW // k - 1)] = True
    shadow = ndimage.binary_closing(shadow, iterations=2)
    row_cut = int((c * 0 + d_ * nf1 + ty_) / k)
    fig_small = msk > 0.5
    iou = float((shadow & fig_small)[:row_cut].sum() / max((shadow | fig_small)[:row_cut].sum(), 1))

    er = ndimage.binary_erosion(mask, iterations=view.get("erode", 5))
    soft = ndimage.gaussian_filter(er.astype(np.float32), 2.0)
    spl = [ndimage.spline_filter(img[..., i], order=3) for i in range(3)]
    fac = smooth(n0, n1, facing)
    if inner is not None and view["yaw"] == 0:
        # Ansiktets inre tar framvyn även på sneda ytor, annars ritar sidovyerna ögon och fransar över ögonvrårna.
        fac = np.maximum(fac, inner * smooth(-0.1, 0.1, facing))
    wt = (vis * fac * ndimage.map_coordinates(soft, [v, u], order=1, cval=0)).astype(np.float32)
    proj = np.stack([ndimage.map_coordinates(spl[i], [v, u], order=3, cval=0, prefilter=False) for i in range(3)], 1).clip(0, 1).astype(np.float32)
    e = wt * view.get("bias", 1.0) * np.maximum(facing, 0.02) ** power
    if inner is not None and view["yaw"] != 0:
        e = e * (1 - 0.995 * inner)
        wt = wt * (1 - inner)
    if hair_zone is not None:
        # Hästsvansen sticker ibland ut över hals eller bakgrund i bilden: där räknas bara hårfärg.
        R_, G_, B_ = proj[:, 0], proj[:, 1], proj[:, 2]
        is_hair = (R_ + G_ + B_ < r.get("hair_sum", 1.5)) & (R_ > G_) & (G_ > B_)
        bad = hair_zone & ~is_hair
        wt[bad] = 0
        e[bad] = 0
        rejected = int(bad.sum())
    views.append([wt, proj, e])
    results.append({"name": view.get("name", str(view["yaw"])), "eye_mesh_y": round(prior["eye"], 4) if prior else None, "hair_rejected": rejected if hair_zone is not None else 0, "iou": round(iou, 3), "ncc_plus_inside": round(-float(res.fun), 3), "px_per_unit": round(float(np.hypot(a, c)), 1),
                    "rot_deg": round(float(np.degrees(np.arctan2(c, a))), 2), "y_over_x": round(float(np.hypot(b_, d_) / np.hypot(a, c)), 3), "head_w_px": round(float(0.44 * np.hypot(a, c)))})

# Färgen: varje vy får en förstärkning per kanal mot framvyn, mätt där båda syns.
w0, p0 = views[0][0], views[0][1]
for i in range(1, len(views)):
    both = (views[i][0] > 0.25) & (w0 > 0.25)
    if both.sum() > 400:
        gain = np.clip(np.median(p0[both], 0) / (np.median(views[i][1][both], 0) + 1e-4), 0.8, 1.25)
        views[i][1] = (views[i][1] * gain).astype(np.float32)
        results[i]["gain"] = [round(float(x), 3) for x in gain]

top = np.max([v[0] for v in views], 0)
P = np.stack([v[2] for v in views])
den = P.sum(0) + 1e-6
mix = sum(views[i][1] * (P[i] / den)[..., None] for i in range(len(views)))
owner = P.argmax(0)
seen = (top > 0.6) & (den > 1e-3)
idx = np.where(seen)[0]
tree = cKDTree(pos[idx[np.linspace(0, len(idx) - 1, min(len(idx), 400000)).astype(int)]])
_, near = tree.query(pos[~seen], workers=-1)
fill = mix.copy()
fill[~seen] = mix[idx[np.linspace(0, len(idx) - 1, min(len(idx), 400000)).astype(int)]][near]
over = np.where(seen, 1.0, 0.0)[..., None]
col = fill.astype(np.float32)
# Halsens nedre snitt: bilderna slutar där, så färgen tas från halsen strax ovanför.
del views, P

canvas = np.zeros((S, S, 3), np.float32)
canvas[ty, tx] = col
covered = np.zeros((S, S), bool)
covered[ty, tx] = True
ind = ndimage.distance_transform_edt(~covered, return_distances=False, return_indices=True)
canvas = canvas[ind[0], ind[1]]
Image.fromarray((canvas.clip(0, 1) * 255 + 0.5).astype(np.uint8)).save(out / "basecolor.png")
own = np.zeros((S, S, 3), np.uint8)
pal = np.array([[230, 60, 60], [60, 200, 60], [60, 90, 230], [230, 200, 40]], np.uint8)
own[ty, tx] = np.where(seen[:, None], pal[owner % 4], np.array([40, 40, 40], np.uint8))
Image.fromarray(own).resize((1024, 1024), Image.NEAREST).save(out / "owner.png")
result = {"views": results, "texels": int(len(ty)), "seen_share": round(float(seen.mean()), 4), "owner_share": [round(float((owner[seen] == i).mean()), 3) for i in range(len(r["views"]))]}
if r.get("export"):
    tex = Image.open(out / "basecolor.png")
    m2 = trimesh.visual.material.PBRMaterial(name="head", baseColorTexture=tex, roughnessFactor=r.get("roughness", 0.7), metallicFactor=0.0)
    g = trimesh.Trimesh(vertices=V, faces=F, process=False, visual=trimesh.visual.TextureVisuals(uv=UV, material=m2))
    g.export(r["export"])
    result["export"] = r["export"]
    result["mb"] = round(Path(r["export"]).stat().st_size / 2**20, 1)
print(json.dumps(result))
