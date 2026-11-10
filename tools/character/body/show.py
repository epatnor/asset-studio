"""Förhandsbild av en passning: AI-kroppen, passningen färgad per del och passningen grå, fram/sida/bak.
  .venv/bin/python tools/show.py <namn> <kropp.glb> <height> <level> <ut.png>"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np, trimesh
from PIL import Image
import fit, render
from template import Template

COLS = {'torso': (200, 200, 200), 'head': (230, 190, 150), 'upperarm': (220, 80, 80), 'forearm': (80, 200, 80),
        'hand': (80, 80, 220), 'leg': (220, 200, 60), 'foot': (200, 60, 200)}


def level_mesh(X6, level):
    T6, T = Template(6), Template(level)
    X = X6[[T6.index[k] for k in T.key]]
    return T, X


def picture(X6, level, target, out, angles=(0, 90, 180), size=(360, 720)):
    T, X = level_mesh(X6, level)
    tris, tp = T.triangles()
    m = trimesh.Trimesh(X, tris, process=False)
    pts, fi = trimesh.sample.sample_surface(m, 500000, seed=0)
    c = np.array([COLS[p.split('_')[0]] for p in tp], float)[fi]
    s = (size[1] - 20) / 1.85
    box = ((-size[0] / 2 / s, -0.02), s)
    rows = []
    if target is not None:
        tp_, tfi = trimesh.sample.sample_surface(target, 500000, seed=0)
        rows.append(np.hstack([render._splat(tp_, target.face_normals[tfi], np.full((len(tp_), 3), (205, 175, 150.)), a, size, box) for a in angles]))
    rows.append(np.hstack([render._splat(pts, m.face_normals[fi], c, a, size, box) for a in angles]))
    Image.fromarray(np.hstack(rows)).save(out)


if __name__ == "__main__":
    name, glb, h, lv, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    X6 = np.load(Path(__file__).resolve().parents[3] / "build/body" / f"build/fit/{name}.npz")["X6"]
    picture(X6, lv, fit.load_target(glb, h) if glb != "-" else None, out)
