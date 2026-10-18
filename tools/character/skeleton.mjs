// Humanoidskelett i A-pose ur en arketyp i characters.json. Allt annat (kropp, kläder, hår, vikter) byggs
// från det här skelettet. Meter, y uppåt, karaktären tittar mot +Z, vänster = +X. Ren JS.
//
// Proportionerna utgår från kroppshöjd (height) och antal huvuden (heads): huvudhöjden är height / heads,
// och resten av kroppen fördelas på hals, bål och ben. Bredder mäts i en enhet W som blandar höjd och
// huvudstorlek, så att figurer med stora huvuden (dvärg, goblin) också blir bredare. Seeden ger
// symmetrisk variation på några procent.
import { add, mul, norm, rng } from '../tree/vec.mjs';

const SIDES = [['Left', 1], ['Right', -1]];
export const BONES = [['Hips', null], ['Spine', 'Hips'], ['Chest', 'Spine'], ['Neck', 'Chest'], ['Head', 'Neck']];
for (const [s] of SIDES) {
  BONES.push([`${s}Shoulder`, 'Chest'], [`${s}UpperArm`, `${s}Shoulder`], [`${s}LowerArm`, `${s}UpperArm`], [`${s}Hand`, `${s}LowerArm`],
    [`${s}UpperLeg`, 'Hips'], [`${s}LowerLeg`, `${s}UpperLeg`], [`${s}Foot`, `${s}LowerLeg`], [`${s}Toe`, `${s}Foot`]);
}

const rad = (d) => (d * Math.PI) / 180;
// Riktning i A-pose: vinkel från lodlinjen ut åt sidan s, plus lite framåt
const armDir = (s, deg, fwd) => norm([s * Math.sin(rad(deg)), -Math.cos(rad(deg)), fwd]);

export function buildSkeleton(a, seed = 1) {
  const r = rng(seed * 7919 + 17);
  const vary = (amt) => 1 + (r() * 2 - 1) * amt;
  const H = a.height * vary(0.04);
  const heads = a.heads * vary(0.02);
  const hH = H / heads; // huvudhöjd, haka till hjässa
  const B = H - hH; // kroppen under hakan
  const W = 0.5 * (H / 7.5 + hH) * vary(0.03);
  const build = a.build * vary(0.04);

  const chinY = H - hH;
  const neckLen = 0.3 * hH * a.neck * vary(0.04);
  const shoulderY = chinY - neckLen; // halsens bas, bålens topp
  const hipY = 0.59 * B * a.legs * vary(0.03); // höftleden
  const torso = shoulderY - hipY;

  const shoulderHalf = 0.78 * W * a.shoulders * Math.sqrt(build) * vary(0.03);
  const hipHalf = 0.36 * W * a.hips * Math.pow(build, 0.3) * vary(0.03);
  const upperL = 0.212 * B * vary(0.02);
  const foreL = 0.167 * B * vary(0.02);
  const handL = 0.5 * (0.105 * H + 0.8 * hH) * a.hands * vary(0.03);
  const footL = 0.5 * (0.15 * H + 1.1 * hH) * a.feet * vary(0.03);
  const ankleY = 0.25 * footL;
  const footX = hipHalf * 1.05;

  const J = {
    Hips: [0, hipY + 0.04 * torso, 0],
    Spine: [0, hipY + 0.3 * torso, 0],
    Chest: [0, hipY + 0.58 * torso, 0],
    Neck: [0, shoulderY, -0.05 * W],
    Head: [0, chinY + 0.22 * hH, -0.03 * hH],
  };
  const tips = { HeadTop: [0, H, -0.03 * hH] };
  for (const [s, x] of SIDES) {
    J[`${s}Shoulder`] = [x * 0.15 * W, shoulderY - 0.06 * torso, 0.02 * W];
    J[`${s}UpperArm`] = [x * shoulderHalf, shoulderY - 0.12 * torso, -0.02 * W];
    J[`${s}UpperLeg`] = [x * hipHalf, hipY, 0];
    const ankle = [x * footX, ankleY, 0];
    J[`${s}LowerLeg`] = [x * (hipHalf + footX) / 2, hipY - 0.52 * (hipY - ankleY), 0.012 * H];
    J[`${s}Foot`] = ankle;
    // Tårna pekar lite utåt (8°)
    const out = Math.sin(rad(8));
    J[`${s}Toe`] = [x * (footX + out * 0.45 * footL), 0.3 * ankleY, 0.45 * footL];
    tips[`${s}ToeTip`] = [x * (footX + out * 0.68 * footL), 0.3 * ankleY, 0.68 * footL];
    tips[`${s}Heel`] = [x * footX, 0.3 * ankleY, -0.25 * footL];
  }

  // Kutryggighet: bröst, hals och axlar roteras framåt runt Spine och Chest (hälften var); huvudet och
  // armarna flyttas med utan att roteras, så att ansiktet tittar framåt och armarna hänger som förut.
  const hunch = rad(a.hunch ?? 0);
  if (hunch) {
    const pitch = (p, c, t) => {
      const dy = p[1] - c[1], dz = p[2] - c[2];
      return [p[0], c[1] + dy * Math.cos(t) - dz * Math.sin(t), c[2] + dz * Math.cos(t) + dy * Math.sin(t)];
    };
    const upper = ['Chest', 'Neck', 'LeftShoulder', 'RightShoulder', 'LeftUpperArm', 'RightUpperArm'];
    const neck0 = J.Neck;
    for (const [pivot, part] of [['Spine', upper], ['Chest', upper.slice(1)]]) {
      const c = J[pivot];
      for (const n of part) J[n] = pitch(J[n], c, hunch / 2);
    }
    const d = [J.Neck[0] - neck0[0], J.Neck[1] - neck0[1], J.Neck[2] - neck0[2]];
    J.Head = add(J.Head, d);
    tips.HeadTop = add(tips.HeadTop, d);
  }

  // Armarna i A-pose från överarmens läge: cirka 42° ut, armbågen lätt böjd framåt
  const dirs = {};
  for (const [s, x] of SIDES) {
    const du = armDir(x, 42, 0.08), df = armDir(x, 36, 0.25), dh = armDir(x, 32, 0.15);
    J[`${s}LowerArm`] = add(J[`${s}UpperArm`], mul(du, upperL));
    J[`${s}Hand`] = add(J[`${s}LowerArm`], mul(df, foreL));
    tips[`${s}HandTip`] = add(J[`${s}Hand`], mul(dh, handL));
    dirs[s] = { upper: du, fore: df, hand: dh };
  }

  const parents = Object.fromEntries(BONES);
  const chinNow = J.Head[1] - 0.22 * hH; // hakan efter kutryggen
  return {
    H, heads, hH, W, build, joints: J, parents, tips, dirs,
    dims: { chinY: chinNow, shoulderY, hipY, torso, neckLen, shoulderHalf, hipHalf, upperL, foreL, handL, footL, ankleY, footX },
  };
}
