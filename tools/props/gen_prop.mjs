// Propsgenerator: naturprops för skog, stig och fält (stenar, bumlingar, mossa, svampar, stubbar,
// lövhögar, krypväxter). Fristående från trädgeneratorn men återanvänder dess byggstenar
// (avståndsfält + surface nets, barkrör, solida blad). Recept in, GLB ut, en rad JSON som svar.
// Användning: node gen_prop.mjs '{"preset":"mossy_boulder","seed":3,"out":"x.glb","textures":{...}}'
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { add, sub, mul, dot, cross, norm, lerp, clamp01, UP, rng, randomUnit } from '../tree/vec.mjs';
import { surfaceNets, gradient, buildCrown } from '../tree/crown.mjs';
import { barkMesh } from '../tree/bark_mesh.mjs';
import { pushLeaf } from '../tree/leafdome.mjs';

const PROPS = JSON.parse(fs.readFileSync(new URL('./props.json', import.meta.url)));
const recipe = JSON.parse(process.argv[2] ?? '{}');
const { preset = 'stone', seed = 0, out, textures = {} } = recipe;
const sp = { ...PROPS[preset], ...(recipe.params ?? {}) };
if (!PROPS[preset] || preset.startsWith('_')) {
  console.error(`unknown preset ${preset}; available: ${Object.keys(PROPS).filter((k) => !k.startsWith('_')).join(', ')}`);
  process.exit(1);
}
const r = rng(seed * 7349 + 11);
const between = ([a, b]) => a + (b - a) * r();
const pick = ([a, b]) => Math.round(between([a, b]));
const lin = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);
const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], indices: [] });
function append(dst, src) { // slå ihop två geometrier
  const base = dst.positions.length / 3;
  for (const k of ['positions', 'normals', 'uvs', 'colors', 'wind']) dst[k].push(...(src[k] ?? []));
  if (!src.colors?.length) for (let i = 0; i < src.positions.length / 3; i++) dst.colors.push(1, 1, 1);
  if (!src.wind?.length) for (let i = 0; i < src.positions.length / 3; i++) dst.wind.push(0);
  dst.indices.push(...src.indices.map((i) => i + base));
  return dst;
}
const LODS = 3;

// ---------- Sten och bumling: mjuk union av ellipsoider med lågfrekvent brus, platt botten i marken ----------
function rockField(size, o, rr) {
  const blobs = Array.from({ length: pick(o.blobs) }, () => ({
    c: [(rr() - 0.5) * size * 0.5, (rr() - 0.3) * size * 0.15, (rr() - 0.5) * size * 0.5],
    rad: [size * (0.38 + rr() * 0.2), size * (0.38 + rr() * 0.2) * o.squash, size * (0.38 + rr() * 0.2)],
    waves: Array.from({ length: 4 }, () => ({ k: mul(randomUnit(rr), 2 + rr() * 2.5), ph: rr() * 6.28, a: o.lump * (0.5 + rr()) })),
  }));
  const k = size * 0.18;
  const smin = (a, b) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
  const cut = -size * 0.12; // stenen går lite ner i marken
  const f = (p) => {
    let d = Infinity;
    for (const b of blobs) {
      const q = [(p[0] - b.c[0]) / b.rad[0], (p[1] - b.c[1]) / b.rad[1], (p[2] - b.c[2]) / b.rad[2]];
      const l = Math.hypot(...q) || 1e-6, dir = q.map((x) => x / l);
      const lump = b.waves.reduce((s, w) => s + w.a * Math.sin(dot(dir, w.k) + w.ph), 0);
      d = smin(d, (l - 1 - lump) * Math.min(...b.rad));
    }
    return Math.max(d, cut - p[1]); // platt snitt under marken
  };
  return { f, cut, extent: size * 1.1 };
}

function buildRock(size, o, rr, offset = [0, 0, 0], cellScale = 1) {
  const { f, cut, extent } = rockField(size, o, rr);
  const lo = [-extent, cut - size * 0.05, -extent], hi = [extent, extent, extent];
  const net = surfaceNets(f, lo, hi, size * (o.cell ?? 0.07) * cellScale);
  const stone = empty(), moss = empty();
  const S = 1 / Math.max(0.6, size * 0.9); // texturupprepning per meter
  const mossNoise = (p) => Math.sin(p[0] * 7.1 / size + 1.3) * Math.cos(p[2] * 6.3 / size) * 0.5 + Math.sin(p[1] * 9 / size) * 0.3;
  for (const q of net.quads) {
    const [a, b, c, d] = q.map((i) => net.verts[i]);
    let qn = cross(sub(c, a), sub(d, b));
    const mid = mul(add(add(a, b), add(c, d)), 0.25);
    const g = gradient(f, mid, size * 0.01);
    const outward = dot(qn, g) > 0;
    qn = norm(outward ? qn : mul(qn, -1));
    if (mid[1] < cut + size * 0.01) continue; // hoppa över botten (dold under marken)
    // Mossa på uppåtvända ytor, med lite brus i kanten
    const isMoss = o.moss > 0 && qn[1] + mossNoise(mid) * 0.18 > 1 - o.moss * 1.25;
    const g2 = isMoss ? moss : stone;
    const ax = [0, 1, 2].reduce((m, x) => (Math.abs(qn[x]) > Math.abs(qn[m]) ? x : m), 0);
    const [u1, u2] = ax === 0 ? [2, 1] : ax === 1 ? [0, 2] : [0, 1];
    const start = g2.positions.length / 3;
    for (const v of [a, b, c, d]) {
      const gn = gradient(f, v, size * 0.01);
      const n = norm(lerp(gn, qn, o.facet)); // mjuka fasetter: mellan rundad och platt
      const p = add(v, offset);
      g2.positions.push(...p); g2.normals.push(...n);
      const sc = isMoss ? (o.mossRepeat ?? 4) : S; // mossan har ett mycket finare mönster än stenen
      g2.uvs.push(p[u1] * sc, -p[u2] * sc);
      const ao = 0.62 + 0.38 * clamp01((v[1] - cut) / (size * 0.55)); // mörkare nedtill
      g2.colors.push(ao, ao, ao); g2.wind.push(0);
    }
    if (outward) g2.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    else g2.indices.push(start, start + 2, start + 1, start, start + 3, start + 2);
  }
  return { stone, moss };
}

function rockLods() {
  const n = pick(sp.count ?? [1, 1]);
  const placements = Array.from({ length: n }, (_, i) => {
    const s = Array.isArray(sp.size) ? between(sp.size) : sp.size * (n > 1 ? 0.6 + r() * 0.6 : 1);
    const a = r() * Math.PI * 2, d = n > 1 ? (sp.spread ?? 1) * Math.sqrt(r()) : 0;
    return { s, off: [Math.cos(a) * d, 0, Math.sin(a) * d], seed: Math.floor(r() * 2 ** 31) };
  });
  return [1, 1.6, 2.6].map((cs) => {
    const parts = { stone: empty(), moss: empty() };
    for (const pl of placements) {
      const g = buildRock(pl.s, sp, rng(pl.seed), pl.off, cs);
      append(parts.stone, g.stone); append(parts.moss, g.moss);
    }
    return parts;
  });
}

// ---------- Svamp: svarvade hattar, skivor och fötter, i klungor ----------
function lathe(profile, segs, uRep, color) {
  // profile: [[radie, höjd], ...] nedifrån och upp (eller ut och in); normaler från profilens lutning
  const g = empty();
  for (let i = 0; i < profile.length; i++) {
    const [rad, y] = profile[i];
    const [r0, y0] = profile[Math.max(0, i - 1)], [r1, y1] = profile[Math.min(profile.length - 1, i + 1)];
    const t = [r1 - r0, y1 - y0], tl = Math.hypot(...t) || 1;
    const n2 = [t[1] / tl, -t[0] / tl]; // profilnormal (utåt för medurs profil)
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      g.positions.push(rad * ca, y, rad * sa);
      g.normals.push(n2[0] * ca, n2[1], n2[0] * sa);
      g.uvs.push((s / segs) * uRep, i / (profile.length - 1));
      g.colors.push(...color); g.wind.push(0);
    }
  }
  const row = segs + 1;
  for (let i = 0; i < profile.length - 1; i++) for (let s = 0; s < segs; s++) {
    const a = i * row + s, b = a + row;
    g.indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return g;
}
const transform = (g, fn) => { // fn(p) -> p för positioner, normaler roteras med samma funktion utan translation
  for (let i = 0; i < g.positions.length; i += 3) {
    const p = fn.pos([g.positions[i], g.positions[i + 1], g.positions[i + 2]]);
    const n = fn.dir([g.normals[i], g.normals[i + 1], g.normals[i + 2]]);
    g.positions.splice(i, 3, ...p); g.normals.splice(i, 3, ...n);
  }
  return g;
};
function mushroomLods() {
  const n = pick(sp.count);
  const mush = Array.from({ length: n }, (_, i) => {
    const rc = between(sp.capRadius) * (i === 0 ? 1.15 : 0.7 + r() * 0.4);
    const hs = between(sp.stemHeight) * (rc / sp.capRadius[1]) ** 0.5;
    const a = r() * Math.PI * 2, d = i === 0 ? 0 : sp.spread * (0.4 + r() * 0.6);
    return { rc, hs, x: Math.cos(a) * d, z: Math.sin(a) * d, tilt: [(r() - 0.5) * 0.35, r() * 6.28, (r() - 0.5) * 0.35] };
  });
  const stemC = lin(sp.stem), gillC = lin(sp.gills);
  return [16, 10, 6].map((segs) => {
    const parts = { cap: empty(), gills: empty(), stem: empty() };
    for (const m of mush) {
      const rc = m.rc, hc = rc * (sp.shape === 'funnel' ? 0.55 : sp.shape === 'bun' ? 0.75 : 0.62), rs = sp.stemRadius * (rc / sp.capRadius[1]);
      const N = 8;
      let capP;
      if (sp.shape === 'funnel') {
        // Kantarell: insjunken mitt, kanten böjd uppåt och utåt med lätt nedrullad kant
        capP = Array.from({ length: N + 1 }, (_, i) => { const t = i / N; return [rc * (1 - t), hc * (1 - 0.55 * Math.sin(t * Math.PI / 2)) - (t < 0.12 ? (0.12 - t) * hc * 1.5 : 0)]; });
      } else {
        const bulge = sp.shape === 'bun' ? 1.06 : 1.0;
        capP = Array.from({ length: N + 1 }, (_, i) => { const a = (i / N) * Math.PI / 2; return [rc * Math.cos(a) * (i === 0 ? 1 : bulge), hc * Math.sin(a)]; });
      }
      const cap = lathe(capP, segs, sp.capRepeat ?? 2, [1, 1, 1]);
      // Skivor under hatten: från kanten in mot foten, vända nedåt
      const gillP = [[rs * 1.1, sp.shape === 'funnel' ? hc * 0.05 : hc * 0.12], [rc * 0.98, 0]];
      const gills = lathe(gillP, segs, 1, gillC);
      // Fot: avsmalnande, med svullen bas (porcini), lätt böjd
      const stemP = Array.from({ length: 6 }, (_, i) => { const t = i / 5; return [rs * (1 + (sp.bulb - 1) * (1 - t) ** 2), -m.hs + m.hs * t]; });
      const stem = lathe(stemP, Math.max(5, segs - 4), 1, stemC);
      const [tx, ty, tz] = m.tilt;
      const rot = (p) => { // rotera runt y, luta runt x och z
        let [x, y, z] = p;
        [x, z] = [x * Math.cos(ty) - z * Math.sin(ty), x * Math.sin(ty) + z * Math.cos(ty)];
        [y, z] = [y * Math.cos(tx) - z * Math.sin(tx), y * Math.sin(tx) + z * Math.cos(tx)];
        [x, y] = [x * Math.cos(tz) - y * Math.sin(tz), x * Math.sin(tz) + y * Math.cos(tz)];
        return [x, y, z];
      };
      const fn = { pos: (p) => add(rot([p[0], p[1] + m.hs, p[2]]), [m.x, -0.01, m.z]), dir: (n) => norm(rot(n)) };
      append(parts.cap, transform(cap, fn)); append(parts.gills, transform(gills, fn)); append(parts.stem, transform(stem, fn));
    }
    return parts;
  });
}

// ---------- Stubbe: trädgeneratorns barkrör, kapat med årsringar på snittytan ----------
function stumpLods() {
  const H = sp.height, R0 = sp.radius;
  const lean = [(r() - 0.5) * 0.06, 1, (r() - 0.5) * 0.06];
  // Täta ringar nedtill, där rötterna sväller ut
  const nodes = Array.from({ length: 12 }, (_, i) => { const t = (i / 11) ** 1.6; return { p: [lean[0] * t * H, -0.05 + (H + 0.05) * t, lean[2] * t * H], r: R0 * (1 - 0.1 * t) }; });
  const sk = { branches: [{ level: 0, nodes, segments: 16, phase: r() * 6.28 }] };
  const lods = [1, 0.7, 0.5].map((segScale) => {
    const g = barkMesh(sk, { maxLevel: 0, segScale, barkRepeat: 0.6, flare: sp.flare, roots: sp.roots, rootAmp: sp.rootAmp, flareHeight: 0.45,
      height: H, lobes: sp.lobes, lobeAmp: sp.lobeAmp, twist: 0.4, bulge: 0.03, flatTop: true });
    const parts = { bark: { ...g, cap: undefined }, cap: g.cap };
    return parts;
  });
  if (sp.moss) {
    // Mossiga stubbar: några mosskuddar på snittytan och vid rötterna
    const pads = Array.from({ length: 4 }, (_, i) => {
      const a = r() * 6.28, top = i < 2;
      const d = top ? R0 * 0.4 * r() : R0 * (1.0 + r() * 0.3);
      return { off: [Math.cos(a) * d, top ? H - 0.02 : 0, Math.sin(a) * d], s: top ? R0 * 0.75 : R0 * 0.55, seed: Math.floor(r() * 2 ** 31) };
    });
    lods.forEach((parts, li) => {
      parts.moss = empty();
      for (const p of pads) append(parts.moss, buildRock(p.s, { blobs: [2, 3], squash: 0.35, lump: 0.12, facet: 0.1, moss: 2, cell: 0.12 }, rng(p.seed), p.off, [1, 1.6, 2.6][li]).moss);
    });
  }
  return lods;
}

// ---------- Lövhög: låg kupol av höstlöv (trädgeneratorns krona utan träd) ----------
function leafpileLods() {
  const R = sp.radius, H = sp.height;
  const twigs = Array.from({ length: 160 }, () => {
    const a = r() * 6.28, d = R * Math.sqrt(r());
    return [Math.cos(a) * d, H * 0.55 * (1 - (d / R) ** 2) + 0.02, Math.sin(a) * d];
  });
  const crown = buildCrown(twigs, {
    mode: 'dome', clumps: sp.clumps, puffR: 0.55, fill: 1.0, flattenY: 0.45, domeBottom: -0.2, puffs: 1, puffScale: 0.5, puffOut: 0.8, puff: 0.7,
    union: 0.15, cell: 0.09, cards: sp.cards, cardSize: 0.2, stickOut: 0.15, normalBlend: 0.85, undersideWeight: 0.6, lump: 0.08, coverR: 0.9,
    seed, height: H,
  });
  // Ställ högen på marken
  let minY = Infinity;
  for (const lod of crown.lods) for (const g of [lod, lod.volume]) for (let i = 1; i < g.positions.length; i += 3) minY = Math.min(minY, g.positions[i]);
  return crown.lods.map((lod) => {
    for (const g of [lod, lod.volume]) for (let i = 1; i < g.positions.length; i += 3) g.positions[i] -= minY + H * 0.08;
    return { leaves: lod, mass: lod.volume };
  });
}

// ---------- Krypväxt: rankor som slingrar längs marken, med solida blad ----------
function creeperLods() {
  const vines = Array.from({ length: pick(sp.vines) }, () => {
    const L = between(sp.length), step = 0.05, n = Math.ceil(L / step);
    let a = r() * 6.28, p = [(r() - 0.5) * 0.15, 0.02, (r() - 0.5) * 0.15];
    const nodes = [{ p, r: 0.009 }];
    for (let i = 1; i <= n; i++) {
      a += (r() - 0.5) * 0.7;
      p = add(p, [Math.cos(a) * step, 0, Math.sin(a) * step]);
      p[1] = 0.015 + 0.012 * Math.abs(Math.sin(i * 0.9 + a));
      nodes.push({ p, r: 0.009 * (1 - 0.6 * i / n) });
    }
    return { level: 1, nodes, segments: 4, phase: 0, length: L };
  });
  const tint = lin(sp.tint);
  const pal = { dark: tint.map((x) => x * 0.42), mid: tint.map((x) => x * 0.75), light: tint.map((x) => Math.min(1, x * 1.1 + 0.03)) };
  const leaves = [];
  for (const v of vines) {
    const every = Math.max(1, Math.round(sp.leafEvery / 0.05));
    v.nodes.forEach((nd, i) => {
      if (i === 0 || i % every) return;
      const fwd = norm(sub(nd.p, v.nodes[i - 1].p));
      const side = norm(cross(UP, fwd));
      const s = (i / every) % 2 ? 1 : -1;
      // Bladen ligger nästan plant mot marken, lite framåt längs rankan
      const axis = norm(add(add(mul(side, s * 0.8), mul(UP, 0.18)), mul(fwd, 0.45)));
      const len = sp.leafLen * (0.7 + r() * 0.5) * (1 - 0.35 * i / v.nodes.length);
      const shade = clamp01(0.35 + r() * 0.5);
      const col = shade < 0.5 ? lerp(pal.dark, pal.mid, shade * 2) : lerp(pal.mid, pal.light, (shade - 0.5) * 2);
      leaves.push({ base: nd.p, axis, side: norm(cross(axis, UP).every((x) => Math.abs(x) < 1e-6) ? [1, 0, 0] : cross(axis, UP)), len, col, prio: r() });
    });
  }
  const vineC = lin(sp.vine);
  return [[1, 1], [0.6, 0.7], [0.35, 0.5]].map(([keep, segScale]) => {
    const g = { ...empty(), cluster: [] };
    leaves.forEach((l, id) => { if (l.prio < keep) pushLeaf(g, l.base, l.axis, l.side, l.len, l.len * 0.65, 0.25, sp.leafShape, l.col, id, 0.5, UP); });
    const stems = barkMesh({ branches: vines }, { maxLevel: 9, segScale, barkRepeat: 0.3, height: 1 });
    for (let i = 0; i < stems.colors.length; i += 3) stems.colors.splice(i, 3, ...vineC);
    return { leaves: g, vines: stems };
  });
}

// Vindningsordning: framsidan ska följa vertexnormalerna. Svarvade former och sammanslagna delar kan
// hamna åt fel håll, så jämför trianglarnas normal med vertexnormalerna och vänd vid behov
function orient(g) {
  const P = (k) => [g.positions[k * 3], g.positions[k * 3 + 1], g.positions[k * 3 + 2]];
  const N = (k) => [g.normals[k * 3], g.normals[k * 3 + 1], g.normals[k * 3 + 2]];
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
    const fn = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    if (dot(fn, add(add(N(a), N(b)), N(c))) < 0) { g.indices[i + 1] = c; g.indices[i + 2] = b; }
  }
}

// ---------- GLB ----------
const build = { rock: rockLods, mushroom: mushroomLods, stump: stumpLods, leafpile: leafpileLods, creeper: creeperLods }[sp.kind];
const lods = build();
const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const tex = (file, nm) => doc.createTexture(nm).setImage(new Uint8Array(fs.readFileSync(file))).setMimeType('image/png');
function material(nm, { texture, tint, alpha, rough = 0.9 } = {}) {
  const m = doc.createMaterial(nm).setRoughnessFactor(rough).setMetallicFactor(0);
  if (texture && fs.existsSync(texture)) m.setBaseColorTexture(tex(texture, nm));
  if (tint) m.setBaseColorFactor([...lin(tint), 1]);
  if (alpha) m.setAlphaMode('MASK').setAlphaCutoff(0.45);
  return m;
}
// Material per del; texturerna kommer från make_prop.py (gråskala när de tintas)
const T = textures;
const MATS = {
  stone: () => material('Stone', { texture: T.stone, tint: recipe.stoneTint }),
  moss: () => material('Moss', { texture: T.moss, tint: recipe.mossTint }),
  cap: () => material('Cap', { texture: T.cap, tint: sp.capTint, rough: 0.6 }),
  gills: () => material('Gills', { rough: 0.9 }),
  stem: () => material('Stem', { rough: 0.85 }),
  bark: () => material('Bark', { texture: T.bark }),
  leaves: () => material('Leaves', { texture: T.leaves, tint: sp.kind === 'leafpile' ? sp.tint : undefined, alpha: sp.kind === 'leafpile' }),
  mass: () => material('LeafMass', { texture: T.mass, tint: sp.tint }),
  vines: () => material('Vines', { rough: 0.9 }),
};
const matCache = {};
const getMat = (part) => (matCache[part] ??= (part === 'cap' && sp.kind === 'stump' ? material('Rings', { texture: T.rings, rough: 0.8 }) : MATS[part]()));
const name = recipe.name ?? path.basename(out, '.glb');
const root = doc.createNode(name).setExtras({ generator: 'tinkertown/prop@1', recipe: { preset, seed } });
const tris = [];
let minY = Infinity;
lods.forEach((parts, i) => {
  const lodNode = doc.createNode(`${name}_LOD${i}`).setExtras({ lod: i });
  let t = 0;
  for (const [part, g] of Object.entries(parts)) {
    if (!g || !g.indices?.length) continue;
    orient(g);
    const nV = g.positions.length / 3;
    const fill = (k, n, v) => { if ((g[k]?.length ?? 0) < nV * n) g[k] = Array.from({ length: nV * n }, (_, j) => (g[k]?.[j] ?? v)); };
    fill('colors', 3, 1); fill('wind', 1, 0); fill('uvs', 2, 0);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', Float32Array.from(g.positions)))
      .setAttribute('NORMAL', acc('VEC3', Float32Array.from(g.normals)))
      .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(g.uvs)))
      .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(g.colors)))
      .setAttribute('_WIND', acc('SCALAR', Float32Array.from(g.wind)))
      .setIndices(acc('SCALAR', Uint32Array.from(g.indices)))
      .setMaterial(getMat(part));
    lodNode.addChild(doc.createNode(`${name}_${part}_LOD${i}`).setMesh(doc.createMesh(`${part}_LOD${i}`).addPrimitive(prim)));
    t += g.indices.length / 3;
    if (i === 0) for (let k = 1; k < g.positions.length; k += 3) minY = Math.min(minY, g.positions[k]);
  }
  root.addChild(lodNode);
  tris.push(Math.round(t));
});
doc.createScene(name).addChild(root);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, await new NodeIO().writeBinary(doc));
const partsLod0 = Object.entries(lods[0]).filter(([, g]) => g?.indices?.length).map(([p]) => p);
// Kontroller: något genererades, och propen vilar i marken (lätt nedsänkt, inte svävande)
const checks = { parts: partsLod0, resting_on_ground: minY <= 0.02 && minY > -0.6 };
checks.ok = partsLod0.length > 0 && checks.resting_on_ground;
console.log(JSON.stringify({ glb: out, preset, kind: sp.kind, tris_lod: tris, checks }));
