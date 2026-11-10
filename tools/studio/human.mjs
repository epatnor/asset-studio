// The Character Creator i Asset Studio (studio/human.js, docs/asset-studio.md): serverns del. Kör character creatorns
// verktyg (tools/character/human/: make_human.py, fit_human.py) med recept ur studion och svarar som jobb, så att
// studion aldrig kör verktyg själv. GLB-filer skrivs aldrig över: ett namn som redan finns nekas.
//
// GET  /api/human               spakarna (params.json + reglage ur human_sliders.json), mallar, sparade figurer,
//                               inpassningar, AI-former att passa in, länkar och en pågående inpassning
// POST /api/human/build         { recipe } -> { job }: förhandsfigur i build/studio/human/ (ca 4 s)
// POST /api/human/save          { name, recipe, thumbnail, from } -> { job }: assets/characters/<name>/ + recipe.json
// POST /api/human/fit           { name, target, sex, age, subdiv, wrap, symmetric, fine, ignore_hair } -> { job }: fit_human.py
//                               (minuter); figuren i assets/characters/<name>/, beviset build/human/fit/<name>/overlay.png
// POST /api/human/upload?name=  GLB i kroppen -> build/human/targets/<name>.glb (en AI-form att passa in)
// POST /api/human/edits         { name, proxy, nverts, offsets } -> { job, name, file }: egna ändringar på punkterna
//                               (tools/character/human/EDITS.md) som en ny fil build/human/edits/<namn>_v<n>.json, och
//                               figuren byggd om med dem till <namn>_e<n>
// POST /api/human/bake          { name } -> { job, out }: detaljernas normalkarta (bake_detail.py) till <namn>_detail.glb
// POST /api/human/final         { name, normal, color, skin, roughness } -> { job, out }: den färdiga modellen (make_final.py):
//                               figuren med normalkartan och färgen i en GLB, <namn>_final(_v<n>).glb + .json
// POST /api/human/paint?name=&base=  PNG i kroppen -> <namn>_paint_v<n>_color.png: färgen målad i studion (studio/human_paint.js)
//                               på MPFB:s UV, aldrig över; en .json bredvid minns grunden
// POST /api/human/ref?name=&file=    en referensbild i kroppen (PNG, JPEG, WebP) -> build/human/refs/<namn>/: målningens
//                               bilder sparas per figur och listas som refs
// POST /api/human/genview      { name, render, refs, prompt, aspect, camera, rect, model, denoise, confirm } -> utan confirm ett prisförslag
//                               { quote }, med confirm ett jobb: gpt-image-2 (OpenRouter, tools/texture/openrouter_image.py)
//                               ritar vyn (render, en bild av figuren från en udda vinkel) som en ny referens i samma stil
//                               som refs -> build/human/refs/<namn>/view_<n>.png + .json (kameran, rutan, prompten, kostnaden)
// POST /api/human/thumb         { name, thumbnail } -> <name>_thumb.jpg för en sparad figur som saknar miniatyr
// POST /api/human/editor        startar Body Editor på värden (tools/character/body/editor/launch.sh)
// GET  /api/human/job?id=       ett jobbs status eller resultat

import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, rm, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HUMAN = 'tools/character/human';
const PREV = 'build/studio/human', KEEP = 24;
const CHARS = 'assets/characters', FITS = 'build/human/fit', TARGETS = 'build/human/targets', EDITS = 'build/human/edits', REFS = 'build/human/refs';
// Där AI-formerna (Pixal3D-GLB) brukar hamna: Darrowmeres nedladdningar och figurernas arbetsmappar
const TARGET_DIRS = [TARGETS, 'build/darrowmere/pixal3d', 'build/characters', 'build/maren/pixal3d', 'build/body/build/pixal3d'];
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

  // A tool with plain command-line arguments (krea2.py); the answer is its last JSON line
  function runArgs(script, args) {
    return new Promise((resolve) => {
      const p = spawn('python3', ['-I', path.join(ROOT, script), ...args.map(String)], { cwd: ROOT });
      let out = '', err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => resolve({ ok: false, error: String(e.message ?? e) }));
      p.on('close', () => {
        const last = (x) => { try { return JSON.parse(x.trim().split('\n').pop()); } catch { return null; } };
        resolve(last(out) ?? { ok: false, error: (err || out).trim().slice(-500) || 'no response' });
      });
    });
  }

  // Jobben: bygg och spara i en kö (Blender, ca 4 s styck), en inpassning i taget vid sidan av
  const jobs = new Map();
  let counter = 0, queue = Promise.resolve(), fitting = null, baking = null;
  function job(kind, name, fn) {
    const id = `h${++counter}`, j = { id, kind, name, t0: Date.now(), done: false, result: null };
    jobs.set(id, j);
    const p = kind === 'fit' || kind === 'bake' || kind === 'gen' ? fn() : (queue = queue.then(fn, fn)); // inpassning och bakning vid sidan av kön
    p.then((r) => r, (e) => ({ ok: false, error: String(e?.message ?? e) })).then((r) => {
      Object.assign(j, { done: true, result: { ...r, ms: Date.now() - j.t0 } });
      if (fitting === id) fitting = null;
      if (baking === id) baking = null;
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
    // Nycklar som studion inte har spakar för (t.ex. elbow_flex, elbow_carry ur inpassningen) följer med, så att en
    // figur byggs om som den var: tal och sant/falskt, råa makron och mål med vikter, och namnen på nät och rigg
    for (const [k, v] of Object.entries(r)) {
      if (k in out || ['name', 'out_dir', 'catalog', 'wrap', 'edits'].includes(k) || !/^[a-z][a-z0-9_]{0,31}$/.test(k)) continue;
      if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v;
      else if (['proxy', 'eyes', 'hair', 'rig'].includes(k) && typeof v === 'string' && /^[\w-]{1,48}$/.test(v)) out[k] = v;
      else if (['macro', 'targets'].includes(k) && v && typeof v === 'object')
        out[k] = Object.fromEntries(Object.entries(v).filter(([t, x]) => /^[\w/.-]{1,96}$/.test(t) && !t.includes('..') && Number.isFinite(Number(x))).map(([t, x]) => [t, Number(x)]));
    }
    // Inpassningens wrap (fit_blender.py): bara en wrap.npz under build/human/fit/
    const w = typeof r.wrap === 'string' && inside(r.wrap);
    if (w && rel(w).startsWith(`${FITS}/`) && w.endsWith('/wrap.npz') && existsSync(w)) out.wrap = w;
    // Egna ändringar på punkterna (EDITS.md): bara en ändringsfil under build/human/edits/
    const ed = typeof r.edits === 'string' && inside(r.edits);
    if (ed && rel(ed).startsWith(`${EDITS}/`) && ed.endsWith('.json') && existsSync(ed)) out.edits = rel(ed);
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

  async function fit({ name, target, sex = 0, age = 25, subdiv = 1, wrap = true, symmetric = true, fine = true, ignore_hair = false }) {
    name = String(name ?? '').trim().toLowerCase();
    if (!NAME.test(name)) return { error: 'the name may only have a–z, 0–9 and _ (at most 48 characters)' };
    if (taken(name)) return { error: `${name} already exists; models are never overwritten, pick a new name`, exists: true };
    const t = typeof target === 'string' && inside(target);
    if (!t || !/\.glb$/i.test(t) || !existsSync(t)) return { error: 'pick an AI shape (a GLB in the project) to fit' };
    if (fitting) return { error: 'a fit is already running; wait for it to finish', job: fitting };
    const r = { name, target: rel(t), sex: Math.min(1, Math.max(0, Number(sex) || 0)), age: Math.max(18, Number(age) || 25), subdiv: Number(subdiv) ? 1 : 0, wrap: !!wrap, symmetric: !!symmetric, fine: !!fine, ignore_hair: !!ignore_hair };
    const j = job('fit', name, async () => {
      const res = await run(`${HUMAN}/fit_human.py`, r);
      if (res.glb) {
        const { wrap: w, ...rest } = res.recipe ?? {};
        await writeFile(path.join(ROOT, CHARS, name, 'recipe.json'), JSON.stringify({ ...rest, wrap: w ? rel(w) : undefined, name, from: 'fit', target: r.target, overlay: res.overlay, ai_transform: res.ai_transform, ignore_hair: r.ignore_hair, saved: new Date().toISOString(), fit: { start: res.start, end: res.end, wrap: res.wrap?.end } }, null, 1) + '\n').catch(() => {});
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
        else if (e.isFile() && /\.glb$/i.test(e.name) && (d === TARGETS || /pixal/i.test(p))) {
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
      const edit = existsSync(path.join(ROOT, CHARS, n, `${n}_edit.json`)) ? `/${CHARS}/${n}/${n}_edit.json` : null;
      // Bakade varianter bredvid figuren: detaljernas normalkarta (bake_detail.py) och färg (transfer_texture.py)
      const baked = (await readdir(path.join(ROOT, CHARS, n))).filter((f) => f.endsWith('.glb') && f !== `${n}.glb` && f !== `${n}_pose.glb`)
        .map((f) => ({ file: `/${CHARS}/${n}/${f}`, kind: /_final(_v\d+)?\.glb$/.test(f) ? 'final' : /_detail(_v\d+)?\.glb$/.test(f) ? 'detail' : /_tex/.test(f) ? 'color' : 'other' }));
      for (const b of baked) if (b.kind === 'final') b.info = await readJson(b.file.slice(1).replace(/\.glb$/, '.json')).catch(() => null);
      // Kartorna som den färdiga modellen kan använda: bredvid figuren och hos figuren den byggdes ur (samma UV)
      const maps = { normal: [], color: [] };
      for (const d of [n, typeof recipe?.from === 'string' && recipe.from !== 'fit' ? recipe.from : null]) {
        if (!d || !existsSync(path.join(ROOT, CHARS, d))) continue;
        for (const f of await readdir(path.join(ROOT, CHARS, d))) {
          const kind = /_detail(_v\d+)?_normal\.png$/.test(f) ? 'normal' : /_color\.png$/.test(f) ? 'color' : null;
          if (kind) maps[kind].push({ file: `${CHARS}/${d}/${f}`, t: (await stat(path.join(ROOT, CHARS, d, f))).mtimeMs });
        }
      }
      for (const k of ['normal', 'color']) maps[k] = maps[k].sort((a, b) => b.t - a.t).map((m) => m.file);
      // Målningens referensbilder: figurens egna och dess ursprungs
      const refs = [];
      for (const d of [n, typeof recipe?.from === 'string' && recipe.from !== 'fit' ? recipe.from : null]) {
        if (d && existsSync(path.join(ROOT, REFS, d))) for (const f of (await readdir(path.join(ROOT, REFS, d))).sort()) if (/\.(png|jpe?g|webp)$/i.test(f)) refs.push(`/${REFS}/${d}/${f}`);
      }
      out.push({ name: n, url: pose ?? `/${glb}`, rigged: `/${glb}`, recipe, thumbnail: thumb ? `/${thumb}` : null, overlay, edit, baked, maps, refs, concept: await concept(recipe), t: st.mtimeMs });
    }
    return out.sort((a, b) => b.t - a.t);
  }

  // The figure's concept as a picture prompt: the Darrowmere order (order_recipe.json) next to its AI shape, if any
  async function concept(recipe) {
    if (typeof recipe?.target !== 'string') return null;
    const f = path.join(path.dirname(path.resolve(ROOT, recipe.target)), 'order_recipe.json');
    if (!f.startsWith(ROOT + path.sep) || !existsSync(f)) return null;
    const o = JSON.parse(await readFile(f, 'utf8').catch(() => '{}')).prompt;
    if (!o?.subject) return null;
    const parts = [o.style, `a ${o.subject}${o.bald ? ' with a smooth bald head' : ''}`, o.outfit && `wearing ${o.outfit}`];
    return { order: rel(f), prompt: `${parts.filter(Boolean).join(', ')}, the same pose and camera angle as the picture, plain light grey background, soft even light` };
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

  // Detaljernas normalkarta (bake_detail.py): AI-formens relief på MPFB:s UV, för en inpassad figur (wrap_debug.npz)
  async function bake({ name }) {
    if (!NAME.test(name ?? '') || !existsSync(path.join(ROOT, CHARS, name, `${name}.glb`))) return { error: 'no such figure' };
    if (baking) return { error: 'a bake is already running; wait for it to finish', job: baking };
    const recipe = await readJson(`${CHARS}/${name}/recipe.json`).catch(() => readJson(`${FITS}/${name}/recipe.json`).catch(() => null));
    const w = typeof recipe?.wrap === 'string' && inside(recipe.wrap);
    const fit = w && path.dirname(w);
    if (!fit || !existsSync(path.join(fit, 'wrap_debug.npz'))) return { error: `${name} has no fit with an AI shape to bake from (wrap_debug.npz)` };
    let out = `${CHARS}/${name}/${name}_detail.glb`, v = 2;
    while (existsSync(path.join(ROOT, out))) out = `${CHARS}/${name}/${name}_detail_v${v++}.glb`; // aldrig över
    const r = { fit: rel(fit), pose: `${CHARS}/${name}/${name}_pose.glb`, rigged: `${CHARS}/${name}/${name}.glb`, out };
    const j = job('bake', name, async () => {
      const res = await run(`${HUMAN}/bake_detail.py`, r);
      return { ...res, url: res.out ? `/${res.out}` : null, png: res.png ? `/${res.png}` : null };
    });
    baking = j.id;
    return { job: j.id, out };
  }

  // Den färdiga modellen (make_final.py): figuren, ögonen och skelettet med normalkartan och färgen i en GLB
  async function final({ name, normal, color, skin, roughness }) {
    if (!NAME.test(name ?? '') || !existsSync(path.join(ROOT, CHARS, name, `${name}.glb`))) return { error: 'no such figure' };
    const map = (v, re) => v === undefined || v === 'auto' ? 'auto' : v === null ? null : typeof v === 'string' && re.test(v) && inside(v) && existsSync(inside(v)) ? v : undefined;
    const r = { name, normal: map(normal, /^assets\/characters\/[\w-]+\/[\w-]+_normal\.png$/), color: map(color, /^assets\/characters\/[\w-]+\/[\w-]+_color\.png$/) };
    if (r.normal === undefined || r.color === undefined) return { error: 'a map must be a _normal.png or _color.png under assets/characters' };
    if (skin != null) { if (!/^#[0-9a-f]{6}$/i.test(skin)) return { error: 'skin must be a hex colour like #c9a48c' }; r.skin = skin; }
    if (roughness != null) { const x = Number(roughness); if (!(x >= 0 && x <= 1)) return { error: 'roughness must be 0..1' }; r.roughness = x; }
    let out = `${CHARS}/${name}/${name}_final.glb`, v = 2;
    while (existsSync(path.join(ROOT, out))) out = `${CHARS}/${name}/${name}_final_v${v++}.glb`; // aldrig över
    r.out = out;
    const j = job('final', name, async () => {
      const res = await run(`${HUMAN}/make_final.py`, r);
      return { ...res, url: res.out ? `/${res.out}` : null };
    });
    return { job: j.id, out };
  }

  // En kropp som binärdata, högst max byte
  async function raw(req, max) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > max) return null; chunks.push(c); }
    return Buffer.concat(chunks);
  }
  const IMG = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };
  const kindOf = (b) => Object.entries(IMG).find(([, m]) => m.every((x, i) => b[i] === x))?.[0];

  // Färgen målad i studion: en ny PNG på MPFB:s UV bredvid figuren (hittas av Finished model som en färgkarta)
  async function paint(req, name, base) {
    if (!NAME.test(name ?? '') || !existsSync(path.join(ROOT, CHARS, name, `${name}.glb`))) return { error: 'no such figure' };
    const data = await raw(req, 64 * 1024 * 1024);
    if (!data) return { error: 'the picture is larger than 64 MB' };
    if (kindOf(data) !== 'png') return { error: 'not a PNG' };
    let v = 1;
    while (existsSync(path.join(ROOT, CHARS, name, `${name}_paint_v${v}_color.png`))) v++; // aldrig över
    const f = `${CHARS}/${name}/${name}_paint_v${v}_color.png`;
    await writeFile(path.join(ROOT, f), data);
    await writeFile(path.join(ROOT, f.replace(/\.png$/, '.json')), JSON.stringify({ base: base || null, saved: new Date().toISOString(), bytes: data.length }, null, 1) + '\n');
    return { ok: true, file: f, bytes: data.length };
  }
  // En referensbild till målningen, sparad per figur
  async function ref(req, name, file) {
    if (!NAME.test(name ?? '') || !existsSync(path.join(ROOT, CHARS, name))) return { error: 'no such figure' };
    const data = await raw(req, 40 * 1024 * 1024);
    if (!data) return { error: 'the picture is larger than 40 MB' };
    const kind = kindOf(data);
    if (!kind) return { error: 'not a PNG, JPEG or WebP picture' };
    const stem = String(file ?? 'ref').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9_-]/g, '_').slice(0, 40) || 'ref';
    await mkdir(path.join(ROOT, REFS, name), { recursive: true });
    let n = stem, k = 2;
    while (existsSync(path.join(ROOT, REFS, name, `${n}.${kind}`))) n = `${stem}_${k++}`;
    await writeFile(path.join(ROOT, REFS, name, `${n}.${kind}`), data);
    return { ok: true, url: `/${REFS}/${name}/${n}.${kind}` };
  }

  // En ny referensbild för en udda vinkel: renderingen från studion (figuren i vinkeln, med det som är målat) och de
  // tidigare referenserna till gpt-image-2, som ritar vyn i samma stil. Kostar pengar: utan confirm bara ett prisförslag.
  let generating = null;
  async function genview({ name, render, refs = [], prompt, aspect, camera, rect, model, denoise, confirm }) {
    const models = (await readJson(`${HUMAN}/params.json`)).paint?.models ?? [];
    const M = models.find((x) => x.id === (model ?? models[0]?.id));
    if (!M) return { error: `unknown picture model ${model}` };
    if (!NAME.test(name ?? '') || !existsSync(path.join(ROOT, CHARS, name))) return { error: 'no such figure' };
    const m = /^data:image\/png;base64,(.+)$/.exec(render ?? '');
    if (!m) return { error: 'the view must be a PNG data URL' };
    if (!['1:1', '2:3', '3:2'].includes(aspect)) return { error: 'aspect must be 1:1, 2:3 or 3:2' };
    if (!Array.isArray(refs) || refs.length > 4) return { error: 'at most four reference pictures' };
    const files = [];
    for (const u of refs) {
      const f = String(u).replace(/^\//, '').replace(/\?.*$/, '');
      if (!/^(build\/human\/refs|assets\/characters)\/[\w-]+\/[\w.-]+\.(png|jpe?g|webp)$/i.test(f) || !inside(f) || !existsSync(inside(f))) return { error: `not a reference picture: ${u}` };
      files.push(f);
    }
    if (typeof prompt !== 'string' || prompt.length < 20 || prompt.length > 4000) return { error: 'the prompt must be 20 to 4000 characters' };
    const d = Math.min(0.95, Math.max(0.15, Number(denoise ?? 0.55)));
    if (!confirm) return { quote: { model: M.id, label: M.label, local: !!M.local, price: M.local ? 'free (local ComfyUI)' : `${M.price} (OpenRouter)`, refs: M.local ? 0 : files.length } };
    if (generating) return { error: 'a picture is already being generated; wait for it', job: generating };
    const dir = `build/human/genview/${name}`;
    await mkdir(path.join(ROOT, dir), { recursive: true });
    await mkdir(path.join(ROOT, REFS, name), { recursive: true });
    let v = 1;
    while (existsSync(path.join(ROOT, REFS, name, `view_${v}.png`)) || existsSync(path.join(ROOT, dir, `render_${v}.png`))) v++; // aldrig över
    const shot = `${dir}/render_${v}.png`, out = `${REFS}/${name}/view_${v}.png`;
    await writeFile(path.join(ROOT, shot), Buffer.from(m[1], 'base64'));
    const j = job('gen', name, async () => {
      // Local Krea-2 repaints the render picture-to-picture at an exact aspect (multiples of 16), so the framing stays
      const [W, H] = { '2:3': [832, 1248], '1:1': [1024, 1024], '3:2': [1248, 832] }[aspect];
      const res = M.local
        ? await runArgs('tools/texture/krea2.py', [prompt, W, H, path.join(ROOT, out), Math.floor(Math.random() * 2 ** 31), '--base', path.join(ROOT, shot), '--denoise', d]).then((r) => (r.out ? { ...r, out } : r))
        : await run('tools/texture/openrouter_image.py', { prompt, out, model: M.id, aspect, refs: [shot, ...files] });
      generating = null;
      if (!res.out) return { ok: false, error: res.error ?? 'no picture' };
      await writeFile(path.join(ROOT, out.replace(/\.png$/, '.json')), JSON.stringify({ render: shot, refs: files, prompt, aspect, camera, rect, model: M.id, denoise: M.local ? d : undefined, seed: res.seed, cost: res.cost ?? null, ms: res.ms, saved: new Date().toISOString() }, null, 1) + '\n');
      return { ok: true, url: `/${out}`, cost: res.cost ?? null, ms: res.ms };
    });
    generating = j.id;
    return { job: j.id, out };
  }

  // Egna ändringar (EDITS.md): en ny ändringsfil per version, sedan figuren byggd om med receptet plus "edits"
  async function edits({ name, proxy, nverts, offsets }) {
    if (!NAME.test(name ?? '') || !existsSync(path.join(ROOT, CHARS, name, `${name}_edit.json`))) return { error: 'no such figure with an editor file' };
    const recipe = await readJson(`${CHARS}/${name}/recipe.json`).catch(() => readJson(`${FITS}/${name}/recipe.json`).catch(() => null));
    if (!recipe) return { error: `${name} has no recipe, so it cannot be built again` };
    const n = Number(nverts);
    if (!Number.isInteger(n) || n < 1 || !Array.isArray(offsets) || offsets.length !== 3 * n) return { error: 'offsets must have three numbers per point' };
    if (!offsets.every((x) => Number.isFinite(x) && Math.abs(x) < 0.3)) return { error: 'an offset is not a number or larger than 30 cm' };
    if (!/^[\w-]{1,48}$/.test(String(proxy ?? ''))) return { error: 'bad proxy name' };
    const stem = name.replace(/_e\d+$/, '');
    await mkdir(path.join(ROOT, EDITS), { recursive: true });
    let v = 1;
    while (existsSync(path.join(ROOT, EDITS, `${stem}_v${v}.json`)) || taken(`${stem}_e${v}`)) v++; // aldrig över
    const file = `${EDITS}/${stem}_v${v}.json`, out = `${stem}_e${v}`;
    await writeFile(path.join(ROOT, file), JSON.stringify({ proxy, nverts: n, from: name, saved: new Date().toISOString(), offsets }) + '\n');
    const r = await cleanRecipe({ ...recipe, edits: file });
    return { file, name: out, job: job('save', out, async () => {
      const res = await run(`${HUMAN}/make_human.py`, { ...r, name: out });
      if (res.glb) {
        const keep = Object.fromEntries(Object.entries(recipe).filter(([k]) => ['target', 'overlay', 'ai_transform', 'ignore_hair', 'fit'].includes(k)));
        await writeFile(path.join(ROOT, CHARS, out, 'recipe.json'), JSON.stringify({ ...r, ...keep, wrap: r.wrap ? rel(r.wrap) : undefined, name: out, from: name, saved: new Date().toISOString(), tris: res.tris, checks: res.checks }, null, 1) + '\n');
      }
      return withUrls(res);
    }).id };
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
    else if (p === '/api/human/bake' && req.method === 'POST') json(res, 200, await bake(await body(req)));
    else if (p === '/api/human/paint' && req.method === 'POST') json(res, 200, await paint(req, url.searchParams.get('name'), url.searchParams.get('base')));
    else if (p === '/api/human/ref' && req.method === 'POST') json(res, 200, await ref(req, url.searchParams.get('name'), url.searchParams.get('file')));
    else if (p === '/api/human/genview' && req.method === 'POST') json(res, 200, await genview(await body(req)));
    else if (p === '/api/human/final' && req.method === 'POST') json(res, 200, await final(await body(req)));
    else if (p === '/api/human/edits' && req.method === 'POST') json(res, 200, await edits(await body(req)));
    else if (p === '/api/human/thumb' && req.method === 'POST') json(res, 200, await thumb(await body(req)));
    else if (p === '/api/human/editor' && req.method === 'POST') json(res, 200, await editor());
    else if (p === '/api/human/job' && req.method === 'GET') {
      const j = jobs.get(url.searchParams.get('id') ?? '');
      json(res, 200, j ? status(j) : { error: 'no such job (the server may have restarted)' });
    } else return false;
    return true;
  };
}
