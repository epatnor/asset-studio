// Kortbollar: varje boll är 6–9 platta lövkort (runda lövklasar i atlasen) som korsar varandra i samma
// centrum, roterade åt olika håll, så att de tillsammans läser som en rund buske. Bollarna sitter på
// skelettets kvistar: kvistarna delas i klasar (k-means) och varje klase får en eller flera bollar.
// Båda sidor av ett kort är egen geometri med normaler från bollens centrum (sfäriska normaler), så hela
// bollen skuggas som en mjuk volym och materialet kan vara enkelsidigt (ingen DoubleSide som vänder normalen).
// Ren JS utan Three.js/DOM.
import { add, sub, mul, dot, cross, norm, lerp, clamp01, rng, randomUnit, basis, UP } from './vec.mjs';
import { clusterLeaves, icosphere } from './canopy.mjs';
import { gradient } from './crown.mjs';
import { twigPoints } from './skeleton.mjs';

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

// Bollarna följer skelettet (som leder i ett IK-skelett): kronan börjar som en grupp (hela trädet), och den mest
// utspridda gruppen delas tills det finns k grupper. En grupp är en gren med en del av sina barngrenar (och deras
// underträd); den delas i två genom att barngrenarna fördelas på två rumsliga halvor (2-means på underträdens
// tyngdpunkter). Har gruppen bara ett barn och inga egna kvistar går den vidare ned till barnet. Varje boll sätts
// sedan på den grenpunkt i den egna gruppen som ligger närmast gruppens kvistar, så att den alltid sitter på en gren
// och följer med sin gren i vinden.
export function skeletonGroups(sk, k, flattenY = 1) {
  const B = sk.branches, maxLevel = sk.maxLevel ?? Math.max(...B.map((b) => b.level));
  const kids = B.map(() => []);
  B.forEach((b, i) => { if (b.parent >= 0) kids[b.parent].push(i); });
  // Samma kvistpunkter som twigsOf: yttre delen av de yngsta grenarna och av alla grenar utan barn
  const own = B.map((b) => twigPoints(b, maxLevel));
  const memo = new Map();
  const subPts = (i) => memo.get(i) ?? memo.set(i, [...own[i], ...kids[i].flatMap(subPts)]).get(i);
  const subBranches = (i) => [i, ...kids[i].flatMap(subBranches)];
  const unit = (b, ks, withOwn) => ({ b, ks, withOwn, pts: [...(withOwn ? own[b] : []), ...ks.flatMap(subPts)] });
  const mean = (pts) => mul(pts.reduce(add, [0, 0, 0]), 1 / Math.max(1, pts.length));
  const spread = (u) => { const c = mean(u.pts); return Math.sqrt(u.pts.reduce((a, p) => a + dist(p, c) ** 2, 0) / Math.max(1, u.pts.length)) * Math.sqrt(u.pts.length); };
  // Går ned genom grenar som bara bär ett barn
  const settle = (u) => {
    while (!u.withOwn || !own[u.b].length) {
      if (u.ks.length !== 1) break;
      const c = u.ks[0];
      u = unit(c, kids[c], true);
    }
    return u;
  };
  let units = [settle(unit(0, kids[0], true))].filter((u) => u.pts.length);
  while (units.length < k) {
    const cand = units.filter((u) => u.pts.length >= 4 && (u.ks.length >= 2 || (u.ks.length === 1 && u.withOwn && own[u.b].length)));
    if (!cand.length) break;
    const u = cand.reduce((a, c) => (spread(c) > spread(a) ? c : a));
    let parts;
    if (u.ks.length === 1) parts = [unit(u.b, [], true), unit(u.ks[0], kids[u.ks[0]], true)];
    else {
      // 2-means på barnens tyngdpunkter, start i de två som ligger längst isär
      const cs = u.ks.map((c) => mean(subPts(c)));
      let ia = 0, ib = 1, far = -1;
      cs.forEach((a, i) => cs.forEach((b, j) => { const d = dist(a, b); if (d > far) { far = d; ia = i; ib = j; } }));
      let ca = cs[ia], cb = cs[ib], side = [];
      for (let it = 0; it < 8; it++) {
        side = cs.map((c) => (dist(c, ca) <= dist(c, cb) ? 0 : 1));
        const A = cs.filter((_, i) => side[i] === 0), Bs = cs.filter((_, i) => side[i] === 1);
        if (!A.length || !Bs.length) break;
        ca = mean(A); cb = mean(Bs);
      }
      const ka = u.ks.filter((_, i) => side[i] === 0), kb = u.ks.filter((_, i) => side[i] === 1);
      if (!ka.length || !kb.length) { ka.splice(0, ka.length, ...u.ks.slice(0, 1)); kb.splice(0, kb.length, ...u.ks.slice(1)); }
      // Grenens egna kvistar följer den halva vars tyngdpunkt ligger närmast dem
      const ownA = u.withOwn && own[u.b].length && dist(mean(own[u.b]), ca) <= dist(mean(own[u.b]), cb);
      parts = [unit(u.b, ka, !!ownA), unit(u.b, kb, u.withOwn && !ownA)];
    }
    units = units.filter((x) => x !== u).concat(parts.map(settle).filter((x) => x.pts.length));
  }
  return units.map((u) => {
    const c = mean(u.pts);
    // Närmaste grenpunkt i gruppen (grenen själv och barnens underträd)
    const branches = [u.b, ...u.ks.flatMap(subBranches)];
    let best = c, bd = Infinity;
    for (const i of branches) for (const n of B[i].nodes) { const d = dist(n.p, c); if (d < bd) { bd = d; best = n.p; } }
    const center = lerp(best, c, 0.35);
    const sd = [0, 1, 2].map((ax) => Math.sqrt(u.pts.reduce((a, p) => a + (p[ax] - center[ax]) ** 2, 0) / u.pts.length));
    const base = Math.max(...sd) * 0.6;
    const radii = sd.map((x) => Math.max(x * 1.9, base));
    radii[1] *= flattenY;
    return { center, radii, count: u.pts.length, pts: u.pts };
  });
}

/**
 * @param {number[][]} twigs  kvistpunkter från skelettet
 * @param {object} o  { seed, height, clusters, ballsPerCluster, cardsPerBall, ballScale, cardScale, minBall,
 *                      normalBlend, normalOffset, normalLift, innerTint, bottomCool, bottomCoolStrength, flattenY, ballSpread }
 */
export function buildCardBalls(twigs, o) {
  const r = rng(o.seed ?? 1);
  const height = o.height ?? 9;
  // Bollarna följer skelettet (skeletonGroups); placement "twigs" ger den gamla k-means över kvistpunkterna
  const bySkeleton = o.skeleton && o.placement !== 'twigs';
  const clusters = bySkeleton ? skeletonGroups(o.skeleton, o.clusters ?? 5, o.flattenY ?? 1) : clusterLeaves(twigs, o.clusters ?? 5, r, o.flattenY ?? 1);
  // Kvistarna fördelas på närmaste klase (skelettets grupper har redan sina); stora klasar delas i flera bollar
  const own = clusters.map((c) => (bySkeleton ? c.pts : []));
  if (!bySkeleton) for (const p of twigs) {
    let bi = 0, bd = Infinity;
    clusters.forEach((c, i) => { const d = dist(p, c.center); if (d < bd) { bd = d; bi = i; } });
    own[bi].push(p);
  }
  const balls = [];
  // ballSpread (0–1) särar på bollarna: varje boll flyttas utåt från kronans mitt, till de yttre kvistarna i sin
  // egen klase. Den sitter alltså kvar på skelettet, men det blir glipor mellan bollarna och kronan blir klumpigare.
  const spread = o.ballSpread ?? 0;
  const mid = twigs.reduce((a, p) => add(a, p), [0, 0, 0]).map((v) => v / Math.max(1, twigs.length));
  clusters.forEach((cl, ci) => {
    const n = o.ballsPerCluster ?? 1;
    const parts = n > 1 && own[ci].length >= n * 6 ? clusterLeaves(own[ci], n, r, o.flattenY ?? 1) : [cl];
    for (const b of parts) {
      const R = Math.max((b.radii[0] + b.radii[1] + b.radii[2]) / 3 * (o.ballScale ?? 1), (o.minBall ?? 0.07) * height);
      // Bollen sitter på en kvist: centrum dras mot närmaste kvist
      let aim = b.center;
      if (spread > 0 && own[ci].length) {
        const out = sub(b.center, mid), want = add(b.center, mul([out[0], out[1] * 0.6, out[2]], spread));
        let far = own[ci][0], fd = Infinity;
        for (const p of own[ci]) { const d = dist(p, want); if (d < fd) { fd = d; far = p; } }
        aim = lerp(b.center, far, Math.min(1, spread * 1.5));
      }
      let best = own[ci][0] ?? aim, bd = Infinity;
      for (const p of own[ci]) { const d = dist(p, aim); if (d < bd) { bd = d; best = p; } }
      const center = bd > 0.3 * R ? lerp(best, aim, 0.3 * R / bd) : aim;
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

  // Spetsbollar: en grenspets som inte ligger väl inne i en boll får en egen liten boll strax utanför spetsen
  // (tipBall = radie i meter, tipCards kort, ofta en trea), så att avstumpade grenar inte syns i kronans kant
  if (o.tipBall && o.tips) {
    const main = balls.slice();
    for (const t of o.tips) {
      if (main.some((b) => dist(t.p, b.center) <= b.radii[0] * (o.tipCover ?? 0.75))) continue;
      const c = add(t.p, mul(t.d, o.tipBall * 0.3));
      if (balls.some((b) => b.tip && dist(c, b.center) < o.tipBall * 0.8)) continue;
      balls.push({ center: c, radii: [o.tipBall, o.tipBall, o.tipBall], count: 1, ci: 0, tip: true });
    }
  }

  // Stamlösa buskar (ground): bollarna ställs på marken (y = 0) med ett mjukt golv per boll. Höga bollar följer
  // med rakt, men bollar nära marken pressas ihop i höjdled i stället för att hamna under den (ingen geometri
  // eller vind under marken i onödan). groundLift (m) lyfter busken: de övre bollarna följer direkt, de nedre
  // lossnar från marken först när lyftet når dem. groundSink: hur stor del av lövverkets räckvidd som får ligga i marken.
  if (o.ground) {
    const y0 = Math.min(...balls.map((b) => b.center[1]));
    const meanR = balls.reduce((acc, b) => acc + b.radii[0], 0) / balls.length, k = 0.35 * meanR;
    const softplus = (x) => (x > 20 * k ? x : k * Math.log1p(Math.exp(x / k)));
    for (const b of balls) {
      // Hur långt ner bollens lövkort når: spridningen i bollen plus kortets halva höjd (klasen fyller ~85 %)
      const h = o.cardSize ? o.cardSize / 2 : (b.radii[0] / 0.85) * (o.cardScale ?? 1);
      const reach = Math.max(b.radii[0], b.radii[0] * (o.cardOffset ?? 0) + 0.85 * h);
      const floor = reach * (1 - (o.groundSink ?? 0.15)); // lägsta tillåtna centrum
      b.center = [b.center[0], floor + softplus(b.center[1] - y0 + (o.groundLift ?? 0) - floor), b.center[2]];
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
  // Kortets halva sida: cardSize (meter) ger samma kort och lövstorlek oavsett bollens storlek, annars
  // följer kortet bollen (cardScale). Klasen i atlasen fyller ungefär 85 % av halva sidan.
  const halfOf = (b, c) => (o.cardSize ? o.cardSize / 2 : b.radii[0] / 0.85 * (o.cardScale ?? 1)) * c.scale;
  // Kortets halva bredd: cardWidth (meter) gör korten rektangulära (löven sträcks med), annars kvadratiska
  const halfW = (b, c) => (o.cardWidth ? (o.cardWidth / 2) * c.scale : halfOf(b, c));
  // cardGroup 3: korten kommer i treor som skär varandra vinkelrätt (x, y, z) runt samma punkt, så att inget
  // kort hänger ensamt eller bara sitter i ett kors. groupJitter (radianer) vrider dem lite ur vinkel.
  const cpb = o.cardsPerBall ?? [6, 9];
  const offsetOf = (b) => {
    // Avstånd från bollens centrum: mest mot skalet (cardCore 0) eller jämnt i radie, vilket ger en tät
    // kärna eftersom volymen är liten nära centrum (cardCore 1)
    const t = r(), radial = (0.4 + 0.6 * Math.cbrt(t)) * (1 - (o.cardCore ?? 0)) + t * (o.cardCore ?? 0);
    return mul(randomUnit(r), b.radii[0] * (o.cardOffset ?? 0) * radial);
  };
  const cardOn = (n, off, scale) => {
    const [b1, b2] = basis(n), roll = r() * Math.PI * 2;
    const a = add(mul(b1, Math.cos(roll)), mul(b2, Math.sin(roll)));
    return { n, a, b: cross(n, a), off, cell: Math.floor(r() * 4), scale };
  };
  const cards = balls.map((b) => {
    // cardsPerM2: antal kort efter bollens yta (större bollar får fler kort och samma täthet)
    const k = b.tip ? (o.tipCards ?? 3) : o.cardsPerM2 ? Math.max(3, Math.round(o.cardsPerM2 * 4 * Math.PI * b.radii[0] ** 2 * (0.9 + 0.2 * r())))
      : Array.isArray(cpb) ? cpb[0] + Math.floor(r() * (cpb[1] - cpb[0] + 1)) : cpb;
    if (o.cardGroup === 'drape') {
      // Draperi (björk, senare palmer och ormbunkar): drapeArms böjda remsor från en gemensam toppunkt, som
      // en stjärna uppifrån. Remsorna börjar lite uppåt, böjer mjukt över (rundad topp, inget spjut) och
      // hänger sedan ner, så att de hängande kvistarna sitter ihop i toppen i stället för att hänga från ingenting.
      const m = o.drapeArms ?? 5;
      return Array.from({ length: Math.max(1, Math.round(k / m)) }, () => {
        const off = offsetOf(b), yaw0 = r() * Math.PI * 2, scale = 0.9 + 0.2 * r();
        return Array.from({ length: m }, (_, j) => {
          const yaw = yaw0 + (j * Math.PI * 2) / m + (r() - 0.5) * 0.4;
          const dir = [Math.cos(yaw), 0, Math.sin(yaw)], side = norm(cross(UP, dir));
          // n, a, b behövs bara för silhuettmåttet; geometrin följer kurvan i drapePos
          return { drape: true, dir, n: side, a: side, b: dir, off, cell: Math.floor(r() * 4), scale: scale * (0.9 + 0.2 * r()) };
        });
      }).flat();
    }
    if (o.cardGroup === 'hang') {
      // Hängande kort (björk, pil): lodräta kort i grupper som korsar varandra runt en lodrät axel, med
      // arkets överkant uppåt (b längs världens upp), så att kvistarna i arket alltid hänger nedåt
      const m = o.hangPlanes ?? 3;
      return Array.from({ length: Math.max(1, Math.round(k / m)) }, () => {
        const off = offsetOf(b), yaw0 = r() * Math.PI, scale = 0.9 + 0.2 * r();
        return Array.from({ length: m }, (_, j) => {
          const yaw = yaw0 + (j * Math.PI) / m + (r() - 0.5) * 0.2;
          const n = norm([Math.cos(yaw), (r() - 0.5) * 0.15, Math.sin(yaw)]), a = norm(cross(UP, n));
          return { n, a, b: cross(n, a), off, cell: Math.floor(r() * 4), scale: scale * (0.95 + 0.1 * r()) };
        });
      }).flat();
    }
    if (o.cardGroup === 3) {
      return Array.from({ length: Math.max(1, Math.round(k / 3)) }, () => {
        const off = offsetOf(b), e1 = randomUnit(r), e2 = basis(e1)[0], scale = 0.9 + 0.2 * r();
        const tilt = (e) => norm(add(e, mul(randomUnit(r), o.groupJitter ?? 0)));
        return [e1, e2, cross(e1, e2)].map((e) => cardOn(tilt(e), off, scale * (0.95 + 0.1 * r())));
      }).flat();
    }
    return cardNormals(k, r).map((n) => {
      return cardOn(n, offsetOf(b), 0.9 + 0.2 * r());
    });
  });

  // Klasen i atlasen fyller ungefär 85 % av cellens halva bredd
  // cardGrid: hörn per kortsida (4 = 3x3 rutor). Små kort klarar sig med 3, eftersom de inte går genom centrum.
  const g0 = o.cardGrid ?? 4;
  const lodSpec = [{ grid: g0, keep: 1 }, { grid: Math.max(2, g0 - 1), keep: 0.7 }, { grid: 2, keep: 0.5 }];
  // normalSource "crown": normalerna (och djupet för färgen) tas från en mjuk union av alla bollar i stället
  // för från varje boll. Kort som korsar varandra på samma ställe får då samma ljus, och bollarna skuggas
  // som en sammanhängande, uppblåst krona utan skarvar (Ghibli-liknande målad volym).
  const meanR = balls.reduce((s, b) => s + b.radii[0], 0) / balls.length;
  const kU = (o.crownUnion ?? 0.8) * meanR;
  const smin = (a, b) => { const hh = Math.max(kU - Math.abs(a - b), 0) / kU; return Math.min(a, b) - hh * hh * kU * 0.25; };
  const crownF = o.normalSource === 'crown' ? (p) => balls.reduce((acc, b) => smin(acc, dist(p, b.center) - b.radii[0]), Infinity) : null;
  // Punkt på ett kort: u tvärs (0..1), v längs (1 = arkets överkant). Platta kort är kvadrater runt mitten;
  // draperier följer en böjd bana från toppunkten (rundad uppåt-över-ned) och smalnar mot toppen.
  const drapePos = (ball, c, h, u, v) => {
    const top = add(add(ball.center, c.off), [0, h * (o.drapeRise ?? 0.5), 0]);
    const L = 2 * h * (o.drapeLength ?? 1), sEnd = 1 - v, steps = 10, th0 = -(o.drapeLift ?? 0.45), k = o.drapeDroop ?? 3.5;
    let p = top;
    for (let i = 0; i < steps; i++) {
      const sm = ((i + 0.5) / steps) * sEnd, th = th0 + (Math.PI / 2 - th0) * (1 - Math.exp(-sm * k));
      p = add(p, mul(add(mul(c.dir, Math.cos(th)), [0, -Math.sin(th), 0]), (L * sEnd) / steps));
    }
    const wid = h * (o.drapeWidth ?? 0.8) * (0.3 + 0.7 * Math.sqrt(sEnd));
    return add(p, mul(c.a, (u * 2 - 1) * wid));
  };
  const cardPos = (ball, c, h, u, v) => c.drape ? drapePos(ball, c, h, u, v)
    : add(add(ball.center, c.off), add(mul(c.a, (u * 2 - 1) * halfW(ball, c)), mul(c.b, (v * 2 - 1) * h)));
  const lods = lodSpec.map(({ grid, keep }) => {
    const g = empty();
    balls.forEach((ball, bi) => {
      const R = ball.radii[0];
      // Lägre LOD behåller hela treor, så att inga ensamma kort uppstår
      const step = o.cardGroup === 3 ? 3 : o.cardGroup === 'hang' ? (o.hangPlanes ?? 3) : o.cardGroup === 'drape' ? (o.drapeArms ?? 5) : 1;
      const list = cards[bi].slice(0, Math.max(3, Math.round(cards[bi].length * keep / step) * step));
      for (const c of list) {
        const h = halfOf(ball, c);
        const cu = (c.cell % 2) * 0.5, cv = Math.floor(c.cell / 2) * 0.5;
        const gu = grid, gv = c.drape ? grid + 2 : grid; // draperier behöver fler rader för böjen
        for (const side of [1, -1]) {
          const faceN = mul(c.drape ? norm(cross(c.a, sub(cardPos(ball, c, h, 0.5, 0.6), cardPos(ball, c, h, 0.5, 0.4)))) : c.n, side);
          const base = g.positions.length / 3;
          for (let j = 0; j < gv; j++) for (let i = 0; i < gu; i++) {
            const u = i / (gu - 1), v = j / (gv - 1);
            const pos = cardPos(ball, c, h, u, v);
            let nn, rel;
            if (crownF) {
              const gn = gradient(crownF, pos, meanR * 0.05);
              nn = norm(lerp(faceN, norm(add(gn, [0, o.normalLift ?? 0, 0])), o.normalBlend ?? 1));
              rel = clamp01(1 + crownF(pos) / meanR); // 1 vid kronans yta, 0 djupt inne
            } else {
              // Sfärisk normal från ett centrum en bit bakom kortytan (och ev. sänkt, för ljusare toppar)
              const d = add(add(sub(pos, ball.center), mul(faceN, R * (o.normalOffset ?? 0.4))), [0, R * (o.normalLift ?? 0), 0]);
              nn = norm(lerp(faceN, norm(d), o.normalBlend ?? 0.9));
              rel = clamp01(dist(pos, ball.center) / R);
            }
            g.positions.push(...pos);
            g.normals.push(...nn);
            g.uvs.push(cu + u * 0.5, cv + (1 - v) * 0.5);
            g.colors.push(...shade(pos, nn, rel));
            g.wind.push(windAt(pos)); // samma vikt på fram- och baksidan: hörnen delar position
            g.cluster.push(bi);
          }
          for (let j = 0; j < gv - 1; j++) for (let i = 0; i < gu - 1; i++) {
            const q = base + j * gu + i, q1 = q + 1, q2 = q + gu, q3 = q + gu + 1;
            // (a, b, n) är högerhänt: moturs sett från +n. Baksidan får omvänd ordning.
            if (side > 0) g.indices.push(q, q1, q3, q, q3, q2);
            else g.indices.push(q, q3, q1, q, q2, q3);
          }
        }
      }
    });
    return g;
  });

  // Stamlösa buskar har inga synliga kvistar (bollarna är flyttade från skelettet)
  const uncovered = o.ground ? 0 : twigs.filter((p) => !balls.some((b) => dist(p, b.center) <= b.radii[0] * 1.05)).length;
  // Mått att kontrollera med kod: bollradie och kortens sida i meter (lövens storlek följer kortet)
  const cardM = balls.flatMap((b, i) => cards[i].map((c) => 2 * halfOf(b, c)));
  const mean = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length * 100) / 100;
  // Silhuett framifrån (längs z): lövklasen på varje kort (en skiva, ~85 % av kortets halva sida)
  // projiceras på xy-planet i rutor om 5 cm. Ger kronans yta och bredd/höjd utan genomskinliga korthörn.
  const cell = 0.05, hit = new Set();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  balls.forEach((b, bi) => cards[bi].forEach((c) => {
    const h = halfOf(b, c), rr = 0.85 * h, wr = c.drape ? 1 : halfW(b, c) / h, cc = add(b.center, c.off);
    const n = Math.min(20000, Math.ceil((rr / cell) ** 2 * 4));
    for (let i = 0; i < n; i++) {
      const rad = rr * Math.sqrt((i + 0.5) / n), ang = i * 2.39996;
      // Draperier: samma skiva lagd på remsans böjda bana (u tvärs, v längs)
      const q = c.drape ? cardPos(b, c, h, 0.5 + 0.5 * (rad / h) * Math.cos(ang), 0.5 + 0.5 * (rad / h) * Math.sin(ang))
        : add(cc, add(mul(c.a, rad * wr * Math.cos(ang)), mul(c.b, rad * Math.sin(ang))));
      hit.add(`${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
  }));
  // Skuggform: samma sfärer som ger kronnormalerna (som tutorialens icosphere), lite mindre än bollen.
  // Korten kastar inga skuggor (de avslöjar skärningarna); formen kastar i stället en mjuk kronskugga på
  // marken och stammen och syns aldrig själv. LOD2 har grövre sfärer.
  const shadow = [1, 1, 0].map((sub) => {
    const g = empty(), ico = icosphere(sub);
    balls.forEach((b, bi) => {
      const base = g.positions.length / 3, rr = b.radii[0] * (o.shadowScale ?? 0.85);
      for (const v of ico.verts) {
        g.positions.push(...add(b.center, mul(v, rr))); g.normals.push(...v); g.uvs.push(0, 0);
        g.colors.push(1, 1, 1); g.wind.push(0); g.cluster.push(bi);
      }
      for (const f of ico.faces) g.indices.push(base + f[0], base + f[1], base + f[2]);
    });
    return g;
  });
  lods.forEach((l, i) => { l.shadow = shadow[i]; });
  return { lods, clusters: balls, uncovered, tipBalls: balls.filter((b) => b.tip).length, cards: cards.reduce((s, c) => s + c.length, 0),
    ballM: mean(balls.map((b) => b.radii[0])), cardM: mean(cardM),
    silhouetteM2: Math.round(hit.size * cell * cell * 10) / 10, crownM: [Math.round((x1 - x0) * 100) / 100, Math.round((y1 - y0) * 100) / 100] };
}
