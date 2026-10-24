// Kortbollar: varje boll är 6–9 platta lövkort (runda lövklasar i atlasen) som korsar varandra i samma
// centrum, roterade åt olika håll, så att de tillsammans läser som en rund buske. Bollarna sitter på
// skelettets kvistar: kvistarna delas i klasar (k-means) och varje klase får en eller flera bollar.
// Båda sidor av ett kort är egen geometri med normaler från bollens centrum (sfäriska normaler), så hela
// bollen skuggas som en mjuk volym och materialet kan vara enkelsidigt (ingen DoubleSide som vänder normalen).
// Ren JS utan Three.js/DOM.
import { add, sub, mul, dot, cross, norm, lerp, clamp01, rng, randomUnit, basis } from './vec.mjs';
import { clusterLeaves } from './canopy.mjs';

const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], cluster: [], indices: [] });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Kortens normaler, jämnt spridda (gyllene spiral) över övre halvklotet; n och -n är samma kort
function cardNormals(k, r) {
  const turn = randomUnit(r), ga = Math.PI * (3 - Math.sqrt(5)), off = r() * 6.28;
  return Array.from({ length: k }, (_, i) => {
    const y = 1 - (i + 0.5) / k; // 1 -> 0: från liggande till stående kort
    const s = Math.sqrt(1 - y * y), a = off + i * ga;
    return norm(add([s * Math.cos(a), y, s * Math.sin(a)], mul(turn, 0.25 * r())));
  });
}

/**
 * @param {number[][]} twigs  kvistpunkter från skelettet
 * @param {object} o  { seed, height, clusters, ballsPerCluster, cardsPerBall, ballScale, cardScale, minBall,
 *                      normalBlend, normalOffset, normalLift, innerTint, bottomCool, bottomCoolStrength, flattenY }
 */
export function buildCardBalls(twigs, o) {
  const r = rng(o.seed ?? 1);
  const height = o.height ?? 9;
  const clusters = clusterLeaves(twigs, o.clusters ?? 5, r, o.flattenY ?? 1);
  // Kvistarna fördelas på närmaste klase; stora klasar delas i flera bollar
  const own = clusters.map(() => []);
  for (const p of twigs) {
    let bi = 0, bd = Infinity;
    clusters.forEach((c, i) => { const d = dist(p, c.center); if (d < bd) { bd = d; bi = i; } });
    own[bi].push(p);
  }
  const balls = [];
  clusters.forEach((cl, ci) => {
    const n = o.ballsPerCluster ?? 1;
    const parts = n > 1 && own[ci].length >= n * 6 ? clusterLeaves(own[ci], n, r, o.flattenY ?? 1) : [cl];
    for (const b of parts) {
      const R = Math.max((b.radii[0] + b.radii[1] + b.radii[2]) / 3 * (o.ballScale ?? 1), (o.minBall ?? 0.07) * height);
      // Bollen sitter på en kvist: centrum dras mot närmaste kvist
      let best = own[ci][0] ?? b.center, bd = Infinity;
      for (const p of own[ci]) { const d = dist(p, b.center); if (d < bd) { bd = d; best = p; } }
      const center = bd > 0.3 * R ? lerp(best, b.center, 0.3 * R / bd) : b.center;
      balls.push({ center, radii: [R, R, R], count: b.count, ci });
    }
  });

  // Täckning: en kvist utanför alla bollar får närmaste boll att växa (högst 40 %), så att inga kala kvistar
  // sticker ut ur kronan
  for (const p of twigs) {
    let nb = null, gap = Infinity;
    for (const b of balls) { const g = dist(p, b.center) / b.radii[0]; if (g < gap) { gap = g; nb = b; } }
    if (nb && gap > 1 && (nb.grown ?? 1) * gap * 1.03 <= (o.maxGrow ?? 1.4)) {
      nb.grown = (nb.grown ?? 1) * gap * 1.03;
      nb.radii = nb.radii.map((x) => x * gap * 1.03);
    }
  }

  const crownMinY = Math.min(...balls.map((b) => b.center[1] - b.radii[0]));
  const crownMaxY = Math.max(...balls.map((b) => b.center[1] + b.radii[0]));
  const maxRadial = Math.max(...balls.map((b) => Math.hypot(b.center[0], b.center[2]) + b.radii[0]));
  const inner = o.innerTint ?? [0.34, 0.42, 0.36]; // mörk men mättad: skuggan multipliceras med lövfärgen
  const cool = o.bottomCool ?? [0.6, 0.7, 0.85];
  const shade = (p, nn, rel) => {
    const hN = clamp01((p[1] - crownMinY) / Math.max(1e-6, crownMaxY - crownMinY));
    const light = clamp01(0.35 * hN + 0.35 * clamp01(nn[1] * 0.5 + 0.5) + 0.3 * rel);
    const c = lerp(inner, [1.0, 1.0, 0.94], light ** (o.gradientFalloff ?? 0.8));
    return lerp(c, [c[0] * cool[0], c[1] * cool[1], c[2] * cool[2]], (o.bottomCoolStrength ?? 0.5) * clamp01(-nn[1]));
  };
  const windAt = (p) => clamp01(0.25 + 0.5 * Math.hypot(p[0], p[2]) / maxRadial + 0.25 * clamp01((p[1] - crownMinY) / (crownMaxY - crownMinY)));

  // Alla kort en gång; lägre LOD tar färre kort per boll och glesare rutnät.
  // cardOffset > 0: korten sitter inte alla i bollens centrum utan spridda i den (mest mot skalet), så att
  // många mindre kort (cardScale < 1) kan bygga samma boll med finare silhuett och mindre löv.
  const cpb = o.cardsPerBall ?? [6, 9];
  const cards = balls.map((b) => {
    const k = Array.isArray(cpb) ? cpb[0] + Math.floor(r() * (cpb[1] - cpb[0] + 1)) : cpb;
    return cardNormals(k, r).map((n) => {
      const [b1, b2] = basis(n), roll = r() * Math.PI * 2;
      const a = add(mul(b1, Math.cos(roll)), mul(b2, Math.sin(roll)));
      const off = mul(randomUnit(r), b.radii[0] * (o.cardOffset ?? 0) * (0.4 + 0.6 * Math.cbrt(r())));
      return { n, a, b: cross(n, a), off, cell: Math.floor(r() * 4), scale: 0.9 + 0.2 * r() };
    });
  });

  // Klasen i atlasen fyller ungefär 85 % av cellens halva bredd
  // cardGrid: hörn per kortsida (4 = 3x3 rutor). Små kort klarar sig med 3, eftersom de inte går genom centrum.
  const g0 = o.cardGrid ?? 4;
  const lodSpec = [{ grid: g0, keep: 1 }, { grid: Math.max(2, g0 - 1), keep: 0.7 }, { grid: 2, keep: 0.5 }];
  const lods = lodSpec.map(({ grid, keep }) => {
    const g = empty();
    balls.forEach((ball, bi) => {
      const R = ball.radii[0];
      const list = cards[bi].slice(0, Math.max(3, Math.round(cards[bi].length * keep)));
      for (const c of list) {
        const h = R / 0.85 * (o.cardScale ?? 1) * c.scale;
        const cc = add(ball.center, c.off);
        const cu = (c.cell % 2) * 0.5, cv = Math.floor(c.cell / 2) * 0.5;
        for (const side of [1, -1]) {
          const faceN = mul(c.n, side);
          const base = g.positions.length / 3;
          for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) {
            const u = i / (grid - 1), v = j / (grid - 1);
            const pos = add(cc, add(mul(c.a, (u * 2 - 1) * h), mul(c.b, (v * 2 - 1) * h)));
            // Sfärisk normal från ett centrum en bit bakom kortytan (och ev. sänkt, för ljusare toppar)
            const d = add(add(sub(pos, ball.center), mul(faceN, R * (o.normalOffset ?? 0.4))), [0, R * (o.normalLift ?? 0), 0]);
            const nn = norm(lerp(faceN, norm(d), o.normalBlend ?? 0.9));
            const rel = clamp01(dist(pos, ball.center) / R);
            g.positions.push(...pos);
            g.normals.push(...nn);
            g.uvs.push(cu + u * 0.5, cv + (1 - v) * 0.5);
            g.colors.push(...shade(pos, nn, rel));
            g.wind.push(windAt(pos)); // samma vikt på fram- och baksidan: hörnen delar position
            g.cluster.push(bi);
          }
          for (let j = 0; j < grid - 1; j++) for (let i = 0; i < grid - 1; i++) {
            const q = base + j * grid + i, q1 = q + 1, q2 = q + grid, q3 = q + grid + 1;
            // (a, b, n) är högerhänt: moturs sett från +n. Baksidan får omvänd ordning.
            if (side > 0) g.indices.push(q, q1, q3, q, q3, q2);
            else g.indices.push(q, q3, q1, q, q2, q3);
          }
        }
      }
    });
    return g;
  });

  const uncovered = twigs.filter((p) => !balls.some((b) => dist(p, b.center) <= b.radii[0] * 1.05)).length;
  // Mått att kontrollera med kod: bollradie och kortens sida i meter (lövens storlek följer kortet)
  const cardM = balls.flatMap((b, i) => cards[i].map((c) => 2 * b.radii[0] / 0.85 * (o.cardScale ?? 1) * c.scale));
  const mean = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length * 100) / 100;
  // Silhuett framifrån (längs z): lövklasen på varje kort (en skiva, ~85 % av kortets halva sida)
  // projiceras på xy-planet i rutor om 5 cm. Ger kronans yta och bredd/höjd utan genomskinliga korthörn.
  const cell = 0.05, hit = new Set();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  balls.forEach((b, bi) => cards[bi].forEach((c) => {
    const rr = 0.85 * b.radii[0] / 0.85 * (o.cardScale ?? 1) * c.scale, cc = add(b.center, c.off);
    const n = Math.min(20000, Math.ceil((rr / cell) ** 2 * 4));
    for (let i = 0; i < n; i++) {
      const rad = rr * Math.sqrt((i + 0.5) / n), ang = i * 2.39996;
      const q = add(cc, add(mul(c.a, rad * Math.cos(ang)), mul(c.b, rad * Math.sin(ang))));
      hit.add(`${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
  }));
  return { lods, clusters: balls, uncovered, cards: cards.reduce((s, c) => s + c.length, 0),
    ballM: mean(balls.map((b) => b.radii[0])), cardM: mean(cardM),
    silhouetteM2: Math.round(hit.size * cell * cell * 10) / 10, crownM: [Math.round((x1 - x0) * 100) / 100, Math.round((y1 - y0) * 100) / 100] };
}
