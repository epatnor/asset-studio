// Penselmönstren i Sculpt (docs/terrain.md, steget Sculpt): masker som trycks ut i stället för en rund kupol, som
// alphas i en skulpteringsapp. Varje mönster är en funktion av (u, v) i penselns enhetsskiva (vriden efter penselns
// vinkel) och svarar ungefär −1..1: positivt lyfter, negativt sänker (en krater sänker mitten och höjer kanten).
// Penselns falloff läggs på utanför, så mönstret behöver inte själv tona ut mot kanten. Procedurella och seedade,
// så att samma mönster blir likadant i studion, i workern och i Node; inga bildfiler. Namn och hjälptexter är data i
// sculptStamps i tools/terrain/terrain.json.
//
//   const mask = createStamp('crater', seed);   // null för round (penselns egen kupol)
//   mask(u, v)

import { createNoise } from './generate.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const MAKERS = {
  // En rundad kulle med lite ojämn yta
  mound: (noise) => (u, v) => { const d2 = u * u + v * v; return Math.max(0, 1 - d2) ** 1.5 * (0.85 + 0.15 * noise(u * 3, v * 3)); },
  // Krater: sänkt mitt och en upphöjd vall runt om
  crater: (noise) => (u, v) => {
    const d = Math.hypot(u, v) * (1 + 0.06 * noise(u * 4, v * 4));
    return -0.75 * (1 - smooth(0, 0.62, d)) + Math.exp(-(((d - 0.7) / 0.14) ** 2));
  },
  // Ås: en lång rygg längs penselns riktning, med en ojämn kam
  ridge: (noise) => (u, v) => Math.exp(-(((v + 0.12 * noise(u * 2.5, 7)) / 0.28) ** 2)) * (1 - u * u * 0.6) * (0.8 + 0.2 * noise(u * 6, 3)),
  // Platå (mesa): platt topp och branta kanter
  mesa: (noise) => (u, v) => smooth(0.78, 0.55, Math.hypot(u, v) * (1 + 0.08 * noise(u * 5, v * 5))),
  // Terrasser: höjden i tre trappsteg in mot mitten, med en platt topp
  terraces: (noise) => (u, v) => {
    const r = Math.min(2.999, (1 - Math.hypot(u, v) * (1 + 0.05 * noise(u * 5, v * 5))) * 3.6), f = Math.floor(r), t = r - f;
    return Math.max(0, (f + smooth(0.7, 0.95, t)) / 3);
  },
  // Klippblock: några runda block av olika storlek
  boulders: (noise, r) => {
    const B = Array.from({ length: 6 }, () => { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.6; return [Math.cos(a) * d, Math.sin(a) * d, 0.18 + r() * 0.22, 0.5 + r() * 0.5]; });
    return (u, v) => { let m = 0; for (const [x, y, s, h] of B) { const q = 1 - ((u - x) ** 2 + (v - y) ** 2) / (s * s); if (q > 0) m = Math.max(m, Math.sqrt(q) * h); } return m * (0.9 + 0.1 * noise(u * 8, v * 8)); };
  },
  // Dyner: vågor tvärs penselns riktning, flack lovartssida och brant läsida
  dunes: (noise) => (u, v) => { const s = (((u * 2.2 + 0.25 * noise(v * 1.5, 1)) % 1) + 1) % 1; return 0.7 * (s < 0.78 ? s / 0.78 : (1 - s) / 0.22) - 0.25; },
  // Rännor: parallella fåror längs penselns riktning, som där regnet runnit
  gullies: (noise) => (u, v) => -((1 - Math.abs(Math.sin((v + 0.15 * noise(u * 2, 5)) * Math.PI * 2.5))) ** 5) * 0.9,
  // Sprickor: ett nät av smala sprickor (kanterna mellan cellerna i ett Voronoi-mönster)
  cracks: (noise, r) => {
    const P = Array.from({ length: 14 }, () => [r() * 2.4 - 1.2, r() * 2.4 - 1.2]);
    return (u, v) => {
      let a = Infinity, b = Infinity;
      for (const [x, y] of P) { const d = Math.hypot(u - x, v - y); if (d < a) { b = a; a = d; } else if (d < b) b = d; }
      return -smooth(0.07, 0, (b - a) * (1 + 0.3 * noise(u * 6, v * 6))) * 0.9;
    };
  },
};

export const STAMP_IDS = ['round', ...Object.keys(MAKERS)];

export function createStamp(id, seed = 1) {
  const make = MAKERS[id];
  if (!make) return null; // round: penselns egen kupol
  return make(createNoise(seed * 31 + id.length * 7), rng(seed * 97 + id.charCodeAt(0)));
}

// Landformerna: hela berg, vulkaner, öar, bergskedjor och kanjoner som höjdkartor, som trycks ut med ett klick i stor
// skala (Patriks idé). Varje funktion svarar med höjden i andelar av landformens höjd (1 = toppen); negativa värden
// är under basen och skalas med djupet (en ö sluttar ned mot havsbotten). Hur de läggs på (blend: add lägger till
// höjden, max höjer bara upp till formen) och var basen är (base: ground = marken där man klickar, sea = havets yta)
// är data i sculptLandforms i terrain.json. Detaljen kommer ur åsbrus och vridet brus, så att de liknar världens berg.
// Åsbrus med rundare kammar än världens: en landform kan bli liten, och knivskarpa krön blir spetsar
function ridgedAt(noise, x, z, oct) {
  let s = 0, a = 1, f = 1, w = 1, nn = 0;
  for (let o = 0; o < oct; o++) { const v0 = noise(x * f + o * 31.7, z * f + o * 11.3); let v = 1 - Math.sqrt(v0 * v0 + 0.03); v *= v * w; w = Math.min(1, Math.max(0, v * 2)); s += v * a; nn += a; a *= 0.5; f *= 2.03; }
  return s / nn;
}
function fbmAt(noise, x, z, oct) { let s = 0, a = 1, f = 1, nn = 0; for (let o = 0; o < oct; o++) { s += noise(x * f + o * 17.3, z * f - o * 9.1) * a; nn += a; a *= 0.5; f *= 2.02; } return s / nn; }
const LANDFORMS = {
  // Ett berg: en topp med åsar som strålar ut och raviner mellan dem
  mountain: (noise) => (u, v) => {
    const wu = u + 0.15 * noise(u * 2 + 5, v * 2), wv = v + 0.15 * noise(u * 2, v * 2 + 9), d = Math.hypot(wu, wv);
    const cone = Math.max(0, 1 - d) ** 1.4, ridges = ridgedAt(noise, wu * 2.2, wv * 2.2, 4);
    return cone * (0.55 + 0.6 * ridges);
  },
  // En vulkan: en kon med konkava sidor, en krater i toppen och fåror nedför sidorna
  volcano: (noise) => (u, v) => {
    const d = Math.hypot(u, v) * (1 + 0.05 * noise(u * 3, v * 3)), a = Math.atan2(v, u);
    const cone = Math.max(0, 1 - d) ** 2.2 * (1 + 0.06 * Math.sin(a * 23 + 3 * noise(u * 2, v * 2)) * smooth(0.15, 0.6, d));
    const crater = 0.45 * (1 - smooth(0.06, 0.16, d));
    return Math.max(0, cone - crater) + 0.03 * fbmAt(noise, u * 6, v * 6, 3) * smooth(0.95, 0.4, d);
  },
  // En ö: land med kullar som sluttar ned till en oregelbunden kust (vid 0,7 av radien) och vidare mot havsbotten
  island: (noise) => (u, v) => {
    const wu = u + 0.12 * noise(u * 1.5 + 3, v * 1.5), wv = v + 0.12 * noise(u * 1.5, v * 1.5 + 7);
    const d = Math.hypot(wu, wv) * (1 + 0.18 * fbmAt(noise, u * 2.5, v * 2.5, 4));
    const land = smooth(0.7, 0.2, d) * (0.6 + 0.5 * fbmAt(noise, u * 3 + 11, v * 3, 4) + 0.3 * ridgedAt(noise, u * 2, v * 2, 3));
    return d < 0.7 ? Math.max(0.02, land) * smooth(0.72, 0.6, d) + 0.02 : -smooth(0.7, 1, d); // under kusten: ned mot botten
  },
  // En bergskedja längs penselns riktning: en rad toppar med en kam mellan dem
  range: (noise) => (u, v) => {
    const along = Math.max(0, 1 - Math.abs(u) ** 2.5), wv = v + 0.18 * noise(u * 1.5, 4);
    const crest = Math.exp(-((wv / 0.3) ** 2)) * along, ridges = ridgedAt(noise, u * 3, wv * 3, 3);
    return crest * (0.45 + 0.7 * ridges);
  },
  // En kanjon längs penselns riktning: branta väggar, en slingrande botten och avsatser
  canyon: (noise) => (u, v) => {
    const wv = v + 0.22 * noise(u * 1.2, 2) + 0.05 * noise(u * 5, 8), along = smooth(1, 0.75, Math.abs(u));
    const r = Math.abs(wv) / 0.32, f = Math.floor(r * 3), t = r * 3 - f;
    const wall = Math.min(1, (f + smooth(0.55, 0.95, t)) / 3);
    return -(1 - wall) * along;
  },
};
export const LANDFORM_IDS = Object.keys(LANDFORMS);
export function createLandform(id, seed = 1) {
  const make = LANDFORMS[id];
  return make ? make(createNoise(seed * 53 + id.length * 11)) : null;
}

// En landform på höjderna: center (x, z), radius (m), height (m), depth (m, för det negativa), angle (radianer),
// blend (add | max), base (meter; vid max: höjden som formen står på) och strength (0..1). Formen läggs alltid
// ovanpå det som finns, i procent (strength), och ersätter aldrig marken under. Svar: de rader som ändrats.
export function placeLandform(h, delta, n, cell, half, x, z, form, { radius, height, depth = 20, angle = 0, blend = 'add', base = 0, edge = 0.15, strength = 1 }) {
  const ci = (x + half) / cell, cj = (z + half) / cell, r = radius / cell, ca = Math.cos(angle), sa = Math.sin(angle);
  const i0 = Math.max(0, Math.floor(ci - r)), i1 = Math.min(n - 1, Math.ceil(ci + r)), j0 = Math.max(0, Math.floor(cj - r)), j1 = Math.min(n - 1, Math.ceil(cj + r));
  if (i0 > i1 || j0 > j1) return null;
  // Tillskottet räknas först i en egen ruta och jämnas ut en gång (3 × 3), så att brusets finaste krön inte blir
  // enstaka spetsar på marken; sedan läggs det på
  const W = i1 - i0 + 1, Hh = j1 - j0 + 1, add = new Float32Array(W * Hh);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const du = (i - ci) / r, dv = (j - cj) / r, d = Math.hypot(du, dv);
    if (d >= 1) continue;
    const m = form(du * ca + dv * sa, -du * sa + dv * ca), f = smooth(1, 1 - edge, d); // mjuk kant mot marken runt om
    const v = m >= 0 ? m * height : m * depth, k = j * n + i;
    add[(j - j0) * W + (i - i0)] = (blend === 'max' ? Math.max(0, base + v - h[k]) : v) * f * strength;
  }
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const q = (j - j0) * W + (i - i0);
    let s = add[q] * 4, wsum = 4;
    for (const [di, dj, w] of [[1, 0, 2], [-1, 0, 2], [0, 1, 2], [0, -1, 2], [1, 1, 1], [1, -1, 1], [-1, 1, 1], [-1, -1, 1]]) {
      const ii = i - i0 + di, jj = j - j0 + dj;
      if (ii >= 0 && jj >= 0 && ii < W && jj < Hh) { s += add[jj * W + ii] * w; wsum += w; }
    }
    const dh = s / wsum, k = j * n + i;
    h[k] += dh;
    delta[k] += dh;
  }
  return { j0, j1 };
}
