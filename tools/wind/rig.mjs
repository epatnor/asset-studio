// Vindriggen (docs/effektlabb.md, fliken Vind): en hierarki av delar (stam -> grenar -> kvistar, stjälk -> blad och
// blomhuvud) som generatorerna bygger innan de skriver sin glTF. Ren JS utan Three.js; körs i Node av generatorerna
// och speglas i klientens shader (shared/effects/wind.js), som räknar exakt samma sak.
//
// En del har ett fäste (pivot), en riktning, en längd, en radie, en förälder och var den sitter på föräldern (tAttach,
// samma parameter som förälderns hörn har i _PT). Ur det räknas:
//   last (luftmotstånd): ytan som delen och alla dess barn bär
//   böjning (amp, radianer vid full vind): en grund per nivå, varierad inom nivån av last * längd² / radie⁴
//   svängningstakt (Hz): en grund per nivå, varierad av sqrt(styvhet / massa), styvhet = radie⁴ / längd³, massa = ved + löv
//   fas: slumpad per del
// Varje hörn har _PART (delens nummer) och _PT (var längs delen, 0 vid fästet, 1 i spetsen, under 0 i marken).
// Deformationen roterar hörnet runt fästet med delens vinkel gånger böjformen f(t), sedan runt förälderns fäste med
// förälderns vinkel vid barnets fästpunkt, och så vidare ned till roten. Barnets fäste följer därför alltid med
// föräldern, och det som sitter i marken (t <= 0 på en rotdel) står still.
//
// Tabellen i glTF-filen (extras.wind på noden): { v, stride: 12, count, parts: [px, py, pz, parent, dx, dy, dz, tAttach,
// amp, freq, phase, length, ...] }. Exporteras också till Pivot Painter senare (E5).
import { sub, dot, cross, norm, len, UP } from '../tree/vec.mjs';

export const RIG_VERSION = 1;
export const STRIDE = 12;
export const MAX_DEPTH = 6;
export const GROUND_BLEND = 0.15; // meter över marken där rörelsen tonas in // så många nivåer shadern går igenom (stam, gren, gren, kvist, blad ...)

// Böjformen längs en del: en inspänd balk (förskjutningen t²(3 - t)/2 delat med t), 0 vid fästet och 1 i spetsen
export const bendShape = (t) => { const x = Math.min(1, Math.max(0, t)); return (x * (3 - x)) / 2; };

const hash = (n) => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 1; };

/**
 * @param {Array<{pivot:number[], dir:number[], length:number, radius:number, parent:number, tAttach:number, area:number}>} parts
 *   föräldrar före barn; area = egen lövyta (m²), ved räknas ur radie och längd
 * @param {object} o  angles och freqs: grundvinkel (radianer vid full vind) och grundtakt (Hz) per nivå (0 = roten);
 *   fysiken (last * längd² / radie⁴ och sqrt(styvhet / massa)) varierar delarna inom nivån runt grunden, begränsat
 *   till spread (en tung, lång, smal gren böjer mer och svänger långsammare än en kort och styv på samma nivå)
 */
export function solveRig(parts, o = {}) {
  const { angles = [0.05, 0.12, 0.18, 0.24], freqs = [0.45, 0.9, 1.6, 2.4], spread = [0.5, 1.8], seed = 0 } = o;
  const n = parts.length;
  const depth = new Array(n).fill(0), load = parts.map((p) => p.area ?? 0);
  parts.forEach((p, i) => { if (p.parent >= 0) depth[i] = depth[p.parent] + 1; });
  for (let i = n - 1; i >= 0; i--) if (parts[i].parent >= 0) load[parts[i].parent] += load[i];
  const r = (p) => Math.max(p.radius, 1e-3), L = (p) => Math.max(p.length, 1e-3);
  const compliance = parts.map((p, i) => (load[i] + 0.02 * L(p)) * L(p) ** 2 / r(p) ** 4);
  const omega = parts.map((p, i) => Math.sqrt((r(p) ** 4 / L(p) ** 3) / (600 * Math.PI * r(p) ** 2 * L(p) + 0.6 * load[i])));
  // Medianen per nivå är nivåns grund
  const levelMedian = (xs) => { const m = new Map(); for (let i = 0; i < n; i++) (m.get(depth[i]) ?? m.set(depth[i], []).get(depth[i])).push(xs[i]); return new Map([...m].map(([d, v]) => [d, median(v) || 1])); };
  const mC = levelMedian(compliance), mW = levelMedian(omega);
  const at = (xs, d) => xs[Math.min(d, xs.length - 1)];
  const clampS = (x) => Math.min(spread[1], Math.max(spread[0], x));
  const table = new Float32Array(n * STRIDE);
  parts.forEach((p, i) => {
    const d = depth[i];
    const amp = at(angles, d) * clampS(Math.sqrt(compliance[i] / mC.get(d)));
    const f = at(freqs, d) * Math.sqrt(clampS(omega[i] / mW.get(d)));
    table.set([...p.pivot, p.parent, ...norm(p.dir), p.tAttach ?? 0, amp, f, hash(i + seed * 101) * Math.PI * 2, L(p)], i * STRIDE);
  });
  return { table, depth: Math.max(0, ...depth), count: n };
}

// Tabellen som glTF-extras (avrundad, så att filen inte växer i onödan)
export function rigExtras(rig) {
  return { v: RIG_VERSION, stride: STRIDE, count: rig.count, depth: rig.depth, parts: Array.from(rig.table, (x) => Math.round(x * 1e4) / 1e4) };
}

// --- Vindfältet: samma formler som shared/effects/wind.js (byar som rullande vågor över marken) ---
export const WIND_DEFAULTS = { strength: 0.6, dir: 0, gust: 0.5, gustScale: 18, gustSpeed: 6, sway: 0.35, time: 0 };
export function gustAt(x, z, w) {
  const W = [Math.cos(w.dir), Math.sin(w.dir)], P = [-W[1], W[0]];
  const a = (x * W[0] + z * W[1] - w.time * w.gustSpeed) / w.gustScale, b = (x * P[0] + z * P[1]) / (w.gustScale * 1.7);
  const s = 0.5 + 0.5 * Math.sin(a * Math.PI * 2 + Math.sin(b * Math.PI * 2) * 1.3) * 0.7 + 0.15 * Math.sin(a * 5.3 + b * 3.1);
  return Math.min(1, Math.max(0, s)) ** 1.5;
}
export function forceAt(x, z, w) { return w.strength * w.strength * (1 - w.gust + w.gust * gustAt(x, z, w)); }

// Axeln en del böjs runt: delen lutar sig mot vinden; en del som pekar längs vinden lyfts eller sänks i stället
export function bendAxis(d, W) {
  const n = cross(d, W), s = len(n), m = cross(UP, W);
  const sg = dot(n, m) >= 0 ? 1 : -1;
  return norm([n[0] + (1 - s) * m[0] * sg, n[1] + (1 - s) * m[1] * sg, n[2] + (1 - s) * m[2] * sg]);
}
const rotate = (v, k, a) => { // Rodrigues
  const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
};

// Ett hörns position i vinden (referens för kontrollerna; shadern gör samma sak)
export function deformPoint(table, part, t, p, w) {
  const W = [Math.cos(w.dir), 0, Math.sin(w.dir)];
  let q = p, cur = part, tt = t;
  for (let k = 0; k < MAX_DEPTH && cur >= 0; k++) {
    const o = cur * STRIDE, pivot = [table[o], table[o + 1], table[o + 2]], d = [table[o + 4], table[o + 5], table[o + 6]];
    const [amp, freq, phase] = [table[o + 8], table[o + 9], table[o + 10]];
    const osc = Math.sin(w.time * freq * Math.PI * 2 + phase);
    // Lutning med kraften (strength² och byarna) och en svängning runt den med egen takt, som syns redan i en bris
    const a = amp * (forceAt(pivot[0], pivot[2], w) + w.sway * w.strength * osc) * bendShape(tt);
    if (a !== 0) { const v = rotate(sub(q, pivot), bendAxis(d, W), a); q = [pivot[0] + v[0], pivot[1] + v[1], pivot[2] + v[2]]; }
    tt = table[o + 7]; cur = Math.round(table[o + 3]);
  }
  // Det som rör marken står still (en buske som vilar på marken, rötter): rörelsen tonas in de första centimetrarna
  const g = Math.min(1, Math.max(0, p[1] / GROUND_BLEND));
  return [p[0] + (q[0] - p[0]) * g, p[1] + (q[1] - p[1]) * g, p[2] + (q[2] - p[2]) * g];
}

/**
 * Kontroller på LOD0-geometrin: { positions, part, pt }[]
 *   rig_torn: hörn som ligger i samma punkt men hamnar på olika ställen i full storm (delar slits isär)
 *   rig_still_moves: hörn som rör sig utan vind
 *   rig_ground_moves: hörn i marken (y <= 0) som rör sig i storm
 *   rig_depth: djupare hierarki än shadern går igenom
 */
export function rigChecks(table, geoms, depth) {
  const storm = { ...WIND_DEFAULTS, strength: 1, gust: 0.5, time: 1.3 }, calm = { ...WIND_DEFAULTS, strength: 0 };
  let torn = 0, still = 0, ground = 0, maxMove = 0;
  const seen = new Map();
  for (const g of geoms) {
    for (let i = 0; i < g.positions.length / 3; i++) {
      const p = [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
      const q = deformPoint(table, g.part[i], g.pt[i], p, storm);
      const moved = len(sub(q, p));
      maxMove = Math.max(maxMove, moved);
      if (p[1] <= 0 && moved > 1e-4) ground++;
      if (i % 7 === 0 && len(sub(deformPoint(table, g.part[i], g.pt[i], p, calm), p)) > 1e-6) still++;
      const key = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
      const was = seen.get(key);
      if (was) { if (len(sub(was, q)) > 2e-3) torn++; } else seen.set(key, q);
    }
  }
  return { rig_parts: table.length / STRIDE, rig_torn: torn, rig_still_moves: still, rig_ground_moves: ground, rig_depth_ok: depth < MAX_DEPTH, rig_storm_max_m: Math.round(maxMove * 100) / 100 };
}

// Närmaste punkt på en del (som polylinje): { part, t } för hörn och klungor som sitter fast på skelettet.
// lines: [{ part, pts: [[x,y,z]...] }] där t = punktens index / (antal - 1), samma som barkens _PT
export function nearestOnLines(lines, p) {
  let best = { part: 0, t: 0, d: Infinity };
  for (const l of lines) {
    const n = l.pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = l.pts[i], ab = sub(l.pts[i + 1], a), ab2 = dot(ab, ab) || 1;
      const u = Math.min(1, Math.max(0, dot(sub(p, a), ab) / ab2));
      const q = [a[0] + ab[0] * u, a[1] + ab[1] * u, a[2] + ab[2] * u], d = len(sub(p, q));
      if (d < best.d) best = { part: l.part, t: (i + u) / n, d };
    }
  }
  return best;
}

// Samma sak för många punkter: segmenten sorteras i ett rutnät (cell i meter), så att varje fråga bara ser grannarna
export function lineIndex(lines, cell = 0.5) {
  const segs = [], grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const l of lines) for (let i = 0; i < l.pts.length - 1; i++) {
    const a = l.pts[i], b = l.pts[i + 1], s = { part: l.part, a, ab: sub(b, a), i, n: l.pts.length - 1 };
    segs.push(s);
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(a[k], b[k]) / cell)), hi = [0, 1, 2].map((k) => Math.floor(Math.max(a[k], b[k]) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = key(x, y, z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s);
    }
  }
  const test = (s, p, best) => {
    const ab2 = dot(s.ab, s.ab) || 1, u = Math.min(1, Math.max(0, dot(sub(p, s.a), s.ab) / ab2));
    const d = len(sub(p, [s.a[0] + s.ab[0] * u, s.a[1] + s.ab[1] * u, s.a[2] + s.ab[2] * u]));
    if (d < best.d) { best.d = d; best.part = s.part; best.t = (s.i + u) / s.n; }
  };
  return (p) => {
    const c = p.map((x) => Math.floor(x / cell)), best = { part: 0, t: 0, d: Infinity };
    // Ringar utåt tills något hittats och nästa ring inte kan vara närmare
    for (let r = 0; r < 64; r++) {
      for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) for (let z = -r; z <= r; z++) {
        if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) !== r) continue;
        for (const s of grid.get(key(c[0] + x, c[1] + y, c[2] + z)) ?? []) test(s, p, best);
      }
      if (best.d <= r * cell) return best;
    }
    for (const s of segs) test(s, p, best);
    return best;
  };
}
