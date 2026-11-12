#!/usr/bin/env python3
"""Low-poly base woman with animation-friendly quad topology, built from code.

Recipe as JSON in, one line of JSON out:

  uv run -q --no-project --python 3.12 --with numpy --with pillow python -I tools/character/lowpoly/make_lowpoly.py \
      '{"name": "lowpoly_woman", "sheet": true}'

Recipe: name, height (m, default 1.68), arm_down (degrees below horizontal, default 40 = A-pose, 0 = T-pose),
sheet (also draw a contact sheet with the quad wire).

Every attempt gets new files (nothing is overwritten):
  assets/characters/<name>/<name>_v<n>.glb         smooth shaded, one primitive per material
  assets/characters/<name>/<name>_v<n>_wire.glb    the same plus the quad edges as lines (the real topology, not triangles)
  assets/characters/<name>/<name>_v<n>.obj + .mtl  quads kept, for Blender
  build/lowpoly/<name>/sheet_v<n>.png              with "sheet": true

Topology (one half is built, x >= 0 = her left, then mirrored; +Y up, +Z front):
  torso   20 columns, rows tilted along the leg line at the hips, shoulders as panels joined by a strip
  legs    12 around; the first loop is the leg opening (inguinal crease, hip, gluteal fold), three loops at the knee
  arms    10 around; the first loop is the arm hole, three loops at the elbow
  hands   palm loop of 10, four fingers and a thumb with square sections that share the web edges
  head    concentric loops round the mouth (lip line, lip border, mouth, nasolabial, cheek, jaw line), concentric loops
          round each eye inside a 2x2 block, nose from the loops' crossings, horizontal rows from brow to jaw going round
          the back, ear as an extruded 6-loop, a 4x6 grid cap on the skull
All faces are quads; the checks count open or non-manifold edges and list the poles.
"""
import json
import math
import struct
import sys
from collections import Counter, deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
COLORS = {"skin": (0.80, 0.62, 0.52), "underwear": (0.24, 0.27, 0.34), "lips": (0.72, 0.42, 0.42), "eye": (0.93, 0.93, 0.92),
          "mouth": (0.25, 0.10, 0.10)}


class Mesh:
    def __init__(self):
        self.v, self.q, self.m = [], [], []

    def vert(self, x, y, z):
        self.v.append((float(x), float(y), float(z)))
        return len(self.v) - 1

    def verts(self, pts):
        return [self.vert(*p) for p in pts]

    def quad(self, a, b, c, d, mat="skin"):
        self.q.append((a, b, c, d))
        self.m.append(mat)

    def band(self, r0, r1, closed=False, mat="skin", skip=(), mats=None):
        """Quads between two rows of the same length (winding is fixed afterwards by orient())."""
        n = len(r0)
        assert len(r1) == n, (len(r0), len(r1))
        for i in range(n if closed else n - 1):
            if i in skip:
                continue
            j = (i + 1) % n
            self.quad(r0[i], r0[j], r1[j], r1[i], (mats or {}).get(i, mat))


def spow(v, p):
    return math.copysign(abs(v) ** p, v)


def outline(W, Zf, Zb, ef, eb, deg, zc=0.0):
    """Point on a superellipse outline seen from above: 0 deg = front centre, 90 = side, 180 = back centre."""
    t = math.radians(deg)
    s, c = math.sin(t), math.cos(t)
    if abs(s) < 1e-9:
        s = 0.0
    e = ef if c >= 0 else eb
    return W * abs(s) ** (2 / e), zc + (Zf if c >= 0 else Zb) * spow(c, 2 / e)


def unit(v):
    return v / np.linalg.norm(v)


# --------------------------------------------------------------------------- head surface
HEAD_T = [  # y, half width, front depth, back depth, front exponent (lower = more V-shaped, the jaw)
    (1.456, .034, .0780, .060, 1.7), (1.480, .054, .0865, .076, 1.9), (1.515, .065, .0910, .087, 2.2),
    (1.548, .072, .0910, .095, 2.4), (1.568, .0735, .0905, .098, 2.4), (1.588, .074, .0960, .099, 2.4)]
SKULL = (1.585, .095, .074, .096, .099, 2.35)   # centre y, height above it, half width, front, back, squareness


def head_dims(y):
    if y >= HEAD_T[-1][0]:
        yc, b, a, cf, cb, p = SKULL
        f = (1 - min((y - yc) / b, 1.0) ** p) ** (1 / p)
        return a * f, cf * f, cb * f, 2.4
    y = max(y, HEAD_T[0][0])
    for (y0, *a), (y1, *b) in zip(HEAD_T, HEAD_T[1:]):
        if y <= y1:
            t = (y - y0) / (y1 - y0)
            return tuple(p + (q - p) * t for p, q in zip(a, b))


def zface(x, y):
    W, Zf, _, e = head_dims(y)
    r = min(abs(x) / W, 0.999)
    return Zf * (1 - r ** e) ** (1 / e)


def hpt(y, deg):
    W, Zf, Zb, e = head_dims(y)
    x, z = outline(W, Zf, Zb, e, 2.2, deg)
    return x, y, z


def skull_y(x, z):
    yc, b, a, cf, cb, p = SKULL
    r = min(math.hypot(x / a, z / (cf if z >= 0 else cb)), 0.999)
    return yc + b * (1 - r ** p) ** (1 / p)


# --------------------------------------------------------------------------- body tables
ZC = -0.008   # the torso's centre is a little behind the head's
T_ANG = [0, 16, 34, 53, 72, 90, 108, 127, 146, 164, 180]
# The leg line: pubic bone, inguinal crease, hip, under the buttock, between the buttocks
T0 = [(0, .838, .078), (.030, .828, .078), (.086, .868, .086), (.134, .905, .066), (.165, .928, .030), (.176, .935, -.012),
      (.166, .915, -.058), (.132, .868, -.098), (.086, .822, -.108), (.030, .800, -.085), (0, .806, -.075)]
ROWS = [  # y front, y side, y back, half width, front depth, back depth, exponent
    (.895, .972, .885, .176, .088, .118, 2.4),    # 1 hips and buttocks (still tilted)
    (.962, 1.000, .965, .164, .090, .100, 2.3),   # 2 top of the briefs
    (1.058, 1.058, 1.058, .123, .084, .078, 2.2),  # 3 waist
    (1.112, 1.112, 1.112, .128, .086, .084, 2.2),  # 4 lower ribs
    (1.158, 1.158, 1.158, .135, .087, .090, 2.2),  # 5 under the bust
    (1.186, 1.186, 1.186, .140, .088, .093, 2.2),  # 6
    (1.215, 1.215, 1.215, .145, .088, .095, 2.2),  # 7 bust
    (1.245, 1.245, 1.245, .150, .087, .097, 2.2),  # 8
    (1.275, 1.275, 1.275, .153, .084, .097, 2.2)]  # 9 armpit
CROTCH_C = [(0, .800, .050), (0, .784, 0), (0, .788, -.045)]
CROTCH_E = [(.030, .797, .050), (.033, .780, 0), (.030, .785, -.045)]
P1F = [(0, 1.325, .078), (.045, 1.328, .076), (.088, 1.332, .066), (.125, 1.335, .050), (.152, 1.335, .026)]
P2F = [(0, 1.372, .052), (.030, 1.385, .047), (.058, 1.402, .028), (.108, 1.398, .020), (.158, 1.386, .012)]
P1B = [(.152, 1.335, -.058), (.125, 1.338, -.088), (.088, 1.340, -.100), (.045, 1.342, -.104), (0, 1.343, -.102)]   # columns 6..10
P2B = [(.158, 1.386, -.038), (.108, 1.402, -.062), (.058, 1.418, -.070), (.030, 1.424, -.078), (0, 1.426, -.080)]
STRIP_IN = [(.064, 1.424, .010), (.068, 1.436, -.014), (.066, 1.434, -.044)]    # neck side
STRIP_MID = [(.110, 1.410, .004), (.112, 1.414, -.016), (.110, 1.411, -.042)]
STRIP_OUT = [(.162, 1.392, .000), (.165, 1.394, -.013), (.162, 1.392, -.027)]   # top of the arm hole
NECK_ANG = [0, 26, 53, 72, 92, 116, 135, 157, 180]
HB = [(0, 1.446, .036), (.021, 1.448, .034), (.040, 1.454, .020), (.049, 1.459, .003), (.052, 1.464, -.015),
      (.049, 1.468, -.035), (.038, 1.470, -.052), (.020, 1.470, -.062), (0, 1.470, -.066)]   # where the neck meets the head
LEG = [  # y, centre x, centre z, half width, half depth
    (.760, .095, -.005, .083, .084), (.660, .092, .000, .072, .078), (.560, .085, .000, .060, .066),
    (.505, .080, .002, .052, .057), (.470, .078, .004, .050, .055), (.435, .077, .000, .047, .052),
    (.360, .078, -.012, .050, .056), (.260, .078, -.012, .042, .046), (.150, .078, -.012, .031, .035),
    (.095, .078, -.012, .027, .031), (.065, .078, -.010, .031, .037)]
FOOT = [  # rings as (dx, y, dz) from the ankle centre; k = 0 outer side, 3 front/top, 6 inner side, 9 back/sole
    [(.038, .030, .012), (.034, .048, .034), (.019, .062, .050), (0, .068, .056), (-.019, .064, .050), (-.032, .050, .034),
     (-.035, .030, .012), (-.033, .006, -.012), (-.024, 0, -.042), (0, .010, -.060), (.024, 0, -.042), (.035, .006, -.012)],
    [(.042, .022, .072), (.036, .040, .076), (.020, .052, .080), (0, .056, .082), (-.018, .054, .080), (-.032, .044, .076),
     (-.036, .024, .072), (-.034, .006, .068), (-.018, 0, .066), (0, 0, .066), (.020, 0, .066), (.040, .003, .068)],
    [(.048, .016, .128), (.040, .030, .134), (.022, .036, .138), (0, .038, .140), (-.020, .038, .140), (-.036, .032, .138),
     (-.042, .017, .134), (-.038, .002, .132), (-.020, 0, .132), (0, 0, .132), (.022, 0, .130), (.044, .002, .128)],
    [(.046, .012, .156), (.038, .021, .164), (.020, .024, .170), (0, .025, .174), (-.020, .026, .178), (-.035, .024, .178),
     (-.040, .013, .176), (-.036, .002, .174), (-.019, 0, .172), (0, 0, .168), (.021, 0, .162), (.042, .002, .154)]]
TOES = [(-.022, .012, .190), (0, .012, .186), (.022, .012, .176)]
ARM = [  # distance from the shoulder joint, radius up/down, radius front/back, forward offset
    (.055, .047, .050, .000), (.115, .041, .045, .000), (.190, .038, .041, .002), (.255, .034, .036, .004),
    (.290, .034, .035, .005), (.325, .036, .037, .007), (.395, .033, .034, .010), (.465, .027, .029, .012),
    (.520, .020, .026, .013)]
FINGERS = [([.030, .021, .019], .05), ([.033, .024, .020], 0.0), ([.031, .022, .019], -.04), ([.024, .016, .017], -.10)]


def bust(x, y):
    dy = y - 1.213
    sy = 0.045 if dy > 0 else 0.028   # a gentle slope above, a fuller lower half
    return 0.050 * math.exp(-((x - 0.080) ** 2 / (2 * 0.034 ** 2) + dy * dy / (2 * sy * sy)))


def butt(x, y):
    dz = -0.018 * math.exp(-((x - 0.078) ** 2 / (2 * 0.05 ** 2) + (y - 0.875) ** 2 / (2 * 0.055 ** 2)))
    if y < 0.93:
        dz += 0.020 * math.exp(-(x / 0.022) ** 2)   # the cleft
    return dz


# --------------------------------------------------------------------------- build
def build(R):
    M = Mesh()
    U = "underwear"

    # ---- torso: half rings, column 0 = front centre, 5 = side, 10 = back centre
    T = [M.verts(T0)]
    for yf, ys, yb, W, Zf, Zb, e in ROWS:
        ring = []
        for j, a in enumerate(T_ANG):
            x, z = outline(W, Zf, Zb, e, e, a, ZC)
            c = math.cos(math.radians(a))
            y = ys + (yf - ys) * max(c, 0) ** 2 + (yb - ys) * max(-c, 0) ** 2
            z += bust(x, y) if j < 5 else (butt(x, y) if j > 5 else 0.0)
            ring.append(M.vert(x, y, z))
        T.append(ring)
    for i in range(9):
        M.band(T[i], T[i + 1], mat=U if (i < 2 or 5 <= i < 9) else "skin")   # briefs up to row 2, bra from row 5 to 9

    # ---- crotch: a strip two quads wide from front to back (one per half)
    cc, ce = M.verts(CROTCH_C), M.verts(CROTCH_E)
    strip = [(T[0][0], T[0][1])] + list(zip(cc, ce)) + [(T[0][10], T[0][9])]
    for a, b in zip(strip, strip[1:]):
        M.quad(a[0], a[1], b[1], b[0], U)

    # ---- leg: the first loop is the leg opening
    L0 = [T[0][5], T[0][4], T[0][3], T[0][2], T[0][1], ce[0], ce[1], ce[2], T[0][9], T[0][8], T[0][7], T[0][6]]
    rings = []
    for y, cx, cz, rx, rz in LEG:
        ring = []
        for k in range(12):
            a = math.radians(30 * k)
            z = cz + rz * math.sin(a)
            if abs(y - .470) < 1e-6 and k == 3:
                z += .006   # kneecap
            ring.append(M.vert(cx + rx * math.cos(a), y, z))
        rings.append(ring)
    half = []   # a loop halfway down the hip wedge, so the outer hip gets a loop at the trochanter
    for k in range(12):
        p = (np.array(M.v[L0[k]]) + np.array(M.v[rings[0][k]])) / 2
        if k in (0, 1, 11):
            p[0] += .004
        half.append(M.vert(*p))
    chain = [L0, half] + rings
    for a, b in zip(chain, chain[1:]):
        M.band(a, b, closed=True)
    cx, cz = LEG[-1][1], LEG[-1][2]
    prev = rings[-1]
    for ring in FOOT:   # a sock: the tube turns forward at the ankle, the heel is the outside of the bend
        cur = [M.vert(cx + dx, y, cz + dz * .96) for dx, y, dz in ring]
        M.band(prev, cur, closed=True)
        prev = cur
    m = [M.vert(cx + dx, y, cz + dz * .96) for dx, y, dz in TOES]
    k = prev   # toe cap: a 4x2 grid
    top, bot = [k[6], m[0], m[1], m[2], k[0]], None
    M.band([k[5], k[4], k[3], k[2], k[1]], top)
    M.band(top, [k[7], k[8], k[9], k[10], k[11]])

    # ---- shoulders: front and back panels above the armpit row, joined over the shoulder by a strip
    p1f, p2f, p1b, p2b = M.verts(P1F), M.verts(P2F), M.verts(P1B), M.verts(P2B)
    M.band(T[9][0:5], p1f, mats={2: U})
    M.band(p1f, p2f, mats={2: U})
    M.band(T[9][6:11], p1b, mats={1: U})
    M.band(p1b, p2b, mats={1: U})
    s_in, s_mid, s_out = M.verts(STRIP_IN), M.verts(STRIP_MID), M.verts(STRIP_OUT)
    srows = [[p2f[2], p2f[3], p2f[4]]] + [[s_in[i], s_mid[i], s_out[i]] for i in range(3)] + [[p2b[2], p2b[1], p2b[0]]]
    for a, b in zip(srows, srows[1:]):
        M.band(a, b, mats={0: U})   # the bra strap runs along the inner half

    # ---- neck
    neck = [p2f[0], p2f[1], p2f[2], s_in[0], s_in[1], s_in[2], p2b[2], p2b[3], p2b[4]]
    nk = []
    for a in NECK_ANG:
        x, z = outline(.052, .047, .050, 2.0, 2.0, a, -.011)
        c = math.cos(math.radians(a))
        nk.append(M.vert(x, 1.452 + (1.410 - 1.452) * max(c, 0) ** 1.5 - .002 * max(-c, 0), z))
    hb = M.verts(HB)
    M.band(neck, nk)
    M.band(nk, hb)

    # ---- arm: the first loop is the arm hole (armpit, back, top of the shoulder, front)
    al = math.radians(R.get("arm_down", 40))
    d = np.array([math.cos(al), -math.sin(al), 0.0])
    f = np.array([0.0, 0.0, 1.0])
    u = np.array([math.sin(al), math.cos(al), 0.0])   # the back of the hand's side
    J = np.array([.168, 1.362, -.012])
    prev = [T[9][5], T[9][6], p1b[0], p2b[0], s_out[2], s_out[1], s_out[0], p2f[4], p1f[4], T[9][4]]
    for s, ru, rf, zo in ARM:
        c = J + d * s + f * zo
        cur = [M.vert(*(c - u * ru * math.cos(math.radians(36 * k)) - f * rf * math.sin(math.radians(36 * k)))) for k in range(10)]
        M.band(prev, cur, closed=True)
        prev = cur

    # ---- hand: palm loop = 5 knuckle points on top (k 7..3) and 5 below (k 8, 9, 0, 1, 2); index side = +f
    def palm(s, w, th, zo):
        ring = [None] * 10
        for i in range(5):
            c = J + d * (s[i] if isinstance(s, list) else s) + f * (zo + w * (1 - i / 2))
            ring[7 - i] = M.vert(*(c + u * th))
            ring[(8 + i) % 10] = M.vert(*(c - u * th))
        return ring
    h1, h2 = palm(.548, .034, .0130, .014), palm(.588, .040, .0125, .015)
    h3 = palm([.616, .626, .628, .620, .604], .039, .0105, .015)
    M.band(prev, h1, closed=True)
    M.band(h1, h2, closed=True, skip=(7,))   # the thumb grows out of the side quad on the index side
    M.band(h2, h3, closed=True)
    for i, (lens, splay) in enumerate(FINGERS):   # neighbouring fingers share the web edge
        base = [h3[7 - i], h3[6 - i], h3[(9 + i) % 10], h3[(8 + i) % 10]]
        c = sum(np.array(M.v[b]) for b in base) / 4
        dv = unit(d + f * splay - u * .06)
        side = unit(f - dv * (f @ dv))
        up = np.cross(side, dv)
        ring, L = base, 0.0
        for n, ln in enumerate(lens):
            L += ln
            t = 1 - .08 * (n + 1)
            p = c + dv * L - u * .004 * (n + 1) ** 1.5   # a slight natural curl
            cur = [M.vert(*(p + side * sx * .0078 * t + up * sy * .0072 * t)) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
            M.band(ring, cur, closed=True)
            ring = cur
        M.quad(*ring)
    base = [h1[7], h2[7], h2[8], h1[8]]
    c = sum(np.array(M.v[b]) for b in base) / 4
    tv = unit(.72 * d + .62 * f - .25 * u)
    n = unit(u - tv * (u @ tv))
    e1 = unit(d - tv * (d @ tv))
    ring = base
    for L, r in ((.026, .0110), (.050, .0098), (.070, .0086)):
        p = c + tv * L
        cur = [M.vert(*(p + e1 * sx * r + n * sy * r)) for sx, sy in ((-1, 1), (1, 1), (1, -1), (-1, -1))]
        M.band(ring, cur, closed=True)
        ring = cur
    M.quad(*ring)

    # ---- head: face verts as (x, y, relief on top of the head surface) or with an absolute z on the centre line
    def fv(x, y, dz=0.0, z=None):
        return M.vert(x, y, z if z is not None else zface(x, y) + dz)
    c0, c1, c2, c3 = fv(0, 1.590, z=.0965), fv(.0165, 1.5885), fv(.0345, 1.5915), fv(.0535, 1.5875, -.002)   # brow
    b0, b1, b3, b4 = fv(0, 1.570, z=.089), fv(.0105, 1.5685, -.006), fv(.058, 1.5675, -.002), fv(.067, 1.568)       # eye level
    # Loops round the mouth, each from the centre line above (index 0) round the corner (4) to the centre line below (8)
    A = [fv(0, 1.556, z=.094), fv(.015, 1.5545, -.003), fv(.0335, 1.5525, -.003), fv(.053, 1.5535), fv(.0635, 1.546, .001),
         fv(.059, 1.513, .003), M.vert(.044, 1.473, .040), M.vert(.027, 1.458, .068), M.vert(0, 1.456, .078)]   # under the eye, cheekbone, jaw line, chin
    L4 = [fv(0, 1.543, z=.103), fv(.0080, 1.5425, .006), fv(.0165, 1.5395, -.001), fv(.0335, 1.535, .004), fv(.0475, 1.522, .006),
          fv(.045, 1.492, .006), fv(.036, 1.470, .004), fv(.018, 1.461, .008), fv(0, 1.461, z=.090)]      # bridge, cheek, chin
    L3 = [fv(0, 1.529, z=.1175), fv(.0085, 1.530, .019), fv(.0158, 1.527, .011), fv(.026, 1.518, .003), fv(.0345, 1.5015, .005),
          fv(.031, 1.488, .005), fv(.024, 1.476, .007), fv(.012, 1.471, .011), fv(0, 1.471, z=.0955)]     # nose tip, wing, nasolabial fold
    M2 = [fv(0, 1.5215, z=.103), fv(.0060, 1.5225, .008), fv(.0145, 1.5215, .004), fv(.0255, 1.5115, .003), fv(.030, 1.5005, .003),
          fv(.027, 1.4915, .002), fv(.019, 1.485, .003), fv(.0105, 1.483, .005), fv(0, 1.483, z=.0915)]   # under the nose, round the mouth
    M1 = [fv(0, 1.5065, z=.1035), fv(.0085, 1.508, .0118), fv(.0165, 1.5062, .009), fv(.0235, 1.5035, .006), fv(.0265, 1.500, .003),
          fv(.0235, 1.4945, .004), fv(.0165, 1.4915, .006), fv(.0095, 1.4905, .009), fv(0, 1.4905, z=.0985)]   # lip border
    M0 = [fv(0, 1.5005, z=.1015), fv(.009, 1.5007, .0098), fv(.0165, 1.5004, .007), fv(.0225, 1.5001, .0045), fv(.0245, 1.500, .002),
          fv(.0225, 1.4999, .0042), fv(.0165, 1.4996, .0065), fv(.009, 1.4993, .0092), fv(0, 1.4995, z=.1010)]  # lip line
    for a, b, mat in ((M0, M1, "lips"), (M1, M2, "skin"), (M2, L3, "skin"), (L3, L4, "skin"), (L4, A, "skin")):
        M.band(a, b, mat=mat)
    inner = M.verts([(0, 1.500, .093), (.0085, 1.500, .091), (.016, 1.500, .0865)]) + [M0[4]]   # a recessed 6x2 grid closes the mouth
    M.band(M0[0:4], inner, mat="mouth")
    M.band(inner, [M0[8], M0[7], M0[6], M0[5]], mat="mouth")
    M.quad(A[0], A[1], b1, b0)   # root of the nose
    M.quad(b0, b1, c1, c0)
    # Eye: three loops of 8 inside the 2x2 block (inner corner, then clockwise over the top)
    E2 = [b1, c1, c2, c3, b3, A[3], A[2], A[1]]
    E1 = [fv(.015, 1.5672, -.008), fv(.0205, 1.5775, -.006), fv(.032, 1.5805, -.004), fv(.0435, 1.5775, -.004),
          fv(.050, 1.5688, -.005), fv(.0435, 1.5595, -.004), fv(.032, 1.557, -.004), fv(.021, 1.559, -.006)]
    E0 = [fv(.0175, 1.5665, -.008), fv(.0235, 1.5725, -.005), fv(.0315, 1.5745, -.003), fv(.0395, 1.5725, -.004),
          fv(.0455, 1.569, -.006), fv(.0395, 1.5635, -.005), fv(.0315, 1.562, -.0045), fv(.0235, 1.5635, -.006)]
    M.band(E2, E1, closed=True)
    M.band(E1, E0, closed=True)
    ctr = fv(.0315, 1.5682, -.001)
    for i in (0, 2, 4, 6):
        M.quad(ctr, E0[i], E0[i + 1], E0[(i + 2) % 8], "eye")
    # Rows going round the side and the back (index 4 .. 10; 6 and 7 hold the ear)
    lat = [74, 90, 101, 128, 155, 180]
    D0 = [c0, c1, c2, c3] + M.verts([hpt(1.588, a) for a in [61] + lat])
    Bl = [b3, b4] + M.verts([hpt(1.568, a) for a in [75] + lat[1:]])
    P = [A[3], A[4]] + M.verts([hpt(1.548, a) for a in [72, 89] + lat[2:]])
    Q = [A[5]] + M.verts([hpt(y, a) for y, a in zip([1.516, 1.517, 1.518, 1.519, 1.519, 1.519], [70, 88] + lat[2:])])
    JLl = [A[6]] + M.verts([hpt(y, a) for y, a in zip([1.483, 1.492, 1.496, 1.492, 1.487, 1.486], [80, 94, 110, 132, 157, 180])])
    M.band(D0[3:], Bl)
    M.band(Bl, P, skip=(3,))
    M.band(P[1:], Q, skip=(2,))
    M.band(Q, JLl)
    M.band([A[8], A[7]] + JLl, hb)   # under the jaw
    # Ear: the hole's loop of 6 is pulled out to the rim, turned in to the bowl and closed
    ebase = [Bl[3], Bl[4], P[4], Q[3], Q[2], P[3]]
    off = [(.004, .014, -.002), (.013, .016, -.008), (.016, .002, -.014), (.009, -.004, -.006), (.003, -.007, -.002), (.003, 0, .001)]
    rim = [M.vert(*(np.array(M.v[b]) + np.array(o))) for b, o in zip(ebase, off)]
    cen = sum(np.array(M.v[r]) for r in rim) / 6
    bowl = [M.vert(*(np.array(M.v[r]) + (cen - np.array(M.v[r])) * .4 - np.array([.004, 0, 0]))) for r in rim]
    M.band(ebase, rim, closed=True)
    M.band(rim, bowl, closed=True)
    M.quad(bowl[0], bowl[1], bowl[4], bowl[5])
    M.quad(bowl[1], bowl[2], bowl[3], bowl[4])
    # Skull: two more rows and a 4x6 grid cap (no pole at the crown)
    D1 = M.verts([hpt(1.628, a) for a in [0, 15, 32, 49, 65, 78, 89, 105, 127, 154, 180]])
    D2 = M.verts([hpt(1.660, a) for a in [0, 20, 40, 57, 73, 90, 107, 123, 140, 160, 180]])
    M.band(D0, D1)
    M.band(D1, D2)
    z0, z1 = M.v[D2[0]][2], M.v[D2[10]][2]
    cap = [[D2[0], D2[1], D2[2]]]
    for j in range(1, 6):
        sx, _, sz = M.v[D2[2 + j]]
        zc = z0 + (z1 - z0) * j / 6
        row = [M.vert(sx * i / 2, skull_y(sx * i / 2, zc + (sz - zc) * i / 2), zc + (sz - zc) * i / 2) for i in (0, 1)]
        cap.append(row + [D2[2 + j]])
    cap.append([D2[10], D2[9], D2[8]])
    for a, b in zip(cap, cap[1:]):
        M.band(a, b)
    return M


def mirror(M):
    mp = {}
    for i, (x, y, z) in enumerate(list(M.v)):
        if abs(x) < 1e-7:
            M.v[i] = (0.0, y, z)
            mp[i] = i
        else:
            mp[i] = M.vert(-x, y, z)
    for (a, b, c, d), m in list(zip(M.q, M.m)):
        M.quad(mp[d], mp[c], mp[b], mp[a], m)


def orient(M):
    """Makes the winding consistent (flood fill over shared edges) and outward (positive volume). Returns the checks."""
    edges = {}
    for fi, q in enumerate(M.q):
        for k in range(4):
            a, b = q[k], q[(k + 1) % 4]
            edges.setdefault((min(a, b), max(a, b)), []).append((fi, a < b))
    bad = [e for e, l in edges.items() if len(l) != 2]
    adj = [[] for _ in M.q]
    for l in edges.values():
        if len(l) == 2:
            (f1, d1), (f2, d2) = l
            adj[f1].append((f2, d1 == d2))
            adj[f2].append((f1, d1 == d2))
    flip, comps = [None] * len(M.q), 0
    for s in range(len(M.q)):
        if flip[s] is not None:
            continue
        comps += 1
        flip[s] = False
        dq = deque([s])
        while dq:
            i = dq.popleft()
            for j, same in adj[i]:
                if flip[j] is None:
                    flip[j] = flip[i] ^ same
                    dq.append(j)
    M.q = [tuple(reversed(q)) if fl else q for q, fl in zip(M.q, flip)]
    V = np.array(M.v)
    vol = sum(np.dot(V[a], np.cross(V[b], V[c])) + np.dot(V[a], np.cross(V[c], V[d])) for a, b, c, d in M.q) / 6
    if vol < 0:
        M.q = [tuple(reversed(q)) for q in M.q]
    val = Counter()
    for a, b in edges:
        val[a] += 1
        val[b] += 1
    hist = Counter(val.values())
    degenerate = sum(1 for q in M.q if len(set(q)) < 4)
    return {"verts": len(M.v), "quads": len(M.q), "tris": 2 * len(M.q), "edges": len(edges), "open_or_nonmanifold_edges": len(bad),
            "components": comps, "euler": len(M.v) - len(edges) + len(M.q), "degenerate": degenerate,
            "valence": {str(k): hist[k] for k in sorted(hist)}, "volume_l": round(abs(float(vol)) * 1000, 1),
            "bad_edges": [[[round(c, 3) for c in M.v[a]], [round(c, 3) for c in M.v[b]]] for a, b in bad[:4]]}, edges


def normals(V, quads):
    N = np.zeros_like(V)
    for a, b, c, d in quads:
        n = np.cross(V[c] - V[a], V[d] - V[b])
        for i in (a, b, c, d):
            N[i] += n
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def tris_of(V, q):
    a, b, c, d = q   # split along the shorter diagonal
    if np.linalg.norm(V[a] - V[c]) <= np.linalg.norm(V[b] - V[d]):
        return [(a, b, c), (a, c, d)]
    return [(a, b, d), (b, c, d)]


def write_glb(path, V, N, quads, mats, edges=None):
    blob, views, accs = bytearray(), [], []

    def add(arr, target, ctype, typ, minmax=False):
        raw = arr.tobytes()
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(raw), "target": target})
        blob.extend(raw)
        blob.extend(b"\0" * (-len(blob) % 4))
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]) if arr.ndim > 1 else int(arr.size), "type": typ}
        if minmax:
            acc["min"], acc["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        accs.append(acc)
        return len(accs) - 1
    pos, nor = add(V.astype(np.float32), 34962, 5126, "VEC3", True), add(N.astype(np.float32), 34962, 5126, "VEC3")
    names = [m for m in COLORS if m in set(mats)]
    materials = [{"name": m, "pbrMetallicRoughness": {"baseColorFactor": [*COLORS[m], 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.75}} for m in names]
    prims = []
    for mi, m in enumerate(names):
        idx = np.array([t for q, qm in zip(quads, mats) if qm == m for t in tris_of(V, q)], dtype=np.uint32).reshape(-1)
        prims.append({"attributes": {"POSITION": pos, "NORMAL": nor}, "indices": add(idx, 34963, 5125, "SCALAR"), "material": mi})
    meshes, nodes = [{"name": "body", "primitives": prims}], [{"name": "body", "mesh": 0}]
    if edges is not None:   # the quad edges as lines, lifted a little off the surface
        wpos = add((V + N * 0.0004).astype(np.float32), 34962, 5126, "VEC3", True)
        widx = add(np.array(sorted(edges), dtype=np.uint32).reshape(-1), 34963, 5125, "SCALAR")
        materials.append({"name": "wire", "pbrMetallicRoughness": {"baseColorFactor": [0.03, 0.03, 0.05, 1.0], "metallicFactor": 0.0, "roughnessFactor": 1.0},
                          "extensions": {"KHR_materials_unlit": {}}})
        meshes.append({"name": "quad_wire", "primitives": [{"attributes": {"POSITION": wpos}, "indices": widx, "material": len(materials) - 1, "mode": 1}]})
        nodes.append({"name": "quad_wire", "mesh": 1})
    gltf = {"asset": {"version": "2.0", "generator": "asset-studio make_lowpoly.py"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
            "nodes": nodes, "meshes": meshes, "materials": materials, "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accs}
    if edges is not None:
        gltf["extensionsUsed"] = ["KHR_materials_unlit"]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


def write_obj(path, V, quads, mats):
    mtl = path.with_suffix(".mtl")
    mtl.write_text("".join(f"newmtl {m}\nKd {c[0]} {c[1]} {c[2]}\n" for m, c in COLORS.items()))
    out = [f"mtllib {mtl.name}", "o lowpoly_woman"] + [f"v {x:.5f} {y:.5f} {z:.5f}" for x, y, z in V]
    for m in COLORS:
        fs = [q for q, qm in zip(quads, mats) if qm == m]
        if fs:
            out.append(f"usemtl {m}")
            out += ["f " + " ".join(str(i + 1) for i in q) for q in fs]
    path.write_text("\n".join(out) + "\n")


# --------------------------------------------------------------------------- contact sheet (a small software renderer)
def render(V, quads, mats, edges, n, r, centre, span, size, ss=2):
    """Orthographic view: n = unit vector towards the camera, r = screen right; span = metres over the image height."""
    from PIL import Image
    w, h = size[0] * ss, size[1] * ss
    n, r = unit(np.array(n, float)), unit(np.array(r, float))
    up = np.cross(n, r)
    P = V - np.array(centre)
    sc = h / span
    sx, sy, sz = w / 2 + (P @ r) * sc, h / 2 - (P @ up) * sc, P @ n
    img = np.full((h, w, 3), 246, np.uint8)
    zb = np.full((h, w), -1e9)
    light = unit(np.array([0.35, 0.55, 0.75]))
    lv = np.array([light @ r, light @ up, light @ n])
    for q, m in zip(quads, mats):
        fn = np.cross(V[q[2]] - V[q[0]], V[q[3]] - V[q[1]])
        fn = fn / max(np.linalg.norm(fn), 1e-12)
        if fn @ n <= 0:
            continue   # back face
        shade = 0.38 + 0.62 * max(0.0, float(lv @ np.array([fn @ r, fn @ up, fn @ n])))
        col = np.array(COLORS[m]) * 255 * shade
        for t in tris_of(V, q):
            x, y, z = sx[list(t)], sy[list(t)], sz[list(t)]
            x0, x1 = max(int(math.floor(x.min())), 0), min(int(math.ceil(x.max())) + 1, w)
            y0, y1 = max(int(math.floor(y.min())), 0), min(int(math.ceil(y.max())) + 1, h)
            if x0 >= x1 or y0 >= y1:
                continue
            den = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
            if abs(den) < 1e-12:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
            l0 = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / den
            l1 = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / den
            l2 = 1 - l0 - l1
            zz = l0 * z[0] + l1 * z[1] + l2 * z[2]
            sub = zb[y0:y1, x0:x1]
            hit = (l0 >= 0) & (l1 >= 0) & (l2 >= 0) & (zz > sub)
            sub[hit] = zz[hit]
            img[y0:y1, x0:x1][hit] = col
    for a, b in edges:   # quad edges, hidden where they are behind the surface
        k = int(max(abs(sx[a] - sx[b]), abs(sy[a] - sy[b]))) + 2
        t = np.linspace(0, 1, k)
        px, py = np.round(sx[a] + (sx[b] - sx[a]) * t - 0.5).astype(int), np.round(sy[a] + (sy[b] - sy[a]) * t - 0.5).astype(int)
        pz = sz[a] + (sz[b] - sz[a]) * t
        ok = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        px, py, pz = px[ok], py[ok], pz[ok]
        vis = pz >= zb[py, px] - 0.0025
        img[py[vis], px[vis]] = (img[py[vis], px[vis]] * 0.25).astype(np.uint8)
    return Image.fromarray(img).resize(size, Image.LANCZOS)


def sheet(path, V, quads, mats, edges, R, s):
    from PIL import Image
    al = math.radians(R.get("arm_down", 40))
    d, u = np.array([math.cos(al), -math.sin(al), 0.0]), np.array([math.sin(al), math.cos(al), 0.0])
    az = lambda deg: (math.sin(math.radians(deg)), 0.0, math.cos(math.radians(deg)))
    rt = lambda deg: (math.cos(math.radians(deg)), 0.0, -math.sin(math.radians(deg)))
    body, face = (0, .84 * s, 0), (0, 1.566 * s, .02 * s)
    hand = (np.array([.168, 1.362, -.012]) + d * .60 + np.array([0, 0, .016])) * s
    cells = [render(V, quads, mats, edges, az(0), rt(0), body, 1.74 * s, (370, 440)),
             render(V, quads, mats, edges, az(90), rt(90), body, 1.74 * s, (130, 440)),
             render(V, quads, mats, edges, az(180), rt(180), body, 1.74 * s, (370, 440)),
             render(V, quads, mats, edges, az(35), rt(35), body, 1.74 * s, (330, 440)),
             render(V, quads, mats, edges, az(0), rt(0), face, .30 * s, (300, 340)),
             render(V, quads, mats, edges, az(40), rt(40), face, .30 * s, (300, 340)),
             render(V, quads, mats, edges, az(90), rt(90), face, .30 * s, (300, 340)),
             render(V, quads, mats, edges, u, d, hand, .26 * s, (300, 340))]
    W = sum(c.size[0] for c in cells[:4])
    out = Image.new("RGB", (W, 440 + 340), (246, 246, 246))
    x = 0
    for c in cells[:4]:
        out.paste(c, (x, 0))
        x += c.size[0]
    x = 0
    for c in cells[4:]:
        out.paste(c, (x, 440))
        x += c.size[0]
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save(path)


def main():
    R = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    name = R.get("name", "lowpoly_woman")
    M = build(R)
    half_quads = len(M.q)
    mirror(M)
    checks, edges = orient(M)
    s = float(R.get("height", 1.68)) / 1.68
    V = np.array(M.v) * s
    N = normals(V, M.q)
    checks["height_m"] = round(float(V[:, 1].max() - V[:, 1].min()), 3)
    checks["poles"] = sum(v for k, v in checks["valence"].items() if k != "4")
    checks["ok"] = bool(checks["open_or_nonmanifold_edges"] == 0 and checks["components"] == 1 and checks["euler"] == 2 and checks["degenerate"] == 0)
    out = ROOT / "assets" / "characters" / name
    out.mkdir(parents=True, exist_ok=True)
    n = 1
    while (out / f"{name}_v{n}.glb").exists():
        n += 1
    stem = out / f"{name}_v{n}"
    write_glb(stem.with_suffix(".glb"), V, N, M.q, M.m)
    write_glb(out / f"{name}_v{n}_wire.glb", V, N, M.q, M.m, edges)
    write_obj(stem.with_suffix(".obj"), V, M.q, M.m)
    (out / f"{name}_v{n}.recipe.json").write_text(json.dumps({"recipe": R, "checks": checks}, indent=1) + "\n")
    res = {"ok": checks["ok"], "name": name, "version": n, "glb": str(stem.with_suffix(".glb").relative_to(ROOT)),
           "wire_glb": str((out / f"{name}_v{n}_wire.glb").relative_to(ROOT)), "obj": str(stem.with_suffix(".obj").relative_to(ROOT)),
           "materials": dict(Counter(M.m)), "checks": checks}
    if R.get("sheet"):
        sp = ROOT / "build" / "lowpoly" / name / f"sheet_v{n}.png"
        sheet(sp, V, M.q, M.m, edges, R, s)
        res["sheet"] = str(sp.relative_to(ROOT))
    print(json.dumps(res))


if __name__ == "__main__":
    main()
