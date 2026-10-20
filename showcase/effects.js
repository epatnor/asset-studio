// Bildeffekter och luftens liv för alla banor. Ren klientkod (ingen Node). Överfört och vidareutvecklat från
// Azshara Island (Godot), styrt av atmosfären (atmosphere.js) och menyns kvalitetsval.
//
// - Dimma (alla material, via FOG_GLSL): avståndsdimma som blir varm åt solen (sun scatter, som Valheims
//   blå dis), markdimma i sänkor (tjock på Azsharas mörka ö) och molnskuggor som driver över landskapet.
// - Volymetriskt solljus: ett helskärmspass som marscherar genom diset och läser solens skuggkarta, så att
//   strålar bildas genom glipor i kronor, hus och broar och följer solen över dygnet (Henyey-Greenstein).
//   Räknas i halv upplösning med jitter och läggs på bilden.
// - Glöd (bloom) på det som lyser: solen, fönster, lyktor och blixtar. Vinjett och färgton i sista passet.
// - Ljusstrålar mellan trädkronorna (createLightShafts), stoftkorn som glimmar i motljus, och regnstänk.
//
// Kvalitet (menyn): Låg/Medel ritar utan efterbehandling (CSS-färgton); Hög har glöd, vinjett och
// volymetriskt ljus i halv upplösning; Ultra fler steg.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// ---------- Dimma, markdimma och molnskuggor: delas av alla material ----------
// Materialen lägger in FOG_GLSL med patchFog (materials.js, ground.js, grass.js, water.js). Uniformerna
// (W.fogU) sätts av atmosfären varje bild.
export function createFogUniforms(THREE) {
  return {
    tkSunDir: { value: new THREE.Vector3(0, 1, 0) }, tkSunColor: { value: new THREE.Color('#ffd9a0') }, tkScatter: { value: 0.6 },
    tkGround: { value: new THREE.Vector4(0, 0, 6, 0) },   // markdimma: täthet, nivå (m), tjocklek (m), –
    tkCloud: { value: new THREE.Vector4(0, 0.012, 0, 0) }, // molnskuggor: styrka, skala, drift x, drift z
  };
}
const FOG_DECL = `
uniform vec3 tkSunDir, tkSunColor;
uniform float tkScatter;
uniform vec4 tkGround, tkCloud;
float tkHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tkNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tkHash(i), tkHash(i + vec2(1, 0)), u.x), mix(tkHash(i + vec2(0, 1)), tkHash(i + vec2(1, 1)), u.x), u.y);
}
#ifndef TK_WORLD_POS
#define TK_WORLD_POS (cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz)
#endif`;
const FOG_CODE = `
#ifdef USE_FOG
{
  vec3 tkW = TK_WORLD_POS;
  // Molnskuggor: mjuka fläckar som driver med vinden
  vec2 cq = tkW.xz * tkCloud.y + tkCloud.zw;
  float cl = tkNoise(cq) * 0.65 + tkNoise(cq * 2.3 + 7.1) * 0.35;
  gl_FragColor.rgb *= 1.0 - tkCloud.x * smoothstep(0.42, 0.72, cl);
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  // Markdimma: tjock nära marken under en nivå, tunnare uppåt
  float gf = tkGround.x * exp(-max(tkW.y - tkGround.y, 0.0) / tkGround.z) * (1.0 - exp(-vFogDepth * 0.035));
  fogFactor = clamp(max(fogFactor, gf), 0.0, 1.0);
  // Sun scatter: diset blir varmt och ljust åt solen
  vec3 vd = normalize(tkW - cameraPosition);
  float sa = pow(max(dot(vd, tkSunDir), 0.0), 6.0) * tkScatter;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(fogColor, tkSunColor, clamp(sa, 0.0, 1.0)), fogFactor);
}
#endif`;
// Byter ut Threes dimma i en shader (onBeforeCompile). worldPos: GLSL-uttryck för världspositionen om
// shadern inte har vViewPosition (t.ex. vattnets vW).
export function patchFog(shader, fogU, worldPos) {
  if (!fogU) return;
  Object.assign(shader.uniforms, fogU);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${worldPos ? `#define TK_WORLD_POS (${worldPos})` : ''}\n${FOG_DECL}`)
    .replace('#include <fog_fragment>', FOG_CODE);
}

// ---------- Volymetriskt solljus ----------
const VOL_FRAG = `
#include <packing>
uniform sampler2D tDepth, tShadow;
uniform mat4 uInvProj, uCamWorld, uShadowMatrix;
uniform vec3 uCamPos, uSunDir, uLight;
uniform float uDensity, uMaxDist, uHaze, uFrame, uAniso, uShadowBias;
varying vec2 vUv;
float phaseHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
float sunAt(vec3 p) {
  vec4 sc = uShadowMatrix * vec4(p, 1.0);
  vec3 s = sc.xyz / sc.w;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0; // utanför skuggkartan: solbelyst
  return step(s.z - uShadowBias, unpackRGBAToDepth(texture2D(tShadow, s.xy)));
}
void main() {
  float d = texture2D(tDepth, vUv).r;
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec3 world = (uCamWorld * vec4(v.xyz / v.w, 1.0)).xyz;
  vec3 ray = world - uCamPos;
  float dist = length(ray);
  vec3 dir = ray / max(dist, 1e-4);
  float march = min(dist, uMaxDist), stepL = march / float(STEPS);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * 5.588, vec2(0.06711056, 0.00583715))));
  float tr = 1.0, light = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = uCamPos + dir * (float(i) + jitter) * stepL;
    float haze = uDensity * (0.4 + 0.6 * exp(-max(p.y - uHaze, 0.0) / 14.0));
    light += sunAt(p) * haze * stepL * tr;
    tr *= exp(-haze * stepL);
  }
  float ph = phaseHG(dot(dir, uSunDir), uAniso) * 4.0 * 3.14159;
  gl_FragColor = vec4(uLight * light * ph, 1.0);
}`;
class VolumetricPass extends Pass {
  constructor(W, steps) {
    super();
    const { THREE } = W;
    this.W = W;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.march = new FullScreenQuad(new THREE.ShaderMaterial({
      defines: { STEPS: steps },
      uniforms: { tDepth: { value: null }, tShadow: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uShadowMatrix: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3() }, uLight: { value: new THREE.Color() },
        uDensity: { value: 0.012 }, uMaxDist: { value: 90 }, uHaze: { value: 0 }, uFrame: { value: 0 }, uAniso: { value: 0.5 }, uShadowBias: { value: 0.002 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: VOL_FRAG, depthTest: false, depthWrite: false,
    }));
    this.add = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tVol: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tColor, tVol; varying vec2 vUv; void main() { gl_FragColor = texture2D(tColor, vUv) + vec4(texture2D(tVol, vUv).rgb, 0.0); }',
      depthTest: false, depthWrite: false,
    }));
    this.intensity = 0.3;
  }
  setSize(w, h) { this.rt.setSize(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2))); }
  render(renderer, writeBuffer, readBuffer) {
    const { camera, sun } = this.W, u = this.march.material.uniforms;
    const shadow = sun.shadow.map;
    u.tDepth.value = readBuffer.depthTexture;
    u.tShadow.value = shadow?.texture ?? null;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uShadowMatrix.value.copy(sun.shadow.matrix);
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.uSunDir.value.subVectors(sun.position, sun.target.position).normalize();
    const a = this.W.atmo?.state, zone = this.W.atmo?.zone ?? {};
    const vis = a ? Math.max(0, 1 - 0.85 * Math.max(a.clouds, zone.storm ?? 0) - 0.3 * a.rain) : 1;
    u.uLight.value.copy(sun.color).multiplyScalar(sun.intensity * this.intensity * vis / 3.2);
    u.uDensity.value = 0.012 * (1 + 1.5 * (a?.haze ?? 0));
    u.uFrame.value = (u.uFrame.value + 1) % 64;
    const ok = !!shadow && this.W.renderer.shadowMap.enabled;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    if (ok) this.march.render(renderer);
    this.add.material.uniforms.tColor.value = readBuffer.texture;
    this.add.material.uniforms.tVol.value = this.rt.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.add.render(renderer);
  }
}

// Vinjett och färgton efter tonmappningen
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1 }, uCon: { value: 1 }, uVig: { value: 0.3 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat, uCon, uVig; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      c.rgb = (c.rgb - 0.5) * uCon + 0.5;
      vec2 o = (vUv - 0.5) * vec2(1.0, 0.8);
      c.rgb *= 1.0 - smoothstep(0.45, 0.95, length(o) * 2.0) * uVig;
      gl_FragColor = c;
    }`,
};

// ---------- Stoftkorn och regnstänk runt kameran ----------
function createMotes(W) {
  const { THREE } = W, n = 380, pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const U = { uCam: { value: new THREE.Vector3() }, uTime: W.wind.uTime, uSun: { value: new THREE.Vector3() }, uStrength: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: `uniform vec3 uCam, uSun; uniform float uTime, uStrength; varying float vA;
      void main() {
        const vec3 B = vec3(36.0, 10.0, 36.0);
        vec3 p = position * B + vec3(sin(uTime * 0.13 + position.y * 40.0), sin(uTime * 0.21 + position.x * 30.0) * 0.3, cos(uTime * 0.11 + position.z * 50.0)) * 1.5 + vec3(uTime * 0.12, 0.0, uTime * 0.05);
        vec3 w = vec3(mod(p.x - uCam.x, B.x) + uCam.x - B.x * 0.5, mod(p.y - uCam.y, B.y) + uCam.y - B.y * 0.4, mod(p.z - uCam.z, B.z) + uCam.z - B.z * 0.5);
        vec3 to = w - uCam; float d = length(to);
        float glint = 0.25 + 1.6 * pow(max(dot(to / d, uSun), 0.0), 6.0);
        vA = glint * smoothstep(0.8, 2.5, d) * (1.0 - smoothstep(14.0, 18.0, d)) * (0.5 + 0.5 * sin(uTime * 0.7 + position.x * 60.0)) * uStrength;
        vec4 mv = modelViewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(60.0 / -mv.z, 1.0, 4.0);
      }`,
    fragmentShader: `varying float vA; void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(1.0, 0.93, 0.75) * (1.0 - smoothstep(0.1, 0.5, d)) * vA, 1.0); }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  W.scene.add(pts);
  return U;
}
function createSplashes(W) {
  const { THREE } = W, n = 260, pos = new Float32Array(n * 3), age = new Float32Array(n).map(() => Math.random());
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAge', new THREE.BufferAttribute(age, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAmount: { value: 0 } }, transparent: true, depthWrite: false, fog: false,
    vertexShader: `attribute float aAge; uniform float uAmount; varying float vAge; varying float vOn;
      void main() { vAge = aAge; vOn = step(fract(float(gl_VertexID) * 0.6180339), uAmount);
        vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp((6.0 + aAge * 30.0) / -mv.z * 8.0, 1.0, 40.0); }`,
    fragmentShader: `varying float vAge; varying float vOn;
      void main() { if (vOn < 0.5) discard; vec2 q = (gl_PointCoord - 0.5) * vec2(1.0, 2.6); float r = length(q) * 2.0;
        float ring = smoothstep(0.75, 0.9, r) * (1.0 - smoothstep(0.92, 1.0, r)); gl_FragColor = vec4(vec3(0.85, 0.9, 0.95), ring * (1.0 - vAge) * 0.7); }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false; pts.visible = false;
  W.scene.add(pts);
  W.onFrame((dt) => {
    const rain = W.atmo?.state.rain ?? 0;
    pts.visible = rain > 0.05 && W.fp.active;
    mat.uniforms.uAmount.value = rain;
    if (!pts.visible) return;
    const c = W.camera.position;
    for (let i = 0; i < n; i++) {
      age[i] += dt * 2.2;
      if (age[i] >= 1) {
        age[i] = 0;
        const a = Math.random() * Math.PI * 2, r = 1.5 + Math.sqrt(Math.random()) * 13;
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        pos.set([x, W.fp.heightAt(x, z) + 0.03, z], i * 3);
      }
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.aAge.needsUpdate = true;
  });
}

// ---------- Ljusstrålar mellan trädkronorna ----------
// trees: [{ x, y, z, h, r }] (stam vid marken, höjd, kronans radie). En stråle börjar i en glipa strax utanför
// en krona, där kronorna runt om är täta, och faller längs solens riktning mot skuggad mark. Kort som
// vänder sig mot kameran; starkast i motljus. Följer solen över dygnet. zoneOk(x, z): får strålar (Azshara:
// inte på den mörka ön).
export function createLightShafts(W, trees, { heightAt, zoneOk = () => true, count = 260, seed = 77 } = {}) {
  const { THREE } = W;
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const CELL = 6, grid = new Map(), key = (i, j) => i * 92821 + j;
  for (const t of trees) { const k = key(Math.floor(t.x / CELL), Math.floor(t.z / CELL)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(t); }
  const canopyAt = (x, z) => {
    let c = 0;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const t of grid.get(key(Math.floor(x / CELL) + i, Math.floor(z / CELL) + j)) ?? []) {
        const d = Math.hypot(t.x - x, t.z - z); if (d < t.r) c = Math.max(c, 1 - (d / t.r) ** 2);
      }
    return c;
  };
  const ring = (x, z, R) => { let c = 0; for (let k = 0; k < 8; k++) c += canopyAt(x + Math.cos(k * 0.785) * R, z + Math.sin(k * 0.785) * R); return c / 8; };
  const start = [], drop = [], width = [], seeds = [];
  for (const t of trees) {
    if (start.length / 3 >= count) break;
    if (!zoneOk(t.x, t.z) || rnd() > 0.6) continue;
    const a = rnd() * Math.PI * 2, x = t.x + Math.cos(a) * t.r * (0.9 + rnd() * 0.4), z = t.z + Math.sin(a) * t.r * (0.9 + rnd() * 0.4);
    const top = t.y + t.h * 0.8, ground = heightAt(x, z);
    if (top - ground < 4) continue;
    const rc = ring(x, z, 5);
    if (rc < 0.3 || canopyAt(x, z) > rc * 0.6) continue; // en glipa i en annars tät krontak
    start.push(x, top, z); drop.push(top - ground); width.push(2.5 + rnd() * 3); seeds.push(rnd());
  }
  const n = start.length / 3;
  if (!n) return null;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('iStart', new THREE.InstancedBufferAttribute(new Float32Array(start), 3));
  geo.setAttribute('iDrop', new THREE.InstancedBufferAttribute(new Float32Array(drop), 1));
  geo.setAttribute('iWidth', new THREE.InstancedBufferAttribute(new Float32Array(width), 1));
  geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(new Float32Array(seeds), 1));
  geo.instanceCount = n;
  const U = { uSun: { value: new THREE.Vector3(0, 1, 0) }, uColor: { value: new THREE.Color('#ffdb99') }, uStrength: { value: 0.5 }, uTime: W.wind.uTime };
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    vertexShader: `attribute vec3 iStart; attribute float iDrop, iWidth, iSeed; uniform vec3 uSun;
      varying vec2 vUv; varying float vSeed, vView, vDist;
      void main() {
        vec3 down = -normalize(uSun); float len = iDrop / max(-down.y, 0.25) * 1.1;
        vec3 axis = down * len, mid = iStart + axis * 0.5;
        vec3 toCam = normalize(cameraPosition - mid), side = normalize(cross(normalize(axis), toCam));
        vec3 w = iStart + axis * position.y + side * (position.x - 0.5) * iWidth;
        vUv = position.xy; vSeed = iSeed; vDist = length(cameraPosition - mid);
        vView = max(dot(-toCam, normalize(uSun)), 0.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: `uniform vec3 uColor; uniform float uStrength, uTime; varying vec2 vUv; varying float vSeed, vView, vDist;
      void main() {
        float across = smoothstep(0.0, 0.45, vUv.x) * smoothstep(1.0, 0.55, vUv.x);
        float along = smoothstep(0.05, 0.35, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
        float sh = 0.45 + 0.9 * smoothstep(0.3, 0.75, 0.5 + 0.5 * sin(vUv.x * 9.0 + vSeed * 40.0 + uTime * 0.25) * sin(vUv.y * 5.0 - uTime * 0.1));
        float fade = smoothstep(2.4, 6.0, vDist) * (1.0 - smoothstep(66.0, 110.0, vDist));
        float a = across * along * sh * (0.15 + 0.85 * pow(vView, 3.0)) * fade * uStrength * (0.6 + 0.8 * vSeed);
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  W.scene.add(mesh);
  W.onFrame(() => {
    U.uSun.value.subVectors(W.sun.position, W.sun.target.position).normalize();
    const a = W.atmo?.state, zone = W.atmo?.zone ?? {};
    const day = Math.max(0, Math.min(1, (U.uSun.value.y - 0.08) / 0.25));
    U.uStrength.value = 0.55 * day * (a ? Math.max(0, 1 - 0.9 * Math.max(a.clouds - 0.2, 0) - a.rain - (zone.storm ?? 0)) : 1);
    U.uColor.value.copy(W.sun.color);
    mesh.visible = U.uStrength.value > 0.01;
  });
  return { mesh, count: n };
}

// ---------- Efterbehandlingen ----------
export function createEffects(W) {
  const { THREE, renderer, scene, camera } = W;
  const motes = createMotes(W);
  createSplashes(W);
  let composer = null, vol = null, bloom = null, grade = null, quality = 'Hög';
  function build() {
    const size = renderer.getSize(new THREE.Vector2()), pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType });
    rt.depthTexture = new THREE.DepthTexture(size.x * pr, size.y * pr);
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    vol = new VolumetricPass(W, quality === 'Ultra' ? 24 : 14);
    composer.addPass(vol);
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.55, 0.92);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    composer.setSize(size.x, size.y);
  }
  addEventListener('resize', () => composer?.setSize(innerWidth, innerHeight));
  const fx = {
    active: false,
    setQuality(name) {
      quality = name;
      const on = name === 'Hög' || name === 'Ultra';
      if (on) { composer?.dispose?.(); build(); }
      fx.active = on;
    },
    render() {
      motes.uCam.value.copy(camera.position);
      motes.uSun.value.subVectors(W.sun.position, W.sun.target.position).normalize();
      const a = W.atmo?.state;
      motes.uStrength.value = a ? Math.max(0, 1 - a.rain - a.snow - (W.atmo.zone.storm ?? 0) * 0.7) : 1;
      if (!fx.active) { renderer.render(scene, camera); return; }
      grade.uniforms.uSat.value = W.grade?.sat ?? 1;
      grade.uniforms.uCon.value = W.grade?.con ?? 1;
      composer.render();
    },
  };
  return fx;
}
