"""Formar ansiktets inre: samma ansiktspunkter på modell och bild, och hörnen dras dit med en mjuk funktion. Konturen hålls fast.

  .venv/bin/python tools/fit_face.py '{"glb": "...", "calib": "head_calib.json", "model_points": "...", "ref_points": "...", "render": {"cy": 1.62, "width": 0.3, "size": 1024}, "out": "faced.glb", "overlay": "face_overlay.png", "front_img": "..."}'

Modellens punkter kommer från en bild av modellen framifrån, med MakeHumans hud. Ögon och hår följer med. Skriver en rad JSON med avstånd i mm per drag."""
import json, sys

import numpy as np
import scipy.sparse as sp
import trimesh
from PIL import Image, ImageDraw
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree

r = json.loads(sys.argv[1])
c = json.load(open(r["calib"]))
smooth = lambda e0, e1, x: (lambda t: t * t * (3 - 2 * t))(np.clip((x - e0) / (e1 - e0), 0, 1))
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
mp_ = np.array(json.load(open(r["model_points"]))["pts"])
rp = np.array(json.load(open(r["ref_points"]))["pts"])
R_ = r["render"]
to_model = lambda p: np.c_[(p[:, 0] - R_["size"] / 2) / R_["size"] * R_["width"], R_["cy"] + (R_["size"] / 2 - p[:, 1]) / R_["size"] * R_["width"]]
s, ax, er, eye_y = c["s"], c["axis"], c["eye_row"], c["eye_y"]
to_ref = lambda p: np.c_[(p[:, 0] - ax) / s, eye_y + (er - p[:, 1]) / s]
to_px = lambda p: np.c_[ax + p[:, 0] * s, er + (eye_y - p[:, 1]) * s]
A, B = to_model(mp_), to_ref(rp)
# Ansiktets yttre oval följer redan bildens kontur, så den tas bort utom hakan. Punkterna på iris sitter sist.
OVAL = {10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109}
use = np.array([i for i in range(len(A)) if i not in OVAL or i in (152, 148, 377, 176, 400)])
# Symmetri: medelvärdet av bild och spegelbild tas bara för höjd, sidled får vara kvar som i bilden.
src, dst = A[use], B[use]
top = np.where(F.ravel() >= 0)[0]
# Konturen hålls fast: hörn långt från ansiktets punkter längs huvudets kant och halsen.
chin_ref = float(B[152, 1])
head = np.where((V[:, 1] > chin_ref - 0.06) & (np.abs(V[:, 0]) < 0.14))[0]
pins = []
for y in np.linspace(V[head, 1].max() - 0.005, chin_ref - 0.05, 16):
    q = head[np.abs(V[head, 1] - y) < 0.006]
    if len(q):
        i, j = q[np.argmin(V[q, 0])], q[np.argmax(V[q, 0])]
        pins += [V[i, :2], V[j, :2]]
pins = np.array(pins)
d = cKDTree(src).query(pins)[0]
pins = pins[d > r.get("pin_gap", 0.012)]
warp = RBFInterpolator(np.r_[src, pins], np.r_[dst, pins], kernel="thin_plate_spline", smoothing=r.get("smoothing", 2e-5))


def apply(P, hold_below=None):
    out = P.copy()
    w = smooth(chin_ref - 0.07, chin_ref - 0.02, P[:, 1]) * (P[:, 2] > r.get("z_min", 0.03))
    sel = w > 0
    t = warp(P[sel][:, :2])
    out[sel, :2] += np.clip(t - P[sel][:, :2], -0.03, 0.03) * w[sel, None]
    return out


before = V.copy()
V = apply(V)
# Ögonhålorna: Djupet jämnas ut runt ögonen, så att vecken från tidigare passningar försvinner. Bara framåt-bakåt.
n = len(V)
ij = np.r_[F[:, 0], F[:, 1], F[:, 2], F[:, 1], F[:, 2], F[:, 0]]
ji = np.r_[F[:, 1], F[:, 2], F[:, 0], F[:, 0], F[:, 1], F[:, 2]]
L = sp.coo_matrix((np.ones(len(ij)), (ij, ji)), shape=(n, n)).tocsr()
L.data[:] = 1
deg = np.asarray(L.sum(1)).ravel() + 1e-9
eye_w = np.max([smooth(1.0, 0.6, np.hypot((V[:, 0] - sx * 0.034) / 0.034, (V[:, 1] - eye_y) / 0.028)) for sx in (-1, 1)], 0) * (V[:, 2] > 0.05)
for _ in range(r.get("eye_smooth", 6)):
    V[:, 2] += 0.5 * eye_w * ((L @ V[:, 2]) / deg - V[:, 2])
D = V - before
tree0 = cKDTree(before)


def follow(P, reach=0.03, k=6):
    dd, j = tree0.query(P, k=k)
    w = np.maximum(1 - dd / reach, 0) ** 2
    return P + (w[..., None] * D[j]).sum(1) / np.maximum(w.sum(1, keepdims=True), 1e-6)


scene.geometry[kb] = trimesh.Trimesh(V[weld], F0, process=False, visual=body.visual)
scene.geometry[ke] = trimesh.Trimesh(apply(np.array(scene.geometry[ke].vertices)), scene.geometry[ke].faces, process=False, visual=scene.geometry[ke].visual)
scene.geometry[kh] = trimesh.Trimesh(follow(np.array(scene.geometry[kh].vertices)), scene.geometry[kh].faces, process=False, visual=scene.geometry[kh].visual)
scene.export(r["out"])
# Bild: modellens nät framifrån ovanpå referensen.
im = Image.open(r["front_img"]).convert("RGB")
dr = ImageDraw.Draw(im)
px = to_px(V)
fr = (V[F][:, :, 2].mean(1) > 0.06) & (V[F][:, :, 1].mean(1) > chin_ref - 0.06)
for f in F[fr]:
    p = [tuple(px[i]) for i in f]
    dr.line(p + [p[0]], fill=(230, 40, 40), width=1)
im.crop((int(ax - 370), int(er - 470), int(ax + 370), int(er + 560))).save(r["overlay"])
checks = {}
Am, Bm = warp(A), B
for k, i in {"iris_l": 468, "iris_r": 473, "mouth_l": 61, "mouth_r": 291, "chin": 152, "nose": 1}.items():
    checks[k] = {"before_mm": round(float(np.linalg.norm(A[i] - B[i]) * 1000), 1), "after_mm": round(float(np.linalg.norm(Am[i] - B[i]) * 1000), 1)}
print(json.dumps({"points_used": len(use), "pins": len(pins), "checks": checks, "chin_ref_y": round(chin_ref, 3), "max_move_mm": round(float(np.linalg.norm(D, axis=1).max() * 1000), 1), "tris": len(F)}))
