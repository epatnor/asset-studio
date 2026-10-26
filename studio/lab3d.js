// Materiallabbet i texturverkstaden (docs/texture-workshop.md, T3a, T3c, T4): verkstadens kartor på testmodeller,
// med triplanar eller UV, parallax, förskjutning, upprepningsskydd, detaljkarta, stiliserad genomlysning och upp
// till fyra blandningslager (riktning, höjd i modellen, höjdkarta, brus och krökning) i en egen shader ovanpå
// MeshPhysicalMaterial. Allt som three.js har inbyggt (lack, sheen, transmission, anisotropi, iridescens) sätts direkt.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { gpuPreference, frameGate } from './gpu.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const MAX_LAYERS = 4;

export const MODELS = {
  block: { label: 'Block with bevelled edges' },
  sphere: { label: 'Sphere' },
  cylinder: { label: 'Cylinder (trunk)' },
  terrain: { label: 'Terrain patch (60 m)' },
  dragon: { label: 'Dragon statue' },
  asset: { label: 'Current tree (the trunk)' },
};
export const LIGHTS = {
  sun: { label: 'Game sun', sun: [0xfff1dc, 3.0, [6, 9, 4]], hemi: [0xbcd7ff, 0x5b4a35, 1.0], env: 0.35, bg: 0x9cc4ec },
  studio: { label: 'Studio light', sun: [0xffffff, 2.0, [4, 6, 6]], hemi: [0xffffff, 0x444444, 0.35], env: 1.0, bg: 0x4a4f58 },
  back: { label: 'Backlight', sun: [0xffe0b0, 3.4, [-6, 5, -7]], hemi: [0x9fb7d9, 0x3a3328, 0.7], env: 0.3, bg: 0x2f3a4a },
  evening: { label: 'Evening', sun: [0xffa860, 2.6, [8, 2.2, 2]], hemi: [0x6f86b8, 0x2a2018, 0.6], env: 0.25, bg: 0x5c6f9a },
  // Släckt: bara det som lyser själv (emission) och miljön om man skruvar upp den; glöden lyser upp plattan
  dark: { label: 'Lights off', sun: [0xffffff, 0, [4, 6, 6]], hemi: [0xffffff, 0x000000, 0], env: 0, bg: 0x0b0d11 },
};
// HDRI som miljöljus (third_party/polyhaven_hdri, hämtas med tools/hdri/fetch_hdri.py): listan läses ur index.json
export const HDRI_DIR = '/third_party/polyhaven_hdri/';
const DIRS = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, 1], south: [0, 0, -1], east: [1, 0, 0], west: [-1, 0, 0] };

// --- Krökning per hörn (positivt på utstickande kanter, negativt i skrymslen), för kantmasker ---
function addCurvature(geo) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal, n = pos.count;
  const ids = new Int32Array(n), keys = new Map();
  let m = 0;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let id = keys.get(k);
    if (id === undefined) { id = m++; keys.set(k, id); }
    ids[i] = id;
  }
  const P = new Float32Array(m * 3), N = new Float32Array(m * 3);
  for (let i = 0; i < n; i++) {
    const j = ids[i] * 3;
    P[j] = pos.getX(i); P[j + 1] = pos.getY(i); P[j + 2] = pos.getZ(i);
    N[j] += nrm.getX(i); N[j + 1] += nrm.getY(i); N[j + 2] += nrm.getZ(i);
  }
  const acc = new Float32Array(m), cnt = new Float32Array(m);
  const edge = (a, b) => {
    const dx = P[b * 3] - P[a * 3], dy = P[b * 3 + 1] - P[a * 3 + 1], dz = P[b * 3 + 2] - P[a * 3 + 2];
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 < 1e-12) return;
    const nl = Math.hypot(N[a * 3], N[a * 3 + 1], N[a * 3 + 2]) || 1;
    acc[a] += -(N[a * 3] * dx + N[a * 3 + 1] * dy + N[a * 3 + 2] * dz) / nl / Math.sqrt(l2);
    cnt[a]++;
  };
  const tri = geo.index ? (t) => geo.index.getX(t) : (t) => t;
  const tris = (geo.index ? geo.index.count : n) / 3;
  for (let t = 0; t < tris; t++) {
    const a = ids[tri(t * 3)], b = ids[tri(t * 3 + 1)], c = ids[tri(t * 3 + 2)];
    edge(a, b); edge(b, a); edge(b, c); edge(c, b); edge(c, a); edge(a, c);
  }
  const c = new Float32Array(m);
  for (let i = 0; i < m; i++) c[i] = cnt[i] ? acc[i] / cnt[i] : 0;
  const sorted = Array.from(c, Math.abs).sort((x, y) => x - y);
  const scale = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, c[ids[i]] / scale));
  geo.setAttribute('curv', new THREE.BufferAttribute(out, 1));
  return geo;
}

function terrainGeometry(seg) {
  const g = new THREE.PlaneGeometry(60, 60, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    let h = 2.6 * Math.sin(x * 0.09) * Math.cos(z * 0.07) + 1.2 * Math.sin(x * 0.21 + 1) * Math.sin(z * 0.17 + 2);
    h += 5 * Math.max(0, 1 - Math.hypot(x - 12, z + 10) / 11) ** 1.5; // en brant kulle med klippsida
    h += 0.25 * Math.sin(x * 0.9) * Math.sin(z * 0.8);
    p.setY(i, h);
  }
  g.computeVertexNormals();
  return g;
}

export function createLab({ getAssetUrl }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: gpuPreference() });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 600);
  camera.position.set(2.2, 1.6, 2.6);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = roomEnv;

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  const hemi = new THREE.HemisphereLight(0xbcd7ff, 0x5b4a35, 1);
  scene.add(sun, sun.target, hemi);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(9, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a8577, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
  // Glöden: lysande material (emission) lyser upp plattan och omgivningen. Ett punktljus i modellen med
  // emissionskartans medelfärg, starkare ju mer av ytan som lyser och ju större modellen är. Inga skuggor:
  // ljuset sitter inne i modellen och kommer ut genom sprickorna.
  const glow = new THREE.PointLight(0xffffff, 0, 0, 2);
  scene.add(glow);
  let glowScale = 1, glowMean = { color: new THREE.Color(0, 0, 0), lum: 0 };
  function meanOf(tex) {
    const img = tex?.image;
    if (!img || !img.width || tex === BLANK.emissive) return { color: new THREE.Color(0, 0, 0), lum: 0 };
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data, sum = [0, 0, 0];
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += lin(d[i + k]);
    const col = new THREE.Color(sum[0] / 256, sum[1] / 256, sum[2] / 256);
    return { color: col, lum: 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b };
  }
  function updateGlow() {
    const on = mat.emissiveIntensity > 0 && glowMean.lum > 0 && model;
    glow.visible = !!on;
    if (!on) return;
    const size = model.box.getSize(new THREE.Vector3()), c = model.box.getCenter(new THREE.Vector3());
    const m = Math.max(glowMean.color.r, glowMean.color.g, glowMean.color.b) || 1;
    glow.color.setRGB(glowMean.color.r / m, glowMean.color.g / m, glowMean.color.b / m);
    const r = Math.max(size.x, size.z) * 0.5;
    glow.position.set(c.x, model.box.min.y + Math.min(size.y * 0.35, r), c.z);
    // Lysande yta ungefär 4 r², halva strålar nedåt mot plattan
    glow.intensity = mat.emissiveIntensity * glowMean.lum * 4 * r * r * 2.5 * glowScale;
  }

  // --- Texturer: platshållare så att shaderns defines aldrig ändras när en karta slås av och på ---
  const px = (r, g, b, srgb) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1); t.needsUpdate = true; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const BLANK = { color: px(255, 255, 255, true), normal: px(128, 128, 255), rough: px(255, 255, 255), ao: px(255, 255, 255), metal: px(0, 0, 0), emissive: px(0, 0, 0, true), height: px(128, 128, 128) };
  const loader = new THREE.TextureLoader();
  const maps = { ...BLANK };
  const layerTex = new Map();
  const loadLayerTex = (name) => {
    if (!layerTex.has(name)) {
      const t = loader.load(`/assets/textures/${name}.png`, () => { needsRender = true; });
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      layerTex.set(name, t);
    }
    return layerTex.get(name);
  };

  const U = {
    uTri: { value: 0 }, uTriScale: { value: 0.5 }, uUvScale: { value: new THREE.Vector2(1, 1) }, uUvOff: { value: new THREE.Vector2() }, uUvRot: { value: 0 },
    uNoTile: { value: 0 }, uMacro: { value: 0 }, uMacroScale: { value: 20 }, uHeightF: { value: BLANK.height },
    uPom: { value: 0 }, uPomDepth: { value: 0.04 }, uPomSteps: { value: 24 },
    uSSS: { value: 0 }, uSSSColor: { value: new THREE.Color(0xe8b070) },
    uDetail: { value: 0 }, uDetailTex: { value: BLANK.color }, uDetailTiling: { value: 8 }, uDetailStrength: { value: 0.4 }, uDetailFade: { value: 8 },
    uBounds: { value: new THREE.Vector2(0, 1) }, uLayerCount: { value: 0 },
  };
  for (let i = 0; i < MAX_LAYERS; i++) {
    Object.assign(U, {
      [`uL${i}`]: { value: BLANK.color }, [`uLA${i}`]: { value: new THREE.Vector4() }, [`uLB${i}`]: { value: new THREE.Vector4(0, 1, 0, -2) },
      [`uLC${i}`]: { value: new THREE.Vector4(0, 1, 0, 1) }, [`uLD${i}`]: { value: new THREE.Vector4(0.9, 0, 0, 1) }, [`uLT${i}`]: { value: new THREE.Color(1, 1, 1) },
    });
  }

  const mat = new THREE.MeshPhysicalMaterial({
    map: maps.color, normalMap: maps.normal, roughnessMap: maps.rough, metalnessMap: maps.metal, aoMap: maps.ao,
    emissiveMap: maps.emissive, displacementMap: maps.height, displacementScale: 0, roughness: 1, metalness: 1, emissive: 0xffffff,
  });
  const lab = (s) => s.replace(/texture2D\(\s*(\w+)\s*,\s*v\w+Uv\s*\)/g, 'labTex( $1 )');
  const layerCode = Array.from({ length: MAX_LAYERS }, (_, i) => `
    if (${i} < uLayerCount) {
      vec4 A = uLA${i}; vec4 Bv = uLB${i}; vec4 C = uLC${i}; vec4 D = uLD${i};
      vec3 w = labW3(); vec3 p = vLabP * C.w;
      vec3 lc = (texture2D(uL${i}, p.zy) * w.x + texture2D(uL${i}, p.xz) * w.y + texture2D(uL${i}, p.xy) * w.z).rgb * uLT${i};
      float m = A.x;
      if (Bv.w > -1.5) m *= smoothstep(Bv.w - 0.12, Bv.w + 0.12, dot(labN, Bv.xyz));
      if (C.x > 0.001) m *= smoothstep(C.x - 0.04, C.x + 0.04, yN);
      if (C.y < 0.999) m *= 1.0 - smoothstep(C.y - 0.04, C.y + 0.04, yN);
      if (abs(C.z) > 0.01) { float t = clamp(vLabC * sign(C.z), 0.0, 1.0); float e = 1.0 - abs(C.z); m *= smoothstep(e * 0.6, e * 0.6 + 0.25, t); }
      float s = mix(0.35, 0.02, A.z);
      float field = 0.5 + (hB - 0.5) * A.y * 1.2;
      if (A.w > 0.0) field += (labFbm(vLabP * D.w) - 0.5) * A.w * 1.4;
      field = clamp(field, s + 0.01, 1.0 - s - 0.01);
      float mk = smoothstep(field - s, field + s, m);
      diffuseColor.rgb = mix(diffuseColor.rgb, lc, mk);
      labLR = mix(labLR, D.x, mk); labLM = labLM + mk * (1.0 - labLM);
      labFlat = max(labFlat, mk * D.y);
      labReliefH += dot(lc, vec3(0.333)) * mk * D.z;
    }`).join('');

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <displacementmap_pars_vertex>', `#include <displacementmap_pars_vertex>
        attribute float curv;
        varying vec3 vLabP; varying vec3 vLabN; varying float vLabC; varying vec2 vLabUv; varying vec3 vTX; varying vec3 vTY; varying vec3 vTZ; varying vec3 vLabWP;
        uniform float uTri; uniform float uTriScale; uniform vec2 uUvScale; uniform vec2 uUvOff; uniform float uUvRot;
        vec2 labUvOf(vec2 t) { t *= uUvScale; float c = cos(uUvRot), s = sin(uUvRot); return mat2(c, s, -s, c) * t + uUvOff; }
        #ifdef USE_DISPLACEMENTMAP
        float labHeightV(vec3 p, vec3 n, vec2 t) {
          if (uTri > 0.5) { vec3 w = pow(abs(n), vec3(4.0)); w /= dot(w, vec3(1.0)); p *= uTriScale;
            return texture2D(displacementMap, p.zy).x * w.x + texture2D(displacementMap, p.xz).x * w.y + texture2D(displacementMap, p.xy).x * w.z; }
          return texture2D(displacementMap, labUvOf(t)).x;
        }
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLabP = position; vLabN = normalize(objectNormal); vLabC = curv; vLabUv = labUvOf(uv);
        vTX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0)); vTY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0)); vTZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
        vLabWP = (modelMatrix * vec4(position, 1.0)).xyz;`)
      .replace('#include <displacementmap_vertex>', `#ifdef USE_DISPLACEMENTMAP
        transformed += normalize(objectNormal) * (labHeightV(position, normalize(objectNormal), uv) * displacementScale + displacementBias);
        #endif`);
    const layerUniforms = Array.from({ length: MAX_LAYERS }, (_, i) =>
      `uniform sampler2D uL${i}; uniform vec4 uLA${i}; uniform vec4 uLB${i}; uniform vec4 uLC${i}; uniform vec4 uLD${i}; uniform vec3 uLT${i};`).join('\n');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLabP; varying vec3 vLabN; varying float vLabC; varying vec2 vLabUv; varying vec3 vTX; varying vec3 vTY; varying vec3 vTZ; varying vec3 vLabWP;
        uniform float uTri; uniform float uTriScale; uniform float uNoTile; uniform float uMacro; uniform float uMacroScale;
        uniform sampler2D uHeightF; uniform float uPom; uniform float uPomDepth; uniform float uPomSteps;
        uniform float uSSS; uniform vec3 uSSSColor;
        uniform float uDetail; uniform sampler2D uDetailTex; uniform float uDetailTiling; uniform float uDetailStrength; uniform float uDetailFade;
        uniform vec2 uBounds; uniform int uLayerCount;
        ${layerUniforms}
        vec2 labUv; vec3 labP; vec3 labN;
        float labLR = 0.0, labLM = 0.0, labFlat = 0.0, labReliefH = 0.0;
        float labHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float labNoise(vec3 x) {
          vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(labHash(i), labHash(i + vec3(1, 0, 0)), f.x), mix(labHash(i + vec3(0, 1, 0)), labHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(labHash(i + vec3(0, 0, 1)), labHash(i + vec3(1, 0, 1)), f.x), mix(labHash(i + vec3(0, 1, 1)), labHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }
        float labFbm(vec3 p) { return 0.5 * labNoise(p) + 0.25 * labNoise(p * 2.03) + 0.125 * labNoise(p * 4.01) + 0.125 * labNoise(p * 8.05); }
        // Upprepningsskydd (Inigo Quilez, "texture repetition", variant 3): två förskjutna avläsningar blandade med brus
        vec4 labNoTile(sampler2D s, vec2 t) {
          vec2 dx = dFdx(t), dy = dFdy(t);
          float l = labNoise(vec3(t * 0.9, 0.5)) * 8.0; float i = floor(l); float f = fract(l);
          vec4 a = textureGrad(s, t + sin(vec2(3.0, 7.0) * i), dx, dy); vec4 b = textureGrad(s, t + sin(vec2(3.0, 7.0) * (i + 1.0)), dx, dy);
          return mix(a, b, smoothstep(0.2, 0.8, f - 0.1 * dot(a.rgb - b.rgb, vec3(1.0))));
        }
        vec4 lab2D(sampler2D s, vec2 t) { return uNoTile > 0.5 ? labNoTile(s, t) : texture2D(s, t); }
        vec3 labW3() { vec3 w = pow(abs(labN), vec3(4.0)); return w / dot(w, vec3(1.0)); }
        vec4 labTex(sampler2D s) {
          if (uTri > 0.5) { vec3 w = labW3(); return lab2D(s, labP.zy) * w.x + lab2D(s, labP.xz) * w.y + lab2D(s, labP.xy) * w.z; }
          return lab2D(s, labUv);
        }
        vec3 labPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
          vec3 vSigmaX = normalize(dFdx(surf_pos)); vec3 vSigmaY = normalize(dFdy(surf_pos)); vec3 vN = surf_norm;
          vec3 R1 = cross(vSigmaY, vN); vec3 R2 = cross(vN, vSigmaX); float fDet = dot(vSigmaX, R1) * faceDir;
          vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2); return normalize(abs(fDet) * surf_norm - vGrad);
        }`)
      .replace('#include <bumpmap_pars_fragment>', `#ifdef USE_BUMPMAP
        uniform sampler2D bumpMap; uniform float bumpScale;
        vec2 dHdxy_fwd() { float H = bumpScale * labTex(bumpMap).x; return vec2(dFdx(H), dFdy(H)); }
        #endif`)
      .replace('void main() {', `void labSetup() {
          labP = vLabP * uTriScale; labN = normalize(vLabN); labUv = vLabUv;
          if (uPom > 0.5 && uTri < 0.5) {
            // Parallax occlusion mapping i UV-läge: stega längs blicken genom höjdkartan
            vec3 V = normalize(vViewPosition); vec3 N = normalize(vNormal);
            vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition); vec2 st0 = dFdx(vLabUv), st1 = dFdy(vLabUv);
            vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
            vec3 T = q1perp * st0.x + q0perp * st1.x; vec3 B = q1perp * st0.y + q0perp * st1.y;
            float det = max(dot(T, T), dot(B, B)); float sc = det == 0.0 ? 0.0 : inversesqrt(det); T *= sc; B *= sc;
            vec3 Vt = vec3(dot(V, T), dot(V, B), dot(V, N));
            vec2 P = Vt.xy / max(Vt.z, 0.2) * uPomDepth * uTriScale;
            float dl = 1.0 / uPomSteps; vec2 duv = P * dl; vec2 t = vLabUv; float cur = 0.0;
            vec2 gx = dFdx(vLabUv), gy = dFdy(vLabUv);
            float d = 1.0 - textureGrad(uHeightF, t, gx, gy).x;
            for (int i = 0; i < 64; i++) { if (float(i) >= uPomSteps || cur >= d) break; t -= duv; cur += dl; d = 1.0 - textureGrad(uHeightF, t, gx, gy).x; }
            vec2 prev = t + duv; float after = d - cur; float before = (1.0 - textureGrad(uHeightF, prev, gx, gy).x) - cur + dl;
            labUv = mix(t, prev, after / (after - before + 1e-5));
          }
        }
        void main() { labSetup();`)
      .replace('#include <map_fragment>', `${lab(THREE.ShaderChunk.map_fragment)}
        {
          if (uDetail > 0.5) {
            float fade = 1.0 - smoothstep(uDetailFade * 0.5, uDetailFade, length(vViewPosition));
            vec4 dt = uTri > 0.5 ? (texture2D(uDetailTex, labP.zy * uDetailTiling) * labW3().x + texture2D(uDetailTex, labP.xz * uDetailTiling) * labW3().y + texture2D(uDetailTex, labP.xy * uDetailTiling) * labW3().z)
                                 : texture2D(uDetailTex, labUv * uDetailTiling);
            diffuseColor.rgb *= 1.0 + (dot(dt.rgb, vec3(0.333)) - 0.5) * 2.0 * uDetailStrength * fade;
          }
          if (uMacro > 0.0) diffuseColor.rgb *= 1.0 + (labFbm(vLabWP / uMacroScale) - 0.5) * uMacro * 1.4;
          float hB = labTex(uHeightF).x;
          float yN = clamp((vLabP.y - uBounds.x) / max(uBounds.y - uBounds.x, 1e-4), 0.0, 1.0);
          ${layerCode}
        }`)
      .replace('#include <roughnessmap_fragment>', `${lab(THREE.ShaderChunk.roughnessmap_fragment)}
        roughnessFactor = mix(roughnessFactor, labLR / max(labLM, 1e-3), labLM);`)
      .replace('#include <metalnessmap_fragment>', `${lab(THREE.ShaderChunk.metalnessmap_fragment)}
        metalnessFactor *= 1.0 - labLM;`)
      .replace('#include <aomap_fragment>', lab(THREE.ShaderChunk.aomap_fragment))
      .replace('#include <emissivemap_fragment>', `${lab(THREE.ShaderChunk.emissivemap_fragment)}
        totalEmissiveRadiance *= 1.0 - labLM;`)
      .replace('#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
        if (uTri > 0.5) {
          // Triplanara normaler med "whiteout"-blandning (Ben Golus), i objektets rum och sedan till vyrummet
          vec3 w = labW3(); vec3 n = labN;
          vec3 tx = lab2D(normalMap, labP.zy).xyz * 2.0 - 1.0; vec3 ty = lab2D(normalMap, labP.xz).xyz * 2.0 - 1.0; vec3 tz = lab2D(normalMap, labP.xy).xyz * 2.0 - 1.0;
          tx.xy *= normalScale; ty.xy *= normalScale; tz.xy *= normalScale;
          tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x); ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y); tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
          vec3 nObj = normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
          normal = normalize(nObj.x * vTX + nObj.y * vTY + nObj.z * vTZ) * faceDirection;
        } else {
          vec3 mapN = lab2D(normalMap, labUv).xyz * 2.0 - 1.0; mapN.xy *= normalScale;
          mat3 ltbn = getTangentFrame(-vViewPosition, normal, vLabUv);
          normal = normalize(ltbn * mapN);
        }
        #elif defined( USE_BUMPMAP )
        normal = labPerturb(-vViewPosition, normal, dHdxy_fwd(), faceDirection);
        #endif
        normal = normalize(mix(normal, normalize(vNormal) * faceDirection, labFlat));
        if (labReliefH > 0.0) normal = labPerturb(-vViewPosition, normal, vec2(dFdx(labReliefH), dFdy(labReliefH)), faceDirection);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        if (uSSS > 0.0) {
          // Stiliserad genomlysning: omslutande diffus plus ljus genom kanten i motljus
          vec3 L = directionalLights[0].direction; float nl = dot(normal, L);
          float wrap = max(0.0, (nl + 0.6) / 1.6) - max(0.0, nl);
          float back = pow(max(0.0, dot(normalize(vViewPosition), -L)), 3.0) * (1.0 - abs(nl));
          reflectedLight.directDiffuse += uSSSColor * diffuseColor.rgb * directionalLights[0].color * (wrap * 0.8 + back * 0.9) * uSSS;
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => 'tt-lab-1';

  // --- Modeller ---
  const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const modelCache = new Map();
  let model = null, modelId = 'sphere', dense = false, projection = 'auto', assetUrl = null;
  async function buildModel(id, isDense) {
    const key = `${id}:${isDense}:${id === 'asset' ? getAssetUrl?.() : ''}`;
    if (modelCache.has(key)) return modelCache.get(key);
    const group = new THREE.Group();
    let uvSize = [1, 1], tri = false;
    const add = (geo) => { const m = new THREE.Mesh(addCurvature(geo), mat); m.castShadow = m.receiveShadow = true; group.add(m); return m; };
    if (id === 'block') {
      add(isDense ? new THREE.BoxGeometry(1, 1, 1, 128, 128, 128).translate(0, 0.5, 0) : new RoundedBoxGeometry(1, 1, 1, 6, 0.06).translate(0, 0.5, 0));
    } else if (id === 'sphere') {
      add(new THREE.SphereGeometry(0.6, isDense ? 384 : 96, isDense ? 256 : 64).translate(0, 0.6, 0));
      uvSize = [2 * Math.PI * 0.6, Math.PI * 0.6];
    } else if (id === 'cylinder') {
      add(new THREE.CylinderGeometry(0.3, 0.36, 2.2, isDense ? 256 : 64, isDense ? 192 : 24).translate(0, 1.1, 0));
      uvSize = [2 * Math.PI * 0.33, 2.2];
    } else if (id === 'terrain') {
      add(terrainGeometry(isDense ? 400 : 200));
      uvSize = [60, 60];
    } else if (id === 'dragon' || id === 'asset') {
      const url = id === 'dragon' ? '/assets/imported/dragon_statue/dragon_statue.gltf' : getAssetUrl?.();
      if (!url) throw new Error('No tree in the studio yet: open the Tree tab first');
      const g = await gltf.loadAsync(url);
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        if (id === 'asset' && !/bark/i.test(o.material?.name ?? '')) { group.add(new THREE.Mesh(o.geometry.clone().applyMatrix4(o.matrixWorld), o.material)); return; }
        const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
        if (!geo.attributes.normal) geo.computeVertexNormals();
        add(geo);
      });
      tri = true;
    }
    const box = new THREE.Box3().setFromObject(group);
    const entry = { group, uvSize, tri, box };
    modelCache.set(key, entry);
    return entry;
  }
  async function showModel() {
    const e = await buildModel(modelId, dense);
    if (model) scene.remove(model.group);
    model = e;
    scene.add(e.group);
    ground.visible = modelId !== 'terrain';
    U.uBounds.value.set(e.box.min.y, e.box.max.y);
    updateGlow();
    applyProjection();
    frame();
  }
  function applyProjection() {
    const tri = projection === 'tri' || (projection === 'auto' && model?.tri);
    U.uTri.value = tri ? 1 : 0;
    const meters = state.meters;
    U.uTriScale.value = 1 / meters;
    const [su, sv] = model?.uvSize ?? [1, 1];
    U.uUvScale.value.set(su / meters, sv / meters);
    needsRender = true;
  }
  let distance = 'fit';
  function frame() {
    if (!model) return;
    const box = model.box, c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z) * 0.5;
    const d = distance === 'fit' ? r / Math.sin((camera.fov * Math.PI) / 360) * 1.3 : Number(distance);
    if (modelId === 'terrain') c.y = box.min.y + 2;
    const dir = camera.position.clone().sub(controls.target).normalize();
    if (dir.lengthSq() < 0.5) dir.set(0.6, 0.45, 0.7).normalize();
    if (modelId === 'terrain' && distance !== 'fit') dir.y = Math.min(dir.y, 0.3);
    controls.target.copy(c);
    camera.position.copy(c).addScaledVector(dir.normalize(), d);
    camera.near = Math.max(0.02, d / 200); camera.far = Math.max(200, d * 10);
    camera.updateProjectionMatrix();
    const s = Math.max(4, r * 3);
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.1, far: s * 6 });
    sun.shadow.camera.updateProjectionMatrix();
    needsRender = true;
  }

  // --- Material ---
  const state = { meters: 2 };
  let lastMaterial = null;
  const colorSpaceOf = (srgb) => (srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace);
  function applySampling(m) {
    const t = m.tex ?? {};
    const filter = t.filter ?? 'trilinear';
    const wrap = { repeat: THREE.RepeatWrapping, mirror: THREE.MirroredRepeatWrapping, clamp: THREE.ClampToEdgeWrapping }[t.wrap ?? 'repeat'];
    const aniso = Math.min(Number(t.anisotropy ?? 8), renderer.capabilities.getMaxAnisotropy());
    for (const [k, tex] of Object.entries(maps)) {
      if (tex === BLANK[k]) continue;
      tex.wrapS = tex.wrapT = wrap;
      tex.magFilter = filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
      tex.minFilter = filter === 'nearest' ? THREE.NearestFilter : filter === 'linear' ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = filter === 'trilinear';
      tex.anisotropy = aniso;
      tex.colorSpace = colorSpaceOf(k === 'color' || k === 'emissive' ? (t.color_space ?? 'srgb') === 'srgb' : t.data_space === 'srgb');
      tex.needsUpdate = true;
    }
  }
  function setMaterial(m) {
    lastMaterial = m;
    state.meters = m.meters ?? 2;
    const bump = m.normal?.mode === 'bump';
    const wantNormal = !bump;
    if (!!mat.normalMap !== wantNormal || !!mat.bumpMap !== bump) {
      mat.normalMap = wantNormal ? maps.normal : null;
      mat.bumpMap = bump ? maps.height : null;
      mat.needsUpdate = true;
    }
    mat.bumpScale = (m.normal?.strength ?? 1) * 1.5;
    mat.displacementScale = m.displace?.on ? m.displace.scale : 0;
    mat.displacementBias = m.displace?.on ? -m.displace.scale * 0.5 : 0;
    if (dense !== !!m.displace?.on) { dense = !!m.displace?.on; showModel(); }
    mat.emissiveIntensity = m.emission?.on ? m.emission.intensity : 0;
    updateGlow();
    const mode = m.alpha?.mode ?? 'off';
    const alphaTest = mode === 'cutout' ? m.alpha.test : 0;
    if ((mat.alphaTest > 0) !== (alphaTest > 0) || mat.transparent !== (mode === 'blend')) mat.needsUpdate = true;
    mat.alphaTest = alphaTest;
    mat.transparent = mode === 'blend';
    // Dubbelsidigt bara för alfa utan transmission: transmission med baksidor och anisotropi ger svart (NaN) i three.js
    const side = mode !== 'off' && !(m.transmission?.amount > 0) ? THREE.DoubleSide : THREE.FrontSide;
    if (mat.side !== side) { mat.side = side; mat.needsUpdate = true; }
    mat.transmission = m.transmission?.amount ?? 0;
    mat.thickness = m.transmission?.thickness ?? 0.3;
    mat.ior = m.transmission?.ior ?? 1.45;
    mat.specularIntensity = m.specular?.intensity ?? 1;
    mat.specularColor.set(m.specular?.color ?? '#ffffff');
    mat.clearcoat = m.clearcoat?.amount ?? 0;
    mat.clearcoatRoughness = m.clearcoat?.rough ?? 0.1;
    mat.sheen = m.sheen?.amount ?? 0;
    mat.sheenColor.set(m.sheen?.color ?? '#ffffff');
    mat.sheenRoughness = m.sheen?.rough ?? 0.5;
    mat.anisotropy = m.aniso?.amount ?? 0;
    mat.anisotropyRotation = ((m.aniso?.rotation ?? 0) * Math.PI) / 180;
    mat.iridescence = m.irid?.amount ?? 0;
    mat.iridescenceIOR = m.irid?.ior ?? 1.3;
    mat.iridescenceThicknessRange = [100, m.irid?.thickness ?? 400];
    U.uSSS.value = m.sss?.amount ?? 0;
    U.uSSSColor.value.set(m.sss?.color ?? '#e8b070');
    U.uPom.value = m.pom?.on ? 1 : 0;
    U.uPomDepth.value = m.pom?.depth ?? 0.04;
    U.uPomSteps.value = m.pom?.steps ?? 24;
    U.uNoTile.value = m.notile ? 1 : 0;
    U.uMacro.value = m.macro?.amount ?? 0;
    U.uMacroScale.value = m.macro?.scale ?? 20;
    U.uUvOff.value.set(m.uv?.offset_x ?? 0, m.uv?.offset_y ?? 0);
    U.uUvRot.value = ((m.uv?.rotation ?? 0) * Math.PI) / 180;
    U.uDetail.value = m.detail?.on ? 1 : 0;
    if (m.detail?.on) U.uDetailTex.value = loadLayerTex(m.detail.texture);
    U.uDetailTiling.value = m.detail?.tiling ?? 8;
    U.uDetailStrength.value = m.detail?.strength ?? 0.4;
    U.uDetailFade.value = m.detail?.fade ?? 8;
    applySampling(m);
    applyProjection();
  }
  async function setMaps(urls) {
    const entries = await Promise.all(Object.entries(urls).map(([k, u]) => loader.loadAsync(`${u}?v=${Date.now() % 1e9}`).then((t) => [k, t]).catch(() => [k, null])));
    const old = { ...maps };
    for (const k of Object.keys(BLANK)) maps[k] = BLANK[k];
    for (const [k, t] of entries) if (t) maps[k] = t;
    mat.map = maps.color; mat.roughnessMap = maps.rough; mat.metalnessMap = maps.metal; mat.aoMap = maps.ao;
    mat.emissiveMap = maps.emissive; mat.displacementMap = maps.height; U.uHeightF.value = maps.height;
    glowMean = meanOf(maps.emissive);
    updateGlow();
    if (mat.normalMap) mat.normalMap = maps.normal;
    if (mat.bumpMap) mat.bumpMap = maps.height;
    if (lastMaterial) applySampling(lastMaterial);
    for (const [k, t] of Object.entries(old)) if (t !== BLANK[k] && !Object.values(maps).includes(t)) t.dispose();
    needsRender = true;
  }
  function setLayers(layers) {
    const list = (layers ?? []).filter((l) => l.on !== false).slice(0, MAX_LAYERS);
    U.uLayerCount.value = list.length;
    list.forEach((l, i) => {
      U[`uL${i}`].value = loadLayerTex(l.texture ?? 'moss_painted');
      U[`uLA${i}`].value.set(l.amount ?? 0.6, l.heightmap ?? 0.6, l.sharp ?? 0.6, l.noise ?? 0.4);
      const d = DIRS[l.dir ?? 'up'];
      U[`uLB${i}`].value.set(d?.[0] ?? 0, d?.[1] ?? 1, d?.[2] ?? 0, d ? Math.cos(((l.width ?? 70) * Math.PI) / 180) : -2);
      U[`uLC${i}`].value.set(l.from ?? 0, l.to ?? 1, l.curv ?? 0, 1 / (l.scale ?? 1.5));
      U[`uLD${i}`].value.set(l.rough ?? 0.9, l.flatten ?? 0.6, l.relief ?? 0.5, 1 / (l.noise_scale ?? 0.6));
      U[`uLT${i}`].value.set(l.tint ?? '#ffffff');
    });
    needsRender = true;
  }
  function setLight(id) {
    const L = LIGHTS[id] ?? LIGHTS.sun;
    sun.color.set(L.sun[0]); sun.intensity = L.sun[1]; sun.position.set(...L.sun[2]).multiplyScalar(modelId === 'terrain' ? 6 : 1);
    hemi.color.set(L.hemi[0]); hemi.groundColor.set(L.hemi[1]); hemi.intensity = L.hemi[2];
    scene.environmentIntensity = (hdri ? Math.max(L.env, L.env > 0 ? 0.6 : 0) : L.env) * envScale;
    scene.background = hdri && hdriBg ? hdri.bg : new THREE.Color(L.bg);
    scene.backgroundIntensity = L.env > 0 ? 1 : 0.15;
    lightId = id;
    needsRender = true;
  }
  // HDRI: miljön (reflexer och omgivningsljus) byts från rummet till bilden; valfritt också som bakgrund
  const hdrLoader = new HDRLoader(), hdriCache = new Map();
  let hdri = null, hdriBg = false;
  async function setHdri(id) {
    if (!id) { hdri = null; scene.environment = roomEnv; setLight(lightId); return; }
    if (!hdriCache.has(id)) {
      const tex = await hdrLoader.loadAsync(`${HDRI_DIR}${id}`);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      hdriCache.set(id, { env: pmrem.fromEquirectangular(tex).texture, bg: tex });
    }
    hdri = hdriCache.get(id);
    scene.environment = hdri.env;
    setLight(lightId);
  }
  let lightId = 'sun', envScale = 1, turntable = false, visible = false, needsRender = true, wire = false;

  let insetL = 0, insetR = 0; // paneler över vyn till vänster och höger: modellen centreras mellan dem
  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    if (insetL || insetR) camera.setViewOffset(innerWidth, innerHeight, (insetR - insetL) / 2, 0, innerWidth, innerHeight);
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  addEventListener('resize', resize);
  controls.addEventListener('change', () => { needsRender = true; });
  let lastT = performance.now();
  const gate = frameGate();
  function loop() {
    if (!visible) return;
    requestAnimationFrame(loop);
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (turntable && model) { model.group.rotation.y += dt * 0.35; needsRender = true; }
    controls.update();
    if (needsRender && gate(now)) { renderer.render(scene, camera); needsRender = false; }
  }
  resize();
  setLight('sun');

  return {
    canvas, renderer, // renderer: för felsökning (programmens diagnostik, info)
    show() { visible = true; canvas.style.display = 'block'; resize(); if (!model) showModel().catch(() => {}); lastT = performance.now(); loop(); },
    hide() { visible = false; canvas.style.display = 'none'; },
    setMaps, setMaterial, setLayers, setLight,
    setInsets(l, r) { insetL = l; insetR = r; resize(); },
    async setModel(id) { modelId = id; await showModel(); setLight(lightId); },
    get modelId() { return modelId; },
    setTurntable(on) { turntable = on; },
    setDistance(d) { distance = d; frame(); },
    setProjection(p) { projection = p; applyProjection(); },
    setExposure(v) { renderer.toneMappingExposure = v; needsRender = true; },
    setEnv(v) { envScale = v; setLight(lightId); },
    setHdri, // filnamn i third_party/polyhaven_hdri, eller null för studiorummet
    setHdriBackground(on) { hdriBg = on; setLight(lightId); },
    setGlow(v) { glowScale = v; updateGlow(); needsRender = true; },
    setWire(on) { wire = on; mat.wireframe = on; needsRender = true; },
    shot() { renderer.render(scene, camera); return canvas.toDataURL('image/jpeg', 0.85); },
    stats() { return { tris: renderer.info.render.triangles, calls: renderer.info.render.calls }; },
  };
}
