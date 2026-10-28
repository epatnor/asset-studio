// Regionerna (docs/terrain.md, steget Regions): nivån över biomerna, som zonerna i ett rollspel. Biomen säger vad som
// växer (äng, skog, myr); regionen säger hur det ser ut och känns: sitt eget klimat (regn, skog, trädgräns), vilka
// biomer som trivs, en färgton på växtligheten och senare väder, musik och vad som bor där. Ren JavaScript, som
// biomes.js, så att samma kod körs i workern och i kontrollerna i Node.
//
// Varje region har en mittpunkt (satt för hand eller utplacerad automatiskt över landet) och växer ut från den som
// en flodvåg (Dijkstra på ett grovt rutnät): att klättra över en ås, korsa en å eller gå över havet kostar mer, så
// gränserna hamnar gärna där naturliga gränser brukar gå. Ett brus låter dem slingra, och nära gränsen blandas
// regionerna mjukt (regionBorder meter). Ovanpå ligger ett målat lager, som biomernas.
//
//   const rf = regionField(t, recipe, cache);   // { P, count, weights, table, centers, coverage, sample(x, z, out), ms }
//   computeBiomes(t, recipe, rf)                // klimatet och biomernas vikter per hörn ur regionerna
//   regionAttributes(t, rf)                     // { reg, look }: kartfärg och färgton per hörn, till marken
//
// Receptet: regions [{ name, theme, at: [u, v] eller null (automatiskt), adjust: { rain, forest, treeline, tone } }],
// regionThemes (terrain.json), regionColors, regionBorder (m), regionWander (0..1), regionTerrain (0..1) och
// regionPaint (PAINT_SIZE² rutor: regionens nummer + 1 och styrkan, som biomernas målade lager).

import { createNoise } from './generate.js';
import { BIOMES, PAINT_SIZE } from './biomes.js';

export const REGION_GRID = 256; // regionerna räknas på samma 256 × 256 rutor som det målade lagret (PAINT_SIZE; biomes.js och regions.js läser varandra, så inget av dem används när modulen laddas)
// Tabellen per ruta: klimatet (6), biomernas vikter (8), färgtonen (3 + 1), kartfärgen (3) och hur ren regionen är (1)
export const K = { treeline: 0, snowline: 1, rainfall: 2, forestCover: 3, marshes: 4, coastWind: 5, bias: 6, tint: 14, tone: 17, color: 18, pure: 21, size: 22 };

const clamp = (a, b, x) => Math.min(b, Math.max(a, x));
const hexRgb = (h) => { const v = parseInt(String(h ?? '#ffffff').replace('#', ''), 16) || 0; return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// En regions värden i tabellen: världens klimatspakar ändrade av temat (tillägg eller faktorer) och regionens egna
// justeringar. Utan tema och justeringar blir det exakt världens spakar, så en värld med en region ser ut som förut.
export function resolveRegion(reg, theme, R, color) {
  const a = reg?.adjust ?? {}, T = theme ?? {};
  const v = new Float32Array(K.size);
  v[K.treeline] = (R.treeline ?? 120) * (T.treeline ?? 1) + (a.treeline ?? 0);
  v[K.snowline] = (R.snowline ?? 150) * (T.snowline ?? 1);
  v[K.rainfall] = clamp(0, 1, (R.rainfall ?? 0.5) + (T.rain ?? 0) + (a.rain ?? 0));
  v[K.forestCover] = clamp(0, 1, (R.forestCover ?? 0.55) + (T.forest ?? 0) + (a.forest ?? 0));
  v[K.marshes] = clamp(0, 1, (R.marshes ?? 0.3) + (T.marsh ?? 0));
  v[K.coastWind] = (R.coastWind ?? 40) * (T.wind ?? 1);
  BIOMES.forEach((b, i) => { v[K.bias + i] = T.biomes?.[b] ?? 1; });
  v.set(hexRgb(T.tint), K.tint);
  v[K.tone] = clamp(-1, 1, (T.tone ?? 0) + (a.tone ?? 0));
  v.set(hexRgb(color), K.color);
  v[K.pure] = 1;
  return v;
}

// Bilinjärt ur ett hörnrutnät (n × n, cell meter, (0, 0) i mitten)
function gridAt(arr, n, cell, half, x, z) {
  const gx = clamp(0, n - 1.001, (x + half) / cell), gz = clamp(0, n - 1.001, (z + half) / cell), i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, k = j * n + i;
  return (arr[k] * (1 - fx) + arr[k + 1] * fx) * (1 - fz) + (arr[k + n] * (1 - fx) + arr[k + n + 1] * fx) * fz;
}

// Mittpunkterna: de satta står kvar, de automatiska sprids över landet (längst bort från de andra) och dras sedan
// mot mitten av sitt område (tre varv Lloyd), så att regionerna blir ungefär lika stora. Svar i meter.
export function placeCenters(regs, size, land) {
  const half = size / 2, pts = land.length ? land : [[0, 0]];
  const centers = regs.map((r) => (Array.isArray(r?.at) ? [r.at[0] * size, r.at[1] * size] : null));
  const auto = centers.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
  if (!auto.length) return centers;
  // Den första automatiska: närmast landets tyngdpunkt, om ingen är satt
  for (const i of auto) {
    const fixed = centers.filter(Boolean);
    let best = pts[0], bd = -1;
    if (!fixed.length) {
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      bd = Infinity;
      for (const p of pts) { const d = (p[0] - cx) ** 2 + (p[1] - cz) ** 2; if (d < bd) { bd = d; best = p; } }
    } else {
      for (const p of pts) {
        let m = Infinity;
        for (const c of fixed) m = Math.min(m, (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2);
        if (m > bd) { bd = m; best = p; }
      }
    }
    centers[i] = [best[0], best[1]];
  }
  for (let it = 0; it < 3; it++) {
    const sx = new Float64Array(centers.length), sz = new Float64Array(centers.length), cnt = new Float64Array(centers.length);
    for (const p of pts) {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2; if (d < bd) { bd = d; bi = i; } });
      sx[bi] += p[0]; sz[bi] += p[1]; cnt[bi]++;
    }
    for (const i of auto) if (cnt[i]) {
      // Mot tyngdpunkten, men alltid på land: den landpunkt som ligger närmast
      const gx = sx[i] / cnt[i], gz = sz[i] / cnt[i];
      let best = centers[i], bd = Infinity;
      for (const p of pts) { const d = (p[0] - gx) ** 2 + (p[1] - gz) ** 2; if (d < bd) { bd = d; best = p; } }
      centers[i] = [best[0], best[1]];
    }
  }
  return centers.map((c) => [clamp(-half, half, c[0]), clamp(-half, half, c[1])]);
}

// Avståndet från en mittpunkt över rutnätet (Dijkstra, åtta grannar), där branter, fuktiga stråk och hav kostar mer
function geodesic(P, cellP, H, Wt, seaY, start, follow, dist, heap) {
  dist.fill(Infinity);
  const hc = heap.c, hi = heap.i;
  let size = 0;
  const push = (c, i) => { let k = size++; while (k > 0) { const p = (k - 1) >> 1; if (hc[p] <= c) break; hc[k] = hc[p]; hi[k] = hi[p]; k = p; } hc[k] = c; hi[k] = i; };
  const pop = () => {
    const top = hi[0], c = hc[--size], i = hi[size];
    let k = 0;
    for (;;) { let m = 2 * k + 1; if (m >= size) break; if (m + 1 < size && hc[m + 1] < hc[m]) m++; if (hc[m] >= c) break; hc[k] = hc[m]; hi[k] = hi[m]; k = m; }
    hc[k] = c; hi[k] = i;
    return top;
  };
  dist[start] = 0;
  push(0, start);
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (size) {
    const c0 = hc[0], a = pop();
    if (c0 > dist[a]) continue;
    const ai = a % P, aj = (a - ai) / P;
    for (const [di, dj, l] of D) {
      const bi = ai + di, bj = aj + dj;
      if (bi < 0 || bj < 0 || bi >= P || bj >= P) continue;
      const b = bj * P + bi, len = l * cellP;
      const cost = len * (1 + follow * ((4 * Math.abs(H[b] - H[a])) / len + (H[b] <= seaY ? 3 : Wt[b] * 2)));
      if (dist[a] + cost < dist[b]) { dist[b] = dist[a] + cost; if (size < hc.length) push(dist[b], b); }
    }
  }
  return dist;
}

// Regionernas fält. cache (valfri, ett objekt som workern behåller) sparar de beräknade vikterna mellan anropen, så
// att ett nytt tema, en ny justering eller ett penseldrag inte räknar om avstånden.
export function regionField(t, R, cache = {}) {
  const t0 = now(), P = REGION_GRID, { size, half, n, cell, heights, wet } = t;
  const regs = (Array.isArray(R.regions) && R.regions.length ? R.regions : [{ name: 'Heartland', theme: 'temperate' }]).slice(0, 16);
  const count = regs.length, cellP = size / (P - 1);
  const sea = R.sea ? (R.seaLevel ?? 0) : null, seaY = sea ?? -Infinity;
  const xy = (i) => -half + i * cellP;
  // Höjden, fukten och landet på regionernas rutnät
  if (cache.terrain !== t) {
    cache.terrain = t;
    cache.H = new Float32Array(P * P); cache.W = new Float32Array(P * P); cache.land = [];
    for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) {
      const k = j * P + i, x = xy(i), z = xy(j);
      cache.H[k] = gridAt(heights, n, cell, half, x, z);
      cache.W[k] = gridAt(wet, n, cell, half, x, z);
      if (cache.H[k] > seaY + 0.3 && i % 4 === 0 && j % 4 === 0) cache.land.push([x, z]);
    }
    cache.key = null;
  }
  const { H, W } = cache;
  const centers = placeCenters(regs, size, cache.land);
  const border = Math.max(1, R.regionBorder ?? 60), wander = R.regionWander ?? 0.5, follow = R.regionTerrain ?? 0.6;
  const key = JSON.stringify([centers, border, wander, follow, R.seed ?? 1]);
  if (cache.key !== key) {
    const weights = new Float32Array(P * P * count);
    if (count === 1) weights.fill(1);
    else {
      const d = new Float32Array(P * P * count), dist = new Float64Array(P * P);
      const heap = { c: new Float64Array(P * P * 8), i: new Int32Array(P * P * 8) };
      const noise = createNoise((R.seed ?? 1) * 7 + 3), lam = size * 0.12, amp = wander * size * 0.05;
      centers.forEach((c, r) => {
        const si = clamp(0, P - 1, Math.round((c[0] + half) / cellP)), sj = clamp(0, P - 1, Math.round((c[1] + half) / cellP));
        geodesic(P, cellP, H, W, seaY, sj * P + si, follow, dist, heap);
        for (let k = 0; k < P * P; k++) {
          const i = k % P, j = (k - i) / P;
          d[k * count + r] = dist[k] + amp * noise(xy(i) / lam + r * 37.1, xy(j) / lam - r * 19.3);
        }
      });
      // Mjuk gräns: varje region väger (1 − (d − dmin) / border)², nära noll en border bort från den närmaste
      for (let k = 0; k < P * P; k++) {
        let m = Infinity, s = 0;
        for (let r = 0; r < count; r++) m = Math.min(m, d[k * count + r]);
        for (let r = 0; r < count; r++) { const q = Math.max(0, 1 - (d[k * count + r] - m) / border); s += weights[k * count + r] = q * q; }
        for (let r = 0; r < count; r++) weights[k * count + r] /= s;
      }
    }
    cache.key = key;
    cache.auto = weights;
  }
  // Det målade lagret ovanpå: vikt = (1 − styrka) · beräknad + styrka · målad region
  const weights = new Float32Array(cache.auto);
  const paint = R.regionPaint;
  if (paint && paint.length === P * P * 2 && count > 1) {
    for (let k = 0; k < P * P; k++) {
      const id = paint[k] - 1, s = paint[P * P + k] / 255;
      if (id < 0 || id >= count || s <= 0) continue;
      for (let r = 0; r < count; r++) weights[k * count + r] = weights[k * count + r] * (1 - s) + (r === id ? s : 0);
    }
  }
  // Tabellen per ruta, ur regionernas värden
  const themes = R.regionThemes ?? {}, colors = R.regionColors ?? ['#d9a441'];
  const vals = regs.map((g, r) => resolveRegion(g, themes[g?.theme], R, g?.color ?? colors[r % colors.length]));
  const table = new Float32Array(P * P * K.size), cover = new Float64Array(count);
  let land = 0;
  for (let k = 0; k < P * P; k++) {
    const o = k * K.size, isLand = H[k] > seaY;
    let pure = 0;
    for (let r = 0; r < count; r++) {
      const w = weights[k * count + r];
      if (!w) continue;
      const v = vals[r];
      for (let q = 0; q < K.pure; q++) table[o + q] += v[q] * w;
      pure = Math.max(pure, w);
      if (isLand) cover[r] += w;
    }
    table[o + K.pure] = pure;
    if (isLand) land++;
  }
  const coverage = Array.from(cover, (c) => (land ? Math.round((1000 * c) / land) / 10 : 0));
  const constant = count === 1;
  // Värdena i en punkt i världen, bilinjärt mellan rutorna; out får K.size platser
  const sample = (x, z, out) => {
    if (constant) { for (let q = 0; q < K.size; q++) out[q] = table[q]; return out; }
    const gx = clamp(0, P - 1.001, (x + half) / cellP), gz = clamp(0, P - 1.001, (z + half) / cellP), i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const a = (j * P + i) * K.size, b = a + K.size, c = a + P * K.size, e = c + K.size;
    for (let q = 0; q < K.size; q++) out[q] = (table[a + q] * (1 - fx) + table[b + q] * fx) * (1 - fz) + (table[c + q] * (1 - fx) + table[e + q] * fx) * fz;
    return out;
  };
  return { P, count, weights, table, centers, coverage, sample, constant, ms: Math.round(now() - t0) };
}

// Per hörn till marken: reg = kartfärgen (rgb) och hur ren regionen är (a, lägre vid gränsen); look = färgtonen på
// växtligheten (rgb, en faktor) och tonen torr–frodig (a: 0,5 = världens, 0 torrare, 1 frodigare)
export function regionAttributes(t, rf) {
  const { n, cell, half } = t, reg = new Uint8Array(n * n * 4), look = new Uint8Array(n * n * 4), v = new Float32Array(K.size);
  const b = (x) => Math.round(clamp(0, 1, x) * 255);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j * n + i) * 4;
    rf.sample(-half + i * cell, -half + j * cell, v);
    reg[k] = b(v[K.color]); reg[k + 1] = b(v[K.color + 1]); reg[k + 2] = b(v[K.color + 2]); reg[k + 3] = b(v[K.pure]);
    look[k] = b(v[K.tint]); look[k + 1] = b(v[K.tint + 1]); look[k + 2] = b(v[K.tint + 2]); look[k + 3] = b(0.5 + v[K.tone] * 0.5);
  }
  return { reg, look };
}

// Regionernas målade lager när en region tas bort: dess rutor töms, och de efter den flyttar ett steg ned
export function removeFromPaint(paint, index) {
  const P = PAINT_SIZE;
  for (let k = 0; k < P * P; k++) {
    const id = paint[k] - 1;
    if (id === index) { paint[k] = 0; paint[P * P + k] = 0; } else if (id > index) paint[k] = id;
  }
  return paint;
}
