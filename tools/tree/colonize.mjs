// Odlat trädskelett (space colonization, Runions m.fl. 2007, efter patriks_input/AAA_Procedural_Trees_Plants_ThreeJS_Reference.md):
// attraktionspunkter strös ut i kronans form, och grenarna växer steg för steg mot de punkter som ligger närmast dem
// tills punkterna tagit slut. Kronan blir alltså grenarnas verk: där punkter saknas (luckor) växer inga grenar, och varje
// gren slutar där det finns ljus att nå. Radierna räknas sedan nerifrån och upp med pipe-modellen (förälderns tvärsnitt
// är summan av barnens, r = (Σ rᵢ^p)^(1/p)), så att stammen smalnar av vid varje förgrening och inget barn blir tjockare
// än sin förälder.
//
// Skelettet får samma form som buildSkeleton (grenar i kedjor med level, nodes, parent, t), så barken, alla
// lövverkstyper, LOD och vindriggen fungerar oförändrade. En kedja följer det tyngsta barnet (flest spetsar) vidare,
// de andra barnen blir egna grenar som börjar exakt på förälderns axel. Nivån är förgreningsordningen, högst 3.
// Kedjor utan barn är terminal: lövverket sätts på dem oavsett nivå.
//
// sp.growth = 'colonize', sp.colonize = { shape, width, crownStart, points, influence, kill, step, tropism, gravity,
// irregular, gaps, pipe, smooth }. Allt i enheter där trädet är 1 högt (skalas till höjden efteråt, som buildSkeleton).
// Ren JS utan Three.js/DOM.
import { add, sub, mul, dot, norm, len, UP, rng, randomUnit } from './vec.mjs';
import { twigsOf } from './skeleton.mjs';

export const SHAPES = ['round', 'oval', 'conical', 'umbrella', 'columnar', 'weeping', 'irregular'];

// Kronans radie (andel av width) vid höjden v (0 nederst i kronan, 1 i toppen)
function envelope(shape, v) {
  const round = Math.sqrt(Math.max(0, 1 - (2 * v - 1) ** 2));
  switch (shape) {
    case 'oval': return round ** 0.8 * 0.8;
    case 'conical': return Math.max(0, 1 - v) ** 0.9 * Math.min(1, v * 7);
    case 'umbrella': return Math.sin(Math.PI * Math.min(1, v ** 1.8)) ** 0.55;
    case 'columnar': return 0.45 * Math.sqrt(Math.sin(Math.PI * v));
    default: return round;
  }
}

const DEFAULTS = { shape: 'round', width: 0.5, crownStart: 0.38, points: 700, influence: 0.22, kill: 0.05, step: 0.034, tropism: 0.12, gravity: 0, irregular: 0.35, gaps: 0.3, pipe: 2.0, smooth: 5 };

export function colonizeSkeleton(sp, seed, size = {}) {
  const C = { ...DEFAULTS, ...(sp.colonize ?? {}) };
  if (C.shape === 'weeping') C.gravity = Math.max(C.gravity, 0.35);
  const r = rng(seed * 2654435761 + 7);
  const T = sp.trunk;
  const W = C.width, y0 = C.crownStart, irr = C.shape === 'irregular' ? Math.max(C.irregular, 0.6) : C.irregular;

  // --- Attraktionspunkterna: i kronans form, tätare mot ytan (där löven sitter), med några luckor ---
  const ph = [r() * 6.283, r() * 6.283, r() * 6.283];
  const lobe = (a) => 1 + irr * 0.35 * (Math.sin(3 * a + ph[0]) * 0.6 + Math.sin(5 * a + ph[1]) * 0.4);
  const holes = Array.from({ length: Math.round(C.gaps * 6) }, () => {
    const a = r() * 6.283, v = 0.25 + r() * 0.6, rr = W * envelope(C.shape, v) * (0.5 + r() * 0.5);
    return { p: [Math.cos(a) * rr, y0 + v * (1 - y0), Math.sin(a) * rr], rad: W * (0.14 + r() * 0.1) };
  });
  const lean = norm([(r() - 0.5) * 0.12, 1, (r() - 0.5) * 0.12]);
  const pts = [];
  const want = Math.round(C.points * (size.count ?? 1));
  for (let tries = 0; pts.length < want && tries < want * 60; tries++) {
    const x = (r() * 2 - 1) * W * 1.4, z = (r() * 2 - 1) * W * 1.4;
    // Hängande krona: ytterkanten fortsätter ned som ett draperi under kronans nederkant
    const yLow = C.shape === 'weeping' ? y0 * 0.45 : y0;
    const y = yLow + r() * (1 - yLow);
    const v = (y - y0) / (1 - y0), a = Math.atan2(z, x), d = Math.hypot(x, z);
    const R = W * (v >= 0 ? envelope(C.shape, v) : envelope(C.shape, 0.5) * 0.9) * lobe(a);
    if (d > R) continue;
    if (v < 0 && d < R * 0.75) continue; // draperiet är bara ett skal
    if (r() > 0.35 + 0.65 * (d / Math.max(R, 1e-6))) continue; // tätare ytterst
    const p = [x + lean[0] * y, y, z + lean[2] * y];
    if (holes.some((h) => len(sub(p, h.p)) < h.rad)) continue;
    pts.push(p);
  }

  // --- Noderna: en stam rakt upp till kronan, sedan växer alla noder mot sina punkter ---
  const nodes = [];
  const cell = C.influence, grid = new Map();
  const key = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  const addNode = (p, parent, dir) => {
    const n = { p, parent, dir, kids: [], i: nodes.length };
    nodes.push(n);
    if (parent) parent.kids.push(n);
    const k = key(p);
    (grid.get(k) ?? grid.set(k, []).get(k)).push(n);
    return n;
  };
  const near = (p, rad) => {
    const out = [], cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      for (const n of grid.get(`${cx + i},${cy + j},${cz + k}`) ?? []) if (len(sub(n.p, p)) < rad) out.push(n);
    }
    return out;
  };
  let tip = addNode([0, 0, 0], null, lean);
  while (tip.p[1] < y0 * 0.85) tip = addNode(add(tip.p, mul(norm(add(tip.dir, mul(randomUnit(r), T.gnarl ?? 0.1))), C.step)), tip, lean);

  let alive = pts.slice();
  for (let it = 0; it < 400 && alive.length; it++) {
    const pull = new Map();
    for (const p of alive) {
      let best = null, bd = C.influence;
      for (const n of near(p, C.influence)) { const d = len(sub(n.p, p)); if (d < bd) { bd = d; best = n; } }
      if (best) (pull.get(best) ?? pull.set(best, []).get(best)).push(p);
    }
    // Inga punkter inom räckhåll: stammen växer vidare uppåt mot kronan
    if (!pull.size) { tip = addNode(add(tip.p, mul(lean, C.step)), tip, lean); continue; }
    for (const [n, ps] of pull) {
      let d = [0, 0, 0];
      for (const p of ps) d = add(d, norm(sub(p, n.p)));
      d = norm(add(add(add(norm(d), mul(n.dir, 0.25)), mul(UP, C.tropism - C.gravity)), mul(randomUnit(r), 0.06)));
      // Samma riktning en gång till från samma nod ger bara en dubblett
      if (n.kids.some((k) => dot(norm(sub(k.p, n.p)), d) > 0.985) || n.kids.length >= 3) continue;
      addNode(add(n.p, mul(d, C.step)), n, d);
    }
    alive = alive.filter((p) => !near(p, C.kill).length);
  }

  // --- Utjämning: varje nod dras mot mitten av föräldern och barnen, så att grenarna flyter i stället för att
  // knycka vid varje tillväxtsteg (roten och spetsarna står still) ---
  for (let it = 0; it < C.smooth; it++) {
    const next = nodes.map((n) => {
      if (!n.parent || !n.kids.length) return n.p;
      const mean = n.kids.reduce((a, k) => add(a, k.p), [0, 0, 0]);
      return add(mul(n.p, 0.5), mul(add(n.parent.p, mul(mean, 1 / n.kids.length)), 0.25));
    });
    nodes.forEach((n, i) => { n.p = next[i]; });
  }

  // --- Pipe-modellen: radierna nerifrån och upp (barnen skapas alltid efter föräldern) ---
  const tipR = 1;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    n.tips = n.kids.length ? n.kids.reduce((s, k) => s + k.tips, 0) : 1;
    n.r = n.kids.length ? n.kids.reduce((s, k) => s + k.r ** C.pipe, 0) ** (1 / C.pipe) : tipR;
  }
  // Kvistarna får smalna av till några procent av stammen, annars slutar de trubbigt
  const k = T.radius / nodes[0].r, minR = T.radius * 0.035;
  for (const n of nodes) n.r = Math.max(minR, n.r * k);

  // --- Kedjor: följ det tyngsta barnet; de andra blir egna grenar som börjar på förälderns axel ---
  const segs = [T.segments ?? 12, ...(sp.levels ?? []).map((L) => L.segments ?? 5)];
  const branches = [];
  const chain = (start, parent, t, level, firstR) => {
    const list = [start];
    const side = [];
    for (let cur = start; cur.kids.length;) {
      const kids = [...cur.kids].sort((a, b) => b.tips - a.tips);
      for (const s of kids.slice(1)) side.push({ node: s, at: list.length - 1 });
      cur = kids[0];
      list.push(cur);
    }
    // Gles ut kedjan till ungefär ett led per C.spacing (tillväxtstegen är korta; varje led blir en barkring och, i
    // kvistarnas yttre del, en kvistpunkt för lövverket). Ändarna och alla förgreningar behålls, så att barnen sitter
    // exakt på sina leder
    // Stammen och grovgrenarna får tätare leder (mjukare böjar, naturligare stam) än kvistarna
    const space = (C.spacing ?? 0.07) * [0.3, 0.55, 0.8, 1][Math.min(level, 3)];
    const joints = new Set(side.map((x) => x.at));
    const keep = [0];
    let run = 0;
    for (let i = 1; i < list.length; i++) {
      run += len(sub(list[i].p, list[i - 1].p));
      if (i === list.length - 1 || joints.has(i) || run >= space) { keep.push(i); run = 0; }
    }
    const at = new Map(keep.map((i, j) => [i, j]));
    const nodesOut = keep.map((i, j) => ({ p: list[i].p, r: j === 0 && firstR !== undefined ? firstR : list[i].r }));
    let length = 0;
    for (let i = 1; i < list.length; i++) length += len(sub(list[i].p, list[i - 1].p));
    const idx = branches.length;
    branches.push({ level, nodes: nodesOut, parent, t, segments: segs[Math.min(level, segs.length - 1)] ?? 4, length, phase: r() * 6.283, terminal: !side.length });
    // Barnets första ring ligger i fogen (på förälderns axel), med barnets egen, mindre radie
    for (const s of side) chain2(list[s.at], s.node, idx, at.get(s.at) / Math.max(1, keep.length - 1), Math.min(level + 1, 3));
    return idx;
  };
  // En sidogren: börjar i fogen (på förälderns axel) och fortsätter i barnet
  const chain2 = (joint, child, parent, t, level) => {
    const fake = { p: joint.p, kids: [child], tips: child.tips, r: child.r };
    chain(fake, parent, t, level, Math.min(child.r, joint.r * 0.85));
  };
  chain(nodes[0], -1, 0, 0);
  branches.forEach((b) => { if (b.level > 0 && b.nodes.length < 2) b.nodes.push({ ...b.nodes[0] }); });
  const maxLevel = Math.max(...branches.map((b) => b.level));
  return { branches, twigs: twigsOf(branches, maxLevel), maxLevel, colonize: { points: pts.length, nodes: nodes.length } };
}
