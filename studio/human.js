// The Character Creator (docs/asset-studio.md, docs/character-creator.md): människor på MPFB:s gemensamma grundnät
// ur reglage. Mallarna till vänster (startrecept med ikoner i assets/icons/human/), reglagen och Save till höger,
// figuren i mitten. Allt körs av verktygen genom servern (tools/studio/human.mjs): en figur byggs av make_human.py
// (ca 4 s), en AI-form (Pixal3D-GLB) passas in av fit_human.py (reglagen och sedan wrapen, några minuter) med
// overlay-bilden som bevis. Formen först; texturen är inte i fokus här. Texten i appen är på engelska.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { gpuPreference, frameGate } from './gpu.js';
import { createCards, withIcon } from './cards.js';

export async function createHuman({ api, el, view, side, drawer, footer }) {
  const info = await api('/api/human');
  const params = info.params.map((q) => ({ ...q, rebuild: true })); // varje reglage bygger om figuren när man släpper
  const defaults = Object.fromEntries(params.map((q) => [q.key, q.default]));
  const vals = { ...defaults };
  const sliderKeys = new Set(params.filter((q) => q.in === 'sliders').map((q) => q.key));
  let from = info.templates[0]?.id ?? null; // mallen eller den sparade figuren man utgår från
  let wrapPath = null, keepWrap = true;     // inpassningens wrap (build/human/fit/<namn>/wrap.npz)
  let extra = {};                           // receptets nycklar utan spak här (elbow_flex …): följer med vid ombygget
  let locked = null;                        // en sparad figur utan recept: visas som den byggdes, reglagen är låsta
  let selGen = 0, showToken = 0;            // det senast valda vinner, även när ett äldre bygge blir klart efteråt
  const META = ['name', 'from', 'saved', 'checks', 'tris', 'height_m', 'target', 'overlay', 'fit', 'wrap', 'sliders', 'out_dir', 'label', 'help', 'ai_transform', 'ignore_hair', 'note', 'from_fit'];
  let fitXf = null;                         // inpassningens skala för AI-formen ({ target, k }): vyn Over följer den exakt
  const view3 = { clay: true, wire: false, rest: false, ai: 'off' };

  // --- Renderaren: WebGL räcker för en figur ---
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: gpuPreference() === 'low-power' ? 'low-power' : 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  view.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  camera.position.set(0.9, 1.3, 4.6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.9, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.53;
  scene.add(new THREE.HemisphereLight('#dfe8f2', '#5a5048', 1.1));
  const key = new THREE.DirectionalLight('#fff4e6', 2.2);
  key.position.set(2.5, 4, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2.4, bottom: -0.2, near: 0.5, far: 12 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.012; // dubbelsidig lera kastar skugga med båda sidorna: utan den blir det strimmor (acne)
  scene.add(key);
  const rim = new THREE.DirectionalLight('#cfe0ff', 0.9);
  rim.position.set(-3, 2.5, -3);
  scene.add(rim);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(3, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#8d9196', roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
  // Ett rutnät med en decimeter mellan linjerna, och meterlinjer: längden syns direkt
  const grid = new THREE.GridHelper(4, 40, '#6b7076', '#7c8187');
  grid.position.y = 0.001;
  grid.material.transparent = true; grid.material.opacity = 0.35;
  scene.add(grid);
  function applyTheme() {
    const css = getComputedStyle(document.documentElement);
    scene.background = new THREE.Color(css.getPropertyValue('--viewport').trim() || '#c8ccd0');
  }
  applyTheme();
  addEventListener('studio-theme', applyTheme);

  // --- Figuren och AI-formen ---
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // Leran är dubbelsidig som kroppens eget material: munnen är en springa i nätet, och med bara framsidan syntes
  // bakgrunden genom den och ljuset läckte genom den i skuggkartan (ljusa strimmor på hakan och halsen)
  const clay = new THREE.MeshStandardMaterial({ color: '#c9a58e', roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
  const ghost = new THREE.MeshStandardMaterial({ color: '#d94b4b', roughness: 0.7, transparent: true, opacity: 0.38, depthWrite: false });
  let figure = null, figureUrl = null, figureStats = null, aiShape = null, aiPath = null;
  const dispose = (o) => o?.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); for (const x of [m.material].flat()) if (x !== clay && x !== ghost) x.dispose?.(); } });
  function styleFigure() {
    figure?.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.own ??= o.material;
      // Ögonen (MPFB:s low-poly, materialet Human.low-poly) behåller sin egen textur, ogenomskinlig
      const eye = /eye|low-poly/i.test(`${o.name} ${o.userData.own?.name ?? ''}`);
      if (eye && o.userData.own) Object.assign(o.userData.own, { transparent: false, depthWrite: true });
      o.material = view3.clay && !eye ? clay : o.userData.own;
      for (const m of [o.material].flat()) m.wireframe = view3.wire;
      o.castShadow = true; o.receiveShadow = true;
    });
  }
  async function showFigure(res) {
    const url = view3.rest ? res.rigged ?? res.url : res.url ?? res.rigged;
    const token = ++showToken;
    const gltf = await loader.loadAsync(`${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`);
    if (token !== showToken) { dispose(gltf.scene); return; } // en nyare figur har valts under laddningen
    if (figure) { scene.remove(figure); dispose(figure); }
    figure = gltf.scene;
    figureUrl = res;
    scene.add(figure);
    styleFigure();
    figure.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(figure), size = box.getSize(new THREE.Vector3());
    let tris = 0;
    figure.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
    figureStats = { height: size.y, width: size.x, depth: size.z, tris: Math.round(tris), feet: box.min.y };
    placeAi();
    stats();
  }
  // AI-formen bredvid eller ovanpå figuren, skalad till figurens längd (bara för ögat; mätningen gör fit_human.py)
  async function loadAi(p) {
    if (aiPath === p && aiShape) return;
    if (aiShape) { scene.remove(aiShape); dispose(aiShape); aiShape = null; }
    aiPath = p;
    if (!p) return;
    note.textContent = `Loading the AI shape ${p.split('/').pop()}…`;
    const g = await loader.loadAsync(`/${p}`).catch((e) => { note.textContent = `Could not load the AI shape: ${e.message ?? e}`; return null; });
    if (!g || aiPath !== p) return;
    aiShape = new THREE.Group();
    aiShape.add(g.scene);
    g.scene.traverse((o) => { if (o.isMesh) { o.userData.own = o.material; o.castShadow = true; } });
    scene.add(aiShape);
    note.textContent = '';
    placeAi();
  }
  function placeAi() {
    if (!aiShape) return;
    aiShape.visible = view3.ai !== 'off';
    const inner = aiShape.children[0];
    inner.position.set(0, 0, 0); inner.scale.setScalar(1); aiShape.position.set(0, 0, 0); aiShape.scale.setScalar(1);
    aiShape.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(inner), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    // Inpassningens egen skala (ai_transform: base_scale × scale, efter halsen med ignore_hair) när den finns för den här
    // AI-formen; annars hela höjden, som inpassningen utan ignore_hair
    const k = fitXf && fitXf.target === aiPath ? fitXf.k : (figureStats?.height ?? 1.7) / Math.max(0.01, s.y);
    inner.position.set(-c.x, -b.min.y, -c.z);
    aiShape.scale.setScalar(k);
    // Som inpassningen (fit_blender.py, place_target): kroppen under axlarna (nedre 75 %) centreras på figurens, i sidled
    // och djupled, så att hår, knut och armar inte flyttar formen
    aiShape.updateMatrixWorld(true);
    const mf = figure ? lowMedian(figure) : new THREE.Vector3(), ma = lowMedian(aiShape);
    aiShape.position.set(mf.x - ma.x, 0, mf.z - ma.z);
    if (view3.ai === 'beside') aiShape.position.x += Math.max(0.75, (figureStats?.width ?? 0.5) * 0.5 + s.x * k * 0.5 + 0.15);
    inner.traverse((o) => { if (o.isMesh) { o.material = view3.ai === 'overlay' ? ghost : view3.clay ? clay : o.userData.own; o.renderOrder = view3.ai === 'overlay' ? 2 : 0; } });
  }

  // Medianen (x, z) av hörnen i nedre 75 % av höjden, i världen; högst ca 30 000 hörn räknas
  function lowMedian(root) {
    const pts = [], v = new THREE.Vector3();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const p = o.geometry.attributes.position, step = Math.max(1, Math.floor(p.count / 30000));
      for (let i = 0; i < p.count; i += step) pts.push(v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).toArray());
    });
    if (!pts.length) return new THREE.Vector3();
    const ys = pts.map((q) => q[1]), lo = Math.min(...ys), cut = lo + 0.75 * (Math.max(...ys) - lo);
    const low = pts.filter((q) => q[1] < cut), med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
    return new THREE.Vector3(med(low.map((q) => q[0])), 0, med(low.map((q) => q[2])));
  }
  const xfOf = (target, t) => (target && t?.scale ? { target, k: (t.base_scale ?? 1) * t.scale, from: t.scale_from ?? 'height' } : null);
  const aiOffset = () => (figure && aiShape ? (() => { const a = lowMedian(figure), b = lowMedian(aiShape); return { dx_mm: Math.round(1000 * (b.x - a.x)), dz_mm: Math.round(1000 * (b.z - a.z)) }; })() : null);

  // --- Receptet: makrona överst, reglagen under sliders, posen och nätet ---
  function recipe() {
    const r = { ...extra, sliders: {} };
    for (const q of params) {
      if (sliderKeys.has(q.key)) { if (vals[q.key]) r.sliders[q.key] = vals[q.key]; } else r[q.key] = vals[q.key];
    }
    if (wrapPath && keepWrap) r.wrap = wrapPath;
    return r;
  }
  function load(rec = {}, { wrap = null, lock = null } = {}) {
    selGen++;
    Object.assign(vals, defaults);
    const keys = new Set(params.map((q) => q.key));
    extra = Object.fromEntries(Object.entries(rec ?? {}).filter(([k]) => !keys.has(k) && !META.includes(k)));
    setLock(lock);
    for (const q of params) {
      const v = sliderKeys.has(q.key) ? rec.sliders?.[q.key] : rec[q.key];
      if (v == null) continue;
      vals[q.key] = q.key === 'pose' ? ({ T: 90, A: 45 }[v] ?? Number(v)) : v;
    }
    wrapPath = wrap ?? (typeof rec.wrap === 'string' ? rec.wrap : null);
    keepWrap = true;
    cards.sync();
    wrapRow.hidden = !wrapPath;
  }

  // --- Bygget: när man släpper ett reglage; kommer fler ändringar under bygget tas den senaste efteråt ---
  let building = false, again = false, lastBuild = null;
  async function poll(id, onWait) {
    for (;;) {
      const j = await api(`/api/human/job?id=${id}`);
      if (!j.pending) return j;
      onWait?.(j);
      await new Promise((r) => setTimeout(r, j.kind === 'fit' ? 2000 : 400));
    }
  }
  async function rebuild() {
    if (locked) { lamp('bad', `${locked} has no recipe: the sliders are locked`); return; }
    if (building) { again = true; return; }
    const gen = selGen;
    building = true;
    lamp('busy', 'Building…');
    const t0 = performance.now();
    try {
      const { job, error } = await api('/api/human/build', { recipe: recipe() });
      const res = error ? { error } : await poll(job);
      if (gen !== selGen) { /* en annan figur valdes medan bygget pågick: det gamla visas inte (ett nytt bygge följer vid behov) */ }
      else if (res.glb) { lastBuild = res; await showFigure(res); lamp(res.ok ? 'ok' : 'bad', res.ok ? `Built in ${((performance.now() - t0) / 1000).toFixed(1)} s` : 'Built, but a check failed'); checksOf(res); }
      else { lamp('bad', 'Not built'); note.textContent = res.error ?? 'The build failed'; }
    } finally {
      building = false;
      if (again) { again = false; rebuild(); }
    }
  }
  const changed = () => { mark(null); rebuild(); };

  // --- Korten till höger ---
  const cards = createCards({ el, side });
  const get = (k) => vals[k], set = (k, v) => { vals[k] = v; };
  const COL = { body: '#c2577a', torso: '#d07a5a', hips: '#c99a1c', legs: '#5a9a6a', arms: '#4a90b9', head: '#8b6cd6', pose: '#7a8a9a' };
  let wrapRow = null;
  for (const g of info.groups) {
    const body = cards.card(g.label, COL[g.id] ?? '#c2577a', { closed: !['body', 'pose'].includes(g.id) });
    for (const q of params.filter((x) => x.group === g.id)) body.append(cards.rowFor(q)(q, get, set, changed));
    if (g.id === 'pose') {
      wrapRow = cards.toggleRow({ key: '_wrap', label: 'Keep the fit\'s wrap', sub: 'the AI surface, baked into the mesh', help: 'The wrap from the fit (wrap.npz) pulls the mesh tight to the AI shape on top of the sliders. Off gives the sliders only' },
        () => keepWrap, (_k, v) => { keepWrap = v; }, changed);
      wrapRow.hidden = true;
      body.append(wrapRow);
    }
  }
  const keepCard = (b) => b.parentElement.classList.add('hu-keep');
  const viewBody = cards.card('View', '#7a8a9a', { help: 'How the figure is shown here; nothing of this is saved' });
  const vget = (k) => view3[k], vset = (k, v) => { view3[k] = v; };
  viewBody.append(
    cards.toggleRow({ key: 'clay', label: 'Clay', sub: 'one neutral material, the shape only' }, vget, vset, () => { styleFigure(); placeAi(); }),
    cards.toggleRow({ key: 'wire', label: 'Wireframe', sub: 'the game mesh\'s edges' }, vget, vset, styleFigure),
    cards.toggleRow({ key: 'rest', label: 'Rest pose', sub: 'the rigged figure instead of the posed copy' }, vget, vset, () => { if (figureUrl) showFigure(figureUrl); }),
    cards.choiceRow({ key: 'ai', label: 'AI shape', help: 'The AI shape picked in the Fit card, scaled to the figure\'s height: beside it, or as a red ghost over it', options: [{ id: 'off', label: 'Off' }, { id: 'beside', label: 'Beside' }, { id: 'overlay', label: 'Over' }] },
      vget, vset, async () => { if (view3.ai !== 'off') await loadAi(targetSel.value); placeAi(); }),
  );

  // Inpassningen: en AI-form (Pixal3D-GLB) blir reglage och sedan en wrap (fit_human.py)
  const fitBody = cards.card('Fit an AI shape', '#d94b4b', { help: 'Find the sliders that make the base mesh look like an AI shape, then wrap the game mesh tight to it (tools/character/human/fit_human.py). Takes a few minutes' });
  keepCard(viewBody); keepCard(fitBody);
  const targetSel = el('select');
  const fillTargets = (sel) => {
    targetSel.replaceChildren(...info.targets.map((t) => Object.assign(el('option', null, `${t.name} · ${(t.size / 1e6).toFixed(0)} MB`), { value: t.path, title: t.path })));
    if (sel) targetSel.value = sel;
  };
  fillTargets();
  const tRow = el('div', 'row span2');
  tRow.title = 'AI shapes found in the project (Pixal3D GLBs from Darrowmere, build/characters/ and uploads)';
  tRow.append(el('label', null, 'AI shape'), targetSel);
  const file = Object.assign(el('input'), { type: 'file', accept: '.glb,model/gltf-binary', hidden: true });
  const upBtn = el('button', null, 'Add a GLB…');
  upBtn.title = 'Copy a GLB from your computer (for example a Pixal3D model from Darrowmere) to build/human/targets/';
  upBtn.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    fitMsg.textContent = `Uploading ${f.name} (${(f.size / 1e6).toFixed(0)} MB)…`;
    const r = await fetch(`/api/human/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    file.value = '';
    if (r.error) { fitMsg.textContent = `Not added: ${r.error}`; return; }
    info.targets.unshift({ path: r.path, name: r.name, size: r.size });
    fillTargets(r.path);
    targetSel.onchange();
    fitMsg.textContent = `Added ${r.path}`;
  };
  const nameIn = Object.assign(el('input'), { type: 'text', spellcheck: false, placeholder: 'name_of_the_fit' });
  const nRow = el('div', 'row span2');
  nRow.title = 'The fit\'s name: the figure lands in assets/characters/<name>/ and the proof in build/human/fit/<name>/. A name that exists is never overwritten';
  nRow.append(el('label', null, 'Name'), nameIn);
  const fitVals = Object.fromEntries(info.fit.map((q) => [q.key, q.default]));
  const fitRows = info.fit.map((q) => cards.rowFor(q)(q, (k) => fitVals[k], (k, v) => { fitVals[k] = v; }));
  const suggest = () => {
    const stem = (targetSel.value.split('/').pop() ?? 'shape').replace(/\.glb$/i, '').replace(/_?\d{3,}_?$/, '').replace(/pixal3d/i, '').replace(/[^a-z0-9_]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'shape';
    const taken = new Set(info.saved.map((s) => s.name));
    let n = `${stem}_fit`, k = 2;
    while (taken.has(n)) n = `${stem}_fit${k++}`;
    nameIn.value = n;
  };
  targetSel.onchange = async () => { suggest(); if (view3.ai !== 'off') { await loadAi(targetSel.value); placeAi(); } };
  suggest();
  const fitBtn = el('button', 'primary', 'Run the fit');
  fitBtn.title = 'Sex and age are kept from the Body card; the other sliders, the pose and the wrap are found by the fit';
  const fitMsg = el('div', 'note');
  const overlayBtn = el('button', null, 'Show the overlay');
  overlayBtn.title = 'The proof: front and side before and after (red = AI, blue = the template, white = both)';
  overlayBtn.disabled = true;
  const btnRow = el('div', 'hu-btns');
  btnRow.append(fitBtn, upBtn, file);
  fitBody.append(tRow, nRow, ...fitRows, btnRow, overlayBtn, fitMsg);
  let overlayUrl = null, fitJob = info.fitting;
  overlayBtn.onclick = () => showOverlay(overlayUrl);
  fitBtn.onclick = async () => {
    const name = nameIn.value.trim().toLowerCase();
    const r = await api('/api/human/fit', { name, target: targetSel.value, sex: vals.sex, age: vals.age, subdiv: vals.subdiv, ...fitVals });
    if (r.error) { fitMsg.textContent = `Not started: ${r.error}`; return; }
    followFit(r.job, name);
  };
  async function followFit(id, name) {
    fitBtn.disabled = true;
    lamp('busy', 'Fitting…');
    const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    const res = await poll(id, (j) => { fitMsg.textContent = `Fitting ${name}… ${clock(Date.now() - j.since)} (the sliders, then the wrap; a few minutes)`; });
    fitBtn.disabled = false;
    fitJob = null;
    if (!res.glb) { lamp('bad', 'The fit failed'); fitMsg.textContent = `The fit failed: ${res.error ?? 'no model'}`; return; }
    lastFit = res;
    fitXf = xfOf(res.target, res.ai_transform);
    overlayUrl = res.overlay;
    overlayBtn.disabled = !overlayUrl;
    load(res.recipe ?? {}, { wrap: res.recipe?.wrap ?? null });
    from = `saved:${name}`;
    await refreshSaved();
    mark(from);
    await showFigure(res);
    checksOf(res);
    await giveThumb(name);
    const w = res.wrap?.end;
    fitMsg.textContent = `Fitted ${name} in ${clock(res.ms)}: sliders ${res.start?.mean_mm} → ${res.end?.mean_mm} mm${w ? `, wrap ${w.before_from_ai_mean_mm ?? '–'} → ${w.from_ai_mean_mm} mm from the AI surface` : ''}`;
    lamp(res.ok ? 'ok' : 'bad', res.ok ? 'Fitted' : 'Fitted, but a check failed');
    showOverlay(overlayUrl);
  }
  let lastFit = null;

  // Verktyg utanför studion: Body Editor och beställningssidan på Darrowmere
  const toolBody = cards.card('More tools', '#5c636d', { help: 'Where the shapes come from and where they are fine-tuned by hand' });
  keepCard(toolBody);
  const edBtn = el('button', null, info.links.editor.label);
  edBtn.title = `${info.links.editor.help} (${info.links.editor.url})`;
  const toolMsg = el('div', 'note');
  edBtn.onclick = async () => {
    const r = await api('/api/human/editor', {});
    toolMsg.textContent = r.ok ? 'The Body Editor opens in its own window (it starts its server first if needed).' : `Could not start it: ${r.error}. Open ${info.links.editor.url}`;
  };
  const order = Object.assign(el('a', 'hu-link', `${info.links.order.label} ↗`), { href: info.links.order.url, target: '_blank', rel: 'noopener', title: info.links.order.help });
  const tBtns = el('div', 'hu-btns');
  tBtns.append(edBtn);
  toolBody.append(tBtns, order, toolMsg);

  // Spara: figuren byggs med sitt namn i assets/characters/<namn>/ (ett namn som finns skrivs aldrig över)
  const saveBody = cards.card('Save', '#4a90d9');
  const saveBtn = el('button', 'primary', 'Save figure…');
  saveBtn.title = 'Builds the figure under its own name in assets/characters/<name>/ (rigged .glb and posed _pose.glb) with recipe.json and a thumbnail';
  const saveMsg = el('div', 'note');
  saveBtn.onclick = async () => {
    const base = String(from ?? 'figure').replace(/^saved:/, '');
    const name = prompt('Name of the figure (a–z, 0–9 and _):', base.endsWith('_2') ? base : `${base}_2`);
    if (!name) return;
    const r = await api('/api/human/save', { name: name.trim().toLowerCase(), recipe: recipe(), thumbnail: thumbnail(), from });
    if (r.error) { saveMsg.textContent = `Not saved: ${r.error}`; return; }
    lamp('busy', 'Saving…');
    const res = await poll(r.job);
    if (!res.glb) { lamp('bad', 'Not saved'); saveMsg.textContent = `Not saved: ${res.error}`; return; }
    saveMsg.textContent = `Saved: ${res.glb}`;
    lamp('ok', 'Saved');
    from = `saved:${res.name}`;
    await refreshSaved();
    mark(from);
  };
  saveBody.append(saveBtn, saveMsg);

  // --- Lådan: mallarna och de sparade figurerna ---
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  head.append(el('h2', null, 'Figures'), el('div', 'note', 'Start from a template, or open a saved figure or fit.'));
  drawer.append(head, body);
  const meta = (r) => {
    if (!r) return 'no recipe';
    const sex = Number(r.sex ?? 0) >= 0.5 ? 'man' : 'woman';
    return [sex, r.age ? `${Math.round(r.age)} y` : null, r.from === 'fit' ? 'fitted' : null, r.wrap ? 'wrap' : null].filter(Boolean).join(' · ');
  };
  function tile(id, label, sub, icon, src) {
    const f = el('button', `wprof${from === id ? ' on' : ''}`);
    f.dataset.id = id;
    f.append(el('b', null, label), el('span', 'wmeta', sub));
    return withIcon(el, f, 'human', icon, label, src);
  }
  function renderDrawer() {
    body.replaceChildren();
    const sec = (title, tiles) => { if (!tiles.length) return; const g = el('section', 'libgroup'); const gr = el('div', 'wprofs'); gr.append(...tiles); g.append(el('h3', null, title), gr); body.append(g); };
    sec('Ready-made', info.templates.map((t) => {
      const f = tile(t.id, t.label, t.help, t.id);
      f.title = t.help;
      f.onclick = () => { load(t.recipe); fitXf = null; from = t.id; mark(t.id); rebuild(); };
      return f;
    }));
    sec('Saved', info.saved.map((s) => {
      const tpl = info.templates.find((t) => t.id === s.recipe?.from)?.id ?? (s.recipe?.from === 'fit' || s.overlay ? 'fit' : 'custom');
      const f = tile(`saved:${s.name}`, s.name, meta(s.recipe), tpl, s.thumbnail);
      f.title = `${s.rigged}${s.overlay ? ' · has a fit overlay' : ''}`;
      f.onclick = async () => {
        load(s.recipe ?? {}, { lock: s.recipe ? null : s.name });
        from = `saved:${s.name}`;
        mark(from);
        overlayUrl = s.overlay;
        overlayBtn.disabled = !overlayUrl;
        fitXf = xfOf(s.recipe?.target, s.recipe?.ai_transform);
        if (s.recipe?.target) { if (![...targetSel.options].some((o) => o.value === s.recipe.target)) { info.targets.unshift({ path: s.recipe.target, name: s.recipe.target.split('/').pop().replace(/\.glb$/i, ''), size: 0 }); fillTargets(); } targetSel.value = s.recipe.target; suggest(); }
        lastBuild = null;
        await showFigure(s);
        checksOf(s.recipe?.checks ? s.recipe : null);
        lamp('ok', `Opened ${s.name}`);
        if (!s.thumbnail) await giveThumb(s.name);
      };
      return f;
    }));
  }
  function mark(id) { if (id !== undefined) from = id ?? from; for (const b of body.querySelectorAll('.wprof')) b.classList.toggle('on', b.dataset.id === id); }
  // En sparad figur utan miniatyr (inpassningarna) får en av vyn första gången den öppnas
  async function giveThumb(name) {
    await new Promise((r) => requestAnimationFrame(r));
    const r = await api('/api/human/thumb', { name, thumbnail: thumbnail() });
    if (!r.thumbnail) return;
    const s = info.saved.find((x) => x.name === name);
    if (s) s.thumbnail = r.thumbnail;
    const box = body.querySelector(`.wprof[data-id="saved:${name}"] .ticon`);
    if (box) { const img = Object.assign(el('img'), { src: r.thumbnail, alt: '' }); box.classList.remove('letter'); box.replaceChildren(img); }
  }
  async function refreshSaved() { const r = await api('/api/human'); info.saved = r.saved; info.targets = r.targets; renderDrawer(); }
  renderDrawer();

  // Overlay-bilden från inpassningen, över vyn
  const ov = el('div', 'hu-overlay');
  const ovImg = el('img'), ovClose = el('button', 'icon', '×');
  ovClose.title = 'Close (Esc)';
  ovClose.onclick = () => { ov.hidden = true; };
  ov.append(ovImg, ovClose);
  ov.hidden = true;
  view.append(ov);
  function showOverlay(url) { if (!url) return; ovImg.src = `${url}?v=${Date.now()}`; ov.hidden = false; }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) ov.hidden = true; });

  // Låset: en figur utan recept.json (byggd utanför studion) kan inte byggas om ur reglagen; den visas som den är
  const lockMsg = el('div', 'hu-lockmsg');
  lockMsg.hidden = true;
  side.prepend(lockMsg);
  function setLock(name) {
    locked = name;
    side.classList.toggle('hu-locked', !!name);
    lockMsg.hidden = !name;
    lockMsg.textContent = name ? `${name} has no recipe, so it is shown as it was built and the sliders are locked. Start from a template, or open a figure that has a recipe.` : '';
  }

  // --- Footern ---
  const fFig = el('div', 'block'), fChecks = el('div', 'block'), note = el('div', 'msg');
  footer.append(fFig, fChecks, note);
  const block = (b, title, text) => { b.replaceChildren(el('b', null, title), el('div', 'vals', text)); };
  function stats() {
    if (!figureStats) return;
    const s = figureStats;
    block(fFig, 'Figure', `${s.height.toFixed(3)} m tall · ${(s.width).toFixed(2)} × ${(s.depth).toFixed(2)} m · ${s.tris.toLocaleString('en')} tris`);
  }
  function checksOf(res) {
    const c = res?.checks;
    if (!c) { block(fChecks, 'Checks', '–'); return; }
    const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k.replace(/_/g, ' '));
    block(fChecks, 'Checks', bad.length ? `failed: ${bad.join(', ')}` : `all ${Object.keys(c).length} ok${res.bones ? ` · ${res.bones} bones` : ''}`);
  }
  function lamp(kind, text) {
    note.replaceChildren(el('span', `lamp ${kind}`), document.createTextNode(text));
  }

  // Miniatyr: figuren inramad framifrån, kvadratiskt utsnitt
  function thumbnail() {
    const saved = { pos: camera.position.clone(), target: controls.target.clone() };
    const aiVis = aiShape?.visible;
    if (aiShape) aiShape.visible = false;
    const h = figureStats?.height ?? 1.7;
    controls.target.set(0, h * 0.52, 0);
    camera.position.set(0.25, h * 0.6, h * 2.3);
    camera.lookAt(controls.target);
    renderer.render(scene, camera);
    const src = renderer.domElement, s = Math.min(src.width, src.height);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    c.getContext('2d').drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 256, 256);
    camera.position.copy(saved.pos); controls.target.copy(saved.target);
    if (aiShape) aiShape.visible = aiVis;
    return c.toDataURL('image/jpeg', 0.86);
  }

  // --- Rendering ---
  let running = false;
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', () => { if (running) resize(); });
  const gate = frameGate();
  function frame(now) { if (!gate(now)) return; controls.update(); renderer.render(scene, camera); }

  // Start: den första mallen, eller en inpassning som redan pågår
  cards.sync();
  load(info.templates[0]?.recipe ?? {});
  mark(from);
  const started = rebuild();
  if (fitJob?.pending) followFit(fitJob.job, fitJob.name);
  await started;

  return {
    show() { running = true; resize(); renderer.setAnimationLoop(frame); },
    hide() { running = false; renderer.setAnimationLoop(null); },
    scene, camera, controls, renderer, vals, recipe, rebuild, load,
    get figure() { return figure; }, get stats() { return figureStats; }, get lastBuild() { return lastBuild; }, get lastFit() { return lastFit; },
    get building() { return building || again; }, get locked() { return locked; }, aiOffset, get fitXf() { return fitXf; }, get aiShape() { return aiShape; }, get from() { return from; }, info,
    async shot(name) {
      renderer.render(scene, camera);
      const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
      return (await fetch(`/api/shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })).json();
    },
  };
}
