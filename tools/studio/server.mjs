// Asset Studio: lokal server för studion (studio/index.html). Serverar projektroten och ett litet API som kör
// generatorerna, så att studion aldrig kör verktyg själv (README: klient och server via eget API).
// Plan: docs/asset-studio.md. Antar ingen webbläsare och inget Electron.
//
//   node tools/studio/server.mjs [port]        (standard 8770, lyssnar bara på 127.0.0.1)
//
// GET  /api/generators              generatorer med spakar (params.json) och arternas standardvärden
// POST /api/generate                { generator, recipe } -> förhandsvisning i build/studio/, svar med modell och checks
// GET  /api/textures?kind=bark      texturer att välja bland (leaves, bark)
// GET  /api/library                 bibliotekets katalog (assets/library.json), med kind (family, fixed) och category
// GET  /api/library/scan            tillgångar under assets/ som inte finns i katalogen
// POST /api/library/add|update|remove|freeze|thumb   { model, ... }: lägg till, taggar, kategori och utplacering
//                                   (scatter), ta bort raden, frys till assets/fixed/<name>/, spara en miniatyr (PNG)
// POST /api/library/variants        { model, count } -> { job }: bygg familjens variantpool (count 0 tar bort den)
// GET  /api/library/job?id=         variantjobbets förlopp { k, n, done, errors, entry }
// POST /api/library                 { generator, name, tags, recipe, thumbnail } -> assets/ + rad i katalogen
// POST /api/shot?name=             skärmdump av 3D-vyn (PNG i kroppen) -> build/shots/studio_<namn>.png
// GET  /api/workshop                texturverkstadens spakar (tools/texture/workshop.json)
// POST /api/texture/preview         { recipe } -> kartorna (512 px) i build/studio/tex/, cachade per recept; långa jobb
//                                   (Krea) svarar { pending, job }
// GET  /api/texture/job?id=         ett pågående jobbs status eller resultat
// POST /api/texture/save            { recipe, name, profile, tags, size, maps, pack, webp, overwrite } -> assets/textures
//                                   + texturkatalogen
// GET  /api/texture/recipe?name=    receptet för en textur som gjorts i verkstaden

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, rm, mkdir, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.argv[2] ?? 8770);
const PREVIEWS = 'build/studio/trees'; // förhandsvisningar; städas, bara det som sparas hamnar i assets/
const KEEP_PREVIEWS = 40;
const LIBRARY = path.join(ROOT, 'assets/library.json');
const NAME = /^[a-z0-9][a-z0-9_]{0,47}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
};

// Generatorerna studion känner till. Fler (props, växter, husdelar) läggs till med sin params.json och sitt skript.
const GENERATORS = {
  tree: {
    params: 'tools/tree/params.json',
    script: 'tools/tree/make_tree.py',
    species: 'tools/tree/species.json',
    assets: 'assets/trees',
  },
};

const json = (res, code, body) => {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
};

async function body(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('för stor förfrågan'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Kör ett generatorskript med ett recept; svaret är dess sista rad JSON
function runTool(script, recipe) {
  return new Promise((resolve) => {
    const p = spawn('python3', ['-I', path.join(ROOT, script), JSON.stringify(recipe)], { cwd: ROOT });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      // Fel skrivs som en rad JSON på stderr (sys.exit), så att studion kan visa bara meddelandet
      const last = (s) => { try { return JSON.parse(s.trim().split('\n').pop()); } catch { return null; } };
      resolve(last(out) ?? (last(err)?.error ? last(err) : { error: (err || out).trim().slice(-500) || 'no response' }));
    });
  });
}

// En generering i taget (grafikkortet och disken delas); senare förfrågningar väntar i kö
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

let previewCounter = 0;
async function cleanPreviews() {
  const dir = path.join(ROOT, PREVIEWS);
  if (!existsSync(dir)) return;
  const entries = await Promise.all((await readdir(dir)).map(async (n) => ({ n, t: (await stat(path.join(dir, n))).mtimeMs })));
  entries.sort((a, b) => b.t - a.t);
  await Promise.all(entries.slice(KEEP_PREVIEWS).map((e) => rm(path.join(dir, e.n), { recursive: true, force: true })));
}

// Receptet från studion: bara kända fält går vidare till generatorn
const cleanRecipe = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) =>
  ['preset', 'seed', 'height', 'bole', 'species', 'canopy', 'leaves', 'bark', 'leaf_tint', 'bark_repeat', 'bark_uv', 'bark_blend'].includes(k)));

async function generate({ generator = 'tree', recipe }) {
  const g = GENERATORS[generator];
  if (!g) return { error: `unknown generator ${generator}` };
  const name = `p${Date.now().toString(36)}${(previewCounter++).toString(36)}`;
  const t0 = Date.now();
  const result = await serial(() => runTool(g.script, { ...cleanRecipe(recipe), name, out_root: PREVIEWS }));
  cleanPreviews().catch(() => {});
  if (result.error) return result;
  return { ...result, url: `/${PREVIEWS}/${name}/${name}.gltf`, ms: Date.now() - t0 };
}

// Små förhandsbilder av texturerna för studions kort (build/studio/thumbs/), gjorda i ett anrop när de saknas
const THUMBS = 'build/studio/thumbs', THUMB_PX = 160;
async function ensureThumbs(names) {
  await mkdir(path.join(ROOT, THUMBS), { recursive: true });
  const thumbOf = (n) => path.join(ROOT, THUMBS, `${n}_${THUMB_PX}.jpg`), texOf = (n) => path.join(ROOT, 'assets/textures', `${n}.png`);
  // Saknas, eller är texturen nyare än förhandsbilden
  const missing = names.filter((n) => !existsSync(thumbOf(n)) || statSync(texOf(n)).mtimeMs > statSync(thumbOf(n)).mtimeMs);
  if (!missing.length) return;
  await new Promise((resolve) => {
    const p = spawn('uv', ['run', '--quiet', '--no-project', '--python', '3.12', '--with', 'pillow==11.1.0', '--with', 'numpy==2.2.3',
      'python', '-I', path.join(ROOT, 'tools/texture/post_textures.py'), 'thumbs', path.join(ROOT, THUMBS), String(THUMB_PX),
      ...missing.map(texOf)], { cwd: ROOT });
    p.on('close', resolve);
  });
}

async function textures(kind) {
  const dir = path.join(ROOT, 'assets/textures');
  const match = { bark: /^bark_/, leaves: /^(leaf|leaves|blossom|autumn|needle)/, blend: /^(moss|bark_|surface_|foliage_painted|lichen|blend_|rock_)/ }[kind] ?? /./;
  const names = (await readdir(dir)).filter((f) => f.endsWith('.png') && match.test(f) && !/_(mass|raw|normal|height|rough|metal|ao|emissive|orm)$/.test(f.slice(0, -4))).map((f) => f.slice(0, -4));
  await ensureThumbs(names);
  const cat = await readJson('assets/textures/catalog.json') ?? {};
  const metersOf = (n) => cat.textures?.find((t) => t.name === n)?.meters ?? cat.scales?.[n] ?? null;
  return names.sort().map((n) => ({ name: n, url: `/assets/textures/${n}.png`, thumb: `/${THUMBS}/${n}_${THUMB_PX}.jpg`, meters: metersOf(n) }));
}

// Materialets skala (meter per upprepning), satt från en tillgång med Use as material default. En textur från
// verkstaden får den i katalograden och i sitt recept; andra texturer i katalogens scales.
async function textureScale({ name, meters }) {
  if (!NAME.test(String(name ?? '')) || !(meters > 0.01 && meters < 100)) return { error: 'bad texture name or scale' };
  const file = path.join(ROOT, 'assets/textures/catalog.json');
  const cat = (await readJson('assets/textures/catalog.json')) ?? { textures: [] };
  const m = Math.round(meters * 1000) / 1000;
  const row = cat.textures?.find((t) => t.name === name);
  if (row) {
    row.meters = m;
    const rf = row.recipe && (await readJson(row.recipe));
    if (rf) { rf.meters = m; rf.material = { ...(rf.material ?? {}), meters: m }; await writeFile(path.join(ROOT, row.recipe), JSON.stringify(rf, null, 2) + '\n'); }
  } else (cat.scales ??= {})[name] = m;
  await writeFile(file, JSON.stringify(cat, null, 2) + '\n');
  return { name, meters: m, in: row ? 'catalog' : 'scales' };
}

// --- Texturverkstaden (docs/texture-workshop.md): recept -> tools/texture/workshop.py ---
// En förhandsvisning ger flera kartor (<hash>_color.png, _height, _normal ...). Den cachas per recept. Jobb som tar
// tid (Krea, cirka 3 minuter) körs vidare i bakgrunden: svaret kommer då som { pending, job } och studion frågar
// /api/texture/job tills det är klart.
const TEXPREV = 'build/studio/tex', TEXCACHE = 'build/studio/texcache';
let texQueue = Promise.resolve();
const texSerial = (fn) => (texQueue = texQueue.then(fn, fn));
const jobs = new Map();
let jobCounter = 0;
const recipeOf = (recipe, size) => ({
  source: recipe?.source ?? { type: 'noise' }, steps: recipe?.steps ?? [], inputs: recipe?.inputs ?? {},
  material: recipe?.material ?? {}, size,
});
async function runPreview(r, hash) {
  const meta = path.join(ROOT, TEXPREV, `${hash}.json`);
  const res = await texSerial(() => runTool('tools/texture/workshop.py', { ...r, out: `${TEXPREV}/${hash}` }));
  if (res.error) return res;
  res.maps = Object.fromEntries(Object.entries(res.maps ?? {}).map(([k, v]) => [k, `/${v}`]));
  await writeFile(meta, JSON.stringify(res));
  cleanDir(path.join(ROOT, TEXPREV), 1600).catch(() => {});
  for (const d of ['base', 'ing']) cleanDir(path.join(ROOT, TEXCACHE, d), 300).catch(() => {});
  return res;
}
async function texturePreview({ recipe }) {
  const r = recipeOf(recipe, Math.min(1024, recipe?.size ?? 512));
  const hash = createHash('sha1').update(JSON.stringify(r)).digest('hex').slice(0, 16);
  const meta = path.join(ROOT, TEXPREV, `${hash}.json`);
  if (existsSync(meta)) return { ...JSON.parse(await readFile(meta, 'utf8')), cached: true };
  for (const [id, j] of jobs) if (j.hash === hash && !j.done) return { pending: true, job: id, since: j.t0 };
  const id = String(++jobCounter);
  const job = { hash, t0: Date.now(), done: false, result: null, krea: r.source?.type === 'krea' || JSON.stringify(r.inputs).includes('"krea"') };
  jobs.set(id, job);
  const p = runPreview(r, hash).then((res) => { job.result = res; job.done = true; setTimeout(() => jobs.delete(id), 600000); return res; });
  const quick = await Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), 4000))]);
  return quick ?? { pending: true, job: id, since: job.t0, krea: job.krea };
}
function textureJob(id) {
  const j = jobs.get(id);
  if (!j) return { error: 'no such job (the server may have restarted)' };
  return j.done ? j.result : { pending: true, job: id, since: j.t0, krea: j.krea };
}
async function textureSave({ recipe, name, profile, tags = [], meters = 2, size = 1024, maps, pack, webp, overwrite = false }) {
  const r = { ...recipeOf(recipe, [512, 1024, 2048, 4096].includes(size) ? size : 1024), blend: recipe?.blend ?? { layers: [] } };
  return texSerial(() => runTool('tools/texture/workshop.py', { ...r, save: { name, profile, tags, meters, maps, pack, webp, overwrite } }));
}
async function cleanDir(dir, keep) {
  if (!existsSync(dir)) return;
  const entries = await Promise.all((await readdir(dir)).map(async (n) => ({ n, t: (await stat(path.join(dir, n))).mtimeMs })));
  entries.sort((a, b) => b.t - a.t);
  await Promise.all(entries.slice(keep).map((e) => rm(path.join(dir, e.n), { force: true, recursive: true })));
}

async function readLibrary() {
  try { return JSON.parse(await readFile(LIBRARY, 'utf8')); } catch { return { items: [] }; }
}

async function saveToLibrary({ generator = 'tree', name, tags = [], recipe, thumbnail, overwrite = false }) {
  const g = GENERATORS[generator];
  if (!g) return { error: `unknown generator ${generator}` };
  if (!NAME.test(name ?? '')) return { error: 'the name may only have a–z, 0–9 and _ (at most 48 characters)' };
  const dir = path.join(ROOT, g.assets, name);
  if (existsSync(dir) && !overwrite) return { error: `${name} already exists`, exists: true };
  const result = await serial(() => runTool(g.script, { ...cleanRecipe(recipe), name }));
  if (result.error) return result;
  let thumb = null;
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(thumbnail ?? '');
  if (m) {
    thumb = `${g.assets}/${name}/${name}_thumb.${m[1] === 'png' ? 'png' : 'jpg'}`;
    await writeFile(path.join(ROOT, thumb), Buffer.from(m[2], 'base64'));
  }
  const lib = await readLibrary();
  const entry = {
    name, type: generator, kind: 'family', category: categoryOf(generator, recipe), tags: cleanTags(tags),
    model: result.model, recipe: `${g.assets}/${name}/recipe.json`, thumbnail: thumb, checks_ok: result.checks?.ok ?? null,
    saved: new Date().toISOString(),
  };
  lib.items = [...lib.items.filter((i) => !(i.type === generator && i.name === name)), await completeEntry(entry)];
  await writeFile(LIBRARY, JSON.stringify(lib, null, 2) + '\n');
  return { entry, checks: result.checks };
}

// --- Biblioteket (docs/asset-studio.md, Familjer och fasta modeller) ---
// En familj är ett recept som generatorn kan göra om och variera; en fast modell är en bestämd modell som ligger
// kvar som den är (importerad, eller frusen ur en familj, under assets/fixed/). Raden heter sin modellsökväg.
const ASSET_DIRS = { trees: 'tree', props: 'prop', plants: 'plant', buildings: 'building', imported: 'imported', fixed: 'fixed' };
const ROCKS = /stone|boulder|rock|pebble|cliff/;
function categoryOf(type, recipe = {}) {
  const preset = String(recipe.preset ?? '');
  if (type === 'tree') return /bush/.test(preset) ? 'bush' : 'tree';
  if (type === 'prop') return ROCKS.test(preset) ? 'rock' : 'prop';
  if (type === 'plant') return 'plant';
  if (type === 'building') return 'building';
  if (type === 'imported') return /building/.test(recipe.category ?? '') ? 'building' : 'prop';
  return 'prop';
}
async function readJson(rel) { try { return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8')); } catch { return null; } }
const thumbFor = (dir, name) => ['png', 'jpg'].map((x) => `${dir}/${name}_thumb.${x}`).find((p) => existsSync(path.join(ROOT, p))) ?? null;
// Katalogen med standardvärden för äldre rader (kind och category saknades före B1)
async function libraryView() {
  const lib = await readLibrary();
  const items = await Promise.all(lib.items.map(async (i) => {
    const recipe = i.recipe ? await readJson(i.recipe) : null;
    const fixed = i.type === 'imported' || i.model.startsWith('assets/fixed/');
    return { kind: fixed ? 'fixed' : 'family', category: categoryOf(i.type, recipe ?? {}), tags: [], ...i,
             thumbnail: i.thumbnail ?? thumbFor(path.dirname(i.model), i.name), preset: recipe?.preset ?? null, seed: recipe?.seed ?? null,
             license: recipe?.license ?? null, origin: recipe?.origin ?? null };
  }));
  for (const i of items) { i.bounds ??= await gltfBounds(i.model); i.scatter = scatterFor(i, i.bounds); }
  return { items };
}
// Tillgångar på disken som inte finns i katalogen, att lägga till
async function libraryScan() {
  const inLib = new Set((await readLibrary()).items.map((i) => i.model));
  const out = [];
  for (const [dir, type] of Object.entries(ASSET_DIRS)) {
    let names = [];
    try { names = await readdir(path.join(ROOT, 'assets', dir)); } catch { continue; }
    for (const name of names) {
      const model = ['gltf', 'glb'].map((x) => `assets/${dir}/${name}/${name}.${x}`).find((p) => existsSync(path.join(ROOT, p)));
      if (!model || inLib.has(model)) continue;
      const recipe = `assets/${dir}/${name}/recipe.json`, r = await readJson(recipe);
      out.push({ name, type, model, recipe: r ? recipe : null, kind: type === 'imported' || dir === 'fixed' ? 'fixed' : 'family',
                 category: categoryOf(type, r ?? {}), thumbnail: thumbFor(`assets/${dir}/${name}`, name), preset: r?.preset ?? null, seed: r?.seed ?? null,
                 license: r?.license ?? null, origin: r?.origin ?? null, tags: [], saved: null });
    }
  }
  return { items: out };
}
async function writeLibrary(lib) { await writeFile(LIBRARY, JSON.stringify(lib, null, 2) + '\n'); }
const cleanTags = (tags) => [...new Set((tags ?? []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase()))];
const CATEGORIES = new Set(['tree', 'bush', 'plant', 'rock', 'prop', 'building']);
async function libraryAdd({ model, tags }) {
  const found = (await libraryScan()).items.find((i) => i.model === model);
  if (!found) return { error: 'does not exist, or is already in the library' };
  const lib = await readLibrary();
  const entry = { name: found.name, type: found.type, kind: found.kind, category: found.category, tags: cleanTags(tags), model, recipe: found.recipe,
                  thumbnail: found.thumbnail, checks_ok: null, saved: new Date().toISOString() };
  lib.items.push(await completeEntry(entry));
  await writeLibrary(lib);
  return { entry };
}
async function libraryUpdate({ model, tags, category, scatter }) {
  const lib = await readLibrary(), e = lib.items.find((i) => i.model === model);
  if (!e) return { error: 'not in the library' };
  if (tags) e.tags = cleanTags(tags);
  if (scatter && typeof scatter === 'object') e.scatter = { ...e.scatter, ...cleanScatter(scatter) };
  if (category) { if (!CATEGORIES.has(category)) return { error: `unknown category ${category}` }; e.category = category; }
  await completeEntry(e);
  await writeLibrary(lib);
  return { entry: e };
}
async function libraryRemove({ model }) {
  // Bara raden i katalogen: filerna ligger kvar och syns under Ej tillagda
  const lib = await readLibrary(), n = lib.items.length;
  lib.items = lib.items.filter((i) => i.model !== model);
  if (lib.items.length === n) return { error: 'not in the library' };
  await writeLibrary(lib);
  return { ok: true };
}
// Frys: kopiera familjens modell till assets/fixed/<namn>/ (samma djup, så att texturernas relativa sökvägar gäller),
// med receptet bredvid och en hänvisning till familjen den kom från
async function libraryFreeze({ model, name }) {
  if (!NAME.test(name ?? '')) return { error: 'the name may only have a–z, 0–9 and _ (at most 48 characters)' };
  const src = (await libraryView()).items.find((i) => i.model === model) ?? (await libraryScan()).items.find((i) => i.model === model);
  if (!src) return { error: 'the model does not exist' };
  if (src.kind === 'fixed') return { error: 'it is already a fixed model' };
  const from = path.dirname(model), to = `assets/fixed/${name}`;
  if (existsSync(path.join(ROOT, to))) return { error: `${name} already exists among the fixed models`, exists: true };
  await mkdir(path.join(ROOT, to), { recursive: true });
  const old = path.basename(model).replace(/\.(gltf|glb)$/, ''), ext = path.extname(model);
  for (const f of await readdir(path.join(ROOT, from))) {
    const target = f.startsWith(`${old}.`) || f.startsWith(`${old}_`) ? name + f.slice(old.length) : f;
    let data = await readFile(path.join(ROOT, from, f));
    if (f === `${old}.gltf`) {
      const g = JSON.parse(data.toString());
      for (const b of g.buffers ?? []) if (b.uri?.startsWith(`${old}.`)) b.uri = name + b.uri.slice(old.length);
      data = JSON.stringify(g);
    }
    await writeFile(path.join(ROOT, to, target), data);
  }
  const recipe = existsSync(path.join(ROOT, to, 'recipe.json')) ? `${to}/recipe.json` : null;
  const lib = await readLibrary();
  const entry = { name, type: src.type, kind: 'fixed', category: src.category, tags: src.tags ?? [], model: `${to}/${name}${ext}`, recipe,
                  thumbnail: thumbFor(to, name), checks_ok: src.checks_ok ?? null, saved: new Date().toISOString(),
                  scatter: src.scatter, from: { name: src.name, model, recipe: src.recipe } };
  lib.items.push(await completeEntry(entry));
  await writeLibrary(lib);
  return { entry };
}
// Miniatyr som studion renderat (PNG med alfa) bredvid modellen; raden i katalogen pekar på den
async function libraryThumb({ model, thumbnail }) {
  const m = /^data:image\/png;base64,(.+)$/.exec(thumbnail ?? '');
  if (!m || typeof model !== 'string' || !/^assets\/[a-z0-9_/]+\/[a-z0-9_]+\.(gltf|glb)$/.test(model) || !existsSync(path.join(ROOT, model)))
    return { error: 'invalid model or image' };
  const name = path.basename(model).replace(/\.(gltf|glb)$/, ''), rel = `${path.dirname(model)}/${name}_thumb.png`;
  await writeFile(path.join(ROOT, rel), Buffer.from(m[1], 'base64'));
  const lib = await readLibrary(), e = lib.items.find((i) => i.model === model);
  const v = lib.items.flatMap((i) => i.variants?.items ?? []).find((x) => x.model === model);
  if (e) e.thumbnail = rel;
  if (v) v.thumbnail = rel;
  if (e || v) await writeLibrary(lib);
  return { thumbnail: rel };
}

// --- Familjernas variantpool och utplacering (B2) ---
// Poolen är familjens egen modell plus N varianter med nya frön, byggda med samma recept under
// <familjens mapp>/variants/<namn>_s<frö>/. Världen sparar familj och frö per punkt och tar närmaste färdiga variant.
const GEN_TOOLS = { tree: 'tools/tree/make_tree.py', prop: 'tools/props/make_prop.py', plant: 'tools/plants/make_plant.py', building: 'tools/building/make_building.py' };
// Utplaceringens standard per kategori: storleksintervall, hur mycket den lutar med marken (0–1), största lutning
// (grader), vridning (y = bara runt höjdaxeln, free = även lutad), avstånd i radier och vikt mot andra familjer
const SCATTER_DEFAULTS = {
  tree: { scale: [0.85, 1.2], align: 0.1, max_slope: 35, rotate: 'y', spacing: 1, weight: 1 },
  bush: { scale: [0.8, 1.25], align: 0.3, max_slope: 40, rotate: 'y', spacing: 0.8, weight: 1 },
  plant: { scale: [0.7, 1.3], align: 0.7, max_slope: 45, rotate: 'y', spacing: 0.6, weight: 1 },
  rock: { scale: [0.6, 1.5], align: 0.8, max_slope: 60, rotate: 'free', spacing: 1, weight: 1 },
  prop: { scale: [0.85, 1.15], align: 0.6, max_slope: 40, rotate: 'y', spacing: 1, weight: 1 },
  building: { scale: [1, 1], align: 0, max_slope: 8, rotate: 'y', spacing: 1.2, weight: 1 },
};
// Modellens mått ur glTF-filens accessorer (POSITION min/max, LOD0 om den finns): bredd, djup, höjd och radie i meter
async function gltfBounds(model) {
  let g;
  try {
    const buf = await readFile(path.join(ROOT, model));
    g = model.endsWith('.glb') ? JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString()) : JSON.parse(buf.toString());
  } catch { return null; }
  const meshes = (g.meshes ?? []).filter((m) => /LOD0/.test(m.name ?? ''));
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes.length ? meshes : g.meshes ?? []) for (const p of m.primitives) {
    const a = g.accessors[p.attributes.POSITION];
    if (!a?.min) continue;
    for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], a.min[i]); mx[i] = Math.max(mx[i], a.max[i]); }
  }
  if (!Number.isFinite(mn[0])) return null;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { width: r2(mx[0] - mn[0]), depth: r2(mx[2] - mn[2]), height: r2(mx[1] - Math.max(mn[1], 0)), radius: r2(Math.max(mx[0] - mn[0], mx[2] - mn[2]) / 2) };
}
const scatterFor = (e, bounds) => ({ ...SCATTER_DEFAULTS[e.category] ?? SCATTER_DEFAULTS.prop, radius: bounds?.radius ?? 1, biomes: [], ...e.scatter });
function cleanScatter(s) {
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
  const out = {};
  if (Array.isArray(s.scale)) { const a = num(s.scale[0], 0.05, 20), b = num(s.scale[1], 0.05, 20); if (a !== undefined && b !== undefined) out.scale = [Math.min(a, b), Math.max(a, b)]; }
  for (const [k, lo, hi] of [['align', 0, 1], ['max_slope', 0, 90], ['spacing', 0.1, 10], ['weight', 0, 100], ['radius', 0.01, 200]]) if (s[k] !== undefined) out[k] = num(s[k], lo, hi);
  if (s.rotate === 'y' || s.rotate === 'free') out.rotate = s.rotate;
  if (Array.isArray(s.biomes)) out.biomes = cleanTags(s.biomes);
  return out;
}
// Katalograden ska vara självbärande för den som läser assets/library.json direkt (Tinkertown): sort, kategori,
// mått och hela utplaceringen med standardvärden ifyllda
async function completeEntry(e) {
  const recipe = e.recipe ? await readJson(e.recipe) : null;
  e.kind ??= e.type === 'imported' || e.model.startsWith('assets/fixed/') ? 'fixed' : 'family';
  e.category ??= categoryOf(e.type, recipe ?? {});
  e.bounds ??= await gltfBounds(e.model);
  e.scatter = scatterFor(e, e.bounds);
  return e;
}
const variantJobs = new Map();
let variantJobCounter = 0;
async function libraryVariants({ model, count = 8 }) {
  const lib = await readLibrary(), e = lib.items.find((i) => i.model === model);
  if (!e) return { error: 'add it to the library first' };
  const view = (await libraryView()).items.find((i) => i.model === model);
  if (view.kind !== 'family' || !GEN_TOOLS[e.type] || !e.recipe) return { error: 'only families from a generator can have variants' };
  const dir = `${path.dirname(model)}/variants`;
  count = Math.max(0, Math.min(16, Math.round(Number(count) || 0)));
  if (!count) { // tom pool: ta bort varianterna
    await rm(path.join(ROOT, dir), { recursive: true, force: true });
    delete e.variants;
    await writeLibrary(lib);
    return { entry: e };
  }
  const recipe = await readJson(e.recipe), base = Number(recipe.seed ?? 1);
  const seeds = Array.from({ length: count }, (_, k) => (base * 31 + (k + 1) * 7919) % 99999);
  const id = String(++variantJobCounter), job = { done: false, k: 0, n: count, errors: [] };
  variantJobs.set(id, job);
  (async () => {
    await rm(path.join(ROOT, dir), { recursive: true, force: true });
    const items = [{ seed: base, model, main: true }];
    for (const seed of seeds) {
      const name = `${e.name}_s${seed}`;
      const res = await serial(() => runTool(GEN_TOOLS[e.type], { ...recipe, name, seed, out_root: dir }));
      job.k++;
      if (res.error) { job.errors.push(`frö ${seed}: ${res.error}`); continue; }
      items.push({ seed, model: res.model, checks_ok: res.checks?.ok ?? null, ...(res.height_m ? { height_m: res.height_m } : {}) });
    }
    const lib2 = await readLibrary(), e2 = lib2.items.find((i) => i.model === model);
    if (e2) {
      e2.variants = { items, built: new Date().toISOString() };
      e2.bounds = await gltfBounds(model);
      e2.scatter = scatterFor(e2, e2.bounds);
      await writeLibrary(lib2);
    }
    Object.assign(job, { done: true, entry: e2 });
    setTimeout(() => variantJobs.delete(id), 600000);
  })().catch((err) => Object.assign(job, { done: true, errors: [...job.errors, String(err)] }));
  return { job: id, n: count };
}

// --- Väderkvarnen, fliken Vind (docs/effektlabb.md): spakar och profiler (tools/wind/wind.json), sparade profiler i
// assets/wind/ och gläntan: riggade modeller byggda med generatorerna i build/wind/glade/, om igen när riggen,
// generatorerna eller receptet har ändrats ---
const WIND_JSON = 'tools/wind/wind.json', WIND_SAVED = 'assets/wind', GLADE = 'build/wind/glade';
const RIG_SOURCES = ['tools/wind', 'tools/tree', 'tools/plants'];
async function newestSource() {
  let t = 0;
  for (const d of RIG_SOURCES) for (const f of await readdir(path.join(ROOT, d))) {
    // wind.json är gläntans och spakarnas data, inte modellernas: ändras den byggs inget om
    if (/\.(mjs|json|py)$/.test(f) && f !== 'wind.json') t = Math.max(t, (await stat(path.join(ROOT, d, f))).mtimeMs);
  }
  return t;
}
async function windInfo() {
  const W = await readJson(WIND_JSON);
  const dir = path.join(ROOT, WIND_SAVED);
  const saved = existsSync(dir) ? (await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.wind.json')).map((f) => readJson(`${WIND_SAVED}/${f}`)))).filter(Boolean) : [];
  return { ...W, saved: saved.sort((a, b) => String(b.saved).localeCompare(String(a.saved))) };
}
async function windSave({ name, profile, overwrite }) {
  name = String(name ?? '').trim().toLowerCase();
  if (!NAME.test(name)) return { error: 'the name may only contain a–z, 0–9 and _' };
  const W = await readJson(WIND_JSON);
  const clean = Object.fromEntries(W.params.filter((q) => !q.view).map((q) => [q.key, Math.min(q.max, Math.max(q.min, Number(profile?.[q.key] ?? q.default)))]));
  const file = path.join(ROOT, WIND_SAVED, `${name}.wind.json`);
  if (existsSync(file) && !overwrite) return { exists: true };
  await mkdir(path.dirname(file), { recursive: true });
  const entry = { name, ...clean, saved: new Date().toISOString() };
  await writeFile(file, JSON.stringify(entry, null, 2) + '\n');
  return { entry, file: `${WIND_SAVED}/${name}.wind.json` };
}
let gladeBusy = null;
async function windGlade() {
  const W = await readJson(WIND_JSON), lib = await libraryView(), newest = await newestSource();
  const items = [], errors = [];
  for (const it of W.glade) {
    let gen = it.generator, recipe = it.recipe;
    if (it.library) {
      const e = lib.items.find((i) => i.name === it.library);
      if (!e) { errors.push(`${it.id}: ${it.library} is not in the library`); continue; }
      if (it.still || !e.recipe || !['tree', 'plant'].includes(e.type)) { items.push({ ...it, url: `/${e.model}`, rigged: false }); continue; }
      gen = e.type; recipe = await readJson(e.recipe);
    }
    const { name: _n, out_root: _o, ...r } = recipe ?? {};
    const rel = `${GLADE}/${it.id}/${it.id}.gltf`, file = path.join(ROOT, rel), stampFile = path.join(ROOT, GLADE, it.id, 'glade.json');
    const key = JSON.stringify({ gen, r });
    const stamp = existsSync(stampFile) ? await readJson(`${GLADE}/${it.id}/glade.json`) : null;
    let checks = stamp?.checks;
    if (!(existsSync(file) && stamp?.key === key && statSync(file).mtimeMs > newest)) {
      const res = await serial(() => runTool(GEN_TOOLS[gen], { ...r, name: it.id, out_root: GLADE }));
      if (res.error) { errors.push(`${it.id}: ${res.error}`); continue; }
      checks = res.checks;
      await writeFile(stampFile, JSON.stringify({ key, checks }));
    }
    items.push({ ...it, url: `/${rel}?v=${Math.round(statSync(file).mtimeMs)}`, rigged: true, checks });
  }
  return { items, errors, grass: W.grass, flag: W.flag };
}

async function api(req, res, url) {
  if (url.pathname === '/api/wind' && req.method === 'GET') return json(res, 200, await windInfo());
  if (url.pathname === '/api/wind/save' && req.method === 'POST') return json(res, 200, await windSave(await body(req)));
  if (url.pathname === '/api/wind/glade' && req.method === 'GET') {
    gladeBusy ??= windGlade().finally(() => { gladeBusy = null; }); // flera flikar som frågar samtidigt får samma bygge
    return json(res, 200, await gladeBusy);
  }
  if (url.pathname === '/api/generators' && req.method === 'GET') {
    const out = {};
    for (const [id, g] of Object.entries(GENERATORS)) {
      const params = JSON.parse(await readFile(path.join(ROOT, g.params), 'utf8'));
      const all = JSON.parse(await readFile(path.join(ROOT, g.species), 'utf8'));
      out[id] = { params, species: Object.fromEntries(params.species.map((s) => [s, all[s]])) };
    }
    return json(res, 200, out);
  }
  if (url.pathname === '/api/generate' && req.method === 'POST') return json(res, 200, await generate(await body(req)));
  if (url.pathname === '/api/textures' && req.method === 'GET') return json(res, 200, await textures(url.searchParams.get('kind')));
  if (url.pathname === '/api/library' && req.method === 'GET') return json(res, 200, await libraryView());
  if (url.pathname === '/api/library/scan' && req.method === 'GET') return json(res, 200, await libraryScan());
  const LIB_POST = { add: libraryAdd, update: libraryUpdate, remove: libraryRemove, freeze: libraryFreeze, thumb: libraryThumb, variants: libraryVariants };
  if (url.pathname === '/api/library/job' && req.method === 'GET') {
    const j = variantJobs.get(url.searchParams.get('id') ?? '');
    return json(res, 200, j ?? { error: 'no such job (the server may have restarted)' });
  }
  const lm = /^\/api\/library\/([a-z]+)$/.exec(url.pathname);
  if (lm && LIB_POST[lm[1]] && req.method === 'POST') return json(res, 200, await LIB_POST[lm[1]](await body(req)));
  if (url.pathname === '/api/library' && req.method === 'POST') return json(res, 200, await saveToLibrary(await body(req)));
  if (url.pathname === '/api/shot' && req.method === 'POST') {
    // Skärmdump av studions 3D-vy (för tavlor och dokumentation): PNG-data -> build/shots/studio_<namn>.png
    const name = url.searchParams.get('name') ?? '';
    if (!/^[a-z0-9_-]{1,64}$/i.test(name)) return json(res, 400, { error: 'name: a-z, 0-9, _ and -' });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await mkdir(path.join(ROOT, 'build/shots'), { recursive: true });
    const out = `build/shots/studio_${name}.png`;
    await writeFile(path.join(ROOT, out), Buffer.concat(chunks));
    return json(res, 200, { out });
  }
  if (url.pathname === '/api/workshop' && req.method === 'GET') {
    // AI-målningen visar hela prompten: stilen som workshop.py lägger till kommer ur tools/style.json
    const w = JSON.parse(await readFile(path.join(ROOT, 'tools/texture/workshop.json'), 'utf8'));
    const st = JSON.parse(await readFile(path.join(ROOT, 'tools/style.json'), 'utf8')).prompt;
    Object.assign(w.ai, { house_style: st.house_style, tile: st.kinds.tile });
    return json(res, 200, w);
  }
  if (url.pathname === '/api/texture/preview' && req.method === 'POST') return json(res, 200, await texturePreview(await body(req)));
  if (url.pathname === '/api/texture/job' && req.method === 'GET') return json(res, 200, textureJob(url.searchParams.get('id') ?? ''));
  if (url.pathname === '/api/texture/scale' && req.method === 'POST') return json(res, 200, await textureScale(await body(req)));
  if (url.pathname === '/api/texture/save' && req.method === 'POST') return json(res, 200, await textureSave(await body(req)));
  if (url.pathname === '/api/texture/recipe' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    const file = path.join(ROOT, 'assets/textures', `${name}.texture.json`);
    if (!NAME.test(name) || !existsSync(file)) return json(res, 404, { error: 'no recipe for that texture' });
    return json(res, 200, JSON.parse(await readFile(file, 'utf8')));
  }
  return json(res, 404, { error: 'unknown request' });
}

async function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '/studio') { res.writeHead(302, { Location: '/studio/' }); return res.end(); }
  const file = path.resolve(ROOT, '.' + rel);
  // Bara filer under projektroten, inga dolda filer eller mappar (.git, .env ...)
  if (!file.startsWith(ROOT + path.sep) || file.split(path.sep).some((p) => p.startsWith('.'))) return json(res, 403, { error: 'denied' });
  try {
    const st = await stat(file);
    const target = st.isDirectory() ? path.join(file, 'index.html') : file;
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    json(res, 500, { error: String(e.message ?? e) });
  }
}).listen(PORT, '127.0.0.1', () => {
  mkdir(path.join(ROOT, PREVIEWS), { recursive: true });
  mkdir(path.join(ROOT, TEXPREV), { recursive: true });
  console.log(`Asset Studio: http://localhost:${PORT}/studio/`);
});
