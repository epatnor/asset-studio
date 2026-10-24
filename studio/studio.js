// Asset Studio (docs/asset-studio.md): spakar för generatorerna, byggda från deras params.json. Ren klientkod;
// generatorerna körs av studioservern (tools/studio/server.mjs) via dess API.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { shareTextures } from '../showcase/shared_textures.js';
import { createMaterialPatcher, applyShadowRole } from '../showcase/materials.js';

const $ = (id) => document.getElementById(id);
const api = (p, payload) => fetch(p, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {})
  .then((r) => r.json());

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

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
const timer = new THREE.Timer();
renderer.setAnimationLoop((t) => {
  timer.update(t);
  wind.uTime.value = timer.getElapsed();
  controls.update();
  renderer.render(scene, camera);
});

// --- Tillstånd: receptet, arten (som i species.json) och visningens val ---
const gens = await api('/api/generators');
const G = gens.tree, P = G.params;
const state = { recipe: {}, spec: {}, view: {} };
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, p, v) => {
  const keys = p.split('.'), last = keys.pop();
  let o = obj;
  for (const [i, k] of keys.entries()) o = (o[k] ??= /^\d+$/.test(keys[i + 1] ?? last) ? [] : {});
  o[last] = v;
};
// Värde för en spak: det som är satt, annars artens värde (recipe.leaves m.fl. finns som leaves i arten), annars standard
function valueOf(p) {
  let v = getPath(state, p.path);
  if (v === undefined && p.path.startsWith('recipe.')) v = state.spec[p.path.slice(7)];
  if (Array.isArray(v) && p.type === 'intrange') v = v[0];
  return v ?? p.default ?? (p.type === 'bool' ? false : p.min ?? 0);
}
function setValue(p, v) {
  if (p.type === 'intrange') {
    const old = getPath(state, p.path), width = Array.isArray(old) ? old[1] - old[0] : 2;
    setPath(state, p.path, [v, v + width]);
  } else setPath(state, p.path, v);
}
function resetSpecies(preset) {
  state.spec = structuredClone(G.species[preset]);
  const height = state.recipe.height ?? 8, seed = state.recipe.seed ?? 47;
  state.recipe = { preset, height, seed };
}
const recipeNow = () => ({
  preset: `${state.recipe.preset}_medium`, seed: state.recipe.seed, height: state.recipe.height,
  leaves: valueOf({ path: 'recipe.leaves' }), bark: valueOf({ path: 'recipe.bark' }), leaf_tint: valueOf({ path: 'recipe.leaf_tint' }),
  species: { trunk: state.spec.trunk, levels: state.spec.levels }, canopy: state.spec.foliage,
});

// --- Modellerna: den aktuella i mitten, fästa till vänster för jämförelse ---
let current = null;
const pinned = [];
const SPACING = 13;
function applyView(root) {
  root.traverse((o) => {
    const lod = o.name.match(/_LOD(\d)$/);
    if (lod) o.visible = Number(lod[1]) === Number(state.view.lod ?? 0);
    if (!o.isMesh) return;
    const proxy = o.material.userData?.shadowProxy;
    if (proxy) { o.material.colorWrite = !!state.view.showShadowProxy; o.material.wireframe = true; }
    else o.material.wireframe = !!state.view.wireframe;
  });
}
function applyViewAll() {
  for (const r of [current, ...pinned]) if (r) applyView(r);
  wind.uWind.value = state.view.wind ?? 0.6;
  for (const k of ['uTrans', 'uLeafSpec', 'uEdgeFade', 'uLeafShadow']) if (state.view[k] !== undefined) leaf[k].value = state.view[k];
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
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  controls.target.set(c.x, size.y * 0.5, c.z);
  camera.position.set(c.x + size.y * 0.35, size.y * 0.55, c.z + Math.max(size.y, size.x) * 1.9);
}

// --- Generering: när en spak släpps byggs trädet om; bara det senaste svaret visas ---
let latest = 0, framed = false, pinFrame = false;
const history = [], future = [];
const snapshot = () => JSON.stringify({ recipe: state.recipe, spec: state.spec });
function commit() { history.push(lastSnapshot); future.length = 0; lastSnapshot = snapshot(); regenerate(); }
let lastSnapshot = null;
async function regenerate() {
  const id = ++latest;
  busy(true, 'Bygger…');
  const t0 = performance.now();
  const res = await api('/api/generate', { generator: 'tree', recipe: recipeNow() });
  if (id !== latest) return;
  if (res.error) { busy(false); return showError(res.error); }
  await showModel(res.url);
  if (id !== latest) return;
  if (!framed || pinFrame) { frame(current, ...pinned); framed = true; pinFrame = false; }
  showStats(res, performance.now() - t0);
}
function busy(on, text) { $('lamp').className = 'lamp' + (on ? ' busy' : ''); if (text) $('state').textContent = text; }
function showError(e) { $('lamp').className = 'lamp bad'; $('state').textContent = 'Fel'; $('warn').textContent = e; }
const LABELS = { floating_clusters: 'bollar som inte sitter på en kvist', uncovered_twigs: 'kvistar som sticker ut', disconnected: 'lösa grenar',
  nodes_below_ground: 'grenar under marken', thicker_than_parent: 'grenar tjockare än sin förälder', wind_torn: 'hörn som slits isär i vinden' };
function showStats(res, ms) {
  const c = res.checks ?? {};
  $('lamp').className = 'lamp ' + (c.ok ? 'ok' : 'bad');
  $('state').textContent = c.ok ? 'Kontrollerna är gröna' : 'Kontrollerna är röda';
  const fmt = (n) => (n ?? 0).toLocaleString('sv-SE');
  const rows = [
    ['Trianglar LOD0 / 1 / 2', (res.tris_lod ?? []).map(fmt).join(' / ')],
    ['varav alfa', (res.alpha_tris_lod ?? []).map(fmt).join(' / ')],
    ['Bollar (spetsbollar)', `${c.clusters ?? '–'} (${c.tip_balls ?? 0})`],
    ['Kort', fmt(c.cards)],
    ['Kortets sida', c.card_m ? `${c.card_m} m` : '–'],
    ['Silhuett framifrån', c.silhouette_m2 ? `${c.silhouette_m2} m²` : '–'],
    ['Grenar inne i kronan', c.branch_cover != null ? `${Math.round(c.branch_cover * 100)} %` : '–'],
    ['Byggtid', `${(ms / 1000).toFixed(1)} s`],
  ];
  $('numbers').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  $('warn').textContent = Object.entries(LABELS).filter(([k]) => c[k]).map(([k, t]) => `${c[k]} ${t}`).join('\n');
}
function showTextures() {
  $('texLeaves').src = `/assets/textures/${valueOf({ path: 'recipe.leaves' })}.png`;
  $('texBark').src = `/assets/textures/${valueOf({ path: 'recipe.bark' })}.png`;
}

// --- Panelen: byggs från params.json ---
const gui = new GUI({ title: P.label, width: 320 });
const folders = Object.fromEntries(P.groups.map((g) => {
  const f = gui.addFolder(g.label);
  if (!g.open) f.close();
  return [g.id, f];
}));
const ui = {};
const controllers = [];
const texLists = { leaves: await api('/api/textures?kind=leaves'), bark: await api('/api/textures?kind=bark') };
for (const p of P.params) {
  const key = p.path;
  ui[key] = valueOf(p);
  const f = folders[p.group] ?? gui;
  let c;
  if (p.type === 'select') c = f.add(ui, key, p.options);
  else if (p.type === 'texture') c = f.add(ui, key, texLists[p.kind].map((t) => t.name));
  else if (p.type === 'color') c = f.addColor(ui, key);
  else if (p.type === 'bool') c = f.add(ui, key);
  else if (p.type === 'seed') c = f.add(ui, key, 0, 99999, 1);
  else c = f.add(ui, key, p.min, p.max, p.type === 'int' || p.type === 'intrange' ? 1 : p.step);
  c.name(p.label);
  if (p.help) c.domElement.title = p.help;
  const live = key.startsWith('view.');
  const apply = (v) => {
    if (key === 'recipe.preset') { resetSpecies(v); refreshUi(); }
    else setValue(p, v);
    if (p.type === 'texture') showTextures();
  };
  if (live) c.onChange((v) => { apply(v); applyViewAll(); });
  else c.onFinishChange((v) => { apply(v); commit(); });
  controllers.push([p, c]);
  if (p.type === 'seed') f.add({ nytt: () => {
    const v = Math.floor(Math.random() * 99999);
    c.setValue(v); // setValue anropar bara onChange, så receptet uppdateras här
    setValue(p, v);
    commit();
  } }, 'nytt').name('Nytt frö');
}
function refreshUi() {
  for (const [p, c] of controllers) { ui[p.path] = valueOf(p); c.updateDisplay(); }
  showTextures();
}

// Verktyg: jämför, ångra, spara
const tools = gui.addFolder('Verktyg');
tools.add({ f: () => {
  if (!current) return;
  pinned.unshift(current);
  current = null;
  pinned.forEach((r, i) => r.position.set(-(i + 1) * SPACING, 0, 0));
  pinFrame = true;
  regenerate();
} }, 'f').name('Fäst (jämför bredvid)');
tools.add({ f: () => { for (const r of pinned) { scene.remove(r); dispose(r); } pinned.length = 0; } }, 'f').name('Ta bort fästa');
tools.add({ f: () => {
  if (!history.length) return;
  future.push(lastSnapshot);
  restore(history.pop());
} }, 'f').name('Ångra');
tools.add({ f: () => {
  if (!future.length) return;
  history.push(lastSnapshot);
  restore(future.pop());
} }, 'f').name('Gör om');
tools.add({ f: () => frame(current, ...pinned) }, 'f').name('Rama in allt');
tools.add({ f: save }, 'f').name('Spara till biblioteket…');
function restore(snap) {
  const s = JSON.parse(snap);
  state.recipe = s.recipe; state.spec = s.spec;
  lastSnapshot = snap;
  refreshUi();
  regenerate();
}

// Miniatyr: bara det aktuella trädet, inramat, kvadratiskt utsnitt av vyn
function thumbnail() {
  const saved = { pos: camera.position.clone(), target: controls.target.clone() };
  pinned.forEach((r) => (r.visible = false));
  frame(current);
  controls.update();
  renderer.render(scene, camera);
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
  const tags = (prompt('Taggar, kommaseparerade (t.ex. lövträd, skog, sommar):', '') ?? '').split(',');
  const payload = { generator: 'tree', name: name.trim().toLowerCase(), tags, recipe: recipeNow(), thumbnail: thumbnail() };
  busy(true, 'Sparar…');
  let res = await api('/api/library', payload);
  if (res.exists && confirm(`${payload.name} finns redan. Skriva över?`)) res = await api('/api/library', { ...payload, overwrite: true });
  busy(false);
  $('lamp').className = 'lamp ' + (res.error ? 'bad' : 'ok');
  $('msg').textContent = res.error ? `Sparades inte: ${res.error}` : `Sparad i biblioteket: ${res.entry.model}`;
}

// Start: första arten
resetSpecies(P.species[0]);
ui['recipe.preset'] = P.species[0];
refreshUi();
lastSnapshot = snapshot();
applyViewAll();
regenerate();
