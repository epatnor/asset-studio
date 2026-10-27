// Vattenmodulen (docs/effektlabb.md, E3): vattenytor i TSL för Väderkvarnens Vatten-flik och Tinkertown (WebGPU, med
// WebGL2 som reserv). En yta för alla sorters vatten: sjö, damm, bäck, strand och hav skiljer sig bara i spakarna
// (tools/water/water.json) och i geometrin man ger den. Byggd efter patriks_input/AAA_Water_Simulation_ThreeJS_Reference.md:
//
// - Vågor: fyra Gerstnervågor (GPU Gems kap. 1) med djupvattnets fart (ω = √(g·k)), dämpade där det är grunt så att de
//   inte sticker upp genom stranden. Normalen räknas analytiskt i hörnen; vassa krön ger skum.
// - Krusningar: en sömlös lutningskarta (byggs här, inga filer) i två lager som korsar varandra med vinden. I strömmande
//   vatten flyter de med strömmen (flödeskarta i två faser med triangelvikter, så att återstarten inte syns).
// - Optik: Fresnel (Schlick, 2 % rakt uppifrån), brytning genom djupbufferten (bilden under ytan förskjuts av normalen,
//   men aldrig från saker ovanför ytan), Beer–Lambert-absorption längs strålen (rött försvinner först) och vattnets egen
//   färg från grunt till djupt. Spegling av himlen (samma himmel som weather.js) eller hela scenen (reflector, halv
//   upplösning). Solglitter som skarp spekulär.
// - Skum: vid stranden och runt stenar (vertikalt djup ur djupbufferten), på vassa krön och i strömt grunt vatten.
// - Strand: en vågrygg rullar in över grundet med en skumsvans efter sig, bryts och sköljer upp på stranden (snabbt upp,
//   långsamt ned, varje våg olika stark), lämnar skum som tonar bort, och sanden förblir våt en stund efteråt. Marken tar sin våthet och kaustik ur groundColor och groundRoughness, så att samma vatten styr.
// - Krusningar från stänk: splash(x, z) ger ringar som breder ut sig och dör bort (åtta samtidigt, analytiskt, ingen
//   simulering).
//
//   const water = createWater({ geometry, level, sky });   // geometry i världen, med attributen bed och flow
//   scene.add(water.mesh); water.set(vals, sun); water.update(time);
//   ground.colorNode = water.groundColor(baseColor, levelNode)
//
// Geometrin har hörnen i världens koordinater (y = ytans nivå i vila) och tre attribut: bed (markens höjd under hörnet,
// för dämpning och sköljning), bedSlope (markens lutning, för vågryggarna mot stranden) och flow (strömmens fart i xz,
// m/s vid Current = 1). bedAndFlow() fyller dem.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, attribute, varying, float, vec2, vec3, vec4, sin, cos, exp, pow, max, min, mix, abs, fract, floor,
  smoothstep, normalize, dot, reflect, length, select, saturate, positionWorld, cameraPosition, screenUV, texture,
  viewportSharedTexture, viewportDepthTexture, getViewPosition, cameraProjectionMatrixInverse, cameraWorldMatrix, reflector,
} from 'three/tsl';

const G = 9.81, DEG = Math.PI / 180;
// De fyra vågorna i förhållande till den största: längd, vinkel mot huvudriktningen och höjd
const WAVES = [[1, 0, 1], [0.61, 28, 0.55], [0.37, -35, 0.3], [0.23, 62, 0.16]];
const RIPPLES = 8; // stänk som kan krusa samtidigt

// ---------- Sömlösa texturer, byggda en gång (inga filer) ----------
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function dataTex(data, N) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
// Avstånd till närmaste och näst närmaste punkt i ett periodiskt rutnät (Worley), i rutornas mått
function worley(cells, seed) {
  const r = rng(seed), pts = Array.from({ length: cells * cells }, () => [r(), r()]);
  return (u, v) => {
    const x = u * cells, y = v * cells, cx = Math.floor(x), cy = Math.floor(y);
    let f1 = 9, f2 = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j, p = pts[(((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells)];
      const d = Math.hypot(gx + p[0] - x, gy + p[1] - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  };
}
let TEX = null;
function textures() {
  if (TEX) return TEX;
  const N = 256;
  // Krusningar: lutningen (dh/dx, dh/dz) av en summa periodiska vågor, i RG
  const slope = new Uint8Array(N * N * 4), r = rng(7), W = [];
  for (let i = 0; i < 56; i++) {
    let kx, ky;
    do { kx = Math.round((r() * 2 - 1) * 11); ky = Math.round((r() * 2 - 1) * 11); } while (kx * kx + ky * ky < 4);
    W.push([kx, ky, Math.pow(kx * kx + ky * ky, -0.85), r() * Math.PI * 2]);
  }
  const sx = new Float32Array(N * N), sy = new Float32Array(N * N);
  let m = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let dx = 0, dy = 0;
    for (const [kx, ky, a, ph] of W) { const c = a * Math.cos((2 * Math.PI * (kx * x + ky * y)) / N + ph); dx += c * kx; dy += c * ky; }
    sx[y * N + x] = dx; sy[y * N + x] = dy; m = Math.max(m, Math.abs(dx), Math.abs(dy));
  }
  for (let i = 0; i < N * N; i++) { slope[i * 4] = 127.5 + (127.5 * sx[i]) / m; slope[i * 4 + 1] = 127.5 + (127.5 * sy[i]) / m; slope[i * 4 + 2] = 128; slope[i * 4 + 3] = 255; }
  // Skum (R: spetsigt nät av bubblor, G: fläckar) och kaustik (B: ljusa trådar där cellerna möts)
  const misc = new Uint8Array(N * N * 4), lace = worley(10, 3), lace2 = worley(23, 5), blot = worley(5, 9), caus = worley(7, 11);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = (y * N + x) * 4;
    const [a1, a2] = lace(u, v), [b1, b2] = lace2(u, v), [c1] = blot(u, v), [k1, k2] = caus(u, v);
    const net = 1 - smoothN(0.04, 0.3, a2 - a1), fine = 1 - smoothN(0.03, 0.22, b2 - b1);
    misc[i] = 255 * Math.min(1, net * 0.7 + fine * 0.45);
    misc[i + 1] = 255 * (1 - smoothN(0.15, 0.75, c1));
    misc[i + 2] = 255 * Math.pow(1 - smoothN(0, 0.2, k2 - k1), 2.2);
    misc[i + 3] = 255;
  }
  TEX = { slope: dataTex(slope, N), misc: dataTex(misc, N) };
  return TEX;
}
function smoothN(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

// Fyll attributen bed och flow för en geometri vars hörn ligger i världen: bedAt(x, z) ger markens höjd, flowAt(x, z) [vx, vz]
export function bedAndFlow(geometry, bedAt, flowAt = null) {
  const p = geometry.attributes.position, n = p.count, bed = new Float32Array(n), flow = new Float32Array(n * 2), grad = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = p.getX(i), z = p.getZ(i), e = 0.25;
    bed[i] = bedAt(x, z);
    grad[i * 2] = (bedAt(x + e, z) - bedAt(x - e, z)) / (2 * e);
    grad[i * 2 + 1] = (bedAt(x, z + e) - bedAt(x, z - e)) / (2 * e);
    if (flowAt) { const f = flowAt(x, z, i); flow[i * 2] = f[0]; flow[i * 2 + 1] = f[1]; }
  }
  geometry.setAttribute('bed', new THREE.BufferAttribute(bed, 1));
  geometry.setAttribute('bedSlope', new THREE.BufferAttribute(grad, 2));
  geometry.setAttribute('flow', new THREE.BufferAttribute(flow, 2));
  return geometry;
}

export function createWater({ geometry, level = 0, sky }) {
  const T = textures();
  const u = {
    time: uniform(0),
    shallow: uniform(new THREE.Color('#3fa6a0')), deep: uniform(new THREE.Color('#0d3a5a')), clarity: uniform(4), deepAt: uniform(4),
    waveA: uniformArray(WAVES.map(() => new THREE.Vector4()), 'vec4'), // riktning x, z, k, höjd
    waveB: uniformArray(WAVES.map(() => new THREE.Vector4()), 'vec4'), // ω, Q, fas, dämpningsdjup
    steep: uniform(0.35), ripples: uniform(0.45), rippleScale: uniform(1.6), wind: uniform(new THREE.Vector2(0, -1)),
    reflections: uniform(1), distortion: uniform(0.3), refraction: uniform(0.35), glitter: uniform(1.4), glitterSize: uniform(400),
    shoreFoam: uniform(0.35), foamWidth: uniform(0.25), crestFoam: uniform(0), foamScale: uniform(1),
    edge: uniform(0.06), wetShore: uniform(0.6), wetBand: uniform(0.12), surge: uniform(0), surgePeriod: uniform(7),
    flowSpeed: uniform(0.8), flowFoam: uniform(0.4), caustics: uniform(0.8), causticScale: uniform(1.5),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color('#ffffff')), sunI: uniform(1), ambient: uniform(new THREE.Color('#8090a0')),
    level: uniform(level),
    splash: uniformArray(Array.from({ length: RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0)), 'vec4'), // x, z, start, styrka
  };
  let nextSplash = 0;

  // ---------- Hörnen: Gerstnervågor och sköljning ----------
  const P0 = attribute('position', 'vec3'), bed = attribute('bed', 'float'), flowA = attribute('flow', 'vec2'), bedSlope = attribute('bedSlope', 'vec2');
  const depth0 = P0.y.sub(bed); // djupet i vila
  // Sköljningen: snabbt upp, långsamt tillbaka; varje våg olika stark, och lite olika längs stranden.
  // s är var i sin cykel vågen är (0 = den når strandlinjen), strength hur stark just den vågen är
  const surgePhase = (t, x) => t.div(u.surgePeriod).add(sin(x.mul(0.13)).mul(0.12)).add(sin(x.mul(0.31).add(1.3)).mul(0.06));
  const waveStrength = (w) => fract(sin(w.mul(12.9898)).mul(43758.5453)).mul(0.45).add(0.55);
  const surgeAt = (t, x) => {
    const ph = surgePhase(t, x), s = fract(ph);
    const prof = select(s.lessThan(0.2), smoothstep(0, 0.2, s), pow(float(1).sub(s.sub(0.2).div(0.8)), 1.7));
    return prof.mul(waveStrength(floor(ph))).mul(u.surge);
  };
  const shoreW = float(1).sub(smoothstep(0.2, 1.6, depth0)); // 1 på stranden och i strandkanten
  // Vågryggen som rullar in: sista tredjedelen av cykeln går den från 1,6 m djup till strandlinjen och reser sig när det
  // grundas; bakom den en skumsvans. Efter sköljningen ligger skum kvar på det grunda och tonar bort.
  const bore = (() => {
    const ph = surgePhase(u.time, P0.x), s = fract(ph), k = saturate(s.sub(0.64).div(0.36));
    const at = float(1.6).mul(float(1).sub(k)), d = depth0.sub(at), on = smoothstep(0.64, 0.72, s).mul(select(u.surge.greaterThan(0), 1, 0));
    const str = waveStrength(floor(ph).add(1)).mul(on);
    const grow = float(1).sub(smoothstep(0.4, 1.8, at)).mul(0.8).add(0.35); // högre när det grundas
    const shape = exp(d.mul(d).div(0.12).negate());
    const h = shape.mul(grow).mul(str).mul(u.surge).mul(1.3).mul(smoothstep(-0.05, 0.1, depth0));
    const dh = shape.mul(d).mul(-2 / 0.12).mul(grow).mul(str).mul(u.surge).mul(1.3); // dh/d(djup)
    const trail = select(d.greaterThan(0), exp(d.div(-0.6)), exp(d.mul(d).div(0.02).negate())).mul(str).mul(smoothstep(0, 0.4, at.add(0.1)));
    const swash = float(1).sub(smoothstep(-0.1, 0.45, depth0)).mul(float(1).sub(smoothstep(0.1, 0.62, s))).mul(waveStrength(floor(ph))).mul(select(u.surge.greaterThan(0), 1, 0));
    // Lutningen ur djupets lutning (djupet minskar uppför stranden)
    return { h, n: vec3(bedSlope.x.mul(dh), 0, bedSlope.y.mul(dh)), foam: max(trail.mul(0.85), swash) };
  })();
  const gerstner = () => {
    let dx = float(0), dy = float(0), dz = float(0), nx = float(0), ny = float(0), nz = float(0), pinch = float(0);
    for (let i = 0; i < WAVES.length; i++) {
      const a = u.waveA.element(i), b = u.waveB.element(i);
      const damp = smoothstep(0.02, b.w, depth0); // vågen dör ut där det är grunt
      const amp = a.w.mul(damp), th = a.z.mul(a.x.mul(P0.x).add(a.y.mul(P0.z))).sub(b.x.mul(u.time)).add(b.z);
      const c = cos(th), s = sin(th), qa = b.y.mul(amp);
      dx = dx.add(qa.mul(a.x).mul(c)); dz = dz.add(qa.mul(a.y).mul(c)); dy = dy.add(amp.mul(s));
      const wa = a.z.mul(amp);
      nx = nx.add(a.x.mul(wa).mul(c)); nz = nz.add(a.y.mul(wa).mul(c));
      const p = b.y.mul(wa).mul(s);
      ny = ny.add(p); pinch = pinch.add(p);
    }
    return { d: vec3(dx, dy, dz), n: normalize(vec3(nx.negate(), float(1).sub(ny), nz.negate())), pinch };
  };
  const g = gerstner();
  const surgeNow = surgeAt(u.time, P0.x).mul(shoreW);
  const vNormal = varying(normalize(g.n.add(bore.n))), vPinch = varying(g.pinch), vFlow = varying(flowA), vBore = varying(bore.foam);

  // ---------- Pixlarna ----------
  const shade = (mirror) => Fn(() => {
    const Pw = positionWorld, toCam = cameraPosition.sub(Pw), dist = length(toCam), V = toCam.div(dist);
    const t = u.time;
    // Krusningar med vinden: två lager som korsar varandra
    const slopeAt = (uv) => texture(T.slope, uv).xy.mul(2).sub(1);
    const xz = Pw.xz.div(u.rippleScale.mul(4));
    const w1 = slopeAt(xz.add(u.wind.mul(t.mul(0.05))));
    const rot = vec2(xz.x.mul(0.8).sub(xz.y.mul(0.6)), xz.x.mul(0.6).add(xz.y.mul(0.8))).mul(1.63);
    const w2 = slopeAt(rot.add(vec2(u.wind.y, u.wind.x.negate()).mul(t.mul(0.031))).add(0.37));
    const windSlope = w1.add(w2.mul(0.7));
    // Med strömmen: två faser som vägs ihop (triangelvikter), så att återstarten aldrig syns
    const f = vFlow.mul(u.flowSpeed), fl = length(f);
    const pa = fract(t.mul(0.35)), pb = fract(t.mul(0.35).add(0.5));
    const fuv = Pw.xz.div(u.rippleScale.mul(2.5));
    const fs = slopeAt(fuv.sub(f.mul(pa.div(0.35).mul(0.4)))).mul(float(1).sub(abs(pa.mul(2).sub(1))))
      .add(slopeAt(fuv.sub(f.mul(pb.div(0.35).mul(0.4))).add(0.5)).mul(float(1).sub(abs(pb.mul(2).sub(1)))));
    const detail = mix(windSlope, fs.mul(1.3), saturate(fl.mul(3))).mul(u.ripples).mul(float(0.35).div(dist.mul(0.015).add(1)));
    // Stänk: ringar som breder ut sig
    let ring = vec2(0);
    for (let i = 0; i < RIPPLES; i++) {
      const s = u.splash.element(i), age = t.sub(s.z), rel = Pw.xz.sub(s.xy), r = length(rel).add(1e-4);
      const d = r.sub(age.mul(0.9)), env = exp(d.mul(d).mul(-1.6)).mul(exp(age.mul(-0.5))).mul(s.w).mul(smoothstep(0, 0.05, age)).div(r.mul(0.4).add(1));
      ring = ring.add(rel.div(r).mul(cos(d.mul(14)).mul(env)));
    }
    const N = normalize(vNormal.add(vec3(detail.x.add(ring.x.mul(0.7)).negate(), 0, detail.y.add(ring.y.mul(0.7)).negate())));
    const ndv = saturate(dot(N, V));

    // Djupet under ytan, ur djupbufferten: markens punkt i världen
    const groundAt = (uv) => cameraWorldMatrix.mul(vec4(getViewPosition(uv, viewportDepthTexture(uv).x, cameraProjectionMatrixInverse), 1)).xyz;
    const G0 = groundAt(screenUV), dv = Pw.y.sub(G0.y).max(0);
    // Brytning: bilden under ytan förskjuts, men inte från saker som står ovanför vattnet
    const ruv0 = screenUV.add(N.xz.mul(u.refraction).mul(0.06).mul(saturate(dv.mul(1.5))).div(dist.mul(0.04).add(1)));
    const G1 = groundAt(ruv0), ok = G1.y.lessThan(Pw.y.sub(0.01));
    const ruv = select(ok, ruv0, screenUV), Gr = select(ok, G1, G0);
    const path = length(Gr.sub(Pw));
    const bottom = viewportSharedTexture(ruv).rgb;
    const trans = exp(vec3(1, 0.42, 0.26).mul(float(4.6).div(u.clarity)).mul(path).negate());
    const lightAmt = u.ambient.add(u.sunColor.mul(u.sunI).mul(max(u.sunDir.y, 0).mul(0.12)));
    const body = mix(u.shallow, u.deep, saturate(dv.div(u.deepAt))).mul(lightAmt);
    const through = bottom.mul(trans).add(body.mul(float(1).sub(trans)));

    // Speglingen: himlen (samma som weather.js) eller hela scenen
    const R = reflect(V.negate(), N), Ru = vec3(R.x, abs(R.y), R.z);
    let refl = sky ? sky.colorAt(Ru, 0) : vec3(0.6, 0.75, 0.9);
    if (mirror) {
      mirror.uvNode = mirror.uvNode.add(N.xz.mul(u.distortion).mul(0.05));
      refl = mirror.rgb;
    }
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(ndv), 5))).mul(u.reflections);
    let col = mix(through, refl, F);
    // Solglitter
    const spec = pow(max(dot(R, u.sunDir), 0), u.glitterSize).mul(u.glitterSize.sqrt().mul(0.25)).mul(u.glitter);
    col = col.add(u.sunColor.mul(u.sunI).mul(spec).mul(0.35));

    // Skum: strand och stenar, vassa krön, strömt grunt vatten
    const fuvB = Pw.xz.div(u.foamScale.mul(8)).add(vec2(t.mul(0.011), t.mul(-0.007)));
    const warp = slopeAt(Pw.xz.div(u.foamScale.mul(5)).add(vec2(t.mul(-0.013), t.mul(0.009)))).mul(0.18);
    const fuvA = Pw.xz.div(u.foamScale.mul(3)).sub(f.mul(t.mul(0.33))).add(warp);
    const blot = texture(T.misc, fuvB).g;
    const noise = texture(T.misc, fuvA).r.mul(blot.mul(0.6).add(0.55)).mul(0.7).add(blot.mul(0.38));
    const shore = float(1).sub(smoothstep(0, u.foamWidth, dv)).mul(u.shoreFoam);
    const crest = smoothstep(0.5, 0.9, vPinch.div(max(u.steep, 0.01))).mul(u.crestFoam).mul(1.4);
    const rapids = saturate(fl.mul(0.8)).mul(float(1).sub(smoothstep(0.05, 0.45, dv))).mul(u.flowFoam).mul(1.3);
    const mask = saturate(max(max(shore, crest), max(rapids, vBore.mul(u.shoreFoam).mul(1.4))));
    const foam = saturate(noise.sub(float(1).sub(mask)).mul(4)).mul(saturate(mask.mul(2)));
    col = mix(col, vec3(0.92, 0.95, 0.96).mul(lightAmt.add(u.sunColor.mul(u.sunI).mul(max(u.sunDir.y, 0).mul(0.3)))), foam);
    // Mot stranden tonar ytan ut (inget hårt snitt där vattnet möter marken)
    return vec4(col, smoothstep(0, u.edge, dv));
  })();

  // Speglingen av scenen: ett plan i ytans nivå som ritar scenen spegelvänd (halv upplösning), byggt först när det behövs
  let mirrorNode = null;
  function material(mirror) {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true, side: THREE.FrontSide });
    m.positionNode = P0.add(g.d).add(vec3(0, surgeNow.add(bore.h), 0));
    if (mirror) {
      mirrorNode = reflector({ resolutionScale: 0.5 });
      mirrorNode.target.rotation.x = -Math.PI / 2;
      mirrorNode.target.position.y = u.level.value;
      mesh.add(mirrorNode.target);
    }
    m.colorNode = shade(mirror ? mirrorNode : null);
    return m;
  }
  const mats = { sky: null, mirror: null };
  const mesh = new THREE.Mesh(geometry);
  mats.sky = mesh.material = material(false);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  let vals = {};

  function setMirror(on) {
    if (on && !mats.mirror) mats.mirror = material(true);
    mesh.material = on ? mats.mirror : mats.sky;
  }

  // ---------- Marken under och vid vattnet ----------
  // Kaustik på botten (i världen, så att mönstret ligger still när kameran rör sig), våt strand och sand som sköljts
  const caustic = (xz) => {
    const t = u.time, s = xz.div(u.causticScale.mul(4));
    const a = texture(T.misc, s.add(vec2(t.mul(0.021), t.mul(0.013)))).b, b = texture(T.misc, s.mul(0.77).add(vec2(t.mul(-0.017), t.mul(0.019))).add(0.31)).b;
    return min(a, b).mul(2.2);
  };
  function wetness(levelNode = u.level) {
    const y = positionWorld.y, above = y.sub(levelNode);
    const band = float(1).sub(smoothstep(0, max(u.wetBand, 0.001), above));
    // Sanden som vågen nyss sköljde över är fortfarande våt: den högsta sköljningen de senaste sekunderna
    const ph = surgePhase(u.time, positionWorld.x), s = fract(ph), n = floor(ph);
    const prof = select(s.lessThan(0.2), smoothstep(0, 0.2, s), float(1).sub(s.sub(0.2).mul(0.45)));
    const line = max(prof.mul(waveStrength(n)), waveStrength(n.sub(1)).mul(float(0.7).sub(s.mul(0.25)))).mul(u.surge);
    const washed = float(1).sub(smoothstep(line.sub(0.1), line.add(0.01), above)).mul(0.75).add(float(1).sub(smoothstep(line.sub(0.01), line.add(0.03), above)).mul(0.25));
    return saturate(max(band, washed.mul(select(u.surge.greaterThan(0), 1, 0)))).mul(u.wetShore);
  }
  return {
    mesh, uniforms: u,
    // Markens färg: kaustik under ytan, mörkare där det är vått
    groundColor(base, levelNode = u.level) {
      const below = levelNode.sub(positionWorld.y);
      const under = smoothstep(0.02, 0.25, below).mul(exp(below.mul(-0.22)));
      const c = caustic(positionWorld.xz).mul(u.caustics).mul(u.sunI).mul(max(u.sunDir.y, 0).add(0.1)).mul(under);
      return base.mul(float(1).sub(wetness(levelNode).mul(0.62))).mul(c.add(1));
    },
    groundRoughness(base, levelNode = u.level) { return mix(base, float(0.5), wetness(levelNode)); },
    // vals ur water.json; sun ur weather.js sunAt (riktning, färg, styrka); light: solens styrka i scenen; ambient: himlens ljus
    set(v, sun, { light = 3, ambient = 1 } = {}) {
      vals = v;
      u.shallow.value.set(v.shallow); u.deep.value.set(v.deep);
      for (const k of ['clarity', 'deepAt', 'ripples', 'rippleScale', 'reflections', 'distortion', 'refraction', 'glitter', 'glitterSize', 'shoreFoam', 'foamWidth', 'crestFoam', 'foamScale', 'edge', 'wetShore', 'wetBand', 'surge', 'surgePeriod', 'flowSpeed', 'flowFoam', 'caustics', 'causticScale']) u[k].value = v[k];
      u.steep.value = v.choppiness;
      const H = v.waveHeight * 0.5, n = WAVES.length;
      WAVES.forEach(([len, ang, amp], i) => {
        const L = v.waveLength * len, k = (2 * Math.PI) / L, A = H * amp, a = (v.waveDir + ang) * DEG;
        u.waveA.array[i].set(Math.sin(a), -Math.cos(a), k, A);
        u.waveB.array[i].set(Math.sqrt(G * k) * v.waveSpeed, A > 1e-5 ? Math.min(1 / (k * A * n), v.choppiness / (k * A * n)) : 0, i * 1.7, Math.min(3, L * 0.12 + 0.15));
      });
      const wa = v.waveDir * DEG;
      u.wind.value.set(Math.sin(wa), -Math.cos(wa));
      if (sun) {
        u.sunDir.value.copy(sun.dir); u.sunColor.value.copy(sun.color);
        u.sunI.value = light * sun.strength;
        u.ambient.value.copy(sun.zenith).lerp(sun.horizon, 0.5).multiplyScalar(0.4 * ambient + 0.06);
      }
      setMirror(!!v.mirror);
    },
    setLevel(y) { u.level.value = y; if (mirrorNode) mirrorNode.target.position.y = y; },
    update(time) { u.time.value = time; },
    // Ringar på ytan där något slog i
    splash(x, z, strength = 1) { u.splash.array[nextSplash].set(x, z, u.time.value, strength); nextSplash = (nextSplash + 1) % RIPPLES; },
    // Ytans höjd i vila plus vågorna (för flytande saker); bed: markens höjd där
    heightAt(x, z, rest = u.level.value, bedY = -99) {
      const t = u.time.value, d0 = rest - bedY;
      let y = rest;
      WAVES.forEach((_, i) => {
        const a = u.waveA.array[i], b = u.waveB.array[i];
        y += a.w * smoothN(0.02, b.w, d0) * Math.sin(a.z * (a.x * x + a.y * z) - b.x * t + b.z);
      });
      return y;
    },
    get vals() { return vals; },
    dispose() { geometry.dispose(); mats.sky.dispose(); mats.mirror?.dispose(); },
  };
}
