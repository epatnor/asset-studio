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

const LEAFY = /^(Leaves|LeafMass|Fronds|leaf|petal|blade|grass|frond)/i;
const DEG = Math.PI / 180;

export async function createWindmill({ api, el, view, side, drawer, footer }) {
  const info = await api('/api/wind');
  const P = Object.fromEntries(info.params.map((q) => [q.key, q]));
  const wind = createWind(Object.fromEntries(info.params.map((q) => [q.key, q.key === 'dir' ? q.default * DEG : q.default])));

  // --- Scenen: himmel, sol, mark ---
  const renderer = new THREE.WebGPURenderer({ antialias: true });
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
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardNodeMaterial({ color: '#6c9a44', roughness: 1 }));
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
  function windMaterial(src, tex, stem) {
    const m = new THREE.MeshStandardNodeMaterial();
    for (const k of ['name', 'color', 'map', 'roughness', 'metalness', 'alphaTest', 'transparent', 'side', 'vertexColors', 'normalMap', 'emissive']) if (src[k] !== undefined) m[k] = src[k];
    m.positionNode = wind.rigged(tex, { flutter: LEAFY.test(src.name), stem });
    if (src.userData?.shadowProxy) { m.colorWrite = false; m.depthWrite = false; }
    const d = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: src.side, alphaTest: src.alphaTest, map: src.map });
    d.colorNode = partColor(attribute('_part', 'float'));
    d.positionNode = m.positionNode;
    if (src.userData?.shadowProxy) { d.colorWrite = false; d.depthWrite = false; }
    return [m, d];
  }
  const tableOf = (o) => { for (let p = o; p; p = p.parent) if (p.userData?.wind) return p.userData.wind; return null; };
  let stats = { models: 0, parts: 0, failed: [] };
  async function loadGlade() {
    setNote('Building the glade with the generators… (the first time takes a little while)');
    const g = await api('/api/wind/glade');
    for (const it of g.items) {
      const root = (await loader.loadAsync(it.url)).scene;
      root.position.set(...it.pos);
      root.rotation.y = (it.rot ?? 0) * DEG;
      const texes = new Map();
      root.traverse((o) => {
        if (/_LOD[12]$/.test(o.name)) o.visible = false; // gläntan visar LOD0
        if (!o.isMesh) return;
        const src = o.material;
        o.castShadow = src.userData?.castShadow !== false;
        o.receiveShadow = src.userData?.receiveShadow !== false && !src.userData?.shadowProxy;
        const w = it.rigged && tableOf(o);
        if (!w || !o.geometry.attributes._part) return;
        if (!texes.has(w)) { texes.set(w, rigTexture(w)); stats.parts += w.count; addPivots(w, root); }
        const [m, d] = windMaterial(src, texes.get(w), !!o.geometry.attributes._stem);
        o.material = m;
        rigged.push({ mesh: o, normal: m, debug: d });
      });
      scene.add(root);
      stats.models += it.rigged ? 1 : 0;
      for (const c of [...(Object.entries(it.checks ?? {}))].filter(([k, v]) => /^rig_(torn|still_moves|ground_moves)$/.test(k) && v)) stats.failed.push(`${it.id}: ${c[0]} ${c[1]}`);
    }
    stats.failed.push(...g.errors);
    addGrass(g.grass);
    addFlag(g.flag);
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

  // --- Gräsplätten: strån som roteras runt roten med samma vind (wind.blades), ljusare i byarna ---
  function addGrass(o) {
    if (!o) return;
    const rnd = (() => { let a = 1234567; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();
    const N = o.blades, SEG = 3, perBlade = SEG * 2 + 1;
    const pos = new Float32Array(N * perBlade * 3), root = new Float32Array(N * perBlade * 3), gt = new Float32Array(N * perBlade);
    const blade = new Float32Array(N * perBlade * 3), col = new Float32Array(N * perBlade * 3), nrm = new Float32Array(N * perBlade * 3);
    const idx = [];
    for (let b = 0; b < N; b++) {
      const r = o.radius * Math.sqrt(rnd()), a = rnd() * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = o.height[0] + (o.height[1] - o.height[0]) * rnd() * (1 - 0.5 * (r / o.radius) ** 3);
      const yaw = rnd() * Math.PI, w = 0.012 + rnd() * 0.01, lean = (rnd() - 0.5) * 0.3;
      const sx = Math.cos(yaw), sz = Math.sin(yaw), base = b * perBlade;
      const amp = o.angle * (0.7 + 0.6 * rnd()), freq = 1.2 + rnd() * 1.4, ph = rnd() * Math.PI * 2, tone = 0.8 + rnd() * 0.35;
      for (let k = 0; k < perBlade; k++) {
        const s = Math.floor(k / 2), t = Math.min(1, s / SEG), side = k === perBlade - 1 ? 0 : k % 2 ? 1 : -1;
        const half = w * (1 - t * 0.85) * side, y = h * t, off = lean * t * t * h;
        const i = base + k;
        pos.set([x + sx * half + -sz * off, y, z + sz * half + sx * off], i * 3);
        root.set([x, 0, z], i * 3);
        gt[i] = t;
        blade.set([amp, freq, ph], i * 3);
        nrm.set([0, 1, 0], i * 3);
        const c = [0.16 + 0.22 * t, 0.3 + 0.32 * t, 0.08 + 0.1 * t].map((v) => v * tone);
        col.set(c, i * 3);
      }
      for (let s = 0; s < SEG; s++) {
        const a0 = base + s * 2, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
        if (s === SEG - 1) idx.push(a0, a1, base + perBlade - 1);
        else idx.push(a0, a1, b1, a0, b1, b0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('groot', new THREE.BufferAttribute(root, 3));
    g.setAttribute('gt', new THREE.BufferAttribute(gt, 1));
    g.setAttribute('gblade', new THREE.BufferAttribute(blade, 3));
    g.setIndex(idx);
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.9 });
    m.positionNode = wind.blades();
    // Byarna syns som ljusare stråk i gräset (som i showcase/grass.js)
    const rootXZ = attribute('groot', 'vec3').xz;
    m.colorNode = vertexColor().mul(float(1).add(wind.gust(rootXZ).mul(wind.uniforms.strength).mul(attribute('gt', 'float')).mul(0.35)));
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  // --- Flaggan: stång och duk ---
  function addFlag(o) {
    if (!o) return;
    const grp = new THREE.Group();
    grp.position.set(...o.pos);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, o.pole, 10), new THREE.MeshStandardNodeMaterial({ color: '#d8d2c4', roughness: 0.6 }));
    pole.position.y = o.pole / 2;
    pole.castShadow = true;
    const cloth = new THREE.PlaneGeometry(o.length, o.height, 28, 10);
    cloth.translate(o.length / 2, o.pole - o.height / 2 - 0.1, 0);
    const fm = new THREE.MeshStandardNodeMaterial({ color: '#c0412e', roughness: 0.85, side: THREE.DoubleSide });
    fm.positionNode = wind.flag(o.length);
    const flag = new THREE.Mesh(cloth, fm);
    flag.castShadow = true;
    flag.frustumCulled = false;
    grp.add(pole, flag);
    scene.add(grp);
  }

  // --- Vindpilen på marken: pekar dit det blåser, längre och mer opak ju starkare ---
  const arrowShape = new THREE.Shape([[0, -0.18], [1.4, -0.18], [1.4, -0.45], [2.2, 0], [1.4, 0.45], [1.4, 0.18], [0, 0.18]].map(([x, y]) => new THREE.Vector2(x, y)));
  const arrowMat = new THREE.MeshBasicNodeMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false });
  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), arrowMat);
  arrow.rotation.x = -Math.PI / 2;
  const arrowPivot = new THREE.Group();
  arrowPivot.position.set(-1.2, 0.03, 8.5);
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
    for (const r of rigged) r.mesh.material = debug ? r.debug : r.normal;
    pivotGroup.visible = debug;
  }

  // --- Spakar, profiler och vy (kort till höger) ---
  const syncs = [];
  const valueFor = (k) => (k === 'dir' ? Math.round(((wind.state.dir / DEG) % 360 + 360) % 360) : wind.state[k]);
  const setParam = (k, v) => wind.set({ [k]: k === 'dir' ? v * DEG : v });
  function card(title, accent) {
    const c = el('section', 'card glass');
    c.style.setProperty('--part', accent);
    const head = el('header'), body = el('div', 'rows');
    head.append(el('h2', null, title));
    c.append(head, body);
    side.append(c);
    return body;
  }
  function slider(q) {
    const row = el('div', 'row'), r = el('input'), out = el('output');
    if (q.help) row.title = q.help;
    Object.assign(r, { type: 'range', min: q.min, max: q.max, step: q.step });
    const dec = q.step >= 1 ? 0 : 2;
    const sync = () => { r.value = valueFor(q.key); out.textContent = Number(r.value).toFixed(dec); };
    r.oninput = () => { setParam(q.key, Number(r.value)); out.textContent = Number(r.value).toFixed(dec); markProfile(null); };
    row.append(el('label', null, q.label), r, out);
    syncs.push(sync);
    return row;
  }
  const windCard = card('Wind', '#4a90d9');
  for (const q of info.params.filter((x) => !x.view)) windCard.append(slider(q));
  const viewCard = card('View', '#7c8a99');
  for (const q of info.params.filter((x) => x.view)) viewCard.append(slider(q));
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
  const saveBtn = el('button', 'primary', 'Save wind profile…');
  saveBtn.title = 'Saves the sliders as a recipe in assets/wind/, for the studio, the showcase and Tinkertown';
  const saveMsg = el('div', 'note');
  saveBtn.onclick = async () => {
    const name = prompt('Name of the wind profile (a–z, 0–9 and _):', currentProfile ?? 'my_wind');
    if (!name) return;
    const profile = Object.fromEntries(info.params.filter((q) => !q.view).map((q) => [q.key, valueFor(q.key)]));
    let r = await api('/api/wind/save', { name, profile });
    if (r.exists && confirm(`${name} already exists. Overwrite?`)) r = await api('/api/wind/save', { name, profile, overwrite: true });
    saveMsg.textContent = r.error ? `Not saved: ${r.error}` : r.file ? `Saved: ${r.file}` : '';
    if (r.entry) { info.saved = [r.entry, ...info.saved.filter((x) => x.name !== r.entry.name)]; currentProfile = r.entry.name; renderDrawer(); }
  };
  saveCard.append(saveBtn, saveMsg);

  // --- Lådan: färdiga profiler och sparade ---
  let currentProfile = null;
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  head.append(el('h2', null, 'Wind drawer'), el('div', 'note', 'Click a profile to blow with it. Save your own in the Save card.'));
  drawer.append(head, body);
  function profileTile(id, label, prof) {
    const f = el('button', `wprof${currentProfile === id ? ' on' : ''}`);
    const bar = el('span', 'wbar2');
    bar.style.setProperty('--s', Math.min(1, (prof.strength ?? 0) / 1.5));
    f.append(el('b', null, label), bar, el('span', 'wmeta', `strength ${(prof.strength ?? 0).toFixed(2)} · gusts ${(prof.gust ?? 0).toFixed(2)}`));
    f.onclick = () => applyProfile(id, prof);
    return f;
  }
  function renderDrawer() {
    body.replaceChildren();
    const sec = (title, tiles) => { if (!tiles.length) return; const g = el('section', 'libgroup'); const grid = el('div', 'wprofs'); grid.append(...tiles); g.append(el('h3', null, title), grid); body.append(g); };
    sec('Profiles', Object.entries(info.presets).map(([id, p]) => profileTile(id, p.label, p)));
    sec('Saved', info.saved.map((p) => profileTile(p.name, p.name, p)));
  }
  function markProfile(id) { currentProfile = id; for (const b of body.querySelectorAll('.wprof')) b.classList.toggle('on', b.querySelector('b').textContent === (info.presets[id]?.label ?? id)); }
  function applyProfile(id, prof) {
    const { label: _l, name: _n, saved: _s, ...vals } = prof;
    for (const [k, v] of Object.entries(vals)) if (P[k] && !P[k].view) setParam(k, v);
    for (const s of syncs) s();
    markProfile(id);
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
    controls.update();
    updateArrow();
    renderer.render(scene, camera);
    frames++;
    if (now - fpsT > 500) {
      fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now;
      block(fStats, 'Glade', `${stats.models} rigged models · ${stats.parts} parts · ${fps} fps`);
      const f = wind.forceAt(controls.target.x, controls.target.z);
      block(fWind, 'Wind here', `toward ${valueFor('dir')}° · force ${f.toFixed(2)} · gust ${wind.gustAt(controls.target.x, controls.target.z).toFixed(2)}`);
    }
  }
  await loadGlade();
  return {
    show() { running = true; resize(); last = performance.now(); renderer.setAnimationLoop(frame); },
    hide() { running = false; renderer.setAnimationLoop(null); },
    wind, scene, camera, controls, renderer,
    setDebug(v) { debug = v; applyDebug(); },
    stats: () => ({ ...stats, fps }),
  };
}
