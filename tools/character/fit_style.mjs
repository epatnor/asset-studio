// Anpassar stiliseringen (hm08.mjs stylizeRaw) mot uppmätta proportioner i en referensbild:
//   node fit_style.mjs '{"macro":{...},"proxy":"male1591","armDeg":14,"ref":{"shoulders_H":0.334,"waist_H":0.171,"hips_H":0.241,"crotch_from_floor_H":0.444},"start":{...}}'
// Kroppen skinnas till referensens armvinkel (grader från lodlinjen) och mäts som i bilden (measure_body.mjs).
// Koordinatsökning över params (standard legs, shoulders, waist, hips; även arms, thighs, calves, head) med krympande steg. Svarar med en rad JSON: bästa
// parametrar, uppmätta proportioner och felet per mått.
import { buildHm08 } from './hm08.mjs';
import { measureBody } from './measure_body.mjs';
import { hm08Weights, poseBones, skinPoint } from './skin.mjs';

const r = JSON.parse(process.argv[2] ?? '{}');
const keys = Object.keys(r.ref);
const params = r.params ?? ['legs', 'shoulders', 'waist', 'hips'];
let cur = { legs: 1, hands: 1, feet: 1, eyes: 1, head: 1, waist: 1, shoulders: 1, hips: 1, arms: 1, thighs: 1, calves: 1, ...(r.start ?? {}) };
let W = null;

function measure(st) {
  const b = buildHm08(r.macro, undefined, st, {}, { proxy: r.proxy });
  W ??= hm08Weights([...Array(19158).keys()]);
  const blend = (src) => { const m = new Map(); for (const [v, a] of src) for (const [bn, w] of W[v]) m.set(bn, (m.get(bn) ?? 0) + a * w); return [...m]; };
  // Armarna ned till referensens vinkel: överarmen roteras runt framåtaxeln
  const J = b.joints, d = [J.LeftLowerArm[0] - J.LeftUpperArm[0], J.LeftLowerArm[1] - J.LeftUpperArm[1]];
  const cur = Math.atan2(d[0], -d[1]) * 180 / Math.PI, rot = cur - (r.armDeg ?? 14);
  const ax = (deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
  const pose = poseBones(J, { LeftUpperArm: ax(-rot), RightUpperArm: ax(rot) });
  const P = b.verts.map((p, i) => skinPoint(p, blend(b.src[i]), J, pose));
  const minY = Math.min(...P.map((p) => p[1]));
  const tris = b.quads.flatMap((q) => (q.length === 4 ? [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] : [q]));
  return measureBody(P.map((p) => [p[0], p[1] - minY, p[2]]), tris);
}
const err = (m) => keys.reduce((s, k) => s + (m[k] == null ? 1 : ((m[k] - r.ref[k]) / r.ref[k]) ** 2), 0);

let best = measure(cur), bestErr = err(best);
for (let step = 0.12; step > 0.008; step /= 2) {
  let improved = true;
  while (improved) {
    improved = false;
    for (const k of params) for (const dir of [1, -1]) {
      const trial = { ...cur, [k]: +(cur[k] + dir * step).toFixed(4) };
      if (trial[k] < 0.6 || trial[k] > 1.6) continue;
      const m = measure(trial), e = err(m);
      if (e < bestErr - 1e-6) { cur = trial; best = m; bestErr = e; improved = true; }
    }
  }
}
console.log(JSON.stringify({ params: Object.fromEntries(params.map((k) => [k, cur[k]])), measured: best, error: Object.fromEntries(keys.map((k) => [k, +((best[k] - r.ref[k]) / r.ref[k] * 100).toFixed(1)])) }));
