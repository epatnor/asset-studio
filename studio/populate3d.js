// Naturen på ön i Kartrummet (docs/terrain.md, steget Populate): det som shared/terrain/populate.js placerat ut, ritat
// som instanser. Ett träd har 12 000–34 000 trianglar, så det ritas i tre nivåer efter avståndet till kameran:
// full modell (LOD0) nära, LOD1 en bit bort och längre bort en stand-in (en klump eller kon i trädets färg, ett
// åttiotal trianglar). Stenar, buskar och växter utan LOD-noder ritas bara inom sitt avstånd. Avstånden är lagrets
// lod.near och lod.mid i terrain.json gånger spaken Detail range. En InstancedMesh per modell, del och nivå: några
// hundra ritanrop för en hel ö.
//
//   const nature = createNature({ scene, rules, library });
//   await nature.set(result, (done, total) => …)   // ur populate(); valfri återkoppling medan modellerna laddas
//   nature.update(camera.position, detail)   // nivåerna om (gör det när kameran flyttat sig)
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STRIDE } from '../shared/terrain/populate.js';

const UP = new THREE.Vector3(0, 1, 0);

export function createNature({ scene, rules, library, manager }) {
  const group = new THREE.Group();
  group.name = 'nature';
  scene.add(group);
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const lib = new Map((library?.items ?? []).map((e) => [e.model, e]));
  const models = new Map(); // url → Promise<{ near: delar, mid: delar }>
  // En modell i delar per nivå: { geometry, material, local (matrisen i modellen), shadow }. LOD0 (eller utan
  // LOD-namn) är nära, LOD1 en bit bort; skuggproxyn ritas inte
  function loadModel(url) {
    if (!models.has(url)) models.set(url, loader.loadAsync(`/${url}`).then((g) => {
      const root = g.scene;
      root.updateMatrixWorld(true);
      const tiers = { near: [], mid: [] };
      root.traverse((o) => {
        if (!o.isMesh || o.material.userData?.shadowProxy) return;
        let lod = 0;
        for (let a = o; a; a = a.parent) { const m = /_LOD(\d)$/.exec(a.name ?? ''); if (m) { lod = Number(m[1]); break; } }
        const part = { geometry: o.geometry, material: o.material, local: o.matrixWorld.clone(), shadow: o.material.userData?.castShadow !== false };
        if (lod === 0) tiers.near.push(part);
        else if (lod === 1) tiers.mid.push(part);
      });
      return tiers;
    }).catch(() => null));
    return models.get(url);
  }
  // Varianterna för en modell: familjens egen och högst tre färdigbyggda ur biblioteket
  const variantsOf = (url) => [url, ...(lib.get(url)?.variants?.items ?? []).filter((v) => !v.main && v.model && v.checks_ok !== false).slice(0, 3).map((v) => v.model)];

  // Stand-ins långt bort: en krona (klump, kon eller gles kvist) på en stam, i lagrets färg, med lite variation per träd
  function proxyGeometry(shape, b, crown, trunk) {
    const r = b.radius ?? 3, h = b.height ?? 8, parts = [];
    const paint = (g, c) => { g = g.index ? g.toNonIndexed() : g; const col = new THREE.Color(c), a = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = col.r; a[i + 1] = col.g; a[i + 2] = col.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); return g; };
    parts.push(paint(new THREE.CylinderGeometry(r * 0.06, r * 0.09, h * 0.45, 5).translate(0, h * 0.22, 0), trunk));
    if (shape === 'cone') parts.push(paint(new THREE.ConeGeometry(r * 0.7, h * 0.85, 7).translate(0, h * 0.55, 0), crown));
    else if (shape === 'twig') parts.push(paint(new THREE.ConeGeometry(r * 0.35, h * 0.6, 5).translate(0, h * 0.6, 0), crown));
    else parts.push(paint(new THREE.IcosahedronGeometry(1, 1).scale(r * 0.8, h * 0.38, r * 0.8).translate(0, h * 0.62, 0), crown));
    return mergeGeometries(parts);
  }
  const proxyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });

  let layers = [], meshes = [], token = 0;
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Qy = new THREE.Quaternion(), N = new THREE.Vector3(), V = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color();
  // Instansens matris: läget, lutningen efter marken (align), vridningen och storleken
  function baseMatrix(L, d, o) {
    const align = L.rule.align ?? 0.1;
    N.set(d[o + 6] * align, 1, d[o + 7] * align).normalize();
    Q.setFromUnitVectors(UP, N).multiply(Qy.setFromAxisAngle(UP, d[o + 3]));
    return M.compose(V.set(d[o], d[o + 1], d[o + 2]), Q, S.setScalar(d[o + 4]));
  }

  // En ny utplacering: delar instanserna på modell och variant, laddar modellerna och bygger en InstancedMesh per del
  // och nivå, och en för lagrets stand-ins
  async function set(result, onProgress) {
    const my = ++token;
    for (const m of meshes) { group.remove(m.im); m.im.dispose(); }
    meshes = [];
    layers = result.layers.map((r) => ({ ...r, rule: rules.layers.find((x) => x.id === r.id) })).filter((L) => L.count && L.rule);
    const jobs = [];
    for (const L of layers) {
      // Instanserna per variant: [variantens url] → index i lagrets data
      const byUrl = new Map();
      const urls = L.rule.models.map(([m]) => `assets/${m}/${m.split('/').pop()}.gltf`), vars = urls.map(variantsOf);
      for (let i = 0; i < L.count; i++) {
        const d = L.data, o = i * STRIDE, v = vars[d[o + 5]] ?? vars[0], url = v[Math.min(v.length - 1, Math.floor(d[o + 8] * v.length))];
        if (!byUrl.has(url)) byUrl.set(url, []);
        byUrl.get(url).push(i);
      }
      L.groups = [];
      for (const [url, idx] of byUrl) {
        const G = { url, idx, near: [], mid: [] };
        L.groups.push(G);
        jobs.push(loadModel(url).then((tiers) => {
          if (my !== token || !tiers) return;
          for (const tier of ['near', 'mid']) for (const p of tiers[tier]) {
            const im = new THREE.InstancedMesh(p.geometry, p.material, idx.length);
            im.frustumCulled = false;
            im.castShadow = tier === 'near' && p.shadow;
            im.receiveShadow = true;
            im.count = 0;
            im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            group.add(im);
            const m = { im, local: p.local, tier };
            meshes.push(m);
            G[tier].push(m);
          }
        }));
      }
      if (L.rule.proxy) {
        const first = urls[0], b = lib.get(first)?.bounds ?? {};
        const im = new THREE.InstancedMesh(proxyGeometry(L.rule.proxy.shape, b, L.rule.proxy.color, L.rule.proxy.trunk), proxyMat, L.count);
        im.frustumCulled = false;
        im.castShadow = im.receiveShadow = true;
        im.count = 0;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.setColorAt(0, C.setScalar(1)); // färgen per träd sätts när stand-ins skrivs (se update)
        group.add(im);
        const m = { im, local: null, tier: 'proxy' };
        meshes.push(m);
        L.proxy = m;
      }
    }
    let loaded = 0;
    onProgress?.(0, jobs.length);
    await Promise.all(jobs.map((j) => j.then(() => onProgress?.(++loaded, jobs.length))));
    if (my !== token) return;
    last = null;
  }

  // Nivåerna efter avståndet: nära full modell, sedan LOD1 (om modellen har det), sedan stand-in eller inget
  let last = null, stats = { near: 0, mid: 0, proxy: 0, triangles: 0, drawn: 0 };
  function update(cam, detail = 1) {
    if (last && last.distanceTo(cam) < 2 && last.detail === detail) return false;
    last = cam.clone(); last.detail = detail;
    stats = { near: 0, mid: 0, proxy: 0, triangles: 0, drawn: 0 };
    const B = new THREE.Matrix4();
    for (const L of layers) {
      const nearR = (L.rule.lod?.near ?? 60) * detail, midR = (L.rule.lod?.mid ?? 0) * detail, d = L.data;
      let pc = 0;
      for (const G of L.groups ?? []) {
        let nc = 0, mc = 0;
        for (const i of G.idx) {
          const o = i * STRIDE, dist = Math.hypot(d[o] - cam.x, d[o + 1] - cam.y, d[o + 2] - cam.z);
          const tier = dist < nearR ? 'near' : dist < midR && G.mid.length ? 'mid' : dist < midR && !L.proxy ? 'near' : L.proxy ? 'proxy' : null;
          if (!tier) continue;
          baseMatrix(L, d, o);
          if (tier === 'proxy') { L.proxy.im.setColorAt(pc, C.setScalar(0.85 + 0.3 * d[o + 8])); L.proxy.im.setMatrixAt(pc++, M); continue; }
          B.copy(M);
          const list = G[tier], k = tier === 'near' ? nc++ : mc++;
          for (const m of list) m.im.setMatrixAt(k, M.copy(B).multiply(m.local));
        }
        for (const m of G.near) { m.im.count = nc; m.im.instanceMatrix.needsUpdate = true; stats.triangles += nc * (m.im.geometry.index ? m.im.geometry.index.count / 3 : 0); }
        for (const m of G.mid) { m.im.count = mc; m.im.instanceMatrix.needsUpdate = true; stats.triangles += mc * (m.im.geometry.index ? m.im.geometry.index.count / 3 : 0); }
        stats.near += nc; stats.mid += mc;
      }
      if (L.proxy) {
        L.proxy.im.count = pc;
        L.proxy.im.instanceMatrix.needsUpdate = true;
        if (L.proxy.im.instanceColor) L.proxy.im.instanceColor.needsUpdate = true;
        stats.proxy += pc;
        stats.triangles += pc * (L.proxy.im.geometry.attributes.position.count / 3);
      }
    }
    stats.drawn = meshes.filter((m) => m.im.count > 0).length;
    stats.triangles = Math.round(stats.triangles);
    return true;
  }

  return {
    group, set, update,
    get stats() { return stats; },
    set visible(v) { group.visible = v; },
    clear() { token++; for (const m of meshes) { group.remove(m.im); m.im.dispose(); } meshes = []; layers = []; last = null; },
  };
}
