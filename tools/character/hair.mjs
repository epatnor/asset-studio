// Hårgenerator: formen ger silhuett och volym, texturen ger strängarna. Ren JS.
//
// Slingor växer från hårbotten (samma hårlinje som hårfästet i outfit.mjs) längs styrkurvor: riktningen
// kommer från bena (bort från den), en svepning bakåt, lugg nära hårlinjen, lyft från huvudet och
// gravitation som ökar längs slingan. Varje steg trycks ut från närmaste yta (hud och kläder), så att
// håret aldrig sticker igenom. Runt kurvan sveps en avsmalnande, tillplattad ellips (den platta sidan mot
// huvudet) som slutar i en spets. UV löper längs slingan (V från rot mot topp), så att en sömlös
// strängtextur flyter rätt; hårfärgen ligger som tint i hörnfärgen, mörkare vid roten.
import { add, sub, mul, dot, cross, norm, len, lerp, rng } from '../tree/vec.mjs';
import { clauseField } from './outfit.mjs';

const linear = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const tangential = (d, n) => sub(d, mul(n, dot(d, n)));

// Närmaste ytpunkt med normal (rutnät över hörnen)
function surfaceIndex(points, normals, cell = 0.03) {
  const grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  points.forEach((p, i) => { const k = key(...p.map((c) => Math.floor(c / cell))); (grid.get(k) ?? grid.set(k, []).get(k)).push(i); });
  return (p) => {
    const [cx, cy, cz] = p.map((c) => Math.floor(c / cell));
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 2 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        for (const i of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) { const d = len(sub(p, points[i])); if (d < bd) { bd = d; best = i; } }
      }
    }
    return best < 0 ? null : { p: points[best], n: normals[best], d: bd };
  };
}

// body: { verts, normals, tris, joints, eyes }, headTris: huvudets trianglar (index i body.tris),
// collide: { points, normals } (hud och kläder), style: ur hair.json, color: #RRGGBB
export function buildHair(body, headTris, collide, style, color, seed = 1) {
  const { verts: V, normals: N, tris: T, joints: J } = body;
  const r = rng(seed * 977 + 13);
  const eyeY = body.eyes[0].center[1], top = Math.max(...V.map((p) => p[1]));
  const H = { top, eyeY, cx: J.Head[0], cz: J.Head[2], eyes: body.eyes };
  const scalp = clauseField({ scalp: style.scalp }, J, {}, H);
  const chinY = eyeY - (top - eyeY), headH = top - chinY;
  const near = surfaceIndex(collide.points, collide.normals);
  const tint = linear(color);

  // Hårbottnens trianglar (inom hårlinjen) med area, för slumpade rötter
  const scalpTris = headTris.filter((ti) => T[ti].every((v) => scalp(V[v]) <= 0));
  const area = scalpTris.map((ti) => { const [a, b, c] = T[ti].map((v) => V[v]); return len(cross(sub(b, a), sub(c, a))) / 2; });
  const total = area.reduce((s, x) => s + x, 0);
  const cdf = []; area.reduce((s, x, i) => (cdf[i] = s + x), 0);
  const sampleRoot = () => {
    const x = r() * total;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < x) lo = m + 1; else hi = m; }
    const [a, b, c] = T[scalpTris[lo]];
    let u = r(), w = r(); if (u + w > 1) { u = 1 - u; w = 1 - w; }
    const p = add(V[a], add(mul(sub(V[b], V[a]), u), mul(sub(V[c], V[a]), w)));
    const n = norm(add(add(mul(N[a], 1 - u - w), mul(N[b], u)), mul(N[c], w)));
    return { p, n, src: a };
  };

  const pos = [], nrm = [], col = [], uv = [], src = [], tris = [];
  const gap = style.gap ?? 0.006, part = style.part ?? { x: 0 }, fr = style.fringe;
  for (const layer of style.clumps) {
    // Rötter med ett minsta avstånd (pilkastning), så att slingorna fördelas jämnt
    const minD = Math.sqrt(total / layer.count) * 0.75;
    const roots = [];
    for (let tries = 0; roots.length < layer.count && tries < layer.count * 60; tries++) {
      const q = sampleRoot();
      if (roots.every((o) => len(sub(o.p, q.p)) > minD)) roots.push(q);
    }
    for (const root of roots) {
      // Region: fram, uppe, sidor, bak (för längd och lugg)
      const rel = sub(root.p, [H.cx, eyeY, H.cz]);
      const front = Math.max(0, norm([rel[0], 0, rel[2]])[2]), back = Math.max(0, -norm([rel[0], 0, rel[2]])[2]);
      const height = (root.p[1] - chinY) / headH;
      const lr = style.lengthRegion ?? {};
      const regionLen = (lr.top ?? 1) * Math.max(0, (height - 0.7) / 0.3) + (lr.front ?? 1) * front + (lr.back ?? 1) * back + (lr.side ?? 1) * (1 - front - back);
      const L = style.length * Math.max(0.15, regionLen / (1 + Math.max(0, (height - 0.7) / 0.3))) * (1 + (r() * 2 - 1) * (layer.lengthVar ?? 0.2));
      // Startriktning: bort från bena, bakåt, lugg fram; lyft från huvudet
      const side = Math.sign(root.p[0] - (part.x ?? 0)) || 1;
      let flow = add(add(mul([side, 0, 0], style.flow?.part ?? 0.5), mul([0, 0, -1], style.flow?.back ?? 0.5)), mul([0, -1, 0], style.flow?.down ?? 0.3));
      if (fr) {
        const f = Math.max(0, (front - (fr.from ?? 0.6)) / (1 - (fr.from ?? 0.6)));
        const fd = [fr.dir[0] * (fr.mirror ? side : 1), fr.dir[1], fr.dir[2]];
        flow = add(mul(flow, 1 - f), mul(fd, f * (fr.weight ?? 1) * 2));
      }
      let dir = norm(add(norm(tangential(flow, root.n)), mul(root.n, style.lift ?? 0.3)));
      // Väx styrkurvan
      const S = layer.segments ?? 10, step = L / S;
      const pts = [sub(root.p, mul(root.n, 0.003))];
      let p = root.p;
      let free = false; // lämnat hårbotten: gravitationen tar över direkt
      for (let s = 1; s <= S; s++) {
        const t = s / S;
        dir = norm(add(dir, mul([0, -1, 0], (style.gravity ?? 0.5) * (free ? 0.9 : t * 0.6))));
        p = add(p, mul(dir, step));
        // Ut från närmaste yta; över hårbotten dras slingan också mot huvudet (ligger an mot skallen med lite
        // volym) och följer dess rundning. Mot ansikte, hals och kropp bara kollision, så att den faller fritt.
        for (let it = 0; it < 3; it++) {
          const q = near(p);
          if (!q) break;
          const d = dot(sub(p, q.p), q.n), g = gap * (1 + t * 0.5);
          const want = g + (style.volume ?? 0.01) * (1 - 0.5 * t);
          if (d < g) {
            p = add(p, mul(q.n, g - d));
            dir = norm(add(tangential(dir, q.n), mul(q.n, 0.05)));
          } else if (scalp(q.p) <= 0.01 && d > want && q.d < want + 0.04) {
            p = sub(p, mul(q.n, (d - want) * 0.85));
            dir = norm(add(tangential(dir, q.n), mul(q.n, -0.02)));
          } else { if (scalp(q.p) > 0.01) free = true; break; }
        }
        pts.push(p);
      }
      // Våg i sidled längs slingan
      const wave = style.wave ?? { amp: 0, freq: 1 }, ph = r() * Math.PI * 2;
      // Ramar längs kurvan med parallelltransport från roten (den platta sidan mot huvudet där), så att
      // slingan inte vrider sig när den hänger nedanför huvudet
      const frames = [];
      let outT = norm(tangential(root.n, norm(sub(pts[1], pts[0]))));
      for (let s = 0; s <= S; s++) {
        const tan = norm(sub(pts[Math.min(S, s + 1)], pts[Math.max(0, s - 1)]));
        outT = norm(tangential(outT, tan));
        frames.push({ tan, out: outT, side: cross(tan, outT) });
      }
      const width = layer.width * (0.85 + r() * 0.3), flat = layer.flatten ?? 0.4;
      const K = 6, base = pos.length;
      const v0 = r() * 3, shade = 0.9 + r() * 0.15;
      let arc = 0;
      pts.forEach((c, s) => {
        const t = s / S;
        const { out, side: sideV } = frames[s];
        const cw = add(c, mul(sideV, wave.amp * Math.sin(t * wave.freq * Math.PI * 2 + ph) * t));
        if (s > 0) arc += len(sub(c, pts[s - 1]));
        // Avsmalning: lite fylligare upp till en tredjedel, sedan mot en spets
        const tipW = layer.tip ?? 0.2;
        const w = width * (0.85 + 0.3 * Math.sin(Math.min(1, t / 0.35) * Math.PI / 2)) * (tipW + (1 - tipW) * Math.pow(1 - t, 0.8));
        const shadeT = Math.pow(t, 0.7);
        for (let k = 0; k <= K; k++) {
          const a = (k / K) * Math.PI * 2;
          const o = add(mul(sideV, Math.cos(a) * w / 2), mul(out, Math.sin(a) * w * flat / 2));
          pos.push(add(cw, o)); nrm.push(norm(add(mul(sideV, Math.cos(a)), mul(out, Math.sin(a) * 0.8))));
          uv.push([k / K * (width / (style.texScale ?? 0.1)), v0 + arc / (style.texScale ?? 0.1)]);
          const g = (0.55 + 0.6 * shadeT) * shade;
          col.push(tint.map((x) => Math.min(1, x * g)));
          src.push([[root.src, 1]]);
        }
      });
      const ring = K + 1;
      for (let s = 0; s < S; s++) for (let k = 0; k < K; k++) {
        const a = base + s * ring + k, b = a + 1, c = a + ring, d = c + 1;
        tris.push([a, c, b], [b, c, d]);
      }
    }
  }
  // Vänd trianglarna utåt (jämför med hörnnormalerna)
  for (const t of tris) {
    const f = cross(sub(pos[t[1]], pos[t[0]]), sub(pos[t[2]], pos[t[0]]));
    if (dot(f, add(add(nrm[t[0]], nrm[t[1]]), nrm[t[2]])) < 0) t.reverse();
  }
  // Släta normaler ur geometrin
  const acc = pos.map(() => [0, 0, 0]);
  for (const [a, b, c] of tris) { const f = cross(sub(pos[b], pos[a]), sub(pos[c], pos[a])); for (const i of [a, b, c]) acc[i] = add(acc[i], f); }
  return {
    slot: 'hair', material: 'hair', kind: 'hair', texture: 'hair_strands', pos, nrm: acc.map(norm), col, uv, src,
    key: pos.map((_, i) => `hair,${i}`), tris, strip: tris.map(() => false),
    stats: { clumps: style.clumps.reduce((s, l) => s + l.count, 0), tris: tris.length },
  };
}
