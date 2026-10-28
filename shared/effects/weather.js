// Vädermodulen (docs/effektlabb.md, E4): en gemensam atmosfär för Väderkvarnens Väder- och Vatten-flikar och Tinkertown
// (WebGPU, med WebGL2 som reserv). Allt läser samma väderläge, så att solen, himlen, molnen, dimman, nederbörden,
// skuggorna och vattnets speglingar alltid hänger ihop (patriks_input/AAA_Weather_Sky_Atmosphere_Lighting_ThreeJS_Reference.md:
// billig och sammanhållen först, dyrt bara som tillval). Recepten är data (tools/weather/weather.json, sparade i
// assets/weather/).
//
//   const atm = createAtmosphere({ scene });   // himlen, dimman, ljusen, regnet och snön, blixtarna
//   atm.set(state); atm.moveTo(center);         // väderläget ur weather.json; var skuggorna ska ligga
//   atm.update(dt, time, camera)                // varje bildruta
//   atm.sky.colorAt(dir)                        // himlens färg i en riktning (vattnets spegling)
//
// - Solen över en nordisk sommardag (upp 5, högst 55° klockan 13, ned 21) och natten (som djupast 28° under horisonten
//   klockan 1). Månen står mitt emot solen, med faser; när den lyser mer än solen tar den över nyckelljuset och skuggorna.
// - Himlen: en gradient som grånar när det mulnar, en solskiva med sken, stjärnor som tindrar på natten, månen med sin
//   fas och sina hav, och moln målade på himlavalvet: fbm-brus projicerat på ett plan högt upp, driver med vinden,
//   ljusare på sidan mot solen (eller månen) med silverkant i motljus och mörka undersidor när de tätnar. Ingen
//   strålmarsch (den dyra nivån i referensen).
// - Dimman är exponentiell höjddimma (integrerad längs strålen: tätast nere vid marken) plus dis på avstånd, i himlens
//   färg och ljusare mot solen; himlen tonar mot samma dimma vid horisonten.
// - Regn och snö: partiklar på grafikkortet i en låda som följer kameran (inga uppdateringar på processorn); regnet är
//   streck längs fallriktningen, snön flingor som virvlar. Vinden lutar båda.
// - Åska: blixtar (spells.js) långt bort med ojämna mellanrum, som lyser upp molnen, himlen och marken i några fladder.
// - Ljusstrålarna (createShafts, FX11 i VFX-referensen) läser nyckelljusets skuggkarta, så de fungerar i månsken också.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uint, float, vec2, vec3, vec4, mix, smoothstep, pow, max, dot, normalize, length, sqrt, exp, sin, abs, fract, floor,
  select, saturate, atan, hash, instanceIndex, uv, fog, renderGroup, positionWorld, positionWorldDirection, cameraPosition, cameraViewMatrix,
  getViewPosition, screenUV, cameraProjectionMatrixInverse, cameraWorldMatrix, mx_fractal_noise_float, mx_noise_float,
} from 'three/tsl';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js';
import { createLightning } from './spells.js';

const C = (c) => new THREE.Color(c);
const lerpC = (a, b, t) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;

// ---------- Solen och månen ----------
export const SUNRISE = 5, SUNSET = 21;
const elevationAt = (hour, peak, night) => {
  const h = ((hour % 24) + 24) % 24;
  if (h >= SUNRISE && h <= SUNSET) return Math.sin(((h - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI) * peak * DEG;
  return -Math.sin((((h - SUNSET + 24) % 24) / (24 - SUNSET + SUNRISE)) * Math.PI) * night * DEG;
};
const dirAt = (el, azimuth) => { const a = azimuth * DEG; return new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el)).normalize(); };
// azimuth är kompassriktningen i grader, 0 = mot -z. Färgerna går från varmt orange lågt till vitt högt,
// himlen från natt via gryning till dag.
export function sunAt(hour, azimuth = 0) {
  const el = elevationAt(hour, 55, 28), dir = dirAt(el, azimuth), s = Math.sin(el);
  const day = smooth(-0.08, 0.35, s), low = 1 - smooth(0.02, 0.45, s);
  return {
    dir, elevation: el, day,
    strength: smooth(-0.04, 0.18, s), // solens styrka (0 när den har gått ned)
    color: lerpC(C('#ff9a55'), C('#fff3dc'), smooth(0.04, 0.55, s)),
    zenith: lerpC(lerpC(C('#060a16'), C('#2a3f78'), smooth(-0.15, 0.05, s)), C('#3f7cd0'), day),
    horizon: lerpC(lerpC(C('#10141f'), C('#e8875a'), smooth(-0.12, 0.04, s)), C('#c4dcf2'), day * (1 - low * 0.6)),
    ambient: 0.12 + 0.9 * day,
  };
}
// Månen mitt emot solen: uppe på natten (högst 34°), nere på dagen
export function moonAt(hour, azimuth = 0) {
  const el = -elevationAt(hour, 30, 38) * 0.9, dir = dirAt(el, azimuth + 180);
  return { dir, elevation: el, up: smooth(-0.03, 0.12, Math.sin(el)) };
}

// ---------- Himlen ----------
export function createSky() {
  const u = {
    zenith: uniform(C('#3f7cd0')), horizon: uniform(C('#c4dcf2')), sunColor: uniform(C('#fff3dc')), sunDir: uniform(new THREE.Vector3(0, 1, 0)), glow: uniform(1), sun: uniform(1),
    moonDir: uniform(new THREE.Vector3(0, -1, 0)), moonRight: uniform(new THREE.Vector3(1, 0, 0)), moonUpV: uniform(new THREE.Vector3(0, 1, 0)), moonL: uniform(new THREE.Vector3(0, 0, 1)), moon: uniform(0), stars: uniform(0),
    clouds: uniform(0), cloudSoft: uniform(0.25), cloudScale: uniform(1), cloudOffset: uniform(new THREE.Vector2()), cloudDark: uniform(0.3), cloudLit: uniform(C('#ffffff')), cloudShade: uniform(C('#8090a8')),
    fogColor: uniform(C('#c4dcf2')), fogAmount: uniform(0), flash: uniform(0), time: uniform(0),
  };
  const MOON_R = 0.024;
  // Molnens täthet i en riktning (ett plan högt upp); fine: fem oktaver och belysning, annars tre (för speglingar)
  const cloudsAt = (d, fine) => {
    const p = d.xz.div(max(d.y, 0.04)).mul(u.cloudScale.mul(0.35)).add(u.cloudOffset);
    // fbm-bruset ligger mest inom ±0,4: sträck ut det till 0..1 så att täckningen motsvarar andelen himmel
    const n = saturate(mx_fractal_noise_float(vec3(p, u.time.mul(0.004)), fine ? 5 : 3, 2.1, 0.5).mul(1.25).add(0.5));
    const cover = u.clouds.mul(1.05);
    const dens = smoothstep(float(1).sub(cover), float(1).sub(cover).add(u.cloudSoft), n).mul(smoothstep(0.01, 0.16, d.y));
    // Ljuset: tätare mot ljuskällan betyder skugga på den här sidan
    const toward = select(u.sun.greaterThan(u.moon.mul(0.5)), u.sunDir, u.moonDir);
    const n2 = fine ? saturate(mx_fractal_noise_float(vec3(p.add(toward.xz.mul(0.08)), u.time.mul(0.004)), 3, 2.1, 0.5).mul(1.25).add(0.5)) : n.mul(0.97);
    const lit = saturate(n.sub(n2).mul(2.5).add(0.55)).mul(float(1).sub(dens.mul(u.cloudDark).mul(0.7)));
    return { dens, lit };
  };
  const colorAt = (dir, discGain = 1, fine = true) => {
    const d = normalize(dir), up = max(d.y, 0);
    let sky = mix(u.horizon, u.zenith, pow(up, 0.55));
    // Stjärnor: ett rutnät på himlavalvet, en stjärna i några få rutor, som tindrar
    const g = d.mul(170), cell = floor(g), f = fract(g).sub(0.5);
    const h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const star = smoothstep(0.996, 1, h).mul(float(1).sub(smoothstep(0.05, 0.32, length(f)))).mul(sin(u.time.mul(2.3).add(h.mul(90))).mul(0.35).add(0.65));
    sky = sky.add(vec3(star.mul(u.stars).mul(smoothstep(0, 0.12, d.y)).mul(2.2)));
    // Månen med fas och hav (månens ram och ljusets riktning i den räknas på processorn)
    const mc = dot(d, u.moonDir), q = d.sub(u.moonDir.mul(mc));
    const mu = dot(q, u.moonRight).div(MOON_R), mv = dot(q, u.moonUpV).div(MOON_R), r2 = mu.mul(mu).add(mv.mul(mv));
    const disc = float(1).sub(smoothstep(0.86, 1, r2)).mul(select(mc.greaterThan(0), 1, 0));
    const mz = sqrt(max(float(1).sub(r2), 0));
    const shade = smoothstep(-0.06, 0.1, mu.mul(u.moonL.x).add(mv.mul(u.moonL.y)).add(mz.mul(u.moonL.z)));
    const maria = float(1).sub(mx_noise_float(vec3(mu.mul(2.2), mv.mul(2.2), 3.1)).mul(0.5).add(0.5).mul(0.35));
    const moonGlow = pow(max(mc, 0), 900).mul(0.25).add(pow(max(mc, 0), 60).mul(0.04));
    const moonCol = vec3(0.93, 0.95, 1).mul(disc.mul(shade.mul(maria).mul(1.6).add(0.03)).add(moonGlow)).mul(u.moon);
    // Solen
    const c = max(dot(d, u.sunDir), 0);
    const sunDisc = smoothstep(0.9993, 0.9997, c).mul(30 * discGain);
    const halo = pow(c, 64).mul(1.4).add(pow(c, 6).mul(0.35));
    // Molnen täcker stjärnorna, månen och solskivan; silverkant i motljus
    const cl = cloudsAt(d, fine);
    sky = sky.add(moonCol.mul(float(1).sub(cl.dens)));
    const silver = pow(c, 10).mul(cl.dens).mul(float(1).sub(cl.dens)).mul(4);
    const cloudCol = mix(u.cloudShade, u.cloudLit, cl.lit).add(u.sunColor.mul(silver).mul(u.sun));
    sky = mix(sky, cloudCol, cl.dens.mul(0.97));
    sky = sky.add(u.sunColor.mul(sunDisc.mul(float(1).sub(cl.dens)).add(halo.mul(float(1).sub(cl.dens.mul(0.6))))).mul(u.glow).mul(u.sun));
    // Dimman vid horisonten, och blixtens sken (starkast i molnen)
    sky = mix(sky, u.fogColor, u.fogAmount.mul(float(1).sub(smoothstep(0, 0.35, d.y))));
    sky = sky.add(vec3(0.75, 0.8, 1).mul(u.flash).mul(cl.dens.mul(1.6).add(0.25)));
    return select(d.y.lessThan(0), mix(u.horizon, u.fogColor, u.fogAmount.mul(0.5).add(0.5)), sky);
  };
  const node = colorAt(positionWorldDirection);
  return { node, uniforms: u, colorAt };
}

// ---------- Höjddimman ----------
// Tätheten avtar exponentiellt med höjden (tjocklek fogHeight); integralen längs strålen från kameran ger hur mycket
// dimma som ligger framför. Plus dis på avstånd (som FogExp2). Ljusare och varmare mot solen.
export function createFog() {
  // Dimman gäller alla material i scenen, också de som three.js gör om från vanliga material (glTF): dess värden måste
  // därför laddas upp en gång per bild (renderGroup), annars fryser de i de materialen vid första kompileringen
  const g = (v) => uniform(v).setGroup(renderGroup);
  const u = { color: g(C('#c4dcf2')), density: g(0), falloff: g(0.1), base: g(0), haze: g(0.01), sunDir: g(new THREE.Vector3(0, 1, 0)), sunColor: g(C('#ffffff')), sun: g(1), flash: g(0) };
  const factor = Fn(() => {
    const ray = positionWorld.sub(cameraPosition), dist = length(ray), k = u.falloff.mul(ray.y);
    const shape = select(abs(k).greaterThan(1e-3), float(1).sub(exp(k.negate())).div(k), float(1));
    const height = u.density.mul(exp(u.falloff.mul(cameraPosition.y.sub(u.base)).negate().max(-30))).mul(dist).mul(shape);
    const hz = u.haze.mul(dist);
    return float(1).sub(exp(height.add(hz.mul(hz)).negate()));
  })();
  const view = normalize(positionWorld.sub(cameraPosition));
  const glow = pow(max(dot(view, u.sunDir), 0), 6).mul(0.6).mul(u.sun);
  const color = u.color.add(u.sunColor.mul(glow)).add(vec3(0.6, 0.65, 0.8).mul(u.flash.mul(0.5)));
  return { node: fog(color, factor), uniforms: u };
}

// ---------- Regn och snö ----------
// En låda (36 × 24 × 36 m) som följer kameran; varje droppe har en egen plats och fart ur sitt nummer och flyttas
// bara i shadern. Antalet är det som syns: mängden × max.
export function createPrecipitation({ max: MAX = 16000 } = {}) {
  const u = { time: uniform(0), snow: uniform(0), wind: uniform(new THREE.Vector3()), color: uniform(C('#b8c4d4')), alpha: uniform(0.35) };
  const B = vec3(36, 24, 36);
  const rnd = (k) => hash(instanceIndex.add(uint(k)));
  const isSnow = u.snow.greaterThan(0.5);
  const speed = select(isSnow, rnd(3).mul(0.6).add(0.9), rnd(3).mul(4).add(9));
  const vel = vec3(u.wind.x, speed.negate(), u.wind.z).mul(select(isSnow, vec3(0.7, 1, 0.7), vec3(0.35, 1, 0.35)));
  const seed = vec3(rnd(1), rnd(2), rnd(4)).mul(B);
  const sway = select(isSnow, vec3(sin(u.time.mul(rnd(5).mul(1.2).add(0.6)).add(rnd(6).mul(6.28))), 0, sin(u.time.mul(rnd(7).mul(1.1).add(0.5)).add(rnd(8).mul(6.28)))).mul(0.35), vec3(0));
  const pos = cameraPosition.add(fract(seed.add(vel.mul(u.time)).sub(cameraPosition).div(B)).sub(0.5).mul(B)).add(vec3(0, 6, 0)).add(sway);
  const dist = length(pos.sub(cameraPosition));
  const fade = smoothstep(0.8, 2.5, dist).mul(float(1).sub(smoothstep(11, 17, dist)));
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  mat.positionNode = pos;
  const vv = cameraViewMatrix.mul(vec4(vel, 0)).xy;
  const size = select(isSnow, rnd(9).mul(0.035).add(0.03), float(0.011));
  mat.scaleNode = select(isSnow, vec2(size), vec2(speed.mul(0.05), size));
  mat.rotationNode = select(isSnow, float(0), atan(vv.y, vv.x));
  const p = uv().sub(0.5);
  const shape = select(isSnow, float(1).sub(smoothstep(0.15, 0.5, length(p))), float(1).sub(abs(p.y).mul(2)).mul(float(1).sub(smoothstep(0.3, 0.5, abs(p.x)))));
  mat.colorNode = select(isSnow, u.color.mul(1.6), u.color);
  mat.opacityNode = shape.mul(fade).mul(select(isSnow, u.alpha.mul(2.2), u.alpha));
  const sprite = new THREE.Sprite(mat);
  sprite.count = 1;
  sprite.frustumCulled = false;
  sprite.renderOrder = 5;
  sprite.visible = false;
  return {
    object: sprite, uniforms: u,
    // kind: 'none' | 'rain' | 'snow'; amount 0..1; wind [x, z] m/s; color: ljuset den får
    set({ kind, amount, wind = [0, 0], color }) {
      const n = Math.round(Math.max(0, Math.min(1, amount)) * MAX);
      sprite.visible = kind !== 'none' && n > 0;
      sprite.count = Math.max(1, n);
      u.snow.value = kind === 'snow' ? 1 : 0;
      u.wind.value.set(wind[0], 0, wind[1]);
      if (color) u.color.value.copy(color);
    },
    update(time) { u.time.value = time; },
  };
}

// ---------- Atmosfären: allt ovan styrt av ett väderläge ----------
// lightDistance: hur långt från mitten solen står (skuggkameran räcker dubbelt så långt); större för stora platser
export function createAtmosphere({ scene, shadowSize = 2048, shadowRange = 30, lightDistance = 80 }) {
  const sky = createSky(), fogFx = createFog(), precip = createPrecipitation();
  scene.backgroundNode = sky.node;
  scene.fogNode = fogFx.node;
  const hemi = new THREE.HemisphereLight('#cfe0ff', '#4a5a30', 1);
  // Nyckelljuset är solen på dagen och månen på natten (aldrig dolt: att dölja ljus kompilerar om alla material)
  const key = new THREE.DirectionalLight('#ffffff', 3);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.04;
  Object.assign(key.shadow.camera, { left: -shadowRange, right: shadowRange, top: shadowRange, bottom: -shadowRange, near: 1, far: Math.max(160, lightDistance * 2) });
  // Blixtens ljus: alltid med, styrka 0 mellan blixtarna
  const flashLight = new THREE.DirectionalLight('#c8d4ff', 0);
  const bolt = createLightning({ color: '#b9b0ff', core: '#ffffff', width: 0.9, jitter: 0.5, branches: 6, regen: 0.06, intensity: 5 });
  bolt.object.visible = false;
  bolt.object.traverse((o) => { if (o.material) o.material.fog = false; });
  scene.add(hemi, key, key.target, flashLight, flashLight.target, precip.object, bolt.object);
  const center = new THREE.Vector3(), cloudOffset = new THREE.Vector2();
  let st = {}, sun = sunAt(12), moon = moonAt(12), exposure = 1, rain = 0, keyDir = sun.dir;
  let nextFlash = 3, flashT = -10, flashPeak = 1;
  const boltFrom = new THREE.Vector3(), boltTo = new THREE.Vector3();

  function apply() {
    const s = st;
    sun = sunAt(s.hour, s.azimuth);
    moon = moonAt(s.hour, s.azimuth);
    const cover = s.clouds ?? 0, dark = s.cloudDark ?? 0.3, night = 1 - sun.day, lit = s.moonPhase ?? 1, ml = s.moonlight ?? 1;
    const moonI = ml * moon.up * (0.15 + 0.85 * lit) * (1 - 0.75 * cover) * 0.35;
    const sunI = (s.sun ?? 3) * sun.strength * (1 - 0.82 * Math.pow(cover, 1.4));
    // Himlen: grånar och mörknar när det mulnar; natten lyfts av månen
    const grey = (c, k) => { const l = c.r * 0.3 + c.g * 0.55 + c.b * 0.15; return c.clone().lerp(new THREE.Color(l, l, l * 1.04), k); };
    const darken = 1 - cover * dark * 0.55;
    const moonLift = C('#16243f').multiplyScalar(moon.up * lit * ml * night);
    const zenith = grey(sun.zenith, Math.pow(cover, 1.3) * 0.85).multiplyScalar(darken).add(moonLift);
    const horizon = grey(sun.horizon, Math.pow(cover, 1.3) * 0.8).multiplyScalar(darken).add(moonLift.clone().multiplyScalar(0.8));
    const U = sky.uniforms;
    U.zenith.value.copy(zenith); U.horizon.value.copy(horizon);
    U.sunColor.value.copy(sun.color); U.sunDir.value.copy(sun.dir); U.glow.value = s.glow ?? 1; U.sun.value = sun.strength * (1 - 0.5 * cover);
    U.moonDir.value.copy(moon.dir);
    U.moonRight.value.crossVectors(moon.dir, new THREE.Vector3(0, 1, 0)).normalize();
    U.moonUpV.value.crossVectors(U.moonRight.value, moon.dir).normalize();
    const a = Math.acos(1 - 2 * Math.min(1, Math.max(0, lit))); // 0 ny, π full
    U.moonL.value.set(Math.sin(a), 0.15, -Math.cos(a)).normalize();
    U.moon.value = moon.up * ml * (0.15 + 0.85 * smooth(0.2, 0.9, night));
    U.stars.value = (s.stars ?? 1) * smooth(0.55, 0.95, night) * (1 - cover * 0.9);
    U.clouds.value = cover; U.cloudSoft.value = s.cloudSoft ?? 0.25; U.cloudScale.value = s.cloudScale ?? 1; U.cloudDark.value = dark;
    // Molnens ljusa sida: solen (färgad lågt), månen på natten; skuggsidan: himlen, mörkare när de är regntunga
    U.cloudLit.value.copy(sun.color.clone().multiplyScalar((0.25 + 1.05 * sun.strength * (1 - 0.45 * cover)) * sun.day).add(C('#8090b0').multiplyScalar(moonI * 0.7)).lerp(horizon, 0.25));
    U.cloudShade.value.copy(zenith.clone().lerp(horizon, 0.6).multiplyScalar(0.62 - 0.35 * dark));
    // Dimman
    const F = fogFx.uniforms, fogCol = horizon.clone().lerp(zenith, 0.12), haze = s.haze ?? 0.01, fogD = s.fog ?? 0, fogH = Math.max(0.5, s.fogHeight ?? 8);
    F.color.value.copy(fogCol); U.fogColor.value.copy(fogCol);
    F.density.value = fogD; F.falloff.value = 1 / fogH; F.haze.value = haze;
    F.sunDir.value.copy(sun.dir); F.sunColor.value.copy(sun.color); F.sun.value = sun.strength * (1 - 0.6 * cover);
    // Himlen vid horisonten tonar mot dimman som om den låg 80 m bort (längre bort blir allt vitt i disigt väder)
    U.fogAmount.value = 1 - Math.exp(-((haze * 80) ** 2) - fogD * 80 * Math.exp(-2 / fogH));
    // Ljusen: nyckelljuset följer det som lyser mest
    const useMoon = moonI > sunI;
    keyDir = (useMoon ? moon : sun).dir.clone();
    key.color.copy(useMoon ? C('#9fb4e8') : sun.color);
    key.intensity = Math.max(sunI, moonI);
    key.castShadow = key.intensity > 0.02;
    hemi.intensity = (sun.ambient - 0.1) * (1 - 0.25 * cover) + moonI * 0.35 + 0.025;
    hemi.color.copy(zenith).lerp(C('#ffffff'), 0.45 - 0.2 * night);
    // Regn eller snö, lutat av vinden och lika ljust som luften
    rain = s.precip === 'rain' ? s.amount ?? 0 : 0;
    const wa = (s.windDir ?? 0) * DEG, ws = s.wind ?? 2;
    precip.set({ kind: s.precip ?? 'none', amount: s.amount ?? 0, wind: [Math.sin(wa) * ws, -Math.cos(wa) * ws], color: horizon.clone().lerp(C('#ffffff'), 0.25).multiplyScalar(0.35 + 0.65 * sun.day + moonI) });
    // På natten behöver bilden mer ljus för att synas (som ögat vänjer sig)
    exposure = 1 + 0.7 * night;
    placeLights();
  }
  function placeLights() {
    key.target.position.copy(center);
    key.position.copy(center).addScaledVector(keyDir, lightDistance);
    flashLight.target.position.copy(center);
  }
  return {
    sky, fog: fogFx, precip, key, hemi, bolt,
    get sun() { return sun; }, get moon() { return moon; },
    get keyDir() { return keyDir; },
    get exposure() { return exposure; },
    get rain() { return rain; },
    get flash() { return sky.uniforms.flash.value; },
    get state() { return st; },
    set(state) { st = { ...state }; apply(); },
    moveTo(c) { center.copy(c); placeLights(); },
    update(dt, time, camera) {
      // Molnen driver med vinden
      const wa = (st.windDir ?? 0) * DEG, sp = (st.cloudSpeed ?? 0.3) * 0.02;
      cloudOffset.x += Math.sin(wa) * sp * dt; cloudOffset.y += -Math.cos(wa) * sp * dt;
      sky.uniforms.cloudOffset.value.copy(cloudOffset);
      sky.uniforms.time.value = time;
      precip.update(time);
      // Åska: en blixt långt bort med ojämna mellanrum, tre fladder som lyser upp himlen och marken
      const rate = st.lightning ?? 0;
      if (rate <= 0) nextFlash = time + 2;
      else if (time >= nextFlash && camera) {
        flashT = time; flashPeak = 0.6 + Math.random() * 0.6;
        const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 90;
        boltTo.set(camera.position.x + Math.cos(a) * r, 0, camera.position.z + Math.sin(a) * r);
        boltFrom.copy(boltTo).add(new THREE.Vector3((Math.random() - 0.5) * 30, 75 + Math.random() * 25, (Math.random() - 0.5) * 30));
        bolt.ends(boltFrom, boltTo);
        bolt.start();
        flashLight.position.set(boltFrom.x, 60, boltFrom.z);
        nextFlash = time + (60 / rate) * (0.4 + Math.random() * 1.2);
      }
      const ft = time - flashT;
      const pulse = (t0, w, k) => (ft >= t0 ? Math.exp(-(ft - t0) / w) * k : 0);
      const flash = ft < 1.2 ? (pulse(0, 0.06, 1) + pulse(0.14, 0.05, 0.7) + pulse(0.32, 0.12, 0.9)) * flashPeak * (st.flash ?? 1) : 0;
      sky.uniforms.flash.value = flash;
      fogFx.uniforms.flash.value = flash;
      flashLight.intensity = flash * 3;
      bolt.object.visible = ft < 0.45;
      if (bolt.object.visible && camera) { bolt.setFade(Math.max(0, 1 - ft / 0.45)); bolt.update(time, 0, { camera }); }
    },
  };
}

// ---------- Ljusstrålarna ----------
// godrays genom skuggkartan, bilateralt suddade, inblandade mot strålarnas färg
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
    // s: { shafts, density, falloff, quality, backlight } ur weather.json; tint: strålarnas färg; dir: mot ljuset
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
