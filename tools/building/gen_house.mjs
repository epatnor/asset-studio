// Husgeneratorn, version 2 (docs/buildings.md): hus av flera volymer med ett gemensamt tak, ur en hustyp i
// houses.json och en stil i buildings.json. Grafen (house/graph.mjs) bestämmer volymer, väggspann, öppningar och
// skorstenar; taklösaren (house/roof.mjs) ger taket där taken möts i ränndalar och nockar; här byggs geometrin ur
// grafen, en gång per LOD. Recept in, glTF ut (LOD0–LOD2), en rad JSON som svar.
//   node gen_house.mjs '{"archetype":"timber_house","style":"fantasy","stylization":"wow","seed":3,"out":"x.gltf","textures":{...}}'
import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { sharedTexture, writeGltf } from '../tree/gltf_write.mjs';
import { add, mul, norm, cross, sub, dot, clamp01 } from '../tree/vec.mjs';
import { planHouse, facePoint, makeRand } from './house/graph.mjs';
import { clip } from './house/roof.mjs';
import { createGeom } from './house/geom.mjs';

const DATA = JSON.parse(fs.readFileSync(new URL('./buildings.json', import.meta.url)));
const HOUSES = JSON.parse(fs.readFileSync(new URL('./houses.json', import.meta.url)));
const STYLE_JSON = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
const recipe = JSON.parse(process.argv[2] ?? '{}');
const { archetype = 'timber_house', style = 'fantasy', seed = 0, out, textures = {} } = recipe;
const fail = (msg) => { console.error(msg); process.exit(1); };
const A = HOUSES.archetypes[archetype];
if (!A) fail(`unknown archetype ${archetype}; available: ${Object.keys(HOUSES.archetypes).join(', ')}`);
if (!DATA._styles[style]) fail(`unknown style ${style}; available: ${Object.keys(DATA._styles).join(', ')}`);
if (!out) fail('out is required');
const ST = { ...DATA._styles[style], ...(recipe.style_params ?? {}) };
const S = typeof recipe.stylization === 'number' ? clamp01(recipe.stylization) : DATA._stylization[recipe.stylization ?? 'overwatch'] ?? 0.5;
// Stiliseringsgraden styr formspråket som i gen_building.mjs (0 nästan realistiskt, 0,5 Overwatch, 1 WoW)
const STY = { bevel: 0.03 + 0.06 * S, wonk: 0.001 + 0.04 * S * S, overhang: 0.18 + 0.62 * S, trim: 0.09 + 0.15 * S, open: 1 + 0.16 * S, depth: 0.06 + 0.07 * S };
const BEVEL_SEGS = STYLE_JSON.geometry?.bevel_segments ?? 2;
const r = makeRand(seed);
const pick = (key, list) => (Array.isArray(list) ? list[Math.floor(r(key) * list.length) % list.length] : list);
const lin = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);

const g = planHouse({ archetype: A, style: ST, sty: { S, overhang: STY.overhang, open: STY.open }, seed });
const { vols, roof, walls, openings, chimneys } = g;
const tints = Object.fromEntries(Object.entries(ST.tints ?? {}).map(([k, v]) => [k, pick(`tint:${k}`, v)]));
const ctx = { lod: { segs: BEVEL_SEGS, detail: 2 }, bevel: STY.bevel, tile: { base: 1.6, wall: 2.4, roof: 2.2, trim: 1.4, door: 1.3, glass: 1, metal: 1, flora: 1 } };
const geom = createGeom(ctx);
const { box, beam, slab, polygon, quad, blob } = geom;
const W3 = (f, s, y, out = 0) => { const [x, z] = facePoint(f, s, out); return [x, y, z]; };
const N3 = (f) => [f.n[0], 0, f.n[1]];
const T3 = (f) => [f.t[0], 0, f.t[1]];
const faceAx = (f) => [T3(f), [0, 1, 0], N3(f)];
const ROOF_T = 0.15 + 0.17 * S;
const timberStyle = !!ST.timber;

// Väggens kanter (lo, hi) i en punkt längs väggen: linjärt mellan grafens punkter
function edgeAt(W, s) {
  const P = W.pts;
  if (s <= P[0][0]) return [P[0][1], P[0][2]];
  for (let k = 1; k < P.length; k++) if (s <= P[k][0]) { const t = (s - P[k - 1][0]) / Math.max(1e-9, P[k][0] - P[k - 1][0]); return [P[k - 1][1] + (P[k][1] - P[k - 1][1]) * t, P[k - 1][2] + (P[k][2] - P[k - 1][2]) * t]; }
  return [P.at(-1)[1], P.at(-1)[2]];
}
const wallPart = (W) => (W.level === 0 && vols[W.v].stone ? 'base' : 'wall');
const openOf = (wi) => openings.filter((o) => o.wall === wi);
const opTop = (o) => o.y + o.h;

// ---------- Väggarna: ytan i lodräta remsor, med hål för öppningarna (inte i LOD2) ----------
function wallMesh(W, wi) {
  const f = W.face, n = N3(f), part = wallPart(W), holes = ctx.lod.detail > 0 ? openOf(wi) : [];
  const xs = new Set(W.pts.map((p) => p[0]));
  for (const o of holes) { xs.add(o.s - o.w / 2); xs.add(o.s + o.w / 2); }
  const s0w = f.o[0] * f.t[0] + f.o[1] * f.t[1]; // texturen löper i världen, så att grannväggar möts
  const tile = ctx.tile[part.split(':')[0]];
  const sorted = [...xs].sort((a, b) => a - b);
  for (let k = 0; k < sorted.length - 1; k++) {
    const sa = sorted[k], sb = sorted[k + 1];
    if (sb - sa < 1e-5) continue;
    const [loA, hiA] = edgeAt(W, sa + 1e-6), [loB, hiB] = edgeAt(W, sb - 1e-6);
    if (hiA - loA < 0.01 && hiB - loB < 0.01) continue;
    // Hålen som täcker hela remsan, nedifrån och upp
    const cut = holes.filter((o) => o.s - o.w / 2 <= sa + 1e-6 && o.s + o.w / 2 >= sb - 1e-6).map((o) => [o.y, opTop(o)]).sort((a, b) => a[0] - b[0]);
    // Lodräta bitar: [nedre (a, b), övre (a, b)]
    const pieces = [];
    let bot = [loA, loB];
    for (const [y0, y1] of cut) { pieces.push([bot, [Math.max(y0, loA), Math.max(y0, loB)]]); bot = [Math.min(Math.max(y1, loA), hiA), Math.min(Math.max(y1, loB), hiB)]; }
    pieces.push([bot, [hiA, hiB]]);
    for (const [[ba, bb], [ta, tb]] of pieces) {
      if (ta - ba < 1e-3 && tb - bb < 1e-3) continue;
      const P = [W3(f, sa, ba), W3(f, sb, bb), W3(f, sb, tb), W3(f, sa, ta)];
      const uv = [[s0w + sa, ba], [s0w + sb, bb], [s0w + sb, tb], [s0w + sa, ta]].map(([u, v]) => [u / tile, -v / tile]);
      quad(part, P, n, uv);
    }
  }
}

// ---------- Öppningarna: smyg, foder, bröstning, glas eller dörrblad ----------
const archy = (o) => o.shape === 'arch' || o.shape === 'round';
function openingMesh(o) {
  const W = walls[o.wall], f = W.face, n = N3(f), ax = faceAx(f), part = wallPart(W), dep = 0.28;
  const s0 = o.s - o.w / 2, s1 = o.s + o.w / 2, y0 = o.y, y1 = opTop(o), ft = STY.trim * 0.75, fd = STY.depth + 0.05;
  if (ctx.lod.detail === 0) { // LOD2: bara en platt ruta på väggen
    const pt = o.kind === 'door' ? 'door' : o.lit ? `glow:${ST.window?.litColor ?? '#FFB65A'}` : 'glass';
    polygon(pt, [W3(f, s0, y0, 0.02), W3(f, s1, y0, 0.02), W3(f, s1, y1, 0.02), W3(f, s0, y1, 0.02)], n);
    return;
  }
  // Smygen: hålets sidor in i väggen, så att fönstret ser djupt ut
  const side = (a, b, nn) => polygon(part, [a, b, add(b, mul(n, -dep)), add(a, mul(n, -dep))], nn);
  side(W3(f, s0, y1), W3(f, s0, y0), T3(f));
  side(W3(f, s1, y0), W3(f, s1, y1), mul(T3(f), -1));
  side(W3(f, s0, y0), W3(f, s1, y0), [0, 1, 0]);
  side(W3(f, s1, y1), W3(f, s0, y1), [0, -1, 0]);
  // Rundad överdel: väggen fyller hörnen ovanför bågen, och fodret följer bågen
  const R = o.w / 2, cy = y1 - R, arcN = ctx.lod.detail > 1 ? 8 : 5;
  const arc = (i) => { const a = Math.PI - (i / arcN) * Math.PI; return [o.s + Math.cos(a) * R, cy + Math.sin(a) * R]; };
  if (archy(o)) {
    for (const sd of [-1, 1]) {
      const pts = [W3(f, o.s + sd * R, y1, 0.001)];
      for (let i = 0; i <= arcN / 2; i++) { const [s, y] = arc(sd < 0 ? i : arcN - i); pts.push(W3(f, s, y, 0.001)); }
      polygon(part, sd < 0 ? pts : pts.reverse(), n);
    }
  }
  // Fodret
  const frameAt = (sa, ya, sb, yb) => beam('trim', W3(f, sa, ya, fd / 2), W3(f, sb, yb, fd / 2), ft, fd);
  frameAt(s0 - ft / 2, y0, s0 - ft / 2, archy(o) ? cy : y1 + ft / 2);
  frameAt(s1 + ft / 2, y0, s1 + ft / 2, archy(o) ? cy : y1 + ft / 2);
  if (archy(o)) for (let i = 0; i < arcN; i++) { const [sa, ya] = arc(i), [sb, yb] = arc(i + 1), k = (R + ft / 2) / R; frameAt(o.s + (sa - o.s) * k, cy + (ya - cy) * k, o.s + (sb - o.s) * k, cy + (yb - cy) * k); }
  else frameAt(s0 - ft, y1 + ft / 2, s1 + ft, y1 + ft / 2);
  if (o.kind === 'door') {
    // Dörrbladet (indraget), handtag, trappa upp till golvet, litet tak och en lykta
    const dt = 0.08, depth = -dep + 0.1;
    box('door', W3(f, o.s, (y0 + (archy(o) ? cy + R * 0.7 : y1)) / 2, depth), [o.w, (archy(o) ? cy + R * 0.7 : y1) - y0, dt], { ax });
    if (archy(o)) for (let i = 0; i < arcN; i++) { const [sa, ya] = arc(i), [sb, yb] = arc(i + 1); polygon('door', [W3(f, o.s, cy, depth + dt / 2), W3(f, sa, ya, depth + dt / 2), W3(f, sb, yb, depth + dt / 2)], n); }
    if (ctx.lod.detail > 1) blob('metal', W3(f, o.s + o.w * 0.32, y0 + 1.0, depth + 0.08), 0.05);
    const steps = Math.ceil(vols[W.v].plinth / 0.18);
    for (let i = 0; i < steps; i++) { const h = vols[W.v].plinth * (1 - i / steps); box('base', W3(f, o.s, h / 2 - 0.05, 0.18 + i * 0.3 + 0.15), [o.w + 0.6, h + 0.1, 0.32], { ax }); }
    if (ST.canopy && ctx.lod.detail > 1) { // litet sadeltak över dörren
      const top = y1 + ft + 0.35, wdt = o.w / 2 + 0.45, rise = 0.45 + 0.15 * S;
      for (const sd of [-1, 1]) slab('roof', W3(f, o.s, top + rise, 0.75), W3(f, o.s + sd * wdt, top, 0.75), 0.09, 1.3, n, { color: [0.9, 0.9, 0.9] });
      for (const sd of [-1, 1]) beam('trim', W3(f, o.s + sd * (wdt - 0.15), top - 0.05, 0.05), W3(f, o.s + sd * (wdt - 0.15), top - 0.05, 1.25), STY.trim * 0.6, STY.trim * 0.6);
    }
    if (ST.lantern && ctx.lod.detail > 0) {
      const ls = o.s + (o.w / 2 + 0.45), ly = y0 + Math.min(2.1, o.h * 0.85);
      box('metal', W3(f, ls, ly, 0.08), [0.06, 0.06, 0.16], { ax });
      box('metal', W3(f, ls, ly - 0.08, 0.2), [0.2, 0.04, 0.2], { ax });
      blob(`light:${ST.lantern.light ?? '#FFC46A'}`, W3(f, ls, ly - 0.22, 0.2), 0.1, { sc: [1, 1.3, 1] });
    }
    return;
  }
  // Fönster: bröstning, glas (lyser ibland), spröjs, luckor och blomlåda
  box('trim', W3(f, o.s, y0 - ft * 0.4, fd * 0.9), [o.w + ft * 3, ft * 0.8, fd * 1.8], { ax });
  const glass = o.lit ? `glow:${ST.window?.litColor ?? '#FFB65A'}` : 'glass', gd = -dep + 0.09;
  const gpts = archy(o) ? [W3(f, s0, y0, gd), W3(f, s1, y0, gd), W3(f, s1, cy, gd), ...Array.from({ length: arcN - 1 }, (_, i) => { const [s, y] = arc(arcN - 1 - i); return W3(f, s, y, gd); }), W3(f, s0, cy, gd)] : [W3(f, s0, y0, gd), W3(f, s1, y0, gd), W3(f, s1, y1, gd), W3(f, s0, y1, gd)];
  polygon(glass, gpts, n);
  if (ST.window?.mullions !== false && ctx.lod.detail > 1) {
    const m = ft * 0.45;
    beam('trim', W3(f, o.s, y0, gd + 0.02), W3(f, o.s, archy(o) ? y1 - 0.02 : y1, gd + 0.02), m, m);
    beam('trim', W3(f, s0, y0 + (archy(o) ? (cy - y0) * 0.6 : o.h * 0.55), gd + 0.02), W3(f, s1, y0 + (archy(o) ? (cy - y0) * 0.6 : o.h * 0.55), gd + 0.02), m, m);
  }
  if (o.shutters && ctx.lod.detail > 1) for (const sd of [-1, 1]) box('door', W3(f, o.s + sd * (o.w * 0.75 + ft), (y0 + (archy(o) ? cy : y1)) / 2, 0.05), [o.w * 0.48, (archy(o) ? cy : y1) - y0, 0.05], { ax });
  if (o.flower && ctx.lod.detail > 1) {
    box('trim', W3(f, o.s, y0 - 0.22, 0.22), [o.w + 0.2, 0.22, 0.26], { ax });
    const rd = makeRand(seed + o.wall * 31 + Math.round(o.s * 10));
    const petals = ['petal_red', 'petal_yellow', 'petal_pink', 'petal_white', 'petal_purple'].map((k) => STYLE_JSON.palette?.[k]).filter(Boolean);
    for (let i = 0; i < 6; i++) blob(`flora:${petals[Math.floor(rd(`p${i}`) * petals.length)] ?? '#E06070'}`, W3(f, s0 + (i + 0.5) * (o.w / 6), y0 - 0.08 + rd(`y${i}`) * 0.08, 0.24), 0.09, { sc: [1, 0.8, 1] });
  }
}

// ---------- Korsvirke, hörn, våningsband och utkragningens bjälkar ----------
function framing(W, wi) {
  if (ctx.lod.detail === 0) return;
  const V = vols[W.v], f = W.face, ax = faceAx(f), t = STY.trim * 0.8, o = t * 0.3, ops = openOf(wi), stone = W.level === 0 && V.stone;
  const clear = (a, b) => !ops.some((p) => b > p.s - p.w / 2 - STY.trim * 1.4 && a < p.s + p.w / 2 + STY.trim * 1.4 && !p.gable);
  for (const [s0, s1] of W.runs) {
    if (W.level > 0) box('trim', W3(f, (s0 + s1) / 2, W.yb, o * 2), [s1 - s0 + 0.1, STY.trim * 1.1, t * 1.2], { ax }); // våningsband
    if (stone) { // hörnkedja av stenar i de yttre hörnen
      if (ST.quoins && ctx.lod.detail > 1) for (const sEnd of [s0, s1]) {
        if (Math.min(sEnd, f.len - sEnd) > 0.05) continue;
        for (let y = W.yb + 0.05, k = 0; y < W.yt - 0.3; y += 0.42, k++) box('base', W3(f, sEnd + (sEnd < f.len / 2 ? 1 : -1) * (k % 2 ? 0.28 : 0.2), y + 0.18, 0.04), [k % 2 ? 0.58 : 0.42, 0.34, 0.12], { ax, color: [1.08, 1.08, 1.08] });
      }
      continue;
    }
    if (!timberStyle) continue;
    box('trim', W3(f, (s0 + s1) / 2, W.yb + t / 2 + 0.02, o), [s1 - s0, t, t * 0.6], { ax }); // syll
    box('trim', W3(f, (s0 + s1) / 2, W.yt - t / 2, o), [s1 - s0, t, t * 0.6], { ax }); // hammarband
    const L = s1 - s0, nb = Math.max(1, Math.round(L / (1.25 * STY.open))), bw = L / nb;
    for (let i = 0; i <= nb; i++) {
      const s = s0 + i * bw, corner = Math.min(s, f.len - s) < 0.05;
      if (!corner && !clear(s - t, s + t)) continue;
      box('trim', W3(f, s + (i === 0 ? t / 2 : i === nb ? -t / 2 : 0), (W.yb + W.yt) / 2, o), [corner ? t * 1.3 : t, W.yt - W.yb, corner ? t * 1.1 : t * 0.6], { ax });
    }
    if (ctx.lod.detail > 1) for (let i = 0; i < nb; i++) {
      const a = s0 + i * bw + t, b = a + bw - 2 * t;
      if (b - a < 0.4 || !clear(a, b)) continue;
      const flip = (i + W.level) % 2;
      beam('trim', W3(f, flip ? b : a, W.yb + t, o), W3(f, flip ? a : b, W.yt - t, o), t * 0.85, t * 0.55);
    }
  }
  // Gavelröstet: kungsstolpe och hanbjälke
  if (timberStyle && W.isTop && ctx.lod.detail > 0 && !stone) {
    let top = W.pts[0];
    for (const p of W.pts) if (p[2] > top[2]) top = p;
    if (top[2] > W.yt + 0.8 && top[1] <= W.yt + 0.05) {
      beam('trim', W3(f, top[0], W.yt, o), W3(f, top[0], top[2] - 0.15, o), t, t * 0.6);
      const yc = W.yt + (top[2] - W.yt) * 0.45, sAt = (dir) => { let s = top[0]; while (s > 0 && s < f.len && edgeAt(W, s)[1] > yc + 0.05) s += dir * 0.05; return s; };
      const a = sAt(-1), b = sAt(1);
      if (b - a > 0.6 && !openOf(wi).some((p) => p.gable && Math.abs(p.y + p.h / 2 - yc) < p.h / 2 + 0.2)) beam('trim', W3(f, a + 0.1, yc, o), W3(f, b - 0.1, yc, o), t, t * 0.6);
    }
  }
  // Utkragningen: bjälkändar under övervåningen där den sticker ut
  if (W.level > 0 && V.jetty > 0 && V.jettySides.includes(f.name) && ctx.lod.detail > 0) {
    for (const [s0, s1] of W.runs) for (let s = s0 + 0.35; s < s1 - 0.2; s += 0.7)
      box('trim', W3(f, s, W.yb - STY.trim * 0.55, -V.jetty / 2 + 0.05), [STY.trim * 0.8, STY.trim * 0.9, V.jetty + 0.25], { ax });
  }
}

// ---------- Sockeln ----------
function plinths() {
  for (const V of vols) {
    const [x0, z0, x1, z1] = V.levelRects[0];
    box('base', [(x0 + x1) / 2, (V.plinth - 0.6) / 2, (z0 + z1) / 2], [x1 - x0 + 0.26, V.plinth + 0.6, z1 - z0 + 0.26], { bevel: 0.06 + 0.06 * S });
  }
}

// ---------- Taket ur taklösaren ----------
function roofMesh() {
  const th = ROOF_T, rd = makeRand(seed * 7 + 3), moss = ST.roof?.moss ?? (style === 'fantasy' || style === 'rpg' ? 0.35 : 0);
  const mossC = lin('#8FB050').map((v) => Math.min(1, v * 2.2));
  // Mossa i mjuka fläckar (ett lågfrekvent brus över taket), mer där taket ligger lågt och i skugga
  const ph = [0, 1, 2, 3].map((i) => rd(`mph${i}`) * 6.28);
  const mossAt = (x, z) => moss <= 0 ? 0 : clamp01((Math.sin(x * 0.8 + ph[0]) * Math.sin(z * 0.9 + ph[1]) + 0.6 * Math.sin(x * 0.31 + z * 0.37 + ph[2]) - 1.1 + moss * 1.4) * 1.4) * 0.75;
  const y = (p, x, z) => p.a * x + p.b * z + p.c;
  roof.pieces.forEach((P, k) => {
    const p = P.plane, N = norm([-p.a, 1, -p.b]), grad = Math.hypot(p.a, p.b);
    const at = (pt, lift = 0) => [pt[0], y(p, pt[0], pt[1]) + lift, pt[1]];
    if (ctx.lod.detail > 1 && grad > 0.05 && ST.roof?.shingles !== false) {
      // Rader av takpannor längs höjdkurvorna, varje rad lite upplyft i nederkanten (som spån som överlappar)
      const rise = 0.55 * grad / Math.hypot(1, grad), lip = 0.05;
      const ys = P.poly.map((q) => y(p, q[0], q[1])), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const dn = norm([-p.a, 0, -p.b]); // nedför i världen (xz); (a, b) är lutningen uppåt
      // Längs raden: bitar på ungefär 1,6 m, förskjutna varannan rad som takpannor, med egen ton och egen mossa
      const cu = [-p.b / grad, p.a / grad], chunk = 1.6;
      const us = P.poly.map((q) => q[0] * cu[0] + q[1] * cu[1]), u0 = Math.min(...us), u1 = Math.max(...us);
      for (let hk = Math.floor(y0 / rise) * rise, row = 0; hk < y1; hk += rise, row++) {
        let band = clip(P.poly, [p.a, p.b, p.c - hk]);
        if (band) band = clip(band, [-p.a, -p.b, hk + rise - p.c]);
        if (!band) continue;
        const stagger = (Math.round(hk / rise) % 2) * chunk * 0.5;
        for (let uc = Math.floor((u0 - stagger) / chunk) * chunk + stagger; uc < u1; uc += chunk) {
          let piece = clip(band, [cu[0], cu[1], -uc]);
          if (piece) piece = clip(piece, [-cu[0], -cu[1], uc + chunk]);
          if (!piece) continue;
          const cx = piece.reduce((s2, q) => s2 + q[0], 0) / piece.length, cz = piece.reduce((s2, q) => s2 + q[1], 0) / piece.length;
          const kk = 0.88 + rd(`r${k}:${Math.round(hk * 100)}:${Math.round(uc * 10)}`) * 0.18, m = mossAt(cx, cz);
          const col = [0, 1, 2].map((i) => kk * (1 - m + m * (0.55 + 0.45 * mossC[i])));
          polygon('roof', piece.map((q) => at(q, 0.02 + lip * clamp01((hk + rise - y(p, q[0], q[1])) / rise))), N, col);
          for (let i = 0; i < piece.length; i++) { // läppen längs bitens nederkant
            const a = piece[i], b = piece[(i + 1) % piece.length];
            if (Math.abs(y(p, a[0], a[1]) - hk) > 1e-3 || Math.abs(y(p, b[0], b[1]) - hk) > 1e-3) continue;
            // vänd nedför (och ett uns uppåt, så att den syns uppifrån; materialen är enkelsidiga), och mörk: kanten
            // ligger i skuggan under raden ovanför
            polygon('roof', [at(a, 0.02 + lip), at(b, 0.02 + lip), at(b, 0.02), at(a, 0.02)], norm([dn[0], 0.15, dn[2]]), col.map((c) => c * 0.45));
          }
        }
      }
    } else polygon('roof', P.poly.map((q) => at(q, 0.02)), N);
    if (ctx.lod.detail > 0) polygon('roof', P.poly.map((q) => at(q, -th)).reverse(), mul(N, -1), [0.55, 0.55, 0.55]); // undersidan (syns under takfoten)
  });
  // Kanterna: takfot och gavelkant får tjocklek och vindskivor, nockar och grater får nockpannor
  const seen = new Set();
  for (const E of roof.edges) {
    const A3 = [E.a[0], E.ya + 0.02, E.a[1]], B3 = [E.b[0], E.yb + 0.02, E.b[1]];
    if (E.kind === 'eave') {
      polygon('roof', [A3, B3, add(B3, [0, -th - 0.02, 0]), add(A3, [0, -th - 0.02, 0])], [E.n[0], 0, E.n[1]], [0.75, 0.75, 0.75]);
      if (ctx.lod.detail > 0 && Math.abs(E.ya - E.yb) > 0.3) slab('trim', add(A3, [E.n[0] * 0.03, -th * 0.4, E.n[1] * 0.03]), add(B3, [E.n[0] * 0.03, -th * 0.4, E.n[1] * 0.03]), th * 1.3, STY.trim * 0.9, [E.n[0], 0, E.n[1]]);
    }
    if (E.kind === 'ridge' && ctx.lod.detail > 0) {
      const key = [E.a, E.b].map((q) => q.map((v) => v.toFixed(2)).join(',')).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      beam('roof', add(A3, [0, th * 0.35, 0]), add(B3, [0, th * 0.35, 0]), th * 1.0, th * 1.5, { color: [0.82, 0.82, 0.82] });
    }
  }
}

// ---------- Skorstenarna ----------
function chimneyMesh() {
  for (const c of chimneys) {
    box('base', [c.x, (c.bottom + c.top) / 2, c.z], [c.size, c.top - c.bottom, c.size], { bevel: 0.05 });
    if (ctx.lod.detail > 0) box(ST.chimney === 'brick' ? 'base' : 'trim', [c.x, c.top + 0.06, c.z], [c.size + 0.2, 0.14, c.size + 0.2], { bevel: 0.03 });
    if (ctx.lod.detail > 1) box('metal', [c.x, c.top + 0.22, c.z], [c.size * 0.35, 0.22, c.size * 0.35]);
  }
}

// ---------- Skevhet och skuggning (som gen_building.mjs) ----------
function deform(H) {
  const Aw = STY.wonk * H, rd = makeRand(seed + 99), lx = rd('lx') * 2 - 1, lz = rd('lz') * 2 - 1, ph = [0, 1, 2, 3].map((i) => rd(`ph${i}`) * 6.28);
  for (const gg of Object.values(geom.G)) for (let i = 0; i < gg.positions.length; i += 3) {
    const x = gg.positions[i], yy = gg.positions[i + 1], z = gg.positions[i + 2];
    if (yy <= 0) continue;
    const h = Math.min(1, yy / H), s = h * h;
    gg.positions[i] += Aw * (lx * s + 0.3 * Math.sin(yy * 0.9 + ph[0]) * Math.sin(z * 0.45 + ph[1]) * h);
    gg.positions[i + 2] += Aw * (lz * s * 0.6 + 0.3 * Math.sin(yy * 0.8 + ph[2]) * Math.sin(x * 0.4 + ph[3]) * h);
  }
}
function shade(H) {
  for (const [part, gg] of Object.entries(geom.G)) {
    if (/^(glass|glow|light)/.test(part)) continue;
    for (let i = 0; i < gg.positions.length / 3; i++) {
      const yy = gg.positions[i * 3 + 1];
      let k = part === 'roof' ? 0.85 + 0.15 * clamp01(yy / H) : 0.8 + 0.2 * clamp01(yy / H);
      k *= 0.72 + 0.28 * clamp01((yy + 0.1) / 0.9); // mörkare mot marken
      for (let c = 0; c < 3; c++) gg.colors[i * 3 + c] *= k;
    }
  }
}

function buildLod(level) {
  geom.reset();
  ctx.lod = [{ segs: BEVEL_SEGS, detail: 2 }, { segs: 1, detail: 1 }, { segs: 0, detail: 0 }][level];
  plinths();
  walls.forEach((W, wi) => wallMesh(W, wi));
  for (const o of openings) openingMesh(o);
  walls.forEach((W, wi) => framing(W, wi));
  roofMesh();
  chimneyMesh();
  let H = 0;
  for (const gg of Object.values(geom.G)) for (let i = 1; i < gg.positions.length; i += 3) H = Math.max(H, gg.positions[i]);
  deform(H);
  shade(H);
  return { parts: geom.G, H };
}

// ---------- glTF ----------
const lods = [0, 1, 2].map(buildLod);
const doc = new Document();
const emissiveExt = doc.createExtension(KHRMaterialsEmissiveStrength);
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const NAMES = { base: 'Base', wall: 'Wall', roof: 'Roof', trim: 'Trim', door: 'Door', glass: 'Glass', metal: 'Metal', flora: 'Flora' };
const ROUGH = { base: 0.9, wall: 0.88, roof: 0.82, trim: 0.8, door: 0.75, glass: 0.12, metal: 0.38, flora: 0.85 };
const matCache = {};
function getMat(part) {
  if (matCache[part]) return matCache[part];
  const [kind, hex] = part.split(':');
  let m;
  if (kind === 'glow' || kind === 'light') {
    const strength = kind === 'glow' ? (ST.window?.glow > 0 ? 1 + 2 * ST.window.glow : 0.85) : (ST.lantern?.glow ?? 2);
    m = doc.createMaterial(kind === 'glow' ? 'GlassGlow' : 'Light').setRoughnessFactor(0.3).setMetallicFactor(0).setBaseColorFactor([...lin(hex), 1]).setEmissiveFactor(lin(hex));
    m.setExtension('KHR_materials_emissive_strength', emissiveExt.createEmissiveStrength().setEmissiveStrength(strength));
  } else if (kind === 'flora') {
    m = doc.createMaterial(`Flora_${hex.slice(1)}`).setRoughnessFactor(0.85).setBaseColorFactor([...lin(hex), 1]);
  } else {
    m = doc.createMaterial(NAMES[kind] ?? kind).setRoughnessFactor(ROUGH[kind] ?? 0.85).setMetallicFactor(kind === 'metal' ? 1 : 0);
    const tint = kind === 'metal' ? ST.metal : kind === 'glass' ? ST.window?.glass : tints[kind];
    if (tint) m.setBaseColorFactor([...lin(tint), 1]);
    if (textures[kind] && fs.existsSync(textures[kind])) m.setBaseColorTexture(sharedTexture(doc, textures[kind], NAMES[kind], out));
    if (textures[`${kind}_normal`] && fs.existsSync(textures[`${kind}_normal`])) m.setNormalTexture(sharedTexture(doc, textures[`${kind}_normal`], `${NAMES[kind]}_normal`, out)).setNormalScale(0.7);
  }
  return (matCache[part] = m);
}
function orient(gg) {
  const Pp = (k) => [gg.positions[k * 3], gg.positions[k * 3 + 1], gg.positions[k * 3 + 2]], Nn = (k) => [gg.normals[k * 3], gg.normals[k * 3 + 1], gg.normals[k * 3 + 2]];
  for (let i = 0; i < gg.indices.length; i += 3) {
    const [a, b, c] = [gg.indices[i], gg.indices[i + 1], gg.indices[i + 2]];
    if (dot(cross(sub(Pp(b), Pp(a)), sub(Pp(c), Pp(a))), add(add(Nn(a), Nn(b)), Nn(c))) < 0) { gg.indices[i + 1] = c; gg.indices[i + 2] = b; }
  }
}
const name = recipe.name ?? path.basename(out, path.extname(out));
const door = openings.find((o) => o.kind === 'door'), dw = door && walls[door.wall].face;
const entrances = door ? [{ pos: W3(dw, door.s, 0, Math.ceil(vols[walls[door.wall].v].plinth / 0.18) * 0.3 + 0.8).map((v) => +v.toFixed(2)), yaw: +Math.atan2(dw.n[0], dw.n[1]).toFixed(3) }] : [];
let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
for (const V of vols) for (const [x0, z0, x1, z1] of V.levelRects) { bx0 = Math.min(bx0, x0); bz0 = Math.min(bz0, z0); bx1 = Math.max(bx1, x1); bz1 = Math.max(bz1, z1); }
// Grafen följer med i modellen (extras), så att huset kan redigeras och byggas om utan att meshen är källan
const graphOut = {
  volumes: vols.map((V) => ({ id: V.id, rect: V.rect.map((v) => +v.toFixed(2)), levels: V.levels, top: +V.top.toFixed(2), stone: V.stone, roof: { type: V.roof.type, axis: V.roof.axis, pitch: +(V.roof.pitch * 180 / Math.PI).toFixed(1) } })),
  openings: openings.map((o) => ({ kind: o.kind, volume: vols[walls[o.wall].v].id, level: walls[o.wall].level, face: walls[o.wall].face.name, s: +o.s.toFixed(2), y: +o.y.toFixed(2), w: +o.w.toFixed(2), h: +o.h.toFixed(2) })),
};
const root = doc.createNode(name).setExtras({ generator: 'asset-studio/house@2', recipe: { archetype, style, stylization: S, seed },
  footprint: [+(bx1 - bx0).toFixed(2), +(bz1 - bz0).toFixed(2)], height: +lods[0].H.toFixed(2), entrances, graph: graphOut });
const tris = [];
let minY = Infinity;
lods.forEach(({ parts }, i) => {
  const lodNode = doc.createNode(`${name}_LOD${i}`).setExtras({ lod: i });
  let t = 0;
  for (const [part, gg] of Object.entries(parts)) {
    if (!gg.indices.length) continue;
    orient(gg);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', Float32Array.from(gg.positions)))
      .setAttribute('NORMAL', acc('VEC3', Float32Array.from(gg.normals)))
      .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(gg.uvs)))
      .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(gg.colors.map((c) => Math.min(1, c)))))
      .setAttribute('_WIND', acc('SCALAR', Float32Array.from(gg.wind)))
      .setIndices(acc('SCALAR', Uint32Array.from(gg.indices)))
      .setMaterial(getMat(part));
    const pn = part.replace(':#', '_');
    lodNode.addChild(doc.createNode(`${name}_${pn}_LOD${i}`).setMesh(doc.createMesh(`${pn}_LOD${i}`).addPrimitive(prim)));
    t += gg.indices.length / 3;
    if (i === 0) for (let k = 1; k < gg.positions.length; k += 3) minY = Math.min(minY, gg.positions[k]);
  }
  root.addChild(lodNode);
  tris.push(Math.round(t));
});
doc.createScene(name).addChild(root);
fs.mkdirSync(path.dirname(out), { recursive: true });
await writeGltf(doc, out);

// ---------- Kontroller ----------
// Taket: inga glipor eller överlapp mellan takytorna (prov i ett rutnät över husets utbredning)
const insidePoly = (poly, x, z) => { for (let i = 0; i < poly.length; i++) { const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length]; if ((x1 - x0) * (z - z0) - (z1 - z0) * (x - x0) < -1e-9) return false; } return true; };
let gaps = 0, overlaps = 0;
for (let x = bx0 - 1; x <= bx1 + 1; x += 0.23) for (let z = bz0 - 1; z <= bz1 + 1; z += 0.21) {
  const H = roof.heightAt(x, z), hits = roof.pieces.filter((P) => insidePoly(P.poly, x, z));
  if (H > -Infinity && !hits.length) gaps++;
  if (hits.length > 1) { const ys = hits.map((P) => P.plane.a * x + P.plane.b * z + P.plane.c); if (Math.max(...ys) - Math.min(...ys) > 1e-3) overlaps++; }
}
// Öppningarna: inom en körning på sin vägg och sin våning, och inte över varandra
let outside = 0, clash = 0;
for (const [i, o] of openings.entries()) {
  const W = walls[o.wall];
  if (!o.gable && !W.runs.some(([a, b]) => o.s - o.w / 2 >= a - 1e-6 && o.s + o.w / 2 <= b + 1e-6)) outside++;
  if (!o.gable && opTop(o) > W.yt + 1e-6) outside++;
  for (const p of openings.slice(i + 1)) if (p.wall === o.wall && Math.abs(p.s - o.s) < (p.w + o.w) / 2 + 0.15 && p.y < opTop(o) && o.y < opTop(p)) clash++;
}
const budget = STYLE_JSON.budgets_tris?.building ?? [4000, 40000];
const area = (bx1 - bx0) * (bz1 - bz0) * Math.max(...vols.map((V) => V.levels));
const checks = {
  doors: openings.filter((o) => o.kind === 'door').length,
  roof_gaps: gaps, roof_overlaps: overlaps,
  openings_outside_wall: outside, openings_overlap: clash,
  chimneys_through_roof: chimneys.every((c) => c.top > roof.heightAt(c.x, c.z) + 0.5 && c.bottom < roof.heightAt(c.x, c.z)),
  grounded: minY < 0 && minY > -1,
  within_budget: tris[0] <= budget[1] * Math.max(1, Math.sqrt(area / 120)) * 1.5,
  lods_decrease: tris[0] > tris[1] && tris[1] > tris[2],
};
checks.ok = checks.doors >= 1 && !gaps && !overlaps && !outside && !clash && checks.chimneys_through_roof && checks.grounded && checks.within_budget && checks.lods_decrease;
console.log(JSON.stringify({ model: out, archetype, style, stylization: S, seed, size: [+(bx1 - bx0).toFixed(2), +lods[0].H.toFixed(2), +(bz1 - bz0).toFixed(2)],
  volumes: vols.map((V) => V.id), roof_pieces: roof.pieces.length, windows: openings.filter((o) => o.kind === 'window').length, chimneys: chimneys.length, tris_lod: tris, checks }));
