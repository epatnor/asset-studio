// Gemensam scen för Tinkertowns visningssidor: rendering, himmel, ljus enligt stilguiden, vind,
// modell-laddning, skyltar och förstapersonskamera. Ren klientkod (ingen Node).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { shareTextures } from './shared_textures.js';
import { createMaterialPatcher, applyShadowRole } from './materials.js';
import { createAtmosphere } from './atmosphere.js';
import { createEffects, createFogUniforms } from './effects.js';

export function createWorld(container, { fog = [60, 220], time = 10, weather = 'klart', atmosphere = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping; // stilguiden: AgX
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // mjuk sedan r182 (PCFSoftShadowMap är borttagen), lika snabb som förr i Skogen
  renderer.shadowMap.autoUpdate = false;        // skuggorna ritas om i takt, se animationsloopen
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const SKY = new THREE.Color('#8fbdf0'), HORIZON = new THREE.Color('#d9ecff');
  scene.fog = new THREE.Fog(HORIZON, fog[0], fog[1]);
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: SKY }, bottom: { value: HORIZON } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 1.6, 0., 1.); gl_FragColor = vec4(mix(bottom, top, h), 1.); }',
  }));
  scene.add(skyMesh); // enkel gradient; atmosfären (atmosphere.js) ersätter den
  const hemi = new THREE.HemisphereLight('#cfe6ff', '#5d7a3a', 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffe9c7', 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  // Solen står alltid i samma riktning; skuggområdet flyttas. I förstapersonsläget följer det spelaren
  // (en mindre yta ger skarpare skuggor för samma kartstorlek), annars täcker det hela området.
  const SUN_DIR = new THREE.Vector3(0.6, 1.1, 0.8).normalize(); // ändras av atmosfären (tid på dygnet)
  let baseArea = null;
  const placeShadow = (center, radius) => {
    lastArea = { center: center.clone(), radius };
    sun.position.copy(center).addScaledVector(SUN_DIR, radius * 2);
    sun.target.position.copy(center);
    Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 1, far: radius * 4 });
    sun.shadow.camera.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;
  };
  let lastArea = null;
  const setSunDir = (d) => {
    if (SUN_DIR.angleTo(d) < 0.002) return;
    SUN_DIR.copy(d).normalize();
    if (lastArea) placeShadow(lastArea.center, lastArea.radius);
  };
  const setShadowArea = (center, radius) => { baseArea = { center: center.clone(), radius }; placeShadow(center, radius); };
  const FOLLOW_R = 32, followAt = new THREE.Vector3(Infinity, 0, 0);
  function updateShadowArea() {
    if (!fp.active) { if (baseArea && followAt.x !== Infinity) { placeShadow(baseArea.center, baseArea.radius); followAt.x = Infinity; } return; }
    // Mitt i synfältet en bit framför spelaren, avrundat till hela kartpixlar så att skuggkanterna inte darrar
    const texel = (FOLLOW_R * 2) / sun.shadow.mapSize.x, step = texel * 16;
    const c = new THREE.Vector3(fp.pos.x - Math.sin(fp.yaw) * FOLLOW_R * 0.45, fp.pos.y, fp.pos.z - Math.cos(fp.yaw) * FOLLOW_R * 0.45);
    c.set(Math.round(c.x / step) * step, Math.round(c.y / step) * step, Math.round(c.z / step) * step);
    if (c.distanceTo(followAt) > 0) { followAt.copy(c); placeShadow(c, FOLLOW_R); }
  }

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  // Vind: läser generatorernas _WIND-attribut (0 vid stammen, 1 i spetsarna)
  const wind = { uTime: { value: 0 }, uWind: { value: 0.6 } };
  // Generatorernas material får vind, platta stjälkar, lövens genomlysning och stenarnas mossa (materials.js)
  const foliage = { uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5).normalize() } };
  const snow = { value: 0 }; // snömängd, sätts av atmosfären
  const fogU = createFogUniforms(THREE); // dimma, markdimma och molnskuggor (effects.js), sätts av atmosfären
  const patchMaterial = createMaterialPatcher(THREE, { wind, sunDir: foliage.uSunDir, snow, fogU });
  const addWind = (material, url = location.href) => patchMaterial(material, url);

  const loader = shareTextures(new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)) // geometrin är meshopt-komprimerad;
  const models = [];
  async function loadModel(url) {
    const root = (await loader.loadAsync(url)).scene;
    root.traverse((o) => {
      if (o.isMesh) { o.castShadow = o.receiveShadow = true; applyShadowRole(o); addWind(o.material, url); }
      const lod = o.name.match(/_LOD(\d)$/);
      if (lod) o.visible = lod[1] === '0';
    });
    models.push(root);
    return root;
  }
  const setLod = (n) => models.forEach((root) => root.traverse((o) => {
    const m = o.name.match(/_LOD(\d)$/);
    if (m) o.visible = Number(m[1]) === n;
  }));
  const measure = (root) => {
    const box = new THREE.Box3().setFromObject(root, true);
    let hasTrunk = false;
    root.traverse((o) => { if (o.isMesh && /_trunk_LOD0$/.test(o.name)) hasTrunk = true; });
    return { box, size: box.getSize(new THREE.Vector3()), hasTrunk };
  };

  // Skyltar: små träskyltar med målad text
  const signs = [];
  const postMat = new THREE.MeshStandardMaterial({ color: '#7a5636', roughness: 0.9 });
  function makeSign(text, tint, scale = 1) {
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    const font = 'bold 44px system-ui, sans-serif';
    ctx.font = font;
    c.width = Math.ceil(ctx.measureText(text).width + (tint ? 46 : 0) + 48); c.height = 84;
    ctx.fillStyle = '#c59a62'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = 'rgba(110, 72, 38, 0.35)'; ctx.lineWidth = 2;
    for (let y = 12; y < c.height; y += 14) { ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(c.width * 0.3, y - 3, c.width * 0.7, y + 4, c.width, y); ctx.stroke(); }
    ctx.strokeStyle = '#7a5636'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, c.width - 6, c.height - 6);
    ctx.font = font; ctx.fillStyle = '#3b2615'; ctx.textBaseline = 'middle'; ctx.fillText(text, 24, c.height / 2 + 2);
    if (tint) { ctx.fillStyle = tint; ctx.beginPath(); ctx.arc(c.width - 34, c.height / 2, 14, 0, Math.PI * 2); ctx.fill(); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const h = 0.24 * scale, w = h * (c.width / c.height);
    const wood = new THREE.MeshStandardMaterial({ color: '#a77d4c', roughness: 0.9 });
    const sign = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.035 * scale), [wood, wood, wood, wood, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }), wood]);
    board.position.y = 0.5 * scale;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.05 * scale, 0.9 * scale, 0.05 * scale), postMat);
    post.position.set(0, 0.15 * scale, -0.03 * scale); // stolpen går ner i marken
    for (const m of [board, post]) { m.castShadow = m.receiveShadow = true; sign.add(m); }
    sign.rotation.set((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.1);
    signs.push(sign);
    return sign;
  }

  // Förstapersonskamera i ögonhöjd, som följer marken (heightAt)
  const colliders = [];
  const fp = { active: false, pos: new THREE.Vector3(), yaw: 0, pitch: -0.05, vel: 0, onGround: true, keys: new Set(), heightAt: () => 0 };
  const EYE = 1.65;
  const setMode = (active) => {
    fp.active = active;
    controls.enabled = !active;
    if (!active && document.pointerLockElement) document.exitPointerLock();
  };
  // Pointer lock går inte överallt (t.ex. i inbäddade webbläsare); då tittar man runt genom att dra med musen
  let lockFailed = false;
  document.addEventListener('pointerlockerror', () => { lockFailed = true; });
  renderer.domElement.addEventListener('click', () => {
    if (!fp.active) setMode(true);
    try { Promise.resolve(renderer.domElement.requestPointerLock()).catch(() => { lockFailed = true; }); } catch { lockFailed = true; }
  });
  addEventListener('mousemove', (e) => {
    const locked = document.pointerLockElement === renderer.domElement;
    if (!fp.active || !(locked || (lockFailed && e.buttons & 1))) return;
    fp.yaw -= e.movementX * 0.0022;
    fp.pitch = THREE.MathUtils.clamp(fp.pitch - e.movementY * 0.0022, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'Tab') { e.preventDefault(); setMode(!fp.active); return; }
    fp.keys.add(e.code);
    if (e.code === 'Space' && fp.active && fp.onGround) { fp.vel = 5; fp.onGround = false; }
  });
  addEventListener('keyup', (e) => fp.keys.delete(e.code));
  function updateFp(dt) {
    const k = fp.keys;
    const fwd = new THREE.Vector3(-Math.sin(fp.yaw), 0, -Math.cos(fp.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3();
    if (k.has('KeyW')) move.add(fwd);
    if (k.has('KeyS')) move.sub(fwd);
    if (k.has('KeyD')) move.add(right);
    if (k.has('KeyA')) move.sub(right);
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? 7.5 : 3.2;
    if (move.lengthSq() > 0) fp.pos.add(move.normalize().multiplyScalar(speed * dt));
    for (const c of colliders) {
      const dx = fp.pos.x - c.x, dz = fp.pos.z - c.z, min = c.r + 0.35, d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-8) { const d = Math.sqrt(d2); fp.pos.x = c.x + (dx / d) * min; fp.pos.z = c.z + (dz / d) * min; }
    }
    const ground = fp.heightAt(fp.pos.x, fp.pos.z);
    fp.vel -= 14 * dt;
    fp.pos.y += fp.vel * dt;
    if (fp.pos.y <= ground) { fp.pos.y = ground; fp.vel = 0; fp.onGround = true; }
    camera.position.set(fp.pos.x, fp.pos.y + EYE, fp.pos.z);
    camera.rotation.set(fp.pitch, fp.yaw, 0, 'YXZ');
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  const timer = new THREE.Timer();
  const frameHooks = [];
  let frame = 0;
  const onFrame = (fn) => frameHooks.push(fn);
  const runFrameHooks = (dt) => { for (const fn of frameHooks) fn(dt); };
  const tick = (t) => {
    timer.update(t);
    const dt = Math.min(timer.getDelta(), 0.05);
    wind.uTime.value = timer.getElapsed();
    if (fp.active) updateFp(dt); else controls.update();
    updateShadowArea();
    // Skuggkartan ritas om var tredje bild (20 gånger/s räcker för träd som svajar), eller när området flyttats
    if (++frame % 3 === 0) renderer.shadowMap.needsUpdate = true;
    foliage.uSunDir.value.subVectors(sun.position, sun.target.position).normalize();
    runFrameHooks(dt);
    if (W.fx) W.fx.render(); else renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(tick);
  // Mätningar kan stoppa loopen och rita själva (runFrameHooks uppdaterar LOD och gräsrutor först)
  const setRunning = (on) => renderer.setAnimationLoop(on ? tick : null);

  const W = { snow, fogU, THREE, renderer, scene, camera, controls, sun, hemi, skyMesh, setSunDir, setShadowArea, wind, addWind, loadModel, setLod, measure, makeSign, signs, colliders, fp, setMode, onFrame, runFrameHooks, setRunning, foliage };
  if (atmosphere) { W.atmo = createAtmosphere(W, { time, weather, ...(typeof atmosphere === 'object' ? atmosphere : {}) }); W.fx = createEffects(W); }
  return W;
}
