// Posetest för en ihopsatt byggsatskaraktär: skinnar kroppen och plaggen i testposerna (skin.mjs) och mäter
//   seam_gap_mm   största avståndet mellan kopiorna av ett sömhörn (fållens innersta hörn mot huden, och
//                 plaggkanter mot varandra i öppna sömmar); ska vara 0, eftersom kopiorna har samma vikter;
//   collapsed     andel skalhörn som hamnat innanför den (borttagna) huden under sig, mätt längs hudens normal;
//   flipped       trianglar som vänts (ytan viker sig i en led), i synlig hud och i plaggen;
//   skin_inside   synliga hudhörn som kryper in i ett plagg (närmaste plagghörn och dess normal).
import { sub, dot, cross, norm, add } from '../tree/vec.mjs';
import { POSES, poseBones, skinPoint } from './skin.mjs';

const triNormals = (P, tris) => {
  const n = P.map(() => [0, 0, 0]);
  for (const [a, b, c] of tris) { const f = cross(sub(P[b], P[a]), sub(P[c], P[a])); for (const i of [a, b, c]) n[i] = add(n[i], f); }
  return n.map(norm);
};
// Normal i posen: vilonormalen roterad med vikternas blandade rotation
const skinNormal = (n, weights, pose) => norm(weights.reduce((s, [b, w]) => {
  const R = pose.R[b]; return [s[0] + w * (R[0][0] * n[0] + R[0][1] * n[1] + R[0][2] * n[2]), s[1] + w * (R[1][0] * n[0] + R[1][1] * n[1] + R[1][2] * n[2]), s[2] + w * (R[2][0] * n[0] + R[2][1] * n[1] + R[2][2] * n[2])];
}, [0, 0, 0]));
const flippedCount = (P, tris, vn) => tris.filter(([a, b, c]) => {
  const f = cross(sub(P[b], P[a]), sub(P[c], P[a]));
  return dot(f, add(add(vn[a], vn[b]), vn[c])) < 0;
}).length;

// body: { verts, normals, tris, weights }, exposedParts: { del: trianglar } för synlig hud (nakna delar som är kvar),
// garments: [{ name, g }] från garment.mjs
export function runPoseTest(body, exposedParts, garments, J, poseNames = Object.keys(POSES)) {
  const out = {}, posed = {};
  const exposedTris = Object.values(exposedParts).flat();
  const partOfVert = new Map(Object.entries(exposedParts).flatMap(([pn, ts]) => ts.flat().map((v) => [v, pn])));
  const exposedVerts = [...partOfVert.keys()];
  for (const name of poseNames) {
    const pose = poseBones(J, POSES[name](J));
    const B = body.verts.map((p, i) => skinPoint(p, body.weights[i], J, pose));
    const BN = triNormals(B, body.tris);
    const res = { seam_gap_mm: 0, collapsed: 0, flipped: 0, skin_inside: 0, skin_inside_by_part: {} };
    let shellCount = 0;
    const G = garments.map(({ g }) => {
      const P = g.positions.map((p, k) => skinPoint(p, body.weights[g.source[k]], J, pose));
      const N = g.normals.map((n, k) => skinNormal(n, body.weights[g.source[k]], pose));
      return { P, N };
    });
    garments.forEach(({ g }, gi) => {
      const { P, N } = G[gi];
      for (const [v, k] of g.shellOf) {
        shellCount++;
        if (dot(sub(P[k], B[v]), BN[v]) <= 0) res.collapsed++;
      }
      // Fållens innersta hörn låg på huden i vila och ska ligga kvar där
      g.positions.forEach((p, k) => {
        const v = g.source[k], r = body.verts[v];
        if (p[0] === r[0] && p[1] === r[1] && p[2] === r[2]) res.seam_gap_mm = Math.max(res.seam_gap_mm, Math.hypot(...sub(P[k], B[v])) * 1000);
      });
      res.flipped += flippedCount(P, g.tris, N);
    });
    // Öppna sömmar: plaggens kanthörn som sammanföll i vila ska sammanfalla i posen
    garments.forEach((A, ai) => garments.forEach((C, ci) => {
      if (ai >= ci) return;
      for (const [v, ka] of A.g.shellOf) {
        const kc = C.g.shellOf.get(v);
        if (kc === undefined || Math.hypot(...sub(A.g.positions[ka], C.g.positions[kc])) > 1e-9) continue;
        res.seam_gap_mm = Math.max(res.seam_gap_mm, Math.hypot(...sub(G[ai].P[ka], G[ci].P[kc])) * 1000);
      }
    }));
    // Synlig hud: vända trianglar och hörn som kryper in i ett plagg (rutnät 3 cm över plaggens hörn)
    const bodyVN = body.normals.map((n, i) => skinNormal(n, body.weights[i], pose));
    res.flipped += flippedCount(B, exposedTris, bodyVN);
    const cell = 0.03, grid = new Map();
    const key = (p) => p.map((x) => Math.floor(x / cell)).join(',');
    G.forEach(({ P, N }) => P.forEach((p, k) => { const kk = key(p); (grid.get(kk) ?? grid.set(kk, []).get(kk)).push([p, N[k]]); }));
    const ownVerts = new Set(garments.flatMap(({ g }) => g.source));
    for (const v of exposedVerts) {
      if (ownVerts.has(v)) continue; // sömhörn delas med plaggen
      const p = B[v], [cx, cy, cz] = p.map((x) => Math.floor(x / cell));
      let best = null, bd = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const [q, n] of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) { const d = Math.hypot(...sub(p, q)); if (d < bd) { bd = d; best = [q, n]; } }
      }
      if (best && bd < cell && dot(sub(p, best[0]), best[1]) < -0.002) {
        res.skin_inside++;
        const pn = partOfVert.get(v); res.skin_inside_by_part[pn] = (res.skin_inside_by_part[pn] ?? 0) + 1;
      }
    }
    res.collapsed = +(res.collapsed / Math.max(1, shellCount)).toFixed(4);
    res.seam_gap_mm = +res.seam_gap_mm.toFixed(4);
    out[name] = res;
    posed[name] = { body: B, garments: G };
  }
  return { results: out, posed };
}
