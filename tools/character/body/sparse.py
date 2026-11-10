"""Gles nivå "s": mallen med ungefär 3 000 trianglar, med budgeten per del från Tripo P1-kroppar (2026-11-03).

Trianglarna ligger där P1 lägger dem: stora på lår, armar, rygg och mage, små vid leder, ansikte, händer och fötter.
Allt är ett urval av hörnen på nivå 6, så passningarna, atlasen och morph targets gäller som för de andra nivåerna.
Raderna väljs per del och kolumnerna runt om är färre: bålen har 18 och 26 i zonen över byst, armhåla och axlar,
armarna 8 (16 vid axeln), benen 12. Där antalet ändras sys ringarna ihop med trianglar. Mellan benen går ett band
(UV-ön "gusset").

  .venv/bin/python tools/sparse.py     -> antal, sömkontroll och inbäddningen i nivå 6"""
import json

import numpy as np

from template import FINE, ROWS, TORSO_T, Template, check

SPARSE_LEVEL = "s"
# Bålens kolumner på nivå 1 (av 32). Armhålens kolumner 6, 8, 10 och 22, 24, 26 måste vara med.
TORSO_COLS = [0, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 29, 30]
# Zonen över byst, armhåla och axlar har fler kolumner: alla fram till armhålet, glest över ryggen.
ZONE_COLS = list(range(0, 11)) + [12, 14, 16, 18, 20] + list(range(22, 32))
# Raderna i nivå 6:s index, glest över magen och tätt över bysten. Armhålet är raderna 72 till 96, kolumnerna 36 till 60.
TORSO_ROWS = [0, 6, 12, 18, 24, 36, 48, 54, 57, 60, 63, 66, 69, 72, 78, 84, 90, 96, 102, 108, 114]
ZONE_ROWS = (54, 108)
SHOULDER_DENSE_ROW = 2
KEEP = {
    "upperarm": [0, 1, 2, 3, 6, 8],
    "forearm": [0, 1, 4, 7],
    "palm": [0, 1, 3, 4],
    "finger": [0, 2, 4, 6, 7],
    "thumb": [0, 2, 3, 5, 6],
    "leg": [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15],
    "foot": [0, 2, 4, 6, 7, 9, 10],
}
# Huvudet i nivå 6:s rader och kolumner: ansiktets kolumner finns bara på ansiktets rader.
HEAD_ROWS = [0, 6, 12, 14, 18, 21, 24, 27, 30, 36, 40, 42, 48, 54, 60, 66, 72, 84, 93, 102]
HEAD_FACE_ROWS = (12, 66)
# Tätt nära mittlinjen, där näsa, mun och ögon sitter, och bara halsens kolumner från tinningarna och bakåt.
HEAD_HALF_COLS = [0, 2, 4, 6, 8, 12, 15, 18, 21, 24, 27, 30, 36, 48, 60, 72, 84, 96]


class RingUV:
    """UV i en öbit mellan två ringar: kolumnen och ringen ("a" eller "b") per hörn, med sömmen skuren vid cut."""

    def __init__(self, full, cut, v_a, v_b):
        self.full, self.cut, self.v = full, cut, {"a": v_a, "b": v_b}

    def __call__(self, *corners):
        out = [(((c - self.cut) % self.full) / self.full, self.v[ring]) for ring, c in corners]
        if max(u for u, _ in out) - min(u for u, _ in out) > 0.5:
            out = [(u + 1 if u < 0.5 else u, v) for u, v in out]
        return out


class SparseTemplate(Template):
    """Samma gränssnitt som Template, med hörnnycklar ur nivå 6."""

    def __init__(self):
        self.level = SPARSE_LEVEL
        self.face_level = True
        self.n = 1
        self.s = FINE
        self.key, self.index = [], {}
        self.vpart, self.vt, self.vpsi, self.vcol, self.vring = [], [], [], [], []
        self.faces, self.fpart, self.fuv = [], [], []
        self.fisland, self.visland = [], []
        self.rings = {}
        self.seams = {}
        self.webs = {}
        self._torso()
        self._head()
        for side in "LR":
            self._arm(side)
            self._leg(side)
        self._orient()
        self.head_flip = {f"{r},{c}": False for r, c in self.head_quads}
        self._apply_head_diagonals()

    def head_selection(self):
        cols = sorted(set(HEAD_HALF_COLS) | {(32 * FINE - c) % (32 * FINE) for c in HEAD_HALF_COLS})
        return {"rows": HEAD_ROWS, "cols": cols, "face_rows": HEAD_FACE_ROWS, "flip": {}, "base": [c * FINE for c in TORSO_COLS]}

    def sparse_tube(self, part, ring0, name, cols6, full, cut6=0, island=None):
        """Ett rör längs de behållna raderna. cols6: ringens kolumner på nivå 6, full: antalet kolumner runt om där."""
        rows, keep, isl = ROWS[name], KEEP[name], island or part
        last = len(rows) - 1
        rings = [list(ring0)]
        for r, index in enumerate(keep[1:], 1):
            row = rows[index]
            key = index * FINE
            if row == "pole":
                rings.append([self.vert((isl, key, 0), part, rows[index - 1][0], 90.0, 0, r, isl)])
            else:
                rings.append([self.vert((isl, key, c), part, row[0], row[1], j, r, isl) for j, c in enumerate(cols6)])
        K = len(cols6)
        for r in range(len(rings) - 1):
            a, b = rings[r], rings[r + 1]
            v0, v1 = keep[r] / last, keep[r + 1] / last
            for j in range(K):
                j1 = (j + 1) % K
                u0 = ((cols6[j] - cut6) % full) / full
                u1 = ((cols6[j1] - cut6) % full) / full
                u1 = u1 if u1 > u0 else 1.0
                if len(b) == 1:
                    self.face((a[j], a[j1], b[0]), part, ((u0, v0), (u1, v0), ((u0 + u1) / 2, v1)), isl)
                else:
                    self.face((a[j], a[j1], b[j1], b[j]), part, ((u0, v0), (u1, v0), (u1, v1), (u0, v1)), isl)
        self.rings[isl] = rings
        return rings

    def mirrored_quad(self, part, column, full, corners, uv, island=None):
        """Rutorna delas längs hörn 0-2. På högra halvan roteras de, så att diagonalerna speglas kring mittlinjen."""
        if column >= full / 2:
            corners, uv = tuple(corners[1:]) + tuple(corners[:1]), tuple(uv[1:]) + tuple(uv[:1])
        self.face(corners, part, uv, island)

    def sew(self, part, a, b, uv, island=None):
        """Syr ihop två ringar (kolumn -> hörn) i nivå 6:s kolumner, med kvadrater där kolumnerna är samma och
        fläktar där den ena ringen har fler. Den glesare ringens kolumner måste finnas i den tätare."""
        full = uv.full
        low, top, flip = (a, b, False) if len(a) <= len(b) else (b, a, True)
        columns = sorted(low)
        for c0, c1 in zip(columns, columns[1:] + columns[:1]):
            span = (c1 - c0) % full
            inner = [(c0 + k) % full for k in range(1, span) if (c0 + k) % full in top]
            if not inner:
                self.mirrored_quad(part, c0, full, (a[c0], a[c1], b[c1], b[c0]), uv(("a", c0), ("a", c1), ("b", c1), ("b", c0)), island)
                continue
            lo, hi = ("b", "a") if flip else ("a", "b")
            points = [c0] + inner + [c1]
            middle = points[len(points) // 2]
            self.face((low[c0], low[c1], top[middle]), part, uv((lo, c0), (lo, c1), (hi, middle)), island)
            seen = False
            for p, q in zip(points, points[1:]):
                corner = c1 if seen else c0
                self.face((low[corner], top[q], top[p]), part, uv((lo, corner), (hi, q), (hi, p)), island)
                seen = seen or q == middle

    def _torso(self):
        full, last = 32 * FINE, (len(TORSO_T) - 1) * FINE
        base = [c * FINE for c in TORSO_COLS]
        zone = [c * FINE for c in ZONE_COLS]
        cols_of = lambda r: zone if ZONE_ROWS[0] <= r <= ZONE_ROWS[1] else base
        holes = {"L": (36, 60), "R": (132, 156)}
        hole_rows = (72, 96)
        inside = lambda r, c: hole_rows[0] < r < hole_rows[1] and any(a < c < b for a, b in holes.values())
        t_of = lambda r: float(np.interp(r / FINE, range(len(TORSO_T)), TORSO_T))
        g = {r: {c: self.vert(("torso", r, c), "torso", t_of(r), 0.0, j, i)
                 for j, c in enumerate(cols_of(r)) if not inside(r, c)} for i, r in enumerate(TORSO_ROWS)}
        for r0, r1 in zip(TORSO_ROWS, TORSO_ROWS[1:]):
            a, b = g[r0], g[r1]
            if r0 >= hole_rows[0] and r1 <= hole_rows[1]:
                # Banden förbi armhålen: kolumnerna på armhålens plats finns inte.
                for j, c0 in enumerate(zone):
                    c1 = zone[(j + 1) % len(zone)]
                    if any(x <= c0 < y for x, y in holes.values()):
                        continue
                    u0 = ((c0 - 96) % full) / full
                    u1 = ((c1 - 96) % full) / full
                    u1 = u1 if u1 > u0 else 1.0
                    self.mirrored_quad("torso", c0, full, (a[c0], a[c1], b[c1], b[c0]), ((u0, r0 / last), (u1, r0 / last), (u1, r1 / last), (u0, r1 / last)))
            else:
                self.sew("torso", a, b, RingUV(full, 96, r0 / last, r1 / last))
        self.rings["torso"] = [list(g[r].values()) for r in TORSO_ROWS]
        for side, (x, y) in holes.items():
            near, far = (x, y) if side == "L" else (y, x)
            step = 6 if far > near else -6
            across = [near + k * step for k in range(5)]
            sides = [78, 84, 90]
            self.seams[f"shoulder_{side}"] = ([g[72][c] for c in across] + [g[r][far] for r in sides] + [g[96][c] for c in across[::-1]]
                                              + [g[r][near] for r in sides[::-1]])
        g = {0: g[0], 19: g[114]}
        # Grenbandet: i stället för en rad hörn mitt emellan benen går ett band från mitt fram till mitt bak.
        # Dess kanter är hörn på benens insida, en rad under grenen på nivå 6.
        front_col, back_col = 112, 104
        edge = {side: (self.vert((f"leg_{side}", FINE, back_col), f"leg_{side}", 0.06, 0.0, 0, -1),
                       self.vert((f"leg_{side}", FINE, front_col), f"leg_{side}", 0.06, 0.0, 1, -1)) for side in "LR"}
        # Bandet börjar brett: mitt fram och mitt bak är dess mittlinje, och benen börjar vid kolumnerna intill.
        (left_back, left_front), (right_back, right_front) = edge["L"], edge["R"]
        middle_front = self.vert(("bridge", 6, 0), "torso", 0.0, 0.0, 0, -1)
        middle_back = self.vert(("bridge", 18, 0), "torso", 0.0, 0.0, 1, -1)
        band = [[g[0][12], g[0][0], g[0][180]], [left_front, middle_front, right_front], [left_back, middle_back, right_back], [g[0][84], g[0][96], g[0][108]]]
        for row in range(3):
            for col in range(2):
                corners = (band[row][col], band[row][col + 1], band[row + 1][col + 1], band[row + 1][col])
                u0, u1, v0, v1 = col / 2, (col + 1) / 2, row / 3, (row + 1) / 3
                uv = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
                self.mirrored_quad("torso", col, 2, corners, uv, "gusset")
        half = [c for c in TORSO_COLS if 2 <= c <= 14]
        self.seams["hip_L"] = [g[0][c * FINE] for c in half] + [left_back, left_front]
        self.seams["hip_R"] = [g[0][((32 - c) % 32) * FINE] for c in half] + [right_back, right_front]
        self.leg_cols = [c * FINE for c in half] + [back_col, front_col]
        self.seams["neck"] = [g[19][c * FINE] for c in TORSO_COLS]

    def _arm(self, side):
        cols = [j * 12 for j in range(8)]
        part = f"upperarm_{side}"
        # Axeln har armhålets 16 hörn, och armen går ned till 8 efter den andra ringen.
        dense = [j * 6 for j in range(16)]
        keep = KEEP["upperarm"]
        last = len(ROWS["upperarm"]) - 1
        rings = {keep[0]: dict(zip(dense, self.seams[f"shoulder_{side}"]))}
        for r, index in enumerate(keep[1:], 1):
            row = ROWS["upperarm"][index]
            columns = dense if index <= SHOULDER_DENSE_ROW else cols
            rings[index] = {c: self.vert((part, index * FINE, c), part, row[0], row[1], c // 6, r) for c in columns}
        for i0, i1 in zip(keep, keep[1:]):
            self.sew(part, rings[i0], rings[i1], RingUV(96, 0, i0 / last, i1 / last))
        self.rings[part] = [list(rings[i].values()) for i in keep]
        ua = [list(rings[keep[-1]].values())]
        self.seams[f"elbow_{side}"] = ua[-1]
        fa = self.sparse_tube(f"forearm_{side}", ua[-1], "forearm", cols, 96)
        self.seams[f"wrist_{side}"] = fa[-1]
        self._hand(side, fa[-1])

    def _hand(self, side, wrist):
        part = f"hand_{side}"
        keep = KEEP["palm"]
        last = len(ROWS["palm"]) - 1
        g = {0: list(wrist)}
        for r, i in enumerate(keep[1:], 1):
            g[i] = [self.vert((part, i * FINE, j * 12), part, ROWS["palm"][i][0], 0.0, j, r) for j in range(8)]
        # Tummens hål är en ruta: raderna 1 och 3, kolumnerna 14 och 16 på nivå 1. Skärningen vid lillfingerkanten, kolumn 6.
        for i0, i1 in zip(keep, keep[1:]):
            for j in range(8):
                if i0 == 1 and j == 7:
                    continue
                j1 = (j + 1) % 8
                u0 = ((j - 3) % 8) / 8
                self.face((g[i0][j], g[i0][j1], g[i1][j1], g[i1][j]), part,
                          ((u0, i0 / last), (u0 + 1 / 8, i0 / last), (u0 + 1 / 8, i1 / last), (u0, i1 / last)))
        self.rings[part] = [g[i] for i in keep]
        thumb = [g[1][7], g[1][0], g[3][0], g[3][7]]
        self.seams[f"thumb_{side}"] = thumb
        top = g[4]
        back = [top[(7 - k) % 8] for k in range(5)]
        palm = [top[(7 + k) % 8] for k in range(5)]
        for i in (1, 2, 3):
            self.webs[(side, i)] = (back[i], [], palm[i])
        for i in range(4):
            if i == 0:
                loop = [back[0], back[1], palm[1]]
            elif i == 3:
                loop = [back[3], back[4], palm[3]]
            else:
                loop = [back[i], back[i + 1], palm[i + 1], palm[i]]
            self.seams[f"finger{i}_{side}"] = loop
            cols, full = ([0, 12, 24], 36) if len(loop) == 3 else ([0, 12, 24, 36], 48)
            self.sparse_tube(part, loop, "finger", cols, full, island=f"finger{i}_{side}")
        self.sparse_tube(part, thumb, "thumb", [0, 12, 24, 36], 48, island=f"thumb_{side}")

    def _leg(self, side):
        leg = self.sparse_tube(f"leg_{side}", self.seams[f"hip_{side}"], "leg", self.leg_cols, 120)
        self.seams[f"ankle_{side}"] = leg[-1]
        self.sparse_tube(f"foot_{side}", leg[-1], "foot", self.leg_cols, 120)


if __name__ == "__main__":
    t = SparseTemplate()
    tris, parts = t.triangles()
    per_part = {}
    for p in parts:
        name = p.split("_")[0]
        per_part[name] = per_part.get(name, 0) + 1
    fine = set(Template(6).key)
    missing = [k for k in t.key if k not in fine]
    print(json.dumps({**t.stats(), **check(t), "per_part": per_part, "nested": not missing, "missing": [str(k) for k in missing[:8]]}))
