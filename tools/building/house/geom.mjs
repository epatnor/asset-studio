// Geometrihjälparna för husen (docs/buildings.md, del 3): samma former som i gen_building.mjs (avfasade lådor med
// platta sidor och rundade kanter, bjälkar, skivor, svarvade former, plana ytor), men med sitt sammanhang (vilken
// LOD, stiliseringen, texturernas storlek) i ett objekt i stället för globala variabler, så att flera generatorer
// kan dela dem. Texturkoordinaterna är i meter, projicerade på ytans plan.
import { add, sub, mul, dot, cross, norm, len, UP } from '../../tree/vec.mjs';

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const toWorld = (c, ax, q) => add(c, add(add(mul(ax[0], q[0]), mul(ax[1], q[1])), mul(ax[2], q[2])));
const dirWorld = (ax, q) => norm(add(add(mul(ax[0], q[0]), mul(ax[1], q[1])), mul(ax[2], q[2])));

// ctx: { lod: { segs, detail }, bevel (andel av minsta måttet), tile: { del: meter } }. G: del → geometri
export function createGeom(ctx) {
  let G = {};
  const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], indices: [] });
  const geo = (part) => (G[part] ??= empty());
  function uvAxes(N, ax, size, grain) {
    if (grain) {
      const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
      for (const k of order) if (Math.abs(dot(ax[k], N)) < 0.5) { const u = ax[k]; return [u, norm(cross(N, u))]; }
    }
    if (Math.abs(N[1]) > 0.92) return [ax[0], ax[2]];
    const u = norm(cross(UP, N));
    return [u, norm(cross(N, u))];
  }
  function pushVert(g, p, n, uv, c, w = 0) {
    g.positions.push(...p); g.normals.push(...n); g.uvs.push(...uv); g.colors.push(...c); g.wind.push(w);
    return g.positions.length / 3 - 1;
  }
  const tileOf = (part) => ctx.tile[part.split(':')[0]] ?? 1;
  // Avfasad låda (se gen_building.mjs): size i lådans axlar ax, color = vertexfärg, grain = texturen längs längsta axeln
  function box(part, c, size, { ax = I3, bevel, segs = ctx.lod.segs, color = [1, 1, 1], grain = part === 'trim', tile = tileOf(part) } = {}) {
    if (ctx.lod.detail < 1 && Math.min(...size) < 0.06) return;
    const g = geo(part), h = size.map((s) => s / 2);
    const b = segs > 0 ? Math.min(bevel ?? Math.min(...size) * ctx.bevel * 2.2, Math.min(...h) * 0.45) : 0;
    const sg = b > 0 ? (Math.min(...size) < 0.4 ? Math.min(segs, 1) : segs) : 0;
    if (sg === 1) return chamferBox(g, c, h, b, ax, size, color, grain, tile);
    const coords = (hh) => {
      if (!sg) return [-hh, hh];
      const lo = [], hi = [];
      for (let i = 0; i <= sg; i++) { lo.push(-hh + (b * i) / sg); hi.push(hh - b + (b * i) / sg); }
      return [...lo, ...hi];
    };
    for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
      const [u, v] = [(a + 1) % 3, (a + 2) % 3];
      const cu = coords(h[u]), cv = coords(h[v]);
      const fn = [0, 0, 0]; fn[a] = s;
      const N = dirWorld(ax, fn), [uA, vA] = uvAxes(N, ax, size, grain), start = g.positions.length / 3;
      for (const x of cu) for (const y of cv) {
        const q = [0, 0, 0]; q[a] = s * h[a]; q[u] = x; q[v] = y;
        let n = fn, p = q, edge = 1;
        if (b > 0) {
          const inner = q.map((t, k) => Math.max(-h[k] + b, Math.min(h[k] - b, t)));
          const d = sub(q, inner);
          if (len(d) > 1e-9) { n = norm(d); p = add(inner, mul(n, b)); if (Math.abs(n[a]) < 0.999) edge = 1.1; }
        }
        const wp = toWorld(c, ax, p);
        pushVert(g, wp, dirWorld(ax, n), [dot(wp, uA) / tile, -dot(wp, vA) / tile], color.map((x) => x * edge));
      }
      const nv = cv.length;
      for (let i = 0; i < cu.length - 1; i++) for (let j = 0; j < nv - 1; j++) { const k = start + i * nv + j; g.indices.push(k, k + nv, k + 1, k + 1, k + nv, k + nv + 1); }
    }
  }
  function chamferBox(g, c, h, b, ax, size, color, grain, tile) {
    const hi = h.map((x) => x - b);
    const pt = (sgn, k) => { const q = sgn.map((sv, i) => sv * hi[i]); q[k] += sgn[k] * b; return toWorld(c, ax, q); };
    const facet = (pts, nLocal, edge) => {
      const N = dirWorld(ax, nLocal), [uA, vA] = uvAxes(N, ax, size, grain);
      const idx = pts.map((p) => pushVert(g, p, N, [dot(p, uA) / tile, -dot(p, vA) / tile], edge ? color.map((x) => x * 1.1) : color));
      g.indices.push(idx[0], idx[1], idx[2]);
      if (idx.length === 4) g.indices.push(idx[0], idx[2], idx[3]);
    };
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3, v = (a + 2) % 3;
      for (const sa of [-1, 1]) {
        const sgn = (su, sv) => { const x = [0, 0, 0]; x[a] = sa; x[u] = su; x[v] = sv; return x; };
        const n = [0, 0, 0]; n[a] = sa;
        facet([pt(sgn(-1, -1), a), pt(sgn(1, -1), a), pt(sgn(1, 1), a), pt(sgn(-1, 1), a)], n, false);
      }
      for (const su of [-1, 1]) for (const sv of [-1, 1]) {
        const sgn = (sa) => { const x = [0, 0, 0]; x[a] = sa; x[u] = su; x[v] = sv; return x; };
        const n = [0, 0, 0]; n[u] = su; n[v] = sv;
        facet([pt(sgn(-1), u), pt(sgn(-1), v), pt(sgn(1), v), pt(sgn(1), u)], norm(n), true);
      }
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) facet([0, 1, 2].map((k) => pt([sx, sy, sz], k)), norm([sx, sy, sz]), true);
  }
  // Låda mellan två punkter (bjälke, stag), tvärsnitt t1 × t2
  function beam(part, a, b, t1, t2 = t1, opts = {}) {
    const d = sub(b, a), L = len(d), ex = norm(d), ref = Math.abs(ex[1]) > 0.9 ? [1, 0, 0] : UP;
    const ez = norm(cross(ex, ref)), ey = cross(ez, ex);
    box(part, mul(add(a, b), 0.5), [L, t1, t2], { ax: [ex, ey, ez], ...opts });
  }
  // Skiva mellan två punkter med bredden längs en given axel; vänder sig aldrig när riktningen är brant
  function slab(part, a, b, thick, width, widthAxis, opts = {}) {
    const d = sub(b, a), ex = norm(d), ez = norm(widthAxis), ey = norm(cross(ez, ex));
    box(part, mul(add(a, b), 0.5), [len(d), thick, width], { ax: [ex, ey, ez], ...opts });
  }
  // Svarvad form runt en lodrät axel: profile [[radie, höjd], ...]
  function lathe(part, c, profile, sides, { color = [1, 1, 1], tile = tileOf(part), cap = false } = {}) {
    const g = geo(part);
    const ringPt = (i, k) => { const [rad, y] = profile[i], a = (k / sides) * Math.PI * 2; return [c[0] + Math.cos(a) * rad, c[1] + y, c[2] + Math.sin(a) * rad]; };
    const profN = (i, a) => {
      const [r0, y0] = profile[Math.max(0, i - 1)], [r1, y1] = profile[Math.min(profile.length - 1, i + 1)], t = [r1 - r0, y1 - y0], tl = Math.hypot(...t) || 1;
      return norm([Math.cos(a) * (t[1] / tl), -t[0] / tl, Math.sin(a) * (t[1] / tl)]);
    };
    for (let i = 0; i < profile.length - 1; i++) for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2, P = [ringPt(i, k), ringPt(i, k + 1), ringPt(i + 1, k + 1), ringPt(i + 1, k)];
      const N = [profN(i, a0), profN(i, a1), profN(i + 1, a1), profN(i + 1, a0)];
      const idx = P.map((p, j) => pushVert(g, p, N[j], [((k + (j === 1 || j === 2 ? 1 : 0)) * 2 * Math.PI * Math.max(profile[j < 2 ? i : i + 1][0], 0.2)) / sides / tile, -p[1] / tile], color));
      g.indices.push(idx[0], idx[1], idx[2], idx[0], idx[2], idx[3]);
    }
    if (cap) {
      const top = profile.length - 1, ci = pushVert(g, [c[0], c[1] + profile[top][1], c[2]], UP, [0, 0], color);
      for (let k = 0; k < sides; k++) { const a = pushVert(g, ringPt(top, k), UP, [0, 0], color), b = pushVert(g, ringPt(top, k + 1), UP, [0, 0], color); g.indices.push(ci, a, b); }
    }
  }
  // Plan konvex polygon (pts i världen, n = normal), som en solfjäder; uv projicerad på planet
  function polygon(part, pts, n, color = [1, 1, 1], { tile = tileOf(part), colors = null } = {}) {
    const g = geo(part), [uA, vA] = uvAxes(n, I3, [1, 1, 1], false);
    const idx = pts.map((p, i) => pushVert(g, p, n, [dot(p, uA) / tile, -dot(p, vA) / tile], colors ? colors[i] : color));
    for (let i = 1; i < idx.length - 1; i++) g.indices.push(idx[0], idx[i], idx[i + 1]);
  }
  // Fyrhörning med egna texturkoordinater (väggar: u längs väggen, v uppåt)
  function quad(part, pts, n, uvs, color = [1, 1, 1]) {
    const g = geo(part), idx = pts.map((p, i) => pushVert(g, p, n, uvs[i], Array.isArray(color[0]) ? color[i] : color));
    g.indices.push(idx[0], idx[1], idx[2], idx[0], idx[2], idx[3]);
  }
  function blob(part, c, rad, { sc = [1, 1, 1], color = [1, 1, 1], w = 0, seg = rad < 0.08 ? 3 : ctx.lod.detail > 1 ? 5 : 3 } = {}) {
    const g = geo(part), start = g.positions.length / 3, rows = seg, cols = seg + 2;
    for (let i = 0; i <= rows; i++) for (let k = 0; k <= cols; k++) {
      const th = (i / rows) * Math.PI, ph = (k / cols) * Math.PI * 2, d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      pushVert(g, add(c, [d[0] * rad * sc[0], d[1] * rad * sc[1], d[2] * rad * sc[2]]), norm([d[0] / sc[0], d[1] / sc[1], d[2] / sc[2]]), [k / cols, i / rows], color, w);
    }
    for (let i = 0; i < rows; i++) for (let k = 0; k < cols; k++) { const a = start + i * (cols + 1) + k; g.indices.push(a, a + cols + 1, a + 1, a + 1, a + cols + 1, a + cols + 2); }
  }
  return {
    get G() { return G; }, reset() { G = {}; }, geo, box, beam, slab, lathe, polygon, quad, blob, uvAxes, pushVert,
  };
}
