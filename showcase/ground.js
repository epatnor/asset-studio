// Marken: ett rutnät med fyra marktexturer som blandas per hörn (splat), plus vattnets botten.
// Ren klientkod (ingen Node). Används av parken och vattensidan.
//
// surfaceAt(x, z) -> { y, splat: [gräs, äng, skog, stig] } beskriver marken; terrain (från carveWater)
// ger vattnet: under ytan blir marken botten (pondbed, riverbed eller sand), kanten mörk och våt, och
// rörlig kaustik lyser på botten. Gräsfältet läser samma fyra texturer med samma blandning (grass.js).
import { BEDS } from './water.js';

const SURFACES = ['grass', 'meadow', 'forestfloor', 'path'];
const FALLBACK = { grass: '#6fa046', meadow: '#8ab24f', forestfloor: '#6e5a3a', path: '#b89466', pondbed: '#4d4a38', riverbed: '#7d7a6a', sand: '#dcc79a' };

export async function loadSurfaces(W, names, { normal = false } = {}) {
  const { THREE } = W;
  const tl = new THREE.TextureLoader();
  const one = (name) => new Promise((res) => tl.load(`../assets/textures/surface_${name}${normal ? '_normal' : ''}.webp`, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = normal ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.anisotropy = 8; res(t);
  }, undefined, () => { // saknas texturen än: en enfärgad ersättare
    const c = document.createElement('canvas'); c.width = c.height = 4; const x = c.getContext('2d'); x.fillStyle = normal ? '#8080ff' : FALLBACK[name] ?? '#808080'; x.fillRect(0, 0, 4, 4);
    const t = new THREE.CanvasTexture(c); t.colorSpace = normal ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; res(t);
  }));
  return Promise.all(names.map(one));
}

export async function createGround(W, { size, seg, surfaceAt, terrain }) {
  const { THREE, scene } = W;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const P = geo.attributes.position, N = P.count, uv = geo.attributes.uv;
  const splat = new Float32Array(N * 4), water = new Float32Array(N * 2), bed = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const x = P.getX(i), z = P.getZ(i), s = surfaceAt(x, z);
    P.setY(i, s.y);
    uv.setXY(i, x / 3, z / 3); // en texturupprepning per 3 m
    splat.set(s.splat, i * 4);
    const w = terrain?.waterAt(x, z);
    if (w) { water.set([w.wet, w.level], i * 2); bed[i * 3 + Math.max(0, BEDS.indexOf(w.body.b.bed))] = 1; }
  }
  geo.computeVertexNormals();
  geo.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
  geo.setAttribute('water', new THREE.BufferAttribute(water, 2));
  geo.setAttribute('bed', new THREE.BufferAttribute(bed, 3));

  const [[tGrass, tMeadow, tForest, tPath, ...beds], [nGrass, nMeadow, nForest, nPath, ...nBeds]] = await Promise.all([
    loadSurfaces(W, [...SURFACES, ...BEDS]), loadSurfaces(W, [...SURFACES, ...BEDS], { normal: true })]);
  // normalMap slår på normalkartsvägen i shadern; själva normalen blandas av alla ytor nedan
  const mat = new THREE.MeshStandardMaterial({ map: tGrass, normalMap: nGrass, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 1 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tMeadow: { value: tMeadow }, tForest: { value: tForest }, tPath: { value: tPath },
      tBed0: { value: beds[0] }, tBed1: { value: beds[1] }, tBed2: { value: beds[2] }, uTime: W.wind.uTime,
      nMeadow: { value: nMeadow }, nForest: { value: nForest }, nPath: { value: nPath }, nBed0: { value: nBeds[0] }, nBed1: { value: nBeds[1] }, nBed2: { value: nBeds[2] } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 splat;\nattribute vec2 water;\nattribute vec3 bed;\nvarying vec4 vSplat;\nvarying vec2 vWater;\nvarying vec3 vBed;\nvarying float vWY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat; vWater = water; vBed = bed; vWY = position.y;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        uniform sampler2D tMeadow, tForest, tPath, tBed0, tBed1, tBed2, nMeadow, nForest, nPath, nBed0, nBed1, nBed2;
        uniform float uTime;
        varying vec4 vSplat; varying vec2 vWater; varying vec3 vBed; varying float vWY;
        // Kaustik: ljusa, slingrande nät som rör sig över botten
        float caustic(vec2 p, float t) {
          vec2 q = p + vec2(sin(p.y * 0.8 + t * 0.7), cos(p.x * 0.9 - t * 0.6)) * 0.6;
          float a = abs(sin(q.x * 2.2 + t) * sin(q.y * 2.0 - t * 0.8)), b = abs(sin((q.x + q.y) * 1.6 - t * 1.1));
          return pow(1.0 - min(a, b), 6.0);
        }`)
      .replace('#include <map_fragment>', `
        // Mot synlig upprepning: blanda varje textur med sig själv i en annan skala och vridning
        vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.37 + 0.31;
        float k = 0.5 + 0.5 * sin(vMapUv.x * 0.7 + sin(vMapUv.y * 0.53) * 1.7);
        #define TEX2(t, s) mix(texture2D(t, vMapUv * s).rgb, texture2D(t, uvB * s).rgb, k * 0.55)
        vec3 cG = TEX2(map, 1.0), cM = TEX2(tMeadow, 0.9), cF = TEX2(tForest, 1.1), cP = TEX2(tPath, 1.3);
        diffuseColor.rgb *= cG * vSplat.x + cM * vSplat.y + cF * vSplat.z + cP * vSplat.w;
        // Vatten: botten under ytan, mörk våt kant, kall ton och kaustik som avtar med djupet
        float wet = smoothstep(0.0, 1.0, vWater.x), d = vWater.y - vWY, under = clamp(d / 0.35, 0.0, 1.0) * wet;
        vec3 bedCol = TEX2(tBed0, 0.8) * vBed.x + TEX2(tBed1, 0.8) * vBed.y + TEX2(tBed2, 0.9) * vBed.z;
        diffuseColor.rgb = mix(diffuseColor.rgb, bedCol, wet * smoothstep(-0.15, 0.05, d) * step(0.5, vBed.x + vBed.y + vBed.z));
        diffuseColor.rgb *= mix(1.0, 0.7, wet * (1.0 - under));                    // våt strand
        // Absorption: ljuset går ner och upp igen genom vattnet; rött försvinner först, sedan grönt
        vec3 absorb = exp(-max(d, 0.0) * vec3(2.4, 1.1, 0.8) * wet);
        diffuseColor.rgb = diffuseColor.rgb * mix(vec3(1.0), absorb, under)
          + caustic(vMapUv * 3.6, uTime) * under * exp(-max(d, 0.0) * 2.2) * vec3(0.32, 0.38, 0.34);
        float bedW = wet * smoothstep(-0.15, 0.05, d) * step(0.5, vBed.x + vBed.y + vBed.z);`)
      // Normalkartor: samma blandning som färgen, så att reliefen följer ytan (och botten under vattnet)
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', `
        vec3 nSurf = TEX2(normalMap, 1.0) * vSplat.x + TEX2(nMeadow, 0.9) * vSplat.y + TEX2(nForest, 1.1) * vSplat.z + TEX2(nPath, 1.3) * vSplat.w;
        vec3 nBedC = TEX2(nBed0, 0.8) * vBed.x + TEX2(nBed1, 0.8) * vBed.y + TEX2(nBed2, 0.9) * vBed.z;
        vec3 mapN = mix(nSurf, nBedC, bedW) * 2.0 - 1.0;`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return { mesh, textures: [tGrass, tMeadow, tForest, tPath] };
}
