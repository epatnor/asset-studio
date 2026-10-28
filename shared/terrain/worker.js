// Terrängen i en worker (docs/terrain.md, T3 och stegen Regions, Biomes och Sculpt): höjdfältet, det formade, marken,
// regionerna och biomerna byggs utanför huvudtråden, så att bilden inte står still medan man drar i spakarna.
//   In: { id, recipe, only }   only = 'biomes': bara regionerna och biomerna om (klimat, regioner, målning), på den
//                              senaste terrängen; only = 'edit': penslarna och kanalerna om (sculpt.js) på den senast
//                              genererade världen, utan att generera den igen; annars allt
//   Ut: { id, n, size, cell, positions, normals, index, wet, heights, channels, biomes, coverage, regions, reg, look,
//   ms, editMs, biomeMs } (buffertarna flyttas, kopieras inte; vid only = 'biomes' utan höjdfältet).
//   regions = { coverage, centers, ms }
import { generateTerrain } from './generate.js';
import { buildField } from './field.js';
import { computeBiomes } from './biomes.js';
import { regionField, regionAttributes } from './regions.js';
import { applyEdits } from './sculpt.js';

let base = null; // den senast genererade världen, före penslarna och kanalerna
let last = null; // den senaste terrängen med det formade, för att räkna om biomerna utan att bygga om den
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
  if (only !== 'edit' || !base) base = generateTerrain(recipe);
  const t = (last = applyEdits(base, recipe));
  const axisOf = () => Array.from({ length: t.n }, (_, i) => -t.half + i * t.cell);
  const f = buildField(axisOf(), axisOf(), t.heightAt, { byDifference: true });
  const N = nature(t, recipe);
  // Höjderna och fukten kopieras (workern behåller sina för nästa biomräkning); resten flyttas
  const out = {
    id, n: t.n, size: t.size, cell: t.cell, positions: f.positions, normals: f.normals, index: f.index, wet: t.wet.slice(), heights: t.heights.slice(),
    channels: t.channels, ms: only === 'edit' ? 0 : t.ms, editMs: t.editMs, ...N.out,
  };
  postMessage(out, [f.positions.buffer, f.normals.buffer, f.index.buffer, out.wet.buffer, out.heights.buffer, ...N.transfer]);
};
