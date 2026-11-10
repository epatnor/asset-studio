"""Målar en MPFB-människa från referensbilder: närbilder på huvudet, helkroppsbilder på resten. Armarna får hudfärg.

  uv run ... python tools/project_human.py '{"glb": "build/nora_mpfb/posed.glb", "out": "build/nora_mpfb/painted", "close": {"front": {...}, ...}, "full": {"front": ".."}}'

Ansiktet riktas in på pupiller och mun, sidorna på ögonlinjen och nästippen, kroppen på figurens höjd och mitt.
Skriver <out>/nora.glb (kropp, ögon, hår) och en rad JSON."""
import json, sys
from pathlib import Path

import cv2
import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree

r = json.loads(sys.argv[1])
out = Path(r["out"])
out.mkdir(parents=True, exist_ok=True)
S = r.get("size", 4096)
smooth = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))
scene = trimesh.load(r["glb"])
pick = lambda key: next(g for n, g in scene.geometry.items() if key in n)
body, eyes, hair = pick("female"), pick("low-poly"), pick("ponytail")
V, F, UV = np.asarray(body.vertices), np.asarray(body.faces), np.asarray(body.visual.uv)


def figure_mask(img):
    edge = np.concatenate([img[:12].reshape(-1, 3), img[:, :12].reshape(-1, 3), img[:, -12:].reshape(-1, 3)])
    lab, _ = ndimage.label(np.abs(img - np.median(edge, 0)).sum(2) < 0.13)
    keep = np.unique(np.r_[lab[0], lab[:, 0], lab[:, -1]])
    return ~np.isin(lab, keep[keep > 0])


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.float32) / 255


def texels(V_, F_, UV_, size):
    """Läge och normal per texel."""
    _, w = np.unique(np.round(V_, 5), axis=0, return_inverse=True)
    w = w.ravel()
    fn = np.cross(V_[F_[:, 1]] - V_[F_[:, 0]], V_[F_[:, 2]] - V_[F_[:, 0]])
    Nw = np.zeros((w.max() + 1, 3))
    for i in range(3):
        np.add.at(Nw, w[F_[:, i]], fn)
    N = Nw[w] / (np.linalg.norm(Nw[w], axis=1, keepdims=True) + 1e-12)
    px_ = np.stack([UV_[:, 0] * size, (1 - UV_[:, 1]) * size], 1)
    tid = np.full((size, size), -1, np.int32)
    for i, p in enumerate(np.round((px_[F_] - 0.5) * 16).astype(np.int32)):
        cv2.fillConvexPoly(tid, p, i, lineType=cv2.LINE_8, shift=4)
    ty, tx = np.where(tid >= 0)
    t = tid[ty, tx]
    A, B, C = px_[F_[t, 0]], px_[F_[t, 1]], px_[F_[t, 2]]
    xp, yp = tx + 0.5, ty + 0.5
    d = (B[:, 1] - C[:, 1]) * (A[:, 0] - C[:, 0]) + (C[:, 0] - B[:, 0]) * (A[:, 1] - C[:, 1])
    d = np.where(np.abs(d) < 1e-9, 1e-9, d)
    ba = ((B[:, 1] - C[:, 1]) * (xp - C[:, 0]) + (C[:, 0] - B[:, 0]) * (yp - C[:, 1])) / d
    bb = ((C[:, 1] - A[:, 1]) * (xp - C[:, 0]) + (A[:, 0] - C[:, 0]) * (yp - C[:, 1])) / d
    bary = np.clip(np.stack([ba, bb, 1 - ba - bb], 1), 0, 1)
    bary /= bary.sum(1, keepdims=True)
    pos = (V_[F_[t]] * bary[..., None]).sum(1).astype(np.float32)
    nor = (N[F_[t]] * bary[..., None]).sum(1).astype(np.float32)
    nor /= np.linalg.norm(nor, axis=1, keepdims=True) + 1e-9
    return ty, tx, pos, nor


ty, tx, pos, nor = texels(V, F, UV, S)

# Mått på modellen.
Ev = np.asarray(eyes.vertices)
pup = np.array([Ev[Ev[:, 0] < 0].mean(0), Ev[Ev[:, 0] > 0].mean(0)])
eye_y = float(pup[:, 1].mean())
ctr = V[np.abs(V[:, 0]) < 0.006]
face = ctr[(ctr[:, 1] < eye_y) & (ctr[:, 1] > eye_y - 0.14) & (ctr[:, 2] > 0)]
nose = face[np.argmax(face[:, 2])]
under = face[(face[:, 1] < nose[1] - 0.02) & (face[:, 1] > nose[1] - 0.06)]
mouth_y = float(under[np.argmax(under[:, 2]), 1]) if len(under) else float(nose[1] - 0.04)
top = float(max(V[:, 1].max(), hair.bounds[1, 1]))

# Närbilderna.
c = r["close"]
fi = load(c["front"]["img"])
ey, ax = c["front"]["eye_y"], c["front"]["axis_x"]
g = fi.sum(2)
# Pupillerna: mörkast i ett smalt band kring ögonlinjen, en bit från mittlinjen. Bredare fångar håret.
rows_, cols_ = np.arange(fi.shape[0])[:, None], np.arange(fi.shape[1])[None, :]
band_ = (np.abs(rows_ - ey) < 30) & (np.abs(cols_ - ax) > 60) & (np.abs(cols_ - ax) < 210)
yy, xx = np.where((g < np.percentile(g[band_], 8)) & band_)
pl, pr = (xx[xx < ax].mean(), yy[xx < ax].mean()), (xx[xx > ax].mean(), yy[xx > ax].mean())
# Munnen: rödast nära mittlinjen, tydligt ovanför halsen.
redness = (fi[..., 0] - fi[..., 1]) * ((np.abs(cols_ - ax) < 70) & (rows_ > ey + 150) & (rows_ < ey + 310))
my = float(np.argmax(ndimage.gaussian_filter1d(redness.sum(1), 4)))
a = (pr[0] - pl[0]) / (pup[1, 0] - pup[0, 0])
d = (my - (pl[1] + pr[1]) / 2) / (mouth_y - eye_y)
txf = (pl[0] + pr[0]) / 2 - a * pup[:, 0].mean()
tyf = (pl[1] + pr[1]) / 2 - d * eye_y
head_views = [{"name": "front", "img": fi, "yaw": 0, "A": (a, d, txf, tyf), "bias": 8}]
for name, yaw in (("left", 90), ("right", -90), ("back", 180)):
    v = c[name]
    img = load(v["img"])
    k = c["front"].get("scale", 1.0) / v.get("scale", 1.0)
    d2, a2 = d * k, abs(d) * k
    ty2 = v["eye_y"] - d2 * eye_y
    if yaw == 180:
        tx2 = v["axis_x"]
    else:
        row = np.where(figure_mask(img)[int(d2 * nose[1] + ty2)])[0]
        tx2 = (row.min() + a2 * nose[2]) if yaw == 90 else (row.max() - a2 * nose[2])
    head_views.append({"name": name, "img": img, "yaw": yaw, "A": (a2, d2, tx2, ty2), "bias": 1})

neck_y0 = eye_y - r.get("neck_below_eye", 0.135)
jaw = ctr[(ctr[:, 1] < mouth_y - 0.022) & (ctr[:, 1] > mouth_y - 0.08) & (ctr[:, 2] > 0)]
chin_y = float(jaw[np.argmax(jaw[:, 2]), 1]) if len(jaw) else mouth_y - 0.045
sk_top = float(V[np.abs(V[:, 0]) < 0.03, 1].max())
chin_px_front, report_lm = 0.0, 0
if r.get("calib"):
    # Modellen är redan formad efter bilderna, så de läggs på rakt, utan extra förvrängning.
    cal = json.load(open(r["calib"]))
    ref_eye = cal["eye_y"]
    a, d = cal["s"], -cal["s"]
    head_views[0]["A"] = (a, d, cal["axis"], cal["eye_row"] - d * ref_eye)
    for view in head_views[1:]:
        k_ = c["front"].get("scale", 1.0) / c[view["name"]].get("scale", 1.0)
        a2, d2 = a * k_, d * k_
        ty2 = c[view["name"]]["eye_y"] - d2 * ref_eye
        if view["yaw"] == 180:
            tx2 = c["back"]["axis_x"]
        elif view["yaw"] == 90:
            tx2 = cal["off"] * cal["sl"]
        else:
            row = np.where(figure_mask(view["img"])[int(d2 * nose[1] + ty2)])[0]
            tx2 = row.max() - a2 * nose[2]
        view["A"] = (a2, d2, tx2, ty2)

# Helkroppsbilderna.
body_views = []
for name, yaw, only_legs in (("front", 0, False), ("back", 180, False), ("left", 90, True), ("right", -90, True)):
    img = load(r["full"][name])
    m = figure_mask(img)
    rows = np.where(m.sum(1) > 12)[0]
    rows = rows[rows < int(m.shape[0] * 0.97)]
    t_, b_ = rows.min(), rows.max()
    k = (b_ - t_) / top
    if yaw in (0, 180):
        cols = np.where(m[int(b_ - 1.1 * k)])[0]
        mid = m.shape[1] / 2 if len(cols) == 0 else (cols.min() + cols.max()) / 2
        tx_ = mid
    else:
        diffs = []
        for y in np.arange(0.22, 0.58, 0.02):
            q = np.where(m[int(b_ - y * k)])[0]
            z = V[np.abs(V[:, 1] - y) < 0.02, 2]
            if len(q) and len(z):
                zc = (z.max() + z.min()) / 2
                diffs.append((q.min() + q.max()) / 2 + (zc * k if yaw == 90 else -zc * k))
        tx_ = float(np.median(diffs))
    body_views.append({"name": name, "img": img, "yaw": yaw, "A": (k, -k, tx_, float(b_)), "bias": 1, "legs": only_legs})

neck_y = eye_y - r.get("neck_below_eye", 0.135)
GRID = 0.003
report = {"chin_y": round(chin_y, 3), "chin_px": round(float(chin_px_front), 1), "skull_top": round(sk_top, 3), "landmarks": report_lm, "eye_y": round(eye_y, 3), "mouth_y": round(mouth_y, 3), "nose": np.round(nose, 3).tolist(), "pupils_px": [np.round(pl, 1).tolist(), np.round(pr, 1).tolist()], "mouth_px": round(my, 1), "front_px_per_m": [round(float(a), 1), round(float(-d), 1)]}


def project(view, p, n):
    th = np.radians(view["yaw"])
    rx, cd = np.array([np.cos(th), 0, -np.sin(th)], np.float32), np.array([np.sin(th), 0, np.cos(th)], np.float32)
    X, Z = p @ rx, p @ cd
    bx = ((X - X.min()) / GRID).astype(np.int32)
    by = ((p[:, 1].max() - p[:, 1]) / GRID).astype(np.int32)
    zb = np.full((by.max() + 1, bx.max() + 1), -1e9, np.float32)
    np.maximum.at(zb, (by, bx), Z)
    vis = Z >= zb[by, bx] - 0.012
    f = n @ cd
    a_, d_, tx_, ty_ = view["A"]
    u, v = a_ * X + tx_, d_ * p[:, 1] + ty_
    m = ndimage.binary_erosion(figure_mask(view["img"]), iterations=4)
    soft = ndimage.gaussian_filter(m.astype(np.float32), 2.0)
    col = np.stack([ndimage.map_coordinates(view["img"][..., i], [v, u], order=1, cval=0) for i in range(3)], 1).astype(np.float32)
    wt = (vis * smooth(0.08, 0.5, f) * ndimage.map_coordinates(soft, [v, u], order=1, cval=0)).astype(np.float32)
    return wt, col, wt * view["bias"] * np.maximum(f, 0.02) ** 6


results = []
for view in head_views:
    results.append((view, *project(view, pos, nor), "head"))
for view in body_views:
    results.append((view, *project(view, pos, nor), "body"))
# Färgen: kroppsbilderna mot huvudbilderna, mätt på halsen. Sidorna mot framsidan inom sin grupp.
hf, bf = results[0], results[len(head_views)]
band = (pos[:, 1] > neck_y - 0.04) & (pos[:, 1] < neck_y + 0.03) & (hf[1] > 0.3) & (bf[1] > 0.3)
gain = np.clip(np.median(hf[2][band], 0) / (np.median(bf[2][band], 0) + 1e-4), 0.85, 1.25) if band.sum() > 200 else np.ones(3)
report["body_gain"] = np.round(gain, 3).tolist()
blend = smooth(neck_y - 0.03, neck_y + 0.03, pos[:, 1])
# Armarna: utanför bålen, ovanför höften. De målas inte, eftersom bildens armar står annorlunda.
arm = (np.abs(pos[:, 0]) > r.get("arm_x", 0.175)) & (pos[:, 1] > 0.85)
inner = smooth(1.0, 0.8, np.sqrt((pos[:, 0] / 0.075) ** 2 + ((pos[:, 1] - eye_y + 0.02) / 0.075) ** 2)) * (pos[:, 2] > 0.02)
# Huden framför öronen, under ögonen: hårfärg där är fel i bilden, så det fylls från närmaste hud.
skin_only = (pos[:, 2] > nose[2] - 0.1) & (pos[:, 1] < eye_y - 0.012) & (pos[:, 1] > neck_y0 - 0.1)
W, E, Col = [], [], []
for view, wt, col, e, kind in results:
    if kind == "head":
        k_ = blend * (~(skin_only & (col.sum(1) < 1.05) & (col[:, 0] > col[:, 1]) & (col[:, 1] > col[:, 2])))
        if view["yaw"] != 0:
            k_ = k_ * (1 - inner)
        else:
            wt = np.maximum(wt, inner * (wt > 0.01))
    else:
        k_ = (1 - blend) * (~arm)
        col = (col * gain).astype(np.float32)
        # Hår på axlar och hals i helkroppsbilden hör inte till kroppen.
        hairy = (col.sum(1) < 1.25) & (col[:, 0] > col[:, 1]) & (col[:, 1] > col[:, 2]) & (pos[:, 1] > neck_y0 - 0.2)
        k_ = k_ * (~hairy)
        if view.get("legs"):
            k_ = k_ * (pos[:, 1] < 0.85)
    W.append(wt * k_)
    E.append(e * k_)
    Col.append(col)
W, E = np.stack(W), np.stack(E)
den = E.sum(0) + 1e-6
mix = sum(Col[i] * (E[i] / den)[..., None] for i in range(len(results)))
seen = (W.max(0) > 0.5) & (den > 1e-3)
idx = np.where(seen)[0]
sub = idx[np.linspace(0, len(idx) - 1, min(len(idx), 400000)).astype(int)]
_, near = cKDTree(pos[sub]).query(pos[~seen], workers=-1)
fill = mix.copy()
fill[~seen] = mix[sub][near]
# Armarna får kroppens hudton: halsens och axelns median.
skin_zone = seen & (pos[:, 1] > neck_y - 0.05) & (pos[:, 1] < neck_y + 0.02)
skin = np.median(mix[skin_zone], 0)
fill[arm] = skin
canvas = np.zeros((S, S, 3), np.float32)
canvas[ty, tx] = fill
cov = np.zeros((S, S), bool)
cov[ty, tx] = True
ind = ndimage.distance_transform_edt(~cov, return_distances=False, return_indices=True)
canvas = canvas[ind[0], ind[1]]
Image.fromarray((canvas.clip(0, 1) * 255 + 0.5).astype(np.uint8)).save(out / "body.png")
mat = trimesh.visual.material.PBRMaterial(name="skin", baseColorTexture=Image.open(out / "body.png"), roughnessFactor=0.75, metallicFactor=0.0)
b2 = trimesh.Trimesh(V, F, process=False, visual=trimesh.visual.TextureVisuals(uv=UV, material=mat))
# Mjuk yta: normalerna räknas över alla sömmar, även hörn som delats av UV eller loop-steget.
_, w_ = np.unique(np.round(V, 5), axis=0, return_inverse=True)
w_ = w_.ravel()
fn_ = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
Nw_ = np.zeros((w_.max() + 1, 3))
for i in range(3):
    np.add.at(Nw_, w_[F[:, i]], fn_)
b2.vertex_normals = (Nw_ / (np.linalg.norm(Nw_, axis=1, keepdims=True) + 1e-12))[w_]

# Ögonen: framifrån.
EV, EF, EUV = Ev, np.asarray(eyes.faces), np.asarray(eyes.visual.uv)
ety, etx, epos, enor = texels(EV, EF, EUV, 512)
a_, d_, tx_, ty_ = head_views[0]["A"]
eu, ev = a_ * epos[:, 0] + tx_, d_ * epos[:, 1] + ty_
ecan = np.zeros((512, 512, 3), np.float32)
ecan[ety, etx] = np.stack([ndimage.map_coordinates(fi[..., i], [ev, eu], order=1) for i in range(3)], 1)
ecov = np.zeros((512, 512), bool)
ecov[ety, etx] = True
ei = ndimage.distance_transform_edt(~ecov, return_distances=False, return_indices=True)
Image.fromarray((ecan[ei[0], ei[1]].clip(0, 1) * 255 + 0.5).astype(np.uint8)).save(out / "eyes.png")
e2 = trimesh.Trimesh(EV, EF, process=False, visual=trimesh.visual.TextureVisuals(uv=EUV, material=trimesh.visual.material.PBRMaterial(name="eyes", baseColorTexture=Image.open(out / "eyes.png"), roughnessFactor=0.3, metallicFactor=0.0)))

s = trimesh.Scene()
s.add_geometry(b2, node_name="body", geom_name="body")
s.add_geometry(e2, node_name="eyes", geom_name="eyes")
s.add_geometry(hair, node_name="hair", geom_name="hair")
s.export(out / "nora.glb", include_normals=True)
report.update({"seen_share": round(float(seen.mean()), 3), "tris": {"body": len(F), "eyes": len(EF), "hair": len(hair.faces)}, "mb": round((out / "nora.glb").stat().st_size / 2**20, 1)})
print(json.dumps(report))
