"""Tar bort framåtbulor på bål och ben: drar in framsidan mot sidoreferensens kontur. Skjuter aldrig ut och rör inte baksidan.

  .venv/bin/python tools/fix_front_profile.py '{"body": ".../nora_L1f_face.glb", "ref": ".../vanster.png", "level": "1f", "out": "build/nora_head/body_fixed.glb"}'

Pixal3D kan lägga en rund kudde över underlivet, och mallen följer den troget. Referensen visar figuren från sidan (ansiktet åt
vänster). Hörnens ordning behålls, så att mallens delar stämmer. Bara delarna torso och leg flyttas, inte armarna.
Skriver en rad JSON: profilen före och efter mot referensen, och antal ställen där framsidan buktar (lokala toppar under bysten)."""
import json, sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from template import Template  # noqa: E402

r = json.loads(sys.argv[1])
b = trimesh.load(r["body"], force="scene", process=False).to_geometry()
V = np.array(b.vertices)
F = np.asarray(b.faces)
tris, tpart = Template(r.get("level", "1f")).triangles()
assert len(tris) == len(F), "kroppen följer inte mallens ordning"
H = float(V[:, 1].max())
y0, y1, fade = r.get("y0", 0.62), r.get("y1", 1.2), r.get("fade", 0.08)
smooth = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))

# Referensens framkontur, i meter från fotleden.
im = np.asarray(Image.open(r["ref"]).convert("RGB")).astype(np.float32) / 255
edge = np.concatenate([im[:12].reshape(-1, 3), im[:, :12].reshape(-1, 3), im[:, -12:].reshape(-1, 3)])
lab, _ = ndimage.label(np.abs(im - np.median(edge, 0)).sum(2) < r.get("bg_tol", 0.13))
keep = np.unique(np.r_[lab[0], lab[:, 0], lab[:, -1]])
mask = ~np.isin(lab, keep[keep > 0])
mask = ndimage.binary_opening(mask, iterations=2)
ys, xs = np.where(mask)
top, bot = ys.min(), ys.max()
k = (bot - top) / H
ankle = np.median(xs[ys > bot - 10])
parts = np.array([str(p).startswith(("torso", "leg")) for p in tpart])
movable = np.zeros(len(V), bool)
movable[np.unique(F[parts])] = True
mesh_parts = trimesh.Trimesh(V, F[parts], process=False)
pts, _ = trimesh.sample.sample_surface(mesh_parts, 500000, seed=1)
levels = np.arange(y0, y1 + 0.001, 0.01)


def front_of(p):
    out = np.full(len(levels), np.nan)
    for i, y in enumerate(levels):
        s = p[np.abs(p[:, 1] - y) < 0.005]
        if len(s):
            out[i] = np.percentile(s[:, 2], 99.8)
    return out


ref = np.full(len(levels), np.nan)
for i, y in enumerate(levels):
    c = np.where(mask[int(bot - y * k)])[0]
    if len(c):
        ref[i] = (ankle - c.min()) / k
front = front_of(pts)
# Samma noll: benens mitt mellan knä och vad, där varken armar, bäcken eller golvet stör. Bysten ligger olika och duger inte.
diffs = []
for y in np.arange(0.22, 0.58, 0.02):
    s = pts[np.abs(pts[:, 1] - y) < 0.005, 2]
    c = np.where(mask[int(bot - y * k)])[0]
    if len(s) and len(c):
        diffs.append((s.max() + s.min()) / 2 - (ankle - (c.min() + c.max()) / 2) / k)
ref = ref + float(np.median(diffs))
d = np.minimum(ref - front, 0)
d = d * smooth(y0, y0 + fade, levels) * smooth(y1, y1 - fade, levels)
d = ndimage.gaussian_filter1d(np.nan_to_num(d), r.get("sigma", 2.0))
# Inverkan: full framtill, ingen från mitten av djupet och bakåt. Mitten räknas per höjd, så att benen och bålen följs.
mid = np.array([np.percentile(pts[np.abs(pts[:, 1] - y) < 0.005, 2], 50) for y in levels])
dep = np.maximum(front - mid, 0.01)
fy = (V[:, 1] - y0) / 0.01
Dz = ndimage.map_coordinates(d, [fy], order=1, mode="nearest")
Mz = ndimage.map_coordinates(mid, [fy], order=1, mode="nearest")
Dp = ndimage.map_coordinates(dep, [fy], order=1, mode="nearest")
w = smooth(0.0, 0.8, (V[:, 2] - Mz) / Dp) * movable * ((V[:, 1] > y0) & (V[:, 1] < y1))
V[:, 2] += Dz * w
b2 = trimesh.Trimesh(V, F, process=False, visual=b.visual)
b2.export(r["out"])
after = front_of(trimesh.sample.sample_surface(trimesh.Trimesh(V, F[parts], process=False), 500000, seed=1)[0])


def bumps(f):
    """Lokala toppar i framsidan under bysten, högre än 3 mm över dalen ovanför."""
    fs = ndimage.gaussian_filter1d(np.nan_to_num(f), 1.5)
    n, i = 0, []
    lo = np.where(levels > 0.72)[0][0]
    hi = np.where(levels < r.get("bump_top", 1.15))[0][-1]
    for j in range(lo + 3, hi - 3):
        if fs[j] >= fs[j - 1] and fs[j] > fs[j + 1] and fs[j] - fs[j + 1:hi].min(initial=fs[j]) > 0.003:
            n += 1
            i.append(round(float(levels[j]), 2))
    return i


rows = {f"{y:.2f}": {"ref": round(float(np.interp(y, levels, ref) * 1000)), "before": round(float(np.interp(y, levels, front) * 1000)), "after": round(float(np.interp(y, levels, after) * 1000))} for y in (1.15, 1.05, 1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7)}
print(json.dumps({"out": r["out"], "max_pull_mm": round(float(-d.min() * 1000), 1), "moved_verts": int((np.abs(Dz * w) > 1e-4).sum()), "bumps_before": bumps(front), "bumps_after": bumps(after), "profile_mm": rows}))
