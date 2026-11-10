"""Mallens nät på en nivå som GLB: UV-atlas (samma för alla kroppar), normaler och morph targets.

  .venv/bin/python tools/export.py <namn> <nivå> <ut.glb> [--targets namn2 namn3 ...]

<namn> är en passning i build/fit/<namn>.npz (hörnen på nivå 6). Nivån (1, 2, 3, 6) tas ut som ett urval av
hörnen. --targets lägger till andra passningar som morph targets (skillnaden mot basen), med namnen i
mesh.extras.targetNames. UV-atlasen ligger i tools/uv_layout.json och räknas ut en gång (första gången) ur
basens mått; därefter är den fast, så att alla kroppar och alla nivåer delar samma UV."""
import json, struct, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from template import Template  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
LAYOUT = Path(__file__).resolve().parent / "uv_layout.json"
# Texeltäthet per del (linjärt): ansiktet och händerna får mer av texturen
DENSITY = {"head": 1.6, "hand": 1.3, "finger0": 1.3, "finger1": 1.3, "finger2": 1.3, "finger3": 1.3, "thumb": 1.3, "foot": 1.1}
MARGIN = 0.012

_T = {}


def template(level):
    if level not in _T:
        if level == "s":
            from sparse import SparseTemplate
            _T[level] = SparseTemplate()
        else:
            _T[level] = Template(level)
    return _T[level]


def level_positions(X6, level):
    T6, T = template(6), template(level)
    return X6[[T6.index[k] for k in T.key]]


def part_dims(T, X):
    """Bredd (medelomkrets) och höjd (längd längs delen) per del, i meter."""
    dims = {}
    for p, rings in T.rings.items():
        full = [r for r in rings if len(r) > 1 and all(v is not None for v in r)]
        circ = np.mean([np.linalg.norm(X[r] - X[np.roll(r, -1)], axis=1).sum() for r in full])
        cen = np.array([X[r].mean(0) for r in rings if all(v is not None for v in r)])
        length = np.linalg.norm(np.diff(cen, axis=0), axis=1).sum()
        dims[p] = (float(circ), float(length))
    return dims


def make_layout(dims):
    """Hyllpackning av delarnas rektanglar i enhetskvadraten; skalan söks så att allt får plats."""
    rects = {p: (w * DENSITY.get(p.split("_")[0], 1), h * DENSITY.get(p.split("_")[0], 1)) for p, (w, h) in dims.items()}
    order = sorted(rects, key=lambda p: -rects[p][1])

    def pack(s):
        x = y = rowh = 0
        out = {}
        for p in order:
            w, h = rects[p][0] * s, rects[p][1] * s
            if x + w > 1:
                x, y, rowh = 0, y + rowh + MARGIN, 0
            out[p] = (x, y, w, h)
            x += w + MARGIN
            rowh = max(rowh, h)
        return out, y + rowh

    lo, hi = 0.01, 10
    for _ in range(50):
        s = (lo + hi) / 2
        if pack(s)[1] <= 1:
            lo = s
        else:
            hi = s
    return {p: list(r) for p, r in pack(lo)[0].items()}


def layout(X6=None):
    if LAYOUT.exists():
        return json.load(open(LAYOUT))
    T = template(6)
    lay = make_layout(part_dims(T, X6))
    json.dump(lay, open(LAYOUT, "w"), indent=1)
    return lay


def vertex_normals(X, tris):
    fn = np.cross(X[tris[:, 1]] - X[tris[:, 0]], X[tris[:, 2]] - X[tris[:, 0]])
    vn = np.zeros_like(X)
    for k in range(3):
        np.add.at(vn, tris[:, k], fn)
    return vn / (np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12)


def gltf_arrays(level, lay):
    """Hörn delade vid UV-sömmar: (källhörn, uv) per unikt par, och trianglar i de nya indexen."""
    T = template(level)
    src, uvs, index, tris = [], [], {}, []
    for f, p, fuv in zip(T.faces, T.fisland, T.fuv):
        x0, y0, w, h = lay[p]
        ids = []
        for v, (u, t) in zip(f, fuv):
            uv = (round(x0 + u * w, 6), round(y0 + t * h, 6))
            k = (v, uv)
            if k not in index:
                index[k] = len(src)
                src.append(v)
                uvs.append(uv)
            ids.append(index[k])
        tris += [ids[:3]] if len(ids) == 3 else [[ids[0], ids[1], ids[2]], [ids[0], ids[2], ids[3]]]
    return np.array(src), np.array(uvs, np.float32), np.array(tris, np.uint32)


def write_glb(path, pos, nrm, uv, tris, targets=(), target_names=(), extras=None):
    """Minimal GLB: en mesh, en primitiv, valfria morph targets (positionsskillnader)."""
    blob = bytearray()
    views, accs = [], []

    def add(arr, target=None, kind="VEC3", comp=5126, minmax=False):
        arr = np.ascontiguousarray(arr)
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": arr.nbytes, **({"target": target} if target else {})})
        blob.extend(arr.tobytes())
        a = {"bufferView": len(views) - 1, "componentType": comp, "count": int(arr.shape[0]) if kind != "SCALAR" else int(arr.size), "type": kind}
        if minmax:
            a["min"], a["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        accs.append(a)
        return len(accs) - 1

    attrs = {"POSITION": add(pos.astype(np.float32), 34962, minmax=True), "NORMAL": add(nrm.astype(np.float32), 34962),
             "TEXCOORD_0": add(uv.astype(np.float32), 34962, kind="VEC2")}
    idx = add(tris.astype(np.uint32).ravel(), 34963, kind="SCALAR", comp=5125)
    prim = {"attributes": attrs, "indices": idx, "mode": 4}
    mesh = {"name": "body", "primitives": [prim]}
    if len(targets):
        prim["targets"] = [{"POSITION": add(d.astype(np.float32), 34962, minmax=True)} for d in targets]
        mesh["weights"] = [0.0] * len(targets)
        mesh["extras"] = {"targetNames": list(target_names)}
    gl = {"asset": {"version": "2.0", "generator": "body-gen"}, "scene": 0, "scenes": [{"nodes": [0]}],
          "nodes": [{"name": "body", "mesh": 0, **({"extras": extras} if extras else {})}], "meshes": [mesh],
          "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accs}
    js = json.dumps(gl).encode()
    js += b" " * (-len(js) % 4)
    while len(blob) % 4:
        blob.append(0)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    Path(path).write_bytes(out)


def load_fit(name):
    return np.load(HERE / f"build/fit/{name}.npz")["X6"]


def export(name, level, out, targets=()):
    X6 = load_fit(name)
    lay = layout(X6)
    T = template(level)
    X = level_positions(X6, level)
    # Den glesa nivåns hörn kan vara justerade mot AI-ytan (tools/refine_s.py). Topologin är densamma.
    refined = HERE / f"build/fit/{name}_s.npz"
    if level == "s" and refined.exists():
        X = np.load(refined)["X"]
    src, uv, tris = gltf_arrays(level, lay)
    ttris = T.triangles()[0]
    nrm = vertex_normals(X, ttris)[src]
    deltas = [level_positions(load_fit(t), level)[src] - X[src] for t in targets]
    q = sum(len(f) == 4 for f in T.faces)
    write_glb(out, X[src], nrm, uv, tris, deltas, targets,
              extras={"template_level": level, "triangles": int(len(tris)), "verts": int(len(src)), "quads": q})
    return {"out": str(out), "level": level, "triangles": int(len(tris)), "verts": int(len(src))}


if __name__ == "__main__":
    a = sys.argv[1:]
    tg = a[a.index("--targets") + 1:] if "--targets" in a else []
    print(json.dumps(export(a[0], int(a[1]) if a[1].isdigit() else a[1], a[2], tg)))
