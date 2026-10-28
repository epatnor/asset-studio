// Kartrummet, stegen World och Biomes (docs/terrain.md, steg 1 och 2): världen ur ett recept, oftast en ö i havet,
// 256 m–4 km i fyrkant, och biomerna på den. Höjdfältet och biomerna räknas i en worker (shared/terrain/worker.js:
// generate.js, field.js och biomes.js), marken läggs i lager efter biomerna (med klippor i branter och rännor där
// vattnet runnit), biomerna kan målas med pensel (ett eget lager i receptet), och havet är vattenmodulen (shared/effects/water.js) med vädret ur Väder-fliken. Platsen står som ett block på
// kartbordet, med jordlager på sidorna. Spakarna och de färdiga landskapen är data i tools/terrain/terrain.json;
// sparade landskap i assets/terrain/. Egen renderare (WebGPU, WebGL2 som reserv). Texten i appen är på engelska.
import * as THREE from 'three/webgpu';
import {
  pass, texture, positionWorld, normalWorld, attribute, mix, smoothstep, mx_noise_float, vec3, vec4, float, uniform, triplanarTexture, color, max, select, length, abs, Fn,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAtmosphere } from '../shared/effects/weather.js';
import { createWater, bedAndFlow } from '../shared/effects/water.js';
import { antiTiled } from '../shared/effects/antitile.js';
import { axis, buildField } from '../shared/terrain/field.js';
import { worldGrid } from '../shared/terrain/generate.js';
import { BIOMES, PAINT_SIZE, mixPaint, paintStroke, encodePaint, decodePaint } from '../shared/terrain/biomes.js';
import { gpuPreference, frameGate } from './gpu.js';
import { createCards, withIcon } from './cards.js';

const DEG = Math.PI / 180;
// Spakar som kräver att höjdfältet räknas om; övriga ändrar bara materialet, havet eller vyn
const SHAPE_KEYS = new Set(['worldSize', 'shape', 'seed', 'height', 'scale', 'coast', 'octaves', 'roughness', 'ridges', 'warp', 'terraces', 'terraceSharp', 'erosion', 'talus']);
// Spakar som bara räknar om biomerna (snabbt, på den senaste terrängen i workern)
const BIOME_KEYS = new Set(['sea', 'seaLevel', 'sandBand', 'snowline', 'cliffAngle', 'treeline', 'rainfall', 'forestCover', 'marshes', 'coastWind']);

export async function createTerrainTab({ api, el, view, side, drawer, footer }) {
  const [info, wx, wa] = await Promise.all([api('/api/terrain'), api('/api/weather'), api('/api/water')]);
  const wxDefaults = Object.fromEntries(wx.params.map((q) => [q.key, q.default]));
  const weathers = { ...wx.presets, ...Object.fromEntries(wx.saved.map((x) => [`saved:${x.name}`, { label: x.name, ...x.settings }])) };
  info.params.find((q) => q.key === 'weather').options = Object.entries(weathers).map(([id, p]) => ({ id, label: p.label ?? id }));
  const defaults = Object.fromEntries(info.params.map((q) => [q.key, q.default]));
  const recipeKeys = info.params.filter((q) => q.recipe !== false).map((q) => q.key);
  const firstPreset = Object.keys(info.presets)[0];
  const vals = { ...defaults, ...stripLabel(info.presets[firstPreset] ?? {}) };
  let current = firstPreset;
  // Världens storlek (rutnätet och havsbottnen följer den: worldGrid i shared/terrain/generate.js)
  const sizeOf = () => Number(vals.worldSize) || 1024;
  let half = sizeOf() / 2, shownSize = 256; // kamerans läge i terrain.json gäller en värld på 256 m; resize3d skalar det

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
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
  camera.position.set(...info.camera.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...info.camera.target);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 4;
  controls.maxDistance = 900;

  // --- Atmosfären (shared/effects/weather.js), med solen långt bort så att skuggorna räcker över hela platsen ---
  const atm = createAtmosphere({ scene, shadowSize: 4096, shadowRange: half * 1.25, lightDistance: half * 2.2 });
  const sky = atm.sky;
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: 4 });
  const raw0 = scenePass.getTextureNode('output');
  // Skydd före glöden: en enstaka pixel med NaN eller oändligt (det hände i de brantaste sluttningarna på Mountain isle)
  // sprids annars av glöden över hela bilden, som blir svart. Jämförelser med NaN är falska, så den blir svart här.
  const lum = raw0.r.add(raw0.g).add(raw0.b);
  const out = select(lum.lessThan(1e5).and(lum.greaterThanEqual(0)), raw0, vec4(0, 0, 0, 1));
  const dbg = new URLSearchParams(location.search).get('dbg') ?? ''; // felsökning: noshadow, nobloom
  pipeline.outputNode = dbg.includes('nobloom') ? out : out.add(bloom(out, 0.12, 0.25, 1.7));

  // --- Texturer: världskoordinater, med skydd mot upprepning (shared/effects/antitile.js) ---
  const texLoader = new THREE.TextureLoader(), texCache = new Map();
  const raw = (name) => {
    if (!texCache.has(name)) { const t = texLoader.load(`/assets/textures/${name}.png`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; texCache.set(name, t); }
    return texCache.get(name);
  };
  const tex = (name, metres) => antiTiled(raw(name), positionWorld.xz.div(metres));

  // --- Havet: vattenmodulen med en havstyp ur Vatten-fliken; botten utanför platsen ligger djupt ---
  const waterVals = { ...Object.fromEntries(wa.params.map((q) => [q.key, q.default])), ...stripLabel(wa.presets.tropical_lagoon ?? {}) };
  let field = null; // senaste marken: { n, cell, heights }
  let SEABED = worldGrid(sizeOf()).seaFloor;
  const bedAt = (x, z) => {
    if (!field || Math.abs(x) > half || Math.abs(z) > half) return SEABED;
    const { n, cell, heights } = field;
    const gx = Math.min(n - 1.001, (x + half) / cell), gz = Math.min(n - 1.001, (z + half) / cell), i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, k = j * n + i;
    return (heights[k] * (1 - fx) + heights[k + 1] * fx) * (1 - fz) + (heights[k + n] * (1 - fx) + heights[k + n + 1] * fx) * fz;
  };
  const waterGeometry = (level) => {
    const W = Math.max(1400, half * 6), step = Math.max(2, half / 64);
    const f = buildField(axis(-W, W, -half - 4, half + 4, step, 1.1), axis(-W, W, -half - 4, half + 4, step, 1.1), () => level);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
    g.setIndex(new THREE.BufferAttribute(f.index, 1));
    return bedAndFlow(g, bedAt);
  };
  const water = createWater({ geometry: waterGeometry(vals.seaLevel), level: vals.seaLevel, sky });
  scene.add(water.mesh);
  // Havsbotten runt platsen, så att havet har en botten ut mot horisonten
  const seabed = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ roughness: 1 }));
  seabed.material.colorNode = tex('surface_sand', 4).mul(0.6);
  seabed.position.y = SEABED;
  scene.add(seabed);

  // --- Marken: lager efter höjd, lutning och fukt ---
  const U = {
    sea: uniform(vals.seaLevel), seaOn: uniform(vals.sea ? 1 : 0), sand: uniform(vals.sandBand), snow: uniform(vals.snowline),
    cliff: uniform(Math.cos(vals.cliffAngle * DEG)), tone: uniform(vals.grassTone), top: uniform(40), low: uniform(-8),
    brush: uniform(new THREE.Vector3(0, 0, 30)), brushOn: uniform(0), // x, z, radie; 1 när penselns ring syns
  };
  const h = positionWorld.y, up = normalWorld.y, wet = attribute('wet', 'float');
  // Biomernas vikter (shared/terrain/biomes.js): bio0 = strand, äng, lövskog, barrskog; bio1 = myr, hed, berg, snö
  const bio0 = attribute('bio0', 'vec4'), bio1 = attribute('bio1', 'vec4');
  const wobble = mx_noise_float(vec3(positionWorld.xz.mul(0.06), 0)).mul(1.0).add(mx_noise_float(vec3(positionWorld.xz.mul(0.4), 3)).mul(0.25));
  const steppe = tex('ground_steppe', 3), moss = tex('moss_stylized', 2.5), floor = tex('surface_forestfloor', 3);
  const grass = mix(steppe, tex('ground_lush', 3), U.tone);
  const meadow = mix(grass, tex('ground_meadow', 3), smoothstep(0.2, 0.8, mx_noise_float(vec3(positionWorld.xz.mul(0.025), 7)).add(0.5)).mul(0.6));
  const LAYER = [
    tex('surface_sand', 2.5), // strand
    meadow, // äng
    floor, // lövskog
    mix(floor, moss, 0.45).mul(0.85), // barrskog: barr och mossa
    mix(tex('surface_mud', 2.5), moss, 0.35), // myr
    mix(steppe, color('#9a8048'), 0.3), // hed: ljung och gyllene gräs
    tex('surface_stone', 3), // berg
    tex('surface_snow', 4), // snö
  ];
  let c = LAYER[0].mul(bio0.x).add(LAYER[1].mul(bio0.y)).add(LAYER[2].mul(bio0.z)).add(LAYER[3].mul(bio0.w))
    .add(LAYER[4].mul(bio1.x)).add(LAYER[5].mul(bio1.y)).add(LAYER[6].mul(bio1.z)).add(LAYER[7].mul(bio1.w));
  c = mix(c, tex('surface_dirt', 2.5), smoothstep(0.75, 1, wet).mul(smoothstep(0.97, 0.88, up)).mul(float(1).sub(bio1.w)).mul(0.7)); // rännor i branta sluttningar
  const rock = triplanarTexture(texture(raw('surface_cliff')), null, null, float(1 / 7), positionWorld, normalWorld).rgb;
  c = mix(c, rock, smoothstep(U.cliff.add(0.05), U.cliff.sub(0.05), up.add(wobble.mul(0.03)))); // klippor i branter
  // Penselns ring (steg Biomes): en ring på marken där penseln är
  const brushRing = Fn(() => {
    const d = length(positionWorld.xz.sub(U.brush.xy)), w = U.brush.z.mul(0.035).add(0.4);
    return float(1).sub(smoothstep(0, w, abs(d.sub(U.brush.z)))).mul(U.brushOn);
  })();
  const shaded = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  shaded.colorNode = mix(water.groundColor(c.mul(0.92), water.uniforms.level), color('#ffffff'), brushRing.mul(0.85));
  shaded.roughnessNode = water.groundRoughness(float(0.92), water.uniforms.level);
  // Felsökningsvyerna
  const debug = (node) => { const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 }); m.colorNode = node; return m; };
  const t = h.sub(U.low).div(max(U.top.sub(U.low), 1)).clamp(0, 1);
  const heightCol = mix(mix(color('#2a6f97'), color('#5aa05a'), smoothstep(-0.02, 0.02, h.sub(U.sea).mul(U.seaOn).add(float(1).sub(U.seaOn)))), mix(color('#8a6a40'), color('#f4f4f4'), smoothstep(0.55, 1, t)), smoothstep(0.15, 0.6, t));
  const slopeT = float(1).sub(up);
  const MATS = {
    shaded,
    height: debug(heightCol.mul(float(0.85).add(smoothstep(0.92, 1, h.mul(0.5).fract()).mul(0.3)))), // ljusa band var 2 m
    slope: debug(mix(mix(color('#20302a'), color('#d8c050'), smoothstep(0, float(1).sub(U.cliff), slopeT)), color('#d03a2a'), smoothstep(float(1).sub(U.cliff).sub(0.02), float(1).sub(U.cliff).add(0.02), slopeT))),
    wetness: debug(mix(color('#e8dcc0'), color('#1f5fb0'), wet)),
    biomes: debug((() => {
      const C = info.biomes.map((x) => color(x.color));
      return C[0].mul(bio0.x).add(C[1].mul(bio0.y)).add(C[2].mul(bio0.z)).add(C[3].mul(bio0.w)).add(C[4].mul(bio1.x)).add(C[5].mul(bio1.y)).add(C[6].mul(bio1.z)).add(C[7].mul(bio1.w))
        .mul(float(0.8).add(up.mul(0.2))).add(brushRing.mul(0.8));
    })()),
    wireframe: Object.assign(debug(mix(color('#3a4a3a'), color('#c8e0c0'), t)), { wireframe: true }),
  };
  const ground = new THREE.Mesh(new THREE.BufferGeometry(), shaded);
  ground.receiveShadow = ground.castShadow = !dbg.includes('noshadow');
  // Blocket: jordlager på platsens fyra sidor ned till en sockel
  const sideMat = new THREE.MeshStandardNodeMaterial({ roughness: 1, side: THREE.DoubleSide });
  const band = mx_noise_float(vec3(positionWorld.x.add(positionWorld.z).mul(0.05), positionWorld.y.mul(0.35), 1));
  sideMat.colorNode = mix(color('#3b2a1e'), color('#6e5137'), smoothstep(-0.6, 0.6, band)).mul(mix(float(0.65), float(1), smoothstep(-30, 0, positionWorld.y)));
  const sides = new THREE.Mesh(new THREE.BufferGeometry(), sideMat);
  sides.receiveShadow = true;
  scene.add(ground, sides);

  function sideGeometry(f, base) {
    const { n, cell, heights } = f, pos = [], idx = [];
    const edge = (k0, step, fx, fz) => {
      const start = pos.length / 3;
      for (let s = 0; s < n; s++) {
        const k = k0 + s * step, x = fx(s), z = fz(s);
        pos.push(x, heights[k], z, x, base, z);
      }
      for (let s = 0; s < n - 1; s++) { const a = start + s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    };
    const at = (s) => -half + s * cell;
    edge(0, 1, at, () => -half); // norr
    edge((n - 1) * n, 1, at, () => half); // söder
    edge(0, n, () => -half, at); // väster
    edge(n - 1, n, () => half, at); // öster
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // --- Generatorn i en worker: den senaste begäran vinner, och bara en räknas åt gången ---
  const worker = new Worker(new URL('../shared/terrain/worker.js', import.meta.url), { type: 'module' });
  let sent = 0, busy = false, dirty = null, waiters = [], stats = { ms: 0, vertices: 0, triangles: 0, land: 0, top: 0, biomeMs: 0, coverage: {} };
  // Biomerna: de beräknade vikterna (auto, ur workern), det målade lagret (paint) och det som ritas (final = auto + paint)
  let auto = null, final = null, paint = new Uint8Array(PAINT_SIZE * PAINT_SIZE * 2);
  const recipe = () => ({ ...Object.fromEntries(recipeKeys.map((k) => [k, vals[k]])), ...worldGrid(sizeOf()) });
  // kind = 'world' (bygg om terrängen och biomerna) eller 'biomes' (bara biomerna, på samma terräng)
  function request(kind = 'world') {
    if (busy) { dirty = dirty === 'world' || kind === 'world' ? 'world' : 'biomes'; return; }
    busy = true;
    note.textContent = kind === 'world' ? 'Building the world…' : 'Placing the biomes…';
    worker.postMessage({ id: ++sent, recipe: recipe(), only: kind === 'biomes' ? 'biomes' : undefined });
  }
  // Vikterna till marken: auto och det målade lagret blandas och delas på två attribut (bio0 och bio1, 4 × 8 bitar)
  function applyBiomes() {
    if (!auto || !field) return;
    final = mixPaint(auto, paint, field.n, final && final.length === auto.length ? final : undefined);
    const g = ground.geometry, count = final.length / 8;
    let a0 = g.getAttribute('bio0'), a1 = g.getAttribute('bio1');
    if (!a0 || a0.count !== count) {
      a0 = new THREE.BufferAttribute(new Uint8Array(count * 4), 4, true);
      a1 = new THREE.BufferAttribute(new Uint8Array(count * 4), 4, true);
      g.setAttribute('bio0', a0);
      g.setAttribute('bio1', a1);
    }
    const A = a0.array, B = a1.array;
    for (let k = 0; k < count; k++) {
      const o = k * 8, p4 = k * 4;
      A[p4] = final[o]; A[p4 + 1] = final[o + 1]; A[p4 + 2] = final[o + 2]; A[p4 + 3] = final[o + 3];
      B[p4] = final[o + 4]; B[p4 + 1] = final[o + 5]; B[p4 + 2] = final[o + 6]; B[p4 + 3] = final[o + 7];
    }
    a0.needsUpdate = a1.needsUpdate = true;
  }
  worker.onmessage = (e) => {
    const d = e.data;
    busy = false;
    if (dirty) { const k = dirty; dirty = null; request(k); return; }
    if (d.only === 'biomes') {
      auto = d.biomes;
      stats.coverage = d.coverage; stats.biomeMs = d.biomeMs;
      applyBiomes();
      showStats();
      note.textContent = hint();
      const w = waiters; waiters = [];
      w.forEach((r) => r());
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
    g.setAttribute('wet', new THREE.BufferAttribute(d.wet, 1));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    g.computeBoundingSphere();
    ground.geometry.dispose();
    ground.geometry = g;
    field = { n: d.n, cell: d.cell, heights: d.heights };
    auto = d.biomes;
    applyBiomes();
    resize3d(d.size);
    let lo = Infinity, hi = -Infinity, land = 0;
    for (const v of d.heights) { lo = Math.min(lo, v); hi = Math.max(hi, v); if (!vals.sea || v > vals.seaLevel) land++; }
    U.low.value = lo; U.top.value = hi;
    sides.geometry.dispose();
    sides.geometry = sideGeometry(field, Math.min(lo, SEABED) - 4);
    rebuildWater();
    stats = { ms: d.ms, vertices: d.positions.length / 3, triangles: d.index.length / 3, land: Math.round((100 * land) / d.heights.length), top: Math.round(hi), biomeMs: d.biomeMs, coverage: d.coverage };
    showStats();
    note.textContent = hint();
    const w = waiters; waiters = [];
    w.forEach((r) => r());
  };
  const regenerate = (kind = 'world') => new Promise((r) => { waiters.push(r); request(kind); });
  // En ny världsstorlek: havet, botten, skuggorna, dimman och kameran skalas med
  function resize3d(size) {
    half = size / 2;
    SEABED = worldGrid(size).seaFloor;
    seabed.position.y = SEABED;
    seabed.scale.setScalar(Math.max(2800, size * 12));
    atm.setShadowRange(half * 1.25, half * 2.2);
    controls.maxDistance = size * 3.5;
    camera.far = Math.max(4000, size * 14);
    camera.updateProjectionMatrix();
    if (size !== shownSize) {
      const k = size / shownSize;
      camera.position.sub(controls.target).multiplyScalar(k).add(controls.target.multiplyScalar(k));
      shownSize = size;
    }
  }
  function rebuildWater() {
    water.mesh.geometry.dispose();
    water.mesh.geometry = waterGeometry(vals.seaLevel);
    water.setLevel(vals.seaLevel);
    water.mesh.visible = seabed.visible = !!vals.sea;
  }

  // --- Spakarna verkställs: vädret, havet, marklagren och vyn ---
  let sun = null;
  function apply() {
    const w = { ...wxDefaults, ...(weathers[vals.weather] ?? {}), hour: vals.hour, azimuth: vals.azimuth };
    w.haze = (w.haze ?? 0.01) * vals.haze * Math.min(1, 400 / sizeOf()); // tunnare dis i större världar
    w.fog = (w.fog ?? 0) * vals.haze;
    atm.set(w);
    atm.moveTo(new THREE.Vector3(0, 0, 0));
    sun = atm.sun;
    renderer.toneMappingExposure = vals.exposure * (w.exposure ?? 1) * atm.exposure;
    const S = sky.uniforms;
    water.set(waterVals, { dir: atm.keyDir, color: atm.key.color, strength: 1, zenith: S.zenith.value, horizon: S.horizon.value }, { light: atm.key.intensity, ambient: atm.hemi.intensity });
    water.uniforms.rain.value = atm.rain;
    U.sea.value = vals.seaLevel; U.seaOn.value = vals.sea ? 1 : 0; U.sand.value = vals.sandBand; U.snow.value = vals.snowline;
    U.cliff.value = Math.cos(vals.cliffAngle * DEG); U.tone.value = vals.grassTone;
    ground.material = MATS[vals.view] ?? shaded;
    markView();
  }

  // --- Provplatsens vyer: en rad ikonknappar överst i bilden (som vattnets scener) ---
  const viewQ = info.params.find((q) => q.key === 'view');
  const stage = el('div', 'stagebar');
  for (const o of viewQ.options) {
    const b = el('button', null);
    b.dataset.id = o.id;
    b.title = o.help;
    const img = el('img');
    img.alt = '';
    img.src = `/assets/icons/maproom/view_${o.id}.png`;
    img.onerror = () => img.remove();
    b.append(img, el('span', null, o.label));
    b.onclick = () => { vals.view = o.id; apply(); };
    stage.append(b);
  }
  view.append(stage);
  function markView() { for (const b of stage.children) b.classList.toggle('on', b.dataset.id === vals.view); }

  // --- Korten: landskapets spakar, sedan vädret (hör till vyn och sparas inte), sist Spara ---
  const cards = createCards({ el, side });
  const get = (k) => vals[k];
  const set = (k, v) => { vals[k] = v; };
  const COL = { shape: '#c0672e', detail: '#b88a5a', erosion: '#6a8fb0', water: '#3fa6a0', material: '#6aa84f', climate: '#3f8f3a', brush: '#e0e0e0', sky: '#e0a030' };
  // Vilka kort som syns i vilket steg: World formar landet, Biomes klimatet och penseln; marken, vädret och Spara i båda
  const IN_STEP = { world: ['shape', 'detail', 'erosion', 'water', 'material', 'sky'], biomes: ['material', 'climate', 'brush', 'sky'] };
  const cardOf = {};
  for (const g of info.groups) {
    if (g.id === 'view') continue;
    const body = cards.card(g.label, COL[g.id] ?? '#c0672e', { closed: ['erosion', 'water', 'sky'].includes(g.id) });
    cardOf[g.id] = body.parentElement;
    for (const q of info.params.filter((x) => x.group === g.id)) {
      body.append(cards.rowFor(q)(q, get, set, () => {
        if (q.recipe !== false) mark(null);
        if (SHAPE_KEYS.has(q.key)) regenerate();
        else if (BIOME_KEYS.has(q.key)) regenerate('biomes');
        if (q.key === 'sea' || q.key === 'seaLevel') rebuildWater();
        if (q.key === 'brush') U.brush.value.z = vals.brush;
        apply();
      }));
    }
  }
  const saveCard = cards.card('Save', '#4a90d9');
  const saveMsg = el('div', 'note');
  const saveBtn = el('button', 'primary', 'Save world…');
  saveBtn.title = 'Saves the sliders as a world recipe in assets/terrain/ (the land is computed from the recipe, nothing is baked)';
  saveBtn.onclick = async () => {
    const name = prompt('Name of the world (a–z, 0–9 and _):', current?.replace(/^saved:/, '') ?? 'my_island');
    if (!name) return;
    const from = current?.startsWith('saved:') ? info.saved.find((x) => `saved:${x.name}` === current)?.from : current;
    const layers = { biomePaint: encodePaint(paint) ?? '' }; // det målade biomlagret följer med receptet
    let r = await api('/api/terrain/save', { name, settings: vals, from, layers });
    if (r.exists && confirm(`${name} already exists. Overwrite?`)) r = await api('/api/terrain/save', { name, settings: vals, from, layers, overwrite: true });
    saveMsg.textContent = r.error ? `Not saved: ${r.error}` : r.file ? `Saved: ${r.file}` : '';
    if (!r.entry) return;
    info.saved = [r.entry, ...info.saved.filter((x) => x.name !== r.entry.name)];
    current = `saved:${r.entry.name}`;
    renderDrawer();
  };
  saveCard.append(saveBtn, saveMsg);

  // --- Lådan: färdiga och sparade landskap ---
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  const headTitle = el('h2', null, 'Worlds'), headNote = el('div', 'note', '');
  head.append(headTitle, headNote);
  drawer.append(head, body);
  const sizeLabel = Object.fromEntries(info.params.find((q) => q.key === 'worldSize').options.map((o) => [o.id, o.label]));
  const shapeLabel = Object.fromEntries(info.params.find((q) => q.key === 'shape').options.map((o) => [o.id, o.label]));
  function tile(id, label, settings, icon, layers) {
    const v = { ...defaults, ...stripLabel(settings) };
    const f = el('button', `wprof${current === id ? ' on' : ''}`);
    f.dataset.id = id;
    f.append(el('b', null, label), el('span', 'wmeta', `${shapeLabel[v.shape] ?? v.shape} · ${sizeLabel[v.worldSize] ?? v.worldSize} · ${v.height} m high`));
    f.onclick = () => use(id, v, layers);
    return withIcon(el, f, 'maproom', icon, label);
  }
  // En värld ur lådan: receptets spakar och det målade lagret byts (färdiga världar har inget), vyn och vädret står kvar
  async function use(id, v, layers) {
    for (const k of recipeKeys) vals[k] = v[k];
    paint = decodePaint(layers?.biomePaint);
    mark(id);
    cards.sync();
    apply();
    await regenerate();
  }
  function renderDrawer() {
    body.replaceChildren();
    const sec = (title, tiles) => { if (!tiles.length) return; const g = el('section', 'libgroup'); const grid = el('div', 'wprofs'); grid.append(...tiles); g.append(el('h3', null, title), grid); body.append(g); };
    if (step === 'biomes') {
      headTitle.textContent = 'Biomes';
      headNote.textContent = 'Pick a biome and paint it on the land with the left mouse button; the right button turns the view. The rules place the rest.';
      sec('Paint', [...info.biomes.map((b, i) => biomeTile(b, i)), biomeTile({ id: 'erase', label: 'Erase', help: 'Wipe the painting, so the rules decide again' }, -1)]);
      const clear = el('button', null, 'Clear all painting');
      clear.onclick = () => { paint.fill(0); applyBiomes(); };
      body.append(clear);
      return;
    }
    headTitle.textContent = 'Worlds';
    headNote.textContent = 'Click a world to start from it. Save your own in the Save card.';
    sec('Ready-made', Object.entries(info.presets).map(([id, p]) => tile(id, p.label, p, id)));
    sec('Saved', info.saved.map((x) => tile(`saved:${x.name}`, x.name, x.settings, x.from, x.layers)));
  }
  // En biom i lådan: väljer penseln (Erase suddar); klick igen släpper penseln, så att vänsterknappen roterar igen
  function biomeTile(b, i) {
    const f = el('button', `wprof${brushBiome === i && painting ? ' on' : ''}`);
    f.dataset.biome = b.id;
    f.title = b.help;
    const sw = el('span', 'gswatch');
    sw.style.background = b.color ?? 'transparent';
    f.append(el('b', null, b.label), i >= 0 ? sw : el('span', 'wmeta', 'back to the rules'), el('span', 'wmeta', i >= 0 ? `${stats.coverage?.[b.id] ?? 0} % of the land` : ''));
    f.onclick = () => { if (painting && brushBiome === i) setBrush(null); else setBrush(i); };
    return withIcon(el, f, 'maproom', `biome_${b.id}`, b.label);
  }
  function mark(id) { current = id; for (const b of body.querySelectorAll('.wprof[data-id]')) b.classList.toggle('on', b.dataset.id === id); }

  // --- Stegen: World formar landet, Biomes målar naturen på det; samma värld och scen ---
  let step = 'world', painting = false, brushBiome = null;
  function setStep(s) {
    step = s;
    for (const [id, c] of Object.entries(cardOf)) c.hidden = !(IN_STEP[s] ?? IN_STEP.world).includes(id);
    vals.view = s === 'biomes' ? 'biomes' : 'shaded';
    if (s !== 'biomes') setBrush(null);
    renderDrawer();
    apply();
    note.textContent = hint();
  }
  // Penseln: med en biom vald målar vänsterknappen och högerknappen roterar; utan pensel som vanligt
  function setBrush(i) {
    painting = i !== null && step === 'biomes';
    brushBiome = painting ? i : null;
    controls.mouseButtons = painting ? { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    U.brushOn.value = 0;
    for (const b of body.querySelectorAll('.wprof[data-biome]')) b.classList.toggle('on', painting && b.dataset.biome === (i < 0 ? 'erase' : info.biomes[i]?.id));
    note.textContent = hint();
  }
  const hint = () => (painting ? `Painting ${brushBiome < 0 ? 'erase' : info.biomes[brushBiome].label.toLowerCase()}: left button paints, right button turns, scroll zooms` : 'Drag to orbit, scroll to zoom');

  // Var pekaren träffar marken: en stråle från kameran, stegvis mot höjdfältet och sedan halvering
  const ndc = new THREE.Vector2(), rc = new THREE.Raycaster();
  function groundAt(ev) {
    if (!field) return null;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, camera);
    const o = rc.ray.origin, dir = rc.ray.direction, stepLen = Math.max(0.5, field.cell * 1.5), maxT = camera.far;
    let t0 = 0;
    for (let t = stepLen; t < maxT; t += stepLen) {
      const x = o.x + dir.x * t, z = o.z + dir.z * t;
      if (Math.abs(x) > half && Math.abs(z) > half && dir.y >= 0) return null;
      if (o.y + dir.y * t <= bedAt(x, z)) {
        let a = t0, b = t;
        for (let it = 0; it < 12; it++) { const m = (a + b) / 2; if (o.y + dir.y * m <= bedAt(o.x + dir.x * m, o.z + dir.z * m)) b = m; else a = m; }
        const px = o.x + dir.x * b, pz = o.z + dir.z * b;
        return Math.abs(px) <= half && Math.abs(pz) <= half ? { x: px, z: pz } : null;
      }
      t0 = t;
    }
    return null;
  }
  let down = false, queued = false;
  const canvas = renderer.domElement;
  function strokeAt(ev) {
    const p = groundAt(ev);
    U.brushOn.value = p ? 1 : 0;
    if (!p) return;
    U.brush.value.set(p.x, p.z, vals.brush);
    if (!down) return;
    paintStroke(paint, p.x, p.z, { biome: brushBiome, radius: vals.brush, strength: vals.brushStrength, size: sizeOf() });
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; applyBiomes(); }); }
    mark(null);
  }
  canvas.addEventListener('pointerdown', (ev) => { if (!painting || ev.button !== 0) return; down = true; canvas.setPointerCapture(ev.pointerId); strokeAt(ev); });
  canvas.addEventListener('pointermove', (ev) => { if (painting) strokeAt(ev); });
  canvas.addEventListener('pointerup', (ev) => { if (!down) return; down = false; canvas.releasePointerCapture(ev.pointerId); });
  canvas.addEventListener('pointerleave', () => { if (!down) U.brushOn.value = 0; });
  renderDrawer();
  cards.sync();
  apply();

  // --- Footern ---
  const fLand = el('div', 'block'), fBiomes = el('div', 'block'), fStats = el('div', 'block'), note = el('div', 'msg');
  footer.append(fLand, fBiomes, fStats, note);
  const block = (b, title, text) => { b.replaceChildren(el('b', null, title), el('div', 'vals', text)); };
  const clock = (hh) => `${String(Math.floor(hh)).padStart(2, '0')}:${String(Math.round((hh % 1) * 60) % 60).padStart(2, '0')}`;
  function showStats() {
    block(fLand, 'World', `${sizeLabel[vals.worldSize] ?? vals.worldSize} square · top ${stats.top} m${vals.sea ? ` · ${stats.land} % above the sea` : ''} · built in ${stats.ms} ms`);
    const top = Object.entries(stats.coverage ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4); // andelar av landet
    block(fBiomes, 'Biomes', `${top.map(([id, v]) => `${info.biomes.find((x) => x.id === id)?.label ?? id} ${v} %`).join(' · ')} · ${stats.biomeMs} ms`);
    if (step === 'biomes') for (const b of body.querySelectorAll('.wprof[data-biome]')) { const m = b.querySelectorAll('.wmeta'); const v = stats.coverage?.[b.dataset.biome]; if (v != null && m.length) m[m.length - 1].textContent = `${v} % of the land`; }
  }
  note.textContent = 'Drag to orbit, scroll to zoom';
  await regenerate();

  // --- Rendering ---
  let running = false, last = performance.now(), frames = 0, fpsT = last, fps = 0, time = 0;
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', () => { if (running) resize(); });
  const gate = frameGate();
  function tick(dt) {
    time += dt;
    water.update(time);
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
      block(fStats, 'View', `${Math.round(stats.triangles / 1000)}k triangles · ${fps} fps · ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'} · ${clock(vals.hour)}`);
    }
  }

  // För prov: ?shot=<namn> sparar en bild av varje färdig värld (eller bara only=<id>,<id>) (build/shots/studio_<namn>_<landskap>_<renderare>_<fps>.png);
  // med test=1 stängs provfönstret efter den sista
  const q = new URLSearchParams(location.search), shotName = q.get('shot');
  if (shotName && /^[\w-]{1,40}$/.test(shotName) && /kartrummet/.test(location.hash)) setTimeout(async () => {
    const ids = Object.keys(info.presets).filter((id) => !q.get('only') || q.get('only').split(',').includes(id)); // only=a,b: bara de världarna
    for (const [i, id] of ids.entries()) {
      // set=nyckel:värde,...: prova en ändring i receptet (felsökning)
      const over = Object.fromEntries((q.get('set') ?? '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split(':'); return [k, v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v)]; }));
      await use(id, { ...defaults, ...stripLabel(info.presets[id]), ...over });
      if (q.get('step')) setStep(q.get('step'));
      if (over.view) { vals.view = over.view; apply(); }
      await new Promise((r) => setTimeout(r, 2500));
      tick(0);
      const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
      const test = q.get('test') === '1' && i === ids.length - 1 ? '&test=1' : '';
      await fetch(`/api/shot?name=${shotName}_${id}_${renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl'}_${fps}fps${test}`, { method: 'POST', body: blob });
    }
  }, 4000);

  return {
    show() { running = true; resize(); last = performance.now(); renderer.setAnimationLoop(frame); },
    hide() { running = false; renderer.setAnimationLoop(null); },
    scene, camera, controls, renderer, vals, apply, regenerate, atm, water, setStep, setBrush,
    get step() { return step; }, get paint() { return paint; }, get weights() { return final; },
    stats: () => ({ ...stats, fps, backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl' }),
  };
}
function stripLabel(p) { const { label: _l, ...rest } = p; return rest; }
