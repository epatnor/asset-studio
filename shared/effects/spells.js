// Besvärjelser i Häxkitteln (docs/effektlabb.md, E6): en effekt är en tidsatt komposition av lager som samarbetar,
// enligt AAA-referensen (patriks_input/AAA_Game_VFX_ThreeJS_Reference.md, avsnitt 5): förvarning, en kort blixt,
// silhuetten som växer, gnistor, rök och glöd som dör ut. Tidslinjerna är data (tools/vfx/vfx.json, "spells"); här
// finns lagren och spelaren.
//
// Lagren utöver vfx.js (partiklar, markör, aura): lågor (FX03, kort mot kameran med brusvriden låga), blixt (FX05,
// förgrenade band som slumpas om), spjut av is eller sten (FX06, facetterade koner med kantglöd som reser sig i en våg),
// ljusblixt (FX02), chockring på marken (FX01), brännmärke (dekal), portal (FX09), ljus, projektil med svans och
// skärmeffekter (FX10): chockvåg och värmedallring i bilden och en kameraknyck, som värden ritar (post()).
//
//   const spell = createSpell(settings, { spells, defaults, anchors, ground, groundY });
//   spell.play(time); spell.update(time, { camera, wind }); spell.post(time) -> { shocks, hazes, shake }
import * as THREE from 'three/webgpu';
import {
  uniform, float, vec2, vec3, uv, instanceIndex, hash, sin, cos, exp, mix, smoothstep, select, length, atan, pow, max,
  clamp, abs, normalize, dot, uint, mx_noise_float, positionView, normalView, PI2, varying, attribute,
} from 'three/tsl';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { createParticles, createMarker, createAura, createRibbon, softFade } from './vfx.js';

const easeOut = (x) => 1 - (1 - x) ** 3;
const easeBack = (x) => { const c = 1.9; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const additiveMat = (Cls, extra = {}) => new Cls({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...extra });

// --- Lågor (FX03): kort mot kameran, var och en en låga som smalnar uppåt, vriden av stigande brus ---
export function createFlames(s, { at } = {}) {
  const C = (c) => uniform(new THREE.Color(c));
  const u = { time: uniform(0), origin: uniform(new THREE.Vector3()), radius: uniform(0.2), height: uniform(1), width: uniform(0.5),
    inner: C('#fff2a0'), outer: C('#ff4a0a'), intensity: uniform(2), speed: uniform(1), fade: uniform(1), soft: uniform(0.25) };
  const h = (k) => hash(instanceIndex.mul(uint(8)).add(uint(k)));
  const ang = float(instanceIndex).mul(2.39996), rr = u.radius.mul(h(0).sqrt());
  const hc = u.height.mul(h(1).mul(0.5).add(0.5)).mul(select(instanceIndex.equal(uint(0)), float(1.25), float(1)));
  const wc = u.width.mul(h(2).mul(0.5).add(0.75));
  const mat = additiveMat(THREE.SpriteNodeMaterial);
  mat.positionNode = u.origin.add(vec3(cos(ang).mul(rr), hc.mul(0.42), sin(ang).mul(rr)));
  mat.scaleNode = vec2(wc, hc);
  mat.rotationNode = sin(u.time.mul(2.3).add(h(3).mul(9))).mul(0.06);
  const seed = varying(h(4));
  const t = u.time.mul(u.speed).add(seed.mul(13));
  const y = uv().y, x = uv().x;
  const wind = mx_noise_float(vec3(y.mul(3).sub(t.mul(1.5)), t.mul(0.3), seed.mul(7))).mul(0.24).mul(y);
  const turb = mx_noise_float(vec3(x.mul(8), y.mul(8).sub(t.mul(3)), seed.mul(3))).mul(0.14).mul(y);
  const hw = pow(max(float(1).sub(y), 0), 1.25).mul(0.42).add(0.018);
  const dist = abs(x.sub(0.5).sub(wind).sub(turb));
  const flame = float(1).sub(smoothstep(hw.mul(0.65), hw, dist)).mul(smoothstep(0, 0.12, y)).mul(float(1).sub(smoothstep(0.7, 1, y)));
  const core = clamp(float(1).sub(smoothstep(0, hw.mul(0.48), dist)).mul(pow(max(float(1).sub(y), 0), 0.5)), 0, 1);
  mat.colorNode = mix(u.outer, u.inner, core).mul(core.mul(3).add(0.8)).mul(u.intensity);
  mat.opacityNode = clamp(flame.mul(u.fade).mul(softFade(u.soft)), 0, 1);
  const sprite = new THREE.Sprite(mat);
  sprite.frustumCulled = false;
  sprite.renderOrder = 7;
  let base = s;
  const fx = {
    object: sprite, uniforms: u,
    set(v) { base = v; sprite.count = Math.max(1, Math.round(v.count ?? 8)); u.inner.value.set(v.inner); u.outer.value.set(v.outer); u.intensity.value = v.intensity ?? 2; u.speed.value = v.speed ?? 1; u.width.value = v.width ?? 0.5; },
    place(p) { u.origin.value.copy(p); },
    // lt: lagrets förlopp 0–1; radien och höjden går från start- till slutvärdet (ett klot av eld som vidgas och sjunker)
    update(time, lt = 0) {
      u.time.value = time;
      const e = easeOut(clamp01(lt));
      u.radius.value = base.radius + ((base.radiusEnd ?? base.radius) - base.radius) * e;
      u.height.value = base.height + ((base.heightEnd ?? base.height) - base.height) * e;
    },
    setFade(f) { u.fade.value = f; },
    dispose() { mat.dispose(); },
  };
  fx.set(s);
  if (at) fx.place(at);
  return fx;
}

// --- Blixt (FX05): huvudstrålen och grenar med mittpunktsförskjutning, band mot kameran, slumpas om med ojämna mellanrum ---
export function createLightning(s) {
  const C = (c) => uniform(new THREE.Color(c));
  const u = { color: C(s.color), core: C(s.core ?? '#ffffff'), intensity: uniform(s.intensity ?? 3), flick: uniform(1), fade: uniform(1) };
  const MAXP = 360;
  const mk = (glow) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MAXP * 2 * 2), 2).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(MAXP * 6), 1).setUsage(THREE.DynamicDrawUsage));
    const m = additiveMat(THREE.MeshBasicNodeMaterial, { side: THREE.DoubleSide });
    const v = uv().y.sub(0.5);
    const core = exp(v.mul(v).div(glow ? 0.08 : 0.018).negate());
    m.colorNode = mix(u.color, u.core, glow ? core.mul(0.2) : core).mul(u.intensity).mul(u.flick).mul(glow ? 0.6 : 1.6);
    m.opacityNode = clamp(core.mul(u.fade).mul(glow ? 0.55 : 1), 0, 1);
    const mesh = new THREE.Mesh(geo, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    return mesh;
  };
  const glow = mk(true), main = mk(false);
  const group = new THREE.Group();
  group.add(glow, main);
  let lines = [], next = 0, base = s;
  const from = new THREE.Vector3(), to = new THREE.Vector3();
  const rnd = (a = -1, b = 1) => a + Math.random() * (b - a);
  // Mittpunktsförskjutning: varje halvering flyttar mitten vinkelrätt mot strålen, mindre för varje nivå
  function bolt(a, b, levels, jit) {
    let pts = [a.clone(), b.clone()];
    const d = new THREE.Vector3().subVectors(b, a), len = d.length();
    const p1 = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
    if (p1.lengthSq() < 1e-6) p1.set(1, 0, 0);
    p1.normalize();
    const p2 = new THREE.Vector3().crossVectors(d, p1).normalize();
    let amp = jit * len * 0.25;
    for (let l = 0; l < levels; l++) {
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const m = pts[i].clone().lerp(pts[i + 1], 0.5).addScaledVector(p1, rnd() * amp).addScaledVector(p2, rnd() * amp);
        out.push(m, pts[i + 1]);
      }
      pts = out;
      amp *= 0.55;
    }
    return pts;
  }
  function regen() {
    const w = base.width ?? 0.08;
    lines = [{ pts: bolt(from, to, 5, base.jitter ?? 0.5), w }];
    const mainPts = lines[0].pts, dir = new THREE.Vector3().subVectors(to, from);
    for (let b = 0; b < (base.branches ?? 3); b++) {
      const i = Math.floor(mainPts.length * rnd(0.15, 0.75));
      const st = mainPts[i];
      const bd = dir.clone().multiplyScalar(rnd(0.15, 0.4)).add(new THREE.Vector3(rnd(), rnd(-0.6, 0.6), rnd()).multiplyScalar(dir.length() * 0.22));
      lines.push({ pts: bolt(st, st.clone().add(bd), 3, 0.6), w: w * 0.45 });
    }
    u.flick.value = rnd(0.55, 1.1);
  }
  const toCam = new THREE.Vector3(), tan = new THREE.Vector3(), side = new THREE.Vector3();
  function strip(mesh, widthMul, camera) {
    const pos = mesh.geometry.attributes.position.array, uvs = mesh.geometry.attributes.uv.array, idx = mesh.geometry.index.array;
    let n = 0, k = 0;
    for (const ln of lines) {
      const P = ln.pts, first = n;
      for (let i = 0; i < P.length && n < MAXP; i++, n++) {
        tan.subVectors(P[Math.min(i + 1, P.length - 1)], P[Math.max(i - 1, 0)]).normalize();
        toCam.subVectors(camera.position, P[i]).normalize();
        side.crossVectors(tan, toCam).normalize();
        const t = i / (P.length - 1), w = ln.w * widthMul * (1 - 0.55 * t) * 0.5;
        for (const sg of [-1, 1]) {
          const j = n * 2 + (sg > 0 ? 1 : 0);
          pos[j * 3] = P[i].x + side.x * w * sg; pos[j * 3 + 1] = P[i].y + side.y * w * sg; pos[j * 3 + 2] = P[i].z + side.z * w * sg;
          uvs[j * 2] = t; uvs[j * 2 + 1] = sg > 0 ? 1 : 0;
        }
        if (i > 0) { const a = (n - 1) * 2, c = n * 2; idx.set([a, a + 1, c, a + 1, c + 1, c], k); k += 6; }
      }
      if (n - first < 2) break;
    }
    mesh.geometry.setDrawRange(0, k);
    mesh.geometry.attributes.position.needsUpdate = mesh.geometry.attributes.uv.needsUpdate = mesh.geometry.index.needsUpdate = true;
  }
  const fx = {
    object: group, uniforms: u,
    set(v) { base = v; u.color.value.set(v.color); u.core.value.set(v.core ?? '#ffffff'); u.intensity.value = v.intensity ?? 3; },
    ends(a, b) { from.copy(a); to.copy(b); },
    start() { next = 0; },
    update(time, lt, { camera } = {}) {
      if (!camera) return;
      if (time >= next) { regen(); next = time + (base.regen ?? 0.08) * rnd(0.5, 1.5); }
      strip(glow, 5, camera);
      strip(main, 1, camera);
    },
    setFade(f) { u.fade.value = f; },
    dispose() { for (const m of [glow, main]) { m.geometry.dispose(); m.material.dispose(); } },
  };
  fx.set(s);
  return fx;
}

// --- Spjut (FX06): facetterade koner av is eller sten som reser sig i en våg längs en linje eller i en ring, med
// kantglöd (fresnel), och som sjunker undan på slutet ---
export function createSpikes(s, { from, to, groundY }) {
  const N = Math.max(1, Math.round(s.count ?? 14));
  const geo = new THREE.ConeGeometry(1, 1, 6, 1).translate(0, 0.5, 0).toNonIndexed();
  geo.computeVertexNormals();
  const u = { rim: uniform(new THREE.Color(s.rim ?? '#bfefff')), rimStrength: uniform(s.rimStrength ?? 1.5), fade: uniform(1) };
  const mat = new THREE.MeshStandardNodeMaterial({ color: s.color ?? '#7fc8e8', roughness: s.roughness ?? 0.2, metalness: 0, flatShading: true });
  const nv = abs(dot(normalize(normalView), normalize(positionView).negate()));
  mat.emissiveNode = u.rim.mul(pow(float(1).sub(nv), 3)).mul(u.rimStrength).mul(u.fade);
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const dir = new THREE.Vector3().subVectors(to, from).setY(0);
  const len = dir.length();
  dir.normalize();
  const perp = new THREE.Vector3(-dir.z, 0, dir.x);
  const spikes = [];
  for (let i = 0; i < N; i++) {
    const k = (i + 0.5) / N;
    let p, d;
    if (s.mode === 'ring') {
      const a = (i / N) * Math.PI * 2 + Math.random() * 0.3, r = (s.radius ?? 1.4) * (0.75 + Math.random() * 0.4);
      p = to.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      d = r;
    } else {
      d = 0.6 + k * Math.max(0.5, len - 0.6);
      p = from.clone().addScaledVector(dir, d).addScaledVector(perp, (Math.random() - 0.5) * (s.spread ?? 0.7));
    }
    p.y = (groundY?.(p.x, p.z) ?? p.y) - 0.08;
    // Lutar ut från linjen (eller ringens mitt), större mot målet
    const out = s.mode === 'ring' ? p.clone().sub(to).setY(0).normalize() : perp.clone().multiplyScalar(Math.sign(Math.random() - 0.5));
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(out.z, 0, -out.x).normalize(), -(0.15 + Math.random() * 0.4));
    const q = tilt.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6.28));
    const grow = s.mode === 'ring' ? 1 : 0.6 + 0.6 * k;
    spikes.push({ p, q, d, h: (s.height ?? 1.4) * grow * (0.65 + Math.random() * 0.5), w: (s.width ?? 0.22) * grow * (0.7 + Math.random() * 0.5) });
  }
  const M = new THREE.Matrix4(), S = new THREE.Vector3();
  const fx = {
    object: mesh, uniforms: u,
    set(v) { mat.color.set(v.color ?? '#7fc8e8'); u.rim.value.set(v.rim ?? '#bfefff'); u.rimStrength.value = v.rimStrength ?? 1.5; mat.roughness = v.roughness ?? 0.2; },
    // t: sekunder sedan lagret började, dur: hela lagrets längd (sista sink sekunderna sjunker de undan)
    update(time, lt, { t = 0, dur = 2 } = {}) {
      const sink = s.sink ?? 0.35, wave = Math.max(0.5, s.wave ?? 8);
      spikes.forEach((sp, i) => {
        let g = easeBack(clamp01((t - sp.d / wave) / 0.16));
        if (t > dur - sink) g *= 1 - easeOut(clamp01((t - (dur - sink)) / sink));
        g = Math.max(0, g);
        M.compose(sp.p, sp.q, S.set(sp.w * (0.4 + 0.6 * Math.min(1, g)), sp.h * g + 1e-4, sp.w * (0.4 + 0.6 * Math.min(1, g))));
        mesh.setMatrixAt(i, M);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
    setFade(f) { u.fade.value = f; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
  return fx;
}

// --- Ljusblixt (FX02): en kort het stjärna och ett ljus som slocknar fort ---
export function createFlash(s, { at }) {
  const u = { color: uniform(new THREE.Color(s.color ?? '#ffffff')), k: uniform(0), fade: uniform(1), intensity: uniform(s.intensity ?? 4) };
  const mat = additiveMat(THREE.SpriteNodeMaterial);
  const p = uv().mul(2).sub(1), d = length(p), inv = clamp(float(1).sub(d), 0, 1);
  const rays = clamp(float(0.02).div(abs(p.x.mul(p.y)).add(0.02)), 0, 1).mul(inv);
  mat.colorNode = u.color.mul(u.intensity).mul(inv.mul(inv).add(rays.mul(0.6)).add(smoothstep(0.25, 0, d).mul(2)));
  mat.opacityNode = clamp(float(1).sub(u.k).mul(u.fade), 0, 1).mul(inv.add(rays));
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(at);
  sprite.renderOrder = 9;
  const light = new THREE.PointLight(s.color ?? '#ffffff', 0, 10, 2);
  light.position.copy(at);
  const group = new THREE.Group();
  group.add(sprite, light);
  return {
    object: group, uniforms: u,
    set(v) { u.color.value.set(v.color); light.color.set(v.color); u.intensity.value = v.intensity ?? 4; s = v; },
    update(time, lt) {
      const k = 1 - Math.exp(-lt * 5);
      u.k.value = k;
      sprite.scale.setScalar((s.size ?? 1.5) * (0.5 + 0.8 * easeOut(clamp01(lt * 2))));
      light.intensity = (s.light ?? 20) * (1 - clamp01(lt)) ** 2 * u.fade.value;
    },
    setFade(f) { u.fade.value = f; },
    dispose() { mat.dispose(); },
  };
}

// --- Chockring på marken (FX01): en tunn ljus ring som vidgas, en kärna som tonar och ekrar ---
export function createRing(s, { at }) {
  const u = { color: uniform(new THREE.Color(s.color ?? '#ffb060')), k: uniform(0), fade: uniform(1), intensity: uniform(s.intensity ?? 2.5), width: uniform(s.thickness ?? 0.03) };
  const mat = additiveMat(THREE.MeshBasicNodeMaterial, { polygonOffset: true, polygonOffsetFactor: -6 });
  const p = uv().mul(2).sub(1), r = length(p);
  const rad = mix(float(0.04), float(0.95), u.k);
  const ring = exp(r.sub(rad).div(u.width).pow(2).negate());
  const ring2 = exp(r.sub(rad.mul(0.72)).div(u.width.mul(0.6)).pow(2).negate()).mul(0.45);
  const inner = exp(r.mul(-5)).mul(float(1).sub(u.k));
  const spokes = pow(abs(sin(atan(p.y, p.x).mul(12).add(u.k.mul(6)))), 18).mul(0.25);
  const fadeOut = float(1).sub(smoothstep(0.6, 1, u.k)).mul(float(1).sub(smoothstep(0.92, 1, r)));
  const I = ring.mul(2.5).add(ring2).add(inner).add(ring.mul(spokes)).mul(fadeOut).mul(u.fade);
  mat.colorNode = u.color.mul(I).mul(u.intensity);
  mat.opacityNode = clamp(I.mul(0.7), 0, 1);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), mat);
  mesh.position.copy(at).y += 0.04;
  mesh.scale.setScalar(s.radius ?? 2);
  mesh.renderOrder = 5;
  return {
    object: mesh, uniforms: u,
    set(v) { u.color.value.set(v.color); u.intensity.value = v.intensity ?? 2.5; mesh.scale.setScalar(v.radius ?? 2); },
    update(time, lt) { u.k.value = easeOut(clamp01(lt)); },
    setFade(f) { u.fade.value = f; },
    dispose() { mesh.geometry.dispose(); mat.dispose(); },
  };
}

// --- Brännmärke: en dekal på marken med brusig kant och glöd som slocknar ---
export function createScorch(s, { at, ground }) {
  const u = { ember: uniform(new THREE.Color(s.ember ?? '#ff6a1a')), dark: uniform(new THREE.Color(s.color ?? '#120a06')), k: uniform(0), fade: uniform(1), seed: uniform(Math.random() * 50) };
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
  const p = uv().mul(2).sub(1), r = length(p);
  const n = mx_noise_float(vec3(p.mul(2.5), u.seed)).mul(0.5).add(mx_noise_float(vec3(p.mul(6), u.seed.add(3))).mul(0.25));
  const mask = float(1).sub(smoothstep(0.45, 0.95, r.add(n.mul(0.35))));
  const cracks = pow(clamp(float(1).sub(abs(mx_noise_float(vec3(p.mul(5), u.seed.add(9))))), 0, 1), 10);
  const heat = clamp(float(1).sub(u.k.mul(1.4)), 0, 1);
  mat.colorNode = mix(u.dark, u.ember.mul(4), cracks.mul(heat).mul(smoothstep(0.85, 0.2, r)));
  mat.opacityNode = clamp(mask.mul(0.88).add(cracks.mul(heat)), 0, 1).mul(u.fade);
  const size = (s.radius ?? 1) * 2;
  const mesh = new THREE.Mesh(new DecalGeometry(ground, at, new THREE.Euler(-Math.PI / 2, 0, Math.random() * 6.28), new THREE.Vector3(size, size, 4)), mat);
  mesh.renderOrder = 3;
  return {
    object: mesh, uniforms: u,
    set() {},
    update(time, lt) { u.k.value = lt; },
    setFade(f) { u.fade.value = f; },
    dispose() { mesh.geometry.dispose(); mat.dispose(); },
  };
}

// --- Portal (FX09): en stående skiva i polära koordinater med virvlande trådar, ljus kant och en mörk mitt ---
export function createPortal(s, { at }) {
  const C = (c) => uniform(new THREE.Color(c));
  const u = { time: uniform(0), c1: C(s.color ?? '#7a3cff'), c2: C(s.color2 ?? '#3a8cff'), c3: C(s.core ?? '#140428'), intensity: uniform(s.intensity ?? 2), fade: uniform(1), open: uniform(0) };
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const p = uv().mul(2).sub(1).div(max(u.open, 0.02)), r = length(p), a = atan(p.y, p.x);
  const warp = mx_noise_float(vec3(p.mul(2.2), u.time.mul(0.4))).mul(0.6);
  const swirl = sin(a.mul(7).sub(r.mul(16)).add(u.time.mul(2.8)).add(warp.mul(3)));
  const fil = pow(swirl.mul(0.5).add(0.5), 6);
  const rim = exp(r.sub(0.84).div(0.07).pow(2).negate());
  const center = exp(r.mul(-4));
  const mask = float(1).sub(smoothstep(0.84, 1, r));
  mat.colorNode = mix(u.c3, u.c1, fil).add(u.c2.mul(rim).mul(2.7)).add(u.c1.mul(center).mul(0.6)).mul(u.intensity);
  mat.opacityNode = clamp(mask.mul(0.92).add(rim), 0, 1).mul(u.fade);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const R = s.radius ?? 1.1;
  mesh.scale.setScalar(R);
  mesh.position.copy(at).y += R + 0.1;
  mesh.renderOrder = 6;
  return {
    object: mesh, uniforms: u,
    set(v) { u.c1.value.set(v.color); u.c2.value.set(v.color2); u.intensity.value = v.intensity ?? 2; },
    update(time, lt, { camera, t = 0 } = {}) {
      u.time.value = time;
      u.open.value = easeBack(clamp01(t / 0.7));
      if (camera) mesh.rotation.y = Math.atan2(camera.position.x - mesh.position.x, camera.position.z - mesh.position.z);
    },
    setFade(f) { u.fade.value = f; },
    dispose() { mesh.geometry.dispose(); mat.dispose(); },
  };
}

// --- Ljus: ett punktljus med en kurva (slocknar, eller fladdrar så länge lagret pågår) ---
export function createLight(s, { at }) {
  const light = new THREE.PointLight(s.color ?? '#ffffff', 0, s.distance ?? 9, 2);
  light.position.copy(at).y += s.lift ?? 0.4;
  let fade = 1;
  return {
    object: light,
    set(v) { light.color.set(v.color); s = v; },
    update(time, lt) {
      const curve = s.flicker ? 1 - s.flicker * (0.5 + 0.5 * Math.sin(time * 17.3) * Math.sin(time * 7.1 + 1.3)) : (1 - clamp01(lt)) ** 2;
      light.intensity = (s.intensity ?? 10) * curve * fade;
    },
    setFade(f) { fade = f; },
    dispose() {},
  };
}

// --- Projektil: ett glödande huvud av lågor och en het kärna, ett band efter sig, rök och gnistor längs vägen ---
export function createBolt(s, { from, to, defaults }) {
  const group = new THREE.Group();
  const flight = from.distanceTo(to) / Math.max(1, s.speed ?? 12);
  const arc = s.arc ?? 0.6;
  const pathAt = (k, out) => out.lerpVectors(from, to, k).setY(out.y + arc * 4 * k * (1 - k));
  const size = s.size ?? 0.3;
  const head = createFlames({ count: 7, radius: size * 0.25, height: size * 2.6, width: size * 1.6, inner: s.inner ?? '#fff2a0', outer: s.color ?? '#ff4a0a', intensity: s.intensity ?? 2.5, speed: 2.2, soft: 0 });
  const coreMat = additiveMat(THREE.SpriteNodeMaterial);
  const cd = length(uv().mul(2).sub(1));
  const cu = { color: uniform(new THREE.Color(s.inner ?? '#fff2a0')), fade: uniform(1) };
  coreMat.colorNode = cu.color.mul(pow(clamp(float(1).sub(cd), 0, 1), 2).mul(4).mul(s.intensity ?? 2.5));
  coreMat.opacityNode = clamp(float(1).sub(cd), 0, 1).mul(cu.fade);
  const core = new THREE.Sprite(coreMat);
  core.scale.setScalar(size * 2.2);
  const light = new THREE.PointLight(s.color ?? '#ff6a1a', 0, 7, 2);
  const ribbon = createRibbon(120);
  const rMat = additiveMat(THREE.MeshBasicNodeMaterial, { side: THREE.DoubleSide });
  const ru = { time: uniform(0), len: uniform(s.trail ?? 0.35), head: uniform(new THREE.Color(s.inner ?? '#fff2a0')), tail: uniform(new THREE.Color(s.color ?? '#ff4a0a')), glow: uniform(s.intensity ?? 2.5), fade: uniform(1) };
  const lt = clamp(ru.time.sub(attribute('aBorn', 'float')).div(ru.len), 0, 1), sd = attribute('aSide', 'float');
  const across = float(1).sub(abs(sd.mul(2).sub(1)));
  const oth = attribute('aOther', 'vec3');
  const P0 = attribute('position', 'vec3');
  rMat.positionNode = mix(P0, P0.add(oth).mul(0.5), lt.mul(0.85));
  rMat.colorNode = mix(ru.head, ru.tail, lt).mul(ru.glow).mul(smoothstep(0.2, 1, across).add(0.4));
  rMat.opacityNode = pow(float(1).sub(lt), 1.4).mul(smoothstep(0, 0.6, across)).mul(ru.fade);
  ribbon.mesh.material = rMat;
  const P = (k) => ({ ...defaults.particles, mode: 'loop', ...k });
  const smoke = createParticles(P({ count: s.smoke ?? 60, lifetime: 1.6, lifeVar: 0.4, emit: 'sphere', radius: size * 0.4, speed: 0.3, speedVar: 0.5, spread: 180, gravity: -0.6, drag: 1.2, turbulence: 0.15, flow: 0.25, wind: 0.6,
    sprite: 'smoke', additive: false, sizeStart: size * 1.2, sizeEnd: size * 4, sizeVar: 0.4, spin: 0.6, colorStart: s.smokeColor ?? '#3a2e28', colorMid: '#4a4440', colorEnd: '#5a5652', alpha: 0.45, fadeIn: 0.1, fadeOut: 0.7, glow: 1, soft: 0.4 }), { max: 600 });
  const sparks = createParticles(P({ count: s.sparks ?? 140, lifetime: 0.55, lifeVar: 0.5, emit: 'sphere', radius: size * 0.5, speed: 1.2, speedVar: 0.6, spread: 180, radial: 0.4, gravity: 2.5, drag: 1.4, turbulence: 0.2,
    sprite: 'spark', additive: true, sizeStart: size * 0.3, sizeEnd: 0.01, sizeVar: 0.5, stretch: 1.2, colorStart: s.inner ?? '#fff2a0', colorMid: s.color ?? '#ff4a0a', colorEnd: s.color ?? '#ff4a0a', fadeIn: 0.05, fadeOut: 0.6, glow: (s.intensity ?? 2.5) * 1.2, flicker: 0.3 }), { max: 1000 });
  group.add(head.object, core, light, ribbon.mesh, smoke.object, sparks.object);
  const H = new THREE.Vector3(), Q = new THREE.Vector3(), camV = new THREE.Vector3(), side = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3();
  let t0 = 0;
  return {
    object: group, flight,
    set() {},
    start(time) {
      t0 = time;
      ribbon.clear();
      smoke.path(from, to, arc, time, flight);
      sparks.path(from, to, arc, time, flight);
    },
    update(time, lt, { camera, wind } = {}) {
      const k = (time - t0) / flight, flying = k >= 0 && k <= 1;
      ru.time.value = time;
      smoke.update(time, { wind }); sparks.update(time, { wind });
      head.object.visible = core.visible = flying;
      light.intensity = flying ? (s.light ?? 8) : 0;
      if (flying) {
        pathAt(k, H); pathAt(Math.max(0, k - 0.02), Q);
        head.place(H.clone().setY(H.y - size * 0.6)); head.update(time, 0);
        core.position.copy(H); light.position.copy(H);
        camera?.getWorldDirection(camV);
        side.crossVectors(Q.sub(H).normalize(), camV).normalize().multiplyScalar((s.width ?? size * 1.6) / 2);
        ribbon.push(A.copy(H).sub(side), B.copy(H).add(side), time);
      }
      ribbon.update(time, ru.len.value);
    },
    setFade(f) { ru.fade.value = f; cu.fade.value = f; head.setFade(f); },
    dispose() { head.dispose(); coreMat.dispose(); rMat.dispose(); ribbon.mesh.geometry.dispose(); smoke.dispose(); sparks.dispose(); },
  };
}

// --- Spelaren ---
// Ett lager i tidslinjen: { role, type, anchor, from, to, at, dur, fi, fo, after: 'impact', set: {...} }. at är sekunder
// efter start (eller efter träffen med after: 'impact'), dur lagrets längd (0 = så länge besvärjelsen pågår), fi och
// fo tonar in och ut. I set ersätts '$c1', '$c2' och '$c3' med besvärjelsens färger, och storlekar och styrkor skalas
// med size och intensity.
const SIZE_KEYS = ['radius', 'radiusEnd', 'sizeStart', 'sizeEnd', 'height', 'heightEnd', 'width', 'size', 'speed', 'radial', 'gravity', 'signSize', 'groundRadius', 'pillarRadius', 'pillarHeight', 'moteSize'];
const GLOW_KEYS = ['glow', 'intensity', 'light', 'rimStrength'];
function resolve(set, sp) {
  const out = {};
  for (const [k, v] of Object.entries(set ?? {})) {
    if (typeof v === 'string' && v.startsWith('$c')) out[k] = sp[`color${v.slice(2) === '1' ? '' : v.slice(2)}`] ?? v;
    else if (typeof v === 'number' && SIZE_KEYS.includes(k)) out[k] = v * sp.size;
    else if (typeof v === 'number' && GLOW_KEYS.includes(k)) out[k] = v * sp.intensity;
    else out[k] = v;
  }
  return out;
}

export function createSpell(s, ctx) {
  const def = ctx.spells?.[s.spell];
  if (!def) throw new Error(`unknown spell: ${s.spell}`);
  const A = ctx.anchors;
  const anchor = (name) => (A[name] ?? A.target).clone();
  const D = ctx.defaults ?? {};
  const group = new THREE.Group();
  const layers = [];
  let impact = def.impact ?? 0;
  for (const L of def.layers) {
    if (L.role && s[`layer_${L.role}`] === false) continue;
    const set = resolve(L.set, s);
    const at = anchor(L.anchor ?? 'target');
    let fx;
    switch (L.type) {
      case 'particles': fx = createParticles({ ...D.particles, ...set }, { at, max: 3000 }); break;
      case 'marker': fx = createMarker({ ...D.marker, ...set }, { ground: ctx.ground, at, top: at.y + 1.8 }); break;
      case 'aura': fx = createAura({ ...D.glow, ...set }, { target: L.anchor === 'dummy' ? ctx.dummy : ctx.figure }); break;
      case 'flames': fx = createFlames(set, { at }); break;
      case 'lightning': fx = createLightning(set); fx.ends(anchor(L.from ?? 'hand'), anchor(L.to ?? 'target')); break;
      case 'spikes': fx = createSpikes(set, { from: anchor(L.from ?? 'caster'), to: anchor(L.to ?? 'targetGround'), groundY: ctx.groundY }); break;
      case 'flash': fx = createFlash(set, { at }); break;
      case 'ring': fx = createRing(set, { at }); break;
      case 'scorch': fx = createScorch(set, { at, ground: ctx.ground }); break;
      case 'portal': fx = createPortal(set, { at }); break;
      case 'light': fx = createLight(set, { at }); break;
      case 'bolt': fx = createBolt(set, { from: anchor(L.from ?? 'hand'), to: anchor(L.to ?? 'target'), defaults: D }); impact = (L.at ?? 0) + fx.flight; break;
      case 'shock': case 'haze': case 'shake': fx = { object: null, set() {}, update() {}, setFade() {}, dispose() {} }; break;
      default: continue;
    }
    if (fx.object) { fx.object.visible = false; group.add(fx.object); }
    layers.push({ L, fx, set, at });
  }
  // Tiderna: efter träffen räknas från projektilens ankomst (eller spellens impact)
  let total = 0;
  for (const l of layers) {
    l.start = (l.L.after === 'impact' ? impact : 0) + (l.L.at ?? 0);
    l.dur = l.L.type === 'bolt' ? l.fx.flight + (l.L.dur ?? 0.4) : l.L.dur ?? 0;
    l.end = l.dur > 0 ? l.start + l.dur : Infinity;
    // Partiklar lever vidare efter att utsändningen slutat
    const tail = l.L.type === 'particles' ? (l.set.lifetime ?? D.particles?.lifetime ?? 1) : 0;
    if (l.end < Infinity) total = Math.max(total, l.end + tail);
  }
  let t0 = -1e9, playing = false;
  const env = (l, T) => {
    if (T < l.start || T > l.end) return 0;
    const fi = l.L.fi ?? 0.05, fo = l.L.fo ?? 0.15;
    return Math.min(1, fi > 0 ? (T - l.start) / fi : 1, l.end === Infinity ? 1 : fo > 0 ? (l.end - T) / fo : 1);
  };
  const fx = {
    object: group, loop: true, ambient: !!def.ambient, duration: total, impact,
    set(v) {
      s = v;
      for (const l of layers) { l.set = resolve(l.L.set, s); const full = l.L.type === 'particles' ? { ...D.particles, ...l.set } : l.L.type === 'marker' ? { ...D.marker, ...l.set } : l.L.type === 'aura' ? { ...D.glow, ...l.set } : l.set; l.fx.set?.(full); }
    },
    play(time) { t0 = time; playing = true; for (const l of layers) l.started = false; },
    update(time, c = {}) {
      if (!playing) return;
      const T = time - t0;
      for (const l of layers) {
        const live = T >= l.start;
        if (live && !l.started) {
          l.started = true;
          const st = t0 + l.start;
          if (l.L.type === 'particles') l.fx.play(st, l.dur > 0 ? l.dur : undefined);
          else l.fx.play?.(st);
          l.fx.start?.(st);
        }
        const e = env(l, T);
        const particlesLive = l.L.type === 'particles' && live;
        if (l.fx.object) l.fx.object.visible = particlesLive || e > 0;
        if (!(particlesLive || e > 0)) continue;
        const lt = l.dur > 0 ? (T - l.start) / l.dur : 0;
        l.fx.setFade?.(l.L.type === 'particles' ? 1 : e);
        if (l.L.type === 'particles') l.fx.update(time, c);
        else l.fx.update(time, lt, { ...c, t: T - l.start, dur: l.dur });
      }
    },
    // Skärmeffekterna just nu, för värden: chockvågor och dallring (i världen) och kameraknyck
    post(time) {
      const out = { shocks: [], hazes: [], shake: 0 };
      if (!playing) return out;
      const T = time - t0;
      for (const l of layers) {
        const e = env(l, T);
        if (e <= 0) continue;
        const lt = l.dur > 0 ? (T - l.start) / l.dur : 0;
        if (l.L.type === 'shock') out.shocks.push({ pos: l.at, k: lt, radius: l.set.radius ?? 0.3, strength: (l.set.strength ?? 0.03) * (s.distortion ?? 1) });
        if (l.L.type === 'haze') out.hazes.push({ pos: l.at, radius: l.set.radius ?? 0.12, strength: (l.set.strength ?? 0.006) * (s.distortion ?? 1) * e });
        if (l.L.type === 'shake') out.shake = Math.max(out.shake, (l.set.amount ?? 0.1) * (s.shake ?? 1) * (1 - clamp01(lt)) ** 2);
      }
      return out;
    },
    dispose() { for (const l of layers) l.fx.dispose(); },
  };
  fx.set(s);
  return fx;
}
