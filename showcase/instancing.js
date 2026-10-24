// Instansierade modeller: träd, buskar och props som står många gånger i en bana. Ren klientkod (ingen Node).
//
// En kopia per exemplar (som i parken) kostar ett ritanrop per del och exemplar, och alla står i LOD0.
// Här delas banan i rutor; varje ruta har en InstancedMesh per del och LOD-nivå, med modellens egna
// (patchade) material. Varje exemplar ritas med den nivå som passar avståndet till kameran, och rutor
// utanför synfältet hoppas över (frustum culling per ruta). Fördelningen räknas om när kameran flyttat sig.
// Platt marktäcke (lövhögar, krypväxter) kan draperas över terrängen i shadern (drape), så att det
// inte behöver en egen kopia av geometrin per exemplar.

import { applyShadowRole } from './materials.js';

// Terrängens höjd som en textur (halvflyttal, en texel per res meter), för drapering i shadern
export function heightTexture(W, heightAt, size, res = 1) {
  const { THREE } = W, n = Math.round(size / res) + 1, data = new Uint16Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) data[j * n + i] = THREE.DataUtils.toHalfFloat(heightAt(-size / 2 + i * res, -size / 2 + j * res));
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { texture: tex, size, n };
}
const DRAPE_GLSL = `
  // Drapera: flytta hörnet lodrätt lika mycket som marken skiljer sig från höjden vid exemplarets fot
  vec2 drapeUv(vec2 xz) { return (xz + uDrapeHalf + 0.5 * uDrapeTexel) / (2.0 * uDrapeHalf + uDrapeTexel); }`;
function drapeMaterial(base, drape) {
  const mat = base.clone();
  mat.onBeforeCompile = (sh, r) => {
    base.onBeforeCompile(sh, r);
    sh.uniforms.tDrape = { value: drape.texture };
    sh.uniforms.uDrapeHalf = { value: drape.size / 2 };
    sh.uniforms.uDrapeTexel = { value: drape.size / (drape.n - 1) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D tDrape;\nuniform float uDrapeHalf, uDrapeTexel;${DRAPE_GLSL}`)
      .replace('#include <project_vertex>', `{
        mat4 dM = modelMatrix * instanceMatrix;
        vec2 dW = (dM * vec4(transformed, 1.0)).xz, dR = (dM * vec4(0.0, 0.0, 0.0, 1.0)).xz;
        float dh = texture2D(tDrape, drapeUv(dW)).r - texture2D(tDrape, drapeUv(dR)).r;
        transformed.y += dh / length(dM[1].xyz); // exemplaren är bara vridna och likformigt skalade
      }
      #include <project_vertex>`);
  };
  mat.customProgramCacheKey = () => `${base.customProgramCacheKey()}-drape`;
  return mat;
}

/**
 * places: [{ x, y, z, yaw, scale }]. lodDist: gränser i meter för LOD0, LOD1 och LOD2 (längre bort ritas inget).
 * chunk: rutans sida i meter. shadowLods: nivåer som kastar skugga (LOD2 långt bort behöver ingen).
 * Returnerar { meshes, stats() }.
 */
export function instanceModel(W, root, places, { lodDist = [25, 60, 160], chunk = 32, shadowLods = [0, 1], drape = null } = {}) {
  const { THREE, scene, camera } = W;
  root.updateMatrixWorld(true);
  // Delarna med sin LOD-nivå; delens placering i modellen bakas in i en kopia av geometrin
  const parts = [];
  root.traverse((o) => {
    const lm = o.isMesh && o.name.match(/_LOD(\d)$/);
    if (!lm) return;
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    parts.push({ lod: Number(lm[1]), geo, mat: drape ? drapeMaterial(o.material, drape) : o.material });
  });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), s = new THREE.Vector3();
  const cells = new Map();
  places.forEach((p, i) => {
    const key = `${Math.floor(p.x / chunk)},${Math.floor(p.z / chunk)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  });
  const meshes = [], chunks = [];
  for (const idx of cells.values()) {
    const cx = idx.reduce((a, i) => a + places[i].x, 0) / idx.length, cz = idx.reduce((a, i) => a + places[i].z, 0) / idx.length;
    const mats = idx.map((i) => {
      const p = places[i];
      q.setFromAxisAngle(up, p.yaw);
      return m4.compose(v.set(p.x, p.y, p.z), q, s.setScalar(p.scale)).clone();
    });
    const byLod = [[], [], []];
    for (const part of parts) {
      const im = new THREE.InstancedMesh(part.geo, part.mat, idx.length);
      im.count = 0; im.visible = false;
      im.castShadow = shadowLods.includes(part.lod); im.receiveShadow = true;
      applyShadowRole(im);
      scene.add(im);
      meshes.push(im);
      byLod[part.lod]?.push(im);
    }
    const radius = Math.max(...idx.map((i) => Math.hypot(places[i].x - cx, places[i].z - cz))) + chunk * 0.25;
    chunks.push({ idx, mats, byLod, cx, cz, radius });
  }
  const last = new THREE.Vector3(Infinity, 0, 0);
  let lastScale = W.lodScale ?? 1;
  const counts = [0, 0, 0];
  function relod(force) {
    // W.lodScale > 1 drar ut avstånden (översiktskameran i en stor bana)
    if (force !== true && camera.position.distanceTo(last) < 2 && lastScale === (W.lodScale ?? 1)) return;
    last.copy(camera.position); lastScale = W.lodScale ?? 1;
    counts.fill(0);
    for (const ch of chunks) {
      const c = [0, 0, 0];
      // Hela rutan bortom sista gränsen: inget att räkna
      if (Math.hypot(ch.cx - camera.position.x, ch.cz - camera.position.z) - ch.radius < lodDist[2] * (W.lodScale ?? 1)) {
        ch.idx.forEach((i, k) => {
          const p = places[i], d = Math.hypot(p.x - camera.position.x, p.z - camera.position.z) / (W.lodScale ?? 1);
          const lod = d < lodDist[0] ? 0 : d < lodDist[1] ? 1 : d < lodDist[2] ? 2 : -1;
          if (lod < 0) return;
          const n = c[lod]++;
          for (const im of ch.byLod[lod]) im.setMatrixAt(n, ch.mats[k]);
        });
      }
      ch.byLod.forEach((list, lod) => list.forEach((im) => {
        im.count = c[lod]; im.visible = c[lod] > 0;
        if (!im.visible) return;
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
      }));
      c.forEach((n, l) => (counts[l] += n));
    }
  }
  relod(true);
  W.onFrame(relod);
  return { meshes, relod, stats: () => ({ chunks: chunks.length, lod: [...counts] }) };
}
