// Byggsatsens sömkontrakt på hm08: hittar sömmarna som riktiga kantslingor i basmeshen och delar
// kroppen i 15 nakna delar. Resultatet är topologi (hörn- och ytindex), så det gäller för alla kroppar
// som görs med targets, och sparas i hm08_kit.json.
//
//   node kit_hm08.mjs '{"out":"/abs/hm08_kit.json"}'
//
// En söm söks nära ett snittplan vid en led: från kanter nära planet som går runt lemmen följs
// kantslingan genom hörn med fyra grannar tills den sluts. Bland slutna slingor runt rätt lem väljs
// den som ligger närmast planet.
import fs from 'node:fs';
import { sub, dot, norm, len, lerp } from '../tree/vec.mjs';
import { buildHm08 } from './hm08.mjs';

const recipe = JSON.parse(process.argv[2] ?? '{}');
const body = buildHm08({});
const { verts: V, quads: Q, joints: J, tips: T, cubes } = body;

// Kanter -> ytor, och grannar per hörn
const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
const edgeFaces = new Map();
const nbr = V.map(() => new Set());
Q.forEach((q, fi) => q.forEach((a, k) => {
  const b = q[(k + 1) % 4];
  (edgeFaces.get(ek(a, b)) ?? edgeFaces.set(ek(a, b), []).get(ek(a, b))).push(fi);
  nbr[a].add(b); nbr[b].add(a);
}));

// Kantslinga från kanten a->b: i varje hörn med fyra grannar fortsätter den längs kanten som inte delar
// yta med kanten man kom ifrån. Ger hörnen i ordning, eller null om slingan inte sluts.
function walkLoop(a0, b0) {
  const loop = [a0];
  let a = a0, b = b0;
  for (let step = 0; step < 600; step++) {
    if (b === a0) return loop;
    loop.push(b);
    if (nbr[b].size !== 4) return null;
    const faces = edgeFaces.get(ek(a, b));
    const inFaces = new Set(faces.flatMap((fi) => Q[fi]));
    const next = [...nbr[b]].filter((c) => c !== a && !inFaces.has(c));
    if (next.length !== 1) return null;
    a = b; b = next[0];
  }
  return null;
}

// Sömmar: snittplan (punkt och normal längs lemmen) och hur långt från punkten slingan får ligga
const S = (name, point, axis, reach) => ({ name, point, axis: norm(axis), reach });
const seams = [
  S('neck', lerp(J.Neck, J.Head, 0.3), sub(J.Head, J.Neck), 0.12),
  S('waist', lerp(J.Hips, cubes['joint-spine-3'], 0.55), sub(cubes['joint-spine-3'], J.Hips), 0.3),
];
for (const [s, c] of [['Left', 'L'], ['Right', 'R']]) {
  seams.push(
    S(`shoulder_${c}`, lerp(J[`${s}UpperArm`], J[`${s}LowerArm`], 0.12), sub(J[`${s}LowerArm`], J[`${s}UpperArm`]), 0.1),
    S(`elbow_${c}`, J[`${s}LowerArm`], sub(J[`${s}Hand`], J[`${s}UpperArm`]), 0.08),
    S(`wrist_${c}`, J[`${s}Hand`], sub(J[`${s}Hand`], J[`${s}LowerArm`]), 0.06),
    S(`groin_${c}`, lerp(J[`${s}UpperLeg`], J[`${s}LowerLeg`], 0.18), sub(J[`${s}LowerLeg`], J[`${s}UpperLeg`]), 0.12),
    S(`knee_${c}`, J[`${s}LowerLeg`], sub(J[`${s}Foot`], J[`${s}UpperLeg`]), 0.1),
    S(`ankle_${c}`, lerp(J[`${s}LowerLeg`], J[`${s}Foot`], 0.93), sub(J[`${s}Foot`], J[`${s}LowerLeg`]), 0.08),
  );
}

function findSeam(seam) {
  const pd = (i) => dot(sub(V[i], seam.point), seam.axis);
  const seen = new Set();
  let best = null;
  for (const key of edgeFaces.keys()) {
    const [a, b] = key.split(',').map(Number);
    const da = pd(a), db = pd(b);
    if (Math.min(Math.abs(da), Math.abs(db)) > 0.015) continue;
    if (len(sub(lerp(V[a], V[b], 0.5), seam.point)) > seam.reach) continue;
    if (Math.abs(dot(norm(sub(V[b], V[a])), seam.axis)) > 0.4) continue;
    const loop = walkLoop(a, b);
    if (!loop || loop.length < 8) continue;
    const id = [...loop].sort((x, y) => x - y).join(',');
    if (seen.has(id)) continue;
    seen.add(id);
    if (loop.some((i) => len(sub(V[i], seam.point)) > seam.reach * 1.6)) continue;
    const score = loop.reduce((s, i) => s + Math.abs(pd(i)), 0) / loop.length;
    if (!best || score < best.score) best = { loop, score };
  }
  return best;
}

const found = seams.map((s) => ({ ...s, ...(findSeam(s) ?? {}) }));
const missing = found.filter((s) => !s.loop).map((s) => s.name);

// Dela kroppen: ytor hänger ihop över alla kanter utom sömmarnas
const seamEdges = new Set();
for (const s of found) if (s.loop) s.loop.forEach((a, k) => seamEdges.add(ek(a, s.loop[(k + 1) % s.loop.length])));
const part = new Int32Array(Q.length).fill(-1);
const comps = [];
for (let f0 = 0; f0 < Q.length; f0++) {
  if (part[f0] >= 0) continue;
  const list = [f0]; part[f0] = comps.length;
  for (let k = 0; k < list.length; k++) {
    const q = Q[list[k]];
    for (let e = 0; e < 4; e++) {
      const key = ek(q[e], q[(e + 1) % 4]);
      if (seamEdges.has(key)) continue;
      for (const g of edgeFaces.get(key)) if (part[g] < 0) { part[g] = comps.length; list.push(g); }
    }
  }
  comps.push(list);
}

// Namnge bitarna efter närmaste referenspunkt på skelettet
const REF = { head: J.Head, torso: J.Chest, pelvis: J.Hips };
for (const [s, c] of [['Left', 'L'], ['Right', 'R']]) Object.assign(REF, {
  [`upperarm_${c}`]: lerp(J[`${s}UpperArm`], J[`${s}LowerArm`], 0.5), [`forearm_${c}`]: lerp(J[`${s}LowerArm`], J[`${s}Hand`], 0.5),
  [`hand_${c}`]: lerp(J[`${s}Hand`], T[`${s}HandTip`], 0.5), [`thigh_${c}`]: lerp(J[`${s}UpperLeg`], J[`${s}LowerLeg`], 0.5),
  [`shin_${c}`]: lerp(J[`${s}LowerLeg`], J[`${s}Foot`], 0.5), [`foot_${c}`]: lerp(J[`${s}Foot`], T[`${s}ToeTip`], 0.5),
});
const centroid = (list) => { const vs = [...new Set(list.flatMap((fi) => Q[fi]))]; return [0, 1, 2].map((k) => vs.reduce((s, i) => s + V[i][k], 0) / vs.length); };
const names = comps.map((list) => {
  const c = centroid(list);
  return Object.entries(REF).sort((x, y) => len(sub(c, x[1])) - len(sub(c, y[1])))[0][0];
});

// Kontroller: 15 bitar med unika namn, varje söm delas av exakt två bitar
const checks = { seams_found: found.length - missing.length, seams_missing: missing, parts: comps.length };
checks.duplicate_names = names.filter((n, i) => names.indexOf(n) !== i);
checks.seam_sides = Object.fromEntries(found.filter((s) => s.loop).map((s) => {
  const a = s.loop[0], b = s.loop[1];
  return [s.name, [...new Set(edgeFaces.get(ek(a, b)).map((fi) => names[part[fi]]))].join('|')];
}));
checks.seam_verts = Object.fromEntries(found.filter((s) => s.loop).map((s) => [s.name, s.loop.length]));
// Spegling: varje hörn i en vänstersöm ska ha sin spegelbild i motsvarande högersöm (inom 1 mm),
// och vänster- och högerdelar ska ha lika många ytor
const loopOf = Object.fromEntries(found.filter((x) => x.loop).map((x) => [x.name, x.loop]));
checks.seams_unmirrored = Object.keys(loopOf).filter((n) => n.endsWith('_L')).filter((n) => {
  const R = loopOf[n.replace(/_L$/, '_R')];
  return !R || loopOf[n].some((i) => !R.some((j) => len(sub(V[j], [-V[i][0], V[i][1], V[i][2]])) < 0.001));
});
const faceCount = Object.fromEntries(comps.map((l, i) => [names[i], l.length]));
checks.parts_unbalanced = Object.keys(faceCount).filter((n) => n.endsWith('_L') && faceCount[n] !== faceCount[n.replace(/_L$/, '_R')]);
checks.faces_per_part = faceCount;
checks.ok = !missing.length && comps.length === 15 && !checks.duplicate_names.length && !checks.seams_unmirrored.length && !checks.parts_unbalanced.length
  && Object.values(checks.seam_sides).every((x) => x.split('|').length === 2);

if (recipe.out) {
  fs.writeFileSync(recipe.out, JSON.stringify({
    _doc: 'Sömkontraktet för hm08 (kit_hm08.mjs). Index gäller kroppens hörn och ytor i hm08.mjs (gruppen body, hörn i ordning efter hm08-index). seams: hörnen i varje söm i slingans ordning. parts: ytindex per naken del.',
    seams: Object.fromEntries(found.filter((s) => s.loop).map((s) => [s.name, s.loop])),
    parts: Object.fromEntries(comps.map((list, i) => [names[i], list])),
  }));
}
console.log(JSON.stringify({ out: recipe.out ?? null, faces: Q.length, checks }));
