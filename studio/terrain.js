// Kartrummet, stegen World, Regions, Biomes, Sculpt, Paint och Populate (docs/terrain.md): världen ur ett recept, oftast en ö i havet, 256 m–4 km
// i fyrkant, regionerna (zoner med eget klimat, tema och färgton) och biomerna på den. Höjdfältet, regionerna och
// biomerna räknas i en worker (shared/terrain/worker.js: generate.js, field.js, regions.js och biomes.js), marken
// läggs i lager efter biomerna och tonas efter regionen, och det formade (penslar, bäckar, åar och vikar ur
// shared/terrain/sculpt.js) ligger ovanpå den genererade marken, och målade marklager (shared/terrain/paint.js) ovanpå
// biomernas mark, i procent; naturen sprids ut med regler (shared/terrain/populate.js) och ritas i nivåer
// (studio/populate3d.js) (med klippor i branter och rännor där
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
import { removeFromPaint } from '../shared/terrain/regions.js';
import { brushDab, rampStroke, encodeDelta, decodeDelta, resampleDelta, falloff } from '../shared/terrain/sculpt.js';
import { createStamp, createLandform, placeLandform } from '../shared/terrain/stamps.js';
import { SLOTS, paintDab, coverage as paintCoverage, resampleWeights, encodeWeights, decodeWeights } from '../shared/terrain/paint.js';
import { populate } from '../shared/terrain/populate.js';
import { createNature } from './populate3d.js';
import { createGrass, groundSampler } from '../shared/effects/grass.js';
import { createWind } from '../shared/effects/wind.js';
import { gpuPreference, frameGate } from './gpu.js';
import { createCards, withIcon } from './cards.js';
import { createSplash } from './splash.js';

const DEG = Math.PI / 180;
// Spakar som kräver att höjdfältet räknas om; övriga ändrar bara materialet, havet eller vyn
const SHAPE_KEYS = new Set(['worldSize', 'shape', 'seed', 'height', 'scale', 'coast', 'octaves', 'roughness', 'ridges', 'warp', 'terraces', 'terraceSharp', 'erosion', 'talus']);
// Spakar som bara räknar om biomerna (snabbt, på den senaste terrängen i workern)
const BIOME_KEYS = new Set(['sea', 'seaLevel', 'sandBand', 'snowline', 'cliffAngle', 'treeline', 'rainfall', 'forestCover', 'marshes', 'coastWind', 'regionBorder', 'regionWander', 'regionTerrain']);
// En ny värld har en region med världens eget klimat, så att steget Regions inte märks förrän man lägger till fler
const firstRegions = (list) => structuredClone(Array.isArray(list) && list.length ? list : [{ name: 'Heartland', theme: 'temperate' }]);

export async function createTerrainTab({ api, el, view, side, drawer, footer }) {
  const [info, wx, wa] = await Promise.all([api('/api/terrain'), api('/api/weather'), api('/api/water')]);
  const wxDefaults = Object.fromEntries(wx.params.map((q) => [q.key, q.default]));
  const weathers = { ...wx.presets, ...Object.fromEntries(wx.saved.map((x) => [`saved:${x.name}`, { label: x.name, ...x.settings }])) };
  info.params.find((q) => q.key === 'weather').options = Object.entries(weathers).map(([id, p]) => ({ id, label: p.label ?? id }));
  const defaults = Object.fromEntries(info.params.map((q) => [q.key, q.default]));
  const recipeKeys = info.params.filter((q) => q.recipe !== false).map((q) => q.key);
  const firstPreset = Object.keys(info.presets)[0];
  const vals = { ...defaults, ...stripLabel(info.presets[firstPreset] ?? {}) };
  vals.regions = firstRegions(vals.regions);
  vals.channels = structuredClone(vals.channels ?? []); // grävt vatten (steget Sculpt): [{ kind, points: [[u, v], ...] }]
  // målade marklager (steget Paint): SLOTS platser med { texture, metres } eller null, i samma ordning som vikterna
  const slotsOf = (list) => Array.from({ length: SLOTS }, (_, i) => (Array.isArray(list) && list[i] ? { ...list[i] } : null));
  vals.paintLayers = slotsOf(vals.paintLayers);
  // utplaceringen (steget Populate): frö, täthet, detaljavstånd och per lager { on, density }
  const popDefaults = () => ({ ...Object.fromEntries(info.populate.global.map((q) => [q.key, q.default])), layers: {} });
  const popOf = (p) => ({ ...popDefaults(), ...structuredClone(p ?? {}) });
  vals.populate = popOf(vals.populate);
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
  // Laddningsskylten (studio/splash.js): när en värld byggs och när naturen och gräset växer fram
  const splash = createSplash(el, view);
  const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); // så att skylten hinner ritas
  // De första bilderna efter en ändring (då kompileras skuggningarna för det som syns); compileAsync på hela scenen tog
  // 15–20 s med naturens alla nivåer, så skylten väntar bara in två ritade bilder
  const prepareView = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
  camera.position.set(...info.camera.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...info.camera.target);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 4;
  controls.maxDistance = 900;
  let running = false; // ritas fliken (show/hide); tangenterna i Sculpt gäller bara då

  // --- Atmosfären (shared/effects/weather.js), med solen långt bort så att skuggorna räcker över hela platsen ---
  const atm = createAtmosphere({ scene, shadowSize: 4096, shadowRange: half * 1.25, lightDistance: half * 2.2 });
  const sky = atm.sky;
  // Vinden för gräset (shared/effects/wind.js), med styrka och riktning ur vädret
  const wind = createWind({ strength: 0.5, dir: 60 * DEG });
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
  // Allt som laddas (texturer, modeller) går genom en LoadingManager, så att skylten kan räkna filerna
  const manager = new THREE.LoadingManager();
  let assetsBusy = false, assetWaiters = [];
  manager.onStart = () => { assetsBusy = true; };
  manager.onProgress = (url, loaded, total) => splash.set('assets', loaded / total, `${loaded} / ${total} files`);
  manager.onLoad = () => { assetsBusy = false; const w = assetWaiters; assetWaiters = []; w.forEach((r) => r()); };
  const assetsIdle = () => new Promise((r) => (assetsBusy ? assetWaiters.push(r) : r()));
  const texLoader = new THREE.TextureLoader(manager), texCache = new Map();
  const raw = (name) => {
    if (!texCache.has(name)) { const t = texLoader.load(`/assets/textures/${name}.png`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; texCache.set(name, t); }
    return texCache.get(name);
  };
  const tex = (name, metres) => antiTiled(raw(name), positionWorld.xz.div(metres));

  // --- Havet: vattenmodulen med en havstyp ur Vatten-fliken; botten utanför platsen ligger djupt ---
  const waterVals = { ...Object.fromEntries(wa.params.map((q) => [q.key, q.default])), ...stripLabel(wa.presets.tropical_lagoon ?? {}) };
  const riverVals = { ...Object.fromEntries(wa.params.map((q) => [q.key, q.default])), ...stripLabel(wa.presets[info.channelKinds.stream?.water] ?? {}) }; // bäckar och åar
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
    brushInner: uniform(0), // radien där falloff börjar (hardness · radien); en svagare inre ring
  };
  const h = positionWorld.y, up = normalWorld.y, wet = attribute('wet', 'float');
  // Biomernas vikter (shared/terrain/biomes.js): bio0 = strand, äng, lövskog, barrskog; bio1 = myr, hed, berg, snö
  const bio0 = attribute('bio0', 'vec4'), bio1 = attribute('bio1', 'vec4');
  // Regionerna (shared/terrain/regions.js): reg = kartfärg och hur ren regionen är, look = färgton på växtligheten och tonen
  const reg = attribute('reg', 'vec4'), look = attribute('look', 'vec4');
  const wobble = mx_noise_float(vec3(positionWorld.xz.mul(0.06), 0)).mul(1.0).add(mx_noise_float(vec3(positionWorld.xz.mul(0.4), 3)).mul(0.25));
  const steppe = tex('ground_steppe', 3), moss = tex('moss_stylized', 2.5), floor = tex('surface_forestfloor', 3);
  const grass = mix(steppe, tex('ground_lush', 3), U.tone.add(look.w.sub(0.5).mul(2)).clamp(0, 1)); // regionens ton flyttar världens
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
  // Växtligheten (äng, skogar, myr, hed) tonas efter regionen; sand, berg och snö är desamma överallt
  const plants = LAYER[1].mul(bio0.y).add(LAYER[2].mul(bio0.z)).add(LAYER[3].mul(bio0.w)).add(LAYER[4].mul(bio1.x)).add(LAYER[5].mul(bio1.y));
  let c = LAYER[0].mul(bio0.x).add(plants.mul(look.xyz)).add(LAYER[6].mul(bio1.z)).add(LAYER[7].mul(bio1.w));
  c = mix(c, tex('surface_dirt', 2.5), smoothstep(0.75, 1, wet).mul(smoothstep(0.97, 0.88, up)).mul(float(1).sub(bio1.w)).mul(0.7)); // rännor i branta sluttningar
  const rock = triplanarTexture(texture(raw('surface_cliff')), null, null, float(1 / 7), positionWorld, normalWorld).rgb;
  c = mix(c, rock, smoothstep(U.cliff.add(0.05), U.cliff.sub(0.05), up.add(wobble.mul(0.03)))); // klippor i branter
  // Penselns ring (steg Biomes): en ring på marken där penseln är
  const brushRing = Fn(() => {
    const d = length(positionWorld.xz.sub(U.brush.xy)), w = U.brush.z.mul(0.035).add(0.4);
    const inner = float(1).sub(smoothstep(0, w, abs(d.sub(U.brushInner)))).mul(0.45).mul(smoothstep(0.4, 0.6, U.brushInner));
    return max(float(1).sub(smoothstep(0, w, abs(d.sub(U.brush.z)))), inner).mul(U.brushOn);
  })();
  // Den skuggade marken: biomernas mark och ovanpå den de målade lagren i procent (paint0 och paint1, åtta vikter per
  // hörn; det som blir över är biomernas mark). Byggs om när ett lager får en ny textur, eftersom texturerna är en del
  // av skuggningen
  const pw = [attribute('paint0', 'vec4'), attribute('paint1', 'vec4')];
  function buildShaded() {
    const w = [pw[0].x, pw[0].y, pw[0].z, pw[0].w, pw[1].x, pw[1].y, pw[1].z, pw[1].w];
    let col = c, sum = null, add = null;
    vals.paintLayers.forEach((L, i) => {
      if (!L) return;
      const t = tex(L.texture, L.metres).mul(w[i]);
      add = add ? add.add(t) : t;
      sum = sum ? sum.add(w[i]) : w[i];
    });
    if (add) col = c.mul(float(1).sub(sum.min(1))).add(add);
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
    m.colorNode = mix(water.groundColor(col.mul(0.92), water.uniforms.level), color('#ffffff'), brushRing.mul(0.85));
    m.roughnessNode = water.groundRoughness(float(0.92), water.uniforms.level);
    return m;
  }
  let shaded = buildShaded();
  function rebuildShaded() {
    const old = shaded;
    shaded = MATS.shaded = buildShaded();
    if (ground.material === old) ground.material = shaded;
    old.dispose();
  }
  // Felsökningsvyerna
  const debug = (node) => { const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 }); m.colorNode = node; m.fog = false; return m; }; // utan dis, så att kartan syns klart
  const t = h.sub(U.low).div(max(U.top.sub(U.low), 1)).clamp(0, 1);
  const heightCol = mix(mix(color('#2a6f97'), color('#5aa05a'), smoothstep(-0.02, 0.02, h.sub(U.sea).mul(U.seaOn).add(float(1).sub(U.seaOn)))), mix(color('#8a6a40'), color('#f4f4f4'), smoothstep(0.55, 1, t)), smoothstep(0.15, 0.6, t));
  const slopeT = float(1).sub(up);
  const MATS = {
    shaded,
    height: debug(heightCol.mul(float(0.85).add(smoothstep(0.92, 1, h.mul(0.5).fract()).mul(0.3)))), // ljusa band var 2 m
    slope: debug(mix(mix(color('#20302a'), color('#d8c050'), smoothstep(0, float(1).sub(U.cliff), slopeT)), color('#d03a2a'), smoothstep(float(1).sub(U.cliff).sub(0.02), float(1).sub(U.cliff).add(0.02), slopeT))),
    wetness: debug(mix(color('#e8dcc0'), color('#1f5fb0'), wet)),
    regions: debug(reg.xyz.mul(float(0.55).add(smoothstep(0.5, 0.85, reg.w).mul(0.45))).mul(float(0.8).add(up.mul(0.2))).add(brushRing.mul(0.8))), // mörkare vid gränserna
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
  // Regionernas målade lager (samma form som biomernas; blandas i workern, eftersom klimatet och biomerna följer det)
  let regionPaint = new Uint8Array(PAINT_SIZE * PAINT_SIZE * 2);
  // Skulpteringen: penslarnas höjdskillnad per hörn (delta, meter, deltaN × deltaN, skapas vid första draget) och
  // ångra-stacken (delta och kanalerna före varje drag)
  let delta = null, deltaN = 0, undoStack = [], channelInfo = [];
  // Målningen: vikterna per hörn och lager (groundW, groundN · groundN · SLOTS), andelarna och ångra-stacken för den
  let groundW = null, groundN = 0, paintUndo = [], paintCov = [];
  // Utplaceringen: naturen som ritas (studio/populate3d.js, skapas första gången), senaste resultatet, om världen
  // ändrats sedan dess, det valda lagret och bibliotekets katalog (familjernas mått och varianter)
  let nature = null, natureDirty = true, natureT = 0, popResult = null, popSel = info.populate.layers[0]?.id ?? null, library = null;
  // Det täta gräset runt kameran (shared/effects/grass.js med follow, inställt i populate.grass i terrain.json): det
  // växer efter biomerna, glesnar av de målade marklagren (deras grass eller plant) och undviker branter och stranden
  let grassField = null, grassEffects = [];
  const grassRoot = new THREE.Group();
  scene.add(grassRoot);
  const grassBiome = BIOMES.map((id) => info.populate.grass?.biomes?.[id] ?? 0);
  const ease = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // Mjukt brus (0..1) för gräsets fläckar: där biomen har lite gräs växer det i gläntor och fläckar, inte jämnt glest
  const hash = (i, j) => { const v = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return v - Math.floor(v); };
  const vnoise = (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
  };
  function grassAt(x, z) {
    if (!field || !final || Math.abs(x) >= half || Math.abs(z) >= half) return 0;
    const cfg = info.populate.grass, { n, cell, heights } = field;
    const i = Math.min(n - 2, Math.max(1, Math.round((x + half) / cell))), j = Math.min(n - 2, Math.max(1, Math.round((z + half) / cell))), k = j * n + i;
    let g = 0;
    for (let b = 0; b < 8; b++) g += final[k * 8 + b] * grassBiome[b];
    g /= 255;
    if (g <= 0.01) return 0;
    const dx = (heights[k + 1] - heights[k - 1]) / (2 * cell), dz = (heights[k + n] - heights[k - n]) / (2 * cell);
    g *= 1 - ease(cfg.slope - 8, cfg.slope, Math.atan(Math.hypot(dx, dz)) / DEG);
    if (vals.sea) g *= ease(vals.seaLevel + cfg.above, vals.seaLevel + cfg.above + 0.5, bedAt(x, z));
    if (groundW && groundN === n && grassEffects.some((e) => e != null)) {
      let sum = 0, eff = 0;
      for (let si = 0; si < SLOTS; si++) { const e = grassEffects[si]; if (e == null) continue; const w = groundW[k * SLOTS + si] / 255; sum += w; eff += w * e; }
      g *= Math.max(0, 1 - Math.min(1, sum)) + eff;
    }
    const patch = 0.5 + (vnoise(x / 9, z / 9) * 0.65 + vnoise(x / 3.5 + 17, z / 3.5 - 5) * 0.35 - 0.5) * 1.8;
    g = Math.min(1, g);
    return ease(patch - 0.25, patch + 0.15, g) * ease(0.03, 0.2, g); // lite gräs (strand, berg) blir inget, inte fläckar
  }
  async function ensureGrass() {
    if (grassField || !info.populate.grass) return;
    const G = await api('/api/grass'), cfg = info.populate.grass;
    const settings = { ...Object.fromEntries(G.params.map((q) => [q.key, q.default])), ...stripLabel(G.presets[cfg.preset] ?? {}), ...cfg.settings };
    grassField = createGrass(wind, { ...cfg.field, follow: true, heightAt: bedAt, densityAt: grassAt }, settings);
    grassField.baseDensity = settings.density ?? 1;
    grassField.setGroundTexture(groundSampler(raw(settings.ground ?? 'ground_meadow')));
    grassField.uniforms.sun.value.copy(atm.keyDir);
    grassRoot.add(grassField.group);
  }
  // Gräsets spak (Grass under Nature) och om det syns: bara i steget Populate
  function showGrass() {
    grassRoot.visible = step === 'populate' && vals.populate.grass > 0;
    grassField?.set({ density: (grassField.baseDensity ?? 1) * vals.populate.grass });
  }
  const recipe = (kind) => ({
    ...Object.fromEntries(recipeKeys.map((k) => [k, vals[k]])), ...worldGrid(sizeOf()),
    regions: vals.regions, regionThemes: info.regionThemes, regionColors: info.regionColors, regionPaint,
    // det formade behövs bara när marken byggs (biomerna räknas på workerns senaste terräng)
    ...(kind === 'biomes' ? {} : { sculpt: delta, sculptN: deltaN, channels: vals.channels, channelKinds: info.channelKinds }),
  });
  // kind = 'world' (generera världen och lägg på det formade), 'edit' (bara det formade, på samma genererade värld)
  // eller 'biomes' (bara regionerna och biomerna, på samma terräng); väntar flera gäller den största
  const RANK = { biomes: 1, edit: 2, world: 3 };
  function request(kind = 'world') {
    if (busy) { dirty = !dirty || RANK[kind] > RANK[dirty] ? kind : dirty; return; }
    busy = true;
    note.textContent = kind === 'world' ? 'Building the world…' : kind === 'edit' ? 'Shaping the land…' : 'Placing the regions and biomes…';
    worker.postMessage({ id: ++sent, recipe: recipe(kind), only: kind === 'world' ? undefined : kind });
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
  // De målade lagrens vikter till marken (paint0 och paint1, 8 bitar var); rows: bara de rader som ändrats
  function applyGroundPaint(rows = null) {
    if (!field) return;
    const n = field.n, g = ground.geometry;
    if (!groundW || groundN !== n) { groundW = groundW ? resampleWeights(groundW, groundN, n) : new Uint8Array(n * n * SLOTS); groundN = n; rows = null; }
    let a0 = g.getAttribute('paint0'), a1 = g.getAttribute('paint1');
    if (!a0 || a0.count !== n * n) {
      a0 = new THREE.BufferAttribute(new Uint8Array(n * n * 4), 4, true);
      a1 = new THREE.BufferAttribute(new Uint8Array(n * n * 4), 4, true);
      g.setAttribute('paint0', a0); g.setAttribute('paint1', a1);
      rows = null;
    }
    const j0 = rows ? Math.max(0, rows.j0) : 0, j1 = rows ? Math.min(n - 1, rows.j1) : n - 1, A = a0.array, B = a1.array;
    for (let k = j0 * n; k < (j1 + 1) * n; k++) for (let q = 0; q < 4; q++) { A[k * 4 + q] = groundW[k * SLOTS + q]; B[k * 4 + q] = groundW[k * SLOTS + 4 + q]; }
    for (const a of [a0, a1]) { if (rows) a.addUpdateRange(j0 * n * 4, (j1 - j0 + 1) * n * 4); a.needsUpdate = true; }
  }
  // Regionernas kartfärg och färgton per hörn, ur workern
  function applyRegions(d) {
    const g = ground.geometry;
    g.setAttribute('reg', new THREE.BufferAttribute(d.reg, 4, true));
    g.setAttribute('look', new THREE.BufferAttribute(d.look, 4, true));
    regionInfo = d.regions;
    placeLabels();
  }
  worker.onmessage = (e) => {
    const d = e.data;
    busy = false;
    if (dirty) { const k = dirty; dirty = null; request(k); return; }
    if (d.only === 'biomes') {
      auto = d.biomes;
      stats.coverage = d.coverage; stats.biomeMs = d.biomeMs;
      applyBiomes();
      applyRegions(d);
      natureDirty = true;
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
    field = { n: d.n, cell: d.cell, heights: d.heights, wet: d.wet };
    if (delta && deltaN !== d.n) { delta = resampleDelta(delta, deltaN, d.n); deltaN = d.n; } // ny världsstorlek
    channelInfo = d.channels ?? [];
    buildChannelWater();
    auto = d.biomes;
    applyBiomes();
    applyRegions(d);
    applyGroundPaint();
    natureDirty = true;
    if (step === 'populate') setTimeout(() => runPopulate(), 0); // efter att resten av svaret lagts på
    paintCov = paintCoverage(groundW, groundN);
    resize3d(d.size);
    let lo = Infinity, hi = -Infinity, land = 0;
    for (const v of d.heights) { lo = Math.min(lo, v); hi = Math.max(hi, v); if (!vals.sea || v > vals.seaLevel) land++; }
    U.low.value = lo; U.top.value = hi;
    sides.geometry.dispose();
    sides.geometry = sideGeometry(field, Math.min(lo, SEABED) - 4);
    rebuildWater();
    stats = { ms: d.ms || stats.ms, editMs: d.editMs, vertices: d.positions.length / 3, triangles: d.index.length / 3, land: Math.round((100 * land) / d.heights.length), top: Math.round(hi), biomeMs: d.biomeMs, coverage: d.coverage };
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
  // Bäckarnas och åarnas yta: ett band längs varje fåra i vattnets nivå (sluttar nedströms), med strömmen längs
  // fåran; vikarna fylls av havet. Kanten ligger under marken (bankarna), så bandet syns bara i fåran.
  let riverWater = null;
  function buildChannelWater() {
    const pos = [], idx = [], flow = [], sea = vals.sea ? vals.seaLevel : -Infinity;
    for (const c of channelInfo) {
      if (c.sea) continue;
      let prev = -1;
      for (const p of c.smp) {
        if (p.level <= sea + 0.03) { prev = -1; continue; } // ute i havet: havets yta tar över
        const v = pos.length / 3, r = p.w * 1.35, sp = (1.1 / p.w) ** 0.9;
        pos.push(p.x + p.tz * r, p.level, p.z - p.tx * r, p.x - p.tz * r, p.level, p.z + p.tx * r);
        flow.push(p.tx * sp * 0.4, p.tz * sp * 0.4, p.tx * sp * 0.4, p.tz * sp * 0.4); // långsammare vid kanterna
        if (prev >= 0) idx.push(prev, prev + 1, v, prev + 1, v + 1, v);
        prev = v;
      }
    }
    if (!pos.length) { if (riverWater) riverWater.mesh.visible = false; return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    bedAndFlow(g, bedAt, (x, z, i) => [flow[i * 2], flow[i * 2 + 1]]);
    if (!riverWater) {
      riverWater = createWater({ geometry: g, level: vals.seaLevel, sky });
      scene.add(riverWater.mesh);
      apply();
    } else { riverWater.mesh.geometry.dispose(); riverWater.mesh.geometry = g; }
    riverWater.mesh.visible = true;
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
    wind.set({ strength: Math.min(1, 0.3 + (w.wind ?? 2) / 10), dir: (w.windDir ?? 60) * DEG });
    grassField?.uniforms.sun.value.copy(atm.keyDir);
    renderer.toneMappingExposure = vals.exposure * (w.exposure ?? 1) * atm.exposure;
    const S = sky.uniforms;
    water.set(waterVals, { dir: atm.keyDir, color: atm.key.color, strength: 1, zenith: S.zenith.value, horizon: S.horizon.value }, { light: atm.key.intensity, ambient: atm.hemi.intensity });
    water.uniforms.rain.value = atm.rain;
    if (riverWater) {
      riverWater.set({ ...riverVals, mirror: false }, { dir: atm.keyDir, color: atm.key.color, strength: 1, zenith: S.zenith.value, horizon: S.horizon.value }, { light: atm.key.intensity, ambient: atm.hemi.intensity });
      riverWater.uniforms.rain.value = atm.rain;
    }
    U.sea.value = vals.seaLevel; U.seaOn.value = vals.sea ? 1 : 0; U.sand.value = vals.sandBand; U.snow.value = vals.snowline;
    U.cliff.value = Math.cos(vals.cliffAngle * DEG); U.tone.value = vals.grassTone;
    ground.material = MATS[vals.view] ?? MATS.shaded;
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
  // Skulpteringspenslarnas inställningar, en uppsättning per pensel och per landform (förval ur terrain.json), sparade
  // i webbläsaren mellan besöken; de hör till verktyget, inte till världen
  const SCULPT_KEY = 'maproom.sculpt.v1', defaultsOf = (qs) => Object.fromEntries(qs.map((q) => [q.key, q.default]));
  let sculptSet = {};
  try { sculptSet = JSON.parse(localStorage.getItem(SCULPT_KEY) ?? '{}') ?? {}; } catch { sculptSet = {}; }
  const saveSculptSet = () => { try { localStorage.setItem(SCULPT_KEY, JSON.stringify(sculptSet)); } catch { /* privat läge: bara för stunden */ } };
  function settingsFor(key) {
    if (!sculptSet[key]) {
      const L = key.startsWith('landform:') ? info.sculptLandforms.find((x) => x.id === key.slice(9)) : null;
      sculptSet[key] = L ? { ...defaultsOf(info.landformParams), size: L.size, height: L.height, seed: 1 }
        : key === 'paint' ? { ...defaultsOf(info.paintParams), stamp: 'round' }
          : { ...defaultsOf(info.sculptParams), stamp: 'round', ...(info.sculptTools.find((x) => x.id === key)?.defaults ?? {}) };
    }
    return sculptSet[key];
  }
  // Penslarna som tar ett mönster; nyckeln och inställningarna för det som är valt (sculptTool och landformId sätts i
  // stegen nedan); kortet Brush byggs med korten men fylls i när ett verktyg väljs
  const STAMPABLE = new Set(['raise', 'lower', 'smooth', 'flatten', 'noise', 'terrace']);
  const activeKey = () => (step === 'paint' ? 'paint' : sculptTool === 'landform' ? `landform:${landformId}` : sculptTool);
  const S = () => settingsFor(activeKey() ?? 'raise');
  let updateSculptCard = () => {}, updatePaintCard = () => {}, updatePopCard = () => {};
  const cards = createCards({ el, side });
  const get = (k) => vals[k];
  const set = (k, v) => { vals[k] = v; };
  const COL = { shape: '#c0672e', detail: '#b88a5a', erosion: '#6a8fb0', water: '#3fa6a0', material: '#6aa84f', regions: '#d9a441', region: '#d9a441', climate: '#3f8f3a', brush: '#e0e0e0', sky: '#e0a030' };
  // Vilka kort som syns i vilket steg: World formar landet, Regions delar in det, Biomes klimatet; vädret och Spara i alla
  const IN_STEP = { world: ['shape', 'detail', 'erosion', 'water', 'material', 'sky'], regions: ['regions', 'region', 'brush', 'sky'], biomes: ['material', 'climate', 'brush', 'sky'], sculpt: ['sculptbrush', 'water', 'sky'], paint: ['paintbrush', 'sky'], populate: ['populate', 'poplayer', 'sky'] };
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
    if (g.id === 'region') regionCard(body);
    if (g.id === 'sculptbrush') sculptCard(body);
    if (g.id === 'paintbrush') paintCard(body);
    if (g.id === 'populate') natureCard(body);
    if (g.id === 'poplayer') popLayerCard(body);
  }
  const saveCard = cards.card('Save', '#4a90d9');
  const saveMsg = el('div', 'note');
  const saveBtn = el('button', 'primary', 'Save world…');
  saveBtn.title = 'Saves the sliders as a world recipe in assets/terrain/ (the land is computed from the recipe, nothing is baked)';
  saveBtn.onclick = async () => {
    const name = prompt('Name of the world (a–z, 0–9 and _):', current?.replace(/^saved:/, '') ?? 'my_island');
    if (!name) return;
    const from = current?.startsWith('saved:') ? info.saved.find((x) => `saved:${x.name}` === current)?.from : current;
    // De målade lagren (biomer och regioner) och regionerna följer med receptet
    const layers = { biomePaint: encodePaint(paint) ?? '', regionPaint: encodePaint(regionPaint) ?? '', sculpt: encodeDelta(delta, deltaN) ?? '', groundPaint: encodeWeights(groundW, groundN) ?? '' };
    const extra = { regions: vals.regions, channels: vals.channels, paintLayers: vals.paintLayers, populate: vals.populate };
    let r = await api('/api/terrain/save', { name, settings: vals, from, layers, ...extra });
    if (r.exists && confirm(`${name} already exists. Overwrite?`)) r = await api('/api/terrain/save', { name, settings: vals, from, layers, ...extra, overwrite: true });
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
    f.append(el('b', null, label), el('span', 'wmeta', `${shapeLabel[v.shape] ?? v.shape} · ${sizeLabel[v.worldSize] ?? v.worldSize} · ${v.height} m high${v.regions?.length > 1 ? ` · ${v.regions.length} regions` : ''}`));
    f.onclick = () => use(id, v, layers);
    return withIcon(el, f, 'maproom', icon, label);
  }
  // En värld ur lådan: receptets spakar och det målade lagret byts (färdiga världar har inget), vyn och vädret står kvar
  async function use(id, v, layers) {
    const name = info.presets[id]?.label ?? id.replace(/^saved:/, '').replace(/_/g, ' ');
    splash.start(`Loading ${name.charAt(0).toUpperCase()}${name.slice(1)}`, [['land', 'Shaping the land'], ['assets', 'Textures'], ['draw', 'Preparing the view']]);
    await painted();
    for (const k of recipeKeys) vals[k] = v[k];
    vals.regions = firstRegions(v.regions);
    regionSel = 0;
    paint = decodePaint(layers?.biomePaint);
    regionPaint = decodePaint(layers?.regionPaint);
    vals.channels = structuredClone(v.channels ?? []);
    const sc = decodeDelta(layers?.sculpt);
    delta = sc?.delta ?? null; deltaN = sc?.n ?? 0;
    undoStack = [];
    vals.paintLayers = slotsOf(v.paintLayers);
    vals.populate = popOf(v.populate);
    const gp = decodeWeights(layers?.groundPaint);
    groundW = gp?.weights ?? null; groundN = gp?.n ?? 0;
    paintUndo = [];
    rebuildShaded();
    mark(id);
    cards.sync();
    apply();
    await regenerate();
    splash.done('land', `${stats.ms} ms`);
    await assetsIdle();
    splash.done('assets');
    await prepareView();
    splash.done('draw');
  }
  function renderDrawer() {
    body.replaceChildren();
    const sec = (title, tiles) => { if (!tiles.length) return; const g = el('section', 'libgroup'); const grid = el('div', 'wprofs'); grid.append(...tiles); g.append(el('h3', null, title), grid); body.append(g); };
    if (step === 'populate') {
      headTitle.textContent = 'Populate';
      headNote.textContent = 'Nature spreads by rules: each layer grows where its biomes, slope, height and wetness say, thinned or filled by the painted ground (paths stay clear) and the region\'s theme. Pick a layer to tune it in the Layer card. Near the camera the full models are drawn, further out lighter ones.';
      sec('Layers', info.populate.layers.map((L) => {
        const r = popResult?.layers.find((x) => x.id === L.id), off = vals.populate.layers[L.id]?.on === false;
        const f = el('button', `wprof${popSel === L.id ? ' on' : ''}`);
        f.dataset.layer = L.id;
        f.title = L.help;
        f.append(el('b', null, L.label), el('span', 'wmeta', off ? 'off' : r ? `${r.count.toLocaleString('en')} placed` : '…'));
        f.onclick = () => { popSel = L.id; updatePopCard(); for (const b of body.querySelectorAll('.wprof[data-layer]')) b.classList.toggle('on', b.dataset.layer === popSel); };
        const m = L.models[0][0];
        return withIcon(el, f, 'maproom', null, L.label, `/assets/${m}/${m.split('/').pop()}_thumb.png`);
      }));
      const tools = el('div', 'rtools');
      const again = el('button', null, 'Populate again');
      again.title = 'Spread the nature again over the world as it looks now';
      again.onclick = () => runPopulate();
      const reseed = el('button', null, 'New seed');
      reseed.title = 'A different, equally valid layout of the same rules';
      reseed.onclick = () => { vals.populate.seed = 1 + Math.floor(Math.random() * 999); cards.sync(); mark(null); runPopulate(); };
      tools.append(again, reseed);
      body.append(tools);
      return;
    }
    if (step === 'paint') {
      headTitle.textContent = 'Paint';
      headNote.textContent = 'Pick a ground texture and paint it on the land with the left mouse button: it lies over what is there by the brush strength, and the biomes fill the rest. Each biome offers its own textures; All shows every one. Ctrl erases, [ and ] change the size, Ctrl+Z undoes.';
      const tabs = [...info.biomes.map((b) => [b.id, b.label]), ['paths', 'Paths'], ['all', 'All']];
      const chips = el('div', 'rtools');
      for (const [id, label] of tabs) {
        const b = el('button', paletteTab === id ? 'on' : null, label);
        b.dataset.palette = id;
        b.onclick = () => { paletteTab = id; renderDrawer(); };
        chips.append(b);
      }
      body.append(chips);
      const ids = paletteTab === 'all' ? info.groundTextures.map((t) => t.id) : info.biomeTextures[paletteTab] ?? [];
      sec(`Textures · ${tabs.find((x) => x[0] === paletteTab)?.[1] ?? ''}`, [...ids.map((id) => textureTile(id)), textureTile('erase')]);
      sec('Pattern', info.sculptStamps.map((x) => stampTile(x)));
      const used = vals.paintLayers.map((L, i) => [L, i]).filter(([L]) => L);
      if (used.length) {
        const list = el('div', 'rtools');
        for (const [L, i] of used) {
          const b = el('button', null, `✕ ${info.groundTextures.find((t) => t.id === L.texture)?.label ?? L.texture} ${paintCov[i] ?? 0} %`);
          b.title = 'Remove this layer: its ground goes back to the biomes';
          b.onclick = () => {
            pushPaintUndo();
            for (let k = i; k < groundW.length; k += SLOTS) groundW[k] = 0;
            vals.paintLayers[i] = null;
            rebuildShaded(); applyGroundPaint(); paintCov = paintCoverage(groundW, groundN);
            mark(null); renderDrawer();
          };
          list.append(b);
        }
        const g = el('section', 'libgroup');
        g.append(el('h3', null, `Painted in this world (${used.length} of ${SLOTS})`), list);
        body.append(g);
      }
      const tools = el('div', 'rtools'), undo = el('button', null, 'Undo');
      undo.title = 'Undo the last stroke (Ctrl+Z)';
      undo.disabled = !paintUndo.length;
      undo.onclick = () => undoPaint();
      tools.append(undo);
      body.append(tools);
      return;
    }
    if (step === 'sculpt') {
      headTitle.textContent = 'Sculpt';
      headNote.textContent = 'Pick a brush and drag on the land with the left mouse button (Ctrl inverts, Shift smooths, [ and ] change the size), click once to place a landform, or draw water: click points along a stream, river or bay and double-click to finish. The right button turns the view; Ctrl+Z undoes.';
      sec('Brushes', info.sculptTools.map((x) => toolTile(x.id, x.label, x.help, `sculpt_${x.id}`)));
      if (STAMPABLE.has(sculptTool)) sec(`Pattern for ${info.sculptTools.find((x) => x.id === sculptTool).label}`, info.sculptStamps.map((x) => stampTile(x)));
      sec('Landforms', info.sculptLandforms.map((L) => landformTile(L)));
      sec('Water', Object.entries(info.channelKinds).map(([id, k]) => toolTile(id, k.label, k.help, `shape_${id}`)));
      const tools = el('div', 'rtools');
      const btn = (label, tip, fn, off = false) => { const b = el('button', null, label); b.title = tip; b.onclick = fn; b.disabled = off; tools.append(b); return b; };
      btn('Undo', 'Undo the last stroke or line (Ctrl+Z)', () => undoLast(), !undoStack.length);
      if (drawing.length) btn('Finish line', 'Dig the line you are drawing (or double-click, or Enter)', () => finishLine());
      btn('Clear sculpting', 'Remove all brush strokes and dug water, back to the generated world', () => {
        if (!confirm('Remove all sculpting and dug water from this world?')) return;
        pushUndo();
        delta = null; deltaN = 0; vals.channels = [];
        mark(null); renderDrawer(); regenerate('edit');
      }, !delta && !vals.channels.length);
      body.append(tools);
      if (vals.channels.length) {
        const list = el('div', 'rtools');
        vals.channels.forEach((c, i) => {
          const b = el('button', null, `✕ ${info.channelKinds[c.kind]?.label ?? c.kind} ${i + 1}`);
          b.title = 'Fill this line in again';
          b.onclick = () => { pushUndo(); vals.channels.splice(i, 1); mark(null); renderDrawer(); regenerate('edit'); };
          list.append(b);
        });
        const g = el('section', 'libgroup');
        g.append(el('h3', null, 'Dug water'), list);
        body.append(g);
      }
      return;
    }
    if (step === 'regions') {
      headTitle.textContent = 'Regions';
      headNote.textContent = 'Regions are the zones of the world, each with its own climate, theme and colour. Pick one to edit it in the Region card and paint its borders with the left mouse button.';
      sec('Regions', [...vals.regions.map((r, i) => regionTile(r, i)), regionTile({ name: 'Erase', theme: null }, -1)]);
      const tools = el('div', 'rtools');
      const btn = (label, tip, fn, on = false) => { const b = el('button', on ? 'on' : null, label); b.title = tip; b.onclick = fn; tools.append(b); return b; };
      btn('Add region', 'A new region with its own theme; its centre is placed where the land has room', () => {
        if (vals.regions.length >= 16) return;
        const used = new Set(vals.regions.map((r) => r.theme)), free = Object.keys(info.regionThemes).find((t) => !used.has(t)) ?? 'temperate';
        vals.regions.push({ name: `Region ${vals.regions.length + 1}`, theme: free });
        regionSel = vals.regions.length - 1;
        changedRegions();
      });
      btn('Remove', 'Remove the selected region; its land goes to the neighbours', () => {
        if (vals.regions.length <= 1) return;
        vals.regions.splice(regionSel, 1);
        removeFromPaint(regionPaint, regionSel);
        regionSel = Math.max(0, regionSel - 1);
        changedRegions();
      });
      btn('Move centre', 'Click on the land to move the centre of the selected region there', () => { placing = !placing; setBrush(null); renderDrawer(); }, placing);
      btn('Auto centres', 'Spread all centres over the land again', () => { for (const r of vals.regions) delete r.at; changedRegions(); });
      btn('Clear painting', 'Wipe the painted borders, so the rules decide again', () => { regionPaint.fill(0); changedRegions(); });
      body.append(tools);
      return;
    }
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
    sec('Saved', info.saved.map((x) => tile(`saved:${x.name}`, x.name, { ...x.settings, regions: x.regions, channels: x.channels, paintLayers: x.paintLayers, populate: x.populate }, x.from, x.layers)));
  }
  // En region i lådan: väljer den för kortet och penseln (Erase suddar); klick igen släpper penseln
  function regionTile(r, i) {
    const f = el('button', `wprof${(painting ? brushIndex === i : i === regionSel) ? ' on' : ''}`);
    f.dataset.pick = String(i);
    const th = info.regionThemes[r.theme];
    f.title = i >= 0 ? (th?.help ?? '') : 'Wipe the painted borders, so the rules decide again';
    const sw = el('span', 'gswatch');
    sw.style.background = regionColor(i);
    f.append(el('b', null, r.name), i >= 0 ? sw : el('span', 'wmeta', 'back to the rules'), el('span', 'wmeta', i >= 0 ? `${th?.label ?? r.theme} · ${regionInfo?.coverage?.[i] ?? 0} % of the land` : ''));
    f.onclick = () => {
      placing = false;
      if (i >= 0) { regionSel = i; cards.sync(); }
      if (painting && brushIndex === i) setBrush(null); else setBrush(i);
      placeLabels();
    };
    return withIcon(el, f, 'maproom', i >= 0 ? `region_${r.theme}` : 'biome_erase', r.name);
  }
  const regionColor = (i) => vals.regions[i]?.color ?? info.regionColors[i % info.regionColors.length];
  // Regionerna ändrade (lagts till, tagits bort, flyttats, nytt tema): lådan, korten och workern
  function changedRegions() {
    mark(null);
    cards.sync();
    renderDrawer();
    regenerate('biomes');
  }
  // Kortet Region: namn, tema och justeringar för den valda regionen (regionParams i terrain.json)
  function regionCard(body) {
    const sel = () => vals.regions[regionSel] ?? vals.regions[0];
    const nameRow = el('div', 'row span2'), name = el('input', 'rname');
    name.type = 'text';
    name.maxLength = 40;
    cards.syncs.push(() => { name.value = sel()?.name ?? ''; });
    name.onchange = () => { sel().name = name.value.trim() || sel().name; mark(null); renderDrawer(); placeLabels(); };
    nameRow.append(el('label', null, 'Name'), name);
    body.append(nameRow);
    const themeQ = { key: 'theme', label: 'Theme', help: 'The kind of land: its climate, which biomes thrive and the colour of the plants', options: Object.entries(info.regionThemes).map(([id, t]) => ({ id, label: t.label, help: t.help })) };
    const get = (k) => (k === 'theme' ? sel().theme : sel().adjust?.[k] ?? 0);
    const set = (k, v) => { if (k === 'theme') sel().theme = v; else (sel().adjust ??= {})[k] = v; };
    body.append(cards.choiceRow(themeQ, get, set, () => changedRegions()));
    for (const q of info.regionParams) body.append(cards.slider({ ...q, rebuild: true }, get, set, () => { mark(null); regenerate('biomes'); }));
  }
  // Kortet Brush i Sculpt: den valda penselns (eller landformens) egna spakar; rader som inte hör till den döljs
  function sculptCard(body) {
    const get = (k) => S()[k];
    const set = (k, v) => { S()[k] = v; saveSculptSet(); ringSize(); };
    const rows = [];
    for (const q of info.sculptParams) { const r = cards.rowFor(q)(q, get, set, () => updateSculptCard()); rows.push(['brush', q, r]); body.append(r); }
    for (const q of info.landformParams) { const r = cards.rowFor(q)(q, get, set, () => updateSculptCard()); rows.push(['form', q, r]); body.append(r); }
    const msg = el('div', 'note');
    body.append(msg);
    updateSculptCard = () => {
      const tool = sculptTool, brush = STAMPABLE.has(tool) || tool === 'ramp' || tool === 'erode', st = brush || tool === 'landform' ? S() : null;
      for (const [kind, q, r] of rows) {
        r.hidden = kind === 'form' ? tool !== 'landform'
          : !brush || (q.tools && !q.tools.includes(tool)) || (q.stamp && (!STAMPABLE.has(tool) || st.stamp === 'round')) || (q.key === 'height' && !st.lock);
      }
      msg.textContent = !tool ? 'Pick a brush, a landform or water in the drawer.' : info.channelKinds[tool] ? 'Water has no brush settings: click points along it and double-click to dig.' : '';
      msg.hidden = !msg.textContent;
      cards.sync();
    };
  }
  // Ringens storlek efter den valda penseln (och den inre ringen för hardness)
  function ringSize() {
    if (step === 'paint' ? !paintChoice : !sculptTool || info.channelKinds[sculptTool]) return;
    const st = S();
    U.brush.value.z = st.size;
    U.brushInner.value = sculptTool === 'landform' && step !== 'paint' ? 0 : st.size * (st.hardness ?? 0.25);
  }
  // Utplaceringen: reglerna i terrain.json (populate.layers) på världen som den ser ut nu (höjder, fukt, biomer med det
  // målade, målade marklager och regionernas teman), och sedan naturen i nivåer
  async function runPopulate() {
    if (!field || !final) return;
    // Skylten: genast första gången (modellerna laddas), annars bara om det tar en stund
    const grassOn = step === 'populate' && vals.populate.grass > 0;
    if (!splash.active) splash.start('Growing the nature', [], { delay: nature ? 400 : 0 });
    splash.add('place', 'Placing the nature');
    splash.add('models', 'Loading models');
    if (grassOn) splash.add('grass', 'Growing the grass');
    splash.add('draw', 'Preparing the view');
    library ??= await api('/api/library').catch(() => ({ items: [] }));
    nature ??= createNature({ scene, rules: info.populate, library, manager });
    note.textContent = 'Placing the nature…';
    await painted();
    const effects = vals.paintLayers.map((L) => (L ? info.groundTextures.find((t) => t.id === L.texture)?.populate ?? {} : null));
    const world = {
      n: field.n, cell: field.cell, half, size: sizeOf(), heights: field.heights, wet: field.wet, biomes: final, sea: vals.sea ? vals.seaLevel : null,
      ground: groundW && vals.paintLayers.some(Boolean) ? { W: groundW, effects } : null,
      regions: regionInfo?.weights ? { P: regionInfo.P, count: regionInfo.count, weights: regionInfo.weights, themes: vals.regions.map((r) => r.theme) } : null,
    };
    popResult = populate(world, info.populate, { seed: vals.populate.seed, density: vals.populate.density, layers: vals.populate.layers });
    splash.done('place', `${popResult.total.toLocaleString('en')} placed`);
    natureDirty = false;
    await ensureGrass();
    grassEffects = effects.map((e) => (e ? e.grass ?? e.plant ?? 1 : null));
    grassField?.refresh();
    showGrass();
    await nature.set(popResult, (a, b) => splash.set('models', b ? a / b : 1, `${a} / ${b} models`));
    splash.done('models');
    nature.visible = step === 'populate';
    nature.update(camera.position, vals.populate.detail);
    showStats();
    if (step === 'populate') renderDrawer();
    note.textContent = hint();
    await prepareView();
    splash.done('draw');
  }
  // Kortet Nature: allt på en gång (täthet, frö, detaljavstånd)
  function natureCard(body) {
    const get = (k) => vals.populate[k], set = (k, v) => { vals.populate[k] = v; };
    for (const q of info.populate.global) {
      body.append(cards.rowFor(q)({ ...q, rebuild: true }, get, set, () => {
        mark(null);
        if (q.key === 'detail') nature?.update(camera.position, vals.populate.detail);
        else if (q.key === 'grass') showGrass();
        else runPopulate();
      }));
    }
  }
  // Kortet Layer: det valda lagret i lådan, på eller av och dess täthet
  function popLayerCard(body) {
    const msg = el('div', 'note');
    const layerSet = () => (vals.populate.layers[popSel] ??= {});
    const get = (k) => layerSet()[k] ?? info.populate.params.find((q) => q.key === k)?.default;
    const set = (k, v) => { layerSet()[k] = v; };
    const rows = info.populate.params.map((q) => { const r = cards.rowFor(q)({ ...q, rebuild: true }, get, set, () => { mark(null); runPopulate(); }); body.append(r); return r; });
    body.prepend(msg);
    updatePopCard = () => {
      const L = info.populate.layers.find((x) => x.id === popSel);
      msg.textContent = L ? `${L.label}: ${L.help}` : 'Pick a layer in the drawer.';
      for (const r of rows) r.hidden = !L;
      cards.sync();
    };
  }
  // Kortet Paint brush: penselns spakar; mönstrets rader bara med ett mönster
  function paintCard(body) {
    const get = (k) => settingsFor('paint')[k];
    const set = (k, v) => { settingsFor('paint')[k] = v; saveSculptSet(); ringSize(); };
    const rows = info.paintParams.map((q) => { const r = cards.rowFor(q)(q, get, set, () => updatePaintCard()); body.append(r); return [q, r]; });
    updatePaintCard = () => { const st = settingsFor('paint'); for (const [q, r] of rows) r.hidden = !!q.stamp && st.stamp === 'round'; cards.sync(); };
  }
  const stamps = new Map();
  const stampFor = (id) => { const k = `${id}:${vals.seed}`; if (!stamps.has(k)) stamps.set(k, createStamp(id, vals.seed)); return stamps.get(k); };
  // Förhandsbilder av mönster och landformer som höjdkartor: gråskala från lägst (svart) till högst (vitt), som
  // penseln trycker ut dem (mönstren med penselns falloff), i en hel fyrkant
  const thumbs = new Map();
  function thumb(key, fn, form) {
    if (thumbs.has(key)) return thumbs.get(key);
    const N = 56, c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d'), img = g.createImageData(N, N), v = new Float32Array(N * N);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = (i / (N - 1)) * 2 - 1, w = (j / (N - 1)) * 2 - 1, d = Math.hypot(u, w);
      const h = d < 1 ? (fn ? fn(u, w) : 1) * falloff(d, form ? 0.85 : 0.25) : 0; // landformerna med kanten de läggs på med
      v[j * N + i] = h; lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    for (let k = 0; k < N * N; k++) { const q = Math.round((255 * (v[k] - lo)) / Math.max(1e-6, hi - lo)); img.data.set([q, q, q, 255], k * 4); }
    g.putImageData(img, 0, 0);
    const url = c.toDataURL();
    thumbs.set(key, url);
    return url;
  }
  // En marktextur i Paint (eller Erase); klick igen släpper penseln, så att vänsterknappen roterar igen
  function textureTile(id) {
    const T = info.groundTextures.find((t) => t.id === id), erase = id === 'erase', label = erase ? 'Erase' : T?.label ?? id;
    const f = el('button', `wprof${paintChoice === id ? ' on' : ''}`);
    f.dataset.paint = id;
    f.title = erase ? 'Wipe the painting, so the biomes decide again' : `${label}: one tile is ${T?.metres ?? 3} m`;
    f.append(el('b', null, label), el('span', 'wmeta', erase ? 'back to the biomes' : vals.paintLayers.some((L) => L?.texture === id) ? 'painted in this world' : `${T?.metres ?? 3} m tiles`));
    f.onclick = () => { paintChoice = paintChoice === id ? null : id; setBrush(null); ringSize(); };
    return withIcon(el, f, 'maproom', erase ? 'biome_erase' : null, label, erase ? undefined : `/assets/textures/${id}.png`);
  }
  // Ångra i Paint: vikterna och lagren före varje drag (högst 6 steg; en värld på 1 km har 8 MB vikter)
  function pushPaintUndo() {
    if (!groundW) return;
    paintUndo.push({ W: groundW.slice(), n: groundN, layers: structuredClone(vals.paintLayers) });
    if (paintUndo.length > 6) paintUndo.shift();
  }
  function undoPaint() {
    const u = paintUndo.pop();
    if (!u) return;
    groundW = u.W; groundN = u.n; vals.paintLayers = u.layers;
    rebuildShaded(); applyGroundPaint(); paintCov = paintCoverage(groundW, groundN);
    mark(null); renderDrawer();
  }
  // Ett lager för texturen: det den redan har, en tom plats eller en som inte längre syns; −1 när alla åtta används
  function slotFor(id) {
    let i = vals.paintLayers.findIndex((L) => L?.texture === id);
    if (i >= 0) return i;
    i = vals.paintLayers.findIndex((L) => !L);
    if (i < 0) i = paintCoverage(groundW, groundN).findIndex((v) => v === 0);
    if (i < 0) return -1;
    for (let k = i; k < groundW.length; k += SLOTS) groundW[k] = 0;
    vals.paintLayers[i] = { texture: id, metres: info.groundTextures.find((t) => t.id === id)?.metres ?? 3 };
    rebuildShaded();
    return i;
  }
  // Ett verktyg i Sculpt: en pensel eller en sorts vatten; klick igen släpper det, så att vänsterknappen roterar igen
  function toolTile(id, label, help, icon) {
    const f = el('button', `wprof${sculptTool === id ? ' on' : ''}`);
    f.dataset.tool = id;
    f.title = help;
    f.append(el('b', null, label), el('span', 'wmeta', info.channelKinds[id] ? 'click points, double-click to finish' : 'drag on the land'));
    f.onclick = () => setTool(sculptTool === id ? null : id);
    return withIcon(el, f, 'maproom', icon, label);
  }
  // Ett mönster för den valda penseln
  function stampTile(st) {
    const f = el('button', `wprof${S().stamp === st.id ? ' on' : ''}`);
    f.dataset.stamp = st.id;
    f.title = st.help;
    f.append(el('b', null, st.label));
    f.onclick = () => { S().stamp = st.id; saveSculptSet(); renderDrawer(); updateSculptCard(); updatePaintCard(); };
    return withIcon(el, f, 'maproom', null, st.label, thumb(`stamp:${st.id}`, createStamp(st.id, 7), false));
  }
  // En landform: ett klick på marken trycker ut den, i den storlek och höjd som kortet säger
  function landformTile(L) {
    const f = el('button', `wprof${sculptTool === 'landform' && landformId === L.id ? ' on' : ''}`);
    f.dataset.tool = `landform:${L.id}`;
    f.title = L.help;
    f.append(el('b', null, L.label), el('span', 'wmeta', 'click once on the land'));
    f.onclick = () => { if (sculptTool === 'landform' && landformId === L.id) setTool(null); else { landformId = L.id; setTool('landform'); } };
    return withIcon(el, f, 'maproom', null, L.label, thumb(`form:${L.id}`, createLandform(L.id, 3), true));
  }
  // Ångra: delta och kanalerna före varje drag eller linje (högst 12 steg)
  function pushUndo() {
    undoStack.push({ delta: delta?.slice() ?? null, n: deltaN, channels: structuredClone(vals.channels) });
    if (undoStack.length > 12) undoStack.shift();
  }
  function undoLast() {
    const u = undoStack.pop();
    if (!u) return;
    delta = u.delta; deltaN = u.n; vals.channels = u.channels;
    mark(null);
    renderDrawer();
    regenerate('edit');
  }
  // En biom i lådan: väljer penseln (Erase suddar); klick igen släpper penseln, så att vänsterknappen roterar igen
  function biomeTile(b, i) {
    const f = el('button', `wprof${brushIndex === i && painting ? ' on' : ''}`);
    f.dataset.pick = String(i);
    f.title = b.help;
    const sw = el('span', 'gswatch');
    sw.style.background = b.color ?? 'transparent';
    f.append(el('b', null, b.label), i >= 0 ? sw : el('span', 'wmeta', 'back to the rules'), el('span', 'wmeta', i >= 0 ? `${stats.coverage?.[b.id] ?? 0} % of the land` : ''));
    f.dataset.biome = b.id;
    f.onclick = () => { if (painting && brushIndex === i) setBrush(null); else setBrush(i); };
    return withIcon(el, f, 'maproom', `biome_${b.id}`, b.label);
  }
  function mark(id) { current = id; for (const b of body.querySelectorAll('.wprof[data-id]')) b.classList.toggle('on', b.dataset.id === id); }

  // --- Stegen: World formar landet, Regions delar in det, Biomes målar naturen på det; samma värld och scen ---
  // Penseln målar biomer i Biomes och regioner i Regions (brushIndex = biomens eller regionens nummer, −1 suddar);
  // placing: nästa vänsterklick på marken flyttar den valda regionens mittpunkt
  // sculptTool: penseln eller vattnet i Sculpt (raise … noise, stream, river, bay); drawing: linjens punkter i meter
  // paintChoice: marktexturen som målas i Paint (eller 'erase'); paletteTab: vilken biom (eller paths, all) lådan visar
  let step = 'world', painting = false, brushIndex = null, placing = false, regionSel = 0, regionInfo = null, sculptTool = null, landformId = null, drawing = [];
  let paintChoice = null, paletteTab = null;
  function setStep(s) {
    step = s;
    for (const [id, c] of Object.entries(cardOf)) c.hidden = !(IN_STEP[s] ?? IN_STEP.world).includes(id);
    vals.view = s === 'biomes' || s === 'regions' ? s : 'shaded';
    placing = false;
    sculptTool = null;
    paintChoice = null;
    // Paint börjar i utbudet för den biom som täcker mest av landet
    if (s === 'paint' && !paletteTab) paletteTab = Object.entries(stats.coverage ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'meadow';
    cancelLine();
    setBrush(null);
    updateSculptCard();
    updatePaintCard();
    updatePopCard();
    // Naturen syns i Populate; den sprids ut igen om världen ändrats sedan sist
    if (nature) nature.visible = s === 'populate';
    showGrass();
    if (s === 'populate' && (natureDirty || !popResult)) runPopulate();
    renderDrawer();
    apply();
    placeLabels();
    note.textContent = hint();
  }
  // Med en pensel (eller när en mittpunkt flyttas) gör vänsterknappen det och högerknappen roterar; annars som vanligt
  function setBrush(i) {
    painting = i !== null && (step === 'biomes' || step === 'regions');
    brushIndex = painting ? i : null;
    const free = painting || placing || !!sculptTool || (step === 'paint' && !!paintChoice);
    controls.mouseButtons = free ? { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    U.brushOn.value = 0;
    for (const b of body.querySelectorAll('.wprof[data-pick]')) b.classList.toggle('on', painting ? b.dataset.pick === String(i) : step === 'regions' && b.dataset.pick === String(regionSel));
    for (const b of body.querySelectorAll('.wprof[data-tool]')) b.classList.toggle('on', b.dataset.tool === activeKey());
    for (const b of body.querySelectorAll('.wprof[data-paint]')) b.classList.toggle('on', b.dataset.paint === paintChoice);
    note.textContent = hint();
  }
  // Ett verktyg i Sculpt (null släpper det); en halvritad linje släpps när man byter
  function setTool(id) {
    sculptTool = step === 'sculpt' ? id : null;
    if (!info.channelKinds[sculptTool]) cancelLine();
    setBrush(null);
    if (step === 'sculpt') renderDrawer(); // mönstren hör till penseln
    ringSize();
    updateSculptCard();
  }
  const pickName = (i) => (i < 0 ? 'erase' : step === 'regions' ? vals.regions[i]?.name : info.biomes[i].label.toLowerCase());
  const hint = () => (step === 'paint' && paintChoice ? `${paintChoice === 'erase' ? 'Erasing' : `Painting ${info.groundTextures.find((t) => t.id === paintChoice)?.label.toLowerCase()}`}: left button paints over what is there · Ctrl erases · [ ] size · Ctrl+Z undoes`
    : placing ? `Click on the land to move the centre of ${vals.regions[regionSel]?.name}`
    : painting ? `Painting ${pickName(brushIndex)}: left button paints, right button turns, scroll zooms`
      : info.channelKinds[sculptTool] ? `${info.channelKinds[sculptTool].label}: click points along it (${drawing.length} so far), double-click or Enter to dig, Esc to cancel`
        : sculptTool === 'landform' ? `${info.sculptLandforms.find((x) => x.id === landformId)?.label}: click once where it should stand · [ ] size · Ctrl+Z undoes`
          : sculptTool ? `${info.sculptTools.find((x) => x.id === sculptTool)?.label}: drag on the land · Ctrl inverts · Shift smooths · [ ] size${sculptTool === 'flatten' ? ' · Alt+click picks the height' : ''} · Ctrl+Z undoes`
          : 'Drag to orbit, scroll to zoom');

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
    // Biomerna blandas här (snabbt); regionerna i workern, eftersom klimatet och biomerna följer dem
    const regions = step === 'regions';
    paintStroke(regions ? regionPaint : paint, p.x, p.z, { biome: brushIndex, radius: vals.brush, strength: vals.brushStrength, size: sizeOf() });
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; if (regions) request('biomes'); else applyBiomes(); }); }
    mark(null);
  }
  // --- Skulpteringen: penseltryck direkt på marken som syns (höjderna, hörnen och normalerna i de rader som ändrats),
  // och workern bygger om marken, regionerna och biomerna när man släpper ---
  let sculptDown = false, lastDab = null, rampA = null, flattenY = 0, strokeDir = 0;
  function ensureDelta() { if (!delta || deltaN !== field.n) { delta = new Float32Array(field.n * field.n); deltaN = field.n; } }
  function updateRows(r) {
    if (!r) return;
    const { n, cell, heights: h } = field, g = ground.geometry, P = g.getAttribute('position'), N = g.getAttribute('normal');
    const j0 = Math.max(0, r.j0 - 1), j1 = Math.min(n - 1, r.j1 + 1);
    for (let j = j0; j <= j1; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      P.array[k * 3 + 1] = h[k];
      const hx = (h[k + (i < n - 1 ? 1 : 0)] - h[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0) + (i < n - 1)));
      const hz = (h[k + (j < n - 1 ? n : 0)] - h[k - (j > 0 ? n : 0)]) / (cell * ((j > 0) + (j < n - 1)));
      const l = Math.hypot(hx, 1, hz);
      N.array[k * 3] = -hx / l; N.array[k * 3 + 1] = 1 / l; N.array[k * 3 + 2] = -hz / l;
    }
    for (const a of [P, N]) { a.addUpdateRange(j0 * n * 3, (j1 - j0 + 1) * n * 3); a.needsUpdate = true; }
  }
  function sculptAt(ev) {
    const p = groundAt(ev);
    U.brushOn.value = p ? 1 : 0;
    if (!p) return;
    // Shift jämnar ut med Smooths inställningar, vilken pensel som än är vald; Ctrl vänder höj och sänk
    const smoothing = ev.shiftKey && STAMPABLE.has(sculptTool), tool = smoothing ? 'smooth' : sculptTool, st = smoothing ? settingsFor('smooth') : S();
    U.brush.value.set(p.x, p.z, st.size);
    U.brushInner.value = tool === 'landform' ? 0 : st.size * (st.hardness ?? 0.25);
    if (!sculptDown || tool === 'ramp' || tool === 'landform') return;
    // Tryck med jämna mellanrum längs draget (Spacing, i delar av penseln), så att snabba drag blir jämna
    const gap = Math.max(field.cell * 0.5, st.size * (st.spacing ?? 0.2)), from = lastDab ?? p, len = Math.hypot(p.x - from.x, p.z - from.z);
    if (lastDab && len < gap) return;
    const steps = Math.max(1, Math.floor(len / gap)), dir = len > 1e-6 ? Math.atan2(p.z - from.z, p.x - from.x) : strokeDir;
    strokeDir = dir;
    const { n, cell, heights: h } = field, stamp = STAMPABLE.has(tool) && st.stamp !== 'round' ? stampFor(st.stamp) : null;
    let rows = null, x = from.x, z = from.z;
    for (let s = lastDab ? 1 : 0; s <= steps; s++) {
      x = from.x + Math.cos(dir) * gap * s; z = from.z + Math.sin(dir) * gap * s;
      if (!lastDab) { x = p.x; z = p.z; }
      let angle = (st.rotation ?? 0) * DEG + (st.follow ? dir : 0), radius = st.size;
      if (st.scatter && stamp) { angle += (Math.random() * 2 - 1) * Math.PI * st.scatter; radius *= 1 + (Math.random() * 2 - 1) * 0.35 * st.scatter; }
      const r = brushDab(h, delta, n, cell, half, x, z, {
        tool, radius, strength: st.strength, hardness: st.hardness, stamp, angle, invert: ev.ctrlKey || ev.metaKey,
        target: st.lock ? st.height : flattenY, stepHeight: st.stepHeight, seed: vals.seed,
      });
      if (r) rows = rows ? { j0: Math.min(rows.j0, r.j0), j1: Math.max(rows.j1, r.j1) } : r;
      if (!lastDab) break;
    }
    lastDab = { x, z };
    updateRows(rows);
  }
  // En landform där man klickar: hela formen på en gång, med ny variant varje klick om New each click är på
  function placeForm(p) {
    const L = info.sculptLandforms.find((x) => x.id === landformId), st = S();
    if (!L) return;
    pushUndo();
    ensureDelta();
    if (st.vary) st.seed = Math.floor(Math.random() * 1e6);
    saveSculptSet();
    const base = L.base === 'sea' ? (vals.sea ? vals.seaLevel : 0) : bedAt(p.x, p.z);
    updateRows(placeLandform(field.heights, delta, field.n, field.cell, half, p.x, p.z, createLandform(L.id, st.seed ?? 1), {
      radius: st.size, height: st.height, depth: L.negative ? st.height : Math.max(10, -SEABED), angle: (st.rotation ?? 0) * DEG, blend: L.blend, base, strength: st.strength ?? 1,
    }));
    mark(null);
    renderDrawer();
    regenerate('edit');
  }
  function sculptUp(ev) {
    if (!sculptDown) return;
    sculptDown = false;
    canvas.releasePointerCapture(ev.pointerId);
    if (sculptTool === 'ramp' && rampA) {
      const p = groundAt(ev);
      const st = S();
      if (p) updateRows(rampStroke(field.heights, delta, field.n, field.cell, half, rampA, { ...p, y: bedAt(p.x, p.z) }, { radius: st.size, strength: Math.max(0.5, st.strength), hardness: st.hardness }));
      rampA = null;
    }
    lastDab = null;
    mark(null);
    renderDrawer();
    regenerate('edit');
  }
  // Linjen som ritas (bäck, å eller vik): en tråd på marken genom punkterna, tills den grävs
  const lineGeo = new THREE.BufferGeometry(), lineMat = new THREE.LineBasicNodeMaterial({ color: '#ffffff', depthTest: false, transparent: true });
  const lineMesh = new THREE.Line(lineGeo, lineMat);
  lineMesh.renderOrder = 10;
  lineMesh.frustumCulled = false;
  scene.add(lineMesh);
  function showLine() {
    const pts = [];
    for (let k = 0; k < drawing.length; k++) {
      const a = drawing[k], b = drawing[k + 1] ?? a, m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, field?.cell ?? 1)));
      for (let s = 0; s < (k + 1 < drawing.length ? m : 1); s++) { const x = a[0] + ((b[0] - a[0]) * s) / m, z = a[1] + ((b[1] - a[1]) * s) / m; pts.push(x, bedAt(x, z) + 0.6, z); }
    }
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    lineMesh.visible = pts.length > 3;
  }
  function cancelLine() { drawing = []; if (lineMesh) showLine(); }
  function finishLine() {
    if (drawing.length >= 2 && info.channelKinds[sculptTool]) {
      pushUndo();
      vals.channels.push({ kind: sculptTool, points: drawing.map(([x, z]) => [x / sizeOf(), z / sizeOf()]) });
      mark(null);
      regenerate('edit');
    }
    cancelLine();
    renderDrawer();
    note.textContent = hint();
  }
  canvas.addEventListener('dblclick', () => { if (info.channelKinds[sculptTool]) finishLine(); });
  addEventListener('keydown', (ev) => {
    if (!running || (step !== 'sculpt' && step !== 'paint') || /input|select|textarea/i.test(ev.target?.tagName ?? '')) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (step === 'paint') undoPaint(); else undoLast(); }
    else if ((ev.key === '[' || ev.key === ']') && step === 'paint' && paintChoice) {
      const st = settingsFor('paint'), q = info.paintParams.find((x) => x.key === 'size');
      st.size = Math.round(Math.min(q.max, Math.max(q.min, st.size * (ev.key === ']' ? 1.15 : 1 / 1.15))));
      saveSculptSet(); ringSize(); cards.sync();
    }
    else if (ev.key === 'Escape' && step === 'paint') { paintChoice = null; setBrush(null); }
    else if (ev.key === 'Enter' && drawing.length) finishLine();
    else if ((ev.key === '[' || ev.key === ']') && sculptTool && !info.channelKinds[sculptTool]) {
      // Penselns storlek, 15 % per tryck inom spakens gränser
      const st = S(), q = (sculptTool === 'landform' ? info.landformParams : info.sculptParams).find((x) => x.key === 'size');
      st.size = Math.round(Math.min(q.max, Math.max(q.min, st.size * (ev.key === ']' ? 1.15 : 1 / 1.15))));
      saveSculptSet(); ringSize(); cards.sync();
    }
    else if (ev.key === 'Escape') { if (drawing.length) { cancelLine(); renderDrawer(); note.textContent = hint(); } else setTool(null); }
  });
  // --- Målningen: penseltryck i vikterna, som syns direkt (bara de rader som ändrats laddas upp) ---
  let paintDown = false, paintSlot = -1, paintLast = null;
  function paintAt(ev) {
    const p = groundAt(ev);
    U.brushOn.value = p ? 1 : 0;
    if (!p) return;
    const st = settingsFor('paint');
    U.brush.value.set(p.x, p.z, st.size);
    U.brushInner.value = st.size * (st.hardness ?? 0.25);
    if (!paintDown) return;
    const gap = Math.max(field.cell * 0.5, st.size * (st.spacing ?? 0.2)), from = paintLast ?? p, len = Math.hypot(p.x - from.x, p.z - from.z);
    if (paintLast && len < gap) return;
    const steps = Math.max(1, Math.floor(len / gap)), dir = len > 1e-6 ? Math.atan2(p.z - from.z, p.x - from.x) : strokeDir;
    strokeDir = dir;
    const stamp = st.stamp !== 'round' ? stampFor(st.stamp) : null, slot = ev.ctrlKey || ev.metaKey ? -1 : paintSlot;
    let rows = null, x = p.x, z = p.z;
    for (let s = paintLast ? 1 : 0; s <= steps; s++) {
      if (paintLast) { x = from.x + Math.cos(dir) * gap * s; z = from.z + Math.sin(dir) * gap * s; }
      let angle = (st.rotation ?? 0) * DEG + (st.follow ? dir : 0), radius = st.size;
      if (st.scatter && stamp) { angle += (Math.random() * 2 - 1) * Math.PI * st.scatter; radius *= 1 + (Math.random() * 2 - 1) * 0.35 * st.scatter; }
      const r = paintDab(groundW, field.n, field.cell, half, x, z, { slot, radius, strength: st.strength, hardness: st.hardness, stamp, angle, slope: [st.slopeMin ?? 0, st.slopeMax ?? 90], heights: field.heights });
      if (r) rows = rows ? { j0: Math.min(rows.j0, r.j0), j1: Math.max(rows.j1, r.j1) } : r;
      if (!paintLast) break;
    }
    paintLast = { x, z };
    applyGroundPaint(rows);
  }
  canvas.addEventListener('pointerdown', (ev) => {
    if (step === 'paint' && paintChoice && ev.button === 0 && field) {
      if (!groundAt(ev)) return;
      pushPaintUndo();
      paintSlot = paintChoice === 'erase' ? -1 : slotFor(paintChoice);
      if (paintSlot < 0 && paintChoice !== 'erase') { paintUndo.pop(); note.textContent = `All ${SLOTS} layers are in use: remove one under Painted in this world`; return; }
      paintDown = true; paintLast = null;
      canvas.setPointerCapture(ev.pointerId);
      paintAt(ev);
      return;
    }
    if (sculptTool && ev.button === 0 && field) {
      const p = groundAt(ev);
      if (!p) return;
      if (info.channelKinds[sculptTool]) {
        const last = drawing.at(-1);
        if (!last || Math.hypot(p.x - last[0], p.z - last[1]) > Math.max(1, field.cell * 2)) drawing.push([p.x, p.z]); // dubbelklicket lägger inte till en punkt till
        showLine();
        if (drawing.length === 1) renderDrawer();
        note.textContent = hint();
        return;
      }
      if (sculptTool === 'landform') { placeForm(p); return; }
      if (sculptTool === 'flatten' && ev.altKey) {
        // Alt+klick: pipetten tar höjden där man klickar, och Flatten jämnar sedan mot den
        Object.assign(S(), { lock: true, height: Math.round(bedAt(p.x, p.z) * 2) / 2 });
        saveSculptSet(); updateSculptCard();
        return;
      }
      pushUndo(); // före lagret skapas, så att det första draget ångras tillbaka till en orörd värld
      ensureDelta();
      sculptDown = true;
      canvas.setPointerCapture(ev.pointerId);
      flattenY = bedAt(p.x, p.z);
      if (sculptTool === 'ramp') rampA = { ...p, y: flattenY };
      lastDab = null;
      sculptAt(ev);
      return;
    }
    if (placing && ev.button === 0) {
      const p = groundAt(ev);
      if (!p) return;
      vals.regions[regionSel].at = [p.x / sizeOf(), p.z / sizeOf()];
      placing = false;
      setBrush(null);
      changedRegions();
      return;
    }
    if (!painting || ev.button !== 0) return;
    down = true; canvas.setPointerCapture(ev.pointerId); strokeAt(ev);
  });
  canvas.addEventListener('pointermove', (ev) => { if (painting) strokeAt(ev); else if (step === 'paint' && paintChoice) paintAt(ev); else if (sculptTool && !info.channelKinds[sculptTool]) sculptAt(ev); });
  canvas.addEventListener('pointerup', (ev) => {
    if (paintDown) {
      paintDown = false;
      canvas.releasePointerCapture(ev.pointerId);
      paintCov = paintCoverage(groundW, groundN);
      mark(null);
      renderDrawer();
      showStats();
      return;
    }
    sculptUp(ev);
    if (!down) return;
    down = false; canvas.releasePointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointerleave', () => { if (!down) U.brushOn.value = 0; });
  renderDrawer();
  cards.sync();
  apply();

  // --- Regionernas namn på kartan, vid mittpunkterna (i steget Regions) ---
  const labelBox = el('div', 'rlabels');
  view.append(labelBox);
  function placeLabels() {
    labelBox.hidden = step !== 'regions';
    if (labelBox.hidden || !regionInfo) return;
    while (labelBox.children.length > vals.regions.length) labelBox.lastChild.remove();
    vals.regions.forEach((r, i) => {
      let d = labelBox.children[i];
      if (!d) { d = el('div', 'rlabel'); d.append(el('span'), el('small')); labelBox.append(d); }
      d.firstChild.textContent = r.name;
      d.lastChild.textContent = info.regionThemes[r.theme]?.label ?? '';
      d.style.setProperty('--rc', regionColor(i));
      d.classList.toggle('on', i === regionSel);
      d.dataset.x = regionInfo.centers?.[i]?.[0] ?? 0;
      d.dataset.z = regionInfo.centers?.[i]?.[1] ?? 0;
    });
    moveLabels();
  }
  const lv = new THREE.Vector3();
  function moveLabels() {
    if (labelBox.hidden) return;
    const r = renderer.domElement.getBoundingClientRect();
    for (const d of labelBox.children) {
      const x = Number(d.dataset.x), z = Number(d.dataset.z);
      lv.set(x, bedAt(x, z) + sizeOf() * 0.01 + 2, z).project(camera);
      d.hidden = lv.z > 1;
      d.style.left = `${r.left + ((lv.x + 1) / 2) * r.width}px`;
      d.style.top = `${r.top + ((1 - lv.y) / 2) * r.height}px`;
    }
  }

  // --- Footern ---
  const fLand = el('div', 'block'), fRegions = el('div', 'block'), fBiomes = el('div', 'block'), fNature = el('div', 'block'), fStats = el('div', 'block'), note = el('div', 'msg');
  footer.append(fLand, fRegions, fBiomes, fNature, fStats, note);
  const block = (b, title, text) => { b.replaceChildren(el('b', null, title), el('div', 'vals', text)); };
  const clock = (hh) => `${String(Math.floor(hh)).padStart(2, '0')}:${String(Math.round((hh % 1) * 60) % 60).padStart(2, '0')}`;
  function showStats() {
    const nPaint = vals.paintLayers.filter(Boolean).length;
    const shaped = (delta || vals.channels.length ? ` · shaped${vals.channels.length ? `, ${vals.channels.length} dug` : ''} (${stats.editMs ?? 0} ms)` : '') + (nPaint ? ` · ${nPaint} painted` : '');
    block(fLand, 'World', `${sizeLabel[vals.worldSize] ?? vals.worldSize} square · top ${stats.top} m${vals.sea ? ` · ${stats.land} % above the sea` : ''} · built in ${stats.ms} ms${shaped}`);
    const top = Object.entries(stats.coverage ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4); // andelar av landet
    block(fBiomes, 'Biomes', `${top.map(([id, v]) => `${info.biomes.find((x) => x.id === id)?.label ?? id} ${v} %`).join(' · ')} · ${stats.biomeMs} ms`);
    block(fRegions, 'Regions', vals.regions.map((r, i) => `${r.name} ${regionInfo?.coverage?.[i] ?? 0} %`).join(' · '));
    fNature.hidden = !popResult || step !== 'populate';
    if (popResult) {
      const kind = (k) => popResult.layers.filter((l) => l.kind === k).reduce((a, l) => a + l.count, 0);
      block(fNature, 'Nature', `${popResult.total.toLocaleString('en')} placed · ${kind('tree')} trees · ${kind('bush')} bushes · ${kind('rock')} rocks · ${(kind('plant') + kind('prop')).toLocaleString('en')} plants and props · ${popResult.ms} ms`);
    }
    if (step === 'regions') for (const b of body.querySelectorAll('.wprof[data-pick]')) { const i = Number(b.dataset.pick), m = b.querySelectorAll('.wmeta'); if (i >= 0 && m.length) m[m.length - 1].textContent = `${info.regionThemes[vals.regions[i]?.theme]?.label ?? ''} · ${regionInfo?.coverage?.[i] ?? 0} % of the land`; }
    if (step === 'biomes') for (const b of body.querySelectorAll('.wprof[data-biome]')) { const m = b.querySelectorAll('.wmeta'); const v = stats.coverage?.[b.dataset.biome]; if (v != null && m.length) m[m.length - 1].textContent = `${v} % of the land`; }
  }
  note.textContent = 'Drag to orbit, scroll to zoom';
  await regenerate();

  // --- Rendering ---
  let last = performance.now(), frames = 0, fpsT = last, fps = 0, time = 0;
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', () => { if (running) resize(); });
  const gate = frameGate();
  function tick(dt) {
    time += dt;
    water.update(time);
    wind.update(dt);
    if (grassField && grassRoot.visible) grassField.update(camera);
    if (splash.has('grass') && grassField) { const p = grassRoot.visible ? grassField.progress : 1; splash.set('grass', p, p >= 1 ? `${Math.round(grassField.blades / 1000)}k blades` : null); }
    riverWater?.update(time);
    controls.update();
    moveLabels();
    if (nature && step === 'populate' && time - natureT > 0.2) { natureT = time; nature.update(camera.position, vals.populate.detail); }
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
      const ns = nature && step === 'populate' ? nature.stats : null;
      block(fStats, 'View', `${Math.round((stats.triangles + (ns?.triangles ?? 0)) / 1000)}k triangles · ${fps} fps · ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'} · ${clock(vals.hour)}${ns ? ` · near ${ns.near}, mid ${ns.mid}, far ${ns.proxy}` : ''}${grassField && grassRoot.visible && grassField.group.visible ? ` · ${Math.round(grassField.visibleBlades() / 1000)}k blades` : ''}`);
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
    get regionPaint() { return regionPaint; }, get regionInfo() { return regionInfo; }, get regionSel() { return regionSel; },
    get delta() { return delta; }, get channelInfo() { return channelInfo; }, get field() { return field; }, get sculptTool() { return sculptTool; }, setTool,
    sculptSettings: () => S(),
    get groundW() { return groundW; }, get paintCov() { return paintCov; }, get paintChoice() { return paintChoice; },
    get popResult() { return popResult; }, natureStats: () => nature?.stats ?? null,
    grassAt, splashLog: () => splash.log, grassStats: () => (grassField ? { blades: grassField.blades, drawn: grassField.visibleBlades(), shown: grassRoot.visible && grassField.group.visible } : null), get fps() { return fps; }, runPopulate,
    // Var en punkt i världen hamnar i fönstret (för UI-testerna): [x, y] i bildpunkter
    screenOf(x, z) { const v = new THREE.Vector3(x, bedAt(x, z), z).project(camera), r = renderer.domElement.getBoundingClientRect(); return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height]; },
    stats: () => ({ ...stats, fps, backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl' }),
  };
}
function stripLabel(p) { const { label: _l, ...rest } = p; return rest; }
