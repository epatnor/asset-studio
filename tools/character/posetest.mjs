// Posetest för en ihopsatt byggsatskaraktär (outfit.mjs): skinnar ytan i testposerna (skin.mjs) och mäter
//   seam_gap_mm   största avståndet mellan kopior av samma hörn i olika platsmeshar (ska vara 0: de har
//                 samma läge och samma vikter, så sömmarna mellan platserna öppnar sig aldrig);
//   collapsed     andel tyghörn som hamnat innanför den skinnade kroppsytan vid sina källhörn;
//   flipped       trianglar som vänts (ytan viker sig i en led), utan fållarna;
//   skin_inside   synliga hudhörn som kryper in i tyget (närmaste tyghörn och dess normal), per plats.
import { sub, dot, cross, norm, add } from '../tree/vec.mjs';
import { POSES, poseBones, skinPoint } from './skin.mjs';

const triNormals = (P, tris) => {
  const n = P.map(() => [0, 0, 0]);
  for (const [a, b, c] of tris) { const f = cross(sub(P[b], P[a]), sub(P[c], P[a])); for (const i of [a, b, c]) n[i] = add(n[i], f); }
  return n.map(norm);
};
const rot = (R, n) => [R[0][0] * n[0] + R[0][1] * n[1] + R[0][2] * n[2], R[1][0] * n[0] + R[1][1] * n[1] + R[1][2] * n[2], R[2][0] * n[0] + R[2][1] * n[1] + R[2][2] * n[2]];

// Vikter för ett hörn med flera källhörn: källornas vikter blandade
function blendWeights(src, W) {
  const m = new Map();
  for (const [v, a] of src) for (const [b, w] of W[v]) m.set(b, (m.get(b) ?? 0) + a * w);
  const top = [...m].sort((x, y) => y[1] - x[1]).slice(0, 4), sum = top.reduce((s, [, w]) => s + w, 0) || 1;
  return top.map(([b, w]) => [b, w / sum]);
}

// body: { verts, tris, weights }, meshes: från buildOutfit
export function runPoseTest(body, meshes, J, poseNames = Object.keys(POSES)) {
  const results = {}, posed = {};
  const MW = meshes.map((m) => m.src.map((s) => blendWeights(s, body.weights)));
  // Hudhörn vid en fåll räknas inte: de sitter ihop med tyget, och vulsten når avsiktligt ut över dem
  const cell = 0.03, restGrid = new Map(), key = (p) => p.map((x) => Math.floor(x / cell)).join(',');
  meshes.forEach((m) => { if (m.kind === 'cloth') m.pos.forEach((p) => { const k = key(p); (restGrid.get(k) ?? restGrid.set(k, []).get(k)).push(p); }); });
  const nearCloth = meshes.map((m) => m.kind !== 'skin' ? [] : m.pos.map((p) => {
    const [cx, cy, cz] = p.map((x) => Math.floor(x / cell));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (const q of restGrid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) if (Math.hypot(...sub(p, q)) < 0.012) return true;
    return false;
  }));
  for (const name of poseNames) {
    const pose = poseBones(J, POSES[name](J));
    const B = body.verts.map((p, i) => skinPoint(p, body.weights[i], J, pose));
    const BN = triNormals(B, body.tris);
    const res = { seam_gap_mm: 0, collapsed: 0, flipped: 0, skin_inside: 0, skin_inside_by_slot: {} };
    const P = meshes.map((m, mi) => m.pos.map((p, k) => skinPoint(p, MW[mi][k], J, pose)));
    const PN = meshes.map((m, mi) => m.nrm.map((n, k) => norm(MW[mi][k].reduce((s, [b, w]) => add(s, rot(pose.R[b], n).map((x) => x * w)), [0, 0, 0]))));
    // Sömmar mellan platser: samma nyckel ska ge samma läge
    const byKey = new Map();
    meshes.forEach((m, mi) => m.key.forEach((k, i) => {
      const q = P[mi][i], prev = byKey.get(k);
      if (prev) res.seam_gap_mm = Math.max(res.seam_gap_mm, Math.hypot(...sub(q, prev)) * 1000); else byKey.set(k, q);
    }));
    // Tyg innanför kroppsytan
    let clothVerts = 0;
    meshes.forEach((m, mi) => {
      if (m.kind !== 'cloth') return;
      m.pos.forEach((_, k) => {
        if (m.key[k].startsWith('f')) return; // fållarnas inre kant ligger på lagret under
        clothVerts++;
        let bp = [0, 0, 0], bn = [0, 0, 0];
        for (const [v, a] of m.src[k]) { bp = add(bp, B[v].map((x) => x * a)); bn = add(bn, BN[v].map((x) => x * a)); }
        if (dot(sub(P[mi][k], bp), norm(bn)) <= 0) res.collapsed++;
      });
    });
    // Vända trianglar (utan fållar)
    meshes.forEach((m, mi) => m.tris.forEach(([a, b, c], ti) => {
      if (m.strip[ti]) return;
      const f = cross(sub(P[mi][b], P[mi][a]), sub(P[mi][c], P[mi][a]));
      if (dot(f, add(add(PN[mi][a], PN[mi][b]), PN[mi][c])) < 0) res.flipped++;
    }));
    // Hud i tyg
    const grid = new Map();
    meshes.forEach((m, mi) => { if (m.kind === 'cloth') P[mi].forEach((p, k) => { const kk = key(p); (grid.get(kk) ?? grid.set(kk, []).get(kk)).push([p, PN[mi][k]]); }); });
    meshes.forEach((m, mi) => {
      if (m.kind !== 'skin') return;
      P[mi].forEach((p, k) => {
        if (nearCloth[mi][k]) return;
        const [cx, cy, cz] = p.map((x) => Math.floor(x / cell));
        let best = null, bd = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (const [q, n] of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) { const d = Math.hypot(...sub(p, q)); if (d < bd) { bd = d; best = [q, n]; } }
        }
        if (best && bd < cell && dot(sub(p, best[0]), best[1]) < -0.002) {
          res.skin_inside++; res.skin_inside_by_slot[m.slot] = (res.skin_inside_by_slot[m.slot] ?? 0) + 1;
        }
      });
    });
    res.collapsed = +(res.collapsed / Math.max(1, clothVerts)).toFixed(4);
    res.seam_gap_mm = +res.seam_gap_mm.toFixed(4);
    results[name] = res;
    posed[name] = P;
  }
  return { results, posed };
}
