"""Sätter ett byggt huvud på en sparad kropp ur editorn och sparar resultatet som en ny version. Originalet rörs inte.

  .venv/bin/python tools/head_attach.py '{"name": "yvonne", "version": "yvonne_robot_v5", "front": "...", "side": "...", "out": "yvonne_newhead"}'

Kroppens polygoner och alla ändringar behålls utom huvudet. Det nya huvudet sys ihop med bålens ring vid halsen och
får vikter mot nacken och huvudet. Skriver out/<out>.glb och build/versions/<out>.json, som syns i editorns versionslista."""
import json
import sys
from pathlib import Path

import numpy as np
import trimesh
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
sys.path.insert(0, str(TOOLS))
from head_builder import build_head, orient, triangulate  # noqa: E402
from fit_neck import fit_collar  # noqa: E402
from make_robot import smoothstep, write_rigged, zip_rings  # noqa: E402

SKIN = [0.78, 0.72, 0.66, 1.0]
r = json.loads(sys.argv[1])
name = r["name"]
editor = json.loads((HERE / f"build/editor/{name}.json").read_text())
saved = json.loads((HERE / f"build/versions/{r['version']}.json").read_text())
mesh = saved["mesh"]
keys = mesh["keys"]
old_positions = np.array(mesh["positions"]).reshape(-1, 3)
is_old_head = [("head|" in key) for key in keys]

# Kroppen: allt utom polygoner som rör det gamla huvudet.
body_polygons = [polygon for polygon in mesh["polygons"] if not any(is_old_head[v] for v in polygon)]
directed = {(a, b) for polygon in body_polygons for a, b in zip(polygon, polygon[1:] + polygon[:1])}
following = {a: b for a, b in directed if (b, a) not in directed}
start = next(iter(following))
ring = [start]
while following[ring[-1]] != start:
    ring.append(following[ring[-1]])
if len(ring) != len(following):
    sys.exit(f"The body has {len(following)} open edges, expected one loop of {len(ring)}")
used = sorted({v for polygon in body_polygons for v in polygon})
number = {old: new for new, old in enumerate(used)}
neck_z = float(old_positions[ring, 2].mean())

head, builder = build_head(HERE / r["front"], HERE / r["side"], neck_z)
offset = len(used)
points = np.array(builder.points)
cap = set(builder.cap)
head_polygons = [[v + offset for v in polygon] for index, polygon in enumerate(builder.polygons) if index not in cap]
keep_head = [i for i in range(len(points)) if i != builder.cap_center]
# Locket tas bort, och dess mittpunkt sist i kön för huvudet behöver inget nummer: den används inte längre.
V = np.vstack([old_positions[used], points])
neck_ring = [v + offset for v in builder.neck_ring]
body_ring = [number[v] for v in ring]
seam = zip_rings(neck_ring, body_ring, V, False)
polygons = [[number[v] for v in polygon] for polygon in body_polygons] + head_polygons + [list(face) for face in seam]
polygons = orient(polygons, V)

# Punkter som inte används (lockets mitt) tas bort, så att numren är täta.
alive = sorted({v for polygon in polygons for v in polygon})
final = {old: new for new, old in enumerate(alive)}
polygons = [[final[v] for v in polygon] for polygon in polygons]
positions = V[alive]
triangles = [tri for polygon in polygons for tri in triangulate(polygon, positions)]

bones = editor["bones"]
neck_bone, head_bone = bones.index("neck"), bones.index("head")
indices, weights, colors, out_keys, mirror_old = [], [], [], [], []
old_indices = np.array(mesh["indices"]).reshape(-1, 4)
old_weights = np.array(mesh["weights"]).reshape(-1, 4)
cut = float(old_positions[ring, 1].mean())
for v in alive:
    if v < offset:
        old = used[v]
        indices.append(old_indices[old].tolist())
        weights.append(old_weights[old].tolist())
        out_keys.append(keys[old])
    else:
        share = float(smoothstep(cut + 0.005, cut + 0.05, V[v, 1]))
        indices.append([head_bone, neck_bone, 0, 0])
        weights.append([share, 1 - share, 0, 0])
        out_keys.append(f"yhead|{v - offset}")
    colors.append(SKIN)

# Spegelpunkter: exakta i det nya huvudet, och kroppens par där båda finns kvar.
body_mirror = mesh.get("mirror")
tree = cKDTree(positions * np.array([-1.0, 1.0, 1.0]))
distance, partner = tree.query(positions)
mirror = np.where(distance < 0.015, partner, -1).tolist()

output = {"positions": np.round(positions, 5).ravel().tolist(), "polygons": polygons, "triangles": np.array(triangles).ravel().tolist(),
          "keys": out_keys, "indices": np.array(indices).ravel().tolist(), "weights": np.round(np.array(weights), 4).ravel().tolist(),
          "colors": np.array(colors).ravel().tolist(), "mirror": mirror}
# Halsen och bålen ska mötas, inte gå in i varandra.
positions, neck_fit = fit_collar(positions, out_keys, polygons)
output["positions"] = np.round(positions, 5).ravel().tolist()
surface = trimesh.Trimesh(positions, np.array(triangles), process=False)
stem = r["out"]
target = HERE / f"out/{stem}.glb"
number_of = 1
while target.exists():
    number_of += 1
    target = HERE / f"out/{stem}_{number_of}.glb"
joints = {bone: np.array(value) for bone, value in editor["joints"].items()}
write_rigged(target, positions, np.array(triangles), np.asarray(surface.vertex_normals), np.array(colors),
             np.array(indices), np.array(weights), joints)
edits = saved["edits"]
edits = {**edits, "operations": edits.get("operations", []) + [{"op": "new_head", "from": r["version"], "head_points": len(alive) - len(used), "tool": "tools/head_builder.py"}]}
(HERE / f"build/versions/{target.stem}.json").write_text(json.dumps({"mesh": output, "edits": edits}))

edge_count = {}
for polygon in polygons:
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        key = (min(a, b), max(a, b))
        edge_count[key] = edge_count.get(key, 0) + 1
print(json.dumps({"out": str(target), "polygons": len(polygons), "triangles": len(triangles), "points": len(alive), "closed": all(c == 2 for c in edge_count.values()),
                  "watertight": bool(surface.is_watertight), "neck_ring": len(neck_ring), "body_ring": len(body_ring), "version": target.stem}))
