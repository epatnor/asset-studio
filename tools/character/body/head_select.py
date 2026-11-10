"""Väljer huvudets rader, kolumner och diagonaler för nivå 1f ur passningarna på nivå 6. JSON-recept in, en rad JSON ut.

  .venv/bin/python tools/head_select.py '{"fits": ["female_swim", "male_swim"], "rows": 10, "col_pairs": 6}'

Felet är den fina ytan mot en bilinjär yta över urvalet, med ansiktet (framsidan upp till kåpan) viktat högst. Urvalet
är girigt och samma för alla kroppar, eftersom topologin är fast. Kolumnerna är symmetriska och finns bara i ansiktets
rader. Resultatet skrivs till tools/head_face.json, som template.py läser."""
import json, sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
sys.path.insert(0, str(TOOLS))
from template import Template, FINE  # noqa: E402

r = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
FITS = r.get("fits", ["female_swim", "male_swim"])
T6 = Template(6)
rings = T6.rings["head"]
grid = np.array([x for x in rings if len(x) > 1])
Rf, Cf = grid.shape
pole = rings[-1][0]
G = {}
for b in FITS:
    X = np.load(HERE / f"build/fit/{b}.npz")["X6"]
    G[b] = np.concatenate([X[grid], np.repeat(X[pole][None, None], Cf, 1)])   # polen som sista rad
ALL = Rf + 1
CAP = r.get("cap_row", 78)      # kåpan börjar här
FACE_FROM = r.get("face_from", 6)   # ansiktets kolumner börjar här (under hakan räcker halsens kolumner)
theta = (np.arange(Cf) / Cf * 360 + 180) % 360 - 180
weight = np.where(np.abs(theta) < 75, 1.0, 0.15)[None] * np.where(np.arange(ALL) <= CAP, 1.0, 0.2)[:, None]
L1_rows = list(range(0, ALL, FINE))
L1_cols = list(range(0, Cf, FINE))


def surface(g, rows, cols):
    rows, cols = np.array(rows), np.array(sorted(cols))
    ri = np.clip(np.searchsorted(rows, np.arange(ALL), side="right") - 1, 0, len(rows) - 2)
    fr = ((np.arange(ALL) - rows[ri]) / (rows[ri + 1] - rows[ri]))[:, None, None]
    cc = np.append(cols, cols[0] + Cf)
    ci = np.clip(np.searchsorted(cc, np.arange(Cf), side="right") - 1, 0, len(cols) - 1)
    fc = ((np.arange(Cf) - cc[ci]) / (cc[ci + 1] - cc[ci]))[None, :, None]
    c0, c1 = cols[ci], cc[ci + 1] % Cf
    a = g[rows[ri]][:, c0] * (1 - fc) + g[rows[ri]][:, c1] * fc
    b = g[rows[ri + 1]][:, c0] * (1 - fc) + g[rows[ri + 1]][:, c1] * fc
    return a * (1 - fr) + b * fr


def cost(rows, cols):
    return sum((np.linalg.norm(surface(g, rows, cols) - g, axis=2) ** 2 * weight).sum() for g in G.values())


def errors(rows, cols):
    out = {}
    for b, g in G.items():
        e = np.linalg.norm(surface(g, rows, cols) - g, axis=2) * 1000
        face = e[FACE_FROM:CAP + 1][:, np.abs(theta) < 75]
        out[b] = {"face_mean_mm": round(float(face.mean()), 2), "face_p95_mm": round(float(np.percentile(face, 95)), 2), "head_mean_mm": round(float(e.mean()), 2)}
    return out


rows = list(L1_rows)
for _ in range(r.get("rows", 10)):
    rows = sorted(rows + [min((x for x in range(1, ALL) if x not in rows), key=lambda x: cost(sorted(rows + [x]), L1_cols))])
cols = list(L1_cols)
pairs = []
for _ in range(r.get("col_pairs", 6)):
    cand = [c for c in range(1, Cf // 2) if c not in cols and abs(theta[c]) <= 80]
    c = min(cand, key=lambda c: cost(rows, sorted(cols + [c, Cf - c])))
    cols = sorted(cols + [c, Cf - c])
    pairs.append(c)

# Diagonaler: per ruta i vänster halva den av de två som ligger närmast den fina ytan, summerat över kropparna; högra
# halvan speglas, så att ansiktet blir symmetriskt. Rutorna finns bara på rader där rad och kolumner är desamma uppåt.
face_rows = [x for x in rows if FACE_FROM <= x <= CAP]
ring_cols = lambda x: cols if face_rows[0] <= x <= face_rows[-1] else L1_cols
flips = {}
ring_rows = [x for x in rows if x < Rf]
for r0, r1 in zip(ring_rows, ring_rows[1:]):
    if ring_cols(r0) is not ring_cols(r1):
        continue
    cs = ring_cols(r0)
    for j, c0 in enumerate(cs):
        c1 = cs[(j + 1) % len(cs)]
        span = (c1 - c0) % Cf
        if not 0 <= c0 < Cf // 2 or span == 0 or c0 + span > Cf // 2:
            continue
        err = 0.0
        for g in G.values():
            A, B, C, D = g[r0, c0], g[r0, c1], g[r1, c1], g[r1, c0]
            for ri in range(r0, r1 + 1):
                s = (ri - r0) / (r1 - r0)
                for k in range(span + 1):
                    u = k / span
                    p = g[ri, (c0 + k) % Cf]
                    # diagonal A-C mot B-D: triangeln som punkten ligger i, plan interpolation
                    q1 = A + u * (B - A) + s * (C - B) if u >= s else A + s * (D - A) + u * (C - D)
                    q2 = A + u * (B - A) + s * (D - A) if u + s <= 1 else C + (1 - u) * (D - C) + (1 - s) * (B - C)
                    err += np.linalg.norm(p - q1) ** 2 - np.linalg.norm(p - q2) ** 2
        flips[f"{r0},{c0}"] = bool(err > 0)   # True: diagonalen B-D (kolumn c1 på rad r0 till kolumn c0 på rad r1)

json.dump({"rows": rows, "cols": cols, "face_rows": [face_rows[0], face_rows[-1]], "flip": flips, "fits": FITS},
          open(TOOLS / "head_face.json", "w"), indent=0)
print(json.dumps({"rows": rows, "added_rows": [x for x in rows if x not in L1_rows], "col_pairs_deg": [round(float(theta[c]), 1) for c in pairs],
                  "face_rows": [face_rows[0], face_rows[-1]], "flipped": int(sum(flips.values())), "quads": len(flips),
                  "L1": errors(L1_rows, L1_cols), "new": errors(rows, cols)}))
