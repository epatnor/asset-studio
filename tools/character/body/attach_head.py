"""Sätter ett projicerat huvud med hår på en kroppspassad mall.

  uv run ... python tools/attach_head.py '{"head": "build/nora_head/nora_head_proj.glb", "body": ".../nora_L1f_face.glb", "level": "1f", "out": "build/nora_head/on_body"}'

1. Huvudet riktas in mot mallens huvud med likformig ICP på skalle och ansikte (inte hästsvansen).
2. Mallens huvud tas bort vid halssömmen. Huvudets hals kapas strax under sömmen, så att den överlappar halsroten.
3. Halsen formas om mot kroppens hals (utjämnad förskjutning), högst upp ingenting och nederst tätt utanför kroppen.
4. Halsens färg tonas mot kroppens färg vid sömmen, varv för varv runt halsen.
Skriver head.glb och body.glb i kroppens rum, och en rad JSON med kontroller (<out>/head.glb förenklas sedan med decimate_head.py)."""
import json, sys
from pathlib import Path

import cv2
import numpy as np
import scipy.sparse as sp
import trimesh
from PIL import Image
from scipy import ndimage
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from refine_part import align  # noqa: E402
from template import Template  # noqa: E402

r = json.loads(sys.argv[1])
out = Path(r["out"])
out.mkdir(parents=True, exist_ok=True)
smooth = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))
body = trimesh.load(r["body"], force="scene").to_geometry()
head = trimesh.load(r["head"], force="scene").to_geometry()
Bv, Bf = np.asarray(body.vertices), np.asarray(body.faces)
Hv, Hf, Huv = np.asarray(head.vertices), np.asarray(head.faces), np.asarray(head.visual.uv)
tris, tpart = Template(r.get("level", "1f")).triangles()
assert len(tris) == len(Bf), "kroppen följer inte mallens ordning"
is_head = tpart == "head"

# Halssömmen: öppna kanten på mallens huvud.
_, bw = np.unique(np.round(Bv, 5), axis=0, return_inverse=True)
bw = bw.ravel()
F_ = bw[Bf[is_head]]
e = np.sort(np.r_[F_[:, [0, 1]], F_[:, [1, 2]], F_[:, [2, 0]]], axis=1)
u, c = np.unique(e, axis=0, return_counts=True)
Bw = np.zeros((bw.max() + 1, 3))
Bw[bw] = Bv
ring = Bw[np.unique(u[c == 1])]
ring_y, ring_c = float(ring[:, 1].mean()), ring.mean(0)

# Inriktning.
sk = r.get("skull", {"c": [0, 0.6, 0.04], "r": [0.225, 0.335, 0.25]})
ell = (((Hv - np.array(sk["c"])) / np.array(sk["r"])) ** 2).sum(1)
Q = Hv[(ell < 1) & (Hv[:, 1] > r.get("skull_min_y", 0.38))][::6]
sub = body.submesh([np.where(is_head)[0]], append=True, only_watertight=False)
P, _ = trimesh.sample.sample_surface(sub, 30000, seed=1)
P = P[P[:, 1] > ring_y + 0.03]
s, R, t, err = align(Q, P, upright=True)
V = s * (Hv @ R.T) + t

# Halsen: hud under sömmens höjd, inte hästsvansen. Gapet mellan hals och svans hittas i huvudets eget mått.
band = (Hv[:, 1] > 0.18) & (Hv[:, 1] < 0.32) & (Hv[:, 2] < 0)
hist, edges = np.histogram(Hv[band, 2], bins=np.arange(-0.36, 0.0, 0.004))
gap_i = np.where(hist == 0)[0]
neck_z = float(edges[gap_i[np.argmax(gap_i)]]) if len(gap_i) else r.get("neck_z", -0.185)
neck = Hv[:, 2] > neck_z
top_y, full_y = r.get("fade_top", ring_y + 0.05), r.get("fade_full", ring_y + 0.018)
cut_y = r.get("cut", ring_y - 0.006)

# Formen: mot kroppens hals, utjämnat längs ytan.
tb = np.where((Bv[Bf].mean(1)[:, 1] > ring_y - 0.04) & (Bv[Bf].mean(1)[:, 1] < top_y + 0.005))[0]
tmesh = trimesh.Trimesh(Bv, Bf[tb], process=False)
tp, tfi = trimesh.sample.sample_surface(tmesh, 200000, seed=2)
tn = tmesh.face_normals[tfi]
_, hw = np.unique(np.round(Hv, 5), axis=0, return_inverse=True)
hw = hw.ravel()
Vw = np.zeros((hw.max() + 1, 3))
Vw[hw] = V
neckw = np.zeros(len(Vw), bool)
neckw[hw[neck]] = True
wt = smooth(top_y, full_y, Vw[:, 1]) * neckw
act = np.where(wt > 0)[0]
# Radiellt per höjd och vinkel: närmaste punkt skulle dra hörnen uppåt mot sömmen, och det blir en krage.
NA, DY = 48, 0.003
y0 = cut_y - 0.012
NY = int((top_y + 0.005 - y0) / DY) + 1
polar = lambda p: (np.arctan2(p[:, 0] - ring_c[0], p[:, 2] - ring_c[2]), np.hypot(p[:, 0] - ring_c[0], p[:, 2] - ring_c[2]))
ta_, tr_ = polar(tp)
ia = (((ta_ + np.pi) / (2 * np.pi)) * NA).astype(int).clip(0, NA - 1)
iy = ((tp[:, 1] - y0) / DY).astype(int)
grid = np.full((NY, NA), np.nan)
for yi in range(NY):
    for ai in range(NA):
        q = tr_[(iy == yi) & (ia == ai)]
        if len(q):
            grid[yi, ai] = np.median(q)
for ai in range(NA):
    ok_ = np.isfinite(grid[:, ai])
    grid[:, ai] = np.interp(np.arange(NY), np.where(ok_)[0], grid[ok_, ai])
grid = ndimage.gaussian_filter(grid, (0.8, 1.2), mode=("nearest", "wrap"))
a_, r_ = polar(Vw[act])
fa = ((a_ + np.pi) / (2 * np.pi)) * NA - 0.5
fy = (Vw[act, 1] - y0) / DY - 0.5
# Överst ligger halsen tätt utanför, och nederst sjunker kanten ner i kroppen: då blir det ingen läpp som kastar skugga.
target = ndimage.map_coordinates(grid, [fy, fa], order=1, mode="grid-wrap") + r.get("skirt", 0.0008) - r.get("sink", 0.004) * smooth(ring_y, cut_y, Vw[act, 1])
rnew = r_ + (target - r_) * wt[act]
D = np.zeros_like(Vw)
D[act, 0] = (Vw[act, 0] - ring_c[0]) / (r_ + 1e-9) * (rnew - r_)
D[act, 2] = (Vw[act, 2] - ring_c[2]) / (r_ + 1e-9) * (rnew - r_)
Vw += D
V = Vw[hw]

# Kroppens översta varv läggs precis innanför halsen, annars sticker kanten ut och man ser in i öppningen.
ring_verts = np.isin(bw, np.unique(u[c == 1]))
Bv = Bv.copy()
na, nr = polar(V[neck & (np.abs(V[:, 1] - ring_y) < 0.004)])
ba, br = polar(Bv[ring_verts])
gap = np.abs(np.angle(np.exp(1j * (ba[:, None] - na[None]))))
inside_r = np.array([np.median(nr[g < 0.12]) for g in gap]) - r.get("ring_inset", 0.0012)
ring_moved = float(np.percentile(np.abs(inside_r - br), 95) * 1000)
Bv[ring_verts, 0] = ring_c[0] + (Bv[ring_verts, 0] - ring_c[0]) / (br + 1e-9) * inside_r
Bv[ring_verts, 2] = ring_c[2] + (Bv[ring_verts, 2] - ring_c[2]) / (br + 1e-9) * inside_r
body.vertices = Bv

# Kapa halsen.
keep = ~(neck[Hf].all(1) & (V[Hf][:, :, 1].max(1) < cut_y))
# Under snittet får bara hästsvansen finnas kvar: delen som når lägst. Annars hänger rester av halsstumpen kvar vid nacken.
below = np.where(keep & (V[Hf][:, :, 1].max(1) < cut_y))[0]
if len(below):
    fb = hw[Hf[below]]
    gb = sp.coo_matrix((np.ones(len(fb) * 2), (np.r_[fb[:, 0], fb[:, 1]], np.r_[fb[:, 1], fb[:, 2]])), shape=(len(Vw), len(Vw)))
    _, labs = connected_components(gb, directed=False)
    fl = labs[fb[:, 0]]
    lowest = fl[np.argmin(V[Hf[below]][:, :, 1].min(1))]
    keep[below[fl != lowest]] = False
Hf2 = Hf[keep]

# Färgen: per vinkel runt halsen, från kroppen vid sömmen.
S = head.visual.material.baseColorTexture.size[0]
tex = np.asarray(head.visual.material.baseColorTexture.convert("RGB")).astype(np.float32) / 255
uvpx = np.stack([Huv[:, 0] * S, (1 - Huv[:, 1]) * S], 1)
tid = np.full((S, S), -1, np.int32)
for i, p in enumerate(np.round((uvpx[Hf2] - 0.5) * 16).astype(np.int32)):
    cv2.fillConvexPoly(tid, p, i, lineType=cv2.LINE_8, shift=4)
ty, tx = np.where(tid >= 0)
ft = tid[ty, tx]
tpos = V[Hf2[ft]].mean(1)
tneck = neck[Hf2[ft]].all(1)
del tid
btex = np.asarray(body.visual.material.baseColorTexture.convert("RGB")).astype(np.float32) / 255
BS = btex.shape[0]
sel = (Bv[:, 1] < ring_y + 0.002) & (Bv[:, 1] > ring_y - 0.03) & (np.hypot(Bv[:, 0] - ring_c[0], Bv[:, 2] - ring_c[2]) < 0.09)
buv = np.asarray(body.visual.uv)[sel]
bcol = btex[((1 - buv[:, 1]) * BS).astype(int).clip(0, BS - 1), (buv[:, 0] * BS).astype(int).clip(0, BS - 1)]
ang = lambda p: np.arctan2(p[:, 0] - ring_c[0], p[:, 2] - ring_c[2])
NB = 16
bins = lambda a: (((a + np.pi) / (2 * np.pi)) * NB).astype(int).clip(0, NB - 1)
bb = bins(ang(Bv[sel]))
hsel = tneck & (tpos[:, 1] > cut_y) & (tpos[:, 1] < cut_y + 0.014)
hb = bins(ang(tpos[hsel]))
overall = np.median(bcol, 0) / (np.median(tex[ty[hsel], tx[hsel]], 0) + 1e-4)
gain = np.ones((NB, 3)) * overall
for i in range(NB):
    a, b = bcol[bb == i], tex[ty[hsel][hb == i], tx[hsel][hb == i]]
    if len(a) >= 2 and len(b) > 50:
        gain[i] = np.median(a, 0) / (np.median(b, 0) + 1e-4)
gain = np.clip(gain, 0.65, 1.5)
kern = np.array([1, 2, 3, 2, 1]) / 9
gain = np.stack([np.convolve(np.r_[gain[-2:, i], gain[:, i], gain[:2, i]], kern, "valid") for i in range(3)], 1)
ta = ((ang(tpos) + np.pi) / (2 * np.pi)) * NB - 0.5
i0 = np.floor(ta).astype(int) % NB
fr = (ta - np.floor(ta))[:, None]
gt = gain[i0] * (1 - fr) + gain[(i0 + 1) % NB] * fr
w_ = (smooth(top_y, cut_y + 0.004, tpos[:, 1]) * tneck)[:, None]
before = float(np.abs(np.median(tex[ty[hsel], tx[hsel]], 0) - np.median(bcol, 0)).max())
tex = tex.copy()
tex[ty, tx] = (tex[ty, tx] * (1 + (gt - 1) * w_)).clip(0, 1)
after = float(np.abs(np.median(tex[ty[hsel], tx[hsel]], 0) - np.median(bcol, 0)).max())
Image.fromarray((tex * 255 + 0.5).astype(np.uint8)).save(out / "head_basecolor.png")

# Spara. Hörn som inte används rensas av trimesh.
m2 = trimesh.visual.material.PBRMaterial(name="head", baseColorTexture=Image.open(out / "head_basecolor.png"), roughnessFactor=0.7, metallicFactor=0.0)
hm = trimesh.Trimesh(V, Hf2, process=False, visual=trimesh.visual.TextureVisuals(uv=Huv, material=m2))
hm.remove_unreferenced_vertices()
hm.export(out / "head.glb")
bm = body.submesh([np.where(~is_head)[0]], append=True, only_watertight=False)
bm.export(out / "body.glb")

# Kontroller.
bpts, bfi = trimesh.sample.sample_surface(bm, 200000, seed=3)
bn = bm.face_normals[bfi]
hair = ~neck & (V[:, 1] < ring_y - 0.02)
hairp = V[hair]
d, idx = cKDTree(bpts).query(hairp)
inside = ((hairp - bpts[idx]) * bn[idx]).sum(1) < 0
_, hw2 = np.unique(np.round(hm.vertices, 5), axis=0, return_inverse=True)
fh = hw2.ravel()[hm.faces]
eh = np.sort(np.r_[fh[:, [0, 1]], fh[:, [1, 2]], fh[:, [2, 0]]], axis=1)
uh, ch = np.unique(eh, axis=0, return_counts=True)
Vh2 = np.zeros((hw2.max() + 1, 3))
Vh2[hw2.ravel()] = hm.vertices
edge = Vh2[np.unique(uh[ch == 1])]
d_edge = cKDTree(bpts).query(edge)[0]
print(json.dumps({"s": round(float(s), 4), "t": np.round(t, 4).tolist(), "tilt_deg": round(float(np.degrees(np.arccos(np.clip(R[1, 1], -1, 1)))), 1), "icp_err": round(float(err), 4), "neck_z": round(neck_z, 3),
                  "ring_y": round(ring_y, 3), "cut_y": round(float(cut_y), 3), "faces": len(hm.faces), "removed": int((~keep).sum()), "ring_moved_mm_p95": round(ring_moved, 1), "shape_move_mm_p95": round(float(np.percentile(np.linalg.norm(D[act], axis=1), 95) * 1000), 1),
                  "open_edge_to_body_mm": {"mean": round(float(d_edge.mean() * 1000), 2), "p95": round(float(np.percentile(d_edge, 95) * 1000), 2), "n": len(edge)},
                  "color_gap": {"before": round(before, 3), "after": round(after, 3)}, "hair_near_body_mm_min": round(float(d.min() * 1000), 1), "hair_inside_share": round(float(inside.mean()), 4),
                  "bounds": hm.bounds.round(3).tolist()}))
