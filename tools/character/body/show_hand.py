"""Närbild av vänster hand: AI-kroppen överst, passningen nedanför färgad per UV-ö (handflata, fingrar, tumme).
  .venv/bin/python tools/show_hand.py <namn> <kropp.glb> <height> <ut.png>"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np, trimesh
from PIL import Image
import fit, render
from template import Template

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
name, glb, h, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
T = Template(6)
X = np.load(HERE / f"build/fit/{name}.npz")["X6"]
tris, _ = T.triangles()
isl = np.array([i for f, i in zip(T.faces, T.fisland) for _ in range(1 if len(f) == 3 else 2)])
m = fit.load_target(glb, h)
sk = json.load(open(HERE / f"build/fit/{name}.json"))["skeleton"]
c = (np.array(sk["wrist_L"]) + np.array(sk["tip_L"])) / 2
R = 0.13
cols = {"hand_L": (200, 200, 200), "finger0_L": (220, 80, 80), "finger1_L": (80, 200, 80), "finger2_L": (80, 80, 220),
        "finger3_L": (220, 200, 60), "thumb_L": (200, 60, 200)}
sel = np.linalg.norm(X[tris].mean(1) - c, axis=1) < R
mm = trimesh.Trimesh(X, tris[sel], process=False)
P, fi = trimesh.sample.sample_surface(mm, 250000, seed=0)
C = np.array([cols.get(i, (130, 130, 130)) for i in isl[sel]], float)[fi]
tm = trimesh.Trimesh(m.vertices, m.faces[np.linalg.norm(m.triangles_center - c, axis=1) < R])
P2, f2 = trimesh.sample.sample_surface(tm, 250000, seed=0)
s = 400 / (2 * R)
rows = []
for PP, NN, CC in ((P2, tm.face_normals[f2], np.full((len(P2), 3), (205, 175, 150.))), (P, mm.face_normals[fi], C)):
    tiles = []
    for a in (0, 90, 180):
        A = np.radians(a)
        Rm = np.array([[np.cos(A), 0, np.sin(A)], [0, 1, 0], [-np.sin(A), 0, np.cos(A)]])
        cc = Rm @ c
        tiles.append(render._splat(PP, NN, CC, a, (400, 400), ((cc[0] - R, cc[1] - R), s)))
    rows.append(np.hstack(tiles))
Image.fromarray(np.vstack(rows)).save(out)
