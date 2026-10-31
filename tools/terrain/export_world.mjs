// Export av en sparad värld ur Kartrummet till rådata för en annan motor (först Godot-provet i ../godot-lab): marken,
// biomerna, de målade lagren, regionernas färgton, fukten och gräsets täthet, per hörn i samma rutnät som Kartrummet.
//
//   node tools/terrain/export_world.mjs '{"name": "my_island"}'                  → build/export/my_island/
//   node tools/terrain/export_world.mjs '{"name": "demo_isle", "out": "../godot-lab/worlds/demo_isle"}'
//
// Filerna (n × n hörn, rad för rad från −half, −half; x åt öster, z åt söder):
//   heights.f32   Float32, meter
//   biomes_a.u8, biomes_b.u8   biomernas vikter (BIOMES) med det målade lagret ovanpå, fyra per hörn i varje (RGBA)
//   paint_a.u8, paint_b.u8     de målade marklagrens vikter (paintLayers), fyra per hörn i varje, om något är målat
//   look.u8       regionens färgton (rgb) och ton (a)
//   wet.u8        fukten 0..255           grass.u8    gräsets täthet 0..255 (samma regler som grassAt i studio/terrain.js)
//   streams.f32   bäckarnas och åarnas vattenyta: tre Float32 per hörn (nivå, flödets riktning x, z); nivån −10000 där
//                 inget rinner (vikar ligger på havets nivå och ritas av havet)
//   nature.json   utplaceringen (shared/terrain/populate.js, världens egna lager och frö): per modell instanserna
//                 [x, y, z, vridning, storlek, lutning x, lutning z] och nivåernas avstånd (lod gånger Detail range), och
//                 modellerna uppackade (utan meshopt) i models/
//   world.json    rutnätet, havet, texturerna per biom och lager, gräsets och vattnets inställningar
// Svarar med en rad JSON.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTerrain, worldGrid } from '../../shared/terrain/generate.js';
import { applyEdits, decodeDelta, resampleDelta } from '../../shared/terrain/sculpt.js';
import { regionField, regionAttributes } from '../../shared/terrain/regions.js';
import { BIOMES, computeBiomes, mixPaint, decodePaint } from '../../shared/terrain/biomes.js';
import { SLOTS, decodeWeights, resampleWeights } from '../../shared/terrain/paint.js';
import { populate, STRIDE } from '../../shared/terrain/populate.js';
import { io } from '../tree/gltf_write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const args = JSON.parse(process.argv[2] ?? '{}');
const name = args.name ?? 'my_island';
const t0 = performance.now();

const T = json('tools/terrain/terrain.json'), saved = json(`assets/terrain/${name}.terrain.json`);
const v = { ...Object.fromEntries(T.params.map((q) => [q.key, q.default])), ...saved.settings };
const recipeKeys = T.params.filter((q) => q.recipe !== false).map((q) => q.key);
const size = Number(v.worldSize), L = saved.layers ?? {};

// Det formade som i use() i studio/terrain.js: penslarna (sculpt) och det som formats i grävt vatten (sculptOver)
const sc = decodeDelta(L.sculpt), so = decodeDelta(L.sculptOver);
let delta = sc?.delta ?? null, deltaN = sc?.n ?? 0;
const over = so ? (delta ? resampleDelta(so.delta, so.n, deltaN) : so.delta) : null;
if (so && !delta) { delta = new Float32Array(so.n * so.n); deltaN = so.n; }
const regions = (saved.regions ?? []).length ? saved.regions : [{ name: 'Heartland', theme: 'temperate' }];
const recipe = {
  ...Object.fromEntries(recipeKeys.map((k) => [k, v[k]])), ...worldGrid(size),
  regions, regionThemes: T.regionThemes, regionColors: T.regionColors, regionPaint: decodePaint(L.regionPaint),
  sculpt: delta, sculptOver: over, sculptN: deltaN, channels: saved.channels ?? [], channelKinds: T.channelKinds,
};

const t = applyEdits(generateTerrain(recipe), recipe), { n, cell, half, heights } = t;
const rf = regionField(t, recipe, {});
const biomes = mixPaint(computeBiomes(t, recipe, rf).weights, decodePaint(L.biomePaint), n);
const { look } = regionAttributes(t, rf);

// De målade marklagren, i samma rutnät som marken
const gp = decodeWeights(L.groundPaint);
const paintLayers = (saved.paintLayers ?? []).slice(0, SLOTS);
let paint = null;
if (gp && paintLayers.some(Boolean)) paint = gp.n === n ? gp.weights : resampleWeights(gp.weights, gp.n, n);

// Gräsets täthet: biomerna, lutningen, höjden över havet, de målade lagrens grass (eller plant) och fläckarna
const G = T.populate.grass, grassBiome = BIOMES.map((id) => G.biomes?.[id] ?? 0);
const effects = paintLayers.map((p) => (p ? (T.groundTextures.find((x) => x.id === p.texture)?.populate ?? {}) : null)).map((e) => (e ? e.grass ?? e.plant ?? 1 : null));
const ease = (a, b, x) => { const s = Math.min(1, Math.max(0, (x - a) / (b - a))); return s * s * (3 - 2 * s); };
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
const vnoise = (x, z) => {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz);
  return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - w) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * w;
};
const grass = new Uint8Array(n * n);
for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
  const k = j * n + i, x = -half + i * cell, z = -half + j * cell;
  let g = 0;
  for (let b = 0; b < 8; b++) g += biomes[k * 8 + b] * grassBiome[b];
  g /= 255;
  if (g <= 0.01) continue;
  const dx = (heights[k + 1] - heights[k - 1]) / (2 * cell), dz = (heights[k + n] - heights[k - n]) / (2 * cell);
  g *= 1 - ease(G.slope - 8, G.slope, (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI);
  if (v.sea) g *= ease(v.seaLevel + G.above, v.seaLevel + G.above + 0.5, heights[k]);
  if (paint) {
    let sum = 0, eff = 0;
    for (let s = 0; s < SLOTS; s++) { if (effects[s] == null) continue; const w = paint[k * SLOTS + s] / 255; sum += w; eff += w * effects[s]; }
    g *= Math.max(0, 1 - Math.min(1, sum)) + eff;
  }
  const patch = 0.5 + (vnoise(x / 9, z / 9) * 0.65 + vnoise(x / 3.5 + 17, z / 3.5 - 5) * 0.35 - 0.5) * 1.8;
  grass[k] = Math.round(ease(patch - 0.25, patch + 0.15, Math.min(1, g)) * ease(0.03, 0.2, g) * 255);
}

const out = path.resolve(ROOT, args.out ?? `build/export/${name}`);
mkdirSync(out, { recursive: true });
const write = (f, a) => writeFileSync(path.join(out, f), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
// Åtta vikter per hörn delas i två RGBA-plan, som motorer läser direkt som texturer
const planes = (a, f) => {
  for (const [p, o] of [['a', 0], ['b', 4]]) {
    const q = new Uint8Array(n * n * 4);
    for (let k = 0; k < n * n; k++) for (let c = 0; c < 4; c++) q[k * 4 + c] = a[k * 8 + o + c];
    write(`${f}_${p}.u8`, q);
  }
};
write('heights.f32', heights);
planes(biomes, 'biomes');
write('look.u8', look);
write('wet.u8', Uint8Array.from(t.wet, (w) => Math.round(Math.min(1, Math.max(0, w)) * 255)));
write('grass.u8', grass);
if (paint) planes(paint, 'paint');

// Bäckarna: varje hörn nära fåran tar nivån och riktningen från närmaste prov längs den
const streams = new Float32Array(n * n * 3), best = new Float32Array(n * n).fill(Infinity);
for (let k = 0; k < n * n; k++) streams[k * 3] = -10000;
for (const c of t.channels) {
  if (c.sea) continue;
  for (const p of c.smp) {
    const r = p.w * 1.2 + 2 * cell, i0 = Math.max(0, Math.floor((p.x - r + half) / cell)), i1 = Math.min(n - 1, Math.ceil((p.x + r + half) / cell));
    const j0 = Math.max(0, Math.floor((p.z - r + half) / cell)), j1 = Math.min(n - 1, Math.ceil((p.z + r + half) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * n + i, d = Math.hypot(-half + i * cell - p.x, -half + j * cell - p.z);
      if (d > r || d >= best[k]) continue;
      best[k] = d;
      streams[k * 3] = p.level; streams[k * 3 + 1] = p.tx; streams[k * 3 + 2] = p.tz;
    }
  }
}
write('streams.f32', streams);

// Naturen: samma utplacering som Kartrummet (runPopulate i studio/terrain.js), modellerna per lager och familj
const pop = saved.populate ?? {};
const popWorld = {
  n, cell, half, size, heights, wet: t.wet, biomes, sea: v.sea ? v.seaLevel : null,
  ground: paint ? { W: paint, effects: paintLayers.map((p) => (p ? (T.groundTextures.find((x) => x.id === p.texture)?.populate ?? {}) : null)) } : null,
  regions: rf.weights ? { P: rf.P, count: rf.count, weights: rf.weights, themes: regions.map((r) => r.theme) } : null,
};
const P = populate(popWorld, T.populate, { seed: pop.seed, density: pop.density, layers: pop.layers });
const byModel = new Map();
for (const L of P.layers) {
  const rule = T.populate.layers.find((x) => x.id === L.id);
  if (!L.count || !rule) continue;
  for (let i = 0; i < L.count; i++) {
    const o = i * STRIDE, m = rule.models[L.data[o + 5]]?.[0] ?? rule.models[0][0], key = `${L.id}:${m}`;
    if (!byModel.has(key)) byModel.set(key, { layer: L.id, kind: L.kind, model: m, align: rule.align ?? 0.1, near: (rule.lod?.near ?? 60) * (pop.detail ?? 1), mid: (rule.lod?.mid ?? 0) * (pop.detail ?? 1), shadow: rule.kind === 'tree' || rule.kind === 'rock', instances: [] });
    const d = L.data;
    byModel.get(key).instances.push(...[d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 6], d[o + 7]].map((x) => Math.round(x * 1000) / 1000));
  }
}
// Modellerna utan meshopt (Godot läser inte EXT_meshopt_compression): geometrin inbäddad, texturerna kvar i asset-studio
const nio = await io();
mkdirSync(path.join(out, 'models'), { recursive: true });
for (const m of new Set([...byModel.values()].map((x) => x.model))) {
  const id = m.split('/').pop(), src = path.join(ROOT, 'assets', m, `${id}.gltf`);
  const doc = await nio.read(src);
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  const { json: J, resources } = await nio.writeJSON(doc, { basename: id });
  for (const b of J.buffers ?? []) b.uri = `data:application/octet-stream;base64,${Buffer.from(resources[b.uri]).toString('base64')}`;
  // Bilderna pekar på asset-studios egna filer, relativt till den uppackade modellen
  for (const im of J.images ?? []) if (im.uri && !im.uri.startsWith('data:')) im.uri = path.relative(path.join(out, 'models'), path.resolve(path.dirname(src), im.uri)).split(path.sep).join('/');
  J.scene ??= 0;
  // WebP-bilder via EXT_texture_webp (Godot läser bara WebP genom tillägget)
  const webp = new Set((J.images ?? []).map((im, i) => (im.mimeType === 'image/webp' ? i : -1)).filter((i) => i >= 0));
  if (webp.size) {
    for (const tx of J.textures ?? []) if (webp.has(tx.source)) { tx.extensions = { ...tx.extensions, EXT_texture_webp: { source: tx.source } }; delete tx.source; }
    J.extensionsUsed = [...new Set([...(J.extensionsUsed ?? []), 'EXT_texture_webp'])];
  }
  writeFileSync(path.join(out, 'models', `${id}.gltf`), JSON.stringify(J));
}
const nature = [...byModel.values()].map((x) => ({ ...x, file: `models/${x.model.split('/').pop()}.gltf` }));
writeFileSync(path.join(out, 'nature.json'), JSON.stringify(nature));

const Gr = json('tools/grass/grass.json'), Wa = json('tools/water/water.json');
const strip = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k !== 'label'));
const metres = (id) => T.groundTextures.find((x) => x.id === id)?.metres ?? 3;
let lo = Infinity, hi = -Infinity;
for (const h of heights) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
const world = {
  name, n, size, cell, half, seaFloor: recipe.seaFloor, sea: !!v.sea, seaLevel: v.seaLevel, cliffAngle: v.cliffAngle, grassTone: v.grassTone,
  low: lo, high: hi, biomes: T.biomes.map((b) => ({ id: b.id, color: b.color })),
  paintLayers: paintLayers.map((p) => (p ? { texture: p.texture, metres: p.metres ?? metres(p.texture) } : null)),
  grass: { ...Object.fromEntries(Gr.params.map((q) => [q.key, q.default])), ...strip(Gr.presets[G.preset]), ...G.settings, field: G.field },
  water: { ...Object.fromEntries(Wa.params.map((q) => [q.key, q.default])), ...strip(Wa.presets.tropical_lagoon) },
  streamWater: { ...Object.fromEntries(Wa.params.map((q) => [q.key, q.default])), ...strip(Wa.presets[T.channelKinds.stream?.water]) },
  files: ['heights.f32', 'biomes_a.u8', 'biomes_b.u8', 'look.u8', 'wet.u8', 'grass.u8', 'streams.f32', 'nature.json', ...(paint ? ['paint_a.u8', 'paint_b.u8'] : [])],
};
writeFileSync(path.join(out, 'world.json'), JSON.stringify(world, null, 1));
let grassy = 0;
for (const g of grass) if (g > 25) grassy++;
console.log(JSON.stringify({ ok: true, name, out: path.relative(ROOT, out), n, size, cell, low: +lo.toFixed(1), high: +hi.toFixed(1), painted: !!paint, streams: t.channels.filter((c) => !c.sea).length, nature: P.total, models: nature.length, grassPct: +(100 * grassy / grass.length).toFixed(1), ms: Math.round(performance.now() - t0) }));
