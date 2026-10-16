// Trädskelett: stam och grenar i nivåer, där varje gren börjar EXAKT på sin förälders axel.
// Allt annat (bark, lövverk) byggs från skelettet, så att delarna alltid sitter ihop.
// Ren JS utan Three.js/DOM.
import { add, sub, mul, dot, norm, lerp, clamp01, UP, rng, randomUnit, basis, len } from './vec.mjs';

const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ~137.5°

// Position, radie och riktning längs en gren vid parameter t (0 = bas, 1 = spets)
export function sampleBranch(b, t) {
  const n = b.nodes.length - 1;
  const x = clamp01(t) * n, i = Math.min(n - 1, Math.floor(x)), f = x - i;
  const a = b.nodes[i], c = b.nodes[i + 1];
  return { p: lerp(a.p, c.p, f), r: a.r + (c.r - a.r) * f, d: norm(sub(c.p, a.p)) };
}

// Väx en gren sektion för sektion: krokighet, ljus (uppåt), gravitation (nedåt), markgräns
function grow(start, dir, length, r0, rTip, spec, r, groundY) {
  const nodes = [{ p: start, r: r0 }];
  let d = norm(dir), p = start;
  const step = length / spec.sections;
  // Mjuk böj med låg frekvens (S-kurva), i ett slumpat plan: ger den svängda stammen i referenserna
  const bendSide = norm([Math.cos(r() * 6.283), 0, Math.sin(r() * 6.283)]), bendPh = r() * 6.283;
  for (let i = 1; i <= spec.sections; i++) {
    const t = i / spec.sections;
    d = norm(add(add(d, mul(randomUnit(r), spec.gnarl)), add(mul(UP, spec.photo * 0.5), mul(UP, -spec.gravity * (0.5 + t)))));
    if (spec.bend) d = norm(add(d, mul(bendSide, spec.bend * Math.cos(t * Math.PI * (spec.bendFreq ?? 1.5) + bendPh))));
    // Grenar får inte gå ner i marken: böj uppåt nära marken
    if (p[1] + d[1] * step < groundY) d = norm([d[0], Math.max(d[1], 0.25), d[2]]);
    p = add(p, mul(d, step));
    // Minsta radie, så att kvistarna syns ända in i lövklumpen (annars ser klumpen ut att sväva)
    nodes.push({ p, r: Math.max(spec.minRadius ?? 0, r0 + (rTip - r0) * t ** 0.9) });
  }
  return nodes;
}

const pick = ([a, b], r) => Math.round(a + (b - a) * r());

/**
 * @param {object} sp  art ur species.json
 * @param {number} seed
 * @param {{count?: number}} size  multiplikator för antal grenar
 * @returns {{ branches: Array<{level, nodes, parent, t, segments, length}>, twigs: number[][] }}
 */
export function buildSkeleton(sp, seed, size = {}) {
  const r = rng(seed * 2654435761 + 1);
  const T = sp.trunk;
  const branches = [];
  const r0 = T.radius, rTip = T.radius * 0.18;
  const lean = norm([(r() - 0.5) * 0.08, 1, (r() - 0.5) * 0.08]);
  const trunk = { level: 0, nodes: grow([0, 0, 0], lean, T.length, r0, rTip, { ...T, gravity: 0 }, r, 0), parent: -1, t: 0, segments: T.segments, length: T.length };
  branches.push(trunk);

  let parents = [0];
  sp.levels.forEach((L, li) => {
    const level = li + 1;
    const next = [];
    for (const pi of parents) {
      const par = branches[pi];
      const slots = [];
      if (L.whorls) {
        // Kransar (gran): flera grenar på samma höjd, jämnt fördelade runt stammen
        for (let w = 0; w < L.whorls; w++) {
          const t = L.start + (L.end - L.start) * (w / (L.whorls - 1)) + (r() - 0.5) * 0.01;
          const k = w / (L.whorls - 1);
          const cnt = Math.max(1, Math.round((pick(L.count, r) * (1 - k) + pick(L.countTop ?? L.count, r) * k) * (size.count ?? 1)));
          const rot = r() * Math.PI * 2;
          for (let j = 0; j < cnt; j++) slots.push({ t, az: rot + (j / cnt) * Math.PI * 2 + (r() - 0.5) * 0.3 });
        }
      } else {
        const cnt = Math.max(1, Math.round(pick(L.count, r) * (size.count ?? 1)));
        let az = r() * Math.PI * 2;
        for (let j = 0; j < cnt; j++) {
          const t = L.start + (1 - L.start) * ((j + 0.3 + r() * 0.4) / cnt);
          az += GOLDEN + (r() - 0.5) * 0.4; // gyllene vinkeln: jämn spridning runt föräldern
          slots.push({ t: Math.min(0.97, t), az });
        }
      }
      for (const s of slots) {
        const at = sampleBranch(par, s.t);
        const [b1, b2] = basis(at.d);
        const ang = (L.angle[0] + (r() * 2 - 1) * L.angle[1]) * Math.PI / 180;
        const side = add(mul(b1, Math.cos(s.az)), mul(b2, Math.sin(s.az)));
        const dir = norm(add(mul(at.d, Math.cos(ang)), mul(side, Math.sin(ang))));
        const length = Math.max(L.minLength ?? 0, par.length * L.length * (1 - s.t * L.lenFalloff) * (0.85 + r() * 0.3));
        // Da Vincis regel i förenklad form: barnet är alltid smalare än föräldern där det sitter
        const cr0 = Math.min(at.r * L.radius, at.r * 0.85);
        const minRadius = Math.min(cr0, T.radius * (sp.minTwigRadius ?? 0.12));
        const nodes = grow(at.p, dir, length, cr0, cr0 * 0.2, { ...L, minRadius }, r, 0.05 * T.length);
        branches.push({ level, nodes, parent: pi, t: s.t, segments: L.segments, length });
        next.push(branches.length - 1);
      }
    }
    parents = next;
  });

  // Kvistpunkter för lövverket: yttre delen av de yngsta grenarna (och spetsarna)
  const maxLevel = Math.max(...branches.map((b) => b.level));
  const twigs = [];
  for (const b of branches) {
    if (b.level < Math.max(1, maxLevel)) continue;
    const n = b.nodes.length - 1;
    for (let i = Math.ceil(n * 0.4); i <= n; i++) twigs.push(b.nodes[i].p);
  }
  return { branches, twigs, maxLevel };
}

// Skala hela skelettet (positioner och radier) så att högsta punkten hamnar på höjden h
export function scaleSkeleton(sk, h, extraTop = 0) {
  let maxY = 0;
  for (const b of sk.branches) for (const n of b.nodes) maxY = Math.max(maxY, n.p[1]);
  const s = h / (maxY * (1 + extraTop));
  for (const b of sk.branches) {
    b.length *= s;
    for (const n of b.nodes) { n.p = mul(n.p, s); n.r *= s; }
  }
  sk.twigs = sk.twigs.map((p) => mul(p, s));
  return s;
}

// Korrekthetskontroller, så att ingen behöver titta på en bild för att veta att trädet hänger ihop
export function validateSkeleton(sk) {
  let disconnected = 0, thicker = 0, below = 0;
  for (const b of sk.branches) {
    for (const n of b.nodes) if (n.p[1] < -1e-6) below++;
    if (b.parent < 0) continue;
    const at = sampleBranch(sk.branches[b.parent], b.t);
    if (len(sub(at.p, b.nodes[0].p)) > 1e-6) disconnected++;
    if (b.nodes[0].r > at.r + 1e-9) thicker++;
  }
  return { branches: sk.branches.length, disconnected, thicker_than_parent: thicker, nodes_below_ground: below };
}
