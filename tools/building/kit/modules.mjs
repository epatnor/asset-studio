// Byggsatsens moduler (docs/building-kit.md, nivå B och C): stenmur, hörn, fönster och dörr i sten, korsvirkesvägg,
// hörnstolpe, halv gavel, takfall och nock. Varje modul byggs i sina egna axlar (x längs väggen 0..W, y upp, z ut
// ur huset, yttersidan vid z = 0) av elementen i elements.mjs, och svarar med sina sockets. Ändarna styr hur
// modulen möter grannen: open (tandad fortsättning), corner (mot hörnmodulen), end (fri ände), verge (takets gavel).
import { makeRand } from '../house/graph.mjs';
import { aabbCorners } from './elements.mjs';

export const lin = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);
const DEG = Math.PI / 180;
const between = (r, key, [a, b]) => a + (b - a) * r(key);
const pickC = (r, key, list) => list[Math.floor(r(key) * list.length) % list.length];
const shade = (c, k) => c.map((x) => x * k);

// Murens skift: lika för hela familjen, så att murar, hörn och fönster möts i samma fogar
export function courses(F, H) {
  const r = makeRand(F.seed), mean = (F.course[0] + F.course[1]) / 2, n = Math.max(1, Math.round(H / mean));
  const hs = Array.from({ length: n }, (_, k) => between(r, `c${k}`, F.course) * (1 + F.courseTaper * (0.5 - k / Math.max(1, n - 1))));
  const s = H / hs.reduce((a, b) => a + b, 0);
  let y = 0;
  return hs.map((h) => { const c = [y, y + h * s]; y += h * s; return c; });
}
// Öppningen i skiftens fogar: underkant och överkant läggs i närmaste fog
export function openingCourses(C, op) {
  const near = (y) => C.reduce((best, c, k) => (Math.abs(c[0] - y) < Math.abs(C[best][0] - y) ? k : best), 0);
  const ks = op.sill <= 0 ? 0 : Math.max(1, near(op.sill)), kt = Math.max(ks + 2, Math.min(C.length - 1, near(op.top)));
  return { ks, kt, y0: C[ks][0], y1: C[kt][0] };
}

// ---------- Sten ----------
// En huggen sten i en cell: x-gränser nertill och upptill (sneda ändar mot ett valv), y0..y1. flush = ingen fog
// på den sidan (fri ände, smyg). dressed = tuktad sten (hörn, smyg, valv): rakare, ljusare, ingen kantstötning
function stone(E, F, ctx, key, c) {
  const { r } = ctx, m = F.mortar / 2, dressed = !!c.dressed;
  const ins = (k, side) => (c.flush?.[side] ? 0 : m + (dressed ? 0.003 : F.inset * r(`${key}i${k}`)));
  const zf = (c.project ?? 0) + (dressed ? 0.004 : between(r, `${key}z`, F.relief));
  const zb = c.full ? -c.t : -between(r, `${key}d`, F.depth);
  const C = [];
  for (let i = 0; i < 8; i++) {
    const bx = i & 1, by = (i >> 1) & 1, bz = (i >> 2) & 1;
    const xs = by ? [c.x0t ?? c.x0, c.x1t ?? c.x1] : [c.x0, c.x1];
    let x = bx ? xs[1] - ins(`x${i & 3}`, 1) : xs[0] + ins(`x${i & 3}`, 0);
    let y = by ? c.y1 - ins(`y${i & 3}`, 3) : c.y0 + ins(`y${i & 3}`, 2);
    if (!by && c.ground) y = -0.06;
    let z = bz ? zf + (dressed ? 0 : (r(`${key}f${i}`) - 0.5) * 0.012) : zb;
    C.push([x, y, z]);
  }
  const col = dressed ? shade(lin(F.dressed), 0.95 + 0.08 * r(`${key}b`)) : shade(lin(pickC(r, `${key}c`, F.colors)), 0.9 + 0.16 * r(`${key}b`));
  const chip = !dressed && r(`${key}ch`) < F.chip[0] ? [4 + Math.floor(r(`${key}cw`) * 4), F.chip[1]] : null;
  const dome = c.domes ?? [[2, 1, (dressed ? 0.35 : 0.5 + r(`${key}dm`)) * F.dome]];
  E.hexa('stone', C, { bevel: dressed ? F.bevel * 0.8 : F.bevel, chip, sub: [1, 1, c.domes ? 1 : 0], dome, skip: c.full || c.keepBack ? [] : ['-z'],
    color: col, jitter: dressed ? F.jitter * 0.4 : F.jitter, seed: ctx.seedN + ctx.n++, tile: F.tile, kind: c.kind ?? 'stone', exact: true, edgeLight: 1.18, grad: 0.12 });
}

// Lägg en skifts sträcka [a, b] med stenar. Fogarna hålls minst minOverlap från fogarna i skiftet under.
// first/last: krav på första och sista stenen (längd, tuktad, fri ände)
function fillRun(F, r, key, a, b, below, first, last) {
  const minL = F.stoneLen[0] * 0.75, out = [];
  const ok = (x) => below.every((j) => Math.abs(j - x) >= F.minOverlap);
  let lf = first?.len ?? null, ll = last?.len ?? null;
  const span = b - a;
  if (span <= (lf ?? 0) + (ll ?? 0) + 0.12) {
    // för kort för egna ändstenar: en eller två stenar
    if (span < F.stoneLen[1] * 1.15) return [{ x0: a, x1: b, first: true, last: true }];
    const mid = a + span / 2;
    return [{ x0: a, x1: mid, first: true }, { x0: mid, x1: b, last: true }];
  }
  let x = a;
  if (lf != null) { out.push({ x0: a, x1: a + lf, first: true }); x = a + lf; }
  const end = ll != null ? b - ll : b;
  let guard = 0;
  while (end - x > F.stoneLen[1] && guard++ < 40) {
    let best = null;
    for (let t = 0; t < 8; t++) {
      const L = between(r, `${key}L${x.toFixed(3)}${t}`, F.stoneLen), j = x + L;
      if (end - j < minL) continue;
      if (ok(j)) { best = L; break; }
      best ??= L;
    }
    best ??= Math.min(F.stoneLen[1], end - x - minL);
    out.push({ x0: x, x1: x + best });
    x += best;
  }
  if (end - x > 1e-6) {
    // sista biten i mitten: dela i två om fogen skulle hamna för nära en fog under
    if (end - x > F.stoneLen[0] * 1.6 && !ok(end) && ll == null) { const h = (end - x) / 2; out.push({ x0: x, x1: x + h }, { x0: x + h, x1: end }); }
    else out.push({ x0: x, x1: end });
  }
  if (ll != null) out.push({ x0: end, x1: b, last: true });
  if (out.length) { out[0].first = true; out.at(-1).last = true; }
  return out;
}

// Stenmur (även med fönster eller dörr) i en våning. spec: { ends: [l, r], opening, seed }
export function stoneWall(E, K, spec) {
  const F = K.families.stone, W = K.width, H = K.storey, t = F.thickness, T = F.tooth, q = F.quoin;
  const r = makeRand(spec.seed ?? 1), ctx = { r, n: 0, seedN: (spec.seed ?? 1) * 7919 };
  const C = courses(F, H), [le, re] = spec.ends ?? ['open', 'open'];
  const delta = (k) => (k % 2 ? T : -T);
  const L = (k) => (le === 'open' ? delta(k) : le === 'corner' ? (k % 2 ? t + q : t) : 0);
  const R = (k) => (re === 'open' ? W + delta(k) : re === 'corner' ? (k % 2 ? W - t : W - t - q) : W);
  const op = spec.opening ? { ...K.openings[spec.opening], kind: spec.opening } : null;
  let O = null;
  if (op) {
    const oc = openingCourses(C, op);
    O = { ...oc, x0: W / 2 - op.width / 2, x1: W / 2 + op.width / 2, e: 0.17, kind: op.kind };
  }
  const endReq = (kind, k) => {
    if (kind === 'open') return { len: between(r, `end${k}${kind}`, F.endLen) };
    if (kind === 'end' || kind === 'jamb') return { len: k % 2 ? 0.44 : 0.3, dressed: true, flush: true, full: true };
    return null;
  };
  let joints = [], jumpers = [];
  for (let k = 0; k < C.length; k++) {
    const [y0, y1] = C[k], a = L(k), b = R(k);
    // sträckor i skiftet: [a, b] minus öppningen, fönsterbänken, valvet och stenar från skiftet under som går två skift
    let runs = [{ a, b, fa: endReq(le === 'corner' ? 'corner' : le, k), fb: endReq(re === 'corner' ? 'corner' : re, k) }];
    const cut = (x0, x1, kindA, kindB) => {
      const next = [];
      for (const s of runs) {
        if (x1 <= s.a || x0 >= s.b) { next.push(s); continue; }
        if (x0 > s.a) next.push({ ...s, b: x0, fb: kindA ? endReq(kindA, k) : null, slantB: s.slantB });
        if (x1 < s.b) next.push({ ...s, a: x1, fa: kindB ? endReq(kindB, k) : null });
      }
      runs = next;
    };
    const inOpening = O && k >= O.ks && k < O.kt;
    if (inOpening) cut(O.x0, O.x1, 'jamb', 'jamb');
    if (O && O.ks > 0 && k === O.ks - 1) cut(O.x0 - 0.1, O.x1 + 0.1, null, null);
    if (O && k === O.kt) {
      cut(O.x0 - O.e, O.x1 + O.e, null, null);
      // stenarna bredvid valvet får sneda ändar mot kilstenarna
      for (const s of runs) { if (Math.abs(s.b - (O.x0 - O.e)) < 1e-9) s.slantB = O.x0; if (Math.abs(s.a - (O.x1 + O.e)) < 1e-9) s.slantA = O.x1; }
    }
    for (const j of jumpers.filter((j) => j.k === k)) cut(j.x0, j.x1, null, null);
    const newJoints = [];
    for (const [ri, s] of runs.entries()) {
      const stones = fillRun(F, r, `k${k}r${ri}`, s.slantA ?? s.a, s.slantB ?? s.b, joints, s.fa, s.fb);
      for (const [si, st] of stones.entries()) {
        const fa = st.first ? s.fa : null, fb = st.last ? s.fb : null;
        const dressed = !!(fa?.dressed || fb?.dressed);
        const c = { x0: st.x0, x1: st.x1, y0, y1, t, ground: k === 0, dressed, full: !!(fa?.full || fb?.full), flush: { 0: !!fa?.flush, 1: !!fb?.flush } };
        // sneda ändar mot valvet: nertill vid valvets fot, upptill ute vid valvets topp
        if (st.first && s.slantA != null) { c.x0 = s.slantA; c.x0t = s.a; }
        if (st.last && s.slantB != null) { c.x1 = s.slantB; c.x1t = s.b; }
        // ibland går en sten över två skift (inte vid ändar, öppningar eller översta skiftet)
        const plain = (kk) => !(O && kk >= (O.ks > 0 ? O.ks - 1 : 0) && kk <= O.kt);
        if (!st.first && !st.last && k + 1 < C.length - 1 && plain(k) && plain(k + 1) && r(`jump${k}${si}${ri}`) < F.jumper
          && st.x0 > Math.max(L(k + 1), 0) + 0.45 && st.x1 < Math.min(R(k + 1), W) - 0.45 && st.x1 - st.x0 < 0.55) {
          c.y1 = C[k + 1][1];
          jumpers.push({ k: k + 1, x0: st.x0, x1: st.x1 });
        }
        stone(E, F, ctx, `s${k}_${ri}_${si}`, c);
        newJoints.push(st.x0, st.x1);
      }
    }
    // skift med stenar som går upp från skiftet under: deras fogar räknas också
    for (const j of jumpers.filter((j) => j.k === k)) newJoints.push(j.x0, j.x1);
    joints = newJoints;
    // kärnan bakom stenarna (fogbruket som syns i fogarna), tandad som stenarna
    const zc = -F.mortarDepth, coreCol = lin(F.mortarColor);
    const coreRuns = inOpening ? [[a, O.x0], [O.x1, b]] : [[a, b]];
    for (const [ca, cb] of coreRuns) if (cb - ca > 1e-6) E.hexa('mortar', aabbCorners([ca, k === 0 ? -0.06 : y0, -t], [cb, y1, zc]), { bevel: 0, color: coreCol, tile: 1.5, kind: 'core', exact: true });
  }
  // Fönsterbänk, valv och själva fönstret eller dörren
  if (O) {
    const { x0, x1, ks, kt, y0, y1, e } = O;
    if (ks > 0) {
      const [sy0, sy1] = C[ks - 1];
      stone(E, F, ctx, 'sill', { x0: x0 - 0.1, x1: x1 + 0.1, y0: sy0, y1: sy1, dressed: true, project: 0.07, slopeTop: 0.0, t, keepBack: true, kind: 'sill' });
    }
    // valvet: kilstenar med radiella fogar, slutstenen i mitten sticker ut lite
    const n = 5, [ay0, ay1] = C[kt];
    for (let i = 0; i < n; i++) {
      const b0 = x0 + ((x1 - x0) * i) / n, b1 = x0 + ((x1 - x0) * (i + 1)) / n;
      const t0 = x0 - e + ((x1 - x0 + 2 * e) * i) / n, t1 = x0 - e + ((x1 - x0 + 2 * e) * (i + 1)) / n;
      const key = i === (n - 1) / 2;
      stone(E, F, ctx, `v${i}`, { x0: b0, x1: b1, x0t: t0, x1t: t1, y0: ay0, y1: ay1 + (key ? 0.0 : 0), dressed: true, project: key ? 0.035 : 0.012, t, full: true, kind: 'voussoir' });
    }
    const zc = -0.21;
    if (O.kind === 'door') doorLeaf(E, K, x0, x1, y1, zc, r);
    else windowFrame(E, K, x0, x1, y0, y1, zc, r);
    if (O.kind === 'door') stone(E, F, ctx, 'step', { x0: x0 - 0.12, x1: x1 + 0.12, y0: -0.08, y1: 0.08, dressed: true, project: 0.3, t: 0.4, keepBack: true, flush: { 2: true }, kind: 'step' });
  }
  const sock = (k) => (k === 'open' ? 'stone:open' : k === 'corner' ? null : 'end');
  return {
    sockets: [
      { type: le === 'corner' ? 'stone:cornerA' : sock(le), pos: [0, 0, 0], dir: [-1, 0, 0] },
      { type: re === 'corner' ? 'stone:cornerB' : sock(re), pos: [W, 0, 0], dir: [1, 0, 0] },
      { type: 'top', pos: [W / 2, H, 0], dir: [0, 1, 0] },
      { type: spec.base ?? 'ground', pos: [W / 2, 0, 0], dir: [0, -1, 0] },
    ],
    courses: C, opening: O && { x0: O.x0, x1: O.x1, y0: O.y0, y1: O.y1 },
  };
}

// Hörnet: en hörnkedja av tuktade stenar, varannan lång åt arm A (+x), varannan åt arm B (−z)
export function stoneCorner(E, K, spec) {
  const F = K.families.stone, H = K.storey, t = F.thickness, q = F.quoin, m = F.mortar / 2;
  const r = makeRand(spec.seed ?? 1), ctx = { r, n: 0, seedN: 104729 };
  const C = courses(F, H);
  C.forEach(([y0, y1], k) => {
    const lo = k % 2 ? [-0.006, k === 0 ? -0.06 : y0 + m, -t] : [-0.006, k === 0 ? -0.06 : y0 + m, -t - q + m];
    const hi = k % 2 ? [t + q - m, y1 - m, 0.006] : [t, y1 - m, 0.006];
    const Cc = aabbCorners(lo, hi);
    // lite ojämnt: hörnen jitteras inåt, inte utåt
    for (let i = 0; i < 8; i++) { Cc[i][0] += (i & 1 ? -1 : 0) * 0.004 * r(`q${k}${i}`); Cc[i][2] += (i & 4 ? 0 : 1) * 0.004 * r(`qz${k}${i}`); }
    E.hexa('stone', Cc, { bevel: F.bevel * 0.9, sub: [1, 1, 1], dome: [[2, 1, F.dome * 0.45], [0, -1, F.dome * 0.45]], color: shade(lin(F.dressed), 0.95 + 0.07 * r(`qc${k}`)),
      jitter: F.jitter * 0.4, seed: 5000 + k, tile: F.tile, kind: 'quoin', exact: true, edgeLight: 1.18, grad: 0.1 });
    // fogbruket bakom fogarna, lika långt in från båda ytorna
    const md = F.mortarDepth;
    E.hexa('mortar', aabbCorners([md, k === 0 ? -0.06 : y0, k % 2 ? -t : -t - q], [k % 2 ? t + q : t, y1, -md]), { bevel: 0, color: lin(F.mortarColor), tile: 1.5, kind: 'core', exact: true });
  });
  return {
    sockets: [
      { type: 'stone:armA', pos: [0, 0, 0], dir: [1, 0, 0] },
      { type: 'stone:armB', pos: [0, 0, 0], dir: [0, 0, -1] },
    ],
    courses: C,
  };
}

// ---------- Fönster och dörr (delas av sten och korsvirke) ----------
export function windowFrame(E, K, x0, x1, y0, y1, zc, r, o = {}) {
  const Wf = K.families.window, Tf = K.families.timber, fw = 0.075, fd = 0.1, col = lin(Wf.frame);
  const wood = (a, b, w, d = fd) => E.lumber('wood', a, b, w, d, { color: col, endColor: col, bevel: 0.012, kind: 'frame' });
  wood([x0 + fw / 2, y0, zc], [x0 + fw / 2, y1, zc], fw);
  wood([x1 - fw / 2, y0, zc], [x1 - fw / 2, y1, zc], fw);
  wood([x0 + fw, y0 + fw / 2, zc], [x1 - fw, y0 + fw / 2, zc], fw);
  wood([x0 + fw, y1 - fw / 2, zc], [x1 - fw, y1 - fw / 2, zc], fw);
  const ym = y0 + (y1 - y0) * 0.64, xm = (x0 + x1) / 2;
  wood([xm, y0 + fw, zc + 0.01], [xm, y1 - fw, zc + 0.01], 0.05, 0.07);
  wood([x0 + fw, ym, zc + 0.01], [x1 - fw, ym, zc + 0.01], 0.05, 0.07);
  // blyspröjs i rutor: tunna järnlister
  const metal = lin(Wf.metal);
  for (const [a0, a1] of [[x0 + fw, xm - 0.025], [xm + 0.025, x1 - fw]]) {
    const xc = (a0 + a1) / 2;
    E.hexa('metal', aabbCorners([xc - 0.008, y0 + fw, zc + 0.004], [xc + 0.008, ym - 0.025, zc + 0.016]), { bevel: 0, color: metal });
    E.hexa('metal', aabbCorners([xc - 0.008, ym + 0.025, zc + 0.004], [xc + 0.008, y1 - fw, zc + 0.016]), { bevel: 0, color: metal });
  }
  const lit = r('lit') < Wf.litChance;
  const gp = lit ? `glow:${Wf.lit}` : `glass:${Wf.glass}`;
  E.quad(gp, [[x0, y0, zc], [x1, y0, zc], [x1, y1, zc], [x0, y1, zc]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]], [1, 1, 1]);
  if (o.sillBoard) E.lumber('wood', [x0 - 0.06, y0 - 0.025, 0.0], [x1 + 0.06, y0 - 0.025, 0.0], 0.05, 0.2 + 0.1, { color: shade(lin(Tf.wood[0]), 0.95), endColor: lin(Tf.endGrain), kind: 'frame' });
}
function doorLeaf(E, K, x0, x1, y1, zc, r) {
  const Tf = K.families.timber, Wf = K.families.window, n = 4, w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const c = shade(lin(pickC(r, `dp${i}`, Tf.wood)), 0.7 + 0.12 * r(`db${i}`));
    E.lumber('wood', [x0 + w * (i + 0.5), 0.0, zc], [x0 + w * (i + 0.5), y1, zc], w - 0.008, 0.06, { color: c, endColor: c, bevel: 0.008, kind: 'door' });
  }
  const metal = lin(Wf.metal);
  for (const y of [0.45, y1 - 0.5]) E.hexa('metal', aabbCorners([x0 + 0.06, y - 0.03, zc + 0.03], [x1 - 0.06, y + 0.03, zc + 0.045]), { bevel: 0.005, color: metal });
  E.hexa('metal', aabbCorners([x1 - 0.2, 1.0, zc + 0.03], [x1 - 0.15, 1.08, zc + 0.08]), { bevel: 0.01, color: metal });
}

// ---------- Korsvirke ----------
// Bjälke i väggens plan: från (xa, ya) till (xb, yb), framsidan vid z = front
function timberBeam(E, F, r, key, a, b, w, d, front, o = {}) {
  const col = shade(lin(pickC(r, `${key}c`, F.wood)), 0.88 + 0.14 * r(`${key}b`));
  const sgn = r(`${key}w`) < 0.5 ? -1 : 1;
  return E.lumber('wood', [a[0], a[1], front - d / 2], [b[0], b[1], front - d / 2], w, d, { color: col, endColor: lin(F.endGrain),
    warp: sgn * F.warp * Math.min(1, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2), twist: (r(`${key}t`) - 0.5) * F.twist, kind: o.kind ?? 'beam', exact: !!o.exact, ...o });
}
// Putsfält mellan bjälkarna (lite indraget, lite kullrigt)
function plaster(E, F, lo, hi) {
  if (hi[0] - lo[0] < 1e-3 || hi[1] - lo[1] < 1e-3) return;
  E.hexa('plaster', aabbCorners(lo, hi), { bevel: 0.006, sub: [2, 2, 0], dome: [[2, 1, 0.008]], color: lin(F.plaster), tile: F.plasterTile, kind: 'plaster', exact: true, skip: ['-z'] });
}

export function timberWall(E, K, spec) {
  const F = K.families.timber, W = K.width, H = K.storey, t = F.thickness, pw = F.post, r = makeRand((spec.seed ?? 1) + 31);
  const [le, re] = spec.ends ?? ['open', 'open'];
  const xL = le === 'corner' ? F.corner : 0, xR = re === 'corner' ? W - F.corner : W;
  const front = 0.012, sillH = F.sill, plateY = H - F.plate;
  // syll och hammarband över hela modulen (skarven mot grannen hamnar under grannens stolpe)
  timberBeam(E, F, r, 'sill', [xL, sillH / 2], [xR, sillH / 2], sillH, t + front, front, { exact: true, extend: 0, warp: 0 });
  timberBeam(E, F, r, 'plate', [xL, plateY + F.plate / 2], [xR, plateY + F.plate / 2], F.plate, t + front, front, { exact: true, warp: 0 });
  const post = (key, xc, w = pw) => timberBeam(E, F, r, key, [xc, sillH], [xc, plateY], w, t + front - 0.004, front - 0.004, { exact: true });
  const pl = le === 'corner' ? xL : pw, pr = re === 'end' ? W - pw : xR;
  if (le !== 'corner') post('pL', pw / 2);
  if (re === 'end') post('pR', W - pw / 2);
  const bw = F.brace, bd = F.braceDepth, bf = front - 0.008;
  const brace = (key, a, b) => timberBeam(E, F, r, key, a, b, bw, bd, bf, { extend: bw * 0.6 });
  const zP = [-t + 0.03, -F.recess];
  const op = spec.opening ? K.openings[spec.opening] : null;
  if (!op) {
    // mittstolpe, regel, Andreaskors nertill och sparrar i V upptill (en "man" i fackverket)
    const xm = W / 2, mw = pw * 0.8, ry = 1.25, rh = F.rail;
    post('pM', xm, mw);
    timberBeam(E, F, r, 'railL', [pl, ry + rh / 2], [xm - mw / 2, ry + rh / 2], rh, t * 0.8, bf, { exact: true, warp: 0 });
    timberBeam(E, F, r, 'railR', [xm + mw / 2, ry + rh / 2], [pr, ry + rh / 2], rh, t * 0.8, bf, { exact: true, warp: 0 });
    for (const [s, a0, a1] of [['L', pl, xm - mw / 2], ['R', xm + mw / 2, pr]]) {
      brace(`x1${s}`, [a0, sillH], [a1, ry]);
      brace(`x2${s}`, [a0, ry], [a1, sillH]);
      if (s === 'L') brace(`u${s}`, [a0, ry + rh], [a1, plateY]); else brace(`u${s}`, [a1, ry + rh], [a0, plateY]);
    }
    plaster(E, F, [xL, sillH, zP[0]], [xR, plateY, zP[1]]);
  } else {
    const x0 = W / 2 - op.width / 2, x1 = W / 2 + op.width / 2, jw = 0.14, rh = 0.14, y0 = op.sill, y1 = op.top;
    post('jL', x0 - jw / 2, jw); post('jR', x1 + jw / 2, jw);
    timberBeam(E, F, r, 'wsill', [pl, y0 - rh / 2], [pr, y0 - rh / 2], rh, t * 0.85, bf, { exact: true, warp: 0 });
    timberBeam(E, F, r, 'whead', [pl, y1 + rh / 2], [pr, y1 + rh / 2], rh, t * 0.85, bf, { exact: true, warp: 0 });
    // Andreaskors under fönstret och sneda stag i sidofälten
    brace('xa', [x0, sillH], [x1, y0 - rh]); brace('xb', [x0, y0 - rh], [x1, sillH]);
    brace('sL', [pl, sillH], [x0 - jw, y0 - rh]); brace('sR', [pr, sillH], [x1 + jw, y0 - rh]);
    brace('hL', [pl, plateY], [x0 - jw, y1 + rh]); brace('hR', [pr, plateY], [x1 + jw, y1 + rh]);
    plaster(E, F, [xL, sillH, zP[0]], [xR, y0, zP[1]]);
    plaster(E, F, [xL, y1, zP[0]], [xR, plateY, zP[1]]);
    plaster(E, F, [xL, y0, zP[0]], [x0, y1, zP[1]]);
    plaster(E, F, [x1, y0, zP[0]], [xR, y1, zP[1]]);
    windowFrame(E, K, x0, x1, y0, y1, -0.07, r, { sillBoard: true });
  }
  const sock = (k, side) => (k === 'open' ? 'timber:open' : k === 'corner' ? `timber:corner${side}` : 'end');
  return {
    sockets: [
      { type: sock(le, 'A'), pos: [0, 0, 0], dir: [-1, 0, 0] },
      { type: sock(re, 'B'), pos: [W, 0, 0], dir: [1, 0, 0] },
      { type: 'top', pos: [W / 2, H, 0], dir: [0, 1, 0] },
      { type: 'storey', pos: [W / 2, 0, 0], dir: [0, -1, 0] },
    ],
  };
}

export function timberCorner(E, K, spec) {
  const F = K.families.timber, H = K.storey, t = F.corner, r = makeRand(77 + (spec.seed ?? 0));
  const col = shade(lin(F.wood[0]), 0.92);
  E.lumber('wood', [t / 2 - 0.012, 0, -t / 2 + 0.012], [t / 2 - 0.012, H, -t / 2 + 0.012], t + 0.024, t + 0.024, { depthAxis: [0, 0, 1], color: col, endColor: lin(F.endGrain), bevel: 0.03, twist: (r('tw') - 0.5) * F.twist, kind: 'beam', exact: true });
  return { sockets: [{ type: 'timber:armA', pos: [0, 0, 0], dir: [1, 0, 0] }, { type: 'timber:armB', pos: [0, 0, 0], dir: [0, 0, -1] }] };
}

// Halv gavel i korsvirke ovanpå väggen. Takets undersida: y = (d0 + dir·x)·tan(lutning), d0 = avståndet från
// takfoten vid x = 0. Stolpen i nocken (kungsstolpen) hör till den fallande halvan.
export function timberGable(E, K, spec) {
  const F = K.families.timber, Rf = K.families.roof, W = K.width, t = F.thickness, tn = Math.tan(Rf.pitch * DEG);
  const r = makeRand((spec.seed ?? 1) + 53), [le, re] = spec.ends ?? ['open', 'open'];
  const d0 = spec.d0 ?? 0, dir = spec.dir ?? 1, yT = (x) => (d0 + dir * x) * tn;
  const xa = le === 'corner' ? F.corner : 0, xb = re === 'corner' ? W - F.corner : W;
  const front = 0.012, bf = front - 0.008, bh = 0.18, rk = 0.16;
  timberBeam(E, F, r, 'gsill', [xa, bh / 2], [xb, bh / 2], bh, t + front, front, { exact: true, warp: 0 });
  // takbjälken längs takets undersida (en bit under den, vinkelrätt)
  const s = Math.sin(Math.atan(tn)), c = Math.cos(Math.atan(tn)), off = rk / 2 + 0.01;
  const P = (x) => [x - dir * s * off * 0, yT(x) - off / c];
  timberBeam(E, F, r, 'rake', P(xa), P(xb), rk, t + front, front, { warp: 0, extend: 0.05 });
  const top = (x) => yT(x) - (rk + 0.01) / c;
  if (dir < 0 && d0 >= Rf.run - 1e-6) timberBeam(E, F, r, 'king', [F.post / 2, bh], [F.post / 2, top(F.post / 2) + 0.02], F.post, t + front - 0.004, front - 0.004, { exact: true });
  const xm = W / 2;
  if (top(xm) - bh > 0.4) timberBeam(E, F, r, 'stud', [xm, bh], [xm, top(xm)], 0.15, t * 0.8, bf, {});
  // regel där gaveln är hög nog
  const ry = 1.15;
  const hiX = dir > 0 ? xb : xa;
  if (top(hiX) > ry + 0.5) {
    const xr = dir > 0 ? Math.max(xa, (ry + 0.3) / tn * 1 + (rk + 0.01) / c / tn - d0) : Math.min(xb, d0 - (ry + 0.3 + (rk + 0.01) / c) / tn);
    const [ra, rb] = dir > 0 ? [xr, xb - (dir < 0 ? 0 : 0)] : [xa + (d0 >= Rf.run - 1e-6 ? F.post : 0), xr];
    if (rb - ra > 0.3) timberBeam(E, F, r, 'grail', [ra, ry], [rb, ry], 0.14, t * 0.8, bf, { warp: 0 });
  }
  // putsen: trapets under takbjälken
  const pts = [[xa, bh], [xb, bh], [xb, Math.max(bh + 0.01, top(xb))], [xa, Math.max(bh + 0.01, top(xa))]];
  E.prism('plaster', pts, -t + 0.03, -F.recess, { color: lin(F.plaster), tile: F.plasterTile, kind: 'plaster' });
  const sock = (k) => (k === 'open' ? 'gable:open' : 'gable:corner');
  return { sockets: [{ type: sock(le), pos: [0, 0, 0], dir: [-1, 0, 0] }, { type: sock(re), pos: [W, 0, 0], dir: [1, 0, 0] }, { type: 'gable', pos: [W / 2, 0, 0], dir: [0, -1, 0] }] };
}

// ---------- Tak ----------
// Takets mått: undersidan av sparrarna går genom väggens ytterkant (z = 0, y = 0) och stiger mot nocken (z = −run)
export function roofFrame(Rf, run = Rf.run) {
  const th = Rf.pitch * DEG, tn = Math.tan(th), cs = Math.cos(th), sn = Math.sin(th);
  const [rw, rd] = Rf.rafter;
  const yU = (z) => -z * tn;
  const deckTop = (z) => yU(z) + (rd + Rf.deck) / cs;
  const n = [0, cs, sn]; // takets normal (framsidan)
  // punkt på takets lutning: s = sträcka uppför från takfotens kant, h = höjd över brädorna längs normalen
  const S0 = Rf.overhang;
  const at = (x, s, h = 0) => { const z = S0 - s * cs; return [x + 0, deckTop(z) + h * cs, z + h * sn]; };
  const sOf = (z) => (S0 - z) / cs;
  return { th, tn, cs, sn, rw, rd, yU, deckTop, n, at, sOf, run, zRidge: -run };
}

export function roofSlope(E, K, spec) {
  const Rf = K.families.roof, Tf = K.families.timber, W = K.width, r = makeRand((spec.seed ?? 1) + 97);
  const run = spec.run ?? Rf.run, R = roofFrame(Rf, run), [le, re] = spec.ends ?? ['open', 'open'];
  const vg = Rf.verge, xa = le === 'verge' ? -vg : 0, xb = re === 'verge' ? W + vg : W;
  const wood = (k) => shade(lin(pickC(r, `${k}c`, Tf.wood)), 0.86 + 0.14 * r(`${k}b`));
  const endG = lin(Tf.endGrain);
  // takets fotrem på väggen
  E.lumber('wood', [xa, 0.07, -0.16], [xb, 0.07, -0.16], 0.14, 0.28, { depthAxis: [0, 0, 1], color: wood('plate'), endColor: endG, kind: 'beam', exact: true });
  // sparrar: rakt avsågade (lodrätt) vid takfoten och mot nockbjälken
  const ov = Rf.overhang, zr = -run + Rf.ridgeBeam[0] / 2, { rw, rd, yU, cs } = R;
  const rafter = (x, key) => {
    const C = [];
    for (let i = 0; i < 8; i++) {
      const z = i & 1 ? zr : ov, top = (i >> 1) & 1, side = (i >> 2) & 1;
      C.push([x + (side ? rw / 2 : -rw / 2), yU(z) + (top ? rd / cs : 0), z]);
    }
    E.hexa('wood', C, { bevel: 0.014, grain: [0, R.sn, -R.cs], color: wood(key), endColor: endG, sub: [2, 0, 0], kind: 'rafter' });
  };
  for (let x = 0.25; x < W; x += Rf.rafterStep) rafter(x, `r${x}`);
  if (le === 'verge') rafter(-vg + 0.12, 'rvL');
  if (re === 'verge') rafter(W + vg - 0.12, 'rvR');
  // brädor (råspont) tvärs över sparrarna; syns underifrån vid takfoten
  const sTop = R.sOf(-run + 0.04), bdW = Rf.board;
  for (let s = 0, i = 0; s < sTop - 1e-6; s += bdW, i++) {
    const s1 = Math.min(sTop, s + bdW - 0.006), C = [];
    for (let k = 0; k < 8; k++) C.push(R.at(k & 1 ? xb : xa, k & 4 ? s1 : s, k & 2 ? 0 : -Rf.deck));
    E.hexa('wood', C, { bevel: 0.004, grain: [1, 0, 0], color: shade(wood(`b${i}`), 1.05), endColor: endG, kind: 'deck', skip: ['+y'] });
  }
  // takpannor i rader, förskjutna en halv panna varannan rad. Pannan över skarven hör till modulen till höger
  const [tw, tl, tt] = Rf.tile, ex = Rf.exposure, gap = Rf.gap, sEnd = R.sOf(-run + 0.05);
  const tiles = [];
  for (let row = 0; ; row++) {
    const s0 = -0.05 + row * ex;
    if (s0 > sEnd - 0.1) break;
    const len = Math.min(tl, sEnd - s0);
    const centers = [];
    const odd = row % 2;
    for (let i = 0; i < 6; i++) centers.push([odd ? i * tw : (i + 0.5) * tw, tw]);
    if (le === 'verge') { if (odd) centers.push([-0.75 * tw, tw / 2]); else centers.push([-0.5 * tw, tw]); }
    if (re === 'verge') { if (odd) centers.push([W, tw], [W + 0.75 * tw, tw / 2]); else centers.push([W + 0.5 * tw, tw]); }
    for (const [cx, w] of centers) {
      const key = `t${row}_${cx.toFixed(3)}`, ws = w - gap, ang = (r(`${key}a`) - 0.5) * 0.035, ds = (r(`${key}s`) - 0.5) * 0.024;
      const C = [];
      for (let k = 0; k < 8; k++) {
        const u = (k & 1 ? 0.5 : -0.5) * ws, v = k & 4 ? len : ds, hBase = k & 4 ? 0 : tt * 0.9;
        const x = cx + u * Math.cos(ang) - (v - len / 2) * Math.sin(ang) * 0.3, s = s0 + v + u * Math.sin(ang);
        C.push(R.at(x, s, hBase + (k & 2 ? tt : 0)));
      }
      const col = shade(lin(pickC(r, `${key}c`, Rf.colors)), (0.8 + 0.3 * r(`${key}b`)) * (r(`${key}o`) < 0.07 ? 0.7 : 1));
      E.hexa('tile', C, { bevel: 0, color: col, skip: ['-y', '+z'], tile: 0.5, kind: 'tile', grad: -0.22, gradAxis: 2 });
      tiles.push(C);
    }
  }
  // gavelns ände: vindskiva under pannornas kant, med en droppe (svarvad hängande knopp) vid takfoten
  for (const [side, on] of [[-1, le === 'verge'], [1, re === 'verge']]) {
    if (!on) continue;
    const xv = side < 0 ? -vg + 0.045 : W + vg - 0.045, [bt, bhgt] = Rf.bargeboard;
    const C = [];
    for (let k = 0; k < 8; k++) {
      const s = k & 1 ? R.sOf(-run) : -0.08, z = Rf.overhang - s * cs;
      const p = R.at(xv, s, 0);
      C.push([xv + (k & 4 ? bt / 2 : -bt / 2), (k & 2 ? p[1] : p[1] - bhgt / cs), k & 1 ? -run : z]);
    }
    E.hexa('wood', C, { bevel: 0.012, grain: [0, R.sn, -R.cs], color: wood(`barge${side}`), endColor: endG, sub: [3, 0, 0], kind: 'barge' });
    const foot = R.at(xv, -0.08, 0);
    E.lathe('wood', [xv, foot[1] - bhgt / cs - 0.32, foot[2] + 0.02], [[0, 0], [0.035, 0.03], [0.05, 0.1], [0.03, 0.17], [0.045, 0.24], [0.04, 0.32]], 8, { color: wood('drop'), tile: 0.5 });
  }
  const sock = (k) => (k === 'open' ? 'roof:open' : 'roof:verge');
  return {
    sockets: [
      { type: sock(le), pos: [0, 0, 0], dir: [-1, 0, 0] }, { type: sock(re), pos: [W, 0, 0], dir: [1, 0, 0] },
      { type: 'plate', pos: [W / 2, 0, 0], dir: [0, -1, 0] }, { type: 'slope', pos: [W / 2, 0, -run], dir: [0, 0, -1] },
    ],
    tiles, run,
  };
}

// Nocken: nockbjälke och nockpannor (rundade, med en vidare ände som ligger över nästa). Vid gaveln sticker
// nockbjälken ut och en svarvad spira står på nocken
export function roofRidge(E, K, spec) {
  const Rf = K.families.roof, Tf = K.families.timber, W = K.width, r = makeRand((spec.seed ?? 1) + 131);
  const run = spec.run ?? Rf.run, R = roofFrame(Rf, run), [le, re] = spec.ends ?? ['open', 'open'];
  const vg = Rf.verge, [bw, bh] = Rf.ridgeBeam, tt = Rf.tile[2];
  const xa = le === 'verge' ? -vg - 0.14 : 0, xb = re === 'verge' ? W + vg + 0.14 : W;
  const yBeamTop = (run - bw / 2) * R.tn + R.rd / R.cs;
  const col = shade(lin(Tf.wood[1]), 0.9);
  E.lumber('wood', [xa, yBeamTop - bh / 2, 0], [xb, yBeamTop - bh / 2, 0], bh, bw, { depthAxis: [0, 0, 1], color: col, endColor: lin(Tf.endGrain), kind: 'beam', exact: true, bevel: 0.025 });
  // pannornas ovansida d meter ut från nocken
  const T = R.rd + Rf.deck + 2 * tt;
  const yT = (d) => (run - d) * R.tn + T / R.cs;
  const yA = yT(0), cap = 0.43, step = 0.4;
  const starts = [];
  for (let x = 0; x < W - 1e-6; x += step) starts.push(x);
  if (le === 'verge') starts.unshift(-step);
  if (re === 'verge') starts.push(W);
  const ccol = lin(Rf.ridgeColor);
  for (const x0 of starts) {
    const C = [];
    for (let k = 0; k < 8; k++) {
      const end = k & 1, top = (k >> 1) & 1, side = k & 4 ? 1 : -1, bell = end ? 1 : 1.07;
      const z = side * (top ? 0.1 : 0.18) * bell, y = top ? yA + 0.1 * bell : yT(0.18) - 0.03;
      C.push([end ? Math.min(x0 + cap, xb - 0.1) : Math.max(x0, le === 'verge' ? -vg - 0.03 : x0), y, z]);
    }
    E.hexa('tile', C, { bevel: 0.012, sub: [0, 0, 2], dome: [[1, 1, 0.045]], skip: ['-y'], color: shade(ccol, 0.9 + 0.15 * r(`cap${x0}`)), tile: 0.9, kind: 'cap' });
  }
  if (le === 'verge') E.lathe('wood', [-vg + 0.02, yA + 0.12, 0], [[0.07, -0.05], [0.08, 0.05], [0.05, 0.14], [0.085, 0.24], [0.06, 0.32], [0.025, 0.42], [0.04, 0.5], [0, 0.66]], 8, { color: col, tile: 0.5 });
  if (re === 'verge') E.lathe('wood', [W + vg - 0.02, yA + 0.12, 0], [[0.07, -0.05], [0.08, 0.05], [0.05, 0.14], [0.085, 0.24], [0.06, 0.32], [0.025, 0.42], [0.04, 0.5], [0, 0.66]], 8, { color: col, tile: 0.5 });
  const sock = (k) => (k === 'open' ? 'ridge:open' : 'ridge:verge');
  return { sockets: [
    { type: sock(le), pos: [0, 0, 0], dir: [-1, 0, 0] }, { type: sock(re), pos: [W, 0, 0], dir: [1, 0, 0] },
    { type: 'ridge', pos: [W / 2, 0, 0], dir: [0, 0, 1] }, { type: 'ridge', pos: [W / 2, 0, 0], dir: [0, 0, -1] },
  ] };
}

export const BUILDERS = { stone_wall: stoneWall, stone_window: stoneWall, stone_door: stoneWall, stone_corner: stoneCorner,
  timber_wall: timberWall, timber_window: timberWall, timber_corner: timberCorner, timber_gable: timberGable, roof_slope: roofSlope, roof_ridge: roofRidge };
