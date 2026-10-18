// Kroppen som avståndsfält, byggd från skelettet: rundade koner för lemmar, hals och muskelstråk, och
// orienterade ellipsoider för bål, huvud, ansikte, händer och fötter. Delarna smälts ihop med polynomisk
// smooth-min, och varje del har sitt eget k: stort där kroppen böjer (mjuka gradienter), litet mellan
// fingrarna. Fältet skärs vid y = 0 så att sulorna blir plana. Ren JS.
//
// Varje primitiv bär bone (skelettets ben, för vikterna) och part (kroppsdel, för kläder och färg).
import { add, sub, mul, dot, cross, norm, lerp } from '../tree/vec.mjs';

const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// Ortonormal bas med ey längs dir och ex så nära hint som möjligt
function frame(dir, hint) {
  const ey = norm(dir);
  const ex = norm(sub(hint, mul(ey, dot(hint, ey))));
  return [ex, ey, cross(ex, ey)];
}

export function buildBody(sk, a) {
  const { joints: J, tips, dirs, W, hH: h, dims: D } = sk;
  const b = Math.sqrt(sk.build);
  const prims = [];
  const ell = (c, r, o, axes = AXES) => prims.push({ t: 0, c, r, ax: axes, ...o });
  const cone = (p, q, r1, r2, o) => prims.push({ t: 1, a: p, b: q, r1, r2, ...o });
  const kBody = 0.15 * W, kJoint = 0.08 * W;

  // Bål
  const torso = D.torso;
  ell([0, D.hipY + 0.02 * torso, -0.02 * W], [0.68 * W * a.hips * b, 0.45 * W, 0.48 * W * b], { bone: 'Hips', part: 'pelvis', k: kBody });
  ell(add(J.Spine, [0, 0, 0.02 * W]), [0.65 * W * a.waist * b, 0.3 * torso, 0.45 * W * b], { bone: 'Spine', part: 'waist', k: kBody });
  if (a.belly > 0.05) {
    const e = a.belly;
    ell(add(J.Spine, [0, -0.05 * torso, W * (0.05 + 0.25 * e)]), [W * (0.4 + 0.25 * e) * b, torso * (0.22 + 0.1 * e), W * (0.3 + 0.3 * e) * b], { bone: 'Spine', part: 'belly', k: kBody });
  }
  ell(add(J.Chest, [0, 0.05 * torso, 0]), [0.72 * W * Math.sqrt(a.shoulders) * b, 0.36 * torso, 0.5 * W * b], { bone: 'Chest', part: 'chest', k: kBody });
  ell(add(J.Chest, [0, 0.22 * torso, -0.05 * W]), [0.82 * W * a.shoulders, 0.22 * torso, 0.4 * W], { bone: 'Chest', part: 'chest', k: kBody });

  const sideStart = {};
  for (const [s, x] of [['Left', 1], ['Right', -1]]) {
    sideStart[s] = prims.length;
    // Säte och bröstmuskler
    ell([x * 0.28 * W * a.hips, D.hipY - 0.03 * torso, -0.2 * W], [0.3 * W * b, 0.32 * W * b, 0.28 * W * b], { bone: 'Hips', part: 'pelvis', k: kBody });
    const bust = a.bust ?? 0, pec = 1 - 0.7 * bust;
    ell([x * 0.24 * W, J.Chest[1] + 0.12 * torso, J.Chest[2] + 0.24 * W * b], [0.34 * W * b * pec, 0.2 * torso * pec, 0.18 * W * b * pec], { bone: 'Chest', part: 'chest', k: kBody });
    if (bust > 0.05) {
      ell([x * 0.21 * W, J.Chest[1] + 0.08 * torso, J.Chest[2] + (0.36 + 0.14 * bust) * W * b], [(0.18 + 0.1 * bust) * W, (0.16 + 0.08 * bust) * W, (0.15 + 0.1 * bust) * W], { bone: 'Chest', part: 'chest', k: 0.06 * W });
    }
    // Trapezius och axel
    const ua = J[`${s}UpperArm`], la = J[`${s}LowerArm`], hand = J[`${s}Hand`];
    cone(add(J.Neck, [0, 0.04 * torso, 0]), add(ua, [0, 0.08 * W, 0]), 0.24 * W * b, 0.2 * W * b, { bone: `${s}Shoulder`, part: 'chest', k: kBody });
    ell(add(ua, [x * 0.04 * W, 0.02 * W, 0]), [0.27 * W * b, 0.29 * W * b, 0.29 * W * b], { bone: `${s}UpperArm`, part: 'shoulder', k: kJoint });

    // Arm
    const { upper: du, fore: df, hand: dh } = dirs[s];
    cone(ua, la, 0.28 * W * b, 0.18 * W * b, { bone: `${s}UpperArm`, part: 'upperarm', k: kJoint });
    ell(add(lerp(ua, la, 0.45), [0, 0, 0.04 * W]), [0.23 * W * b, 0.3 * D.upperL, 0.24 * W * b], { bone: `${s}UpperArm`, part: 'upperarm', k: kJoint }, frame(du, [1, 0, 0]));
    cone(la, hand, 0.22 * W * b, 0.13 * W * b, { bone: `${s}LowerArm`, part: 'forearm', k: kJoint });
    ell(lerp(la, hand, 0.3), [0.22 * W * b, 0.28 * D.foreL, 0.19 * W * b], { bone: `${s}LowerArm`, part: 'forearm', k: kJoint }, frame(df, [1, 0, 0]));

    // Hand: handflata, två fingergrupper och tumme. tIn pekar mot kroppen, wv framåt (tumsidan).
    const L = D.handL;
    const { palm: tIn, thumb: wv } = dirs[s];
    const hp = (along, side, inward) => add(hand, add(mul(dh, along * L), add(mul(wv, side * L), mul(tIn, inward * L))));
    ell(hp(0.28, 0, 0), [0.13 * L, 0.3 * L, 0.25 * L], { bone: `${s}Hand`, part: 'hand', k: 0.02 * W }, frame(dh, tIn));
    cone(hp(0.5, 0.1, 0), hp(0.95, 0.1, 0.12), 0.075 * L, 0.06 * L, { bone: `${s}Hand`, part: 'hand', k: 0.006 * W });
    cone(hp(0.5, -0.1, 0), hp(0.87, -0.1, 0.12), 0.07 * L, 0.055 * L, { bone: `${s}Hand`, part: 'hand', k: 0.006 * W });
    cone(hp(0.12, 0.2, 0.05), hp(0.5, 0.38, 0.12), 0.075 * L, 0.06 * L, { bone: `${s}Hand`, part: 'hand', k: 0.02 * W });

    // Ben
    const ul = J[`${s}UpperLeg`], ll = J[`${s}LowerLeg`], ft = J[`${s}Foot`];
    cone(add(ul, [-Math.sign(ul[0]) * 0.04 * W, 0.03 * W, 0]), ll, 0.38 * W * b, 0.25 * W * b, { bone: `${s}UpperLeg`, part: 'thigh', k: kBody });
    ell(add(lerp(ul, ll, 0.32), [0, 0, 0.05 * W]), [0.33 * W * b, 0.3 * (ul[1] - ll[1]), 0.31 * W * b], { bone: `${s}UpperLeg`, part: 'thigh', k: kJoint });
    cone(ll, add(ft, [0, 0.02 * W, 0]), 0.25 * W * b, 0.15 * W * b, { bone: `${s}LowerLeg`, part: 'shin', k: kJoint });
    ell(add(lerp(ll, ft, 0.3), [0, 0, -0.07 * W]), [0.27 * W * b, 0.28 * (ll[1] - ft[1]), 0.27 * W * b], { bone: `${s}LowerLeg`, part: 'shin', k: kJoint });

    // Fot: häl, trampdyna och tåparti; doppar under y = 0 och skärs till en plan sula
    const F = D.footL, toe = J[`${s}Toe`], tip = tips[`${s}ToeTip`];
    const heel = [x * D.footX, 0.12 * F, -0.1 * F];
    cone(heel, [toe[0], 0.1 * F, toe[2]], 0.15 * F, 0.17 * F, { bone: `${s}Foot`, part: 'foot', k: kJoint });
    cone(ft, lerp(heel, [toe[0], 0.1 * F, toe[2]], 0.45), 0.15 * W * b, 0.15 * F, { bone: `${s}Foot`, part: 'foot', k: kJoint });
    ell([tip[0] * 0.5 + toe[0] * 0.5, 0.08 * F, tip[2] - 0.06 * F], [0.18 * F, 0.1 * F, 0.13 * F], { bone: `${s}Toe`, part: 'foot', k: kJoint });
  }

  const perSide = sideStart.Right - sideStart.Left;

  // Hals och huvud. O ligger i hakans höjd rakt under huvudleden; ansiktet framåt (+Z).
  cone(add(J.Neck, [0, -0.04 * torso, 0]), J.Head, 0.27 * h * a.neck * b, 0.23 * h * a.neck, { bone: 'Neck', part: 'neck', k: kJoint });
  const O = sk.face;
  const at = (x, y, z) => add(O, [x * h, y * h, z * h]);
  const head = (o) => ({ bone: 'Head', part: 'head', ...o });
  ell(at(0, 0.56, -0.04), [0.37 * h, 0.44 * h, 0.45 * h], head({ k: 0.08 * h }));
  ell(at(0, 0.3, 0.08), [0.3 * h, 0.3 * h, 0.33 * h], head({ k: 0.1 * h }));
  ell(at(0, 0.09, 0.3), [0.13 * h, 0.1 * h, 0.1 * h], head({ k: 0.08 * h }));
  ell(at(0, 0.6, 0.33), [0.28 * h, 0.07 * h, 0.1 * h], head({ k: 0.06 * h }));
  const n = a.nose;
  cone(at(0, 0.56, 0.4), at(0, 0.38, 0.4 + 0.07 * n), 0.04 * h * n, 0.06 * h * n, head({ k: 0.03 * h }));
  ell(at(0, 0.36, 0.38 + 0.07 * n), [0.08 * h * n, 0.04 * h * n, 0.05 * h * n], head({ k: 0.03 * h }));
  for (const x of [1, -1]) {
    ell(at(x * 0.2, 0.42, 0.24), [0.12 * h, 0.08 * h, 0.1 * h], head({ k: 0.06 * h }));
    // Öron: platta ellipsoider; spetsiga pekar ut, upp och bakåt
    const es = a.earSize;
    const base = at(x * 0.35, 0.45, -0.02);
    if (a.ears === 'pointy') {
      const tipE = at(x * (0.35 + 0.3 * es), 0.45 + 0.22 * es, -0.02 - 0.12 * es);
      const len = Math.hypot(...sub(tipE, base));
      ell(lerp(base, tipE, 0.5), [0.035 * h, len / 2, 0.09 * h * es], head({ k: 0.012 * h }), frame(sub(tipE, base), [x, 0, 0]));
    } else {
      ell(add(base, [x * 0.02 * h, 0, 0]), [0.04 * h * es, 0.14 * h * es, 0.09 * h * es], head({ k: 0.012 * h }), frame([x * 0.15, 1, -0.25], [x, 0, 0]));
    }
  }

  // Förberäkna konstanter och en omslutande sfär per primitiv (för att hoppa över delar långt bort)
  for (const p of prims) {
    if (p.t === 0) {
      p.sc = p.c; p.sr = Math.max(...p.r);
    } else {
      p.ba = sub(p.b, p.a); p.l2 = dot(p.ba, p.ba); p.rr = p.r1 - p.r2; p.a2 = p.l2 - p.rr * p.rr; p.il2 = 1 / p.l2;
      p.sc = lerp(p.a, p.b, 0.5); p.sr = Math.sqrt(p.l2) / 2 + Math.max(p.r1, p.r2);
    }
  }
  // Spegling: vänsterdelens index -> högerdelens (och tvärtom), mittdelarna pekar på sig själva
  const mirror = prims.map((_, i) => i);
  for (let i = 0; i < perSide; i++) { mirror[sideStart.Left + i] = sideStart.Right + i; mirror[sideStart.Right + i] = sideStart.Left + i; }
  prims.mirror = mirror;
  return prims;
}

// Avstånd till en primitiv (ellipsoid: Quilez approximation; rundad kon: Quilez exakta)
function primDist(p, q) {
  if (q.t === 0) {
    const dx = p[0] - q.c[0], dy = p[1] - q.c[1], dz = p[2] - q.c[2];
    const [e0, e1, e2] = q.ax;
    const u = (dx * e0[0] + dy * e0[1] + dz * e0[2]) / q.r[0];
    const v = (dx * e1[0] + dy * e1[1] + dz * e1[2]) / q.r[1];
    const w = (dx * e2[0] + dy * e2[1] + dz * e2[2]) / q.r[2];
    const k0 = Math.hypot(u, v, w);
    const k1 = Math.hypot(u / q.r[0], v / q.r[1], w / q.r[2]) || 1e-9;
    return (k0 * (k0 - 1)) / k1;
  }
  const pa0 = p[0] - q.a[0], pa1 = p[1] - q.a[1], pa2 = p[2] - q.a[2];
  const [b0, b1, b2] = q.ba;
  const y = pa0 * b0 + pa1 * b1 + pa2 * b2, z = y - q.l2;
  const x0 = pa0 * q.l2 - b0 * y, x1 = pa1 * q.l2 - b1 * y, x2v = pa2 * q.l2 - b2 * y;
  const x2 = x0 * x0 + x1 * x1 + x2v * x2v;
  const y2 = y * y * q.l2, z2 = z * z * q.l2;
  const k = Math.sign(q.rr) * q.rr * q.rr * x2;
  if (Math.sign(z) * q.a2 * z2 > k) return Math.sqrt(x2 + z2) * q.il2 - q.r2;
  if (Math.sign(y) * q.a2 * y2 < k) return Math.sqrt(x2 + y2) * q.il2 - q.r1;
  return (Math.sqrt(x2 * q.a2 * q.il2) + y * q.rr) * q.il2 - q.r1;
}

// Fältet: mjuk union av primitiverna, skuren vid marken. info() ger även närmaste primitiv.
// Smooth-min beror på ordningen, så fältet räknas alltid på +x-sidan och speglas: då blir kroppen
// exakt symmetrisk, och närmaste primitiv byts mot sin spegelbild på -x-sidan.
export function bodyField(prims) {
  const kMax = Math.max(...prims.map((q) => q.k));
  const info = (p0) => {
    const flip = p0[0] < 0, p = flip ? [-p0[0], p0[1], p0[2]] : p0;
    let d = Infinity, dmin = Infinity, pi = -1;
    for (let i = 0; i < prims.length; i++) {
      const q = prims[i];
      const lower = Math.hypot(p[0] - q.sc[0], p[1] - q.sc[1], p[2] - q.sc[2]) - q.sr;
      if (lower > d + kMax && lower > dmin) continue;
      const di = primDist(p, q);
      if (di < dmin) { dmin = di; pi = i; }
      const hh = Math.max(q.k - Math.abs(d - di), 0) / q.k;
      d = Math.min(d, di) - hh * hh * q.k * 0.25;
    }
    return { d: Math.max(d, -p[1]), pi: flip ? prims.mirror[pi] : pi };
  };
  return { f: (p) => info(p).d, info };
}

export function bodyBounds(prims, margin) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const q of prims) for (let i = 0; i < 3; i++) {
    lo[i] = Math.min(lo[i], q.sc[i] - q.sr - margin); hi[i] = Math.max(hi[i], q.sc[i] + q.sr + margin);
  }
  return { lo, hi };
}
