"""Roboten: ansiktslös testkaraktär för att prova kropp, nät och rörelse utan ansikte, hår eller textur.

  ../lowpoly-test/.venv/bin/python tools/make_robot.py '{"name": "yvonne", "head": str(SPEL / "lowpoly-test/output/yvonne/p1_texture_mv.glb"), "out": "out/yvonne_robot.glb"}'

Kroppen är mallens glesa nivå (justerade hörn ur build/fit/<namn>_s.npz). Huvudet tas från en Tripo P1-modell av samma
person, där kanterna följer ansiktets former, och sys ihop med bålen vid halsen. Skelettet läggs i mallens ringar och
vikterna räknas ur delarna, så ingen automatisk riggning behövs. GLB:n har skelett, vikter och ett testklipp.
Skriver en ny fil om <out> redan finns. Skriver också varje pose som lera för bilder (build/robot/<pose>.glb)."""
import json, struct, sys
from pathlib import Path

import numpy as np
import open3d as o3d
import trimesh
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
sys.path.insert(0, str(TOOLS))
from sparse import SparseTemplate  # noqa: E402

# Skelettet: namn -> förälder.
BONES = {
    "root": None, "spine": "root", "chest": "spine", "neck": "chest", "head": "neck",
    "upperarm_L": "chest", "forearm_L": "upperarm_L", "hand_L": "forearm_L",
    "upperarm_R": "chest", "forearm_R": "upperarm_R", "hand_R": "forearm_R",
    "thigh_L": "root", "shin_L": "thigh_L", "foot_L": "shin_L",
    "thigh_R": "root", "shin_R": "thigh_R", "foot_R": "shin_R",
}
NAMES = list(BONES)
HIP_ABOVE = 0.03
KNEE_ROW = 7
# Benets rader 6, 7 och 8: helt lår, hälften och hälften, helt skenben.
KNEE_T = (0.40, 0.52)
LIGHT, DARK = (0.78, 0.8, 0.83, 1.0), (0.13, 0.14, 0.17, 1.0)
# Poserna, i grader runt X och Z per ben. +Z är framåt, X är figurens vänster, Y uppåt. A-pose är vilan.
POSES = {
    "rest": {},
    "arms_down": {"upperarm_L": (0, -35), "upperarm_R": (0, 35)},
    "arms_up": {"upperarm_L": (0, 75), "upperarm_R": (0, -75)},
    "elbows": {"upperarm_L": (-30, -20), "upperarm_R": (-30, 20), "forearm_L": (-110, 0), "forearm_R": (-110, 0)},
    "squat": {"thigh_L": (-80, 0), "thigh_R": (-80, 0), "shin_L": (110, 0), "shin_R": (110, 0), "foot_L": (-30, 0), "foot_R": (-30, 0), "spine": (20, 0), "chest": (10, 0), "_drop": 0.3},
    "step": {"thigh_L": (-50, 0), "shin_L": (55, 0), "thigh_R": (20, 0), "spine": (12, 0), "upperarm_L": (25, -30), "upperarm_R": (-25, 30), "forearm_L": (-30, 0), "forearm_R": (-50, 0)},
}


def smoothstep(low, high, value):
    t = np.clip((value - low) / (high - low), 0, 1)
    return t * t * (3 - 2 * t)


def weld(V, F):
    _, index, inverse = np.unique(np.round(V, 5), axis=0, return_index=True, return_inverse=True)
    return V[index], inverse.ravel()[F]


def load_head(path, body_points):
    """Tripo-modellen vänd till mallens riktning, i meter, inpassad mot AI-kroppens huvud med skala och läge."""
    mesh = trimesh.load(path, force="scene").to_geometry()
    V, F = weld(np.asarray(mesh.vertices), np.asarray(mesh.faces))
    V = np.stack([-V[:, 2], V[:, 1], V[:, 0]], axis=1)
    top = body_points[:, 1].max()
    head_points = body_points[body_points[:, 1] > top - 0.2]
    scale = (body_points[:, 1].max() - body_points[:, 1].min()) / (V[:, 1].max() - V[:, 1].min())
    V = V * scale
    V[:, 1] += top - V[:, 1].max()
    source = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(V[V[:, 1] > top - 0.2]))
    target = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(head_points))
    estimation = o3d.pipelines.registration.TransformationEstimationPointToPoint(with_scaling=True)
    fit = o3d.pipelines.registration.registration_icp(source, target, 0.03, np.eye(4), estimation)
    V = (fit.transformation[:3, :3] @ V.T).T + fit.transformation[:3, 3]
    return V, F, float(fit.inlier_rmse)


def cut_head(V, F, y_cut):
    """Det som ligger ovanför halsens snitt, och randen som en sluten slinga."""
    keep = F[V[F].mean(axis=1)[:, 1] > y_cut]
    components = trimesh.graph.connected_components(trimesh.graph.face_adjacency(keep), nodes=np.arange(len(keep)))
    keep = keep[max(components, key=len)]
    edges = {}
    for a, b, c in keep:
        for u, v in ((a, b), (b, c), (c, a)):
            if (v, u) in edges:
                del edges[(v, u)]
            else:
                edges[(u, v)] = True
    following = {}
    for u, v in edges:
        following.setdefault(u, []).append(v)
    loops = []
    seen = set()
    for start in following:
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        while True:
            options = [v for v in following[loop[-1]] if v not in seen or v == start]
            if not options or options[0] == start:
                break
            loop.append(options[0])
            seen.add(options[0])
        loops.append(loop)
    return keep, max(loops, key=len), len(loops)


def zip_rings(upper, lower, V, reverse_upper):
    """Syr ihop två slingor efter vinkeln runt halsens mitt."""
    center = V[lower].mean(axis=0)
    angle = lambda i: np.arctan2(V[i, 0] - center[0], V[i, 2] - center[2])
    def ordered(ring):
        ring = list(ring)
        angles = np.unwrap([angle(i) for i in ring])
        if angles[-1] < angles[0]:
            ring = ring[::-1]
            angles = np.unwrap([angle(i) for i in ring])
        start = int(np.argmin(np.abs(np.arctan2(np.sin(angles), np.cos(angles)))))
        ring = ring[start:] + ring[:start]
        unwrapped = np.unwrap([angle(i) for i in ring])
        return ring, unwrapped - unwrapped[0]
    up, up_a = ordered(upper)
    low, low_a = ordered(lower)
    i = j = 0
    faces = []
    while i < len(up) or j < len(low):
        next_up = up_a[i + 1] if i + 1 < len(up) else 2 * np.pi
        next_low = low_a[j + 1] if j + 1 < len(low) else 2 * np.pi
        if i < len(up) and (j == len(low) or next_up <= next_low):
            faces.append((low[j % len(low)], up[(i + 1) % len(up)], up[i % len(up)]))
            i += 1
        else:
            faces.append((low[j % len(low)], low[(j + 1) % len(low)], up[i % len(up)]))
            j += 1
    return faces


def oriented_polygons(polygons, V):
    """Alla polygoner varvade åt samma håll, och utåt."""
    owners = {}
    for index, polygon in enumerate(polygons):
        for a, b in zip(polygon, polygon[1:] + polygon[:1]):
            owners.setdefault((min(a, b), max(a, b)), []).append(index)
    polygons = [list(p) for p in polygons]
    done = [False] * len(polygons)
    for start in range(len(polygons)):
        if done[start]:
            continue
        done[start] = True
        queue = [start]
        while queue:
            current = queue.pop()
            polygon = polygons[current]
            for a, b in zip(polygon, polygon[1:] + polygon[:1]):
                for other in owners[(min(a, b), max(a, b))]:
                    if other == current or done[other]:
                        continue
                    candidate = polygons[other]
                    if any((x, y) == (a, b) for x, y in zip(candidate, candidate[1:] + candidate[:1])):
                        polygons[other] = candidate[::-1]
                    done[other] = True
                    queue.append(other)
    volume = 0.0
    for polygon in polygons:
        for k in range(1, len(polygon) - 1):
            volume += np.dot(V[polygon[0]], np.cross(V[polygon[k]], V[polygon[k + 1]]))
    return [p[::-1] for p in polygons] if volume < 0 else polygons


def skeleton(T, X, head_low, head_top):
    """Lederna ur mallens ringar."""
    ring = lambda seam: X[T.seams[seam]].mean(axis=0)
    torso_rows = {key[1]: [] for key in T.key if key[0] == "torso"}
    for index, key in enumerate(T.key):
        if key[0] == "torso":
            torso_rows[key[1]].append(index)
    row = lambda r: X[torso_rows[r]].mean(axis=0)
    def leg_row(side, wanted):
        indices = [i for i, key in enumerate(T.key) if key[0] == f"leg_{side}" and key[1] == wanted * 6]
        return X[indices].mean(axis=0)
    joints = {"root": row(24), "spine": row(48), "chest": row(72), "neck": row(108), "head": np.array([0.0, head_low, row(108)[2]])}
    for side in "LR":
        joints[f"upperarm_{side}"] = ring(f"shoulder_{side}")
        joints[f"forearm_{side}"] = ring(f"elbow_{side}")
        joints[f"hand_{side}"] = ring(f"wrist_{side}")
        # Höftleden sitter ovanför grenen, inte i benöppningens mitt, och knäet där benet är smalast.
        hip = ring(f"hip_{side}")
        joints[f"thigh_{side}"] = np.array([hip[0], X[T.seams[f"hip_{side}"], 1].max() + HIP_ABOVE, hip[2]])
        joints[f"shin_{side}"] = leg_row(side, KNEE_ROW)
        joints[f"foot_{side}"] = ring(f"ankle_{side}")
    return joints


def body_weights(T, X, keep_vertices):
    """Upp till fyra ben per hörn, ur delen och läget längs delen. Blandningen är mjuk över varje led."""
    out = []
    for i in keep_vertices:
        part, t, x = T.vpart[i], T.vt[i], X[i, 0]
        side = "L" if x > 0 else "R"
        w = {}
        if part == "torso":
            if t < 0.3:
                w = {"root": 1.0}
            elif t < 0.5:
                b = float(smoothstep(0.3, 0.5, t))
                w = {"root": 1 - b, "spine": b}
            elif t < 0.72:
                b = float(smoothstep(0.5, 0.72, t))
                w = {"spine": 1 - b, "chest": b}
            elif t < 0.93:
                w = {"chest": 1.0}
            else:
                b = float(smoothstep(0.93, 1.0, t))
                w = {"chest": 1 - b, "neck": b}
            # Bålen närmast armhålet följer armen lite, och höften följer låret.
            distance = abs(x) / 0.13
            if 0.6 < t < 0.92 and distance > 0.75:
                share = 0.45 * float(smoothstep(0.75, 1.1, distance))
                w = {k: v * (1 - share) for k, v in w.items()}
                w[f"upperarm_{side}"] = share
            if t < 0.22 and abs(x) > 0.02:
                # Framsidan viks i ljumsken och stannar med bäckenet. Skinkan följer låret, sidan lite.
                behind = float(smoothstep(0.04, -0.06, X[i, 2]))
                reach = 0.12 + 0.3 * behind
                share = reach * float(smoothstep(0.22, 0.0, t)) * float(smoothstep(0.02, 0.09, abs(x)))
                w = {k: v * (1 - share) for k, v in w.items()}
                w[f"thigh_{side}"] = share
        elif part.startswith("upperarm"):
            s = part[-1]
            b = float(smoothstep(0.8, 1.0, t))
            w = {f"upperarm_{s}": 1 - b, f"forearm_{s}": b}
            if t < 0.2:
                share = 0.45 * float(smoothstep(0.2, 0.0, t))
                w = {k: v * (1 - share) for k, v in w.items()}
                w["chest"] = share
        elif part.startswith("forearm"):
            s = part[-1]
            low = float(smoothstep(0.2, 0.0, t)) * 0.5
            high = float(smoothstep(0.85, 1.0, t))
            w = {f"upperarm_{s}": low, f"forearm_{s}": (1 - low) * (1 - high), f"hand_{s}": (1 - low) * high}
        elif part.startswith("hand"):
            w = {f"hand_{part[-1]}": 1.0}
        elif part.startswith("leg"):
            s = part[-1]
            # Lårets översta ringar: mer bäcken fram än bak, så att ljumsken viks och skinkan rundas.
            top = float(smoothstep(0.2, 0.0, t)) * (0.25 + 0.3 * float(smoothstep(-0.04, 0.05, X[i, 2])))
            knee =float(smoothstep(KNEE_T[0], KNEE_T[1], t))
            ankle = float(smoothstep(0.9, 1.0, t))
            w = {"root": top, f"thigh_{s}": (1 - top) * (1 - knee), f"shin_{s}": (1 - top) * knee * (1 - ankle), f"foot_{s}": (1 - top) * knee * ankle}
        elif part.startswith("foot"):
            w = {f"foot_{part[-1]}": 1.0}
        out.append(w)
    return out


def rotation(rx, rz):
    a, c = np.radians(rx), np.radians(rz)
    Rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    Rz = np.array([[np.cos(c), -np.sin(c), 0], [np.sin(c), np.cos(c), 0], [0, 0, 1]])
    return Rz @ Rx


def pose_matrices(pose, joints):
    """Världsmatriser per ben, som flyttar vilolägets punkter till posen."""
    world = {}
    for name, parent in BONES.items():
        R = rotation(*pose.get(name, (0, 0)))
        offset = joints[name] - (joints[parent] if parent else 0)
        local = np.eye(4)
        local[:3, :3], local[:3, 3] = R, offset
        if name == "root":
            local[1, 3] -= pose.get("_drop", 0.0)
        world[name] = (world[parent] if parent else np.eye(4)) @ local
    return {name: world[name] @ translate(-joints[name]) for name in BONES}


def translate(offset):
    out = np.eye(4)
    out[:3, 3] = offset
    return out


def quaternion(rx, rz):
    a, c = np.radians(rx) / 2, np.radians(rz) / 2
    qx = np.array([np.sin(a), 0, 0, np.cos(a)])
    qz = np.array([0, 0, np.sin(c), np.cos(c)])
    x1, y1, z1, w1 = qz
    x2, y2, z2, w2 = qx
    return np.array([w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
                     w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2])


def write_rigged(path, V, F, normals, colors, indices, weights, joints):
    blob = bytearray()
    views, accessors = [], []

    def add(array, kind, component, target=None, minmax=False):
        array = np.ascontiguousarray(array)
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": array.nbytes, **({"target": target} if target else {})})
        blob.extend(array.tobytes())
        count = int(array.size) if kind == "SCALAR" else int(array.shape[0])
        accessor = {"bufferView": len(views) - 1, "componentType": component, "count": count, "type": kind}
        if minmax:
            accessor["min"], accessor["max"] = np.atleast_2d(array).min(0).tolist(), np.atleast_2d(array).max(0).tolist()
            if kind == "SCALAR":
                accessor["min"], accessor["max"] = [float(array.min())], [float(array.max())]
        accessors.append(accessor)
        return len(accessors) - 1

    primitive = {"attributes": {"POSITION": add(V.astype(np.float32), "VEC3", 5126, 34962, True), "NORMAL": add(normals.astype(np.float32), "VEC3", 5126, 34962),
                                "COLOR_0": add(colors.astype(np.float32), "VEC4", 5126, 34962), "JOINTS_0": add(indices.astype(np.uint16), "VEC4", 5123, 34962),
                                "WEIGHTS_0": add(weights.astype(np.float32), "VEC4", 5126, 34962)},
                 "indices": add(F.astype(np.uint32).ravel(), "SCALAR", 5125, 34963), "material": 0, "mode": 4}
    nodes = [{"name": "robot", "mesh": 0, "skin": 0}]
    for name, parent in BONES.items():
        offset = joints[name] - (joints[parent] if parent else 0)
        nodes.append({"name": name, "translation": [float(v) for v in offset], "children": [NAMES.index(c) + 1 for c, p in BONES.items() if p == name]})
    nodes[1]["children"] = [NAMES.index(c) + 1 for c, p in BONES.items() if p == "root"]
    for node in nodes[1:]:
        if not node["children"]:
            del node["children"]
    bind = np.stack([translate(-joints[name]).T for name in NAMES]).astype(np.float32)
    skin = {"joints": [i + 1 for i in range(len(NAMES))], "skeleton": 1, "inverseBindMatrices": add(bind, "MAT4", 5126)}

    # Testklippet: poserna efter varandra, två sekunder per pose, och tillbaka till vilan.
    order = list(POSES) + ["rest"]
    times = np.array([i * 2.0 for i in range(len(order))], np.float32)
    time_accessor = add(times, "SCALAR", 5126, None, True)
    samplers, channels = [], []
    for index, name in enumerate(NAMES):
        keys = np.stack([quaternion(*POSES[p].get(name, (0, 0))) for p in order]).astype(np.float32)
        samplers.append({"input": time_accessor, "output": add(keys, "VEC4", 5126), "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": index + 1, "path": "rotation"}})
    root_positions = np.stack([joints["root"] - np.array([0, POSES[p].get("_drop", 0.0), 0]) for p in order]).astype(np.float32)
    samplers.append({"input": time_accessor, "output": add(root_positions, "VEC3", 5126), "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": 1, "path": "translation"}})

    document = {"asset": {"version": "2.0", "generator": "body-gen make_robot"}, "scene": 0, "scenes": [{"nodes": [0, 1]}], "nodes": nodes,
                "meshes": [{"name": "robot", "primitives": [primitive]}], "skins": [skin],
                "materials": [{"name": "robot", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.1, "roughnessFactor": 0.55}}],
                "animations": [{"name": "test", "samplers": samplers, "channels": channels}],
                "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accessors}
    text = json.dumps(document).encode()
    text += b" " * (-len(text) % 4)
    while len(blob) % 4:
        blob.append(0)
    Path(path).write_bytes(struct.pack("<III", 0x46546C67, 2, 28 + len(text) + len(blob)) + struct.pack("<II", len(text), 0x4E4F534A) + text
                           + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


def main():
    r = json.loads(sys.argv[1])
    name = r["name"]
    T = SparseTemplate()
    X = np.load(HERE / f"build/fit/{name}_s.npz")["X"]
    tris, parts = T.triangles()
    target = trimesh.load(HERE / f"build/fit/{name}_ai.glb", force="scene").to_geometry()
    points, _ = trimesh.sample.sample_surface_even(target, 120000, seed=4)
    HV, HF, rmse = load_head(HERE / r["head"], points)

    # Bålen slutar vid raden under halsens överkant, och huvudet tar över därifrån.
    ring_row = r.get("neck_row", 108)
    rows = {i: key[1] for i, key in enumerate(T.key) if key[0] == "torso"}
    ring = [i for i, key in enumerate(T.key) if key[0] == "torso" and key[1] == ring_row]
    above = {i for i, row in rows.items() if row > ring_row}
    body = np.array([f for f, p in zip(tris, parts) if p != "head" and not above.intersection(f.tolist())])
    used = np.unique(body)
    y_cut = float(X[ring, 1].mean()) + r.get("cut_above", 0.012)
    head_faces, boundary, loops = cut_head(HV, HF, y_cut)
    head_used = np.unique(head_faces)

    remap_body = {old: new for new, old in enumerate(used)}
    remap_head = {old: new + len(used) for new, old in enumerate(head_used)}
    V = np.vstack([X[used], HV[head_used]])
    faces = [[remap_body[v] for v in f] for f in body] + [[remap_head[v] for v in f] for f in head_faces]
    seam = zip_rings([remap_head[v] for v in boundary], [remap_body[v] for v in ring], V, False)
    faces = np.array(faces + [list(f) for f in seam])

    # Patriks ändringar ur editorn (tools/editor/) ligger ovanpå det beräknade nätet, per hörn i mallen.
    keys = ["|".join(str(part) for part in T.key[old]) for old in used] + [f"head|{old}" for old in head_used]
    index_of = {key: k for k, key in enumerate(keys)}
    base = V.copy()
    edits_path = HERE / f"build/fit/{name}_edits.json"
    edits = json.loads(edits_path.read_text()) if edits_path.exists() else {}
    for key, delta in edits.get("vertices", {}).items():
        if key in index_of:
            V[index_of[key]] += delta

    # Hela nätet ska vända utåt: sömmens trianglar följer bålens riktning.
    mesh = trimesh.Trimesh(V, faces, process=False)
    trimesh.repair.fix_normals(mesh)
    faces = np.asarray(mesh.faces)
    normals = np.asarray(mesh.vertex_normals)
    opening = {"watertight": bool(mesh.is_watertight), "head_loops": loops, "head_rmse_mm": round(rmse * 1000, 1), "neck_ring": len(ring), "head_ring": len(boundary)}

    joints = skeleton(T, X, y_cut + 0.03, float(HV[:, 1].max()))
    influences = body_weights(T, X, used)
    for vertex in head_used:
        y = HV[vertex, 1]
        b = float(smoothstep(y_cut, y_cut + 0.05, y))
        influences.append({"neck": 1 - b, "head": b})
    indices = np.zeros((len(V), 4), np.uint16)
    weights = np.zeros((len(V), 4), np.float32)
    for v, w in enumerate(influences):
        top = sorted(((value, bone) for bone, value in w.items() if value > 1e-4), reverse=True)[:4]
        total = sum(value for value, _ in top)
        for k, (value, bone) in enumerate(top):
            indices[v, k] = NAMES.index(bone)
            weights[v, k] = value / total

    # Mörka fält vid lederna, ljusa plåtar annars.
    colors = np.tile(np.array(LIGHT, np.float32), (len(V), 1))
    for new, old in enumerate(used):
        part, t = T.vpart[old], T.vt[old]
        joint = (part.startswith("upperarm") and (t < 0.13 or t > 0.87)) or (part.startswith("forearm") and (t < 0.16 or t > 0.87)) or part.startswith("hand") \
            or (part.startswith("leg") and (0.44 <= t <= 0.54 or t > 0.92 or t < 0.07)) or (part == "torso" and 0.40 <= t <= 0.47)
        if joint:
            colors[new] = DARK

    # Allt editorn behöver: nätet utan ändringar, vikterna, poserna och spegelhörnen.
    mirrored = cKDTree(base * np.array([-1.0, 1.0, 1.0]))
    distance, partner = mirrored.query(base)
    editor_folder = HERE / "build/editor"
    editor_folder.mkdir(parents=True, exist_ok=True)
    # Polygonerna som mallen har dem: rutor på kroppen, trianglar på huvudet och i halsens söm.
    head_polygons = [[remap_head[v] for v in f] for f in head_faces]
    body_polygons = [[remap_body[v] for v in f] for f, part in zip(T.faces, T.fpart) if part != "head" and not above.intersection(f)]
    polygons = oriented_polygons(body_polygons + head_polygons + [list(f) for f in seam], base)
    (editor_folder / f"{name}.json").write_text(json.dumps({
        "name": name, "positions": np.round(base, 5).ravel().tolist(), "polygons": polygons, "keys": keys,
        "joints": {bone: [float(v) for v in joints[bone]] for bone in NAMES}, "colors": np.round(colors, 3).ravel().tolist(),
        "indices": indices.ravel().tolist(), "weights": np.round(weights, 4).ravel().tolist(), "bones": NAMES,
        "mirror": np.where(distance < 0.015, partner, -1).tolist(),
        "poses": {pose_name: np.stack([pose_matrices(pose, joints)[bone] for bone in NAMES]).round(6).ravel().tolist() for pose_name, pose in POSES.items()},
    }))
    if r.get("data_only"):
        print(json.dumps({"editor_data": str(editor_folder / f"{name}.json"), "verts": len(V)}))
        return

    target_path = HERE / r["out"]
    stem, version = target_path.stem, 1
    while target_path.exists():
        version += 1
        target_path = target_path.with_name(f"{stem}_v{version}.glb")
    target_path.parent.mkdir(parents=True, exist_ok=True)
    write_rigged(target_path, V, faces, normals, colors, indices, weights, joints)

    # Varje pose med samma vikter, för att mäta och rita rörelsen.
    pose_folder = HERE / "build/robot"
    pose_folder.mkdir(parents=True, exist_ok=True)
    homogeneous = np.c_[V, np.ones(len(V))]
    report, rings_report = {}, {}
    for pose_name, pose in POSES.items():
        matrices = pose_matrices(pose, joints)
        stack = np.stack([matrices[bone] for bone in NAMES])
        # Ändringar som bara gäller en pose ritas med i den posen. De ändrar inte vilan.
        shaped = homogeneous.copy()
        for key, delta in edits.get("pose_vertices", {}).get(pose_name, {}).items():
            if key in index_of:
                shaped[index_of[key], :3] += delta
        moved = (stack[indices] @ shaped[:, None, :, None])[:, :, :3, 0]
        result = (moved * weights[..., None]).sum(axis=1)
        trimesh.Trimesh(result, faces, process=False).export(pose_folder / f"{pose_name}.glb")
        rest_lengths = np.linalg.norm(V[mesh.edges_unique[:, 0]] - V[mesh.edges_unique[:, 1]], axis=1)
        lengths = np.linalg.norm(result[mesh.edges_unique[:, 0]] - result[mesh.edges_unique[:, 1]], axis=1)
        report[pose_name] = round(float(np.percentile(np.abs(lengths / (rest_lengths + 1e-9) - 1), 99)), 3)
        # Hur mycket ringarna kring leden krymper: 1 är samma omkrets som i vila.
        new_index = {old: k for k, old in enumerate(used)}
        def perimeter_ratio(side, row):
            ring_vertices = [new_index[i] for i, key in enumerate(T.key) if key[0] == f"leg_{side}" and key[1] == row * 6 and i in new_index]
            length = lambda P: np.linalg.norm(P[ring_vertices] - np.roll(P[ring_vertices], -1, axis=0), axis=1).sum()
            return round(float(length(result) / length(V)), 3)
        rings_report[pose_name] = {f"knee_{s}": [perimeter_ratio(s, row) for row in (6, 7, 8)] for s in "LR"}
        rings_report[pose_name].update({f"hip_{s}": perimeter_ratio(s, 2) for s in "LR"})
    print(json.dumps({"rings": rings_report}))
    print(json.dumps({"out": str(target_path), "triangles": int(len(faces)), "verts": int(len(V)), "mb": round(target_path.stat().st_size / 2**20, 2), **opening,
                      "y_cut": round(y_cut, 3), "edge_stretch_p99": report}))


if __name__ == "__main__":
    main()
