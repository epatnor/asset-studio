"""Passning i delar: en kroppspassad mall förfinas mot en AI-del i hög upplösning (Pixal3D ur delbilden).

  .venv/bin/python tools/refine_part.py <kropp> <del> <delmodell.glb> [--out namn] [--sides L R]

<kropp> är en passning i build/fit/<kropp>.npz. <del> är head, hand, foot, torso, leg, upperarm eller forearm;
delbilderna visar vänster sida, och höger sida passas mot samma del speglad.
1. Inriktning: AI-delen (godtycklig skala och vridning) riktas mot malldelen med likformig ICP (skala, vridning,
   flytt; de 10 % sämsta paren räknas bort, eftersom AI-delen har snittytor och mer hår). 24 startvridningar
   (kubens symmetrier) provas och den bästa behålls.
2. Icke-stel ICP som i fit.py, men bara för delens hörn: sömslingorna och allt utanför delen är låsta, och de
   närmaste raderna vid sömmen har ingen dragning (bara utjämning), så att övergången blir mjuk.
Skriver build/fit/<ut>.npz (hela kroppen, med delen förfinad), build/fit/<ut>_<del>_<sida>.glb (AI-delen i kroppens
rum, med textur, för bakningen) och mätvärden i build/fit/<ut>.json under "refined"."""
import argparse, itertools, json, sys
from pathlib import Path

import numpy as np
import trimesh
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fit  # noqa: E402
from template import Template  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
ISLANDS = {"head": ["head"], "hand": ["hand", "finger0", "finger1", "finger2", "finger3", "thumb"], "foot": ["foot"],
           "torso": ["torso"], "leg": ["leg"], "upperarm": ["upperarm"], "forearm": ["forearm"]}
SEAMS = {"head": ["neck"], "hand": ["wrist"], "foot": ["ankle"], "torso": ["neck", "shoulder_L", "shoulder_R", "hip_L", "hip_R"],
         "leg": ["hip", "ankle"], "upperarm": ["shoulder", "elbow"], "forearm": ["elbow", "wrist"]}


def umeyama(src, dst):
    """Likformig transform (s, R, t) som för src närmast dst i minsta kvadrat."""
    ms, md = src.mean(0), dst.mean(0)
    A, B = src - ms, dst - md
    U, S, Vt = np.linalg.svd(B.T @ A / len(src))
    D = np.eye(3)
    D[2, 2] = np.sign(np.linalg.det(U @ Vt))
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (A ** 2).sum(1).mean()
    return s, R, md - s * R @ ms


def rotations24(upright=False):
    """Kubens 24 vridningar, eller bara de fyra runt lodlinjen (upright: delen står redan rätt, som Pixal3D:s råa
    modell i kamerans ram när förlagan var rakt framifrån)."""
    if upright:
        return [np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]]) for a in np.radians([0, 90, 180, 270])]
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1, -1), repeat=3):
            R = np.zeros((3, 3))
            for i, (p, sg) in enumerate(zip(perm, signs)):
                R[i, p] = sg
            if np.linalg.det(R) > 0:
                out.append(R)
    return out


def align(Q, P, iters=40, keep=0.9, upright=True):
    """Riktar punkterna Q (AI-delen) mot P (malldelen). Svarar med (s, R, t, fel)."""
    tree_p = cKDTree(P)
    best = None
    for R0 in rotations24(upright):
        s = np.sqrt(((P - P.mean(0)) ** 2).sum(1).mean() / ((Q - Q.mean(0)) ** 2).sum(1).mean())
        R, t = R0, P.mean(0) - s * R0 @ Q.mean(0)
        for _ in range(iters):
            Qt = s * Q @ R.T + t
            d, j = tree_p.query(Qt)
            # åt båda hållen: malldelens punkter mot närmaste AI-punkt också, så att AI-delen inte krymper in i mallen
            tq = cKDTree(Qt)
            d2, k = tq.query(P)
            src = np.vstack([Q, Q[k]])
            dst = np.vstack([P[j], P])
            dd = np.r_[d, d2]
            ok = dd <= np.quantile(dd, keep)
            s, R, t = umeyama(src[ok], dst[ok])
        Qt = s * Q @ R.T + t
        err = np.r_[tree_p.query(Qt)[0], cKDTree(Qt).query(P)[0]]
        err = err[err <= np.quantile(err, keep)].mean()
        if best is None or err < best[3]:
            best = (s, R, t, err)
    return best


def refine(body, part, glb, out, sides=("L", "R"), upright=True):
    T = Template(6)
    X = np.load(HERE / f"build/fit/{body}.npz")["X6"].copy()
    A = T.arrays()
    L = fit.laplacian(T)
    fit._FACES["tris"] = T.triangles()[0]
    rec = json.load(open(HERE / f"build/fit/{body}.json"))
    src = trimesh.load(glb)
    raw = src.to_geometry() if isinstance(src, trimesh.Scene) else src
    res = {}
    for side in (sides if part not in ("head", "torso") else ("C",)):
        isl = [i + ("" if part in ("head", "torso") else f"_{side}") for i in ISLANDS[part]]
        sel = np.isin(A["island"], isl)
        seams = [s_ if part in ("head", "torso") or s_.endswith(("_L", "_R")) else f"{s_}_{side}" for s_ in SEAMS[part]]
        seam_v = np.unique(np.concatenate([T.seams[s_] for s_ in seams]))
        mirror = np.diag([-1.0, 1, 1]) if side == "R" else np.eye(3)
        Q0 = trimesh.sample.sample_surface(raw, 30000, seed=3)[0] @ mirror.T
        P = X[sel]
        s, R, t, err = align(Q0, P, upright=upright)
        M = np.eye(4)
        M[:3, :3] = s * R @ mirror
        M[:3, 3] = t
        m = raw.copy()
        m.apply_transform(M)
        if np.linalg.det(M[:3, :3]) < 0:
            m.invert()
        sc_full = src.copy()
        sc_full.apply_transform(M)
        tag = f"{out}_{part}_{side}"
        sc_full.export(HERE / f"build/fit/{tag}.glb")
        surf = fit.Surface(m)
        before = surf.unsigned(P)
        # låst: allt utanför delen och sömmarna; ingen dragning för hörn nära sömmen (bara utjämning)
        fixed = ~sel
        fixed[seam_v] = True
        near = np.zeros(len(X), bool)
        tree = cKDTree(X[seam_v])
        dseam = tree.query(X)[0]
        near[sel & (dseam < 0.02 if part != "hand" else dseam < 0.008)] = True
        vpart = np.where(sel, "part", "none")
        sc = {"part": surf, "none": surf}
        Xn = nicp_part(X, L, sc, vpart, fixed, near)
        after = surf.unsigned(Xn[sel])
        moved = np.linalg.norm(Xn - X, axis=1)[sel]
        X = Xn
        res[f"{part}_{side}"] = {"align_err_mm": round(err * 1000, 2), "scale": round(float(s), 4),
                                 "to_part_before_mean_mm": round(float(before.mean()) * 1000, 2),
                                 "to_part_after_mean_mm": round(float(after.mean()) * 1000, 2),
                                 "to_part_after_p95_mm": round(float(np.percentile(after, 95)) * 1000, 2),
                                 "moved_mean_mm": round(float(moved.mean()) * 1000, 2), "high": f"build/fit/{tag}.glb"}
        print(json.dumps(res[f"{part}_{side}"]), flush=True)
    np.savez(HERE / f"build/fit/{out}.npz", X6=X)
    rec = dict(rec, name=out, refined={**rec.get("refined", {}), **res})
    if out != body:
        import shutil
        shutil.copy(HERE / f"build/fit/{body}_ai.glb", HERE / f"build/fit/{out}_ai.glb")
    json.dump(rec, open(HERE / f"build/fit/{out}.json", "w"), indent=1)
    return res


def nicp_part(X, L, sc, vpart, fixed, near, alphas=(10, 3, 1, 0.5), iters=3, dmax=0.015):
    import scipy.sparse as sp
    import scipy.sparse.linalg as spla
    LtL = (L.T @ L).tocsc()
    for a in alphas:
        ref = X.copy()
        b_ref = LtL @ ref
        for _ in range(iters):
            c, cn = fit.closest_parts(X, vpart, sc)
            vn = fit.vertex_normals(X, L)
            d = np.linalg.norm(c - X, axis=1)
            w = ((d < dmax) & ((vn * cn).sum(1) > 0.3)).astype(float)
            w[near] = 0
            w[fixed] = 100.0
            c[fixed] = X[fixed]
            Wm = sp.diags(w)
            X = spla.spsolve((Wm + a * LtL).tocsc(), Wm @ c + a * b_ref)
    return X


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("body")
    ap.add_argument("part")
    ap.add_argument("glb")
    ap.add_argument("--out")
    ap.add_argument("--sides", nargs="+", default=["L", "R"])
    ap.add_argument("--free", action="store_true", help="alla 24 startvridningar (delen står inte upprätt i bilden)")
    a = ap.parse_args()
    refine(a.body, a.part, a.glb, a.out or a.body, a.sides, upright=not a.free)
