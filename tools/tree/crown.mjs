// Lövkrona v4: underklumpar vid kvistarna smälts ihop till EN molnlik form (mjuk union av ellipsoider
// som avståndsfält), som görs till en ogenomskinlig mesh med surface nets. Ytan täcks tätt av små
// lövkort med normaler från samma fält, så kronan skuggas som en mjuk massa med tydliga löv i kanten.
// Ren JS utan Three.js/DOM.
import { add, sub, mul, dot, cross, norm, lerp, clamp01, rng, randomUnit, basis } from './vec.mjs';
import { clusterLeaves } from './canopy.mjs';

const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], cluster: [], indices: [] });

// Mjuk union (smooth min) av klumparna, med lite brus per klump så att formen blir knölig ("blomkål")
function crownField(clumps, k) {
  // Polynomisk smooth min (Inigo Quilez): blandar bara där klumparna möts och blåser upp formen
  // högst k/4, till skillnad från exp-summan som växer med antalet klumpar
  const smin = (a, b) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
  return (p) => {
    let dist = Infinity;
    for (const c of clumps) {
      const q = [(p[0] - c.center[0]) / c.radii[0], (p[1] - c.center[1]) / (p[1] < c.center[1] ? c.radii[1] * c.bottom : c.radii[1]), (p[2] - c.center[2]) / c.radii[2]];
      const l = Math.hypot(q[0], q[1], q[2]) || 1e-6;
      const dir = [q[0] / l, q[1] / l, q[2] / l];
      const lump = c.waves.reduce((s, w) => s + w.a * Math.sin(dot(dir, w.k) + w.ph), 0);
      dist = smin(dist, (l - 1 - lump) * c.minR);
    }
    return dist;
  };
}

const gradient = (f, p, e) => norm([
  f([p[0] + e, p[1], p[2]]) - f([p[0] - e, p[1], p[2]]),
  f([p[0], p[1] + e, p[2]]) - f([p[0], p[1] - e, p[2]]),
  f([p[0], p[1], p[2] + e]) - f([p[0], p[1], p[2] - e]),
]);

// Surface nets: en vertex per cell som korsar ytan (medel av kantkorsningarna), quads över korsade kanter
function surfaceNets(f, lo, hi, cell) {
  const n = [0, 1, 2].map((a) => Math.max(2, Math.ceil((hi[a] - lo[a]) / cell) + 1));
  const idx = (i, j, k) => i + n[0] * (j + n[1] * k);
  const vals = new Float32Array(n[0] * n[1] * n[2]);
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    vals[idx(i, j, k)] = f([lo[0] + i * cell, lo[1] + j * cell, lo[2] + k * cell]);
  }
  const P = (i, j, k) => [lo[0] + i * cell, lo[1] + j * cell, lo[2] + k * cell];
  const cellVert = new Int32Array((n[0] - 1) * (n[1] - 1) * (n[2] - 1)).fill(-1);
  const cIdx = (i, j, k) => i + (n[0] - 1) * (j + (n[1] - 1) * k);
  const verts = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let k = 0; k < n[2] - 1; k++) for (let j = 0; j < n[1] - 1; j++) for (let i = 0; i < n[0] - 1; i++) {
    const v = corners.map(([a, b, c]) => vals[idx(i + a, j + b, k + c)]);
    let acc = [0, 0, 0], cnt = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      const pa = P(i + corners[a][0], j + corners[a][1], k + corners[a][2]);
      const pb = P(i + corners[b][0], j + corners[b][1], k + corners[b][2]);
      acc = add(acc, lerp(pa, pb, t)); cnt++;
    }
    if (!cnt) continue;
    cellVert[cIdx(i, j, k)] = verts.length;
    verts.push(mul(acc, 1 / cnt));
  }
  const quads = [];
  const cv = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= n[0] - 1 || j >= n[1] - 1 || k >= n[2] - 1) ? -1 : cellVert[cIdx(i, j, k)];
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const a = vals[idx(i, j, k)];
    // Kanter längs x, y och z från denna gridpunkt; de fyra cellerna runt kanten bildar en quad
    if (i < n[0] - 1 && (a < 0) !== (vals[idx(i + 1, j, k)] < 0)) quads.push([cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k)]);
    if (j < n[1] - 1 && (a < 0) !== (vals[idx(i, j + 1, k)] < 0)) quads.push([cv(i - 1, j, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i - 1, j, k)]);
    if (k < n[2] - 1 && (a < 0) !== (vals[idx(i, j, k + 1)] < 0)) quads.push([cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k)]);
  }
  return { verts, quads: quads.filter((q) => q.every((x) => x >= 0)) };
}

/**
 * @param {number[][]} twigs  kvistpunkter från skelettet (meter)
 * @param {object} o  { seed, height, clumps, fill, union, cell, cards, cardSize, bottom, lump, normalBlend, undersideWeight }
 */
export function buildCrown(twigs, o) {
  const r = rng(o.seed * 6151 + 3);
  const H = o.height;
  const clumps = clusterLeaves(twigs, o.clumps, r, o.flattenY ?? 0.9);
  // Kärnklump vid kronans tyngdpunkt (på en kvist), som binder ihop klumparna till en krona
  if (o.core !== false && clumps.length > 2) {
    const cg = mul(clumps.reduce((s, c) => add(s, c.center), [0, 0, 0]), 1 / clumps.length);
    const meanR = clumps.reduce((s, c) => s + c.radii[0] + c.radii[1] + c.radii[2], 0) / (3 * clumps.length);
    clumps.push({ center: cg, radii: [meanR * 1.3, meanR * 1.1, meanR * 1.3], count: 1 });
  }
  for (const c of clumps) {
    c.radii = c.radii.map((x) => Math.max(x, H * 0.07) * o.fill);
    // Förankring: klumpens centrum nära en kvist, så att den sitter på en gren
    const meanR = (c.radii[0] + c.radii[1] + c.radii[2]) / 3;
    let best = twigs[0], bd = Infinity;
    for (const p of twigs) { const d = Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]); if (d < bd) { bd = d; best = p; } }
    if (bd > 0.3 * meanR) c.center = lerp(best, c.center, (0.3 * meanR) / bd);
    c.minR = Math.min(...c.radii);
    c.bottom = o.bottom ?? 0.75; // plattare undersida, som i referenserna
    c.waves = Array.from({ length: 4 }, () => ({ k: mul(randomUnit(r), 3 + r() * 4), ph: r() * 6.283, a: (o.lump ?? 0.1) * (0.6 + r() * 0.8) }));
  }
  const k = (o.union ?? 0.08) * H;
  const f = crownField(clumps, k);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  // Rutnätet måste rymma hela ytan med marginal (knölar + blandning), annars klipps kronan till en låda
  for (const c of clumps) for (let a = 0; a < 3; a++) {
    const m = c.radii[a] * (1.25 + 2 * (o.lump ?? 0.1)) + k;
    lo[a] = Math.min(lo[a], c.center[a] - m); hi[a] = Math.max(hi[a], c.center[a] + m);
  }
  lo[1] = Math.max(lo[1], 0.02);
  const crownMinY = lo[1], crownMaxY = hi[1];
  const wUp = o.undersideWeight ?? 0.3;
  const shade = (p, n, depth) => {
    const hN = clamp01((p[1] - crownMinY) / Math.max(1e-6, crownMaxY - crownMinY));
    const up = clamp01(n[1] * 0.5 + 0.5);
    const light = clamp01((0.35 * hN + wUp * up + 0.4 * (1 - depth)) / (0.75 + wUp));
    // Ljusare skuggvärde än tidigare: målbilderna har klara, mättade kronor med mjuka skuggor
    return lerp([0.42, 0.46, 0.52], [1.0, 1.0, 0.94], light ** 0.8);
  };
  const maxRadial = Math.max(...clumps.map((c) => Math.hypot(c.center[0], c.center[2]) + c.radii[0]));
  const windAt = (p) => clamp01(0.25 + 0.5 * Math.hypot(p[0], p[2]) / maxRadial + 0.25 * clamp01((p[1] - crownMinY) / (crownMaxY - crownMinY)));

  // Kort sprids en gång på den finaste ytan; lägre LOD behåller en delmängd (större kort)
  const fine = surfaceNets(f, lo, hi, (o.cell ?? 0.035) * H);
  const tris = [];
  for (const q of fine.quads) tris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
  const area = tris.map(([a, b, c]) => 0.5 * Math.hypot(...cross(sub(fine.verts[b], fine.verts[a]), sub(fine.verts[c], fine.verts[a]))));
  const total = area.reduce((s, x) => s + x, 0);
  const cdf = []; area.reduce((s, x, i) => (cdf[i] = s + x), 0);
  const cardSize = (o.cardSize ?? 0.05) * H;
  const cards = [];
  for (let i = 0; i < o.cards; i++) {
    const x = r() * total;
    let lo2 = 0, hi2 = cdf.length - 1;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (cdf[m] < x) lo2 = m + 1; else hi2 = m; }
    const [a, b, c] = tris[lo2];
    let u = r(), v = r(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const base = add(fine.verts[a], add(mul(sub(fine.verts[b], fine.verts[a]), u), mul(sub(fine.verts[c], fine.verts[a]), v)));
    const n = gradient(f, base, cardSize * 0.2);
    // De flesta korten ligger strax utanför ytan; några sticker ut och bryter silhuetten
    const out = r() < 0.15 ? 0.35 + r() * 0.35 : -0.1 + r() * 0.3;
    const p = add(base, mul(n, out * cardSize));
    const cn = norm(add(n, mul(randomUnit(r), 0.6)));
    const [t0] = basis(cn);
    const ang = r() * Math.PI * 2;
    const t = norm(add(mul(t0, Math.cos(ang)), mul(cross(cn, t0), Math.sin(ang))));
    cards.push({ p, n, cn, t, size: cardSize * (0.75 + r() * 0.5), cell: Math.floor(r() * 4), prio: r(), depth: clamp01(0.5 - out) });
  }

  const pushCard = (g, c, scale) => {
    const b = cross(c.cn, c.t);
    const w = c.size * scale * 0.5, h = c.size * scale;
    const start = g.positions.length / 3;
    const cu = (c.cell % 2) * 0.5, cvv = Math.floor(c.cell / 2) * 0.5;
    const col = shade(c.p, c.n, c.depth);
    for (const [u, vv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      // Lövets bas (v=0) nära ytan, spetsen utåt längs t
      const pos = add(c.p, add(mul(b, (u - 0.5) * 2 * w), mul(c.t, (vv - 0.25) * h)));
      const nn = norm(lerp(c.cn, gradient(f, pos, h * 0.2), o.normalBlend ?? 0.85));
      g.positions.push(...pos); g.normals.push(...nn);
      g.uvs.push(cu + u * 0.5, cvv + (1 - vv) * 0.5);
      g.colors.push(...col); g.wind.push(windAt(pos) * (0.7 + 0.3 * vv)); g.cluster.push(0);
    }
    // Moturs sett från +cn (framsidan utåt); enkelsidigt så att normalerna inte vänds på baksidan
    g.indices.push(start, start + 3, start + 1, start, start + 2, start + 3); // b × t = −cn, så vänd ordningen
  };

  const lodDefs = [{ keep: 1, scale: 1, cell: 1 }, { keep: 0.45, scale: 1.45, cell: 1.6 }, { keep: 0.18, scale: 2.2, cell: 2.6 }];
  const lods = lodDefs.map(({ keep, scale, cell }) => {
    const g = empty();
    for (const c of cards) if (c.prio < keep) pushCard(g, c, scale);
    // Ogenomskinlig kronmassa, lite inkrympt så att korten ligger utanpå
    const mesh = cell === 1 ? fine : surfaceNets(f, lo, hi, (o.cell ?? 0.035) * H * cell);
    const vol = empty();
    for (const p0 of mesh.verts) {
      const n = gradient(f, p0, cardSize * 0.2);
      const p = sub(p0, mul(n, cardSize * 0.15));
      vol.positions.push(...p); vol.normals.push(...n);
      vol.uvs.push(p[0] / (H * 0.25), p[2] / (H * 0.25));
      vol.colors.push(...shade(p, n, 0.55)); vol.wind.push(windAt(p) * 0.5); vol.cluster.push(0);
    }
    // Vänd varje quad så att den pekar längs fältets gradient (utåt)
    for (const q of mesh.quads) {
      const [a, b, c, d] = q.map((i) => mesh.verts[i]);
      const qn = cross(sub(c, a), sub(d, b));
      const out = dot(qn, gradient(f, mul(add(add(a, b), add(c, d)), 0.25), cardSize * 0.2)) > 0;
      if (out) vol.indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
      else vol.indices.push(q[0], q[2], q[1], q[0], q[3], q[2]);
    }
    g.volume = vol;
    return g;
  });
  return { clusters: clumps, lods };
}
