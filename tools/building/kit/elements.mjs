// Byggsatsens element (docs/building-kit.md, nivå A): huggna stenar, kilstenar, bjälkar med ändträ, takpannor
// och nockpannor. Allt utgår från en sexsiding (åtta hörn) med avfasade kanter. Den formas fritt (kil, sned
// ände, skev bjälke) och får vägda normaler: plana ytor och mjuka fasar, som stilguiden vill ha.
// Varje element kan registreras med sin utbredning, så att kontrollerna kan pröva hur modulerna möts.
import { add, sub, mul, dot, cross, norm, len } from '../../tree/vec.mjs';
import { createGeom } from '../house/geom.mjs';

// Snabb hash av heltal, för ojämnheter som måste bli lika i delade hörn
function hash3(a, b, c, s) {
  let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791) ^ Math.imul(s, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return [(h & 1023) / 511.5 - 1, ((h >>> 10) & 1023) / 511.5 - 1, ((h >>> 20) & 1023) / 511.5 - 1];
}
// Trilinjär interpolation mellan åtta hörn (index = x + 2y + 4z, bit 0 = −1 och bit 1 = +1)
function tri(C, U) {
  const w = [0, 0, 0];
  for (let i = 0; i < 8; i++) {
    const f = (i & 1 ? 1 + U[0] : 1 - U[0]) * (i & 2 ? 1 + U[1] : 1 - U[1]) * (i & 4 ? 1 + U[2] : 1 - U[2]) / 8;
    w[0] += C[i][0] * f; w[1] += C[i][1] * f; w[2] += C[i][2] * f;
  }
  return w;
}
// Hörnen till en låda: c = mitt, ax = axlar, s = mått
export function boxCorners(c, ax, s) {
  const C = [];
  for (let i = 0; i < 8; i++) C.push(add(c, add(add(mul(ax[0], (i & 1 ? 0.5 : -0.5) * s[0]), mul(ax[1], (i & 2 ? 0.5 : -0.5) * s[1])), mul(ax[2], (i & 4 ? 0.5 : -0.5) * s[2]))));
  return C;
}
export const aabbCorners = ([x0, y0, z0], [x1, y1, z1]) => boxCorners([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [x1 - x0, y1 - y0, z1 - z0]);

// ctx.lod: 0 (alla detaljer), 1 (enkla fasar), 2 (lådor)
export function createElements(ctx) {
  const geom = createGeom({ lod: { segs: 1, detail: 2 - ctx.lod }, bevel: 0.03, tile: { glass: 1, glow: 1, metal: 1, wood: 1.6 } });
  const reg = [];
  const register = (kind, mesh, extra = {}) => {
    if (!kind) return;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh) { lo = lo.map((v, k) => Math.min(v, p[k])); hi = hi.map((v, k) => Math.max(v, p[k])); }
    reg.push({ kind, lo, hi, ...extra });
  };

  // Sexsidingen. o: bevel (fasens bredd i meter), chip ([hörn, större fas]: ett kantstött hörn), sub (extra
  // delningar per axel, för välvning), dome ([[axel, tecken, meter], ...]: ytan buktar ut), bend (vektor: bjälken
  // böjs i mitten), jitter (meter), skip (['-z', ...]: dolda sidor), color, endColor (färg på ±x-ändarna:
  // ändträ), grain (axel för träets ådring), tile (texturens storlek i meter), kind/exact (registret)
  function hexa(part, C, o = {}) {
    const lod = ctx.lod, e = (a, b) => len(sub(C[b], C[a]));
    const L = [(e(0, 1) + e(2, 3) + e(4, 5) + e(6, 7)) / 4, (e(0, 2) + e(1, 3) + e(4, 6) + e(5, 7)) / 4, (e(0, 4) + e(1, 5) + e(2, 6) + e(3, 7)) / 4];
    const h = L.map((x) => x / 2), hm = Math.min(...h);
    const b = lod >= 2 ? 0 : Math.min(o.bevel ?? 0.025, hm * 0.45);
    const bc = o.chip && lod === 0 ? Math.min(o.chip[1], hm * 0.85) : b;
    const subs = lod === 0 ? (o.sub ?? [0, 0, 0]) : [0, 0, 0];
    const coords = (k) => {
      const c = new Set([-h[k], h[k]]);
      for (const bb of [b, bc]) if (bb > 0) { c.add(-h[k] + bb); c.add(h[k] - bb); }
      const m = Math.max(b, bc);
      for (let i = 1; i <= subs[k]; i++) c.add(-h[k] + m + ((2 * h[k] - 2 * m) * i) / (subs[k] + 1));
      return [...c].sort((x, y) => x - y);
    };
    const cs = [coords(0), coords(1), coords(2)];
    const center = tri(C, [0, 0, 0]);
    const faceDir = (a, s) => { const U = [0, 0, 0]; U[a] = s; return norm(sub(tri(C, U), center)); };
    const chipOct = o.chip ? o.chip[0] : -1;
    const dome = lod >= 2 ? [] : (o.dome ?? []).map(([a, s, m]) => [a, s, m, faceDir(a, s)]);
    const jit = lod === 0 ? o.jitter ?? 0 : 0, seed = o.seed ?? 0;
    const skip = new Set(o.skip ?? []);
    const verts = new Map(), P = [], E = [], Q = [], idx = [];
    function vert(q) {
      const key = q.map((t) => Math.round(t * 1e5)).join(',');
      if (verts.has(key)) return verts.get(key);
      const oct = (q[0] > 0 ? 1 : 0) + (q[1] > 0 ? 2 : 0) + (q[2] > 0 ? 4 : 0);
      const bl = oct === chipOct ? bc : b;
      let p = q, edge = 0;
      if (bl > 0) {
        const inner = q.map((t, k) => Math.max(-h[k] + bl, Math.min(h[k] - bl, t))), d = sub(q, inner), dl = len(d);
        if (dl > 1e-9) { p = add(inner, mul(d, bl / dl)); edge = d.filter((x) => Math.abs(x) > 1e-9).length; }
      }
      const U = p.map((t, k) => t / h[k]);
      let w = tri(C, U);
      for (const [a, s, m, dir] of dome) {
        let f = Math.max(0, s * U[a]);
        for (let k = 0; k < 3; k++) if (k !== a) f *= Math.max(0, 1 - U[k] * U[k]);
        w = add(w, mul(dir, m * f));
      }
      if (o.bend) w = add(w, mul(o.bend, 1 - U[0] * U[0]));
      if (jit) w = add(w, mul(hash3(Math.round(U[0] * 977), Math.round(U[1] * 977), Math.round(U[2] * 977), seed), jit));
      P.push(w); E.push(edge); Q.push(q);
      verts.set(key, P.length - 1);
      return P.length - 1;
    }
    for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
      if (skip.has(`${s < 0 ? '-' : '+'}${'xyz'[a]}`)) continue;
      const u = (a + 1) % 3, v = (a + 2) % 3, cu = cs[u], cv = cs[v], fd = faceDir(a, s);
      const grid = cu.map((x) => cv.map((y) => { const q = [0, 0, 0]; q[a] = s * h[a]; q[u] = x; q[v] = y; return vert(q); }));
      for (let i = 0; i < cu.length - 1; i++) for (let j = 0; j < cv.length - 1; j++) {
        const A = grid[i][j], B = grid[i + 1][j], Cc = grid[i + 1][j + 1], D = grid[i][j + 1];
        for (const t of [[A, B, Cc], [A, Cc, D]]) {
          const n = cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]]));
          if (len(n) < 1e-12) continue;
          idx.push(...(dot(n, fd) < 0 ? [t[0], t[2], t[1]] : t));
        }
      }
    }
    // Vägda normaler: summan av triangelnormalerna viktade med ytan
    const N = P.map(() => [0, 0, 0]);
    for (let i = 0; i < idx.length; i += 3) {
      const [a, bq, c] = [idx[i], idx[i + 1], idx[i + 2]], n = cross(sub(P[bq], P[a]), sub(P[c], P[a]));
      for (const k of [a, bq, c]) N[k] = add(N[k], n);
    }
    const g = geom.geo(part), base = g.positions.length / 3, tile = o.tile ?? 1, col = o.color ?? [1, 1, 1];
    const gr = o.grain ? norm(o.grain) : null;
    P.forEach((p, i) => {
      const n = norm(N[i]);
      let uv;
      if (gr && Math.abs(dot(n, gr)) < 0.7) { const vv = norm(cross(n, gr)); uv = [dot(p, gr) / tile, dot(p, vv) / tile]; }
      else { const an = n.map(Math.abs); uv = an[1] >= an[0] && an[1] >= an[2] ? [p[0] / tile, p[2] / tile] : an[0] >= an[2] ? [p[2] / tile, -p[1] / tile] : [p[0] / tile, -p[1] / tile]; }
      let c = col;
      if (o.endColor && Math.abs(Math.abs(Q[i][0]) - h[0]) < 1e-9 && E[i] < 2) c = o.endColor;
      if (E[i] >= 2) c = c.map((x) => x * (o.edgeLight ?? 1.12));
      // målad ton: ljusare upptill, mörkare nertill (som en penselskugga)
      if (o.grad) { const ga = o.gradAxis ?? 1; c = c.map((x) => x * (1 + o.grad * (Q[i][ga] / h[ga]))); }
      geom.pushVert(g, p, n, uv, c);
    });
    for (const k of idx) g.indices.push(base + k);
    register(o.kind, P, { exact: !!o.exact, mod: o.mod });
    return P;
  }

  // Bjälke från a till b (mittlinjen). w = bredd, d = djup längs depthAxis (standard z: ut ur väggen)
  function lumber(part, a, b, w, d, o = {}) {
    const ex = norm(sub(b, a)), dz0 = o.depthAxis ?? [0, 0, 1];
    let ez = sub(dz0, mul(ex, dot(dz0, ex)));
    if (len(ez) < 1e-6) ez = [1, 0, 0];
    ez = norm(ez);
    const ey = cross(ez, ex), L = len(sub(b, a)), c = mul(add(a, b), 0.5);
    const C = boxCorners(c, [ex, ey, ez], [L + (o.extend ?? 0), w, d]);
    if (o.twist) for (let i = 0; i < 8; i++) {
      const s = i & 1 ? 1 : -1, rel = sub(C[i], add(c, mul(ex, s * L / 2))), ang = s * o.twist;
      const y = dot(rel, ey), z = dot(rel, ez);
      C[i] = add(add(c, mul(ex, s * L / 2)), add(add(mul(ey, y * Math.cos(ang) - z * Math.sin(ang)), mul(ez, y * Math.sin(ang) + z * Math.cos(ang))), mul(ex, dot(rel, ex))));
    }
    // böjen går ut ur väggens plan, så att en skev stolpe aldrig tränger in i grannmodulen
    const bend = o.warp ? mul(ez, o.warp) : null;
    return hexa(part, C, { bevel: o.bevel ?? Math.min(w, d) * 0.12, grain: ex, bend, sub: [Math.min(3, Math.floor(L / 0.8)), 0, 0], ...o, tile: o.tile ?? 1.6 });
  }

  // Konvex platta (polygon i xy, z0..z1), t.ex. putsen i en gavel. Platt skuggad
  function prism(part, pts, z0, z1, o = {}) {
    const col = o.color ?? [1, 1, 1], tile = o.tile ?? 2;
    const front = pts.map(([x, y]) => [x, y, z1]), back = pts.map(([x, y]) => [x, y, z0]).reverse();
    geom.polygon(part, front, [0, 0, 1], col, { tile });
    if (!o.noBack) geom.polygon(part, back, [0, 0, -1], col, { tile });
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length], n = norm([y1 - y0, -(x1 - x0), 0]);
      geom.quad(part, [[x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1]], n, [[0, 0], [1, 0], [1, 1], [0, 1]], col);
    }
    if (o.kind) reg.push({ kind: o.kind, prism: { pts, z0, z1 }, lo: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), z0], hi: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])), z1], exact: false });
  }

  return { geom, hexa, lumber, prism, reg, get G() { return geom.G; }, lathe: geom.lathe, quad: geom.quad, polygon: geom.polygon };
}
