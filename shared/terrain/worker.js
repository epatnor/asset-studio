// Terrängen i en worker (docs/terrain.md, T3 och stegen Regions och Biomes): höjdfältet, marken, regionerna och
// biomerna byggs utanför huvudtråden, så att bilden inte står still medan man drar i spakarna.
//   In: { id, recipe, only: 'biomes' }   only = 'biomes': bara regionerna och biomerna om (klimat, regioner, målning),
//                                        på den senaste terrängen
//   Ut: { id, n, size, cell, positions, normals, index, wet, heights, biomes, coverage, regions, reg, look, ms, biomeMs }
//   (buffertarna flyttas, kopieras inte; vid only = 'biomes' utan höjdfältet). regions = { coverage, centers, ms }
import { generateTerrain } from './generate.js';
import { buildField } from './field.js';
import { computeBiomes } from './biomes.js';
import { regionField, regionAttributes } from './regions.js';

let last = null; // den senaste terrängen, för att räkna om biomerna utan att bygga om den
const cache = {}; // regionernas avstånd (regions.js), så länge terrängen och mittpunkterna är desamma

function nature(t, recipe) {
  const rf = regionField(t, recipe, cache);
  const b = computeBiomes(t, recipe, rf);
  const a = regionAttributes(t, rf);
  return {
    out: { biomes: b.weights, coverage: b.coverage, biomeMs: b.ms + rf.ms, reg: a.reg, look: a.look, regions: { coverage: rf.coverage, centers: rf.centers, ms: rf.ms } },
    transfer: [b.weights.buffer, a.reg.buffer, a.look.buffer],
  };
}

self.onmessage = (e) => {
  const { id, recipe, only } = e.data;
  if (only === 'biomes' && last) {
    const N = nature(last, recipe);
    postMessage({ id, only, ...N.out }, N.transfer);
    return;
  }
  const t = generateTerrain(recipe);
  last = t;
  const axisOf = () => Array.from({ length: t.n }, (_, i) => -t.half + i * t.cell);
  const f = buildField(axisOf(), axisOf(), t.heightAt, { byDifference: true });
  const N = nature(t, recipe);
  // Höjderna och fukten kopieras (workern behåller sina för nästa biomräkning); resten flyttas
  const out = { id, n: t.n, size: t.size, cell: t.cell, positions: f.positions, normals: f.normals, index: f.index, wet: t.wet.slice(), heights: t.heights.slice(), ms: t.ms, ...N.out };
  postMessage(out, [f.positions.buffer, f.normals.buffer, f.index.buffer, out.wet.buffer, out.heights.buffer, ...N.transfer]);
};
