// MakeHumans basmesh hm08 som kroppskälla (CC0, third_party/makehuman/, se SOURCE.md). Läser meshen,
// blandar macro-targets (kön, ålder, muskler, vikt, längd, proportioner) och placerar vårt skelett
// i mitten av hm08:s "joint cubes", så att lederna följer kroppen när targets ändrar den.
// Meshen är i decimeter med mitten vid y = 0; ut kommer meter med fötterna på y = 0, y uppåt,
// ansiktet mot +Z och vänster = +X (samma som våra egna kroppar). Node (läser filer).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Våra ben -> hm08:s joint cubes (samma koppling som MPFB:s rig.game_engine)
const JOINTS = {
  Hips: 'joint-pelvis', Spine: 'joint-spine-3', Chest: 'joint-spine-1', Neck: 'joint-neck', Head: 'joint-head',
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
export function buildHm08(macro, ethnic) {
  const base = loadBase();
  const list = macroTargets(macro, ethnic);
  const { verts: raw, missing } = applyTargets(base.verts, list);
  const bodyFaces = base.groups.body.map((fi) => base.faces[fi]);
  const used = [...new Set(bodyFaces.flat())].sort((x, y) => x - y);
  const minY = Math.min(...used.map((i) => raw[i][1]));
  const toM = (p) => [p[0] * 0.1, (p[1] - minY) * 0.1, p[2] * 0.1];
  const remap = new Map(used.map((i, k) => [i, k]));
  const verts = used.map((i) => toM(raw[i]));
  const quads = bodyFaces.map((f) => f.map((i) => remap.get(i)));
  const joints = Object.fromEntries(Object.entries(JOINTS).map(([b, g]) => [b, toM(center(raw, groupVerts(base, g)))]));
  const tips = Object.fromEntries(Object.entries(TIPS).map(([b, g]) => [b, toM(center(raw, groupVerts(base, g)))]));
  return { verts, quads, joints, tips, targets: list.length, missing, sourceIndex: used };
}
