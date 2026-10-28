// Terränggeneratorn (docs/terrain.md, T3): ett höjdfält ur ett recept, i Kartrummets flik Landscape. Ren JavaScript
// utan Three.js, så att samma kod körs i studion, i en worker och i kontrollerna i Node. Byggd efter
// patriks_input/AAA_Terrain_Worldbuilding_Texturing_ThreeJS_Reference.md, med Tinkertowns generator som förlaga:
//
// - Brus: seedat gradientbrus i flera oktaver (fbm), åsbrus (1 − |n|, kvadrerat) för bergskammar och domänvridning,
//   så att formerna slingrar sig i stället för att se ut som brus.
// - Form: receptets shape lägger en mask över bruset: ö, skärgård, öppet land, dal, kanjon eller kust.
// - Terrasser: höjden trappas i mjuka steg (platåer och klippband).
// - Erosion: droppar som rinner nedför, river och lägger av material (Beyer 2015, som Sebastian Lagues), och termisk
//   erosion som rasar branter till rasvinkeln. Dropparnas väg blir fuktkartan (där vatten runnit), som marklagren läser.
//
//   const t = generateTerrain(recipe);   // { n, size, cell, heights, wet, ms }
//   t.heightAt(x, z)                     // bilinjärt i världen, (0, 0) i mitten

// ---------- Brus ----------
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 2D-gradientbrus (Perlin) med en seedad permutation; ungefär −1..1
export function createNoise(seed) {
  const r = rng(seed), p = new Uint8Array(512), gx = new Float32Array(256), gz = new Float32Array(256);
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  for (let i = 0; i < 256; i++) { const a = r() * Math.PI * 2; gx[i] = Math.cos(a); gz[i] = Math.sin(a); }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, X = ix & 255, Z = iz & 255;
    const g = (i, j, dx, dz) => { const h = p[p[X + i] + Z + j]; return gx[h] * dx + gz[h] * dz; };
    const u = fade(fx), v = fade(fz);
    const a = g(0, 0, fx, fz) + (g(1, 0, fx - 1, fz) - g(0, 0, fx, fz)) * u;
    const b = g(0, 1, fx, fz - 1) + (g(1, 1, fx - 1, fz - 1) - g(0, 1, fx, fz - 1)) * u;
    return (a + (b - a) * v) * 1.41;
  };
}
// fbm: oktaver med halverad våglängd; gain = hur mycket varje finare oktav väger
function fbm(noise, x, z, octaves, gain) {
  let s = 0, a = 1, f = 1, n = 0;
  for (let o = 0; o < octaves; o++) { s += noise(x * f + o * 17.3, z * f - o * 9.1) * a; n += a; a *= gain; f *= 2.02; }
  return s / n;
}
// Åsbrus: skarpa kammar där bruset korsar noll; varje oktav viktas med den förra, så att kammarna förgrenar sig
function ridged(noise, x, z, octaves, gain) {
  let s = 0, a = 1, f = 1, n = 0, w = 1;
  for (let o = 0; o < octaves; o++) {
    const nv = noise(x * f + o * 31.7, z * f + o * 11.3);
    let v = 1 - Math.sqrt(nv * nv + 0.004); // mjukt |n|: rundade krön i stället för knivskarpa
    v *= v * w;
    w = Math.min(1, Math.max(0, v * 2));
    s += v * a; n += a; a *= gain; f *= 2.02;
  }
  return s / n;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------- Formerna: mask över bruset, u och v från −1 till 1 över platsen ----------
// Varje form får bruset b (0..1, berg och kullar), ett lågfrekvent brus w (−1..1, för oregelbundna kanter) och svarar
// med höjden i andelar av receptets height; under 0 är under havet.
const SHAPES = {
  // Öppet land: bara bruset (kullar, berg, slätter, högland)
  open: (u, v, b) => b,
  // En ö: en kupol som stiger inåt land (högst i mitten, inte en platå), bruset ovanpå, och en oregelbunden strand
  island: (u, v, b, w, R) => {
    const r = Math.hypot(u, v) + w * 0.22, land = smooth(R.coast + 0.15, R.coast - 0.2, r), dome = Math.max(0, 1 - r / (R.coast + 0.15)) ** 0.75;
    return (0.2 + b * 0.8) * dome * land - 0.18 * (1 - land);
  },
  // Skärgård: många öar där det låga bruset sticker upp, allt glesare utåt
  archipelago: (u, v, b, w, R, lo) => { const r = Math.hypot(u, v); const land = smooth(-0.05, 0.3, lo + 0.25 - r * 0.45) * smooth(0.97, 0.8, Math.max(Math.abs(u), Math.abs(v))); return b * land - 0.15 * (1 - land); },
  // Vulkan: en kon med krater i toppen, kullar och raviner på sluttningarna, havet runt om
  volcano: (u, v, b, w, R) => {
    const k = (Math.hypot(u, v) + w * 0.12) / (R.coast ?? 0.8), cone = Math.max(0, 1 - k) ** 1.25;
    const crater = smooth(0.16, 0.07, k) * 0.42;
    return (cone * 0.85 + (b - 0.4) * 0.35 * smooth(1.05, 0.6, k) - crater) * smooth(1.12, 0.95, k) - 0.2 * smooth(0.9, 1.2, k);
  },
  // Atoll: en ring av låga öar runt en grund lagun, med öppningar i ringen
  atoll: (u, v, b, w, R) => {
    const k = Math.hypot(u, v) / (R.coast ?? 0.8), ring = 1 - Math.abs(k - 0.86) / 0.11;
    const land = smooth(0.3, 0.6, ring * 0.8 + w * 0.9 + (b - 0.5) * 0.9); // bruset bryter ringen i öar med öppningar
    const sea = -1.0 + 0.6 * smooth(1.0, 0.8, k); // lagunen några meter djup, havet utanför djupare
    return sea * (1 - land) + land * (0.1 + b * 0.35);
  },
  // Två öar med ett sund emellan
  twin: (u, v, b, w) => {
    const r = Math.min(Math.hypot(u + 0.38, v - 0.1) / 0.5, Math.hypot(u - 0.4, v + 0.18) / 0.42) + w * 0.22;
    return b * smooth(1.2, 0.65, r) - 0.18 * smooth(0.8, 1.2, r);
  },
  // Halvmåne: en ö med en stor, skyddad vik som öppnar sig mot havet
  crescent: (u, v, b, w, R) => {
    const r = Math.hypot(u, v) + w * 0.2, bay = Math.hypot(u - 0.32, v - 0.38) / 0.55 + w * 0.15;
    const land = smooth((R.coast ?? 0.8) + 0.25, (R.coast ?? 0.8) - 0.3, r) * smooth(0.75, 1.25, bay); // mjuk sluttning ned i viken
    return b * land - 0.18 * (1 - land);
  },
  // Kust: land på ena sidan (bortåt, −v), havet på den andra
  coast: (u, v, b, w) => { const t = smooth(-0.35, 0.35, -v * 0.9 + w * 0.3 + 0.1); return b * t - 0.16 * (1 - t); },
  // Dal: två åsar med en bred, flack dalbotten som slingrar sig längs mitten
  valley: (u, v, b, w) => { const d = Math.abs(u + w * 0.35); return 0.04 + b * 0.3 * smooth(0.05, 0.25, d) + smooth(0.12, 0.85, d) * (0.45 + b * 0.55); },
  // Kanjon: en hög platå med en djup, slingrande klyfta och branta väggar
  canyon: (u, v, b, w) => { const d = Math.abs(u * 1.1 + w * 0.45 + Math.sin(v * 3.1) * 0.12); return 0.15 + smooth(0.06, 0.16, d) * (0.6 + b * 0.25); },
};

const SEA_SHAPES = new Set(['island', 'archipelago', 'coast', 'volcano', 'atoll', 'twin', 'crescent']);

// ---------- Generatorn ----------
// Världens rutnät efter storleken: högst 1025 × 1025 hörn (0,5 m upp till 512 m, sedan size / 1024), och havsbottnen
// utanför platsen djupare i större världar
export const worldGrid = (size) => ({ size, cell: Math.max(0.5, size / 1024), seaFloor: -Math.max(16, size / 40) });

// recipe: shape, seed, size (m), cell (m), height (m), scale (m per kulle), octaves, roughness (0..1), ridges (0..1),
// warp (m), terraces (antal), terraceSharp (0..1), coast (ön: var stranden går, andel av radien), erosion (0..1),
// talus (rasvinkel, grader), sea (havsnivån i m, eller null utan hav)
export function generateTerrain(R) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const size = R.size ?? 256, cell = R.cell ?? 0.5, n = Math.round(size / cell) + 1, half = size / 2;
  const noise = createNoise(R.seed ?? 1), warpNoise = createNoise((R.seed ?? 1) * 7 + 3), loNoise = createNoise((R.seed ?? 1) * 13 + 5);
  const shape = SHAPES[R.shape] ?? SHAPES.open;
  const sc = 1 / (R.scale ?? 80), oct = R.octaves ?? 6, gain = 0.3 + 0.45 * (R.roughness ?? 0.5), ridges = R.ridges ?? 0, warp = R.warp ?? 0;
  const terraces = R.terraces ?? 0, sharp = R.terraceSharp ?? 0.5;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -half + i * cell, z = -half + j * cell;
    // Domänvridning: platsen förskjuts av ett grovt brus innan bruset läses
    const wx = x + warp * fbm(warpNoise, x * sc * 0.5, z * sc * 0.5, 3, 0.5), wz = z + warp * fbm(warpNoise, x * sc * 0.5 + 41.7, z * sc * 0.5 - 13.2, 3, 0.5);
    const soft = fbm(noise, wx * sc, wz * sc, oct, gain) * 0.5 + 0.5, sharpB = ridged(noise, wx * sc * 0.8, wz * sc * 0.8, oct, gain);
    let b = soft * (1 - ridges) + sharpB * ridges;
    if (terraces > 0) {
      // Mjuka trappsteg: varje steg går från platt (sharp 1) till jämn lutning (sharp 0)
      const s = b * terraces, k = Math.floor(s), f = s - k, e = 0.5 - 0.5 * Math.cos(Math.PI * Math.pow(f, 1 + sharp * 6));
      b = (k + f * (1 - sharp) + e * sharp) / terraces;
    }
    const w = fbm(loNoise, x / size * 3, z / size * 3, 3, 0.5), lo = fbm(loNoise, x / size * 4 + 9, z / size * 4 - 4, 4, 0.55);
    let hh = shape(x / half, z / half, b, w, R, lo) * (R.height ?? 30);
    // Former med hav: havsbottnen sjunker utåt mot seaFloor (rundat och oregelbundet, så att inget grund får platsens
    // fyrkantiga form) och möter bottnen utanför platsen; bara under vattnet, land sänks aldrig
    if (SEA_SHAPES.has(R.shape)) {
      const r = Math.max(Math.hypot(x, z) / half * 0.85 + w * 0.12, Math.max(Math.abs(x), Math.abs(z)) / half);
      const e = smooth(0.45, 0.98, r) * smooth(0, -2, hh);
      hh = hh * (1 - e) + (R.seaFloor ?? -16) * e;
    }
    heights[j * n + i] = hh;
  }
  const wet = new Float32Array(n * n);
  if ((R.erosion ?? 0) > 0) {
    erode(heights, wet, n, cell, R);
    // Lätt utjämning efteråt: hälften av en 3 × 3-utjämning, mot sylvassa kanter efter dropparna
    const soft = Float32Array.from(heights);
    blur(soft, n, 1);
    for (let k = 0; k < heights.length; k++) heights[k] = heights[k] * 0.5 + soft[k] * 0.5;
  }
  if ((R.talus ?? 0) > 0) thermal(heights, n, cell, R.talus, 4);
  despeckle(heights, n, 0.04, 12); // sist: spetsar efter dropparna, rasen eller där åsar korsas
  // Fuktkartan: dropparnas spår, utjämnat och normerat till 0..1
  blur(wet, n, 2);
  let mx = 0;
  for (let k = 0; k < wet.length; k++) mx = Math.max(mx, wet[k]);
  if (mx > 0) for (let k = 0; k < wet.length; k++) wet[k] = Math.min(1, Math.sqrt(wet[k] / mx));
  const heightAt = (x, z) => {
    const gx = Math.min(n - 1.001, Math.max(0, (x + half) / cell)), gz = Math.min(n - 1.001, Math.max(0, (z + half) / cell));
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, k = j * n + i;
    return (heights[k] * (1 - fx) + heights[k + 1] * fx) * (1 - fz) + (heights[k + n] * (1 - fx) + heights[k + n + 1] * fx) * fz;
  };
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { n, size, cell, half, heights, wet, heightAt, ms: Math.round(t1 - t0) };
}

// Hydraulisk erosion med droppar: varje droppe rinner nedför med tröghet, tar med sig material när den har fart och
// kapacitet över, och lägger av det där den saktar in. Antalet droppar följer platsens yta och spaken erosion.
function erode(h, wet, n, cell, R) {
  const r = rng((R.seed ?? 1) * 31 + 7), drops = Math.round(n * n * 0.12 * R.erosion), steps = 64;
  const inertia = 0.05, capK = 4, minCap = 0.01, erodeK = 0.3, depositK = 0.3, evap = 0.02, grav = 4;
  const grad = (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, k = j * n + i;
    const a = h[k], b = h[k + 1], c = h[k + n], d = h[k + n + 1];
    return [(b - a) * (1 - fz) + (d - c) * fz, (c - a) * (1 - fx) + (d - b) * fx, a * (1 - fx) * (1 - fz) + b * fx * (1 - fz) + c * (1 - fx) * fz + d * fx * fz];
  };
  // Material läggs av i de fyra hörnen runt droppen (bilinjärt) men tas med en rund pensel (radie 2 rutor), så att
  // dropparna inte gräver gropar på enstaka rutor
  const brush = [];
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const d = Math.hypot(di, dj); if (d < 2.5) brush.push([di + dj * n, 2.5 - d]); }
  const bw = brush.reduce((a, b) => a + b[1], 0);
  brush.forEach((b) => { b[1] /= bw; });
  const take = (x, z, amt) => { const k = Math.round(z) * n + Math.round(x); for (const [o, w] of brush) h[k + o] -= amt * w; };
  const spread = (x, z, amt) => take(x, z, -amt);
  const sea = R.sea ? (R.seaLevel ?? 0) : -Infinity; // en droppe som når havet stannar där
  const put = (x, z, amt) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, k = j * n + i;
    h[k] += amt * (1 - fx) * (1 - fz); h[k + 1] += amt * fx * (1 - fz); h[k + n] += amt * (1 - fx) * fz; h[k + n + 1] += amt * fx * fz;
  };
  for (let d = 0; d < drops; d++) {
    let x = 3 + r() * (n - 7), z = 3 + r() * (n - 7), dx = 0, dz = 0, speed = 1, water = 1, sed = 0;
    for (let s = 0; s < steps; s++) {
      const [gx, gz, hOld] = grad(x, z);
      if (hOld < sea) { spread(x, z, sed); break; } // i havet: sedimentet sprids ut som en mjuk rand, inte en hög
      dx = dx * inertia - gx * (1 - inertia); dz = dz * inertia - gz * (1 - inertia);
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) break;
      dx /= l; dz /= l;
      const nx = x + dx, nz = z + dz;
      if (nx < 3 || nz < 3 || nx >= n - 4 || nz >= n - 4) break;
      wet[Math.round(z) * n + Math.round(x)] += water;
      const dh = grad(nx, nz)[2] - hOld;
      const cap = Math.max(-dh * speed * water * capK, minCap * cell);
      if (sed > cap || dh > 0) {
        // Uppför: fyll gropen; annars lägg av en del av överskottet
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depositK;
        sed -= amt; put(x, z, amt);
      } else {
        const amt = Math.min((cap - sed) * erodeK, -dh);
        sed += amt; take(x, z, amt);
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * -grav / cell));
      water *= 1 - evap;
      x = nx; z = nz;
    }
  }
}

// Rensning: en ruta som ligger mer än tol över eller under alla fyra grannar (en spets eller grop på
// en enda ruta) sätts till medlet av sina åtta grannar. Åsar och klippkanter har grannar i samma höjd och lämnas.
function despeckle(h, n, tol, maxPasses) {
  for (let p = 0; p < maxPasses; p++) {
    let changed = 0;
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const k = j * n + i, a = h[k - 1], b = h[k + 1], c = h[k - n], d = h[k + n];
      if (h[k] - Math.max(a, b, c, d) > tol || Math.min(a, b, c, d) - h[k] > tol) { h[k] = (a + b + c + d + h[k - n - 1] + h[k - n + 1] + h[k + n - 1] + h[k + n + 1]) / 8; changed++; }
    }
    if (!changed) break; // tills inget mer sticker ut
  }
}

// Termisk erosion: där lutningen mellan grannar är brantare än rasvinkeln flyttas hälften av överskottet nedåt
function thermal(h, n, cell, talusDeg, iterations) {
  const lim = Math.tan(talusDeg * Math.PI / 180) * cell;
  for (let it = 0; it < iterations; it++) for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    const k = j * n + i;
    for (const o of [1, -1, n, -n]) {
      const diff = h[k] - h[k + o];
      if (diff > lim) { const m = (diff - lim) * 0.25; h[k] -= m; h[k + o] += m; }
    }
  }
}

// Enkel lådutjämning i båda riktningarna, radie r celler
function blur(a, n, r) {
  const tmp = new Float32Array(a.length);
  for (const [di, dj] of [[1, 0], [0, 1]]) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let o = -r; o <= r; o++) { const ii = i + o * di, jj = j + o * dj; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue; s += a[jj * n + ii]; c++; }
      tmp[j * n + i] = s / c;
    }
    a.set(tmp);
  }
}
