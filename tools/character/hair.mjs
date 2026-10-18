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

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const srgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
// Färgzoner (sRGB, HSV): skuggan mörkare och mer mättad, högdagern ljusare och lite mindre mättad
function zones(hex, z = {}) {
  const [r, g, b] = srgb(hex), mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, sat = mx ? (mx - mn) / mx : 0;
  const h = mx === mn ? 0 : mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
  const hsv = (hh, ss, vv) => { const c = vv * ss, x = c * (1 - Math.abs((hh % 2) - 1)), m = vv - c; const [a, bb, cc] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]; return [a + m, bb + m, cc + m].map(toLin); };
  return {
    shadow: hsv(h, Math.min(1, sat * (z.shadowSat ?? 1.3) + 0.05), v * (z.shadow ?? 0.55)),
    base: hsv(h, sat, v),
    light: hsv(h, sat * 0.8, Math.min(1, v * (z.light ?? 1.3) + 0.08)),
  };
}
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
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
  // Skalets V vid en punkt (samma som outfit.mjs uvMode crown), så att lock och draperi fortsätter texturen där
  // skalet slutar i stället för att börja om med en mörk rot
  const capV = (p) => (style.cap.vMax ?? 0.55) * (1 - Math.min(1, Math.max(0, -scalp(p)) / (style.cap.uvDepth ?? 0.09)));
  const Z = zones(color, style.zones);
  const hl = style.highlight ?? { at: 0.86, width: 0.07, strength: 0.6 };

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

  // Styrkurva från en rot: startriktning längs flödet med lyft, gravitation som ökar längs längden (och tar
  // över när kurvan lämnat hårbotten), ut från närmaste yta; över hårbotten dras kurvan mot huvudet och
  // följer dess rundning, mot ansikte, hals och kropp bara kollision så att den faller fritt.
  const growGuide = (root, flow, L, S) => {
    let dir = norm(add(norm(tangential(flow, root.n)), mul(root.n, style.lift ?? 0.3)));
    const step = L / S;
    const pts = [sub(root.p, mul(root.n, 0.003))];
    let p = root.p, free = false;
    for (let s = 1; s <= S; s++) {
      const t = s / S;
      dir = norm(add(dir, mul([0, -1, 0], (style.gravity ?? 0.5) * (free ? 0.9 : t * 0.6))));
      p = add(p, mul(dir, step));
      pushOut: for (let it = 0; it < 3; it++) {
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
        } else { if (scalp(q.p) > 0.01) free = true; break pushOut; }
      }
      pts.push(p);
    }
    return pts;
  };
  // Rötter i en ring innanför hårlinjen vid givna vinklar (grader, 0 = rakt fram)
  const ringRoot = (at, th, cands) => {
    let best = -1, bd = Infinity;
    for (const v of cands) {
      const a2 = (Math.atan2(V[v][0] - H.cx, V[v][2] - H.cz) * 180) / Math.PI;
      const d = Math.abs(((a2 - th + 540) % 360) - 180);
      if (d < bd) { bd = d; best = v; }
    }
    return best < 0 ? null : { p: V[best], n: N[best], src: best };
  };
  const ringCands = (at) => [...new Set(scalpTris.flatMap((ti) => T[ti]))].filter((v) => Math.abs(-scalp(V[v]) - at * headH) < 0.035 * headH);

  const pos = [], nrm = [], col = [], uv = [], src = [], tris = [];
  const gap = style.gap ?? 0.006, part = style.part ?? { x: 0 }, fr = style.fringe;
  for (const layer of style.clumps ?? []) {
    const roots = [];
    if (layer.ring) {
      // Lock i en ring innanför hårlinjen: jämnt fördelade runt huvudet, at huvudhöjder innanför linjen.
      // skip: [från, till] i grader (0 = rakt fram) där ringen inte har lock (t.ex. ansiktet); only: bara där.
      const { at, count, phase = 0, skip, only } = layer.ring;
      const cands = [...new Set(scalpTris.flatMap((ti) => T[ti]))].filter((v) => Math.abs(-scalp(V[v]) - at * headH) < 0.035 * headH);
      for (let k = 0; k < count; k++) {
        const th = ((phase + (360 * k) / count + 540) % 360) - 180;
        if (skip && th >= skip[0] && th <= skip[1]) continue;
        if (only && (th < only[0] || th > only[1])) continue;
        let best = -1, bd = Infinity;
        for (const v of cands) {
          const a2 = (Math.atan2(V[v][0] - H.cx, V[v][2] - H.cz) * 180) / Math.PI;
          const d = Math.abs(((a2 - th + 540) % 360) - 180);
          if (d < bd) { bd = d; best = v; }
        }
        if (best >= 0) roots.push({ p: V[best], n: N[best], src: best });
      }
    } else {
      // Rötter med ett minsta avstånd (pilkastning), så att slingorna fördelas jämnt
      const minD = Math.sqrt(total / layer.count) * 0.75;
      for (let tries = 0; roots.length < layer.count && tries < layer.count * 60; tries++) {
        const q = sampleRoot();
        if (roots.every((o) => len(sub(o.p, q.p)) > minD)) roots.push(q);
      }
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
      // Rama in ansiktet: främre slingor vid sidorna vinklas utåt längs ansiktet i stället för framåt
      const sideAmt = Math.min(1, Math.abs(rel[0]) / 0.05);
      flow = add(flow, mul([Math.sign(rel[0]) || 1, 0, -0.3], (style.frameFace ?? 0) * front * sideAmt));
      if (fr) {
        const f = Math.max(0, (front - (fr.from ?? 0.6)) / (1 - (fr.from ?? 0.6)));
        const fd = [fr.dir[0] * (fr.mirror ? side : 1), fr.dir[1], fr.dir[2]];
        flow = add(mul(flow, 1 - f), mul(fd, f * (fr.weight ?? 1) * 2));
      }
      const S = layer.segments ?? 10;
      const pts = growGuide(root, flow, L, S);
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
      const total = pts.reduce((acc, q, i) => acc + (i ? len(sub(q, pts[i - 1])) : 0), 0) || 1;
      pts.forEach((c, s) => {
        const t = s / S;
        const { out, side: sideV } = frames[s];
        const cw = add(c, mul(sideV, wave.amp * Math.sin(t * wave.freq * Math.PI * 2 + ph) * t));
        if (s > 0) arc += len(sub(c, pts[s - 1]));
        // Avsmalning: lite fylligare upp till en tredjedel, sedan mot en spets
        const tipW = layer.tip ?? 0.2;
        const w = width * (0.85 + 0.3 * Math.sin(Math.min(1, t / 0.35) * Math.PI / 2)) * (tipW + (1 - tipW) * Math.pow(1 - t, 0.8));
        const shadeT = Math.pow(t, 0.7);
        // Glansring: ett brutet ljusband runt huvudet i höjd hl.at (huvudhöjder), där ljuset träffar
        const hh = (cw[1] - chinY) / headH;
        const band = hl.strength * (1 - smoothstep(0, hl.width, Math.abs(hh - hl.at))) * (0.6 + 0.4 * Math.sin(ph * 3 + t * 5));
        for (let k = 0; k <= K; k++) {
          const a = (k / K) * Math.PI * 2;
          const o = add(mul(sideV, Math.cos(a) * w / 2), mul(out, Math.sin(a) * w * flat / 2));
          pos.push(add(cw, o)); nrm.push(norm(add(mul(sideV, Math.cos(a)), mul(out, Math.sin(a) * 0.8))));
          // U över bredden (upprepas), V från roten (0) till toppen (1): texturens rötter, ljusband och toppar hamnar rätt
          const vr = capV(root.p);
          uv.push([v0 + (k / K) * (width / (style.texU ?? 0.35)), vr + (1 - vr) * (arc / total)]);
          // Rot mot topp: skugga till bas; över slingan: mörkare kanter och undersida, ljusast mitt på ovansidan
          const up = Math.sin(a), edge = up >= 0 ? 0.78 + 0.22 * up : 0.7;
          let c = mix(Z.shadow, Z.base, smoothstep(0, 0.45, shadeT)).map((x) => x * edge * shade);
          if (up > 0.2) c = mix(c, Z.light, band * up);
          col.push(c.map((x) => Math.min(1, x)));
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
  // Draperi: en sammanhängande skiva från en båge av hårlinjen (vinklar from..to i grader, 0 = rakt fram,
  // genom 180 = bak). Kurvorna jämnas ut i sidled mot varandra så att skivan hänger ihop, och sys ihop till en
  // yta med tjocklek, slutna kanter och UV längs fallet. Färg som locken: skugga vid roten, glansring.
  for (const sh of style.sheets ?? []) {
    // at: [vid sidorna, bak] i huvudhöjder innanför hårlinjen; bak sitter rötterna högre (mot hjässan)
    const [atSide, atBack] = Array.isArray(sh.at) ? sh.at : [sh.at, sh.at];
    const n = sh.guides, S = sh.segments ?? 10;
    const span = ((sh.to - sh.from) + 360) % 360 || 360;
    const roots = [];
    const candCache = new Map();
    for (let k = 0; k < n; k++) {
      const th = sh.from + (span * k) / (n - 1);
      const at = atSide + (atBack - atSide) * Math.max(0, -Math.cos((th * Math.PI) / 180));
      const key = at.toFixed(2);
      if (!candCache.has(key)) candCache.set(key, ringCands(at));
      const q = ringRoot(at, th, candCache.get(key));
      if (q) roots.push(q);
    }
    const G = roots.map((root) => {
      const rad = norm([root.p[0] - H.cx, 0, root.p[2] - H.cz]);
      const flow = add(add(mul(rad, sh.radial ?? 0.3), mul([0, -1, 0], sh.down ?? 1)), mul([0, 0, -1], sh.back ?? 0.2));
      // lengthScale: [vid sidorna, bak]; kortare vid sidorna så att håret slutar vid axlarna i stället för att
      // lägga sig över dem, längre bak ned längs ryggen
      const [ls, lb] = sh.lengthScale ?? [1, 1];
      const relLen = ls + (lb - ls) * Math.max(0, -norm([root.p[0] - H.cx, 0, root.p[2] - H.cz])[2]);
      const g = growGuide(root, flow, sh.length * relLen, S);
      g[0] = sub(root.p, mul(root.n, sh.rootInset ?? 0.01)); // roten under skalets yta
      return g;
    });
    // Utjämning i sidled (inte roten) med Taubin (växlande +λ och −μ, så att skivan inte krymper), och ut
    // från ytorna igen
    for (let it = 0; it < 2 * (sh.smooth ?? 4); it++) {
      const w = it % 2 ? -0.53 : 0.5;
      const next = G.map((g) => g.map((p) => p));
      for (let k = 1; k < G.length - 1; k++) for (let s = 1; s <= S; s++) next[k][s] = add(G[k][s], mul(sub(lerp(G[k - 1][s], G[k + 1][s], 0.5), G[k][s]), w));
      // även längs fallet (inte roten och toppen), så att kollisionen mot axlarna inte ger knyckar
      for (let k = 0; k < G.length; k++) for (let s = 2; s < S - 1; s++) next[k][s] = add(next[k][s], mul(sub(lerp(G[k][s - 1], G[k][s + 1], 0.5), G[k][s]), w * 0.6));
      for (let k = 0; k < G.length; k++) for (let s = 1; s <= S; s++) {
        const q = near(next[k][s]);
        if (q) { const d = dot(sub(next[k][s], q.p), q.n); if (d < gap) next[k][s] = add(next[k][s], mul(q.n, gap - d)); }
        G[k][s] = next[k][s];
      }
    }
    // Ytan: ytter- och innerskikt med tjocklek längs skivans normal (bort från huvudets mitt)
    const headC = [H.cx, eyeY, H.cz];
    const base = pos.length, rows = G.length, cols = S + 1;
    const ts = style.texScale ?? 0.15;
    const at = (k, s) => G[k][s];
    const ph = r() * 6;
    for (const layerSide of [1, -1]) {
      for (let k = 0; k < rows; k++) {
        let arc = 0;
        const total = G[k].reduce((acc, q, i) => acc + (i ? len(sub(q, G[k][i - 1])) : 0), 0) || 1;
        for (let s = 0; s < cols; s++) {
          const t = s / S, p = at(k, s);
          if (s > 0) arc += len(sub(p, at(k, s - 1)));
          const along = norm(sub(at(k, Math.min(S, s + 1)), at(k, Math.max(0, s - 1))));
          const across = norm(sub(at(Math.min(rows - 1, k + 1), s), at(Math.max(0, k - 1), s)));
          let nn = norm(cross(across, along));
          if (dot(nn, sub(p, headC)) < 0) nn = mul(nn, -1);
          const edgeT = Math.min(1, Math.min(k, rows - 1 - k) / 2.5);
          // Tunn vid roten (glider ut ur skalet), full tjocklek efter en sjättedel, tunnare mot toppen
          const th = (sh.thickness ?? 0.015) * Math.min(1, 0.2 + t * 5) * (1 - 0.6 * t) * (0.15 + 0.85 * edgeT) / 2;
          pos.push(add(p, mul(nn, th * layerSide))); nrm.push(mul(nn, layerSide));
          const vr = capV(roots[k].p);
          uv.push([(k / (rows - 1)) * (sh.width ?? 0.4) / (style.texU ?? 0.35), vr + (1 - vr) * (arc / total)]);
          const hh = (p[1] - chinY) / headH;
          const band = hl.strength * (1 - smoothstep(0, hl.width, Math.abs(hh - hl.at))) * (0.7 + 0.3 * Math.sin(ph + k * 0.9));
          let c = mix(Z.shadow, Z.base, smoothstep(0, 0.35, t));
          if (layerSide < 0) c = c.map((x) => x * 0.75);
          else c = mix(c, Z.light, band);
          col.push(c.map((x) => Math.min(1, x)));
          src.push([[roots[k].src, 1]]);
        }
      }
    }
    const idx = (side, k, s) => base + (side === 1 ? 0 : rows * cols) + k * cols + s;
    for (let k = 0; k < rows - 1; k++) for (let s = 0; s < S; s++) {
      tris.push([idx(1, k, s), idx(1, k + 1, s), idx(1, k + 1, s + 1)], [idx(1, k, s), idx(1, k + 1, s + 1), idx(1, k, s + 1)]);
      tris.push([idx(-1, k, s), idx(-1, k + 1, s + 1), idx(-1, k + 1, s)], [idx(-1, k, s), idx(-1, k, s + 1), idx(-1, k + 1, s + 1)]);
    }
    // Kanter: sidorna och nederkanten
    for (let s = 0; s < S; s++) for (const k of [0, rows - 1]) tris.push([idx(1, k, s), idx(-1, k, s), idx(-1, k, s + 1)], [idx(1, k, s), idx(-1, k, s + 1), idx(1, k, s + 1)]);
    for (let k = 0; k < rows - 1; k++) tris.push([idx(1, k, S), idx(-1, k, S), idx(-1, k + 1, S)], [idx(1, k, S), idx(-1, k + 1, S), idx(1, k + 1, S)]);
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
    slot: 'hair', material: 'hair', kind: 'hair', texture: style.texture ?? 'hair_strands', alphaMask: !!style.alphaTips, pos, nrm: acc.map(norm), col, uv, src,
    key: pos.map((_, i) => `hair,${i}`), tris, strip: tris.map(() => false),
    stats: { locks: (style.clumps ?? []).reduce((s2, l) => s2 + (l.ring?.count ?? l.count ?? 0), 0), sheets: (style.sheets ?? []).length, tris: tris.length },
  };
}
