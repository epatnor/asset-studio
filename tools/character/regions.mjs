// Kroppens regioner: meshen delas längs sömmar där kläder brukar sluta, så att ett plagg kan dölja
// regionerna det täcker och skarven aldrig syns. Varje triangel får regionen för närmaste bensegment;
// gränsen mellan två segment är ett bisektorplan i leden (axel, armbåge, handled, höft, knä, fotled).
// Halsen delas vid kragen och bålen vid midjan med plan. Regionerna skärs ur samma mesh, så hörnen i
// sömmarna är desamma på båda sidor. Ren JS.
import { sub, dot } from '../tree/vec.mjs';

const LIMBS = ['upperarm', 'forearm', 'hand', 'thigh', 'shin', 'foot'];
export const REGIONS = ['head', 'torso', 'pelvis', ...LIMBS.flatMap((r) => [`${r}_L`, `${r}_R`])];
// Grannar som måste dela en söm
export const SEAMS = [['head', 'torso'], ['torso', 'pelvis'],
  ...['L', 'R'].flatMap((s) => [['torso', `upperarm_${s}`], [`upperarm_${s}`, `forearm_${s}`], [`forearm_${s}`, `hand_${s}`],
    ['pelvis', `thigh_${s}`], [`thigh_${s}`, `shin_${s}`], [`shin_${s}`, `foot_${s}`]])];

export function nearestSegment(p, segments) {
  let best = { i: -1, t: 0, d: Infinity };
  segments.forEach((s, i) => {
    const ab = sub(s.b, s.a), ap = sub(p, s.a);
    const t = Math.min(1, Math.max(0, dot(ap, ab) / dot(ab, ab)));
    const d = Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
    if (d < best.d) best = { i, t, d };
  });
  return best;
}

// Region för en punkt. Räknas på +x-sidan och speglas, så att indelningen blir exakt symmetrisk.
export function regionOf(p, sk) {
  const flip = p[0] < 0, q = flip ? [-p[0], p[1], p[2]] : p;
  const { i, t } = nearestSegment(q, sk.segments);
  const bone = sk.segments[i].bone;
  const side = bone.startsWith('Left') ? '_L' : bone.startsWith('Right') ? '_R' : '';
  const base = bone.replace(/^(Left|Right)/, '');
  const beltY = sk.joints.Spine[1];
  let r;
  if (base === 'Head' || (base === 'Neck' && t > 0.35)) r = 'head';
  else if (['Neck', 'Hips', 'Spine', 'Chest', 'Shoulder'].includes(base)) r = q[1] < beltY ? 'pelvis' : 'torso';
  else if (base === 'LowerLeg') r = (q[1] < sk.dims.ankleY * 1.15 ? 'foot' : 'shin') + side;
  else r = { UpperArm: 'upperarm', LowerArm: 'forearm', Hand: 'hand', UpperLeg: 'thigh', Foot: 'foot', Toe: 'foot' }[base] + side;
  return flip ? r.replace(/_L$/, '_R') : r;
}

// Kantgrannar per triangel (index i tris, -1 vid öppen kant)
export function triNeighbors(tris) {
  const edges = new Map();
  const nb = tris.map(() => []);
  tris.forEach((t, ti) => {
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
      const other = edges.get(key);
      if (other === undefined) edges.set(key, ti);
      else { nb[ti].push(other); nb[other].push(ti); }
    }
  });
  return nb;
}

// Region per triangel (efter mittpunkten), sedan städning: en triangel vars grannar mest tillhör en annan
// region byter, och öar (mindre delar av en region) går till den region de gränsar mest mot.
export function assignRegions(verts, tris, sk) {
  const reg = tris.map(([a, b, c]) => regionOf([0, 1, 2].map((k) => (verts[a][k] + verts[b][k] + verts[c][k]) / 3), sk));
  const nb = triNeighbors(tris);
  const majority = (ti, exclude) => {
    const count = {};
    for (const n of nb[ti]) if (reg[n] !== exclude) count[reg[n]] = (count[reg[n]] ?? 0) + 1;
    return Object.entries(count).sort((x, y) => y[1] - x[1])[0];
  };
  for (let pass = 0; pass < 3; pass++) {
    // Alla byten räknas på föregående omgång, så att resultatet inte beror på ordningen (symmetri)
    const next = reg.map((r, ti) => { const m = majority(ti, r); return m && m[1] >= 2 ? m[0] : r; });
    next.forEach((r, ti) => { reg[ti] = r; });
  }
  for (let pass = 0; pass < 3; pass++) {
    const comps = components(reg, nb);
    let moved = 0;
    for (const list of Object.values(comps)) {
      list.sort((x, y) => y.length - x.length);
      for (const island of list.slice(1)) {
        const count = {};
        for (const ti of island) for (const n of nb[ti]) if (reg[n] !== reg[ti]) count[reg[n]] = (count[reg[n]] ?? 0) + 1;
        const to = Object.entries(count).sort((x, y) => y[1] - x[1])[0];
        if (to) { for (const ti of island) reg[ti] = to[0]; moved++; }
      }
    }
    if (!moved) break;
  }
  return reg;
}

// Sammanhängande delar per region: { region: [[tri, ...], ...] }
export function components(reg, nb) {
  const seen = new Uint8Array(reg.length), out = {};
  for (let s = 0; s < reg.length; s++) {
    if (seen[s]) continue;
    const list = [s]; seen[s] = 1;
    for (let k = 0; k < list.length; k++) for (const n of nb[list[k]]) if (!seen[n] && reg[n] === reg[s]) { seen[n] = 1; list.push(n); }
    (out[reg[s]] ??= []).push(list);
  }
  return out;
}

// Kontroller: tomma regioner, öar, saknade sömmar och extra kontakter (lemmar som rör vid varandra)
export function regionChecks(reg, tris) {
  const nb = triNeighbors(tris);
  const comps = components(reg, nb);
  const pairs = new Set();
  reg.forEach((r, ti) => { for (const n of nb[ti]) if (reg[n] !== r) pairs.add([r, reg[n]].sort().join('|')); });
  const expected = new Set(SEAMS.map((p) => [...p].sort().join('|')));
  const tris_per_region = Object.fromEntries(REGIONS.map((r) => [r, reg.filter((x) => x === r).length]));
  return {
    tris_per_region,
    empty: REGIONS.filter((r) => !tris_per_region[r]),
    islands: Object.entries(comps).filter(([, l]) => l.length > 1).map(([r, l]) => `${r}:${l.length}`),
    missing_seams: [...expected].filter((p) => !pairs.has(p)),
    extra_contacts: [...pairs].filter((p) => !expected.has(p)),
  };
}
