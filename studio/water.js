// Väderkvarnen, fliken Vatten (docs/effektlabb.md, E3): vattnet provas i fyra scener, öppet vatten, en strand där
// vågorna sköljer in, en bäck med vattenväxter och en liten sjö med träd för speglingar. Ytan är shared/effects/water.js,
// himlen, ljuset, dimman, regnet och åskan Väder-flikens atmosfär (weather.js), med väderlägena ur Väder-fliken. Spakarna, vattentyperna och scenerna är data i tools/water/water.json; sparade
// vattentyper i assets/water/. Egen renderare (WebGPU, WebGL2 som reserv), som Väder-fliken. Texten i appen är på engelska.
import * as THREE from 'three/webgpu';
import { pass, texture, positionWorld, mix, smoothstep, mx_noise_float, vec3, float, attribute } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAtmosphere } from '../shared/effects/weather.js';
import { createWater, bedAndFlow } from '../shared/effects/water.js';
import { antiTiled } from '../shared/effects/antitile.js';
import { axis, buildField } from '../shared/terrain/field.js';
import { createChannel } from '../shared/terrain/shapes.js';
import { hills } from '../shared/terrain/noise.js';
import { gpuPreference, frameGate } from './gpu.js';
import { createCards, withIcon } from './cards.js';

const DEG = Math.PI / 180;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Marken byggs med terrängkärnan (shared/terrain/, docs/terrain.md): rutnät med diagonaler längs höjdkurvorna och
// normaler ur höjdfunktionen, och bäckens fåra som ett avståndsfält
function toGeometry(f) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(f.normals, 3));
  g.setIndex(new THREE.BufferAttribute(f.index, 1));
  return g;
}
// Ett rutnät i världen: xs × zs, höjden ur yAt
const grid = (xs, zs, yAt) => toGeometry(buildField(xs, zs, yAt));

export async function createWaterTab({ api, el, view, side, drawer, footer }) {
  const [info, wx] = await Promise.all([api('/api/water'), api('/api/weather')]);
  // Väderlägena ur Väder-fliken (färdiga och sparade) blir valen i kortet Weather
  const wxDefaults = Object.fromEntries(wx.params.map((q) => [q.key, q.default]));
  const weathers = { ...Object.fromEntries(Object.entries(wx.presets).map(([id, p]) => [id, p])), ...Object.fromEntries(wx.saved.map((x) => [`saved:${x.name}`, { label: x.name, ...x.settings }])) };
  info.params.find((q) => q.key === 'weather').options = Object.entries(weathers).map(([id, p]) => ({ id, label: p.label ?? id }));
  const defaults = Object.fromEntries(info.params.map((q) => [q.key, q.default]));
  const isRecipe = (q) => q.recipe !== false;
  const vals = { ...defaults };
  let current = null;

  // --- Renderaren (se weather.js): WebGPU bara på ett riktigt grafikkort ---
  const pref = gpuPreference() === 'default' ? undefined : gpuPreference();
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: pref }).catch(() => null) : null;
  const software = !adapter || adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter || /swiftshader|llvmpipe/i.test(`${adapter.info?.architecture} ${adapter.info?.description}`);
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: pref, forceWebGL: software });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  view.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 900);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.maxDistance = 120;

  // --- Atmosfären: samma som Väder-flikens (sol och måne, moln, dimma, regn och snö, åska) ---
  const atm = createAtmosphere({ scene, shadowRange: 32 });
  const sky = atm.sky;

  // --- Bilden: scenen (med djup, som vattnet läser) och glöden från solglittret ---
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: 4 });
  const out = scenePass.getTextureNode('output');
  pipeline.outputNode = out.add(bloom(out, 0.18, 0.25, 1.6)); // bara det starkaste (solglittret) glöder

  // --- Texturer och modeller ---
  const texLoader = new THREE.TextureLoader();
  const texCache = new Map();
  const tex = (name) => {
    if (!texCache.has(name)) { const t = texLoader.load(`/assets/textures/${name}.png`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; texCache.set(name, t); }
    // Mot synlig upprepning: vriden andra sampling och storskalig ton (shared/effects/antitile.js)
    return antiTiled(texCache.get(name), positionWorld.xz.div(name === 'ground_meadow' ? 3 : 2.2));
  };
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const models = new Map(), failed = new Set();
  const loadModel = (url) => {
    if (!models.has(url)) models.set(url, loader.loadAsync(`/${url}`).then((g) => g.scene).catch(() => { failed.add(url.split('/').pop()); return null; }));
    return models.get(url);
  };
  async function place(group, url, x, y, z, rot = 0, scale = 1) {
    const src = await loadModel(url);
    if (!src) return null;
    const root = src.clone(true);
    root.position.set(x, y, z);
    root.rotation.y = rot * DEG;
    root.scale.setScalar(scale);
    root.traverse((o) => {
      if (/_LOD[12]$/.test(o.name)) o.visible = false;
      if (!o.isMesh) return;
      const m = o.material;
      o.castShadow = m.userData?.castShadow !== false;
      o.receiveShadow = m.userData?.receiveShadow !== false && !m.userData?.shadowProxy;
      if (m.userData?.shadowProxy) { m.colorWrite = false; m.depthWrite = false; }
    });
    group.add(root);
    return root;
  }

  // --- Marken: lager efter höjden över vattnet (levelNode), våt och med kaustik genom vattnet ---
  function groundMaterial(water, levelNode, { low, mid, high, highAt = 0.9 }) {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
    const y = positionWorld.y.sub(levelNode), n = mx_noise_float(vec3(positionWorld.xz.mul(0.35), 0)).mul(0.25);
    let c = mix(tex(low), tex(mid), smoothstep(-0.12, 0.05, y.add(n.mul(0.4))));
    c = mix(c, tex(high), smoothstep(highAt - 0.25, highAt + 0.25, y.add(n)));
    m.colorNode = water.groundColor(c.mul(0.92), levelNode);
    m.roughnessNode = water.groundRoughness(float(0.92), levelNode);
    return m;
  }

  // ---------- De fyra scenerna ----------
  const BUILD = {
    // Öppet vatten till horisonten: en sandbotten långt ned och inget annat
    async plane(S, group) {
      const L = S.level ?? 0, bedAt = (x, z) => -9 + hills(x, z) * 0.8;
      const geo = bedAndFlow(grid(axis(-450, 450, -60, 60, 0.45, 1.04), axis(-450, 450, -70, 40, 0.45, 1.04), () => L), bedAt);
      const water = createWater({ geometry: geo, level: L, sky });
      const ground = new THREE.Mesh(grid(axis(-450, 450, -60, 60, 3), axis(-450, 450, -60, 60, 3), bedAt), null);
      ground.material = groundMaterial(water, water.uniforms.level, { low: 'surface_sand', mid: 'surface_sand', high: 'surface_sand' });
      return { water, ground, level: L, bedAt };
    },
    // En strand längs x: havet bortåt (-z), sanden stiger mot kameran, dyner med gräs och tallar bakom
    async beach(S, group) {
      const L = S.level ?? 0;
      const bedAt = (x, z) => {
        let h = -0.15 + 0.07 * z + Math.sin(x * 0.15) * 0.18 * smooth(-12, 4, z) + Math.sin(x * 0.41 + 2) * 0.05;
        if (z < -28) h = -0.15 + 0.07 * -28 - (-28 - z) * 0.035;
        h += 0.35 * Math.exp(-(((z + 15) / 3.5) ** 2)) * (0.8 + 0.2 * Math.sin(x * 0.07)); // sandrevel
        h += smooth(9, 17, z) * (0.7 + hills(x, z) * 0.5); // dynerna
        return Math.max(h, -7);
      };
      const geo = bedAndFlow(grid(axis(-260, 260, -36, 36, 0.28, 1.045), axis(-320, 14, -26, 14, 0.25, 1.045), () => L), bedAt);
      const water = createWater({ geometry: geo, level: L, sky });
      const ground = new THREE.Mesh(grid(axis(-260, 260, -40, 40, 0.5), axis(-320, 120, -30, 40, 0.5), bedAt), null);
      ground.material = groundMaterial(water, water.uniforms.level, { low: 'surface_sand', mid: 'surface_sand', high: 'surface_grass', highAt: 1.9 });
      return { water, ground, level: L, bedAt };
    },
    // En bäck som slingrar sig genom en äng mot kameran, med en bred, lugn göl på mitten. Fåran är ett avståndsfält
    // längs splinen (shared/terrain/shapes.js): jämn profil, runda bankkrön och en yta som aldrig rinner uppför.
    async stream(S, group) {
      const base = (x, z) => 0.6 - 0.01 * z + hills(x, z) * 0.35;
      const { smp, query, bedAt } = createChannel({ path: S.path, base });
      // Vattnet: rutnätet längs bäcken, bara rutor nära fåran (vattenlinjen ligger vid d = w, ytan under marken utanför
      // döljs av marken). Nivån och strömmen ur närmaste sträcka, så att de är jämna längs hela bäcken.
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of smp) { x0 = Math.min(x0, p.x - p.w * 2); x1 = Math.max(x1, p.x + p.w * 2); z0 = Math.min(z0, p.z - p.w * 2); z1 = Math.max(z1, p.z + p.w * 2); }
      const wf = buildField(axis(x0, x1, x0, x1, 0.3), axis(z0, z1, z0, z1, 0.3), (x, z) => query(x, z)?.level ?? -50);
      const wet = (k) => { const q = query(wf.positions[k * 3], wf.positions[k * 3 + 2]); return q && q.d < q.w * 1.3; };
      const keep = new Uint8Array(wf.count), tris = [];
      for (let t = 0; t < wf.index.length; t += 3) {
        const [a, b, c] = [wf.index[t], wf.index[t + 1], wf.index[t + 2]];
        if (wet(a) || wet(b) || wet(c)) { tris.push(a, b, c); keep[a] = keep[b] = keep[c] = 1; }
      }
      const remap = new Int32Array(wf.count).fill(-1), pos = [];
      for (let k = 0; k < wf.count; k++) if (keep[k]) { remap[k] = pos.length / 3; pos.push(wf.positions[k * 3], wf.positions[k * 3 + 1], wf.positions[k * 3 + 2]); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(tris.map((k) => remap[k]));
      // Strömmen: snabbare där bäcken är smal, långsammare vid kanterna och i gölen
      bedAndFlow(geo, bedAt, (x, z) => {
        const q = query(x, z);
        if (!q) return [0, 0];
        const k = Math.min(1, q.d / q.w), v = (1.1 / q.w) ** 0.9 * (1 - 0.6 * k * k);
        return [q.tx * v, q.tz * v];
      });
      const level = query(0, 2).level;
      const water = createWater({ geometry: geo, level, sky });
      // Marken; vattnets nivå vid varje hörn (för våt strand och kaustik) tonar mjukt bort från bäcken
      const tg = grid(axis(-90, 90, -30, 30, 0.3), axis(-120, 120, -50, 40, 0.3), bedAt);
      const tp = tg.attributes.position, wl = new Float32Array(tp.count);
      for (let i = 0; i < tp.count; i++) { const q = query(tp.getX(i), tp.getZ(i)); wl[i] = q ? q.level - 50 * smooth(q.w * 2, q.w * 5, q.d) : -50; }
      tg.setAttribute('wlevel', new THREE.BufferAttribute(wl, 1));
      const ground = new THREE.Mesh(tg, null);
      ground.material = groundMaterial(water, attribute('wlevel', 'float'), { low: 'surface_riverbed', mid: 'surface_mud', high: 'ground_meadow', highAt: 0.18 });
      // Platserna för modellerna: längs bäcken (andel av längden, sidled i bredder), på bankarna och i gölen
      const along = (t, off) => { const p = smp[Math.round(t * (smp.length - 1))]; return [p.x - p.tz * off * p.w, p.z + p.tx * off * p.w, p]; };
      const pool = smp.reduce((a, b) => (b.w > a.w ? b : a));
      return { water, ground, level, bedAt, along, pool, query, mirrorLevel: level };
    },
    // En liten sjö med oregelbunden strand, en kulle bakom och träd runt om
    async lake(S, group) {
      const L = S.level ?? 0, { radius: R, depth, wobble } = S.basin;
      const radiusAt = (a) => R * (1 + wobble * (Math.sin(3 * a + 0.7) * 0.6 + Math.sin(5 * a + 2.1) * 0.35));
      const kAt = (x, z) => Math.hypot(x, z) / radiusAt(Math.atan2(-z, x));
      const bedAt = (x, z) => {
        const k = kAt(x, z), h0 = 0.25 + smooth(1.3, 2.6, k) * (0.4 + hills(x, z) * 0.4) + 3.2 * smooth(-R * 1.3, -R * 3, z) * (0.7 + 0.3 * Math.sin(x * 0.08));
        // Skålen: en parabel som fortsätter rakt ut över stranden (samma profil som bäckens fåra), utan veck i kanten
        return mix1(L - 0.12 - depth + depth * (k < 1 ? k * k : 2 * k - 1), h0, smooth(0.97, 1.45, k));
      };
      const geo = bedAndFlow(grid(axis(-R * 2, R * 2, -R * 1.8, R * 1.8, 0.35), axis(-R * 2, R * 2, -R * 1.8, R * 1.8, 0.35), () => L), bedAt);
      const water = createWater({ geometry: geo, level: L, sky });
      const ground = new THREE.Mesh(grid(axis(-260, 260, -R * 2.2, R * 2.2, 0.4), axis(-260, 260, -R * 2.6, R * 2.2, 0.4), bedAt), null);
      ground.material = groundMaterial(water, water.uniforms.level, { low: 'surface_pondbed', mid: 'surface_mud', high: 'ground_meadow', highAt: 0.3 });
      const shore = (deg, k) => { const a = deg * DEG, r = radiusAt(Math.atan2(Math.sin(a), Math.cos(a))) * k; return [Math.cos(a) * r, -Math.sin(a) * r]; };
      return { water, ground, level: L, bedAt, shore };
    },
  };
  const mix1 = (a, b, t) => a + (b - a) * t;

  // Bygg en scen en gång; sedan byts den bara in och ut
  const built = {};
  let active = null;
  async function buildScene(id) {
    const S = info.scenes[id], group = new THREE.Group();
    const B = await BUILD[id](S, group);
    B.ground.receiveShadow = true;
    group.add(B.ground, B.water.mesh);
    if (B.mirrorLevel !== undefined) B.water.setLevel(B.mirrorLevel);
    // Modellerna ur water.json. Utströdda växter (scatter) blir en InstancedMesh per del och modell: ett anrop i stället
    // för ett per exemplar, i bilden, i speglingen och i skuggan (där de inte är med alls)
    const r = rng(id.length * 977 + 13), floats = [], jobs = [], flocks = [];
    const rand = (a, b) => a + (b - a) * r();
    for (const m of S.models ?? []) {
      const n = m.scatter ?? 1, [s0, s1] = Array.isArray(m.scale) ? m.scale : [m.scale ?? 1, m.scale ?? 1], list = [];
      for (let i = 0; i < n; i++) {
        let x, z;
        if (m.at) [x, z] = m.at;
        else if (m.along) [x, z] = B.along(...m.along);
        else if (m.shore) [x, z] = B.shore(...m.shore);
        else if (m.ring) [x, z] = B.shore(rand(m.ring[0], m.ring[1]), rand(m.ring[2], m.ring[3]));
        else if (m.pool) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * B.pool.w * 0.75; [x, z] = [B.pool.x + Math.cos(a) * d, B.pool.z + Math.sin(a) * d]; }
        else if (m.bank) { const [px, pz] = B.along(rand(0.05, 0.95), (r() < 0.5 ? -1 : 1) * rand(m.bank[0], m.bank[1])); [x, z] = [px, pz]; }
        else if (m.zone) [x, z] = [rand(m.zone[0], m.zone[1]), rand(m.zone[2], m.zone[3])];
        else continue;
        const bed = B.bedAt(x, z), lvl = B.query?.(x, z)?.level ?? B.level;
        const y = m.float ? lvl + 0.01 : bed - (m.scatter ? 0.03 : 0.08);
        const rot = m.rot ?? r() * 360, sc = m.scatter ? rand(s0, s1) : s0, ph = r() * 6;
        if (m.float && bed > lvl - 0.05) continue; // näckrosor bara där det är vatten
        if (!m.float && !m.pool && m.scatter && bed < lvl - 0.05 && !/reed|cattail/.test(m.model)) continue; // gräs inte under vattnet
        if (m.scatter) list.push({ x, y, z, rot, sc, float: !!m.float, lvl, bed, ph });
        else jobs.push(place(group, m.model, x, y, z, rot, sc));
      }
      if (list.length) flocks.push({ url: m.model, list });
    }
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
    const baseOf = (it, y = it.y) => M.compose(V.set(it.x, y, it.z), Q.setFromAxisAngle(UP, it.rot * DEG), SC.setScalar(it.sc));
    for (const { url, list } of flocks) jobs.push(loadModel(url).then((src) => {
      if (!src) return;
      src.updateMatrixWorld(true);
      const parts = [];
      src.traverse((o) => {
        if (!o.isMesh || o.material.userData?.shadowProxy) return;
        for (let a = o; a && a !== src; a = a.parent) if (/_LOD[12]$/.test(a.name)) return;
        const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
        im.castShadow = false;
        im.receiveShadow = true;
        if (list.some((it) => it.float)) im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // guppar varje bildruta
        list.forEach((it, i) => im.setMatrixAt(i, baseOf(it).multiply(o.matrixWorld)));
        im.computeBoundingSphere();
        group.add(im);
        parts.push({ im, local: o.matrixWorld.clone() });
      });
      list.forEach((it, i) => { if (it.float) floats.push({ ...it, i, parts }); });
    }));
    await Promise.all(jobs);
    return { ...B, group, floats, S };
  }

  async function showScene(id, { keep = false } = {}) {
    note.textContent = built[id] ? '' : 'Building the scene…';
    built[id] ??= buildScene(id);
    const B = await built[id];
    if (active && active !== B) scene.remove(active.group);
    active = B;
    scene.add(B.group);
    const S = B.S;
    if (!keep) {
      Object.assign(vals, stripLabel(info.presets[S.preset] ?? {}), S.sky ?? {});
      current = S.preset;
      const [cx, cy, cz] = S.camera.pos;
      camera.position.set(cx, S.camera.overGround ? Math.max(B.bedAt(cx, cz), B.level) + cy : cy, cz);
      const [tx, ty, tz] = S.camera.target;
      controls.target.set(tx, S.camera.overGround ? B.level + ty : ty, tz); // overGround: kameran över marken, målet över vattnet
      controls.update();
      sync();
      markDrawer(S.preset);
    }
    relevant();
    apply();
    note.textContent = failed.size ? `Could not load: ${[...failed].join(', ')}` : 'Click the water to make ripples';
  }

  // --- Spakarna verkställs: vädret (med scenens tid och solriktning) och vattnet ---
  let sun = null;
  function apply() {
    const w = { ...wxDefaults, ...(weathers[vals.weather] ?? {}), hour: vals.hour, azimuth: vals.azimuth };
    atm.set(w);
    atm.moveTo(new THREE.Vector3(...(active?.S.camera.target ?? [0, 0, 0])));
    sun = atm.sun;
    renderer.toneMappingExposure = vals.exposure * (w.exposure ?? 1) * atm.exposure;
    // Vattnet glittrar i det som lyser: solen, eller månen på natten
    const U = sky.uniforms;
    const light = { dir: atm.keyDir, color: atm.key.color, strength: 1, zenith: U.zenith.value, horizon: U.horizon.value };
    active?.water.set(vals, light, { light: atm.key.intensity, ambient: atm.hemi.intensity });
    if (active) active.water.uniforms.rain.value = atm.rain;
  }

  // --- Som i de andra vyerna: mallarna (vattentyperna) i lådan till vänster, spakarna och Spara till höger. Scenerna
  // är provplatsen, inte något man sparar, och väljs i raden överst i bilden ---
  const get = (k) => vals[k], set = (k, v) => { vals[k] = v; };
  const sceneQ = info.params.find((q) => q.key === 'scene');
  const stage = el('div', 'stagebar');
  for (const o of sceneQ.options) {
    const b = el('button', null);
    b.dataset.id = o.id;
    b.title = `${o.help}. Starts with ${info.presets[info.scenes[o.id].preset]?.label ?? '—'}`;
    const img = el('img');
    img.alt = '';
    img.src = `/assets/icons/waterscene/${o.id}.png`;
    b.append(img, el('span', null, o.label));
    b.onclick = () => { if (vals.scene !== o.id) { vals.scene = o.id; showScene(o.id); } };
    stage.append(b);
  }
  view.append(stage);
  const markScene = () => { for (const b of stage.children) b.classList.toggle('on', b.dataset.id === vals.scene); };

  // Vattnets spakar, sedan himlen och solen (hör till scenen och sparas inte), sist Spara
  const cards = createCards({ el, side });
  const COLORS = { color: '#3fa6a0', waves: '#5aa0d8', light: '#f0d080', foam: '#e8eef0', shore: '#c8a878', flow: '#58b0c8', caustics: '#a0e0f0', sky: '#e0a030' };
  const groupCards = {}, rows = {};
  for (const g of [...info.groups.filter((x) => x.id !== 'scene' && x.id !== 'sky'), info.groups.find((x) => x.id === 'sky')]) {
    const gb = cards.card(g.label, COLORS[g.id] ?? '#7aa8d8', { help: g.id === 'sky' ? 'The weather belongs to the scene; it is not saved in the water type' : undefined });
    groupCards[g.id] = gb.parentElement;
    for (const q of info.params.filter((x) => x.group === g.id)) {
      const row = cards.rowFor(q)(q, get, set, () => { if (isRecipe(q)) markDrawer(null); apply(); });
      rows[q.key] = row;
      gb.append(row);
    }
  }
  // Det som inte finns i scenen döljs: ström bara i bäcken, strand och kaustik inte på öppet vatten
  function relevant() {
    const id = vals.scene;
    groupCards.flow.hidden = id !== 'stream';
    groupCards.shore.hidden = id === 'plane';
    groupCards.caustics.hidden = id === 'plane';
    rows.surge.hidden = rows.surgePeriod.hidden = id === 'stream';
    markScene();
  }
  const sync = () => cards.sync();
  const saveCard = cards.card('Save', '#4a90d9');
  const saveMsg = el('div', 'note');
  const saveBtn = el('button', 'primary', 'Save water type…');
  saveBtn.title = 'Saves the water sliders (not the scene or the sky) as a water type in assets/water/, for the studio, the showcase and Tinkertown';
  saveBtn.onclick = async () => {
    const name = prompt('Name of the water type (a–z, 0–9 and _):', current?.replace(/^saved:/, '') ?? 'my_water');
    if (!name) return;
    const from = current?.startsWith('saved:') ? info.saved.find((x) => `saved:${x.name}` === current)?.from : current;
    let r = await api('/api/water/save', { name, settings: vals, from });
    if (r.exists && confirm(`${name} already exists. Overwrite?`)) r = await api('/api/water/save', { name, settings: vals, from, overwrite: true });
    saveMsg.textContent = r.error ? `Not saved: ${r.error}` : r.file ? `Saved: ${r.file}` : '';
    if (!r.entry) return;
    info.saved = [r.entry, ...info.saved.filter((x) => x.name !== r.entry.name)];
    current = `saved:${r.entry.name}`;
    renderDrawer();
  };
  saveCard.append(saveBtn, saveMsg);

  // --- Lådan: färdiga och sparade vattentyper ---
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  head.append(el('h2', null, 'Water types'), el('div', 'note', 'Click a water type to use it. Save your own in the Save card.'));
  drawer.append(head, body);
  function tile(id, label, settings, icon) {
    const v = Object.fromEntries(info.params.filter(isRecipe).map((q) => [q.key, settings[q.key] ?? q.default]));
    const f = el('button', `wprof${current === id ? ' on' : ''}`);
    f.dataset.id = id;
    const sw = el('span', 'gswatch');
    sw.style.background = `linear-gradient(90deg, ${v.shallow}, ${v.deep})`;
    f.append(el('b', null, label), sw, el('span', 'wmeta', `waves ${v.waveHeight.toFixed(2)} m · clear ${v.clarity} m${v.flowSpeed && v.flowFoam ? ` · current ${v.flowSpeed}` : ''}`));
    f.onclick = () => { Object.assign(vals, v); markDrawer(id); cards.sync(); apply(); };
    return withIcon(el, f, 'water', icon, label);
  }
  function renderDrawer() {
    body.replaceChildren();
    const sec = (title, tiles) => { if (!tiles.length) return; const g = el('section', 'libgroup'); const gr = el('div', 'wprofs'); gr.append(...tiles); g.append(el('h3', null, title), gr); body.append(g); };
    sec('Ready-made', Object.entries(info.presets).map(([id, p]) => tile(id, p.label, p, id)));
    sec('Saved', info.saved.map((x) => tile(`saved:${x.name}`, x.name, x.settings, x.from)));
  }
  function markDrawer(id = current) { current = id; for (const b of body.querySelectorAll('.wprof')) b.classList.toggle('on', b.dataset.id === id); }
  renderDrawer();

  // --- Footern ---
  const fStats = el('div', 'block'), fSun = el('div', 'block'), note = el('div', 'msg');
  footer.append(fStats, fSun, note);
  const block = (b, title, text) => { b.replaceChildren(el('b', null, title), el('div', 'vals', text)); };
  const clock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

  // --- Klick på vattnet: ringar ---
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !active) return;
    const rc = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([active.water.mesh, active.ground], false)[0];
    if (hit?.object === active.water.mesh) active.water.splash(hit.point.x, hit.point.z, 1);
  });

  // --- Rendering ---
  let running = false, last = performance.now(), frames = 0, fpsT = last, fps = 0, time = 0;
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', () => { if (running) resize(); });
  const gate = frameGate();
  const bob = new THREE.Matrix4(), bobQ = new THREE.Quaternion(), bobV = new THREE.Vector3(), bobS = new THREE.Vector3(), bobUp = new THREE.Vector3(0, 1, 0);
  function tick(dt) {
    time += dt;
    if (active) {
      active.water.update(time);
      // Näckrosorna guppar med vågorna
      const moved = new Set();
      for (const f of active.floats) {
        const y = active.water.heightAt(f.x, f.z, f.lvl, f.bed) + 0.01 + Math.sin(time * 0.9 + f.ph) * 0.006;
        for (const { im, local } of f.parts) { im.setMatrixAt(f.i, bob.compose(bobV.set(f.x, y, f.z), bobQ.setFromAxisAngle(bobUp, f.rot * DEG), bobS.setScalar(f.sc)).multiply(local)); moved.add(im); }
      }
      for (const im of moved) im.instanceMatrix.needsUpdate = true;
      // Kameran stannar ovanför ytan
      const minY = (active.mirrorLevel ?? active.level) + 0.3;
      if (camera.position.y < minY) camera.position.y = minY;
    }
    controls.update();
    atm.update(dt, time, camera);
    pipeline.render();
  }
  function frame() {
    const now = performance.now();
    if (!gate(now)) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(dt);
    frames++;
    if (now - fpsT > 500) {
      fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now;
      block(fStats, 'Water', `${info.params[0].options.find((o) => o.id === vals.scene)?.label} · ${fps} fps · ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`);
      block(fSun, 'Weather', `${weathers[vals.weather]?.label ?? vals.weather} · ${clock(vals.hour)} · sun ${Math.round(sun.elevation / DEG)}°`);
    }
  }
  await showScene(vals.scene);
  // För prov: ?shot=<namn> sparar en bild av varje scen (build/shots/studio_<namn>_<scen>_<renderare>_<fps>.png), som
  // Väder-fliken; med test=1 stängs provfönstret efter den sista
  const q = new URLSearchParams(location.search), shotName = q.get('shot');
  if (shotName && /^[\w-]{1,40}$/.test(shotName) && /vatten/.test(location.hash)) setTimeout(async () => {
    const ids = Object.keys(info.scenes);
    for (const [i, id] of ids.entries()) {
      vals.scene = id;
      await showScene(id);
      await new Promise((r) => setTimeout(r, 4000));
      tick(0);
      const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
      const test = q.get('test') === '1' && i === ids.length - 1 ? '&test=1' : '';
      await fetch(`/api/shot?name=${shotName}_${id}_${renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl'}_${fps}fps${test}`, { method: 'POST', body: blob });
    }
  }, 5000);
  return {
    show() { running = true; resize(); last = performance.now(); renderer.setAnimationLoop(frame); },
    hide() { running = false; renderer.setAnimationLoop(null); },
    scene, camera, controls, renderer, vals, apply, showScene,
    get active() { return active; },
    stats: () => ({ fps, failed: [...failed], backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl', scene: vals.scene }),
    // För prov: rita en gång till och spara bilden som build/shots/studio_<namn>.png
    async shot(name) {
      tick(0);
      const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
      return (await fetch(`/api/shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })).json();
    },
  };
}
function stripLabel(p) { const { label: _l, ...rest } = p; return rest; }
