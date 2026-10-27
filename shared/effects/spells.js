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
//   const spell = createSpell(settings, { spells, templates, defaults, anchors, ground, groundY });
//   settings.extra: lager som lagts till ur templates (id:n), utöver besvärjelsens egna
//   spell.play(time); spell.update(time, { camera, wind }); spell.post(time) -> { shocks, hazes, shake }
import * as THREE from 'three/webgpu';
import {
  uniform, float, vec2, vec3, uv, instanceIndex, hash, sin, cos, exp, mix, smoothstep, select, length, atan, pow, max,
  clamp, abs, normalize, dot, uint, mx_noise_float, mx_worley_noise_vec2, positionView, normalView, positionLocal, positionWorld,
  texture, PI2, varying, attribute, vec4, cameraViewMatrix,
} from 'three/tsl';
import { createParticles, createMarker, createAura, createRibbon, softFade, depthDecal, decalMesh, placeDecal } from './vfx.js';

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

// --- Spjut (FX06): is eller sten som reser sig i en våg längs ett spår (eller i en ring) ---
// Varje plats i spåret får en klunga av ett till tre spjut av olika modeller (kristallprisma, nål med sned spets, platt
// skärva och kort kristall; för sten taggiga block med trubbig topp och flata hällar), olika långa och tjocka och
// lutade ut från spåret. Is är delvis genomskinlig med strimmor, frost vid foten och en lysande kant; sten har Ateljéns
// klipptextur med normalkarta. Längs spåret spricker marken upp i takt med vågen (en dekal: frusen skorpa med lysande
// sprickor, eller uppriven jord med mörka sprickor), och skärvor och damm eller froströk sprutar upp där vågen går fram.
const TEX_BASE = '/assets/textures/';
const texCache = new Map();
function loadTex(name, srgb = true, base = TEX_BASE) {
  const key = `${base}${name}|${srgb}`;
  if (!texCache.has(key)) {
    const t = new THREE.TextureLoader().load(`${base}${name}.png`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texCache.set(key, t);
  }
  return texCache.get(key);
}
// En spjutmodell: en kon med sidor och höjdsegment som formas om (prisma nedtill, spets upptill), skevas och skakas
// med ett frö, så att ingen ser ut som en annan. Platta ytor (toNonIndexed) ger facetterna.
function spikeGeometry(kind, seed) {
  let st = seed;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296);
  const V = {
    crystal: { seg: 6, prism: 0.62, tip: 0, skew: 0, jit: 0.025, flat: 1 },
    needle: { seg: 5, prism: 0, tip: 0, skew: 0.22, jit: 0.03, flat: 1 },
    shard: { seg: 4, prism: 0.2, tip: 0, skew: 0.12, jit: 0.04, flat: 0.45 },
    stubby: { seg: 6, prism: 0.4, tip: 0, skew: 0.05, jit: 0.03, flat: 1 },
    rock: { seg: 7, prism: 0, tip: 0.16, skew: 0.15, jit: 0.13, flat: 1 },
    slab: { seg: 5, prism: 0.3, tip: 0.1, skew: 0.2, jit: 0.1, flat: 0.5 },
    jag: { seg: 6, prism: 0, tip: 0.05, skew: 0.3, jit: 0.16, flat: 0.85 },
    pillar: { seg: 6, prism: 0.55, tip: 0.22, skew: 0.08, jit: 0.1, flat: 1 },
  }[kind];
  const geo = new THREE.ConeGeometry(1, 1, V.seg, 5).translate(0, 0.5, 0);
  const p = geo.attributes.position, sk = (rnd() - 0.5) * 2 * V.skew, sk2 = (rnd() - 0.5) * 2 * V.skew;
  const jit = new Map(); // samma skakning för hörn på samma plats, så att ytan inte rämnar
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r0 = Math.hypot(x, z) / Math.max(1e-4, 1 - y), a = Math.atan2(z, x);
    const prof = y < V.prism ? 1 - 0.12 * y : V.tip + (1 - V.tip) * (1 - y) / Math.max(1e-3, 1 - V.prism) * (1 - 0.12 * V.prism);
    const r = r0 * prof * (y >= 0.999 ? (V.tip > 0 ? 1 : 0) : 1);
    const k = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (!jit.has(k)) jit.set(k, [(rnd() - 0.5) * V.jit, (rnd() - 0.5) * V.jit * 0.5, (rnd() - 0.5) * V.jit]);
    const [jx, jy, jz] = jit.get(k);
    p.setXYZ(i, Math.cos(a) * r * V.flat + sk * y * y + jx * (y < 0.98 ? 1 : 0.3), Math.min(1, Math.max(0, y + jy)), Math.sin(a) * r + sk2 * y * y + jz);
  }
  const g = geo.toNonIndexed();
  g.computeVertexNormals();
  geo.dispose();
  return g;
}
export function createSpikes(s, { from, to, groundY, ground, defaults = {}, texBase }) {
  const ice = (s.style ?? 'ice') === 'ice';
  const sites = Math.max(0, Math.round(s.count ?? 14)); // 0: bara spåret, skärvorna och resterna
  const kinds = ice ? ['crystal', 'needle', 'shard', 'stubby'] : ['rock', 'slab', 'jag', 'pillar'];
  const geos = kinds.map((k, i) => spikeGeometry(k, 977 + i * 131));
  const u = { rim: uniform(new THREE.Color(s.rim ?? '#bfefff')), rimStrength: uniform(s.rimStrength ?? 1.5), fade: uniform(1), color: uniform(new THREE.Color(s.color ?? '#7fc8e8')), cracks: uniform(s.iceCracks ?? 0.6), groundY: uniform(from.y) };
  const nv = abs(dot(normalize(normalView), normalize(positionView).negate()));
  const fres = pow(float(1).sub(nv), 3);
  const yl = positionLocal.y; // 0 vid foten, 1 i toppen
  // Foten: de nedersta decimetrarna över marken (i världen, så att höga och låga spjut får lika hög fot), med en
  // ojämn övre kant; texturen läggs på från sidan (x + z, y)
  const footH = s.foot ?? 0.42;
  const foot = smoothstep(footH, footH * 0.3, positionWorld.y.sub(u.groundY).add(mx_noise_float(positionWorld.mul(4.5)).mul(0.1)));
  const footTex = texture(loadTex(ice ? 'surface_snow' : 'surface_dirt', true, texBase), vec2(positionWorld.x.add(positionWorld.z), positionWorld.y).div(0.9)).rgb;
  let mat;
  if (ice) {
    // Is: delvis genomskinlig, tätare i kanterna (fresnel), lodräta strimmor och luftbubblor, frost vid foten
    mat = new THREE.MeshStandardNodeMaterial({ transparent: true, roughness: 0.08, metalness: 0, flatShading: true });
    const streak = mx_noise_float(vec3(positionLocal.x.mul(7), yl.mul(1.2), positionLocal.z.mul(7))).mul(0.5).add(0.5);
    const frost = smoothstep(0.28, 0.02, yl).mul(mx_noise_float(positionLocal.mul(14)).mul(0.4).add(0.8));
    const deep = u.color.mul(0.55), light = u.color.add(vec3(0.25, 0.3, 0.3));
    // Fina sprickor i isen: cellkanter (worley F2 − F1) i två storlekar, i spjutets eget rum så att de sitter still
    // medan det växer; en förskjutning per spjut så att inga två spricker likadant
    const cp = vec2(positionLocal.x.add(positionLocal.z.mul(0.7)).mul(6), positionLocal.y.mul(3.2)).add(hash(instanceIndex).mul(37));
    const w1 = mx_worley_noise_vec2(cp), w2 = mx_worley_noise_vec2(cp.mul(2.7).add(11));
    const iceCracks = clamp(smoothstep(0.06, 0.0, w1.y.sub(w1.x)).add(smoothstep(0.04, 0.0, w2.y.sub(w2.x)).mul(0.55)), 0, 1).mul(u.cracks);
    mat.colorNode = mix(mix(mix(deep, light, streak), vec3(0.92, 0.97, 1), clamp(frost, 0, 1)), vec3(0.95, 0.99, 1), iceCracks.mul(0.85));
    mat.opacityNode = clamp(mix(float(0.42), float(0.95), fres).add(frost.mul(0.5)).add(streak.mul(0.12)).add(iceCracks.mul(0.45)), 0, 1);
    mat.emissiveNode = u.rim.mul(fres.mul(u.rimStrength).add(smoothstep(0.55, 1, streak).mul(0.12)).add(iceCracks.mul(0.4))).mul(u.fade).mul(float(1).sub(foot.mul(0.85)));
    // Foten: ett lager vit snö ovanpå isen närmast marken, tätt och nästan ogenomskinligt
    mat.colorNode = mix(mat.colorNode, footTex.mul(1.08), foot);
    mat.opacityNode = max(mat.opacityNode, foot.mul(0.97));
  } else {
    // Sten: Ateljéns klipptextur med normalkarta, mörkare och fuktigare vid foten, svag kant i besvärjelsens färg
    const map = loadTex(s.texture ?? 'surface_cliff', true, texBase), nmap = loadTex(`${s.texture ?? 'surface_cliff'}_normal`, false, texBase);
    map.repeat.set(1, 2); nmap.repeat.set(1, 2);
    mat = new THREE.MeshStandardNodeMaterial({ map, normalMap: nmap, roughness: 0.92, metalness: 0, flatShading: true });
    mat.colorNode = texture(map).rgb.mul(u.color.mul(1.6)).mul(mix(float(0.55), float(1.05), smoothstep(0, 0.35, yl)));
    mat.emissiveNode = u.rim.mul(fres).mul(u.rimStrength).mul(u.fade).mul(float(1).sub(foot));
    // Foten: ett lager jord i markens färg ovanpå stenen, som om spjutet rivit med sig marken upp
    mat.colorNode = mix(mat.colorNode, footTex.mul(u.color.mul(1.4)).mul(0.8), foot);
  }
  const dir = new THREE.Vector3().subVectors(to, from).setY(0);
  const len = dir.length();
  dir.normalize();
  const perp = new THREE.Vector3(-dir.z, 0, dir.x), up = new THREE.Vector3(0, 1, 0);
  let st = 4242;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296);
  const spikes = [];
  const D0 = 0.6, span = Math.max(0.5, len - D0);
  // Spårets halva bredd (m) längs vägen 0–1: från trailStart vid kastaren till trailEnd vid målet
  const wS = s.trailStart ?? 0.25, wE = s.trailEnd ?? 1;
  const halfW = (k) => wS + (wE - wS) * k;
  for (let i = 0; i < sites; i++) {
    const k = (i + 0.5) / sites;
    let base, d, out;
    if (s.mode === 'ring') {
      const a = (i / sites) * Math.PI * 2 + rnd() * 0.3, r = (s.radius ?? 1.4) * (0.75 + rnd() * 0.4);
      base = to.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      d = r; out = base.clone().sub(to).setY(0).normalize();
    } else {
      const side = rnd() < 0.5 ? -1 : 1, lat = (0.15 + rnd() * 0.85) * halfW(k) * 0.75 * side;
      d = D0 + k * span + (rnd() - 0.5) * (span / sites) * 0.6;
      base = from.clone().addScaledVector(dir, d).addScaledVector(perp, lat);
      out = perp.clone().multiplyScalar(side);
    }
    const grow = s.mode === 'ring' ? 1 : 0.55 + 0.65 * k;
    // En klunga: ett huvudspjut och upp till två mindre som lutar längre ut
    const n = 1 + (rnd() < 0.65 ? 1 : 0) + (rnd() < 0.3 ? 1 : 0);
    for (let c = 0; c < n; c++) {
      const main = c === 0;
      const p = base.clone().addScaledVector(out, main ? 0 : 0.12 + rnd() * 0.25).addScaledVector(dir, main ? 0 : (rnd() - 0.5) * 0.4);
      p.y = (groundY?.(p.x, p.z) ?? p.y) - 0.06;
      const lean = (main ? 0.12 + rnd() * 0.45 : 0.45 + rnd() * 0.4); // radianer ut från spåret
      const fwd = (rnd() - 0.35) * 0.35; // lite framåt i vågens riktning
      const axis = new THREE.Vector3().crossVectors(up, out).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(axis, lean)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().crossVectors(up, dir).normalize(), -fwd))
        .multiply(new THREE.Quaternion().setFromAxisAngle(up, rnd() * 6.28));
      const h = (s.height ?? 1.4) * grow * (main ? 0.7 + rnd() * 0.55 : 0.3 + rnd() * 0.35);
      const w = (s.width ?? 0.22) * grow * (main ? 0.7 + rnd() * 0.7 : 0.45 + rnd() * 0.4) * (0.8 + 0.4 * (h / (s.height ?? 1.4)));
      spikes.push({ p, q, d: d + (main ? 0 : 0.05 + rnd() * 0.08), h, w, kind: Math.floor(rnd() * geos.length) });
    }
  }
  const group = new THREE.Group();
  const meshes = geos.map((g, gi) => {
    const list = spikes.filter((sp) => sp.kind === gi);
    const m = new THREE.InstancedMesh(g, mat, Math.max(1, list.length));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // uppdateras varje bild; som statisk byggs shadern om vid första ändringen
    m.count = list.length;
    m.castShadow = true; m.receiveShadow = !ice;
    m.frustumCulled = false;
    m.renderOrder = ice ? 4 : 0;
    // Nedsjunkna från början (och bufferten ändrad en gång före förvärmningen, så att inget byggs om vid kastet)
    const Z = new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4);
    list.forEach((sp, i) => m.setMatrixAt(i, Z.clone().setPosition(sp.p)));
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
    return { mesh: m, list };
  });

  // Spåret: en djupdekal på marken längs linjen som spricker upp där vågen har gått fram
  let trail = null, tu = null;
  if (s.mode !== 'ring' && s.trail !== false) {
    const TD = depthDecal({ slope: 0.5 }), DW = TD.world;
    tu = { front: uniform(-1), fade: uniform(1), from: uniform(from.clone()), dir: uniform(dir.clone()), perp: uniform(perp.clone()),
      len: uniform(len), rim: u.rim, color: u.color, glow: uniform(ice ? (s.rimStrength ?? 1.5) : 0.15),
      wStart: uniform(wS), wEnd: uniform(wE), soft: uniform(0.45), breakup: uniform(0.55), breakupScale: uniform(1.2), fadeIn: uniform(0.8), fadeOut: uniform(0.8), opacity: uniform(0.9),
      rest: uniform(0), restFade: uniform(1) }; // rest: 0 medan spjuten står, 1 när bara resterna ligger kvar; restFade tonar ut dem
    const rel = DW.sub(tu.from);
    const along = dot(rel.xz, tu.dir.xz);
    // Avsmalning: halva bredden går från wStart vid kastaren till wEnd vid målet
    const halfWn = mix(tu.wStart, tu.wEnd, clamp(along.div(tu.len), 0, 1));
    const across = dot(rel.xz, tu.perp.xz).div(max(halfWn, 0.02));
    // Masken: mjuk kant, uppbruten av brus i två skalor (fransiga kanter och hål när breakup är högt)
    const bp = DW.xz.mul(tu.breakupScale);
    const n = mx_noise_float(vec3(bp, 2)).add(mx_noise_float(vec3(bp.mul(2.3), 5)).mul(0.5));
    const edgeD = abs(across).add(n.mul(tu.breakup).mul(0.55));
    const edgeM = float(1).sub(smoothstep(float(1).sub(max(tu.soft, 0.02)), 1, edgeD));
    // Hålen växer när resterna tonar bort, så att snön eller jorden smälter undan i fläckar i stället för att blekna jämnt
    const holes = smoothstep(-0.75, -0.35, n.add(float(1).sub(tu.breakup).mul(1.2)).sub(float(1).sub(tu.restFade).mul(1.6)));
    const ends = smoothstep(0, max(tu.fadeIn, 0.01), along).mul(float(1).sub(smoothstep(tu.len.sub(0.1), tu.len.add(max(tu.fadeOut, 0.01)), along)));
    const shown = smoothstep(tu.front, tu.front.sub(0.35), along);
    const wv = mx_worley_noise_vec2(DW.xz.mul(ice ? 2.2 : 1.6)), wv2 = mx_worley_noise_vec2(DW.xz.mul(5.5));
    const cracks = clamp(smoothstep(0.09, 0.0, wv.y.sub(wv.x)).add(smoothstep(0.05, 0.0, wv2.y.sub(wv2.x)).mul(0.6)), 0, 1).mul(smoothstep(1.0, 0.3, edgeD));
    const tex = texture(loadTex(ice ? 'surface_snow' : 'surface_dirt', true, texBase), DW.xz.div(1.6)).rgb;
    const tmat = new THREE.MeshStandardNodeMaterial({ roughness: ice ? 0.25 : 0.95 });
    // Ljuset ska falla på marken, inte på lådans sidor: markens normal (ur djupet) i kamerans rum
    tmat.normalNode = normalize(cameraViewMatrix.mul(vec4(TD.normal, 0)).xyz);
    // Is: frusen skorpa i besvärjelsens färg med lysande sprickor. Jord: uppriven mörk jord med svarta sprickor och
    // ljusare upptryckta kanter.
    tmat.colorNode = ice ? mix(tex.mul(mix(vec3(1, 1, 1), tu.color, 0.45)), tu.color.mul(0.5), cracks)
      : mix(tex.mul(tu.color.mul(1.1)).mul(mix(float(1.15), float(0.7), smoothstep(0.2, 0.7, abs(across)))), vec3(0.05, 0.035, 0.025), cracks);
    tmat.emissiveNode = tu.rim.mul(cracks).mul(tu.glow).mul(shown).mul(tu.fade).mul(float(1).sub(tu.rest));
    // Resterna: ett tunt snötäcke på isspåret, lös ljusare jord på stenspåret
    const residue = ice ? mix(tex, vec3(0.96, 0.98, 1), 0.6) : mix(tex.mul(tu.color.mul(1.1)), vec3(0.62, 0.53, 0.4), 0.3);
    tmat.colorNode = mix(tmat.colorNode, residue, tu.rest);
    const mask = edgeM.mul(holes).mul(ends).mul(shown);
    tmat.opacityNode = clamp(mask.mul(TD.mask).mul(tu.opacity).add(cracks.mul(mask).mul(0.3).mul(float(1).sub(tu.rest))), 0, 1).mul(mix(float(1), float(0.6), tu.rest)).mul(tu.restFade).mul(tu.fade);
    const mid = from.clone().addScaledVector(dir, len / 2);
    const ang = Math.atan2(dir.x, dir.z);
    const reach = len + 2 * Math.max(wS, wE) + 2 * (s.trailFadeOut ?? 0.8) + 1;
    trail = decalMesh(tmat, 2);
    placeDecal(trail, mid, reach / 2, { height: 2.4 });
    group.add(trail);
  }

  // Skärvor och damm (eller froströk) längs spåret: föds där vågen är när de föds (partiklarnas bana)
  const P = (k) => ({ ...defaults.particles, mode: 'loop', ...k });
  const debris = createParticles(P({ count: s.debris ?? 160, lifetime: 1.1, lifeVar: 0.4, emit: 'sphere', radius: 0.3, speed: 3.6, speedVar: 0.6, spread: 38, radial: 1.4, gravity: 9.5, drag: 0.4,
    turbulence: 0, sprite: 'shard', additive: false, sizeStart: (s.width ?? 0.22) * 0.65, sizeEnd: (s.width ?? 0.22) * 0.4, sizeVar: 0.6, spin: 9, stretch: 0,
    colorStart: ice ? '#eaf8ff' : '#6a5440', colorMid: ice ? `#${new THREE.Color(s.color ?? '#7fc8e8').getHexString()}` : '#4a382a', colorEnd: ice ? '#b8e0f4' : '#3a2a1e',
    alpha: 1, fadeIn: 0.02, fadeOut: 0.15, glow: ice ? 1.3 : 1, soft: 0 }), { max: 800 });
  const dust = createParticles(P({ count: s.dust ?? 70, lifetime: 1.8, lifeVar: 0.4, emit: 'sphere', radius: 0.35, speed: 1.1, speedVar: 0.5, spread: 55, radial: 0.8, gravity: ice ? 0.1 : -0.15, drag: 2,
    flow: 0.25, flowScale: 0.8, wind: 0.5, sprite: 'smoke', additive: false, sizeStart: 0.35, sizeEnd: 1.3, sizeVar: 0.4, spin: 0.6,
    colorStart: ice ? '#f0faff' : '#8a7458', colorMid: ice ? '#d8eef8' : '#7a6650', colorEnd: ice ? '#c8e2f0' : '#6e5c48', alpha: ice ? 0.45 : 0.6, fadeIn: 0.08, fadeOut: 0.65, glow: 1, soft: 0.5 }), { max: 400 });
  const avgW = (wS + wE) / 2;
  const after = createParticles(P(ice
    ? { count: s.mist ?? 45, lifetime: 3, lifeVar: 0.4, emit: 'disc', radius: avgW * 0.8, speed: 0.25, speedVar: 0.6, spread: 85, radial: 0.6, gravity: 0.15, drag: 2, flow: 0.12, flowScale: 0.4, wind: 0.3,
      sprite: 'smoke', additive: false, sizeStart: 0.6, sizeEnd: 2, sizeVar: 0.4, spin: 0.3, colorStart: '#f6fcff', colorMid: '#eaf6fc', colorEnd: '#e0f0f8', alpha: 0.22, fadeIn: 0.25, fadeOut: 0.6, glow: 1, soft: 0.7 }
    : { count: s.mist ?? 55, lifetime: 2.6, lifeVar: 0.4, emit: 'disc', radius: avgW * 0.8, speed: 0.35, speedVar: 0.6, spread: 70, radial: 0.5, gravity: -0.03, drag: 1.6, flow: 0.2, flowScale: 0.5, wind: 0.5,
      sprite: 'smoke', additive: false, sizeStart: 0.5, sizeEnd: 2.2, sizeVar: 0.4, spin: 0.4, colorStart: '#a08a68', colorMid: '#968062', colorEnd: '#8a7658', alpha: 0.28, fadeIn: 0.2, fadeOut: 0.6, glow: 1, soft: 0.6 }), { max: 300 });
  group.add(debris.object, dust.object, after.object);
  debris.object.visible = dust.object.visible = after.object.visible = s.mode !== 'ring'; // i en ring finns inget spår att spricka upp
  const pathFrom = from.clone().addScaledVector(dir, D0), pathTo = from.clone().addScaledVector(dir, len);
  pathFrom.y = (groundY?.(pathFrom.x, pathFrom.z) ?? pathFrom.y) + 0.05; pathTo.y = (groundY?.(pathTo.x, pathTo.z) ?? pathTo.y) + 0.05;

  const M = new THREE.Matrix4(), S = new THREE.Vector3();
  let t0 = 0;
  const wave = () => Math.max(0.5, s.wave ?? 8);
  // hold: hur länge spjuten står (lagrets längd i tidslinjen); linger: hur länge resterna ligger kvar efteråt
  const hold = () => s.hold ?? 2.6, linger = () => s.linger ?? 3;
  const fx = {
    object: group, uniforms: u,
    set(v) {
      s = { ...s, ...v };
      u.color.value.set(v.color ?? '#7fc8e8'); u.rim.value.set(v.rim ?? '#bfefff'); u.rimStrength.value = v.rimStrength ?? 1.5; u.cracks.value = s.iceCracks ?? 0.6;
      if (tu) {
        // Bredden ändras live i spåret; spjutens platser följer när besvärjelsen byggs om
        tu.wStart.value = s.trailStart ?? 0.25; tu.wEnd.value = s.trailEnd ?? 1; tu.soft.value = s.trailSoft ?? 0.45; tu.breakup.value = s.trailBreakup ?? 0.55;
        tu.breakupScale.value = s.trailBreakupScale ?? 1.2; tu.fadeIn.value = s.trailFadeIn ?? 0.8; tu.fadeOut.value = s.trailFadeOut ?? 0.8; tu.opacity.value = s.trailOpacity ?? 0.9;
      }
    },
    start(time) {
      t0 = time;
      if (s.mode !== 'ring') {
        const flight = span / wave();
        debris.path(pathFrom, pathTo, 0, time + D0 / wave(), flight);
        dust.path(pathFrom, pathTo, 0, time + D0 / wave(), flight);
        // Resterna sveper längs spåret när spjuten sjunker undan
        after.path(pathFrom, pathTo, 0, time + hold() - 0.2, Math.max(0.8, linger() * 0.4));
      }
    },
    // t: sekunder sedan lagret började, dur: hela lagrets längd (de sista sink sekunderna sjunker de undan)
    update(time, lt, { t = 0, dur = 2, wind } = {}) {
      const sink = s.sink ?? 0.35, H = Math.min(hold(), dur);
      for (const { mesh, list } of meshes) {
        list.forEach((sp, i) => {
          let g = easeBack(clamp01((t - sp.d / wave()) / 0.16));
          if (t > H - sink) g *= 1 - easeOut(clamp01((t - (H - sink)) / sink));
          g = Math.max(0, g);
          const wg = 0.35 + 0.65 * Math.min(1, g);
          M.compose(sp.p, sp.q, S.set(sp.w * wg, sp.h * g + 1e-4, sp.w * wg));
          mesh.setMatrixAt(i, M);
        });
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (tu) {
        tu.front.value = t * wave(); tu.fade.value = u.fade.value;
        tu.rest.value = clamp01((t - H + 0.2) / 0.6);
        const x = clamp01((t - H) / Math.max(0.1, linger()));
        tu.restFade.value = 1 - x * x * (3 - 2 * x);
      }
      debris.update(time, { wind }); dust.update(time, { wind }); after.update(time, { wind });
    },
    setFade(f) { u.fade.value = f; if (tu) tu.fade.value = f; },
    dispose() { for (const g of geos) g.dispose(); mat.dispose(); if (trail) trail.material.dispose(); debris.dispose(); dust.dispose(); after.dispose(); },
  };
  fx.set(s);
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

// --- Chockring på marken (FX01, djupdekal): en tunn ljus ring som vidgas, en kärna som tonar och ekrar ---
export function createRing(s, { at, ground }) {
  const u = { color: uniform(new THREE.Color(s.color ?? '#ffb060')), k: uniform(0), fade: uniform(1), intensity: uniform(s.intensity ?? 2.5), width: uniform(s.thickness ?? 0.03) };
  const mat = new THREE.MeshBasicNodeMaterial({ blending: THREE.AdditiveBlending });
  const D = depthDecal();
  const p = D.uv.mul(2).sub(1), r = length(p);
  const rad = mix(float(0.04), float(0.95), u.k);
  const ring = exp(r.sub(rad).div(u.width).pow(2).negate());
  const ring2 = exp(r.sub(rad.mul(0.72)).div(u.width.mul(0.6)).pow(2).negate()).mul(0.45);
  const inner = exp(r.mul(-5)).mul(float(1).sub(u.k));
  const spokes = pow(abs(sin(atan(p.y, p.x).mul(12).add(u.k.mul(6)))), 18).mul(0.25);
  const fadeOut = float(1).sub(smoothstep(0.6, 1, u.k)).mul(float(1).sub(smoothstep(0.92, 1, r)));
  const I = ring.mul(2.5).add(ring2).add(inner).add(ring.mul(spokes)).mul(fadeOut).mul(u.fade).mul(D.mask);
  mat.colorNode = u.color.mul(I).mul(u.intensity);
  mat.opacityNode = clamp(I.mul(0.7), 0, 1);
  const mesh = decalMesh(mat, 5);
  placeDecal(mesh, at, s.radius ?? 2);
  return {
    object: mesh, uniforms: u,
    set(v) { u.color.value.set(v.color); u.intensity.value = v.intensity ?? 2.5; placeDecal(mesh, at, v.radius ?? 2); },
    update(time, lt) { u.k.value = easeOut(clamp01(lt)); },
    setFade(f) { u.fade.value = f; },
    dispose() { mat.dispose(); },
  };
}

// --- Brännmärke: en djupdekal på marken med brusig kant och glöd som slocknar ---
export function createScorch(s, { at, ground }) {
  const u = { ember: uniform(new THREE.Color(s.ember ?? '#ff6a1a')), dark: uniform(new THREE.Color(s.color ?? '#120a06')), k: uniform(0), fade: uniform(1), seed: uniform(Math.random() * 50) };
  const mat = new THREE.MeshBasicNodeMaterial();
  const D = depthDecal();
  const p = D.uv.mul(2).sub(1), r = length(p);
  const n = mx_noise_float(vec3(p.mul(2.5), u.seed)).mul(0.5).add(mx_noise_float(vec3(p.mul(6), u.seed.add(3))).mul(0.25));
  const mask = float(1).sub(smoothstep(0.45, 0.95, r.add(n.mul(0.35))));
  const cracks = pow(clamp(float(1).sub(abs(mx_noise_float(vec3(p.mul(5), u.seed.add(9))))), 0, 1), 10);
  const heat = clamp(float(1).sub(u.k.mul(1.4)), 0, 1);
  mat.colorNode = mix(u.dark, u.ember.mul(4), cracks.mul(heat).mul(smoothstep(0.85, 0.2, r)));
  mat.opacityNode = clamp(mask.mul(0.88).add(cracks.mul(heat)), 0, 1).mul(u.fade).mul(D.mask);
  const mesh = decalMesh(mat, 3);
  placeDecal(mesh, at, s.radius ?? 1, { rotY: Math.random() * 6.28 });
  return {
    object: mesh, uniforms: u,
    set() {},
    update(time, lt) { u.k.value = lt; },
    setFade(f) { u.fade.value = f; },
    dispose() { mat.dispose(); },
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

// Ett lager visas eller döljs, men ljus döljs aldrig: de släcks (styrka 0). Ändras antalet synliga ljus i scenen måste
// three.js kompilera om alla belysta material (mark, figurer, spjut), och det ger ett ryck på nästan en sekund just när
// ett lager med ljus börjar eller slutar.
function show(obj, on) {
  if (obj.isLight) { obj.visible = true; if (!on) obj.intensity = 0; return; }
  let lit = false;
  obj.traverse((o) => { if (o.isLight) lit = true; });
  if (!lit) { obj.visible = on; return; }
  obj.visible = true;
  for (const c of obj.children) show(c, on);
}

// Markspårets spakar ur besvärjelsen (kortet Ground trail), till lager som har ett spår; bredderna följer storleken
const TRAIL_KEYS = ['trailSoft', 'trailBreakup', 'trailBreakupScale', 'trailFadeIn', 'trailFadeOut', 'trailOpacity', 'iceCracks', 'linger'];
function trailOf(s) {
  const o = Object.fromEntries(TRAIL_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
  if (s.trailStart !== undefined) o.trailStart = s.trailStart * (s.size ?? 1);
  if (s.trailEnd !== undefined) o.trailEnd = s.trailEnd * (s.size ?? 1);
  return o;
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
  // Besvärjelsens egna lager, plus de som lagts till (Add a layer: mallar i vfx.json under layerTemplates)
  const all = [...def.layers, ...(s.extra ?? []).map((id) => ctx.templates?.[id]?.layer).filter(Boolean)];
  for (const L of all) {
    if (L.role && s[`layer_${L.role}`] === false) continue;
    const set = resolve(L.set, s);
    const at = anchor(L.anchor ?? 'target');
    let fx;
    switch (L.type) {
      case 'particles': fx = createParticles({ ...D.particles, ...set }, { at, max: 3000 }); fx.object.renderOrder = 6; break; // efter pelare och ringar, så att de inte tvättas bort
      case 'marker': fx = createMarker({ ...D.marker, ...set }, { ground: ctx.ground, at, top: at.y + 1.8 }); break;
      case 'aura': fx = createAura({ ...D.glow, ...set }, { target: L.anchor === 'dummy' ? ctx.dummy : ctx.figure, ground: ctx.ground }); break;
      case 'flames': fx = createFlames(set, { at }); break;
      case 'lightning': fx = createLightning(set); fx.ends(anchor(L.from ?? 'hand'), anchor(L.to ?? 'target')); break;
      case 'spikes': fx = createSpikes({ ...set, ...trailOf(s), hold: L.dur ?? 2.6 }, { from: anchor(L.from ?? 'caster'), to: anchor(L.to ?? 'targetGround'), groundY: ctx.groundY, ground: ctx.ground, defaults: D, texBase: ctx.texBase }); break;
      case 'flash': fx = createFlash(set, { at }); break;
      case 'ring': fx = createRing(set, { at, ground: ctx.ground }); break;
      case 'scorch': fx = createScorch(set, { at, ground: ctx.ground }); break;
      case 'portal': fx = createPortal(set, { at }); break;
      case 'light': fx = createLight(set, { at }); break;
      case 'bolt': fx = createBolt(set, { from: anchor(L.from ?? 'hand'), to: anchor(L.to ?? 'target'), defaults: D }); impact = (L.at ?? 0) + fx.flight; break;
      case 'shock': case 'haze': case 'shake': fx = { object: null, set() {}, update() {}, setFade() {}, dispose() {} }; break;
      default: continue;
    }
    if (fx.object) { show(fx.object, false); group.add(fx.object); }
    layers.push({ L, fx, set, at });
  }
  // Tiderna: efter träffen räknas från projektilens ankomst (eller spellens impact)
  let total = 0;
  for (const l of layers) {
    l.start = (l.L.after === 'impact' ? impact : 0) + (l.L.at ?? 0);
    l.dur = l.L.type === 'bolt' ? l.fx.flight + (l.L.dur ?? 0.4) : l.L.type === 'spikes' ? (l.L.dur ?? 2.6) + (s.linger ?? 3) : l.L.dur ?? 0;
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
      for (const l of layers) { l.set = resolve(l.L.set, s); const full = l.L.type === 'particles' ? { ...D.particles, ...l.set } : l.L.type === 'marker' ? { ...D.marker, ...l.set } : l.L.type === 'aura' ? { ...D.glow, ...l.set } : l.L.type === 'spikes' ? { ...l.set, ...trailOf(s) } : l.set; l.fx.set?.(full); }
    },
    play(time) { t0 = time; playing = true; for (const l of layers) l.started = false; },
    // Förberedelse före kastet: alla lager finns med men är helt uttonade, så att bildkedjan kompilerar deras shaders i
    // samma sammanhang som när de syns på riktigt (scenpasset), utan att något syns. Kastet börjar bilden efter.
    prepare(time, camera) {
      for (const l of layers) {
        if (l.fx.object) show(l.fx.object, true);
        if (l.L.type === 'particles') l.fx.update(time, {});
        else l.fx.update(time, 0, { camera, t: 0, dur: l.dur });
        l.fx.setFade?.(0);
      }
    },
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
        if (l.fx.object) show(l.fx.object, particlesLive || e > 0);
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
