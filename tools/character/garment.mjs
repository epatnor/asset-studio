// Plagg som byggsatsdelar: ett plagg ersätter de nakna delarna på sina platser och slutar exakt i deras
// sömmar (hm08_kit.json). Ren JS.
//
// Plagget byggs ur kroppens egen topologi:
//   1. skal: platsernas quads, förskjutna utåt längs kroppens normaler (mer där plagget är löst),
//      utjämnade så att tyget inte visar varje muskel, och alltid minst minGap utanför huden;
//   2. invikt fåll vid varje söm: från skalets kant ut till en vulst och sedan in till exakt sömmens
//      hörn på huden, så att kanten syns som en fåll men anslutningen till grannarna är exakt.
// Eftersom varje skalhörn motsvarar ett kroppshörn följer plagget med när kroppen ändras av targets.
import { add, sub, mul, dot, cross, norm } from '../tree/vec.mjs';

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Avståndet från huden per hörn. looseProfile "waist": vidden ökar nedåt mot midjan (tunika som hänger);
// "uniform": samma vidd överallt (ärmar, byxor).
export function offsetFn(spec, J) {
  const yChest = J.Chest[1], yWaist = J.Hips[1] + 0.75 * (J.Spine[1] - J.Hips[1]);
  return (p) => spec.thickness + spec.loose * ((spec.looseProfile ?? 'waist') === 'waist' ? 1 - smoothstep(yWaist, yChest, p[1]) : 1);
}

// openSeams: { söm: (hörn) => avstånd } för sömmar mot ett annat plagg. Där viks ingen fåll; kanthörnen
// läggs på sömmen förskjuten med det gemensamma avståndet och får kroppens normal, så att båda plaggen
// möts i exakt samma hörn och skarven blir tät och slät.
export function buildGarment(body, kit, spec, { openSeams = {} } = {}) {
  const { verts: V, normals: N, quads: Q, joints: J } = body;
  const faces = spec.slots.flatMap((slot) => kit.parts[slot]);
  const vset = [...new Set(faces.flatMap((f) => Q[f]))];
  const inPart = new Set(vset);
  // Sömmarna som avgränsar plagget: slingor vars alla hörn ligger i plaggets ytor, men som också gränsar mot
  // en annan plats. Sömmar mellan två av plaggets egna platser är inre och syns inte.
  const faceSet = new Set(faces);
  const edgeFaces = new Map();
  Q.forEach((q, fi) => q.forEach((a, k) => { const b = q[(k + 1) % 4], key = a < b ? `${a},${b}` : `${b},${a}`; (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)).push(fi); }));
  const seams = Object.entries(kit.seams).filter(([, loop]) => loop.every((v) => inPart.has(v))).filter(([, loop]) => {
    const a = loop[0], b = loop[1], key = a < b ? `${a},${b}` : `${b},${a}`;
    return edgeFaces.get(key).some((f) => !faceSet.has(f));
  });
  const seamVerts = new Set(seams.flatMap(([, l]) => l));

  // 1. Skal: tygets tjocklek plus vidd; i öppna sömmar det gemensamma avståndet
  const offset = offsetFn(spec, J);
  const openOff = new Map(seams.filter(([n]) => openSeams[n]).flatMap(([n, loop]) => loop.map((v) => [v, openSeams[n](v)])));
  const shell = new Map(vset.map((v) => [v, add(V[v], mul(N[v], openOff.get(v) ?? offset(V[v])))]));
  const nb = new Map(vset.map((v) => [v, new Set()]));
  for (const f of faces) Q[f].forEach((a, k) => { const b = Q[f][(k + 1) % 4]; nb.get(a).add(b); nb.get(b).add(a); });
  for (let it = 0; it < spec.smooth; it++) {
    const next = new Map();
    for (const v of vset) {
      if (seamVerts.has(v)) { next.set(v, shell.get(v)); continue; }
      const ns = [...nb.get(v)];
      const avg = mul(ns.reduce((s, u) => add(s, shell.get(u)), [0, 0, 0]), 1 / ns.length);
      let p = add(shell.get(v), mul(sub(avg, shell.get(v)), 0.5));
      // Aldrig närmare huden än minGap längs kroppens normal
      const gap = dot(sub(p, V[v]), N[v]);
      if (gap < spec.minGap) p = add(p, mul(N[v], spec.minGap - gap));
      next.set(v, p);
    }
    for (const [v, p] of next) shell.set(v, p);
  }

  // Hörn och ytor
  const P = [], C = [], tris = [];
  const cloth = spec.color, trim = spec.trimColor ?? spec.color;
  const vid = new Map();
  // Bården: fållsömmarnas hörn och hem.band hörnrader inåt får bårdens färg (inte öppna sömmar mot plagg)
  const band = new Set(seams.filter(([n]) => !openSeams[n]).flatMap(([, l]) => l));
  for (let r = 0; r < (spec.hem.band ?? 0); r++) for (const v of [...band]) for (const u of nb.get(v)) band.add(u);
  for (const v of vset) { vid.set(v, P.length); P.push(shell.get(v)); C.push(band.has(v) ? trim : cloth); }
  for (const f of faces) {
    const [a, b, c, d] = Q[f].map((v) => vid.get(v));
    tris.push([a, b, c], [a, c, d]);
  }

  // 2. Invikt fåll per söm: skalkant -> vulst -> sömmens hörn på huden
  const hem = spec.hem;
  for (const [name, loop] of seams) {
    if (openSeams[name]) continue;
    const n = loop.length;
    // Riktning ut ur plagget i sömmen: från grannhörnen inne i plagget mot sömmen, i ytans plan
    const outDir = loop.map((v) => {
      const inner = [...nb.get(v)].filter((u) => !seamVerts.has(u));
      const c = inner.length ? mul(inner.reduce((s, u) => add(s, V[u]), [0, 0, 0]), 1 / inner.length) : V[v];
      const t = sub(V[v], c);
      return norm(sub(t, mul(N[v], dot(t, N[v]))));
    });
    const bead = loop.map((v, k) => { const i = P.length; P.push(add(add(shell.get(v), mul(N[v], hem.bead)), mul(outDir[k], hem.overhang))); C.push(trim); return i; });
    const skin = loop.map((v) => { const i = P.length; P.push([...V[v]]); C.push(trim); return i; });
    const ring = (A, B, expect) => {
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const q = [A[k], A[k2], B[k2], B[k]];
        const fn = cross(sub(P[q[1]], P[q[0]]), sub(P[q[3]], P[q[0]]));
        const flip = dot(fn, expect(k)) < 0;
        const [a, b, c, d] = flip ? [q[0], q[3], q[2], q[1]] : q;
        tris.push([a, b, c], [a, c, d]);
      }
    };
    ring(loop.map((v) => vid.get(v)), bead, (k) => add(N[loop[k]], outDir[k]));
    ring(bead, skin, (k) => outDir[k]);
  }

  // Normaler ur plaggets egna trianglar (viktade med area)
  const normals = P.map(() => [0, 0, 0]);
  for (const [a, b, c] of tris) {
    const fn = cross(sub(P[b], P[a]), sub(P[c], P[a]));
    for (const i of [a, b, c]) normals[i] = add(normals[i], fn);
  }
  const out = normals.map(norm);
  for (const v of openOff.keys()) out[vid.get(v)] = [...N[v]];
  return { positions: P, normals: out, colors: C, tris, seams: seams.map(([name]) => name), open: seams.filter(([n]) => openSeams[n]).map(([n]) => n), shellOf: vid };
}

// Genomstick: skalhörn som ligger innanför huden (mot sitt kroppshörns normal eller närmaste kroppshörn)
export function garmentChecks(body, g, kit) {
  // (öppna sömmar kontrolleras vid ihopsättningen, mot grannplagget)
  const { verts: V, normals: N } = body;
  let inside = 0, minGap = Infinity;
  for (const [v, i] of g.shellOf) {
    const gap = dot(sub(g.positions[i], V[v]), N[v]);
    minGap = Math.min(minGap, gap);
    if (gap <= 0) inside++;
  }
  // Sömmarna: plaggets innersta fållhörn ska ligga exakt på kroppens sömhörn
  let seamError = 0;
  const skinPos = new Map(V.map((p, i) => [i, p]));
  for (const name of g.seams.filter((n) => !g.open.includes(n))) for (const v of kit.seams[name]) {
    const best = Math.min(...g.positions.map((p) => Math.hypot(p[0] - skinPos.get(v)[0], p[1] - skinPos.get(v)[1], p[2] - skinPos.get(v)[2])));
    seamError = Math.max(seamError, best);
  }
  return { shell_inside: inside, min_gap_mm: +(minGap * 1000).toFixed(2), seam_error_mm: +(seamError * 1000).toFixed(4), hems: g.seams.filter((n) => !g.open.includes(n)), open: g.open };
}
