"""Närbild av huvudet: AI-delen i kroppens rum, mallen passad mot helkroppen och mallen förfinad mot delen.
  .venv/bin/python tools/show_head.py <kropp> <förfinad> <ut.png>"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np, trimesh
from PIL import Image
import render
from template import Template

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
body, ref, out = sys.argv[1:4]
T = Template(6)
tris, tp = T.triangles()
rows = []
part = trimesh.load(HERE / f"build/fit/{ref}_head_C.glb").dump(concatenate=True)
Xb = np.load(HERE / f"build/fit/{body}.npz")["X6"]
Xr = np.load(HERE / f"build/fit/{ref}.npz")["X6"]
sel = np.isin(tp, ["head"])
c = Xr[np.unique(tris[sel])].mean(0)
R = 0.16
for V, F, col in ((part.vertices, part.faces, (205, 175, 150)), (Xb, tris[sel], (170, 190, 215)), (Xr, tris[sel], (150, 200, 160))):
    m = trimesh.Trimesh(V, F, process=False)
    m = m.submesh([np.where(np.linalg.norm(m.triangles_center - c, axis=1) < R)[0]], append=True)
    P, fi = trimesh.sample.sample_surface(m, 300000, seed=0)
    s = 400 / (2 * R)
    tiles = []
    for a in (0, 60, 90):
        A = np.radians(a)
        Rm = np.array([[np.cos(A), 0, np.sin(A)], [0, 1, 0], [-np.sin(A), 0, np.cos(A)]])
        cc = Rm @ c
        tiles.append(render._splat(P, m.face_normals[fi], np.tile(np.array(col, float), (len(P), 1)), a, (400, 400), ((cc[0] - R, cc[1] - R), s)))
    rows.append(np.hstack(tiles))
Image.fromarray(np.vstack(rows)).save(out)
