"""Formar huvudets mesh efter närbildernas konturer: framifrån (bredd, pupiller, mun, haka) och i profil (panna, näsa, läppar, haka).

  .venv/bin/python tools/fit_head.py '{"glb": "build/nora_mpfb/fitted.glb", "close": "build/nora_head/recipe.json", "full_front": ".../fram.png", "out": "build/nora_mpfb/head_fitted.glb"}'

Topologin är oförändrad. Kropp, ögon och hår flyttas med samma funktion, så att de sitter ihop. Halsen tonas ut mot kroppen.
Skalan tas från helkroppsbilden, så att huvudet blir lika stort i förhållande till kroppen som hos referensen. Skriver en rad JSON."""
import json, sys

import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
from scipy.interpolate import RBFInterpolator

r = json.loads(sys.argv[1])
scene = trimesh.load(r["glb"])
name = lambda key: next(n for n in scene.geometry if key in n)
kb, ke, kh = name("female"), name("low-poly"), name("ponytail")
V, Ev, Hv = np.array(scene.geometry[kb].vertices), np.array(scene.geometry[ke].vertices), np.array(scene.geometry[kh].vertices)
F = np.asarray(scene.geometry[kb].faces)
smooth = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))
views = {v["name"]: v for v in json.load(open(r["close"]))["views"]}


def figure(path):
    im = np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255
    e = np.concatenate([im[:12].reshape(-1, 3), im[:, :12].reshape(-1, 3), im[:, -12:].reshape(-1, 3)])
    lab, _ = ndimage.label(np.abs(im - np.median(e, 0)).sum(2) < 0.13)
    keep = np.unique(np.r_[lab[0], lab[:, 0], lab[:, -1]])
    return im, ndimage.binary_opening(~np.isin(lab, keep[keep > 0]), iterations=2)


# Modellens drag.
samp, _ = trimesh.sample.sample_surface(trimesh.Trimesh(V, F, process=False), 500000, seed=1)
pup = np.array([Ev[Ev[:, 0] < 0].mean(0), Ev[Ev[:, 0] > 0].mean(0)])
eye_y = float(pup[:, 1].mean())
ctr = samp[np.abs(samp[:, 0]) < 0.006]
face = ctr[(ctr[:, 1] < eye_y) & (ctr[:, 1] > eye_y - 0.14) & (ctr[:, 2] > 0)]
nose = face[np.argmax(face[:, 2])]
# Läpparna: bulan en bit under nästippen. Närmare än 2 cm är det bara näsroten.
under = face[(face[:, 1] < nose[1] - 0.02) & (face[:, 1] > nose[1] - 0.06)]
mouth_y = float(under[np.argmax(under[:, 2]), 1])
jaw = face[(face[:, 1] < mouth_y - 0.022) & (face[:, 1] > mouth_y - 0.08)]
chin_y = float(jaw[np.argmax(jaw[:, 2]), 1])
sk_top = float(samp[np.abs(samp[:, 0]) < 0.03, 1].max())
neck_y = chin_y - r.get("neck_below_chin", 0.05)

# Bildens drag.
fi, fm = figure(views["front"]["img"])
li, lm = figure(views["left"]["img"])
ey, ax = views["front"]["eye_y"], views["front"]["axis_x"]
g = fi.sum(2)
rows_, cols_ = np.arange(fi.shape[0])[:, None], np.arange(fi.shape[1])[None, :]
band = (np.abs(rows_ - ey) < 30) & (np.abs(cols_ - ax) > 60) & (np.abs(cols_ - ax) < 210)
yy, xx = np.where((g < np.percentile(g[band], 8)) & band)
pl, pr = (xx[xx < ax].mean(), yy[xx < ax].mean()), (xx[xx > ax].mean(), yy[xx > ax].mean())
red = (fi[..., 0] - fi[..., 1]) * ((np.abs(cols_ - ax) < 70) & (rows_ > ey + 150) & (rows_ < ey + 310))
my = float(np.argmax(ndimage.gaussian_filter1d(red.sum(1), 4)))
axis = (pl[0] + pr[0]) / 2
eye_row = (pl[1] + pr[1]) / 2
le, lk = views["left"]["eye_y"], views["front"].get("scale", 1.0) / views["left"].get("scale", 1.0)
front_col = lambda row: np.where(lm[int(row)])[0].min() if lm[int(row)].any() else lm.shape[1]
lr = le + (my - ey) * lk
rr = np.arange(int(lr), int(lr + 260))
prof = ndimage.gaussian_filter1d(np.array([front_col(y) for y in rr], float), 2)
dip = int(np.argmax(prof[8:70])) + 8
chin_i = dip + int(np.argmin(prof[dip:dip + 130]))
chin_row = ey + (rr[chin_i] - le) / lk
skull_row = np.where(fm.sum(1) > 0.5 * np.ptp(np.where(fm[int(ey)])[0]))[0].min()

# Skalan: huvudets bredd vid ögonen i närbilden mot helkroppsbilden.
ff, ffm = figure(r["full_front"])
rows = np.where(ffm.sum(1) > 12)[0]
rows = rows[rows < int(ffm.shape[0] * 0.97)]
top_all = max(g_.bounds[1, 1] for g_ in scene.geometry.values())
k = (rows.max() - rows.min()) / top_all
wf = np.where(ffm[int(rows.max() - eye_y * k)])[0]
a_ = int((wf.min() + wf.max()) / 2)
l_, h_ = a_, a_
row_ = ffm[int(rows.max() - eye_y * k)]
while l_ > 0 and row_[l_]:
    l_ -= 1
while h_ < len(row_) - 1 and row_[h_]:
    h_ += 1
w_close = np.ptp(np.where(fm[int(eye_row)])[0])
s = float(r.get("px_per_m") or w_close / ((h_ - l_) / k))
sl = s * lk
ym, ri = [sk_top, eye_y, mouth_y, chin_y, neck_y], [float(skull_row), eye_row, my, chin_row, chin_row + (chin_row - my) * (chin_y - neck_y) / max(mouth_y - chin_y, 0.01)]
row_of = lambda y: float(np.interp(-y, -np.array(ym), ri))
ref_y = lambda row: eye_y + (eye_row - row) / s

# Framifrån: kontur, pupiller, mun, näsa.
head = samp[(samp[:, 1] > neck_y - 0.01) & (np.abs(samp[:, 0]) < 0.14)]
src, dst = [(pup[0, 0], eye_y), (pup[1, 0], eye_y), (0.0, mouth_y), (0.0, chin_y)], [((pl[0] - axis) / s, eye_y), ((pr[0] - axis) / s, eye_y), (0.0, ref_y(my)), (0.0, ref_y(chin_row))]
for y in np.linspace(sk_top - 0.012, neck_y, 8):
    q = head[np.abs(head[:, 1] - y) < 0.003, 0]
    rw = int(row_of(y))
    c = np.where(fm[rw])[0]
    if len(q) < 5 or not len(c):
        continue
    half_l = (axis - c.min()) / s
    # Hästsvansen syns till höger under käken, så där speglas vänster kant.
    half_r = (c.max() - axis) / s if y > mouth_y else half_l
    src += [(q.min(), y), (q.max(), y)]
    dst += [(-half_l, ref_y(rw)), (half_r, ref_y(rw))]
front = RBFInterpolator(np.array(src), np.array(dst), kernel="thin_plate_spline", smoothing=1e-4)

# Profilen: framsidans kontur, rad för rad. Nacken och bakhuvudet bara högt upp, där hästsvansen inte skymmer.
cen = samp[(np.abs(samp[:, 0]) < 0.01) & (samp[:, 1] > neck_y - 0.01)]
pts = []
for y in np.linspace(sk_top - 0.006, neck_y, 34):
    q = cen[np.abs(cen[:, 1] - y) < 0.0025, 2]
    rw = le + (row_of(y) - ey) * lk
    if len(q) >= 3 and lm[int(rw)].any():
        pts.append((q.max(), y, front_col(rw), ref_y(row_of(y))))
pts = np.array(pts)
mid = (pts[:, 1] < eye_y) & (pts[:, 1] > mouth_y)
off = float(np.median(pts[mid, 0] + pts[mid, 2] / sl))
src2 = [(p[0], p[1]) for p in pts]
dst2 = [(off - p[2] / sl, p[3]) for p in pts]
dz_mean = float(np.median([d[0] - s_[0] for s_, d in zip(src2, dst2)]))
for y in np.linspace(sk_top - 0.01, sk_top - 0.05, 3):
    q = cen[np.abs(cen[:, 1] - y) < 0.0025, 2]
    rw = le + (row_of(y) - ey) * lk
    c = np.where(lm[int(rw)])[0]
    if len(q) >= 3 and len(c):
        src2.append((q.min(), y))
        dst2.append((off - c.max() / sl, ref_y(row_of(y))))
q = samp[(np.abs(samp[:, 0]) < 0.02) & (np.abs(samp[:, 1] - eye_y) < 0.004), 2]
src2.append((q.min(), eye_y))
dst2.append((q.min() + dz_mean, eye_y))
side = RBFInterpolator(np.array(src2), np.array(dst2), kernel="thin_plate_spline", smoothing=1e-4)

lim = r.get("clamp", 0.04)


def warp(P, is_hair=False):
    P = P.copy()
    w = smooth(neck_y - 0.03, neck_y + 0.02, P[:, 1])
    Y = np.maximum(P[:, 1], neck_y) if is_hair else P[:, 1]
    if is_hair:
        w = np.ones(len(P))
    f = front(np.c_[P[:, 0], Y])
    z = side(np.c_[P[:, 2], Y])
    P[:, 0] += np.clip(f[:, 0] - P[:, 0], -lim, lim) * w
    P[:, 1] += np.clip(f[:, 1] - Y, -lim, lim) * w
    P[:, 2] += np.clip(z[:, 0] - P[:, 2], -lim, lim) * w
    return P


Vn = V.copy()
near = np.abs(V[:, 0]) < 0.2
above = near & (V[:, 1] > neck_y - 0.04)
Vn[above] = warp(V[above])
En, Hn = warp(Ev), warp(Hv, is_hair=True)
for key, P in ((kb, Vn), (ke, En), (kh, Hn)):
    g_ = scene.geometry[key]
    scene.geometry[key] = trimesh.Trimesh(P, g_.faces, process=False, visual=g_.visual)
scene.export(r["out"])
json.dump({"s": s, "sl": sl, "axis": float(axis), "eye_row": float(eye_row), "off": off, "le": float(le), "ey": float(ey), "lk": float(lk), "eye_y": eye_y, "mouth_y": float(ref_y(my)), "chin_y": float(ref_y(chin_row)), "skull_top": float(ref_y(skull_row)), "front_img": views["front"]["img"], "left_img": views["left"]["img"]}, open(r["out"].rsplit("/", 1)[0] + "/head_calib.json", "w"))
# Kontroll: profilen före och efter mot bilden, och konturen framifrån.
samp2, _ = trimesh.sample.sample_surface(trimesh.Trimesh(Vn, F, process=False), 500000, seed=2)
c2 = samp2[np.abs(samp2[:, 0]) < 0.006]
errs_before, errs_after = [], []
for p, d in zip(pts, dst2):
    a0 = abs(p[0] - d[0])
    q = c2[np.abs(c2[:, 1] - d[1]) < 0.0025, 2]
    if len(q) >= 2:
        errs_before.append(a0)
        errs_after.append(abs(q.max() - d[0]))
hs = samp2[(samp2[:, 1] > neck_y) & (np.abs(samp2[:, 0]) < 0.14)]
pn = np.array([En[En[:, 0] < 0].mean(0), En[En[:, 0] > 0].mean(0)])
print(json.dumps({"px_per_m": round(s, 1), "features_model": {"eye": round(eye_y, 3), "nose": round(float(nose[1]), 3), "mouth": round(mouth_y, 3), "chin": round(chin_y, 3), "top": round(sk_top, 3)},
                  "rows_image": {"skull": int(skull_row), "eye": round(eye_row, 1), "mouth": round(my, 1), "chin": round(float(chin_row), 1)},
                  "ref_m": {"eye_to_mouth": round((my - eye_row) / s, 3), "eye_to_chin": round((chin_row - eye_row) / s, 3), "ipd": round((pr[0] - pl[0]) / s, 3), "eye_to_top": round((eye_row - skull_row) / s, 3)},
                  "model_m_before": {"eye_to_mouth": round(eye_y - mouth_y, 3), "eye_to_chin": round(eye_y - chin_y, 3), "ipd": round(float(pup[1, 0] - pup[0, 0]), 3), "eye_to_top": round(sk_top - eye_y, 3)},
                  "ipd_after": round(float(pn[1, 0] - pn[0, 0]), 3), "profile_err_mm": {"before": round(float(np.mean(errs_before) * 1000), 1), "after": round(float(np.mean(errs_after) * 1000), 1), "after_p95": round(float(np.percentile(errs_after, 95) * 1000), 1)}, "landmarks": [len(src), len(src2)]}))
