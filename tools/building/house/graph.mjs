// Husets strukturgraf (docs/buildings.md, del 2): hustypens grammatik (houses.json) blir volymer, och volymerna blir
// väggspann, öppningar och skorstenar. Ren JavaScript; geometrin byggs ur grafen i gen_house.mjs.
//
//   const g = planHouse({ archetype, style, sty, seed });
//   g.vols    [{ id, rect (översta våningen), levelRects, levels, floors, top, roof, stone, ... }]
//   g.roof    taklösaren (roof.mjs)
//   g.walls   [{ v, level, face, yb, yt, pts: [[s, lo, hi], ...], runs: [[s0, s1], ...] }]   den synliga väggen
//   g.openings [{ kind: door | window, wall, s, y, w, h, shape, lit, shutters, flower, gable }]
//   g.chimneys [{ x, z, size, bottom, top }]
//
// Slumpen: en hash av (seed, nyckel) per beslut i stället för en löpande slumpföljd, så att ett nytt fönster inte
// ändrar taket (referensen §5, deterministic independent random streams).
import { solveRoof } from './roof.mjs';

function hash32(x) { x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return (x ^ (x >>> 16)) >>> 0; }
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
export const makeRand = (seed) => (key) => hash32((seed * 2654435761) ^ strHash(key)) / 4294967296;
const range = (r, key, v) => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] + (v[1] - v[0]) * r(key) : v);
const choose = (r, key, v) => (Array.isArray(v) ? v[Math.floor(r(key) * v.length) % v.length] : v);
const DEG = Math.PI / 180;

// Väggarna kring en rektangel: o = början, t = riktning längs väggen, n = utåt, len
export function rectFaces([x0, z0, x1, z1]) {
  return [
    { name: 'front', o: [x0, z1], t: [1, 0], n: [0, 1], len: x1 - x0 },
    { name: 'right', o: [x1, z1], t: [0, -1], n: [1, 0], len: z1 - z0 },
    { name: 'back', o: [x1, z0], t: [-1, 0], n: [0, -1], len: x1 - x0 },
    { name: 'left', o: [x0, z0], t: [0, 1], n: [-1, 0], len: z1 - z0 },
  ];
}
export const facePoint = (f, s, out = 0) => [f.o[0] + f.t[0] * s + f.n[0] * out, f.o[1] + f.t[1] * s + f.n[1] * out];
const inside = ([x0, z0, x1, z1], x, z) => x > x0 + 1e-4 && x < x1 - 1e-4 && z > z0 + 1e-4 && z < z1 - 1e-4;

export function planHouse({ archetype: A, style: ST, sty, seed = 0 }) {
  const r = makeRand(seed);
  const fh = A.floorHeight, plinth = range(r, 'plinth', A.plinth);
  const vols = [], byId = {};
  for (const spec of A.volumes) {
    if (spec.chance != null && r(`${spec.id}:chance`) > spec.chance) continue;
    const parent = spec.attach ? byId[spec.attach.to] : null;
    if (spec.attach && !parent) continue;
    const w = range(r, `${spec.id}:w`, spec.w), d = range(r, `${spec.id}:d`, spec.d);
    const floors = spec.floors?.rel != null ? parent.floors + spec.floors.rel : Math.round(range(r, `${spec.id}:floors`, spec.floors));
    let rect, side = null;
    if (!parent) rect = [-w / 2, -d / 2, w / 2, d / 2];
    else {
      side = choose(r, `${spec.id}:side`, spec.attach.side);
      const [px0, pz0, px1, pz1] = parent.levelRects[0], inset = spec.attach.inset ?? 0.3;
      const along = side === 'front' || side === 'back' ? [px0, px1] : [pz0, pz1], L = along[1] - along[0];
      const a = spec.attach.at === 'corner' ? (r(`${spec.id}:corner`) < 0.5 ? -0.5 : 0.5) : range(r, `${spec.id}:at`, spec.attach.at);
      const c = (along[0] + along[1]) / 2 + a * Math.max(0, L - w);
      if (side === 'front') rect = [c - w / 2, pz1 - inset, c + w / 2, pz1 - inset + d];
      else if (side === 'back') rect = [c - w / 2, pz0 + inset - d, c + w / 2, pz0 + inset];
      else if (side === 'right') rect = [px1 - inset, c - w / 2, px1 - inset + d, c + w / 2];
      else rect = [px0 + inset - d, c - w / 2, px0 + inset, c + w / 2];
    }
    const type = choose(r, `${spec.id}:roof`, spec.roof);
    let axis = spec.axis ?? 'auto';
    if (axis === 'across') axis = side === 'front' || side === 'back' ? 'z' : 'x';
    if (axis === 'auto') axis = rect[2] - rect[0] >= rect[3] - rect[1] ? 'x' : 'z';
    const maxPitch = type === 'pyramid' ? 72 : 64;
    const pitch = Math.min(maxPitch, range(r, `${spec.id}:pitch`, spec.pitch) * (ST.roof?.pitch ?? 1) ** 0.5) * DEG;
    const dir = { front: '+z', back: '-z', left: '-x', right: '+x' }[side ?? 'front'];
    // Utkragning: övervåningarna sticker ut på långsidorna (eller de sidor hustypen säger), en bit till per våning
    const jetty = ST.timber && ST.jetty ? (spec.jetty ?? 0) * (0.6 + 0.4 * sty.S) : 0;
    const jettySides = spec.jettySides ? [].concat(spec.jettySides) : axis === 'x' ? ['front', 'back'] : ['left', 'right'];
    const levels = Math.max(1, Math.ceil(floors - 1e-6));
    const levelRects = Array.from({ length: levels }, (_, l) => {
      const e = jetty * l, [x0, z0, x1, z1] = rect;
      return [x0 - (jettySides.includes('left') ? e : 0), z0 - (jettySides.includes('back') ? e : 0), x1 + (jettySides.includes('right') ? e : 0), z1 + (jettySides.includes('front') ? e : 0)];
    });
    const top = plinth + floors * fh * (spec.height ?? 1);
    const stone = r(`${spec.id}:stone`) < (spec.stone ?? 0) * (ST.timber ? 1 : 0.6);
    const V = { i: vols.length, id: spec.id, rect: levelRects[levels - 1], levelRects, levels, floors, fh, plinth, top, side, parent: parent?.i ?? null, stone, jetty, jettySides,
      roof: { type, axis, pitch, overhang: sty.overhang * (type === 'pyramid' ? 0.6 : 1), dir } };
    vols.push(V);
    byId[spec.id] = V;
  }
  const roof = solveRoof(vols);

  // --- Väggarna: per volym och våning, den del som syns (inte inne i en annan volym, upp till taket) ---
  const walls = [];
  for (const V of vols) for (let l = 0; l < V.levels; l++) {
    const yb = V.plinth + l * V.fh, isTop = l === V.levels - 1, yt = isTop ? V.top : V.plinth + (l + 1) * V.fh;
    for (const f of rectFaces(V.levelRects[l])) {
      if (f.len < 0.3) continue;
      // Gömd: inne i en annan volym (provpunkten strax utanför väggen ligger i den), upp till dess tak
      const hidden = (s) => { let m = -Infinity; const [x, z] = facePoint(f, s, 0.05); for (const W of vols) if (W !== V && inside(W.rect, x, z)) m = Math.max(m, roof.roofOf(W.i, x, z)); return m; };
      const hiAt = (s) => (isTop ? roof.roofOf(V.i, ...facePoint(f, s, -0.001)) : yt);
      const loAt = (s) => Math.max(yb, hidden(s));
      // Brytpunkter: ändarna, andra volymers kanter och där två takplan möts längs väggen
      const cand = new Set([0, f.len]);
      for (const W of vols) {
        for (const [x0, z0, x1, z1] of [W.rect, roof.vols[W.i].ext]) for (const c of f.t[0] ? [x0, x1] : [z0, z1]) {
          const s = f.t[0] ? (c - f.o[0]) / f.t[0] : (c - f.o[1]) / f.t[1];
          if (s > 0 && s < f.len) { cand.add(s - 1e-4); cand.add(s + 1e-4); }
        }
        const P = roof.vols[W.i].planes;
        for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
          // (Pi − Pj) längs väggen: linjärt i s
          const g = (s) => { const [x, z] = facePoint(f, s); return (P[i].a - P[j].a) * x + (P[i].b - P[j].b) * z + (P[i].c - P[j].c); };
          const g0 = g(0), g1 = g(f.len);
          if (Math.abs(g1 - g0) > 1e-9) { const s = (-g0 / (g1 - g0)) * f.len; if (s > 0 && s < f.len) cand.add(s); }
        }
      }
      let ss = [...cand].sort((a, b) => a - b);
      // Där väggens över- och underkant korsar varandra
      const pts = [];
      for (let k = 0; k < ss.length; k++) {
        const s = ss[k], lo = loAt(s), hi = hiAt(s);
        if (k > 0) {
          const [ps, plo, phi] = pts[pts.length - 1];
          if ((phi - plo) * (hi - lo) < 0) { const t = (phi - plo) / ((phi - plo) - (hi - lo)), sx = ps + (s - ps) * t; pts.push([sx, loAt(sx), hiAt(sx)]); }
        }
        pts.push([s, lo, hi]);
      }
      // Synliga körningar där väggen har hela våningens höjd (för fönster och dörrar)
      const runs = [];
      let start = null;
      for (let k = 0; k < pts.length; k++) {
        const ok = pts[k][1] <= yb + 0.02 && pts[k][2] >= yt - 0.02;
        if (ok && start === null) start = pts[k][0];
        if ((!ok || k === pts.length - 1) && start !== null) { const end = ok ? pts[k][0] : pts[k - 1][0]; if (end - start > 0.2) runs.push([start, end]); start = null; }
      }
      if (pts.some(([, lo, hi]) => hi - lo > 0.05)) walls.push({ v: V.i, level: l, isTop, face: f, yb, yt, pts, runs });
    }
  }

  // --- Öppningar: dörren på den främsta väggen, fönster i fack längs körningarna, gavelfönster högt upp ---
  const open = sty.open, ow = 0.95 * open, oh = 1.25 * open, dw = 1.15 * open, dh = Math.min(A.floorHeight - 0.4, 2.15 * open);
  const shape = ST.window?.shape ?? 'rect', openings = [];
  const front = walls.filter((W) => W.level === 0 && W.face.name === 'front' && W.runs.some(([a, b]) => b - a > dw + 0.8));
  const doorWall = front.sort((a, b) => b.face.o[1] - a.face.o[1] || Math.abs(a.face.o[0] + a.face.len / 2) - Math.abs(b.face.o[0] + b.face.len / 2))[0];
  const bay = 2.4 * open;
  walls.forEach((W, wi) => {
    const V = vols[W.v], rate = W.face.name === 'front' ? 0.9 : W.face.name === 'back' ? 0.45 : 0.65;
    for (const [s0, s1] of W.runs) {
      const L = s1 - s0, nb = Math.max(1, Math.floor((L - 0.4) / bay)), bw = (L - 0.4) / nb;
      let doorBay = -1;
      if (W === doorWall) { const mid = Array.from({ length: nb }, (_, i) => i).sort((a, b) => Math.abs(a - (nb - 1) / 2) - Math.abs(b - (nb - 1) / 2)); doorBay = mid.find((i) => bw >= dw + 0.5) ?? -1; }
      for (let i = 0; i < nb; i++) {
        const s = s0 + 0.2 + (i + 0.5) * bw, key = `${V.id}:${W.level}:${W.face.name}:${i}`;
        if (i === doorBay) { openings.push({ kind: 'door', wall: wi, s, y: W.yb, w: dw, h: Math.min(dh, W.yt - W.yb - 0.15), shape: ST.door?.shape ?? 'rect' }); continue; }
        const h = Math.min(oh, W.yt - W.yb - 0.75);
        if (bw < ow + 0.5 || h < 0.6 || r(key) > rate) continue;
        const y = W.yb + Math.min((W.yt - W.yb) * 0.34, W.yt - W.yb - h - 0.3);
        openings.push({ kind: 'window', wall: wi, s, y, w: ow, h, shape, lit: r(`${key}:lit`) < (ST.window?.lit ?? 0.6), shutters: shape !== 'strip' && r(`${key}:sh`) < (ST.window?.shutters ?? 0), flower: shape !== 'strip' && W.level > 0 && r(`${key}:fl`) < (ST.flowerboxes ?? 0) });
      }
    }
    // Gavelfönster: där väggen fortsätter upp i ett gavelröste, mitt på gaveln
    if (W.isTop && V.roof.type === 'gable') {
      const mid = W.face.len / 2, k = W.pts.findIndex(([s]) => s >= mid), p = W.pts[Math.max(0, k)];
      const rise = (p?.[2] ?? W.yt) - W.yt;
      if (rise > 1.7 && p[1] <= W.yt + 0.05 && r(`${V.id}:gablewin:${W.face.name}`) < 0.85)
        openings.push({ kind: 'window', wall: wi, s: mid, y: W.yt + rise * 0.22, w: ow * 0.75, h: Math.min(oh, rise * 0.42), shape: shape === 'strip' ? 'rect' : shape, gable: true, lit: r(`${V.id}:gl:${W.face.name}`) < 0.5 });
    }
  });

  // --- Skorstenar: längs huvudvolymens nock, där inget annat tak ligger högre ---
  const chimneys = [], M = vols[0], n = Math.round(range(r, 'chimneys', A.chimneys ?? [1, 1]));
  if (ST.chimney !== 'none') for (let i = 0; i < n; i++) {
    const [x0, z0, x1, z1] = M.rect, along = M.roof.axis === 'x';
    const t = (n === 1 ? (r('ch0') < 0.5 ? -1 : 1) * 0.28 : i ? 0.3 : -0.3) + (r(`ch${i}`) - 0.5) * 0.08;
    const off = (r(`chx${i}`) - 0.5) * 0.5;
    const x = along ? (x0 + x1) / 2 + t * (x1 - x0) : (x0 + x1) / 2 + off, z = along ? (z0 + z1) / 2 + off : (z0 + z1) / 2 + t * (z1 - z0);
    const size = 0.75 + 0.2 * sty.S, hs = size / 2;
    let roofTop = -Infinity; // det högsta taket över skorstenens fotavtryck (3 × 3 prov; nocken kan gå mitt emellan hörnen)
    for (const dx of [-hs, 0, hs]) for (const dz of [-hs, 0, hs]) roofTop = Math.max(roofTop, roof.heightAt(x + dx, z + dz));
    if (roof.roofOf(M.i, x, z) < roof.heightAt(x, z) - 0.05) continue; // under en annan volyms tak
    chimneys.push({ x, z, size, bottom: M.top - 1, top: roofTop + 0.9 + 0.3 * sty.S });
  }
  return { vols, roof, walls, openings, chimneys, plinth, fh };
}
