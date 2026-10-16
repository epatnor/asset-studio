// Stiliserad trädkrona enligt docs/Stiliserad_vegetation_ThreeJS_med_bildreferenser.pdf:
// lövpunkter -> 8–20 kluster (ellipsoider) -> böjda lövkort på klustrens skal,
// normaler riktade ut från klustercentrum, gradient i vertexfärg, vindvikt och LOD.
// Ren JS utan Three.js/DOM, så att samma kod kan köras i Node och senare i klienten.

// Seedad PRNG (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function randomUnit(r) {
  const z = r() * 2 - 1, phi = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(phi), z, s * Math.sin(phi)];
}

// k-means++ på lövpunkterna; ger klustercentrum och ellipsoidradier
export function clusterLeaves(points, k, r, flattenY = 1) {
  k = Math.max(1, Math.min(k, Math.floor(points.length / 6)));
  const centers = [points[Math.floor(r() * points.length)]];
  while (centers.length < k) {
    const d2 = points.map((p) => Math.min(...centers.map((c) => dot(sub(p, c), sub(p, c)))));
    let pick = r() * d2.reduce((s, x) => s + x, 0);
    let i = 0;
    for (; i < d2.length - 1 && pick > d2[i]; i++) pick -= d2[i];
    centers.push(points[i]);
  }
  let assign = new Array(points.length).fill(0);
  for (let it = 0; it < 25; it++) {
    assign = points.map((p) => {
      let best = 0, bd = Infinity;
      centers.forEach((c, j) => { const d = dot(sub(p, c), sub(p, c)); if (d < bd) { bd = d; best = j; } });
      return best;
    });
    for (let j = 0; j < k; j++) {
      const mine = points.filter((_, i) => assign[i] === j);
      if (mine.length) centers[j] = mul(mine.reduce(add, [0, 0, 0]), 1 / mine.length);
    }
  }
  return centers.map((c, j) => {
    const mine = points.filter((_, i) => assign[i] === j);
    const sd = [0, 1, 2].map((ax) => Math.sqrt(mine.reduce((s, p) => s + (p[ax] - c[ax]) ** 2, 0) / Math.max(1, mine.length)));
    const base = Math.max(...sd) * 0.6;
    // Lite större än punktmolnet så att grenspetsarna täcks; minsta radie mot alltför platta kluster
    const radii = sd.map((s) => Math.max(s * 1.9, base));
    radii[1] *= flattenY;
    return { center: c, radii, count: mine.length };
  }).filter((cl) => cl.count > 0);
}

// Ett böjt lövkort: 3x2 hörn (två quads med svag vikning utåt), UV i en atlascell
function pushCard(out, p, n, t, size, cell, clusterIdx, clusterCenter, normalBlend, color, wind, aspect = 1, normalAt = null) {
  const b = cross(n, t);
  const w = size * 0.5 * aspect;
  const fold = size * 0.12;
  const rows = [0, 0.5, 1];
  const base = out.positions.length / 3;
  const cu = (cell % 2) * 0.5, cv = Math.floor(cell / 2) * 0.5;
  for (const v of rows) {
    const bend = Math.sin(v * Math.PI) * fold; // konvex utåt
    for (const u of [0, 1]) {
      const pos = add(add(p, mul(b, (u - 0.5) * 2 * w)), add(mul(t, (v - 0.35) * size), mul(n, bend)));
      // n = normalize(vertex - clusterCenter), blandat med kortets egen normal
      const nc = normalAt ? normalAt(pos) : norm(sub(pos, clusterCenter));
      const nn = norm(lerp(n, nc, normalBlend));
      out.positions.push(...pos);
      out.normals.push(...nn);
      out.uvs.push(cu + u * 0.5, cv + (1 - v) * 0.5);
      out.colors.push(...color);
      out.wind.push(wind * (0.6 + 0.4 * v)); // spetsen rör sig mer än fästet
      out.cluster.push(clusterIdx);
    }
  }
  // Medurs i (b, t)-planet = moturs sett från +n, så framsidan pekar utåt.
  // Korten är enkelsidiga: med DoubleSide skulle baksidan vända normalen och förstöra klusterskuggningen.
  for (let q = 0; q < 2; q++) {
    const i = base + q * 2;
    out.indices.push(i, i + 3, i + 1, i, i + 2, i + 3);
  }
}

/**
 * @param {number[][]} leafPoints  lövens fästpunkter från ez-tree (meter, y uppåt)
 * @param {object} o  { seed, clusters, cards, normalBlend, flattenY, droop, height }
 * @returns {{ clusters, lods: Array<{positions,normals,uvs,colors,wind,cluster,indices}> }}
 */
// Ikosfär (enhetsriktningar + trianglar), subdiv 0 = 20 trianglar, 1 = 80, 2 = 320
function icosphere(subdiv) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
    [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < subdiv; s++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!cache.has(key)) { cache.set(key, verts.length); verts.push(norm(lerp(verts[a], verts[b], 0.5))); }
      return cache.get(key);
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  return { verts, faces };
}

// Ojämn klustervolym: ikosfär förskjuten med några slumpade vågor, så att den ser ut som en lövklump
// och inte som en grön plastellipsoid. Ogenomskinlig, så den fyller kronan billigt (djuptestet
// slänger allt bakom), och korten behöver bara bryta silhuetten.
function pushVolume(out, cl, ci, r, subdiv, shade, uvScale, normalAt = null) {
  const { verts, faces } = icosphere(subdiv);
  const waves = Array.from({ length: 4 }, () => ({ k: mul(randomUnit(r), 2 + r() * 3), ph: r() * 6.283, a: 0.05 + r() * 0.06 }));
  const lump = (d) => 1 + waves.reduce((s, w) => s + w.a * Math.sin(dot(d, w.k) + w.ph), 0);
  const pos = verts.map((d) => {
    const f = 0.86 * lump(d);
    return add(cl.center, [d[0] * cl.radii[0] * f, d[1] * cl.radii[1] * f, d[2] * cl.radii[2] * f]);
  });
  // Sfärisk UV per triangel (icke-indexerad) så att sömmen vid u=0/1 kan lagas per triangel
  for (const tri of faces) {
    const uv = tri.map((i) => [Math.atan2(verts[i][2], verts[i][0]) / (2 * Math.PI) + 0.5, Math.acos(Math.max(-1, Math.min(1, verts[i][1]))) / Math.PI]);
    const us = uv.map((x) => x[0]);
    if (Math.max(...us) - Math.min(...us) > 0.5) uv.forEach((x) => { if (x[0] < 0.5) x[0] += 1; });
    const base = out.positions.length / 3;
    tri.forEach((i, k) => {
      out.positions.push(...pos[i]);
      out.normals.push(...(normalAt ? normalAt(pos[i]) : norm(sub(pos[i], cl.center))));
      out.uvs.push(uv[k][0] * uvScale[0], uv[k][1] * uvScale[1]);
      out.colors.push(...shade(pos[i], verts[i], 0.86));
      out.wind.push(0.3);
      out.cluster.push(ci);
    });
    // Ikosfärens trianglar är moturs sett utifrån
    out.indices.push(base, base + 1, base + 2);
  }
}

// Mjuk union (smooth min) av klustrens ellipsoider som ett avståndsfält; normalen är gradienten
function unionNormal(clusters, k) {
  const sdf = (p) => {
    let sum = 0;
    for (const c of clusters) {
      const q = [(p[0] - c.center[0]) / c.radii[0], (p[1] - c.center[1]) / c.radii[1], (p[2] - c.center[2]) / c.radii[2]];
      const d = (Math.hypot(q[0], q[1], q[2]) - 1) * Math.min(...c.radii); // ungefärligt avstånd till ellipsoiden
      sum += Math.exp(-d / k);
    }
    return -k * Math.log(sum);
  };
  const e = k * 0.05;
  return (p) => norm([
    sdf([p[0] + e, p[1], p[2]]) - sdf([p[0] - e, p[1], p[2]]),
    sdf([p[0], p[1] + e, p[2]]) - sdf([p[0], p[1] - e, p[2]]),
    sdf([p[0], p[1], p[2] + e]) - sdf([p[0], p[1], p[2] - e]),
  ]);
}

// Barrträd: dela lövpunkterna i höjdband (våningar) och klustra varje band för sig,
// så att kronan blir separata horisontella skivor med luckor emellan i stället för klumpar
function tierClusters(points, o, r) {
  const ys = points.map((p) => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const out = [];
  for (let t = 0; t < o.tiers; t++) {
    const a = lo + (hi - lo) * (t / o.tiers), b = lo + (hi - lo) * ((t + 1) / o.tiers);
    const band = points.filter((p) => p[1] >= a && (p[1] < b || t === o.tiers - 1));
    if (band.length < 8) continue;
    // Färre kluster högre upp där våningen är smalare
    const k = Math.max(1, Math.round(o.clustersPerTier * (1 - 0.6 * t / o.tiers)));
    out.push(...clusterLeaves(band, k, r, o.flattenY ?? 0.35));
  }
  return out;
}

export function buildCanopy(leafPoints, o) {
  const r = rng(o.seed * 7919 + 13);
  const clusters = o.tiers ? tierClusters(leafPoints, o, r) : clusterLeaves(leafPoints, o.clusters, r, o.flattenY ?? 1);
  // Fylligare krona: förstora klustren så att de möts, men lämna luckor (fill ~1.1–1.3)
  for (const cl of clusters) cl.radii = cl.radii.map((x) => x * (o.fill ?? 1));
  // Förankring: dra varje klusters centrum mot närmaste lövpunkt (kvist), så att klumpen sitter
  // på en gren och inte svävar mellan två grenar där medelvärdet råkade hamna
  for (const cl of clusters) {
    const meanR = (cl.radii[0] + cl.radii[1] + cl.radii[2]) / 3;
    let best = null, bd = Infinity;
    for (const p of leafPoints) { const d = Math.hypot(p[0] - cl.center[0], p[1] - cl.center[1], p[2] - cl.center[2]); if (d < bd) { bd = d; best = p; } }
    const maxD = 0.35 * meanR;
    if (best && bd > maxD) cl.center = lerp(best, cl.center, maxD / bd);
  }
  const volume = o.volume ?? true;
  const crownMinY = Math.min(...clusters.map((c) => c.center[1] - c.radii[1]));
  const crownMaxY = Math.max(...clusters.map((c) => c.center[1] + c.radii[1]));
  const maxRadial = Math.max(...clusters.map((c) => Math.hypot(c.center[0], c.center[2]) + c.radii[0]));
  const wUp = o.undersideWeight ?? 0.25;

  // Färg: mörkt och kallt inåt/nedåt, ljust och varmt utåt/uppåt (multipliceras med texturen).
  // Samma funktion för volymer och kort, så att korten smälter in i volymen.
  const shade = (p, d, shell) => {
    const hN = clamp01((p[1] - crownMinY) / Math.max(1e-6, crownMaxY - crownMinY));
    const up = clamp01(d[1] * 0.5 + 0.5);
    const light = clamp01((0.3 * hN + 0.45 * clamp01(shell) + wUp * up) / (0.75 + wUp));
    // Kraftig ljus/mörk-skillnad men mild kall ton, så att rosa och gula kronor inte blir lila
    return lerp([0.3, 0.34, 0.4], [1.0, 1.0, 0.92], light ** 0.85);
  };

  // Fördela kort efter klustrens yta
  const area = clusters.map((c) => c.radii[0] * c.radii[2] + c.radii[0] * c.radii[1] + c.radii[1] * c.radii[2]);
  const areaSum = area.reduce((s, a) => s + a, 0);

  // Generera alla kort en gång (LOD0) med en slumpad prioritet; lägre LOD behåller en delmängd
  const cards = [];
  clusters.forEach((cl, ci) => {
    const nCards = Math.max(6, Math.round(o.cards * area[ci] / areaSum));
    const meanR = (cl.radii[0] + cl.radii[1] + cl.radii[2]) / 3;
    for (let i = 0; i < nCards; i++) {
      const roll = r();
      let shell, stickOut;
      if (volume) {
        // Med volym: korten ligger på volymens yta och strax utanför; 10 % sticker ut och bryter silhuetten
        stickOut = roll >= 0.9;
        shell = stickOut ? 1.0 + r() * 0.22 : 0.84 + r() * 0.16;
      } else {
        // Utan volym: 80 % yttre skal, inre löv (innerShare), 6 % utstickande kvistar
        const outerEnd = 0.94 - (o.innerShare ?? 0.14);
        stickOut = roll >= 0.94;
        shell = roll < outerEnd ? 0.78 + r() * 0.27 : !stickOut ? 0.3 + r() * 0.4 : 1.08 + r() * 0.18;
      }
      const d = randomUnit(r);
      const p = add(cl.center, [d[0] * cl.radii[0] * shell, d[1] * cl.radii[1] * shell, d[2] * cl.radii[2] * shell]);
      // Utåtriktning på ellipsoiden (gradienten), lätt slumpad; på en volym ligger korten närmare ytan
      const grad = norm([d[0] / cl.radii[0], d[1] / cl.radii[1], d[2] / cl.radii[2]]);
      const n = norm(add(grad, mul(randomUnit(r), volume ? 0.35 : 0.55)));
      // Kortets "upp": slumpvis i kortets plan, med lätt häng nedåt för barrträd
      let t = norm(cross(n, randomUnit(r)));
      if (o.droop) t = norm(lerp(t, [0, -1, 0], o.droop * 0.5));
      t = norm(sub(t, mul(n, dot(t, n))));
      const size = meanR * (stickOut ? 0.34 : volume ? 0.5 : 0.46) * (0.8 + r() * 0.45);
      const radial = Math.hypot(p[0], p[2]) / Math.max(1e-6, maxRadial);
      const hN = clamp01((p[1] - crownMinY) / Math.max(1e-6, crownMaxY - crownMinY));
      const wind = clamp01(0.25 + 0.5 * radial + 0.25 * hN);
      cards.push({ p, n, t, size, cell: Math.floor(r() * 4), ci, center: cl.center, color: shade(p, grad, shell), wind, prio: r() });
    }
  });

  // "Fluffy"-skuggning: normaler från en mjuk sammanslagning av alla kluster, så att kronan skuggas
  // som EN sammanhängande form och inte som separata bollar (o.union = mjukhet i meter, 0 = av)
  const k = o.union ?? 0.35 * Math.max(...clusters.map((c) => Math.min(...c.radii)));
  const normalAt = k > 0 ? unionNormal(clusters, k) : null;

  // Volymer: samma klumpform i alla LOD (seedad per kluster), grövre ikosfär i LOD2
  const volumeSeeds = clusters.map(() => Math.floor(r() * 2 ** 31));

  // LOD0 alla kort, LOD1 ~50 % större kort, LOD2 ~20 % ännu större
  const lodDefs = [{ keep: 1, scale: 1, subdiv: 2 }, { keep: 0.5, scale: 1.38, subdiv: 2 }, { keep: 0.2, scale: 2.1, subdiv: 1 }];
  const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], cluster: [], indices: [] });
  const lods = lodDefs.map(({ keep, scale, subdiv }) => {
    const out = empty();
    for (const c of cards) {
      if (c.prio >= keep) continue;
      pushCard(out, c.p, c.n, c.t, c.size * scale, c.cell, c.ci, c.center, o.normalBlend ?? 0.8, c.color, c.wind, o.cardAspect ?? 1, normalAt);
    }
    if (volume) {
      out.volume = empty();
      clusters.forEach((cl, ci) => pushVolume(out.volume, cl, ci, rng(volumeSeeds[ci]), subdiv, shade, o.volumeUV ?? [3, 2], normalAt));
    }
    return out;
  });
  return { clusters, lods };
}
