// Diorama-öar för Kartrummet (docs/terrain.md): en liten ö där allt finns på en gång, för att prova växtlighet, vatten,
// mark, props, ljus och atmosfär i samma bild. Generatorns ö (oftast Volcano) står kvar i mitten; runt den delas kusten i
// sektorer med var sin kustprofil (strand, träsk, klippkust, äng) som tonar i varandra. Verktyget skriver Kartrummets
// vanliga lager: det formade (sculpt, höjdskillnad per hörn), målade biomer och regioner, grävda bäckar och regionerna,
// och sparar världen som assets/terrain/<namn>.terrain.json. Allt går sedan att forma vidare i Kartrummet.
//
//   node tools/terrain/make_diorama.mjs "$(cat tools/terrain/dioramas/demo_isle.json)"
//
// Receptet: name, from (landskapet det bygger på), settings (Kartrummets spakar), radius (kustens radie, m), core (vulkanens
// radie som står kvar orörd), wobble (kustlinjens slingor, m), spread (sektorernas övergång, grader) och sectors: angle
// (0 = norr, −z, medsols), coast (en av PROFILES), detail (brusets höjd, m), paint ([{biome, from, to, strength}], från och
// till i meter relativt kusten, negativt inåt land), region ({name, theme}) och stream (en bäck från vulkanens fot ut i
// havet), populate (Populate-stegets inställningar) och checks (beachMaxDepth, cliffMinDepth: djupet 6 m ut från kusten;
// marshMinPonds: procent gölar i myren). Ut: en rad JSON med fil och kontroller (kustens djup, gölar och biomernas andel
// per sektor).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTerrain, worldGrid, createNoise } from '../../shared/terrain/generate.js';
import { applyEdits, encodeDelta } from '../../shared/terrain/sculpt.js';
import { computeBiomes, mixPaint, encodePaint, PAINT_SIZE } from '../../shared/terrain/biomes.js';
import { regionField } from '../../shared/terrain/regions.js';
import { populate } from '../../shared/terrain/populate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const X = JSON.parse(readFileSync(path.join(ROOT, 'tools/terrain/terrain.json'), 'utf8'));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Kustprofilerna: höjden (m över havet) mot avståndet till kusten (m, negativt inåt land), som punkter med mjuka steg
// emellan. Profilen börjar där vulkanens fot tar slut och slutar på havsbotten. noise: hur mycket av brusets höjd som
// får vara kvar (1 inåt land, 0 vid vattnet, där formen ska vara ren)
const PROFILES = {
  // Sandstrand som grundas långsamt (1:12 över vattnet, 1:25 under), så att vågorna bryts och sköljer upp
  beach: { pts: [[-40, 10], [-24, 4.5], [-12, 1.6], [0, 0], [8, -0.7], [30, -2.6], [55, -9], [80, -15]], noise: [-30, -10] },
  // Låg, flack myr strax över havet, med gölar där bruset går under ytan, och ett grunt, gyttjigt hav utanför
  marsh: { pts: [[-56, 19], [-40, 9], [-28, 3.5], [-19, 1.2], [-6, 0.4], [2, -0.4], [24, -1.4], [55, -7], [80, -15]], noise: [-54, -28], pools: [-21, -3] },
  // Klippkust: en platå som går ned i hyllor till djupt vatten. ledges: [kant (m från kusten), höjden nedanför, hur långt
  // kanten vandrar längs kusten (m)]; kanterna vandrar var för sig, så att hyllorna ligger omlott: en hylla smalnar av och
  // tar slut, och där två kanter möts blir det en hög vägg. face: väggens bredd (m); under: botten utanför klippan
  cliff: {
    pts: [[-30, 15], [-10, 14], [-2, 10], [0, 6], [2, -4], [6, -10], [30, -14], [80, -16]], noise: [-30, 0], crag: true,
    ledges: [[-18, 11.5, 8], [-12.5, 8, 8], [-7, 4.5, 7], [-2.5, 1.6, 4.5]], face: 1.4,
    under: [[0, 2], [2.5, -4], [6, -10], [30, -14], [80, -16]],
  },
  // Äng: mjuka kullar ned mot en grön strand, med en brantare kant under vattnet
  meadow: { pts: [[-45, 12], [-22, 5], [-8, 1.4], [0, 0], [6, -1.6], [22, -4.5], [50, -11], [80, -15]], noise: [-40, -8] },
};
const profileAt = (pts, d) => {
  if (d <= pts[0][0]) return pts[0][1];
  for (let q = 1; q < pts.length; q++) if (d <= pts[q][0]) return pts[q - 1][1] + (pts[q][1] - pts[q - 1][1]) * smooth(pts[q - 1][0], pts[q][0], d);
  return pts.at(-1)[1];
};
// Hyllorna: platån och sedan ett steg per hylla, med kanter som vandrar i ett brus (stort längs kusten, smått i kanten)
const ledgesAt = (P, d, x, z) => {
  let y = profileAt(P.pts, Math.min(d, -10));
  P.ledges.forEach(([e, h, J], i) => {
    const edge = e + J * noise(x * 0.055 + i * 13.1, z * 0.055 - i * 7.7) + 0.8 * noise(x * 0.18 - i * 5.3, z * 0.18 + i * 3.9);
    const hh = h + 0.8 * noise(x * 0.05 - i * 3.3, z * 0.05 + i * 9.1);
    y = mix(y, Math.min(y, hh), smooth(edge - P.face / 2, edge + P.face / 2, d));
  });
  return d <= P.under[0][0] ? y : Math.min(y, profileAt(P.under, d));
};
const angDiff = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return Math.abs(d); };

const D = JSON.parse(process.argv[2] ?? '{}');
const name = String(D.name ?? 'diorama');
if (!/^[a-z0-9_]{1,40}$/.test(name)) { console.log(JSON.stringify({ ok: false, error: 'name: a–z, 0–9 and _' })); process.exit(1); }
const settings = { ...Object.fromEntries(X.params.map((q) => [q.key, q.default])), ...(X.presets[D.from] ?? {}), ...(D.settings ?? {}) };
delete settings.label;
const size = Number(settings.worldSize), G = worldGrid(size);
const base = generateTerrain({ ...settings, ...G });
const { n, cell, half } = base;
const sectors = D.sectors ?? [];
const Rc = D.radius ?? 90, core = D.core ?? 35, wobble = D.wobble ?? 5, spread = D.spread ?? 32;
const noise = createNoise((settings.seed ?? 1) + 101);
const fbm = (x, z, f) => noise(x * f, z * f) * 0.6 + noise(x * f * 2.3 + 17, z * f * 2.3 - 5) * 0.3 + noise(x * f * 5.1 - 9, z * f * 5.1 + 3) * 0.1;

// Vikterna per sektor (summerar till 1) och kustens radie i en riktning
const weightsAt = (deg) => {
  const w = sectors.map((s) => Math.exp(-((angDiff(deg, s.angle) / spread) ** 2)));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((v) => v / sum);
};
const coastR = (a) => Rc + wobble * (Math.sin(3 * a + 1.1) * 0.6 + Math.sin(7 * a + 2.3) * 0.3 + Math.sin(13 * a + 0.4) * 0.15);
// Vulkanens fot: medelhöjden i ringen där sektorerna tar över, så att de börjar i samma höjd
let footSum = 0, footN = 0;
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
  const r = Math.hypot(-half + i * cell, -half + j * cell);
  if (Math.abs(r - core) < cell * 2) { footSum += base.heights[j * n + i]; footN++; }
}
const foot = footN ? footSum / footN : 10;

const delta = new Float32Array(n * n);
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
  const x = -half + i * cell, z = -half + j * cell, r = Math.hypot(x, z), a = Math.atan2(x, -z), deg = (a * 180 / Math.PI + 360) % 360;
  const d = r - coastR(a), w = weightsAt(deg), k = j * n + i;
  const b0 = base.heights[k];
  let h = 0;
  sectors.forEach((s, q) => {
    if (w[q] < 1e-4) return;
    const P = PROFILES[s.coast] ?? PROFILES.meadow;
    // Vulkanens egen sluttning tonar över i profilen från foten ut till 18 m bortom profilens första punkt, så att foten
    // inte blir en mur
    const start = P.pts[0][0];
    let y = mix(b0, P.ledges ? ledgesAt(P, d, x, z) : profileAt(P.pts, d), smooth(core - Rc, start + 18, d));
    const amp = s.detail ?? 1.5, nz = fbm(x + q * 37, z - q * 23, 0.035);
    y += amp * nz * smooth(P.noise[1], P.noise[0], d);
    if (P.crag) y += 2.2 * Math.abs(noise(x * 0.09 + 3, z * 0.09 - 7)) * smooth(4, -6, d); // skrovliga block längs kanten
    if (P.pools) y -= 2.6 * Math.max(0, fbm(x * 1.7 + 5, z * 1.7 - 2, 0.05) + 0.2) * smooth(P.pools[0], P.pools[0] + 6, d) * smooth(P.pools[1], P.pools[1] - 6, d);
    h += w[q] * y;
  });
  // Vulkanen står kvar inom core; utanför tar sektorerna över
  const keep = 1 - smooth(core * 0.75, core * 1.15, r);
  delta[k] = (keep * base.heights[k] + (1 - keep) * h) - base.heights[k];
}
function mix(a, b, t) { return a + (b - a) * t; }

// Bäckar: från vulkanens fot ut genom sektorn till havet, med en svag sväng
const channels = [];
sectors.forEach((s) => {
  if (!s.stream) return;
  const a0 = s.angle * Math.PI / 180, pts = [];
  for (let q = 0; q <= 8; q++) {
    const t = q / 8, r = core * 1.05 + (coastR(a0) + 10 - core * 1.05) * t, a = a0 + Math.sin(t * Math.PI * 1.5) * 0.12;
    pts.push([+(Math.sin(a) * r / size).toFixed(4), +(-Math.cos(a) * r / size).toFixed(4)]);
  }
  channels.push({ kind: s.stream === true ? 'stream' : s.stream, points: pts });
});

// Målade biomer och regioner (256 × 256 rutor över världen): sektorns band, med styrkan efter hur mycket sektorn äger platsen
const P = PAINT_SIZE, cellP = size / P, biomeIds = X.biomes.map((b) => b.id ?? b);
const paint = new Uint8Array(P * P * 2), regionPaint = new Uint8Array(P * P * 2);
const regions = [{ name: D.center?.name ?? 'The Peak', theme: D.center?.theme ?? 'ashland', at: [0, 0] }];
sectors.forEach((s) => {
  if (!s.region) return;
  const a = s.angle * Math.PI / 180, r = (core + Rc) / 2 / size;
  regions.push({ name: s.region.name, theme: s.region.theme, at: [+(Math.sin(a) * r).toFixed(3), +(-Math.cos(a) * r).toFixed(3)] });
});
for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) {
  const x = -half + (i + 0.5) * cellP, z = -half + (j + 0.5) * cellP, r = Math.hypot(x, z), a = Math.atan2(x, -z), deg = (a * 180 / Math.PI + 360) % 360;
  const d = r - coastR(a), w = weightsAt(deg), q = j * P + i;
  let best = -1, bestS = 0;
  sectors.forEach((s, si) => {
    for (const b of s.paint ?? []) {
      const id = biomeIds.indexOf(b.biome);
      if (id < 0) continue;
      const st = (b.strength ?? 0.8) * w[si] * smooth(b.from - 4, b.from + 2, d) * smooth(b.to + 4, b.to - 2, d);
      if (st > bestS) { bestS = st; best = id; }
    }
  });
  if (best >= 0 && bestS > 0.03) { paint[q] = best + 1; paint[P * P + q] = Math.round(255 * Math.min(1, bestS)); }
  // Regionerna: sektorn som äger platsen, mjukt mot vulkanen i mitten
  const si = w.indexOf(Math.max(...w)), rs = smooth(core * 0.7, core * 1.1, r);
  if (sectors[si]?.region && rs > 0.05) { const ri = regions.findIndex((g) => g.name === sectors[si].region.name); regionPaint[q] = ri + 1; regionPaint[P * P + q] = Math.round(200 * rs * w[si]); }
}

// Kontroller: hela kedjan som i Kartrummet (det formade, regionerna, biomerna med det målade)
const recipe = { ...settings, ...G, regions, regionThemes: X.regionThemes, regionColors: X.regionColors, regionPaint, sculpt: delta, sculptN: n, channels, channelKinds: X.channelKinds };
const t = applyEdits(base, recipe), rf = regionField(t, recipe, {}), bio = computeBiomes(t, recipe, rf);
const W = mixPaint(bio.weights, paint, n), NB = biomeIds.length;
const per = sectors.map((s) => ({ coast: s.coast, slope: null, biomes: new Float64Array(NB), land: 0, band: 0, ponds: 0 }));
for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) {
  const x = -half + i * cell, z = -half + j * cell, r = Math.hypot(x, z), k = j * n + i;
  if (r < core) continue;
  const a = Math.atan2(x, -z), deg = (a * 180 / Math.PI + 360) % 360, w = weightsAt(deg), si = w.indexOf(Math.max(...w));
  if (w[si] < 0.8) continue;
  // Gölar: andelen under vattnet i bandet 3–22 m innanför kusten
  const d = r - coastR(a);
  if (d > -22 && d < -3) { per[si].band++; if (t.heights[k] <= (settings.seaLevel ?? 0)) per[si].ponds++; }
  if (t.heights[k] <= (settings.seaLevel ?? 0)) continue;
  per[si].land++;
  for (let b = 0; b < NB; b++) per[si].biomes[b] += W[k * NB + b] / 255;
}
sectors.forEach((s, si) => {
  // Lutningen under vattnet: djupet 6 m ut från kusten i sektorns mitt (en strand ≈ 0,5, en klippa > 8)
  const a = s.angle * Math.PI / 180, r = coastR(a) + 6, sx = Math.sin(a) * r, sz = -Math.cos(a) * r;
  per[si].slope = +(-t.heightAt(sx, sz)).toFixed(1);
});
const report = per.map((p) => ({
  coast: p.coast, depthAt6m: p.slope, pondsPct: Math.round(100 * p.ponds / Math.max(1, p.band)),
  biomes: Object.fromEntries([...p.biomes].map((v, b) => [biomeIds[b], Math.round(100 * v / Math.max(1, p.land))]).filter(([, v]) => v >= 5)),
}));
// Naturen som Populate-steget lägger ut den med receptets inställningar: antal per lager
let nature = null;
if (D.populate) {
  const world = { ...t, biomes: W, sea: settings.seaLevel ?? 0, regions: { P: rf.P, count: rf.count, weights: rf.weights, themes: regions.map((g) => g.theme) } };
  const pop = populate(world, X.populate, D.populate);
  nature = { total: pop.total, ...Object.fromEntries(pop.layers.filter((l) => l.count).map((l) => [l.id, l.count])) };
}
let bad = 0;
for (let k = 0; k < n * n; k++) if (!Number.isFinite(t.heights[k])) bad++;
const landPct = Math.round(100 * t.heights.filter((y) => y > 0).length / (n * n));
const ok = bad === 0 && report.every((p) => Object.keys(p.biomes).length > 0) && (D.checks?.beachMaxDepth == null || report.filter((p) => p.coast === 'beach').every((p) => p.depthAt6m <= D.checks.beachMaxDepth))
  && (D.checks?.cliffMinDepth == null || report.filter((p) => p.coast === 'cliff').every((p) => p.depthAt6m >= D.checks.cliffMinDepth))
  && (D.checks?.marshMinPonds == null || report.filter((p) => p.coast === 'marsh').every((p) => p.pondsPct >= D.checks.marshMinPonds));

// Spara som en vanlig värld (samma format som Kartrummets Save)
const clean = {};
for (const q of X.params) {
  if (q.recipe === false) continue;
  const v = settings[q.key];
  if (q.type === 'color') clean[q.key] = /^#[0-9a-f]{6}$/i.test(v) ? v : q.default;
  else if (q.type === 'bool') clean[q.key] = v === undefined ? q.default : !!v;
  else if (q.type === 'choice') clean[q.key] = q.options.some((o) => o.id === v) ? v : q.default;
  else clean[q.key] = Math.min(q.max, Math.max(q.min, Number(v ?? q.default)));
}
const layers = Object.fromEntries(Object.entries({ biomePaint: encodePaint(paint), regionPaint: encodePaint(regionPaint), sculpt: encodeDelta(delta, n) }).filter(([, v]) => v));
const entry = { name, settings: clean, regions, ...(channels.length ? { channels } : {}), ...(D.populate ? { populate: D.populate } : {}), layers, ...(D.from ? { from: D.from } : {}), saved: new Date().toISOString() };
const file = `assets/terrain/${name}.terrain.json`;
mkdirSync(path.join(ROOT, 'assets/terrain'), { recursive: true });
writeFileSync(path.join(ROOT, file), JSON.stringify(entry, null, 2) + '\n');
console.log(JSON.stringify({ ok, file, n, landPct, foot: +foot.toFixed(1), maxDelta: +delta.reduce((m, v) => Math.max(m, Math.abs(v)), 0).toFixed(1), channels: channels.length, regions: regions.length, sectors: report, ...(nature ? { nature } : {}), nan: bad }));
