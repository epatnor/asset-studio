// Propsgenerator: naturprops för skog, stig och fält (stenar, bumlingar, mossa, svampar, stubbar,
// lövhögar, krypväxter). Fristående från trädgeneratorn men återanvänder dess byggstenar
// (avståndsfält + surface nets, barkrör, solida blad). Recept in, GLB ut, en rad JSON som svar.
// Användning: node gen_prop.mjs '{"preset":"mossy_boulder","seed":3,"out":"x.gltf","textures":{...}}'
import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { sharedTexture, writeGltf } from '../tree/gltf_write.mjs';
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
  const cut = -size * 0.35; // stenen fortsätter en bra bit ner, så att den inte avslöjar sin botten i en sluttning
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

// ---------- Low poly-sten: polygonernas kanter är stenens kanter (Patriks idé). Stenen är det konvexa höljet av ett
// tiotal punkter på en tillplattad ellipsoid med platt botten; trianglar i samma plan slås ihop till en yta, och varje
// yta får en smal nött kant längs sina gränser: ljusare, med normaler som lutar mot grannytorna, så att kanten läser som
// en fas utan extra geometri. Ett hundratal trianglar per sten. ----------
function convexHull(P) {
  const eps = 1e-7, n = P.length;
  const nrm = (f) => norm(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]])));
  // Starttetraeder ur fyra punkter som inte ligger i samma plan
  let i0 = 0, i1 = 1;
  for (let i = 1; i < n; i++) if (Math.hypot(...sub(P[i], P[i0])) > Math.hypot(...sub(P[i1], P[i0]))) i1 = i;
  let i2 = -1, best = 0;
  for (let i = 0; i < n; i++) { const a = Math.hypot(...cross(sub(P[i1], P[i0]), sub(P[i], P[i0]))); if (a > best) { best = a; i2 = i; } }
  let i3 = -1; best = 0;
  const n0 = norm(cross(sub(P[i1], P[i0]), sub(P[i2], P[i0])));
  for (let i = 0; i < n; i++) { const d = Math.abs(dot(n0, sub(P[i], P[i0]))); if (d > best) { best = d; i3 = i; } }
  const inner = mul(add(add(P[i0], P[i1]), add(P[i2], P[i3])), 0.25);
  const out = (f) => (dot(nrm(f), sub(P[f[0]], inner)) < 0 ? [f[0], f[2], f[1]] : f);
  let faces = [[i0, i1, i2], [i0, i1, i3], [i0, i2, i3], [i1, i2, i3]].map(out);
  for (let p = 0; p < n; p++) {
    if ([i0, i1, i2, i3].includes(p)) continue;
    const vis = faces.filter((f) => dot(nrm(f), sub(P[p], P[f[0]])) > eps);
    if (!vis.length) continue;
    const edges = new Set(vis.flatMap((f) => [`${f[0]},${f[1]}`, `${f[1]},${f[2]}`, `${f[2]},${f[0]}`]));
    const horizon = [...edges].map((e) => e.split(',').map(Number)).filter(([a, b]) => !edges.has(`${b},${a}`));
    faces = faces.filter((f) => !vis.includes(f)).concat(horizon.map(([a, b]) => [a, b, p]));
  }
  return faces.map((f) => ({ f, n: nrm(f) }));
}

// En bumling kan vara flera block som går in i varandra (chunks), de mindre lutade mot det största
function buildLowpolyRock(size, o, rr, offset = [0, 0, 0]) {
  const n = Math.round((o.chunks ?? [1, 1])[0] + ((o.chunks ?? [1, 1])[1] - (o.chunks ?? [1, 1])[0]) * rr());
  const out = { stone: empty(), moss: empty() };
  for (let c = 0; c < n; c++) {
    const a = rr() * 6.283, s = c ? size * (0.45 + rr() * 0.25) : size;
    const off = c ? add(offset, [Math.cos(a) * size * 0.38, 0, Math.sin(a) * size * 0.38]) : offset;
    const g = lowpolyChunk(s, o, rr, off);
    append(out.stone, g.stone); append(out.moss, g.moss);
  }
  return out;
}

function lowpolyChunk(size, o, rr, offset) {
  const pickR = ([a, b]) => Math.round(a + (b - a) * rr());
  const sq = (Array.isArray(o.squash) ? o.squash[0] + (o.squash[1] - o.squash[0]) * rr() : o.squash ?? 0.7) * (o.tall ?? 1);
  const R = [size * 0.5 * (0.85 + rr() * 0.3), size * 0.5 * sq, size * 0.5 * (0.85 + rr() * 0.3)];
  const cut = -R[1] * 0.25; // stenen sjunker en bit ner i marken
  const P = [];
  if (o.prism) {
    // Basaltpelare: n hörn nere och uppe, toppen lite sned
    const rot = rr() * 6.283, tilt = [(rr() - 0.5) * 0.25, (rr() - 0.5) * 0.25], h = R[1] * 2;
    for (let i = 0; i < o.prism; i++) {
      const a = rot + (i / o.prism) * 6.283, x = Math.cos(a) * R[0], z = Math.sin(a) * R[0];
      P.push([x, cut, z], [x, h + x * tilt[0] + z * tilt[1], z]);
    }
  } else {
    // Punkter jämnt runt ellipsoiden (gyllene spiral) med lite slump, under marken plattade till botten
    const N = pickR(o.points ?? [10, 14]);
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N, rad = Math.sqrt(1 - y * y), th = i * 2.39996 + rr() * 1.2, k = 0.72 + rr() * 0.34;
      P.push([Math.cos(th) * rad * R[0] * k, Math.max(cut, y * R[1] * k + R[1] * 0.15), Math.sin(th) * rad * R[2] * k]);
    }
    if (rr() < (o.flatTop ?? 0.4)) { const t = R[1] * 0.95, w = 0.45; for (let j = 0; j < 3; j++) { const a = rr() * 6.283; P.push([Math.cos(a) * R[0] * w, t, Math.sin(a) * R[2] * w]); } }
    for (let j = 0; j < 4; j++) { const a = j * 1.571 + rr() * 0.8; P.push([Math.cos(a) * R[0] * 0.9, cut, Math.sin(a) * R[2] * 0.9]); } // platt botten
  }
  const tris = convexHull(P);
  // Ytor: grannar som nästan ligger i samma plan (inom ~15° från ytans första triangel) blir en yta, så att den nötta
  // kanten bara hamnar på riktiga brytkanter och inte som kryss över flata sidor
  const byEdge = new Map();
  tris.forEach((t, i) => { for (let k = 0; k < 3; k++) byEdge.set(`${t.f[k]},${t.f[(k + 1) % 3]}`, i); });
  const groupOf = new Array(tris.length).fill(-1), groups = [];
  const same = Math.cos((o.merge ?? 15) * Math.PI / 180);
  tris.forEach((t0, i0) => {
    if (groupOf[i0] >= 0) return;
    const g = { n0: t0.n, tris: [] }, queue = [i0];
    groupOf[i0] = groups.length;
    while (queue.length) {
      const i = queue.pop(), t = tris[i];
      g.tris.push(t.f);
      for (let k = 0; k < 3; k++) {
        const j = byEdge.get(`${t.f[(k + 1) % 3]},${t.f[k]}`);
        if (j !== undefined && groupOf[j] < 0 && dot(tris[j].n, g.n0) > same) { groupOf[j] = groups.length; queue.push(j); }
      }
    }
    // Ytans normal: medel av trianglarnas (ytan är bara nästan plan)
    const ids = [...groupOf.keys()].filter((i) => groupOf[i] === groups.length);
    g.n = norm(ids.reduce((a, i) => add(a, tris[i].n), [0, 0, 0]));
    groups.push(g);
  });
  // Hörnens normaler (medel av ytorna runt dem) ger den nötta kanten sin fas
  const vn = P.map(() => [0, 0, 0]);
  for (const g of groups) for (const f of g.tris) for (const v of new Set(f)) vn[v] = add(vn[v], g.n);
  const stone = empty(), moss = empty();
  const S = 0.5 / Math.max(0.6, size * 0.9), wear = size * (o.bevel ?? 0.05), edgeTint = 1, faceTint = o.faceTint ?? 0.84; // texturen glest: stora lugna fält
  const push = (g, p, n, c) => {
    const ax = [0, 1, 2].reduce((m, x) => (Math.abs(n[x]) > Math.abs(n[m]) ? x : m), 0);
    const [u1, u2] = ax === 0 ? [2, 1] : ax === 1 ? [0, 2] : [0, 1];
    const q = add(p, offset), ao = 0.7 + 0.3 * clamp01((p[1] - cut) / (R[1] * 1.2));
    g.positions.push(...q); g.normals.push(...n); g.uvs.push(q[u1] * S, -q[u2] * S); g.colors.push(c * ao, c * ao, c * ao); g.wind.push(0);
    return g.positions.length / 3 - 1;
  };
  for (const g of groups) {
    if (g.n[1] < -0.9) continue; // botten syns aldrig
    const edges = new Map();
    for (const f of g.tris) for (let k = 0; k < 3; k++) { const a = f[k], b = f[(k + 1) % 3]; const key = `${b},${a}`; if (edges.has(key)) edges.delete(key); else edges.set(`${a},${b}`, [a, b]); }
    // Gränsen som en ordnad slinga
    const next = new Map([...edges.values()].map(([a, b]) => [a, b]));
    const loop = [next.keys().next().value];
    while (loop.length < next.size && next.get(loop.at(-1)) !== loop[0]) loop.push(next.get(loop.at(-1)));
    const c = mul(loop.reduce((s, v) => add(s, P[v]), [0, 0, 0]), 1 / loop.length);
    const isMoss = o.moss > 0 && !o.unified && g.n[1] > 1 - o.moss * 1.25;
    const G = isMoss ? moss : stone;
    // Inre slinga: varje hörn flyttas mot mitten så att kanten blir ungefär wear bred (varierar lite: nött, inte fräst)
    const inner = loop.map((v) => { const d = sub(c, P[v]), l = Math.hypot(...d); return add(P[v], mul(d, Math.min(0.45, (wear * (0.7 + rr() * 0.6)) / Math.max(l, 1e-6)))); });
    const ic = push(G, c, g.n, faceTint);
    const ii = inner.map((p) => push(G, p, g.n, faceTint));
    const oo = loop.map((v) => push(G, P[v], norm(add(mul(norm(vn[v]), 0.65), mul(g.n, 0.35))), edgeTint));
    for (let k = 0; k < loop.length; k++) {
      const k2 = (k + 1) % loop.length;
      G.indices.push(ic, ii[k], ii[k2]);
      G.indices.push(ii[k], oo[k], oo[k2], ii[k], oo[k2], ii[k2]);
    }
  }
  return { stone, moss };
}

function buildRock(size, o, rr, offset = [0, 0, 0], cellScale = 1) {
  if (o.shape === 'lowpoly') return buildLowpolyRock(size, o, rr, offset);
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
    // unified: allt blir sten och klienten lägger mossan i shadern (mjuk kant, se showcase/materials.js)
    const isMoss = !o.unified && o.moss > 0 && qn[1] + mossNoise(mid) * 0.18 > 1 - o.moss * 1.25;
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
  // Basaltpelare står tätt i ett sexkantsmönster (närmast mitten först); andra stenar strös inom spread
  const hex = sp.prism ? (() => {
    const w = (Array.isArray(sp.size) ? sp.size[1] : sp.size) * 0.92 * (sp.scale ?? 1), cells = [];
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) cells.push([(i + j * 0.5) * w, j * w * 0.866]);
    return cells.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) + (r() - 0.5) * w * 0.3);
  })() : null;
  const placements = Array.from({ length: n }, (_, i) => {
    const s = (Array.isArray(sp.size) ? between(sp.size) : sp.size * (n > 1 ? 0.6 + r() * 0.6 : 1)) * (sp.scale ?? 1);
    const a = r() * Math.PI * 2, d = n > 1 ? (sp.spread ?? 1) * Math.sqrt(r()) : 0;
    const off = hex ? [hex[i][0], 0, hex[i][1]] : [Math.cos(a) * d, 0, Math.sin(a) * d];
    return { s, off, seed: Math.floor(r() * 2 ** 31) };
  });
  return [1, 1.6, 2.6].map((cs) => {
    const parts = { stone: empty(), moss: empty() };
    for (const pl of placements) {
      const g = buildRock(pl.s, { ...sp, unified: true }, rng(pl.seed), pl.off, cs);
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
      // Foten börjar en bit under marken, så att svampen inte svävar i en sluttning
      const stemP = Array.from({ length: 7 }, (_, i) => { const t = i / 6; return [rs * (1 + (sp.bulb - 1) * Math.min(1, (1 - t) * 1.2) ** 2), -m.hs - 0.04 + (m.hs + 0.04) * t]; });
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
      height: H, lobes: sp.lobes, lobeAmp: sp.lobeAmp, twist: 0.4, bulge: 0.03, flatTop: true, sinkDepth: 0.35 });
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

// ---------- Stock: en liggande stam, byggd som två halvor av stubbens barkrör ut från mitten ----------
// Varje halva slutar i en snittyta med årsringar. Stocken ligger med ungefär en fjärdedel i marken.
function logLods() {
  const L = sp.length, R0 = sp.radius, y0 = R0 * 0.72, bend = (r() - 0.5) * 0.15 * L, ph = r() * 6.28;
  const half = (dir) => {
    const nodes = Array.from({ length: 10 }, (_, i) => {
      const t = i / 9, x = dir * (t * L * 0.5 - 0.02);
      return { p: [x, y0 + Math.sin(t * 3.1) * R0 * 0.08, bend * (1 - (2 * x / L) ** 2)], r: R0 * (1 - (dir > 0 ? 0.18 : 0.06) * t) };
    });
    return { branches: [{ level: 0, nodes, segments: 14, phase: ph }] };
  };
  const halves = [half(1), half(-1)];
  const lods = [1, 0.7, 0.5].map((segScale) => {
    const parts = { bark: empty(), cap: empty() };
    for (const sk of halves) {
      const g = barkMesh(sk, { maxLevel: 0, segScale, barkRepeat: 0.6, flare: 0, roots: 0, rootAmp: 0, flareHeight: 0.1,
        height: L, lobes: sp.lobes, lobeAmp: sp.lobeAmp, twist: 0.2, bulge: 0.03, flatTop: true, sinkDepth: 0 });
      append(parts.bark, { ...g, cap: undefined });
      if (g.cap) append(parts.cap, g.cap);
    }
    return parts;
  });
  if (sp.moss) { // mosskuddar längs ovansidan
    const pads = Array.from({ length: 5 }, () => ({ off: [(r() - 0.5) * L * 0.8, y0 + R0 * 0.75, (r() - 0.5) * R0 * 0.6], s: R0 * (0.5 + r() * 0.4), seed: Math.floor(r() * 2 ** 31) }));
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
  // Ställ högen på marken, varje LOD för sig (större kort i lägre LOD når längre ner)
  return crown.lods.map((lod) => {
    let minY = Infinity;
    for (const g of [lod, lod.volume]) for (let i = 1; i < g.positions.length; i += 3) minY = Math.min(minY, g.positions[i]);
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


// Vindkontinuitet: hörn i samma punkt måste ha samma vindvikt, annars slits geometrin isär i vinden
function windTorn(g) {
  const seen = new Map(); let torn = 0;
  for (let i = 0; i < g.positions.length / 3; i++) {
    const key = `${Math.round(g.positions[i * 3] * 1e4)},${Math.round(g.positions[i * 3 + 1] * 1e4)},${Math.round(g.positions[i * 3 + 2] * 1e4)}`;
    const w = g.wind[i] ?? 0;
    if (seen.has(key)) { if (Math.abs(seen.get(key) - w) > 1e-4) torn++; } else seen.set(key, w);
  }
  return torn;
}
let WIND_TORN = 0;

// ---------- GLB ----------
const build = { rock: rockLods, mushroom: mushroomLods, stump: stumpLods, log: logLods, leafpile: leafpileLods, creeper: creeperLods }[sp.kind];
const lods = build();
const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
// Texturer refereras till delade filer (bäddas inte in), se tools/tree/gltf_write.mjs
const tex = (file, nm) => sharedTexture(doc, file, nm, out);
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
  stone: () => {
    const m = material('Stone', { texture: T.stone, tint: recipe.stoneTint });
    if (sp.kind !== 'rock') return m;
    // Triplanar sten och mossa i världskoordinater i klienten; mängd, textur och skala som extras
    const mossFile = T.moss && (fs.existsSync(T.moss.replace(/\.png$/, '.webp')) ? T.moss.replace(/\.png$/, '.webp') : T.moss);
    const size = Array.isArray(sp.size) ? (sp.size[0] + sp.size[1]) / 2 : sp.size;
    return m.setExtras({ triplanar: true, moss: sp.moss ?? 0, mossTint: recipe.mossTint ?? null, stoneScale: 1 / Math.max(0.6, size * 0.9), mossScale: sp.mossRepeat ?? 4,
      mossTexture: mossFile ? path.relative(path.dirname(out), mossFile).split(path.sep).join('/') : null });
  },
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
const getMat = (part) => (matCache[part] ??= (part === 'cap' && (sp.kind === 'stump' || sp.kind === 'log') ? material('Rings', { texture: T.rings, rough: 0.8 }) : MATS[part]()));
const name = recipe.name ?? path.basename(out, path.extname(out));
const root = doc.createNode(name).setExtras({ generator: 'tinkertown/prop@1', recipe: { preset, seed } });
const tris = [];
let minY = Infinity;
lods.forEach((parts, i) => {
  const lodNode = doc.createNode(`${name}_LOD${i}`).setExtras({ lod: i });
  let t = 0;
  for (const [part, g] of Object.entries(parts)) {
    if (!g || !g.indices?.length) continue;
    orient(g);
    if (i === 0) WIND_TORN += windTorn(g);
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
await writeGltf(doc, out);
const partsLod0 = Object.entries(lods[0]).filter(([, g]) => g?.indices?.length).map(([p]) => p);
// Kontroller: något genererades, och propen vilar i marken (lätt nedsänkt, inte svävande)
// Vilar på marken: något når ner till marken (och går gärna ner under den), men den svävar inte
const checks = { parts: partsLod0, resting_on_ground: minY <= 0.02 && minY > -2.5 };
checks.wind_torn = WIND_TORN;
checks.ok = partsLod0.length > 0 && checks.resting_on_ground && WIND_TORN === 0;
console.log(JSON.stringify({ model: out, preset, kind: sp.kind, tris_lod: tris, checks }));
