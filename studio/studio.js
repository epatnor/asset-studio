// Asset Studio (docs/asset-studio.md): spakar för generatorerna, byggda från deras params.json. Ren klientkod;
// generatorerna körs av studioservern (tools/studio/server.mjs) via dess API.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { shareTextures } from '../showcase/shared_textures.js';
import { createMaterialPatcher, applyShadowRole } from '../showcase/materials.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const api = (p, payload) => fetch(p, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {})
  .then((r) => r.json());
const fmt = (n, d = 0) => (n ?? 0).toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d });

// --- Scen: samma ljus, himmel och mark som visningen (showcase/index.html) ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping; // stilguiden: AgX
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const SKY = new THREE.Color('#8fbdf0'), HORIZON = new THREE.Color('#d9ecff');
scene.fog = new THREE.Fog(HORIZON, 80, 260);
scene.add(new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: SKY }, bottom: { value: HORIZON } },
  vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 1.6, 0., 1.); gl_FragColor = vec4(mix(bottom, top, h), 1.); }',
})));
scene.add(new THREE.HemisphereLight('#cfe6ff', '#5d7a3a', 1.1));
const sunDir = { value: new THREE.Vector3(0.6, 1.1, 0.8).normalize() };
const sun = new THREE.DirectionalLight('#ffe9c7', 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.position.copy(sunDir.value).multiplyScalar(60);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 160 });
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.CircleGeometry(300, 64), new THREE.MeshStandardMaterial({ color: '#6fa046', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(4, 5, 18);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 4, 0);
const wind = { uTime: { value: 0 }, uWind: { value: 0.6 } };
const patchMaterial = createMaterialPatcher(THREE, { wind, sunDir });
const leaf = patchMaterial.uniforms;
const loader = shareTextures(new GLTFLoader().setMeshoptDecoder(MeshoptDecoder));

// Efterbehandling (bara när ambient occlusion är på): render -> GTAO -> tonmappning
let composer = null;
function setAO(on) {
  if (!on) { composer?.dispose(); composer = null; return; }
  if (composer) return;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const ao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5 });
  composer.addPass(ao);
  composer.addPass(new OutputPass());
}
const draw = () => (composer ? composer.render() : renderer.render(scene, camera));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});
const timer = new THREE.Timer();
let paused = false;
renderer.setAnimationLoop((t) => {
  if (paused) return;
  timer.update(t);
  wind.uTime.value = timer.getElapsed();
  controls.update();
  draw();
});

// --- Tillstånd: receptet, arten (som i species.json) och visningens val ---
const gens = await api('/api/generators');
const G = gens.tree, P = G.params;
const state = { recipe: {}, spec: {}, view: {} };
let kind = P.kinds[0];
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, p, v) => {
  const keys = p.split('.'), last = keys.pop();
  let o = obj;
  for (const [i, k] of keys.entries()) o = (o[k] ??= /^\d+$/.test(keys[i + 1] ?? last) ? [] : {});
  o[last] = v;
};
const paramAt = (path) => P.params.find((q) => q.path === path) ?? { path };
// Värde för en spak: det som är satt, annars artens värde (recipe.leaves m.fl. finns som leaves i arten), annars standard
function valueOf(p) {
  let v = getPath(state, p.path);
  if (v === undefined && p.path.startsWith('recipe.')) v = getPath(state.spec, p.path.slice(7));
  if (v === undefined && p.fallback) v = valueOf(paramAt(p.fallback));
  if (Array.isArray(v) && p.type === 'intrange') v = v[0];
  return v ?? p.default ?? (p.type === 'bool' ? false : p.min ?? 0);
}
function setValue(p, v) {
  if (p.type === 'intrange') {
    const old = getPath(state, p.path), width = Array.isArray(old) ? old[1] - old[0] : 2;
    setPath(state, p.path, [v, v + width]);
  } else setPath(state, p.path, v);
}
function resetSpecies(preset, height) {
  state.spec = structuredClone(G.species[preset]);
  state.recipe = { preset, height: height ?? state.recipe.height ?? kind.height ?? 8, seed: state.recipe.seed ?? 47,
    bark_blend: structuredClone(state.spec.bark_blend ?? {}) };
}
// Texturblandningen: artens värden, ändrade spakar ovanpå, och spakarnas standard där arten saknar värde
function blendNow() {
  const out = {};
  for (const p of P.params.filter((q) => q.path.startsWith('recipe.bark_blend.'))) setPath(out, p.path.slice(18), valueOf(p));
  return out;
}
const recipeNow = () => ({
  preset: `${state.recipe.preset}_medium`, seed: state.recipe.seed, height: state.recipe.height,
  leaves: valueOf(paramAt('recipe.leaves')), bark: valueOf(paramAt('recipe.bark')), leaf_tint: valueOf(paramAt('recipe.leaf_tint')),
  species: { trunk: state.spec.trunk, levels: state.spec.levels, stemless: !!state.spec.stemless }, canopy: state.spec.foliage, bark_blend: blendNow(),
});

// --- Modellerna: den aktuella i mitten, fästa till vänster för jämförelse ---
let current = null;
const pinned = [];
const spacing = () => (kind.height ?? 8) * 1.6;

// Skuggor: vilka delar som kastar och tar emot, efter kortet Rendering och skuggor
function shadowRoles(o) {
  const v = state.view, ground = v.groundShadow ?? 'proxy', self = v.selfShadow ?? 'fake';
  const leafCast = ground === 'cards' || self !== 'fake';
  if (/_leaves_LOD\d$/.test(o.name)) {
    const recv = self !== 'fake';
    if (o.receiveShadow !== recv) o.material.needsUpdate = true;
    o.castShadow = leafCast; o.receiveShadow = recv;
  } else if (o.material.userData?.shadowProxy) {
    o.castShadow = ground === 'proxy' && !leafCast; // korten kastar redan om de skuggar varandra
  } else if (/_trunk_LOD\d$/.test(o.name)) {
    o.castShadow = ground !== 'off';
  }
}
function applyView(root) {
  root.traverse((o) => {
    const lod = o.name.match(/_LOD(\d)$/);
    if (lod) o.visible = Number(lod[1]) === Number(state.view.lod ?? 0);
    if (!o.isMesh) return;
    shadowRoles(o);
    // Trådram på skuggformen bara när den visas: skuggpasset ritar annars skuggan i trådram
    if (o.material.userData?.shadowProxy) o.material.colorWrite = o.material.wireframe = !!state.view.showShadowProxy;
    else o.material.wireframe = !!state.view.wireframe;
  });
}
const QUALITY = { low: [1024, THREE.PCFShadowMap], medium: [2048, THREE.PCFShadowMap], high: [4096, THREE.PCFShadowMap], vsm: [2048, THREE.VSMShadowMap] };
function applyViewAll() {
  const v = state.view;
  for (const r of [current, ...pinned]) if (r) applyView(r);
  wind.uWind.value = v.wind ?? 0.6;
  for (const k of ['uTrans', 'uLeafSpec', 'uEdgeFade']) if (v[k] !== undefined) leaf[k].value = v[k];
  leaf.uLeafShadow.value = (v.selfShadow ?? 'fake') === 'soft' ? 0.35 : 1;
  const [size, type] = QUALITY[v.shadowQuality ?? 'high'];
  if (sun.shadow.mapSize.x !== size || renderer.shadowMap.type !== type) {
    sun.shadow.mapSize.set(size, size);
    sun.shadow.map?.dispose(); sun.shadow.map = null;
    if (renderer.shadowMap.type !== type) { renderer.shadowMap.type = type; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); }
  }
  sun.shadow.radius = v.shadowRadius ?? 1;
  sun.shadow.blurSamples = 16;
  sun.intensity = v.sun ?? 3.2;
  renderer.toneMappingExposure = v.exposure ?? 1.15;
  setAO(!!v.ao);
}
async function showModel(url) {
  const root = (await loader.loadAsync(url)).scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    applyShadowRole(o);
    patchMaterial(o.material, url);
  });
  applyView(root);
  if (current) { scene.remove(current); dispose(current); }
  current = root;
  scene.add(root);
}
function dispose(root) { root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); }
function frame(...roots) {
  const box = new THREE.Box3();
  for (const r of roots.filter(Boolean)) box.expandByObject(r, true);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  controls.target.set(c.x, size.y * 0.5, c.z);
  camera.position.set(c.x + size.y * 0.35, size.y * 0.55, c.z + Math.max(size.y, size.x) * 1.9);
}

// --- Generering: när en spak släpps byggs tillgången om; bara det senaste svaret visas ---
let latest = 0, framed = false, pinFrame = false, lastSnapshot = null;
const history = [], future = [];
const snapshot = () => JSON.stringify({ kind: kind.id, recipe: state.recipe, spec: state.spec });
function commit() { history.push(lastSnapshot); future.length = 0; lastSnapshot = snapshot(); regenerate(); }
async function regenerate() {
  const id = ++latest;
  busy(true, 'Bygger…');
  const t0 = performance.now();
  const res = await api('/api/generate', { generator: 'tree', recipe: recipeNow() });
  if (id !== latest) return;
  if (res.error) return showError(res.error);
  await showModel(res.url);
  if (id !== latest) return;
  if (!framed || pinFrame) { frame(current, ...pinned); framed = true; pinFrame = false; }
  showAssetStats(res, performance.now() - t0);
  measureSoon('modellen byggdes om');
}
function busy(on, text) { $('lamp').className = 'lamp' + (on ? ' busy' : ''); if (text) setState(text); }
// Statusen syns som text i breda fönster och som tooltip på lampan i smala
function setState(text) { $('state').textContent = text; $('status').title = text; }
function showError(e) { $('lamp').className = 'lamp bad'; setState('Fel'); $('warn').textContent = e; }
const LABELS = { floating_clusters: 'bollar som inte sitter på en kvist', uncovered_twigs: 'kvistar som sticker ut', disconnected: 'lösa grenar',
  nodes_below_ground: 'grenar under marken', thicker_than_parent: 'grenar tjockare än sin förälder', wind_torn: 'hörn som slits isär i vinden' };
function showAssetStats(res, ms) {
  const c = res.checks ?? {};
  $('lamp').className = 'lamp ' + (c.ok ? 'ok' : 'bad');
  setState(c.ok ? 'Kontrollerna är gröna' : 'Kontrollerna är röda');
  const vals = [
    ['Trianglar', (res.tris_lod ?? []).map((n) => fmt(n)).join(' / ')],
    ['varav alfa', (res.alpha_tris_lod ?? []).map((n) => fmt(n)).join(' / ')],
    ['Bollar', `${c.clusters ?? '–'} (${c.tip_balls ?? 0} spets)`],
    ['Kort', `${fmt(c.cards)} à ${c.card_m ?? '–'} m`],
    ['Silhuett', c.silhouette_m2 ? `${c.silhouette_m2} m²` : '–'],
    ['Grenar i kronan', c.branch_cover != null ? `${Math.round(c.branch_cover * 100)} %` : '–'],
    ['Byggtid', `${fmt(ms / 1000, 1)} s`],
  ];
  $('assetStats').innerHTML = vals.map(([a, b]) => `<span>${a} <b>${b}</b></span>`).join('');
  $('warn').textContent = Object.entries(LABELS).filter(([k]) => c[k]).map(([k, t]) => `${c[k]} ${t}`).join(' · ');
}

// --- Prestanda: mät hur lång tid en bild tar (synkront, så att grafikkortet hinner klart), jämför med förra ---
let prevPerf = null, measureTimer = 0, pendingReason = '';
function measureSoon(reason) {
  pendingReason = reason;
  clearTimeout(measureTimer);
  measureTimer = setTimeout(measure, 600);
}
function measure() {
  if (!current) return;
  paused = true;
  const gl = renderer.getContext(), px = new Uint8Array(4), N = 12;
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  draw(); sync(); // uppvärmning (skuggkartor, nya shaders)
  renderer.info.autoReset = false;
  renderer.info.reset();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) draw();
  sync();
  const ms = (performance.now() - t0) / N;
  const calls = renderer.info.render.calls / N, tris = renderer.info.render.triangles / N;
  renderer.info.autoReset = true;
  paused = false;
  const perf = { ms, calls, tris, reason: pendingReason };
  $('perfStats').innerHTML = [
    `<span><b>${fmt(ms, 1)} ms</b> per bild</span>`,
    `<span>≈ ${fmt(Math.min(999, 1000 / ms))} fps</span>`,
    `<span>${fmt(calls)} ritanrop</span>`,
    `<span>${fmt(tris / 1000)} k trianglar per bild (med skuggpass)</span>`,
  ].join('');
  if (prevPerf) {
    const d = ms - prevPerf.ms, pct = (100 * d) / prevPerf.ms, cls = Math.abs(pct) < 5 ? '' : d > 0 ? 'up' : 'down';
    const dc = calls - prevPerf.calls;
    $('perfDelta').innerHTML = `<span class="delta ${cls}"><b>${d >= 0 ? '+' : ''}${fmt(d, 1)} ms (${pct >= 0 ? '+' : ''}${fmt(pct)} %)</b></span>`
      + `<span>ritanrop ${dc >= 0 ? '+' : ''}${fmt(dc)}</span><span>efter: ${perf.reason}</span>`;
  }
  prevPerf = perf;
}

// --- Panelen: ett kort per del av tillgången (params.json: parts, groups, params) ---
const texLists = Object.fromEntries(await Promise.all(['leaves', 'bark', 'blend'].map(async (k) => [k, await api(`/api/textures?kind=${k}`)])));
const syncs = [], whens = [];
const decimals = (p) => (p.type === 'int' || p.type === 'intrange' ? 0 : Math.max(0, Math.ceil(-Math.log10(p.step ?? 0.01) - 1e-9)));
const isView = (p) => p.path.startsWith('view.');
const optionLabel = (p, v) => Object.entries(p.options ?? {}).find(([, x]) => x === v)?.[0] ?? v;
// Spaken släpps (eller ett val görs): spara i tillståndet och bygg om, eller ändra visningen direkt och mät kostnaden
function commitParam(p, v) {
  if (p.path === 'recipe.preset') resetSpecies(v);
  else setValue(p, v);
  refreshUi();
  if (isView(p)) { applyViewAll(); measureSoon(`${p.label}: ${p.type === 'select' ? optionLabel(p, v) : p.type === 'bool' ? (v ? 'på' : 'av') : v}`); }
  else commit();
}

function texturePicker(p) {
  const wrap = el('div', 'tex'), now = el('div', 'now'), img = el('img'), text = el('span'), grid = el('div', 'grid');
  img.alt = '';
  now.append(img, text);
  const list = texLists[p.kind] ?? [];
  const figs = list.map((t) => {
    const f = el('figure'), i = el('img');
    i.loading = 'lazy'; i.src = t.thumb; i.alt = '';
    f.title = t.name;
    f.append(i, el('figcaption', null, t.name.replace(/^(bark_|leaf_?)/, '')));
    f.onclick = () => { wrap.classList.remove('open'); commitParam(p, t.name); };
    grid.append(f);
    return [t.name, f];
  });
  now.onclick = () => wrap.classList.toggle('open');
  now.title = 'Klicka för att byta';
  wrap.append(now, grid);
  syncs.push(() => {
    const name = valueOf(p), t = list.find((x) => x.name === name);
    img.src = t?.thumb ?? `/assets/textures/${name}.png`;
    text.replaceChildren(el('b', null, p.label), document.createTextNode(name));
    for (const [n, f] of figs) f.classList.toggle('sel', n === name);
  });
  return wrap;
}

const kindRows = []; // spakar som bara gäller vissa flikar (kinds) eller vissa val (when) i params.json
function makeRow(p) {
  const row = el('div', 'row');
  if (p.kinds || p.when) kindRows.push([row, p]);
  if (p.help) row.title = p.help;
  const label = el('label', null, p.label);
  if (p.type === 'texture') { row.classList.add('texrow'); row.append(texturePicker(p)); return row; }
  if (p.type === 'select') {
    row.classList.add('span2');
    const sel = el('select');
    const fill = () => {
      // Artlistan visar bara arterna för den valda fliken (Träd, Buske ...)
      const opts = Object.entries(p.options).filter(([, val]) => p.path !== 'recipe.preset' || (kind.species ?? []).includes(val));
      sel.replaceChildren(...opts.map(([lab, val]) => { const o = el('option', null, lab); o.value = JSON.stringify(val); return o; }));
    };
    sel.onchange = () => commitParam(p, JSON.parse(sel.value));
    syncs.push(() => { if (p.path === 'recipe.preset') fill(); sel.value = JSON.stringify(valueOf(p)); });
    fill();
    row.append(label, sel);
  } else if (p.type === 'bool') {
    row.classList.add('span2');
    // Av/på-reglage; invert visar motsatsen till värdet (t.ex. Stam på = stemless false)
    const box = el('input', 'switch');
    box.type = 'checkbox';
    box.onchange = () => commitParam(p, p.invert ? !box.checked : box.checked);
    syncs.push(() => { box.checked = p.invert ? !valueOf(p) : !!valueOf(p); });
    row.append(label, box);
  } else if (p.type === 'color') {
    row.classList.add('span2');
    const c = el('input');
    c.type = 'color';
    c.onchange = () => commitParam(p, c.value);
    syncs.push(() => { c.value = valueOf(p); });
    row.append(label, c);
  } else if (p.type === 'seed') {
    const n = el('input'), b = el('button', null, 'Nytt');
    n.type = 'number'; n.min = 0; n.max = 99999;
    n.onchange = () => commitParam(p, Number(n.value));
    b.title = 'Slumpa ett nytt frö';
    b.onclick = () => commitParam(p, Math.floor(Math.random() * 99999));
    syncs.push(() => { n.value = valueOf(p); });
    row.append(label, n, b);
  } else {
    const r = el('input'), out = el('output');
    r.type = 'range'; r.min = p.min; r.max = p.max; r.step = p.type === 'int' || p.type === 'intrange' ? 1 : p.step;
    const show = () => { out.textContent = Number(r.value).toFixed(decimals(p)); };
    r.oninput = () => { show(); if (isView(p)) { setValue(p, Number(r.value)); applyViewAll(); } };
    r.onchange = () => commitParam(p, Number(r.value));
    syncs.push(() => { r.value = valueOf(p); show(); });
    row.append(label, r, out);
  }
  return row;
}

let assetTitle = null;
for (const part of P.parts) {
  const groups = P.groups.filter((g) => g.part === part.id);
  const params = P.params.filter((q) => groups.some((g) => g.id === q.group));
  if (!params.length) continue;
  const card = el('section', 'card glass');
  card.style.setProperty('--part', part.accent);
  const head = el('header'), h2 = el('h2', null, part.label);
  if (part.id === 'asset') assetTitle = h2; // byter namn efter fliken (Träd, Buske ...)
  head.append(h2);
  card.append(head);
  const heroes = params.filter((q) => q.hero);
  if (heroes.length) { const h = el('div', 'hero'); for (const q of heroes) h.append(texturePicker(q)); card.append(h); }
  for (const g of groups) {
    const items = params.filter((q) => q.group === g.id && !q.hero);
    if (!items.length) continue;
    const det = el('details', 'group');
    det.open = !!g.open;
    det.append(el('summary', null, g.label));
    const rows = el('div', 'rows');
    for (const q of items) rows.append(makeRow(q));
    det.append(rows);
    card.append(det);
    if (g.when) whens.push([det, g.when]);
  }
  $('side').append(card);
}
function refreshUi() {
  for (const s of syncs) s();
  for (const [det, w] of whens) det.style.display = valueOf(paramAt(w.path)) === w.equals ? '' : 'none';
  if (assetTitle) assetTitle.textContent = kind.label;
  for (const [row, p] of kindRows) {
    const show = (!p.kinds || p.kinds.includes(kind.id)) && (!p.when || valueOf(paramAt(p.when.path)) === p.when.equals);
    row.style.display = show ? '' : 'none';
  }
  for (const b of $('kinds').children) b.classList.toggle('on', b.dataset.kind === kind.id);
}

// --- Header: flikar för tillgångstyp och verktyg ---
for (const k of P.kinds) {
  const b = el('button', null, k.label);
  b.dataset.kind = k.id;
  if (k.soon) { b.disabled = true; b.title = 'Kommer: generatorn behöver sina spakar (params.json) först'; b.append(el('span', 'soon', 'snart')); }
  else b.onclick = () => selectKind(k);
  $('kinds').append(b);
}
function selectKind(k) {
  if (k.id === kind.id) return;
  kind = k;
  resetSpecies(k.species[0], k.height);
  framed = false;
  for (const r of pinned) { scene.remove(r); dispose(r); }
  pinned.length = 0;
  refreshUi();
  commit();
}
$('pin').onclick = () => {
  if (!current) return;
  pinned.unshift(current);
  current = null;
  pinned.forEach((r, i) => r.position.set(-(i + 1) * spacing(), 0, 0));
  pinFrame = true;
  regenerate();
};
$('unpin').onclick = () => { for (const r of pinned) { scene.remove(r); dispose(r); } pinned.length = 0; };
$('undo').onclick = () => { if (!history.length) return; future.push(lastSnapshot); restore(history.pop()); };
$('redo').onclick = () => { if (!future.length) return; history.push(lastSnapshot); restore(future.pop()); };
$('frame').onclick = () => frame(current, ...pinned);
$('save').onclick = save;
function restore(snap) {
  const s = JSON.parse(snap);
  kind = P.kinds.find((k) => k.id === s.kind) ?? kind;
  state.recipe = s.recipe; state.spec = s.spec;
  lastSnapshot = snap;
  refreshUi();
  regenerate();
}

// Miniatyr: bara den aktuella tillgången, inramad, kvadratiskt utsnitt av vyn
function thumbnail() {
  const saved = { pos: camera.position.clone(), target: controls.target.clone() };
  pinned.forEach((r) => (r.visible = false));
  frame(current);
  controls.update();
  draw();
  const src = renderer.domElement, s = Math.min(src.width, src.height);
  const c = document.createElement('canvas');
  c.width = c.height = 384;
  c.getContext('2d').drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 384, 384);
  pinned.forEach((r) => (r.visible = true));
  camera.position.copy(saved.pos); controls.target.copy(saved.target);
  return c.toDataURL('image/jpeg', 0.88);
}
async function save() {
  if (!current) return;
  const suggestion = `${state.recipe.preset}_${state.recipe.seed}`;
  const name = prompt('Namn i biblioteket (a–z, 0–9 och _):', suggestion);
  if (!name) return;
  const tags = [kind.label.toLowerCase(), ...(prompt('Taggar, kommaseparerade (t.ex. skog, sommar):', '') ?? '').split(',')];
  const payload = { generator: 'tree', name: name.trim().toLowerCase(), tags, recipe: recipeNow(), thumbnail: thumbnail() };
  busy(true, 'Sparar…');
  let res = await api('/api/library', payload);
  if (res.exists && confirm(`${payload.name} finns redan. Skriva över?`)) res = await api('/api/library', { ...payload, overwrite: true });
  busy(false);
  $('lamp').className = 'lamp ' + (res.error ? 'bad' : 'ok');
  setState(res.error ? 'Sparades inte' : 'Sparad');
  $('note').textContent = res.error ? res.error : `Sparad i biblioteket: ${res.entry.model}`;
}

window.__studio = { camera, controls, state, frame: () => frame(current, ...pinned), measure }; // för felsökning och automatiska tester

// Start: första fliken och dess första art
resetSpecies(kind.species[0], kind.height);
refreshUi();
lastSnapshot = snapshot();
applyViewAll();
regenerate();
