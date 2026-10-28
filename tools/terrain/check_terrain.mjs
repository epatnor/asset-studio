// Kontroller av terrängen utan bilder (docs/terrain.md, Kontroller): veck, hopp och sågtänder i strandlinjen.
//
//   node tools/terrain/check_terrain.mjs ['{"scene": "stream"}']       bäcken i Vatten-fliken
//   node tools/terrain/check_terrain.mjs '{"scene": "landscapes"}'     Kartrummets färdiga landskap
//
// Svarar med en rad JSON: {"ok": ..., "checks": {...}}. Mätningarna exporteras också (measure), så att andra rutnät kan
// jämföras med samma mått.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { axis, buildField } from '../../shared/terrain/field.js';
import { createChannel } from '../../shared/terrain/shapes.js';
import { generateTerrain, worldGrid } from '../../shared/terrain/generate.js';
import { computeBiomes } from '../../shared/terrain/biomes.js';
import { regionField } from '../../shared/terrain/regions.js';
import { applyEdits, brushDab, rampStroke, encodeDelta, decodeDelta } from '../../shared/terrain/sculpt.js';
import { STAMP_IDS, createStamp, LANDFORM_IDS, createLandform, placeLandform } from '../../shared/terrain/stamps.js';
import { SLOTS, paintDab, encodeWeights, decodeWeights } from '../../shared/terrain/paint.js';
import { populate, STRIDE } from '../../shared/terrain/populate.js';
import { hills } from '../../shared/terrain/noise.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEG = 180 / Math.PI;
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r2 = (v) => Math.round(v * 100) / 100;

// f: { xs, zs, nx, nz, heights, normals, index }; levelAt(x, z) ger vattnets nivå (eller null utan vatten);
// inside(x, z) väljer området som mäts
export function measure(f, { levelAt = null, inside = () => true } = {}) {
  const { nx, nz, xs, zs, heights: h, normals: n } = f;
  // Veck: vinkeln mellan grannhörnens normaler; hopp: största lutningen mellan grannar
  const bends = [];
  let steep = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (!inside(xs[i], zs[j])) continue;
    const k = j * nx + i;
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      if (i + di >= nx || j + dj >= nz) continue;
      const m = (j + dj) * nx + i + di, dot = n[k * 3] * n[m * 3] + n[k * 3 + 1] * n[m * 3 + 1] + n[k * 3 + 2] * n[m * 3 + 2];
      bends.push(Math.acos(Math.min(1, dot)) * DEG);
      steep = Math.max(steep, Math.abs(h[m] - h[k]) / (di ? xs[i + 1] - xs[i] : zs[j + 1] - zs[j]));
    }
  }
  const out = { bend_p99_deg: r2(pct(bends, 0.99)), bend_max_deg: r2(bends.reduce((a, b) => Math.max(a, b), 0)), steepest: r2(steep) };
  if (!levelAt) return out;
  // Strandlinjen: där marken skär vattennivån, triangel för triangel; kedjorna följs och vinkeln mellan stegen mäts
  const P = (k) => [f.positions[k * 3], f.positions[k * 3 + 2]];
  const lv = new Float32Array(f.count ?? nx * nz).fill(NaN);
  const fv = (k) => { if (Number.isNaN(lv[k])) { const [x, z] = P(k), l = levelAt(x, z); lv[k] = l == null ? Infinity : h[k] - l; } return lv[k]; };
  const edges = new Map(), segs = [];
  const cross = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`, fa = fv(a), fb = fv(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb) || (fa < 0) === (fb < 0)) return null;
    const t = fa / (fa - fb), [ax, az] = P(a), [bx, bz] = P(b);
    return { key, x: ax + (bx - ax) * t, z: az + (bz - az) * t };
  };
  for (let t = 0; t < f.index.length; t += 3) {
    const [a, b, c] = [f.index[t], f.index[t + 1], f.index[t + 2]];
    const [x, z] = P(a);
    if (!inside(x, z)) continue;
    const pts = [cross(a, b), cross(b, c), cross(c, a)].filter(Boolean);
    if (pts.length !== 2) continue;
    const s = segs.length;
    segs.push(pts);
    for (const p of pts) { if (!edges.has(p.key)) edges.set(p.key, []); edges.get(p.key).push(s); }
  }
  // Kedjorna: varje strandsegment delar en kantpunkt med nästa
  const used = new Uint8Array(segs.length), turns = [];
  let length = 0, chains = 0, worst = null;
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    chains++;
    for (const dir of [0, 1]) {
      let s = s0, from = segs[s0][dir].key, prev = null;
      used[s0] = 1;
      for (;;) {
        const [p, q] = segs[s][0].key === from ? segs[s] : [segs[s][1], segs[s][0]];
        const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz);
        if (dir === 0) length += l;
        if (l > 1e-4) {
          if (prev) {
            const a = Math.acos(Math.max(-1, Math.min(1, (prev[0] * dx + prev[1] * dz) / l))) * DEG;
            turns.push(a);
            if (!worst || a > worst.deg) worst = { deg: r2(a), at: [r2(p.x), r2(p.z)] };
          }
          prev = [dx / l, dz / l];
        }
        const next = (edges.get(q.key) ?? []).find((o) => !used[o]);
        if (next === undefined) break;
        used[next] = 1;
        s = next;
        from = q.key;
      }
    }
  }
  return { ...out, shore_m: Math.round(length), shore_chains: chains, worst_turn: worst, shore_turn_p95_deg: r2(pct(turns, 0.95)), shore_turns_over_60: turns.filter((a) => a > 60).length };
}

// Bäckscenen ur tools/water/water.json, byggd som i studio/water.js
export async function streamScene() {
  const water = JSON.parse(await readFile(path.join(ROOT, 'tools/water/water.json'), 'utf8'));
  const base = (x, z) => 0.6 - 0.01 * z + hills(x, z) * 0.35; // samma mark som bäcken i studio/water.js
  const ch = createChannel({ path: water.scenes.stream.path, base });
  const t0 = performance.now();
  const f = buildField(axis(-90, 90, -30, 30, 0.3), axis(-120, 120, -50, 40, 0.3), ch.bedAt);
  return { f, ch, ms: Math.round(performance.now() - t0) };
}

// Gränser för ok (grader och lutning); hamnar i svaret så att de syns
const LIMITS = { bend_max_deg: 25, shore_turn_p95_deg: 30, shore_turns_over_60: 0, edge_clearance_min: 0.02, landscape_spikes: 0 };

// Spetsar och gropar: ett hörn som ligger mer än tol över (under) alla fyra grannar, där marken två rutor ut inte
// fortsätter att sjunka (stiga). En riktig topp eller sänka fortsätter utåt; en artefakt på en enda ruta gör det inte.
function spikes(h, n, tol = 0.12) {
  let c = 0;
  for (let j = 2; j < n - 2; j++) for (let i = 2; i < n - 2; i++) {
    const k = j * n + i, r1 = [h[k - 1], h[k + 1], h[k - n], h[k + n]], r2 = [h[k - 2], h[k + 2], h[k - 2 * n], h[k + 2 * n]];
    const up = h[k] - Math.max(...r1), down = Math.min(...r1) - h[k];
    if ((up > tol && Math.max(...r1) - Math.max(...r2) < up * 0.3) || (down > tol && Math.min(...r2) - Math.min(...r1) < down * 0.3)) c++;
  }
  return c;
}
// Kartrummets världar: inga NaN, inga spetsar eller gropar, region- och biomvikter som summerar till 1, inga regioner
// under 10 % av landet, och för öarna en kant under havet
async function landscapes() {
  const T = JSON.parse(await readFile(path.join(ROOT, 'tools/terrain/terrain.json'), 'utf8'));
  const defaults = Object.fromEntries(T.params.map((q) => [q.key, q.default]));
  const out = {};
  let ok = true;
  for (const [id, p] of Object.entries(T.presets)) {
    const R = { ...defaults, ...p }, t = generateTerrain({ ...R, ...worldGrid(Number(R.worldSize)) });
    const xs = Array.from({ length: t.n }, (_, i) => -t.half + i * t.cell);
    const f = buildField(xs, xs, t.heightAt, { byDifference: true });
    const nan = t.heights.some((h) => !Number.isFinite(h));
    let edge = -Infinity;
    if (['island', 'archipelago', 'volcano', 'atoll', 'twin', 'crescent'].includes(R.shape)) for (let i = 0; i < t.n; i++) for (const k of [i, (t.n - 1) * t.n + i, i * t.n, i * t.n + t.n - 1]) edge = Math.max(edge, t.heights[k]);
    const m = measure(f);
    const sp = spikes(t.heights, t.n);
    // Regionerna: vikterna summerar till 1 i varje ruta, och med flera regioner får var och en minst 10 % av landet
    const rf = regionField(t, { ...R, regionThemes: T.regionThemes, regionColors: T.regionColors });
    let regBad = 0;
    for (let k = 0; k < rf.P * rf.P; k++) { let sum = 0; for (let r = 0; r < rf.count; r++) sum += rf.weights[k * rf.count + r]; if (!(Math.abs(sum - 1) < 1e-3)) regBad++; }
    const regSmall = rf.count > 1 ? rf.coverage.filter((c) => c < 10).length : 0;
    // Biomerna: varje hörns vikter summerar till 1 (255 ± 8 efter avrundning)
    const bio = computeBiomes(t, R, rf);
    let badSum = 0;
    for (let k = 0; k < bio.weights.length; k += 8) { let sum = 0; for (let b = 0; b < 8; b++) sum += bio.weights[k + b]; if (Math.abs(sum - 255) > 8) badSum++; }
    const good = !nan && sp <= LIMITS.landscape_spikes && badSum === 0 && regBad === 0 && regSmall === 0 && (edge === -Infinity || edge < (R.seaLevel ?? 0) - 1);
    ok &&= good;
    out[id] = { ok: good, ms: t.ms, top: r2(t.heights.reduce((a, b) => Math.max(a, b), -Infinity)), bend_p99_deg: m.bend_p99_deg, bend_max_deg: m.bend_max_deg, spikes: sp, biome_ms: bio.ms, biome_sum_errors: badSum, biomes_pct_of_land: bio.coverage, region_ms: rf.ms, region_sum_errors: regBad, regions_pct_of_land: rf.coverage, ...(edge > -Infinity ? { edge_max: r2(edge) } : {}) };
  }
  return { ok, landscapes: out };
}

// Steget Sculpt på Green isle: penslar (höj, jämna ut, ramp), en å och en bäck från toppen och en vik från havet.
// Lagret ska överleva texten (fel under 6 mm), ytan i bäck och å får aldrig stiga nedströms, botten ska ligga under
// vattnet, viken under havet, inga NaN eller spetsar, och kanalerna får inte bygga väggar ur havsbottnen.
async function sculptScene() {
  const T = JSON.parse(await readFile(path.join(ROOT, 'tools/terrain/terrain.json'), 'utf8'));
  const R = { ...Object.fromEntries(T.params.map((q) => [q.key, q.default])), ...T.presets.island, channelKinds: T.channelKinds };
  const t = generateTerrain({ ...R, ...worldGrid(Number(R.worldSize)) }), { n, cell, half, size } = t;
  let top = 0;
  for (let k = 0; k < n * n; k++) if (t.heights[k] > t.heights[top]) top = k;
  const bx = -half + (top % n) * cell, bz = -half + Math.floor(top / n) * cell;
  const h = t.heights.slice(), delta = new Float32Array(n * n);
  for (let s = 0; s < 20; s++) brushDab(h, delta, n, cell, half, bx - 100, bz, { tool: 'raise', radius: 30, strength: 0.5 });
  for (let s = 0; s < 5; s++) brushDab(h, delta, n, cell, half, bx - 100, bz, { tool: 'smooth', radius: 30, strength: 0.5 });
  rampStroke(h, delta, n, cell, half, { x: bx + 50, z: bz, y: 30 }, { x: bx + 150, z: bz, y: 10 }, { radius: 12 });
  const text = encodeDelta(delta, n), back = decodeDelta(text);
  let err = 0;
  for (let k = 0; k < n * n; k++) err = Math.max(err, Math.abs(back.delta[k] - delta[k]));
  const u = (x) => x / size;
  const channels = [
    { kind: 'river', points: [[u(bx), u(bz)], [u(bx - 150), u(bz + 60)], [u(bx - 300), u(bz + 20)], [-0.49, u(bz)]] },
    { kind: 'stream', points: [[u(bx + 20), u(bz - 30)], [u(bx + 120), u(bz - 120)], [u(bx + 250), u(bz - 160)]] },
    { kind: 'bay', points: [[0, 0.49], [0.02, 0.3], [0, 0.2]] },
  ];
  const e = applyEdits(t, { ...R, sculpt: back.delta, sculptN: back.n, channels });
  const out = { encoded_chars: text.length, roundtrip_err_m: r2(err), edit_ms: e.editMs, nan: e.heights.some((v) => !Number.isFinite(v)), spikes: spikes(e.heights, n), channels: {} };
  let ok = err <= 0.006 && !out.nan && out.spikes <= LIMITS.landscape_spikes;
  for (const c of e.channels) {
    let rises = 0, dry = 0;
    for (let i = 1; i < c.smp.length; i++) if (c.smp[i].level > c.smp[i - 1].level + 1e-6) rises++;
    for (const p of c.smp) if (e.heightAt(p.x, p.z) > p.level - 0.05) dry++; // botten i mitten ska ligga under ytan
    out.channels[c.kind] = { samples: c.smp.length, level_rises: rises, dry_centre: dry, level_from: r2(c.smp[0].level), level_to: r2(c.smp.at(-1).level) };
    ok &&= rises === 0 && dry <= c.smp.length * 0.02;
  }
  // Penslarna var för sig på en kopia: varje mönster med Raise (inga NaN, något ändras; kratern sänker mitten och höjer
  // vallen), Terrace (höjderna samlas vid stegen) och Erode (ändrar marken utan spetsar)
  const k0 = Math.floor(n / 2) * n + Math.floor(n / 2), cx = 0, cz = 0, at = (x, z) => Math.round((z + half) / cell) * n + Math.round((x + half) / cell);
  out.brushes = {};
  for (const id of STAMP_IDS) {
    const hh = t.heights.slice(), dd = new Float32Array(n * n);
    brushDab(hh, dd, n, cell, half, cx, cz, { tool: 'raise', radius: 40, strength: 1, hardness: 0.3, stamp: createStamp(id, 7), angle: 0.6 });
    let lo = 0, hi = 0, bad = 0;
    for (let k = 0; k < n * n; k++) { lo = Math.min(lo, dd[k]); hi = Math.max(hi, dd[k]); if (!Number.isFinite(hh[k])) bad++; }
    out.brushes[id] = { min_m: r2(lo), max_m: r2(hi) };
    ok &&= bad === 0 && hi - lo > 0.05;
  }
  const crater = out.brushes.crater;
  { const hh = t.heights.slice(), dd = new Float32Array(n * n); brushDab(hh, dd, n, cell, half, cx, cz, { tool: 'raise', radius: 40, strength: 1, stamp: createStamp('crater', 7) }); crater.centre_m = r2(dd[at(cx, cz)]); crater.rim_m = r2(dd[at(cx + 28, cz)]); ok &&= dd[at(cx, cz)] < 0 && dd[at(cx + 28, cz)] > 0; }
  {
    const hh = t.heights.slice(), dd = new Float32Array(n * n), step = 4;
    for (let q = 0; q < 25; q++) brushDab(hh, dd, n, cell, half, cx, cz, { tool: 'terrace', radius: 40, strength: 1, hardness: 0.6, stepHeight: step });
    let on = 0, all = 0;
    for (let j = -15; j <= 15; j++) for (let i = -15; i <= 15; i++) { const v = hh[k0 + j * n + i] / step; all++; if (Math.abs(v - Math.round(v)) < 0.12) on++; }
    out.brushes.terrace = { on_steps_pct: Math.round((100 * on) / all) };
    ok &&= on / all > 0.6;
  }
  {
    const hh = t.heights.slice(), dd = new Float32Array(n * n);
    for (let q = 0; q < 10; q++) brushDab(hh, dd, n, cell, half, cx + q * 3, cz, { tool: 'erode', radius: 30, strength: 1 });
    let moved = 0;
    for (let k = 0; k < n * n; k++) moved += Math.abs(dd[k]);
    out.brushes.erode = { moved_m3: Math.round(moved * cell * cell), spikes: spikes(hh, n), nan: hh.some((v) => !Number.isFinite(v)) };
    ok &&= moved > 1 && !out.brushes.erode.nan && out.brushes.erode.spikes <= 2;
  }
  // Landformerna med ett klick: toppen når ungefär höjden, inga NaN eller spetsar; ön reser sig ur havet
  out.landforms = {};
  for (const id of LANDFORM_IDS) {
    const hh = t.heights.slice(), dd = new Float32Array(n * n), island = id === 'island';
    const px = island ? 0.38 * size : 0, pz = island ? 0.38 * size : 0; // ön ute i havet, i hörnet
    placeLandform(hh, dd, n, cell, half, px, pz, createLandform(id, 3), { radius: island ? 110 : 150, height: island ? 25 : 120, depth: id === 'canyon' ? 60 : 20, angle: 0.4, blend: island ? 'max' : 'add', base: island ? 0 : 0 });
    let lo = 0, hi = 0;
    for (let k = 0; k < n * n; k++) { lo = Math.min(lo, dd[k]); hi = Math.max(hi, dd[k]); }
    const sp = spikes(hh, n), nan = hh.some((x) => !Number.isFinite(x)), top = hh[at(px, pz)];
    out.landforms[id] = { min_m: r2(lo), max_m: r2(hi), spikes: sp, ...(island ? { centre_m: r2(top), before_m: r2(t.heights[at(px, pz)]) } : {}) };
    ok &&= !nan && sp <= 2 && (id === 'canyon' ? lo < -30 : hi > 40 * (island ? 0.4 : 1)) && (!island || (top > 2 && t.heights[at(px, pz)] < 0));
  }
  // Styrkan i procent: ett berg på 50 % lägger halva höjden ovanpå marken och behåller marken under
  {
    const full = t.heights.slice(), half50 = t.heights.slice(), d1 = new Float32Array(n * n), d2 = new Float32Array(n * n);
    placeLandform(full, d1, n, cell, half, 0, 0, createLandform('mountain', 3), { radius: 150, height: 120 });
    placeLandform(half50, d2, n, cell, half, 0, 0, createLandform('mountain', 3), { radius: 150, height: 120, strength: 0.5 });
    let worst = 0;
    for (let k = 0; k < n * n; k++) worst = Math.max(worst, Math.abs(d2[k] - d1[k] * 0.5));
    out.landforms.strength_50_err_m = r2(worst);
    ok &&= worst < 0.01;
  }
  // Målningen (steget Paint): 50 % ger hälften ovanpå det som finns, summan går aldrig över 1, Erase ger tillbaka
  // marken, lutningsfiltret målar bara i branter, och lagret överlever texten exakt
  {
    const W = new Uint8Array(n * n * SLOTS), c0 = at(0, 0) * SLOTS;
    paintDab(W, n, cell, half, 0, 0, { slot: 0, radius: 30, strength: 1, hardness: 1 });
    paintDab(W, n, cell, half, 0, 0, { slot: 1, radius: 30, strength: 0.5, hardness: 1 });
    let over = 0;
    for (let k = 0; k < n * n; k++) { let sum = 0; for (let q = 0; q < SLOTS; q++) sum += W[k * SLOTS + q]; if (sum > 256) over++; }
    const text = encodeWeights(W, n), back = decodeWeights(text);
    let diff = 0;
    for (let k = 0; k < W.length; k++) if (back.weights[k] !== W[k]) diff++;
    const centre = [W[c0], W[c0 + 1]];
    for (let q = 0; q < 30; q++) paintDab(W, n, cell, half, 0, 0, { slot: -1, radius: 40, strength: 0.4 });
    const left = W.reduce((a, b) => a + b, 0);
    const S2 = new Uint8Array(n * n * SLOTS);
    paintDab(S2, n, cell, half, bx, bz, { slot: 2, radius: 120, strength: 1, hardness: 1, slope: [35, 90], heights: t.heights });
    let steep = 0, flat = 0;
    for (let j = 2; j < n - 2; j++) for (let i = 2; i < n - 2; i++) {
      const k = j * n + i;
      if (!S2[k * SLOTS + 2]) continue;
      const hx = (t.heights[k + 1] - t.heights[k - 1]) / (2 * cell), hz = (t.heights[k + n] - t.heights[k - n]) / (2 * cell), deg = Math.atan(Math.hypot(hx, hz)) * 180 / Math.PI;
      if (deg < 30) flat++; else steep++;
    }
    out.paint = { centre_two_layers: centre, over_one: over, encoded_chars: text.length, roundtrip_diff: diff, left_after_erase: left, slope_filter_painted_on_flat: flat, on_steep: steep };
    ok &&= Math.abs(centre[0] - 128) <= 2 && Math.abs(centre[1] - 128) <= 2 && over === 0 && diff === 0 && left < 500 && flat === 0;
  }
  const mouth = e.heightAt(0.01 * size, 0.3 * size);
  let raised = 0;
  for (let k = 0; k < n * n; k++) if (t.heights[k] < -0.05 && e.heights[k] > t.heights[k] + 0.05) raised++;
  Object.assign(out, { bay_bed_m: r2(mouth), seabed_raised_corners: raised });
  ok &&= mouth < -2 && raised <= 50;
  return { ok, scene: 'sculpt', ...out };
}

// Steget Populate på Green isle: samma frö ger samma natur, en målad väg håller undan träden, höstträden växer bara i
// en region med temat Autumn wood, inga träd står under havet och inga stenar i en stam
async function populateScene() {
  const T = JSON.parse(await readFile(path.join(ROOT, 'tools/terrain/terrain.json'), 'utf8'));
  const R = { ...Object.fromEntries(T.params.map((q) => [q.key, q.default])), ...T.presets.island, regionThemes: T.regionThemes, regionColors: T.regionColors };
  const t = generateTerrain({ ...R, ...worldGrid(Number(R.worldSize)) }), { n, cell, half } = t;
  const worldFor = (regions, ground = null) => {
    const rf = regionField(t, { ...R, regions }), b = computeBiomes(t, { ...R, regions }, rf);
    return { ...t, biomes: b.weights, sea: R.seaLevel ?? 0, ground, regions: { P: rf.P, count: rf.count, weights: rf.weights, themes: regions.map((r) => r.theme) } };
  };
  const plain = worldFor([{ name: 'Heartland', theme: 'temperate' }]);
  const a = populate(plain, T.populate, { seed: 3 }), b = populate(plain, T.populate, { seed: 3 });
  const same = a.layers.every((l, i) => l.count === b.layers[i].count && l.data.every((v, k) => v === b.layers[i].data[k]));
  const trees = (r) => r.layers.filter((l) => l.kind === 'tree');
  let wet = 0;
  for (const l of trees(a)) for (let i = 0; i < l.count; i++) if (l.data[i * STRIDE + 1] < (R.seaLevel ?? 0) - 0.2) wet++;
  // En väg målad till 100 % i en ruta på 200 × 200 m mitt på ön
  const W = new Uint8Array(n * n * SLOTS), box = (x, z) => Math.abs(x) < 100 && Math.abs(z) < 100;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (box(-half + i * cell, -half + j * cell)) W[(j * n + i) * SLOTS] = 255;
  const road = populate({ ...plain, ground: { W, effects: [T.groundTextures.find((x) => x.id === 'surface_road').populate] } }, T.populate, { seed: 3 });
  let onRoad = 0, before = 0;
  const inner = (x, z) => Math.abs(x) < 98 && Math.abs(z) < 98; // en ruta in från kanten: kanthörnen ligger utanför vägen
  for (const l of trees(road)) for (let i = 0; i < l.count; i++) if (inner(l.data[i * STRIDE], l.data[i * STRIDE + 2])) onRoad++;
  for (const l of trees(a)) for (let i = 0; i < l.count; i++) if (box(l.data[i * STRIDE], l.data[i * STRIDE + 2])) before++;
  // Höstträd: inga med en vanlig region, några med en region i Autumn wood
  const autumn = populate(worldFor([{ name: 'Goldleaf', theme: 'autumn' }]), T.populate, { seed: 3 });
  const count = (r, id) => r.layers.find((l) => l.id === id).count;
  // Stenar i stammar: en sten närmare ett träd än en meter
  const stems = [];
  for (const l of trees(a)) for (let i = 0; i < l.count; i++) stems.push([l.data[i * STRIDE], l.data[i * STRIDE + 2]]);
  let inStem = 0;
  const rocks = a.layers.find((l) => l.id === 'boulders');
  for (let i = 0; i < rocks.count; i++) { const x = rocks.data[i * STRIDE], z = rocks.data[i * STRIDE + 2]; if (stems.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 1)) inStem++; }
  const out = {
    ms: a.ms, total: a.total, per_layer: Object.fromEntries(a.layers.map((l) => [l.id, l.count])), same_seed_same_nature: same, trees_under_sea: wet,
    trees_in_road_box: onRoad, trees_in_box_without_road: before, autumn_trees_plain: count(a, 'autumn'), autumn_trees_in_autumn_region: count(autumn, 'autumn'), broadleaf_in_autumn_region: count(autumn, 'broadleaf'), rocks_in_stems: inStem,
  };
  const ok = same && wet === 0 && onRoad === 0 && before > 20 && count(a, 'autumn') === 0 && count(autumn, 'autumn') > 300 && count(autumn, 'broadleaf') < count(a, 'broadleaf') * 0.4 && inStem === 0 && a.total > 10000;
  return { ok, scene: 'populate', ...out };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && JSON.parse(process.argv[2] ?? '{}').scene === 'populate') {
  console.log(JSON.stringify(await populateScene()));
} else if (process.argv[1] === fileURLToPath(import.meta.url) && JSON.parse(process.argv[2] ?? '{}').scene === 'sculpt') {
  console.log(JSON.stringify(await sculptScene()));
} else if (process.argv[1] === fileURLToPath(import.meta.url) && JSON.parse(process.argv[2] ?? '{}').scene === 'landscapes') {
  const r = await landscapes();
  console.log(JSON.stringify({ ...r, limits: { spikes: LIMITS.landscape_spikes, edge: 'under the sea by 1 m' } }));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { f, ch, ms } = await streamScene();
  // Vattnet ligger bara nära fåran (d < 1,3 w), som vattenytan i studio/water.js
  const levelAt = (x, z) => { const q = ch.query(x, z); return q && q.d < q.w * 1.3 ? q.level : null; };
  const m = measure(f, { levelAt, inside: (x, z) => Math.abs(x) < 30 && z > -50 && z < 40 });
  // Vattenytans kant (d = 1,3 w) ska ligga under marken på båda sidor, annars syns en rak kant
  let clear = Infinity;
  for (const p of ch.smp) for (const side of [-1, 1]) {
    const x = p.x - p.tz * side * p.w * 1.3, z = p.z + p.tx * side * p.w * 1.3, q = ch.query(x, z);
    if (q && Math.abs(x) < 30 && z > -50 && z < 40) clear = Math.min(clear, f.sample(x, z) - q.level);
  }
  m.edge_clearance_min = r2(clear);
  const ok = m.bend_max_deg <= LIMITS.bend_max_deg && m.shore_turn_p95_deg <= LIMITS.shore_turn_p95_deg && m.shore_turns_over_60 <= LIMITS.shore_turns_over_60 && clear >= LIMITS.edge_clearance_min;
  console.log(JSON.stringify({ ok, scene: 'stream', vertices: f.count, build_ms: ms, checks: m, limits: LIMITS }));
}
