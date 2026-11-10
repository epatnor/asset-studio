"""Avstånd mellan AI-kroppen och mallen på varje nivå (samma hörn, färre polygoner), per del.
  .venv/bin/python tools/level_metrics.py <namn> <kropp.glb> <height>   -> build/fit/<namn>_levels.json"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np, open3d as o3d, trimesh
import fit, export
from template import Template

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
name, glb, h = sys.argv[1], sys.argv[2], float(sys.argv[3])
m = fit.load_target(glb, h)
P, _ = trimesh.sample.sample_surface_even(m, 200000, seed=2)
X6 = np.load(HERE / f"build/fit/{name}.npz")["X6"]
out = {}
for lv in (1, 2, 3, 6):
    T = Template(lv)
    X = export.level_positions(X6, lv)
    tris, tp = T.triangles()
    mm = o3d.t.geometry.TriangleMesh(o3d.core.Tensor(X.astype(np.float32)), o3d.core.Tensor(tris.astype(np.int32)))
    sc = o3d.t.geometry.RaycastingScene(); sc.add_triangles(mm)
    ans = sc.compute_closest_points(o3d.core.Tensor(P.astype(np.float32)))
    d = np.linalg.norm(ans["points"].numpy() - P, axis=1) * 1000
    pp = np.array([p.split("_")[0] for p in tp])[ans["primitive_ids"].numpy()]
    out[lv] = {"triangles": int(len(tris)), "mean_mm": round(float(d.mean()), 2), "p95_mm": round(float(np.percentile(d, 95)), 2),
               "per_part_mean_mm": {p: round(float(d[pp == p].mean()), 2) for p in sorted(set(pp))}}
    print(lv, json.dumps(out[lv]))
json.dump(out, open(HERE / f"build/fit/{name}_levels.json", "w"), indent=1)
