// Import av färdiga modeller: gör en GLB/glTF (från Sketchfab, Kenney, egna) kompatibel med Azshara Asset Studio.
// Recept in, glTF ut, en rad JSON som svar.
//   node import_model.mjs '{"name":"bench","source":"x.glb","out":"assets/imported/bench/bench.gltf","height":0.9}'
//
// Normalisering: meter (gissar centimeter och millimeter om inget anges), valfri höjd eller skala,
// centrerad i xz med pivot vid markkontakten (y = 0), dubbletter sammanslagna och oanvänt bortrensat.
// Komprimering som generatorernas: texturer till WebP med maxstorlek, geometri med meshopt.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { center, dedup, getBounds, prune, resample, textureCompress, weld } from '@gltf-transform/functions';
import { io, writeGltf } from '../tree/gltf_write.mjs';

const STYLE = JSON.parse(fs.readFileSync(new URL('../style.json', import.meta.url)));
const recipe = JSON.parse(process.argv[2] ?? '{}');
const { source, out, height, scale, maxTexture = 1024, category = 'prop_medium' } = recipe;
const name = recipe.name ?? path.basename(out, path.extname(out));

const doc = await (await io()).read(source);
const root = doc.getRoot(), scene = root.getDefaultScene() ?? root.listScenes()[0];
const size = (b) => b.max.map((v, i) => v - b.min[i]);
const s0 = size(getBounds(scene));

// Skala: angiven skala, angiven höjd, eller en gissning av enheten (modeller i cm är ofta 100 ggr för stora)
let factor = 1, unit = 'm';
if (scale) factor = scale;
else if (height) factor = height / (s0[1] || 1);
else if (Math.max(...s0) > 5000) { factor = 0.001; unit = 'mm'; }
else if (Math.max(...s0) > 200) { factor = 0.01; unit = 'cm'; }

// Allt under en rotnod med modellens namn, som får skalan; center() lägger sedan pivoten vid marken
const top = doc.createNode(name).setScale([factor, factor, factor]).setExtras({ generator: 'tinkertown/import@1', source: path.basename(source) });
for (const n of scene.listChildren()) { scene.removeChild(n); top.addChild(n); }
scene.addChild(top);
await doc.transform(
  center({ pivot: 'below' }),
  dedup(), weld(), resample(), prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [maxTexture, maxTexture], quality: 88 }),
);
for (const t of root.listTextures()) t.setURI(''); // låt skrivaren namnge bilderna efter modellen

// Kontroller
const b = getBounds(scene), dims = size(b);
let tris = 0, noNormals = 0, skinned = false;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
  const idx = p.getIndices(), pos = p.getAttribute('POSITION');
  tris += Math.floor((idx ? idx.getCount() : pos.getCount()) / 3);
  if (!p.getAttribute('NORMAL')) noNormals++;
  if (p.getAttribute('JOINTS_0')) skinned = true;
}
const budget = STYLE.budgets_tris[category] ?? STYLE.budgets_tris.prop_medium;
fs.mkdirSync(path.dirname(out), { recursive: true });
await writeGltf(doc, out, { images: true });
const checks = {
  resting_on_ground: Math.abs(b.min[1]) < 0.01,
  centered: Math.abs((b.min[0] + b.max[0]) / 2) < 0.01 && Math.abs((b.min[2] + b.max[2]) / 2) < 0.01,
  has_normals: noNormals === 0,
  within_budget: tris <= budget[1],
};
checks.ok = checks.resting_on_ground && checks.centered && checks.has_normals && tris > 0;
console.log(JSON.stringify({
  model: out, unit_guess: unit, scale: +factor.toFixed(5), size_m: dims.map((v) => +v.toFixed(3)), tris, budget,
  meshes: root.listMeshes().length, materials: root.listMaterials().length, textures: root.listTextures().length,
  animations: root.listAnimations().length, skinned, checks,
}));
