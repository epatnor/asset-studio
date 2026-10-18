// Kropp ur MakeHumans hm08 (hm08.mjs) med outfit (outfit.mjs): recept in, glTF ut, en rad JSON med kontroller.
//
//   node gen_hm08.mjs '{"name":"hero","out":"/abs/hero.gltf","macro":{"gender":1,"age":0.5,"muscle":0.8,"weight":0.55,"height":0.6,"proportions":1},
//                       "kit":true,"outfit":{"top":{"part":"tunic","color":"#3F5443","trim":"#D9A423"},"legs":"trousers"}}'
//
// Receptfält: macro (gender 1 = man, age 0,5 = 25 år, muscle, weight, height, proportions; 0–1, 0,5 = medel),
// ethnic ({african, asian, caucasian}, summa 1), skin (#RRGGBB),
// kit (true: ytan delas per byggsatsplats enligt hm08_kit.json, en nod per plats; false: en kroppsmesh),
// outfit ({namn: del i parts.json, eller {part, color, trim}}; kräver kit), explode (dra isär platserna),
// stylize (överstyr style.json character.stylize, false = realistisk hm08), face (MakeHuman-targets för ansiktet,
// läggs till style.json character.face; false = inget förval), debug ("parts": en färg per plats), poses (true: posetest i testposerna, se posetest.mjs),
// posed_out (mapp: skriv varje pose som en statisk glTF för förhandsbilder), eyes (irisfärg, false = inga ögon),
// only ([platser]: skriv bara dessa, t.ex. ["head", "eye_L", "eye_R"] för närbilder),
// hair ({style: frisyr i hair.json, color}: hårfäste plus slingor, kräver kit), seed.
import fs from 'node:fs';
import { Document } from '@gltf-transform/core';
import { writeGltf, sharedTexture } from '../tree/gltf_write.mjs';
import { KHRMaterialsAnisotropy } from '@gltf-transform/extensions';
import path from 'node:path';
import { sub, add, cross, dot, norm } from '../tree/vec.mjs';
import { BONES } from './skeleton.mjs';
import { buildHm08 } from './hm08.mjs';
import { buildOutfit } from './outfit.mjs';
import { buildEyes } from './face.mjs';
import { buildHair } from './hair.mjs';
import { hm08Weights } from './skin.mjs';
import { runPoseTest } from './posetest.mjs';

const recipe = JSON.parse(process.argv[2] ?? '{}');
const style = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
// Stilisering: style.json character.stylize blandad efter kön, eller recipe.stylize (false = ingen)
const st = style.character.stylize, g = recipe.macro?.gender ?? 0.5;
const stylize = recipe.stylize === false ? null : { ...Object.fromEntries(Object.keys(st.male).map((k) => [k, st.female[k] + (st.male[k] - st.female[k]) * g])), ...(recipe.stylize ?? {}) };
// Ansiktsförval: style.json character.face blandad efter kön, plus recipe.face (false = inget)
const fc = style.character.face;
const face = recipe.face === false ? {} : { ...Object.fromEntries([...new Set([...Object.keys(fc.male), ...Object.keys(fc.female)])]
  .map((k) => [k, (fc.female[k] ?? 0) + ((fc.male[k] ?? 0) - (fc.female[k] ?? 0)) * g])), ...(recipe.face ?? {}) };
const body = buildHm08(recipe.macro ?? {}, recipe.ethnic, stylize, face);
const { verts, quads, joints: J } = body;

// Quads till trianglar längs den kortare diagonalen (två per quad i ordning); hm08:s quads pekar utåt
const tris = [];
for (const [a, b, c, d] of quads) {
  const ac = sub(verts[c], verts[a]), bd = sub(verts[d], verts[b]);
  if (dot(ac, ac) <= dot(bd, bd)) tris.push([a, b, c], [a, c, d]); else tris.push([a, b, d], [b, c, d]);
}
const triNormals = (P, T) => {
  const n = P.map(() => [0, 0, 0]);
  for (const [a, b, c] of T) { const f = cross(sub(P[b], P[a]), sub(P[c], P[a])); for (const i of [a, b, c]) n[i] = add(n[i], f); }
  return n.map(norm);
};
const normals = triNormals(verts, tris);

// Kontroller för kroppen
const checks = {};
const ys = verts.map((p) => p[1]);
checks.missing_targets = body.missing.length;
checks.targets = body.targets;
checks.height = +Math.max(...ys).toFixed(3);
// Hakan: i profilen längs mittlinjen hoppar framkanten från halsen ut till hakan. Hakans underkant är den
// lägsta punkten som ligger längre fram än mitten mellan halsens framkant och hm08:s Jaw-led (vid hakspetsen).
const midline = verts.filter((p) => Math.abs(p[0]) < 0.02 && p[2] > J.Neck[2]);
const throatZ = Math.max(...midline.filter((p) => Math.abs(p[1] - J.Neck[1]) < 0.01).map((p) => p[2]));
const chin = Math.min(...midline.filter((p) => p[1] > J.Neck[1] && p[2] > (throatZ + J.Jaw[2]) / 2).map((p) => p[1]));
checks.heads_measured = +(checks.height / (checks.height - chin)).toFixed(2);
const keys = new Set(verts.map((p) => p.map((v) => Math.round(v * 1000)).join(',')));
checks.symmetry = +(verts.filter((p) => {
  const [x, y, z] = p.map((v) => Math.round(v * 1000));
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (keys.has(`${-x + dx},${y + dy},${z + dz}`)) return true;
  return false;
}).length / verts.length).toFixed(4);
checks.joint_order = J.Head[1] > J.Neck[1] && J.Neck[1] > J.Chest[1] && J.Chest[1] > J.Spine[1] && J.Spine[1] > J.Hips[1]
  && J.Hips[1] > J.LeftLowerLeg[1] && J.LeftLowerLeg[1] > J.LeftFoot[1] && J.LeftUpperArm[0] > 0 && J.LeftHand[0] > J.LeftLowerArm[0];
const [bmin, bmax] = style.budgets_tris.character;
checks.ok = !checks.missing_targets && checks.symmetry > 0.99 && checks.joint_order;

// Ytan: hela kroppen som en mesh, eller per byggsatsplats med outfit
const skinHex = recipe.skin ?? '#E9B48A';
const linear = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
let meshes;
if (recipe.kit) {
  const kitData = JSON.parse(fs.readFileSync(new URL('./hm08_kit.json', import.meta.url)));
  const lib = JSON.parse(fs.readFileSync(new URL('./parts.json', import.meta.url)));
  const items = Object.entries(recipe.outfit ?? {}).map(([, e]) => {
    const o = typeof e === 'string' ? { part: e } : e;
    if (!lib[o.part]) throw new Error(`okänd del ${o.part}`);
    return { name: o.part, spec: lib[o.part], color: o.color ?? '#3F5443', trim: o.trim ?? '#D9A423' };
  });
  // Hår: hårfästet (tunt, mörkare lager med frisyrens hårlinje) under hårgeneratorns slingor
  if (recipe.hair) {
    const hs = JSON.parse(fs.readFileSync(new URL('./hair.json', import.meta.url)))[recipe.hair.style];
    if (!hs) throw new Error(`okänd frisyr ${recipe.hair.style}`);
    const dark = '#' + [1, 3, 5].map((i) => Math.round(parseInt(recipe.hair.color.slice(i, i + 2), 16) * hs.cap.darken).toString(16).padStart(2, '0')).join('');
    items.push({ name: 'hair_cap', spec: { ...lib.hair_cap, thickness: hs.cap.thickness, boost: hs.cap.boost, smooth: hs.cap.smooth ?? lib.hair_cap.smooth, texture: hs.texture, texScale: hs.texScale, cover: [{ scalp: hs.scalp }] }, color: dark, trim: dark });
  }
  const r = buildOutfit({ verts, normals, quads, tris, joints: J, cubes: body.cubes, eyes: body.eyes }, kitData, items, { skin: skinHex });
  meshes = r.meshes;
  checks.outfit = r.checks;
  checks.ok = checks.ok && r.checks.shell_inside === 0;
} else {
  meshes = [{ slot: 'body', material: 'skin', kind: 'skin', pos: verts, nrm: normals, col: verts.map(() => linear(skinHex)), src: verts.map((_, i) => [[i, 1]]), key: verts.map((_, i) => `-1,${i}`), tris, strip: tris.map(() => false) }];
}
// Håret: slingor som kolliderar mot hud och kläder
if (recipe.hair && recipe.kit) {
  const hs = JSON.parse(fs.readFileSync(new URL('./hair.json', import.meta.url)))[recipe.hair.style];
  const kitData = JSON.parse(fs.readFileSync(new URL('./hm08_kit.json', import.meta.url)));
  const headTris = kitData.parts.head.flatMap((f) => [2 * f, 2 * f + 1]);
  const surf = meshes.filter((m) => m.kind === 'skin' || m.kind === 'cloth');
  const collide = { points: surf.flatMap((m) => m.pos), normals: surf.flatMap((m) => m.nrm) };
  const hair = buildHair({ verts, normals, tris, joints: J, eyes: body.eyes }, headTris, collide, hs, recipe.hair.color, recipe.seed ?? 1);
  checks.hair = hair.stats;
  meshes.push(hair);
}
// Ögonen (egna meshar som följer huvudet)
if (recipe.eyes !== false) meshes.push(...buildEyes({ verts, eyes: body.eyes }, { iris: recipe.eyes ?? '#4C7A9E' }));
checks.tris = meshes.reduce((s, m) => s + m.tris.length, 0);
checks.within_budget = checks.tris >= bmin * 0.8 && checks.tris <= bmax;
checks.ok = checks.ok && checks.within_budget;

// glTF: skelettnoder med våra namn och en nod per plats (med en primitiv per material)
async function writeDoc(out, P, N) {
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
  const mats = {};
  const aniso = doc.createExtension(KHRMaterialsAnisotropy);
  // Material per (material, textur). Håret får strängtexturen och anisotrop glans längs strängarna (V-led).
  const matOf = (m, tex) => (mats[`${m}|${tex ?? ''}`] ??= (() => {
    const mat = doc.createMaterial(m[0].toUpperCase() + m.slice(1))
      .setRoughnessFactor((style.character.materials[m] ?? style.character.materials.cloth).roughness)
      .setMetallicFactor(style.character.materials[m]?.metalness ?? 0);
    if (tex) {
      const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), `../../assets/textures/${tex}.png`);
      mat.setBaseColorTexture(sharedTexture(doc, file, tex, out));
      if (m === 'hair') mat.setExtension('KHR_materials_anisotropy', aniso.createAnisotropy().setAnisotropyStrength(0.6).setAnisotropyRotation(Math.PI / 2));
    }
    return mat;
  })());
  const DEBUG = ['#E6B8A2', '#4F7BE0', '#3F5443', '#D9A423', '#B3263A', '#5FD3C8', '#9B6BE0', '#E07A1F', '#2FA866', '#C9C2B5', '#6B4A2E', '#F2A23A', '#3E859C', '#8A4FD8', '#7FAE4A'];
  const slots = [...new Set(meshes.map((m) => m.slot))].filter((sl) => !recipe.only || recipe.only.includes(sl));
  const lo = [0, 1, 2].map((k) => Math.min(...verts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...verts.map((p) => p[k])));
  for (const slot of slots) {
    const mesh = doc.createMesh(`body_${slot}`);
    let c = [0, 0, 0], n = 0;
    meshes.forEach((m, mi) => {
      if (m.slot !== slot || !m.tris.length) return;
      const col = recipe.debug === 'parts' && m.kind === 'skin' ? m.pos.map(() => linear(DEBUG[slots.indexOf(slot) % DEBUG.length])) : m.col;
      const prim = doc.createPrimitive()
        .setAttribute('POSITION', acc('VEC3', Float32Array.from(P[mi].flat())))
        .setAttribute('NORMAL', acc('VEC3', Float32Array.from(N[mi].flat())))
        .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(col.flat())))
        .setIndices(acc('SCALAR', Uint32Array.from(m.tris.flat())))
        .setMaterial(matOf(m.material, m.texture));
      if (m.uv) prim.setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(m.uv.flat())));
      mesh.addPrimitive(prim);
      for (const p of P[mi]) { c = add(c, p); n++; }
    });
    const node = doc.createNode(`body_${slot}`).setMesh(mesh);
    // Isärdragning i x och y; allt lyfts så att den lägsta delen står kvar på marken
    if (recipe.explode && n) { c = c.map((x) => x / n); node.setTranslation([(c[0] - (lo[0] + hi[0]) / 2) * recipe.explode, (c[1] - lo[1]) * recipe.explode, 0]); }
    root.addChild(node);
  }
  root.setExtras({ source: 'makehuman hm08 (CC0)', macro: recipe.macro, outfit: recipe.outfit ?? null, joints: J });
  doc.createScene(name).addChild(root);
  await writeGltf(doc, out);
}
await writeDoc(recipe.out, meshes.map((m) => m.pos), meshes.map((m) => m.nrm));

// Posetest: ytan skinnad med hm08:s vikter i testposerna
if (recipe.poses) {
  const weights = hm08Weights(body.sourceIndex);
  const { results, posed } = runPoseTest({ verts, tris, weights }, meshes, J);
  checks.poses = results;
  checks.ok = checks.ok && Object.values(results).every((r) => r.seam_gap_mm < 0.01 && r.collapsed <= 0.02);
  if (recipe.posed_out) {
    fs.mkdirSync(recipe.posed_out, { recursive: true });
    for (const [pname, P] of Object.entries(posed)) {
      await writeDoc(`${recipe.posed_out}/${recipe.name ?? 'hm08'}_${pname}.gltf`, P, P.map((pp, mi) => triNormals(pp, meshes[mi].tris)));
    }
  }
}

console.log(JSON.stringify({ name: recipe.name, out: recipe.out, verts: verts.length, checks }));
