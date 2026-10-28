// Former som gräver i marken (docs/terrain.md, T1–T2): splines för bäckar och åar (senare vägar), som avståndsfält.
// Ren JavaScript utan Three.js, som field.js.
//
// Avståndet mäts till närmaste *sträcka* mellan splinens punkter, inte till närmaste punkt; mätt mot punkter får
// bankarna en buckla mellan varje punkt. Bredd, vattennivå och riktning interpoleras längs sträckan, så att allt som
// läses ur formen är kontinuerligt. Fåran möter marken runt om med smooth min, så att bankkrönet blir runt i stället
// för en skarp kant.

// Mjukt minimum (polynomiskt, Inigo Quilez): som Math.min, men rundat inom k
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export const smax = (a, b, k) => -smin(-a, -b, k);
export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Catmull-Rom genom punkterna [x, z, bredd, ...], samplad ungefär var step meter. Bredden (och övriga tal) följer en
// mjuk kurva mellan punkterna. Varje prov får tangent (tx, tz) och båglängd s.
export function sampleSpline(points, step = 0.4) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t, e = t2 * (3 - 2 * t);
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: cr(p0[0], p1[0], p2[0], p3[0]), z: cr(p0[1], p1[1], p2[1], p3[1]), w: p1[2] + (p2[2] - p1[2]) * e });
    }
  }
  const last = points.at(-1);
  out.push({ x: last[0], z: last[1], w: last[2] });
  let s = 0;
  out.forEach((p, i) => {
    const q = out[Math.min(i + 1, out.length - 1)], r = out[Math.max(i - 1, 0)], tl = Math.hypot(q.x - r.x, q.z - r.z) || 1;
    p.tx = (q.x - r.x) / tl; p.tz = (q.z - r.z) / tl;
    if (i) s += Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z);
    p.s = s;
  });
  return out;
}

// Närmaste sträcka på en samplad spline, snabbt via ett rutnät av fack. reach: hur långt bort frågor behöver svar;
// längre bort ger query() null. Svaret interpolerar provens tal (w, level, depth, tx, tz, s ...) på sträckan.
export function splineIndex(smp, reach, cell = 2) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of smp) { x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z); }
  x0 -= reach; z0 -= reach; x1 += reach; z1 += reach;
  const W = Math.ceil((x1 - x0) / cell) + 1, H = Math.ceil((z1 - z0) / cell) + 1, buckets = Array.from({ length: W * H }, () => []);
  for (let i = 0; i < smp.length - 1; i++) {
    const a = smp[i], b = smp[i + 1];
    const ci0 = Math.floor((Math.min(a.x, b.x) - reach - x0) / cell), ci1 = Math.floor((Math.max(a.x, b.x) + reach - x0) / cell);
    const cj0 = Math.floor((Math.min(a.z, b.z) - reach - z0) / cell), cj1 = Math.floor((Math.max(a.z, b.z) + reach - z0) / cell);
    for (let cj = Math.max(0, cj0); cj <= Math.min(H - 1, cj1); cj++) for (let ci = Math.max(0, ci0); ci <= Math.min(W - 1, ci1); ci++) buckets[cj * W + ci].push(i);
  }
  const keys = Object.keys(smp[0]).filter((k) => typeof smp[0][k] === 'number' && k !== 'x' && k !== 'z');
  return function query(x, z) {
    const ci = Math.floor((x - x0) / cell), cj = Math.floor((z - z0) / cell);
    if (ci < 0 || cj < 0 || ci >= W || cj >= H) return null;
    let best = Infinity, bi = -1, bu = 0;
    for (const i of buckets[cj * W + ci]) {
      const a = smp[i], b = smp[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      const u = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const d = (a.x + dx * u - x) ** 2 + (a.z + dz * u - z) ** 2;
      if (d < best) { best = d; bi = i; bu = u; }
    }
    if (bi < 0 || best > reach * reach) return null;
    const a = smp[bi], b = smp[bi + 1], r = { d: Math.sqrt(best), i: bi, u: bu };
    for (const k of keys) r[k] = a[k] + (b[k] - a[k]) * bu;
    const tl = Math.hypot(r.tx, r.tz) || 1;
    r.tx /= tl; r.tz /= tl;
    r.side = Math.sign((x - (a.x + (b.x - a.x) * bu)) * -r.tz + (z - (a.z + (b.z - a.z) * bu)) * r.tx) || 1; // +1 till vänster om strömmen
    return r;
  };
}

// En bäck eller å: en fåra längs splinen, med vattenytan som sluttar nedströms och aldrig stiger.
//   path: [[x, z, halva bredden], ...] i strömmens riktning; base(x, z): marken runt om
//   bank: hur rund övergången till marken är (m); drop: hur långt under marken vattnet ligger (m)
//   levee: minsta höjd över vattnet för marken närmast fåran (m), så att vattnet aldrig rinner ut åt sidan där marken
//   runt om sjunker; lyftet tonar bort mellan 2 och 6 bredder från mitten
//   level: en fast vattennivå längs hela fåran (en vik i havets nivå) i stället för markens nivå minus drop
//   sea: havets nivå; ytan stannar där, och där fåran ligger i havet lyfts inga vallar (de blev väggar ur havsbottnen)
// Profilen över fåran är en parabel som fortsätter rakt ut (samma lutning i kanten), så att botten, vattenlinjen och
// slänten hänger ihop utan veck: höjden = nivå − djup + djup · g(d / w), g(k) = k² inne i fåran och 2k − 1 utanför.
export function createChannel({ path, base, step = 0.4, depth = (w) => 0.22 + 0.2 * w, drop = 0.32, bank = 0.7, levee = 0.3, level, sea }) {
  const smp = sampleSpline(path, step);
  let lvl = Infinity;
  for (const p of smp) {
    lvl = Math.min(lvl, base(p.x, p.z) - drop); // ytan sluttar nedströms och stiger aldrig
    p.level = level ?? lvl;
    if (sea != null) p.level = Math.max(p.level, sea);
    p.lift = sea != null && p.level <= sea + 0.01 ? 0 : 1;
    p.depth = depth(p.w);
  }
  const maxW = Math.max(...smp.map((p) => p.w));
  const reach = maxW * 6 + 8; // bortom detta ligger fårans slänt alltid över marken
  const query = splineIndex(smp, reach, Math.max(2, reach / 6)); // facken växer med räckvidden (en bred vik har 280 m)
  const profile = (q) => { const k = q.d / q.w; return q.level - q.depth + q.depth * (k < 1 ? k * k : 2 * k - 1); };
  const bedAt = (x, z) => {
    const q = query(x, z);
    if (!q) return base(x, z);
    const b = base(x, z), lift = (1 - smoothstep(q.w * 2, q.w * 6, q.d)) * (q.lift ?? 1) * (sea == null ? 1 : smoothstep(sea - 0.6, sea + 0.2, b)); // havsbotten lyfts aldrig
    return smin(b + (smax(b, q.level + levee, levee) - b) * lift, profile(q), bank);
  };
  return { smp, query, bedAt, profile, reach };
}
