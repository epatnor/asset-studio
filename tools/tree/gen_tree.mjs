// Trädgenerator v3: art (species.json) -> skelett -> bark + lövverk fäst i skelettet -> kontroller -> GLB.
// Allt växer ur samma skelett, så delarna sitter alltid ihop. Ingen Blender och ingen Three.js behövs.
// Användning: node gen_tree.mjs '{"preset":"oak_medium","seed":42,"height":9,"out":"x.glb","bark":"b.png","leaves":"atlas.png"}'
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { buildSkeleton, scaleSkeleton, validateSkeleton } from './skeleton.mjs';
import { barkMesh } from './bark_mesh.mjs';
import { buildCanopy } from './canopy.mjs';
import { buildConiferFoliage } from './conifer.mjs';
import { buildCrown } from './crown.mjs';

const SPECIES = JSON.parse(fs.readFileSync(new URL('./species.json', import.meta.url)));
const STYLE = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
const lin = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2); // sRGB-hex -> linjärt

const recipe = JSON.parse(process.argv[2] ?? '{}');
const { preset = 'oak_medium', seed = 0, height = 9, out, bark, leaves, leafMass } = recipe;

// preset = <art>_<storlek> (oak_medium, pine_large, bush_2 ...); pine = gran
const [speciesKey, sizeKey = 'medium'] = preset.split('_');
const spName = SPECIES._presets[speciesKey];
if (!spName) {
  console.error(`unknown preset ${preset}; species: ${Object.keys(SPECIES._presets).join(', ')}`);
  process.exit(1);
}
// Receptets "species" överstyr artens parametrar (djup-merge), t.ex. {"levels": [{"count": [8, 10]}]}
const merge = (dst, src) => {
  for (const [k, v] of Object.entries(src ?? {})) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') v.forEach((x, i) => merge((dst[k][i] ??= {}), x));
    else if (v && typeof v === 'object' && !Array.isArray(v)) merge((dst[k] ??= {}), v);
    else dst[k] = v;
  }
  return dst;
};
const sp = merge(structuredClone(SPECIES[spName]), recipe.species);
const size = SPECIES._sizes[sizeKey] ?? SPECIES._sizes.medium;
const fronds = sp.foliage.type === 'fronds';
const kind = fronds ? 'conifer' : spName === 'bush' ? 'bush' : 'deciduous';
// bush_1, bush_2 ... är olika seeds av samma art
const seedEff = seed + (/^\d+$/.test(sizeKey) ? Number(sizeKey) * 1000 : 0);

// 1. Skelett, skalat till höjden (lövkronan sticker upp ovanför grenspetsarna, så lämna marginal)
const sk = buildSkeleton(sp, seedEff, size);
scaleSkeleton(sk, height, fronds ? 0 : 0.12);
const checks = validateSkeleton(sk);

// 2. Bark med riktig LOD: LOD1 utan yngsta grennivån, LOD2 bara stam och första nivån
const barkRepeat = recipe.barkRepeat ?? 1.2; // meter per texturupprepning
const barkLods = [
  { maxLevel: 9, segScale: 1 },
  { maxLevel: Math.max(1, sk.maxLevel - 1), segScale: 0.7 },
  { maxLevel: 1, segScale: 0.5 },
].map((l) => barkMesh(sk, {
  ...l, barkRepeat, flare: sp.trunk.flare, roots: sp.trunk.roots, rootAmp: sp.trunk.rootAmp, flareHeight: sp.trunk.flareHeight, height,
  // Gran: barrgrenen ÄR grenen, så bara stammen får bark (annars sticker kala grenar ut ur barren)
  maxLevel: fronds ? 0 : l.maxLevel,
}));

// 3. Lövverk, fäst i skelettet
let foliage;
if (fronds) {
  const pal = STYLE.palette;
  foliage = buildConiferFoliage(sk, {
    seed: seedEff, height, normalBlend: 0.5, ...sp.foliage, ...(recipe.conifer ?? {}),
    textured: !!recipe.frondTexture,
    palette: { light: lin(pal.conifer_light), mid: lin(pal.conifer_mid), dark: lin(pal.conifer_dark) },
  });
  checks.fronds_attached = foliage.fronds; // varje barrgren följer en riktig gren
} else if (sp.foliage.type === 'crown') {
  // v4: sammanslagen molnlik kronmassa + täta små lövkort
  const opts = { ...sp.foliage, cards: Math.round(sp.foliage.cards * (size.cards ?? 1)), ...(recipe.canopy ?? {}), seed: seedEff, height };
  foliage = buildCrown(sk.twigs, opts);
  checks.clusters = foliage.clusters.length;
  checks.floating_clusters = foliage.clusters.filter((c) => {
    const meanR = (c.radii[0] + c.radii[1] + c.radii[2]) / 3;
    return !sk.twigs.some((p) => Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]) <= 0.31 * meanR);
  }).length;
} else {
  const opts = { ...sp.foliage, cards: Math.round(sp.foliage.cards * (size.cards ?? 1)), ...(recipe.canopy ?? {}), seed: seedEff };
  if (!leafMass) opts.volume = false;
  foliage = buildCanopy(sk.twigs, opts);
  checks.clusters = foliage.clusters.length;
  // Strängt: närmaste kvist måste ligga nära klustrets centrum (inte bara någonstans i volymen)
  checks.floating_clusters = foliage.clusters.filter((c) => {
    const meanR = (c.radii[0] + c.radii[1] + c.radii[2]) / 3;
    return !sk.twigs.some((p) => Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]) <= 0.36 * meanR);
  }).length;
}
checks.ok = checks.disconnected === 0 && checks.thicker_than_parent === 0 && checks.nodes_below_ground === 0 && !checks.floating_clusters;

// 4. GLB
const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const texture = (file, name) => doc.createTexture(name).setImage(new Uint8Array(fs.readFileSync(file))).setMimeType('image/png');

const barkMat = doc.createMaterial('Bark').setBaseColorTexture(texture(bark, 'bark')).setRoughnessFactor(0.9).setMetallicFactor(0);
let leafMat;
if (fronds && recipe.frondTexture) {
  // Målad barrtextur (gråskala) med alfa bara i kanten: solid kärna, spretiga barr i silhuetten
  leafMat = doc.createMaterial('Fronds').setBaseColorTexture(texture(recipe.frondTexture, 'fronds'))
    .setRoughnessFactor(0.85).setMetallicFactor(0).setAlphaMode('MASK').setAlphaCutoff(0.45);
} else if (fronds) {
  leafMat = doc.createMaterial('Fronds').setRoughnessFactor(0.85).setMetallicFactor(0);
} else {
  leafMat = doc.createMaterial('Leaves').setBaseColorTexture(texture(leaves, 'leaves'))
    .setRoughnessFactor(0.85).setMetallicFactor(0).setAlphaMode('MASK').setAlphaCutoff(0.45).setDoubleSided(false);
}
// leafTint: färgen som materialparameter (gråskaletexturer), som Material Instances
const tint = recipe.leafTint && lin(recipe.leafTint);
if (tint) leafMat.setBaseColorFactor([...tint, 1]);
const massMat = !fronds && leafMass && doc.createMaterial('LeafMass').setBaseColorTexture(texture(leafMass, 'leaf_mass'))
  .setRoughnessFactor(0.9).setMetallicFactor(0);
if (tint && massMat) massMat.setBaseColorFactor([...tint, 1]);

function mesh(name, g, mat, extra = {}) {
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', Float32Array.from(g.positions)))
    .setAttribute('NORMAL', acc('VEC3', Float32Array.from(g.normals)))
    .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(g.uvs)))
    .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(g.colors)))
    .setAttribute('_WIND', acc('SCALAR', Float32Array.from(g.wind)))
    .setIndices(acc('SCALAR', Uint32Array.from(g.indices)))
    .setMaterial(mat);
  for (const [k, v] of Object.entries(extra)) prim.setAttribute(k, acc('SCALAR', Float32Array.from(v)));
  return doc.createMesh(name).addPrimitive(prim);
}

const name = recipe.name ?? path.basename(out, '.glb');
const root = doc.createNode(name).setExtras({ generator: 'tinkertown/tree@3', recipe: { preset, seed, height, kind } });
const tris = [], alphaTris = [];
foliage.lods.forEach((lod, i) => {
  const lodNode = doc.createNode(`${name}_LOD${i}`).setExtras({ lod: i });
  lodNode.addChild(doc.createNode(`${name}_trunk_LOD${i}`).setMesh(mesh(`bark_LOD${i}`, barkLods[i], barkMat)));
  lodNode.addChild(doc.createNode(`${name}_leaves_LOD${i}`).setMesh(mesh(`leaves_LOD${i}`, lod, leafMat, { _CLUSTER: lod.cluster })));
  let volTris = 0;
  if (lod.volume && massMat) {
    lodNode.addChild(doc.createNode(`${name}_volume_LOD${i}`).setMesh(mesh(`volume_LOD${i}`, lod.volume, massMat, { _CLUSTER: lod.volume.cluster })));
    volTris = lod.volume.indices.length / 3;
  }
  root.addChild(lodNode);
  tris.push(Math.round((barkLods[i].indices.length + lod.indices.length) / 3 + volTris));
  alphaTris.push(fronds && !recipe.frondTexture ? 0 : lod.indices.length / 3); // det som kostar overdraw
});
doc.createScene(name).addChild(root);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await new NodeIO().writeBinary(doc));

// Kort svar, avsett för en AI-agent
console.log(JSON.stringify({
  glb: out, species: spName, kind, height_m: height, tris_lod: tris, alpha_tris_lod: alphaTris,
  bark_tris_lod: barkLods.map((b) => b.indices.length / 3), checks,
}));
