// Terrängen i en worker (docs/terrain.md, T3): höjdfältet och marken byggs utanför huvudtråden, så att bilden inte
// står still medan man drar i spakarna. In: { id, recipe }. Ut: { id, n, size, cell, positions, normals, index, wet,
// heights, ms } (buffertarna flyttas, kopieras inte).
import { generateTerrain } from './generate.js';
import { buildField } from './field.js';

self.onmessage = (e) => {
  const { id, recipe } = e.data;
  const t = generateTerrain(recipe);
  const axisOf = () => Array.from({ length: t.n }, (_, i) => -t.half + i * t.cell);
  const f = buildField(axisOf(), axisOf(), t.heightAt, { byDifference: true });
  const out = { id, n: t.n, size: t.size, cell: t.cell, positions: f.positions, normals: f.normals, index: f.index, wet: t.wet, heights: t.heights, ms: t.ms };
  postMessage(out, [f.positions.buffer, f.normals.buffer, f.index.buffer, t.wet.buffer, t.heights.buffer]);
};
