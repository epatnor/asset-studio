// Väderkvarnen, fliken Vind (docs/effektlabb.md, E1): gläntan där vinden provas. Riggade träd, buskar och blommor från
// generatorerna (byggda av studioservern, /api/wind/glade), en gräsplätt och en flagga, alla drivna av samma vindfält
// (shared/effects/wind.js). Spakarna och profilerna är data i tools/wind/wind.json; sparade profiler i assets/wind/.
// Egen renderare (WebGPU, WebGL2 som reserv), som texturverkstadens labb har sin egen. Texten i appen är på engelska.
import * as THREE from 'three/webgpu';
import { attribute, vertexColor, float, fract, mix, color } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWind, rigTexture } from '../shared/effects/wind.js';
import { createGrass, colorTexture, groundSampler } from '../shared/effects/grass.js';
import { gpuPreference } from './gpu.js';
import { createCloth } from '../shared/effects/cloth.js';

const LEAFY = /^(Leaves|LeafMass|Fronds|leaf|petal|blade|grass|frond)/i;
const DEG = Math.PI / 180;

export async function createWindmill({ api, el, view, side, drawer, footer }) {
  const info = await api('/api/wind');
  const P = Object.fromEntries(info.params.map((q) => [q.key, q]));
  const wind = createWind(Object.fromEntries(info.params.map((q) => [q.key, q.key === 'dir' ? q.default * DEG : q.default])));

  // --- Scenen: himmel, sol, mark ---
  // WebGPU bara på ett riktigt grafikkort: en mjukvarulösning (SwiftShader, när Vulkan inte startar) ritar på
  // processorn och är mycket långsammare än WebGL2, så då används WebGL2 i stället
  const pref = gpuPreference() === 'default' ? undefined : gpuPreference();
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: pref }).catch(() => null) : null;
  const software = !adapter || adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter || /swiftshader|llvmpipe/i.test(`${adapter.info?.architecture} ${adapter.info?.description}`);
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: pref, forceWebGL: software });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  view.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9cc6f0');
  scene.fog = new THREE.Fog('#d9ecff', 45, 140);
  scene.add(new THREE.HemisphereLight('#cfe6ff', '#5d7a3a', 1.1));
  const sun = new THREE.DirectionalLight('#ffe9c7', 3.0);
  sun.position.set(18, 30, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 80 });
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardNodeMaterial({ color: '#557f2a', roughness: 1 })); // som gräset på avstånd
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  camera.position.set(1, 8.5, 26);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2.2, -2);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  // --- Gläntan: riggade modeller, där varje material får vindens position ---
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const rigged = []; // { mesh, normal, debug } för felsökningsvyn
  const pivots = [];
  const partColor = (n) => { const h = fract(n.mul(0.61803)); return mix(color('#e0533d'), color('#3d8be0'), h).mul(float(0.55).add(fract(n.mul(0.37)).mul(0.6))); };
  function windMaterial(src, tex, stem, place = false, response = 'tree') {
    const m = new THREE.MeshStandardNodeMaterial();
    for (const k of ['name', 'color', 'map', 'roughness', 'metalness', 'alphaTest', 'transparent', 'side', 'vertexColors', 'normalMap', 'emissive']) if (src[k] !== undefined) m[k] = src[k];
    m.positionNode = wind.rigged(tex, { flutter: LEAFY.test(src.name), stem, place, response });
    if (place) m.normalNode = wind.placedNormal();
    if (src.userData?.shadowProxy) { m.colorWrite = false; m.depthWrite = false; }
    const d = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: src.side, alphaTest: src.alphaTest, map: src.map });
    d.colorNode = partColor(attribute('_part', 'float'));
    d.positionNode = m.positionNode;
    if (place) d.normalNode = m.normalNode;
    if (src.userData?.shadowProxy) { d.colorWrite = false; d.depthWrite = false; }
    return [m, d];
  }
  const tableOf = (o) => { for (let p = o; p; p = p.parent) if (p.userData?.wind) return p.userData.wind; return null; };
  // Vilken svarskurva (RESPONSE i wind.js) en modell har: växtgeneratorns växter, buskar eller träd
  function responseOf(root) {
    let info = null;
    root.traverse((o) => { if (o.userData?.generator) info ??= o.userData; });
    if (String(info?.generator ?? '').startsWith('tinkertown/plant')) return 'plant';
    // Buskar: arten bush, eller allt från trädgeneratorn som är lägre än 2,5 m (kortbuskar heter lövträd i receptet)
    if (info?.recipe?.kind === 'bush') return 'bush';
    return new THREE.Box3().setFromObject(root).max.y < 2.5 ? 'bush' : 'tree';
  }
  let stats = { models: 0, parts: 0, failed: [] };
  async function loadGlade() {
    setNote('Building the glade with the generators… (the first time takes a little while)');
    const g = await api('/api/wind/glade');
    for (const it of g.items) {
      const root = (await loader.loadAsync(it.url)).scene;
      root.position.set(...it.pos);
      root.rotation.y = (it.rot ?? 0) * DEG;
      const texes = new Map(), response = responseOf(root);
      root.traverse((o) => {
        if (/_LOD[12]$/.test(o.name)) o.visible = false; // gläntan visar LOD0
        if (!o.isMesh) return;
        const src = o.material;
        o.castShadow = src.userData?.castShadow !== false;
        o.receiveShadow = src.userData?.receiveShadow !== false && !src.userData?.shadowProxy;
        const w = it.rigged && tableOf(o);
        if (!w || !o.geometry.attributes._part) return;
        if (!texes.has(w)) { texes.set(w, rigTexture(w)); stats.parts += w.count; addPivots(w, root); }
        const [m, d] = windMaterial(src, texes.get(w), !!o.geometry.attributes._stem, false, response);
        o.material = m;
        rigged.push({ mesh: o, normal: m, debug: d });
      });
      scene.add(root);
      stats.models += it.rigged ? 1 : 0;
      for (const c of [...(Object.entries(it.checks ?? {}))].filter(([k, v]) => /^rig_(torn|still_moves|ground_moves)$/.test(k) && v)) stats.failed.push(`${it.id}: ${c[0]} ${c[1]}`);
    }
    stats.failed.push(...g.errors);
    addGrass(g.grass, g.items, g.flag);
    scatter();
    await addFlag(g.flag);
    applyDebug();
    setNote(stats.failed.length ? `Glade built, with problems: ${stats.failed.join('; ')}` : '');
  }

  // Fästena (felsökningsvyn): en liten kula per del, i vila
  const pivotMat = new THREE.MeshBasicNodeMaterial({ color: '#ffd84a', depthTest: false, transparent: true });
  const pivotGroup = new THREE.Group();
  pivotGroup.renderOrder = 10;
  scene.add(pivotGroup);
  function addPivots(w, root) {
    root.updateMatrixWorld(true);
    const geo = new THREE.OctahedronGeometry(0.05);
    const im = new THREE.InstancedMesh(geo, pivotMat, w.count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < w.count; i++) {
      const p = new THREE.Vector3(w.parts[i * 12], w.parts[i * 12 + 1], w.parts[i * 12 + 2]).applyMatrix4(root.matrixWorld);
      im.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
    }
    pivots.push(im);
    pivotGroup.add(im);
  }

  // --- Gräset: ett recept (tools/grass/grass.json, shared/effects/grass.js) i samma vind; inget gräs där träd, buskar
  // och stenar står, och kortare gräs runt blommorna ---
  const G = await api('/api/grass');
  const grassVals = Object.fromEntries(G.params.map((q) => [q.key, q.default]));
  let grass = null, baseExclude = [];
  function addGrass(o, items, flag) {
    if (!o) return;
    baseExclude = items.filter((it) => it.clear).map((it) => ({ x: it.pos[0], z: it.pos[2], r: it.clear }));
    for (const it of items.filter((x) => x.short)) baseExclude.push({ x: it.pos[0], z: it.pos[2], r: 0.6, h: it.short });
    if (flag) baseExclude.push({ x: flag.pos[0], z: flag.pos[2], r: 0.2 });
    grass = createGrass(wind, { ...o, exclude: baseExclude }, grassVals);
    grass.uniforms.sun.value.copy(sun.position).normalize();
    scene.add(grass.group);
    // Marken ritar samma textur som rötterna läser, i samma skala
    ground.material.colorNode = grass.groundNode;
    ground.material.needsUpdate = true;
    setGround(grassVals.ground);
  }
  // Marktexturen (Ground): samma textur för marken och för grässtrånas rötter; 'none' = markens enfärg
  const groundList = await api('/api/textures?kind=ground').catch(() => []);
  const groundCache = new Map(), texLoader = new THREE.TextureLoader();
  async function setGround(name) {
    if (!groundCache.has(name)) groundCache.set(name, name === 'none' ? Promise.resolve(colorTexture('#557f2a')) : texLoader.loadAsync(`/assets/textures/${name}.png`).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      return groundSampler(t);
    }));
    const tex = await groundCache.get(name).catch(() => null);
    if (tex && grassVals.ground === name) grass?.setGroundTexture(tex);
  }
  const setGrass = (k, v) => { grassVals[k] = v; if (k === 'ground') setGround(v); else grass?.set({ [k]: v }); };

  // --- Blomklungor: växter från växtgeneratorn (riggade, i samma vind), slumpade i klungor över ängen. Varje art
  // byggs i några frön av servern (/api/wind/plant) och klonas; klonerna delar geometri och material ---
  const TAU = Math.PI * 2;
  const rng = (seed) => { let x = seed >>> 0; return () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const flowerVals = { plants: [...G.flowers.default.plants], ...Object.fromEntries(G.flowers.params.map((q) => [q.key, q.default])) };
  const flowerGroup = new THREE.Group();
  scene.add(flowerGroup);
  let flowerRigged = [];
  // Varje art och frö byggs en gång; dess delar (LOD0) ritas sedan instansierat, en ritning per del för alla exemplar
  const plantCache = new Map();
  function plantTemplate(preset, seed) {
    const key = `${preset}_${seed}`;
    if (!plantCache.has(key)) plantCache.set(key, (async () => {
      const r = await api(`/api/wind/plant?preset=${preset}&seed=${seed}`);
      if (r.error) throw new Error(r.error);
      const root = (await loader.loadAsync(r.url)).scene;
      const parts = [], texes = new Map();
      root.traverse((o) => {
        if (!o.isMesh || /_LOD[12]$/.test(o.parent?.name ?? '') || !o.geometry.attributes._part) return;
        const w = tableOf(o);
        if (!w) return;
        if (!texes.has(w)) texes.set(w, rigTexture(w));
        const [m, d] = windMaterial(o.material, texes.get(w), !!o.geometry.attributes._stem, true, 'plant');
        parts.push({ geometry: o.geometry, normal: m, debug: d });
      });
      return parts;
    })());
    return plantCache.get(key);
  }
  let scatterToken = 0, scatterTimer = 0;
  const scatterSoon = () => { clearTimeout(scatterTimer); scatterTimer = setTimeout(scatter, 250); };
  async function scatter() {
    const token = ++scatterToken, fv = flowerVals, kinds = fv.plants;
    const r = rng(fv.seed * 7919 + 13), pick = () => kinds[Math.floor(r() * kinds.length)];
    const clumps = [];
    for (let tries = 0; kinds.length && clumps.length < fv.clumps && tries < 600; tries++) {
      const a = r() * TAU, d = Math.sqrt(r()) * fv.area, x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (baseExclude.some((e) => !(e.h > 0) && (x - e.x) ** 2 + (z - e.z) ** 2 < (e.r + fv.spread * 0.6) ** 2)) continue;
      clumps.push({ x, z, kind: pick() });
    }
    // Tätast i klungans mitt (ungefär normalfördelat), en art per klunga utom där mixed slår in
    const plants = [];
    for (const c of clumps) for (let k = 0; k < fv.perClump; k++) {
      const a = r() * TAU, d = fv.spread * Math.min(1.6, Math.sqrt(-2 * Math.log(1 - r() * 0.98)) * 0.5);
      plants.push({ x: c.x + Math.cos(a) * d, z: c.z + Math.sin(a) * d, kind: r() < fv.mixed ? pick() : c.kind,
        seed: Math.floor(r() * G.flowers.seeds), yaw: r() * TAU, s: (fv.size ?? 1) * (0.85 + r() * 0.3) });
    }
    const keys = [...new Set(plants.map((p) => `${p.kind}|${p.seed}`))];
    if (keys.some((k) => !plantCache.has(k.replace('|', '_')))) setNote('Growing the plants with the plant generator…');
    const templates = new Map();
    for (const k of keys) {
      const [kind, seed] = k.split('|');
      templates.set(k, await plantTemplate(kind, Number(seed)).catch((e) => { setNote(`${kind}: ${e.message}`); return null; }));
      if (token !== scatterToken) return; // en nyare utslumpning har börjat
    }
    // (geometrierna kastas inte: de delar attribut med växtens mall, som används igen nästa gång)
    flowerGroup.clear();
    flowerRigged = [];
    for (const k of keys) {
      const parts = templates.get(k), mine = plants.filter((p) => `${p.kind}|${p.seed}` === k);
      if (!parts || !mine.length) continue;
      const place = new THREE.InstancedBufferAttribute(new Float32Array(mine.flatMap((p) => [p.x, p.z, p.yaw, p.s])), 4);
      const sphere = new THREE.Sphere(new THREE.Vector3(), 0).setFromPoints(mine.map((p) => new THREE.Vector3(p.x, 0.4, p.z)));
      sphere.radius += 1.5;
      for (const part of parts) {
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = part.geometry.index;
        for (const [name, attr] of Object.entries(part.geometry.attributes)) geo.setAttribute(name, attr);
        geo.setAttribute('iPlace', place);
        geo.instanceCount = mine.length;
        geo.boundingSphere = sphere;
        const mesh = new THREE.Mesh(geo, debug ? part.debug : part.normal);
        mesh.receiveShadow = true; mesh.castShadow = false; // små växter: skuggan syns knappt och kostar ett pass till
        flowerGroup.add(mesh);
        flowerRigged.push({ mesh, normal: part.normal, debug: part.debug });
      }
    }
    grass?.setExclude([...baseExclude, ...clumps.map((c) => ({ x: c.x, z: c.z, r: fv.spread + 0.4, h: 0.35 }))]);
    stats.flowers = plants.length;
    applyDebug();
    setNote('');
  }

  // --- Flaggan: stång och duk. Duken är ett simulerat tyg (shared/effects/cloth.js, implicit efter Baraff och Witkin)
  // med fäst stångkant, tyngd och vinden ur samma vindfält; texturen har alfa (målad av GPT Image 2, fransarna
  // genomskinliga). Klicka och dra i flaggan för att dra i tyget. ---
  let cloth = null, clothGeo = null, flagMesh = null;
  // Vinden vid tyget: vindfältet (svarar som en blomma) plus turbulens som växer med farten, så att tyget fladdrar
  function clothWind(x, y, z) {
    const v = wind.velocityAt(x, z, 'plant'), sp = Math.hypot(v[0], v[2]), t = wind.state.time;
    const px = -Math.sin(wind.state.dir), pz = Math.cos(wind.state.dir);
    const lat = sp * 0.16 * Math.sin(t * (2.2 + sp * 0.35) + x * 2.3 + y * 1.7) + sp * 0.06 * Math.sin(t * 7.1 + x * 5.3 - y * 2.9);
    const up = sp * 0.05 * Math.sin(t * 3.3 + x * 3.1 + z * 2.2);
    return [v[0] + px * lat, up, v[2] + pz * lat];
  }
  async function addFlag(o) {
    if (!o) return;
    const grp = new THREE.Group();
    grp.position.set(...o.pos);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, o.pole, 10), new THREE.MeshStandardNodeMaterial({ color: '#d8d2c4', roughness: 0.6 }));
    pole.position.y = o.pole / 2;
    pole.castShadow = true;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshStandardNodeMaterial({ color: '#d9b440', roughness: 0.35, metalness: 0.6 }));
    knob.position.y = o.pole + 0.04;
    grp.add(pole, knob);
    scene.add(grp);
    const tex = o.texture ? await texLoader.loadAsync(`/assets/textures/${o.texture}.png`).catch(() => null) : null;
    if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; }
    // Duken i flaggans proportioner (bildens, med fransarna), överkanten vid stångens topp; i världens koordinater
    const L = o.length, H = tex ? (L * tex.image.height) / tex.image.width : o.height;
    cloth = createCloth({ width: L, height: H, anchor: [o.pos[0] + 0.05, o.pole - 0.06, o.pos[2]], dir: [Math.cos(wind.state.dir), Math.sin(wind.state.dir)] });
    clothGeo = new THREE.BufferGeometry();
    clothGeo.setAttribute('position', new THREE.BufferAttribute(cloth.positions, 3).setUsage(THREE.DynamicDrawUsage));
    clothGeo.setAttribute('normal', new THREE.BufferAttribute(cloth.normals, 3).setUsage(THREE.DynamicDrawUsage));
    clothGeo.setAttribute('uv', new THREE.BufferAttribute(cloth.uvs, 2));
    clothGeo.setIndex(cloth.indices);
    const fm = new THREE.MeshStandardNodeMaterial({ color: tex ? '#ffffff' : '#c0412e', map: tex, alphaTest: tex ? 0.5 : 0, roughness: 0.82, side: THREE.DoubleSide });
    flagMesh = new THREE.Mesh(clothGeo, fm);
    flagMesh.castShadow = true;
    flagMesh.frustumCulled = false;
    scene.add(flagMesh);
    // Låt tyget falla på plats innan första bilden
    for (let i = 0; i < 90; i++) cloth.step(1 / 60, clothWind);
    updateCloth();
  }
  function updateCloth() {
    if (!cloth) return;
    clothGeo.attributes.position.needsUpdate = true;
    clothGeo.attributes.normal.needsUpdate = true;
    clothGeo.computeBoundingSphere();
  }
  // Dra i tyget: klicka på flaggan, dra i bildens plan; kameran rör sig inte under tiden
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), dragPlane = new THREE.Plane(), hitP = new THREE.Vector3();
  let dragIdx = -1;
  const pointerRay = (e) => { const r = renderer.domElement.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); };
  view.addEventListener('pointerdown', (e) => {
    if (!flagMesh || e.button !== 0) return;
    pointerRay(e);
    const hit = ray.intersectObject(flagMesh)[0];
    if (!hit) return;
    dragIdx = cloth.nearest(hit.point.toArray());
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point);
    cloth.grab(dragIdx, hit.point.toArray());
    controls.enabled = false;
    renderer.domElement.setPointerCapture?.(e.pointerId);
    e.stopPropagation();
  }, { capture: true });
  view.addEventListener('pointermove', (e) => {
    if (dragIdx < 0) return;
    pointerRay(e);
    if (ray.ray.intersectPlane(dragPlane, hitP)) cloth.grab(dragIdx, hitP.toArray());
  });
  addEventListener('pointerup', () => {
    if (dragIdx < 0) return;
    cloth.grab(dragIdx, null);
    dragIdx = -1;
    controls.enabled = true;
  });

  // --- Vindpilen över gräset: pekar dit det blåser, längre och mer opak ju starkare ---
  const arrowShape = new THREE.Shape([[0, -0.18], [1.4, -0.18], [1.4, -0.45], [2.2, 0], [1.4, 0.45], [1.4, 0.18], [0, 0.18]].map(([x, y]) => new THREE.Vector2(x, y)));
  const arrowMat = new THREE.MeshBasicNodeMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false });
  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), arrowMat);
  arrow.rotation.x = -Math.PI / 2;
  const arrowPivot = new THREE.Group();
  arrowPivot.position.set(-1.2, 0.75, 8.5); // svävar över gräset
  arrowPivot.add(arrow);
  scene.add(arrowPivot);
  function updateArrow() {
    const s = wind.state;
    arrowPivot.rotation.y = -s.dir;
    const f = wind.forceAt(arrowPivot.position.x, arrowPivot.position.z);
    arrow.scale.setScalar(0.6 + 0.9 * Math.min(1.5, s.strength));
    arrowMat.opacity = 0.35 + 0.6 * Math.min(1, f + 0.15);
  }

  // --- Felsökningsvyn: färg per del och fästena ---
  let debug = false;
  function applyDebug() {
    for (const r of [...rigged, ...flowerRigged]) r.mesh.material = debug ? r.debug : r.normal;
    pivotGroup.visible = debug;
  }

  // --- Spakar (kort till höger, fälls ihop med ett klick på rubriken) ---
  const syncs = [];
  const valueFor = (k) => (k === 'dir' ? Math.round(((wind.state.dir / DEG) % 360 + 360) % 360) : wind.state[k]);
  const setParam = (k, v) => wind.set({ [k]: k === 'dir' ? v * DEG : v });
  function card(title, accent, { closed = false, help } = {}) {
    const c = el('section', `card glass${closed ? ' closed' : ''}`);
    c.style.setProperty('--part', accent);
    const head = el('header'), body = el('div', 'rows');
    head.append(el('h2', null, title));
    if (help) head.title = help;
    head.onclick = () => c.classList.toggle('closed');
    c.append(head, body);
    side.append(c);
    return body;
  }
  // En spak: get och set läser och skriver värdet, changed körs efter varje ändring
  function slider(q, get, set, changed) {
    const row = el('div', 'row'), r = el('input'), out = el('output');
    if (q.help) row.title = q.help;
    Object.assign(r, { type: 'range', min: q.min, max: q.max, step: q.step });
    const dec = q.step >= 1 ? 0 : q.step >= 0.1 ? 1 : q.step >= 0.01 ? 2 : 3;
    syncs.push(() => { r.value = get(q.key); out.textContent = Number(r.value).toFixed(dec); });
    // Spakar som bygger om (rebuild) gör det när man släpper, de andra medan man drar
    const apply = () => { set(q.key, Number(r.value)); out.textContent = Number(r.value).toFixed(dec); changed?.(); };
    if (q.rebuild) { r.oninput = () => { out.textContent = Number(r.value).toFixed(dec); }; r.onchange = apply; } else r.oninput = apply;
    row.append(el('label', null, q.label), r, out);
    return row;
  }
  // Marktexturen: små tumnaglar att klicka på, plus None
  function textureRow(q, get, set, changed) {
    const row = el('div', 'row span2 texpick'), grid = el('div', 'gtex');
    if (q.help) row.title = q.help;
    const opts = [{ name: 'none', thumb: null }, ...groundList];
    const btns = opts.map((t) => {
      const b = el('button', 'gtile');
      b.title = t.name === 'none' ? 'None: a plain ground colour' : t.name;
      if (t.thumb) b.append(Object.assign(el('img'), { src: t.thumb, alt: '', loading: 'lazy' }));
      else b.append(el('span', null, 'None'));
      b.append(el('small', null, t.name.replace(/^(ground_|surface_)/, '')));
      b.onclick = () => { set(q.key, t.name); sync(); changed?.(); };
      grid.append(b);
      return [t.name, b];
    });
    const sync = () => { for (const [n, b] of btns) b.classList.toggle('on', n === get(q.key)); };
    syncs.push(sync);
    row.append(el('label', null, q.label), grid);
    return row;
  }
  // Av och på (iOS-reglage); hjälptexten står under etiketten
  function toggleRow(q, get, set, changed) {
    const row = el('div', 'row span2'), box = el('input', 'switch'), lab = el('label', 'twoline');
    box.type = 'checkbox';
    lab.append(document.createTextNode(q.label), el('small', null, q.key === 'rootFromGround' ? 'Follow ground texture color' : ''));
    if (q.help) row.title = q.help;
    syncs.push(() => { box.checked = !!get(q.key); });
    box.onchange = () => { set(q.key, box.checked); changed?.(); };
    row.append(lab, box);
    return row;
  }
  function colorRow(q, get, set, changed) {
    const row = el('div', 'row span2'), c = el('input');
    c.type = 'color';
    if (q.help) row.title = q.help;
    syncs.push(() => { c.value = get(q.key); });
    c.oninput = () => { set(q.key, c.value); changed?.(q); };
    if (q.reset) {
      // Återställ (till ingen ändring)
      const wrap = el('div', 'colreset'), b = el('button', 'icon', '↺');
      b.title = 'Reset (no change)';
      b.onclick = () => { set(q.key, q.default); c.value = q.default; changed?.(q); };
      wrap.append(c, b);
      row.append(el('label', null, q.label), wrap);
    } else row.append(el('label', null, q.label), c);
    return row;
  }
  const windCard = card('Wind', '#4a90d9');
  for (const q of info.params.filter((x) => !x.view)) windCard.append(slider(q, valueFor, setParam, () => markProfile(null)));

  // Gräset: ett kort per grupp i grass.json
  const grassGet = (k) => grassVals[k];
  // Drar man själv i Root slutar rötterna följa marken (reglaget Follow ground texture color slås av)
  const grassChanged = (q) => {
    markGrass(null);
    if (q?.key === 'base' && grassVals.rootFromGround) { setGrass('rootFromGround', false); for (const s of syncs) s(); }
  };
  for (const g of G.groups) {
    const body = card(g.label, '#5aa43c', { closed: !['waves', 'ground', 'color'].includes(g.id) });
    const rowFor = { color: colorRow, texture: textureRow, bool: toggleRow };
    for (const q of G.params.filter((x) => x.group === g.id)) body.append((rowFor[q.type] ?? slider)(q, grassGet, setGrass, grassChanged));
  }

  // Blomklungorna: vilka växter, och hur de slumpas ut
  const flCard = card('Flowers', '#d9a03a', { help: 'Scatter clumps of flowers and grasses over the meadow; they sway in the same wind' });
  const chips = el('div', 'chips flowerchips');
  for (const pl of G.flowers.plants) {
    const c = el('button', 'chip', pl.label);
    syncs.push(() => c.classList.toggle('on', flowerVals.plants.includes(pl.preset)));
    c.onclick = () => {
      flowerVals.plants = flowerVals.plants.includes(pl.preset) ? flowerVals.plants.filter((x) => x !== pl.preset) : [...flowerVals.plants, pl.preset];
      c.classList.toggle('on', flowerVals.plants.includes(pl.preset));
      markGrass(null); scatterSoon();
    };
    chips.append(c);
  }
  flCard.append(chips);
  const flowerGet = (k) => flowerVals[k], flowerSet = (k, v) => { flowerVals[k] = v; };
  for (const q of G.flowers.params) flCard.append(slider(q, flowerGet, flowerSet, () => { markGrass(null); scatterSoon(); }));
  const reroll = el('button', null, 'New scatter');
  reroll.title = 'A new seed: the same settings, scattered differently';
  reroll.onclick = () => { flowerVals.seed = Math.floor(Math.random() * 9999); for (const s of syncs) s(); scatterSoon(); };
  flCard.append(reroll);

  const viewCard = card('View', '#7c8a99');
  for (const q of info.params.filter((x) => x.view)) viewCard.append(slider(q, valueFor, setParam));
  const sw = (label, help, onchange) => {
    const row = el('div', 'row span2'), box = el('input', 'switch');
    box.type = 'checkbox';
    box.onchange = () => onchange(box.checked);
    row.title = help;
    row.append(el('label', null, label), box);
    viewCard.append(row);
    return box;
  };
  sw('Show parts', 'Colour every part of the rig and show the pivots (yellow) it bends around', (v) => { debug = v; applyDebug(); });
  sw('Pause', 'Stop the time (the wind keeps its shape)', (v) => { paused = v; });

  const saveCard = card('Save', '#4a90d9');
  const saveMsg = el('div', 'note');
  async function saveAs(kind) {
    const isWind = kind === 'wind';
    const name = prompt(`Name of the ${isWind ? 'wind profile' : 'grass'} (a–z, 0–9 and _):`, (isWind ? currentProfile : currentGrass) ?? (isWind ? 'my_wind' : 'my_meadow'));
    if (!name) return;
    const payload = isWind
      ? { name, profile: Object.fromEntries(info.params.filter((q) => !q.view).map((q) => [q.key, valueFor(q.key)])) }
      : { name, settings: { ...grassVals }, flowers: { ...flowerVals } };
    const url = isWind ? '/api/wind/save' : '/api/grass/save';
    let r = await api(url, payload);
    if (r.exists && confirm(`${name} already exists. Overwrite?`)) r = await api(url, { ...payload, overwrite: true });
    saveMsg.textContent = r.error ? `Not saved: ${r.error}` : r.file ? `Saved: ${r.file}` : '';
    if (!r.entry) return;
    const list = isWind ? info : G;
    list.saved = [r.entry, ...list.saved.filter((x) => x.name !== r.entry.name)];
    if (isWind) currentProfile = r.entry.name; else currentGrass = r.entry.name;
    renderDrawer();
  }
  const saveWind = el('button', 'primary', 'Save wind profile…');
  saveWind.title = 'Saves the wind sliders as a recipe in assets/wind/, for the studio, the showcase and Tinkertown';
  saveWind.onclick = () => saveAs('wind');
  const saveGrass = el('button', null, 'Save grass…');
  saveGrass.title = 'Saves the grass and the flower clumps as a recipe in assets/grass/';
  saveGrass.onclick = () => saveAs('grass');
  saveCard.append(saveWind, saveGrass, saveMsg);

  // --- Lådan: vindprofiler och gräs, färdiga och sparade ---
  let currentProfile = null, currentGrass = 'meadow';
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  head.append(el('h2', null, 'Windmill drawer'), el('div', 'note', 'Click a wind profile or a grass to use it. Save your own in the Save card.'));
  drawer.append(head, body);
  function profileTile(id, label, prof) {
    const f = el('button', `wprof${currentProfile === id ? ' on' : ''}`);
    f.dataset.id = `wind:${id}`;
    const bar = el('span', 'wbar2');
    bar.style.setProperty('--s', Math.min(1, (prof.strength ?? 0) / 1.5));
    f.append(el('b', null, label), bar, el('span', 'wmeta', `strength ${(prof.strength ?? 0).toFixed(2)} · gusts ${(prof.gust ?? 0).toFixed(2)}`));
    f.onclick = () => applyProfile(id, prof);
    return f;
  }
  function grassTile(id, label, settings, flowers) {
    const f = el('button', `wprof${currentGrass === id ? ' on' : ''}`);
    f.dataset.id = `grass:${id}`;
    const v = { ...Object.fromEntries(G.params.map((q) => [q.key, q.default])), ...settings };
    const sw2 = el('span', 'gswatch');
    sw2.style.background = `linear-gradient(90deg, ${v.base}, ${v.mid} 35%, ${v.tip} 75%, ${v.dry})`;
    f.append(el('b', null, label), sw2, el('span', 'wmeta', `${v.heightMin.toFixed(2)}–${v.heightMax.toFixed(2)} m${flowers ? ` · ${flowers.plants.length} flower kinds` : ''}`));
    f.onclick = () => applyGrass(id, v, flowers);
    return f;
  }
  function renderDrawer() {
    body.replaceChildren();
    const sec = (title, tiles) => { if (!tiles.length) return; const g = el('section', 'libgroup'); const grid = el('div', 'wprofs'); grid.append(...tiles); g.append(el('h3', null, title), grid); body.append(g); };
    sec('Wind', Object.entries(info.presets).map(([id, p]) => profileTile(id, p.label, p)));
    sec('Saved wind', info.saved.map((p) => profileTile(p.name, p.name, p)));
    sec('Grass', Object.entries(G.presets).map(([id, p]) => { const { label, ...st } = p; return grassTile(id, label, st); }));
    sec('Saved grass', G.saved.map((p) => grassTile(p.name, p.name, p.settings, p.flowers)));
  }
  const markIn = (prefix, id) => { for (const b of body.querySelectorAll(`.wprof[data-id^="${prefix}:"]`)) b.classList.toggle('on', b.dataset.id === `${prefix}:${id}`); };
  function markProfile(id) { currentProfile = id; markIn('wind', id); }
  function markGrass(id) { currentGrass = id; markIn('grass', id); }
  function applyProfile(id, prof) {
    const { label: _l, name: _n, saved: _s, ...vals } = prof;
    for (const [k, v] of Object.entries(vals)) if (P[k] && !P[k].view) setParam(k, v);
    for (const s of syncs) s();
    markProfile(id);
  }
  function applyGrass(id, settings, flowers) {
    for (const [k, v] of Object.entries(settings)) if (k in grassVals) setGrass(k, v);
    if (flowers) { Object.assign(flowerVals, flowers); scatterSoon(); }
    for (const s of syncs) s();
    markGrass(id);
  }
  renderDrawer();
  for (const s of syncs) s();

  // --- Footern ---
  const fStats = el('div', 'block'), fWind = el('div', 'block'), note = el('div', 'msg');
  footer.append(fStats, fWind, note);
  function setNote(t) { note.textContent = t; }
  const block = (b, title, text) => { b.replaceChildren(el('b', null, title), el('div', 'vals', text)); };

  // --- Rendering ---
  let paused = false, running = false, last = performance.now(), frames = 0, fpsT = last, fps = 0;
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', () => { if (running) resize(); });
  function frame() {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) wind.update(dt);
    if (cloth && !paused && cloth.step(dt * wind.state.timeScale, clothWind)) updateCloth();
    controls.update();
    grass?.update(camera);
    updateArrow();
    renderer.render(scene, camera);
    frames++;
    if (now - fpsT > 500) {
      fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now;
      block(fStats, 'Glade', `${stats.models} rigged models · ${stats.flowers ?? 0} flowers · ${Math.round((grass?.visibleBlades() ?? 0) / 1000)}k blades · ${fps} fps · ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`);
      const f = wind.forceAt(controls.target.x, controls.target.z);
      block(fWind, 'Wind here', `toward ${valueFor('dir')}° · force ${f.toFixed(2)} · gust ${wind.gustAt(controls.target.x, controls.target.z).toFixed(2)}`);
    }
  }
  await loadGlade();
  // För prov: ?shot=<namn> sparar en bild av gläntan (build/shots/studio_<namn>.png) när den har laddat, med vilken
  // renderare som användes, så att man kan se WebGPU-fönster som man inte själv kan titta in i
  const shotName = new URLSearchParams(location.search).get('shot');
  if (shotName && /^[\w-]{1,40}$/.test(shotName)) setTimeout(async () => {
    renderer.render(scene, camera);
    const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
    // Ett provfönster (test=1, egen profil) stängs av servern när bilden är sparad
    const test = new URLSearchParams(location.search).get('test') === '1' ? '&test=1' : '';
    await fetch(`/api/shot?name=${shotName}_${renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl'}${test}`, { method: 'POST', body: blob });
  }, 4000);
  return {
    show() { running = true; resize(); last = performance.now(); renderer.setAnimationLoop(frame); },
    hide() { running = false; renderer.setAnimationLoop(null); },
    wind, scene, camera, controls, renderer,
    setDebug(v) { debug = v; applyDebug(); },
    get cloth() { return cloth; }, get flagMesh() { return flagMesh; }, // för felsökning och prov
    stats: () => ({ ...stats, fps }),
  };
}
