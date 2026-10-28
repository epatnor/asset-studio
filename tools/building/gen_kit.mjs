// Byggsatsens generator (docs/building-kit.md): en modul, hela katalogen eller ett hus av moduler. Modulerna
// byggs av elementen (kit/elements.mjs) i kit/modules.mjs; ett hus är en lista med placeringar (modul, ändar,
// läge, vridning i steg om 90°) som räknas ut ur ett recept i kit.json. Kontrollerna prövar hur modulerna
// möts: sockets, inga överlapp mellan moduler, inga glipor i murar och tak, inga svävande stenar.
//   node gen_kit.mjs '{"module":"stone_window","ends":["end","end"],"seed":2,"out":"build/kit/x.gltf"}'
//   node gen_kit.mjs '{"catalog":true,"out_dir":"build/kit/catalog"}'
//   node gen_kit.mjs '{"assembly":"cottage","out":"build/kit/cottage.gltf"}'
import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { sharedTexture, writeGltf } from '../tree/gltf_write.mjs';
import { add, sub, cross, dot } from '../tree/vec.mjs';
import { createElements } from './kit/elements.mjs';
import { BUILDERS, lin, courses } from './kit/modules.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const K = JSON.parse(fs.readFileSync(new URL('./kit/kit.json', import.meta.url)));
const recipe = JSON.parse(process.argv[2] ?? '{}');
const fail = (msg) => { console.error(msg); process.exit(1); };
const TEX = {
  // sten och pannor: färgen är målad per sten i vertexfärgerna, texturen ger bara ytan (normalen)
  stone: [null, 'assets/textures/rock_stylized_normal.png'],
  tile: [null, 'assets/textures/rock_stylized_normal.png'],
  wood: ['assets/textures/surface_bld_fantasy_trim.png', 'assets/textures/surface_bld_fantasy_trim_normal.png'],
  plaster: ['assets/textures/surface_bld_fantasy_wall.png', 'assets/textures/surface_bld_fantasy_wall_normal.png'],
};

// ---------- En modul ----------
function buildModule(pl, lod) {
  const def = K.modules[pl.module];
  if (!def) fail(`unknown module ${pl.module}; available: ${Object.keys(K.modules).join(', ')}`);
  const E = createElements({ lod });
  const spec = { ...def, ...pl, ends: pl.ends ?? def.ends };
  const info = BUILDERS[pl.module](E, K, spec);
  if (lod === 0) countTris(E.G);
  return { G: E.G, reg: E.reg, info, def };
}
const countTris = (G) => Object.values(G).reduce((s, g) => s + g.indices.length / 3, 0);
const cache = new Map();
const keyOf = (pl) => JSON.stringify([pl.module, pl.ends, pl.seed, pl.run, pl.d0, pl.dir]);
function moduleCached(pl, lod) {
  const k = keyOf(pl) + lod;
  if (!cache.has(k)) cache.set(k, buildModule(pl, lod));
  return cache.get(k);
}

// ---------- Placering: läge + vridning runt y (steg om 90°) ----------
const rot = (yaw, [x, y, z]) => { const a = (yaw * Math.PI) / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a)); return [x * c + z * s, y, -x * s + z * c]; };
const unrot = (yaw, v) => rot(-yaw, v);
const toWorld = (pl, p) => add(pl.pos, rot(pl.yaw, p));
const toLocal = (pl, p) => unrot(pl.yaw, sub(p, pl.pos));
function worldBox(pl, lo, hi) {
  const a = toWorld(pl, lo), b = toWorld(pl, hi);
  return [[0, 1, 2].map((k) => Math.min(a[k], b[k])), [0, 1, 2].map((k) => Math.max(a[k], b[k]))];
}

// ---------- Byggnadsrecept → placeringar ----------
function expand(A) {
  const W = K.width, H = K.storey, [nx, nz] = A.footprint, Dx = nx * W, Dz = nz * W;
  const sides = [
    { name: 'front', start: [0, Dz], yaw: 0, n: nx }, { name: 'right', start: [Dx, Dz], yaw: 90, n: nz },
    { name: 'back', start: [Dx, 0], yaw: 180, n: nx }, { name: 'left', start: [0, 0], yaw: 270, n: nz },
  ];
  const dirOf = (yaw) => rot(yaw, [1, 0, 0]);
  const P = [];
  A.storeys.forEach((S, si) => {
    const y = si * H;
    sides.forEach((sd, k) => {
      const d = dirOf(sd.yaw);
      P.push({ module: `${S.family}_corner`, pos: [sd.start[0], y, sd.start[1]], yaw: sd.yaw, seed: si * 4 + k });
      S[sd.name].forEach((mod, i) => P.push({ module: mod, pos: [sd.start[0] + d[0] * W * i, y, sd.start[1] + d[2] * W * i], yaw: sd.yaw,
        ends: [i === 0 ? 'corner' : 'open', i === sd.n - 1 ? 'corner' : 'open'], seed: 1 + ((si * 5 + k * 3 + i) % 3), base: si ? 'storey' : 'ground', side: sd.name }));
    });
  });
  const Y = A.storeys.length * H, run = Dz / 2;
  for (let i = 0; i < nx; i++) {
    const ends = [i === 0 ? 'verge' : 'open', i === nx - 1 ? 'verge' : 'open'];
    P.push({ module: 'roof_slope', pos: [W * i, Y, Dz], yaw: 0, ends, seed: 1 + i, run });
    P.push({ module: 'roof_slope', pos: [Dx - W * i, Y, 0], yaw: 180, ends, seed: 3 + i, run });
    P.push({ module: 'roof_ridge', pos: [W * i, Y, run], yaw: 0, ends, seed: 1 + i, run });
  }
  for (const sd of [sides[1], sides[3]]) {
    const d = dirOf(sd.yaw);
    for (let i = 0; i < nz; i++) {
      const rise = i < nz / 2;
      P.push({ module: 'timber_gable', pos: [sd.start[0] + d[0] * W * i, Y, sd.start[1] + d[2] * W * i], yaw: sd.yaw, seed: 7 + i,
        ends: [i === 0 ? 'corner' : 'open', i === nz - 1 ? 'corner' : 'open'], d0: rise ? i * W : Dz - i * W, dir: rise ? 1 : -1 });
    }
  }
  return P;
}

// ---------- glTF ----------
async function write(lods, out, extras) {
  const doc = new Document(), emissiveExt = doc.createExtension(KHRMaterialsEmissiveStrength), buffer = doc.createBuffer();
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const mats = {};
  const getMat = (part) => {
    if (mats[part]) return mats[part];
    const [kind, hex] = part.split(':');
    let m;
    if (kind === 'glow') {
      m = doc.createMaterial('GlassGlow').setRoughnessFactor(0.3).setBaseColorFactor([...lin(hex), 1]).setEmissiveFactor(lin(hex));
      m.setExtension('KHR_materials_emissive_strength', emissiveExt.createEmissiveStrength().setEmissiveStrength(1.6));
    } else if (kind === 'glass') m = doc.createMaterial('Glass').setRoughnessFactor(0.12).setBaseColorFactor([...lin(hex), 1]);
    else {
      m = doc.createMaterial(kind[0].toUpperCase() + kind.slice(1)).setRoughnessFactor({ stone: 0.9, mortar: 0.95, wood: 0.8, plaster: 0.92, tile: 0.78, metal: 0.4 }[kind] ?? 0.85).setMetallicFactor(kind === 'metal' ? 1 : 0);
      const t = TEX[kind];
      if (t) {
        if (t[0]) m.setBaseColorTexture(sharedTexture(doc, path.join(ROOT, t[0]), `${kind}_color`, path.resolve(out)));
        m.setNormalTexture(sharedTexture(doc, path.join(ROOT, t[1]), `${kind}_normal`, path.resolve(out))).setNormalScale(0.8);
      }
    }
    return (mats[part] = m);
  };
  const name = extras.name;
  const root = doc.createNode(name).setExtras(extras);
  const tris = [];
  lods.forEach((G, i) => {
    const lodNode = doc.createNode(`${name}_LOD${i}`).setExtras({ lod: i });
    let t = 0;
    for (const [part, g] of Object.entries(G)) {
      if (!g.indices.length) continue;
      orient(g);
      const prim = doc.createPrimitive()
        .setAttribute('POSITION', acc('VEC3', Float32Array.from(g.positions)))
        .setAttribute('NORMAL', acc('VEC3', Float32Array.from(g.normals)))
        .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(g.uvs)))
        .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(g.colors.map((c) => Math.min(1, c)))))
        .setIndices(acc('SCALAR', Uint32Array.from(g.indices))).setMaterial(getMat(part));
      const pn = part.replace(':#', '_');
      lodNode.addChild(doc.createNode(`${name}_${pn}_LOD${i}`).setMesh(doc.createMesh(`${pn}_LOD${i}`).addPrimitive(prim)));
      t += g.indices.length / 3;
    }
    root.addChild(lodNode);
    tris.push(Math.round(t));
  });
  doc.createScene(name).addChild(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await writeGltf(doc, out);
  return tris;
}
// Trianglarna vänds efter normalerna (som i gen_house.mjs)
function orient(g) {
  const P = (k) => [g.positions[k * 3], g.positions[k * 3 + 1], g.positions[k * 3 + 2]], N = (k) => [g.normals[k * 3], g.normals[k * 3 + 1], g.normals[k * 3 + 2]];
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
    if (dot(cross(sub(P(b), P(a)), sub(P(c), P(a))), add(add(N(a), N(b)), N(c))) < 0) { g.indices[i + 1] = c; g.indices[i + 2] = b; }
  }
}
// Slå ihop modulernas geometri i världen, en per material
function merge(placements, lod) {
  const out = {};
  for (const pl of placements) {
    const { G } = moduleCached(pl, lod);
    for (const [part, g] of Object.entries(G)) {
      const o = (out[part] ??= { positions: [], normals: [], uvs: [], colors: [], wind: [], indices: [] }), base = o.positions.length / 3;
      for (let i = 0; i < g.positions.length; i += 3) {
        o.positions.push(...toWorld(pl, [g.positions[i], g.positions[i + 1], g.positions[i + 2]]));
        o.normals.push(...rot(pl.yaw, [g.normals[i], g.normals[i + 1], g.normals[i + 2]]));
      }
      o.uvs.push(...g.uvs); o.colors.push(...g.colors);
      for (const k of g.indices) o.indices.push(base + k);
    }
  }
  return out;
}
// Ett kort id för bilderna och svaret
const shortId = (pl) => pl.name ?? `${pl.module}${pl.ends ? '_' + pl.ends.join('-') : ''}${pl.seed != null ? '_s' + pl.seed : ''}`;

// ---------- Kontroller ----------
function checkAssembly(P) {
  const mods = P.map((pl) => ({ pl, m: moduleCached(pl, 0) }));
  const pairs = K.sockets.pairs, terminal = new Set(K.sockets.terminal);
  const compatible = (a, b) => pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  // 1. Sockets: varje socket har en partner av rätt typ på samma plats, vänd mot den
  const S = [];
  mods.forEach(({ pl, m }, i) => (m.info.sockets ?? []).forEach((s) => s.type && S.push({ i, type: s.type, pos: toWorld(pl, s.pos), dir: rot(pl.yaw, s.dir) })));
  const unpaired = [];
  for (const s of S) {
    if (terminal.has(s.type)) continue;
    const hit = S.find((o) => o.i !== s.i && Math.hypot(...sub(o.pos, s.pos)) < 1e-3 && dot(o.dir, s.dir) < -0.99 && compatible(o.type, s.type));
    if (!hit) unpaired.push(`${shortId(P[s.i])}:${s.type}@${s.pos.map((v) => +v.toFixed(2))}`);
  }
  // 2. Överlapp: exakta element (stenar, kärna, stolpar, syllar, puts) från olika moduler går inte in i varandra
  const boxes = [];
  mods.forEach(({ pl, m }, i) => m.reg.filter((e) => e.exact).forEach((e) => { const [lo, hi] = worldBox(pl, e.lo, e.hi); boxes.push({ i, kind: e.kind, lo, hi }); }));
  let overlaps = 0;
  const overlapList = [];
  const sh = 0.004;
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
    const A = boxes[a], B = boxes[b];
    if (A.i === B.i) continue;
    let vol = 1;
    for (let k = 0; k < 3; k++) vol *= Math.max(0, Math.min(A.hi[k], B.hi[k]) - Math.max(A.lo[k], B.lo[k]) - 2 * sh);
    if (vol > 1e-6) { overlaps++; if (overlapList.length < 6) overlapList.push(`${shortId(P[A.i])}/${A.kind} × ${shortId(P[B.i])}/${B.kind}`); }
  }
  // 3. Glipor i väggarna: prov 6 cm in i varje vägg (utom i öppningarna) ska ligga i något element
  const solidAt = (w) => {
    for (const { pl, m } of mods) {
      const p = toLocal(pl, w);
      for (const e of m.reg) {
        if (!(e.exact || e.prism)) continue;
        if (p[0] < e.lo[0] || p[0] > e.hi[0] || p[1] < e.lo[1] || p[1] > e.hi[1] || p[2] < e.lo[2] || p[2] > e.hi[2]) continue;
        if (!e.prism) return true;
        const pts = e.prism.pts;
        let inside = true;
        for (let k = 0; k < pts.length; k++) { const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % pts.length]; if ((x1 - x0) * (p[1] - y0) - (y1 - y0) * (p[0] - x0) < -1e-9) { inside = false; break; } }
        if (inside) return true;
      }
    }
    return false;
  };
  let wallGaps = 0, wallSamples = 0;
  const gapList = [];
  for (const { pl, m } of mods) {
    const kind = m.def.kind;
    if (kind !== 'wall' && kind !== 'gable') continue;
    const op = m.def.opening ? K.openings[m.def.opening] : null;
    const ox0 = op ? K.width / 2 - op.width / 2 : 0, ox1 = op ? K.width / 2 + op.width / 2 : 0;
    const oy0 = m.info.opening?.y0 ?? op?.sill, oy1 = m.info.opening?.y1 ?? op?.top;
    const tn = Math.tan((K.families.roof.pitch * Math.PI) / 180);
    // proven börjar 6 cm från ändarna: närmare än så ligger fogarna i hörnet, som är indragna från den andra ytan
    for (let x = 0.06; x < K.width - 0.04; x += 0.05) for (let y = 0.03; y < K.storey; y += 0.05) {
      if (op && x > ox0 - 0.01 && x < ox1 + 0.01 && y > oy0 - 0.01 && y < oy1 + 0.01) continue;
      if (kind === 'gable' && y > (pl.d0 + pl.dir * x) * tn - 0.3) continue;
      wallSamples++;
      if (!solidAt(toWorld(pl, [x, y, -0.06]))) { wallGaps++; if (gapList.length < 6) gapList.push(`${shortId(pl)}@${x.toFixed(2)},${y.toFixed(2)}`); }
    }
  }
  // 4. Glipor i taket: varje punkt på takfallen ligger under en takpanna (prov i planet, alla moduler)
  const tileQuads = [];
  for (const { pl, m } of mods) for (const C of m.info.tiles ?? []) tileQuads.push([C[2], C[3], C[7], C[6]].map((p) => toWorld(pl, p)));
  const inQuad = (q, x, z) => { let s = 0; for (let k = 0; k < 4; k++) { const [x0, , z0] = q[k], [x1, , z1] = q[(k + 1) % 4], c = (x1 - x0) * (z - z0) - (z1 - z0) * (x - x0); if (c !== 0) { if (s && Math.sign(c) !== s) return false; s = Math.sign(c); } } return true; };
  let roofGaps = 0, roofSamples = 0;
  for (const { pl, m } of mods) {
    if (m.def.kind !== 'slope') continue;
    const Rf = K.families.roof, run = m.info.run;
    for (let x = 0.02; x < K.width; x += 0.06) for (let z = Rf.overhang - 0.03; z > -run + 0.25; z -= 0.06) {
      roofSamples++;
      const w = toWorld(pl, [x, 0, z]);
      if (!tileQuads.some((q) => inQuad(q, w[0], w[2]))) roofGaps++;
    }
  }
  // 5. Svävande stenar: under varje sten (utom valvstenar och mark) finns en sten
  const stones = boxes.filter((b) => ['stone', 'quoin', 'sill'].includes(b.kind));
  const support = boxes.filter((b) => ['stone', 'quoin', 'sill', 'voussoir'].includes(b.kind));
  let floating = 0;
  for (const s of stones) {
    if (s.lo[1] < 0.02) continue;
    const y = s.lo[1] - 0.05, axis = s.hi[0] - s.lo[0] > s.hi[2] - s.lo[2] ? 0 : 2, other = 2 - axis, mid = (s.lo[other] + s.hi[other]) / 2;
    let ok = false;
    for (let f = 0.1; f < 0.95 && !ok; f += 0.2) {
      const p = [0, y, 0]; p[axis] = s.lo[axis] + (s.hi[axis] - s.lo[axis]) * f; p[other] = mid;
      ok = support.some((b) => b !== s && p[0] >= b.lo[0] && p[0] <= b.hi[0] && p[1] >= b.lo[1] && p[1] <= b.hi[1] + 0.06 && p[2] >= b.lo[2] && p[2] <= b.hi[2]);
    }
    if (!ok) floating++;
  }
  const C0 = JSON.stringify(courses(K.families.stone, K.storey));
  const coursesMatch = mods.filter(({ m }) => m.info.courses).every(({ m }) => JSON.stringify(m.info.courses) === C0);
  return {
    sockets: S.length, unpaired: unpaired.length, ...(unpaired.length ? { unpaired_list: unpaired.slice(0, 6) } : {}),
    overlaps, ...(overlaps ? { overlap_list: overlapList } : {}),
    wall_gaps: wallGaps, wall_samples: wallSamples, ...(wallGaps ? { gap_list: gapList } : {}),
    roof_gaps: roofGaps, roof_samples: roofSamples, floating_stones: floating, courses_match: coursesMatch,
  };
}

// ---------- Körning ----------
const budget = { wall: 14000, corner: 3000, gable: 3000, slope: 6000, ridge: 2000 };
async function writeModule(pl, out) {
  const lods = [0, 1, 2].map((l) => moduleCached(pl, l).G);
  const m = moduleCached(pl, 0);
  const tris = await write(lods, out, { name: path.basename(out, '.gltf'), generator: 'asset-studio/kit@1', module: pl.module, ends: pl.ends ?? m.def.ends, seed: pl.seed, sockets: m.info.sockets });
  const stones = m.reg.filter((e) => ['stone', 'quoin', 'voussoir', 'sill'].includes(e.kind)).length;
  const checks = { lods_decrease: tris[0] > tris[1] && tris[1] > tris[2], within_budget: tris[0] <= (budget[m.def.kind] ?? 10000), sockets: (m.info.sockets ?? []).length };
  checks.ok = checks.lods_decrease && checks.within_budget;
  return { model: path.relative(ROOT, out), module: pl.module, ends: pl.ends ?? m.def.ends, tris_lod: tris, elements: m.reg.length, stones, checks };
}

if (recipe.module) {
  if (!recipe.out) fail('out is required');
  console.log(JSON.stringify(await writeModule(recipe, recipe.out)));
} else if (recipe.catalog) {
  const dir = recipe.out_dir ?? 'build/kit/catalog', res = [];
  for (const pl of K.catalog) res.push(await writeModule(pl, path.join(dir, `${shortId(pl)}.gltf`)));
  console.log(JSON.stringify({ catalog: res, ok: res.every((r) => r.checks.ok) }));
} else if (recipe.assembly) {
  const A = K.assemblies[recipe.assembly];
  if (!A) fail(`unknown assembly ${recipe.assembly}; available: ${Object.keys(K.assemblies).join(', ')}`);
  if (!recipe.out) fail('out is required');
  // färdiga placeringar (handbyggt) eller ett recept som räknas ut
  const P = A.placements ? A.placements.map((pl) => ({ ...pl })) : expand(A), t0 = Date.now();
  const lods = [0, 1, 2].map((l) => merge(P, l));
  const placements = P.map((pl) => ({ module: pl.module, ends: pl.ends, seed: pl.seed, pos: pl.pos.map((v) => +v.toFixed(3)), yaw: pl.yaw, ...(pl.run ? { run: pl.run } : {}), ...(pl.d0 != null ? { d0: pl.d0, dir: pl.dir } : {}) }));
  const tris = await write(lods, recipe.out, { name: recipe.name ?? recipe.assembly, generator: 'asset-studio/kit@1', assembly: recipe.assembly, placements });
  const checks = checkAssembly(P);
  const variants = new Set(P.map(keyOf)).size;
  checks.lods_decrease = tris[0] > tris[1] && tris[1] > tris[2];
  checks.ok = !checks.unpaired && !checks.overlaps && !checks.wall_gaps && !checks.roof_gaps && !checks.floating_stones && checks.courses_match && checks.lods_decrease;
  console.log(JSON.stringify({ model: recipe.out, assembly: recipe.assembly, modules: P.length, unique_modules: variants, tris_lod: tris, ms: Date.now() - t0, checks }));
} else fail('give module, catalog or assembly');
