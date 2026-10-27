// Väderkvarnen, fliken Väder (docs/effektlabb.md, E4): en stuga i en glänta där vädret provas. Börjar med ljusstrålar:
// solen över dygnet, himlen, volymetriskt solljus genom kronorna (shared/effects/weather.js), dis och stoft i luften.
// Spakarna och väderlägena är data i tools/weather/weather.json; sparade väderlägen i assets/weather/. Egen renderare
// (WebGPU, WebGL2 som reserv) med glöd, som Väderkvarnens Vind-flik. Texten i appen är på engelska.
import * as THREE from 'three/webgpu';
import { pass, texture, positionWorld, mix, smoothstep, mx_noise_float, vec3 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { sunAt, createSky, createShafts } from '../shared/effects/weather.js';
import { createParticles } from '../shared/effects/vfx.js';
import { gpuPreference, frameGate } from './gpu.js';
import { createCards } from './cards.js';

const DEG = Math.PI / 180;

export async function createWeather({ api, el, view, side, drawer, footer }) {
  const info = await api('/api/weather');
  const defaults = Object.fromEntries(info.params.map((q) => [q.key, q.default]));
  const vals = { ...defaults, ...stripLabel(Object.values(info.presets)[0] ?? {}) };
  let current = Object.keys(info.presets)[0] ?? null;

  // --- Renderaren (se windmill.js): WebGPU bara på ett riktigt grafikkort ---
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
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
  camera.position.set(...info.camera.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...info.camera.target);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  // --- Solen, himlen och ljuset ---
  const sky = createSky();
  scene.backgroundNode = sky.node;
  const hemi = new THREE.HemisphereLight('#cfe0ff', '#4a5a30', 1);
  const sunLight = new THREE.DirectionalLight('#ffffff', 3);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.04;
  Object.assign(sunLight.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, near: 1, far: 110 });
  const CENTER = new THREE.Vector3(0, 0, -8);
  sunLight.target.position.copy(CENTER);
  scene.add(hemi, sunLight, sunLight.target);

  // --- Marken: äng med en stig av kullersten fram till stugan ---
  const texLoader = new THREE.TextureLoader();
  const tex = (name) => { const t = texLoader.load(`/assets/textures/${name}.png`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const gMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const xz = positionWorld.xz;
  const path = smoothstep(1.6, 0.9, xz.x.sub(xz.y.mul(0.08)).abs().add(mx_noise_float(vec3(xz.mul(0.6), 0)).mul(0.4))).mul(smoothstep(-12, -9.5, xz.y));
  gMat.colorNode = mix(texture(tex('ground_meadow'), xz.div(3)).rgb.mul(0.9), texture(tex('cobblestone'), xz.div(1.1)).rgb.mul(0.85), path);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(150, 64).rotateX(-Math.PI / 2), gMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // --- Platsen: stugan, träden och några stenar ur weather.json ---
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  let loaded = 0;
  const failed = [];
  await Promise.all(info.scene.map(async (it) => {
    const root = await loader.loadAsync(`/${it.model}`).then((g) => g.scene).catch(() => null);
    if (!root) { failed.push(it.id); return; }
    root.position.set(...it.pos);
    root.rotation.y = (it.rot ?? 0) * DEG;
    root.scale.setScalar(it.scale ?? 1);
    root.traverse((o) => {
      if (/_LOD[12]$/.test(o.name)) o.visible = false;
      if (!o.isMesh) return;
      const m = o.material;
      // Skuggformer (shadowProxy) kastar skugga men syns inte; de ger strålarna sina glipor
      o.castShadow = m.userData?.castShadow !== false;
      o.receiveShadow = m.userData?.receiveShadow !== false && !m.userData?.shadowProxy;
      if (m.userData?.shadowProxy) { m.colorWrite = false; m.depthWrite = false; }
    });
    scene.add(root);
    loaded++;
  }));

  // --- Stoft i luften: små korn som driver långsamt och glimmar (vfx.js partiklar) ---
  const dustSettings = (n, col) => ({
    mode: 'loop', count: Math.max(1, n), lifetime: 9, lifeVar: 0.3, emit: 'sphere', radius: 10, speed: 0.03, speedVar: 0.5, spread: 180, radial: 0, gravity: 0, drag: 0.2,
    swirl: 0, turbulence: 0.15, flow: 0.06, flowScale: 0.35, wind: 0.1, sprite: 'soft', additive: true, sizeStart: 0.025, sizeEnd: 0.025, sizeVar: 0.5, stretch: 0, spin: 0,
    colorStart: col, colorMid: col, colorEnd: col, alpha: 0.8, fadeIn: 0.25, fadeOut: 0.3, glow: 1.6, flicker: 0.7,
  });
  const dust = createParticles(dustSettings(vals.dust, '#ffe6b0'), { at: new THREE.Vector3(0, 3.5, -5), max: 1000 });
  scene.add(dust.object);

  // --- Bilden: scenen, ljusstrålarna och glöden ---
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const shafts = createShafts({ sceneColor: scenePass.getTextureNode('output'), sceneDepth: scenePass.getTextureNode('depth'), camera, light: sunLight });
  const glowPass = bloom(shafts.node, 0.35, 0.5, 0.9);
  pipeline.outputNode = shafts.node.add(glowPass);

  // --- Spakarna verkställs: solen, himlen, dis, strålar och stoft ---
  let sun = sunAt(vals.hour, vals.azimuth);
  function apply() {
    sun = sunAt(vals.hour, vals.azimuth);
    sunLight.position.copy(CENTER).addScaledVector(sun.dir, 60);
    sunLight.color.copy(sun.color);
    sunLight.intensity = vals.sun * sun.strength;
    sunLight.castShadow = sun.strength > 0.01;
    hemi.intensity = sun.ambient;
    hemi.color.copy(sun.zenith).lerp(new THREE.Color('#ffffff'), 0.45);
    sky.set(sun, vals.glow);
    scene.fog = vals.haze > 0 ? new THREE.FogExp2(sun.horizon, vals.haze) : null;
    renderer.toneMappingExposure = vals.exposure;
    const tint = vals.followSun ? sun.color.clone().lerp(new THREE.Color('#ffffff'), 0.15) : new THREE.Color(vals.shaftColor);
    shafts.set({ ...vals, shafts: vals.shafts * sun.strength }, tint, sun.dir);
    dust.set(dustSettings(vals.dust, `#${tint.getHexString()}`));
    dust.object.visible = vals.dust > 0;
  }

  // --- Korten ---
  const cards = createCards({ el, side });
  const get = (k) => vals[k], set = (k, v) => { vals[k] = v; };
  for (const g of info.groups) {
    const body = cards.card(g.label, g.id === 'sun' ? '#e0a030' : g.id === 'shafts' ? '#f0c060' : '#7aa8d8');
    for (const q of info.params.filter((x) => x.group === g.id)) body.append(cards.rowFor(q)(q, get, set, () => { mark(null); apply(); }));
  }
  const saveCard = cards.card('Save', '#4a90d9');
  const saveMsg = el('div', 'note');
  const saveBtn = el('button', 'primary', 'Save weather…');
  saveBtn.title = 'Saves the sliders as a weather recipe in assets/weather/, for the studio, the showcase and Tinkertown';
  saveBtn.onclick = async () => {
    const name = prompt('Name of the weather (a–z, 0–9 and _):', current?.replace(/^saved:/, '') ?? 'my_weather');
    if (!name) return;
    let r = await api('/api/weather/save', { name, settings: vals });
    if (r.exists && confirm(`${name} already exists. Overwrite?`)) r = await api('/api/weather/save', { name, settings: vals, overwrite: true });
    saveMsg.textContent = r.error ? `Not saved: ${r.error}` : r.file ? `Saved: ${r.file}` : '';
    if (!r.entry) return;
    info.saved = [r.entry, ...info.saved.filter((x) => x.name !== r.entry.name)];
    current = `saved:${r.entry.name}`;
    renderDrawer();
  };
  saveCard.append(saveBtn, saveMsg);

  // --- Lådan: färdiga och sparade väderlägen ---
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  head.append(el('h2', null, 'Weather'), el('div', 'note', 'Click a weather to use it. Save your own in the Save card.'));
  drawer.append(head, body);
  const clock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;
  function tile(id, label, settings) {
    const v = { ...defaults, ...stripLabel(settings) }, s = sunAt(v.hour, v.azimuth);
    const f = el('button', `wprof${current === id ? ' on' : ''}`);
    f.dataset.id = id;
    const sw = el('span', 'gswatch');
    sw.style.background = `linear-gradient(90deg, #${s.horizon.getHexString()}, #${s.color.getHexString()} 50%, #${s.zenith.getHexString()})`;
    f.append(el('b', null, label), sw, el('span', 'wmeta', `${clock(v.hour)} · shafts ${v.shafts.toFixed(2)} · haze ${v.haze.toFixed(3)}`));
    f.onclick = () => { Object.assign(vals, v); mark(id); cards.sync(); apply(); };
    return f;
  }
  function renderDrawer() {
    body.replaceChildren();
    const sec = (title, tiles) => { if (!tiles.length) return; const g = el('section', 'libgroup'); const grid = el('div', 'wprofs'); grid.append(...tiles); g.append(el('h3', null, title), grid); body.append(g); };
    sec('Ready-made', Object.entries(info.presets).map(([id, p]) => tile(id, p.label, p)));
    sec('Saved', info.saved.map((x) => tile(`saved:${x.name}`, x.name, x.settings)));
  }
  function mark(id) { current = id; for (const b of body.querySelectorAll('.wprof')) b.classList.toggle('on', b.dataset.id === id); }
  renderDrawer();
  cards.sync();
  apply();

  // --- Footern ---
  const fStats = el('div', 'block'), fSun = el('div', 'block'), note = el('div', 'msg');
  footer.append(fStats, fSun, note);
  const block = (b, title, text) => { b.replaceChildren(el('b', null, title), el('div', 'vals', text)); };
  if (failed.length) note.textContent = `Could not load: ${failed.join(', ')}`;

  // --- Rendering ---
  let running = false, last = performance.now(), frames = 0, fpsT = last, fps = 0, time = 0;
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', () => { if (running) resize(); });
  const gate = frameGate();
  function tick(dt) {
    time += dt;
    dust.update(time, { wind: [0.3, 0, 0.1] });
    controls.update();
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
      block(fStats, 'Glade', `${loaded} models · ${fps} fps · ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`);
      block(fSun, 'Sun', `${clock(vals.hour)} · ${Math.round(sun.elevation / DEG)}° up · toward ${Math.round(vals.azimuth)}°`);
    }
  }
  // För prov: ?shot=<namn> sparar en bild (build/shots/studio_<namn>.png) när platsen har laddat, som Vind-fliken
  const shotName = new URLSearchParams(location.search).get('shot');
  if (shotName && /^[\w-]{1,40}$/.test(shotName) && /vader/.test(location.hash)) setTimeout(async () => {
    tick(0);
    const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
    const test = new URLSearchParams(location.search).get('test') === '1' ? '&test=1' : '';
    await fetch(`/api/shot?name=${shotName}_${renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl'}_${fps}fps${test}`, { method: 'POST', body: blob });
  }, 5000);
  return {
    show() { running = true; resize(); last = performance.now(); renderer.setAnimationLoop(frame); },
    hide() { running = false; renderer.setAnimationLoop(null); },
    scene, camera, controls, renderer, vals, apply, shafts,
    stats: () => ({ fps, loaded, failed, backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl' }),
    // För prov: rita en gång till och spara bilden som build/shots/studio_<namn>.png
    async shot(name) {
      tick(0);
      const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
      return (await fetch(`/api/shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })).json();
    },
  };
}
function stripLabel(p) { const { label: _l, ...rest } = p; return rest; }
