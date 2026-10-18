// Outfit på en hm08-kropp: alla plagg blir EN yta, uppdelad per byggsatsplats. Ren JS.
//
// Varje plagg är ett lager (layer) med ett täckningsområde: platserna det får finnas på (slots) och gränser
// (cover) i meter, t.ex. "ned till mitt på höften", "ärmen till 60 % av överarmen", V-ringning eller ett band
// vid midjan. I varje punkt vinner det översta plagget som täcker punkten, och avståndet från huden staplas
// (bältet utanpå tunikan utanpå byxorna). Ytan skärs exakt längs gränsernas konturer, och där två lager möts
// viks en fåll från det yttre lagrets kant över en vulst ned till det inre (eller till huden). Där huden
// syns är ytan kroppens egen. Inga två lager ligger på varandra, så inget kan sticka igenom och inget ritas
// två gånger. Varje hörn ärver vikterna från sina kroppshörn (sources), så ytan följer skelettet.
import { add, sub, mul, dot, cross, norm, lerp } from '../tree/vec.mjs';

const EPS = 1e-9;
const CHILD = { UpperArm: 'LowerArm', LowerArm: 'Hand', UpperLeg: 'LowerLeg', LowerLeg: 'Foot' };

// Namngivna höjder ur skelettet (meter)
function heights(J, cubes) {
  const seg = (a, b, t) => lerp(J[a], J[b], t)[1];
  return {
    neckSeam: lerp(J.Neck, J.Head, 0.3)[1], neck: J.Neck[1], chest: J.Chest[1],
    waist: lerp(J.Hips, cubes['joint-spine-3'], 0.55)[1], hip: J.Hips[1],
    crotch: seg('LeftUpperLeg', 'LeftLowerLeg', 0.15), knee: J.LeftLowerLeg[1], ankle: J.LeftFoot[1],
  };
}

// En gräns som fält i meter: ≤ 0 där plagget täcker
function clauseField(c, J, Hs) {
  const y = (a, b, t) => Hs[a] + (Hs[b] - Hs[a]) * t;
  if (c.above) { const line = y(...c.above); return (p) => line - p[1]; }
  if (c.below) { const line = y(...c.below); return (p) => p[1] - line; }
  if (c.band) { const at = Hs[c.band[0]], w = c.band[1]; return (p) => Math.abs(p[1] - at) - w / 2; }
  if (c.limb) {
    const [bone, max] = c.limb;
    return (p) => {
      const side = p[0] >= 0 ? 'Left' : 'Right';
      const a = J[side + bone], b = J[side + CHILD[bone]], ab = sub(b, a), L = Math.hypot(...ab);
      return (dot(sub(p, a), ab) / (L * L) - max) * L;
    };
  }
  if (c.vneck) {
    const { depth, width, back } = c.vneck, top = Hs.neckSeam;
    return (p) => {
      const line = p[2] > J.Neck[2] ? top - depth + Math.abs(p[0]) * (depth / width) : top - back;
      return p[1] - line;
    };
  }
  throw new Error(`okänd gräns ${JSON.stringify(c)}`);
}

// Skär en triangelyta längs nollkonturen av f. Nya hörn på kanter (delas mellan grannar) med interpolerat
// läge, normal och källor (vikter).
function cutMesh(M, f) {
  const d = M.pos.map(f);
  const edgeVert = new Map();
  const mid = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (edgeVert.has(key)) return edgeVert.get(key);
    const t = d[a] / (d[a] - d[b]);
    const i = M.pos.length;
    M.pos.push(lerp(M.pos[a], M.pos[b], t)); M.nrm.push(norm(lerp(M.nrm[a], M.nrm[b], t)));
    const src = new Map();
    for (const [v, w] of M.src[a]) src.set(v, (src.get(v) ?? 0) + w * (1 - t));
    for (const [v, w] of M.src[b]) src.set(v, (src.get(v) ?? 0) + w * t);
    M.src.push([...src]); d.push(0);
    edgeVert.set(key, i);
    return i;
  };
  const tris = [], slot = [];
  M.tris.forEach((t, ti) => {
    const s = t.map((i) => (Math.abs(d[i]) < EPS ? 0 : Math.sign(d[i])));
    if (!(s.includes(1) && s.includes(-1))) { tris.push(t); slot.push(M.slot[ti]); return; }
    // Sutherland–Hodgman: polygonen på var sida, nollhörn på båda
    for (const side of [1, -1]) {
      const poly = [];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3], sa = s[k], sb = s[(k + 1) % 3];
        if (sa === side || sa === 0) poly.push(a);
        if (sa * sb === -1) poly.push(mid(a, b));
      }
      for (let k = 1; k + 1 < poly.length; k++) { tris.push([poly[0], poly[k], poly[k + 1]]); slot.push(M.slot[ti]); }
    }
  });
  M.tris = tris; M.slot = slot;
}

// body: { verts, normals, quads, tris, joints, cubes }, kit: hm08_kit.json, items: [{ name, spec, color, trim }]
// (spec ur parts.json). Ger meshar per (plats, material) och kontroller. Utan plagg blir det den nakna
// kroppen delad per plats.
export function buildOutfit(body, kit, items, { skin = '#E9B48A' } = {}) {
  const { verts: V, normals: N, tris: T, joints: J } = body;
  const Hs = heights(J, body.cubes);
  const faceSlot = new Map(Object.entries(kit.parts).flatMap(([s, fs]) => fs.map((f) => [f, s])));
  const M = { pos: V.map((p) => [...p]), nrm: N.map((n) => [...n]), src: V.map((_, i) => [[i, 1]]), tris: T.map((t) => [...t]), slot: T.map((_, ti) => faceSlot.get(ti >> 1)) };

  // Lager i ordning nedifrån: lägre layer först, sedan ordningen i outfit
  const L = items.map((it, k) => ({ ...it, k, fields: (it.spec.cover ?? []).map((c) => clauseField(c, J, Hs)), slots: new Set(it.spec.slots) }))
    .sort((a, b) => (a.spec.layer ?? 0) - (b.spec.layer ?? 0) || a.k - b.k);
  // Skär längs varje gräns, och längs bårdens inre kant så att bården blir en rak rand
  for (const it of L) for (const f of it.fields) {
    cutMesh(M, f);
    const w = it.spec.trim?.width ?? 0;
    if (w > 0) cutMesh(M, (p) => f(p) + w);
  }
  const covers = (it, p) => it.fields.every((f) => f(p) <= 1e-7);

  // Zon per triangel: översta lagret som täcker (efter plats och gränser), annars hud (-1).
  // Bården: inom trim.width från någon av lagrets gränser.
  const zone = M.tris.map((t, ti) => {
    const c = [0, 1, 2].map((k) => (M.pos[t[0]][k] + M.pos[t[1]][k] + M.pos[t[2]][k]) / 3);
    for (let li = L.length - 1; li >= 0; li--) {
      const it = L[li];
      if (!it.slots.has(M.slot[ti]) || !covers(it, c)) continue;
      const w = it.spec.trim?.width ?? 0;
      const trim = w > 0 && it.fields.some((f) => f(c) > -w);
      return { li, trim };
    }
    return { li: -1, trim: false };
  });

  // Hörnens platser (ett hörn i en söm hör till flera)
  const vSlots = M.pos.map(() => new Set());
  M.tris.forEach((t, ti) => t.forEach((v) => vSlots[v].add(M.slot[ti])));
  const looseOf = (it, p) => it.spec.loose * ((it.spec.looseProfile ?? 'uniform') === 'waist'
    ? 1 - Math.min(1, Math.max(0, (p[1] - Hs.waist) / (Hs.chest - Hs.waist))) : 1);
  // Staplat avstånd: lagret li i hörnet v ligger utanpå det översta lägre lager som täcker v
  const memo = new Map();
  const offset = (li, v) => {
    if (li < 0) return 0;
    const key = `${li},${v}`;
    if (memo.has(key)) return memo.get(key);
    const it = L[li];
    const r = under(li, v) + it.spec.thickness + looseOf(it, M.pos[v]);
    memo.set(key, r);
    return r;
  };
  const under = (li, v) => {
    for (let lj = li - 1; lj >= 0; lj--) {
      const it = L[lj];
      if ([...vSlots[v]].some((s) => it.slots.has(s)) && covers(it, M.pos[v])) return offset(lj, v);
    }
    return 0;
  };

  // Skal per lager: läge = kroppen + normal × avstånd, utjämnat inom lagret med kanterna fasta
  const shellPos = new Map(); // `${li},${v}` -> läge
  const zoneTris = new Map();
  M.tris.forEach((t, ti) => { const li = zone[ti].li; (zoneTris.get(li) ?? zoneTris.set(li, []).get(li)).push(ti); });
  const vZones = M.pos.map(() => new Set());
  M.tris.forEach((t, ti) => t.forEach((v) => vZones[v].add(zone[ti].li)));
  for (const [li, tis] of zoneTris) {
    const vs = [...new Set(tis.flatMap((ti) => M.tris[ti]))];
    for (const v of vs) shellPos.set(`${li},${v}`, add(M.pos[v], mul(M.nrm[v], offset(li, v))));
    if (li < 0) continue;
    const it = L[li];
    const nb = new Map(vs.map((v) => [v, new Set()]));
    for (const ti of tis) M.tris[ti].forEach((a, k) => { const b = M.tris[ti][(k + 1) % 3]; nb.get(a).add(b); nb.get(b).add(a); });
    // Kanthörn (mot ett annat lager eller huden) jämnas bara ut längs kanten, så att kanten blir rak utan att
    // krympa in i lagret; fållen kopplar ihop lagren vid vilket läge kanten än får. Sömmar mellan platser
    // påverkas inte: samma lager och hörn har ett enda läge.
    const edge = (v) => vZones[v].size > 1;
    const edgeNb = new Map(vs.filter(edge).map((v) => [v, [...nb.get(v)].filter(edge)]));
    for (let iter = 0; iter < (it.spec.smooth ?? 0); iter++) {
      const next = new Map();
      for (const v of vs) {
        const key = `${li},${v}`;
        if (edge(v) && (edgeNb.get(v).length < 2)) continue;
        const ns = edge(v) ? edgeNb.get(v) : [...nb.get(v)];
        const avg = mul(ns.reduce((s, u) => add(s, shellPos.get(`${li},${u}`)), [0, 0, 0]), 1 / ns.length);
        let p = lerp(shellPos.get(key), avg, 0.5);
        const minGap = under(li, v) + (it.spec.minGap ?? 0.004);
        const gap = dot(sub(p, M.pos[v]), M.nrm[v]);
        if (gap < minGap) p = add(p, mul(M.nrm[v], minGap - gap));
        next.set(key, p);
      }
      for (const [k2, p] of next) shellPos.set(k2, p);
    }
  }
  // Sulor och annat som hamnat under marken lyfts till marken
  for (const [k2, p] of shellPos) if (p[1] < 0) shellPos.set(k2, [p[0], 0, p[2]]);

  // Utdata per (plats, material). Hörnkopior per (lager, bård, hörn); fållarna får egna kopior.
  const linear = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const skinCol = linear(skin);
  const meshes = new Map();
  const meshOf = (slot, material) => {
    const k = `${slot}|${material}`;
    if (!meshes.has(k)) meshes.set(k, { slot, material, pos: [], col: [], src: [], key: [], kind: material === 'skin' ? 'skin' : 'cloth', tris: [], strip: [], idx: new Map() });
    return meshes.get(k);
  };
  const materialOf = (li) => (li < 0 ? 'skin' : L[li].spec.material ?? 'cloth');
  const colorOf = (li, trim) => (li < 0 ? skinCol : linear(trim ? (L[li].trim ?? L[li].color) : L[li].color));
  const vert = (m, tag, p, col, src, key) => {
    if (m.idx.has(tag)) return m.idx.get(tag);
    const i = m.pos.length;
    m.pos.push(p); m.col.push(col); m.src.push(src); m.key.push(key);
    m.idx.set(tag, i);
    return i;
  };
  M.tris.forEach((t, ti) => {
    const { li, trim } = zone[ti];
    const m = meshOf(M.slot[ti], materialOf(li));
    m.tris.push(t.map((v) => vert(m, `s${li},${trim ? 1 : 0},${v}`, shellPos.get(`${li},${v}`), colorOf(li, trim), M.src[v], `${li},${v}`)));
  });

  // Fållar där två lager möts: yttre kant -> vulst -> inre kant
  const edgeTris = new Map();
  M.tris.forEach((t, ti) => t.forEach((a, k) => { const b = t[(k + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`; (edgeTris.get(key) ?? edgeTris.set(key, []).get(key)).push(ti); }));
  const centroid = (ti) => mul(M.tris[ti].reduce((s, v) => add(s, M.pos[v]), [0, 0, 0]), 1 / 3);
  // Riktning ut över gränsen i hörnet v, från det yttre lagrets sida mot det inre
  const outAcc = new Map();
  const boundary = [];
  for (const [key, tis] of edgeTris) {
    if (tis.length !== 2) continue;
    const [t1, t2] = tis, z1 = zone[t1].li, z2 = zone[t2].li;
    if (z1 === z2) continue;
    const [a, b] = key.split(',').map(Number);
    const o1 = (offset(z1, a) + offset(z1, b)) / 2, o2 = (offset(z2, a) + offset(z2, b)) / 2;
    // Samma avstånd (t.ex. tunika och ärm i samma lager): ingen fåll, kanterna ligger redan på samma ställe
    if (Math.abs(o1 - o2) < 0.001) continue;
    const [to, ti_] = o1 >= o2 ? [t1, t2] : [t2, t1];
    boundary.push({ a, b, to, ti: ti_ });
    const dir = sub(centroid(ti_), centroid(to));
    for (const v of [a, b]) {
      const k2 = `${zone[to].li},${zone[ti_].li},${v}`;
      outAcc.set(k2, add(outAcc.get(k2) ?? [0, 0, 0], dir));
    }
  }
  // Fållens riktning jämnas ut längs kanten (skärningen ger små flisor med spretiga riktningar)
  const bNb = new Map();
  for (const { a, b, to, ti } of boundary) {
    const tag = `${zone[to].li},${zone[ti].li}`;
    for (const [x, y] of [[a, b], [b, a]]) { const k2 = `${tag},${x}`; (bNb.get(k2) ?? bNb.set(k2, new Set()).get(k2)).add(`${tag},${y}`); }
  }
  for (let iter = 0; iter < 4; iter++) {
    const next = new Map();
    for (const [k2, d] of outAcc) {
      const ns = [...(bNb.get(k2) ?? [])];
      next.set(k2, ns.reduce((sacc, n) => add(sacc, norm(outAcc.get(n) ?? [0, 0, 0])), norm(d)));
    }
    for (const [k2, d] of next) outAcc.set(k2, d);
  }
  const outDir = (lo, lin, v) => { const d = outAcc.get(`${lo},${lin},${v}`); return norm(sub(d, mul(M.nrm[v], dot(d, M.nrm[v])))); };
  for (const { a, b, to, ti } of boundary) {
    const lo = zone[to].li, lin = zone[ti].li, trim = zone[to].trim;
    const hem = L[lo].spec.hem ?? { bead: 0.004, overhang: 0.005 };
    const m = meshOf(M.slot[to], materialOf(lo));
    const col = colorOf(lo, trim);
    const P = (li, v) => shellPos.get(`${li},${v}`);
    const bead = (v) => add(add(P(lo, v), mul(M.nrm[v], hem.bead)), mul(outDir(lo, lin, v), hem.overhang));
    const vv = (tag, p, v) => vert(m, `f${lo},${lin},${tag},${v}`, p, col, M.src[v], `f${lo},${lin},${tag},${v}`);
    const oa = vv('o', P(lo, a), a), ob = vv('o', P(lo, b), b), ba = vv('b', bead(a), a), bb = vv('b', bead(b), b);
    const ia = vv('i', P(lin, a), a), ib = vv('i', P(lin, b), b);
    const quad = (q, expect) => {
      const fn = cross(sub(m.pos[q[1]], m.pos[q[0]]), sub(m.pos[q[3]], m.pos[q[0]]));
      const [p0, p1, p2, p3] = dot(fn, expect) < 0 ? [q[0], q[3], q[2], q[1]] : q;
      m.tris.push([p0, p1, p2], [p0, p2, p3]); m.strip.push(true, true);
    };
    const od = norm(add(outDir(lo, lin, a), outDir(lo, lin, b)));
    quad([oa, ob, bb, ba], add(M.nrm[a], od));
    quad([ba, bb, ib, ia], od);
  }

  // Normaler: skalets hörn delar normal per lager och kroppshörn (sömmar och bårdgränser blir släta);
  // fållarnas hörn får normaler ur fållens egna ytor
  const acc = new Map();
  const out = [...meshes.values()];
  for (const m of out) m.tris.forEach(([x, y, z]) => {
    const fn = cross(sub(m.pos[y], m.pos[x]), sub(m.pos[z], m.pos[x]));
    for (const i of [x, y, z]) acc.set(m.key[i], add(acc.get(m.key[i]) ?? [0, 0, 0], fn));
  });
  for (const m of out) m.nrm = m.key.map((k) => norm(acc.get(k)));

  // Kontroller: skalhörn som ligger närmare huden än lagret under (genomstick), och hur mycket varje lager täcker
  let inside = 0;
  for (const [k, p] of shellPos) {
    const [li, v] = k.split(',').map(Number);
    if (li < 0 || p[1] === 0) continue; // sulor som lyfts till marken räknas inte
    if (dot(sub(p, M.pos[v]), M.nrm[v]) < under(li, v) + 1e-4) inside++;
  }
  const trisPerLayer = Object.fromEntries([[-1, 'skin'], ...L.map((it, i) => [i, it.name])].map(([li, n]) => [n, zone.filter((z) => z.li === li).length]));
  return { meshes: out, cutVerts: M.pos.length, checks: { shell_inside: inside, tris_per_layer: trisPerLayer, hems: boundary.length } };
}
