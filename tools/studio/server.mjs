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
  '.webmanifest': 'application/manifest+json',
};

// Generatorerna studion känner till. Fler (props, växter, husdelar) läggs till med sin params.json och sitt skript.
const GENERATORS = {
  tree: {
    params: 'tools/tree/params.json',
    script: 'tools/tree/make_tree.py',
    species: 'tools/tree/species.json',
    assets: 'assets/trees',
  },
  // Stenarna (Smedjans flik Stone): props-generatorn med sina spakar; arterna är presets i props.json
  prop: {
    params: 'tools/props/params.json',
    script: 'tools/props/make_prop.py',
    species: 'tools/props/props.json',
    assets: 'assets/props',
  },
  // Husen (Smedjans flik House): den nya byggnadsgeneratorn (docs/buildings.md); arterna är hustyperna i houses.json
  building: {
    params: 'tools/building/params.json',
    script: 'tools/building/make_building.py',
    species: 'tools/building/houses.json',
    speciesKey: 'archetypes',
    assets: 'assets/buildings',
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
  ['preset', 'seed', 'height', 'bole', 'age', 'species', 'canopy', 'leaves', 'bark', 'leaf_tint', 'bark_repeat', 'bark_uv', 'bark_blend', 'params', 'stone_tint', 'moss_tint',
    'archetype', 'style', 'stylization', 'textures'].includes(k)));

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
  const match = { bark: /^bark_/, ground: /^(ground_|surface_(?!bld_))/, leaves: /^(leaf|leaves|blossom|autumn|needle)/, blend: /^(moss|bark_|surface_|foliage_painted|lichen|blend_|rock_)/ }[kind] ?? /./;
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
async function textureSave({ recipe, name, profile, tags = [], meters = 2, size = 1024, maps, pack, webp, hd = 0, overwrite = false }) {
  const r = { ...recipeOf(recipe, [512, 1024, 2048, 4096].includes(size) ? size : 1024), blend: recipe?.blend ?? { layers: [] } };
  // hd: storebroderns storlek (2048 eller 4096), ritad först; texturen skalas ned ur den
  return texSerial(() => runTool('tools/texture/workshop.py', { ...r, save: { name, profile, tags, meters, maps, pack, webp, hd: [2048, 4096].includes(hd) ? hd : 0, overwrite } }));
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
// Mallen en sparad produkt byggdes från (ett id ur de färdiga), så att den får mallens ikon i lådan
const fromOf = (from) => (/^[a-z0-9_]{1,40}$/.test(String(from ?? '')) ? { from } : {});
async function windSave({ name, profile, overwrite, from }) {
  name = String(name ?? '').trim().toLowerCase();
  if (!NAME.test(name)) return { error: 'the name may only contain a–z, 0–9 and _' };
  const W = await readJson(WIND_JSON);
  const clean = Object.fromEntries(W.params.filter((q) => !q.view).map((q) => [q.key, Math.min(q.max, Math.max(q.min, Number(profile?.[q.key] ?? q.default)))]));
  const file = path.join(ROOT, WIND_SAVED, `${name}.wind.json`);
  if (existsSync(file) && !overwrite) return { exists: true };
  await mkdir(path.dirname(file), { recursive: true });
  const entry = { name, ...clean, ...fromOf(from), saved: new Date().toISOString() };
  await writeFile(file, JSON.stringify(entry, null, 2) + '\n');
  return { entry, file: `${WIND_SAVED}/${name}.wind.json` };
}
// En riggad modell från en generator i dir/<id>/, byggd om bara när receptet, riggen eller generatorn har ändrats
async function riggedModel(dir, id, gen, recipe, newest) {
  const { name: _n, out_root: _o, ...r } = recipe ?? {};
  const rel = `${dir}/${id}/${id}.gltf`, file = path.join(ROOT, rel), stampRel = `${dir}/${id}/glade.json`;
  const key = JSON.stringify({ gen, r });
  const stamp = existsSync(path.join(ROOT, stampRel)) ? await readJson(stampRel) : null;
  let checks = stamp?.checks;
  if (!(existsSync(file) && stamp?.key === key && statSync(file).mtimeMs > newest)) {
    const res = await serial(() => runTool(GEN_TOOLS[gen], { ...r, name: id, out_root: dir }));
    if (res.error) return { error: res.error };
    checks = res.checks;
    await writeFile(path.join(ROOT, stampRel), JSON.stringify({ key, checks }));
  }
  return { url: `/${rel}?v=${Math.round(statSync(file).mtimeMs)}`, checks };
}
// Växterna till blomklungorna (tools/grass/grass.json): några frön per art, i build/wind/plants/
const PLANTS_DIR = 'build/wind/plants';
async function windPlant(preset, seed) {
  const G = await readJson('tools/grass/grass.json');
  if (!G.flowers.plants.some((p) => p.preset === preset) || !(seed >= 0 && seed < 100)) return { error: 'unknown plant' };
  return riggedModel(PLANTS_DIR, `${preset}_s${seed}`, 'plant', { preset, seed }, await newestSource());
}
// Gräset som recept: spakar och färdiga gräs (tools/grass/grass.json), sparade i assets/grass/ med blomklungorna
const GRASS_SAVED = 'assets/grass';
async function grassInfo() {
  const G = await readJson('tools/grass/grass.json');
  const dir = path.join(ROOT, GRASS_SAVED);
  const saved = existsSync(dir) ? (await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.grass.json')).map((f) => readJson(`${GRASS_SAVED}/${f}`)))).filter(Boolean) : [];
  return { ...G, saved: saved.sort((a, b) => String(b.saved).localeCompare(String(a.saved))) };
}
async function grassSave({ name, settings, flowers, overwrite, from }) {
  name = String(name ?? '').trim().toLowerCase();
  if (!NAME.test(name)) return { error: 'the name may only contain a–z, 0–9 and _' };
  const G = await readJson('tools/grass/grass.json');
  const clean = {};
  for (const q of G.params) {
    const v = settings?.[q.key];
    if (q.type === 'color') clean[q.key] = /^#[0-9a-f]{6}$/i.test(v) ? v : q.default;
    else if (q.type === 'bool') clean[q.key] = v === undefined ? q.default : !!v;
    else if (q.type === 'texture') clean[q.key] = v === 'none' || (NAME.test(String(v)) && existsSync(path.join(ROOT, 'assets/textures', `${v}.png`))) ? v : q.default;
    else clean[q.key] = Math.min(q.max, Math.max(q.min, Number(v ?? q.default)));
  }
  const fl = flowers ? {
    plants: (flowers.plants ?? []).filter((p) => G.flowers.plants.some((x) => x.preset === p)),
    ...Object.fromEntries(G.flowers.params.map((q) => [q.key, Math.min(q.max, Math.max(q.min, Number(flowers[q.key] ?? q.default)))])),
  } : undefined;
  const file = path.join(ROOT, GRASS_SAVED, `${name}.grass.json`);
  if (existsSync(file) && !overwrite) return { exists: true };
  await mkdir(path.dirname(file), { recursive: true });
  const entry = { name, settings: clean, ...(fl ? { flowers: fl } : {}), ...fromOf(from), saved: new Date().toISOString() };
  await writeFile(file, JSON.stringify(entry, null, 2) + '\n');
  return { entry, file: `${GRASS_SAVED}/${name}.grass.json` };
}
// --- Häxkitteln (docs/effektlabb.md, E6): spakar och färdiga effekter (tools/vfx/vfx.json), sparade i assets/vfx/ ---
const VFX_JSON = 'tools/vfx/vfx.json', VFX_SAVED = 'assets/vfx';
async function vfxInfo() {
  const X = await readJson(VFX_JSON);
  const dir = path.join(ROOT, VFX_SAVED);
  const saved = existsSync(dir) ? (await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.vfx.json')).map((f) => readJson(`${VFX_SAVED}/${f}`)))).filter(Boolean) : [];
  return { ...X, saved: saved.sort((a, b) => String(b.saved).localeCompare(String(a.saved))) };
}
async function vfxSave({ name, kind, settings, overwrite, from }) {
  name = String(name ?? '').trim().toLowerCase();
  if (!NAME.test(name)) return { error: 'the name may only contain a–z, 0–9 and _' };
  const X = await readJson(VFX_JSON);
  const K = X.kinds.find((k) => k.id === kind);
  if (!K) return { error: `unknown effect kind: ${kind}` };
  const clean = {};
  for (const q of K.params) {
    const v = settings?.[q.key];
    if (q.type === 'color') clean[q.key] = /^#[0-9a-f]{6}$/i.test(v) ? v : q.default;
    else if (q.type === 'bool') clean[q.key] = v === undefined ? q.default : !!v;
    else if (q.type === 'choice') clean[q.key] = q.options.some((o) => o.id === v) ? v : q.default;
    else clean[q.key] = Math.min(q.max, Math.max(q.min, Number(v ?? q.default)));
  }
  // Besvärjelser: lagren som lagts till (Add a layer), bara mallar som finns
  if (kind === 'spell' && Array.isArray(settings?.extra)) clean.extra = [...new Set(settings.extra.filter((id) => X.layerTemplates?.[id]))];
  const file = path.join(ROOT, VFX_SAVED, `${name}.vfx.json`);
  if (existsSync(file) && !overwrite) return { exists: true };
  await mkdir(path.dirname(file), { recursive: true });
  const entry = { name, kind, settings: clean, ...fromOf(from), saved: new Date().toISOString() };
  await writeFile(file, JSON.stringify(entry, null, 2) + '\n');
  return { entry, file: `${VFX_SAVED}/${name}.vfx.json` };
}
// --- Väderkvarnen, flikarna Väder och Vatten (docs/effektlabb.md, E4 och E3): spakar, färdiga lägen och platserna
// (tools/<område>/<område>.json), sparade recept i assets/<område>/<namn>.<område>.json. Spakar med recipe: false
// (vattnets scen och himmel) sparas inte ---
// extra: fält utanför spakarna som får sparas, med en funktion som rensar värdet (svarar null för att hoppa över)
function recipeStore(area, { extra = {} } = {}) {
  const JSON_FILE = `tools/${area}/${area}.json`, SAVED = `assets/${area}`, EXT = `.${area}.json`;
  return {
    async info() {
      const X = await readJson(JSON_FILE);
      const dir = path.join(ROOT, SAVED);
      const saved = existsSync(dir) ? (await Promise.all((await readdir(dir)).filter((f) => f.endsWith(EXT)).map((f) => readJson(`${SAVED}/${f}`)))).filter(Boolean) : [];
      return { ...X, saved: saved.sort((a, b) => String(b.saved).localeCompare(String(a.saved))) };
    },
    // layers: lager som inte är spakar (Kartrummets målade biomer och regioner, skulpteringen), som base64-text, högst 8 miljoner tecken totalt
    async save({ name, settings, overwrite, from, layers, ...rest }) {
      name = String(name ?? '').trim().toLowerCase();
      if (!NAME.test(name)) return { error: 'the name may only contain a–z, 0–9 and _' };
      const X = await readJson(JSON_FILE);
      const clean = {};
      for (const q of X.params) {
        if (q.recipe === false) continue;
        const v = settings?.[q.key];
        if (q.type === 'color') clean[q.key] = /^#[0-9a-f]{6}$/i.test(v) ? v : q.default;
        else if (q.type === 'bool') clean[q.key] = v === undefined ? q.default : !!v;
        else if (q.type === 'choice') clean[q.key] = q.options.some((o) => o.id === v) ? v : q.default;
        else clean[q.key] = Math.min(q.max, Math.max(q.min, Number(v ?? q.default)));
      }
      const file = path.join(ROOT, SAVED, `${name}${EXT}`);
      if (existsSync(file) && !overwrite) return { exists: true };
      await mkdir(path.dirname(file), { recursive: true });
      const lay = Object.fromEntries(Object.entries(layers && typeof layers === 'object' ? layers : {}).filter(([k, v]) => /^\w{1,40}$/.test(k) && typeof v === 'string' && v && /^[A-Za-z0-9+/=]*$/.test(v)));
      if (Object.values(lay).reduce((n, v) => n + v.length, 0) > 8000000) return { error: 'the layers are too large' };
      const more = Object.fromEntries(Object.entries(extra).map(([k, fn]) => [k, fn(rest[k], X)]).filter(([, v]) => v != null));
      const entry = { name, settings: clean, ...more, ...(Object.keys(lay).length ? { layers: lay } : {}), ...fromOf(from), saved: new Date().toISOString() };
      await writeFile(file, JSON.stringify(entry, null, 2) + '\n');
      return { entry, file: `${SAVED}/${name}${EXT}` };
    },
  };
}
// Kartrummets regioner (docs/terrain.md, steget Regions): högst 16, med namn, tema, mittpunkt (andelar av världen, eller
// automatisk) och justeringar inom spakarnas gränser i terrain.json (regionParams)
function cleanRegions(list, X) {
  if (!Array.isArray(list) || !list.length) return null;
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return list.slice(0, 16).map((r, i) => {
    const out = { name: String(r?.name ?? `Region ${i + 1}`).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || `Region ${i + 1}`, theme: X.regionThemes?.[r?.theme] ? r.theme : 'temperate' };
    if (Array.isArray(r?.at) && r.at.length === 2) out.at = r.at.map((v) => num(v, -0.5, 0.5, 0));
    if (/^#[0-9a-f]{6}$/i.test(r?.color ?? '')) out.color = r.color;
    const adj = Object.fromEntries((X.regionParams ?? []).map((q) => [q.key, num(r?.adjust?.[q.key], q.min, q.max, q.default)]).filter(([, v]) => v !== 0));
    if (Object.keys(adj).length) out.adjust = adj;
    return out;
  });
}
// Kartrummets grävda vatten (steget Sculpt): högst 32 linjer med 2–64 punkter (andelar av världen), av en sort i channelKinds
function cleanChannels(list, X) {
  if (!Array.isArray(list) || !list.length) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.min(0.5, Math.max(-0.5, Number(v))) : 0);
  const out = list.slice(0, 32).filter((c) => X.channelKinds?.[c?.kind] && Array.isArray(c.points) && c.points.length >= 2)
    .map((c) => ({ kind: c.kind, points: c.points.slice(0, 64).map((p) => [num(p?.[0]), num(p?.[1])]) }));
  return out.length ? out : null;
}
// Kartrummets målade marklager (steget Paint): högst 8 platser, var och en en marktextur ur groundTextures (eller tom),
// i samma ordning som vikterna i layers.groundPaint
function cleanPaintLayers(list, X) {
  if (!Array.isArray(list) || !list.some(Boolean)) return null;
  const known = new Map((X.groundTextures ?? []).map((t) => [t.id, t]));
  return list.slice(0, 8).map((p) => (p && known.has(p.texture) ? { texture: p.texture, metres: Math.min(20, Math.max(0.5, Number(p.metres) || known.get(p.texture).metres)) } : null));
}
// Kartrummets utplacering (steget Populate): frö, täthet och detaljavstånd, och per lager på/av och täthet
function cleanPopulate(v, X) {
  if (!v || typeof v !== 'object') return null;
  const num = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : d);
  const ids = new Set((X.populate?.layers ?? []).map((l) => l.id));
  const layers = Object.fromEntries(Object.entries(v.layers ?? {}).filter(([id]) => ids.has(id)).map(([id, l]) => [id, { on: l?.on !== false, density: num(l?.density, 0, 2, 1) }]));
  return { seed: Math.round(num(v.seed, 1, 999, 1)), density: num(v.density, 0, 2, 1), detail: num(v.detail, 0.3, 3, 1), layers };
}
const weatherStore = recipeStore('weather'), waterStore = recipeStore('water'), terrainStore = recipeStore('terrain', { extra: { regions: cleanRegions, channels: cleanChannels, paintLayers: cleanPaintLayers, populate: cleanPopulate } }); // Kartrummet: docs/terrain.md
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
    const m = await riggedModel(GLADE, it.id, gen, recipe, newest);
    if (m.error) { errors.push(`${it.id}: ${m.error}`); continue; }
    items.push({ ...it, url: m.url, rigged: true, checks: m.checks });
  }
  return { items, errors, grass: W.grass, flag: W.flag };
}

// --- Grafikkort (docs/asset-studio.md, Grafikkort): en webbsida kan inte byta grafikkort själv (på Linux väljer
// webbläsaren kort när den startar). Servern listar korten med cardwire eller switcherooctl och kan starta studion i ett eget
// appfönster på valt kort, med en egen profil per kort (annars öppnas bara en flik i den Chrome som redan kör).
// Sidorna rapporterar vilket kort de faktiskt ritar på (/api/gpu/seen), så att menyn kan visa det.
const onHost = (cmd) => (existsSync('/run/.toolboxenv') || existsSync('/run/.containerenv') ? ['host-spawn', ...cmd] : cmd);
function capture(cmd) {
  return new Promise((resolve) => {
    const [c, ...args] = onHost(cmd);
    const p = spawn(c, args);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out : null));
  });
}
const gpuSeen = [];
// cardwire (Bazzite) eller switcherooctl (Fedora m.fl.; på Bazzite ett avvecklat omslag som bara varnar utan terminal)
let gpuTool = null;
async function gpuTool_() {
  if (gpuTool) return gpuTool;
  for (const t of ['cardwire', 'switcherooctl']) if ((await capture(['sh', '-c', `command -v ${t}`]))?.trim()) return (gpuTool = t);
  return null;
}
// Stänger provfönstrens Chrome (profilen för prov): först snällt, och lever det kvar efter två sekunder med SIGKILL
// (Chrome bryr sig ibland inte om SIGTERM strax efter start med en ny profil). Mönstret med [a] matchar inte sig självt.
const closeTest = () => capture(['sh', '-c', 'pkill -f "[a]sset-studio-test"; sleep 2; pkill -9 -f "[a]sset-studio-test"; true']);
async function gpuList() {
  const tool = await gpuTool_();
  const out = tool ? await capture([tool, 'list']) : null;
  const gpus = [];
  for (const line of (out ?? '').split(/\r?\n/)) {
    const m = line.match(/^(\d+)\s+(.+?)\s{2,}\S+\s+(renderD\d+)\s+\S+\s+\((.)\)\s+\((.)\)/);
    if (m) gpus.push({ id: Number(m[1]), name: m[2].trim(), render: m[3], default: m[4] === '*', discrete: m[5] === '*' });
  }
  const apps = (await capture(['flatpak', 'list', '--app', '--columns=application'])) ?? '';
  const browser = ['com.google.Chrome', 'org.chromium.Chromium'].find((b) => apps.split(/\r?\n/).map((x) => x.trim()).includes(b)) ?? null;
  return { gpus, browser, canLaunch: gpus.length > 1 && !!browser, seen: gpuSeen.slice(-6) };
}
// test: ett provfönster (?shot=) med en egen profil, så att det kan stängas helt efteråt (gpuCloseTest) utan att
// röra studiofönster som redan är öppna; vanliga fönster delar en profil per kort och öppnas i samma Chrome
// headless (bara med test): utan fönster, så att proven ritar även när skärmen är låst eller släckt (då står ett
// vanligt fönster stilla på 0 fps). Ingen WebGPU utan fönster, så sidan ritar med WebGL2 på samma kort.
async function gpuLaunch({ id, path: page, test = false, headless = false }) {
  const { gpus, browser, canLaunch } = await gpuList();
  // id: kortets nummer, eller 'discrete' för det snabba kortet (genvägen i appmenyn, tools/studio/launch.sh)
  const gpu = id === 'discrete' ? gpus.find((g) => g.discrete) ?? gpus[0] : gpus.find((g) => g.id === id);
  if (!canLaunch || !gpu) return { error: 'cannot start on that graphics card here' };
  id = gpu.id;
  if (!/^\/studio\/[\w./?=&#%-]*$/.test(String(page ?? ''))) return { error: 'bad page' };
  // Fönstret får sitt kortval med sig (gpu=), som förval för WebGPU:s adapter i den profilen
  const u = new URL(page, 'http://localhost');
  u.searchParams.set('gpu', gpu.discrete ? 'high-performance' : 'low-power');
  if (test) u.searchParams.set('test', '1');
  const url = `http://localhost:${PORT}${u.pathname}${u.search}${u.hash}`;
  const profile = path.join(process.env.HOME, `.var/app/${browser}/data/asset-studio-${test ? 'test' : `gpu${id}`}`);
  // Provprofilen töms före varje prov: ingen cachad kod eller gammalt tillstånd från förra provet
  if (test) await rm(profile, { recursive: true, force: true });
  // Kortet väljs med miljövariabler (PRIME för NVIDIA, DRI_PRIME för Mesa), inte med cardwire launch: dess låsning
  // av Vulkan-drivrutinerna gör att Vulkan inte startar i Flatpak-Chrome, och då hamnar WebGPU på processorn
  // (SwiftShader). X11 (XWayland) i stället för Wayland: Chrome med Vulkan och NVIDIA fungerar inte på Wayland.
  const env = /nvidia/i.test(gpu.name) && !gpu.default ? ['__NV_PRIME_RENDER_OFFLOAD=1', '__GLX_VENDOR_LIBRARY_NAME=nvidia'] : gpu.default ? [] : ['DRI_PRIME=1'];
  // --class: fönstrets klass i X11, så att dockan och aktivitetsfältet visar Asset Studio med sin ikon (StartupWMClass)
  const mode = test && headless ? ['--headless=new', '--window-size=1280,1280', url] : ['--ozone-platform=x11', '--class=asset-studio', `--app=${url}`];
  const [c, ...args] = onHost(['env', ...env, 'flatpak', 'run', browser, `--user-data-dir=${profile}`, ...mode,
    '--enable-features=Vulkan', '--no-first-run', '--no-default-browser-check']); // WebGPU går på Vulkan; --enable-unsafe-webgpu behövs inte och ger en varningsrad
  const p = spawn(c, args, { detached: true, stdio: 'ignore' });
  p.unref();
  // Ett osynligt prov som aldrig skickar sin bild får inte ligga kvar och dra ström (10 minuter räcker för alla världar)
  if (test && headless) setTimeout(closeTest, 600_000);
  return { ok: true, gpu: gpu.name, url, headless: test && headless };
}

async function api(req, res, url) {
  if (url.pathname === '/api/gpus' && req.method === 'GET') return json(res, 200, await gpuList());
  if (url.pathname === '/api/gpu/launch' && req.method === 'POST') return json(res, 200, await gpuLaunch(await body(req)));
  if (url.pathname === '/api/gpu/close-test' && req.method === 'POST') {
    // Stänger provfönstrens Chrome (profilen asset-studio-test); mönstret med [a] matchar inte kommandot självt
    await closeTest();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/gpu/seen' && req.method === 'POST') {
    const b = await body(req);
    gpuSeen.push({ gpu: String(b.gpu ?? '').slice(0, 160), api: String(b.api ?? '').slice(0, 40), webgpu: b.webgpu ? String(b.webgpu).slice(0, 80) : null, page: String(b.page ?? '').slice(0, 80), at: new Date().toISOString() });
    if (gpuSeen.length > 50) gpuSeen.shift();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/wind' && req.method === 'GET') return json(res, 200, await windInfo());
  if (url.pathname === '/api/wind/save' && req.method === 'POST') return json(res, 200, await windSave(await body(req)));
  if (url.pathname === '/api/wind/plant' && req.method === 'GET') return json(res, 200, await windPlant(url.searchParams.get('preset'), Number(url.searchParams.get('seed'))));
  if (url.pathname === '/api/grass' && req.method === 'GET') return json(res, 200, await grassInfo());
  if (url.pathname === '/api/grass/save' && req.method === 'POST') return json(res, 200, await grassSave(await body(req)));
  if (url.pathname === '/api/vfx' && req.method === 'GET') return json(res, 200, await vfxInfo());
  if (url.pathname === '/api/vfx/save' && req.method === 'POST') return json(res, 200, await vfxSave(await body(req)));
  if (url.pathname === '/api/weather' && req.method === 'GET') return json(res, 200, await weatherStore.info());
  if (url.pathname === '/api/weather/save' && req.method === 'POST') return json(res, 200, await weatherStore.save(await body(req)));
  if (url.pathname === '/api/water' && req.method === 'GET') return json(res, 200, await waterStore.info());
  if (url.pathname === '/api/water/save' && req.method === 'POST') return json(res, 200, await waterStore.save(await body(req)));
  if (url.pathname === '/api/terrain' && req.method === 'GET') return json(res, 200, await terrainStore.info());
  if (url.pathname === '/api/terrain/save' && req.method === 'POST') return json(res, 200, await terrainStore.save(await body(req)));
  if (url.pathname === '/api/wind/glade' && req.method === 'GET') {
    gladeBusy ??= windGlade().finally(() => { gladeBusy = null; }); // flera flikar som frågar samtidigt får samma bygge
    return json(res, 200, await gladeBusy);
  }
  if (url.pathname === '/api/generators' && req.method === 'GET') {
    const out = {};
    for (const [id, g] of Object.entries(GENERATORS)) {
      const params = JSON.parse(await readFile(path.join(ROOT, g.params), 'utf8'));
      const file = JSON.parse(await readFile(path.join(ROOT, g.species), 'utf8')), all = g.speciesKey ? file[g.speciesKey] : file;
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
    // Från ett provfönster (test=1, profilen asset-studio-test): stäng det när bilden är sparad
    if (url.searchParams.get('test') === '1') setTimeout(closeTest, 300);
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
