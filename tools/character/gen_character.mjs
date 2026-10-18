// Karaktärsgenerator: recept in, glTF ut, en rad JSON med kontroller. Skelettet först (skeleton.mjs),
// kroppen som avståndsfält från skelettet (body.mjs), mesh med surface nets från trädgeneratorn.
//
//   node gen_character.mjs '{"name":"hero1","archetype":"hero","seed":1,"out":"/abs/hero1.gltf"}'
//
// Receptfält: archetype (characters.json), seed, overrides (överstyr arketypens värden),
// cell (meshens cellstorlek i meter, standard efter höjden så att trianglarna hamnar inom budget).
import fs from 'node:fs';
import { Document } from '@gltf-transform/core';
import { writeGltf } from '../tree/gltf_write.mjs';
import { surfaceNets, gradient } from '../tree/crown.mjs';
import { sub, mul, dot, cross, rng } from '../tree/vec.mjs';
import { buildSkeleton } from './skeleton.mjs';
import { buildBody, bodyField, bodyBounds } from './body.mjs';

const recipe = JSON.parse(process.argv[2] ?? '{}');
const chars = JSON.parse(fs.readFileSync(new URL('./characters.json', import.meta.url)));
const style = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
const archetype = recipe.archetype ?? 'hero';
const a = { ...chars[archetype], ...(recipe.overrides ?? {}) };
const seed = recipe.seed ?? 1;

const sk = buildSkeleton(a, seed);
const prims = buildBody(sk, a);
const { f, info } = bodyField(prims);

// Gittret är symmetriskt kring x = 0 (samma cellgräns på båda sidor), så att meshen blir spegelsymmetrisk.
// y-gittret är förskjutet ett halvt steg så att marksnittet aldrig hamnar exakt på en gitterpunkt.
const cell = recipe.cell ?? 0.0105 * Math.sqrt(sk.H / 1.8);
const bb = bodyBounds(prims, 2 * cell);
const X = Math.ceil(Math.max(-bb.lo[0], bb.hi[0]) / cell) * cell;
const lo = [-X, -1.5 * cell, bb.lo[2]], hi = [X, bb.hi[1], bb.hi[2]];
const net = surfaceNets(f, lo, hi, cell);

// Två Newtonsteg mot ytan, normaler ur fältets gradient
const e = cell * 0.25;
const verts = net.verts.map((p) => {
  for (let i = 0; i < 2; i++) p = sub(p, mul(gradient(f, p, e), f(p)));
  return p;
});
const normals = verts.map((p) => gradient(f, p, e));
const near = verts.map((p) => prims[info(p).pi]);

// Quads till trianglar längs den kortare diagonalen, vända så att de pekar ut ur kroppen
const tris = [];
for (const q of net.quads) {
  const [A, B, C, Dv] = q.map((i) => verts[i]);
  const qn = cross(sub(C, A), sub(Dv, B));
  const nAvg = q.reduce((s, i) => [s[0] + normals[i][0], s[1] + normals[i][1], s[2] + normals[i][2]], [0, 0, 0]);
  const out = dot(qn, nAvg) > 0;
  const d02 = dot(sub(C, A), sub(C, A)), d13 = dot(sub(Dv, B), sub(Dv, B));
  const [i0, i1, i2, i3] = q;
  const t = d02 <= d13 ? [[i0, i1, i2], [i0, i2, i3]] : [[i0, i1, i3], [i1, i2, i3]];
  for (const [x, y, z] of t) tris.push(out ? [x, y, z] : [x, z, y]);
}

// Färg: hud ur arketypens lista med seed (kläder och ansikte kommer i nästa steg)
const pick = rng(seed * 31 + 5);
const choose = (list) => list[Math.floor(pick() * list.length)];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const colors = { skin: choose(a.colors.skin) };
const skin = hex(colors.skin);

// Kontroller
const checks = {};
const ys = verts.map((p) => p[1]);
const minY = Math.min(...ys), maxY = Math.max(...ys);
checks.min_y = +minY.toFixed(4);
const sole = (s) => verts.filter((p, i) => p[1] < 0.004 && Math.sign(p[0]) === s && near[i].part === 'foot').length;
checks.sole_verts = [sole(1), sole(-1)];
checks.feet_on_ground = Math.abs(minY) < 0.003 && checks.sole_verts.every((n) => n > 20);
// Symmetri: varje vertex ska ha en spegling i x inom 1 mm
const key = (p) => p.map((v) => Math.round(v * 1000)).join(',');
const keys = new Set(verts.map(key));
const mirrored = verts.filter((p) => {
  const [x, y, z] = p.map((v) => Math.round(v * 1000));
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (keys.has(`${-x + dx},${y + dy},${z + dz}`)) return true;
  return false;
}).length;
checks.symmetry = +(mirrored / verts.length).toFixed(4);
// Sammanhängande: union-find över trianglarna (lösa fingrar eller öron syns här)
const parent = Int32Array.from(verts, (_, i) => i);
const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
for (const [x, y, z] of tris) { parent[find(y)] = find(x); parent[find(z)] = find(x); }
checks.components = new Set(verts.map((_, i) => find(i))).size;
checks.heads_measured = +(maxY / (maxY - sk.dims.chinY)).toFixed(2);
checks.heads_target = +sk.heads.toFixed(2);
checks.height = +maxY.toFixed(3);
checks.tris = tris.length;
const [bmin, bmax] = style.budgets_tris.character;
checks.within_budget = tris.length >= bmin * 0.8 && tris.length <= bmax;
checks.ok = checks.feet_on_ground && checks.symmetry > 0.99 && checks.components === 1
  && Math.abs(checks.heads_measured - checks.heads_target) <= (a.hunch ? 0.6 : 0.25) && checks.within_budget;

// glTF
const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const mat = style.character.materials;
const skinMat = doc.createMaterial('Skin').setRoughnessFactor(mat.skin.roughness).setMetallicFactor(0);
const prim = doc.createPrimitive()
  .setAttribute('POSITION', acc('VEC3', Float32Array.from(verts.flat())))
  .setAttribute('NORMAL', acc('VEC3', Float32Array.from(normals.flat())))
  .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(verts.flatMap(() => skin))))
  .setIndices(acc('SCALAR', Uint32Array.from(tris.flat())))
  .setMaterial(skinMat);
const name = recipe.name ?? `${archetype}_${seed}`;
const mesh = doc.createMesh(`${name}_body`).addPrimitive(prim);
const node = doc.createNode(`${name}_body`).setMesh(mesh);
const root = doc.createNode(name).addChild(node).setExtras({ archetype, seed, heads: sk.heads, height: sk.H, joints: sk.joints });
doc.createScene(name).addChild(root);
await writeGltf(doc, recipe.out);

console.log(JSON.stringify({ name, out: recipe.out, archetype, seed, tris: tris.length, verts: verts.length, prims: prims.length, cell: +cell.toFixed(4), colors, checks }));
