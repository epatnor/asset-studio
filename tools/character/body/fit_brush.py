"""Kantpassning som för hand: modellen läggs över referensen, varje hörn på konturen dras till bildens kant, grannarna följer med.

  uv run ... python tools/fit_brush.py '{"glb": "build/nora_mpfb/head_fitted.glb", "calib": "build/nora_mpfb/head_calib.json", "full_front": "..", "full_side": "..", "out": "build/nora_mpfb/brushed.glb", "sheet": "build/nora_mpfb/overlay.png"}'

Penseln är viktad: flytten når grannar inom en radie med mjuk avtoning, och bara ytor som vetter åt samma håll, så att framsidan inte drar med baksidan.
Kanter som inte går att lita på räknas inte: hästsvansen, hårknuten, armarna och händerna, som står annorlunda i bilderna.
Skriver glb, ett ark med modellens kontur (rött) över bilderna före och efter, och en rad JSON med felet i mm längs konturen."""
import json, sys

import cv2
import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

r = json.loads(sys.argv[1])
c = json.load(open(r["calib"]))
scene = trimesh.load(r["glb"])
name = lambda key: next(n for n in scene.geometry if key in n)
kb, ke, kh = name("female"), name("low-poly"), name("ponytail")
body = scene.geometry[kb]
V0, F0 = np.array(body.vertices), np.asarray(body.faces)
_, weld = np.unique(np.round(V0, 5), axis=0, return_inverse=True)
weld = weld.ravel()
V = np.zeros((weld.max() + 1, 3))
V[weld] = V0
F = weld[F0]
smooth = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))
top_all = max(g.bounds[1, 1] for g in scene.geometry.values())
eye_y, mouth_y, chin_y = c["eye_y"], c["mouth_y"], c["chin_y"]
split_y = chin_y - 0.08
xarm = r.get("arm_x", 0.19)
# Armen: långt ut i sidled. Under armbågens höjd är armen redan bortom höfterna, så där är gränsen vidare.
arm_v = (np.abs(V[:, 0]) > np.where(V[:, 1] < 1.03, r.get("arm_x_low", 0.27), xarm)) & (V[:, 1] > 0.75) | ((np.abs(V[:, 0]) > 0.14) & (V[:, 1] > 1.22))
keep_f = ~arm_v[F].any(1)


def figure(path):
    im = np.asarray(Image.open(path).convert("RGB"))
    a = im.astype(np.float32) / 255
    e = np.concatenate([a[:12].reshape(-1, 3), a[:, :12].reshape(-1, 3), a[:, -12:].reshape(-1, 3)])
    lab, _ = ndimage.label(np.abs(a - np.median(e, 0)).sum(2) < 0.13)
    keep = np.unique(np.r_[lab[0], lab[:, 0], lab[:, -1]])
    return im, ndimage.binary_opening(~np.isin(lab, keep[keep > 0]), iterations=2)


def full_cal(path, side):
    im, m = figure(path)
    rows = np.where(m.sum(1) > 12)[0]
    rows = rows[rows < int(m.shape[0] * 0.97)]
    k, bot = (rows.max() - rows.min()) / top_all, rows.max()
    if side:
        off = []
        for y in np.arange(0.22, 0.58, 0.02):
            q = np.where(m[int(bot - y * k)])[0]
            z = V[np.abs(V[:, 1] - y) < 0.02, 2]
            if len(q) and len(z):
                off.append((z.max() + z.min()) / 2 + (q.min() + q.max()) / 2 / k)
        o = float(np.median(off))
        return im, m, lambda P: np.c_[(o - P[:, 2]) * k, bot - P[:, 1] * k], 1 / k
    ax = np.median([(np.where(m[int(bot - y * k)])[0].min() + np.where(m[int(bot - y * k)])[0].max()) / 2 for y in np.arange(0.3, 0.7, 0.05)])
    return im, m, lambda P: np.c_[ax + P[:, 0] * k, bot - P[:, 1] * k], 1 / k


# Vyerna. to_px går från modell till bild; allow säger vilka hörn som får följa kanten.
s, sl, ax, er, off, le, ey, lk = c["s"], c["sl"], c["axis"], c["eye_row"], c["off"], c["le"], c["ey"], c["lk"]
imf, mf = figure(c["front_img"])
iml, ml = figure(c["left_img"])
views = [
    {"name": "head_front", "img": imf, "mask": mf, "px": lambda P: np.c_[ax + P[:, 0] * s, er + (eye_y - P[:, 1]) * s], "m": 1 / s, "axis": 0,
     "allow": lambda P: (P[:, 1] > split_y) & ~((np.abs(P[:, 0]) < 0.05) & (P[:, 1] > c["skull_top"] - 0.02)), "R": 0.018, "sym_left_only_below": mouth_y},
    {"name": "head_side", "img": iml, "mask": ml, "px": lambda P: np.c_[(off - P[:, 2]) * sl, le + (er + (eye_y - P[:, 1]) * s - ey) * lk], "m": 1 / sl, "axis": 2,
     "allow": lambda P: (P[:, 1] > split_y) & (P[:, 2] > np.median(V[V[:, 1] > split_y, 2]) - 0.005), "R": 0.016},
]
imb, mb, pb, mmb = full_cal(r["full_front"], False)
ims, ms, ps, mms = full_cal(r["full_side"], True)
views += [
    {"name": "body_front", "img": imb, "mask": mb, "px": pb, "m": mmb, "axis": 0, "allow": lambda P: (P[:, 1] > 0.93) & (P[:, 1] < 1.2), "R": 0.05},
    {"name": "body_side", "img": ims, "mask": ms, "px": ps, "m": mms, "axis": 2, "allow": lambda P: (P[:, 1] > 0.6) & (P[:, 1] < split_y), "R": 0.05},
]
for v in views:
    out_ = ndimage.distance_transform_edt(~v["mask"])
    in_ = ndimage.distance_transform_edt(v["mask"])
    sdf = ndimage.gaussian_filter((out_ - in_).astype(np.float32), 1.0)
    v["sdf"], v["gy"], v["gx"] = sdf, *np.gradient(sdf)


def model_mask(P, v):
    h, w = v["mask"].shape
    pts = np.round(v["px"](P) * 8).astype(np.int32)
    m = np.zeros((h, w), np.uint8)
    for f in F[keep_f]:
        cv2.fillConvexPoly(m, pts[f], 1, lineType=cv2.LINE_8, shift=3)
    return m.astype(bool)


def contour_err(P, v):
    """Medelavstånd i mm från modellens kontur till bildens kant, bara där kanten räknas."""
    m = model_mask(P, v)
    edge = m & ~ndimage.binary_erosion(m)
    dist = ndimage.distance_transform_edt(~edge)
    px = v["px"](P)
    ok = np.ones(len(P), bool) & ~arm_v
    inb = (px[:, 0] >= 0) & (px[:, 0] < m.shape[1] - 1) & (px[:, 1] >= 0) & (px[:, 1] < m.shape[0] - 1)
    ok &= inb & v["allow"](P)
    on = np.zeros(len(P), bool)
    on[ok] = ndimage.map_coordinates(dist, [px[ok, 1], px[ok, 0]], order=1) < 2.5
    d = np.abs(ndimage.map_coordinates(v["sdf"], [px[on, 1], px[on, 0]], order=1)) * v["m"] * 1000
    return on, px, d


def normals(P):
    fn = np.cross(P[F[:, 1]] - P[F[:, 0]], P[F[:, 2]] - P[F[:, 0]])
    N = np.zeros_like(P)
    for i in range(3):
        np.add.at(N, F[:, i], fn)
    return N / (np.linalg.norm(N, axis=1, keepdims=True) + 1e-12)


def brush_step(P, v, gain=0.7, cap=0.02, reject=0.05):
    on, px, _ = contour_err(P, v)
    idx = np.where(on)[0]
    if not len(idx):
        return P, 0
    sd = ndimage.map_coordinates(v["sdf"], [px[idx, 1], px[idx, 0]], order=1)
    gx = ndimage.map_coordinates(v["gx"], [px[idx, 1], px[idx, 0]], order=1)
    gy = ndimage.map_coordinates(v["gy"], [px[idx, 1], px[idx, 0]], order=1)
    nrm = np.hypot(gx, gy) + 1e-6
    dx, dy = -sd * gx / nrm * v["m"], -sd * gy / nrm * v["m"]
    d3 = np.zeros((len(idx), 3))
    if v["axis"] == 0:
        d3[:, 0] = dx
    else:
        d3[:, 2] = -dx
    d3[:, 1] = -dy
    mag = np.linalg.norm(d3, axis=1)
    good = mag < reject
    idx, d3, mag = idx[good], d3[good], mag[good]
    d3 = d3 * np.minimum(1, cap / (mag + 1e-9))[:, None] * gain
    # Symmetri framifrån: varje hörn och dess spegelbild får samma flytt. Under munnen skymmer hästsvansen höger sida.
    if v["axis"] == 0:
        tree_m = cKDTree(P * np.array([-1, 1, 1]))
        use = np.full(len(idx), True)
        if "sym_left_only_below" in v:
            use = ~((P[idx, 0] > 0) & (P[idx, 1] < v["sym_left_only_below"]))
        extra_i, extra_d = [], []
        for i, d_ in zip(idx[use], d3[use]):
            dist, j = tree_m.query(P[i])
            if dist < 0.008:
                extra_i.append(j)
                extra_d.append(d_ * np.array([-1, 1, 1]))
        idx = np.r_[idx[use], np.array(extra_i, int)] if extra_i else idx[use]
        d3 = np.r_[d3[use], np.array(extra_d)] if extra_i else d3[use]
    # Penseln: viktad medelflytt för alla hörn inom radien, mjuk avtoning, bara ytor åt samma håll.
    N = normals(P)
    R = v["R"]
    tree = cKDTree(P)
    wsum = np.zeros(len(P))
    dsum = np.zeros_like(P)
    for i, d_ in zip(idx, d3):
        js = tree.query_ball_point(P[i], R)
        js = np.array(js)
        dist = np.linalg.norm(P[js] - P[i], axis=1)
        w = (1 - (dist / R) ** 2) ** 2 * smooth(0.0, 0.5, N[js] @ N[i])
        wsum[js] += w
        dsum[js] += w[:, None] * d_
    D = dsum / np.maximum(wsum, 1.0)[:, None]
    D[arm_v] = 0
    return P + D, len(idx)


before = V.copy()
start_err = {v["name"]: contour_err(V, v)[2] for v in views}
iters = r.get("iters", 8)
for it in range(iters):
    for v in views:
        V, n = brush_step(V, v, gain=0.75 if it < iters - 2 else 0.5)
end_err = {v["name"]: contour_err(V, v)[2] for v in views}

# Ögon och hår följer närmaste kroppshörn.
D = V - before
tree0 = cKDTree(before)


def follow(P, reach=0.03, k=6):
    d, j = tree0.query(P, k=k)
    w = np.maximum(1 - d / reach, 0) ** 2
    return P + (w[..., None] * D[j]).sum(1) / np.maximum(w.sum(1, keepdims=True), 1e-6)


scene.geometry[kb] = trimesh.Trimesh(V[weld], F0, process=False, visual=body.visual)
scene.geometry[ke] = trimesh.Trimesh(follow(np.array(scene.geometry[ke].vertices)), scene.geometry[ke].faces, process=False, visual=scene.geometry[ke].visual)
scene.geometry[kh] = trimesh.Trimesh(follow(np.array(scene.geometry[kh].vertices)), scene.geometry[kh].faces, process=False, visual=scene.geometry[kh].visual)
scene.export(r["out"])

# Arket: modellens kontur över bilden, före och efter.
H = 420
rows_sheet = []
for P in (before, V):
    cells = []
    for v in views:
        m = model_mask(P, v).astype(np.uint8)
        im = v["img"].copy()
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(im, cs, -1, (230, 20, 20), max(2, im.shape[0] // 500))
        if v["name"].startswith("body"):
            top = int(v["px"](np.array([[0, 1.3, 0.05]]))[0, 1])
            bot = int(v["px"](np.array([[0, 0.55, 0.05]]))[0, 1])
            im = im[top:bot]
        f = H / im.shape[0]
        im = cv2.resize(im, (int(im.shape[1] * f), H), interpolation=cv2.INTER_AREA)
        cells.append(im)
    rows_sheet.append(np.hstack(cells))
wid = min(x.shape[1] for x in rows_sheet)
Image.fromarray(np.vstack([x[:, :wid] for x in rows_sheet])).save(r["sheet"])
ctr = V[np.abs(V[:, 0]) < 0.004]
chin = ctr[(ctr[:, 1] < mouth_y) & (ctr[:, 1] > chin_y - 0.03) & (ctr[:, 2] > 0)]
face = ctr[(ctr[:, 1] < eye_y + 0.02) & (ctr[:, 1] > chin_y - 0.03) & (ctr[:, 2] > 0)]
fmt = lambda e: {k: {"mean": round(float(d.mean()), 1), "p95": round(float(np.percentile(d, 95)), 1), "n": int(len(d))} for k, d in e.items() if len(d)}
print(json.dumps({"before_mm": fmt(start_err), "after_mm": fmt(end_err), "max_move_mm": round(float(np.linalg.norm(D, axis=1).max() * 1000), 1), "centerline_verts": {"mouth_to_chin": int(len(chin)), "brow_to_chin": int(len(face))}, "chin_rows_y": np.round(np.sort(chin[:, 1])[::-1], 3).tolist()}))
