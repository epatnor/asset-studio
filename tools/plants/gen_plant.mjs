// Växtgenerator: gräsknippen, vass, säd och blommor. Allt byggs av samma byggsten, en böjd kurva från
// marken: strån (platta, lätt V-vikta blad) och stjälkar (smala rör) som kan bära blad och ett huvud i
// toppen (tofs, ax, kolv, blomma eller knopp). Arterna är data i plants.json. Recept in, glTF ut, en rad JSON.
// Användning: node gen_plant.mjs '{"preset":"grass_medium","seed":3,"out":"x.gltf"}'
//
// Attribut utöver de vanliga: _WIND (0 vid marken, 1 i toppen; en funktion av höjden, så delar som möts
// rör sig alltid lika) och _GROUND (1 vid roten, 0 en bit upp). Klienten låter roten ta markens färg där
// _GROUND är 1. _STEM: se ribbon(). COLOR_0 ger en mörkare bas för visare som inte har den shadern.
import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { writeGltf } from '../tree/gltf_write.mjs';
import { add, sub, mul, dot, cross, norm, lerp, len, rng, UP } from '../tree/vec.mjs';
import { solveRig, rigExtras, rigChecks } from '../wind/rig.mjs';

const PLANTS = JSON.parse(fs.readFileSync(new URL('./plants.json', import.meta.url)));
const STYLE = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
const recipe = JSON.parse(process.argv[2] ?? '{}');
const { preset = 'grass_medium', seed = 0, out } = recipe;
if (!PLANTS[preset] || preset.startsWith('_')) {
  console.error(`unknown preset ${preset}; available: ${Object.keys(PLANTS).filter((k) => !k.startsWith('_')).join(', ')}`);
  process.exit(1);
}
const params = recipe.params ?? {};
const sp = { ...PLANTS[preset], ...params, colors: { ...PLANTS[preset].colors, ...(params.colors ?? {}) } };
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lin = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);
const colorOf = (key) => { const c = sp.colors[key] ?? key; return STYLE.palette[c] ?? c; };
const SINK = 0.03; // strån och stjälkar börjar under marken, så att roten aldrig syns som ett snitt
const LODS = [{ step: 1, seg: 1, sides: 6, ell: [5, 4] }, { step: 2, seg: 0.6, sides: 4, ell: [4, 3] }, { step: 4, seg: 0.4, sides: 3, ell: [3, 2] }];

// ---------- Kurvan: vinkeln från lodlinjen växer mot spetsen, som ett strå som böjer sig av sin egen tyngd ----------
function curve(o, th0, phi, L, bend, n) {
  const pts = [];
  let p = [...o], b1 = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n, th = Math.min(th0 + bend * 1.9 * t ** 1.6, 2.9);
    const d = [Math.sin(th) * Math.cos(phi), Math.cos(th), Math.sin(th) * Math.sin(phi)];
    // Parallellförflyttad ram, så att rör och ax inte vrider sig där kurvan passerar lodlinjen
    b1 = b1 ? norm(sub(b1, mul(d, dot(b1, d)))) : [-Math.sin(phi), 0, Math.cos(phi)];
    pts.push({ p: [...p], d, b1, b2: cross(d, b1), t, th, phi });
    if (i < n) p = add(p, mul(d, L / n));
  }
  return pts;
}
function at(pts, t) { // punkt och ram längs kurvan, t i [0, 1]
  const f = clamp(t, 0, 1) * (pts.length - 1), i = Math.min(Math.floor(f), pts.length - 2), u = f - i;
  const a = pts[i], b = pts[i + 1];
  const d = norm(lerp(a.d, b.d, u)), b1 = norm(sub(lerp(a.b1, b.b1, u), mul(d, dot(lerp(a.b1, b.b1, u), d))));
  return { p: lerp(a.p, b.p, u), d, b1, b2: cross(d, b1), th: a.th + (b.th - a.th) * u, phi: a.phi };
}
const angles = (d) => ({ th: Math.acos(clamp(d[1], -1, 1)), phi: Math.atan2(d[2], d[0]) });

// ---------- Geometri per färg (en mesh och ett material per färgnyckel) ----------
const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], stem: [], part: [], pt: [], indices: [] });
let parts = {};
const part = (key) => (parts[key] ??= empty());
// Vindriggen (tools/wind/rig.mjs): strån och stjälkar är rotdelar med fäste i marken, blad och tofsens strån sitter
// på stjälken, och blomhuvudet är en egen del i stjälkens topp som nickar. rig.cur och rig.t sätts av den som bygger
// (strå, rör, band) och följer med varje hörn som _PART och _PT.
let rig = { parts: [], cur: -1, t: 0 };
function rigPart(pts, radius, parent, tAttach, area) {
  const a = pts[0].p, b = pts[pts.length - 1].p;
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += len(sub(pts[i].p, pts[i - 1].p));
  rig.parts.push({ pivot: [...a], dir: len(sub(b, a)) > 1e-6 ? sub(b, a) : pts[0].d ?? UP, length: L, radius, parent, tAttach, area });
  return (rig.cur = rig.parts.length - 1);
}
const vtx = (g, p, n, uv, shade = 1, stem = [0, 0, 0]) => { g.positions.push(...p); g.normals.push(...n); g.uvs.push(...uv); g.colors.push(shade, shade, shade); g.stem.push(...stem); g.part.push(rig.cur); g.pt.push(rig.t); return g.positions.length / 3 - 1; };
const tri = (g, a, b, c) => g.indices.push(a, b, c);
// Öppna ytor (strån, blad, kronblad) får en riktig baksida med SAMMA normaler. Med dubbelsidiga material
// vänder renderaren normalen på baksidan, och då blir "rakt upp" rakt ner och undersidan svart.
const tri2 = (g, a, b, c) => g.indices.push(a, b, c, a, c, b);
// Slutna ytor (rör, kärnor) vänds så att framsidan pekar åt samma håll som hörnens normaler
function triOut(g, a, b, c) {
  const P = (i) => g.positions.slice(i * 3, i * 3 + 3), N = (i) => g.normals.slice(i * 3, i * 3 + 3);
  const fn = cross(sub(P(b), P(a)), sub(P(c), P(a))), vn = add(add(N(a), N(b)), N(c));
  if (dot(fn, vn) >= 0) g.indices.push(a, b, c); else g.indices.push(a, c, b);
}

const WIDTH = {
  grass: (t) => (0.75 + 0.25 * Math.min(1, t * 6)) * (1 - t) ** 0.8,
  strap: (t) => (1 - t ** 4) ** 0.8,
  leaf: (t) => Math.sin(Math.PI * (0.05 + 0.95 * t)) ** 0.8 * (1 - 0.3 * t),
};
// Strå eller blad: tre hörn per rad (vänster kant, vikt mitt, höger kant). Normalerna pekar rakt upp,
// så att knippet skuggas som en helhet utan svarta insidor (stilguiden, gräsreferensen).
function blade(key, pts, w, { shape = 'grass', fold = 0.4, twist = 0, upNormals = true }) {
  const g = part(key), fw = WIDTH[shape] ?? WIDTH.grass, rows = [];
  pts.forEach((q, i) => {
    const t = i / (pts.length - 1), a = twist * t;
    rig.t = t;
    const s = norm(add(mul(q.b1, Math.cos(a)), mul(q.b2, Math.sin(a))));
    const m = cross(s, q.d), half = (w * fw(t)) / 2, nrm = upNormals ? UP : m, shade = 0.55 + 0.45 * Math.min(1, t * 1.6);
    if (half < 1e-5) { rows.push([vtx(g, q.p, nrm, [0.5, t], shade)]); return; }
    rows.push([vtx(g, sub(q.p, mul(s, half)), nrm, [0, t], shade), vtx(g, add(q.p, mul(m, half * fold)), nrm, [0.5, t], shade), vtx(g, add(q.p, mul(s, half)), nrm, [1, t], shade)]);
  });
  for (let i = 0; i < rows.length - 1; i++) {
    const [a, b] = [rows[i], rows[i + 1]];
    if (b.length === 1) { tri2(g, a[0], a[1], b[0]); tri2(g, a[1], a[2], b[0]); continue; }
    tri2(g, a[0], a[1], b[1]); tri2(g, a[0], b[1], b[0]); tri2(g, a[1], a[2], b[2]); tri2(g, a[1], b[2], b[1]);
  }
}
// Rör längs kurvan (stjälkar, kolvar). upBlend drar normalerna mot uppåt för mjuk, sammanhållen skuggning.
function tube(key, pts, radius, sides, upBlend = 0.5, from = 0, to = 1, cap = true) {
  const g = part(key), n = pts.length - 1, ring = [];
  const ts = Array.from({ length: n + 1 }, (_, i) => from + (to - from) * (i / n));
  ts.forEach((t, i) => {
    const q = at(pts, t), r = radius(i / n), row = [];
    rig.t = t;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2, dir = add(mul(q.b1, Math.cos(a)), mul(q.b2, Math.sin(a)));
      row.push(vtx(g, add(q.p, mul(dir, r)), norm(lerp(dir, UP, upBlend)), [k / sides, t], 0.6 + 0.4 * t));
    }
    ring.push(row);
  });
  for (let i = 0; i < n; i++) for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    triOut(g, ring[i][k], ring[i + 1][k], ring[i + 1][k2]); triOut(g, ring[i][k], ring[i + 1][k2], ring[i][k2]);
  }
  if (cap) { rig.t = to; const q = at(pts, to), c = vtx(g, add(q.p, mul(q.d, radius(1) * 0.8)), q.d, [0.5, 1]); for (let k = 0; k < sides; k++) triOut(g, ring[n][k], c, ring[n][(k + 1) % sides]); }
}
// Stjälk som platt band (två hörn per rad). _STEM är förskjutningen från stjälkens mittlinje; klienten vrider
// bandet mot kameran runt mittlinjen, så att det ser ut som ett rör för en tredjedel av trianglarna.
function ribbon(key, pts, radius) {
  const g = part(key), n = pts.length - 1, rows = [];
  pts.forEach((q, i) => {
    const t = i / n, o = mul(q.b1, radius(t)), sh = 0.6 + 0.4 * t;
    rig.t = t;
    rows.push([vtx(g, sub(q.p, o), UP, [0, t], sh, mul(o, -1)), vtx(g, add(q.p, o), UP, [1, t], sh, o)]);
  });
  for (let i = 0; i < n; i++) { const [a, b] = [rows[i], rows[i + 1]]; tri2(g, a[0], a[1], b[1]); tri2(g, a[0], b[1], b[0]); }
}
// Ellipsoid längs en axel (kärnor i ax, knoppar, blommans mitt)
function ellipsoid(key, c, axis, r, l, [sides, rings]) {
  const g = part(key), ref = Math.abs(axis[1]) < 0.95 ? UP : [1, 0, 0], b1 = norm(cross(axis, ref)), b2 = cross(axis, b1);
  const bottom = vtx(g, sub(c, mul(axis, l / 2)), mul(axis, -1), [0.5, 0]), rows = [];
  for (let j = 1; j < rings; j++) {
    const v = -Math.cos((j / rings) * Math.PI), s = Math.sqrt(1 - v * v), row = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2, rad = add(mul(b1, Math.cos(a)), mul(b2, Math.sin(a)));
      row.push(vtx(g, add(c, add(mul(rad, r * s), mul(axis, (v * l) / 2))), norm(add(mul(rad, s / r), mul(axis, v / (l / 2)))), [k / sides, j / rings]));
    }
    rows.push(row);
  }
  const top = vtx(g, add(c, mul(axis, l / 2)), axis, [0.5, 1]);
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    triOut(g, bottom, rows[0][k2], rows[0][k]);
    for (let j = 0; j < rows.length - 1; j++) { triOut(g, rows[j][k], rows[j][k2], rows[j + 1][k2]); triOut(g, rows[j][k], rows[j + 1][k2], rows[j + 1][k]); }
    triOut(g, rows.at(-1)[k], rows.at(-1)[k2], top);
  }
}
// Kronblad: växer ut från blommans mitt, lutar uppåt med cup (0 = platt, 90 = rakt upp) och böjer med curl
function petal(key, base, axis, o, L, W, cup, curl, segs) {
  const g = part(key), side = norm(cross(axis, o)), rows = [];
  let p = [...base];
  for (let i = 0; i <= segs; i++) {
    const s = i / segs, c = (cup + curl * s) * DEG;
    const d = norm(add(mul(o, Math.cos(c)), mul(axis, Math.sin(c))));
    const face = norm(sub(mul(axis, Math.cos(c)), mul(o, Math.sin(c)))), nrm = norm(lerp(face, UP, 0.5));
    const half = (W * Math.sqrt(Math.sin(Math.PI * Math.min(1, 0.08 + s * 0.92)))) / 2;
    rows.push([vtx(g, sub(p, mul(side, half)), nrm, [0, s]), vtx(g, add(p, mul(face, half * 0.35)), nrm, [0.5, s]), vtx(g, add(p, mul(side, half)), nrm, [1, s])]);
    if (i < segs) p = add(p, mul(d, L / segs));
  }
  for (let i = 0; i < segs; i++) {
    const [a, b] = [rows[i], rows[i + 1]];
    tri2(g, a[0], a[1], b[1]); tri2(g, a[0], b[1], b[0]); tri2(g, a[1], a[2], b[2]); tri2(g, a[1], b[2], b[1]);
  }
}

// Flytblad (näckros): en platt, rund skiva med ett snitt in mot mitten och en lätt uppvikt kant.
// Ligger vid y = 0, som klienten placerar på vattenytan.
function pad(key, c, r, rot, notch, segs) {
  rig.cur = -1; rig.t = 0; // flytblad ligger på vattnet och rör sig inte i vinden
  const g = part(key), center = vtx(g, [c[0], 0.012, c[2]], UP, [0.5, 0.5], 0.85), rim = [];
  for (let i = 0; i <= segs; i++) {
    const a = rot + notch / 2 + (i / segs) * (Math.PI * 2 - notch), wob = 1 + 0.05 * Math.sin(a * 5 + rot);
    rim.push(vtx(g, [c[0] + Math.cos(a) * r * wob, 0.012 + r * 0.06, c[2] + Math.sin(a) * r * wob], UP, [0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5], 1));
  }
  for (let i = 0; i < segs; i++) tri2(g, center, rim[i], rim[i + 1]);
}

// ---------- Fästen: varje blad och huvud på en stjälk måste nå stjälken (kontrolleras efteråt) ----------
let attachments = [];
function attached(key, startVertex, stalkPts, tol) { attachments.push({ key, startVertex, stalkPts, tol }); }
function distToPolyline(p, pts) {
  let m = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i].p, ab = sub(pts[i + 1].p, a), t = clamp(dot(sub(p, a), ab) / (dot(ab, ab) || 1), 0, 1);
    m = Math.min(m, len(sub(p, add(a, mul(ab, t)))));
  }
  return m;
}

// ---------- Huvuden ----------
function head(h, st, stalkR, lod, rr, keep, stalkPart) {
  const q = at(st, 1), key = h.color ?? 'head';
  const D = () => rr(); // alla slumptal dras även när delen inte byggs, så att LOD-nivåerna blir samma växt
  if (h.type === 'tuft') { // tofs: några strån eller vippgrenar från toppen
    const n = Math.round(h.count[0] + (h.count[1] - h.count[0]) * D());
    for (let i = 0; i < n; i++) {
      const phi = (i / n) * Math.PI * 2 + D() * 0.8, th = (h.lean[0] + (h.lean[1] - h.lean[0]) * D()) * DEG;
      const L = h.length[0] + (h.length[1] - h.length[0]) * D(), bend = h.bend ?? 0.3;
      if (!keep || i % lod.step) continue;
      const v0 = part(key).positions.length / 3;
      const tc = curve(sub(q.p, mul(q.d, 0.01)), th, phi, L, bend, Math.max(2, Math.round(4 * lod.seg)));
      rigPart(tc, h.width / 2, stalkPart, 1, L * h.width * 0.5);
      blade(key, tc, h.width * Math.sqrt(lod.step), { shape: h.shape ?? 'grass', fold: 0.2 });
      attached(key, v0, st, stalkR + 0.015);
    }
  } else if (h.type === 'spike') { // ax: kärnor i rader runt toppen, gärna med borst (säd, lavendel, lupin)
    const n = Math.round(h.kernels[0] + (h.kernels[1] - h.kernels[0]) * D());
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n, jit = D(), aw = D();
      if (!keep) continue;
      rig.cur = stalkPart; rig.t = 1 - h.span + h.span * u; // axet sitter på stjälken och följer den
      const qq = at(st, 1 - h.span + h.span * u), rows = h.rows ?? 4;
      const a = (k % rows) * ((2 * Math.PI) / rows) + Math.floor(k / rows) * (Math.PI / rows) + jit * 0.3;
      const rad = add(mul(qq.b1, Math.cos(a)), mul(qq.b2, Math.sin(a))), ka = (h.angle ?? 25) * DEG;
      const kd = norm(add(mul(qq.d, Math.cos(ka)), mul(rad, Math.sin(ka))));
      const f = (h.taper ?? 0.45), size = 1 - f + f * Math.sin(Math.PI * Math.min(1, u * 1.1 + 0.05));
      const kr = h.size[0] * size, kl = h.size[1] * size, c = add(add(qq.p, mul(rad, stalkR + kr * 0.5)), mul(kd, kl * 0.4));
      const v0 = part(key).positions.length / 3;
      ellipsoid(key, c, kd, kr, kl, lod.ell.map((x) => Math.max(x - 1, 2 + (x === lod.ell[0])))); // små kärnor behöver färre hörn
      attached(key, v0, st, stalkR + kr * 1.2);
      if (h.awn && lod.step < 4) {
        const tip = add(c, mul(kd, kl * 0.45)), { th, phi } = angles(norm(lerp(kd, qq.d, 0.4)));
        const t0 = rig.t;
        blade(key, curve(tip, th, phi, h.awn * (0.8 + aw * 0.4), 0.08, 2), 0.004, { fold: 0 });
        rig.t = t0;
      }
    }
  } else if (h.type === 'cattail') { // kolv: tjock, brun cylinder en bit under toppen, stjälken fortsätter som en spets
    if (!keep) return;
    rig.cur = stalkPart;
    const v0 = part(key).positions.length / 3;
    tube(key, st, (u) => h.radius * (0.35 + 0.65 * Math.sqrt(Math.sin(Math.PI * clamp(u, 0.02, 0.98)))), Math.max(5, lod.sides + 2), 0.2, 1 - h.span - (h.top ?? 0.12), 1 - (h.top ?? 0.12));
    attached(key, v0, st, h.radius * 1.2);
  } else if (h.type === 'flower') { // blomma: kronblad i en eller två kransar runt en kupig mitt; ibland en knopp i stället
    const isBud = D() < (h.bud?.chance ?? 0), spin = D() * Math.PI * 2, jits = Array.from({ length: 12 }, D);
    if (!keep) return;
    const axis = norm(lerp(q.d, UP, h.faceUp ?? 0.5));
    // Blomhuvudet: en egen del i stjälkens topp som nickar som en helhet (alla hörn i spetsen, _PT = 1)
    const size = isBud ? h.bud.length : h.length + h.center[0];
    rigPart([{ p: q.p }, { p: add(q.p, mul(axis, size)) }], stalkR * 0.8, stalkPart, 1, Math.PI * size * size * 0.5);
    rig.t = 1;
    const ref = Math.abs(axis[1]) < 0.95 ? UP : [1, 0, 0], b1 = norm(cross(axis, ref)), b2 = cross(axis, b1);
    if (isBud) {
      const v0 = part(h.bud.color ?? 'bud').positions.length / 3;
      ellipsoid(h.bud.color ?? 'bud', add(q.p, mul(axis, h.bud.length * 0.4)), axis, h.bud.radius, h.bud.length, lod.ell);
      attached(h.bud.color ?? 'bud', v0, st, stalkR + 0.01);
      return;
    }
    const rings = h.rings ?? 1;
    for (let ring = 0; ring < rings; ring++) {
      const n = h.petals, sc = 1 - ring * 0.22;
      for (let i = 0; i < n; i++) {
        const a = spin + ((i + ring * 0.5) / n) * Math.PI * 2 + (jits[i % 12] - 0.5) * 0.25;
        const o = add(mul(b1, Math.cos(a)), mul(b2, Math.sin(a)));
        const base = add(add(q.p, mul(o, h.center[0] * 0.5)), mul(axis, ring * h.center[1] * 0.25));
        const v0 = part('petal').positions.length / 3;
        petal('petal', base, axis, o, h.length * sc * (0.9 + jits[(i + 5) % 12] * 0.2), h.width * sc, h.cup + ring * 18, h.curl ?? 0, Math.max(2, Math.round(3 * lod.seg)));
        attached('petal', v0, st, stalkR + h.center[0] + 0.01);
      }
    }
    if (h.center[0] > 0) {
      const v0 = part('center').positions.length / 3;
      ellipsoid('center', add(q.p, mul(axis, h.center[1] * 0.3)), axis, h.center[0], h.center[1], lod.ell);
      attached('center', v0, st, stalkR + h.center[0]);
    }
  }
}

// ---------- Lager: knippen av strån eller stjälkar ----------
const range = (v, r) => (Array.isArray(v) ? v[0] + (v[1] - v[0]) * r() : v);
function build(lod) {
  parts = {}; attachments = []; rig = { parts: [], cur: -1, t: 0 };
  const r = rng(seed * 7919 + 17);
  const bases = []; // rötternas startpunkter (kontrolleras: under marken)
  for (const layer of sp.layers) {
    const n = Math.round(range(layer.count, r)), key = layer.color ?? 'blade';
    for (let i = 0; i < n; i++) {
      const rad = Math.sqrt(r()) * layer.spread, ang = r() * Math.PI * 2;
      const o = [Math.cos(ang) * rad, -SINK, Math.sin(ang) * rad];
      // Strån lutar utåt från knippets mitt, mer ju längre ut de står; stjälkar står nästan rakt
      const out01 = layer.spread ? rad / layer.spread : 0;
      const phi = layer.type === 'blades' ? ang + (r() - 0.5) * 1.2 : r() * Math.PI * 2;
      const lean = layer.lean[0] + (layer.lean[1] - layer.lean[0]) * (layer.type === 'blades' ? Math.min(1, out01 ** 0.7 * 0.7 + r() * 0.4) : r());
      const L = range(layer.length, r), bend = range(layer.bend ?? 0, r), w = range(layer.width ?? 0, r), twist = (r() - 0.5) * (layer.twist ?? 0);
      const keep = i % lod.step === 0, segs = Math.max(2, Math.round((layer.segments ?? 5) * lod.seg));
      if (layer.type === 'pads') { // flytblad: ingen kurva, ligger platt på ytan
        const pr = range(layer.radius, r), rot = r() * Math.PI * 2;
        if (keep) pad(key, o, pr, rot, (layer.notch ?? 30) * DEG, Math.max(6, Math.round((layer.segments ?? 12) * lod.seg)));
        continue;
      }
      const pts = curve(o, lean * DEG, phi, L + SINK, bend, segs);
      if (layer.type === 'blades') {
        if (keep) { rigPart(pts, w / 2, -1, 0, L * w * 0.5); blade(key, pts, w * Math.sqrt(lod.step), { shape: layer.shape, fold: lod.step >= 4 ? 0 : layer.fold ?? 0.4, twist }); bases.push(o); }
        continue;
      }
      // Stjälk med blad och huvud
      const R = layer.radius;
      const stalkPart = keep ? rigPart(pts, R, -1, 0, L * R * 2) : -1;
      if (keep) { if (layer.ribbon === false) tube(key, pts, (t) => R * (1 - 0.45 * t), lod.sides, 0.5); else ribbon(key, pts, (t) => R * (1 - 0.45 * t)); bases.push(o); }
      const lv = layer.leaves;
      if (lv) {
        const m = Math.round(range(lv.count, r));
        for (let j = 0; j < m; j++) {
          const t = lv.at[0] + (lv.at[1] - lv.at[0]) * ((j + 0.5) / m) + (r() - 0.5) * 0.05;
          // side: bladens vinkel ut från stjälkens plan (90 = åt sidorna, som ormbunkens småblad); taper: kortare mot toppen
          const lphi = phi + (j % 2 ? Math.PI : 0) + (lv.side ?? 0) * DEG + (r() - 0.5) * 1.2 * (lv.jitter ?? 1);
          const ll = range(lv.length, r) * (1 - (lv.taper ?? 0) * (j / Math.max(1, m - 1))), lw = range(lv.width, r), lb = range(lv.bend ?? 0.3, r);
          if (!keep) continue;
          const q = at(pts, t), lk = lv.color ?? 'leaf', v0 = part(lk).positions.length / 3;
          const th = clamp(q.th + range(lv.lean, () => 0.5) * DEG, 0, 2.6);
          const lc = curve(sub(q.p, mul(norm([Math.cos(lphi), 0, Math.sin(lphi)]), R * 0.5)), th, lphi, ll, lb, Math.max(2, Math.round(4 * lod.seg)));
          rigPart(lc, lw / 2, stalkPart, t, ll * lw * 0.5);
          blade(lk, lc, lw, { shape: lv.shape ?? 'strap', fold: 0.3 });
          attached(lk, v0, pts, R + 0.01);
        }
      }
      if (layer.head) head(layer.head, pts, R * 0.55, lod, r, keep, stalkPart);
    }
  }
  return { parts, attachments, bases, rigParts: rig.parts };
}

// ---------- Bygg alla LOD, attribut och kontroller ----------
const scale = sp.scale ?? 1;
const lods = LODS.map((l) => build(l));
let H = 0;
for (const g of Object.values(lods[0].parts)) for (let i = 1; i < g.positions.length; i += 3) H = Math.max(H, g.positions[i]);
const groundH = Math.min(H * 0.6, sp.root ?? 0.3); // hur högt upp roten tar markens färg
const checks = { rooted: true, attached: true, floating: 0, normals_up: true, wind_torn: 0 };
for (const [li, { parts: ps, attachments: at0, bases }] of lods.entries()) {
  for (const g of Object.values(ps)) {
    g.wind = []; g.ground = [];
    for (let i = 0; i < g.positions.length; i += 3) {
      const y = g.positions[i + 1];
      g.wind.push(clamp(y / H, 0, 1));
      g.ground.push(1 - clamp(y / groundH, 0, 1) ** 0.8);
    }
  }
  if (li > 0) continue;
  checks.rooted = bases.every((b) => b[1] < 0);
  for (const a of at0) { // något hörn i delen måste ligga vid stjälken
    const g = ps[a.key];
    let m = Infinity;
    for (let v = a.startVertex; v < g.positions.length / 3 && v < a.startVertex + 400; v++) m = Math.min(m, distToPolyline(g.positions.slice(v * 3, v * 3 + 3), a.stalkPts));
    if (m > a.tol) checks.floating++;
  }
  checks.attached = checks.floating === 0;
  for (const k of Object.keys(ps).filter((k) => /^(blade|grass)/.test(k))) for (let i = 1; i < ps[k].normals.length; i += 3) if (ps[k].normals[i] < 0.99) checks.normals_up = false;
}
for (const { parts: ps } of lods) for (const g of Object.values(ps)) for (let i = 0; i < g.positions.length; i++) g.positions[i] *= scale;
// Vindriggen per LOD (LOD-nivåerna har olika många strån): strån och stjälkar svänger snabbare ju kortare växten är
const fScale = clamp(Math.sqrt(0.6 / Math.max(0.05, H * scale)), 0.6, 1.8);
for (const l of lods) {
  for (const q of l.rigParts) { q.pivot = mul(q.pivot, scale); q.length *= scale; q.radius *= scale; q.area *= scale * scale; }
  l.rig = solveRig(l.rigParts, { angles: sp.wind?.angles ?? [0.3, 0.4, 0.45], freqs: (sp.wind?.freqs ?? [1.1, 1.8, 2.4]).map((f) => f * fScale), seed });
}
Object.assign(checks, rigChecks(lods[0].rig.table, Object.values(lods[0].parts), lods[0].rig.depth));

const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const groundTint = new Set(sp.groundTint ?? ['blade', 'stalk', 'leaf']);
const mats = {};
const material = (key) => (mats[key] ??= doc.createMaterial(key).setBaseColorFactor([...lin(colorOf(key)), 1]).setDoubleSided(false)
  .setRoughnessFactor(key === 'petal' ? 0.6 : 0.8).setMetallicFactor(0).setExtras({ groundTint: groundTint.has(key) }));
const name = recipe.name ?? path.basename(out, path.extname(out));
const root = doc.createNode(name).setExtras({ generator: 'tinkertown/plant@1', recipe: { preset, seed } });
const tris = [];
let minY = Infinity;
lods.forEach(({ parts: ps }, i) => {
  const lodNode = doc.createNode(`${name}_LOD${i}`).setExtras({ lod: i, wind: rigExtras(lods[i].rig) });
  let t = 0;
  for (const [key, g] of Object.entries(ps)) {
    if (!g.indices.length) continue;
    const seen = new Map();
    for (let v = 0; v < g.wind.length; v++) { // samma position måste ha samma vind, annars slits delar isär
      const k = g.positions.slice(v * 3, v * 3 + 3).map((x) => x.toFixed(4)).join();
      if (seen.has(k) && Math.abs(seen.get(k) - g.wind[v]) > 1e-4) checks.wind_torn++; else seen.set(k, g.wind[v]);
    }
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', Float32Array.from(g.positions)))
      .setAttribute('NORMAL', acc('VEC3', Float32Array.from(g.normals)))
      .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(g.uvs)))
      .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(g.colors)))
      .setAttribute('_WIND', acc('SCALAR', Float32Array.from(g.wind)))
      .setAttribute('_GROUND', acc('SCALAR', Float32Array.from(g.ground)))
      .setAttribute('_STEM', acc('VEC3', Float32Array.from(g.stem.map((x) => x * scale))))
      .setAttribute('_PART', acc('SCALAR', Float32Array.from(g.part)))
      .setAttribute('_PT', acc('SCALAR', Float32Array.from(g.pt)))
      .setIndices(acc('SCALAR', Uint32Array.from(g.indices)))
      .setMaterial(material(key));
    lodNode.addChild(doc.createNode(`${name}_${key}_LOD${i}`).setMesh(doc.createMesh(`${key}_LOD${i}`).addPrimitive(prim)));
    t += g.indices.length / 3;
    if (i === 0) for (let k = 1; k < g.positions.length; k += 3) minY = Math.min(minY, g.positions[k]);
  }
  root.addChild(lodNode);
  tris.push(Math.round(t));
});
doc.createScene(name).addChild(root);
await writeGltf(doc, out);

const budget = STYLE.budgets_tris.ground_cover ?? [100, 4000];
checks.resting_on_ground = minY < 0 && minY > -0.2;
checks.within_budget = tris[0] <= budget[1];
checks.ok = checks.rooted && checks.attached && checks.normals_up && checks.wind_torn === 0 && checks.resting_on_ground && checks.within_budget
  && checks.rig_torn === 0 && checks.rig_still_moves === 0 && checks.rig_ground_moves === 0 && checks.rig_depth_ok;
console.log(JSON.stringify({ model: out, preset, height_m: +(H * scale).toFixed(2), parts: Object.keys(lods[0].parts), tris_lod: tris, checks }));
