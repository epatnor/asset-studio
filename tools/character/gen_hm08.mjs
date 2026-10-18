// Kropp ur MakeHumans hm08 (hm08.mjs): recept in, glTF ut, en rad JSON med kontroller.
//
//   node gen_hm08.mjs '{"name":"hero_hm","out":"/abs/hero_hm.gltf","macro":{"gender":1,"age":0.5,"muscle":0.8,"weight":0.55,"height":0.8,"proportions":1}}'
//
// Receptfält: macro (gender 1 = man, age 0,5 = 25 år, muscle, weight, height, proportions; 0–1, 0,5 = medel),
// ethnic ({african, asian, caucasian}, summa 1), skin (#RRGGBB).
import fs from 'node:fs';
import { Document } from '@gltf-transform/core';
import { writeGltf } from '../tree/gltf_write.mjs';
import { sub, add, cross, dot, norm } from '../tree/vec.mjs';
import { BONES } from './skeleton.mjs';
import { buildHm08 } from './hm08.mjs';

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
const prim = doc.createPrimitive()
  .setAttribute('POSITION', acc('VEC3', Float32Array.from(verts.flat())))
  .setAttribute('NORMAL', acc('VEC3', Float32Array.from(normals.flat())))
  .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(verts.flatMap(() => skin))))
  .setIndices(acc('SCALAR', Uint32Array.from(tris.flat())))
  .setMaterial(mat);
root.addChild(doc.createNode(`${name}_body`).setMesh(doc.createMesh(`${name}_body`).addPrimitive(prim)));
root.setExtras({ source: 'makehuman hm08 (CC0)', macro: recipe.macro, joints: J });
doc.createScene(name).addChild(root);
await writeGltf(doc, recipe.out);

console.log(JSON.stringify({ name, out: recipe.out, verts: verts.length, tris: tris.length, checks }));
