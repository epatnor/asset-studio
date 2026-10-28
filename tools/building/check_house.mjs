// Kontroller för den nya husgeneratorn utan bilder (docs/buildings.md): taklösaren i fem svåra fall (inga glipor,
// inga överlapp, rätt höjd i varje provpunkt) och grafen för alla hustyper och stilar (dörr, och att samma recept
// alltid ger samma hus). En rad JSON ut.
//   node tools/building/check_house.mjs
import fs from 'node:fs';
import { solveRoof } from './house/roof.mjs';
import { planHouse } from './house/graph.mjs';

const inside = (poly, x, z) => { for (let i = 0; i < poly.length; i++) { const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length]; if ((x1 - x0) * (z - z0) - (z1 - z0) * (x - x0) < -1e-9) return false; } return true; };
const wellInside = (poly, x, z) => { for (let i = 0; i < poly.length; i++) { const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length], L = Math.hypot(x1 - x0, z1 - z0) || 1; if (((x1 - x0) * (z - z0) - (z1 - z0) * (x - x0)) / L < 1e-3) return false; } return true; };
const pitch = (45 * Math.PI) / 180;
const CASES = {
  gable: [{ rect: [-4, -3, 4, 3], top: 5, roof: { type: 'gable', axis: 'x', pitch, overhang: 0.4 } }],
  hip: [{ rect: [-4, -3, 4, 3], top: 5, roof: { type: 'hip', pitch, overhang: 0.4 } }],
  cross: [{ rect: [-4.5, -3, 4.5, 3], top: 5, roof: { type: 'gable', axis: 'x', pitch, overhang: 0.4 } }, { rect: [-1.8, 2.7, 1.8, 5], top: 5, roof: { type: 'gable', axis: 'z', pitch, overhang: 0.4 } }],
  L: [{ rect: [-5, -3, 5, 3], top: 4, roof: { type: 'gable', axis: 'x', pitch, overhang: 0.4 } }, { rect: [2, -9, 5, -2.7], top: 4, roof: { type: 'gable', axis: 'z', pitch, overhang: 0.4 } }],
  tower_and_shed: [{ rect: [-4, -3, 4, 3], top: 5, roof: { type: 'gable', axis: 'x', pitch, overhang: 0.4 } }, { rect: [-6.5, -2, -3.8, 2], top: 3, roof: { type: 'shed', dir: '-x', pitch: 0.4, overhang: 0.3 } }, { rect: [2, 1.5, 5, 4.5], top: 9, roof: { type: 'hip', pitch: 1.1, overhang: 0.3 } }],
};
const roofs = {};
let ok = true;
for (const [name, vols] of Object.entries(CASES)) {
  const R = solveRoof(vols);
  let gaps = 0, overlaps = 0, wrong = 0;
  for (let x = -8; x <= 8; x += 0.137) for (let z = -10; z <= 7; z += 0.131) {
    const H = R.heightAt(x, z), hits = R.pieces.filter((p) => inside(p.poly, x, z));
    if (H === -Infinity) continue;
    if (!hits.length) gaps++;
    else if (Math.abs(hits[0].plane.a * x + hits[0].plane.b * z + hits[0].plane.c - H) > 1e-3) wrong++;
    const deep = hits.filter((p) => wellInside(p.poly, x, z));
    if (deep.length > 1) { const ys = deep.map((p) => p.plane.a * x + p.plane.b * z + p.plane.c); if (Math.max(...ys) - Math.min(...ys) > 1e-3) overlaps++; }
  }
  roofs[name] = { pieces: R.pieces.length, gaps, overlaps, wrong_height: wrong, edges: R.edges.reduce((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {}) };
  ok &&= !gaps && !overlaps && !wrong;
}
const H = JSON.parse(fs.readFileSync(new URL('./houses.json', import.meta.url))), D = JSON.parse(fs.readFileSync(new URL('./buildings.json', import.meta.url)));
const houses = {};
for (const [id, A] of Object.entries(H.archetypes)) for (const style of Object.keys(D._styles)) for (const seed of [1, 2, 3]) {
  const S = 0.5, sty = { S, overhang: 0.18 + 0.62 * S, open: 1 + 0.16 * S }, ST = D._styles[style];
  const a = planHouse({ archetype: A, style: ST, sty, seed }), b = planHouse({ archetype: A, style: ST, sty, seed });
  const same = JSON.stringify([a.vols, a.openings, a.chimneys]) === JSON.stringify([b.vols, b.openings, b.chimneys]);
  const doors = a.openings.filter((o) => o.kind === 'door').length;
  const good = same && doors === 1;
  houses[id] ??= { ok: true, volumes: new Set(), roof_pieces: [] };
  houses[id].ok &&= good;
  a.vols.forEach((V) => houses[id].volumes.add(V.id));
  houses[id].roof_pieces.push(a.roof.pieces.length);
  ok &&= good;
}
for (const h of Object.values(houses)) { h.volumes = [...h.volumes]; h.roof_pieces = [Math.min(...h.roof_pieces), Math.max(...h.roof_pieces)]; }
console.log(JSON.stringify({ ok, roofs, houses }));
