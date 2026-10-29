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
//   simulering). Regn (uniforms.rain, 0..1 ur atmosfären) ger små ringar överallt på ytan.
//
//   const water = createWater({ geometry, level, sky });   // geometry i världen, med attributen bed och flow
//   scene.add(water.mesh); water.set(vals, sun); water.update(time);
//   ground.colorNode = water.groundColor(baseColor, levelNode)
//
// Geometrin har hörnen i världens koordinater (y = ytans nivå i vila) och fyra attribut: bed (markens höjd under hörnet,
// för dämpning och sköljning), bedSlope (markens lutning, för vågryggarna mot stranden), flow (strömmens fart i xz,
// m/s vid Current = 1) och shore (gångtiden från stranden, riktningen in mot land och frontens samstämmighet, för de
// brytande vågorna). bedAndFlow() fyller dem.
//
// Brytande vågor och spetsskum (Breakers och Lace foam, båda av som standard, så att vattnet annars är som förut) är
// efter Ultra-Water (github.com/Humpalumps/Ultra-Water, MIT, © 2026 Humpalumps): vågfronter som går på gångtiden från
// stranden (shore.js), så att de saktar in, packas och böjer sig efter botten; Greens lag och brytgränsen 0,42 × djupet;
// krön som bryts tidigt på vissa sträckor och sent på andra (peeling); vitvatten som rider med vågen och nöts ned till
// spetsar med åldern; spetsar som ligger kvar i bränningen; sköljningen i takt med vågorna och en våt linje som torkar.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, attribute, varying, float, vec2, vec3, vec4, sin, cos, exp, pow, max, min, mix, abs, fract, floor,
  smoothstep, normalize, dot, reflect, length, select, saturate, positionWorld, cameraPosition, screenUV, texture,
  viewportSharedTexture, viewportDepthTexture, getViewPosition, cameraProjectionMatrixInverse, cameraWorldMatrix, reflector,
  sqrt, clamp, acos, mx_noise_float,
} from 'three/tsl';
import { travelField } from './shore.js';

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
  // Skum (R: mjuka runda bubblor, G: fläckar) och kaustik (B: ljusa trådar där cellerna möts). Bubblorna är avståndet
  // till cellernas mitt (runda, målade fläckar) i två storlekar, inte cellkanterna (som gav ett spretigt nät)
  const misc = new Uint8Array(N * N * 4), lace = worley(10, 3), lace2 = worley(23, 5), blot = worley(5, 9), caus = worley(7, 11);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = (y * N + x) * 4;
    const [a1] = lace(u, v), [b1] = lace2(u, v), [c1] = blot(u, v), [k1, k2] = caus(u, v);
    const big = 1 - smoothN(0.05, 0.55, a1), small = 1 - smoothN(0.03, 0.5, b1);
    misc[i] = 255 * Math.min(1, big * 0.75 + small * 0.4);
    misc[i + 1] = 255 * (1 - smoothN(0.15, 0.75, c1));
    misc[i + 2] = 255 * Math.pow(1 - smoothN(0, 0.2, k2 - k1), 2.2);
    misc[i + 3] = 255;
  }
  TEX = { slope: dataTex(slope, N), misc: dataTex(misc, N), foam: foamTex(512) };
  return TEX;
}
// Spetsskummet (efter Ultra-Water, bakeTextures.js): R = spetsmönstret (cellkanter i två storlekar och små bubblor),
// som skummet nöts ned till med åldern; G = vitvattnets bulor ("blomkål": varje cell en kupol, veckad där cellerna
// möts, i tre storlekar); BA = bulornas lutning per ruta (0,5 + d/duv / 64)
function foamTex(N) {
  const cells = (n, seed) => { const r = rng(seed); return { n, p: Float32Array.from({ length: n * n * 2 }, r) }; };
  const vor = ({ n, p }, u, v) => {
    const x = u * n, y = v * n, cx = Math.floor(x), cy = Math.floor(y);
    let f1 = 9, f2 = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j, k = ((((gy % n) + n) % n) * n + (((gx % n) + n) % n)) * 2;
      const dx = gx + p[k] - x, dy = gy + p[k + 1] - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  };
  const A = cells(9, 21), B = cells(23, 22), C = cells(61, 23), BA = cells(7, 24), BB = cells(17, 25), BC = cells(41, 26);
  const data = new Uint8Array(N * N * 4), bil = new Float32Array(N * N);
  const dome = ([f1, f2]) => Math.sqrt(Math.min(1, Math.max(0, (f2 - f1) * 2.2)));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N, v = (y + 0.5) / N, i = y * N + x;
    const a = vor(A, u, v), b = vor(B, u, v), c = vor(C, u, v);
    const lace = 1 - smoothN(0, 0.22, a[1] - a[0]), fine = 1 - smoothN(0, 0.16, b[1] - b[0]), bubbles = 1 - smoothN(0.15, 0.55, c[0]);
    data[i * 4] = 255 * Math.min(1, (lace * 0.55 + fine * 0.3 + bubbles * 0.25 + (1 - a[0]) * 0.25) * 0.85);
    bil[i] = 0.5 * dome(vor(BA, u, v)) + 0.32 * dome(vor(BB, u, v)) + 0.18 * dome(vor(BC, u, v));
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, gx = (bil[y * N + ((x + 1) % N)] - bil[y * N + ((x + N - 1) % N)]) * N / 2, gy = (bil[((y + 1) % N) * N + x] - bil[((y + N - 1) % N) * N + x]) * N / 2;
    data[i * 4 + 1] = 255 * Math.min(1, bil[i]);
    data[i * 4 + 2] = 255 * Math.min(1, Math.max(0, 0.5 + gx / 64));
    data[i * 4 + 3] = 255 * Math.min(1, Math.max(0, 0.5 + gy / 64));
  }
  return dataTex(data, N);
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
  // De brytande vågorna (Breakers): gångtiden från stranden, riktningen in mot land och frontens samstämmighet, ur ett
  // eikonalfält över geometrins ruta (shore.js). Inte i strömmande vatten (bäckar och åar)
  const shore = new Float32Array(n * 4);
  if (!flowAt && n) {
    // Bara över grundet (vågorna finns inte där det är djupare än 8 m), så att rutorna blir små nog även när havet når
    // horisonten
    const L = p.getY(0);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) if (bed[i] > L - 12) { const x = p.getX(i), z = p.getZ(i); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const field = x0 < x1 ? travelField(bedAt, L, x0 - 20, x1 + 20, z0 - 20, z1 + 20) : null;
    if (field) for (let i = 0; i < n; i++) shore.set(field.at(p.getX(i), p.getZ(i)), i * 4);
  }
  geometry.setAttribute('shore', new THREE.BufferAttribute(shore, 4));
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
    breakers: uniform(0), lace: uniform(0), swellDir: uniform(new THREE.Vector2(0, 1)),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color('#ffffff')), sunI: uniform(1), ambient: uniform(new THREE.Color('#8090a0')),
    level: uniform(level), rain: uniform(0),
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
  // Sköljningen börjar en tiondels cykel innan vågryggen når strandlinjen, så att ryggen sjunker ned i den i stället för
  // att försvinna vid kanten (då klipptes vågorna i varandra)
  const runPhase = (t, x) => surgePhase(t, x).add(0.1);
  const surgeAt = (t, x) => {
    const ph = runPhase(t, x), s = fract(ph);
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
    const sink = smoothstep(0.05, 0.6, at); // ryggen sjunker ned i sköljningen sista biten
    const h = shape.mul(grow).mul(str).mul(u.surge).mul(1.3).mul(sink).mul(smoothstep(-0.05, 0.1, depth0));
    const dh = shape.mul(d).mul(-2 / 0.12).mul(grow).mul(str).mul(u.surge).mul(1.3).mul(sink); // dh/d(djup)
    const trail = select(d.greaterThan(0), exp(d.div(-0.6)), exp(d.mul(d).div(0.02).negate())).mul(str).mul(smoothstep(0, 0.4, at.add(0.1)));
    const rp = runPhase(u.time, P0.x), rs = fract(rp);
    const swash = float(1).sub(smoothstep(-0.1, 0.45, depth0)).mul(float(1).sub(smoothstep(0.1, 0.62, rs))).mul(waveStrength(floor(rp))).mul(select(u.surge.greaterThan(0), 1, 0));
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

  // Brytande vågor (Breakers, efter Ultra-Water): två vågtåg på gångtiden från stranden, fas ω(τ + t). När de är på
  // ersätter de vågryggen ovan, och sköljningen går i takt med dem
  const shoreA = attribute('shore', 'vec4'), brOn = select(u.breakers.greaterThan(0), 1, 0);
  const TAU = Math.PI * 2;
  const vn = (p) => mx_noise_float(vec3(p.x, p.y, 0)).mul(0.5).add(0.5);
  const shorePhase = (xz) => vn(xz.mul(0.009)).mul(9).add(vn(xz.mul(0.023).add(7)).mul(2.5)); // fasen längs stranden
  const shoreGroup = (xz) => vn(xz.mul(0.008).add(vec2(u.time.mul(0.021), u.time.mul(-0.017)))).mul(0.55).add(0.45); // seten
  const omega = float(TAU).div(u.surgePeriod);
  // Sköljningen: vågen når strandlinjen (τ = 0) vid s = 0, springer upp till R på en knapp tredjedel och rinner tillbaka
  const swashS = (xz) => fract(u.time.mul(omega).add(shorePhase(xz)).div(TAU));
  const swashEta = (s, R) => R.mul(select(s.lessThan(0.3), sin(s.div(0.3).mul(Math.PI / 2)), cos(s.sub(0.3).div(0.7).mul(Math.PI / 2))));
  const br = (() => {
    const tau = shoreA.x, dir = shoreA.yz, coh = shoreA.w, depth = depth0;
    const env = float(1).sub(smoothstep(3, 8, depth)).mul(smoothstep(-0.9, 0.5, depth)).mul(coh).mul(brOn);
    const expo = mix(0.25, 1, smoothstep(-0.3, 0.7, dot(dir, u.swellDir))); // kuster mot dyningen får de stora seten
    const shoal = pow(clamp(max(depth, 0.6).div(8), 0.04, 1), -0.25); // Greens lag
    const cel = sqrt(clamp(depth, 0.3, 14).mul(G));
    const amax = max(depth, 0).mul(0.42).add(u.breakers.mul(0.3));
    const np = shorePhase(P0.xz), grp = shoreGroup(P0.xz), lean = max(u.steep, 0.2);
    let pinch = float(0.85); // all hoptryckning i sidled tillsammans (ytan viks aldrig över sig själv)
    let disp = vec3(0), slope = vec2(0), foam = float(0), lip = float(0), residual = float(0);
    for (let i = 0; i < 2; i++) {
      const w = omega.mul(i ? 1.28 : 1), k = w.div(cel);
      const a = min(u.breakers.mul(i ? 0.45 : 1).mul(env).mul(expo).mul(shoal).mul(grp), amax.mul(i ? 0.5 : 1));
      const ph = w.mul(tau.add(u.time)).add(np.mul(i ? 1.37 : 1)).add(i * 2.1);
      const c = max(cos(ph).mul(0.5).add(0.5), 1e-4), s = sin(ph), cp = pow(c, 0.6); // smalare krön, flackare dalar
      const rel = a.div(max(depth, 0.05));
      // Varje krön bryts tidigt på vissa sträckor och sent på andra, med en ny fördelning för varje våg
      const cycle = floor(ph.add(Math.PI).div(TAU));
      const early = vn(P0.xz.mul(0.03).add(vec2(cycle.mul(7.3), cycle.mul(3.1).add(i * 31))));
      const breaking = smoothstep(early.mul(0.14).add(0.12), early.mul(0.2).add(0.3), rel);
      // Kammen lutar fram där den bryts (bara kring brytpunkten; längre in går den som en bränning)
      let pitch = float(0);
      if (i === 0) pitch = min(a.mul(2).mul(lean).mul(smoothstep(0.16, 0.28, rel)).mul(float(1).sub(smoothstep(0.4, 0.6, rel))), float(0.35).div(k.mul(1.08)));
      pinch = pinch.sub(pitch.mul(k).mul(1.08));
      const qak = max(min(pinch, lean.mul(a).mul(k).mul(8)), 0);
      pinch = pinch.sub(qak);
      const c5 = c.mul(c).mul(c).mul(c).mul(c);
      disp = disp.add(vec3(dir.x, 0, dir.y).mul(qak.div(k).mul(s).add(pitch.mul(c5).mul(c)))).add(vec3(0, a.mul(cp.mul(c).mul(2).sub(0.78)), 0));
      slope = slope.add(dir.mul(a.mul(k).mul(1.6).mul(cp).mul(s).div(max(float(1).sub(qak.mul(cos(ph))).add(pitch.mul(k).mul(3).mul(c5).mul(s)), 0.2))));
      // Vitvatten på krönet och efter det, när vågen bryts
      const psi = fract(ph.add(Math.PI).div(TAU)).mul(TAU).sub(Math.PI);
      foam = foam.add(breaking.mul(smoothstep(-0.45, 0, psi)).mul(exp(max(psi, 0).mul(-0.8))));
      if (i === 0) {
        lip = breaking.mul(c5).mul(smoothstep(0.6, -0.2, psi));
        residual = smoothstep(0.18, 0.4, rel).mul(exp(fract(ph.div(TAU)).mul(TAU).mul(-0.4)).mul(0.45).add(0.3)); // spetsarna som blir kvar
      }
    }
    // Skummet i sköljningens framkant medan den springer upp
    const uprush = float(1).sub(smoothstep(0.25, 0.45, swashS(P0.xz))).mul(float(1).sub(smoothstep(0.3, 1.2, depth))).mul(brOn);
    return { disp, slope, foam, lip, residual, uprush, dir, cel, swash: swashEta(swashS(P0.xz), u.surge.mul(grp)) };
  })();
  const surgeNow = mix(surgeAt(u.time, P0.x), br.swash, brOn).mul(shoreW);
  const brNormal = vec3(br.slope.x.negate(), 0, br.slope.y.negate());
  const vNormal = varying(normalize(g.n.add(bore.n.mul(float(1).sub(brOn))).add(brNormal))), vPinch = varying(g.pinch), vFlow = varying(flowA);
  const vBore = varying(mix(bore.foam, max(br.foam, br.residual.mul(0.5)), brOn));
  const vBr = varying(vec4(br.foam, br.residual, br.lip, br.uprush)), vDir = varying(br.dir), vCel = varying(br.cel);
  const vSlope = varying(bedSlope); // bottnens lutning: skummet sträcks längs strandlinjen

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
    // Regnets ringar: två förskjutna rutnät med en droppe per ruta och sin egen takt; ringen växer och dör ut innan den
    // når rutans kant. Fler och tätare droppar när det regnar mer
    const drops = (cellSize, salt) => {
      const g = Pw.xz.div(cellSize).add(salt), cell = floor(g), h1 = fract(sin(cell.x.mul(127.1).add(cell.y.mul(311.7)).add(salt * 17)).mul(43758.5453));
      const h2 = fract(h1.mul(91.7)), h3 = fract(h1.mul(53.3));
      const period = float(0.5).add(h3.mul(0.9)).div(u.rain.mul(0.8).add(0.2));
      const age = fract(t.div(period).add(h1)).mul(period);
      const rel = fract(g).sub(vec2(h2, h3).mul(0.4).add(0.3)).mul(cellSize), r = length(rel).add(1e-4);
      const d = r.sub(age.mul(0.32)), env = exp(d.mul(d).mul(-900)).mul(exp(age.mul(-4))).mul(select(h2.lessThan(u.rain.mul(0.9).add(0.1)), 1, 0));
      return rel.div(r).mul(cos(d.mul(90)).mul(env));
    };
    const rainSlope = select(u.rain.greaterThan(0.001), drops(0.6, 0).add(drops(0.45, 0.5)), vec2(0)).mul(u.rain.mul(0.6).add(0.25));
    const N = normalize(vNormal.add(vec3(detail.x.add(ring.x.mul(0.7)).add(rainSlope.x).negate(), 0, detail.y.add(ring.y.mul(0.7)).add(rainSlope.y).negate())));
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
    let refl = sky ? sky.colorAt(Ru, 0, false) : vec3(0.6, 0.75, 0.9); // molnen med färre oktaver i speglingen
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
    const warp = slopeAt(Pw.xz.div(u.foamScale.mul(5)).add(vec2(t.mul(-0.013), t.mul(0.009)))).mul(0.04);
    const fuvA = Pw.xz.div(u.foamScale.mul(6)).add(warp);
    // Skummet följer strömmen med samma tvåfas-flöde som krusningarna: två kopior glider med strömmen och tonas
    // växelvis in och ut (triangelvikter), så att skummet driver längs bäckens kontur utan att töjas ut med tiden.
    // Långsammare cykel än krusningarna (ca 6,7 s), annars pulserar skummet
    const qa = fract(t.mul(0.15)), qb = fract(t.mul(0.15).add(0.5));
    const wa = float(1).sub(abs(qa.mul(2).sub(1))), wb = float(1).sub(abs(qb.mul(2).sub(1)));
    const oa = f.mul(qa.div(0.15).mul(0.33)), ob = f.mul(qb.div(0.15).mul(0.33));
    // De stora fläckarna formar skummets kant, bubblorna ger rundade hål och tungor i den. k skalar koordinaterna
    // per axel: k.x < 1 drar ut skummet längs x
    const foamAt = (k, o, s0) => mix(texture(T.misc, fuvB.sub(o.mul(0.75)).add(s0).mul(k)).g, texture(T.misc, fuvA.sub(o).add(s0).mul(k)).r, 0.3);
    // Den andra kopian förskjuts bara där det strömmar: i stilla vatten (strand, sjö) är kopiorna lika och inget pulserar
    const foamNoise = (k) => foamAt(k, oa, vec2(0)).mul(wa).add(foamAt(k, ob, vec2(0.5, 0.37).mul(saturate(fl.mul(4)))).mul(wb));
    // Utdraget längs strandlinjen: bruset samplas utdraget längs x och längs z och blandas efter bottnens lutning
    // (lutar botten i z går stranden längs x). Ingen vridning per pixel, så inga virvlar där stranden kröker sig.
    // På plant vatten (ingen lutning) är skummet runt som förut.
    const sx = vSlope.x.mul(vSlope.x), sz = vSlope.y.mul(vSlope.y);
    const S = float(1).div(3); // tre gånger längre längs stranden än tvärs
    const along = mix(foamNoise(vec2(S, 1)), foamNoise(vec2(1, S)), sx.div(sx.add(sz).add(1e-6)));
    const noise = mix(foamNoise(vec2(1, 1)), along, smoothstep(0.002, 0.03, sx.add(sz)));
    const shore = float(1).sub(smoothstep(0, u.foamWidth, dv)).mul(u.shoreFoam);
    const crest = smoothstep(0.5, 0.9, vPinch.div(max(u.steep, 0.01))).mul(u.crestFoam).mul(1.4);
    // Forsskummet har sin topp en bit ut från kanten (där strömmen bryts över stenarna), inte ända in mot land
    const rapids = saturate(fl.mul(0.8)).mul(float(1).sub(smoothstep(0.08, 0.45, dv))).mul(smoothstep(0.0, 0.1, dv)).mul(u.flowFoam).mul(1.3);
    // Taket 0,8: även tätt skum bryts upp i fläckar (vid 1 släpper tröskeln igenom allt och det blir ett vitt band)
    const mask = saturate(max(max(shore, crest), max(rapids, vBore.mul(u.shoreFoam).mul(1.4)))).mul(0.8);
    // Mjuk kant: skummet blir runda fläckar som tonar ut, inte vassa trådar, och tonar bort mot strandlinjen
    const edge0 = float(1).sub(mask);
    const foam = smoothstep(edge0.sub(0.1), edge0.add(0.4), noise).mul(saturate(mask.mul(2))).mul(smoothstep(0, u.edge.mul(3).add(0.02), dv));
    // Den brytande kammen är tunn och lyser igenom (turkos) innan den slår över
    col = col.add(u.shallow.mul(lightAmt).mul(vBr.z).mul(0.6));
    // Lite genomskinligt skum (0,85), så att vattnet skymtar igenom och kanten blandas mjukt
    const colBlob = mix(col, vec3(0.92, 0.95, 0.96).mul(lightAmt.add(u.sunColor.mul(u.sunI).mul(max(u.sunDir.y, 0).mul(0.3)))), foam.mul(0.85));

    // Spetsskummet (Lace foam, efter Ultra-Water): tätt skum är nästan helt vitt och nöts med åldern ned till ett nät
    // av spetsar (tröskel i mönstret). Varje källa ger också bulornas höjd och lutning och en täthet för ljuset
    const fsc = u.foamScale, ft = (uv) => texture(T.foam, uv);
    const t0 = ft(Pw.xz.mul(float(0.11).div(fsc)));
    // Vid stranden och på krönen, och en rand i sköljningens framkant medan den springer upp. Taket 0,85: på en flack
    // strand är vattnet tunt långt upp, och då skulle allt bli vitt
    const fStat = min(max(shore, crest).add(vBr.w.mul(float(1).sub(smoothstep(0.02, 0.12, dv))).mul(0.6)), 0.85);
    const pat0 = t0.r.mul(0.65).add(ft(Pw.xz.mul(float(0.031).div(fsc)).add(0.37)).r.mul(0.35));
    let cover = smoothstep(float(1.05).sub(fStat), float(1.3).sub(fStat), pat0).mul(sqrt(fStat));
    let pat = pat0, fh = t0.g, fg = t0.ba.sub(0.5).mul(float(64 * 0.11).div(fsc)), dens = fStat;
    // Vitvattnet rider med vågen in mot land: flödeskarta i vågens fart, två faser som vägs ihop (det kärnar också)
    const ww = min(vBr.x.mul(u.shoreFoam), 0.8), vel = vDir.mul(vCel), FT = 2.5;
    const f0 = fract(t.div(FT)), f1 = fract(t.div(FT).add(0.5)), wbl = abs(f0.mul(2).sub(1));
    const ws = float(0.15).div(fsc);
    const b0 = ft(Pw.xz.sub(vel.mul(f0.mul(FT))).mul(ws)), b1 = ft(Pw.xz.sub(vel.mul(f1.mul(FT))).mul(ws).add(0.43));
    const sh = mix(b0.g, b1.g, wbl);
    const sPat = mix(b0.r, b1.r, wbl).mul(0.3).add(sh.mul(0.45)).add(ft(Pw.xz.mul(float(0.023).div(fsc)).add(0.5)).r.mul(0.25));
    const sCover = smoothstep(float(1).sub(ww.mul(1.1)), float(1.2).sub(ww.mul(1.1)), sPat).mul(sqrt(ww));
    const sWin = sCover.greaterThanEqual(cover);
    pat = select(sWin, sPat, pat); fh = select(sWin, sh, fh); dens = select(sWin, ww, dens);
    fg = select(sWin, mix(b0.ba, b1.ba, wbl).sub(0.5).mul(ws.mul(64)), fg);
    cover = max(cover, sCover);
    // Spetsarna som blir kvar i bränningen och driver in mot land
    const res = saturate(vBr.y.mul(u.shoreFoam).mul(1.2)), fp = fract(t.div(8)), drift = vDir.mul(2.8), rs = float(0.06).div(fsc);
    const rp = mix(ft(Pw.xz.sub(drift.mul(fp)).mul(rs)).r, ft(Pw.xz.sub(drift.mul(fract(fp.add(0.5)))).mul(rs).add(0.5)).r, abs(fp.mul(2).sub(1)));
    const rCover = smoothstep(float(1.2).sub(res), float(1.35).sub(res), rp).mul(res);
    const rWin = rCover.greaterThanEqual(cover);
    pat = select(rWin, rp, pat); fh = select(rWin, float(0.5), fh); dens = select(rWin, res.mul(0.5), dens); fg = select(rWin, vec2(0), fg);
    cover = max(cover, rCover);
    // Forsskummet som förut (det följer strömmen)
    const rapM = saturate(rapids).mul(0.8), rapE = float(1).sub(rapM);
    cover = max(cover, smoothstep(rapE.sub(0.1), rapE.add(0.4), noise).mul(saturate(rapM.mul(2))));
    cover = cover.mul(smoothstep(0, u.edge.mul(1.5).add(0.01), dv));
    // Ljuset: bulorna buktar normalen och skuggar vecken; tunt skum är en bubbelhinna i vattnets färg, tätt skum vitt med
    // lite glans på bubbeltopparna; solen bakom krönet lyser igenom det tunna
    const fN = normalize(N.sub(vec3(fg.x, 0, fg.y).mul(dens.mul(0.12).add(0.03))));
    const ao = mix(0.45, 1, smoothstep(0.15, 0.75, fh)), solid = smoothstep(0.2, 0.9, dens.mul(fh.mul(0.7).add(0.55)));
    const albedo = mix(u.shallow.mul(0.45).add(0.45), vec3(0.95), max(solid, smoothstep(0.3, 0.9, pat).mul(0.6)));
    const sunL = u.sunColor.mul(u.sunI).mul(0.42);
    const lit = sunL.mul(saturate(dot(fN, u.sunDir).mul(0.8).add(0.2))).mul(mix(ao, 1, 0.4)).add(u.ambient.mul(ao).mul(1.1))
      .add(sunL.mul(pow(saturate(dot(u.sunDir, V.negate())), 4)).mul(0.4).mul(float(1).sub(solid)));
    const Hs = normalize(u.sunDir.add(V));
    const foamCol = albedo.mul(lit).add(sunL.mul(pow(max(dot(fN, Hs), 0), 90)).mul(0.5).mul(smoothstep(0.55, 0.85, fh)).mul(solid));
    const colLace = mix(col, foamCol, cover.mul(mix(0.8, 1, solid)));
    col = mix(colBlob, colLace, u.lace);
    // Mot stranden tonar ytan ut (inget hårt snitt där vattnet möter marken); spetsskummet håller sin kant lite längre
    const alpha = smoothstep(0, u.edge.mul(1.8), dv);
    return vec4(col, mix(alpha, max(alpha, cover.mul(0.9).mul(smoothstep(0, 0.015, dv))), u.lace));
  })();

  // Speglingen av scenen: ett plan i ytans nivå som ritar scenen spegelvänd (halv upplösning), byggt först när det behövs
  let mirrorNode = null;
  function material(mirror) {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true, side: THREE.FrontSide });
    m.positionNode = P0.add(g.d).add(br.disp).add(vec3(0, surgeNow.add(bore.h.mul(float(1).sub(brOn))), 0));
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
    const ph = runPhase(u.time, positionWorld.x), s = fract(ph), n = floor(ph);
    const prof = select(s.lessThan(0.2), smoothstep(0, 0.2, s), float(1).sub(s.sub(0.2).mul(0.45)));
    const line = max(prof.mul(waveStrength(n)), waveStrength(n.sub(1)).mul(float(0.7).sub(s.mul(0.25)))).mul(u.surge);
    const washed = float(1).sub(smoothstep(line.sub(0.1), line.add(0.01), above)).mul(0.75).add(float(1).sub(smoothstep(line.sub(0.01), line.add(0.03), above)).mul(0.25));
    // Med de brytande vågorna (efter Ultra-Water): sanden under sköljningen är våt, och torkar sedan några sekunder från
    // det att vattnet drog sig tillbaka därifrån; de större seten når högre och lämnar en svagare fuktig rand
    const xz = positionWorld.xz, R = max(u.surge.mul(shoreGroup(xz)), 0.005), sw = swashS(xz);
    const sPass = acos(clamp(above.div(R), 0, 1)).div(Math.PI / 2).mul(0.7).add(0.3);
    const dry = select(sw.greaterThan(sPass), sw.sub(sPass), sw.add(1).sub(sPass)).mul(u.surgePeriod);
    const film = select(swashEta(sw, R).sub(above).greaterThan(0), float(1), exp(dry.div(-5)));
    const washedBr = select(above.greaterThan(R), smoothstep(R.mul(1.5), R, above).mul(0.5), film);
    const washedAll = mix(washed, washedBr, brOn).mul(select(u.surge.greaterThan(0), 1, 0));
    return saturate(max(band, washedAll)).mul(u.wetShore);
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
      for (const k of ['clarity', 'deepAt', 'ripples', 'rippleScale', 'reflections', 'distortion', 'refraction', 'glitter', 'glitterSize', 'shoreFoam', 'foamWidth', 'crestFoam', 'foamScale', 'edge', 'wetShore', 'wetBand', 'surge', 'surgePeriod', 'flowSpeed', 'flowFoam', 'caustics', 'causticScale', 'breakers', 'lace']) u[k].value = v[k] ?? 0;
      u.steep.value = v.choppiness;
      const H = v.waveHeight * 0.5, n = WAVES.length;
      WAVES.forEach(([len, ang, amp], i) => {
        const L = v.waveLength * len, k = (2 * Math.PI) / L, A = H * amp, a = (v.waveDir + ang) * DEG;
        u.waveA.array[i].set(Math.sin(a), -Math.cos(a), k, A);
        u.waveB.array[i].set(Math.sqrt(G * k) * v.waveSpeed, A > 1e-5 ? Math.min(1 / (k * A * n), v.choppiness / (k * A * n)) : 0, i * 1.7, Math.min(3, L * 0.12 + 0.15));
      });
      const wa = v.waveDir * DEG;
      u.wind.value.set(Math.sin(wa), -Math.cos(wa));
      u.swellDir.value.set(Math.sin(wa), -Math.cos(wa));
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
