"""Sätter ihop kropp och huvud till en figur med två delar. Kroppens normaler räknas över UV-sömmarna, så att den blir mjuk.

  .venv/bin/python tools/figure_glb.py '{"body": "build/nora_head/on_body/body.glb", "head": "build/nora_head/on_body/head_game.glb", "out": "build/nora_head/on_body/nora_full.glb"}'

Skriver en rad JSON."""
import json, sys
from pathlib import Path

import numpy as np
import trimesh

r = json.loads(sys.argv[1])
b = trimesh.load(r["body"], force="scene", process=False).to_geometry()
h = trimesh.load(r["head"], force="scene", process=False).to_geometry()
for m in (b, h):
    _, w = np.unique(np.round(m.vertices, 5), axis=0, return_inverse=True)
    w = w.ravel()
    fn = np.cross(m.vertices[m.faces[:, 1]] - m.vertices[m.faces[:, 0]], m.vertices[m.faces[:, 2]] - m.vertices[m.faces[:, 0]])
    N = np.zeros((w.max() + 1, 3))
    for i in range(3):
        np.add.at(N, w[m.faces[:, i]], fn)
    m.vertex_normals = (N / (np.linalg.norm(N, axis=1, keepdims=True) + 1e-12))[w]
s = trimesh.Scene()
s.add_geometry(b, node_name="nora_body", geom_name="nora_body")
s.add_geometry(h, node_name="nora_head", geom_name="nora_head")
s.export(r["out"], include_normals=True)
print(json.dumps({"tris": len(b.faces) + len(h.faces), "body_tris": len(b.faces), "head_tris": len(h.faces), "verts": len(b.vertices) + len(h.vertices), "mb": round(Path(r["out"]).stat().st_size / 2**20, 1)}))
