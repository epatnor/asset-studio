import { barkMesh } from './bark_mesh.mjs';
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
  // högst k/4, till skillnad från exp-summan som växer med antalet klumpar.
  // Returnerar även vilken klump som ligger närmast (för puffnormaler) och det minsta enskilda
  // avståndet (skillnaden mot unionen visar var det är en skreva mellan två puffar).
  const smin = (a, b) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
  return (p) => {
    let dist = Infinity, dmin = Infinity, ci = 0;
    clumps.forEach((c, i) => {
      const q = [(p[0] - c.center[0]) / c.radii[0], (p[1] - c.center[1]) / (p[1] < c.center[1] ? c.radii[1] * c.bottom : c.radii[1]), (p[2] - c.center[2]) / c.radii[2]];
      const l = Math.hypot(q[0], q[1], q[2]) || 1e-6;
      const dir = [q[0] / l, q[1] / l, q[2] / l];
      const lump = c.waves.reduce((s, w) => s + w.a * Math.sin(dot(dir, w.k) + w.ph), 0);
      const d = (l - 1 - lump) * c.minR;
      if (d < dmin) { dmin = d; ci = i; }
      dist = smin(dist, d);
    });
    return { d: dist, dmin, ci };
  };
}

export const gradient = (f, p, e) => norm([
  f([p[0] + e, p[1], p[2]]) - f([p[0] - e, p[1], p[2]]),
  f([p[0], p[1] + e, p[2]]) - f([p[0], p[1] - e, p[2]]),
  f([p[0], p[1], p[2] + e]) - f([p[0], p[1], p[2] - e]),
]);

// Surface nets: en vertex per cell som korsar ytan (medel av kantkorsningarna), quads över korsade kanter
export function surfaceNets(f, lo, hi, cell) {
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

// Kupolläge: stora runda puffar jämnt fördelade (Fibonacci-sfär) över kronans övre och yttre yta,
// som stackmoln (referensbilden), plus en kärna som fyller insidan
function domeClumps(twigs, o, r) {
  const n = twigs.length;
  const c = mul(twigs.reduce(add, [0, 0, 0]), 1 / n);
  const radii = [0, 1, 2].map((a) => Math.max(...twigs.map((p) => Math.abs(p[a] - c[a]))) * 0.85);
  // round: sfärisk grundform (bollbuskar), oberoende av hur de dolda grenarna råkade sprida sig
  // (största radien, så att sfären omsluter alla kvistar och inga täckningspuffar sticker ut)
  if (o.round) { const m = Math.max(...radii) / 0.85; radii[0] = radii[1] = radii[2] = m; }
  radii[1] *= o.flattenY ?? 1;
  const meanR = (radii[0] + radii[1] + radii[2]) / 3;
  const out = [{ center: [c[0], c[1] - radii[1] * 0.1, c[2]], radii: radii.map((x) => x * 0.72), count: n }];
  const N = o.clumps ?? 11;
  for (let i = 0; i < N * 1.6 && out.length < N + 1; i++) {
    const y = 1 - (i + 0.5) / (N * 1.6) * 2, rr = Math.sqrt(1 - y * y), th = i * 2.399963;
    if (y < (o.domeBottom ?? -0.35)) continue; // inga puffar under kronan
    const d = [Math.cos(th) * rr, y, Math.sin(th) * rr];
    const pr = meanR * (o.puffR ?? 0.42) * (0.85 + r() * 0.3);
    out.push({ center: add(c, [d[0] * radii[0] * 0.8, d[1] * radii[1] * 0.8, d[2] * radii[2] * 0.8]), radii: [pr, pr * 0.92, pr], count: 1 });
  }
  return out;
}

/**
 * @param {number[][]} twigs  kvistpunkter från skelettet (meter)
 * @param {object} o  { seed, height, clumps, fill, union, cell, cards, cardSize, bottom, lump, normalBlend, undersideWeight }
 */
export function buildCrown(twigs, o) {
  const r = rng(o.seed * 6151 + 3);
  const H = o.height;
  const clumps = o.mode === 'dome' ? domeClumps(twigs, o, r) : clusterLeaves(twigs, o.clumps, r, o.flattenY ?? 0.9);
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
    if (bd > 0.28 * meanR) c.center = lerp(best, c.center, (0.28 * meanR) / bd);
    c.minR = Math.min(...c.radii);
    c.bottom = o.bottom ?? 0.75; // plattare undersida, som i referenserna
    c.waves = Array.from({ length: 4 }, () => ({ k: mul(randomUnit(r), 3 + r() * 4), ph: r() * 6.283, a: (o.lump ?? 0.1) * (0.6 + r() * 0.8) }));
  }
  // Täckning: varje kvist utanför kronan får en egen puff (centrerad på kvisten), så att inga kala
  // grenar sticker ut. Girigt: när en kvist täcks av en ny puff täcks dess grannar ofta också.
  const insideAny = (p, f = 0.85) => clumps.some((c) => [0, 1, 2].reduce((s, a) => s + ((p[a] - c.center[a]) / (c.radii[a] * f)) ** 2, 0) <= 1);
  const refR = clumps.slice(1).reduce((s, c) => s + c.radii[0], 0) / Math.max(1, clumps.length - 1);
  for (const p of twigs) {
    if (insideAny(p)) continue;
    const pr = refR * (o.coverR ?? 0.75) * (0.85 + r() * 0.3);
    const fy = o.coverFlatten ?? 1; // kuddar (japansk tall): platta täckningspuffar
    clumps.push({ center: p, radii: [pr, pr * 0.92 * fy, pr], count: 1, minR: pr * 0.92 * fy, bottom: o.bottom ?? 0.75,
      waves: clumps[0].waves.map((w) => ({ ...w, ph: w.ph + r() * 6 })) });
  }
  // Puffar: mindre klumpar på klumparnas övre och yttre sida, så kronan blir bullig som ett stackmoln
  const base = clumps.length;
  for (let i = 0; i < base; i++) {
    const c = clumps[i];
    for (let j = 0; j < (o.puffs ?? 0); j++) {
      let d = randomUnit(r);
      d = norm([d[0] + c.center[0] * 0.15, Math.abs(d[1]) * 0.9 + 0.1, d[2] + c.center[2] * 0.15]);
      const s2 = (o.puffScale ?? 0.45) + r() * 0.2;
      clumps.push({
        center: add(c.center, mul([d[0] * c.radii[0], d[1] * c.radii[1], d[2] * c.radii[2]], o.puffOut ?? 0.72)),
        radii: c.radii.map((x) => x * s2), count: 1, bottom: c.bottom, minR: c.minR * s2, parent: i,
        waves: c.waves.map((w) => ({ ...w, ph: w.ph + j * 1.7, a: w.a * 0.7 })),
      });
    }
  }
  const k = (o.union ?? 0.08) * H;
  const info = crownField(clumps, k);
  const f = (p) => info(p).d;
  // Bullig skuggning: blanda fältets normal med den närmaste puffens egen ellipsoidnormal
  // (guidens sfäriska överskrivning, α ≈ 0,75–0,9), så varje bulle får eget ljus och egen skugga
  const puffNormal = (p, e) => {
    const g = gradient(f, p, e);
    const c = clumps[info(p).ci];
    const sph = norm([(p[0] - c.center[0]) / c.radii[0] ** 2, (p[1] - c.center[1]) / c.radii[1] ** 2, (p[2] - c.center[2]) / c.radii[2] ** 2]);
    return norm(lerp(g, sph, o.puff ?? 0.5));
  };
  // Skrevor: där unionen ligger klart under närmaste enskilda klump smälter två puffar ihop
  const crevice = (p) => { const x = info(p); return clamp01((x.dmin - x.d) / (k * 0.25)); };
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  // Rutnätet måste rymma hela ytan med marginal (knölar + blandning), annars klipps kronan till en låda
  for (const c of clumps) for (let a = 0; a < 3; a++) {
    const m = c.radii[a] * (1.25 + 2 * (o.lump ?? 0.1)) + k;
    lo[a] = Math.min(lo[a], c.center[a] - m); hi[a] = Math.max(hi[a], c.center[a] + m);
  }
  lo[1] = Math.max(lo[1], 0.02);
  const crownMinY = lo[1], crownMaxY = hi[1];
  const wUp = o.undersideWeight ?? 0.3;
  const shade = (p, n, depth, crev = 0) => {
    const hN = clamp01((p[1] - crownMinY) / Math.max(1e-6, crownMaxY - crownMinY));
    const up = clamp01(n[1] * 0.5 + 0.5);
    const light = clamp01((0.35 * hN + wUp * up + 0.4 * (1 - depth)) / (0.75 + wUp)) * (1 - (o.creviceDark ?? 0.45) * crev);
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
    const n = puffNormal(base, cardSize * 0.2);
    // Regel: varje korts rot sitter i volymen (vid eller strax innanför ytan), aldrig fritt i luften.
    // Utstickande kort flyttas inte ut från ytan; de LUTAS ut, så att roten sitter fast och spetsen
    // bryter silhuetten.
    const stick = r() < (o.stickOut ?? 0.12);
    const out = stick ? -0.08 - r() * 0.1 : -0.3 + r() * 0.26;
    const p = add(base, mul(n, out * cardSize));
    let cn, t;
    if (stick) {
      t = norm(add(n, mul(randomUnit(r), 0.6)));          // spetsen pekar ut från ytan
      cn = sub(n, mul(t, dot(n, t)));                      // kortets plan innehåller utåtriktningen
      cn = dot(cn, cn) > 1e-6 ? norm(cn) : basis(t)[0];
    } else {
      cn = norm(add(n, mul(randomUnit(r), 0.6)));
      const [t0] = basis(cn);
      const ang = r() * Math.PI * 2;
      t = norm(add(mul(t0, Math.cos(ang)), mul(cross(cn, t0), Math.sin(ang))));
    }
    const size = cardSize * (0.75 + r() * 0.5);
    // Roten (mitten av kortets bas) måste ligga i volymen: på bulliga, konvexa ytor hamnar den annars utanför
    let pp = p;
    for (let k = 0; k < 12 && f(sub(pp, mul(t, size * 0.25))) > -cardSize * 0.02; k++) pp = sub(pp, mul(n, cardSize * 0.08));
    cards.push({ p: pp, n, cn, t, size, cell: Math.floor(r() * 4), prio: r(), depth: clamp01(0.5 - out), crev: crevice(base), ci: info(base).ci });
  }

  const pushCard = (g, c, scale) => {
    const b = cross(c.cn, c.t);
    const w = c.size * scale * 0.5, h = c.size * scale;
    const start = g.positions.length / 3;
    const cu = (c.cell % 2) * 0.5, cvv = Math.floor(c.cell / 2) * 0.5;
    const col = shade(c.p, c.n, c.depth, c.crev);
    for (const [u, vv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      // Lövets bas (v=0) nära ytan, spetsen utåt längs t
      const pos = add(c.p, add(mul(b, (u - 0.5) * 2 * w), mul(c.t, (vv - 0.25) * h)));
      const nn = norm(lerp(c.cn, puffNormal(pos, h * 0.2), o.normalBlend ?? 0.85));
      g.positions.push(...pos); g.normals.push(...nn);
      g.uvs.push(cu + u * 0.5, cvv + (1 - vv) * 0.5);
      g.colors.push(...col); g.wind.push(c.strand ? windAt(c.root) * 0.9 : windAt(pos) * (0.7 + 0.3 * vv)); g.cluster.push(c.ci);
    }
    // Moturs sett från +cn (framsidan utåt); enkelsidigt så att normalerna inte vänds på baksidan
    g.indices.push(start, start + 3, start + 1, start, start + 2, start + 3); // b × t = −cn, så vänd ordningen
    // Baksida: samma fyra hörn igen med omvänd ordning men SAMMA normal, så att baksidan belyses som
    // framsidan (ett dubbelsidigt material skulle vända normalen och förstöra klotskuggningen).
    // Från kronans utsida vänder kopian bort från kameran och sorteras bort, så ingen extra overdraw där.
    const back = g.positions.length / 3;
    for (let k = 0; k < 4; k++) {
      for (const key of ['positions', 'normals', 'colors']) g[key].push(...g[key].slice((start + k) * 3, (start + k) * 3 + 3));
      g.uvs.push(...g.uvs.slice((start + k) * 2, (start + k) * 2 + 2));
      g.wind.push(g.wind[start + k]); g.cluster.push(g.cluster[start + k]);
    }
    g.indices.push(back, back + 1, back + 3, back, back + 3, back + 2);
  };

  // Hängande gardiner (pil): stänglar som hänger ned från kronans undersida, med blad längs stjälken
  const strands = [];
  if (o.hang) {
    const lower = tris.filter((_, i) => i % 3 === 0).map(([a]) => fine.verts[a]).filter((p) => gradient(f, p, cardSize * 0.2)[1] < 0.15);
    for (let s = 0; s < o.hang && lower.length; s++) {
      const top = lower[Math.floor(r() * lower.length)];
      const L = H * (o.hangLength ?? 0.3) * (0.6 + r() * 0.6);
      const out = norm([top[0], 0, top[2]]);
      const n = Math.max(3, Math.round(L / (cardSize * 0.55)));
      // Stjälken börjar en bit inne i volymen och hänger ned med en svag båge utåt
      const at = (u) => add(sub(top, mul(gradient(f, top, cardSize * 0.2), cardSize * 0.35)), add(mul([0, -1, 0], L * u), mul(out, L * 0.08 * Math.sin(u * Math.PI))));
      const nodes = [];
      for (let i = 0; i <= n; i++) {
        const pt = at(i / n);
        if (pt[1] < H * 0.04) break;
        nodes.push({ p: pt, r: cardSize * 0.035 * (1 - 0.5 * i / n) });
      }
      if (nodes.length < 3) continue;
      strands.push({ level: 1, nodes, segments: 4, phase: 0, length: L });
      // Bladen sitter längs stjälken: kortets rot (överkant) ligger på stjälken
      for (let i = 1; i < nodes.length; i++) {
        const u = i / n;
        const cn = norm(add(out, mul(randomUnit(r), 0.5)));
        const t = norm(add([0, -1, 0], mul(randomUnit(r), 0.3)));
        const sz = cardSize * (0.7 + r() * 0.4);
        const p = add(nodes[i].p, mul(t, sz * 0.25)); // så att roten (p − t·0,25h) hamnar på stjälken
        cards.push({ p, n: puffNormal(top, cardSize * 0.2), cn, t, size: sz, cell: Math.floor(r() * 4), prio: r(), depth: 0.2 + 0.3 * u, crev: 0, ci: 0, strand: true, root: nodes[i].p });
      }
    }
  }

  // Kontroll: ett korts rot (mitten av kortets bas) ska sitta i volymen eller på en stjälk
  const floatingCards = cards.filter((c) => !c.strand && f(sub(c.p, mul(c.t, c.size * 0.25))) > cardSize * 0.08).length;
  let stems = null;
  if (strands.length) {
    stems = barkMesh({ branches: strands }, { maxLevel: 9, segScale: 1, barkRepeat: 0.3, height: H });
    for (let i = 0; i < stems.positions.length / 3; i++) {
      stems.colors.splice(i * 3, 3, 0.16, 0.2, 0.08); // mörkt gröngrått (linjärt), annars ser de tunna stänglarna vita ut i himmelsljuset
      stems.wind[i] = windAt([stems.positions[i * 3], stems.positions[i * 3 + 1], stems.positions[i * 3 + 2]]) * 0.9;
    }
  }

  const lodDefs = [{ keep: 1, scale: 1, cell: 1 }, { keep: 0.45, scale: 1.45, cell: 1.6 }, { keep: 0.18, scale: 2.2, cell: 2.6 }];
  const lods = lodDefs.map(({ keep, scale, cell }) => {
    const g = empty();
    for (const c of cards) if (c.prio < keep) pushCard(g, c, scale);
    // Ogenomskinlig kronmassa, lite inkrympt så att korten ligger utanpå
    const mesh = cell === 1 ? fine : surfaceNets(f, lo, hi, (o.cell ?? 0.035) * H * cell);
    // Beräkna vertexdata en gång per vertex, och bygg sedan icke-indexerade quads med lådprojektion:
    // varje quad projiceras längs sin dominerande axel, så texturen inte sträcks ut på sidorna
    const vd = mesh.verts.map((p0) => {
      const n = puffNormal(p0, cardSize * 0.2);
      const p = sub(p0, mul(n, cardSize * 0.15));
      return { p, n, col: shade(p, n, 0.55, crevice(p0)), wind: windAt(p) * 0.5, ci: info(p0).ci };
    });
    const vol = empty();
    const S = 1 / (H * (o.massScale ?? 0.162)); // texturupprepningar per meter
    for (const q of mesh.quads) {
      const [a, b, c, d] = q.map((i) => mesh.verts[i]);
      const qn = cross(sub(c, a), sub(d, b));
      const out = dot(qn, gradient(f, mul(add(add(a, b), add(c, d)), 0.25), cardSize * 0.2)) > 0;
      const ax = [0, 1, 2].reduce((m, x) => (Math.abs(qn[x]) > Math.abs(qn[m]) ? x : m), 0);
      const [u1, u2] = ax === 0 ? [2, 1] : ax === 1 ? [0, 2] : [0, 1];
      const start = vol.positions.length / 3;
      for (const vi of q) {
        const v = vd[vi];
        vol.positions.push(...v.p); vol.normals.push(...v.n);
        vol.uvs.push(v.p[u1] * S, -v.p[u2] * S);
        vol.colors.push(...v.col); vol.wind.push(v.wind); vol.cluster.push(v.ci);
      }
      if (out) vol.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      else vol.indices.push(start, start + 2, start + 1, start, start + 3, start + 2);
    }
    g.volume = vol;
    if (stems) g.stems = stems;
    return g;
  });
  return { clusters: clumps, lods, floatingCards };
}
