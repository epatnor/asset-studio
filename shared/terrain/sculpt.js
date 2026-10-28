// Skulpteringen (docs/terrain.md, steget Sculpt): det man formar för hand ovanpå den genererade världen. Ren
// JavaScript, som generate.js, så att samma kod körs i studion, i workern och i kontrollerna i Node.
//
// Två lager, i den ordningen:
// - Penslarna (höj, sänk, jämna ut, platta till, ramp, brus) skriver en höjdskillnad per hörn (delta, meter) som
//   läggs på den genererade marken. Världen kan alltså byggas om (ny seed, mer erosion) utan att det formade försvinner.
// - Vattnet som grävs: bäckar, åar och vikar är linjer (punkter i andelar av världen) som gräver en fåra med
//   createChannel (shapes.js) i marken efter penslarna. Bäckens och åns yta sluttar bara nedströms; en vik ligger i
//   havets nivå och fylls av havet.
//
//   const e = applyEdits(t, recipe);   // en ny terräng (heights, wet, heightAt) och kanalerna ({ kind, smp, level })
//   brushDab(h, delta, n, cell, half, x, z, opts)   // ett penseltryck på höjderna (i studion, medan man drar),
//                                                   // rund eller med ett mönster ur stamps.js

import { createChannel, smoothstep } from './shapes.js';
import { createNoise } from './generate.js';

const clamp = (a, b, x) => Math.min(b, Math.max(a, x));

// Bilinjärt i ett hörnrutnät (n × n, cell meter, (0, 0) i mitten)
export function gridSampler(h, n, cell, half) {
  return (x, z) => {
    const gx = clamp(0, n - 1.001, (x + half) / cell), gz = clamp(0, n - 1.001, (z + half) / cell), i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, k = j * n + i;
    return (h[k] * (1 - fx) + h[k + 1] * fx) * (1 - fz) + (h[k + n] * (1 - fx) + h[k + n + 1] * fx) * fz;
  };
}

// Ett delta från ett annat rutnät (världens storlek ändrad): bilinjärt över samma fyrkant
export function resampleDelta(delta, n0, n1) {
  if (!delta || n0 === n1) return delta;
  const out = new Float32Array(n1 * n1), at = gridSampler(delta, n0, 1, (n0 - 1) / 2), s = (n0 - 1) / (n1 - 1);
  for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) out[j * n1 + i] = at(i * s - (n0 - 1) / 2, j * s - (n0 - 1) / 2);
  return out;
}

// En kanals linje i meter, med halva bredden längs vägen (från start till slut, mjukt)
export function channelPath(c, kinds, size) {
  const K = kinds[c.kind] ?? kinds.stream, pts = c.points.map((p) => [p[0] * size, p[1] * size]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = len.at(-1) || 1;
  return pts.map((p, i) => [p[0], p[1], K.width[0] + (K.width[1] - K.width[0]) * smoothstep(0, 1, len[i] / L)]);
}

// Penslarna och kanalerna på en genererad terräng t (ur generateTerrain). R: receptet med sculpt (Float32Array, n · n
// meter, eller null), channels ([{ kind, points: [[u, v], ...] }]), channelKinds (terrain.json), sea och seaLevel.
// Svar: { ...t, heights, wet, heightAt, channels: [{ kind, smp (x, z, w, level, tx, tz), reach }], editMs }
export function applyEdits(t, R) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { n, cell, half, size } = t;
  const heights = t.heights.slice(), wet = t.wet.slice();
  const delta = resampleDelta(R.sculpt, R.sculptN ?? n, n);
  if (delta && delta.length === n * n) for (let k = 0; k < n * n; k++) heights[k] += delta[k];
  const kinds = R.channelKinds ?? {}, sea = R.sea ? (R.seaLevel ?? 0) : null, channels = [];
  for (const c of (R.channels ?? []).slice(0, 32)) {
    if (!Array.isArray(c?.points) || c.points.length < 2) continue;
    const K = kinds[c.kind] ?? kinds.stream ?? { width: [1, 1.6] };
    const base = gridSampler(heights.slice(), n, cell, half); // marken före den här kanalen
    // Riktningen: en bäck rinner från den högre änden, en vik börjar vid havet (den lägre änden, där den är bredast)
    const a = c.points[0], b = c.points.at(-1), ha = base(a[0] * size, a[1] * size), hb = base(b[0] * size, b[1] * size);
    const line = (K.sea ? ha > hb : ha < hb) ? { ...c, points: [...c.points].reverse() } : c;
    const ch = createChannel({
      path: channelPath(line, kinds, size), base, step: Math.max(0.4, cell * 0.5, Math.min(...K.width) * 0.3), // glesare prov i breda fåror
      depth: (w) => (K.depth?.[0] ?? 0.22) + (K.depth?.[1] ?? 0.2) * w, drop: K.drop ?? 0.32, bank: K.bank ?? 0.7, levee: K.levee ?? 0.3,
      level: K.sea && sea != null ? sea : undefined, sea: sea ?? undefined, // ytan stannar vid havet, utan vallar där
    });
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of ch.smp) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    const i0 = Math.max(0, Math.floor((x0 - ch.reach + half) / cell)), i1 = Math.min(n - 1, Math.ceil((x1 + ch.reach + half) / cell));
    const j0 = Math.max(0, Math.floor((z0 - ch.reach + half) / cell)), j1 = Math.min(n - 1, Math.ceil((z1 + ch.reach + half) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = -half + i * cell, z = -half + j * cell, q = ch.query(x, z);
      if (!q) continue;
      const k = j * n + i;
      heights[k] = ch.bedAt(x, z);
      wet[k] = Math.max(wet[k], 1 - smoothstep(q.w, q.w * 5, q.d)); // fuktigt längs vattnet (myr och vass i biomerna)
    }
    channels.push({ kind: c.kind, sea: !!K.sea, smp: ch.smp.map((p) => ({ x: p.x, z: p.z, w: p.w, level: p.level, tx: p.tx, tz: p.tz })) });
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { ...t, heights, wet, heightAt: gridSampler(heights, n, cell, half), channels, editMs: Math.round(t1 - t0) };
}

// Penselns falloff: full verkan inom hardness · radien, sedan mjukt ut till kanten (0 = en kupol, 1 = en skarp kant)
export const falloff = (d, hardness = 0.25) => (d >= 1 ? 0 : smoothstep(1, Math.min(0.97, hardness), d));

// Ett penseltryck kring (x, z): h är höjderna som ritas (ändras), delta det sparade lagret (ändras lika mycket).
// opts: tool (raise | lower | smooth | flatten | noise | terrace | erode), radius (m), strength (0..1), hardness
// (falloff), stamp (en mask ur stamps.js eller null) och angle (radianer, mönstrets vinkel), invert (vänder höj och
// sänk), target (flatten: höjden), stepHeight (terrace: meter per steg) och seed. Svar: de rader som ändrats
// ({ j0, j1 }), för att bara ladda upp dem.
const noises = new Map();
export function brushDab(h, delta, n, cell, half, x, z, opts) {
  const { radius, strength, hardness = 0.25, stamp = null, angle = 0, invert = false, target = 0, stepHeight = 4, seed = 1 } = opts;
  let tool = opts.tool;
  if (invert && (tool === 'raise' || tool === 'lower')) tool = tool === 'raise' ? 'lower' : 'raise';
  if (tool === 'erode') return erodeDab(h, delta, n, cell, half, x, z, opts);
  const ci = (x + half) / cell, cj = (z + half) / cell, r = radius / cell;
  const i0 = Math.max(1, Math.floor(ci - r)), i1 = Math.min(n - 2, Math.ceil(ci + r)), j0 = Math.max(1, Math.floor(cj - r)), j1 = Math.min(n - 2, Math.ceil(cj + r));
  if (i0 > i1 || j0 > j1) return null;
  const rate = strength * Math.max(0.05, radius * 0.025); // höj och sänk: meter per tryck, större pensel lyfter mer
  if (!noises.has(seed)) noises.set(seed, createNoise(seed * 13 + 5));
  const noise = noises.get(seed), ca = Math.cos(angle), sa = Math.sin(angle);
  // Utjämningen läser grannarna före trycket, så att resultatet inte beror på i vilken ordning hörnen går
  const src = tool === 'smooth' ? h.slice((j0 - 1) * n, (j1 + 2) * n) : null, o = (j0 - 1) * n;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const du = (i - ci) / r, dv = (j - cj) / r, d = Math.hypot(du, dv);
    if (d >= 1) continue;
    let f = falloff(d, hardness), m = 1;
    if (stamp) m = stamp(du * ca + dv * sa, -du * sa + dv * ca); // mönstret i penselns vinkel
    const k = j * n + i;
    let dh = 0;
    if (tool === 'raise' || tool === 'lower') dh = (tool === 'raise' ? 1 : -1) * rate * f * m; // en krater sänker mitten även med Raise
    else {
      f *= Math.min(1, Math.abs(m)); // för de andra penslarna är mönstret en mask för styrkan (beloppet: sprickor sänker men ska också verka)
      if (tool === 'smooth') {
        const s = src, q = k - o;
        const avg = (s[q - 1] + s[q + 1] + s[q - n] + s[q + n] + s[q] * 2 + (s[q - n - 1] + s[q - n + 1] + s[q + n - 1] + s[q + n + 1]) * 0.5) / 8;
        dh = (avg - s[q]) * clamp(0, 1, strength * 1.5) * f;
      } else if (tool === 'flatten') dh = (target - h[k]) * clamp(0, 1, strength * 0.6) * f;
      else if (tool === 'noise') {
        const xx = -half + i * cell, zz = -half + j * cell, l = Math.max(2, radius * 0.35);
        dh = noise(xx / l, zz / l) * rate * 0.6 * f * (invert ? -1 : 1);
      } else if (tool === 'terrace') {
        // Trappsteg: platta avsatser stepHeight isär, med en kort slänt mellan dem
        const q = h[k] / stepHeight, fl = Math.floor(q), tgt = (fl + smoothstep(0.62, 0.92, q - fl)) * stepHeight;
        dh = (tgt - h[k]) * clamp(0, 1, strength * 0.5) * f;
      }
    }
    h[k] += dh;
    delta[k] += dh;
  }
  return { j0, j1 };
}

// Erosion under penseln: droppar (som världens erosion i generate.js, Beyer 2015) som startar slumpvis inom penseln,
// rinner nedför, river där de går fort och lägger av där de saktar in. Ger rännor och mjuka raskäglor där man drar.
let erodeSeed = 1;
function erodeDab(h, delta, n, cell, half, x, z, { radius, strength, hardness = 0.25 }) {
  const ci = (x + half) / cell, cj = (z + half) / cell, r = radius / cell;
  const i0 = Math.max(1, Math.floor(ci - r * 1.4)), i1 = Math.min(n - 3, Math.ceil(ci + r * 1.4)), j0 = Math.max(1, Math.floor(cj - r * 1.4)), j1 = Math.min(n - 3, Math.ceil(cj + r * 1.4));
  if (i0 > i1 || j0 > j1) return null;
  const rnd = (() => { let s = erodeSeed++ * 7919; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  const drops = Math.round(10 + strength * 50 * Math.min(4, Math.max(0.5, r / 15)));
  const at = (px, pz) => { const i = Math.floor(px), j = Math.floor(pz), fx = px - i, fz = pz - j, k = j * n + i; return { k, fx, fz, hh: h[k] * (1 - fx) * (1 - fz) + h[k + 1] * fx * (1 - fz) + h[k + n] * (1 - fx) * fz + h[k + n + 1] * fx * fz, gx: (h[k + 1] - h[k]) * (1 - fz) + (h[k + n + 1] - h[k + n]) * fz, gz: (h[k + n] - h[k]) * (1 - fx) + (h[k + n + 1] - h[k + 1]) * fx }; };
  const add = (c, v) => { const w = [(1 - c.fx) * (1 - c.fz), c.fx * (1 - c.fz), (1 - c.fx) * c.fz, c.fx * c.fz], K = [c.k, c.k + 1, c.k + n, c.k + n + 1]; for (let q = 0; q < 4; q++) { h[K[q]] += v * w[q]; delta[K[q]] += v * w[q]; } };
  for (let dIdx = 0; dIdx < drops; dIdx++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * r;
    let px = ci + Math.cos(a) * rr, pz = cj + Math.sin(a) * rr, dx = 0, dz = 0, speed = 1, water = 1, sed = 0;
    for (let step = 0; step < 40; step++) {
      if (px < i0 || px > i1 || pz < j0 || pz > j1) break;
      const c = at(px, pz), f = falloff(Math.hypot(px - ci, pz - cj) / (r * 1.4), hardness);
      dx = dx * 0.3 - c.gx * 0.7; dz = dz * 0.3 - c.gz * 0.7;
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) break;
      dx /= l; dz /= l;
      const nx = px + dx, nz = pz + dz;
      if (nx < i0 || nx > i1 || nz < j0 || nz > j1) break;
      const dh = at(nx, nz).hh - c.hh, cap = Math.max(-dh, 0.01 * cell) * speed * water * 4;
      if (sed > cap || dh > 0) { const dep = dh > 0 ? Math.min(dh, sed) : (sed - cap) * 0.3; sed -= dep; add(c, dep * f); }
      else { const ero = Math.min((cap - sed) * 0.3 * strength, -dh); sed += ero; add(c, -ero * f); }
      speed = Math.sqrt(Math.max(0.01, speed * speed - dh * 4 / cell)); water *= 0.97;
      px = nx; pz = nz;
    }
  }
  // Dropparna lämnar enstaka hack där de stannar; en lätt utjämning över penseln tar bort dem men behåller rännorna
  brushDab(h, delta, n, cell, half, x, z, { tool: 'smooth', radius: radius * 1.2, strength: 0.35, hardness });
  return { j0, j1: j1 + 1 };
}

// En ramp från A till B (punkter { x, z, y }): marken längs sträckan läggs i en jämn lutning mellan A:s och B:s höjd,
// med mjuka kanter radius ut. Svar som brushDab.
export function rampStroke(h, delta, n, cell, half, a, b, { radius, strength = 1, hardness = 0.5 }) {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
  if (L2 < 1e-4) return null;
  const pad = radius / cell;
  const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) + half) / cell - pad)), i1 = Math.min(n - 1, Math.ceil((Math.max(a.x, b.x) + half) / cell + pad));
  const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) + half) / cell - pad)), j1 = Math.min(n - 1, Math.ceil((Math.max(a.z, b.z) + half) / cell + pad));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = -half + i * cell, z = -half + j * cell, u = clamp(0, 1, ((x - a.x) * dx + (z - a.z) * dz) / L2);
    const d = Math.hypot(a.x + dx * u - x, a.z + dz * u - z) / radius;
    if (d >= 1) continue;
    const k = j * n + i, target = a.y + (b.y - a.y) * smoothstep(0, 1, u), dh = (target - h[k]) * falloff(d, hardness) * clamp(0, 1, strength);
    h[k] += dh;
    delta[k] += dh;
  }
  return { j0, j1 };
}

// Lagret som text i receptet: centimeter (Int16) där nollorna körs ihop (antal nollor, antal värden, värdena ...),
// så att en nästan orörd värld blir några hundra tecken. Första talet är n. Tomt lager → null.
export function encodeDelta(delta, n) {
  if (!delta || !delta.some((v) => Math.abs(v) >= 0.005)) return null;
  const words = [n & 0xffff];
  let k = 0;
  const N = n * n;
  while (k < N) {
    let z = 0;
    while (k < N && z < 0xffff && Math.round(delta[k] * 100) === 0) { z++; k++; }
    const start = k;
    while (k < N && k - start < 0xffff && Math.round(delta[k] * 100) !== 0) k++;
    words.push(z, k - start);
    for (let q = start; q < k; q++) words.push(clamp(-32767, 32767, Math.round(delta[q] * 100)));
  }
  const bytes = new Uint8Array(new Int16Array(words).buffer);
  let s = '';
  for (let q = 0; q < bytes.length; q += 0x8000) s += String.fromCharCode(...bytes.subarray(q, q + 0x8000));
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}
export function decodeDelta(text) {
  if (!text) return null;
  const s = typeof atob === 'function' ? atob(text) : Buffer.from(text, 'base64').toString('binary');
  const bytes = new Uint8Array(s.length & ~1);
  for (let q = 0; q < bytes.length; q++) bytes[q] = s.charCodeAt(q);
  const w = new Int16Array(bytes.buffer), n = w[0] & 0xffff, out = new Float32Array(n * n);
  let p = 1, k = 0;
  while (p + 1 < w.length && k < out.length) {
    k += w[p++] & 0xffff;
    const c = w[p++] & 0xffff;
    for (let q = 0; q < c && k < out.length; q++) out[k++] = w[p++] / 100;
  }
  return { n, delta: out };
}
