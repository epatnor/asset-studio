// Kropp ur MakeHumans hm08 (hm08.mjs): recept in, glTF ut, en rad JSON med kontroller.
//
//   node gen_hm08.mjs '{"name":"hero_hm","out":"/abs/hero_hm.gltf","macro":{"gender":1,"age":0.5,"muscle":0.8,"weight":0.55,"height":0.8,"proportions":1}}'
//
// Receptfält: macro (gender 1 = man, age 0,5 = 25 år, muscle, weight, height, proportions; 0–1, 0,5 = medel),
// ethnic ({african, asian, caucasian}, summa 1), skin (#RRGGBB), kit (true: en meshnod per naken del enligt
// sömkontraktet i hm08_kit.json), explode (dra isär delarna, t.ex. 0,15), debug ("parts": en färg per del),
// outfit ({plats: del i parts.json}, kräver kit; delen ersätter de nakna delarna på sina platser),
// colors ({cloth, accent} för plaggen).
import fs from 'node:fs';
import { Document } from '@gltf-transform/core';
import { writeGltf } from '../tree/gltf_write.mjs';
import { sub, add, cross, dot, norm } from '../tree/vec.mjs';
import { BONES } from './skeleton.mjs';
import { buildHm08 } from './hm08.mjs';
import { buildGarment, garmentChecks, offsetFn } from './garment.mjs';

const recipe = JSON.parse(process.argv[2] ?? '{}');
const style = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
const body = buildHm08(recipe.macro ?? {}, recipe.ethnic);
const { verts, quads, joints: J } = body;

// Quads till trianglar längs den kortare diagonalen; hm08:s quads pekar redan utåt
const tris = [];
for (const [a, b, c, d] of quads) {
  const ac = sub(verts[c], verts[a]), bd = sub(verts[d], verts[b]);
  if (dot(ac, ac) <= dot(bd, bd)) tris.push([a, b, c], [a, c, d]); else tris.push([a, b, d], [b, c, d]);
}
// Hörnnormaler viktade med triangelarea
const normals = verts.map(() => [0, 0, 0]);
for (const [a, b, c] of tris) {
  const n = cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]));
  for (const i of [a, b, c]) normals[i] = add(normals[i], n);
}
for (let i = 0; i < normals.length; i++) normals[i] = norm(normals[i]);

// Kontroller
const checks = {};
const ys = verts.map((p) => p[1]);
checks.missing_targets = body.missing.length;
checks.targets = body.targets;
checks.height = +Math.max(...ys).toFixed(3);
// Hakan: i profilen längs mittlinjen hoppar framkanten från halsen ut till hakan. Hakans underkant är
// den lägsta punkten som ligger längre fram än mitten mellan halsens framkant och hm08:s Jaw-led
// (som sitter vid hakspetsen).
const midline = verts.filter((p) => Math.abs(p[0]) < 0.02 && p[2] > J.Neck[2]);
const throatZ = Math.max(...midline.filter((p) => Math.abs(p[1] - J.Neck[1]) < 0.01).map((p) => p[2]));
const chin = Math.min(...midline.filter((p) => p[1] > J.Neck[1] && p[2] > (throatZ + J.Jaw[2]) / 2).map((p) => p[1]));
checks.heads_measured = +(checks.height / (checks.height - chin)).toFixed(2);
// Symmetri: varje hörn ska ha en spegling i x inom 1 mm
const keys = new Set(verts.map((p) => p.map((v) => Math.round(v * 1000)).join(',')));
checks.symmetry = +(verts.filter((p) => {
  const [x, y, z] = p.map((v) => Math.round(v * 1000));
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (keys.has(`${-x + dx},${y + dy},${z + dz}`)) return true;
  return false;
}).length / verts.length).toFixed(4);
// Lederna i rätt ordning uppifrån och ned, och vänster på +x
checks.joint_order = J.Head[1] > J.Neck[1] && J.Neck[1] > J.Chest[1] && J.Chest[1] > J.Spine[1] && J.Spine[1] > J.Hips[1]
  && J.Hips[1] > J.LeftLowerLeg[1] && J.LeftLowerLeg[1] > J.LeftFoot[1] && J.LeftUpperArm[0] > 0 && J.LeftHand[0] > J.LeftLowerArm[0];
checks.tris = tris.length;
const [bmin, bmax] = style.budgets_tris.character;
checks.within_budget = tris.length >= bmin * 0.8 && tris.length <= bmax;
checks.ok = !checks.missing_targets && checks.symmetry > 0.99 && checks.joint_order && checks.within_budget;

// glTF: skelettnoder med våra namn och en kroppsmesh
const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const name = recipe.name ?? 'hm08';
const root = doc.createNode(name);
const nodes = {};
for (const [bone, par] of BONES) {
  nodes[bone] = doc.createNode(bone).setTranslation(sub(J[bone], par ? J[par] : [0, 0, 0]));
  (par ? nodes[par] : root).addChild(nodes[bone]);
}
const linear = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const skin = linear(recipe.skin ?? '#E9B48A');
const mat = doc.createMaterial('Skin').setRoughnessFactor(style.character.materials.skin.roughness).setMetallicFactor(0);
// En mesh per del. Normalerna räknades på hela kroppen, så hörnen i en söm har samma läge och normal
// på båda sidor. Varje quad gav två trianglar i ordning (tris[2f], tris[2f + 1]).
const DEBUG = ['#E6B8A2', '#4F7BE0', '#3F5443', '#D9A423', '#B3263A', '#5FD3C8', '#9B6BE0', '#E07A1F', '#2FA866',
  '#C9C2B5', '#6B4A2E', '#F2A23A', '#3E859C', '#8A4FD8', '#7FAE4A'];
const kitData = recipe.kit ? JSON.parse(fs.readFileSync(new URL('./hm08_kit.json', import.meta.url))) : null;
const kit = kitData ? { ...kitData.parts } : { body: quads.map((_, f) => f) };
// Plaggen: varje del i outfit ersätter de nakna delarna på sina platser. outfit: { plats: del } eller
// { plats: { part, color, trim } }. En söm mot ett annat plagg blir öppen: ingen fåll, och båda plaggen
// lägger kanten på samma avstånd (det största av deras två) så att de möts i samma hörn.
const partsLib = JSON.parse(fs.readFileSync(new URL('./parts.json', import.meta.url)));
const owner = {};
const entries = Object.entries(recipe.outfit ?? {}).map(([slot, e]) => {
  const o = typeof e === 'string' ? { part: e } : e;
  const spec = partsLib[o.part];
  for (const s of spec.slots) owner[s] = slot;
  return { slot, partName: o.part, spec, color: o.color ?? recipe.colors?.cloth ?? '#3F5443', trim: o.trim ?? recipe.colors?.accent ?? '#D9A423' };
});
// Vilka delar varje söm skiljer (ur första kanten i slingan)
const partOfFace = new Map();
if (kitData) for (const [pn, fs2] of Object.entries(kitData.parts)) for (const f of fs2) partOfFace.set(f, pn);
const edgeFacesAll = new Map();
quads.forEach((q, fi) => q.forEach((a, k) => { const b = q[(k + 1) % 4], key = a < b ? `${a},${b}` : `${b},${a}`; (edgeFacesAll.get(key) ?? edgeFacesAll.set(key, []).get(key)).push(fi); }));
const seamSides = kitData ? Object.fromEntries(Object.entries(kitData.seams).map(([n, l]) => {
  const key = l[0] < l[1] ? `${l[0]},${l[1]}` : `${l[1]},${l[0]}`;
  return [n, [...new Set(edgeFacesAll.get(key).map((f) => partOfFace.get(f)))]];
})) : {};
const offsets = Object.fromEntries(entries.map((e) => [e.slot, offsetFn(e.spec, J)]));
const garments = [];
for (const e of entries) {
  const openSeams = {};
  for (const [n, sides] of Object.entries(seamSides)) {
    const [a, b] = sides.map((p) => owner[p]);
    if (!a || !b || a === b || (a !== e.slot && b !== e.slot)) continue;
    const fa = offsets[a], fb = offsets[b];
    openSeams[n] = (v) => Math.max(fa(verts[v]), fb(verts[v]));
  }
  const g = buildGarment({ verts, normals, quads, joints: J }, kitData, {
    ...e.spec, color: linear(e.color), trimColor: e.spec.trim ? linear(e.trim) : null,
  }, { openSeams });
  checks[`part_${e.slot}_${e.partName}`] = garmentChecks({ verts, normals }, g, kitData);
  for (const s of e.spec.slots) delete kit[s];
  garments.push({ ...e, g });
}
// Öppna sömmar: båda plaggens kanthörn ska ligga på samma ställe
let clothSeamError = 0;
for (const A of garments) for (const B of garments) {
  if (A === B) continue;
  for (const n of A.g.open.filter((x) => B.g.open.includes(x))) for (const v of kitData.seams[n]) {
    const pa = A.g.positions[A.g.shellOf.get(v)], pb = B.g.positions[B.g.shellOf.get(v)];
    clothSeamError = Math.max(clothSeamError, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]));
  }
}
if (garments.length) checks.cloth_seam_error_mm = +(clothSeamError * 1000).toFixed(4);
checks.ok = checks.ok && clothSeamError < 1e-5 && garments.every(({ slot, partName }) => {
  const c = checks[`part_${slot}_${partName}`];
  return c.shell_inside === 0 && c.seam_error_mm < 0.01;
});
const lo = [0, 1, 2].map((k) => Math.min(...verts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...verts.map((p) => p[k])));
const mid = lo.map((v, k) => (v + hi[k]) / 2);
Object.entries(kit).forEach(([part, faces], pi) => {
  const local = new Map(), idx = [];
  for (const f of faces) for (const t of [tris[2 * f], tris[2 * f + 1]]) for (const v of t) { if (!local.has(v)) local.set(v, local.size); idx.push(local.get(v)); }
  const vs = [...local.keys()];
  const col = recipe.debug === 'parts' ? linear(DEBUG[pi % DEBUG.length]) : skin;
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', Float32Array.from(vs.flatMap((v) => verts[v]))))
    .setAttribute('NORMAL', acc('VEC3', Float32Array.from(vs.flatMap((v) => normals[v]))))
    .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(vs.flatMap(() => col))))
    .setIndices(acc('SCALAR', Uint32Array.from(idx)))
    .setMaterial(mat);
  const c = [0, 1, 2].map((k) => vs.reduce((s, v) => s + verts[v][k], 0) / vs.length);
  const node = doc.createNode(`body_${part}`).setMesh(doc.createMesh(`body_${part}`).addPrimitive(prim));
  // Isärdragning i x och y; allt lyfts så att den lägsta delen står kvar på marken
  if (recipe.explode) node.setTranslation([(c[0] - mid[0]) * recipe.explode, (c[1] - lo[1]) * recipe.explode, 0]);
  root.addChild(node);
});
for (const { slot, partName, spec, g } of garments) {
  const m = style.character.materials[spec.material] ?? style.character.materials.cloth;
  const gmat = doc.createMaterial(spec.material[0].toUpperCase() + spec.material.slice(1)).setRoughnessFactor(m.roughness).setMetallicFactor(m.metalness ?? 0);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', Float32Array.from(g.positions.flat())))
    .setAttribute('NORMAL', acc('VEC3', Float32Array.from(g.normals.flat())))
    .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(g.colors.flat())))
    .setIndices(acc('SCALAR', Uint32Array.from(g.tris.flat())))
    .setMaterial(gmat);
  root.addChild(doc.createNode(`part_${slot}_${partName}`).setMesh(doc.createMesh(`part_${slot}_${partName}`).addPrimitive(prim)));
}
root.setExtras({ source: 'makehuman hm08 (CC0)', macro: recipe.macro, joints: J });
doc.createScene(name).addChild(root);
await writeGltf(doc, recipe.out);

console.log(JSON.stringify({ name, out: recipe.out, verts: verts.length, tris: tris.length, checks }));
