// Trädgenerator v3: art (species.json) -> skelett -> bark + lövverk fäst i skelettet -> kontroller -> GLB.
// Allt växer ur samma skelett, så delarna sitter alltid ihop. Ingen Blender och ingen Three.js behövs.
// Användning: node gen_tree.mjs '{"preset":"oak_medium","seed":42,"height":9,"out":"x.gltf","bark":"b.png","leaves":"atlas.png"}'
import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { sharedTexture, writeGltf } from './gltf_write.mjs';
import { buildSkeleton, scaleSkeleton, validateSkeleton } from './skeleton.mjs';
import { barkMesh } from './bark_mesh.mjs';
import { buildCanopy } from './canopy.mjs';
import { buildConiferFoliage } from './conifer.mjs';
import { buildCrown } from './crown.mjs';
import { buildLeafDome } from './leafdome.mjs';
import { buildCardBalls } from './cardball.mjs';

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
const barkRepeat = recipe.barkRepeat ?? 1.08; // meter per texturupprepning
const barkLods = [
  { maxLevel: 9, segScale: 1 },
  { maxLevel: Math.max(1, sk.maxLevel - 1), segScale: 0.7 },
  { maxLevel: 1, segScale: 0.5 },
].map((l) => barkMesh(sk, {
  ...l, barkRepeat, flare: sp.trunk.flare, roots: sp.trunk.roots, rootAmp: sp.trunk.rootAmp, flareHeight: sp.trunk.flareHeight, height,
  lobes: sp.trunk.lobes, lobeAmp: sp.trunk.lobeAmp, twist: sp.trunk.twist, bulge: sp.trunk.bulge,
  // Gran: barrgrenen ÄR grenen, så bara stammen får bark (annars sticker kala grenar ut ur barren)
  // stemless (bollbuskar): skelettet styr var bullarna sitter, men ingen bark renderas
  maxLevel: sp.stemless ? -1 : fronds ? 0 : l.maxLevel,
  // barkTip (kortbollar m.fl.): barken tonas mot lövfärgen ytterst på smågrenarna, så att stumpar smälter in
  tipTint: (recipe.canopy?.barkTip ?? sp.foliage.barkTip) && recipe.leafTint ? (() => { const c = lin(recipe.leafTint), m = Math.max(...c); return c.map((x) => x / m); })() : null,
  tipFrom: (recipe.canopy?.barkTip ?? sp.foliage.barkTip)?.from ?? 0.4, tipLevel: (recipe.canopy?.barkTip ?? sp.foliage.barkTip)?.level ?? 2,
  topCut: sp.foliage.topCut ?? (fronds ? 0.9 : 0),
  sinkDepth: Math.max(0.3, height * (sp.trunk.sinkDepth ?? 0.12)), // stammen går ner under marken
}));

// 3. Lövverk, fäst i skelettet
let foliage;
if (fronds) {
  const pal = STYLE.palette;
  foliage = buildConiferFoliage(sk, {
    seed: seedEff, height, normalBlend: 0.5, ...sp.foliage, ...(recipe.conifer ?? {}),
    textured: !!recipe.frondTexture,
    // Paletten kan väljas per art (palm: lövträdens grönt), standard är granens
    palette: Object.fromEntries(Object.entries({ light: 'conifer_light', mid: 'conifer_mid', dark: 'conifer_dark', ...(sp.foliage.palette ?? {}) })
      .map(([k, v]) => [k, lin(pal[v])])),
  });
  checks.fronds_attached = foliage.fronds; // varje barrgren följer en riktig gren
} else if (sp.foliage.type === 'leafdome') {
  // Bladkupol: solida, facetterade blad i ringar. leafTint ger en egen palett (mörk/mellan/ljus av tinten)
  const pal = STYLE.palette;
  const names = { dark: 'foliage_shadow', mid: 'foliage_mid', light: 'foliage_light', ...(sp.foliage.palette ?? {}) };
  const palette = recipe.leafTint
    ? (() => { const c = lin(recipe.leafTint); return { dark: c.map((x) => x * 0.38), mid: c.map((x) => x * 0.7), light: c.map((x) => Math.min(1, x * 1.1 + 0.03)) }; })()
    : Object.fromEntries(Object.entries(names).map(([k, v]) => [k, lin(pal[v])]));
  foliage = buildLeafDome({ ...sp.foliage, ...(recipe.canopy ?? {}), seed: seedEff, height, palette });
  foliage.clusters = [];
  checks.leaves = foliage.leaves;
} else if (sp.foliage.type === 'none') {
  // Kala träd (döda träd): bara stam och grenar
  const none = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], cluster: [], indices: [] });
  foliage = { lods: [none(), none(), none()], clusters: [] };
} else if (sp.foliage.type === 'cardball') {
  // Kortbollar: 6–9 korsade lövkort per boll, bollarna på skelettets kvistar
  // Grenspetsar (punkt och riktning) för spetsbollar
  const tips = sk.branches.filter((b) => b.level >= 1).map((b) => {
    const n = b.nodes, p = n[n.length - 1].p, q = n[Math.max(0, n.length - 2)].p;
    const d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]], l = Math.hypot(...d) || 1;
    return { p, d: d.map((x) => x / l) };
  });
  foliage = buildCardBalls(sk.twigs, { ...sp.foliage, ...(recipe.canopy ?? {}), seed: seedEff, height, tips });
  checks.tip_balls = foliage.tipBalls;
  checks.clusters = foliage.clusters.length;
  checks.cards = foliage.cards;
  checks.ball_radius_m = foliage.ballM;
  checks.card_m = foliage.cardM;
  // Andel av grenarnas punkter (ej stammen) som ligger inne i någon boll: lågt värde = grenar syns mellan bollarna
  const limbs = sk.branches.filter((b) => b.level > 0).flatMap((b) => b.nodes.map((n) => n.p));
  checks.branch_cover = Math.round(100 * limbs.filter((p) => foliage.clusters.some((c) => Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]) <= c.radii[0])).length / Math.max(1, limbs.length)) / 100;
  checks.silhouette_m2 = foliage.silhouetteM2; // kronans yta sedd framifrån: jämför hur fyllig den blir
  checks.crown_m = foliage.crownM;
  // Bollar måste sitta på en kvist; spetsbollar på den grenspets de täcker
  const near = (pts, c) => pts.some((p) => Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]) <= 0.36 * c.radii[0]);
  checks.floating_clusters = foliage.clusters.filter((c) => !near(c.tip ? tips.map((t) => t.p) : sk.twigs, c)).length;
  checks.uncovered_twigs = foliage.uncovered;
} else if (sp.foliage.type === 'crown') {
  // v4: sammanslagen molnlik kronmassa + täta små lövkort
  const opts = { ...sp.foliage, cards: Math.round(sp.foliage.cards * (size.cards ?? 1)), ...(recipe.canopy ?? {}), seed: seedEff, height };
  foliage = buildCrown(sk.twigs, opts);
  checks.clusters = foliage.clusters.length;
  checks.floating_cards = foliage.floatingCards; // lövkort vars rot inte sitter i volymen eller på en stjälk
  // Klumpar måste sitta på en kvist; puffar måste sitta inne i sin föräldraklump
  const inside = (p, c, f) => [0, 1, 2].reduce((s, a) => s + ((p[a] - c.center[a]) / (c.radii[a] * f)) ** 2, 0) <= 1;
  checks.floating_clusters = foliage.clusters.filter((c) => {
    if (c.parent !== undefined) return !inside(c.center, foliage.clusters[c.parent], 1);
    const meanR = (c.radii[0] + c.radii[1] + c.radii[2]) / 3;
    return !sk.twigs.some((p) => Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]) <= 0.31 * meanR);
  }).length;
  // Kala grenar: kvistar som inte ligger inne i någon klump
  checks.uncovered_twigs = sk.twigs.filter((p) => !foliage.clusters.some((c) => inside(p, c, 1))).length;
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
// Stamlösa buskar: sänk hela formen så att den vilar på marken (lite nedsänkt så att den inte svävar)
if (sp.stemless) {
  let minY = Infinity;
  for (const lod of foliage.lods) for (const g of [lod, lod.volume].filter(Boolean)) for (let i = 1; i < g.positions.length; i += 3) minY = Math.min(minY, g.positions[i]);
  const dy = -minY - height * (sp.sink ?? 0.05);
  for (const lod of foliage.lods) for (const g of [lod, lod.volume].filter(Boolean)) for (let i = 1; i < g.positions.length; i += 3) g.positions[i] += dy;
  checks.resting_on_ground = true;
}
checks.ok = checks.disconnected === 0 && checks.thicker_than_parent === 0 && checks.nodes_below_ground === 0 && !checks.floating_clusters && !checks.uncovered_twigs && !checks.floating_cards;

// 4. GLB
const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
// Texturer refereras till delade filer (bäddas inte in), se gltf_write.mjs
const texture = (file, name) => sharedTexture(doc, file, name, out);

const barkMat = doc.createMaterial('Bark').setBaseColorTexture(texture(bark, 'bark')).setRoughnessFactor(0.9).setMetallicFactor(0);
// barkTint (björk, palm, dött träd): barken är då gråskala och färgas här
if (recipe.barkTint) barkMat.setBaseColorFactor([...lin(recipe.barkTint), 1]);
let leafMat;
if (fronds && recipe.frondTexture) {
  // Målad barrtextur (gråskala) med alfa bara i kanten: solid kärna, spretiga barr i silhuetten
  leafMat = doc.createMaterial('Fronds').setBaseColorTexture(texture(recipe.frondTexture, 'fronds'))
    .setRoughnessFactor(0.85).setMetallicFactor(0).setAlphaMode('MASK').setAlphaCutoff(0.45);
} else if (sp.foliage.type === 'leafdome' && leaves && fs.existsSync(leaves)) {
  // Bladkupol med målad bladyta (gråskala): formen kommer från geometrin, färgen från paletten (vertexfärg)
  leafMat = doc.createMaterial('Leaves').setBaseColorTexture(texture(leaves, 'leaf_surface')).setRoughnessFactor(0.8).setMetallicFactor(0);
} else if (fronds || sp.foliage.type === 'leafdome') {
  leafMat = doc.createMaterial(fronds ? 'Fronds' : 'Leaves').setRoughnessFactor(0.85).setMetallicFactor(0);
} else {
  leafMat = doc.createMaterial('Leaves').setBaseColorTexture(texture(leaves, 'leaves'))
    .setRoughnessFactor(0.85).setMetallicFactor(0).setAlphaMode('MASK').setAlphaCutoff(0.45).setDoubleSided(false);
}
// leafTint: färgen som materialparameter (gråskaletexturer), som Material Instances
const tint = recipe.leafTint && lin(recipe.leafTint);
if (tint && sp.foliage.type !== 'leafdome') leafMat.setBaseColorFactor([...tint, 1]);
// v4-kronans massa har bara vertexfärg (projicerad textur ger ränder på sidorna); äldre kronor har lövmassa
// Kronmassan: målad lövmassa (lådprojicerad i crown.mjs, tintad som löven), annars bara vertexfärg
const massMat = !fronds && (leafMass
  ? doc.createMaterial('LeafMass').setBaseColorTexture(texture(leafMass, 'leaf_mass')).setRoughnessFactor(0.9).setMetallicFactor(0)
  : doc.createMaterial('LeafMass').setRoughnessFactor(0.9).setMetallicFactor(0));
if (tint && massMat) massMat.setBaseColorFactor([...tint, 1]);


// Skuggroller i materialens extras, så att klienten (och andra motorer) vet vad som ska kasta skugga.
// Kortbollar: korten kastar och tar inte emot skugga (skärningarna syns annars direkt); djupet i kronan
// fejkas med kronnormaler och vertexfärg, och en osynlig skuggform kastar kronans skugga.
const shadowMat = sp.foliage.type === 'cardball' ? doc.createMaterial('ShadowProxy').setExtras({ shadowProxy: true }) : null;
if (shadowMat) leafMat.setExtras({ ...leafMat.getExtras(), castShadow: false, receiveShadow: false });

// Vindkontinuitet: hörn i samma punkt måste ha samma vindvikt, annars slits geometrin isär i vinden
function windTorn(g) {
  const seen = new Map(); let torn = 0;
  for (let i = 0; i < g.positions.length / 3; i++) {
    const key = `${Math.round(g.positions[i * 3] * 1e4)},${Math.round(g.positions[i * 3 + 1] * 1e4)},${Math.round(g.positions[i * 3 + 2] * 1e4)}`;
    const w = g.wind[i] ?? 0;
    if (seen.has(key)) { if (Math.abs(seen.get(key) - w) > 1e-4) torn++; } else seen.set(key, w);
  }
  return torn;
}
let WIND_TORN = 0;

function mesh(name, g, mat, extra = {}) {
  if (/LOD0/.test(name)) WIND_TORN += windTorn(g);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', Float32Array.from(g.positions)))
    .setAttribute('NORMAL', acc('VEC3', Float32Array.from(g.normals)))
    .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(g.uvs)))
    .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(g.colors)))
    .setAttribute('_WIND', acc('SCALAR', Float32Array.from(g.wind)))
    .setIndices(acc('SCALAR', Uint32Array.from(g.indices)))
    .setMaterial(mat);
  for (const [k, v] of Object.entries(extra)) prim.setAttribute(k, acc('SCALAR', Float32Array.from(v)));
  // Vinddata i vertexfärg enligt stilguidens konvention, läsbar direkt i Unreal/Godot/Unity:
  // R = höjd över marken, G = rörlighet (avstånd från gren-pivot), B = slumpmässig fas per kluster
  const nV = g.positions.length / 3, wc = new Float32Array(nV * 4);
  const cl = extra._CLUSTER;
  for (let i = 0; i < nV; i++) {
    const phase = cl ? ((Math.sin((cl[i] + 1) * 12.9898) * 43758.5453) % 1 + 1) % 1 : 0.5;
    wc.set([Math.min(1, Math.max(0, g.positions[i * 3 + 1] / height)), g.wind[i], phase, 1], i * 4);
  }
  prim.setAttribute('COLOR_1', acc('VEC4', wc));
  return doc.createMesh(name).addPrimitive(prim);
}

const name = recipe.name ?? path.basename(out, path.extname(out));
const root = doc.createNode(name).setExtras({ generator: 'tinkertown/tree@3', recipe: { preset, seed, height, kind } });
const tris = [], alphaTris = [];
let stemMat;
foliage.lods.forEach((lod, i) => {
  const lodNode = doc.createNode(`${name}_LOD${i}`).setExtras({ lod: i });
  if (barkLods[i].indices.length) lodNode.addChild(doc.createNode(`${name}_trunk_LOD${i}`).setMesh(mesh(`bark_LOD${i}`, barkLods[i], barkMat)));
  if (lod.indices.length) lodNode.addChild(doc.createNode(`${name}_leaves_LOD${i}`).setMesh(mesh(`leaves_LOD${i}`, lod, leafMat, { _CLUSTER: lod.cluster })));
  let volTris = 0;
  if (lod.volume && massMat) {
    lodNode.addChild(doc.createNode(`${name}_volume_LOD${i}`).setMesh(mesh(`volume_LOD${i}`, lod.volume, massMat, { _CLUSTER: lod.volume.cluster })));
    volTris = lod.volume.indices.length / 3;
  }
  if (lod.stems?.indices.length) {
    // Hängande stänglar (pil): tunna gröngrå rankor som löven sitter på
    stemMat ??= doc.createMaterial('Stems').setRoughnessFactor(0.9).setMetallicFactor(0);
    lodNode.addChild(doc.createNode(`${name}_stems_LOD${i}`).setMesh(mesh(`stems_LOD${i}`, lod.stems, stemMat)));
  }
  // Skuggform (kortbollar): kastar skugga men ritas inte (materialets extras.shadowProxy, läses av klienten)
  if (lod.shadow?.indices.length) lodNode.addChild(doc.createNode(`${name}_shadow_LOD${i}`).setMesh(mesh(`shadow_LOD${i}`, lod.shadow, shadowMat)));
  root.addChild(lodNode);
  tris.push(Math.round((barkLods[i].indices.length + lod.indices.length) / 3 + volTris));
  alphaTris.push((fronds && !recipe.frondTexture) || sp.foliage.type === 'leafdome' ? 0 : lod.indices.length / 3); // det som kostar overdraw
});
doc.createScene(name).addChild(root);
checks.wind_torn = WIND_TORN;
checks.ok = checks.ok && WIND_TORN === 0;
await writeGltf(doc, out);

// Kort svar, avsett för en AI-agent
console.log(JSON.stringify({
  model: out, species: spName, kind, height_m: height, tris_lod: tris, alpha_tris_lod: alphaTris,
  bark_tris_lod: barkLods.map((b) => b.indices.length / 3), checks,
}));
