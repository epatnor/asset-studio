// Byggnadsgenerator: hus, värdshus, torn och butiker i olika spelstilar, från recept. Alla hus byggs av
// samma delar: grund, väggar per våning, tak, torn, skorsten, fönster, dörr med trappa och litet tak,
// lykta, blomlådor, rankor och props. Data (typer, stilar, stiliseringsgrad) i buildings.json.
// Recept in, glTF ut (3 LOD), en rad JSON som svar.
//   node gen_building.mjs '{"preset":"house","style":"fantasy","stylization":"wow","seed":3,"out":"x.gltf","textures":{...}}'
//
// Först görs en plan med alla slumpval (mått, tak, vilka väggar som får fönster, var dörren sitter ...),
// sedan byggs geometrin från planen en gång per LOD. Då ser alla LOD-nivåer likadana ut.
// Formerna följer stilguiden: avfasade lådor med platta ytor och rundade kanter (samma utseende som
// bevel + weighted normals), ljusare upptill och i kanterna, och en mjuk skevhet som växer med stylization.
import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { sharedTexture, writeGltf } from '../tree/gltf_write.mjs';
import { add, sub, mul, dot, cross, norm, len, clamp01, UP, rng } from '../tree/vec.mjs';

const DATA = JSON.parse(fs.readFileSync(new URL('./buildings.json', import.meta.url)));
const STYLE_JSON = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
const recipe = JSON.parse(process.argv[2] ?? '{}');
const { preset = 'house', style = 'fantasy', seed = 0, out, textures = {} } = recipe;
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!DATA[preset] || preset.startsWith('_')) fail(`unknown preset ${preset}; available: ${Object.keys(DATA).filter((k) => !k.startsWith('_')).join(', ')}`);
if (!DATA._styles[style]) fail(`unknown style ${style}; available: ${Object.keys(DATA._styles).join(', ')}`);
const P = { ...DATA[preset], ...(recipe.params ?? {}) };
const ST = { ...DATA._styles[style], ...(recipe.style_params ?? {}) };
const S = typeof recipe.stylization === 'number' ? clamp01(recipe.stylization) : DATA._stylization[recipe.stylization ?? 'overwatch'] ?? 0.5;

// Stiliseringsgraden styr formspråket (0 = nästan realistiskt, 0.5 = Overwatch, 1 = WoW)
const STY = {
  bevel: 0.03 + 0.06 * S,                 // avfasning, andel av delens minsta mått (stilguiden: 2–4 %, mer i WoW)
  wonk: 0.001 + 0.04 * S * S,             // skevhet, andel av höjden: lutning, buktning, svackor
  overhang: 0.18 + 0.62 * S,               // takutsprång (m)
  pitch: 1 + 0.3 * S,                      // brantare tak
  trim: 0.09 + 0.15 * S,                   // tjocklek på bjälkar och ramar (m)
  open: 1 + 0.16 * S,                      // större dörrar och fönster
  depth: 0.06 + 0.07 * S,                  // hur långt ramar sticker ut (m)
};
const BEVEL_SEGS = STYLE_JSON.geometry?.bevel_segments ?? 2;

// ---------- Slump (bara i planen) ----------
const r = rng(seed * 9173 + 5);
const between = (v) => (Array.isArray(v) ? v[0] + (v[1] - v[0]) * r() : v);
const pickInt = (v) => Math.round(between(v));
const chance = (p) => r() < p;
const choose = (list) => list[Math.floor(r() * list.length)];
const lin = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);

// ---------- Geometri ----------
const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], indices: [] });
let G = {}; // del (material) -> geometri för aktuell LOD
let LOD = { segs: BEVEL_SEGS, detail: 2 };
const geo = (part) => (G[part] ??= empty());
const TILE = { base: 1.6, wall: 2.4, roof: 2.2, trim: 1.4, door: 1.3 }; // texturens storlek i meter
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const toWorld = (c, ax, q) => add(c, add(add(mul(ax[0], q[0]), mul(ax[1], q[1])), mul(ax[2], q[2])));
const dirWorld = (ax, q) => norm(add(add(mul(ax[0], q[0]), mul(ax[1], q[1])), mul(ax[2], q[2])));

// Texturkoordinater i meter, projicerade på ytans plan: lodräta ytor får v uppåt, sluttande (tak) v längs
// lutningen och u längs nocken; grain = u längs delens längsta axel (träfibrer i bjälkar)
function uvAxes(N, ax, size, grain) {
  if (grain) {
    const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
    for (const k of order) if (Math.abs(dot(ax[k], N)) < 0.5) { const u = ax[k]; return [u, norm(cross(N, u))]; }
  }
  if (Math.abs(N[1]) > 0.92) return [ax[0], ax[2]];
  const u = norm(cross(UP, N));
  return [u, norm(cross(N, u))];
}
function pushVert(g, p, n, uv, c, w = 0) {
  g.positions.push(...p); g.normals.push(...n); g.uvs.push(...uv); g.colors.push(...c); g.wind.push(w);
  return g.positions.length / 3 - 1;
}

/**
 * Avfasad låda: platta sidor och rundade kanter (projektion mot en inre låda, som RoundedBox).
 * size = [x, y, z] i lådans egna axlar ax; color = vertexfärg; grain = texturen längs längsta axeln.
 */
function box(part, c, size, { ax = I3, bevel, segs = LOD.segs, color = [1, 1, 1], grain = part === 'trim', tile = TILE[part] ?? 1 } = {}) {
  if (LOD.detail < 1 && Math.min(...size) < 0.06) return;
  const g = geo(part), h = size.map((s) => s / 2);
  const b = segs > 0 ? Math.min(bevel ?? Math.min(...size) * STY.bevel * 2.2, Math.min(...h) * 0.45) : 0;
  const sg = b > 0 ? (Math.min(...size) < 0.4 ? Math.min(segs, 1) : segs) : 0; // smala delar: enkel fasning
  if (sg === 1) return chamferBox(g, c, h, b, ax, size, color, grain, tile);
  const coords = (hh) => {
    if (!sg) return [-hh, hh];
    const lo = [], hi = [];
    for (let i = 0; i <= sg; i++) { lo.push(-hh + (b * i) / sg); hi.push(hh - b + (b * i) / sg); }
    return [...lo, ...hi];
  };
  for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
    const [u, v] = [(a + 1) % 3, (a + 2) % 3];
    const cu = coords(h[u]), cv = coords(h[v]);
    const fn = [0, 0, 0]; fn[a] = s;
    const N = dirWorld(ax, fn);
    const [uA, vA] = uvAxes(N, ax, size, grain);
    const start = g.positions.length / 3;
    for (const x of cu) for (const y of cv) {
      const q = [0, 0, 0]; q[a] = s * h[a]; q[u] = x; q[v] = y;
      let n = fn, p = q, edge = 1;
      if (b > 0) {
        const inner = q.map((t, k) => Math.max(-h[k] + b, Math.min(h[k] - b, t)));
        const d = sub(q, inner);
        if (len(d) > 1e-9) { n = norm(d); p = add(inner, mul(n, b)); if (Math.abs(n[a]) < 0.999) edge = 1.1; }
      }
      const wp = toWorld(c, ax, p);
      pushVert(g, wp, dirWorld(ax, n), [dot(wp, uA) / tile, -dot(wp, vA) / tile], color.map((x) => x * edge));
    }
    const nv = cv.length;
    for (let i = 0; i < cu.length - 1; i++) for (let j = 0; j < nv - 1; j++) {
      const k = start + i * nv + j;
      g.indices.push(k, k + nv, k + 1, k + 1, k + nv, k + nv + 1);
    }
  }
}
// Enkel fasning: varje fasett en gång (6 sidor, 12 kantband, 8 hörn = 44 trianglar), platta normaler per fasett
function chamferBox(g, c, h, b, ax, size, color, grain, tile) {
  const hi = h.map((x) => x - b);
  const pt = (sgn, k) => { const q = sgn.map((sv, i) => sv * hi[i]); q[k] += sgn[k] * b; return toWorld(c, ax, q); };
  const facet = (pts, nLocal, edge) => {
    const N = dirWorld(ax, nLocal), [uA, vA] = uvAxes(N, ax, size, grain);
    const idx = pts.map((p) => pushVert(g, p, N, [dot(p, uA) / tile, -dot(p, vA) / tile], edge ? color.map((x) => x * 1.1) : color));
    g.indices.push(idx[0], idx[1], idx[2]);
    if (idx.length === 4) g.indices.push(idx[0], idx[2], idx[3]);
  };
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3;
    for (const sa of [-1, 1]) { // sidan
      const sgn = (su, sv) => { const x = [0, 0, 0]; x[a] = sa; x[u] = su; x[v] = sv; return x; };
      const n = [0, 0, 0]; n[a] = sa;
      facet([pt(sgn(-1, -1), a), pt(sgn(1, -1), a), pt(sgn(1, 1), a), pt(sgn(-1, 1), a)], n, false);
    }
    for (const su of [-1, 1]) for (const sv of [-1, 1]) { // kantbandet längs axel a
      const sgn = (sa) => { const x = [0, 0, 0]; x[a] = sa; x[u] = su; x[v] = sv; return x; };
      const n = [0, 0, 0]; n[u] = su; n[v] = sv;
      facet([pt(sgn(-1), u), pt(sgn(-1), v), pt(sgn(1), v), pt(sgn(1), u)], norm(n), true);
    }
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) facet([0, 1, 2].map((k) => pt([sx, sy, sz], k)), norm([sx, sy, sz]), true);
}
// Låda mellan två punkter (bjälke, stag, kabel): längden längs a->b, tvärsnitt t1 × t2
function beam(part, a, b, t1, t2 = t1, opts = {}) {
  const d = sub(b, a), L = len(d), ex = norm(d);
  const ref = Math.abs(ex[1]) > 0.9 ? [1, 0, 0] : UP;
  const ez = norm(cross(ex, ref)), ey = cross(ez, ex);
  box(part, mul(add(a, b), 0.5), [L, t1, t2], { ax: [ex, ey, ez], ...opts });
}

// Skiva mellan två punkter med bredden längs en given axel (takskivor, takrader, vindskivor): till skillnad
// från beam vänder den sig aldrig när riktningen är brant
function slab(part, a, b, thick, width, widthAxis, opts = {}) {
  const d = sub(b, a), ex = norm(d), ez = norm(widthAxis), ey = norm(cross(ez, ex));
  box(part, mul(add(a, b), 0.5), [len(d), thick, width], { ax: [ex, ey, ez], ...opts });
}

/**
 * Svarvad form: profile [[radie, höjd], ...] nedifrån och upp runt axeln ay (standard uppåt), sides sidor.
 * flat = platta sidor (kantigt torn), annars mjuka. lean(t) -> förskjutning i x (böjd tornspets).
 */
function lathe(part, c, profile, sides, { flat = false, color = [1, 1, 1], tile = TILE[part] ?? 1, rot = 0, lean = null, cap = false } = {}) {
  const g = geo(part);
  const H = profile[profile.length - 1][1] - profile[0][1] || 1;
  const ringPt = (i, k) => {
    const [rad, y] = profile[i], a = rot + (k / sides) * Math.PI * 2;
    const off = lean ? lean((y - profile[0][1]) / H) : 0;
    return [c[0] + Math.cos(a) * rad + off, c[1] + y, c[2] + Math.sin(a) * rad];
  };
  const profN = (i, a) => {
    const [r0, y0] = profile[Math.max(0, i - 1)], [r1, y1] = profile[Math.min(profile.length - 1, i + 1)];
    const t = [r1 - r0, y1 - y0], tl = Math.hypot(...t) || 1;
    return norm([Math.cos(a) * (t[1] / tl), -t[0] / tl, Math.sin(a) * (t[1] / tl)]);
  };
  const circ = (rad) => (2 * Math.PI * Math.max(rad, 0.2)) / sides;
  for (let i = 0; i < profile.length - 1; i++) for (let k = 0; k < sides; k++) {
    const a0 = rot + (k / sides) * Math.PI * 2, a1 = rot + ((k + 1) / sides) * Math.PI * 2;
    const P = [ringPt(i, k), ringPt(i, k + 1), ringPt(i + 1, k + 1), ringPt(i + 1, k)];
    let N;
    if (flat) { const am = (a0 + a1) / 2; const fnrm = profN(i, am); N = [fnrm, fnrm, profN(i + 1, am), profN(i + 1, am)]; }
    else N = [profN(i, a0), profN(i, a1), profN(i + 1, a1), profN(i + 1, a0)];
    const v = [profile[i][1], profile[i][1], profile[i + 1][1], profile[i + 1][1]];
    const u = [k, k + 1, k + 1, k].map((kk, j) => (kk * circ(profile[j < 2 ? i : i + 1][0])) / tile);
    const idx = P.map((p, j) => pushVert(g, p, N[j], [u[j], -v[j] / tile], color));
    g.indices.push(idx[0], idx[1], idx[2], idx[0], idx[2], idx[3]);
  }
  if (cap) { // platt lock i toppen
    const top = profile.length - 1, cy = [c[0] + (lean ? lean(1) : 0), c[1] + profile[top][1], c[2]];
    const ci = pushVert(g, cy, UP, [0, 0], color);
    for (let k = 0; k < sides; k++) {
      const a = pushVert(g, ringPt(top, k), UP, [0, 0], color), b = pushVert(g, ringPt(top, k + 1), UP, [0, 0], color);
      g.indices.push(ci, a, b);
    }
  }
}
// Platt polygon (konvex, i en yta): glas, skyltar. pts i världen, n = normal
function polygon(part, pts, n, color = [1, 1, 1], tile = 1) {
  const g = geo(part), c = mul(pts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / pts.length);
  const [uA, vA] = uvAxes(n, I3, [1, 1, 1], false);
  const ci = pushVert(g, c, n, [dot(c, uA) / tile, -dot(c, vA) / tile], color);
  const idx = pts.map((p) => pushVert(g, p, n, [dot(p, uA) / tile, -dot(p, vA) / tile], color));
  for (let i = 0; i < idx.length; i++) g.indices.push(ci, idx[i], idx[(i + 1) % idx.length]);
}
// Klotform (blommor, löv, lyktknopp): ett lågt UV-klot, tillplattat med sc
function blob(part, c, rad, { sc = [1, 1, 1], color = [1, 1, 1], w = 0, seg = rad < 0.08 ? 3 : LOD.detail > 1 ? 5 : 3 } = {}) {
  const g = geo(part), start = g.positions.length / 3, rows = seg, cols = seg + 2;
  for (let i = 0; i <= rows; i++) for (let k = 0; k <= cols; k++) {
    const th = (i / rows) * Math.PI, ph = (k / cols) * Math.PI * 2;
    const d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    pushVert(g, add(c, [d[0] * rad * sc[0], d[1] * rad * sc[1], d[2] * rad * sc[2]]), norm([d[0] / sc[0], d[1] / sc[1], d[2] / sc[2]]), [k / cols, i / rows], color, w);
  }
  for (let i = 0; i < rows; i++) for (let k = 0; k < cols; k++) {
    const a = start + i * (cols + 1) + k;
    g.indices.push(a, a + cols + 1, a + 1, a + 1, a + cols + 1, a + cols + 2);
  }
}

// ---------- Planen: alla slumpval görs här, en gång ----------
const plan = (() => {
  const round = !!P.round;
  const W = between(P.footprint[0]), D = between(P.footprint[1]);
  const floors = pickInt(P.floors), fh = P.floorHeight;
  const plinth = between(P.plinth);
  const roofType = round ? (ST.tower.roof === 'flat' ? 'flat' : ST.tower.roof === 'dome' ? 'dome' : 'cone') : P.roof ?? choose(ST.roofs);
  const pitch = Math.min(64, between(P.roofPitch) * STY.pitch * (ST.roof?.pitch ?? 1)) * (Math.PI / 180);
  const jetty = !round && floors > 1 ? ST.jetty * (0.6 + 0.4 * S) : 0;
  const stoneGround = !round && floors > 1 && ST.timber && chance(0.6); // WoW: bottenvåning i sten, övervåningar i korsvirke
  const tints = Object.fromEntries(Object.entries(ST.tints).map(([k, v]) => [k, choose(v)]));
  const tower = !round && P.towerScale > 0 && chance(ST.tower.chance)
    ? { R: (1.15 + 0.35 * S) * P.towerScale, side: chance(0.5) ? 1 : -1, extra: 1, roof: ST.tower.roof, sides: 10 } : null;
  const wing = !round && !tower && chance(P.wing) ? { w: W * between([0.38, 0.5]), d: D * between([0.6, 0.78]), side: chance(0.5) ? 1 : -1, roof: ST.roofs.includes('flat') ? 'flat' : 'shed' } : null;
  const chimneys = ST.chimney === 'none' ? 0 : pickInt(P.chimneys);
  const lean = [(r() - 0.5) * 2, (r() - 0.5) * 2];
  const phases = Array.from({ length: 6 }, () => r() * Math.PI * 2);
  const glassAlt = ST.window.glassAlt;
  // Utvändig skorsten på en gavel (ur vägen för torn och flygel), och takkupor på långsidorna
  const gableChimney = !round && chimneys > 0 && ST.chimneyPlacement === 'gable' && (P.roof ?? roofType) === 'gable' && (P.frontAxis !== 'x' && W >= D);
  const towerSide = tower?.side, wingSide = wing?.side;
  const chimneySide = gableChimney ? ([1, -1].find((sd) => sd !== towerSide && sd !== wingSide) ?? 0) : 0;
  const chimneyAcross = (r() < 0.5 ? -1 : 1) * 0.5;
  const dormerList = [];
  if (!round && roofType === 'gable' && chance(ST.dormers ?? 0)) {
    const n = W >= 7.5 ? 2 : 1;
    for (let i = 0; i < n; i++) dormerList.push({ t: n === 1 ? (r() - 0.5) * 0.3 : (i ? 0.28 : -0.28) + (r() - 0.5) * 0.08, back: chance(0.4) });
  }
  const ridgeX = P.frontAxis === 'x' ? false : W >= D; // nocken längs x: gavlarna åt sidorna
  return { gableChimney: gableChimney && chimneySide !== 0, chimneySide, chimneyAcross, dormers: dormerList, round, ridgeX, W, D, floors, fh, plinth, roofType, pitch, jetty, stoneGround, tints, tower, wing, chimneys, lean, phases, glassAlt,
    wallTop: plinth + floors * fh, chimneyPos: Array.from({ length: chimneys }, (_, i) => ({ x: (i ? -1 : 1) * (0.25 + r() * 0.15), z: (r() - 0.5) * 0.5 })),
    detailSeed: Math.floor(r() * 2 ** 31) };
})();

// Väggar som ytor: o = mitten vid y = 0, t = riktning längs väggen, n = utåt, len = längd
function faces(W, D, cx = 0, cz = 0) {
  return [
    { name: 'front', o: [cx, 0, cz + D / 2], t: [1, 0, 0], n: [0, 0, 1], len: W },
    { name: 'right', o: [cx + W / 2, 0, cz], t: [0, 0, -1], n: [1, 0, 0], len: D },
    { name: 'back', o: [cx, 0, cz - D / 2], t: [-1, 0, 0], n: [0, 0, -1], len: W },
    { name: 'left', o: [cx - W / 2, 0, cz], t: [0, 0, 1], n: [-1, 0, 0], len: D },
  ];
}
const onFace = (f, u, y, out = 0) => add(add(f.o, mul(f.t, u)), [f.n[0] * out, y, f.n[2] * out]);
const faceAx = (f) => [f.t, UP, f.n];

// Fönster och dörrar per vägg och våning: bays längs väggen; dörren i bottenvåningens framsida.
// Allt som är valt lagras i planen (layout), så att kontrollerna kan räkna på det.
const layout = (() => {
  const { W, D, floors, fh, plinth, round, tower, wing } = plan;
  const openings = [], blocked = [];
  const ow = 0.95 * STY.open, oh = 1.25 * STY.open, dw = 1.15 * STY.open, dh = Math.min(fh - 0.35, 2.15 * STY.open);
  const shape = ST.window.shape;
  const flowerP = ST.flowerboxes ?? 0;
  if (round) {
    const R = W / 2, n = 6;
    for (let fl = 0; fl < floors; fl++) for (let k = 0; k < n; k++) {
      const a = Math.PI / 2 - (k / n) * Math.PI * 2; // k = 0 rakt fram (+z)
      const y0 = plinth + fl * fh;
      if (fl === 0 && k === 0) { openings.push({ kind: 'door', round: true, a, R, u: 0, y: y0, w: dw, h: dh, shape: ST.door.shape }); continue; }
      if ((k + fl) % 2 === 1 || (fl === 0 && chance(0.5))) continue;
      openings.push({ kind: 'window', round: true, a, R, u: 0, y: y0 + fh * 0.36, w: ow * 0.8, h: oh, shape: shape === 'strip' ? 'rect' : shape, shutters: false, flower: false });
    }
    return { openings, dw, dh };
  }
  // Tornet och flygeln upptar delar av väggarna
  if (tower) { // i ett främre hörn: blockerar en bit av framsidan och av gaveln på samma sida
    const x = (W / 2) * tower.side, m = tower.R + 0.45;
    tower.x = x; tower.z = D / 2;
    blocked.push({ face: 'front', u0: x - m, u1: x + m });
    // Gavelns u: höger vägg går mot -z (u = -z), vänster mot +z (u = z); tornet står vid z = D/2
    blocked.push(tower.side > 0 ? { face: 'right', u0: -D / 2 - m - 1, u1: -D / 2 + m } : { face: 'left', u0: D / 2 - m, u1: D / 2 + m + 1 });
  }
  if (wing) blocked.push({ face: wing.side > 0 ? 'right' : 'left', u0: -wing.d / 2 - 0.4, u1: wing.d / 2 + 0.4, maxFloor: 0 });
  if (plan.gableChimney) { // höger vägg: u = -z, vänster: u = z
    const z = plan.chimneyAcross * (D / 2), u = plan.chimneySide > 0 ? -z : z, m = 0.75 + 0.5;
    blocked.push({ face: plan.chimneySide > 0 ? 'right' : 'left', u0: u - m, u1: u + m });
  }
  const isBlocked = (f, fl, u0, u1) => blocked.some((b) => b.face === f.name && (b.maxFloor === undefined || fl <= b.maxFloor) && u1 > b.u0 && u0 < b.u1);
  for (let fl = 0; fl < floors; fl++) {
    const jw = fl > 0 ? plan.jetty : 0;
    for (const f of faces(W, D + 2 * jw)) {
      const nb = Math.max(1, Math.floor((f.len - 0.6) / (P.bay * STY.open)));
      const bayW = (f.len - 0.6) / nb;
      const y0 = plinth + fl * fh;
      const rate = f.name === 'front' ? 0.92 : f.name === 'back' ? 0.45 : 0.6;
      // Dörren: bottenvåningen, framsidan, i den bay som ligger närmast mitten (och inte blockerad)
      let doorBay = -1;
      if (fl === 0 && f.name === 'front') {
        const order = Array.from({ length: nb }, (_, i) => i).sort((a, b) => Math.abs(a - (nb - 1) / 2) - Math.abs(b - (nb - 1) / 2) + (r() - 0.5) * 0.1);
        doorBay = order.find((i) => { const u = -f.len / 2 + 0.3 + (i + 0.5) * bayW; return !isBlocked(f, fl, u - dw / 2 - 0.2, u + dw / 2 + 0.2); }) ?? -1;
      }
      for (let i = 0; i < nb; i++) {
        const u = -f.len / 2 + 0.3 + (i + 0.5) * bayW;
        if (i === doorBay) { openings.push({ kind: 'door', face: f.name, fl, u, y: y0, w: dw, h: dh, shape: ST.door.shape }); continue; }
        const shop = P.shopfront && fl === 0 && f.name === 'front';
        const w = shape === 'strip' ? Math.max(ow, bayW - 0.7) : shop ? Math.min(bayW - 0.5, ow * 1.8) : ow;
        const h = shop ? oh * 1.25 : oh;
        if (w > bayW - 0.3 || isBlocked(f, fl, u - w / 2 - 0.15, u + w / 2 + 0.15)) continue;
        if (!shop && !chance(rate)) continue;
        const wy = y0 + (shop ? 0.55 : fh * 0.34);
        openings.push({ kind: 'window', face: f.name, fl, u, y: wy, w, h, shape: shop ? 'rect' : shape, shop,
          shutters: !shop && shape !== 'strip' && chance(ST.window.shutters), flower: !shop && shape !== 'strip' && chance(flowerP * (fl > 0 ? 1 : 0.5)),
          glass: plan.glassAlt ? choose(plan.glassAlt) : null, lit: chance(ST.window.lit ?? 0.6) });
      }
      // Gavelfönster högt upp (vind) på gavlarna
      const gableFace = plan.ridgeX ? f.name === 'left' || f.name === 'right' : f.name === 'front' || f.name === 'back';
      if (fl === floors - 1 && plan.roofType === 'gable' && gableFace && chance(0.75) && !(tower && f.name === (tower.side > 0 ? 'right' : 'left'))) {
        const rise = (plan.ridgeX ? D / 2 + jw : W / 2) * Math.tan(plan.pitch);
        if (rise > 1.6) openings.push({ kind: 'window', face: f.name, fl, gable: true, u: 0, y: plan.wallTop + rise * 0.3, w: ow * 0.75, h: Math.min(oh, rise * 0.45),
          shape: shape === 'strip' ? 'rect' : shape === 'arch' ? 'round' : shape, shutters: false, flower: false });
      }
    }
  }
  return { openings, dw, dh };
})();

// Props kring huset (planerade, så att alla LOD har samma)
const propPlan = (() => {
  const list = [];
  const names = ST.props ?? [];
  const n = Math.min(names.length, 2 + Math.floor(r() * 2));
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const name = names[(i + Math.floor(r() * names.length)) % names.length];
    if (used.has(name)) continue;
    used.add(name);
    list.push({ name, side: chance(0.5) ? 1 : -1, t: r(), yaw: r() * Math.PI * 2, s: 0.9 + r() * 0.25 });
  }
  return list;
})();
const vinePlan = Array.from({ length: !plan.round && chance(ST.vines ?? 0) ? 1 + Math.floor(r() * 2 * (ST.vines ?? 0) + 0.5) : 0 }, () => ({ face: choose(['front', 'left', 'right', 'back']), t: r(), seed: Math.floor(r() * 1e9) }));

// ---------- Delar ----------
const PETALS = ['petal_red', 'petal_yellow', 'petal_pink', 'petal_white', 'petal_purple', 'petal_blue'].map((k) => STYLE_JSON.palette[k]).filter(Boolean);
const LEAF = [STYLE_JSON.palette.foliage_mid, STYLE_JSON.palette.foliage_light, STYLE_JSON.palette.foliage_shadow].filter(Boolean);
const srgb = (hex) => lin(hex); // vertexfärger är linjära i glTF
const ROOF_T = () => 0.15 + 0.17 * S;  // takets tjocklek
let ctx; // per LOD: rd (småslump), höjder

// Lodrät vägg från en vinkel runt ett centrum (torn, runda hus) som yta för fönster och dörrar
const radialFace = (cx, cz, R, a) => ({ name: 'round', o: [cx + Math.cos(a) * R, 0, cz + Math.sin(a) * R], t: [-Math.sin(a), 0, Math.cos(a)], n: [Math.cos(a), 0, Math.sin(a)], len: 2 * R });
const faceByName = (name, fl) => { const jw = fl > 0 ? plan.jetty : 0; return faces(plan.W, plan.D + 2 * jw).find((f) => f.name === name); };

// Ram runt en öppning: rect, arch (rundbåge) eller round (rund), som avfasade lådor
function outline(shape, w, h, k) {
  // Konturen i (u, v) med v från öppningens botten; konvex, moturs
  if (shape === 'round') return Array.from({ length: k * 2 }, (_, i) => { const a = (i / (k * 2)) * Math.PI * 2; return [Math.cos(a) * w / 2, w / 2 + Math.sin(a) * w / 2]; });
  if (shape === 'arch') {
    const pts = [[-w / 2, 0], [w / 2, 0]];
    for (let i = 0; i <= k; i++) { const a = (i / k) * Math.PI; pts.push([Math.cos(a) * w / 2, h - w / 2 + Math.sin(a) * w / 2]); }
    return pts;
  }
  return [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]];
}
function frame(f, u, y, w, h, shape, { ft = STY.trim * 0.75, fd = STY.depth + 0.05, bottom = true } = {}) {
  const k = LOD.detail > 1 ? 7 : LOD.detail ? 5 : 3;
  const ax = faceAx(f);
  const at = (uu, vv, out) => onFace(f, u + uu, y + vv, out);
  if (shape === 'round') {
    const R = w / 2 + ft / 2, n = k * 2;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      beam('trim', at(Math.cos(a0) * R, w / 2 + Math.sin(a0) * R, fd / 2), at(Math.cos(a1) * R, w / 2 + Math.sin(a1) * R, fd / 2), ft * 1.05, fd);
    }
    return;
  }
  const side = shape === 'arch' ? h - w / 2 : h;
  for (const s of [-1, 1]) box('trim', at(s * (w / 2 + ft / 2), side / 2 + (bottom ? 0 : -ft / 4), fd / 2), [ft, side + (bottom ? ft : ft / 2), fd], { ax });
  if (bottom) box('trim', at(0, -ft / 2, fd / 2), [w + ft * 2, ft, fd], { ax });
  if (shape === 'arch') {
    const R = w / 2 + ft / 2;
    for (let i = 0; i < k; i++) {
      const a0 = (i / k) * Math.PI, a1 = ((i + 1) / k) * Math.PI;
      beam('trim', at(Math.cos(a0) * R, side + Math.sin(a0) * R, fd / 2), at(Math.cos(a1) * R, side + Math.sin(a1) * R, fd / 2), ft * 1.05, fd);
    }
    if (LOD.detail > 0) box('trim', at(0, side + R + ft * 0.2, fd * 0.6), [ft * 1.3, ft * 1.4, fd * 1.2], { ax }); // slutsten
  } else box('trim', at(0, h + ft / 2, fd / 2), [w + ft * 2.4, ft * 1.15, fd * 1.1], { ax });
}
// Glas (eller dörrblad) i öppningen: konturen som en platt yta lite framför väggen
function pane(part, f, u, y, w, h, shape, out = 0.03, color = [1, 1, 1]) {
  const k = LOD.detail > 1 ? 7 : LOD.detail ? 5 : 3;
  polygon(part, outline(shape, w, h, k).map(([uu, vv]) => onFace(f, u + uu, y + vv, out)), f.n, color);
}

function windowAt(o, f) {
  const { u, y, w, shape } = o, h = shape === 'round' ? w : o.h;
  const glowing = (ST.window.glow > 0 || ST.window.litColor) && (o.lit ?? true);
  const glassPart = glowing ? `glow:${o.glass ?? (ST.window.glow > 0 ? ST.window.glass : ST.window.litColor)}` : 'glass';
  pane(glassPart, f, u, y, w, h, shape, 0.03);
  if (LOD.detail === 0) { box('trim', onFace(f, u, y - 0.06, 0.08), [w + 0.2, 0.12, 0.16], { ax: faceAx(f) }); return; }
  frame(f, u, y, w, h, shape, { bottom: !(ST.window.sill && !o.shop) });
  const ax = faceAx(f), t = STY.trim * 0.32;
  if (ST.window.mullions && shape !== 'strip') { // spröjsar
    const top = shape === 'arch' ? h - w / 2 : h;
    box('trim', onFace(f, u, y + (shape === 'round' ? w / 2 : top / 2), 0.05), [t, shape === 'round' ? w : top, 0.05], { ax });
    box('trim', onFace(f, u, y + (shape === 'round' ? w / 2 : top * 0.55), 0.05), [w, t, 0.05], { ax });
  }
  if (ST.window.lattice && LOD.detail > 1 && shape !== 'round') { // blyinfattade rutor: diagonala spröjsar
    const top = shape === 'arch' ? h - w / 2 : h, step = 0.3, t = 0.025;
    for (const dir of [1, -1]) for (let c = -top - w; c < w + top; c += step) {
      // Linjen u = c + dir·v, klippt mot rutan [-w/2, w/2] × [0, top]
      const pts = [];
      for (const v of [0, top]) { const uu = c + dir * v; if (uu >= -w / 2 && uu <= w / 2) pts.push([uu, v]); }
      for (const uu of [-w / 2, w / 2]) { const v = (uu - c) * dir; if (v > 0 && v < top) pts.push([uu, v]); }
      if (pts.length < 2) continue;
      const [p0, p1] = pts;
      if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 0.08) continue;
      beam('metal', onFace(f, u + p0[0], y + p0[1], 0.045), onFace(f, u + p1[0], y + p1[1], 0.045), t, t, { segs: 0 });
    }
  }
  if (ST.window.sill && !o.shop) box('trim', onFace(f, u, y - STY.trim * 0.35, (STY.depth + 0.16) / 2), [w + STY.trim * 2.6, STY.trim * 0.7, STY.depth + 0.16], { ax });
  if (o.shutters) for (const s of [-1, 1]) {
    const sw = w * 0.5, sh = (shape === 'arch' ? h - w * 0.25 : h) * 0.98, su = u + s * (w / 2 + STY.trim * 0.75 + sw / 2 + 0.03);
    box('door', onFace(f, su, y + sh / 2, 0.05), [sw, sh, 0.07], { ax, color: [0.95, 0.95, 0.95] });
    if (LOD.detail > 1) for (const v of [0.22, 0.78]) box('trim', onFace(f, su, y + sh * v, 0.1), [sw * 0.92, 0.07, 0.04], { ax });
  }
  if (o.flower) flowerBox(f, u, y, w);
}
function flowerBox(f, u, y, w) {
  const ax = faceAx(f), by = y - STY.trim * 0.7 - 0.2, bd = 0.32;
  box('door', onFace(f, u, by, bd / 2 + 0.04), [w + 0.3, 0.3, bd], { ax, color: [0.9, 0.9, 0.9] });
  if (LOD.detail === 0) return;
  const n = Math.max(3, Math.round((w + 0.3) / (LOD.detail > 1 ? 0.16 : 0.26)));
  for (let i = 0; i < n; i++) {
    const uu = u - (w + 0.2) / 2 + ((i + 0.5) / n) * (w + 0.2), out = 0.08 + ctx.rd() * (bd - 0.1);
    blob('flora', onFace(f, uu, by + 0.18 + ctx.rd() * 0.05, out), 0.1 + ctx.rd() * 0.04, { sc: [1.1, 0.75, 1.1], color: srgb(LEAF[i % LEAF.length]), w: 0.2 });
    if (ctx.rd() < 0.7) blob('flora', onFace(f, uu + (ctx.rd() - 0.5) * 0.08, by + 0.27 + ctx.rd() * 0.08, out + 0.02), 0.055, { color: srgb(PETALS[Math.floor(ctx.rd() * PETALS.length)]), w: 0.3 });
  }
}

function doorAt(o, f) {
  const { u, y, w, h, shape } = o, ax = faceAx(f);
  pane('door', f, u, y, w, h, shape, 0.04);
  if (LOD.detail > 0) {
    // Dörrbladet som en tjock skiva (gångjärnsband och handtag i metall)
    box('door', onFace(f, u, y + (shape === 'arch' ? (h - w / 2) / 2 : h / 2), 0.02), [w, shape === 'arch' ? h - w / 2 : h, 0.06], { ax });
    if (LOD.detail > 1) for (const v of [0.22, 0.72]) box('metal', onFace(f, u - w * 0.18, y + h * v, 0.07), [w * 0.6, 0.06, 0.03], { ax });
    blob('metal', onFace(f, u + w * 0.32, y + h * 0.45, 0.1), 0.05);
  }
  frame(f, u, y, w, h, shape, { bottom: false, ft: STY.trim * 0.95, fd: STY.depth + 0.08 });
  stairs(f, u, w);
  if (LOD.detail > 0) canopy(f, u, y, w, h);
  lantern(f, u + (u > 0 ? -1 : 1) * (w / 2 + STY.trim + 0.38), y + Math.min(h + 0.15, 2.3));
}
// Trappa från marken upp till golvet: staplade block, de nedre längre ut (grundens material)
function stairs(f, u, w) {
  const top = plan.plinth;
  if (top <= 0.12) return;
  const n = Math.max(1, Math.ceil(top / 0.2)), rise = top / n, land = 0.55 + 0.2 * S, sd = 0.32;
  const ax = faceAx(f);
  for (let k = 0; k < n; k++) {
    const yt = top - k * rise, depth = land + k * sd + 0.12, width = w + 0.55 + 0.12 * k;
    box('base', onFace(f, u, (yt - 0.35) / 2, depth / 2), [width, yt + 0.35, depth], { ax });
  }
  ctx.stairs = { n, depth: land + (n - 1) * sd + 0.12 };
}
// Litet tak över entrén, på två konsoler
function canopy(f, u, y, w, h) {
  const kind = ST.canopy ?? 'shed', ax = faceAx(f);
  const yc = y + h + 0.2 + STY.trim * 0.3, cd = 0.95 + 0.25 * S, cw = w + 0.95 + 0.3 * S, th = ROOF_T() * 0.7;
  for (const s of [-1, 1]) beam('trim', onFace(f, u + s * (cw / 2 - 0.18), yc - 0.75, 0.02), onFace(f, u + s * (cw / 2 - 0.18), yc - 0.02, cd * 0.82), STY.trim * 0.65);
  if (kind === 'flat') { box('roof', onFace(f, u, yc + th / 2, cd / 2), [cw, th, cd], { ax }); return; }
  if (kind === 'shed') {
    const q = 0.38, s = norm(add(mul(f.n, Math.cos(q)), mul(UP, -Math.sin(q)))), nn = norm(add(mul(f.n, Math.sin(q)), mul(UP, Math.cos(q))));
    const L = cd / Math.cos(q);
    box('roof', add(onFace(f, u, yc + (cd * Math.tan(q)) / 2, cd / 2), mul(nn, th / 2)), [cw, th, L], { ax: [f.t, nn, s] });
    return;
  }
  // gable: nocken rakt ut från väggen
  const q = 0.5, rise = (cw / 2) * Math.tan(q), L = cw / 2 / Math.cos(q);
  for (const s of [-1, 1]) {
    const down = norm(add(mul(f.t, s * Math.cos(q)), mul(UP, -Math.sin(q)))), nn = norm(add(mul(f.t, s * Math.sin(q)), mul(UP, Math.cos(q))));
    box('roof', add(onFace(f, u + s * cw / 4, yc + rise / 2, cd / 2), mul(nn, th / 2)), [L + th * 0.6, th, cd], { ax: [down, nn, f.n] });
  }
  if (LOD.detail > 1) { // gavelspets i trä
    beam('trim', onFace(f, u - cw / 2, yc, cd + 0.02), onFace(f, u, yc + rise, cd + 0.02), STY.trim * 0.55, 0.08);
    beam('trim', onFace(f, u + cw / 2, yc, cd + 0.02), onFace(f, u, yc + rise, cd + 0.02), STY.trim * 0.55, 0.08);
  }
}
// Lykta vid dörren
function lantern(f, u, y) {
  const L = ST.lantern ?? { kind: 'iron', light: '#FFC46A' }, light = `light:${L.light}`, ax = faceAx(f);
  if (L.kind === 'neon') { // ett lodrätt neonrör i en ram
    box('metal', onFace(f, u, y - 0.2, 0.05), [0.16, 0.9, 0.08], { ax });
    box(`neon:${L.light}`, onFace(f, u, y - 0.2, 0.1), [0.07, 0.8, 0.05], { ax, segs: 1 });
    return;
  }
  if (L.kind === 'led' || L.kind === 'modern') { // vägglampa
    box('metal', onFace(f, u, y - 0.1, 0.06), [0.2, 0.32, 0.1], { ax });
    box(light, onFace(f, u, y - 0.1, 0.12), [0.14, 0.22, 0.04], { ax, segs: 1 });
    return;
  }
  // Hängande lykta på en arm (iron, gas)
  const arm = 0.42, top = onFace(f, u, y + 0.12, arm);
  beam('metal', onFace(f, u, y + 0.12, 0), top, 0.05);
  if (LOD.detail > 0) beam('metal', onFace(f, u, y - 0.18, 0), onFace(f, u, y + 0.12, arm * 0.7), 0.035);
  const c = add(top, [0, -0.3, 0]), lw = 0.2 + 0.05 * S;
  if (L.kind === 'gas') lathe(light, c, [[0.001, -0.14], [lw * 0.55, -0.1], [lw * 0.55, 0.1], [0.001, 0.14]], LOD.detail ? 8 : 5);
  else box(light, c, [lw, 0.28, lw], { ax, segs: 1 });
  lathe('metal', add(c, [0, 0.13, 0]), [[lw * 0.75, 0], [lw * 0.5, 0.06], [0.04, 0.16], [0.001, 0.17]], 4, { flat: true, rot: Math.PI / 4 });
  box('metal', add(c, [0, -0.15, 0]), [lw * 1.1, 0.04, lw * 1.1], { ax });
}

// ---------- Huskroppen ----------
function massRect() {
  const { W, D, floors, fh, plinth, jetty, stoneGround } = plan;
  const wb = 0.05 + 0.08 * S; // väggarnas avfasning
  box('base', [0, (plinth - 0.6) / 2, 0], [W + 0.26, plinth + 0.6, D + 0.26], { bevel: 0.06 + 0.06 * S });
  for (let fl = 0; fl < floors; fl++) {
    const y0 = plinth + fl * fh, jw = fl > 0 ? jetty : 0;
    const part = fl === 0 && stoneGround ? 'base' : 'wall';
    box(part, [0, y0 + fh / 2, 0], [W, fh, D + 2 * jw], { bevel: wb });
    if (fl > 0) { // våningsband, och synliga bjälkändar under ett utskjutande övervåningsgolv
      box('trim', [0, y0, 0], [W + 0.14, STY.trim * 1.2, D + 2 * jw + 0.14]);
      if (jw > 0 && LOD.detail > 0) for (const s of [-1, 1]) for (let x = -W / 2 + 0.4; x <= W / 2 - 0.3; x += 0.75)
        box('trim', [x, y0 - STY.trim * 0.9, s * (D / 2 + jw / 2)], [STY.trim * 0.8, STY.trim * 0.9, jw + 0.1]);
    }
  }
  box('trim', [0, plan.wallTop - STY.trim * 0.4, 0], [W + 0.1, STY.trim * 0.8, D + 2 * (floors > 1 ? jetty : 0) + 0.1]); // takfot
  if (ST.timber || S > 0.6) corners();
  if (ST.timber) timber();
}
// Hörnstolpar i trim (chunky hörn, som i WoW)
function corners() {
  const { W, D, floors, fh, plinth, jetty, stoneGround } = plan, t = STY.trim * 1.15;
  for (let fl = stoneGround ? 1 : 0; fl < floors; fl++) {
    const y0 = plinth + fl * fh, jw = fl > 0 ? jetty : 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (plan.tower && sx === plan.tower.side && sz === 1) continue;
      box('trim', [sx * W / 2, y0 + fh / 2, sz * (D / 2 + jw)], [t, fh, t]);
    }
  }
}
// Korsvirke: stolpar mellan fönstren, syll och hammarband, snedstag i fält utan fönster
function timber() {
  const { W, D, floors, fh, plinth, jetty, stoneGround } = plan, t = STY.trim * 0.8;
  for (let fl = stoneGround ? 1 : 0; fl < floors; fl++) {
    const y0 = plinth + fl * fh, jw = fl > 0 ? jetty : 0;
    for (const f of faces(W, D + 2 * jw)) {
      if (plan.wing && fl === 0 && f.name === (plan.wing.side > 0 ? 'right' : 'left')) continue;
      const ax = faceAx(f), open = layout.openings.filter((o) => o.face === f.name && o.fl === fl && !o.gable);
      const nb = Math.max(1, Math.floor((f.len - 0.6) / (P.bay * STY.open))), bayW = (f.len - 0.6) / nb;
      box('trim', onFace(f, 0, y0 + t / 2 + 0.02, t * 0.3), [f.len, t, t * 0.6], { ax });
      if (LOD.detail === 0) continue;
      const clear = (u0, u1) => !open.some((o) => u1 > o.u - o.w / 2 - STY.trim * 1.6 && u0 < o.u + o.w / 2 + STY.trim * 1.6);
      for (let i = 1; i < nb; i++) { const u = -f.len / 2 + 0.3 + i * bayW; if (clear(u - t, u + t)) box('trim', onFace(f, u, y0 + fh / 2, t * 0.3), [t, fh, t * 0.6], { ax }); }
      for (let i = 0; i < nb; i++) {
        const u0 = -f.len / 2 + 0.3 + i * bayW + t, u1 = u0 + bayW - 2 * t;
        if (!clear(u0, u1) || (plan.tower && f.name === 'front' && Math.abs((u0 + u1) / 2 - plan.tower.x) < plan.tower.R + bayW / 2)) continue;
        const flip = (i + fl) % 2 ? 1 : 0;
        beam('trim', onFace(f, flip ? u1 : u0, y0 + t, t * 0.3), onFace(f, flip ? u0 : u1, y0 + fh - t * 0.5, t * 0.3), t * 0.85, t * 0.55);
      }
    }
  }
}
function massRound() {
  const { W, floors, fh, plinth } = plan, R = W / 2, sides = 12;
  const part = ST.tower.material === 'base' ? 'base' : 'wall';
  lathe('base', [0, 0, 0], [[R + 0.18, -0.6], [R + 0.18, plinth]], sides, { cap: true });
  lathe(part, [0, 0, 0], [[R, plinth], [R * (1 - 0.06 * S), plan.wallTop]], sides, { cap: true });
  for (let fl = 1; fl <= floors; fl++) {
    const y = plinth + fl * fh, rr = R * (1 - 0.06 * S * (fl / floors)) + 0.07;
    lathe('trim', [0, 0, 0], [[rr, y - STY.trim * 0.6], [rr, y]], sides, { cap: false });
  }
}

// ---------- Tak ----------
// Nocken längs x eller z: allt byggs i (längs, upp, tvärs) och speglas till världen
const sw = (v) => (plan.ridgeX ? v : [v[2], v[1], v[0]]);
function roofRect(W, D, top, type, { ov = STY.overhang, pitch = plan.pitch, gableWalls = true } = {}) {
  const A = plan.ridgeX ? W : D, B = plan.ridgeX ? D : W; // längs nocken, tvärs
  const hd = B / 2, th = ROOF_T();
  if (type === 'flat') {
    box('roof', [0, top + 0.12, 0], [W + 0.25, 0.36, D + 0.25], { bevel: 0.06 });
    const pt = 0.26, ph = 0.55 + 0.2 * S;
    for (const s of [-1, 1]) {
      box('trim', sw([0, top + 0.3 + ph / 2, s * (hd + 0.1)]), sw([A + 0.45, ph, pt]));
      box('trim', sw([s * (A / 2 + 0.1), top + 0.3 + ph / 2, 0]), sw([pt, ph, B + 0.2]));
    }
    return { ridge: top + 0.3 + ph, eave: top, surface: () => top + 0.3 };
  }
  const rise = hd * Math.tan(pitch), ridge = top + rise;
  if (type === 'gable' || type === 'shed') {
    const sides = type === 'shed' ? [1] : [-1, 1];
    const prof = roofProfile(hd, ov, rise, top), ext = (ST.roof?.tips ? 0.35 + 0.45 * S : 0.12); // nocken sticker ut förbi gaveln
    const segs = LOD.detail > 1 ? 4 : LOD.detail ? 3 : 1, half = A / 2 + ov;
    for (const s of sides) {
      // Takskivan i segment längs den utsvängda profilen (brant vid nocken, flackare ut mot takfoten)
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const a = prof.at(t0), b = prof.at(t1), n2 = prof.normal((t0 + t1) / 2), e = i === 0 ? th * 0.6 : 0.03;
        const A3 = [0, a[1] + n2[1] * th / 2, s * (a[0] + n2[0] * th / 2)], B3 = [0, b[1] + n2[1] * th / 2, s * (b[0] + n2[0] * th / 2)];
        const dir = norm(sub(B3, A3));
        slab('roof', sw(sub(A3, mul(dir, e))), sw(add(B3, mul(dir, 0.03))), th, 2 * half, sw([1, 0, 0]), { segs: LOD.segs ? 1 : 0 });
      }
      if (ST.roof?.shingles && LOD.detail > 0) shingles(prof, s, half, th);
      if (LOD.detail > 0) for (const x of [-1, 1]) { // vindskivor längs gavlarna, som följer kurvan
        for (let i = 0; i < segs; i++) {
          const a = prof.at(i / segs), b = prof.at((i + 1) / segs), n2 = prof.normal((i + 0.5) / segs);
          const off = th * 0.55;
          slab('trim', sw([x * (half - 0.04), a[1] + n2[1] * off, s * (a[0] + n2[0] * off)]), sw([x * (half - 0.04), b[1] + n2[1] * off, s * (b[0] + n2[0] * off)]), th * 1.25, STY.trim * 0.9, sw([1, 0, 0]));
        }
      }
    }
    if (type === 'gable') {
      box('roof', sw([0, ridge + th * 0.75, 0]), sw([2 * (half + ext), th * 1.0, th * 1.6]), { color: [0.85, 0.85, 0.85] }); // nockpanna
      if (ST.roof?.tips && LOD.detail > 0) for (const x of [-1, 1]) // spetsiga, uppåtböjda nockändar
        beam('roof', sw([x * (half + ext - 0.05), ridge + th * 0.75, 0]), sw([x * (half + ext + 0.25 + 0.2 * S), ridge + th * 0.75 + 0.35 + 0.25 * S, 0]), th * 0.8, th * 1.2, { color: [0.85, 0.85, 0.85] });
    }
    if (gableWalls) for (const x of [-1, 1]) gableWall(x, A, hd, top, prof, type);
    return { ridge, eave: prof.at(1)[1], prof, surface: (along, across) => (Math.abs(along) > half ? -Infinity : prof.y(Math.abs(across))) };
  }
  // hip (valmat tak): sluttande sidor runt om, kort nock i mitten; tjocklek via takfot och undersida
  pitch = Math.min(pitch, (48 * Math.PI) / 180); // ett valmat tak blir en pyramid om det är för brant
  const Ae = A / 2 + ov, Be = hd + ov, ye = top - ov * Math.tan(pitch), yr = ye + Be * Math.tan(pitch), rl = Math.max(0, Ae - Be);
  const E = [[-Ae, ye, Be], [Ae, ye, Be], [Ae, ye, -Be], [-Ae, ye, -Be]].map(sw), R1 = sw([-rl, yr, 0]), R2 = sw([rl, yr, 0]);
  const fn = (pts) => norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
  const facesHip = [[E[0], E[1], R2, R1], [E[2], E[3], R1, R2], [E[1], E[2], R2], [E[3], E[0], R1]];
  for (const pts of facesHip) {
    let n = fn(pts); if (n[1] < 0) n = mul(n, -1);
    quadOrTri('roof', pts, n);
  }
  const yb = ye - th;
  for (let i = 0; i < 4; i++) { // takfotens tjocklek
    const a = E[i], b = E[(i + 1) % 4], a2 = [a[0], yb, a[2]], b2 = [b[0], yb, b[2]];
    const mid = mul(add(a, b), 0.5); const n = norm([mid[0], 0, mid[2]]);
    const nn = Math.abs(n[0]) > Math.abs(n[2]) ? [Math.sign(n[0]), 0, 0] : [0, 0, Math.sign(n[2])];
    quadOrTri('roof', [a, b, b2, a2], nn);
  }
  quadOrTri('roof', E.map((p) => [p[0], yb, p[2]]), [0, -1, 0], [0.6, 0.6, 0.6]);
  if (LOD.detail > 0) { // nock och grater
    const cap = th * 1.1;
    if (rl > 0.05) beam('roof', add(R1, [0, cap * 0.4, 0]), add(R2, [0, cap * 0.4, 0]), cap, cap * 1.3, { color: [0.85, 0.85, 0.85] });
    for (const [e, rr] of [[E[0], R1], [E[3], R1], [E[1], R2], [E[2], R2]]) beam('roof', add(e, [0, cap * 0.4, 0]), add(rr, [0, cap * 0.4, 0]), cap * 0.9, cap * 1.1, { color: [0.85, 0.85, 0.85] });
  }
  return { ridge: yr, eave: ye, surface: (along, across) => ye + Math.min(Be - Math.abs(across), Ae - Math.abs(along)) * Math.tan(pitch) };
}
function quadOrTri(part, pts, n, color = [1, 1, 1]) {
  const g = geo(part), [uA, vA] = uvAxes(n, I3, [1, 1, 1], false), tile = TILE[part] ?? 1;
  const idx = pts.map((p) => pushVert(g, p, n, [dot(p, uA) / tile, -dot(p, vA) / tile], color));
  g.indices.push(idx[0], idx[1], idx[2]);
  if (idx.length === 4) g.indices.push(idx[0], idx[2], idx[3]);
}
// Takprofilen: utsvängd takfot (flare). f(t) = t + flare·t·(1 − t) är brantare vid nocken och flackare ut
// mot takfoten; skalan väljs så att taket går exakt genom väggens överkant. at(t) = [tvärs, höjd], t 0..1
function roofProfile(hd, ov, rise, top) {
  const fl = (ST.roof?.flare ?? 0) * (0.4 + 0.6 * S), L = hd + ov, tw = hd / L;
  const f = (t) => t + fl * t * (1 - t), fd = (t) => 1 + fl * (1 - 2 * t);
  const R = rise / f(tw), ridge = top + rise;
  const at = (t) => [L * t, ridge - R * f(t)];
  const normal = (t) => norm([R * fd(t) / L, 1]); // uppåt-utåt, vinkelrät mot ytan
  return { at, normal, y: (x) => (x > L ? -Infinity : ridge - R * f(x / L)), ridge, L };
}
// Takrader i relief: rader som ligger tätt och överlappar som spån (nederkanten lite upplyft), i långa
// bitar med lite olika ton; en del med mossa
function shingles(prof, s, half, th) {
  const rows = Math.round(prof.L / (LOD.detail > 1 ? 0.6 : 0.9)), chunk = LOD.detail > 1 ? 3.6 : 6;
  const moss = ST.roof?.moss ?? (style === 'fantasy' || style === 'rpg' ? 0.35 : 0);
  const rd = rng(plan.detailSeed + (s > 0 ? 1 : 2)), along = sw([1, 0, 0]);
  for (let r0 = 0; r0 < rows; r0++) {
    const t0 = r0 / rows, t1 = Math.min(1, (r0 + 1.15) / rows);
    const a = prof.at(t0), b = prof.at(t1), n2 = prof.normal((t0 + t1) / 2);
    const nc = Math.max(1, Math.round((2 * half) / chunk)), cw = (2 * half) / nc, stagger = (r0 % 2) * cw * 0.5;
    for (let c = -1; c < nc; c++) {
      let x0 = -half + c * cw + stagger, x1 = x0 + cw;
      x0 = Math.max(-half, x0); x1 = Math.min(half, x1);
      if (x1 - x0 < 0.3) continue;
      const P = (pt, l) => sw([(x0 + x1) / 2, pt[1] + n2[1] * l, s * (pt[0] + n2[0] * l)]);
      const mossy = rd() < moss * 0.3, k = 0.9 + rd() * 0.16;
      const mc = srgb('#8FB050').map((v) => Math.min(1, v * 2.2)), color = mossy ? [0, 1, 2].map((i) => k * (0.55 + 0.45 * mc[i])) : [k, k, k];
      slab('roof', P(a, th + 0.005), P(b, th + 0.045), 0.05, x1 - x0, along, { segs: LOD.detail > 1 ? 1 : 0, color });
    }
  }
}
// Gavelröstet följer takets kurva (väggens material, med korsvirke i trä), lite indraget under takskivorna
function gableWall(x, A, hd, top, prof, type) {
  const part = 'wall', xa = x * (A / 2), xi = x * (A / 2 - 0.3);
  const n = LOD.detail > 1 ? 6 : 3, tw = hd / prof.L;
  const curve = [];
  for (let i = 0; i <= n; i++) { const t = tw * (1 - i / n); const p = prof.at(t); curve.push([p[0], p[1]]); }
  const outline = type === 'shed'
    ? [[-hd, top], [hd, top], ...curve.map(([c, y]) => [-c, y]).reverse().slice(0, 1), [-hd, prof.ridge]]
    : [[-hd, top], [hd, top], ...curve.slice(1).map(([c, y]) => [c, y]), ...curve.slice(0, -1).reverse().map(([c, y]) => [-c, y]).slice(0, -1)];
  const P3 = (xx, [z, y]) => sw([xx, y, z]);
  polygon(part, outline.map((p) => P3(xa, p)), sw([x, 0, 0]));
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length], n2 = norm([b[1] - a[1], -(b[0] - a[0])]);
    quadOrTri(part, [P3(xa, a), P3(xa, b), P3(xi, b), P3(xi, a)], sw([0, n2[1], n2[0]]));
  }
  if (ST.timber && LOD.detail > 0 && type === 'gable') {
    const t = STY.trim * 0.8, o = x * (A / 2 + t * 0.25), ridge = prof.ridge;
    beam('trim', sw([o, top + 0.02, 0]), sw([o, ridge - 0.1, 0]), t, t * 0.6);
    beam('trim', sw([o, top + (ridge - top) * 0.45, -hd * 0.55]), sw([o, top + (ridge - top) * 0.45, hd * 0.55]), t, t * 0.6);
  }
}
// Kon (spetsigt tornak, böjd spets i WoW-stil) och kupol
function roofRound(cx, cz, R, top, type) {
  const ov = STY.overhang * 0.8, Re = R + ov, th = ROOF_T(), sides = LOD.detail > 1 ? 14 : LOD.detail ? 10 : 7;
  if (type === 'flat') { lathe('roof', [cx, 0, cz], [[R + 0.15, top], [R + 0.15, top + 0.5]], sides, { cap: true }); return top + 0.5; }
  if (type === 'dome') {
    const prof = [[Re, top - th]];
    for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI / 2; prof.push([Math.max(0.001, Math.cos(a) * Re), top + Math.sin(a) * Re * 0.85]); }
    lathe('roof', [cx, 0, cz], prof, sides);
    lathe('roof', [cx, 0, cz], [[0.001, top - th], [Re, top - th]], sides, { color: [0.6, 0.6, 0.6] });
    blob('metal', [cx, top + Re * 0.85 + 0.12, cz], 0.14);
    return top + Re * 0.85 + 0.25;
  }
  const Hc = Re * Math.tan(plan.pitch) * (1.1 + 0.45 * S), k = 1 + 0.8 * S, n = LOD.detail > 1 ? 9 : 5;
  const prof = [[Re, top - th], [Re, top - ov * 0.3]];
  for (let i = 1; i <= n; i++) { const t = i / n; prof.push([Math.max(0.01, Re * (1 - t) ** k), top - ov * 0.3 + Hc * t]); }
  const leanAmt = S * 0.45 * Re, leanFn = (t) => leanAmt * Math.max(0, (t - 0.3) / 0.7) ** 2;
  lathe('roof', [cx, 0, cz], prof, sides, { lean: leanFn });
  lathe('roof', [cx, 0, cz], [[0.001, top - th], [Re, top - th]], sides, { color: [0.6, 0.6, 0.6] });
  blob('metal', [cx + leanFn(1), top - ov * 0.3 + Hc + 0.08, cz], 0.12 + 0.04 * S);
  return top + Hc;
}

function towerMass() {
  const T = plan.tower; if (!T) return;
  const { fh, plinth, floors } = plan, levels = floors + T.extra, top = plinth + levels * fh * 0.94;
  const part = ST.tower.material === 'base' ? 'base' : 'wall', sides = LOD.detail > 1 ? 12 : 8;
  lathe('base', [T.x, 0, T.z], [[T.R + 0.18, -0.6], [T.R + 0.18, plinth]], sides, { cap: true });
  lathe(part, [T.x, 0, T.z], [[T.R, plinth], [T.R * (1 - 0.05 * S), top]], sides, { cap: true, flat: S > 0.4 });
  for (let l = 1; l <= levels; l++) lathe('trim', [T.x, 0, T.z], [[T.R + 0.06, plinth + l * fh * 0.94 - STY.trim * 0.6], [T.R + 0.06, plinth + l * fh * 0.94]], sides);
  ctx.towerTop = roofRound(T.x, T.z, T.R, top, T.roof);
  // Fönster åt de håll som pekar bort från huset
  for (let l = 1; l < levels; l++) for (const a of [Math.PI / 2, T.side > 0 ? 0 : Math.PI, Math.PI / 2 + T.side * 0.8]) {
    if ((l + Math.round(a * 3)) % 2 && l < levels - 1) continue;
    const f = radialFace(T.x, T.z, T.R * (1 - 0.05 * S * (l / levels)), a);
    windowAt({ u: 0, y: plinth + l * fh * 0.94 + fh * 0.3, w: 0.7 * STY.open, h: 1.05 * STY.open, shape: ST.window.shape === 'strip' ? 'rect' : ST.window.shape, lit: true }, f);
  }
}
function wingMass() {
  const Wg = plan.wing; if (!Wg) return;
  const { W, plinth, fh } = plan, cx = Wg.side * (W / 2 + Wg.w / 2 - 0.05), top = plinth + fh * 0.92;
  box('base', [cx, (plinth - 0.6) / 2, 0], [Wg.w + 0.26, plinth + 0.6, Wg.d + 0.26], { bevel: 0.06 + 0.06 * S });
  box('wall', [cx, plinth + (top - plinth) / 2, 0], [Wg.w, top - plinth, Wg.d], { bevel: 0.05 + 0.08 * S });
  box('trim', [cx, top - STY.trim * 0.4, 0], [Wg.w + 0.1, STY.trim * 0.8, Wg.d + 0.1]);
  if (Wg.roof === 'flat') { box('roof', [cx, top + 0.15, 0], [Wg.w + 0.3, 0.3, Wg.d + 0.3]); }
  else { // pulpettak som lutar bort från huset
    const q = 0.42, run = Wg.w + STY.overhang, L = run / Math.cos(q), th = ROOF_T();
    const down = [Wg.side * Math.cos(q), -Math.sin(q), 0], nn = [Wg.side * Math.sin(q), Math.cos(q), 0];
    const a = [Wg.side * (W / 2 - 0.05), top + Wg.w * Math.tan(q), 0];
    box('roof', add(add(a, mul(down, L / 2)), mul(nn, th / 2)), [L, th, Wg.d + 2 * STY.overhang * 0.7], { ax: [down, nn, [0, 0, 1]] });
  }
  const f = { name: 'wing', o: [cx, 0, Wg.d / 2], t: [1, 0, 0], n: [0, 0, 1], len: Wg.w };
  windowAt({ u: 0, y: plinth + fh * 0.32, w: Math.min(Wg.w - 0.8, 0.95 * STY.open), h: 1.2 * STY.open, shape: ST.window.shape, shutters: ST.window.shutters > 0.5, flower: (ST.flowerboxes ?? 0) > 0.3 }, f);
}

function chimneys(roof) {
  if (plan.round) return;
  const { W, D } = plan, A = plan.ridgeX ? W : D, B = plan.ridgeX ? D : W;
  plan.chimneyPos.forEach((cp, i) => i === 0 && plan.gableChimney ? gableChimney(roof, A, B) : null);
  for (const cp of plan.chimneyPos.slice(plan.gableChimney ? 1 : 0)) {
    const along = cp.x * Math.max(0.5, A / 2 - 1.0), across = cp.z * (B / 2) * 0.7;
    const top = roof.ridge + 0.7 + 0.5 * S, bottom = plan.wallTop - 0.4, cs = 0.62 + 0.32 * S;
    const c = sw([along, 0, across]);
    ctx.chimneys.push({ bottom, top, surface: roof.surface(along, across) });
    if (ST.chimney === 'metal') {
      lathe('metal', [c[0], 0, c[2]], [[0.2, bottom], [0.2, top], [0.28, top], [0.28, top + 0.12], [0.001, top + 0.3]], LOD.detail ? 10 : 6);
      if (LOD.detail > 0) for (const y of [roof.surface(along, across) + 0.4, top - 0.4]) lathe('metal', [c[0], 0, c[2]], [[0.25, y], [0.25, y + 0.08]], 10);
      continue;
    }
    box('base', [c[0], (bottom + top) / 2, c[2]], [cs, top - bottom, cs], { bevel: 0.04 + 0.04 * S });
    box(ST.chimney === 'brick' ? 'trim' : 'base', [c[0], top + 0.09, c[2]], [cs + 0.2, 0.18, cs + 0.2], { color: [0.85, 0.85, 0.85] });
    if (LOD.detail > 0) lathe('metal', [c[0], 0, c[2]], [[0.11, top + 0.15], [0.11, top + 0.42], [0.14, top + 0.45]], 8, { color: [0.6, 0.45, 0.4] });
    chimneyCap([c[0], top + 0.18, c[2]], cs);
  }
}

// Utvändig skorsten på gaveln: bred fot, avsmalnande axel och en smal pipa genom takfoten (som i referenserna)
function gableChimney(roof, A, B) {
  const x = plan.chimneySide * (A / 2 + 0.42 + 0.12 * S), z = plan.chimneyAcross * (B / 2);
  const cs = 0.75 + 0.3 * S, foot = cs * 1.55, sh = plan.wallTop * 0.5, top = roof.ridge + 0.6 + 0.5 * S;
  const bevel = 0.05 + 0.05 * S;
  box('base', [x, (sh - 0.3) / 2, z], [foot * 0.9, sh + 0.3, foot], { bevel });
  // Avsmalnande axel: en fyrsidig stympad pyramid
  lathe('base', [x, 0, z], [[foot * 0.68, sh], [cs * 0.72, sh + 1.1]], 4, { flat: true, rot: Math.PI / 4 });
  box('base', [x, (sh + 1.1 + top) / 2, z], [cs, top - sh - 1.1, cs], { bevel });
  box('base', [x, top + 0.1, z], [cs + 0.22, 0.2, cs + 0.22], { color: [0.85, 0.85, 0.85] });
  ctx.chimneys.push({ bottom: -0.3, top, surface: roof.ridge - 0.6, exterior: true });
  chimneyCap([x, top + 0.2, z], cs);
}
// Liten huv på skorstenen (trästolpar och ett pyramidtak), som i referenserna
function chimneyCap(c, cs) {
  if (LOD.detail === 0 || !(ST.chimneyCap > 0) || rng(plan.detailSeed + 7)() > ST.chimneyCap) return;
  const h = 0.45, t = 0.08;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box('trim', add(c, [sx * cs * 0.36, h / 2, sz * cs * 0.36]), [t, h, t]);
  lathe('roof', add(c, [0, h, 0]), [[cs * 0.85, 0], [cs * 0.85, 0.08], [0.02, 0.55]], 4, { flat: true, rot: Math.PI / 4 });
}
// Takkupor: en liten gavel med fönster som sticker ut ur takfallet
function dormers(roof) {
  if (!roof.prof || !plan.dormers.length) return;
  const prof = roof.prof, A = plan.ridgeX ? plan.W : plan.D, hd = (plan.ridgeX ? plan.D + 2 * (plan.floors > 1 ? plan.jetty : 0) : plan.W) / 2;
  const dw = 1.35 + 0.25 * S, dh = 1.35 + 0.2 * S, fa = hd * 0.6, th = ROOF_T() * 0.8;
  for (const d of plan.dormers) {
    const along = d.t * A;
    if (Math.abs(along) + dw / 2 > A / 2 - 0.4) continue;
    if (plan.tower && plan.ridgeX && Math.sign(along) === plan.tower.side && Math.abs(along) > A / 2 - plan.tower.R - dw) continue;
    for (const s of d.back ? [1, -1] : [1]) {
      const yr = prof.y(fa) - 0.1;
      let dd = 0.6; // djupet in i taket tills taket ligger över kupans tak
      while (prof.y(Math.max(0, fa - dd)) < yr + dh + 0.6 && dd < fa) dd += 0.2;
      const P = (al, y, ac) => sw([al, y, s * ac]);
      box('wall', P(along, yr + dh / 2, fa - dd / 2), sw([dw, dh, dd]), { bevel: 0.05 + 0.05 * S });
      // Kupans gavel och tak (nock rakt ut från taket)
      const q = 0.85, rise = (dw / 2 + 0.2) * Math.tan(q) * 0.75, ytop = yr + dh, front = fa + 0.22;
      polygon('wall', [P(along - dw / 2, ytop, fa + 0.005), P(along + dw / 2, ytop, fa + 0.005), P(along, ytop + rise, fa + 0.005)], sw([0, 0, s]));
      for (const side of [-1, 1]) {
        const a = P(along, ytop + rise + th * 0.5, 0), b = P(along + side * (dw / 2 + 0.22), ytop - 0.08 + th * 0.5, 0);
        const mid = (x) => add(x, sw([0, 0, s * (front - (dd + 0.22) / 2)]));
        slab('roof', mid(a), mid(b), th, dd + 0.22, sw([0, 0, 1]));
      }
      if (LOD.detail > 0) box('trim', P(along, ytop + rise + th * 0.9, front - (dd + 0.22) / 2), sw([th * 1.2, th, dd + 0.3]), { color: [0.9, 0.9, 0.9] });
      const f = { name: 'dormer', o: P(along, 0, fa), t: sw([s, 0, 0]), n: sw([0, 0, s]), len: dw };
      windowAt({ u: 0, y: yr + 0.25, w: Math.min(dw - 0.55, 0.75 * STY.open), h: Math.min(dh - 0.5, 0.95 * STY.open), shape: ST.window.shape === 'strip' ? 'rect' : ST.window.shape === 'round' ? 'round' : ST.window.shape, lit: true }, f);
    }
  }
}
// Hörnkedjor: stenblock i hörnen, växelvis långa och korta
function quoins() {
  if (!ST.quoins || LOD.detail < 2 || plan.round) return;
  const { W, D, fh, plinth, floors, stoneGround } = plan, h = 0.34, t = 0.3;
  const levels = stoneGround ? 1 : ST.timber ? 0 : floors;
  for (let fl = 0; fl < levels; fl++) {
    const y0 = plinth + fl * fh, jw = fl > 0 ? plan.jetty : 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (plan.tower && sx === plan.tower.side && sz === 1) continue;
      if (plan.wing && fl === 0 && sx === plan.wing.side) continue;
      for (let k = 0; k < Math.floor(fh / h); k++) {
        const long = k % 2 ? [0.62, 0.34] : [0.34, 0.62];
        const cx = sx * (W / 2 - long[0] / 2 + 0.05), cz = sz * (D / 2 + jw - long[1] / 2 + 0.05);
        box('base', [cx, y0 + (k + 0.5) * h, cz], [long[0], h - 0.03, long[1]], { color: [1.05, 1.05, 1.05] });
      }
    }
  }
}
// Kullerstenar i sockeln: kantiga stenar som sticker ut lite runt hela grunden
function rubble() {
  if (!ST.rubble || LOD.detail < 1 || plan.round) return;
  const rd = rng(plan.detailSeed + 3), { W, D, plinth } = plan, step = LOD.detail > 1 ? 0.5 : 0.9;
  for (const f of faces(W + 0.26, D + 0.26)) {
    const door = f.name === 'front' ? layout.openings.find((o) => o.kind === 'door' && o.face === 'front') : null;
    for (let u = -f.len / 2 + 0.25; u < f.len / 2 - 0.2; u += step * (0.8 + rd() * 0.4)) {
      if (door && Math.abs(u - door.u) < door.w / 2 + 0.6) continue;
      const w = 0.32 + rd() * 0.26, hh = Math.min(plinth + 0.25, 0.24 + rd() * 0.22), k = 0.85 + rd() * 0.25;
      box('base', onFace(f, u, hh / 2 - 0.08 + rd() * 0.06, 0.04 + rd() * 0.05), [w, hh, 0.22], { ax: faceAx(f), color: [k, k, k] });
    }
  }
}

// ---------- Rankor och props ----------
function vines() {
  if (LOD.detail === 0 && vinePlan.length === 0) return;
  for (const v of vinePlan) {
    const rv = rng(v.seed), f = faceByName(v.face, 0);
    if (!f) continue;
    const maxY = plan.plinth + plan.fh * (plan.jetty > 0 ? 0.95 : Math.min(plan.floors, 1.7));
    const open = layout.openings.filter((o) => o.face === v.face);
    let u = (v.t - 0.5) * (f.len - 1.2), y = 0, prev = onFace(f, u, 0, 0.05);
    const step = 0.28;
    while (y < maxY) {
      y += step;
      u += (rv() - 0.5) * 0.3;
      const hit = open.find((o) => Math.abs(u - o.u) < o.w / 2 + 0.25 && y > o.y - 0.4 && y < o.y + o.h + 0.2);
      if (hit) u = hit.u + Math.sign(u - hit.u || 1) * (hit.w / 2 + 0.3);
      u = Math.max(-f.len / 2 + 0.2, Math.min(f.len / 2 - 0.2, u));
      const p = onFace(f, u, y, 0.06);
      if (LOD.detail > 0) beam('flora', prev, p, 0.04, 0.04, { color: srgb('#5A4A2A'), segs: 0 });
      prev = p;
      const leaves = LOD.detail > 1 ? 2 : LOD.detail ? 1 : rv() < 0.3 ? 1 : 0;
      for (let k = 0; k < leaves; k++) {
        const lu = u + (rv() - 0.5) * 0.55, ly = y + (rv() - 0.5) * 0.3, rad = (0.16 + rv() * 0.12) * (LOD.detail > 1 ? 1 : LOD.detail ? 1.3 : 1.8);
        blob('flora', onFace(f, lu, ly, 0.08), rad, { sc: [1, 0.85, 1].map((x, i) => (Math.abs(f.n[i]) > 0.5 ? 0.45 : x)), color: srgb(LEAF[Math.floor(rv() * LEAF.length)]).map((c) => c * (0.85 + rv() * 0.3)), w: 0.15 });
      }
    }
  }
}
function propsAround() {
  if (LOD.detail === 0) return;
  const front = faceByName('front', 0), door = layout.openings.find((o) => o.kind === 'door' && !o.round);
  // Sidor där flygeln eller tornet står är upptagna
  const busy = new Set([plan.wing && (plan.wing.side > 0 ? 'right' : 'left'), plan.tower && (plan.tower.side > 0 ? 'right' : 'left')].filter(Boolean));
  const spot = (pr) => { // en plats längs framsidan eller en fri sida, inte framför dörren eller trappan
    const want = pr.side > 0 ? 'right' : 'left', alt = pr.side > 0 ? 'left' : 'right';
    const sideName = !busy.has(want) ? want : !busy.has(alt) ? alt : null;
    const f = (pr.t < 0.5 || !door) && sideName ? faceByName(sideName, 0) : front;
    let u = (pr.t - 0.5) * (f.len - 1.6);
    if (f === front && door && Math.abs(u - door.u) < door.w / 2 + 1.3) u = door.u + Math.sign(u - door.u || 1) * (door.w / 2 + 1.4);
    return { f, u };
  };
  const metal = { color: [1, 1, 1] };
  for (const pr of propPlan) {
    const { f, u } = spot(pr), ax = faceAx(f), base = (out) => onFace(f, u, 0, out);
    switch (pr.name) {
      case 'barrel': {
        const c = base(0.65), rb = 0.32 * pr.s;
        lathe('door', c, [[rb * 0.85, 0], [rb, 0.4 * pr.s], [rb * 0.85, 0.85 * pr.s]], 12, { cap: true });
        for (const y of [0.15, 0.7]) lathe('metal', c, [[rb * 0.93 + 0.01, y * pr.s], [rb * 0.97 + 0.015, (y + 0.05) * pr.s]], 12);
        break;
      }
      case 'pots': { // terrakottakrukor med blommor vid trappan
        if (!door) break;
        const fs = front, n = 2 + Math.floor(pr.t * 3);
        for (let i = 0; i < n; i++) {
          const side = i % 2 ? 1 : -1, uu = door.u + side * (door.w / 2 + 0.75 + Math.floor(i / 2) * 0.55), rp = 0.18 + (i % 3) * 0.05;
          const c = onFace(fs, uu, 0, 0.42 + (i % 2) * 0.12);
          lathe('door', c, [[rp * 0.7, 0], [rp, rp * 1.6], [rp * 1.12, rp * 1.75]], 10, { cap: true, color: [1.0, 0.55, 0.38] });
          blob('flora', add(c, [0, rp * 1.9, 0]), rp * 1.15, { color: srgb(LEAF[i % LEAF.length]), w: 0.2 });
          for (let k = 0; k < 3; k++) blob('flora', add(c, [Math.cos(k * 2.1 + i) * rp * 0.6, rp * 2.4, Math.sin(k * 2.1 + i) * rp * 0.6]), 0.07, { color: srgb(PETALS[(i + k) % PETALS.length]), w: 0.3 });
        }
        break;
      }
      case 'crate': box('door', add(base(0.7), [0, 0.33 * pr.s, 0]), [0.66 * pr.s, 0.66 * pr.s, 0.66 * pr.s], { ax, color: [0.95, 0.85, 0.75] }); break;
      case 'bench':
        box('door', onFace(f, u, 0.45, 0.45), [1.4, 0.09, 0.42], { ax });
        for (const s of [-1, 1]) box('door', onFace(f, u + s * 0.55, 0.22, 0.45), [0.1, 0.45, 0.36], { ax });
        break;
      case 'woodpile':
        for (let row = 0; row < 3; row++) for (let i = 0; i < 4 - row; i++) beam('door', onFace(f, u - 0.45, 0.12 + row * 0.2, 0.4 + (i - (3 - row) / 2) * 0.21 + row * 0.1), onFace(f, u + 0.45, 0.12 + row * 0.2, 0.4 + (i - (3 - row) / 2) * 0.21 + row * 0.1), 0.19, 0.19, { color: [0.9, 0.75, 0.6] });
        break;
      case 'sign': { // hängande skylt på väggen bredvid dörren
        if (!door) break;
        const fs = front, su = door.u + (door.u > 0 ? -1 : 1) * (door.w / 2 + 1.1), sy = door.y + door.h + 0.35;
        beam('metal', onFace(fs, su, sy, 0), onFace(fs, su, sy, 0.75), 0.05);
        box('door', onFace(fs, su, sy - 0.32, 0.45), [0.06, 0.45, 0.65], { ax: faceAx(fs), color: [1, 0.9, 0.75] });
        break;
      }
      case 'pipes':
        for (const du of [0, 0.32]) lathe('metal', onFace(f, u + du, 0, 0.18), [[0.1, 0], [0.1, plan.wallTop - 0.3]], 8, metal);
        if (LOD.detail > 1) for (let y = 0.6; y < plan.wallTop - 0.4; y += 1.4) for (const du of [0, 0.32]) lathe('metal', onFace(f, u + du, 0, 0.18), [[0.14, y], [0.14, y + 0.08]], 8);
        break;
      case 'gear': {
        const c = onFace(f, u, plan.plinth + plan.fh * 0.6, 0.05), gr = 0.55;
        beam('metal', c, onFace(f, u, plan.plinth + plan.fh * 0.6, 0.14), gr * 2, gr * 2, { segs: 1 });
        if (LOD.detail > 1) for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; box('metal', onFace(f, u + Math.cos(a) * (gr + 0.08), plan.plinth + plan.fh * 0.6 + Math.sin(a) * (gr + 0.08), 0.1), [0.16, 0.16, 0.1], { ax }); }
        blob('metal', onFace(f, u, plan.plinth + plan.fh * 0.6, 0.16), 0.12);
        break;
      }
      case 'mailbox':
        box('metal', onFace(faceByName('front', 0), (door?.u ?? 0) + 2.2, 0.55, (ctx.stairs?.depth ?? 0.5) + 1.2), [0.08, 1.1, 0.08], {});
        box('metal', onFace(faceByName('front', 0), (door?.u ?? 0) + 2.2, 1.15, (ctx.stairs?.depth ?? 0.5) + 1.2), [0.3, 0.26, 0.45], { color: [1.2, 0.5, 0.45] });
        break;
      case 'ac': {
        const y = plan.plinth + Math.min(plan.floors - 1, 1) * plan.fh + plan.fh * 0.25;
        box('metal', onFace(f, u, y, 0.32), [0.9, 0.6, 0.6], { ax, color: [2.2, 2.2, 2.3] });
        if (LOD.detail > 1) lathe('metal', onFace(f, u + 0.15, y - 0.2, 0.62), [[0.001, 0], [0.22, 0], [0.22, 0.4], [0.001, 0.4]], 10, { color: [0.4, 0.4, 0.4] });
        break;
      }
      case 'bin': lathe('metal', base(0.6), [[0.26, 0], [0.3, 0.9], [0.33, 0.95]], 10, { cap: true, color: [0.7, 0.75, 0.7] }); break;
      case 'planter':
        box('trim', add(base(0.7), [0, 0.25, 0]), [0.8, 0.5, 0.8], { ax });
        blob('flora', add(base(0.7), [0, 0.75, 0]), 0.45, { color: srgb(LEAF[0]), w: 0.2 });
        break;
      case 'neon': { // skylt i neon ovanför dörren
        if (!door) break;
        const fs = front, ny = door.y + door.h + 0.9, col = (ST.window.glassAlt ?? [ST.lantern.light])[Math.floor(pr.t * 3) % (ST.window.glassAlt?.length ?? 1)];
        box('metal', onFace(fs, door.u, ny, 0.1), [1.8, 0.6, 0.12], { ax: faceAx(fs) });
        for (let k = 0; k < 4; k++) box(`neon:${col}`, onFace(fs, door.u - 0.6 + k * 0.4, ny, 0.18), [0.06, 0.4, 0.05], { ax: faceAx(fs), segs: 1 });
        box(`neon:${col}`, onFace(fs, door.u, ny + 0.2, 0.18), [1.5, 0.05, 0.05], { ax: faceAx(fs), segs: 1 });
        break;
      }
      case 'cables': {
        const y = plan.wallTop - 0.6;
        for (let k = 0; k < 3; k++) {
          const a = onFace(f, -f.len / 2 + 0.3, y - k * 0.25, 0.08), b = onFace(f, f.len / 2 - 0.3, y - k * 0.3, 0.08);
          let prev = a;
          for (let i = 1; i <= 6; i++) { const t = i / 6, p = add(add(mul(a, 1 - t), mul(b, t)), [0, -Math.sin(Math.PI * t) * 0.45, 0]); beam('metal', prev, p, 0.035, 0.035, { segs: 0, color: [0.3, 0.3, 0.3] }); prev = p; }
        }
        break;
      }
      case 'antenna': case 'solar': ctx.roofProps.push(pr.name); break;
      default: break;
    }
  }
}
function roofProps(roof) {
  for (const name of ctx.roofProps) {
    if (name === 'antenna') {
      const c = plan.roofType === 'flat' ? [plan.W * 0.25, roof.ridge - 0.3, -plan.D * 0.2] : sw([plan.W * 0.2 * (plan.ridgeX ? 1 : 0) + plan.D * 0.2 * (plan.ridgeX ? 0 : 1), roof.ridge, 0]);
      beam('metal', c, add(c, [0, 2.2, 0]), 0.06);
      if (LOD.detail > 0) for (const y of [1.2, 1.7, 2.1]) beam('metal', add(c, [-0.4, y, 0]), add(c, [0.4, y, 0]), 0.04);
    }
    if (name === 'solar' && plan.roofType === 'flat') for (let i = 0; i < 2; i++) {
      const c = [-plan.W * 0.15 + i * 1.3, roof.ridge - 0.3 + 0.45, plan.D * 0.1], q = 0.5;
      box('glass', c, [1.1, 0.06, 1.6], { ax: [[1, 0, 0], [0, Math.cos(q), Math.sin(q)], [0, -Math.sin(q), Math.cos(q)]], color: [0.5, 0.6, 1.2] });
    }
  }
}

// ---------- Skevhet, skuggning, LOD ----------
function deform(H, roofInfo) {
  const A = STY.wonk * H, [lx, lz] = plan.lean, ph = plan.phases;
  const ext = (plan.ridgeX ? plan.W : plan.D) / 2 + STY.overhang;
  for (const g of Object.values(G)) for (let i = 0; i < g.positions.length; i += 3) {
    const x = g.positions[i], y = g.positions[i + 1], z = g.positions[i + 2];
    if (y <= 0) continue;
    const h = Math.min(1, y / H), s = h * h;
    g.positions[i] += A * (lx * s + 0.3 * Math.sin(y * 0.9 + ph[0]) * Math.sin(z * 0.45 + ph[1]) * h);
    g.positions[i + 2] += A * (lz * s * 0.6 + 0.3 * Math.sin(y * 0.8 + ph[2]) * Math.sin(x * 0.4 + ph[3]) * h);
    // Taket sviktar lite på mitten av nocken
    const along = plan.ridgeX ? x : z, roofT = clamp01((y - plan.wallTop) / Math.max(0.5, roofInfo.ridge - plan.wallTop));
    g.positions[i + 1] -= A * 0.45 * Math.max(0, 1 - (along / ext) ** 2) * roofT;
  }
}
function shadePass(H, roofInfo) {
  for (const [part, g] of Object.entries(G)) {
    if (/^(glass|glow|light|neon)/.test(part)) continue;
    for (let i = 0; i < g.positions.length / 3; i++) {
      const y = g.positions[i * 3 + 1];
      let k = part === 'roof' ? 0.82 + 0.18 * clamp01((y - roofInfo.eave) / Math.max(0.5, roofInfo.ridge - roofInfo.eave)) : 0.8 + 0.2 * clamp01(y / H);
      k *= 0.72 + 0.28 * clamp01((y + 0.1) / 0.9); // mörkare mot marken
      if (part !== 'roof' && y < plan.wallTop && y > plan.wallTop - 0.7) k *= 0.8 + 0.2 * clamp01((plan.wallTop - y) / 0.7); // under takfoten
      for (let c = 0; c < 3; c++) g.colors[i * 3 + c] *= k;
    }
  }
}
function buildLod(level) {
  G = {};
  LOD = [{ segs: BEVEL_SEGS, detail: 2 }, { segs: 1, detail: 1 }, { segs: 0, detail: 0 }][level];
  ctx = { rd: rng(plan.detailSeed), chimneys: [], roofProps: [], stairs: null, towerTop: 0 };
  let roofInfo;
  if (plan.round) {
    massRound();
    const top = roofRound(0, 0, plan.W / 2 * (1 - 0.06 * S), plan.wallTop, plan.roofType);
    roofInfo = { ridge: top, eave: plan.wallTop, surface: () => top };
  } else {
    massRect();
    const topD = plan.D + 2 * (plan.floors > 1 ? plan.jetty : 0);
    roofInfo = roofRect(plan.W, topD, plan.wallTop, plan.roofType);
    towerMass();
    wingMass();
    chimneys(roofInfo);
    dormers(roofInfo);
    quoins();
    rubble();
  }
  for (const o of layout.openings) {
    const f = o.round ? radialFace(0, 0, plan.W / 2 * (1 - 0.06 * S * ((o.y - plan.plinth) / (plan.wallTop - plan.plinth))), o.a) : faceByName(o.face, o.fl);
    if (o.kind === 'door') doorAt(o, f); else windowAt(o, f);
  }
  vines();
  propsAround();
  roofProps(roofInfo);
  const H = Math.max(roofInfo.ridge, ctx.towerTop, plan.wallTop);
  deform(H, roofInfo);
  shadePass(H, roofInfo);
  return { parts: G, H, roofInfo, chimneys: ctx.chimneys, stairs: ctx.stairs };
}

// ---------- glTF ----------
const lods = [0, 1, 2].map(buildLod);
const doc = new Document();
const emissiveExt = doc.createExtension(KHRMaterialsEmissiveStrength);
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const T = textures;
const tex = (file, nm) => sharedTexture(doc, file, nm, out);
const NAMES = { base: 'Base', wall: 'Wall', roof: 'Roof', trim: 'Trim', door: 'Door', glass: 'Glass', metal: 'Metal', flora: 'Flora' };
const ROUGH = { base: 0.9, wall: 0.88, roof: 0.82, trim: 0.8, door: 0.75, glass: 0.12, metal: 0.38, flora: 0.85 };
const matCache = {};
function getMat(part) {
  if (matCache[part]) return matCache[part];
  const [kind, hex] = part.split(':');
  let m;
  if (kind === 'glow' || kind === 'light' || kind === 'neon') {
    const strength = kind === 'glow' ? (ST.window.glow > 0 ? 1 + 2 * ST.window.glow : 0.85) : (ST.lantern?.glow ?? 2);
    m = doc.createMaterial(kind === 'glow' ? 'GlassGlow' : kind === 'neon' ? 'Neon' : 'Light').setRoughnessFactor(0.3).setMetallicFactor(0)
      .setBaseColorFactor([...lin(hex), 1]).setEmissiveFactor(lin(hex));
    m.setExtension('KHR_materials_emissive_strength', emissiveExt.createEmissiveStrength().setEmissiveStrength(strength));
  } else {
    m = doc.createMaterial(NAMES[kind] ?? kind).setRoughnessFactor(ROUGH[kind] ?? 0.85).setMetallicFactor(kind === 'metal' ? 1 : 0);
    const tint = kind === 'metal' ? ST.metal : kind === 'glass' ? ST.window.glass : plan.tints[kind];
    if (tint) m.setBaseColorFactor([...lin(tint), 1]);
    if (T[kind] && fs.existsSync(T[kind])) m.setBaseColorTexture(tex(T[kind], NAMES[kind]));
    if (T[`${kind}_normal`] && fs.existsSync(T[`${kind}_normal`])) m.setNormalTexture(tex(T[`${kind}_normal`], `${NAMES[kind]}_normal`)).setNormalScale(0.7);
  }
  return (matCache[part] = m);
}
function orient(g) {
  const Pp = (k) => [g.positions[k * 3], g.positions[k * 3 + 1], g.positions[k * 3 + 2]];
  const Nn = (k) => [g.normals[k * 3], g.normals[k * 3 + 1], g.normals[k * 3 + 2]];
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
    const fnn = cross(sub(Pp(b), Pp(a)), sub(Pp(c), Pp(a)));
    if (dot(fnn, add(add(Nn(a), Nn(b)), Nn(c))) < 0) { g.indices[i + 1] = c; g.indices[i + 2] = b; }
  }
}
const name = recipe.name ?? path.basename(out, path.extname(out));
const door0 = layout.openings.find((o) => o.kind === 'door');
const doorFace = door0 && (door0.round ? radialFace(0, 0, plan.W / 2, door0.a) : faceByName(door0.face, 0));
const entrances = door0 ? [{ pos: onFace(doorFace, door0.u ?? 0, 0, (lods[0].stairs?.depth ?? 0.4) + 0.6).map((v) => +v.toFixed(2)), yaw: +Math.atan2(doorFace.n[0], doorFace.n[2]).toFixed(3) }] : [];
const root = doc.createNode(name).setExtras({ generator: 'tinkertown/building@1', recipe: { preset, style, stylization: S, seed },
  footprint: [+plan.W.toFixed(2), +(plan.D + 2 * plan.jetty).toFixed(2)], height: +lods[0].H.toFixed(2), entrances });
const tris = [];
let minY = Infinity;
lods.forEach(({ parts }, i) => {
  const lodNode = doc.createNode(`${name}_LOD${i}`).setExtras({ lod: i });
  let t = 0;
  for (const [part, g] of Object.entries(parts)) {
    if (!g.indices.length) continue;
    orient(g);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', Float32Array.from(g.positions)))
      .setAttribute('NORMAL', acc('VEC3', Float32Array.from(g.normals)))
      .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(g.uvs)))
      .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(g.colors.map((c) => Math.min(1, c)))))
      .setAttribute('_WIND', acc('SCALAR', Float32Array.from(g.wind)))
      .setIndices(acc('SCALAR', Uint32Array.from(g.indices)))
      .setMaterial(getMat(part));
    const pn = part.replace(':#', '_');
    lodNode.addChild(doc.createNode(`${name}_${pn}_LOD${i}`).setMesh(doc.createMesh(`${pn}_LOD${i}`).addPrimitive(prim)));
    t += g.indices.length / 3;
    if (i === 0) for (let k = 1; k < g.positions.length; k += 3) minY = Math.min(minY, g.positions[k]);
  }
  root.addChild(lodNode);
  tris.push(Math.round(t));
});
doc.createScene(name).addChild(root);
fs.mkdirSync(path.dirname(out), { recursive: true });
await writeGltf(doc, out);

// ---------- Kontroller ----------
const doors = layout.openings.filter((o) => o.kind === 'door');
let overlaps = 0, outside = 0;
const flat = layout.openings.filter((o) => !o.round);
for (let i = 0; i < flat.length; i++) {
  const a = flat[i], f = faceByName(a.face, a.fl), ft = STY.trim;
  if (Math.abs(a.u) + a.w / 2 + ft > f.len / 2 + 1e-6) outside++;
  if (!a.gable && a.y + (a.shape === 'round' ? a.w : a.h) + ft > plan.plinth + (a.fl + 1) * plan.fh + 1e-6) outside++;
  for (let j = i + 1; j < flat.length; j++) {
    const b = flat[j];
    if (a.face !== b.face || a.fl !== b.fl) continue;
    const hy = (o) => [o.y, o.y + (o.shape === 'round' ? o.w : o.h)];
    const [a0, a1] = hy(a), [b0, b1] = hy(b);
    if (Math.abs(a.u - b.u) < (a.w + b.w) / 2 + 0.2 && a1 > b0 && b1 > a0) overlaps++;
  }
}
const ch = lods[0].chimneys;
const budget = STYLE_JSON.budgets_tris.building ?? [4000, 40000];
const checks = {
  doors: doors.length,
  stairs_reach_floor: plan.plinth <= 0.12 || (lods[0].stairs?.n ?? 0) > 0,
  openings_overlap: overlaps,
  openings_outside_wall: outside,
  chimneys_through_roof: ch.every((c) => c.bottom < c.surface && c.top > c.surface + 0.5), // utvändiga: står på marken och når över nocken
  grounded: minY < 0 && minY > -1,
  // Större hus är fler moduler (stilguiden: per modul): taket växer med roten ur golvytan mot ett hus på 2 × 60 m²
  within_budget: tris[0] <= budget[1] * Math.max(1, Math.sqrt((plan.W * plan.D * plan.floors) / 120)),
  lods_decrease: tris[0] > tris[1] && tris[1] > tris[2],
};
checks.ok = checks.doors >= 1 && checks.stairs_reach_floor && !overlaps && !outside && checks.chimneys_through_roof && checks.grounded && checks.within_budget && checks.lods_decrease;
console.log(JSON.stringify({ model: out, preset, style, stylization: S, size: [+plan.W.toFixed(2), +lods[0].H.toFixed(2), +(plan.D + 2 * plan.jetty).toFixed(2)],
  floors: plan.floors, roof: plan.roofType, tower: !!plan.tower, wing: !!plan.wing, windows: layout.openings.filter((o) => o.kind === 'window').length,
  props: propPlan.map((p) => p.name), vines: vinePlan.length, tris_lod: tris, textures: Object.keys(T).filter((k) => !k.endsWith('_normal')), checks }));
