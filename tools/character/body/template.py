"""Kroppsmallen: fast topologi i delar, med sömslingor där delarna möts.

Varje del är ett rör av ringar (rader) och kolumner runt om. Delarna och sömmarna:
  torso      32n kolumner; två armhål (4n x 4n celler, slinga 16n hörn) och två benöppningar längst ned
             (halva bottenringen plus en grenbrygga på 4n-1 hörn: slinga 20n hörn); halsringen överst (32n)
  head       börjar i bålens halsring, sluter med en pol på hjässan
  upperarm   börjar i armhålets slinga (16n), slutar i armbågen
  forearm    armbåge -> handled (16n)
  hand       handflatan: handled -> knogar, med ett hål (2n x 2n celler, slinga 8n) där tummen sitter; knogslingan
             delas i fyra fingerslingor med bryggor (2n-1 hörn) mellan fingrarna, som grenen; pekfinger och lillfinger
             6n hörn, lång- och ringfinger 8n. Fingrar och tumme är egna rör med pol i toppen och egna UV-öar,
             men passas som en del ("hand_L")
  leg        benöppningen (20n) -> fotleden
  foot       fotled -> tår, pol längst fram
Nivå n (1, 2, 3, 6) ger n gånger så många rader och kolumner. Nivåerna är inbäddade i den finaste (6):
hörnet (del, rad, kolumn) på nivå n har nyckeln (del, rad*6/n, kolumn*6/n), så ett nät på nivå n är
ett urval av hörnen i en passning på nivå 6. Därför kan passningen göras fint och lågpolyn tas ut sist,
med polygonerna där mallen säger.

Extra ringar där formen varierar mest: säte och bröst i bålen, axlarna (ringarna kring armhålen), ansiktet
(täta rader från haka till panna) och knä och armbåge.

Vänster = +X, framåt = +Z, uppåt = +Y. Vinkeln theta runt bålen och huvudet: 0 fram, +90 grader åt vänster."""
import json
from pathlib import Path

import numpy as np

FINE = 6
LEVELS = (1, 2, 3, 6)
# Nivå 1 med tätare ansikte: huvudets rader, kolumner och diagonaler är ett urval ur nivå 6 (tools/head_face.json,
# från tools/head_select.py). Resten av kroppen är nivå 1, och atlasen är densamma.
FACE_LEVEL = "1f"
HEAD_FACE = Path(__file__).resolve().parent / "head_face.json"

# Raderna på nivå 1 som (t, psi): t längs delens axel 0..1, psi > 0 för ringar i en kåpa (grader, höjd över
# tvärplanet från axelpunkten vid t); "pole" är polen.
TORSO_T = [0, .05, .10, .16, .22, .28, .34, .40, .46, .52, .58, .63, .68, .73, .78, .83, .88, .93, .97, 1.0]
HOLE_ROWS = (12, 16)       # armhålets rader på nivå 1 (4 celler)
HOLE_COLS_L = (6, 10)      # vänster armhål: kolumner kring 90 grader (4 celler)
HOLE_COLS_R = (22, 26)
ROWS = {
    "upperarm": [(t, 0) for t in (0, .12, .25, .38, .5, .62, .75, .88, 1.0)],
    "forearm": [(t, 0) for t in (0, .15, .3, .45, .6, .75, .88, 1.0)],
    "palm": [(t, 0) for t in (0, .25, .5, .75, 1.0)],
    "finger": [(t, 0) for t in (0, .3, .55, .75, .88)] + [(.88, 40), (.88, 70), "pole"],
    "thumb": [(t, 0) for t in (0, .3, .55, .75)] + [(.75, 40), (.75, 70), "pole"],
    "leg": [(t, 0) for t in (0, .06, .12, .19, .26, .33, .40, .46, .52, .58, .65, .72, .79, .86, .93, 1.0)],
    "foot": [(t, 0) for t in (0, .12, .25, .38, .5, .62, .74, .85)] + [(.85, 35), (.85, 65), "pole"],
    "head": [(t, 0) for t in (0, .05, .1, .16, .22, .27, .32, .37, .42, .47, .52, .57, .62, .66)]
            + [(.6, 30), (.6, 50), (.6, 70), "pole"],
}
# Handflatan (nivå 1, 16 kolumner som armen): framkanten (pekfingersidan) i kolumn 14, lillfingerkanten i 6;
# handryggen är kolumnerna 13..7 och handflatan 15, 0..5 (passningen lägger armens kolumner så). Tummens hål sitter
# på handflatesidan av framkanten, rad 1..3.
PALM_EDGE_F, PALM_EDGE_P = 14, 6
THUMB_ROWS, THUMB_COLS = (1, 3), (14, 16)
PARTS = ["torso", "head", "upperarm_L", "forearm_L", "hand_L", "upperarm_R", "forearm_R", "hand_R",
         "leg_L", "foot_L", "leg_R", "foot_R"]


def refine(rows, n):
    """Rader på nivå n: n-1 jämnt fördelade mellanrader mellan varje par på nivå 1 (polen sist)."""
    out = []
    for a, b in zip(rows, rows[1:]):
        if b == "pole":
            b = (a[0], 90.0)
        for k in range(n):
            f = k / n
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    out.append(rows[-1])
    return out


class Template:
    """Mallen på en nivå: hörn med nycklar och parametrar, ytor (quads och trianglar) med del."""

    def __init__(self, level):
        assert level in LEVELS or level == FACE_LEVEL
        self.face_level = level == FACE_LEVEL
        self.n = n = 1 if self.face_level else level
        self.s = FINE // n
        self.key, self.index = [], {}
        self.vpart, self.vt, self.vpsi, self.vcol, self.vring = [], [], [], [], []
        self.faces, self.fpart, self.fuv = [], [], []   # fuv: (u, v) per hörn i ytan, i delens egna rum 0..1
        self.fisland, self.visland = [], []   # UV-ö per yta och hörn (som delen, utom fingrarna och tummen)
        self.rings = {}          # del -> lista av ringar (listor av hörnindex); polen som [idx]
        self.seams = {}          # sömnamn -> hörnindex i slingans ordning
        self._torso()
        self._head()
        for side in "LR":
            self._arm(side)
            self._leg(side)
        self._orient()
        if self.face_level:
            self._apply_head_diagonals()

    # --- hjälpare ---
    def vert(self, key, part, t=0.0, psi=0.0, col=0, ring=0, island=None):
        if key in self.index:
            return self.index[key]
        i = len(self.key)
        self.index[key] = i
        self.key.append(key); self.vpart.append(part); self.vt.append(t); self.vpsi.append(psi)
        self.vcol.append(col); self.vring.append(ring); self.visland.append(island or part)
        return i

    def face(self, idx, part, uv, island=None):
        self.faces.append(tuple(idx)); self.fpart.append(part); self.fuv.append(tuple(uv)); self.fisland.append(island or part)

    def tube(self, part, ring0, rows, cut=0, island=None):
        """Ett rör från en befintlig slinga ring0 (K hörn) längs rows (rad 0 = ring0). cut: kolumnen där UV skärs upp.
        island: UV-ö och nyckelnamn (standard: delen)."""
        K, s = len(ring0), self.s
        isl = island or part
        rings = [list(ring0)]
        for r, row in enumerate(rows[1:], 1):
            if row == "pole":
                rings.append([self.vert((isl, r * s, 0), part, rows[r - 1][0], 90.0, 0, r, isl)])
            else:
                rings.append([self.vert((isl, r * s, j * s), part, row[0], row[1], j, r, isl) for j in range(K)])
        R = len(rings) - 1
        for r in range(R):
            a, b = rings[r], rings[r + 1]
            v0, v1 = r / R, (r + 1) / R
            for j in range(K):
                j1 = (j + 1) % K
                u0 = ((j - cut) % K) / K
                u1 = u0 + 1 / K
                if len(b) == 1:
                    self.face((a[j], a[j1], b[0]), part, ((u0, v0), (u1, v0), ((u0 + u1) / 2, v1)), isl)
                else:
                    self.face((a[j], a[j1], b[j1], b[j]), part, ((u0, v0), (u1, v0), (u1, v1), (u0, v1)), isl)
        self.rings[isl] = rings
        return rings

    # --- delarna ---
    def _torso(self):
        n, s = self.n, self.s
        K = 32 * n
        T = refine([(t, 0) for t in TORSO_T], n)
        R = len(T)
        h0, h1 = HOLE_ROWS[0] * n, HOLE_ROWS[1] * n
        holes = {"L": (HOLE_COLS_L[0] * n, HOLE_COLS_L[1] * n), "R": (HOLE_COLS_R[0] * n, HOLE_COLS_R[1] * n)}
        inside = lambda i, j: h0 < i < h1 and any(c0 < j < c1 for c0, c1 in holes.values())   # hörn inne i armhålen finns inte
        g = [[None if inside(i, j) else self.vert(("torso", i * s, j * s), "torso", T[i][0], 0.0, j, i) for j in range(K)]
             for i in range(R)]
        cut = K // 2   # UV skärs upp mitt bak
        for i in range(R - 1):
            for j in range(K):
                if h0 <= i < h1 and any(c0 <= j < c1 for c0, c1 in holes.values()):
                    continue
                j1 = (j + 1) % K
                u0 = ((j - cut) % K) / K
                self.face((g[i][j], g[i][j1], g[i + 1][j1], g[i + 1][j]), "torso",
                          ((u0, i / (R - 1)), (u0 + 1 / K, i / (R - 1)), (u0 + 1 / K, (i + 1) / (R - 1)), (u0, (i + 1) / (R - 1))))
        self.rings["torso"] = g
        # Armhålens slingor: runt cellrektangeln, nederkant -> bortre kant -> överkant -> närmre kant.
        # Ordningen speglas för höger sida, så att samma kolumn i armen ligger på samma ställe på båda armarna.
        for side, (c0, c1) in holes.items():
            loop = [g[h0][j] for j in range(c0, c1 + 1)] + [g[i][c1] for i in range(h0 + 1, h1 + 1)] \
                 + [g[h1][j] for j in range(c1 - 1, c0 - 1, -1)] + [g[i][c0] for i in range(h1 - 1, h0, -1)]
            if side == "R":   # spegelbild av vänster: index k ligger på samma ställe på båda armarna
                loop = [g[h0][j] for j in range(c1, c0 - 1, -1)] + [g[i][c0] for i in range(h0 + 1, h1 + 1)] \
                     + [g[h1][j] for j in range(c0 + 1, c1 + 1)] + [g[i][c1] for i in range(h1 - 1, h0, -1)]
            self.seams[f"shoulder_{side}"] = loop
        # Grenbryggan: 4n-1 hörn från mitt fram (kolumn 0) till mitt bak (kolumn K/2), ägs av bålen
        kb = 4 * n - 1
        bridge = [self.vert(("bridge", (m + 1) * s, 0), "torso", 0.0, 0.0, m, -1) for m in range(kb)]
        self.bridge = bridge
        front, back = g[0][0], g[0][K // 2]
        # Benöppningar: fram -> utsidan -> bak -> bryggan tillbaka (vänster); speglat för höger
        left = [g[0][j] for j in range(0, K // 2 + 1)] + bridge[::-1]
        right = [g[0][(K - j) % K] for j in range(0, K // 2 + 1)] + bridge[::-1]
        self.seams["hip_L"], self.seams["hip_R"] = left, right
        self.seams["neck"] = g[-1]

    def _head(self):
        n = self.n
        if self.face_level:
            return self._head_face()
        rows = refine(ROWS["head"], n)
        # halsringen som rad 0; huvudets kolumner följer bålens (0 fram), UV skärs upp bak
        self.tube("head", self.seams["neck"], rows, cut=16 * n)

    def head_selection(self):
        return json.load(open(HEAD_FACE))

    def _head_face(self):
        """Huvudet som urval ur nivå 6: nycklarna är nivå 6:s, och UV räknas i nivå 6:s rader och kolumner.
        Ansiktets rader har fler kolumner; där antalet ändras sys ringarna ihop med trianglar."""
        sel = self.head_selection()
        fine = refine(ROWS["head"], FINE)
        Cf, Rtop = 32 * FINE, len(fine) - 1
        base = sel.get("base") or list(range(0, Cf, FINE))
        f0, f1 = sel["face_rows"]
        cols_of = lambda r: sel["cols"] if f0 <= r <= f1 else base
        ring = {}
        for r in sel["rows"]:
            if r == 0:
                ring[r] = dict(zip(base, self.seams["neck"]))
            elif r == Rtop:
                ring[r] = {0: self.vert(("head", r, 0), "head", fine[r - 1][0], 90.0, 0, r, "head")}
            else:
                ring[r] = {c: self.vert(("head", r, c), "head", fine[r][0], fine[r][1], c // FINE, r, "head") for c in cols_of(r)}
        uv = lambda r, c: (((c - Cf // 2) % Cf) / Cf, r / Rtop)

        def uvs(*pts):
            # Sömmen mitt bak: u = 1 i stället för 0 när resten av ytan ligger till vänster om den.
            out = [uv(*p) for p in pts]
            if max(u for u, _ in out) - min(u for u, _ in out) > 0.5:
                out = [(u + 1 if u < 0.5 else u, v) for u, v in out]
            return out

        self.head_quads = {}
        for r0, r1 in zip(sel["rows"], sel["rows"][1:]):
            a, b = ring[r0], ring[r1]
            if len(b) == 1:
                ca = sorted(a)
                for c0, c1 in zip(ca, ca[1:] + ca[:1]):
                    (u0, v0), (u1, _) = uvs((r0, c0), (r0, c1))
                    self.face((a[c0], a[c1], b[0]), "head", ((u0, v0), (u1, v0), ((u0 + u1) / 2, 1.0)))
                continue
            top, low, swap = (b, a, False) if len(b) >= len(a) else (a, b, True)   # low: ringen med färre hörn
            rl, rt = (r1, r0) if swap else (r0, r1)
            cl = sorted(low)
            for c0, c1 in zip(cl, cl[1:] + cl[:1]):
                span = (c1 - c0) % Cf
                inner = [c0 + k for k in range(1, span) if (c0 + k) % Cf in top]
                if not inner:
                    r_a, r_b = (r0, r1)
                    self.head_quads[(r0, c0)] = (len(self.faces), a[c0], a[c1], b[c1], b[c0])
                    self.face((a[c0], a[c1], b[c1], b[c0]), "head", uvs((r_a, c0), (r_a, c1), (r_b, c1), (r_b, c0)))
                    continue
                # Fläkt: ett hörn mitt på den långa sidan möter båda hörnen på den korta.
                pts = [c0] + inner + [c0 + span]
                mid = pts[len(pts) // 2]
                self.face((low[c0], low[c1], top[mid % Cf]), "head", uvs((rl, c0), (rl, c1), (rt, mid % Cf)))
                for p, q in zip(pts, pts[1:]):
                    corner = c0 if q <= mid else c1
                    self.face((low[corner], top[q % Cf], top[p % Cf]), "head", uvs((rl, corner), (rt, q % Cf), (rt, p % Cf)))
        self.rings["head"] = [list(ring[r].values()) for r in sel["rows"]]
        self.head_flip = sel["flip"]

    def _apply_head_diagonals(self):
        """Väljer varje ansiktsrutas diagonal efter head_face.json; högra halvan speglar vänstra. Ytan roteras, så att
        diagonalen blir hörn 0-2 (triangles() och export.py delar rutor längs den)."""
        Cf = 32 * FINE
        for (r0, c0), (fi, a0, a1, b1, b0) in self.head_quads.items():
            cols = sorted(c for (r, c) in self.head_quads if r == r0)
            c1 = cols[(cols.index(c0) + 1) % len(cols)]
            if c0 < Cf // 2:
                flip = self.head_flip.get(f"{r0},{c0}")
                want = (a1, b0) if flip else (a0, b1)
            else:
                # spegelrutan: kolumnerna (Cf-c1, Cf-c0), med hörnen i omvänd ordning runt mittlinjen
                flip = self.head_flip.get(f"{r0},{(Cf - c1) % Cf}")
                want = (a0, b1) if flip else (a1, b0)
            if flip is None:
                continue
            f = self.faces[fi]
            if f[0] not in want:
                self.faces[fi] = f[1:] + f[:1]
                self.fuv[fi] = self.fuv[fi][1:] + self.fuv[fi][:1]

    def _arm(self, side):
        n = self.n
        ua = self.tube(f"upperarm_{side}", self.seams[f"shoulder_{side}"], refine(ROWS["upperarm"], n))
        self.seams[f"elbow_{side}"] = ua[-1]
        fa = self.tube(f"forearm_{side}", ua[-1], refine(ROWS["forearm"], n))
        self.seams[f"wrist_{side}"] = fa[-1]
        self._hand(side, fa[-1])

    def _hand(self, side, wrist):
        n, s = self.n, self.s
        part = f"hand_{side}"
        K = len(wrist)   # 16n
        rows = refine(ROWS["palm"], n)
        R = len(rows)
        h0, h1 = THUMB_ROWS[0] * n, THUMB_ROWS[1] * n
        c0, c1 = THUMB_COLS[0] * n, THUMB_COLS[1] * n
        inside = lambda i, j: h0 < i < h1 and c0 < j < c1
        g = [list(wrist)] + [[None if inside(i, j) else self.vert((part, i * s, j * s), part, rows[i][0], 0.0, j, i)
                              for j in range(K)] for i in range(1, R)]
        cut = PALM_EDGE_P * n   # UV skärs upp vid lillfingerkanten, långt från tummen
        for i in range(R - 1):
            for j in range(K):
                if h0 <= i < h1 and c0 <= j < c1:
                    continue
                j1 = (j + 1) % K
                u0 = ((j - cut) % K) / K
                self.face((g[i][j], g[i][j1], g[i + 1][j1], g[i + 1][j]), part,
                          ((u0, i / (R - 1)), (u0 + 1 / K, i / (R - 1)), (u0 + 1 / K, (i + 1) / (R - 1)), (u0, (i + 1) / (R - 1))))
        self.rings[part] = g
        col = lambda j: j % K
        thumb = [g[h0][col(j)] for j in range(c0, c1 + 1)] + [g[i][col(c1)] for i in range(h0 + 1, h1 + 1)] \
              + [g[h1][col(j)] for j in range(c1 - 1, c0 - 1, -1)] + [g[i][c0] for i in range(h1 - 1, h0, -1)]
        self.seams[f"thumb_{side}"] = thumb
        # Knogslingan: handryggen B och handflatan P, båda från framkanten till lillfingerkanten
        ef = PALM_EDGE_F * n
        B = [g[-1][(ef - k) % K] for k in range(8 * n + 1)]
        P = [g[-1][(ef + k) % K] for k in range(8 * n + 1)]
        webs = {i: [self.vert((f"web{i}_{side}", (m + 1) * s, 0), part, 1.0, 0.0, m, -1) for m in range(2 * n - 1)]
                for i in (1, 2, 3)}
        self.webs = getattr(self, "webs", {})
        for i, w in webs.items():
            self.webs[(side, i)] = (B[2 * n * i], w, P[2 * n * i])
        for i in range(4):
            a, b = 2 * n * i, 2 * n * (i + 1)
            loop = B[a:b + 1]
            if i < 3:
                loop += webs[i + 1] + P[a:b + 1][::-1]
            else:
                loop += P[a:b][::-1]
            if i > 0:
                loop += webs[i][::-1]
            else:
                loop = loop[:-1]   # pekfingret: P[0] är samma hörn som B[0]
            self.seams[f"finger{i}_{side}"] = loop
            self.tube(part, loop, refine(ROWS["finger"], n), island=f"finger{i}_{side}")
        self.tube(part, thumb, refine(ROWS["thumb"], n), island=f"thumb_{side}")

    def _leg(self, side):
        n = self.n
        lg = self.tube(f"leg_{side}", self.seams[f"hip_{side}"], refine(ROWS["leg"], n))
        self.seams[f"ankle_{side}"] = lg[-1]
        self.tube(f"foot_{side}", lg[-1], refine(ROWS["foot"], n))

    def _orient(self):
        """Gör ytornas varvordning konsekvent (varje kant åt var sitt håll i sina två ytor), med bredden först
        från yta 0. Om hela nätet blir inåtvänt vänds allt i passningen, där geometrin finns."""
        from collections import defaultdict, deque
        owner = defaultdict(list)
        for fi, f in enumerate(self.faces):
            for a, b in zip(f, f[1:] + f[:1]):
                owner[(min(a, b), max(a, b))].append(fi)
        done = [False] * len(self.faces)
        for start in range(len(self.faces)):
            if done[start]:
                continue
            done[start] = True
            q = deque([start])
            while q:
                fi = q.popleft()
                f = self.faces[fi]
                for a, b in zip(f, f[1:] + f[:1]):
                    for gi in owner[(min(a, b), max(a, b))]:
                        if gi == fi or done[gi]:
                            continue
                        g = self.faces[gi]
                        if any((x, y) == (a, b) for x, y in zip(g, g[1:] + g[:1])):   # samma riktning: vänd
                            self.faces[gi] = g[::-1]
                            self.fuv[gi] = self.fuv[gi][::-1]
                        done[gi] = True
                        q.append(gi)

    # --- utdata ---
    def arrays(self):
        return dict(key=self.key, part=np.array(self.vpart), t=np.array(self.vt), psi=np.array(self.vpsi),
                    col=np.array(self.vcol), ring=np.array(self.vring), island=np.array(self.visland))

    def triangles(self):
        tris, tpart = [], []
        for f, p in zip(self.faces, self.fpart):
            if len(f) == 3:
                tris.append(f); tpart.append(p)
            else:
                tris += [(f[0], f[1], f[2]), (f[0], f[2], f[3])]; tpart += [p, p]
        return np.array(tris), np.array(tpart)

    def stats(self):
        q = sum(len(f) == 4 for f in self.faces)
        return {"level": self.n, "verts": len(self.key), "quads": q, "tris": len(self.faces) - q,
                "triangles": 2 * q + (len(self.faces) - q),
                "seams": {k: len(v) for k, v in self.seams.items()}}


def check(t):
    """Sömkontrollen: varje söm delas av exakt två delar, kanterna är manifold och nätet är slutet."""
    from collections import Counter
    edges = Counter()
    for f in t.faces:
        for a, b in zip(f, f[1:] + f[:1]):
            edges[(min(a, b), max(a, b))] += 1
    bad = {e: c for e, c in edges.items() if c != 2}
    V, E, F = len(t.key), len(edges), len(t.faces)
    return {"open_or_nonmanifold_edges": len(bad), "euler": V - E + F}


if __name__ == "__main__":
    import json
    for lv in LEVELS:
        t = Template(lv)
        print(json.dumps({**t.stats(), **check(t)}))
    # inbäddningen: alla nycklar på nivå 1, 2 och 3 finns på nivå 6
    fine = set(Template(6).key)
    print("nested:", all(set(Template(lv).key) <= fine for lv in (1, 2, 3)))
    if HEAD_FACE.exists():
        t = Template(FACE_LEVEL)
        print(json.dumps({**t.stats(), **check(t), "nested": set(t.key) <= fine}))
