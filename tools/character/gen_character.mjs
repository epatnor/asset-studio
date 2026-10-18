// Karaktärsgenerator: recept in, glTF ut, en rad JSON med kontroller. Skelettet först (skeleton.mjs),
// kroppen som avståndsfält från skelettet (body.mjs). Meshen kommer från rasens mall (template.mjs):
// referenskroppen meshas med surface nets och delas i regioner (regions.mjs), och varje kropp av rasen
// får samma hörn och trianglar, anpassade till sitt eget fält.
//
//   node gen_character.mjs '{"name":"hero1","archetype":"hero","seed":1,"out":"/abs/hero1.gltf"}'
//
// Receptfält: archetype (characters.json), seed, overrides (överstyr arketypens värden),
// cell (mallens cellstorlek i meter, standard efter referensens höjd), debug: "regions" (färg per region).
//
// Utdata: skelettet som noder (Hips ... med sockets som barn till sina ben) och en meshnod per region
// (body_head, body_torso, body_hand_L ...), så att plagg kan dölja regionerna de täcker.
import fs from 'node:fs';
import { Document } from '@gltf-transform/core';
import { writeGltf } from '../tree/gltf_write.mjs';
import { surfaceNets, gradient } from '../tree/crown.mjs';
import { sub, mul, dot, cross, rng } from '../tree/vec.mjs';
import { buildSkeleton, BONES, quatFromAxes } from './skeleton.mjs';
import { buildBody, bodyField, bodyBounds } from './body.mjs';
import { assignRegions, regionChecks, REGIONS } from './regions.mjs';
import { bindTemplate, fitTemplate, vertexNeighbors } from './template.mjs';

const recipe = JSON.parse(process.argv[2] ?? '{}');
const chars = JSON.parse(fs.readFileSync(new URL('./characters.json', import.meta.url)));
const style = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
const archetype = recipe.archetype ?? 'hero';
const a = { ...chars[archetype], ...(recipe.overrides ?? {}) };
const seed = recipe.seed ?? 1;
const race = a.race ?? 'human';
const refName = chars._races[race].reference;
const aRef = chars[refName];

// Mallen: referenskroppen (seed 0) meshad med surface nets. Gittret är symmetriskt kring x = 0 och
// y-gittret förskjutet ett halvt steg, så att marksnittet aldrig hamnar på en gitterpunkt.
function buildTemplate() {
  const sk = buildSkeleton(aRef, 0);
  const prims = buildBody(sk, aRef);
  const { f } = bodyField(prims);
  const grid = (cell) => {
    const bb = bodyBounds(prims, 2 * cell);
    const X = Math.ceil(Math.max(-bb.lo[0], bb.hi[0]) / cell) * cell;
    return surfaceNets(f, [-X, -1.5 * cell, bb.lo[2]], [X, bb.hi[1], bb.hi[2]], cell);
  };
  // Cellstorleken räknas fram ur en grov provmeshning (antalet quads växer med 1 / cell²), så att
  // mallen hamnar nära TARGET_TRIS oavsett kroppens storlek och form
  const TARGET_TRIS = 45000, probe = 0.025;
  const cell = recipe.cell ?? probe * Math.sqrt((grid(probe).quads.length * 2) / TARGET_TRIS);
  const net = grid(cell);
  const e = cell * 0.25;
  const verts = net.verts.map((p) => { for (let i = 0; i < 2; i++) p = sub(p, mul(gradient(f, p, e), f(p))); return p; });
  const normals = verts.map((p) => gradient(f, p, e));
  // Quads till trianglar längs den kortare diagonalen, vända så att de pekar ut ur kroppen
  const tris = [];
  for (const q of net.quads) {
    const [A, B, C, D] = q.map((i) => verts[i]);
    const nAvg = q.reduce((s, i) => [s[0] + normals[i][0], s[1] + normals[i][1], s[2] + normals[i][2]], [0, 0, 0]);
    const out = dot(cross(sub(C, A), sub(D, B)), nAvg) > 0;
    const [i0, i1, i2, i3] = q;
    const t = dot(sub(C, A), sub(C, A)) <= dot(sub(D, B), sub(D, B)) ? [[i0, i1, i2], [i0, i2, i3]] : [[i0, i1, i3], [i1, i2, i3]];
    for (const [x, y, z] of t) tris.push(out ? [x, y, z] : [x, z, y]);
  }
  const regions = assignRegions(verts, tris, sk);
  return { sk, cell, verts, tris, regions, bind: bindTemplate(verts, sk), neighbors: vertexNeighbors(verts.length, net.quads) };
}

const tpl = buildTemplate();
const sk = buildSkeleton(a, seed);
const prims = buildBody(sk, a);
const { f, info } = bodyField(prims);
const cell = tpl.cell;
const verts = fitTemplate(tpl, tpl.sk, sk, f, cell);
const tris = tpl.tris;
const normals = verts.map((p) => gradient(f, p, cell * 0.25));
const near = verts.map((p) => prims[info(p).pi]);

// Färg: hud ur arketypens lista med seed, eller en färg per region (debug)
const pick = rng(seed * 31 + 5);
const choose = (list) => list[Math.floor(pick() * list.length)];
const linear = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const colors = { skin: choose(a.colors.skin) };
const DEBUG = ['#E6B8A2', '#4F7BE0', '#3F5443', '#D9A423', '#B3263A', '#5FD3C8', '#9B6BE0', '#E07A1F', '#2FA866',
  '#C9C2B5', '#6B4A2E', '#F2A23A', '#3E859C', '#8A4FD8', '#7FAE4A'];
const regionColor = (r) => linear(recipe.debug === 'regions' ? DEBUG[REGIONS.indexOf(r) % DEBUG.length] : colors.skin);

// Kontroller
const checks = {};
const ys = verts.map((p) => p[1]);
const minY = Math.min(...ys), maxY = Math.max(...ys);
checks.min_y = +minY.toFixed(4);
const sole = (s) => verts.filter((p, i) => p[1] < 0.004 && Math.sign(p[0]) === s && near[i].part === 'foot').length;
checks.sole_verts = [sole(1), sole(-1)];
checks.feet_on_ground = Math.abs(minY) < 0.003 && checks.sole_verts.every((n) => n > 20);
// Symmetri: varje vertex ska ha en spegling i x inom 1 mm
const keys = new Set(verts.map((p) => p.map((v) => Math.round(v * 1000)).join(',')));
const mirrored = verts.filter((p) => {
  const [x, y, z] = p.map((v) => Math.round(v * 1000));
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (keys.has(`${-x + dx},${y + dy},${z + dz}`)) return true;
  return false;
}).length;
checks.symmetry = +(mirrored / verts.length).toFixed(4);
// Sammanhängande: union-find över trianglarna
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
// Mallen: hur väl hörnen ligger på ytan och om några trianglar vänts
checks.template = refName;
checks.fit_error_mm = +(Math.max(...verts.map((p) => Math.abs(f(p)))) * 1000).toFixed(2);
const flipped = tris.map((t, ti) => ti).filter((ti) => {
  const [x, y, z] = tris[ti];
  const c = [0, 1, 2].map((k) => (verts[x][k] + verts[y][k] + verts[z][k]) / 3);
  return dot(cross(sub(verts[y], verts[x]), sub(verts[z], verts[x])), gradient(f, c, cell * 0.25)) <= 0;
});
checks.flipped_tris = flipped.length;
checks.flipped_by_region = flipped.reduce((m, ti) => ({ ...m, [tpl.regions[ti]]: (m[tpl.regions[ti]] ?? 0) + 1 }), {});
// Regioner och sockets
const rc = regionChecks(tpl.regions, tris);
checks.regions = { empty: rc.empty, islands: rc.islands, missing_seams: rc.missing_seams, extra_contacts: rc.extra_contacts };
checks.sockets_outside = ['socket_hand_L', 'socket_hand_R', 'socket_head'].filter((s) => f(sk.sockets[s].pos) >= 0);
checks.ok = checks.feet_on_ground && checks.symmetry > 0.99 && checks.components === 1
  && Math.abs(checks.heads_measured - checks.heads_target) <= (a.hunch ? 0.6 : 0.25) && checks.within_budget
  && checks.fit_error_mm < 2 && checks.flipped_tris <= tris.length * 0.002
  && !rc.empty.length && !rc.islands.length && !rc.missing_seams.length && !checks.sockets_outside.length;

// glTF: skelettet som nodhierarki (bara translation i bindpose), sockets under sina ben, en meshnod per region
const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const name = recipe.name ?? `${archetype}_${seed}`;
const root = doc.createNode(name);
const nodes = {};
for (const [bone, par] of BONES) {
  const p = sk.joints[bone], pp = par ? sk.joints[par] : [0, 0, 0];
  nodes[bone] = doc.createNode(bone).setTranslation(sub(p, pp));
  (par ? nodes[par] : root).addChild(nodes[bone]);
}
for (const [sname, s] of Object.entries(sk.sockets)) {
  nodes[s.parent].addChild(doc.createNode(sname).setTranslation(sub(s.pos, sk.joints[s.parent])).setRotation(quatFromAxes(s.axes)));
}
const skinMat = doc.createMaterial('Skin').setRoughnessFactor(style.character.materials.skin.roughness).setMetallicFactor(0);
for (const r of REGIONS) {
  const local = new Map(), idx = [];
  tris.forEach((t, ti) => { if (tpl.regions[ti] !== r) return; for (const v of t) { if (!local.has(v)) local.set(v, local.size); idx.push(local.get(v)); } });
  const vs = [...local.keys()];
  const col = regionColor(r);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', Float32Array.from(vs.flatMap((v) => verts[v]))))
    .setAttribute('NORMAL', acc('VEC3', Float32Array.from(vs.flatMap((v) => normals[v]))))
    .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(vs.flatMap(() => col))))
    .setIndices(acc('SCALAR', Uint32Array.from(idx)))
    .setMaterial(skinMat);
  root.addChild(doc.createNode(`body_${r}`).setMesh(doc.createMesh(`body_${r}`).addPrimitive(prim)));
}
root.setExtras({ archetype, race, template: refName, seed, heads: sk.heads, height: sk.H, regions: rc.tris_per_region });
doc.createScene(name).addChild(root);
await writeGltf(doc, recipe.out);

console.log(JSON.stringify({ name, out: recipe.out, archetype, race, seed, tris: tris.length, verts: verts.length, prims: prims.length, cell: +cell.toFixed(4), colors, checks }));
