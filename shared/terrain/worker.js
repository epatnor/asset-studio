// Terrängen i en worker (docs/terrain.md, T3 och steg 2): höjdfältet, marken och biomerna byggs utanför
// huvudtråden, så att bilden inte står still medan man drar i spakarna.
//   In: { id, recipe, only: 'biomes' }   only = 'biomes': bara biomerna om (klimatet ändrat), på den senaste terrängen
//   Ut: { id, n, size, cell, positions, normals, index, wet, heights, biomes, coverage, ms, biomeMs } (buffertarna
//   flyttas, kopieras inte; vid only = 'biomes' bara id, biomes, coverage och biomeMs)
import { generateTerrain } from './generate.js';
import { buildField } from './field.js';
import { computeBiomes } from './biomes.js';

let last = null; // den senaste terrängen, för att räkna om biomerna utan att bygga om den

self.onmessage = (e) => {
  const { id, recipe, only } = e.data;
  if (only === 'biomes' && last) {
    const b = computeBiomes(last, recipe);
    postMessage({ id, only, biomes: b.weights, coverage: b.coverage, biomeMs: b.ms }, [b.weights.buffer]);
    return;
  }
  const t = generateTerrain(recipe);
  last = t;
  const axisOf = () => Array.from({ length: t.n }, (_, i) => -t.half + i * t.cell);
  const f = buildField(axisOf(), axisOf(), t.heightAt, { byDifference: true });
  const b = computeBiomes(t, recipe);
  // Höjderna och fukten kopieras (workern behåller sina för nästa biomräkning); resten flyttas
  const out = { id, n: t.n, size: t.size, cell: t.cell, positions: f.positions, normals: f.normals, index: f.index, wet: t.wet.slice(), heights: t.heights.slice(),
    biomes: b.weights, coverage: b.coverage, ms: t.ms, biomeMs: b.ms };
  postMessage(out, [f.positions.buffer, f.normals.buffer, f.index.buffer, out.wet.buffer, out.heights.buffer, b.weights.buffer]);
};
