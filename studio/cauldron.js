// Häxkitteln (docs/effektlabb.md, E6): spelets effekter provas i en liten arena i skymning, med en figur (stand-in
// tills karaktärerna är klara), en träningsdocka, mark i två material med en kulle och en lykta. Fyra flikar: Glow &
// aura, Markers, Particles och Trails & hits. Effekterna är recept (tools/vfx/vfx.json, sparade i assets/vfx/) som
// shared/effects/vfx.js spelar upp, samma modul som Tinkertown ska använda. Egen renderare (WebGPU, WebGL2 som reserv)
// med glöd (bloom). Texten i appen är på engelska.
import * as THREE from 'three/webgpu';
import { pass, texture, positionWorld, mix, smoothstep, length, mx_noise_float, mx_noise_vec3, vec2, vec3, uniform, screenUV, exp, normalize } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEffect } from '../shared/effects/vfx.js';
import { gpuPreference, frameGate } from './gpu.js';
import { createCards } from './cards.js';

const DEG = Math.PI / 180;
// Där effekten sitter: per slag vilka platser som går att välja
const PLACES = {
  glow: [['figure', 'Figure'], ['dummy', 'Dummy']],
  marker: [['figure', 'Figure'], ['dummy', 'Dummy'], ['ground', 'Ground']],
  particles: [['ground', 'Ground'], ['lantern', 'Lantern'], ['figure', 'Figure'], ['dummy', 'Dummy']],
  trail: [],
  spell: [['ground', 'Spot (click)']],
};

export async function createCauldron({ api, el, view, side, drawer, footer }) {
  const info = await api('/api/vfx');
  const KIND = Object.fromEntries(info.kinds.map((k) => [k.id, k]));
  const defaults = (kind) => Object.fromEntries(KIND[kind].params.map((q) => [q.key, q.default]));

  // --- Renderaren: WebGPU bara på ett riktigt grafikkort (se windmill.js), glöd ovanpå ---
  const pref = gpuPreference() === 'default' ? undefined : gpuPreference();
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: pref }).catch(() => null) : null;
  const software = !adapter || adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter || /swiftshader|llvmpipe/i.test(`${adapter.info?.architecture} ${adapter.info?.description}`);
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: pref, forceWebGL: software });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  view.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
  camera.position.set(0.5, 3.4, 9);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0.3, 1.0, 0.3);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  // Skärmeffekter (FX10 i AAA-referensen): chockvågor som trycker isär bilden i en ring som vidgas, och värmedallring
  // med brus inom en cirkel. Ett fast antal platser som besvärjelsens post() fyller varje bild.
  const shockU = [0, 1, 2, 3].map(() => uniform(new THREE.Vector4())); // x, y (skärmen), radie, styrka
  const hazeU = [0, 1, 2].map(() => uniform(new THREE.Vector4()));
  const aspectU = uniform(1), timeU = uniform(0);
  const asp = vec2(aspectU, 1);
  let off = vec2(0, 0);
  for (const S of shockU) {
    const d = screenUV.sub(S.xy).mul(asp), r = length(d);
    off = off.add(normalize(d.add(1e-5)).mul(exp(r.sub(S.z).div(0.035).pow(2).negate())).mul(S.w));
  }
  for (const H of hazeU) {
    const d = screenUV.sub(H.xy).mul(asp);
    off = off.add(mx_noise_vec3(vec3(screenUV.mul(asp).mul(45), timeU.mul(4))).xy.mul(smoothstep(H.z, 0, length(d))).mul(H.w));
  }
  const bent = sceneColor.sample(screenUV.sub(off));
  const glowPass = bloom(bent, 0.8, 0.45, 0.85);
  pipeline.outputNode = bent.add(glowPass);
  const P = new THREE.Vector3();
  const toScreen = (pos) => { P.copy(pos).project(camera); return P.z < 1 ? [P.x * 0.5 + 0.5, 0.5 - P.y * 0.5] : null; };
  // Kameraknycken: en liten förskjutning som slumpas varje bild och tas bort efter ritningen
  const kick = new THREE.Vector3();
  function applyPost() {
    timeU.value = time;
    aspectU.value = camera.aspect;
    const post = fx?.post?.(time) ?? { shocks: [], hazes: [], shake: 0 };
    shockU.forEach((U, i) => {
      const sh = post.shocks[i], sc = sh && toScreen(sh.pos);
      if (!sc) { U.value.set(0, 0, 0, 0); return; }
      const e = 1 - (1 - Math.min(1, sh.k)) ** 3;
      U.value.set(sc[0], sc[1], sh.radius * e, sh.strength * (1 - Math.min(1, sh.k)));
    });
    hazeU.forEach((U, i) => {
      const h = post.hazes[i], sc = h && toScreen(h.pos);
      U.value.set(sc?.[0] ?? 0, sc?.[1] ?? 0, h?.radius ?? 0, sc ? h.strength : 0);
    });
    kick.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0).multiplyScalar(post.shake).applyQuaternion(camera.quaternion);
    camera.position.add(kick);
  }

  // --- Ljuset: från natt till dag, skymning som förval så att effekterna syns ---
  const hemi = new THREE.HemisphereLight('#9fb4e0', '#3a3428', 1);
  const sun = new THREE.DirectionalLight('#ffc89a', 1);
  sun.position.set(-12, 9, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
  scene.add(hemi, sun);
  const SKY = [new THREE.Color('#0b1020'), new THREE.Color('#2b3456'), new THREE.Color('#9cc6f0')];
  function setDaylight(d) {
    const c = d < 0.5 ? SKY[0].clone().lerp(SKY[1], d * 2) : SKY[1].clone().lerp(SKY[2], d * 2 - 1);
    scene.background = c;
    scene.fog = new THREE.Fog(c, 25, 90);
    hemi.intensity = 0.15 + 1.1 * d;
    sun.intensity = 0.1 + 2.8 * d * d;
    sun.color.set(d < 0.6 ? '#ffb27a' : '#ffe9c7');
  }

  // --- Marken: kullersten i arenan, äng utanför, och en kulle där markörerna får följa sluttningen ---
  const heightAt = (x, z) => 0.9 * Math.exp(-((x - 4.5) ** 2 + (z + 3.5) ** 2) / 5) + 0.5 * Math.exp(-((x + 6) ** 2 + (z + 1) ** 2) / 8);
  const gGeo = new THREE.PlaneGeometry(60, 60, 150, 150).rotateX(-Math.PI / 2);
  const gp = gGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, heightAt(gp.getX(i), gp.getZ(i)));
  gGeo.computeVertexNormals();
  const texLoader = new THREE.TextureLoader();
  const tex = (name) => { const t = texLoader.load(`/assets/textures/${name}.png`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const gMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const xz = positionWorld.xz;
  const edge = smoothstep(5.6, 5.0, length(xz).add(mx_noise_float(vec3(xz.mul(0.7), 0)).mul(0.5)));
  gMat.colorNode = mix(texture(tex('ground_meadow'), xz.div(3)).rgb.mul(0.85), texture(tex('cobblestone'), xz.div(1.1)).rgb, edge);
  const ground = new THREE.Mesh(gGeo, gMat);
  ground.receiveShadow = true;
  scene.add(ground);
  ground.updateMatrixWorld(true);

  // --- Stand-ins: figuren (Tripos referenskropp om den finns, annars en docka av kapslar), träningsdockan och lyktan ---
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const load = (url) => loader.loadAsync(url).then((g) => g.scene).catch(() => null);
  const shadows = (o) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); return o; };
  const mat = (color, roughness = 0.8) => new THREE.MeshStandardNodeMaterial({ color, roughness });
  function mannequin() {
    const g = new THREE.Group(), skin = mat('#b9a58f', 0.7);
    const part = (geo, x, y, z, m = skin) => { const p = new THREE.Mesh(geo, m); p.position.set(x, y, z); g.add(p); return p; };
    part(new THREE.CapsuleGeometry(0.2, 0.5, 6, 16), 0, 1.2, 0);
    part(new THREE.SphereGeometry(0.13, 24, 16), 0, 1.68, 0);
    for (const s of [-1, 1]) {
      part(new THREE.CapsuleGeometry(0.075, 0.75, 4, 12), s * 0.1, 0.48, 0);
      part(new THREE.CapsuleGeometry(0.06, 0.6, 4, 12), s * 0.29, 1.12, 0).rotation.z = s * 0.15;
    }
    return g;
  }
  function trainingDummy() {
    const g = new THREE.Group(), wood = mat('#6b4a2e'), straw = mat('#c9a95a', 0.95), cloth = mat('#8a3b2e', 0.9);
    const part = (geo, m, x, y, z) => { const p = new THREE.Mesh(geo, m); p.position.set(x, y, z); g.add(p); return p; };
    part(new THREE.CylinderGeometry(0.06, 0.07, 1.9, 12), wood, 0, 0.95, 0);
    part(new THREE.CylinderGeometry(0.3, 0.34, 0.12, 20), wood, 0, 0.06, 0);
    part(new THREE.CapsuleGeometry(0.24, 0.55, 6, 18), straw, 0, 1.2, 0);
    part(new THREE.CylinderGeometry(0.255, 0.255, 0.14, 18), cloth, 0, 1.1, 0);
    part(new THREE.SphereGeometry(0.17, 20, 14), straw, 0, 1.78, 0);
    part(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 10), wood, 0, 1.38, 0).rotation.z = Math.PI / 2;
    return g;
  }
  const figure = shadows((await load('/assets/imported/tripo_male_ref/tripo_male_ref.gltf')) ?? mannequin());
  figure.position.set(-2, 0, 0.5);
  figure.rotation.y = Math.PI / 2; // tittar mot dockan (+x)
  const dummy = shadows(trainingDummy());
  dummy.position.set(2.6, 0, 0.5);
  scene.add(figure, dummy);
  const lantern = shadows((await load('/assets/imported/azshara_lantern/azshara_lantern.gltf')) ?? new THREE.Group());
  lantern.position.set(-1.2, 0, -2.8);
  scene.add(lantern);
  const boxOf = (o) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); };
  // Lågan: mitten av den del som sitter högst (lykthuset, inte stolpen)
  boxOf(lantern);
  let flameAt = new THREE.Vector3(-1.2, 2, -2.8), best = -Infinity;
  lantern.traverse((o) => {
    if (!o.isMesh) return;
    const b = new THREE.Box3().setFromObject(o), c = b.getCenter(new THREE.Vector3());
    if (c.y > best) { best = c.y; flameAt = c; }
  });
  const lanternLight = new THREE.PointLight('#ffb35a', 6, 8, 2);
  lanternLight.position.copy(flameAt);
  scene.add(lanternLight);
  const figBox = boxOf(figure), dumBox = boxOf(dummy);
  const chest = (b, k = 0.62) => b.getCenter(new THREE.Vector3()).setY(b.min.y + (b.max.y - b.min.y) * k);
  const feet = (b) => b.getCenter(new THREE.Vector3()).setY(b.min.y);

  // --- Effekten: ett slag i taget (fliken), med sina spakar och sin plats ---
  const state = {};
  for (const k of info.kinds) state[k.id] = { settings: { ...defaults(k.id), ...(Object.values(info.presets[k.id] ?? {})[0] ?? {}) }, preset: Object.keys(info.presets[k.id] ?? {})[0] ?? null, place: PLACES[k.id][0]?.[0] };
  for (const st of Object.values(state)) delete st.settings.label;
  let kind = 'glow', fx = null, groundPoint = new THREE.Vector3(0, 0, 2.4), time = 0, lastCast = -1e9;
  let loop = true, nextPlay = 0, timeScale = 1, paused = false, windSpeed = 2, windDir = 30;
  const cur = () => state[kind];
  function anchor() {
    const p = cur().place;
    if (p === 'figure') return kind === 'particles' ? chest(figBox, 0.75) : feet(figBox);
    if (p === 'dummy') return kind === 'particles' ? chest(dumBox, 0.7) : feet(dumBox);
    if (p === 'lantern') return flameAt.clone();
    return groundPoint.clone();
  }
  const topOf = () => (cur().place === 'dummy' ? dumBox.max.y : cur().place === 'figure' ? figBox.max.y : groundPoint.y + 1.6);
  // Besvärjelsernas fästpunkter: kastaren, handen, målet, marken under det, himlen ovanför och platsen man klickat på
  function anchors() {
    const caster = feet(figBox), tg = feet(dumBox);
    return {
      caster, casterChest: chest(figBox, 0.6), hand: chest(figBox, 0.72).add(new THREE.Vector3(0.35, 0, 0)),
      target: chest(dumBox, 0.68), targetGround: tg, sky: tg.clone().add(new THREE.Vector3(-0.9, 14, -0.7)),
      mid: caster.clone().lerp(tg, 0.5), spot: groundPoint.clone(), spotUp: groundPoint.clone().add(new THREE.Vector3(0, 1.1, 0)),
      spotPortal: groundPoint.clone().add(new THREE.Vector3(0, 1.2, 0)),
    };
  }
  const spellDefaults = () => ({ particles: defaults('particles'), marker: defaults('marker'), glow: defaults('glow') });
  function build() {
    if (fx) { scene.remove(fx.object); fx.dispose(); fx = null; }
    const s = cur().settings, at = anchor();
    const ctx = { at, ground, top: topOf(), target: cur().place === 'dummy' ? dummy : figure, figure, dummy, from: chest(figBox, 0.72).add(new THREE.Vector3(0.35, 0, 0)), to: chest(dumBox, 0.68),
      spells: info.spells, defaults: spellDefaults(), anchors: anchors(), groundY: heightAt };
    try {
      fx = createEffect(kind, s, ctx);
    } catch (e) { setNote(`The effect could not be built: ${e.message}`); console.error(e); return; }
    if (kind === 'marker') fx.place(at, topOf());
    fx.loop = loop;
    scene.add(fx.object);
    nextPlay = time;
    if (kind === 'spell') { fx.play(time); lastCast = time; nextPlay = time + fx.duration + s.pause; }
  }
  function changed() { fx?.set(cur().settings); if (fx) fx.loop = loop; }

  // Klick på marken flyttar markören eller utsändaren dit (ett klick, inte en dragning med kameran)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  view.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  view.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
    down = null;
    if (!PLACES[kind].some(([id]) => id === 'ground')) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(ground)[0];
    if (!hit) return;
    groundPoint.copy(hit.point);
    cur().place = 'ground';
    build();
    cards.sync();
  });

  // --- Korten: spakarna för fliken, uppspelning och vy, spara ---
  const cards = createCards({ el, side });
  const kindCards = {};
  for (const k of info.kinds) {
    const els = [];
    const get = (key) => state[k.id].settings[key], set = (key, v) => { state[k.id].settings[key] = v; };
    // En besvärjelse byggs om när den byts, när ett lager slås av eller på och när storleken ändras
    const onChange = (q) => { markPreset(null); if (k.id === 'spell' && (q?.key === 'spell' || q?.type === 'bool' || q?.key === 'size')) build(); else changed(); };
    for (const g of k.groups) {
      const body = cards.card(g.label, '#8b5cf6', { closed: false });
      for (const q of k.params.filter((x) => x.group === g.id)) body.append(cards.rowFor(q)(q, get, set, onChange));
      els.push(body.parentElement);
    }
    kindCards[k.id] = els;
  }
  // Trails & hits: korten för svärd eller projektil syns efter läget
  const trailGroupEls = Object.fromEntries(KIND.trail.groups.map((g, i) => [g.id, kindCards.trail[i]]));
  function showCards() {
    for (const [id, els] of Object.entries(kindCards)) for (const c of els) c.hidden = id !== kind;
    if (kind === 'trail') {
      const proj = cur().settings.mode === 'projectile';
      trailGroupEls.sword.hidden = proj;
      trailGroupEls.projectile.hidden = trailGroupEls.hit.hidden = !proj;
    }
    placeRow.hidden = !PLACES[kind].length;
    for (const [id, b] of placeBtns) b.hidden = !PLACES[kind].some(([p]) => p === id);
    cards.sync();
  }
  // Läget i Trails & hits byter kort
  for (const c of kindCards.trail[0].querySelectorAll('.seg button')) c.addEventListener('click', () => { showCards(); });

  const playCard = cards.card('Play', '#b48cff');
  const placeRow = el('div', 'row span2'), placeSeg = el('div', 'seg');
  placeRow.title = 'Where the effect sits. Click the ground in the view to put markers and particles there';
  const placeBtns = [['figure', 'Figure'], ['dummy', 'Dummy'], ['ground', 'Ground'], ['lantern', 'Lantern']].map(([id, label]) => {
    const b = el('button', null, label);
    b.onclick = () => { cur().place = id; build(); cards.sync(); };
    placeSeg.append(b);
    return [id, b];
  });
  cards.syncs.push(() => { for (const [id, b] of placeBtns) b.classList.toggle('on', id === cur().place); });
  placeRow.append(el('label', null, 'Place on'), placeSeg);
  const playBtn = el('button', 'primary', 'Play once');
  playBtn.title = 'Plays the effect once: a burst, a swing or a shot';
  playBtn.onclick = () => { loopBox.checked = loop = false; if (fx) { fx.loop = false; fx.play(time); } };
  const loopRow = el('div', 'row span2'), loopBox = el('input', 'switch');
  loopBox.type = 'checkbox';
  loopBox.checked = true;
  loopBox.onchange = () => { loop = loopBox.checked; if (fx) fx.loop = loop; nextPlay = time; };
  loopRow.title = 'Repeat bursts, swings and shots';
  loopRow.append(el('label', null, 'Loop'), loopBox);
  playCard.append(placeRow, loopRow, playBtn);

  const viewCard = cards.card('View', '#7c8a99', { closed: true });
  const viewVals = { daylight: 0.3, bloom: 0.8, timeScale: 1, wind: windSpeed, windDir };
  const V = [
    { key: 'daylight', label: 'Daylight', min: 0, max: 1, step: 0.01, help: 'From night to full day; effects show best at dusk' },
    { key: 'bloom', label: 'Bloom', min: 0, max: 3, step: 0.05, help: 'How much bright light glows (bloom)' },
    { key: 'timeScale', label: 'Speed', min: 0.05, max: 2, step: 0.05, help: 'Slow motion below 1' },
    { key: 'wind', label: 'Wind', min: 0, max: 14, step: 0.1, help: 'Wind speed (m/s) for particles that follow the wind' },
    { key: 'windDir', label: 'Wind direction', min: 0, max: 359, step: 1, help: 'Where the wind blows (degrees)' },
  ];
  const applyView = () => {
    setDaylight(viewVals.daylight);
    glowPass.strength.value = viewVals.bloom;
    timeScale = viewVals.timeScale; windSpeed = viewVals.wind; windDir = viewVals.windDir;
    lanternLight.intensity = 6 * (1 - viewVals.daylight * 0.8);
  };
  for (const q of V) viewCard.append(cards.slider(q, (k) => viewVals[k], (k, v) => { viewVals[k] = v; }, applyView));
  const pauseRow = el('div', 'row span2'), pauseBox = el('input', 'switch');
  pauseBox.type = 'checkbox';
  pauseBox.onchange = () => { paused = pauseBox.checked; };
  pauseRow.append(el('label', null, 'Pause'), pauseBox);
  viewCard.append(pauseRow);
  applyView();

  const saveCard = cards.card('Save', '#8b5cf6');
  const saveMsg = el('div', 'note');
  const saveBtn = el('button', 'primary', 'Save effect…');
  saveBtn.title = 'Saves the sliders as a recipe in assets/vfx/, for the studio and Tinkertown';
  saveBtn.onclick = async () => {
    const name = prompt('Name of the effect (a–z, 0–9 and _):', cur().preset ?? `my_${kind}`);
    if (!name) return;
    const payload = { name, kind, settings: cur().settings };
    let r = await api('/api/vfx/save', payload);
    if (r.exists && confirm(`${name} already exists. Overwrite?`)) r = await api('/api/vfx/save', { ...payload, overwrite: true });
    saveMsg.textContent = r.error ? `Not saved: ${r.error}` : r.file ? `Saved: ${r.file}` : '';
    if (!r.entry) return;
    info.saved = [r.entry, ...info.saved.filter((x) => x.name !== r.entry.name)];
    cur().preset = `saved:${r.entry.name}`;
    renderDrawer();
  };
  saveCard.append(saveBtn, saveMsg);

  // --- Lådan: flikens färdiga och sparade effekter ---
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  const headTitle = el('h2'), headNote = el('div', 'note');
  head.append(headTitle, headNote);
  drawer.append(head, body);
  const swatch = (s) => {
    const cs = [s.color, s.color2, s.colorStart, s.colorMid, s.colorEnd, s.colorHead, s.colorTail, s.hitColor].filter(Boolean);
    const sw = el('span', 'gswatch');
    sw.style.background = cs.length > 1 ? `linear-gradient(90deg, ${cs.join(', ')})` : cs[0] ?? 'var(--line)';
    return sw;
  };
  const metaOf = (s) => ({
    glow: () => `${s.motes} motes${s.pillar > 0 ? ' · pillar' : ''}`,
    marker: () => `${KIND.marker.params.find((q) => q.key === 'shape').options.find((o) => o.id === s.shape)?.label} · ${s.radius} m`,
    particles: () => `${s.mode === 'burst' ? 'burst' : 'continuous'} · ${s.count} · ${s.sprite}`,
    trail: () => (s.mode === 'sword' ? 'sword swing' : `projectile · ${s.speed} m/s`),
    spell: () => `${info.spells[s.spell]?.layers.length ?? 0} layers${info.spells[s.spell]?.ambient ? ' · lasting' : ''}`,
  })[kind]();
  function tile(id, label, settings) {
    const f = el('button', `wprof${cur().preset === id ? ' on' : ''}`);
    f.dataset.id = id;
    const full = { ...defaults(kind), ...settings };
    delete full.label;
    f.append(el('b', null, label), swatch(full), el('span', 'wmeta', metaOf(full)));
    f.onclick = () => applyPreset(id, full);
    return f;
  }
  function renderDrawer() {
    headTitle.textContent = `${KIND[kind].label}`;
    headNote.textContent = 'Click an effect to brew it. Save your own in the Save card.';
    body.replaceChildren();
    const sec = (title, tiles) => { if (!tiles.length) return; const g = el('section', 'libgroup'); const grid = el('div', 'wprofs'); grid.append(...tiles); g.append(el('h3', null, title), grid); body.append(g); };
    sec('Ready-made', Object.entries(info.presets[kind] ?? {}).map(([id, p]) => tile(id, p.label, p)));
    sec('Saved', info.saved.filter((x) => x.kind === kind).map((x) => tile(`saved:${x.name}`, x.name, x.settings)));
  }
  function markPreset(id) { cur().preset = id; for (const b of body.querySelectorAll('.wprof')) b.classList.toggle('on', b.dataset.id === id); }
  function applyPreset(id, full) {
    const modeChanged = kind === 'trail' && full.mode !== cur().settings.mode;
    cur().settings = full;
    markPreset(id);
    if (modeChanged || kind === 'spell') build(); else changed();
    showCards();
    if (kind !== 'spell') nextPlay = time;
  }

  // --- Footern ---
  const fStats = el('div', 'block'), fFx = el('div', 'block'), note = el('div', 'msg');
  footer.append(fStats, fFx, note);
  function setNote(t) { note.textContent = t; }
  const block = (b, title, text) => { b.replaceChildren(el('b', null, title), el('div', 'vals', text)); };

  // --- Rendering ---
  let running = false, last = performance.now(), frames = 0, fpsT = last, fps = 0;
  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', () => { if (running) resize(); });
  const gate = frameGate();
  const windVec = [0, 0, 0];
  function frame() {
    const now = performance.now();
    if (!gate(now)) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(dt);
    frames++;
    if (now - fpsT > 500) {
      fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now;
      const s = cur().settings;
      block(fStats, 'Arena', `${fps} fps · ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`);
      const n = kind === 'particles' ? `${s.count} particles` : kind === 'glow' ? `${s.motes} motes` : kind === 'trail' ? (s.mode === 'sword' ? 'sword' : `${s.sparks} + ${s.hitSparks} sparks`) : kind === 'spell' ? info.spells[s.spell]?.label : s.shape;
      block(fFx, KIND[kind].label, `${cur().preset?.replace(/^saved:/, '') ?? 'custom'} · ${n}`);
    }
  }
  function tick(dt) {
    if (!paused) time += dt * timeScale;
    windVec[0] = Math.cos(windDir * DEG) * windSpeed; windVec[2] = Math.sin(windDir * DEG) * windSpeed;
    // Smällar upprepas i loop: en ny när den förra har dött ut
    const s = cur().settings;
    if (fx && loop && kind === 'particles' && s.mode === 'burst' && time >= nextPlay) { fx.play(time); nextPlay = time + s.lifetime + (s.burstSpread ?? 0) + 0.4; }
    // Besvärjelser kastas om efter sin längd och pausen (de som pågår hela tiden, som lägerelden, en gång)
    if (fx && kind === 'spell' && !fx.ambient) {
      if (nextPlay <= lastCast) nextPlay = lastCast + fx.duration + s.pause;
      if (loop && time >= nextPlay) { fx.play(time); lastCast = time; nextPlay = time + fx.duration + s.pause; }
    }
    fx?.update(time, { camera, wind: windVec });
    controls.update();
    applyPost();
    pipeline.render();
    camera.position.sub(kick);
  }

  function select(k) {
    if (!KIND[k]) return;
    kind = k;
    build();
    showCards();
    renderDrawer();
  }
  select(kind);
  // För prov: ?shot=<namn> sparar en bild av arenan (build/shots/studio_<namn>.png), som Väderkvarnen
  const shotName = new URLSearchParams(location.search).get('shot');
  if (shotName && /^[\w-]{1,40}$/.test(shotName) && /kitteln/.test(location.hash)) setTimeout(async () => {
    pipeline.render();
    const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
    const test = new URLSearchParams(location.search).get('test') === '1' ? '&test=1' : '';
    await fetch(`/api/shot?name=${shotName}_${renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl'}_${fps}fps${test}`, { method: 'POST', body: blob });
  }, 4000);
  return {
    show(k) { if (k && k !== kind) select(k); running = true; resize(); last = performance.now(); renderer.setAnimationLoop(frame); },
    hide() { running = false; renderer.setAnimationLoop(null); },
    get kind() { return kind; },
    select, scene, camera, controls, renderer, get fx() { return fx; }, state,
    // För prov: spela effekten från början och frys den efter t sekunder (Loop stängs av); resume() släpper den
    seek(t, step = 1 / 30) {
      loop = loopBox.checked = false; if (fx) fx.loop = false;
      paused = false; fx?.play?.(time); lastCast = time;
      for (let x = 0; x < t; x += step) tick(step);
      paused = pauseBox.checked = true;
    },
    resume() { paused = pauseBox.checked = false; loop = loopBox.checked = true; if (fx) fx.loop = true; },
    // För prov utan ritslinga (dold flik): stega tiden och rita, och spara bilden som build/shots/studio_<namn>.png
    async shot(name, seconds = 1, step = 1 / 30) {
      for (let t = 0; t < seconds; t += step) tick(step);
      tick(0); // rita en gång till och läs bilden i samma uppgift
      const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
      return (await fetch(`/api/shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })).json();
    },
    stats: () => ({ fps, kind, backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl' }),
  };
}
