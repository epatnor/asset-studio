"""Får halsen och bålen att mötas: bålens översta ring blir halsens nederkant, och ringarna under glider över i axlarna.

  .venv/bin/python tools/fit_neck.py '{"name": "yvonne", "version": "yvonne_v7"}'

Skriver över den versionen (Patrik bad om det för v7, 2026-11-03); originalet ska kopieras undan först. Alla andra punkter,
polygoner och vikter lämnas orörda. tools/head_attach.py använder samma funktion."""
import json
import sys
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
sys.path.insert(0, str(TOOLS))
from make_robot import smoothstep, write_rigged  # noqa: E402

# Så långt under halsens topp ringen hamnar, och hur nära bålens ring halsens nederkant ligger.
SHOULDER_HALF_WIDTH = (0.1, 0.2)
GAP_ABOVE_RING = 0.008
RING_DROP_SHARE = 0.45


def fit_collar(positions, keys, polygons):
    """Flyttar punkterna på plats. Svarar med vad som flyttades."""
    P = positions
    is_head = np.array([("head|" in key) for key in keys])
    seam = [p for p in polygons if is_head[p].any() and not is_head[p].all()]
    ring = sorted({v for p in seam for v in p if not is_head[v]})
    neck_bottom = sorted({v for p in seam for v in p if is_head[v]})
    head_points = np.where(is_head)[0]

    # Halsens ringar: punkterna i huvudet som ligger under käken, grupperade efter höjd.
    bottom_y = P[neck_bottom, 1].mean()
    near = head_points[np.abs(P[head_points, 0]) < P[neck_bottom, 0].max() * 1.05]
    above = np.sort(np.unique(np.round(P[near, 1], 3)))
    rows = [y for y in above if y > bottom_y + 0.005][:2]
    mid_y, top_y = rows[0], rows[1]
    mid_ring = near[np.abs(P[near, 1] - mid_y) < 0.002]
    ring_y = P[ring, 1].mean()

    # Den nya höjden: halsen får hela sträckan från käken ned till bålens ring.
    target_ring_y = ring_y + (bottom_y - ring_y) * RING_DROP_SHARE
    new_bottom_y = max(target_ring_y + GAP_ABOVE_RING, bottom_y)

    x_scale = P[neck_bottom, 0].max() / P[ring, 0].max()
    ring_back, ring_front = P[ring, 2].min(), P[ring, 2].max()
    neck_back, neck_front = P[neck_bottom, 2].min(), P[neck_bottom, 2].max()
    z_scale = (neck_front - neck_back) / (ring_front - ring_back)

    body = np.where(~is_head)[0]
    # Bålens rader under ringen, som bestämmer var övergången till axlarna slutar.
    lower_rows = [key for key in keys if key.startswith("torso|96|")]
    start_y = float(np.mean([P[keys.index(key), 1] for key in lower_rows])) if lower_rows else ring_y - 0.08
    moved = P.copy()
    for v in body:
        x, y, z = P[v]
        share = float(smoothstep(start_y, ring_y, y)) * float(smoothstep(SHOULDER_HALF_WIDTH[1], SHOULDER_HALF_WIDTH[0], abs(x)))
        if share <= 0:
            continue
        new_x = x * x_scale
        new_z = neck_back + (z - ring_back) * z_scale
        moved[v, 0] = x + (new_x - x) * share
        moved[v, 2] = z + (new_z - z) * share
        moved[v, 1] = y + (target_ring_y - ring_y) * share ** 3
    moved[neck_bottom, 1] = new_bottom_y
    moved[mid_ring, 1] = (new_bottom_y + top_y) / 2
    return moved, {"ring_points": len(ring), "ring_y": [round(float(ring_y), 3), round(float(target_ring_y), 3)], "neck_bottom_y": [round(float(bottom_y), 3), round(float(new_bottom_y), 3)],
                   "x_scale": round(float(x_scale), 3), "z_scale": round(float(z_scale), 3), "moved_points": int((np.abs(moved - P).sum(axis=1) > 1e-6).sum())}


def triangles_of(polygons, positions):
    sys.path.insert(0, str(TOOLS))
    from head_builder import triangulate
    return [tri for polygon in polygons for tri in triangulate(polygon, positions)]


if __name__ == "__main__":
    r = json.loads(sys.argv[1])
    name, version = r["name"], r["version"]
    saved = json.loads((HERE / f"build/versions/{version}.json").read_text())
    mesh = saved["mesh"]
    positions = np.array(mesh["positions"]).reshape(-1, 3)
    moved, report = fit_collar(positions, mesh["keys"], mesh["polygons"])
    mesh["positions"] = np.round(moved, 5).ravel().tolist()
    triangles = np.array(mesh["triangles"]).reshape(-1, 3)
    surface = trimesh.Trimesh(moved, triangles, process=False)
    editor = json.loads((HERE / f"build/editor/{name}.json").read_text())
    joints = {bone: np.array(value) for bone, value in editor["joints"].items()}
    write_rigged(HERE / f"out/{version}.glb", moved, triangles, np.asarray(surface.vertex_normals), np.array(mesh["colors"]).reshape(-1, 4),
                 np.array(mesh["indices"]).reshape(-1, 4), np.array(mesh["weights"]).reshape(-1, 4), joints)
    edits = saved["edits"]
    edits["operations"] = edits.get("operations", []) + [{"op": "fit_neck", **report}]
    (HERE / f"build/versions/{version}.json").write_text(json.dumps({"mesh": mesh, "edits": edits}))
    latest_path = HERE / f"build/fit/{name}_mesh.json"
    latest = json.loads(latest_path.read_text())
    if len(latest["positions"]) == len(positions.ravel()) and np.allclose(np.array(latest["positions"]).reshape(-1, 3), positions, atol=1e-4):
        latest_path.write_text(json.dumps(mesh))
        (HERE / f"build/fit/{name}_edits.json").write_text(json.dumps(edits, indent=1))
        report["also_latest"] = True
    print(json.dumps({"out": str(HERE / f"out/{version}.glb"), "watertight": bool(surface.is_watertight), **report}))
