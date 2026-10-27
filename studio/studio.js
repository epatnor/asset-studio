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
import { createWorkshop } from './workshop.js';
import { createLibrary } from './library.js';
import { createHome, DEPARTMENTS, VAULT } from './home.js';
import { createForgeDrawer } from './drawer.js';
import { createWindmill } from './windmill.js';
import { createCauldron } from './cauldron.js';
import { createWeather } from './weather.js';
import { createWaterTab } from './water.js';
import { createGpuMenu, gpuPreference, frameGate } from './gpu.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const api = (p, payload) => fetch(p, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {})
  .then((r) => r.json());
const fmt = (n, d = 0) => (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// --- Scen: samma ljus, himmel och mark som visningen (showcase/index.html) ---
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: gpuPreference() });
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
// Marken: målat gräs (ground_lush, nedtonat så att träden får stå i fokus), en upprepning per 2,5 m. En andra,
// mycket större upprepning av samma textur multipliceras in, så att rutnätet inte syns på avstånd
const grassTex = new THREE.TextureLoader().load('/assets/textures/ground_lush.png', (t) => { t.needsUpdate = true; });
grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
grassTex.colorSpace = THREE.SRGBColorSpace;
grassTex.anisotropy = 8;
grassTex.repeat.set(240, 240); // skivan är 600 m bred
const groundMat = new THREE.MeshStandardMaterial({ color: '#b4c7a0', map: grassTex, roughness: 1 });
groundMat.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
    diffuseColor.rgb *= mix(vec3(0.82), vec3(1.12), texture2D(map, vMapUv * 0.031 + 0.37).g);`);
};
const ground = new THREE.Mesh(new THREE.CircleGeometry(300, 64), groundMat);
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

// Efterbehandling (bara när ambient occlusion är på): render -> GTAO -> tonmappning.
// GTAO ritar annars djup och normaler med ett eget material som inte ser lövens alfa, så att korten blir
// mörka fyrkanter. Därför ritas djupet här med djupmaterial som klipper bort det genomskinliga (som skuggorna
// gör), och GTAO räknar fram normalerna ur det djupet. Skuggformen och himlen ritar inget djup och hoppas över.
let composer = null, aoDepth = null;
const depthMats = new WeakMap();
const depthMatFor = (m) => {
  if (!depthMats.has(m)) depthMats.set(m, new THREE.MeshDepthMaterial({ map: m.map ?? null, alphaTest: m.alphaTest || 0, side: m.side }));
  return depthMats.get(m);
};
function renderAoDepth() {
  const swaps = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    swaps.push([o, o.material, o.visible]);
    if (o.material.colorWrite === false || o.material.depthWrite === false) o.visible = false;
    else o.material = depthMatFor(o.material);
  });
  renderer.setRenderTarget(aoDepth);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  for (const [o, m, v] of swaps) { o.material = m; o.visible = v; }
}
function setAO(on) {
  if (!on) { composer?.dispose(); aoDepth?.dispose(); composer = aoDepth = null; return; }
  if (composer) return;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  aoDepth = new THREE.WebGLRenderTarget(size.x, size.y, { depthTexture: new THREE.DepthTexture(size.x, size.y) });
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // Djupet sätts efteråt: i three r186 kraschar konstruktorn om det ges direkt (den läser ett internt mål
  // som då inte finns). Utan normaltextur räknar GTAO fram normalerna ur djupet.
  const ao = new GTAOPass(scene, camera, size.x, size.y);
  ao.setGBuffer(aoDepth.depthTexture, undefined);
  ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5 });
  composer.addPass(ao);
  composer.addPass(new OutputPass());
}
const draw = () => {
  if (!composer) return renderer.render(scene, camera);
  renderAoDepth();
  composer.render();
};

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
  if (aoDepth) { const size = renderer.getDrawingBufferSize(new THREE.Vector2()); aoDepth.setSize(size.x, size.y); }
});
const timer = new THREE.Timer();
let paused = false;
const gate = frameGate(); // bildtakten (grafikkortsmenyn): taket gäller alla 3D-vyer
renderer.setAnimationLoop((t) => {
  if (paused || !gate(performance.now())) return;
  timer.update(t);
  wind.uTime.value = timer.getElapsed();
  controls.update();
  draw();
});

// --- Tillstånd: receptet, arten (som i species.json) och visningens val ---
const gens = await api('/api/generators');
// Träden är huvudgeneratorn (flikarna står i dess params.json); andra generatorer (stenarna: prop) lägger till sina kort,
// grupper och spakar, och en flik med generator: prop bygger med den. Korten har kinds, så att bara flikens kort syns.
const G = gens.tree, GX = Object.entries(gens).filter(([id]) => id !== 'tree').map(([, g]) => g.params);
const P = { ...G.params, parts: [...G.params.parts, ...GX.flatMap((x) => x.parts)], groups: [...G.params.groups, ...GX.flatMap((x) => x.groups)], params: [...G.params.params, ...GX.flatMap((x) => x.params)] };
const genOf = (k) => k?.generator ?? 'tree';
// Smedjans mallar (lådan till vänster): en färdig tillgång per familj (tools/tree/templates.json); stenarnas mallar är
// presetsen i props-generatorn, med namnen från dess Kind-spak
const TEMPLATES = await fetch('/tools/tree/templates.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}));
const PROP_KINDS = Object.fromEntries(Object.entries(gens.prop?.params.params.find((q) => q.path === 'recipe.preset')?.options ?? {}).map(([l, v]) => [v, l]));
function templatesOf(k) {
  if (genOf(k) === 'prop') return (k.species ?? []).map((id) => ({ id, label: PROP_KINDS[id] ?? id }));
  return (TEMPLATES[k.id] ?? []).map((t) => ({ id: t.id, label: t.label, help: t.help, preset: t.recipe.preset,
    model: `assets/trees/${t.id}/${t.id}.gltf`, recipe: `assets/trees/${t.id}/recipe.json` }));
}
const state = { recipe: {}, spec: {}, view: {} };
let kind = P.kinds[0];
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, p, v) => {
  const keys = p.split('.'), last = keys.pop();
  let o = obj;
  for (const [i, k] of keys.entries()) o = (o[k] ??= /^\d+$/.test(keys[i + 1] ?? last) ? [] : {});
  o[last] = v;
};
// Färger kan vara sparade som palettnamn (palette:foliage_light, som i species.json); färgväljaren vill ha #rrggbb
const PALETTE = (await fetch('/tools/style.json').then((r) => r.json())).palette;
const colorOf = (v) => (typeof v === 'string' && v.startsWith('palette:') ? PALETTE[v.slice(8)] ?? '#888888' : v);
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
  state.spec = structuredClone(gens[genOf(kind)].species[preset]);
  state.recipe = { preset, height: height ?? state.recipe.height ?? kind.height ?? 8, seed: state.recipe.seed ?? 47,
    bark_blend: structuredClone(state.spec.bark_blend ?? {}) };
}
// Som generatorns merge (gen_tree.mjs): objekt slås ihop, listor av objekt index för index, allt annat ersätts
function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') v.forEach((x, i) => deepMerge((dst[k] ??= [])[i] ??= {}, x));
    else if (v && typeof v === 'object' && !Array.isArray(v)) deepMerge((dst[k] ??= {}), v);
    else dst[k] = v;
  }
  return dst;
}
// Läs in ett sparat recept (som make_tree.py skriver i recipe.json): artens värden med receptets överst
function loadRecipe(r) {
  resetSpecies(r.preset.split('_')[0], r.height);
  const sp = state.spec;
  deepMerge(sp, r.species ?? {});
  Object.assign(sp.foliage, r.canopy ?? {});
  Object.assign(state.recipe, { seed: r.seed ?? state.recipe.seed, bark_blend: structuredClone(r.bark_blend ?? state.recipe.bark_blend) });
  for (const k of ['leaves', 'bark', 'leaf_tint', 'bole']) if (r[k] !== undefined) state.recipe[k] = r[k];
  if (r.bark_uv) state.recipe.bark_uv = { ...r.bark_uv };
}
// Fliken startar med sitt startrecept (params.json: kinds[].start, ett namn i biblioteket), annars med sin första art
async function startKind(k) {
  if (k.start) {
    const r = await fetch(`/assets/trees/${k.start}/recipe.json`, { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (r) { loadRecipe(r); drawer?.mark(`assets/trees/${k.start}/${k.start}.gltf`); return; }
  }
  resetSpecies(k.species[0], k.height);
  drawer?.mark(null);
}
// Texturblandningen: artens värden, ändrade spakar ovanpå, och spakarnas standard där arten saknar värde
function blendNow() {
  const out = {};
  for (const p of P.params.filter((q) => q.path.startsWith('recipe.bark_blend.'))) setPath(out, p.path.slice(18), valueOf(p));
  return out;
}
// Stenarna (props-generatorn): presetet, fröet och presetets värden med spakarna ovanpå
const recipeNow = () => (genOf(kind) === 'prop' ? { preset: state.recipe.preset, seed: state.recipe.seed, params: { ...state.spec } } : {
  preset: `${state.recipe.preset}_medium`, seed: state.recipe.seed, height: state.recipe.height, ...(state.recipe.bole > 0 ? { bole: state.recipe.bole } : {}),
  leaves: valueOf(paramAt('recipe.leaves')), bark: valueOf(paramAt('recipe.bark')), leaf_tint: valueOf(paramAt('recipe.leaf_tint')),
  // growth och colonize: det odlade skelettet; foliage.type: lövverkets slag (none = kalt träd), som generatorn läser ur arten
  species: { trunk: state.spec.trunk, levels: state.spec.levels, stemless: !!state.spec.stemless, growth: state.spec.growth ?? 'levels',
    ...(state.spec.colonize ? { colonize: state.spec.colonize } : {}), foliage: { type: state.spec.foliage.type } },
  canopy: state.spec.foliage, bark_blend: blendNow(),
  ...barkUvNow(),
});
// Barkens skala på just det här trädet (bark_uv), relativt materialets; bara det som avviker från 1 sparas
function barkUvNow() {
  const uv = Object.fromEntries(['tiling', 'along', 'around'].map((k) => [k, valueOf(paramAt(`recipe.bark_uv.${k}`))]).filter(([, v]) => v !== 1));
  return Object.keys(uv).length ? { bark_uv: uv } : {};
}
// Knappar i spakarna (params.json: type action)
const ACTIONS = {
  // Use as material default: tilingen blir barkmaterialets egen skala (meter per upprepning) i Ateljén, och trädet
  // går tillbaka till tiling 1, så att det ser likadant ut. Sträckningarna stannar på trädet.
  async barkDefault(note) {
    const name = valueOf(paramAt('recipe.bark')), t = (texLists.bark ?? []).find((x) => x.name === name);
    const base = t?.meters ?? 1.08, tiling = valueOf(paramAt('recipe.bark_uv.tiling'));
    if (tiling === 1) { note.textContent = `Already the material's scale: ${base} m per repeat`; return; }
    const meters = base / tiling;
    if (!confirm(`Make ${name} repeat every ${meters.toFixed(2)} m (now ${base} m) for every asset that uses it?`)) return;
    const r = await api('/api/texture/scale', { name, meters });
    if (r.error) { note.textContent = r.error; return; }
    if (t) t.meters = r.meters;
    commitParam(paramAt('recipe.bark_uv.tiling'), 1);
  },
};

// --- Modellerna: den aktuella i mitten, fästa till vänster för jämförelse ---
let current = null, currentUrl = null; // currentUrl: verkstadens materiallabb kan visa det aktuella trädet
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
  currentUrl = url;
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
  busy(true, 'Building…');
  const t0 = performance.now();
  const res = await api('/api/generate', { generator: genOf(kind), recipe: recipeNow() });
  if (id !== latest) return;
  if (res.error) return showError(res.error);
  await showModel(res.url);
  if (id !== latest) return;
  if (!framed || pinFrame) { frame(current, ...pinned); framed = true; pinFrame = false; }
  showAssetStats(res, performance.now() - t0);
  measureSoon('the model was rebuilt');
}
function busy(on, text) { $('lamp').className = 'lamp' + (on ? ' busy' : ''); if (text) setState(text); }
// Statusen syns som text i breda fönster och som tooltip på lampan i smala
function setState(text) { $('state').textContent = text; $('status').title = text; }
function showError(e) { $('lamp').className = 'lamp bad'; setState('Error'); $('warn').textContent = e; }
const LABELS = { floating_clusters: 'balls not on a twig', uncovered_twigs: 'twigs sticking out', disconnected: 'loose branches',
  nodes_below_ground: 'branches below ground', thicker_than_parent: 'branches thicker than their parent', wind_torn: 'vertices torn apart by the wind' };
function showAssetStats(res, ms) {
  const c = res.checks ?? {};
  $('lamp').className = 'lamp ' + (c.ok ? 'ok' : 'bad');
  setState(c.ok ? 'Checks are green' : 'Checks are red');
  const vals = genOf(kind) === 'prop' ? [
    ['Triangles', (res.tris_lod ?? []).map((n) => fmt(n)).join(' / ')],
    ['Resting on the ground', c.resting_on_ground ? 'yes' : 'no'],
    ['Build time', `${fmt(ms / 1000, 1)} s`],
  ] : [
    ['Height', res.height_m != null ? `${fmt(res.height_m, 1)} m` : '–'], // med stamhöjden (gen_tree: top)
    ['Triangles', (res.tris_lod ?? []).map((n) => fmt(n)).join(' / ')],
    ['of which alpha', (res.alpha_tris_lod ?? []).map((n) => fmt(n)).join(' / ')],
    ['Balls', `${c.clusters ?? '–'} (${c.tip_balls ?? 0} tips)`],
    ['Cards', `${fmt(c.cards)} à ${c.card_m ?? '–'} m`],
    ['Silhouette', c.silhouette_m2 ? `${c.silhouette_m2} m²` : '–'],
    ['Branches in the crown', c.branch_cover != null ? `${Math.round(c.branch_cover * 100)} %` : '–'],
    ['Build time', `${fmt(ms / 1000, 1)} s`],
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
    `<span><b>${fmt(ms, 1)} ms</b> per frame</span>`,
    `<span>≈ ${fmt(Math.min(999, 1000 / ms))} fps</span>`,
    `<span>${fmt(calls)} draw calls</span>`,
    `<span>${fmt(tris / 1000)} k triangles per frame (with shadow pass)</span>`,
  ].join('');
  if (prevPerf) {
    const d = ms - prevPerf.ms, pct = (100 * d) / prevPerf.ms, cls = Math.abs(pct) < 5 ? '' : d > 0 ? 'up' : 'down';
    const dc = calls - prevPerf.calls;
    $('perfDelta').innerHTML = `<span class="delta ${cls}"><b>${d >= 0 ? '+' : ''}${fmt(d, 1)} ms (${pct >= 0 ? '+' : ''}${fmt(pct)} %)</b></span>`
      + `<span>draw calls ${dc >= 0 ? '+' : ''}${fmt(dc)}</span><span>after: ${perf.reason}</span>`;
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
  if (isView(p)) { applyViewAll(); measureSoon(`${p.label}: ${p.type === 'select' ? optionLabel(p, v) : p.type === 'bool' ? (v ? 'on' : 'off') : v}`); }
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
  now.title = 'Click to switch';
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
  if (p.type === 'action') {
    row.classList.add('span2', 'actrow');
    const b = el('button', null, p.button ?? p.label), note = el('span', 'note');
    b.onclick = () => ACTIONS[p.action]?.(note);
    // Materialets skala visas bredvid knappen
    if (p.action === 'barkDefault') syncs.push(() => { const t = (texLists.bark ?? []).find((x) => x.name === valueOf(paramAt('recipe.bark'))); note.textContent = `Material: ${t?.meters ?? 1.08} m per repeat`; });
    row.append(label, b, note);
    return row;
  }
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
    syncs.push(() => { c.value = colorOf(valueOf(p)); });
    row.append(label, c);
  } else if (p.type === 'seed') {
    const n = el('input'), b = el('button', null, 'New');
    n.type = 'number'; n.min = 0; n.max = 99999;
    n.onchange = () => commitParam(p, Number(n.value));
    b.title = 'Roll a new seed';
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
const partCards = []; // kort som bara hör till vissa flikar (part.kinds)
for (const part of P.parts) {
  const groups = P.groups.filter((g) => g.part === part.id);
  const params = P.params.filter((q) => groups.some((g) => g.id === q.group));
  if (!params.length) continue;
  const card = el('section', 'card glass');
  if (part.kinds) partCards.push([card, part]);
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
// Sparakortet: sist i panelen, under alla inställningar (samma mönster som de andra avdelningarna)
{
  const card = el('section', 'card glass savecard');
  card.style.setProperty('--part', '#4a90d9');
  const head = el('header');
  head.append(el('h2', null, 'Save'));
  const note = el('div', 'note', 'Saves what you see as a new family in the library, with its recipe, so it can be opened again here and scattered in the worlds.');
  $('save').classList.remove('asset-tool');
  const rows = el('div', 'rows');
  rows.append(note);
  card.append(head, rows, $('save'));
  $('side').append(card);
}
// Villkor för en spak eller grupp (params.json): {path, equals} eller {path, not}
const holds = (w) => { const v = valueOf(paramAt(w.path)); return 'not' in w ? v !== w.not : v === w.equals; };
function refreshUi() {
  for (const s of syncs) s();
  for (const [det, w] of whens) det.style.display = holds(w) ? '' : 'none';
  for (const [card, part] of partCards) card.style.display = part.kinds.includes(kind.id) ? '' : 'none';
  if (assetTitle) assetTitle.textContent = kind.label;
  for (const [row, p] of kindRows) {
    const show = (!p.kinds || p.kinds.includes(kind.id)) && (!p.when || holds(p.when));
    row.style.display = show ? '' : 'none';
  }
  for (const b of $('kinds').children) b.classList.toggle('on', textureMode ? b === texBtn : libraryMode ? b === libBtn : windMode ? b === windBtn : weatherMode ? b === weatherBtn : waterMode ? b === waterBtn : fxMode ? b.dataset.fx === fxKind : b.dataset.kind === kind.id);
  drawer?.setKind(kind);
  applyDept();
}

// --- Tema: Auto (systemets), Ljust eller Mörkt; sparas i webbläsaren och sätts före första ritningen (index.html) ---
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>',
  dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg>',
};
const THEME_LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };
function setTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { localStorage.setItem('studio-theme', t); } catch {}
  $('theme').innerHTML = THEME_ICONS[t];
  $('theme').title = `Theme: ${THEME_LABELS[t]} (click to cycle Auto, Light and Dark)`;
  $('theme').dataset.t = t;
  dispatchEvent(new Event('studio-theme'));
}
$('theme').onclick = () => setTheme({ auto: 'light', light: 'dark', dark: 'auto' }[$('theme').dataset.t]);
setTheme(document.documentElement.dataset.theme ?? 'auto');
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => dispatchEvent(new Event('studio-theme')));

// --- Header: flikar för tillgångstyp och verktyg ---
for (const k of P.kinds) {
  const b = el('button', null, k.label);
  b.dataset.kind = k.id;
  if (k.soon) { b.disabled = true; b.title = 'Coming: the generator needs its sliders (params.json) first'; b.append(el('span', 'soon', 'soon')); }
  else b.onclick = () => selectKind(k);
  $('kinds').append(b);
}
// Texturverkstaden (studio/workshop.js): egen vy, egna kort och egen footer; skapas första gången den öppnas
const texBtn = el('button', null, 'Texture workshop');
texBtn.dataset.dept = 'atelier';
texBtn.title = 'The Atelier: make and tune textures for assets, terrain and buildings';
// Biblioteket (studio/library.js): familjer och fasta modeller, som FAB; skapas första gången det öppnas
const libBtn = el('button', null, 'Library');
libBtn.dataset.dept = 'vault';
libBtn.title = 'The Vault: everything saved, as families (recipes) and fixed models';
$('kinds').append(libBtn, texBtn);
// Väderkvarnen (studio/windmill.js): Vind är byggd, Vatten och Väder kommer (docs/effektlabb.md)
const windBtn = el('button', null, 'Wind');
windBtn.dataset.dept = 'windmill';
windBtn.title = 'The Windmill: one wind for trees, bushes, flowers, grass and flags, tried in a glade';
$('kinds').append(windBtn);
// Väder (studio/weather.js): börjar med solen och ljusstrålarna
const weatherBtn = el('button', null, 'Weather');
weatherBtn.dataset.dept = 'windmill';
weatherBtn.title = 'The Windmill: time of day and light shafts through the trees (clouds, rain, snow and storms will follow)';
// Vatten (studio/water.js): öppet vatten, strand, bäck och sjö
const waterBtn = el('button', null, 'Water');
waterBtn.dataset.dept = 'windmill';
waterBtn.title = 'The Windmill: water to try out, on open water, a beach, a stream and a lake, under the sky and sun';
$('kinds').append(waterBtn, weatherBtn);
// Häxkitteln (studio/cauldron.js): fyra flikar med en gemensam arena (docs/effektlabb.md, E6)
const FX_TABS = [
  ['glow', 'Glow & aura', 'Glowing rims, light pillars and auras around figures'],
  ['marker', 'Markers', 'Selection rings, targets, ability areas and exclamation marks on the ground'],
  ['particles', 'Particles', 'Sparks, fire, smoke, magic, leaves and dust'],
  ['trail', 'Trails & hits', 'Sword trails, projectiles and hits'],
  ['spell', 'Spells', 'Spells as timed layers: wind-up, flash, flames, lightning, spikes, sparks, smoke, distortion and a camera kick'],
];
for (const [id, label, tip] of FX_TABS) {
  const b = el('button', null, label);
  b.dataset.dept = 'cauldron';
  b.dataset.fx = id;
  b.title = `The Cauldron: ${tip}`;
  b.onclick = () => openCauldron(id);
  $('kinds').append(b);
}
let workshop = null, textureMode = false, library = null, libraryMode = false, homeMode = false, windmill = null, windMode = false;
let cauldron = null, fxMode = false, fxKind = 'glow', weather = null, weatherMode = false, waterTab = null, waterMode = false;
// Miniatyrerna (The Vault och lådan) får samma material som studion, utan vind
const thumbWind = { uTime: { value: 0 }, uWind: { value: 0 } };
const thumbPatch = createMaterialPatcher(THREE, { wind: thumbWind, sunDir });
function prepareThumb(o, url) { applyShadowRole(o); thumbPatch(o.material, url); }
const drawer = createForgeDrawer({ api, el, root: $('fdrawer'), templates: templatesOf, openTemplate, canOpen: (i) => canOpen(i), open: (i) => openInStudio(i), reveal: showInVault, prepare: prepareThumb });

// --- Avdelningarna (docs/avdelningar.md): väljaren i headern, namnet och underrubriken, flikarna och accentfärgen ---
// Flikarna i andra raden hör till en avdelning (data-dept; utan är det The Forge). Läget bestämmer avdelningen.
const DEPTS = Object.fromEntries([...DEPARTMENTS, VAULT].map((d) => [d.id, d]));
for (const d of Object.values(DEPTS)) {
  const b = el('button');
  b.dataset.dept = d.id;
  b.style.setProperty('--dot', d.accent);
  b.append(el('span', null, d.name.replace(/^The /, '')));
  b.title = `${d.name}: ${d.sub}${d.ready ? '' : ' (planned)'}`;
  b.disabled = !d.ready;
  b.onclick = () => openDept(d.id);
  $('depts').append(b);
}
function openDept(id) {
  if (id === 'atelier') texBtn.onclick();
  else if (id === 'vault') libBtn.onclick();
  else if (id === 'windmill') windBtn.onclick();
  else if (id === 'cauldron') openCauldron(fxKind);
  else selectKind(kind);
}
const currentDept = () => (homeMode ? null : textureMode ? 'atelier' : libraryMode ? 'vault' : windMode || weatherMode || waterMode ? 'windmill' : fxMode ? 'cauldron' : 'forge');
function applyDept() {
  const d = currentDept();
  if (d) document.documentElement.dataset.dept = d; else delete document.documentElement.dataset.dept;
  $('dept').querySelector('b').textContent = d ? DEPTS[d].name : '';
  $('dept').querySelector('span').textContent = d ? DEPTS[d].sub : '';
  for (const b of $('kinds').children) b.hidden = (b.dataset.dept ?? 'forge') !== d;
  for (const b of $('depts').children) b.classList.toggle('on', b.dataset.dept === d);
  applyDrawer();
}

// --- Lådorna (docs/avdelningar.md): en per avdelning till vänster; Ctrl+Mellanslag eller knappen fäller ihop den.
// Smedjans låda är studio/drawer.js, Ateljéns är texturverkstadens bibliotek och The Vaults är dess sidopanel.
const drawers = (() => { try { return JSON.parse(localStorage.getItem('studio-drawers')) ?? {}; } catch { return {}; } })();
function applyDrawer() {
  const d = currentDept(), open = !d || drawers[d] !== false;
  document.body.classList.toggle('drawer-closed', !open);
  $('drawerbtn').classList.toggle('on', open);
  $('drawerbtn').title = `${open ? 'Hide' : 'Show'} the drawer (Ctrl+Space)`;
}
function toggleDrawer() {
  const d = currentDept();
  if (!d) return;
  drawers[d] = drawers[d] === false;
  try { localStorage.setItem('studio-drawers', JSON.stringify(drawers)); } catch {}
  applyDrawer();
}
$('drawerbtn').onclick = toggleDrawer;
addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Space') { e.preventDefault(); toggleDrawer(); }
});
// Visa i The Vault: lådorna pekar ut saken där (nyckeln är modellens sökväg, eller texture:<namn>)
async function showInVault(key) {
  await libBtn.onclick();
  if (key) await library.reveal(key);
}
async function openInAtelier(name) {
  await texBtn.onclick();
  await workshop.open(name);
}
libBtn.onclick = async () => {
  leaveHome();
  leaveTextureMode();
  leaveWindMode();
  leaveFxMode();
  leaveWeatherMode(); leaveWaterMode();
  libraryMode = true;
  document.body.classList.add('library-mode');
  paused = true;
  refreshUi();
  library ??= createLibrary({ api, el, root: $('libview'), canOpen, openInStudio, openInAtelier, prepare: prepareThumb });
  await library.show();
};
function leaveLibraryMode() {
  if (!libraryMode) return;
  libraryMode = false;
  document.body.classList.remove('library-mode');
  paused = false;
}
// En familj (eller en fast modells recept) kan öppnas när studion har spakar för dess art
const speciesOf = (item) => String(item.preset ?? '').split('_')[0];
function canOpen(item) { return !!item.recipe && item.type !== 'imported' && !!G.species[speciesOf(item)] && P.kinds.some((k) => k.species?.includes(speciesOf(item))); }
// En mall ur lådan: ett träd eller en buske öppnas som sitt recept; en sten börjar om från sitt preset
async function openTemplate(t) {
  if (t.recipe) return openInStudio({ ...t, name: t.label });
  resetSpecies(t.id, kind.height);
  framed = false;
  refreshUi();
  commit();
  setState(`Started from ${t.label}`);
}
async function openInStudio(item) {
  const r = await fetch(`/${item.recipe}`, { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) { alert(`Could not read the recipe for ${item.name}`); return; }
  leaveLibraryMode();
  kind = P.kinds.find((k) => k.species?.includes(speciesOf(item))) ?? kind;
  loadRecipe(r);
  framed = false;
  for (const p of pinned) { scene.remove(p); dispose(p); }
  pinned.length = 0;
  refreshUi();
  commit();
  drawer.mark(item.model);
  setState(`Opened ${item.name}`);
}
texBtn.onclick = async () => {
  leaveHome();
  leaveLibraryMode();
  leaveWindMode();
  leaveFxMode();
  leaveWeatherMode(); leaveWaterMode();
  textureMode = true;
  document.body.classList.add('texture-mode');
  paused = true; // 3D-vyn behövs inte medan man arbetar med texturer
  refreshUi();
  workshop ??= await createWorkshop({ api, el, side: $('wside'), view: $('wview'), footer: $('wfoot'), lib: $('wlib'), tools: $('tools'), getAssetUrl: () => currentUrl, reveal: showInVault });
  workshop.show();
};
windBtn.onclick = async () => {
  leaveHome();
  leaveLibraryMode();
  leaveTextureMode();
  leaveFxMode();
  leaveWeatherMode(); leaveWaterMode();
  windMode = true;
  document.body.classList.add('wind-mode');
  paused = true; // studions egen 3D-vy behövs inte; gläntan har sin egen renderare
  refreshUi();
  try {
    windmill ??= await createWindmill({ api, el, view: $('wmview'), side: $('wmside'), drawer: $('wmdrawer'), footer: $('wmfoot') });
  } catch (e) {
    $('wmfoot').replaceChildren(el('div', 'msg', `The Windmill could not start: ${e.message ?? e}`));
    console.error(e);
    return;
  }
  if (windMode) windmill.show();
};
function leaveWindMode() {
  if (!windMode) return;
  windMode = false;
  document.body.classList.remove('wind-mode');
  windmill?.hide();
  paused = false;
}
async function openCauldron(id) {
  leaveHome();
  leaveLibraryMode();
  leaveTextureMode();
  leaveWindMode();
  leaveWeatherMode(); leaveWaterMode();
  fxMode = true;
  fxKind = id;
  document.body.classList.add('fx-mode');
  paused = true; // arenan har sin egen renderare
  refreshUi();
  try {
    cauldron ??= await createCauldron({ api, el, view: $('cvview'), side: $('cvside'), drawer: $('cvdrawer'), footer: $('cvfoot') });
  } catch (e) {
    $('cvfoot').replaceChildren(el('div', 'msg', `The Cauldron could not start: ${e.message ?? e}`));
    console.error(e);
    return;
  }
  if (fxMode) cauldron.show(fxKind);
}
weatherBtn.onclick = async () => {
  leaveHome();
  leaveLibraryMode();
  leaveTextureMode();
  leaveWindMode();
  leaveFxMode();
  leaveWaterMode();
  weatherMode = true;
  document.body.classList.add('weather-mode');
  paused = true; // platsen har sin egen renderare
  refreshUi();
  try {
    weather ??= await createWeather({ api, el, view: $('wxview'), side: $('wxside'), drawer: $('wxdrawer'), footer: $('wxfoot') });
  } catch (e) {
    $('wxfoot').replaceChildren(el('div', 'msg', `The weather could not start: ${e.message ?? e}`));
    console.error(e);
    return;
  }
  if (weatherMode) weather.show();
};
waterBtn.onclick = async () => {
  leaveHome();
  leaveLibraryMode();
  leaveTextureMode();
  leaveWindMode();
  leaveFxMode();
  leaveWeatherMode();
  waterMode = true;
  document.body.classList.add('water-mode');
  paused = true; // scenerna har sin egen renderare
  refreshUi();
  try {
    waterTab ??= await createWaterTab({ api, el, view: $('waview'), side: $('waside'), drawer: $('wadrawer'), footer: $('wafoot') });
  } catch (e) {
    $('wafoot').replaceChildren(el('div', 'msg', `The water could not start: ${e.message ?? e}`));
    console.error(e);
    return;
  }
  if (waterMode) waterTab.show();
};
function leaveWaterMode() {
  if (!waterMode) return;
  waterMode = false;
  document.body.classList.remove('water-mode');
  waterTab?.hide();
  paused = false;
}
function leaveWeatherMode() {
  if (!weatherMode) return;
  weatherMode = false;
  document.body.classList.remove('weather-mode');
  weather?.hide();
  paused = false;
}
function leaveFxMode() {
  if (!fxMode) return;
  fxMode = false;
  document.body.classList.remove('fx-mode');
  cauldron?.hide();
  paused = false;
}
function leaveTextureMode() {
  if (!textureMode) return;
  textureMode = false;
  document.body.classList.remove('texture-mode');
  workshop?.hide();
  paused = false;
}
async function selectKind(k) {
  if (homeMode || textureMode || libraryMode || windMode || fxMode || weatherMode || waterMode) { leaveHome(); leaveTextureMode(); leaveLibraryMode(); leaveWindMode(); leaveFxMode(); leaveWeatherMode(); leaveWaterMode(); if (k.id === kind.id) return refreshUi(); }
  if (k.id === kind.id) return;
  kind = k;
  await startKind(k);
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
  const name = prompt('Name in the library (a–z, 0–9 and _):', suggestion);
  if (!name) return;
  const tags = [kind.label.toLowerCase(), ...(prompt('Tags, comma separated (e.g. forest, summer):', '') ?? '').split(',')];
  const payload = { generator: genOf(kind), name: name.trim().toLowerCase(), tags, recipe: recipeNow(), thumbnail: thumbnail() };
  busy(true, 'Saving…');
  let res = await api('/api/library', payload);
  if (res.exists && confirm(`${payload.name} already exists. Overwrite?`)) res = await api('/api/library', { ...payload, overwrite: true });
  busy(false);
  $('lamp').className = 'lamp ' + (res.error ? 'bad' : 'ok');
  setState(res.error ? 'Not saved' : 'Saved');
  $('note').textContent = res.error ? res.error : `Saved to the library: ${res.entry.model}`;
  if (!res.error) { await drawer.refresh(); drawer.mark(res.entry.model); }
}

// För felsökning och automatiska tester. shot(name) sparar 3D-vyn som build/shots/studio_<name>.png.
window.__studio = {
  camera, controls, state, frame: () => frame(current, ...pinned), measure,
  get workshop() { return workshop; }, // texturverkstaden (lab = materiallabbet), när den har öppnats
  get windmill() { return windmill; }, // Väderkvarnen (wind, scene, stats), när den har öppnats
  get weather() { return weather; }, // Väderfliken (vals, apply, shafts, stats), när den har öppnats
  get water() { return waterTab; }, // Vattenfliken (vals, apply, showScene, active, stats), när den har öppnats
  get cauldron() { return cauldron; }, // Häxkitteln (fx, select, stats), när den har öppnats
  prepareThumb, // för att rendera om miniatyrer: renderThumb(url, __studio.prepareThumb) i library.js
  shot: async (name) => {
    controls.update();
    draw();
    const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
    return (await fetch(`/api/shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })).json();
  },
};

// Start: första fliken med sitt startrecept
await startKind(kind);
refreshUi();
lastSnapshot = snapshot();
applyViewAll();
regenerate();
// Landningssidan (studio/home.js): visas vid start och när man klickar på märket i headern
const home = createHome({ el, api, root: $('home'), open: openDept });
createGpuMenu({ el, api, button: $('gpu'), root: document.body });
function goHome() {
  leaveTextureMode(); leaveLibraryMode(); leaveWindMode(); leaveFxMode(); leaveWeatherMode(); leaveWaterMode();
  homeMode = true;
  paused = true; // 3D-vyn behövs inte under landningssidan
  home.show();
  applyDept();
}
function leaveHome() {
  if (!homeMode) return;
  homeMode = false;
  home.hide();
  paused = false;
}
document.querySelector('header#top h1').onclick = goHome;
// En länk till …/studio/#texturer, #bibliotek, #vind, #vader, #vatten, #kitteln eller #smedjan öppnar en avdelning direkt; annars landningssidan
if (location.hash === '#texturer') texBtn.onclick();
else if (location.hash === '#bibliotek') libBtn.onclick();
else if (location.hash === '#vind') windBtn.onclick();
else if (location.hash === '#vader') weatherBtn.onclick();
else if (location.hash === '#vatten') waterBtn.onclick();
else if (location.hash.startsWith('#kitteln')) openCauldron(location.hash.split('-')[1] ?? 'glow');
else if (location.hash !== '#smedjan') goHome();
