// Biomerna (docs/terrain.md, steg 2): vilken natur som växer var, ur geografin. Ren JavaScript utan Three.js, som
// generate.js, så att samma kod körs i workern och i kontrollerna i Node. Efter
// patriks_input/AAA_Terrain_Worldbuilding_Texturing_ThreeJS_Reference.md (Data model, Example 3): separata kartor för
// höjd, lutning, fukt, temperatur och avstånd till vatten, och mjuka vikter som summerar till 1.
//
// Kartorna: höjden över havet, lutningen, fukten (dropparnas spår ur generate.js, plus regn och fuktig kustluft) och
// avståndet till havet. Temperaturen följer höjden mot trädgränsen och snögränsen (spakarna, i meter), inte en
// verklig lapse rate: öarna är några hundra meter höga, och gränserna ska gå att styra. Ett lågfrekvent brus ger
// skogen dungar och gläntor.
//
//   const b = computeBiomes(t, recipe, rf);   // t ur generateTerrain, rf ur regions.js (valfri); { weights (Uint8, n·n·8), coverage (% av landet), ms }
//   mixPaint(b.weights, paint, n)          // det målade lagret ovanpå (se nedan)

import { createNoise } from './generate.js';
import { K } from './regions.js';

// Ordningen är densamma överallt: vikterna, attributen bio0 (0–3) och bio1 (4–7) och färgerna i terrain.json
export const BIOMES = ['beach', 'meadow', 'forest', 'pine', 'marsh', 'heath', 'rock', 'snow'];
export const PAINT_SIZE = 256; // det målade lagret: 256 × 256 rutor över hela världen, oavsett storlek

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Avståndet till havet i meter (chamferavstånd, två svep), för varje hörn; utan hav oändligt
export function seaDistance(heights, n, cell, sea) {
  const INF = 1e9, d = new Float32Array(n * n);
  if (sea == null) return d.fill(INF);
  for (let k = 0; k < d.length; k++) d[k] = heights[k] <= sea ? 0 : INF;
  const a = cell, b = cell * Math.SQRT2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    if (i > 0) d[k] = Math.min(d[k], d[k - 1] + a);
    if (j > 0) { d[k] = Math.min(d[k], d[k - n] + a); if (i > 0) d[k] = Math.min(d[k], d[k - n - 1] + b); if (i < n - 1) d[k] = Math.min(d[k], d[k - n + 1] + b); }
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const k = j * n + i;
    if (i < n - 1) d[k] = Math.min(d[k], d[k + 1] + a);
    if (j < n - 1) { d[k] = Math.min(d[k], d[k + n] + a); if (i < n - 1) d[k] = Math.min(d[k], d[k + n + 1] + b); if (i > 0) d[k] = Math.min(d[k], d[k + n - 1] + b); }
  }
  return d;
}

// t: { n, cell, half, heights, wet } ur generateTerrain. R: receptet (sea, seaLevel, sandBand, snowline, cliffAngle,
// treeline, rainfall, forestCover, marshes, coastWind, seed). rf: regionernas fält (regions.js); med det tar varje
// hörn klimatet och biomernas vikter ur sina regioner i stället för ur världens spakar
export function computeBiomes(t, R, rf = null) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { n, cell, half, heights: H, wet } = t;
  const sea = R.sea ? (R.seaLevel ?? 0) : null, seaY = sea ?? -Infinity;
  const dSea = seaDistance(H, n, cell, sea);
  const noise = createNoise((R.seed ?? 1) * 5 + 11), patch = createNoise((R.seed ?? 1) * 3 + 2);
  const cliff = Math.cos((R.cliffAngle ?? 36) * Math.PI / 180), sand = R.sandBand ?? 1.4;
  let tree = R.treeline ?? 120, snow = R.snowline ?? 150, rain = R.rainfall ?? 0.5, cover = R.forestCover ?? 0.55, marshes = R.marshes ?? 0.3, wind = R.coastWind ?? 40;
  const weights = new Uint8Array(n * n * 8), w = new Float32Array(8), sum = new Float64Array(8), rv = new Float32Array(K.size);
  let land = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, h = H[k], e = h - (sea ?? 0);
    if (h <= seaY) { weights[k * 8] = 255; continue; } // under havet: sandbotten (strandens lager), räknas inte i andelarna
    land++;
    const x = -half + i * cell, z = -half + j * cell;
    if (rf) { rf.sample(x, z, rv); tree = rv[K.treeline]; snow = rv[K.snowline]; rain = rv[K.rainfall]; cover = rv[K.forestCover]; marshes = rv[K.marshes]; wind = rv[K.coastWind]; }
    // Lutningen ur grannarna (centrala differenser), som normalens y
    const hx = (H[k + (i < n - 1 ? 1 : 0)] - H[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0) + (i < n - 1)));
    const hz = (H[k + (j < n - 1 ? n : 0)] - H[k - (j > 0 ? n : 0)]) / (cell * ((j > 0) + (j < n - 1)));
    const up = 1 / Math.hypot(hx, 1, hz);
    const low = noise(x / 90, z / 90) * 0.6 + noise(x / 30, z / 30) * 0.25; // −1..1, dungar och gläntor
    const coast = Math.exp(-dSea[k] / Math.max(1, wind)); // 1 vid stranden, 0 inåt land
    // Fukten: dropparnas spår, regnet och kustluften, minus branta sluttningar där vattnet rinner av
    const m = Math.min(1, Math.max(0, wet[k] * 0.7 + rain * 0.55 + coast * 0.15 - (1 - up) * 0.8 + low * 0.12));
    const steep = smooth(cliff + 0.06, cliff - 0.06, up); // klippa
    const cold = smooth(tree - 15, tree + 25, e + low * 8); // över trädgränsen
    const frozen = smooth(snow - 6, snow + 10, e + low * 6) * smooth(0.55, 0.8, up);
    w[0] = sea == null ? 0 : smooth(sand * 1.6 + 0.5, sand * 0.6, e + low * 0.6) * smooth(0.75, 0.9, up) * smooth(60, 15, dSea[k]); // strand
    w[6] = Math.max(steep, cold * (1 - frozen)) * (1 - w[0]); // berg: klippor och kalfjäll
    w[7] = frozen; // snö
    const free = Math.max(0, 1 - w[0] - w[6] - w[7]); // det som är kvar för växtligheten
    const flat = smooth(0.94, 0.985, up);
    const marsh = Math.min(1, smooth(0.5, 0.72, m + (marshes - 0.3) * 0.5) * flat * smooth(tree * 0.5, tree * 0.1, e) * marshes * 2.5);
    const dry = smooth(0.45, 0.2, m) + coast * smooth(0.3, 0.8, wind / 80) * 0.6; // hed: torrt eller vindpinat vid kusten
    const woods = smooth(-0.15, 0.25, low + (cover - 0.5) * 1.2) * smooth(0.25, 0.5, m) * (1 - coast * 0.8) * smooth(0.6, 0.8, up);
    const pineBand = smooth(tree * 0.45, tree * 0.8, e + low * 10); // barrskog högre upp och närmare trädgränsen
    w[4] = marsh * free;
    w[5] = Math.min(1, dry) * (1 - marsh) * free * 0.9;
    w[2] = woods * (1 - pineBand) * (1 - marsh) * free;
    w[3] = woods * pineBand * (1 - marsh) * free + smooth(0.2, 0.6, m) * pineBand * (1 - cold) * free * 0.25;
    w[1] = Math.max(0.05, free - w[2] - w[3] - w[4] - w[5]) * (0.6 + 0.4 * (1 - dry)); // äng: resten
    if (rf) for (let b = 0; b < 8; b++) w[b] *= rv[K.bias + b]; // regionens tema: vilka biomer som trivs där
    let s = 0;
    for (let b = 0; b < 8; b++) s += w[b];
    if (s < 1e-6) { w[1] = 1; s = 1; } // ett tema som stängt av allt: äng
    for (let b = 0; b < 8; b++) { const v = w[b] / s; weights[k * 8 + b] = Math.round(v * 255); sum[b] += v; }
  }
  // Andelarna av landet (procent), för lådan, footern och kontrollerna
  const coverage = Object.fromEntries(BIOMES.map((id, b) => [id, land ? Math.round((1000 * sum[b]) / land) / 10 : 0]));
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { weights, coverage, ms: Math.round(t1 - t0) };
}

// Det målade lagret: PAINT_SIZE² rutor med biomens nummer + 1 (0 = omålat) och styrkan (0–255). Ovanpå de
// beräknade vikterna: vikt = (1 − styrka) · beräknad + styrka · målad biom. Varje hörn läser de fyra närmaste rutorna
// bilinjärt, och varje ruta bidrar med sin styrka till sin egen biom; där två målade biomer möts tonas de alltså i
// varandra i stället för att rutorna byter biom tvärt (det gav en fyrkantig trappa i gränsen). out får samma form som
// auto (n · n · 8).
// En rutas bidrag till sin biom (vikten w · styrkan); svarar med bidraget
function add(acc, ids, str, c, w) {
  if (!ids[c] || !str[c] || w <= 0) return 0;
  const a = (w * str[c]) / 255;
  acc[ids[c] - 1] += a;
  return a;
}
export function mixPaint(auto, paint, n, out = new Uint8Array(auto.length)) {
  if (!paint) { out.set(auto); return out; }
  const P = PAINT_SIZE, ids = paint.subarray(0, P * P), str = paint.subarray(P * P), acc = new Float32Array(8);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, gx = (i / (n - 1)) * (P - 1), gz = (j / (n - 1)) * (P - 1);
    const pi = Math.min(P - 2, Math.floor(gx)), pj = Math.min(P - 2, Math.floor(gz)), fx = gx - pi, fz = gz - pj, q = pj * P + pi;
    if (!str[q] && !str[q + 1] && !str[q + P] && !str[q + P + 1]) { for (let b = 0; b < 8; b++) out[k * 8 + b] = auto[k * 8 + b]; continue; }
    acc.fill(0);
    const s = add(acc, ids, str, q, (1 - fx) * (1 - fz)) + add(acc, ids, str, q + 1, fx * (1 - fz)) + add(acc, ids, str, q + P, (1 - fx) * fz) + add(acc, ids, str, q + P + 1, fx * fz);
    if (s <= 0) { for (let b = 0; b < 8; b++) out[k * 8 + b] = auto[k * 8 + b]; continue; }
    for (let b = 0; b < 8; b++) out[k * 8 + b] = Math.round(auto[k * 8 + b] * (1 - s) + 255 * acc[b]);
  }
  return out;
}

// Penseln: ett drag i det målade lagret kring (x, z) i världen. biome = index i BIOMES, eller −1 för att sudda.
// radius i meter, strength 0..1 per drag; mjuk kant (smoothstep). Svarar med de rutor som ändrats (för uppdatering).
export function paintStroke(paint, x, z, { biome, radius, strength = 0.35, size }) {
  const P = PAINT_SIZE, ids = paint.subarray(0, P * P), str = paint.subarray(P * P), cellP = size / P, half = size / 2;
  const ci = (x + half) / cellP, cj = (z + half) / cellP, r = radius / cellP;
  let changed = 0;
  for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(P - 1, Math.ceil(cj + r)); j++) {
    for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(P - 1, Math.ceil(ci + r)); i++) {
      const d = Math.hypot(i - ci, j - cj) / r;
      if (d >= 1) continue;
      const a = smooth(1, 0.5, d) * strength, q = j * P + i;
      if (biome < 0) { str[q] = Math.max(0, Math.round(str[q] * (1 - a))); if (!str[q]) ids[q] = 0; }
      else {
        if (ids[q] !== biome + 1) { str[q] = Math.round(str[q] * (1 - a)); ids[q] = biome + 1; }
        str[q] = Math.min(255, Math.round(str[q] + (255 - str[q]) * a));
      }
      changed++;
    }
  }
  return changed;
}

// Lagret som text i receptet (base64), och tillbaka; tomt lager → null
export function encodePaint(paint) {
  if (!paint || !paint.subarray(PAINT_SIZE * PAINT_SIZE).some((v) => v)) return null;
  let s = '';
  for (let k = 0; k < paint.length; k += 0x8000) s += String.fromCharCode(...paint.subarray(k, k + 0x8000));
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}
export function decodePaint(text) {
  const out = new Uint8Array(PAINT_SIZE * PAINT_SIZE * 2);
  if (!text) return out;
  const s = typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary');
  for (let k = 0; k < Math.min(s.length, out.length); k++) out[k] = s.charCodeAt(k);
  return out;
}
