"""Syr ihop lösa delar (öron, knut) med kroppens skal, så att modellen blir ett enda skal utan punkter inuti.

  .venv/bin/python tools/weld_parts.py '{"name": "yvonne", "version": "yvonne_v7", "out": "yvonne_v8"}'

Delens ytor som ligger inne i skalet tas bort, skalets ytor under delen tas bort, och de två öppna kanterna binds ihop
med en remsa trianglar. Skriver en ny version i out/ och build/versions/, aldrig över en gammal."""
import json
import sys
from pathlib import Path

import numpy as np
import open3d as o3d
import trimesh

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
sys.path.insert(0, str(TOOLS))
from make_robot import write_rigged  # noqa: E402


def triangulate(polygon, points):
    if len(polygon) == 4 and np.linalg.norm(points[polygon[0]] - points[polygon[2]]) > np.linalg.norm(points[polygon[1]] - points[polygon[3]]):
        return [[polygon[0], polygon[1], polygon[3]], [polygon[1], polygon[2], polygon[3]]]
    return [[polygon[0], polygon[k], polygon[k + 1]] for k in range(1, len(polygon) - 1)]


def edges_of(polygon):
    return [(min(a, b), max(a, b)) for a, b in zip(polygon, polygon[1:] + polygon[:1])]


def components(polygons):
    """Ytor som hänger ihop över kanter, största först."""
    owners = {}
    for index, polygon in enumerate(polygons):
        for edge in edges_of(polygon):
            owners.setdefault(edge, []).append(index)
    seen, found = set(), []
    for start in range(len(polygons)):
        if start in seen:
            continue
        seen.add(start)
        stack, part = [start], []
        while stack:
            current = stack.pop()
            part.append(current)
            for edge in edges_of(polygons[current]):
                for other in owners[edge]:
                    if other not in seen:
                        seen.add(other)
                        stack.append(other)
        found.append(part)
    return sorted(found, key=len, reverse=True)


def open_loops(polygons):
    """De öppna kanterna som slutna slingor av punkter."""
    count = {}
    for polygon in polygons:
        for edge in edges_of(polygon):
            count[edge] = count.get(edge, 0) + 1
    around = {}
    for (a, b), number in count.items():
        if number == 1:
            around.setdefault(a, []).append(b)
            around.setdefault(b, []).append(a)
    loops, seen = [], set()
    for start in around:
        if start in seen:
            continue
        loop, previous, current = [start], None, start
        seen.add(start)
        while True:
            following = [v for v in around[current] if v != previous]
            step = next((v for v in following if v not in seen), None)
            if step is None:
                break
            seen.add(step)
            loop.append(step)
            previous, current = current, step
        loops.append(loop)
    return sorted(loops, key=len, reverse=True)


def scene_of(points, polygons):
    triangles = [tri for polygon in polygons for tri in triangulate(polygon, points)]
    owner = [index for index, polygon in enumerate(polygons) for _ in triangulate(polygon, points)]
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(points.astype(np.float32)), o3d.core.Tensor(np.array(triangles, np.uint32)))
    return scene, owner


def occupied(scene, points):
    return scene.compute_occupancy(o3d.core.Tensor(points.astype(np.float32))).numpy().astype(bool)


def crossings(scene, owner, points, segments):
    """Vilka ytor sträckorna går igenom."""
    if not len(segments):
        return np.zeros(0, bool), set()
    A, B = points[segments[:, 0]], points[segments[:, 1]]
    lengths = np.linalg.norm(B - A, axis=1)
    rays = np.hstack([A, (B - A) / (lengths[:, None] + 1e-12)]).astype(np.float32)
    answer = scene.cast_rays(o3d.core.Tensor(rays))
    hit = answer["t_hit"].numpy() < lengths
    return hit, {owner[int(i)] for i in answer["primitive_ids"].numpy()[hit]}


def bridge(first, second, points):
    """Remsa av trianglar mellan två slutna slingor. Kortaste tvärgången väljs i varje steg."""
    best = None
    for candidate in (second, second[::-1]):
        distances = np.linalg.norm(points[first][:, None] - points[candidate][None], axis=2)
        i0, j0 = np.unravel_index(np.argmin(distances), distances.shape)
        a = first[i0:] + first[:i0] + [first[i0]]
        b = candidate[j0:] + candidate[:j0] + [candidate[j0]]
        faces, total, i, j = [], 0.0, 0, 0
        while i < len(a) - 1 or j < len(b) - 1:
            advance_a = j == len(b) - 1 or (i < len(a) - 1 and np.linalg.norm(points[a[i + 1]] - points[b[j]]) <= np.linalg.norm(points[a[i]] - points[b[j + 1]]))
            if advance_a:
                total += np.linalg.norm(points[a[i + 1]] - points[b[j]])
                faces.append([a[i], a[i + 1], b[j]])
                i += 1
            else:
                total += np.linalg.norm(points[a[i]] - points[b[j + 1]])
                faces.append([a[i], b[j + 1], b[j]])
                j += 1
        if best is None or total < best[0]:
            best = (total, faces)
    return best[1]


def weld_part(points, shell, part):
    """Svarar med skalets nya ytor och vad som togs bort."""
    shell_scene, shell_owner = scene_of(points, shell)
    part_scene, part_owner = scene_of(points, part)
    part_points = sorted({v for polygon in part for v in polygon})
    inside_shell = dict(zip(part_points, occupied(shell_scene, points[part_points])))
    outside = [polygon for polygon in part if not any(inside_shell[v] for v in polygon)]
    keep = components(outside)[0]
    outside = [outside[index] for index in keep]

    # Skalets ytor som delen sitter i: punkter inne i delen, ytor som delens kanter går igenom och kanter som går genom delen.
    shell_points = sorted({v for polygon in shell for v in polygon})
    inside_part = dict(zip(shell_points, occupied(part_scene, points[shell_points])))
    removed = {index for index, polygon in enumerate(shell) if any(inside_part[v] for v in polygon)}
    part_edges = sorted({edge for polygon in part for edge in edges_of(polygon)})
    going_in = np.array([edge for edge in part_edges if inside_shell[edge[0]] != inside_shell[edge[1]]], int).reshape(-1, 2)
    removed |= crossings(shell_scene, shell_owner, points, going_in)[1]
    shell_edges = {}
    for index, polygon in enumerate(shell):
        for edge in edges_of(polygon):
            shell_edges.setdefault(edge, []).append(index)
    segments = np.array(sorted(shell_edges), int)
    hit, _ = crossings(part_scene, part_owner, points, segments)
    for edge, through in zip(segments, hit):
        if through:
            removed.update(shell_edges[(int(edge[0]), int(edge[1]))])

    # Ett enda hål: små öar av skalet inne i hålet följer med, och två hål växer ihop.
    while True:
        kept = [polygon for index, polygon in enumerate(shell) if index not in removed]
        pieces = components(kept)
        if len(pieces) > 1:
            original = [index for index in range(len(shell)) if index not in removed]
            for piece in pieces[1:]:
                removed.update(original[i] for i in piece)
            continue
        loops = open_loops(kept)
        if len(loops) <= 1:
            break
        small = set(loops[-1])
        removed.update(index for index, polygon in enumerate(shell) if index not in removed and small & set(polygon))
    part_loops = open_loops(outside)
    if not loops or len(part_loops) != 1:
        raise RuntimeError(f"Expected one open edge on each side, found {len(loops)} and {len(part_loops)}")
    faces = bridge(part_loops[0], loops[0], points)
    return kept + outside + faces, {"part_points": len(part_points), "points_dropped": int(sum(inside_shell.values())), "shell_faces_removed": len(removed), "bridge_triangles": len(faces)}


def weld_islands(points, polygons):
    """Alla lösa delar in i det största skalet. Svarar med polygoner och en rad per del."""
    points = np.asarray(points, float)
    pieces = components(polygons)
    shell = [polygons[index] for index in pieces[0]]
    report = []
    for piece in pieces[1:]:
        shell, line = weld_part(points, shell, [polygons[index] for index in piece])
        report.append(line)
    return shell, report


def main():
    from head_builder import orient
    r = json.loads(sys.argv[1])
    name, version, out = r["name"], r["version"], r["out"]
    target = HERE / f"out/{out}.glb"
    stored = HERE / f"build/versions/{out}.json"
    if target.exists() or stored.exists():
        sys.exit(f"{out} already exists")
    saved = json.loads((HERE / f"build/versions/{version}.json").read_text())
    mesh = saved["mesh"]
    points = np.array(mesh["positions"]).reshape(-1, 3)
    polygons, report = weld_islands(points, mesh["polygons"])
    polygons = orient(polygons, points)
    alive = sorted({v for polygon in polygons for v in polygon})
    number = {old: new for new, old in enumerate(alive)}
    polygons = [[number[v] for v in polygon] for polygon in polygons]
    positions = points[alive]
    triangles = np.array([tri for polygon in polygons for tri in triangulate(polygon, positions)])
    pick = lambda values, size: np.array(values).reshape(-1, size)[alive]
    indices, weights, colors = pick(mesh["indices"], 4), pick(mesh["weights"], 4), pick(mesh["colors"], 4)
    output = {"positions": np.round(positions, 5).ravel().tolist(), "polygons": polygons, "triangles": triangles.ravel().tolist(),
              "keys": [mesh["keys"][v] for v in alive], "indices": indices.ravel().tolist(), "weights": weights.ravel().tolist(), "colors": colors.ravel().tolist(),
              "mirror": [number.get(mesh["mirror"][v], -1) for v in alive]}
    surface = trimesh.Trimesh(positions, triangles, process=False)
    editor = json.loads((HERE / f"build/editor/{name}.json").read_text())
    joints = {bone: np.array(value) for bone, value in editor["joints"].items()}
    write_rigged(target, positions, triangles, np.asarray(surface.vertex_normals), colors, indices, weights, joints)
    edits = saved["edits"]
    edits = {**edits, "operations": edits.get("operations", []) + [{"op": "weld_parts", "from": version, "parts": report, "tool": "tools/weld_parts.py"}]}
    stored.write_text(json.dumps({"mesh": output, "edits": edits}))
    print(json.dumps({"out": str(target), "polygons": len(polygons), "triangles": len(triangles), "points": len(alive), "watertight": bool(surface.is_watertight), "parts": report}))


if __name__ == "__main__":
    main()
