// Vattengeneratorn: dammar, sjöar, bäckar, åar, floder och hav som data. Ren klientkod (ingen Node).
//
// Ett vattendrag är ett recept: { type, ...överstyrningar }. Typen ger standardvärden (WATER_TYPES).
//   basin   (pond, lake): center [x, z], radius, depth. Skål med oregelbunden kant; nivån sätts strax under kanten.
//   channel (stream, brook, river): points [[x, z], ...] i flödesriktningen (eller [x, z, botten]: fårans höjd är given,
//           vattnet ligger surface m ovanför), width (halva bredden), depth. Gräver en fåra;
//           vattenytan sluttar nedströms och stiger aldrig. into: index till ett vattendrag som kanalen
//           mynnar i (nivån planar ut mot dess nivå).
//   sea     (ocean): level. Hav där terrängen ligger under nivån.
//
// carve: false (alla typer): terrängen är redan formad (t.ex. Azshara Island), vattnet läggs bara ovanpå.
// carveWater(recept, baseHeight) ger en terräng: heightAt (med gropar och fåror), waterAt (vatten på en
// plats: nivå, djup, ström) och wetAt (0 torrt, 1 i vattnet, däremellan våt strand). createWaterMeshes
// bygger ytorna med samma shader för alla typer.
//
// Shaderknepen, i stil med WoW: inga riktiga speglingar eller djupbuffertar.
// - Djupet räknas ur terrängen och bakas in per hörn. Ytan är tunn och genomskinlig; grumligheten (murk)
//   tilltar med djupet som absorption (1 - e^(-djup·murk)). Botten mörknar per färgkanal i markens shader.
// - Himlen speglas falskt med fresnel. Krusningar i två lager ger normaler och ett skarpt solglitter.
// - Strömmande vatten: krusningarna flyter med strömmen (flödeskarta i två faser), vitt skum i grunda forsar.
// - Hav: dyning och vågband som rullar in mot stranden. Skum mot land för alla typer.

import { patchFog } from './effects.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const WATER_TYPES = {
  pond:   { shape: 'basin', radius: 7, depth: 1.8, freeboard: 0.18, wobble: 1, colors: { shallow: '#3E9F8F', deep: '#123F5C' }, swell: 0.008, ripple: 1, turbulence: 0, shoreWaves: 0, murk: 1.3, bed: 'pondbed' },
  lake:   { shape: 'basin', radius: 18, depth: 3.5, freeboard: 0.25, wobble: 1.3, colors: { shallow: '#3A9EA0', deep: '#0E365E' }, swell: 0.02, ripple: 1.3, turbulence: 0, shoreWaves: 0.3, murk: 0.9, bed: 'pondbed' },
  stream: { shape: 'channel', width: 0.6, depth: 0.32, bank: 0.1, speed: 1.3, colors: { shallow: '#3C9686', deep: '#1D5464' }, swell: 0.004, ripple: 1.4, turbulence: 1, shoreWaves: 0, murk: 0.8, bed: 'riverbed' },
  brook:  { shape: 'channel', width: 1.6, depth: 0.8, bank: 0.14, speed: 0.9, colors: { shallow: '#4FAE9C', deep: '#1B5468' }, swell: 0.006, ripple: 1.2, turbulence: 0.6, shoreWaves: 0, murk: 0.9, bed: 'riverbed' },
  river:  { shape: 'channel', width: 4.5, depth: 2, bank: 0.22, speed: 0.7, colors: { shallow: '#4A9A88', deep: '#123F55' }, swell: 0.012, ripple: 1.1, turbulence: 0.35, shoreWaves: 0, murk: 1.1, bed: 'riverbed' },
  ocean:  { shape: 'sea', level: 0, colors: { shallow: '#3FC9BC', deep: '#0B3A6A' }, swell: 0.09, ripple: 1.5, turbulence: 0, shoreWaves: 1, murk: 0.55, bed: 'sand', size: 400 },
};
export const BEDS = ['pondbed', 'riverbed', 'sand']; // bottentexturer, i den ordning markens shader läser dem

// ---------- Former ----------
function basin(b, baseHeight) {
  const [cx, cz] = b.center, ph = [b.seed ?? 0.7, (b.seed ?? 0.7) * 3 + 1.4];
  const rim = b.rim ?? baseHeight(cx, cz), level = b.level ?? rim - b.freeboard;
  const radiusAt = (a) => b.radius * (1 + b.wobble * (0.16 * Math.sin(3 * a + ph[0]) + 0.09 * Math.sin(5 * a + ph[1])));
  const e = (x, z) => Math.hypot(x - cx, z - cz) / radiusAt(Math.atan2(z - cz, x - cx)); // 0 i mitten, 1 vid strandlinjen
  return {
    b, level, bounds: [cx, cz, b.radius * 1.6],
    carve(x, z, h) {
      const k = e(x, z);
      if (k > 1.7) return h;
      const flat = 1 - smooth(1.0, 1.7, k), bowl = k < 1 ? (1 - k * k) ** 0.8 : 0; // plant runt om, skål i mitten
      return h + (rim - h) * flat - b.depth * bowl;
    },
    info(x, z) { const k = e(x, z); return k < 1.3 ? { level, flow: [0, 0], wet: 1 - smooth(0.92, 1.2, k), inside: k < 1.15 } : null; },
    shoreAt(a, k = 1) { const r = radiusAt(a) * k; return [cx + Math.cos(a) * r, cz + Math.sin(a) * r]; },
  };
}

function channel(b, baseHeight, bodies) {
  // Catmull-Rom genom punkterna, tätt samplad
  const P = b.points, S = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / Math.min(1, b.width * 0.5)));
    for (let j = 0; j < n; j++) {
      const t = j / n, t2 = t * t, t3 = t2 * t;
      const f = (k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      S.push({ x: f(0), z: f(1), y: p1.length > 2 ? p1[2] + (p2[2] - p1[2]) * t : null });
    }
  }
  S.push({ x: P.at(-1)[0], z: P.at(-1)[1], y: P.at(-1)[2] ?? null });
  // Riktning, bredd (lite bredare nedströms) och en nivå som aldrig stiger nedströms
  const into = b.into != null ? bodies[b.into] : null;
  let level = Infinity;
  S.forEach((s, i) => {
    const a = S[Math.max(0, i - 1)], c = S[Math.min(S.length - 1, i + 1)], dx = c.x - a.x, dz = c.z - a.z, l = Math.hypot(dx, dz) || 1;
    s.tx = dx / l; s.tz = dz / l; s.u = i / (S.length - 1); s.w = b.width * (0.85 + 0.3 * s.u) * (1 + 0.15 * Math.sin(i * 0.37));
    level = Math.min(level - 0.004, s.y != null ? s.y + (b.surface ?? 0.35) : baseHeight(s.x, s.z) - b.bank - b.depth * 0.15);
    s.level = level;
  });
  if (into) { // mynnar i ett annat vatten: sista biten planar ut mot dess nivå
    S.forEach((s) => { s.level = Math.max(s.level, into.level); });
    const n = Math.min(S.length, 12);
    for (let i = 0; i < n; i++) { const s = S[S.length - 1 - i]; s.level = into.level + (s.level - into.level) * (i / n); }
  }
  // Rutnät för snabb närmaste-punkt-sökning
  const CELL = 4, reach = b.width * 2.6 + CELL, grid = new Map(), key = (gx, gz) => gx * 73856093 ^ gz * 19349663;
  S.forEach((s, i) => {
    for (let gx = Math.floor((s.x - reach) / CELL); gx <= Math.floor((s.x + reach) / CELL); gx++)
      for (let gz = Math.floor((s.z - reach) / CELL); gz <= Math.floor((s.z + reach) / CELL); gz++) {
        const k = key(gx, gz); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
  });
  const nearest = (x, z) => {
    const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;
    let bi = -1, bd = Infinity;
    for (const i of list) { const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    return { s: S[bi], d: Math.sqrt(bd) };
  };
  const xs = S.map((s) => s.x), zs = S.map((s) => s.z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  return {
    b, S, level: S.at(-1).level, bounds: [(minX + maxX) / 2, (minZ + maxZ) / 2, Math.hypot(maxX - minX, maxZ - minZ) / 2 + reach],
    carve(x, z, h) {
      const n = nearest(x, z);
      if (!n) return h;
      const { s, d } = n, w = s.w, outer = w * 2.4;
      if (d > outer) return h;
      const bed = s.level - b.depth * (1 - Math.min(1, d / w) ** 2) ** 0.7;          // fårans botten
      const bankH = s.level + b.bank * 0.4 + Math.max(0, d - w) * 0.3;               // låga, mjuka bankar
      let t = d < w ? Math.min(h, bed) : Math.min(h, bankH);
      if (d > w && d < w * 1.35) t = Math.max(t, s.level + 0.03);                    // vallen håller vattnet kvar
      return h + (t - h) * (1 - smooth(w * 1.6, outer, d));
    },
    info(x, z) {
      const n = nearest(x, z);
      if (!n || n.d > n.s.w * 1.6) return null;
      const sp = b.speed * (1 - Math.min(1, (n.d / n.s.w) ** 2) * 0.6);
      return { level: n.s.level, flow: [n.s.tx * sp, n.s.tz * sp], wet: 1 - smooth(n.s.w * 0.85, n.s.w * 1.45, n.d), inside: n.d < n.s.w * 1.2 };
    },
  };
}

function sea(b, baseHeight) {
  const L = b.level, c = b.center ?? [0, 0];
  return {
    b, level: L, bounds: [c[0], c[1], b.size / 2],
    carve: (x, z, h) => h,
    info(x, z) { const h = baseHeight(x, z); return h < L + 0.5 ? { level: L, flow: [0, 0], wet: 1 - smooth(L - 0.05, L + 0.45, h), inside: true } : null; },
  };
}

export function carveWater(recipes, baseHeight) {
  const bodies = [];
  for (const r of recipes) {
    if (!WATER_TYPES[r.type]) throw new Error(`okänd vattentyp ${r.type}; finns: ${Object.keys(WATER_TYPES).join(', ')}`);
    const b = { ...WATER_TYPES[r.type], ...r, colors: { ...WATER_TYPES[r.type].colors, ...(r.colors ?? {}) } };
    const body = b.shape === 'basin' ? basin(b, baseHeight) : b.shape === 'channel' ? channel(b, baseHeight, bodies) : sea(b, baseHeight);
    if (r.carve === false) body.carve = (x, z, h) => h;
    bodies.push(body);
  }
  const heightAt = (x, z) => { let h = baseHeight(x, z); for (const w of bodies) h = w.carve(x, z, h); return h; };
  // Vattnet som täcker platsen (det med högst våthet); null på torr mark
  const waterAt = (x, z) => {
    let best = null;
    for (const w of bodies) { const i = w.info(x, z); if (i && (!best || i.wet > best.wet)) best = { ...i, body: w }; }
    if (best) best.depth = best.level - heightAt(x, z);
    return best;
  };
  const wetAt = (x, z) => { let m = 0; for (const w of bodies) { const i = w.info(x, z); if (i) m = Math.max(m, i.wet); } return m; };
  return { bodies, heightAt, waterAt, wetAt };
}

// ---------- Ytor ----------
const VERT = `
  attribute float depth;
  attribute vec2 flow;
  uniform float uTime, uSwell;
  varying vec3 vW; varying float vD; varying vec2 vFlow;
  #include <fog_pars_vertex>
  void main() {
    vec3 p = position;
    vec4 wp0 = modelMatrix * vec4(p, 1.0);
    float deepW = smoothstep(0.0, 1.0, depth);
    p.y += (sin(wp0.x * 1.3 + uTime * 1.1) + sin(wp0.z * 1.7 - uTime * 0.9)) * 0.1 * uSwell * deepW
         + sin(dot(wp0.xz, vec2(0.21, 0.13)) - uTime * 1.1) * uSwell * deepW; // dyning
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vW = wp.xyz; vD = depth; vFlow = flow;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const FRAG = `
  uniform vec3 uShallow, uDeep, uFoam, uSky, uHorizon, uSunDir, uSunColor;
  uniform float uTime, uWind, uRipple, uTurb, uShore, uMurk;
  varying vec3 vW; varying float vD; varying vec2 vFlow;
  #include <fog_pars_fragment>
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float waves(vec2 p) {
    return vnoise(p * 1.7 + vec2(uTime * 0.35, uTime * 0.2)) * 0.6 + vnoise(p * 3.9 - vec2(uTime * 0.25, -uTime * 0.42)) * 0.4;
  }
  // Flödeskarta i två faser: krusningarna förs med strömmen och nollställs omväxlande, utan synligt hopp
  float flowWaves(vec2 p) {
    float t1 = fract(uTime * 0.3), t2 = fract(uTime * 0.3 + 0.5), w1 = 1.0 - abs(2.0 * t1 - 1.0);
    return waves(p - vFlow * t1 * 3.333) * w1 + waves(p - vFlow * t2 * 3.333 + 0.37) * (1.0 - w1);
  }
  void main() {
    if (vD < -0.02) discard; // över land
    vec2 p = vW.xz * uRipple, e = vec2(0.06, 0.0);
    float k = (0.08 + uWind * 0.18) * (1.0 + length(vFlow) * 0.6) * (1.0 - 0.85 * smoothstep(25.0, 110.0, distance(cameraPosition, vW))); // lugnare på avstånd, inga ränder
    vec3 n = normalize(vec3(-(flowWaves(p + e.xy) - flowWaves(p - e.xy)) * k, 2.0 * e.x, -(flowWaves(p + e.yx) - flowWaves(p - e.yx)) * k));
    vec3 V = normalize(cameraPosition - vW);
    float fres = clamp(0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0), 0.0, 1.0) * 0.6;
    vec3 r = reflect(-V, n);
    vec3 sky = mix(uHorizon, uSky, clamp(r.y * 1.6, 0.0, 1.0));
    float murk = 1.0 - exp(-max(vD, 0.0) * uMurk);               // hur mycket vatten ljuset passerar
    vec3 col = mix(uShallow, uDeep, murk);
    col = mix(col, sky, fres);
    float s = pow(max(dot(n, normalize(uSunDir + V)), 0.0), 280.0);
    col += uSunColor * (smoothstep(0.35, 0.45, s) * 1.4 + s * 0.4);
    // Skum: kant mot land, band mot stranden, forsar i grunt strömmande vatten, vågband på havet
    float edge = 1.0 - smoothstep(0.0, 0.035, vD);
    // Mjukt, målat skum: stora rundade fläckar och breda band som bryts i tungor, inga spretiga trådar
    float blot = smoothstep(0.3, 0.65, vnoise(vW.xz * 0.8 + uTime * 0.05));
    float rapids = uTurb * smoothstep(0.4, 1.4, length(vFlow)) * (1.0 - smoothstep(0.05, 0.45, vD)) * smoothstep(0.42, 0.72, vnoise(vW.xz * 1.6 - vFlow * uTime * 1.5));
    float surf = uShore * smoothstep(0.7, 0.9, fract(vD * 0.6 + uTime * 0.12 + vnoise(vW.xz * 0.3) * 0.3)) * blot * (1.0 - smoothstep(0.3, 2.5, vD));
    float foam = max(edge * 0.55 * smoothstep(0.25, 0.75, vnoise(vW.xz * 2.5 + uTime * 0.3)), max(rapids, surf * 0.8));
    col = mix(col, uFoam, clamp(foam, 0.0, 1.0));
    float alpha = clamp(0.1 + murk * 0.85 + fres * 0.8 + foam + s * 0.5, 0.0, 1.0) * smoothstep(-0.02, 0.03, vD); // tunn yta, grumligt med djupet
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

function material(W, b) {
  const { THREE } = W;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uShallow: { value: new THREE.Color(b.colors.shallow) }, uDeep: { value: new THREE.Color(b.colors.deep) }, uFoam: { value: new THREE.Color('#EAF6F2') },
    uSky: { value: new THREE.Color('#8fbdf0') }, uHorizon: { value: new THREE.Color('#d9ecff') },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5).normalize() }, uSunColor: { value: new THREE.Color('#fff1d6') },
    uSwell: { value: b.swell }, uRipple: { value: b.ripple }, uTurb: { value: b.turbulence }, uShore: { value: b.shoreWaves }, uMurk: { value: b.murk },
  }]);
  uniforms.uTime = W.wind.uTime; uniforms.uWind = W.wind.uWind; // delade, inte kopior
  const tmp = new THREE.Vector3();
  W.onFrame(() => uniforms.uSunDir.value.copy(tmp.subVectors(W.sun.position, W.sun.target.position).normalize()));
  const m = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: true });
  m.onBeforeCompile = (sh) => patchFog(sh, W.fogU, 'vW'); // samma dimma som marken (effects.js)
  return m;
}

export function createWaterMeshes(W, terrain) {
  const { THREE, scene } = W;
  const meshes = [];
  for (const body of terrain.bodies) {
    const b = body.b;
    let geo;
    if (b.shape === 'channel') { // band längs fåran, med nivån per tvärsnitt
      const S = body.S, across = 9, pos = [], idx = [];
      for (const s of S) for (let j = 0; j < across; j++) {
        const o = (j / (across - 1) * 2 - 1) * s.w * 1.3;
        pos.push(s.x - s.tz * o, s.level, s.z + s.tx * o);
      }
      for (let i = 0; i < S.length - 1; i++) for (let j = 0; j < across - 1; j++) {
        const a = i * across + j; idx.push(a, a + 1, a + across, a + 1, a + across + 1, a + across); // framsidan uppåt
      }
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
    } else { // rutnät på vattennivån runt skålen eller över havet
      const [cx, cz, r] = body.bounds, size = r * 2, seg = Math.min(220, Math.ceil(size * (b.shape === 'sea' ? 0.6 : 4)));
      geo = new THREE.PlaneGeometry(size, size, seg, seg);
      geo.rotateX(-Math.PI / 2);
      geo.translate(cx, body.level, cz);
    }
    const P = geo.attributes.position, depth = new Float32Array(P.count), flow = new Float32Array(P.count * 2);
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), z = P.getZ(i), w = body.info(x, z);
      depth[i] = w && w.inside ? P.getY(i) - terrain.heightAt(x, z) : -1; // utanför vattnets mask finns ingen yta
      if (w) flow.set(w.flow, i * 2);
    }
    geo.setAttribute('depth', new THREE.BufferAttribute(depth, 1));
    geo.setAttribute('flow', new THREE.BufferAttribute(flow, 2));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material(W, b));
    mesh.renderOrder = 1;
    scene.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}
