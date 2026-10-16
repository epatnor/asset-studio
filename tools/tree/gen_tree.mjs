// Headless ez-tree generator: tar ett litet JSON-recept, skriver branches.obj + leaves.obj med UV.
// Användning: node gen_tree.mjs '{"preset":"oak_medium","seed":42,"out":"out/oak42"}'
import fs from 'node:fs';
import path from 'node:path';

// ez-tree laddar texturer via THREE.TextureLoader vid import; i Node finns ingen DOM,
// så vi ger den en tom <img>-stub. Texturerna används inte, bara geometrin.
globalThis.document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }),
};
globalThis.window = globalThis;

const { Tree, TreePreset } = await import('@dgreenheck/ez-tree');
const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');

const recipe = JSON.parse(process.argv[2] ?? '{}');
const { preset = 'oak_medium', seed = 0, out = 'out/tree', options = {} } = recipe;

// ez-tree nycklar presets som "Oak Medium" och faller tyst tillbaka på standardträdet
// vid okänt namn, så översätt oak_medium -> "Oak Medium" och kräv träff
const presetKey = preset.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
if (!TreePreset[presetKey]) {
  console.error(`unknown preset ${preset}; available: ${Object.keys(TreePreset).join(', ')}`);
  process.exit(1);
}

const tree = new Tree();
tree.loadPreset(presetKey);

// Djup-merge av överstyrningar ovanpå presetet
const merge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) merge((dst[k] ??= {}), v);
    else dst[k] = v;
  }
};
merge(tree.options, options);
tree.options.seed = seed;
tree.generate();

fs.mkdirSync(out, { recursive: true });
const exporter = new OBJExporter();
const parts = { branches: tree.branchesMesh, leaves: tree.leavesMesh };
const summary = { preset, seed, out };

for (const [name, mesh] of Object.entries(parts)) {
  mesh.name = name;
  fs.writeFileSync(path.join(out, `${name}.obj`), exporter.parse(mesh));
  const g = mesh.geometry;
  summary[name] = {
    vertices: g.attributes.position.count,
    triangles: (g.index ? g.index.count : g.attributes.position.count) / 3,
    hasUV: !!g.attributes.uv,
  };
}

const box = new (await import('three')).Box3().setFromObject(tree);
summary.heightM = +(box.max.y - box.min.y).toFixed(2);
fs.writeFileSync(path.join(out, 'recipe.json'), JSON.stringify({ ...recipe, resolvedOptions: tree.options }, null, 2));
// Kort svar, avsett för en AI-agent
console.log(JSON.stringify(summary));
