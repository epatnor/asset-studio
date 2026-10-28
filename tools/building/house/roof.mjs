// Taklösaren (docs/buildings.md, del 2): taket över alla husets volymer som ett enda tak, där taken möts i
// ränndalar och nockar i stället för att skära igenom varandra. Efter patriks_input/AAA_Procedural_Modular_
// Buildings_ThreeJS_Reference.md, avsnitt 9 (roof solver).
//
// Varje volym ger sina takplan (y = a·x + b·z + c) över sin rektangel med takutsprång. Volymens tak är det lägsta av
// dess plan (två för sadeltak, fyra för valmat tak, ett för pulpettak); husets tak är det högsta av volymernas tak
// där de överlappar. En synlig takyta är då ett konvext område (där planet är volymens lägsta) minus de konvexa
// områden där en annan volyms tak ligger högre. Differensen delas upp i konvexa bitar med halvplansklippning, så att
// inget bibliotek behövs och varje bit trianguleras som en solfjäder.
//
//   const R = solveRoof(volumes);   // volumes: [{ rect: [x0, z0, x1, z1], top, roof: { type, axis, pitch, overhang, dir } }]
//   R.pieces    [{ v, plane, poly: [[x, z], ...] }]   synliga takytor, konvexa, moturs sett uppifrån
//   R.heightAt(x, z)      husets tak (−Infinity utanför)
//   R.roofOf(v, x, z)     volymens eget tak
//   R.edges     takytornas kanter: kind = eave (takfot och gavelkant), ridge, valley, step (mot en högre vägg),
//               inner (skarv mellan två bitar av samma takyta)
//   R.planeAt(x, z)       planet som bär taket där

const EPS = 1e-6;
const area = (poly) => { let s = 0; for (let i = 0; i < poly.length; i++) { const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length]; s += x0 * z1 - x1 * z0; } return s / 2; };

// Den del av en konvex polygon där a·x + b·z + c ≥ 0 (Sutherland–Hodgman mot ett halvplan)
export function clip(poly, [a, b, c]) {
  const out = [], f = ([x, z]) => a * x + b * z + c;
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i], Q = poly[(i + 1) % poly.length], fp = f(P), fq = f(Q);
    if (fp >= -EPS) out.push(P);
    if ((fp >= -EPS) !== (fq >= -EPS)) { const t = fp / (fp - fq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
  }
  return out.length >= 3 && Math.abs(area(out)) > 1e-5 ? out : null;
}
// A minus det konvexa området C (givet som halvplan h ≥ 0): bitarna utanför h1, innanför h1 men utanför h2, ...
export function subtract(A, halfplanes) {
  const out = [];
  let rest = A;
  for (const [a, b, c] of halfplanes) {
    if (!rest) break;
    const outside = clip(rest, [-a, -b, -c]);
    if (outside) out.push(outside);
    rest = clip(rest, [a, b, c]);
  }
  return out; // det som är kvar i rest ligger inne i C och försvinner
}
const rectPoly = ([x0, z0, x1, z1]) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const rectHalfplanes = ([x0, z0, x1, z1]) => [[1, 0, -x0], [-1, 0, x1], [0, 1, -z0], [0, -1, z1]];

// Volymens takplan, { a, b, c } i y = a·x + b·z + c. Takfoten (y = top) ligger vid väggen; utsprånget fortsätter
// nedåt. axis: nockens riktning ('x' eller 'z'); shed: dir = den sida taket lutar mot (+x, -x, +z, -z)
export function roofPlanes(V) {
  const [x0, z0, x1, z1] = V.rect, { type, axis = 'x', pitch = 0.75, dir = '+z' } = V.roof, t = Math.tan(pitch), top = V.top;
  const P = {
    '+z': { a: 0, b: -t, c: top + z1 * t }, '-z': { a: 0, b: t, c: top - z0 * t },
    '+x': { a: -t, b: 0, c: top + x1 * t }, '-x': { a: t, b: 0, c: top - x0 * t },
  };
  if (type === 'flat') return [{ a: 0, b: 0, c: top + 0.25, side: 'flat' }];
  if (type === 'shed') return [{ ...P[dir], side: dir }];
  if (type === 'hip' || type === 'pyramid') return ['+z', '-z', '+x', '-x'].map((s) => ({ ...P[s], side: s }));
  return (axis === 'x' ? ['+z', '-z'] : ['+x', '-x']).map((s) => ({ ...P[s], side: s })); // sadeltak
}
const yOf = (p, x, z) => p.a * x + p.b * z + p.c;
const extRect = (V) => { const o = V.roof.overhang ?? 0.4, [x0, z0, x1, z1] = V.rect; return [x0 - o, z0 - o, x1 + o, z1 + o]; };

export function solveRoof(volumes) {
  const vols = volumes.map((V, i) => ({ ...V, i, planes: roofPlanes(V), ext: extRect(V) }));
  const inRect = ([x0, z0, x1, z1], x, z) => x >= x0 - EPS && x <= x1 + EPS && z >= z0 - EPS && z <= z1 + EPS;
  const roofOf = (v, x, z) => { const V = vols[v]; if (!inRect(V.ext, x, z)) return -Infinity; let m = Infinity; for (const p of V.planes) m = Math.min(m, yOf(p, x, z)); return m; };
  const heightAt = (x, z) => { let m = -Infinity; for (let v = 0; v < vols.length; v++) m = Math.max(m, roofOf(v, x, z)); return m; };
  // Planet som bär taket i en punkt (för att se om två bitar är samma takyta)
  const planeAt = (x, z) => { let best = null, m = -Infinity; for (const V of vols) { if (!inRect(V.ext, x, z)) continue; let lo = null; for (const p of V.planes) if (!lo || yOf(p, x, z) < yOf(lo, x, z)) lo = p; if (yOf(lo, x, z) > m) { m = yOf(lo, x, z); best = lo; } } return best; };
  const pieces = [];
  for (const V of vols) for (const p of V.planes) {
    // Där p är volymens lägsta plan
    let poly = rectPoly(V.ext);
    for (const q of V.planes) if (q !== p && poly) poly = clip(poly, [q.a - p.a, q.b - p.b, q.c - p.c]); // q ≥ p
    if (!poly) continue;
    // Minus där en annan volyms tak ligger högre (vid lika vinner den som kom först)
    let parts = [poly];
    for (const W of vols) {
      if (W === V) continue;
      const bias = W.i < V.i ? -1e-4 : 1e-4;
      const hp = [...rectHalfplanes(W.ext), ...W.planes.map((q) => [q.a - p.a, q.b - p.b, q.c - p.c - bias])]; // q > p för alla q
      parts = parts.flatMap((A) => subtract(A, hp));
      if (!parts.length) break;
    }
    for (const poly2 of parts) pieces.push({ v: V.i, plane: p, poly: area(poly2) < 0 ? poly2.reverse() : poly2 });
  }
  // Kanterna: vad som finns strax utanför varje kant avgör vad den är
  const edges = [];
  for (const [k, P] of pieces.entries()) {
    for (let i = 0; i < P.poly.length; i++) {
      const A = P.poly[i], B = P.poly[(i + 1) % P.poly.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L < 1e-3) continue;
      const n = [(B[1] - A[1]) / L, -(B[0] - A[0]) / L]; // utåt (moturs polygon)
      const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], here = yOf(P.plane, m[0], m[1]);
      const out = heightAt(m[0] + n[0] * 0.02, m[1] + n[1] * 0.02);
      const rise = P.plane.a * n[0] + P.plane.b * n[1]; // stiger ytan mot kanten?
      let kind;
      const q = planeAt(m[0] + n[0] * 0.02, m[1] + n[1] * 0.02);
      if (q && Math.abs(q.a - P.plane.a) < 1e-6 && Math.abs(q.b - P.plane.b) < 1e-6 && Math.abs(q.c - P.plane.c) < 1e-4) kind = 'inner'; // samma takyta, bara uppdelad
      else if (out === -Infinity || out < here - 0.05) kind = 'eave';
      else if (out > here + 0.05) kind = 'step';
      else kind = rise > 0 ? 'ridge' : 'valley';
      edges.push({ piece: k, a: A, b: B, n, kind, ya: yOf(P.plane, A[0], A[1]), yb: yOf(P.plane, B[0], B[1]) });
    }
  }
  return { pieces, edges, heightAt, roofOf, planeAt, vols };
}
