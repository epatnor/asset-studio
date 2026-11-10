"""Delar ett Pixal3D-huvud med hästsvans i huvud och hår utanför skallen.

  .venv/bin/python tools/split_ponytail.py '{"in": "build/nora_head/nora_head_mv.glb", "out": "build/nora_head", "skull": {"c": [0, 0.6, 0.04], "r": [0.225, 0.335, 0.25]}, "neck_y": 0.42, "neck_z": -0.14}'

Skallen är en ellipsoid i delens mått. Bakom den räknas allt som hår; under neck_y allt bakom neck_z. Öronen sitter utanför
ellipsoiden men längre fram, så de stannar kvar. Skriver head.glb och hair.glb (med textur) och en rad JSON.

Sammanhängande delar räknas på hörn svetsade efter läge: UV-sömmarna delar annars ytan i hundratals öar, som inte är lösa bitar.
Bara ett submesh per del, eftersom trimesh kopierar materialet för varje (64 MB styck med 2048-texturer)."""
import json, sys
from pathlib import Path

import numpy as np
import scipy.sparse as sp
import trimesh
from scipy.sparse.csgraph import connected_components

r = json.loads(sys.argv[1])
out = Path(r["out"])
m = trimesh.load(r["in"], force="scene").to_geometry()
V, F = m.vertices, m.faces
sk = r["skull"]
c, rad = np.array(sk["c"]), np.array(sk["r"])
fc = V[F].mean(1)
ell = (((fc - c) / rad) ** 2).sum(1)
ear = (np.abs(fc[:, 0]) > r.get("ear_x", 0.16)) & (fc[:, 2] > r.get("ear_z", -0.12))
upper = fc[:, 1] > r.get("neck_y", 0.42)
hair = (upper & (ell > r.get("margin", 1.0)) & (fc[:, 2] < 0) & ~ear) | (~upper & (fc[:, 2] < r.get("neck_z", -0.14)))
_, weld = np.unique(np.round(V, 5), axis=0, return_inverse=True)
weld = weld.ravel()


def largest(mask, keep_share=0.02):
    """Delen utan lösa småbitar. Svarar med delen och andelen ytor som rensades bort."""
    idx = np.where(mask)[0]
    f = weld[F[idx]]
    n = weld.max() + 1
    g = sp.coo_matrix((np.ones(len(f) * 2), (np.r_[f[:, 0], f[:, 1]], np.r_[f[:, 1], f[:, 2]])), shape=(n, n))
    _, lab = connected_components(g, directed=False)
    face_lab = lab[f[:, 0]]
    ids, cnt = np.unique(face_lab, return_counts=True)
    keep = np.isin(face_lab, ids[cnt >= keep_share * cnt.max()])
    return m.submesh([idx[keep]], append=True, only_watertight=False), len(ids), round(float(1 - keep.mean()), 4)


h, hparts, hdrop = largest(~hair)
p, pparts, pdrop = largest(hair)
h.export(out / "head.glb")
p.export(out / "hair.glb")
print(json.dumps({"head_faces": len(h.faces), "hair_faces": len(p.faces), "head_parts": hparts, "hair_parts": pparts, "head_dropped": hdrop, "hair_dropped": pdrop, "head_bounds": h.bounds.round(3).tolist(), "hair_bounds": p.bounds.round(3).tolist()}))
