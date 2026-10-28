// Texturmålningen (docs/terrain.md, steget Paint): marklager som målas ovanpå marken som biomerna ger. Ren
// JavaScript, som sculpt.js, så att samma kod körs i studion och i kontrollerna i Node.
//
// En värld har upp till SLOTS målade lager (en textur var, i receptets paintLayers). Varje hörn har en vikt per lager
// (0–255, n · n · SLOTS); det som blir över (1 − summan) är biomernas mark. Ett penseldrag lägger sig i procent
// ovanpå det som finns och ersätter aldrig: lagret som målas får w + (1 − w) · a och alla andra krymper med (1 − a),
// så att summan aldrig går över 1. Erase krymper alla lager, och biomernas mark kommer tillbaka.
//
//   paintDab(weights, n, cell, half, x, z, { slot, radius, strength, hardness, stamp, angle, slope, heights })
//   encodeWeights(weights, n) / decodeWeights(text)   // lagret som text i receptet (nollorna körs ihop)

import { smoothstep } from './shapes.js';
import { falloff } from './sculpt.js';

export const SLOTS = 8;
const clamp = (a, b, x) => Math.min(b, Math.max(a, x));

// Ett penseltryck. slot: lagret som målas (0..SLOTS − 1) eller −1 för att sudda. slope: [min, max] i grader, där
// penseln verkar (mjukt 3° in), till exempel sten bara i branter; heights behövs då för lutningen. stamp och angle
// som i brushDab: mönstret blir en mask för styrkan (dess belopp, så att sprickor och rännor också målar). Svar: de rader som ändrats ({ j0, j1 }).
export function paintDab(W, n, cell, half, x, z, { slot, radius, strength, hardness = 0.25, stamp = null, angle = 0, slope = null, heights = null }) {
  const ci = (x + half) / cell, cj = (z + half) / cell, r = radius / cell;
  const i0 = Math.max(0, Math.floor(ci - r)), i1 = Math.min(n - 1, Math.ceil(ci + r)), j0 = Math.max(0, Math.floor(cj - r)), j1 = Math.min(n - 1, Math.ceil(cj + r));
  if (i0 > i1 || j0 > j1) return null;
  const ca = Math.cos(angle), sa = Math.sin(angle), useSlope = slope && heights && (slope[0] > 0 || slope[1] < 90);
  const w = new Float32Array(SLOTS);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const du = (i - ci) / r, dv = (j - cj) / r, d = Math.hypot(du, dv);
    if (d >= 1) continue;
    let a = strength * falloff(d, hardness);
    if (stamp) a *= Math.min(1, Math.abs(stamp(du * ca + dv * sa, -du * sa + dv * ca))); // mönstrets styrka, även för de som sänker (sprickor)
    if (useSlope) {
      const k = j * n + i, hx = (heights[k + (i < n - 1 ? 1 : 0)] - heights[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0) + (i < n - 1)));
      const hz = (heights[k + (j < n - 1 ? n : 0)] - heights[k - (j > 0 ? n : 0)]) / (cell * ((j > 0) + (j < n - 1)));
      const deg = Math.atan(Math.hypot(hx, hz)) * 180 / Math.PI;
      a *= smoothstep(slope[0] - 3, slope[0] + 3, deg) * (1 - smoothstep(slope[1] - 3, slope[1] + 3, deg));
    }
    if (a <= 0.001) continue;
    const o = (j * n + i) * SLOTS;
    for (let s = 0; s < SLOTS; s++) w[s] = (W[o + s] / 255) * (1 - a);
    if (slot >= 0) w[slot] += a;
    for (let s = 0; s < SLOTS; s++) {
      // Avrundningen får inte låsa ett lager som krymper: minst ett steg nedåt när a är litet
      let q = Math.round(w[s] * 255);
      if (s !== slot && q === W[o + s] && q > 0 && a > 0.004) q--;
      W[o + s] = q;
    }
  }
  return { j0, j1 };
}

// Andelen av landet som varje lager täcker (procent av hörnen, viktat)
export function coverage(W, n) {
  const sum = new Float64Array(SLOTS);
  for (let k = 0; k < n * n; k++) for (let s = 0; s < SLOTS; s++) sum[s] += W[k * SLOTS + s];
  return Array.from(sum, (v) => Math.round((1000 * v) / 255 / (n * n)) / 10);
}

// Ett lager i en annan upplösning (världens storlek ändrad): närmaste hörn
export function resampleWeights(W, n0, n1) {
  if (!W || n0 === n1) return W;
  const out = new Uint8Array(n1 * n1 * SLOTS), s = (n0 - 1) / (n1 - 1);
  for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
    const a = (Math.round(j * s) * n0 + Math.round(i * s)) * SLOTS, b = (j * n1 + i) * SLOTS;
    for (let q = 0; q < SLOTS; q++) out[b + q] = W[a + q];
  }
  return out;
}

// Lagret som text: n (två byte), sedan körningar (antal nollor, antal värden, värdena), som skulpteringen i sculpt.js
export function encodeWeights(W, n) {
  if (!W || !W.some((v) => v)) return null;
  const out = [n & 255, n >> 8], N = W.length;
  const u16 = (v) => out.push(v & 255, v >> 8);
  let k = 0;
  while (k < N) {
    let z = 0;
    while (k < N && z < 0xffff && W[k] === 0) { z++; k++; }
    const start = k;
    while (k < N && k - start < 0xffff && W[k] !== 0) k++;
    u16(z); u16(k - start);
    for (let q = start; q < k; q++) out.push(W[q]);
  }
  const bytes = Uint8Array.from(out);
  let s = '';
  for (let q = 0; q < bytes.length; q += 0x8000) s += String.fromCharCode(...bytes.subarray(q, q + 0x8000));
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}
export function decodeWeights(text) {
  if (!text) return null;
  const s = typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary');
  const b = new Uint8Array(s.length);
  for (let q = 0; q < s.length; q++) b[q] = s.charCodeAt(q);
  const n = b[0] | (b[1] << 8), W = new Uint8Array(n * n * SLOTS);
  let p = 2, k = 0;
  while (p + 3 < b.length && k < W.length) {
    k += b[p] | (b[p + 1] << 8);
    const c = b[p + 2] | (b[p + 3] << 8);
    p += 4;
    for (let q = 0; q < c && k < W.length; q++) W[k++] = b[p++];
  }
  return { n, weights: W };
}
