"""Tar bort lösa småbitar ur ett AI-nät (Pixal3D lämnar tunna streck och flagor, t.ex. vid armarna) och behåller
texturen. Bitarna räknas efter att punkterna svetsats ihop (UV-sömmar delar annars nätet i hundratals öar).

  uv run --no-project --python 3.12 --with trimesh --with numpy --with scipy --with pillow python -I tools/mesh/clean_floaters.py \
      '{"in": "a.glb", "out": "a_clean.glb", "keep_frac": 0.02}'

keep_frac: en bit behålls om den har minst så stor andel av den största bitens trianglar (standard 0,02). Svarar med en rad
JSON: bitar och trianglar före och efter, och var de borttagna låg (lådan).
"""
import json, sys
import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


def main():
    r = json.loads(sys.argv[1])
    scene = trimesh.load(r["in"])
    m = scene.to_geometry() if isinstance(scene, trimesh.Scene) else scene
    w = trimesh.Trimesh(m.vertices.copy(), m.faces.copy(), process=False)
    w.merge_vertices(merge_tex=True, merge_norm=True)   # samma ordning på ytorna, bara punkterna slås ihop
    n = len(w.faces); adj = w.face_adjacency
    k, lab = connected_components(coo_matrix((np.ones(len(adj)), (adj[:, 0], adj[:, 1])), shape=(n, n)), directed=False)
    cnt = np.bincount(lab, minlength=k)
    keep = cnt[lab] >= float(r.get("keep_frac", 0.02)) * cnt.max()
    gone = w.triangles_center[~keep]
    out = m.copy(); out.update_faces(keep); out.remove_unreferenced_vertices()
    out.export(r["out"])
    print(json.dumps({"ok": True, "parts_before": int(k), "parts_after": int(len(np.unique(lab[keep]))), "tris_before": int(n),
                      "tris_after": int(keep.sum()), "removed_tris": int((~keep).sum()),
                      "removed_box": [gone.min(0).round(3).tolist(), gone.max(0).round(3).tolist()] if len(gone) else None,
                      "out": r["out"]}))


if __name__ == "__main__":
    main()
