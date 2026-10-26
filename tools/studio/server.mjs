// Asset Studio: lokal server för studion (studio/index.html). Serverar projektroten och ett litet API som kör
// generatorerna, så att studion aldrig kör verktyg själv (README: klient och server via eget API).
// Plan: docs/asset-studio.md. Antar ingen webbläsare och inget Electron.
//
//   node tools/studio/server.mjs [port]        (standard 8770, lyssnar bara på 127.0.0.1)
//
// GET  /api/generators              generatorer med spakar (params.json) och arternas standardvärden
// POST /api/generate                { generator, recipe } -> förhandsvisning i build/studio/, svar med modell och checks
// GET  /api/textures?kind=bark      texturer att välja bland (leaves, bark)
// GET  /api/library                 bibliotekets katalog (assets/library.json)
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
      resolve(last(out) ?? (last(err)?.error ? last(err) : { error: (err || out).trim().slice(-500) || 'inget svar' }));
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
  ['preset', 'seed', 'height', 'species', 'canopy', 'leaves', 'bark', 'leaf_tint', 'bark_repeat', 'bark_blend'].includes(k)));

async function generate({ generator = 'tree', recipe }) {
  const g = GENERATORS[generator];
  if (!g) return { error: `okänd generator ${generator}` };
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
  return names.sort().map((n) => ({ name: n, url: `/assets/textures/${n}.png`, thumb: `/${THUMBS}/${n}_${THUMB_PX}.jpg` }));
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
  if (!j) return { error: 'jobbet finns inte (servern kan ha startats om)' };
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
  if (!g) return { error: `okänd generator ${generator}` };
  if (!NAME.test(name ?? '')) return { error: 'namnet får bara ha a–z, 0–9 och _ (högst 48 tecken)' };
  const dir = path.join(ROOT, g.assets, name);
  if (existsSync(dir) && !overwrite) return { error: `${name} finns redan`, exists: true };
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
    name, type: generator, tags: tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase()),
    model: result.model, recipe: `${g.assets}/${name}/recipe.json`, thumbnail: thumb, checks_ok: result.checks?.ok ?? null,
    saved: new Date().toISOString(),
  };
  lib.items = [...lib.items.filter((i) => !(i.type === generator && i.name === name)), entry];
  await writeFile(LIBRARY, JSON.stringify(lib, null, 2) + '\n');
  return { entry, checks: result.checks };
}

async function api(req, res, url) {
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
  if (url.pathname === '/api/library' && req.method === 'GET') return json(res, 200, await readLibrary());
  if (url.pathname === '/api/library' && req.method === 'POST') return json(res, 200, await saveToLibrary(await body(req)));
  if (url.pathname === '/api/shot' && req.method === 'POST') {
    // Skärmdump av studions 3D-vy (för tavlor och dokumentation): PNG-data -> build/shots/studio_<namn>.png
    const name = url.searchParams.get('name') ?? '';
    if (!/^[a-z0-9_-]{1,64}$/i.test(name)) return json(res, 400, { error: 'name: a-z, 0-9, _ och -' });
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
  if (url.pathname === '/api/texture/save' && req.method === 'POST') return json(res, 200, await textureSave(await body(req)));
  if (url.pathname === '/api/texture/recipe' && req.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    const file = path.join(ROOT, 'assets/textures', `${name}.texture.json`);
    if (!NAME.test(name) || !existsSync(file)) return json(res, 404, { error: 'inget recept för den texturen' });
    return json(res, 200, JSON.parse(await readFile(file, 'utf8')));
  }
  return json(res, 404, { error: 'okänt anrop' });
}

async function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '/studio') { res.writeHead(302, { Location: '/studio/' }); return res.end(); }
  const file = path.resolve(ROOT, '.' + rel);
  // Bara filer under projektroten, inga dolda filer eller mappar (.git, .env ...)
  if (!file.startsWith(ROOT + path.sep) || file.split(path.sep).some((p) => p.startsWith('.'))) return json(res, 403, { error: 'nekad' });
  try {
    const st = await stat(file);
    const target = st.isDirectory() ? path.join(file, 'index.html') : file;
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'finns inte' });
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
