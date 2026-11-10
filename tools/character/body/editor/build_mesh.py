"""Bygger en ny modell ur editorns sparade nät, med egna polygoner, vikter och hörn. Skriver aldrig över en modell.
  .venv/bin/python tools/editor/build_mesh.py <namn> [smooth|faceted]
Smooth delar hörnen mellan ytorna, så att ljuset flyter över kanterna. Faceted ger varje polygon egna hörn och en egen normal.
Läser build/fit/<namn>_mesh.json och build/editor/<namn>.json (lederna), skriver out/<namn>_v<n>.glb och en rad JSON."""
import json, re, sys
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[4]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parents[1]
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
sys.path.insert(0, str(TOOLS))
from make_robot import write_rigged  # noqa: E402

SKIN = (0.78, 0.72, 0.66, 1.0)
name = sys.argv[1]
shading = sys.argv[2] if len(sys.argv) > 2 else "smooth"
mesh = json.loads((HERE / f"build/fit/{name}_mesh.json").read_text())
joints = {bone: np.array(value) for bone, value in json.loads((HERE / f"build/editor/{name}.json").read_text())["joints"].items()}
V = np.array(mesh["positions"]).reshape(-1, 3)
F = np.array(mesh["triangles"]).reshape(-1, 3)
surface = trimesh.Trimesh(V, F, process=False)
watertight = bool(surface.is_watertight)
normals = np.asarray(surface.vertex_normals)
indices = np.array(mesh["indices"]).reshape(-1, 4)
weights = np.array(mesh["weights"]).reshape(-1, 4)
if shading == "faceted":
    # Trianglarna ligger i polygonernas ordning. Varje polygon får egna hörn och trianglarnas gemensamma normal.
    new_V, new_F, new_normals, new_indices, new_weights = [], [], [], [], []
    next_triangle = 0
    for polygon in mesh["polygons"]:
        corners = set(polygon)
        own = []
        while next_triangle < len(F) and corners.issuperset(F[next_triangle].tolist()):
            own.append(F[next_triangle])
            next_triangle += 1
        if not own:
            sys.exit("The triangles do not follow the polygons")
        own = np.array(own)
        normal = np.cross(V[own[:, 1]] - V[own[:, 0]], V[own[:, 2]] - V[own[:, 0]]).sum(axis=0)
        normal = normal / (np.linalg.norm(normal) + 1e-12)
        first = len(new_V)
        number = {v: first + k for k, v in enumerate(polygon)}
        new_V += [V[v] for v in polygon]
        new_normals += [normal] * len(polygon)
        new_indices += [indices[v] for v in polygon]
        new_weights += [weights[v] for v in polygon]
        new_F += [[number[int(v)] for v in triangle] for triangle in own]
    if next_triangle != len(F):
        sys.exit("The triangles do not follow the polygons")
    V, F, normals = np.array(new_V), np.array(new_F), np.array(new_normals)
    indices, weights = np.array(new_indices), np.array(new_weights)
# Numreringen fortsätter där de äldre filerna slutar. Inget skrivs över.
taken = [re.search(r"_v(\d+)$", path.stem) for path in (HERE / "out").glob(f"{name}*_v*.glb")]
version = max([int(found.group(1)) for found in taken if found] + [1]) + 1
target = HERE / f"out/{name}_v{version}.glb"
# Hon är enfärgad tills hon får sin textur.
colors = np.tile(np.array(SKIN, np.float32), (len(V), 1))
write_rigged(target, V, F, normals, colors, indices, weights, joints)
print(json.dumps({"out": str(target), "triangles": int(len(F)), "polygons": len(mesh["polygons"]), "verts": int(len(V)), "watertight": watertight, "shading": shading}))
