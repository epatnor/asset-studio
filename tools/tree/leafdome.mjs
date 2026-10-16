// Bladkupol: buske av solida, facetterade blad i ringar över en kupol, som fjäll eller en rosett
// (referens: stiliserade low-poly-buskar). Varje blad är en liten mesh med mittveck; ingen alfatextur,
// så ingen overdraw. Färgen kommer från paletten: mörkt nedtill och inåt, ljust mot spetsar och topp.
// Ren JS utan Three.js/DOM.
import { add, sub, mul, cross, norm, lerp, clamp01, UP, rng, randomUnit } from './vec.mjs';

const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], cluster: [], indices: [] });

// Bladets halva bredd längs u (0 = bas, 1 = spets)
const PROFILES = {
  pointed: (u) => Math.sin(Math.PI * u ** 0.7) * (1 - u) ** 0.25,
  round: (u) => Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, u * 1.02)))),
  serrated: (u) => Math.sin(Math.PI * u ** 0.7) * (1 - u) ** 0.25 * (1 - 0.28 * Math.abs(Math.sin(u * Math.PI * 5)) * clamp01((u - 0.15) / 0.2)),
};

function pushLeaf(g, base, axis, side, len, width, fold, shape, col, id, faceBlend, domeN) {
  const prof = PROFILES[shape] ?? PROFILES.pointed;
  const up = norm(cross(side, axis)); // bladets ovansida
  const rows = 5;
  const pts = [];
  for (let i = 0; i <= rows; i++) {
    const u = i / rows;
    const c = add(base, mul(axis, len * u));
    const w = prof(u) * width * 0.5;
    const ws = prof(u); // relativ bredd (0–1), för UV: bladytan mappas över bladets faktiska bredd
    // Mittvecket ligger högre än kanterna: ger de skarpa facetterna.
    // UV: x över bladet (mittnerven vid 0,5), y längs bladet (basen nederst i texturen)
    pts.push([
      { p: add(c, add(mul(side, -w), mul(up, -fold * w))), uv: [0.5 - 0.5 * ws, 1 - u] },
      { p: add(c, mul(up, fold * w * 0.4)), uv: [0.5, 1 - u] },
      { p: add(c, add(mul(side, w), mul(up, -fold * w))), uv: [0.5 + 0.5 * ws, 1 - u] },
    ]);
  }
  // Icke-indexerat med platta normaler per triangel (facetterat), lätt blandat mot kupolens normal
  const tri = (a, b, c, u) => {
    let fnRaw = norm(cross(sub(b.p, a.p), sub(c.p, a.p)));
    // Framsidan ska vetta utåt från kupolen
    if (fnRaw[0] * domeN[0] + fnRaw[1] * domeN[1] + fnRaw[2] * domeN[2] < 0) { [b, c] = [c, b]; fnRaw = mul(fnRaw, -1); }
    for (const flip of [false, true]) { // dubbelsidigt: baksidan med vänd ordning och normal
      const [p, q, t] = flip ? [a, c, b] : [a, b, c];
      const fn = flip ? mul(fnRaw, -1) : fnRaw;
      const n = norm(lerp(fn, domeN, faceBlend * (flip ? 0.3 : 1)));
      const start = g.positions.length / 3;
      for (const v of [p, q, t]) {
        g.positions.push(...v.p); g.normals.push(...n);
        g.uvs.push(...v.uv); g.colors.push(...(flip ? col.map((x) => x * 0.7) : col));
        g.wind.push(0.2 + 0.8 * u); g.cluster.push(id);
      }
      g.indices.push(start, start + 1, start + 2);
    }
  };
  for (let i = 0; i < rows; i++) {
    const [l0, m0, r0] = pts[i], [l1, m1, r1] = pts[i + 1];
    const u = (i + 0.5) / rows;
    tri(l0, m0, l1, u); tri(m0, m1, l1, u); tri(m0, r0, m1, u); tri(r0, r1, m1, u);
  }
}

/**
 * @param {object} o { seed, height, width, rings, leaves, leafLen, leafWidth, fold, shape, droop, jitter,
 *                     palette: {dark, mid, light}, faceBlend }
 */
export function buildLeafDome(o) {
  const r = rng(o.seed * 92821 + 5);
  const H = o.height, R = H * (o.width ?? 1.4) / 2;
  const thetaMax = (o.thetaMax ?? 105) * Math.PI / 180;
  const leaves = [];
  const color = (shade) => (shade < 0.5 ? lerp(o.palette.dark, o.palette.mid, shade * 2) : lerp(o.palette.mid, o.palette.light, (shade - 0.5) * 2));
  if (o.layout === 'scatter') {
    // Oregelbundet: blad spridda jämnt men slumpvis (Fibonacci-sfär + jitter) över en ellipsoid som
    // fortsätter förbi ekvatorn, så att undersidan böjer sig in mot marken (en boll, inte en hatt)
    const ry = H * 0.5, cy = H * 0.5, hs = ry / R;
    const thMax = (o.thetaMax ?? 160) * Math.PI / 180;
    const leafLen = R * (o.leafLen ?? 0.45), leafW = leafLen * (o.leafWidth ?? 0.7);
    const cap = (1 - Math.cos(thMax)) / 2; // andel av sfärens yta som täcks
    const area = 4 * Math.PI * ((R * R * 2 + R * ry) / 3) * cap;
    const N = Math.round(area / (leafLen * leafW * 0.6) * (o.overlap ?? 2.2));
    for (let i = 0; i < N; i++) {
      // Fibonacci-punkt inom polkalotten, med jitter så att inga rader syns
      const z = 1 - cap * 2 * ((i + 0.5 + (r() - 0.5) * 0.9) / N);
      const th = Math.acos(Math.max(-1, Math.min(1, z)));
      const az = i * 2.399963 + (r() - 0.5) * 0.5;
      const k = th / thMax;
      const dn = norm([Math.sin(th) * Math.cos(az), Math.cos(th) / hs, Math.sin(th) * Math.sin(az)]);
      const merid = norm([Math.cos(th) * Math.cos(az), -Math.sin(th) * hs, Math.cos(th) * Math.sin(az)]);
      const surf = [Math.sin(th) * Math.cos(az) * R * 0.88, cy + Math.cos(th) * ry * 0.88, Math.sin(th) * Math.sin(az) * R * 0.88];
      // Slumpvis vridning i ytans plan kring den nedåtgående riktningen, plus varierande lyft
      const spin = (r() - 0.5) * 2 * (o.spread ?? 55) * Math.PI / 180;
      const tdir = add(mul(merid, Math.cos(spin)), mul(cross(dn, merid), Math.sin(spin)));
      const axis = norm(add(tdir, mul(dn, (o.lift ?? 0.3) * (0.4 + r() * 0.9))));
      const len = leafLen * (0.75 + r() * 0.5);
      const base = sub(surf, mul(axis, len * 0.3));
      const side = norm(cross(axis, dn));
      // Tydlig gradient som i referensen: ljus topp, mörk undersida
      const shade = clamp01(0.78 - 0.7 * k + 0.2 * Math.max(0, dn[1]) + (r() - 0.5) * 0.2);
      leaves.push({ base, axis, side, len, width: len * (o.leafWidth ?? 0.7), col: color(shade), dn, prio: r(), k });
    }
  }
  const rings = o.layout === 'scatter' ? 0 : o.rings ?? 6;
  for (let i = 0; i < rings; i++) {
    const k = (i + 0.5) / rings;
    const th = thetaMax * k ** 0.85;
    // Antal blad per ring från ringens omkrets, så att bladen alltid överlappar (overlap > 1 = tätare)
    const ringR = R * Math.max(Math.sin(th), 0.3);
    const leafW = R * (o.leafLen ?? 0.75) * (o.leafWidth ?? 0.6);
    const n = Math.max(i === 0 ? 6 : 4, Math.round((2 * Math.PI * ringR) / leafW * (o.overlap ?? 1.6) * (0.9 + r() * 0.2)));
    const rot = r() * Math.PI * 2;
    for (let j = 0; j < n; j++) {
      const az = rot + (j / n) * Math.PI * 2 + (r() - 0.5) * 0.3;
      // Kupolens normal (tillplattad i höjdled) och meridianen nedåt längs ytan
      const hs = H * 0.9 / R;
      const dn = norm([Math.sin(th) * Math.cos(az), Math.cos(th) / hs, Math.sin(th) * Math.sin(az)]);
      const merid = norm([Math.cos(th) * Math.cos(az), -Math.sin(th) * hs, Math.cos(th) * Math.sin(az)]);
      const surf = [Math.sin(th) * Math.cos(az) * R * 0.8, H * 0.9 * Math.cos(th) * 0.85 + H * 0.05, Math.sin(th) * Math.sin(az) * R * 0.8];
      // Bladet ligger som ett fjäll längs ytan: följer meridianen nedåt, lyfts lite utåt
      let axis = norm(add(add(merid, mul(dn, o.lift ?? 0.35)), mul(randomUnit(r), o.jitter ?? 0.12)));
      if (i === 0) axis = norm(add(axis, mul(UP, 0.22))); // toppens blad reser sig lite, som en rosett
      const len = R * (o.leafLen ?? 0.75) * (0.85 + r() * 0.3) * (0.7 + 0.3 * Math.sin(Math.max(th, 0.6)));
      const base = sub(surf, mul(axis, len * 0.25)); // basen lite in under föregående rings blad
      // side i tangentplanet, så att bladets ovansida vetter utåt (up = cross(side, axis) ≈ dn)
      const side = norm(cross(axis, dn));
      const shade = clamp01(0.25 * (1 - k) + 0.45 + (r() - 0.5) * 0.25);
      const col = shade < 0.5 ? lerp(o.palette.dark, o.palette.mid, shade * 2) : lerp(o.palette.mid, o.palette.light, (shade - 0.5) * 2);
      leaves.push({ base, axis, side, len, width: len * (o.leafWidth ?? 0.6), col, dn, prio: r(), k });
    }
  }
  const lodDefs = [{ keep: 1, scale: 1 }, { keep: 0.6, scale: 1.2 }, { keep: 0.32, scale: 1.45 }];
  const lods = lodDefs.map(({ keep, scale }) => {
    const g = empty();
    leaves.forEach((l, id) => {
      if (l.prio >= keep && l.k > 0.2) return; // toppens rosett behålls alltid
      pushLeaf(g, l.base, l.axis, l.side, l.len * scale, l.width * scale, o.fold ?? 0.35, o.shape ?? 'pointed', l.col, id, o.faceBlend ?? 0.35, l.dn);
    });
    return g;
  });
  return { lods, leaves: leaves.length };
}
