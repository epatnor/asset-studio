// Vädermodulen (docs/effektlabb.md, E4): solen över dygnet, himlen och ljusstrålarna, i TSL, så att samma kod körs i
// Väderkvarnens Väderflik och i Tinkertown (WebGPU, med WebGL2 som reserv). Börjar med ljusstrålar; moln, regn, snö,
// dimma och blixtar kommer i samma modul. Recepten är data (tools/weather/weather.json, sparade i assets/weather/).
//
//   const sun = sunAt(hour, azimuth);        // riktning, färg, styrka och himlens färger
//   scene.backgroundNode = sky.node;          // const sky = createSky(); sky.set(sun, glow)
//   const shafts = createShafts({ sceneColor, sceneDepth, camera, light }); pipeline.outputNode = shafts.node
//
// Ljusstrålarna (FX11 i AAA-referensen, patriks_input/AAA_Game_VFX_ThreeJS_Reference.md) är volymetriskt solljus:
// three.js GodraysNode (från three-good-godrays, MIT) marscherar från kameran genom luften och läser solens
// skuggkarta, så att strålar bildas där ljuset går genom glipor i kronor och mellan hus och skuggas där det inte gör
// det. Resultatet suddas med ett bilateralt filter (kanterna mot föremål bevaras) och läggs ovanpå bilden som ljus,
// starkast när man ser mot solen (Henyey-Greenstein, som visningens volymetriska ljus): i motljus lyser strålarna, från
// sidan är luften nästan klar. Kräver att solen och föremålen kastar skuggor.
import * as THREE from 'three/webgpu';
import { uniform, mix, smoothstep, pow, max, dot, normalize, positionWorldDirection, getViewPosition, screenUV, vec4, cameraProjectionMatrixInverse, cameraWorldMatrix, float } from 'three/tsl';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js';

const C = (c) => new THREE.Color(c);
const lerpC = (a, b, t) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Solen: en nordisk sommardag, upp klockan 5, högst 55° klockan 13, ned klockan 21 (och lite under horisonten före
// och efter). azimuth är kompassriktningen i grader, 0 = mot -z. Färgerna går från varmt orange lågt till vitt högt,
// himlen från natt via gryning till dag.
export const SUNRISE = 5, SUNSET = 21;
export function sunAt(hour, azimuth = 0) {
  const el = Math.sin(((hour - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI) * 55 * (Math.PI / 180);
  const s = Math.sin(el), a = azimuth * (Math.PI / 180);
  const dir = new THREE.Vector3(Math.sin(a) * Math.cos(el), s, -Math.cos(a) * Math.cos(el)).normalize();
  const day = smooth(-0.08, 0.35, s), low = 1 - smooth(0.02, 0.45, s);
  return {
    dir, elevation: el, day,
    strength: smooth(-0.04, 0.18, s), // solens styrka (0 när den har gått ned)
    color: lerpC(C('#ff9a55'), C('#fff3dc'), smooth(0.04, 0.55, s)),
    zenith: lerpC(lerpC(C('#070b18'), C('#2a3f78'), smooth(-0.15, 0.05, s)), C('#3f7cd0'), day),
    horizon: lerpC(lerpC(C('#121626'), C('#e8875a'), smooth(-0.12, 0.04, s)), C('#c4dcf2'), day * (1 - low * 0.6)),
    ambient: 0.12 + 0.9 * day,
  };
}

// Himlen: en gradient från horisonten till zenit, en solskiva och ett sken runt den (som lyser i glöden)
export function createSky() {
  const u = { zenith: uniform(C('#3f7cd0')), horizon: uniform(C('#c4dcf2')), sunColor: uniform(C('#fff3dc')), sunDir: uniform(new THREE.Vector3(0, 1, 0)), glow: uniform(1), sun: uniform(1) };
  const d = normalize(positionWorldDirection);
  const h = max(d.y, 0);
  const sky = mix(u.horizon, u.zenith, pow(h, 0.55));
  const c = max(dot(d, u.sunDir), 0);
  const disc = smoothstep(0.9993, 0.9997, c).mul(30);
  const halo = pow(c, 64).mul(1.4).add(pow(c, 6).mul(0.35));
  const node = sky.add(u.sunColor.mul(disc.add(halo)).mul(u.glow).mul(u.sun));
  return {
    node, uniforms: u,
    set(sun, glow = 1) { u.zenith.value.copy(sun.zenith); u.horizon.value.copy(sun.horizon); u.sunColor.value.copy(sun.color); u.sunDir.value.copy(sun.dir); u.glow.value = glow; u.sun.value = sun.strength; },
  };
}

// Ljusstrålarna: godrays genom skuggkartan, bilateralt suddade, inblandade mot strålarnas färg
const QUALITY = { low: { scale: 0.25, steps: 30 }, medium: { scale: 0.5, steps: 60 }, high: { scale: 1, steps: 90 } };
export function createShafts({ sceneColor, sceneDepth, camera, light }) {
  const rays = godrays(sceneDepth, camera, light);
  const blur = bilateralBlur(rays.getTextureNode());
  const color = uniform(C('#ffd9a0')), sunDir = uniform(new THREE.Vector3(0, 1, 0)), g = uniform(0.6), amount = uniform(1);
  // Blickens riktning i världen för varje bildpunkt, ur djupet
  const view = getViewPosition(screenUV, sceneDepth.sample(screenUV), cameraProjectionMatrixInverse);
  const dir = normalize(cameraWorldMatrix.mul(vec4(view, 0)).xyz);
  const c = dot(dir, sunDir), g2 = g.mul(g);
  const hg = float(1).sub(g2).div(pow(max(float(1).add(g2).sub(g.mul(2).mul(c)), 1e-3), 1.5)); // 4π · Henyey-Greenstein
  const d = blur.getTextureNode().sample(screenUV).r;
  const base = sceneColor.sample(screenUV);
  const node = vec4(base.rgb.mul(float(1).sub(d.mul(0.2))).add(color.mul(d).mul(hg.mul(0.35).add(0.2)).mul(amount)), base.a);
  return {
    node, rays, color,
    // s: { shafts, density, falloff, quality, backlight } ur weather.json; tint: strålarnas färg; dir: mot solen
    set(s, tint, dir) {
      g.value = s.backlight ?? 0.6;
      if (dir) sunDir.value.copy(dir);
      rays.maxDensity.value = s.shafts;
      rays.density.value = s.density;
      rays.distanceAttenuation.value = s.falloff;
      const q = QUALITY[s.quality] ?? QUALITY.medium;
      rays.raymarchSteps.value = q.steps;
      rays.resolutionScale = q.scale;
      if (tint) color.value.copy(tint);
    },
  };
}
