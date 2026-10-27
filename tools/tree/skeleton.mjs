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
    // droopCurve: nästan ingen tyngd vid fästet och mycket mot spetsen, så grenen går ut och bågnar ner
    const grav = spec.droopCurve ? spec.gravity * (0.1 + 2.2 * t * t) : spec.gravity * (0.5 + t);
    d = norm(add(add(d, mul(randomUnit(r), spec.gnarl)), add(mul(UP, spec.photo * 0.5), mul(UP, -grav))));
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
  const trunk = { level: 0, nodes: grow([0, 0, 0], lean, T.length, r0, rTip, { ...T, gravity: 0 }, r, 0), parent: -1, t: 0, segments: T.segments, length: T.length, phase: r() * 6.283 };
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
          const k = L.whorls > 1 ? w / (L.whorls - 1) : 0; // en enda krans (palm) sitter vid start
          const t = L.start + (L.end - L.start) * k + (r() - 0.5) * 0.01;
          const cnt = Math.max(1, Math.round((pick(L.count, r) * (1 - k) + pick(L.countTop ?? L.count, r) * k) * (size.count ?? 1)));
          const rot = r() * Math.PI * 2;
          for (let j = 0; j < cnt; j++) slots.push({ t, k, az: rot + (j / cnt) * Math.PI * 2 + (r() - 0.5) * 0.3 });
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
        // angleTop: vinkeln kan ändras med höjden (gran: grenarna hänger brantare nedåt högre upp)
        const base = L.angleTop !== undefined && s.k !== undefined ? L.angle[0] + (L.angleTop - L.angle[0]) * s.k : L.angle[0];
        const ang = (base + (r() * 2 - 1) * L.angle[1]) * Math.PI / 180;
        const side = add(mul(b1, Math.cos(s.az)), mul(b2, Math.sin(s.az)));
        const dir = norm(add(mul(at.d, Math.cos(ang)), mul(side, Math.sin(ang))));
        const length = Math.max(L.minLength ?? 0, par.length * L.length * (1 - s.t * L.lenFalloff) * (0.85 + r() * 0.3));
        // Da Vincis regel i förenklad form: barnet är alltid smalare än föräldern där det sitter
        const cr0 = Math.min(at.r * L.radius, at.r * 0.85);
        const minRadius = Math.min(cr0, T.radius * (sp.minTwigRadius ?? 0.12));
        const nodes = grow(at.p, dir, length, cr0, cr0 * 0.2, { ...L, minRadius }, r, 0.05 * T.length);
        branches.push({ level, nodes, parent: pi, t: s.t, segments: L.segments, length, phase: r() * 6.283 });
        next.push(branches.length - 1);
      }
    }
    parents = next;
  });

  const maxLevel = Math.max(...branches.map((b) => b.level));
  return { branches, twigs: twigsOf(branches, maxLevel), maxLevel };
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

// Kvistpunkter för lövverket: yttre delen av de yngsta grenarna (och spetsarna)
export function twigsOf(branches, maxLevel) {
  const twigs = [];
  for (const b of branches) {
    if (b.level < Math.max(1, maxLevel) && !b.terminal) continue; // odlade skelett: alla kedjor utan barn bär löv
    const n = b.nodes.length - 1;
    for (let i = Math.ceil(n * 0.4); i <= n; i++) twigs.push(b.nodes[i].p);
  }
  return twigs;
}

// Stamhöjd: sträck (eller korta) den kala stammen under den lägsta grenen till höjden bole (meter) och flytta kronan
// upp lika mycket, oförändrad. Varje gren på stammen flyttas stelt med hela sitt underträd till sin nya fästpunkt,
// så att allt fortfarande sitter ihop. Körs efter scaleSkeleton; returnerar hur mycket kronan flyttades.
export function setBoleHeight(sk, bole) {
  const trunk = sk.branches[0];
  const firsts = sk.branches.filter((b) => b.parent === 0);
  if (!firsts.length || !(bole > 0)) return 0;
  const y0 = sampleBranch(trunk, Math.min(...firsts.map((b) => b.t))).p[1];
  const target = Math.max(bole, 0.15 * y0, 0.3);
  const dy = target - y0, k = target / y0;
  // Under den lägsta grenen sträcks stammen, ovanför flyttas den
  const old = trunk.nodes.map((n) => n.p);
  for (const n of trunk.nodes) n.p = n.p[1] <= y0 ? [n.p[0], n.p[1] * k, n.p[2]] : [n.p[0], n.p[1] + dy, n.p[2]];
  let L = 0;
  for (let i = 1; i < trunk.nodes.length; i++) L += len(sub(trunk.nodes[i].p, trunk.nodes[i - 1].p));
  trunk.length = L;
  const kids = new Map();
  sk.branches.forEach((b, i) => { if (b.parent >= 0) (kids.get(b.parent) ?? kids.set(b.parent, []).get(b.parent)).push(i); });
  const move = (bi, d) => {
    for (const n of sk.branches[bi].nodes) n.p = add(n.p, d);
    for (const c of kids.get(bi) ?? []) move(c, d);
  };
  for (const b of firsts) {
    const was = sampleBranch({ nodes: old.map((p) => ({ p, r: 0 })) }, b.t).p;
    move(sk.branches.indexOf(b), sub(sampleBranch(trunk, b.t).p, was));
  }
  sk.twigs = twigsOf(sk.branches, sk.maxLevel);
  return dy;
}

// Grenar utan barn smalnar av mot spetsen (sista leden till amount × radien), så att de inte slutar trubbigt.
// Bara grenar som inget sitter på, så att inget barn blir tjockare än sin förälder.
export function taperTips(sk, amount = 0.3) {
  const parents = new Set(sk.branches.map((b) => b.parent));
  sk.branches.forEach((b, i) => {
    if (b.level < 1 || parents.has(i) || b.nodes.length < 2) return;
    const n = b.nodes.length - 1;
    b.nodes[n].r *= amount;
    if (n >= 2) b.nodes[n - 1].r *= (1 + amount) / 2;
  });
}

// Beskär det som syns utanför lövverket: en grens ände efter dess sista barn klipps tillbaka så länge leden inte är
// dold (hidden), och en gren utan barn som inte har någon dold led alls tas bort. Upprepas, eftersom en förälder
// kan bli utan barn när dess barn tas bort. Barnens t räknas om när föräldern blir kortare, så att de sitter kvar
// på samma punkt. Returnerar antalet borttagna grenar och leder.
export function pruneHiddenEnds(sk, hidden) {
  let removedBranches = 0, removedNodes = 0;
  const gone = new Set();
  for (let changed = true; changed;) {
    changed = false;
    const kids = sk.branches.map(() => []);
    sk.branches.forEach((b, i) => { if (b.parent >= 0 && !gone.has(i)) kids[b.parent].push(i); });
    sk.branches.forEach((b, i) => {
      if (gone.has(i)) return;
      const n = b.nodes.length - 1;
      const lastKid = kids[i].reduce((m, k) => Math.max(m, sk.branches[k].t * n), 0);
      let m = n;
      while (m > Math.ceil(lastKid) && !hidden(b.nodes[m].p)) m--;
      if (m === n) return;
      if (m < 1 && !kids[i].length && b.level >= 1) { gone.add(i); removedBranches++; changed = true; return; }
      if (m < 1) m = 1;
      if (m === n) return;
      removedNodes += n - m;
      b.nodes = b.nodes.slice(0, m + 1);
      for (const k of kids[i]) sk.branches[k].t = Math.min(1, sk.branches[k].t * n / m);
      changed = true;
    });
  }
  if (gone.size) {
    const map = new Map();
    const keep = sk.branches.filter((_, i) => !gone.has(i));
    sk.branches.forEach((b, i) => { if (!gone.has(i)) map.set(i, map.size); });
    for (const b of keep) if (b.parent >= 0) b.parent = map.get(b.parent);
    sk.branches = keep;
  }
  return { pruned_branches: removedBranches, pruned_nodes: removedNodes };
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
