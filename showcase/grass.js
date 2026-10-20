// Gräsfält och instansierade växter. Ren klientkod (ingen Node).
//
// Gräsfältet är inte modeller utan hundratusentals enkla strån som ritas med instansiering per ruta (chunk):
// - stråna växer i tuvor; tätheten och höjden styrs av marken (splat), brusfläckar, skugga under träd och hinder
// - roten tar exakt markens färg (samma texturer och samma blandning som markshadern), toppen en gräsfärg som
//   varierar i fläckar över fältet
// - normalerna pekar rakt upp, så att fältet skuggas som en sammanhängande yta (inga svarta strån)
// - vindbyar sveper över fältet som vågor: stråna böjs och blir ljusare där vågen passerar
// - inga kastade skuggor, men gräset tar emot skuggor från träd
// Samma vindbyar och rotfärg används för de instansierade växterna (blommor, vass, säd).

import { patchFog } from './effects.js';

// Markfärg på en plats: måste blanda texturerna precis som markshadern i park.html
const GROUND_GLSL = `
uniform sampler2D tGround0, tGround1, tGround2, tGround3;
vec3 groundAt(vec2 xz, vec4 s) {
  vec2 uv = xz / 3.0;
  vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.37 + 0.31;
  float k = 0.5 + 0.5 * sin(uv.x * 0.7 + sin(uv.y * 0.53) * 1.7);
  #define GT(t, sc) mix(textureLod(t, uv * sc, 2.0).rgb, textureLod(t, uvB * sc, 2.0).rgb, k * 0.55)
  return GT(tGround0, 1.0) * s.x + GT(tGround1, 0.9) * s.y + GT(tGround2, 1.1) * s.z + GT(tGround3, 1.3) * s.w;
}
uniform float uTime, uWind, uSnow;
uniform vec2 uWindDir, uGust; // byarnas vågtal (rad/m) och fart
// Vindbyar: breda vågor som vandrar längs vindriktningen, uppbrutna på tvären så att de inte blir raka linjer
float gustAt(vec2 xz) {
  vec2 side = vec2(-uWindDir.y, uWindDir.x);
  float ph = dot(xz, uWindDir) * uGust.x - uTime * uGust.y;
  float a = sin(ph + sin(dot(xz, side) * 0.12) * 1.8);
  float b = sin(ph * 0.53 + dot(xz, side) * 0.09 + 1.3);
  return smoothstep(0.25, 1.0, 0.5 + 0.35 * a + 0.25 * b);
}`;

// Delas av gräsfältet och alla växter, så att vindbyarna går genom allt på samma sätt
function sharedUniforms(W, textures) {
  return (W.grassUniforms ??= {
    tGround0: { value: textures[0] }, tGround1: { value: textures[1] }, tGround2: { value: textures[2] }, tGround3: { value: textures[3] },
    uTime: W.wind.uTime, uWind: W.wind.uWind, uSnow: W.snow ?? { value: 0 }, uWindDir: { value: new W.THREE.Vector2(0.8, 0.6) }, uGust: { value: new W.THREE.Vector2(0.45, 1.6) },
  });
}

// Seedad slump
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Gräsfält.
 * opts: size (m, kvadrat kring origo), heightAt(x,z), splatAt(x,z) -> [gräs, äng, skog, stig],
 *   densityAt(x,z,splat) -> 0..1, heightScaleAt(x,z,splat) -> m, textures [gräs, äng, skog, stig],
 *   tips: två toppfärger som fältet växlar mellan i fläckar, cell (m per tuvplats), chunk (m), fade [start, slut] (m)
 */
export function createGrassField(W, opts) {
  const { THREE, scene, camera } = W;
  const { size, heightAt, splatAt, densityAt, heightScaleAt, textures, seed = 7, cell = 0.3, chunk = 10, fade = [26, 46] } = opts;
  const tips = (opts.tips ?? ['#5E9E34', '#8DB43E']).map((c) => new THREE.Color(c));
  const r = rng(seed);
  const patch = (x, z) => 0.5 + 0.3 * Math.sin(x * 0.21 + Math.sin(z * 0.17) * 2.1) + 0.2 * Math.sin(z * 0.29 - x * 0.13 + 0.7);

  // Ett strå: tre rader och en spets, x i [-0.5, 0.5], y = andel av höjden. Formen och böjen görs i shadern.
  const rows = [0, 0.3, 0.58, 0.82], pos = [], idx = [];
  rows.forEach((t) => pos.push(-0.5, t, 0, 0.5, t, 0));
  pos.push(0, 1, 0);
  for (let i = 0; i < rows.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  idx.push((rows.length - 1) * 2, (rows.length - 1) * 2 + 1, rows.length * 2);

  // Reglagen i klienten ändrar de här direkt (som en Material Instance). Fältet genereras med full täthet;
  // uDensity väljer hur stor andel av tuvorna som ritas.
  const uniforms = {
    ...sharedUniforms(W, textures), uTipA: { value: tips[0] }, uTipB: { value: tips[1] }, uFade: { value: new THREE.Vector2(...fade) },
    uGroundMix: { value: 0.3 }, uBright: { value: 0.9 }, uHeight: { value: 1 }, uDensity: { value: 0.8 },
  };
  // Lambert räcker: normalerna pekar ändå rakt upp, och den är mycket billigare per pixel än PBR-materialet
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    patchFog(sh, W.fogU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${GROUND_GLSL}
        uniform vec2 uFade;
        uniform float uHeight, uDensity;
        attribute vec4 iPos;   // x, y, z, riktning (rad)
        attribute vec4 iShape; // höjd, bredd, lutning, färgvariation 0..1
        attribute vec4 iSplat;
        varying vec3 vGround; varying float vT, vWave, vVar;`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
        float t = position.y;
        vec2 dir = vec2(cos(iPos.w), sin(iPos.w)), side = vec2(-dir.y, dir.x);
        // Glesare och kortare på avstånd, sedan inget alls (marktexturen är redan gräs där)
        float dist = distance(cameraPosition.xz, iPos.xz);
        float hsh = fract(sin(dot(iPos.xz, vec2(12.9898, 78.233))) * 43758.5453);
        float keep = mix(1.0, 0.3, smoothstep(uFade.x * 0.45, uFade.y, dist)) * uDensity;
        float h = iShape.x * uHeight * (1.0 - smoothstep(uFade.x, uFade.y, dist)) * clamp((keep - hsh) * 8.0, 0.0, 1.0);
        float gust = gustAt(iPos.xz);
        float flutter = sin(uTime * 3.3 + iShape.w * 37.0 + iPos.x * 1.7) * 0.07;
        vec2 off = dir * iShape.z + uWindDir * (uWind * (0.18 + gust * 0.75) + flutter);
        float drop = 1.0 - 0.4 * min(1.0, length(off));
        vec3 transformed = vec3(iPos.x, iPos.y, iPos.z)
          + vec3(side.x, 0.0, side.y) * position.x * iShape.y * (1.0 - t * 0.8)
          + vec3(off.x * t * t * h, t * h * drop, off.y * t * t * h);
        vGround = groundAt(iPos.xz, iSplat); vT = t; vWave = gust * t * uWind; vVar = iShape.w;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTipA, uTipB;\nuniform float uGroundMix, uBright, uSnow;\nvarying vec3 vGround; varying float vT, vWave, vVar;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz); // båda sidor skuggas som marken')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 tip = mix(mix(uTipA, uTipB, vVar), vGround * 1.25, uGroundMix);
        vec3 col = mix(vGround * 0.92, tip, smoothstep(0.0, 0.8, vT));
        diffuseColor.rgb = mix(col * uBright * (1.0 + vWave * 0.55), vec3(0.9, 0.93, 0.98), uSnow * smoothstep(0.1, 0.7, vT));`);
  };

  (W.grassFields ??= []).push(uniforms); // menyns kvalitetsval styr tätheten
  const group = new THREE.Group();
  const chunks = [];
  let total = 0;
  const n = Math.ceil(size / chunk);
  for (let cx = 0; cx < n; cx++) for (let cz = 0; cz < n; cz++) {
    const x0 = -size / 2 + cx * chunk, z0 = -size / 2 + cz * chunk;
    const P = [], S = [], SP = [];
    for (let gx = 0; gx < chunk / cell; gx++) for (let gz = 0; gz < chunk / cell; gz++) {
      const x = x0 + (gx + r()) * cell, z = z0 + (gz + r()) * cell;
      const s = splatAt(x, z), d = densityAt(x, z, s), roll = r();
      if (roll >= d) continue;
      // En tuva: några strån kring en punkt, lutande utåt, med gemensam höjd och färg
      const blades = 6 + Math.floor(r() * 7 * (0.5 + d * 0.6)), rad = 0.05 + r() * 0.09;
      const hb = heightScaleAt(x, z, s) * (0.85 + r() * 0.3), v = Math.min(1, Math.max(0, patch(x, z) + (r() - 0.5) * 0.25));
      for (let b = 0; b < blades; b++) {
        const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * rad, bx = x + Math.cos(a) * rr, bz = z + Math.sin(a) * rr;
        P.push(bx, heightAt(bx, bz) - 0.02, bz, a + (r() - 0.5) * 0.9);
        S.push(hb * (0.7 + r() * 0.35), 0.055 + r() * 0.03, 0.12 + r() * 0.35, v);
        SP.push(...s);
      }
    }
    if (!P.length) continue;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setIndex(idx);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(P), 4));
    geo.setAttribute('iShape', new THREE.InstancedBufferAttribute(new Float32Array(S), 4));
    geo.setAttribute('iSplat', new THREE.InstancedBufferAttribute(new Float32Array(SP), 4));
    geo.instanceCount = P.length / 4;
    const c = new THREE.Vector3(x0 + chunk / 2, heightAt(x0 + chunk / 2, z0 + chunk / 2), z0 + chunk / 2);
    geo.boundingSphere = new THREE.Sphere(c, chunk * 0.75 + 2); // för frustum culling per ruta
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.castShadow = false;
    group.add(mesh);
    chunks.push({ mesh, c });
    total += geo.instanceCount;
  }
  scene.add(group);
  // Rutor bortom fade-avståndet ritas inte alls
  W.onFrame(() => { for (const ch of chunks) ch.mesh.visible = Math.hypot(ch.c.x - camera.position.x, ch.c.z - camera.position.z) < uniforms.uFade.value.y + chunk; });
  return { group, blades: total, uniforms };
}

/**
 * Instansierade växter från en genererad modell: en InstancedMesh per del och LOD-nivå. Varje växt ritas
 * med den nivå som passar avståndet till kameran (lodDist: gränser i meter för LOD0, LOD1 och LOD2;
 * längre bort ritas den inte). Fördelningen räknas om när kameran har flyttat sig en bit.
 * places: [{ x, y, z, yaw, scale, splat }]. Delar vars material har extras.groundTint får rotens färg från marken.
 */
export function instancePlants(W, root, places, { textures, lodDist = [12, 28, 60], castShadow = false } = {}) {
  const { THREE, scene, camera } = W;
  const uniforms = sharedUniforms(W, textures);
  const meshes = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const mats = places.map((p) => { q.setFromAxisAngle(up, p.yaw); return m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.scale, p.scale, p.scale)).clone(); });
  const byLod = [[], [], []];
  root.traverse((o) => {
    const lm = o.isMesh && o.name.match(/_LOD(\d)$/);
    if (!lm) return;
    const lod = Number(lm[1]);
    const geo = o.geometry.clone();
    geo.setAttribute('iSplat', new THREE.InstancedBufferAttribute(new Float32Array(places.length * 4), 4));
    const mat = o.material.clone();
    const tint = !!o.material.userData.groundTint;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      patchFog(sh, W.fogU);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          ${GROUND_GLSL}
          attribute float _wind; attribute float _ground; attribute vec3 _stem; attribute vec4 iSplat;
          varying vec3 vGround; varying float vGroundW;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // Platta stjälkar (_stem = förskjutning från mittlinjen) vrids runt mittlinjen mot kameran
          if (dot(_stem, _stem) > 0.0) {
            vec3 c = transformed - _stem;
            vec3 toCam = cameraPosition - (modelMatrix * instanceMatrix * vec4(c, 1.0)).xyz;
            vec3 sideW = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
            vec3 sideL = normalize(transpose(mat3(modelMatrix * instanceMatrix)) * sideW), perp = cross(sideL, vec3(0.0, 1.0, 0.0));
            transformed = c + sideL * length(_stem) * sign(dot(_stem, sideL) * 1000.0 + dot(_stem, perp));
          }
          vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float ph = root.x * 0.35 + root.z * 0.25;
          float sway = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 3.1 + ph * 2.3) * 0.25;
          vec3 ld = transpose(mat3(instanceMatrix)) * vec3(uWindDir.x, 0.0, uWindDir.y);
          ld /= max(dot(ld, ld), 1e-6); // vindriktningen i växtens egna koordinater
          float bend = _wind * _wind;
          transformed.xz += (vec2(sway, sway * 0.6) * 0.06 + ld.xz * gustAt(root.xz) * 0.22) * uWind * bend;
          vGround = groundAt(root.xz, iSplat); vGroundW = _ground;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSnow;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n{ float upW = (vec4(normal, 0.0) * viewMatrix).y; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.98), uSnow * smoothstep(0.25, 0.75, upW)); }');
      if (tint) sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGround; varying float vGroundW;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vGround, vGroundW);');
    };
    mat.customProgramCacheKey = () => `tinkertown-plant-${tint}`; // samma källkod, olika varianter
    const im = new THREE.InstancedMesh(geo, mat, places.length);
    im.count = 0;
    im.castShadow = castShadow; im.receiveShadow = true;
    scene.add(im);
    meshes.push(im);
    byLod[lod]?.push(im);
  });
  // Fördela växterna på LOD-nivåerna efter avstånd
  const last = new THREE.Vector3(Infinity, 0, 0);
  function relod() {
    if (camera.position.distanceTo(last) < 2) return;
    last.copy(camera.position);
    const counts = [0, 0, 0];
    for (let i = 0; i < places.length; i++) {
      const p = places[i], d = Math.hypot(p.x - camera.position.x, p.z - camera.position.z);
      const lod = d < lodDist[0] ? 0 : d < lodDist[1] ? 1 : d < lodDist[2] ? 2 : -1;
      if (lod < 0) continue;
      const k = counts[lod]++;
      for (const im of byLod[lod]) { im.setMatrixAt(k, mats[i]); im.geometry.attributes.iSplat.array.set(p.splat, k * 4); }
    }
    byLod.forEach((list, lod) => list.forEach((im) => {
      im.count = counts[lod];
      im.instanceMatrix.needsUpdate = true; im.geometry.attributes.iSplat.needsUpdate = true;
      if (im.count) im.computeBoundingSphere();
    }));
  }
  relod();
  W.onFrame(relod);
  return meshes;
}
