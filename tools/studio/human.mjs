// The Character Creator i Asset Studio (studio/human.js, docs/asset-studio.md): serverns del. Kör character creatorns
// verktyg (tools/character/human/: make_human.py, fit_human.py) med recept ur studion och svarar som jobb, så att
// studion aldrig kör verktyg själv. GLB-filer skrivs aldrig över: ett namn som redan finns nekas.
//
// GET  /api/human               spakarna (params.json + reglage ur human_sliders.json), mallar, sparade figurer,
//                               inpassningar, AI-former att passa in, länkar och en pågående inpassning
// POST /api/human/build         { recipe } -> { job }: förhandsfigur i build/studio/human/ (ca 4 s)
// POST /api/human/save          { name, recipe, thumbnail, from } -> { job }: assets/characters/<name>/ + recipe.json
// POST /api/human/fit           { name, target, sex, age, subdiv, wrap, symmetric, fine } -> { job }: fit_human.py
//                               (minuter); figuren i assets/characters/<name>/, beviset build/human/fit/<name>/overlay.png
// POST /api/human/upload?name=  GLB i kroppen -> build/human/targets/<name>.glb (en AI-form att passa in)
// POST /api/human/thumb         { name, thumbnail } -> <name>_thumb.jpg för en sparad figur som saknar miniatyr
// POST /api/human/editor        startar Body Editor på värden (tools/character/body/editor/launch.sh)
// GET  /api/human/job?id=       ett jobbs status eller resultat

import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, rm, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HUMAN = 'tools/character/human';
const PREV = 'build/studio/human', KEEP = 24;
const CHARS = 'assets/characters', FITS = 'build/human/fit', TARGETS = 'build/human/targets';
// Där AI-formerna (Pixal3D-GLB) brukar hamna: Darrowmeres nedladdningar och figurernas arbetsmappar
const TARGET_DIRS = [TARGETS, 'build/darrowmere/pixal3d', 'build/characters', 'build/maren/pixal3d'];
const NAME = /^[a-z0-9][a-z0-9_]{0,47}$/;
const MACROS = ['sex', 'age', 'muscle', 'weight', 'height', 'proportions', 'bust_size', 'bust_firmness', 'mons']; // mons: human_blender.py, 0..1

export function createHumanApi({ ROOT, onHost }) {
  const readJson = async (f) => JSON.parse(await readFile(path.join(ROOT, f), 'utf8'));
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const inside = (p) => { const a = path.resolve(ROOT, p); return a.startsWith(ROOT + path.sep) ? a : null; };

  // Ett verktyg med ett recept; svaret är dess sista rad JSON
  function run(script, recipe) {
    return new Promise((resolve) => {
      const p = spawn('python3', ['-I', path.join(ROOT, script), JSON.stringify(recipe)], { cwd: ROOT });
      let out = '', err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => resolve({ ok: false, error: String(e.message ?? e) }));
      p.on('close', () => {
        const last = (s) => { try { return JSON.parse(s.trim().split('\n').pop()); } catch { return null; } };
        resolve(last(out) ?? last(err) ?? { ok: false, error: (err || out).trim().slice(-500) || 'no response' });
      });
    });
  }

  // Jobben: bygg och spara i en kö (Blender, ca 4 s styck), en inpassning i taget vid sidan av
  const jobs = new Map();
  let counter = 0, queue = Promise.resolve(), fitting = null;
  function job(kind, name, fn) {
    const id = `h${++counter}`, j = { id, kind, name, t0: Date.now(), done: false, result: null };
    jobs.set(id, j);
    const p = kind === 'fit' ? fn() : (queue = queue.then(fn, fn));
    p.then((r) => r, (e) => ({ ok: false, error: String(e?.message ?? e) })).then((r) => {
      Object.assign(j, { done: true, result: { ...r, ms: Date.now() - j.t0 } });
      if (fitting === id) fitting = null;
      setTimeout(() => jobs.delete(id), 3600_000);
    });
    return j;
  }
  const status = (j) => (j.done ? { ...j.result, done: true, kind: j.kind, name: j.name } : { pending: true, job: j.id, kind: j.kind, name: j.name, since: j.t0 });

  // Receptet från studion: bara kända fält, inom gränserna
  async function cleanRecipe(r = {}) {
    const cat = await readJson(`${HUMAN}/human_sliders.json`), ids = new Set(cat.sliders.map((s) => s.id));
    const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
    const out = {};
    for (const k of MACROS) if (r[k] != null) out[k] = k === 'age' ? num(r[k], 18, 90) : num(r[k], 0, 1);
    out.sliders = {};
    for (const [k, v] of Object.entries(r.sliders ?? {})) if (ids.has(k) && num(v, -1, 1)) out.sliders[k] = num(v, -1, 1);
    if (r.pose === 'T' || r.pose === 'A') out.pose = r.pose; else if (r.pose != null) out.pose = num(r.pose, 0, 90);
    if (r.arm_forward != null) out.arm_forward = num(r.arm_forward, 0, 45);
    if (r.leg_spread != null) out.leg_spread = num(r.leg_spread, 0, 30);
    if (r.subdiv != null) out.subdiv = Number(r.subdiv) ? 1 : 0;
    // Inpassningens wrap (fit_blender.py): bara en wrap.npz under build/human/fit/
    const w = typeof r.wrap === 'string' && inside(r.wrap);
    if (w && rel(w).startsWith(`${FITS}/`) && w.endsWith('/wrap.npz') && existsSync(w)) out.wrap = w;
    return out;
  }
  const withUrls = (res) => (res.glb ? { ...res, url: `/${res.pose_glb ?? res.glb}`, rigged: `/${res.glb}` } : res);

  async function clean(dir, keep) {
    const d = path.join(ROOT, dir);
    if (!existsSync(d)) return;
    const es = await Promise.all((await readdir(d)).map(async (n) => ({ n, t: (await stat(path.join(d, n))).mtimeMs })));
    es.sort((a, b) => b.t - a.t);
    await Promise.all(es.slice(keep).map((e) => rm(path.join(d, e.n), { recursive: true, force: true })));
  }

  async function build({ recipe }) {
    const r = await cleanRecipe(recipe), name = `p${Date.now().toString(36)}${(counter + 1).toString(36)}`;
    return job('build', name, async () => {
      const res = await run(`${HUMAN}/make_human.py`, { ...r, name, out_dir: `${PREV}/${name}` });
      clean(PREV, KEEP).catch(() => {});
      return withUrls(res);
    });
  }

  const taken = (name) => existsSync(path.join(ROOT, CHARS, name)) || existsSync(path.join(ROOT, FITS, name));
  async function save({ name, recipe, thumbnail, from }) {
    name = String(name ?? '').trim().toLowerCase();
    if (!NAME.test(name)) return { error: 'the name may only have a–z, 0–9 and _ (at most 48 characters)' };
    if (taken(name)) return { error: `${name} already exists; models are never overwritten, pick a new name`, exists: true };
    const r = await cleanRecipe(recipe);
    return { job: job('save', name, async () => {
      const res = await run(`${HUMAN}/make_human.py`, { ...r, name });
      if (!res.glb) return res;
      const dir = path.join(ROOT, CHARS, name);
      let thumb = null;
      const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(thumbnail ?? '');
      if (m) { thumb = `${CHARS}/${name}/${name}_thumb.${m[1] === 'png' ? 'png' : 'jpg'}`; await writeFile(path.join(ROOT, thumb), Buffer.from(m[2], 'base64')); }
      await writeFile(path.join(dir, 'recipe.json'), JSON.stringify({ ...r, name, from: from ?? null, saved: new Date().toISOString(), tris: res.tris, height_m: res.height_m, checks: res.checks }, null, 1) + '\n');
      return withUrls({ ...res, thumbnail: thumb });
    }).id };
  }

  async function fit({ name, target, sex = 0, age = 25, subdiv = 1, wrap = true, symmetric = true, fine = true }) {
    name = String(name ?? '').trim().toLowerCase();
    if (!NAME.test(name)) return { error: 'the name may only have a–z, 0–9 and _ (at most 48 characters)' };
    if (taken(name)) return { error: `${name} already exists; models are never overwritten, pick a new name`, exists: true };
    const t = typeof target === 'string' && inside(target);
    if (!t || !/\.glb$/i.test(t) || !existsSync(t)) return { error: 'pick an AI shape (a GLB in the project) to fit' };
    if (fitting) return { error: 'a fit is already running; wait for it to finish', job: fitting };
    const r = { name, target: rel(t), sex: Math.min(1, Math.max(0, Number(sex) || 0)), age: Math.max(18, Number(age) || 25), subdiv: Number(subdiv) ? 1 : 0, wrap: !!wrap, symmetric: !!symmetric, fine: !!fine };
    const j = job('fit', name, async () => {
      const res = await run(`${HUMAN}/fit_human.py`, r);
      if (res.glb) {
        const { wrap: w, ...rest } = res.recipe ?? {};
        await writeFile(path.join(ROOT, CHARS, name, 'recipe.json'), JSON.stringify({ ...rest, wrap: w ? rel(w) : undefined, name, from: 'fit', target: r.target, overlay: res.overlay, saved: new Date().toISOString(), fit: { start: res.start, end: res.end, wrap: res.wrap } }, null, 1) + '\n').catch(() => {});
      }
      return withUrls({ ...res, overlay: res.overlay ? `/${res.overlay}` : null, target: r.target });
    });
    fitting = j.id;
    return { job: j.id };
  }

  async function upload(req, name) {
    name = String(name ?? '').trim().toLowerCase().replace(/\.glb$/, '').replace(/[^a-z0-9_]/g, '_').slice(0, 40) || 'shape';
    if (!/^[a-z0-9]/.test(name)) name = `s${name}`;
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 300 * 1024 * 1024) return { error: 'the file is larger than 300 MB' }; chunks.push(c); }
    const data = Buffer.concat(chunks);
    if (data.subarray(0, 4).toString('latin1') !== 'glTF') return { error: 'not a GLB file' };
    await mkdir(path.join(ROOT, TARGETS), { recursive: true });
    let n = name, k = 2;
    while (existsSync(path.join(ROOT, TARGETS, `${n}.glb`))) n = `${name}_${k++}`; // skrivs aldrig över
    await writeFile(path.join(ROOT, TARGETS, `${n}.glb`), data);
    return { ok: true, path: `${TARGETS}/${n}.glb`, name: n, size };
  }

  // AI-formerna: GLB med pixal3d i namnet (eller uppladdade), nyast först
  async function targets() {
    const found = [];
    async function walk(d, depth) {
      const abs = path.join(ROOT, d);
      if (!existsSync(abs)) return;
      for (const e of await readdir(abs, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory() && depth > 0) await walk(p, depth - 1);
        else if (e.isFile() && /\.glb$/i.test(e.name) && (d === TARGETS || /pixal/i.test(e.name))) {
          const st = await stat(path.join(ROOT, p));
          found.push({ path: p, name: e.name.replace(/\.glb$/i, ''), size: st.size, t: st.mtimeMs });
        }
      }
    }
    for (const d of TARGET_DIRS) await walk(d, 2);
    return found.sort((a, b) => b.t - a.t).slice(0, 60);
  }

  // Sparade figurer (assets/characters/<namn>/<namn>.glb), med recept, miniatyr och inpassningens bevis
  async function saved() {
    const dir = path.join(ROOT, CHARS), out = [];
    if (!existsSync(dir)) return out;
    for (const n of await readdir(dir)) {
      const glb = `${CHARS}/${n}/${n}.glb`;
      if (!existsSync(path.join(ROOT, glb))) continue;
      const st = await stat(path.join(ROOT, glb));
      const recipe = await readJson(`${CHARS}/${n}/recipe.json`).catch(() => readJson(`${FITS}/${n}/recipe.json`).then((r) => ({ ...r, from: 'fit' })).catch(() => null));
      const thumb = ['jpg', 'png'].map((x) => `${CHARS}/${n}/${n}_thumb.${x}`).find((f) => existsSync(path.join(ROOT, f)));
      const overlay = existsSync(path.join(ROOT, FITS, n, 'overlay.png')) ? `/${FITS}/${n}/overlay.png` : null;
      const pose = existsSync(path.join(ROOT, CHARS, n, `${n}_pose.glb`)) ? `/${CHARS}/${n}/${n}_pose.glb` : null;
      out.push({ name: n, url: pose ?? `/${glb}`, rigged: `/${glb}`, recipe, thumbnail: thumb ? `/${thumb}` : null, overlay, t: st.mtimeMs });
    }
    return out.sort((a, b) => b.t - a.t);
  }

  async function info() {
    const P = await readJson(`${HUMAN}/params.json`), cat = await readJson(`${HUMAN}/human_sliders.json`);
    // Ett reglage i human_sliders.json som saknas i params.json kommer ändå med, med sin etikett
    const have = new Set(P.params.map((q) => q.key)), added = [];
    for (const s of cat.sliders) if (!have.has(s.id)) {
      added.push(s.id);
      P.params.push({ key: s.id, label: s.label, group: String(s.group ?? 'body').toLowerCase(), in: 'sliders', min: -1, max: 1, step: 0.01, default: 0 });
    }
    return { ...P, added, saved: await saved(), targets: await targets(), fitting: fitting ? status(jobs.get(fitting)) : null };
  }

  // En miniatyr till en sparad figur som saknar en (inpassningar), gjord av studion när figuren öppnas
  async function thumb({ name, thumbnail }) {
    if (!NAME.test(name ?? '') || !existsSync(path.join(ROOT, CHARS, name, `${name}.glb`))) return { error: 'no such figure' };
    if (['jpg', 'png'].some((x) => existsSync(path.join(ROOT, CHARS, name, `${name}_thumb.${x}`)))) return { error: 'it already has a thumbnail' };
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(thumbnail ?? '');
    if (!m) return { error: 'a JPEG data URL is needed' };
    const f = `${CHARS}/${name}/${name}_thumb.jpg`;
    await writeFile(path.join(ROOT, f), Buffer.from(m[1], 'base64'));
    return { ok: true, thumbnail: `/${f}` };
  }

  function editor() {
    return new Promise((resolve) => {
      const [c, ...args] = onHost(['sh', path.join(ROOT, 'tools/character/body/editor/launch.sh')]);
      const p = spawn(c, args, { detached: true, stdio: 'ignore' });
      p.on('error', (e) => resolve({ ok: false, error: String(e.message ?? e) }));
      p.unref();
      setTimeout(() => resolve({ ok: true }), 300);
    });
  }

  // Svarar true när förfrågan var en av figurernas
  return async function handle(req, res, url, { json, body }) {
    const p = url.pathname;
    if (!p.startsWith('/api/human')) return false;
    if (p === '/api/human' && req.method === 'GET') json(res, 200, await info());
    else if (p === '/api/human/build' && req.method === 'POST') json(res, 200, { job: (await build(await body(req))).id });
    else if (p === '/api/human/save' && req.method === 'POST') json(res, 200, await save(await body(req)));
    else if (p === '/api/human/fit' && req.method === 'POST') json(res, 200, await fit(await body(req)));
    else if (p === '/api/human/upload' && req.method === 'POST') json(res, 200, await upload(req, url.searchParams.get('name')));
    else if (p === '/api/human/thumb' && req.method === 'POST') json(res, 200, await thumb(await body(req)));
    else if (p === '/api/human/editor' && req.method === 'POST') json(res, 200, await editor());
    else if (p === '/api/human/job' && req.method === 'GET') {
      const j = jobs.get(url.searchParams.get('id') ?? '');
      json(res, 200, j ? status(j) : { error: 'no such job (the server may have restarted)' });
    } else return false;
    return true;
  };
}
