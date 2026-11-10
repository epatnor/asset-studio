"""Drar kroppens hörn mot referensens konturer framifrån och från sidan. Topologin är oförändrad, bara hörnen flyttas.

  .venv/bin/python tools/fit_silhouette.py '{"glb": "build/nora_mpfb/posed.glb", "front": ".../fram.png", "side": ".../vanster.png", "out": "build/nora_mpfb/fitted.glb"}'

Per höjd skalas bredden mot bålens spann i framvyn, och framsida och baksida mot sidovyns kontur. Armarna står inte stilla i
bilderna, så de flyttas inte, och ryggen över midjan räknas inte (armen skymmer den från sidan). Skriver en rad JSON med måtten."""
import json, sys

import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage

r = json.loads(sys.argv[1])
scene = trimesh.load(r["glb"])
key = next(n for n in scene.geometry if "female" in n)
body = scene.geometry[key]
V = np.array(body.vertices)
smooth = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))
top_model = max(g.bounds[1, 1] for g in scene.geometry.values())


def figure(path):
    im = np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255
    e = np.concatenate([im[:12].reshape(-1, 3), im[:, :12].reshape(-1, 3), im[:, -12:].reshape(-1, 3)])
    lab, _ = ndimage.label(np.abs(im - np.median(e, 0)).sum(2) < 0.13)
    keep = np.unique(np.r_[lab[0], lab[:, 0], lab[:, -1]])
    m = ndimage.binary_opening(~np.isin(lab, keep[keep > 0]), iterations=2)
    rows = np.where(m.sum(1) > 12)[0]
    rows = rows[rows < int(m.shape[0] * 0.97)]
    return m, rows.min(), rows.max()


Ff, tf, bf = figure(r["front"])
Fs, ts, bs = figure(r["side"])
kf, ks = (bf - tf) / top_model, (bs - ts) / top_model
xlim = r.get("arm_x", 0.19)
levels = np.arange(0.5, 1.46, 0.01)
mx, rx_, mf, mb, rf, rb = (np.full(len(levels), np.nan) for _ in range(6))
samp, _ = trimesh.sample.sample_surface(trimesh.Trimesh(V, body.faces, process=False), 400000, seed=1)
# Armen: långt ut i sidled. Under armbågens höjd är armen redan bortom höfterna, så där är gränsen vidare.
limit_x = lambda y: np.where(y < 1.03, r.get("arm_x_low", 0.27), xlim)
samp = samp[np.abs(samp[:, 0]) < limit_x(samp[:, 1])]
axis = np.median([(np.where(Ff[int(bf - y * kf)])[0].min() + np.where(Ff[int(bf - y * kf)])[0].max()) / 2 for y in np.arange(0.3, 0.7, 0.05)])
# Sidovyns noll: benens mitt mellan knä och vad.
off = []
for y in np.arange(0.22, 0.58, 0.02):
    q = np.where(Fs[int(bs - y * ks)])[0]
    z = samp[np.abs(samp[:, 1] - y) < 0.005, 2]
    if len(q) and len(z):
        off.append((z.max() + z.min()) / 2 + (q.min() + q.max()) / 2 / ks)
off = float(np.median(off))
for i, y in enumerate(levels):
    s = samp[np.abs(samp[:, 1] - y) < 0.005]
    if len(s) < 10:
        continue
    # Baksidan mäts nära ryggraden: längre ut ligger axeln och överarmen.
    sp = s[np.abs(s[:, 0]) < 0.1, 2]
    mx[i], mf[i], mb[i] = np.abs(s[:, 0]).max(), np.percentile(s[:, 2], 99.7), np.percentile(sp if len(sp) > 5 else s[:, 2], 0.3)
    row = Ff[int(bf - y * kf)]
    a = int(axis)
    if row[a]:
        l = a
        while l > 0 and row[l]:
            l -= 1
        h = a
        while h < len(row) - 1 and row[h]:
            h += 1
        rx_[i] = (h - l) / 2 / kf
    else:
        q = np.where(row)[0]
        rx_[i] = (q.max() - q.min()) / 2 / kf
    q = np.where(Fs[int(bs - y * ks)])[0]
    if len(q):
        rf[i], rb[i] = off - q.min() / ks, off - q.max() / ks
fill = lambda a: np.interp(levels, levels[np.isfinite(a)], a[np.isfinite(a)])
mx, rx_, mf, mb, rf, rb = map(fill, (mx, rx_, mf, mb, rf, rb))
clamp = r.get("clamp", 0.05)
gs = lambda a: ndimage.gaussian_filter1d(a, 2.5)
# Under höften når handen in i bilden och räknas annars som höft: där hålls flytten från höftens höjd.
raw_dx = np.clip(rx_ - mx, -clamp, clamp)
hip_i = int(np.argmin(np.abs(levels - r.get("hip_y", 0.94))))
raw_dx[:hip_i] = raw_dx[hip_i]
dx = gs(raw_dx) * smooth(0.6, 0.8, levels) * smooth(1.22, 1.12, levels)
df = gs(np.clip(rf - mf, -clamp, clamp)) * smooth(0.55, 0.68, levels) * smooth(1.46, 1.4, levels)
# Baksidan: hela vägen upp, med mindre utjämning så att svanken och rumpans övergång blir kvar.
db = ndimage.gaussian_filter1d(np.clip(rb - mb, -r.get("clamp_back", 0.07), r.get("clamp_back", 0.07)), 1.5) * smooth(0.55, 0.68, levels) * smooth(1.46, 1.38, levels)
fy = (V[:, 1] - levels[0]) / 0.01
at = lambda a: ndimage.map_coordinates(a, [fy], order=1, mode="nearest")
move = np.abs(V[:, 0]) < limit_x(V[:, 1])
X, Z = V[:, 0].copy(), V[:, 2].copy()
ok = move & (V[:, 1] > levels[0]) & (V[:, 1] < levels[-1])
w_ = at(mx)
V[ok, 0] = X[ok] * (1 + at(dx)[ok] / w_[ok])
f_, b_ = at(mf), at(mb)
t = np.clip((Z - b_) / np.maximum(f_ - b_, 0.02), 0, 1)
# Vid axlarna tonas flytten ut mot armen, som står still.
wz = np.where(V[:, 1] < 1.15, 1.0, smooth(xlim, 0.12, np.abs(X)))
V[ok, 2] = Z[ok] + ((at(df) * t + at(db) * (1 - t)) * wz)[ok]
scene.geometry[key] = trimesh.Trimesh(V, body.faces, process=False, visual=body.visual)
scene.export(r["out"])
rows = {f"{y:.2f}": {"half_width": [int(np.interp(y, levels, rx_) * 1000), int(np.interp(y, levels, mx + dx) * 1000)], "front": [int(np.interp(y, levels, rf) * 1000), int(np.interp(y, levels, mf + df) * 1000)], "back": [int(np.interp(y, levels, rb) * 1000), int(np.interp(y, levels, mb + db) * 1000)]} for y in (1.3, 1.12, 0.98, 0.92, 0.85, 0.75)}
print(json.dumps({"out": r["out"], "moved": int((np.abs(dx[np.clip(fy.astype(int), 0, len(levels) - 1)]) + np.abs(df[np.clip(fy.astype(int), 0, len(levels) - 1)]) > 1e-3)[ok].sum()), "max_mm": {"width": round(float(np.abs(dx).max() * 1000)), "front": round(float(np.abs(df).max() * 1000)), "back": round(float(np.abs(db).max() * 1000))}, "ref_vs_model_mm": rows}))
