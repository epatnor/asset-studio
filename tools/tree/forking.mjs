// Gaffelträd (sp.growth = 'fork'): ett enkelt skelett efter riktiga träds förgreningsregler, i meter.
// - Stammen växer rakt upp till kronans bas och delar sig där i några huvudgrenar (limbs), som en ek.
// - Varje huvudgren gaffelgrenar sig enligt Hondas modell (Honda 1971): vid varje gaffel fortsätter huvudgrenen
//   nästan rakt (ratioMain av längden, böjd angleMain), sidogrenen går ut i större vinkel (ratioLateral, angleLateral),
//   och gaffelns plan vrids den gyllene vinkeln (divergence, 137,5°) för varje generation, så att grenarna sprids
//   jämnt runt om. orders = hur många gånger grenarna gaffelgrenar sig (3–4 ordningar som i riktiga träd).
// - Tjockleken följer da Vincis regel (pipe-modellen): en grens tvärsnitt är summan av det den bär,
//   r = (Σ rᵢ^pipe)^(1/pipe), med pipe = 2 (da Vinci: tvärsnittsytan bevaras). Stammens radie är ett eget mått
//   (trunkRadius i meter, grövre än i verkligheten som i stiliserade träd), och spetsarnas
//   radie följer av den: trunkRadius / antal spetsar^(1/pipe). Spetsarna smalnar sedan av inne i bollarna
//   (taperTips). thickness skalar allt lika.
// - Mjuka grenfästen: en sidogren börjar med en krage (collar) som vidgar den in i föräldern (aldrig tjockare än den).
// - Måtten är egna: kronans bredd och höjd i meter (crownWidth, crownHeight); stammen är resten av trädets höjd.
//   Att ändra höjden gör alltså bara stammen längre, och kronan behåller sin storlek.
// Skelettet får samma form som buildSkeleton (grenar i kedjor med level, nodes, parent, t), så bark, lövbollar,
// LOD och vindriggen fungerar oförändrade. En kedja följer huvudgrenen genom gafflarna; sidogrenar blir egna kedjor.
// Varje kedjas sista gaffelsträcka bär löv (leafFrom). Ren JS utan Three.js/DOM.
import { add, sub, mul, norm, len, UP, rng, randomUnit, basis } from './vec.mjs';
import { twigsOf } from './skeleton.mjs';

export const FORK_DEFAULTS = {
  crownWidth: 8, crownHeight: 6, limbs: 3, limbAngle: 40, orders: 3,
  ratioMain: 0.82, ratioLateral: 0.62, angleMain: 14, angleLateral: 44, divergence: 137.5,
  gnarl: 0.12, tropism: 0.15, gravity: 0.04, pipe: 2, trunkRadius: 0.4, thickness: 1, collar: 1.3, spacing: 0.4, fill: 0.85,
};

const rad = (d) => (d * Math.PI) / 180;
// Vrid riktningen d vinkeln a (radianer) bort från sig själv, åt sidan som ligger i azimuten az runt d
function deflect(d, a, az) {
  const [b1, b2] = basis(d);
  const side = add(mul(b1, Math.cos(az)), mul(b2, Math.sin(az)));
  return norm(add(mul(d, Math.cos(a)), mul(side, Math.sin(a))));
}

export function forkSkeleton(sp, seed, height) {
  const F = { ...FORK_DEFAULTS, ...(sp.branching ?? {}) };
  const r = rng(seed * 2654435761 + 11);
  const crownH = Math.min(F.crownHeight, height * 0.9);
  const bole = Math.max(0.4, height - crownH);

  // --- 1. Gaffelträdet som sträckor i en enhetsskala (huvudgrenarna 1 långa); varje sträcka böjs lite ---
  // seg: { pts: [[x,y,z]...], kids: [seg], main: seg|null }
  const STEPS = 4;
  const bendSeg = (p0, d0, L) => {
    const pts = [p0];
    let p = p0, d = d0;
    for (let i = 1; i <= STEPS; i++) {
      d = norm(add(add(d, mul(randomUnit(r), F.gnarl * 0.35)), mul(UP, (F.tropism - F.gravity) * 0.18)));
      p = add(p, mul(d, L / STEPS));
      pts.push(p);
    }
    return { pts, dir: d };
  };
  const grow = (p0, d0, L, order, az) => {
    const { pts, dir } = bendSeg(p0, d0, L);
    const seg = { pts, kids: [], main: null };
    if (order < F.orders) {
      const end = pts[pts.length - 1];
      const nextAz = az + rad(F.divergence);
      seg.main = grow(end, deflect(dir, rad(F.angleMain), az + Math.PI), L * F.ratioMain, order + 1, nextAz);
      seg.kids.push(grow(end, deflect(dir, rad(F.angleLateral * (0.85 + 0.3 * r())), az), L * F.ratioLateral, order + 1, nextAz));
    }
    return seg;
  };
  const base = [0, 0, 0];
  // Stammen till kronans bas (i enhetsskalan: bole räknas om när kronan skalas; här bara riktningen)
  const lean = norm([(r() - 0.5) * 0.06, 1, (r() - 0.5) * 0.06]);
  const az0 = r() * Math.PI * 2;
  const limbs = [];
  for (let i = 0; i < Math.max(1, F.limbs); i++) {
    const az = az0 + (i / F.limbs) * Math.PI * 2 + (r() - 0.5) * 0.5;
    // Den första huvudgrenen är stammens fortsättning (brantare), de andra går ut i limbAngle
    const ang = i === 0 && F.limbs > 1 ? rad(F.limbAngle * 0.35) : rad(F.limbAngle * (0.85 + 0.3 * r()));
    limbs.push(grow(base, deflect(lean, ang, az), i === 0 ? 1.05 : 1, 1, az + Math.PI / 2));
  }

  // --- 2. Skala kronan till sina mått i meter: skelettets bredd och höjd tar ~80 % av kronan, bollarna resten ---
  const all = [];
  const walk = (s) => { all.push(...s.pts); if (s.main) walk(s.main); s.kids.forEach(walk); };
  limbs.forEach(walk);
  const rx = Math.max(1e-3, ...all.map((p) => Math.hypot(p[0], p[2])));
  const hy = Math.max(1e-3, ...all.map((p) => p[1]));
  const kx = (F.crownWidth / 2) * F.fill / rx, ky = crownH * F.fill / hy; // fill: skelettets andel, bollarna resten
  const place = (p) => [p[0] * kx, bole + p[1] * ky, p[2] * kx];
  const mapSeg = (s) => { s.pts = s.pts.map(place); if (s.main) mapSeg(s.main); s.kids.forEach(mapSeg); };
  limbs.forEach(mapSeg);

  // --- 3. Tjocklek med da Vincis regel, från spetsarna inåt ---
  const tips = (s) => (s.main || s.kids.length ? [s.main, ...s.kids].filter(Boolean).reduce((a, x) => a + tips(x), 0) : 1);
  const nTips = limbs.reduce((a, s) => a + tips(s), 0);
  const want = F.trunkRadius;
  const P = F.pipe, tipR = want / Math.max(1, nTips) ** (1 / P);
  const radius = (s) => {
    const parts = [s.main, ...s.kids].filter(Boolean).map(radius);
    s.r = parts.length ? parts.reduce((a, x) => a + x ** P, 0) ** (1 / P) : tipR;
    return s.r;
  };
  limbs.forEach(radius);
  let trunkR = limbs.reduce((a, s) => a + s.r ** P, 0) ** (1 / P);
  // Exakt till trunkRadius (exponenten ger det bara ungefär när grenarna är olika stora)
  const fit = want / trunkR;
  const scaleR = (s) => { s.r *= fit; if (s.main) scaleR(s.main); s.kids.forEach(scaleR); };
  limbs.forEach(scaleR);
  trunkR = want;

  // --- 4. Kedjor: stammen + första huvudgrenen genom alla huvudgafflar; sidogrenar blir egna kedjor ---
  const branches = [];
  const resample = (pts) => {
    // Ungefär en led per spacing meter, ändarna kvar
    const out = [pts[0]];
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      run += len(sub(pts[i], pts[i - 1]));
      if (i === pts.length - 1 || run >= F.spacing) { out.push(pts[i]); run = 0; }
    }
    return out;
  };
  const segsFor = [20, 12, 8, 6, 5];
  // chain(first, parentIdx, t, level, startPts, startR): följer huvudgrenen; sidogrenarna köas med sin fogpunkt
  const chain = (first, parent, level, prefix = [], prefixR = []) => {
    const nodes = prefix.map((p, i) => ({ p, r: prefixR[i] }));
    const forks = [];
    for (let s = first; s; s = s.main) {
      const pts = resample(s.pts);
      const r0 = s.r * F.thickness, r1 = (s.main ? s.main.r : s.r * 0.75) * F.thickness;
      pts.forEach((p, i) => {
        if (nodes.length && i === 0) return; // fogen finns redan som förra sträckans sista led
        const k = pts.length > 1 ? i / (pts.length - 1) : 0;
        nodes.push({ p, r: r0 + (r1 - r0) * k });
      });
      if (!s.main) nodes.leafFrom = Math.max(1, nodes.length - pts.length);
      for (const kid of s.kids) forks.push({ kid, at: nodes.length - 1 });
    }
    const idx = branches.length;
    let length = 0;
    for (let i = 1; i < nodes.length; i++) length += len(sub(nodes[i].p, nodes[i - 1].p));
    branches.push({ level, nodes: nodes.map(({ p, r: rr }) => ({ p, r: rr })), parent, t: 0, segments: segsFor[Math.min(level, 4)],
      length, phase: r() * 6.283, terminal: !forks.length, leafFrom: nodes.leafFrom ?? Math.ceil((nodes.length - 1) * 0.5) });
    return { idx, nodes, forks };
  };
  // Stammen: rakt upp till kronans bas, sedan den första huvudgrenen
  const trunkPts = [];
  for (let i = 0; i <= Math.max(2, Math.round(bole / F.spacing)); i++) {
    const k = i / Math.max(2, Math.round(bole / F.spacing));
    trunkPts.push(add(mul(lean, bole * k * 0.02), [0, bole * k, 0]));
  }
  trunkPts[trunkPts.length - 1] = [0, bole, 0];
  const queue = [];
  const trunk = chain(limbs[0], -1, 0, trunkPts, trunkPts.map(() => trunkR * F.thickness));
  const baseAt = trunkPts.length - 1; // kronans bas: där de andra huvudgrenarna sitter
  for (const f of trunk.forks) queue.push({ seg: f.kid, parent: trunk.idx, at: f.at, level: 1 });
  for (const limb of limbs.slice(1)) queue.push({ seg: limb, parent: trunk.idx, at: baseAt, level: 1 });
  while (queue.length) {
    const q = queue.shift();
    const par = branches[q.parent];
    const joint = par.nodes[Math.min(q.at, par.nodes.length - 1)];
    // Kragen: sidogrenen börjar vidare och smalnar till sin egen radie, men aldrig tjockare än föräldern där
    const own = q.seg.r * F.thickness;
    const r0 = Math.min(joint.r * 0.95, own * F.collar), rMid = Math.min(joint.r * 0.9, own * (1 + (F.collar - 1) * 0.35));
    const c = chain(q.seg, q.parent, q.level, [joint.p], [r0]);
    const b = branches[c.idx];
    b.t = Math.min(q.at, par.nodes.length - 1) / Math.max(1, par.nodes.length - 1);
    if (b.nodes.length > 2) b.nodes[1].r = Math.max(b.nodes[1].r, Math.min(rMid, b.nodes[0].r));
    for (const f of c.forks) queue.push({ seg: f.kid, parent: c.idx, at: f.at, level: q.level + 1 });
  }
  const maxLevel = Math.max(...branches.map((b) => b.level));
  return { branches, twigs: twigsOf(branches, maxLevel), maxLevel, crownHeight: crownH, bole };
}
