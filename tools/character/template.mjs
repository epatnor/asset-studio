// Mallmesh per ras: alla kroppar av en ras delar topologi (samma hörn, samma trianglar, samma regioner),
// så att reglage i karaktärsskapandet kan bli morph targets och sömmarna följer med. Mallen görs ur
// rasens referenskropp med surface nets. En variant får sin mesh så här:
//   1. varje mallhörn är bundet till närmaste bensegment (läge längs segmentet och förskjutning från det),
//      och följer segmentet när skelettet ändras (rotation och skala per kroppsdel);
//   2. hörnet projiceras på variantens eget fält med Newtonsteg;
//   3. några varv avslappning (mot grannarnas medelpunkt) och ny projicering jämnar ut trianglarna.
// Ren JS.
import { add, sub, mul, dot, cross, norm, len } from '../tree/vec.mjs';
import { gradient } from '../tree/crown.mjs';

// Rotation som vrider enhetsvektorn u till v (Rodrigues), tillämpad på x
function rotateTo(u, v, x) {
  const c = dot(u, v), ax = cross(u, v), s = len(ax);
  if (s < 1e-9) return c > 0 ? x : mul(x, -1);
  const k = mul(ax, 1 / s), ang = Math.atan2(s, c);
  return add(add(mul(x, Math.cos(ang)), mul(cross(k, x), Math.sin(ang))), mul(k, dot(k, x) * (1 - Math.cos(ang))));
}

// Skala tvärs segmentet: huvud efter huvudhöjd, händer och fötter efter sina längder, resten efter bredd och byggnad
function lateralScale(bone, skA, skB) {
  const base = bone.replace(/^(Left|Right)/, '');
  if (base === 'Head' || base === 'Neck') return skB.hH / skA.hH;
  if (base === 'Hand') return skB.dims.handL / skA.dims.handL;
  if (base === 'Foot' || base === 'Toe') return skB.dims.footL / skA.dims.footL;
  return (skB.W / skA.W) * Math.sqrt(skB.build / skA.build);
}

// Varje hörn binds mjukt till de tre närmaste segmenten (vikt ~ 1 / avstånd⁴), som i skinning, så att
// mappningen blir kontinuerlig över segmentgränserna och inte viker ytan i armhålor och grenen
const NEAREST = 3;
function segmentsByDistance(p, segments) {
  return segments.map((s, i) => {
    const ab = sub(s.b, s.a), ap = sub(p, s.a);
    const t = Math.min(1, Math.max(0, dot(ap, ab) / dot(ab, ab)));
    const off = sub(ap, mul(ab, t));
    return { i, t, off, d: len(off) };
  }).sort((x, y) => x.d - y.d).slice(0, NEAREST);
}

export function bindTemplate(verts, sk) {
  // Räknas på +x-sidan och speglas till rätt segment, så att bindningen blir symmetrisk
  const mirror = sk.segments.map((s) => sk.segments.findIndex((o) => o.key === s.key.replace(/Left|Right/g, (m) => (m === 'Left' ? 'Right' : 'Left'))));
  return verts.map((p) => {
    const flip = p[0] < 0, q = flip ? [-p[0], p[1], p[2]] : p;
    const near = segmentsByDistance(q, sk.segments);
    const w = near.map((n) => 1 / (n.d ** 4 + 1e-12)), sum = w.reduce((x, y) => x + y, 0);
    return near.map((n, k) => ({ i: flip ? mirror[n.i] : n.i, t: n.t, off: flip ? [-n.off[0], n.off[1], n.off[2]] : n.off, w: w[k] / sum }));
  });
}

// Grannar längs polygonkanterna. Ges surface nets quads: de är spegelsymmetriska, men diagonalerna i
// trianglarna är det inte, och då skulle avslappningen dra kroppen snett.
export function vertexNeighbors(n, polys) {
  const nb = Array.from({ length: n }, () => new Set());
  for (const p of polys) p.forEach((v, k) => { const w = p[(k + 1) % p.length]; nb[v].add(w); nb[w].add(v); });
  return nb.map((s) => [...s]);
}

export function fitTemplate(tpl, skA, skB, f, cell, { relax = 3 } = {}) {
  const e = cell * 0.25;
  const project = (p, steps) => {
    for (let k = 0; k < steps; k++) {
      const d = f(p);
      const step = Math.max(-2 * cell, Math.min(2 * cell, d));
      p = sub(p, mul(gradient(f, p, e), step));
    }
    return p;
  };
  let verts = tpl.bind.map((bind) => {
    const p = bind.reduce((acc, { i, t, off, w }) => {
      const sa = skA.segments[i], sb = skB.segments[i];
      const da = norm(sub(sa.b, sa.a)), db = norm(sub(sb.b, sb.a));
      const o = mul(rotateTo(da, db, off), lateralScale(sa.bone, skA, skB));
      return add(acc, mul(add(add(sb.a, mul(sub(sb.b, sb.a), t)), o), w));
    }, [0, 0, 0]);
    return project(p, 8);
  });
  for (let r = 0; r < relax; r++) {
    verts = verts.map((p, vi) => {
      const nb = tpl.neighbors[vi];
      const avg = nb.reduce((s, j) => add(s, verts[j]), [0, 0, 0]).map((v) => v / nb.length);
      return project(add(p, mul(sub(avg, p), 0.5)), 3);
    });
  }
  return verts;
}
