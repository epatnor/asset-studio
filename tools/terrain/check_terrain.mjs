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

if (process.argv[1] === fileURLToPath(import.meta.url) && JSON.parse(process.argv[2] ?? '{}').scene === 'landscapes') {
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
