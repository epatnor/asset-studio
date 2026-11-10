"""Justerar hörnen på den glesa nivån så att ytan ligger så nära AI-kroppen som möjligt. Bara kod, ingen modell.

  .venv/bin/python tools/refine_s.py '{"name": "yvonne", "iters": 14, "weights": {"face": 2, "chest": 2}}'
  .venv/bin/python tools/refine_s.py '{"name": "yvonne", "measure": true}'

Ett urval av hörnen på nivå 6 ligger på ytan, så en grov yta skär in i allt som är konvext. Här flyttas hörnen fritt:
punkter på AI-ytan ska nås av nätet och punkter på nätet ska nå AI-ytan, i båda riktningarna, med en Laplace-term
som håller nätets form. Topologin, atlasen och hörnens ordning ändras inte.
Skriver build/fit/<namn>_s.npz, som tools/export.py läser, och en rad JSON med avstånd per område före och efter."""
import json, sys
from pathlib import Path

import numpy as np
import open3d as o3d
import scipy.sparse as sp
import scipy.sparse.linalg as spla
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
SAMPLES = 160000
MAX_DISTANCE = 0.035
REGIONS = ("face", "head", "shoulders", "chest", "upperarm", "crotch", "rest")


def vertex_regions(T, X):
    """Problemområdena som Patrik pekade ut, per hörn. Resten av kroppen är "rest"."""
    part = np.array([p.split("_")[0] for p in T.vpart])
    t, ring = np.array(T.vt), np.array(T.vring)
    out = np.full(len(X), "rest", dtype=object)
    torso = part == "torso"
    side = np.abs(X[:, 0]) / (np.abs(X[torso, 0]).max() + 1e-9)
    z_mid = np.median(X[torso, 2])
    out[(part == "upperarm")] = "upperarm"
    out[torso & (t >= 0.5) & (t <= 0.83) & (X[:, 2] > z_mid)] = "chest"
    out[(torso & (t >= 0.68) & (side > 0.5)) | ((part == "upperarm") & (ring <= 1))] = "shoulders"
    legs = part == "leg"
    out[(torso & (t <= 0.16)) | (legs & (ring <= 1))] = "crotch"
    head = part == "head"
    y0, y1 = X[head, 1].min(), X[head, 1].max()
    h = (X[:, 1] - y0) / (y1 - y0)
    out[head] = "head"
    out[head & (h > 0.12) & (h < 0.72) & (X[:, 2] > np.median(X[head, 2]))] = "face"
    return out


def scene_of(V, F):
    mesh = o3d.t.geometry.TriangleMesh(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.int32)))
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(mesh)
    return scene


def closest(scene, P):
    ans = scene.compute_closest_points(o3d.core.Tensor(P.astype(np.float32)))
    return ans["points"].numpy().astype(np.float64), ans["primitive_ids"].numpy().astype(np.int64), ans["primitive_uvs"].numpy().astype(np.float64)


def face_normals(V, F):
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)


def measure(V, F, tri_region, P, PN):
    """Från AI-ytan till nätet, per område, i mm. Punkter längre bort än MAX_DISTANCE (knuten) räknas inte."""
    Q, tid, _ = closest(scene_of(V, F), P)
    d = np.linalg.norm(Q - P, axis=1)
    keep = d < MAX_DISTANCE
    out = {}
    for region in REGIONS:
        k = keep & (tri_region[tid] == region)
        out[region] = [round(float(d[k].mean() * 1000), 2), round(float(np.percentile(d[k], 95) * 1000), 2)] if k.any() else None
    out["all"] = [round(float(d[keep].mean() * 1000), 2), round(float(np.percentile(d[keep], 95) * 1000), 2)]
    return out


def main():
    r = json.loads(sys.argv[1])
    name = r["name"]
    T = export.template("s")
    start = export.level_positions(export.load_fit(name), "s")
    path = HERE / f"build/fit/{name}_s.npz"
    X = np.load(path)["X"] if r.get("resume") and path.exists() else start.copy()
    F, _ = T.triangles()
    regions = vertex_regions(T, start)
    tri_region = regions[F[:, 0]]
    for k in range(1, 3):
        order = np.array([REGIONS.index(x) for x in regions[F[:, k]]])
        current = np.array([REGIONS.index(x) for x in tri_region])
        tri_region = np.where(order < current, regions[F[:, k]], tri_region)

    target = trimesh.load(HERE / f"build/fit/{name}_ai.glb", force="scene").to_geometry()
    P, tids = trimesh.sample.sample_surface_even(target, SAMPLES, seed=3)
    PN = target.face_normals[tids]
    before = measure(start, F, tri_region, P, PN)
    if r.get("measure"):
        print(json.dumps({"measure": measure(X, F, tri_region, P, PN), "start": before}))
        return

    weights = np.array([r.get("weights", {}).get(x, 1.0) for x in REGIONS])
    tri_weight = weights[[REGIONS.index(x) for x in tri_region]]
    target_scene = scene_of(np.asarray(target.vertices), np.asarray(target.faces))
    target_normals = np.asarray(target.face_normals)

    # Laplace på skillnaden mot startläget: nätet får flytta sig, men inte veckas.
    n = len(X)
    edges = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    adj = sp.coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(n, n)).tocsr()
    adj = adj + adj.T
    degree = np.asarray(adj.sum(1)).ravel()
    L = sp.diags(degree) - adj
    L = sp.diags(1 / degree) @ L
    LTL = (L.T @ L).tocsr()
    normals0 = face_normals(start, F)
    iters = r.get("iters", 14)
    rng = np.random.default_rng(5)

    for it in range(iters):
        smooth = r.get("smooth", 1.5) * (1 - 0.8 * it / max(iters - 1, 1))
        fn = face_normals(X, F)
        rows, cols, values, rhs, row_weights = [], [], [], [], []

        def add(tid, uv, goal, w):
            base = len(rhs) and sum(len(g) for g in rhs)
            m = len(goal)
            bary = np.stack([1 - uv[:, 0] - uv[:, 1], uv[:, 0], uv[:, 1]], axis=1)
            rows.append(np.repeat(np.arange(m) + base, 3))
            cols.append(F[tid].ravel())
            values.append(bary.ravel())
            rhs.append(goal)
            row_weights.append(w)

        # AI-ytan ska nås av nätet.
        Q, tid, uv = closest(scene_of(X, F), P)
        d = np.linalg.norm(Q - P, axis=1)
        ok = (d < MAX_DISTANCE) & ((fn[tid] * PN).sum(1) > 0.1)
        add(tid[ok], uv[ok], P[ok], tri_weight[tid[ok]])

        # Nätet ska nå AI-ytan: punkter på nätet, jämnt över ytan.
        area = np.linalg.norm(np.cross(X[F[:, 1]] - X[F[:, 0]], X[F[:, 2]] - X[F[:, 0]]), axis=1)
        pick = rng.choice(len(F), size=SAMPLES // 2, p=area / area.sum())
        a, b = rng.random(len(pick)), rng.random(len(pick))
        flip = a + b > 1
        a[flip], b[flip] = 1 - a[flip], 1 - b[flip]
        low_uv = np.stack([a, b], axis=1)
        low = (X[F[pick]] * np.stack([1 - a - b, a, b], axis=1)[..., None]).sum(1)
        hit, hit_id, _ = closest(target_scene, low)
        dist = np.linalg.norm(hit - low, axis=1)
        good = (dist < MAX_DISTANCE) & ((fn[pick] * target_normals[hit_id]).sum(1) > 0.1)
        add(pick[good], low_uv[good], hit[good], tri_weight[pick[good]])

        goal = np.vstack(rhs)
        A = sp.csr_matrix((np.concatenate(values), (np.concatenate(rows), np.concatenate(cols))), shape=(len(goal), n))
        w = np.concatenate(row_weights) * (n / len(goal))
        W = sp.diags(w)
        lhs = (A.T @ W @ A + smooth * LTL + 1e-4 * sp.identity(n)).tocsc()
        right = A.T @ (w[:, None] * goal) + smooth * (LTL @ start) + 1e-4 * X
        solve = spla.factorized(lhs)
        X = np.stack([solve(np.asarray(right[:, i]).ravel()) for i in range(3)], axis=1)

    flipped = int(((face_normals(X, F) * normals0).sum(1) < 0).sum())
    np.savez(path, X=X)
    moved = np.linalg.norm(X - start, axis=1) * 1000
    print(json.dumps({"before": before, "after": measure(X, F, tri_region, P, PN), "flipped_tris": flipped,
                      "moved_mm": [round(float(moved.mean()), 1), round(float(moved.max()), 1)], "smooth": r.get("smooth", 1.5), "weights": r.get("weights", {})}))


if __name__ == "__main__":
    main()
