// Skinning för hm08-kroppar: MakeHumans vikter för game_engine-skelettet (CC0) slagna ihop till våra ben,
// linjär blend skinning och några testposer. Plaggens hörn skinnas med vikterna från sitt kroppshörn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { add, sub, cross, norm } from '../tree/vec.mjs';
import { BONES } from './skeleton.mjs';

const MH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../third_party/makehuman');

// game_engine-ben -> våra ben (fingrarna till handen, spine_01 och spine_02 till Spine)
function ourBone(b) {
  const side = b.endsWith('_l') ? 'Left' : b.endsWith('_r') ? 'Right' : '';
  const base = b.replace(/_[lr]$/, '');
  if (/^(thumb|index|middle|ring|pinky)_/.test(base)) return `${side}Hand`;
  return {
    Root: 'Hips', pelvis: 'Hips', spine_01: 'Spine', spine_02: 'Spine', spine_03: 'Chest', neck_01: 'Neck', head: 'Head',
    clavicle: `${side}Shoulder`, upperarm: `${side}UpperArm`, lowerarm: `${side}LowerArm`, hand: `${side}Hand`,
    thigh: `${side}UpperLeg`, calf: `${side}LowerLeg`, foot: `${side}Foot`, ball: `${side}Toe`,
  }[base];
}

// Vikter per kroppshörn: [[ben, vikt], ...], högst fyra, normaliserade
export function hm08Weights(sourceIndex) {
  const W = JSON.parse(fs.readFileSync(path.join(MH, 'rigs/standard/weights.game_engine.json'), 'utf8')).weights;
  const local = new Map(sourceIndex.map((s, k) => [s, k]));
  const acc = sourceIndex.map(() => new Map());
  for (const [bone, list] of Object.entries(W)) {
    const ours = ourBone(bone);
    if (!ours) continue;
    for (const [i, w] of list) {
      const k = local.get(i);
      if (k !== undefined) acc[k].set(ours, (acc[k].get(ours) ?? 0) + w);
    }
  }
  return acc.map((m) => {
    const top = [...m].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    return top.map(([b, w]) => [b, w / sum]);
  });
}

// 3x3-rotationer som rader
const axisAngle = (axis, deg) => {
  const [x, y, z] = norm(axis), a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
};
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mm = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mv = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const mulAll = (...Ms) => Ms.reduce((A, B) => mm(A, B), I3);

// Poserna: lokala rotationer i bindposens axlar (bindposen har inga rotationer, så lokala och globala
// axlar sammanfaller där). Böj "framåt" för en lem med riktningen d: axeln d × Z för d mot +Z.
const dir = (J, a, b) => norm(sub(J[b], J[a]));
const forward = (J, a, b, deg) => axisAngle(cross(dir(J, a, b), [0, 0, 1]), deg);
export const POSES = {
  bind: () => ({}),
  arms_down: () => ({ LeftUpperArm: axisAngle([0, 0, 1], -38), RightUpperArm: axisAngle([0, 0, 1], 38) }),
  elbows_90: (J) => ({
    LeftUpperArm: axisAngle([0, 0, 1], -38), RightUpperArm: axisAngle([0, 0, 1], 38),
    LeftLowerArm: forward(J, 'LeftLowerArm', 'LeftHand', 90), RightLowerArm: forward(J, 'RightLowerArm', 'RightHand', 90),
  }),
  step: (J) => ({
    // Armarna sänks mindre än i arms_down, så att händerna går fria från låren när de svingar
    LeftUpperArm: mulAll(axisAngle([0, 0, 1], -28), axisAngle([1, 0, 0], 20)), RightUpperArm: mulAll(axisAngle([0, 0, 1], 28), axisAngle([1, 0, 0], -25)),
    LeftUpperLeg: axisAngle([1, 0, 0], -35), LeftLowerLeg: axisAngle([1, 0, 0], 45),
    RightUpperLeg: axisAngle([1, 0, 0], 20), RightLowerLeg: axisAngle([1, 0, 0], 15),
  }),
  crouch: () => ({
    Spine: axisAngle([1, 0, 0], 12), Chest: axisAngle([1, 0, 0], 8),
    LeftUpperArm: axisAngle([0, 0, 1], -30), RightUpperArm: axisAngle([0, 0, 1], 30),
    LeftUpperLeg: axisAngle([1, 0, 0], -80), RightUpperLeg: axisAngle([1, 0, 0], -80),
    LeftLowerLeg: axisAngle([1, 0, 0], 100), RightLowerLeg: axisAngle([1, 0, 0], 100),
    LeftFoot: axisAngle([1, 0, 0], -20), RightFoot: axisAngle([1, 0, 0], -20),
  }),
};

// Ledernas rotation och läge i posen, ned genom hierarkin
export function poseBones(J, local) {
  const R = {}, P = {};
  for (const [b, par] of BONES) {
    const Rl = local[b] ?? I3;
    if (!par) { R[b] = Rl; P[b] = [...J[b]]; continue; }
    R[b] = mm(R[par], Rl);
    P[b] = add(P[par], mv(R[par], sub(J[b], J[par])));
  }
  return { R, P };
}

// Linjär blend skinning av ett hörn med sina vikter
export function skinPoint(p, weights, J, pose) {
  let out = [0, 0, 0];
  for (const [b, w] of weights) {
    const q = add(mv(pose.R[b], sub(p, J[b])), pose.P[b]);
    out = [out[0] + q[0] * w, out[1] + q[1] * w, out[2] + q[2] * w];
  }
  return out;
}
