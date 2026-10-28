// Kontroller av terrängen utan bilder (docs/terrain.md, Kontroller): veck, hopp och sågtänder i strandlinjen.
//
//   node tools/terrain/check_terrain.mjs ['{"scene": "stream"}']
//
// Svarar med en rad JSON: {"ok": ..., "checks": {...}}. Mätningarna exporteras också (measure), så att andra rutnät kan
// jämföras med samma mått.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { axis, buildField } from '../../shared/terrain/field.js';
import { createChannel } from '../../shared/terrain/shapes.js';
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
  const out = { bend_p99_deg: r2(pct(bends, 0.99)), bend_max_deg: r2(Math.max(0, ...bends)), steepest: r2(steep) };
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
const LIMITS = { bend_max_deg: 25, shore_turn_p95_deg: 30, shore_turns_over_60: 0, edge_clearance_min: 0.02 };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
