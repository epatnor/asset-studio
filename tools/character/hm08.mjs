// MakeHumans basmesh hm08 som kroppskälla (CC0, third_party/makehuman/, se SOURCE.md). Läser meshen,
// blandar macro-targets (kön, ålder, muskler, vikt, längd, proportioner) och placerar vårt skelett
// i mitten av hm08:s "joint cubes", så att lederna följer kroppen när targets ändrar den.
// Meshen är i decimeter med mitten vid y = 0; ut kommer meter med fötterna på y = 0, y uppåt,
// ansiktet mot +Z och vänster = +X (samma som våra egna kroppar). Node (läser filer).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hm08Weights } from './skin.mjs';

const MH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../third_party/makehuman');

export function loadBase() {
  const verts = [], faces = [], groups = {};
  let g = null;
  for (const line of fs.readFileSync(path.join(MH, '3dobjs/base.obj'), 'utf8').split('\n')) {
    if (line.startsWith('v ')) verts.push(line.split(/\s+/).slice(1, 4).map(Number));
    else if (line.startsWith('g ')) g = line.split(/\s+/)[1];
    else if (line.startsWith('f ')) {
      const f = line.trim().split(/\s+/).slice(1).map((t) => parseInt(t, 10) - 1);
      faces.push(f);
      (groups[g] ??= []).push(faces.length - 1);
    }
  }
  return { verts, faces, groups };
}

const targetCache = new Map();
export function loadTarget(rel) {
  if (!targetCache.has(rel)) {
    const file = path.join(MH, 'targets', rel);
    const rows = fs.existsSync(file) ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n') : null;
    targetCache.set(rel, rows && rows.filter((r) => r && !r.startsWith('#')).map((r) => r.trim().split(/\s+/).map(Number)));
  }
  return targetCache.get(rel);
}

// Vikter för ett reglage mellan tre nivåer (0 = min, 0,5 = medel, 1 = max)
const tri = (v, [lo, mid, hi]) => (v < 0.5 ? { [lo]: 1 - v / 0.5, [mid]: v / 0.5 } : { [mid]: 1 - (v - 0.5) / 0.5, [hi]: (v - 0.5) / 0.5 });
// Ålder: 0 bebis, 0,1875 barn, 0,5 ung vuxen (25 år), 1 gammal
function ageWeights(v) {
  if (v < 0.1875) return { baby: 1 - v / 0.1875, child: v / 0.1875 };
  if (v < 0.5) { const t = (v - 0.1875) / (0.5 - 0.1875); return { child: 1 - t, young: t }; }
  return { young: 1 - (v - 0.5) / 0.5, old: (v - 0.5) / 0.5 };
}
const both = (v, a, b) => ({ [a]: v, [b]: 1 - v });
const nz = (o) => Object.entries(o).filter(([, w]) => w > 1e-6);

// Macro-targets enligt MakeHumans namnschema. m: { gender (1 = man), age, muscle, weight, height,
// proportions } i 0–1, ethnic: { african, asian, caucasian } (summa 1). Ger [[fil, vikt], ...].
export function macroTargets(m, ethnic = { african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 }) {
  const G = nz(both(m.gender ?? 0.5, 'male', 'female')), A = nz(ageWeights(m.age ?? 0.5));
  const M = nz(tri(m.muscle ?? 0.5, ['minmuscle', 'averagemuscle', 'maxmuscle']));
  const W = nz(tri(m.weight ?? 0.5, ['minweight', 'averageweight', 'maxweight']));
  const h = m.height ?? 0.5, p = m.proportions ?? 0.5;
  const H = nz({ maxheight: Math.max(0, (h - 0.5) * 2), minheight: Math.max(0, (0.5 - h) * 2) });
  const P = nz({ idealproportions: Math.max(0, (p - 0.5) * 2), uncommonproportions: Math.max(0, (0.5 - p) * 2) });
  const out = [];
  for (const [e, we] of nz(ethnic)) for (const [g, wg] of G) for (const [a, wa] of A) out.push([`macrodetails/${e}-${g}-${a}.target.gz`, we * wg * wa]);
  for (const [g, wg] of G) for (const [a, wa] of A) for (const [mu, wm] of M) for (const [w, ww] of W) {
    const base = `${g}-${a}-${mu}-${w}`, wb = wg * wa * wm * ww;
    out.push([`macrodetails/universal-${base}.target.gz`, wb]);
    for (const [hh, wh] of H) out.push([`macrodetails/height/${base}-${hh}.target.gz`, wb * wh]);
    if (a !== 'baby') for (const [pp, wp] of P) out.push([`macrodetails/proportions/${base}-${pp}.target.gz`, wb * wp]);
  }
  return out;
}

export function applyTargets(verts, list) {
  const v = verts.map((p) => [...p]);
  const missing = [];
  for (const [rel, w] of list) {
    const rows = loadTarget(rel);
    if (!rows) { missing.push(rel); continue; }
    for (const [i, dx, dy, dz] of rows) { v[i][0] += dx * w; v[i][1] += dy * w; v[i][2] += dz * w; }
  }
  return { verts: v, missing };
}

const center = (verts, vs) => [0, 1, 2].map((k) => vs.reduce((s, i) => s + verts[i][k], 0) / vs.length);
const groupVerts = (base, g) => [...new Set(base.groups[g].flatMap((fi) => base.faces[fi]))];

// Våra ben -> hm08:s joint cubes (samma pivåer som MPFB:s rig.game_engine: Spine = spine_01, Chest = spine_03)
const JOINTS = {
  Hips: 'joint-pelvis', Spine: 'joint-spine-4', Chest: 'joint-spine-2', Neck: 'joint-neck', Head: 'joint-head',
  Jaw: 'joint-jaw', LeftEye: 'joint-l-eye', RightEye: 'joint-r-eye',
};
for (const [s, c] of [['Left', 'l'], ['Right', 'r']]) {
  Object.assign(JOINTS, {
    [`${s}Shoulder`]: `joint-${c}-clavicle`, [`${s}UpperArm`]: `joint-${c}-shoulder`, [`${s}LowerArm`]: `joint-${c}-elbow`,
    [`${s}Hand`]: `joint-${c}-hand`, [`${s}UpperLeg`]: `joint-${c}-upper-leg`, [`${s}LowerLeg`]: `joint-${c}-knee`,
    [`${s}Foot`]: `joint-${c}-ankle`, [`${s}Toe`]: `joint-${c}-foot-1`,
  });
}
const TIPS = { HeadTop: 'joint-head-2', LeftHandTip: 'joint-l-finger-3-4', RightHandTip: 'joint-r-finger-3-4', LeftToeTip: 'joint-l-toe-2-4', RightToeTip: 'joint-r-toe-2-4' };

// En kropp ur hm08: bara kroppens ytor (gruppen "body", utan hjälpgeometri), targets applicerade,
// i meter med fötterna på marken, och lederna ur joint cubes
// Stilisering som egna procedurtargets: förskjutningar som räknas ur hm08:s vikter (game_engine, ihopslagna
// till våra ben) och joint cubes, applicerade på HELA meshen (även leder och ögonhjälpare), så att skelettet
// och ögonen följer med. s: { legs, hands, feet, eyes, head, waist, shoulders } där 1 = oförändrat.
// Allt räknas från lägena efter macro-targets (decimeter).
function stylizeRaw(raw, base, s) {
  const W = hm08Weights(raw.map((_, i) => i)).map((ws) => Object.fromEntries(ws));
  const cube = (g) => center(raw, groupVerts(base, g));
  const w = (i, ...bones) => bones.reduce((sum, b) => sum + (W[i][b] ?? 0), 0);
  const bodyIdx = [...new Set(base.groups.body.flatMap((fi) => base.faces[fi]))];
  const ground = Math.min(...bodyIdx.map((i) => raw[i][1]));
  const hipY = cube('joint-l-upper-leg')[1], ankleY = cube('joint-l-ankle')[1];
  const eyes = ['helper-l-eye', 'helper-r-eye'].map((g) => {
    const vs = groupVerts(base, g), c = center(raw, vs);
    return { c, r: vs.reduce((sum, i) => sum + Math.hypot(raw[i][0] - c[0], raw[i][1] - c[1], raw[i][2] - c[2]), 0) / vs.length };
  });
  const headC = cube('joint-head'), spine = cube('joint-spine-3'), clav = cube('joint-l-shoulder');
  const side = (p) => (p[0] >= 0 ? 'Left' : 'Right');
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return raw.map((p, i) => {
    const S = side(p), o = [0, 0, 0];
    // Ben: sträck mellan höft och fotled; under fotleden flyttas allt ned lika mycket
    const leg = w(i, `${S}UpperLeg`, `${S}LowerLeg`, `${S}Foot`, `${S}Toe`);
    if (leg > 0 && p[1] < hipY) {
      const y2 = p[1] >= ankleY ? hipY - (hipY - p[1]) * s.legs : p[1] - (hipY - ankleY) * (s.legs - 1);
      o[1] += leg * (y2 - p[1]);
    }
    // Händer runt handleden, fötter runt fotleden (sulan stannar nära marken)
    const hand = w(i, `${S}Hand`), wrist = cube(`joint-${S[0].toLowerCase()}-hand`);
    for (let k = 0; k < 3; k++) o[k] += hand * (s.hands - 1) * (p[k] - wrist[k]);
    const foot = w(i, `${S}Foot`, `${S}Toe`), ank = cube(`joint-${S[0].toLowerCase()}-ankle`);
    o[0] += foot * (s.feet - 1) * (p[0] - ank[0]); o[2] += foot * (s.feet - 1) * (p[2] - ank[2]);
    o[1] += foot * (s.feet - 1) * 0.5 * (p[1] - ground);
    // Ögon: området runt ögat (lock och glob) skalas med mjuk avtoning
    for (const e of eyes) {
      const d = Math.hypot(p[0] - e.c[0], p[1] - e.c[1], p[2] - e.c[2]);
      const f = 1 - smooth(e.r * 1.15, e.r * 2.6, d);
      for (let k = 0; k < 3; k++) o[k] += f * (s.eyes - 1) * (p[k] - e.c[k]);
    }
    // Huvud runt huvudleden, midja mot ryggradens axel, axlar utåt
    const head = w(i, 'Head');
    for (let k = 0; k < 3; k++) o[k] += head * (s.head - 1) * (p[k] - headC[k]);
    const waist = w(i, 'Spine');
    o[0] += waist * (s.waist - 1) * (p[0] - spine[0]); o[2] += waist * (s.waist - 1) * (p[2] - spine[2]);
    const arm = w(i, `${S}Shoulder`, `${S}UpperArm`, `${S}LowerArm`, `${S}Hand`);
    o[0] += arm * (s.shoulders - 1) * Math.abs(clav[0]) * Math.sign(p[0]);
    return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
  });
}

// extra: { 'eyes/{s}-eye-scale-incr': 0.7, ... } (ansiktsförval och andra MakeHuman-targets med vikter)
export function buildHm08(macro, ethnic, stylize = null, extra = {}) {
  const base = loadBase();
  const list = macroTargets(macro, ethnic);
  for (const [t, w] of Object.entries(extra)) for (const name of t.includes('{s}') ? ['l', 'r'].map((c) => t.replace('{s}', c)) : [t]) list.push([`${name}.target.gz`, w]);
  const applied = applyTargets(base.verts, list);
  const missing = applied.missing;
  const raw = stylize ? stylizeRaw(applied.verts, base, stylize) : applied.verts;
  const bodyFaces = base.groups.body.map((fi) => base.faces[fi]);
  const used = [...new Set(bodyFaces.flat())].sort((x, y) => x - y);
  const minY = Math.min(...used.map((i) => raw[i][1]));
  const toM = (p) => [p[0] * 0.1, (p[1] - minY) * 0.1, p[2] * 0.1];
  const remap = new Map(used.map((i, k) => [i, k]));
  const verts = used.map((i) => toM(raw[i]));
  const quads = bodyFaces.map((f) => f.map((i) => remap.get(i)));
  const joints = Object.fromEntries(Object.entries(JOINTS).map(([b, g]) => [b, toM(center(raw, groupVerts(base, g)))]));
  const tips = Object.fromEntries(Object.entries(TIPS).map(([b, g]) => [b, toM(center(raw, groupVerts(base, g)))]));
  const cubes = Object.fromEntries(Object.keys(base.groups).filter((g) => g.startsWith('joint-')).map((g) => [g, toM(center(raw, groupVerts(base, g)))]));
  // Ögonens mitt, radie och blickriktning (ur hjälpgeometrin och eye-target-lederna)
  const eyes = ['l', 'r'].map((c) => {
    const vs = groupVerts(base, `helper-${c}-eye`), ctr = center(raw, vs);
    const r = vs.reduce((s2, i) => s2 + Math.hypot(raw[i][0] - ctr[0], raw[i][1] - ctr[1], raw[i][2] - ctr[2]), 0) / vs.length;
    const t = center(raw, groupVerts(base, `joint-${c}-eye-target`));
    const d = [t[0] - ctr[0], t[1] - ctr[1], t[2] - ctr[2]], L = Math.hypot(...d);
    return { center: toM(ctr), radius: r * 0.1, dir: d.map((x) => x / L) };
  });
  return { verts, quads, joints, tips, cubes, eyes, targets: list.length, missing, sourceIndex: used };
}
