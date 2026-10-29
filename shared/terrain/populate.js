// Utplaceringen (docs/terrain.md, steget Populate): naturen på ön som en PCG-graf, halvautomatiskt. Ren JavaScript,
// som de andra i shared/terrain/, så att samma kod körs i studion och i kontrollerna i Node.
//
// Varje lager i populate.layers (terrain.json) är en kedja: punkter (ett jittrat rutnät med lagrets avstånd) →
// täthet (biomernas vikter, de målade marktexturerna och regionens tema) → filter (lutning, höjd över havet, fukt,
// klungor ur ett brus) → upptaget (stora saker tar plats först, så att en sten inte hamnar i en stam) → familj efter
// vikt → instans (läge, vridning, storlek, markens lutning). Allt är seedat: samma värld, regler och frö ger samma
// skog. Det man målat lägger sig i procent även här: en stig målad till 50 % halverar trädens täthet där.
//
//   const r = populate(world, rules, { seed, layers: { id: { on, density } } });
//   r.layers[i] = { id, kind, models, count, data: Float32Array(count · STRIDE) }   // x, y, z, rot, scale, model, nx, nz, pick

import { createNoise } from './generate.js';
import { BIOMES } from './biomes.js';

const MARSH = BIOMES.indexOf('marsh');
import { SLOTS } from './paint.js';

export const STRIDE = 9;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const window01 = (lo, hi, x, soft) => smooth(lo - soft, lo + soft, x) * (1 - smooth(hi - soft, hi + soft, x));
// Heltalshash till 0..1 (samma tal överallt, oberoende av ordning)
function hash(a, b, c, d) {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1) ^ Math.imul(d, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// world: { n, cell, half, size, heights, wet, biomes (Uint8 n·n·8), sea (eller null), ground: { W (Uint8 n·n·SLOTS),
// effects: [{ tree: 0, … } per lager] } eller null, regions: { P, count, weights, themes: [tema per region] } eller null }
// rules: { layers: [...] } ur terrain.json. opts: { seed, layers: { id: { on, density } }, density (allt) }
export function populate(world, rules, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { n, cell, half, size, heights: H, wet, biomes: B } = world, sea = world.sea ?? null;
  const seed = opts.seed ?? 1, global = opts.density ?? 1;
  // Upptaget: 1 m-rutor (högst 2048 × 2048) där en stam eller sten redan står
  const oc = Math.max(1, size / 2048), on = Math.ceil(size / oc), occ = new Uint8Array(on * on);
  const occAt = (x, z) => occ[Math.min(on - 1, Math.max(0, Math.floor((z + half) / oc))) * on + Math.min(on - 1, Math.max(0, Math.floor((x + half) / oc)))];
  const mark = (x, z, r) => {
    const i0 = Math.max(0, Math.floor((x - r + half) / oc)), i1 = Math.min(on - 1, Math.floor((x + r + half) / oc));
    const j0 = Math.max(0, Math.floor((z - r + half) / oc)), j1 = Math.min(on - 1, Math.floor((z + r + half) / oc));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Math.hypot(-half + (i + 0.5) * oc - x, -half + (j + 0.5) * oc - z) <= r) occ[j * on + i] = 1;
  };
  const heightAt = (x, z) => {
    const gx = Math.min(n - 1.001, Math.max(0, (x + half) / cell)), gz = Math.min(n - 1.001, Math.max(0, (z + half) / cell)), i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, k = j * n + i;
    return (H[k] * (1 - fx) + H[k + 1] * fx) * (1 - fz) + (H[k + n] * (1 - fx) + H[k + n + 1] * fx) * fz;
  };
  const R = world.regions;
  const out = [];
  rules.layers.forEach((L, li) => {
    const set = opts.layers?.[L.id] ?? {}, want = (L.density ?? 0.5) * (set.density ?? 1) * global;
    // Över 1 räcker inte ett frö per ruta: rutnätet blir finare i stället (lika många per yta under 1, inget tak över)
    const fine = Math.max(1, want), density = want / fine;
    const res = { id: L.id, kind: L.kind, models: L.models.map((m) => m[0]), count: 0, data: null };
    out.push(res);
    if (set.on === false || density <= 0) { res.data = new Float32Array(0); return; }
    const sp = L.spacing / Math.sqrt(fine), cols = Math.ceil(size / sp), max = L.max ?? 50000, buf = new Float32Array(Math.min(max, cols * cols) * STRIDE);
    const bw = BIOMES.map((b) => L.biomes?.[b] ?? 0);
    const noise = L.clump ? createNoise(seed * 41 + li * 7 + 3) : null;
    const wsum = L.models.reduce((s, m) => s + m[1], 0);
    const [s0, s1] = L.scale ?? [0.85, 1.15];
    let count = 0;
    for (let cj = 0; cj < cols && count < max; cj++) for (let ci = 0; ci < cols && count < max; ci++) {
      const r1 = hash(ci, cj, li, seed), r2 = hash(cj, ci, li + 101, seed), r3 = hash(ci + 7, cj, li + 202, seed);
      if (r3 > density * 1.6) continue; // snabbt ut: täthet över 0,6 klarar sig ändå genom faktorerna nedan
      const x = -half + (ci + 0.15 + 0.7 * r1) * sp, z = -half + (cj + 0.15 + 0.7 * r2) * sp;
      if (Math.abs(x) > half - cell || Math.abs(z) > half - cell) continue;
      const i = Math.round((x + half) / cell), j = Math.round((z + half) / cell), k = j * n + i;
      const y = heightAt(x, z), e = sea == null ? y : y - sea;
      if (L.height && (e < L.height[0] || e > L.height[1])) continue;
      // Lutningen i grader ur grannarna
      const hx = (H[k + (i < n - 1 ? 1 : 0)] - H[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0) + (i < n - 1)));
      const hz = (H[k + (j < n - 1 ? n : 0)] - H[k - (j > 0 ? n : 0)]) / (cell * ((j > 0) + (j < n - 1)));
      const slope = Math.atan(Math.hypot(hx, hz)) * 180 / Math.PI;
      let f = 0;
      for (let b = 0; b < 8; b++) f += (B[k * 8 + b] / 255) * bw[b];
      if (f <= 0) continue;
      if (L.slope) f *= window01(L.slope[0], L.slope[1], slope, 3);
      // Fukten: avrinningen, eller träskets andel (ett målat träsk är blött även där inget vatten rinner)
      if (L.wet) f *= window01(L.wet[0], L.wet[1], Math.max(wet[k], B[k * 8 + MARSH] / 255), 0.08);
      if (L.height) f *= window01(L.height[0], L.height[1], e, Math.min(2, (L.height[1] - L.height[0]) * 0.1));
      // De målade marklagren: deras andel väger in med texturens verkan på den här sortens saker (stig, väg: inga träd)
      if (world.ground) {
        const { W, effects } = world.ground;
        let rest = 1, g = 0;
        for (let s = 0; s < SLOTS; s++) { const w = W[k * SLOTS + s] / 255; if (!w) continue; rest -= w; g += w * (effects[s]?.[L.kind] ?? 1); }
        f *= Math.max(0, rest) + g;
      }
      // Regionens tema: ett lager kan trivas mer (eller bara) i vissa teman, till exempel höstlöv i Autumn wood
      if (R && (L.themes || L.themeOnly)) {
        const P = R.P, pi = Math.min(P - 1, Math.round(((x + half) / size) * (P - 1))), pj = Math.min(P - 1, Math.round(((z + half) / size) * (P - 1))), o = (pj * P + pi) * R.count;
        let tf = 0;
        for (let r = 0; r < R.count; r++) tf += R.weights[o + r] * (L.themes?.[R.themes[r]] ?? (L.themeOnly ? 0 : 1));
        f *= tf;
      }
      if (noise) f *= Math.max(0, 1 + L.clump[1] * 2 * (noise(x / L.clump[0], z / L.clump[0]) + noise(x / (L.clump[0] * 0.4), z / (L.clump[0] * 0.4)) * 0.4));
      if (r3 >= density * f) continue;
      if (occAt(x, z)) continue;
      // Familjen efter vikt, och resten av instansen
      let pick = hash(ci, cj, li + 303, seed) * wsum, m = 0;
      while (m < L.models.length - 1 && pick > L.models[m][1]) { pick -= L.models[m][1]; m++; }
      const scale = s0 + (s1 - s0) * hash(ci, cj, li + 404, seed), nl = Math.hypot(hx, 1, hz);
      const o = count * STRIDE;
      buf[o] = x; buf[o + 1] = L.float && sea != null ? sea : y - (L.sink ?? 0) * scale; buf[o + 2] = z; // float: på vattenytan (näckrosblad)
      buf[o + 3] = hash(ci, cj, li + 505, seed) * Math.PI * 2; buf[o + 4] = scale; buf[o + 5] = m;
      buf[o + 6] = -hx / nl; buf[o + 7] = -hz / nl; buf[o + 8] = hash(ci, cj, li + 606, seed);
      if (L.footprint) mark(x, z, L.footprint * scale);
      count++;
    }
    res.count = count;
    res.data = buf.slice(0, count * STRIDE);
  });
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { layers: out, total: out.reduce((s, l) => s + l.count, 0), ms: Math.round(t1 - t0) };
}
