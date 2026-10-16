// Kontroll: hörn som ligger i samma punkt (inom en primitiv) måste ha samma vindvikt (_WIND),
// annars flyttar vindshadern dem olika långt och geometrin slits isär.
// Användning: node check_wind.mjs <glb> [<glb> ...]   -> en rad JSON per fil
import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();
for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  let worst = 0, torn = 0, total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    if (!/LOD0/.test(mesh.getName())) continue;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'), wind = prim.getAttribute('_WIND');
      if (!pos || !wind) continue;
      const seen = new Map();
      for (let i = 0; i < pos.getCount(); i++) {
        const p = pos.getElement(i, []);
        const key = p.map((x) => Math.round(x * 1e4)).join(',');
        const w = wind.getElement(i, [])[0];
        if (seen.has(key)) {
          const d = Math.abs(seen.get(key) - w);
          total++;
          if (d > 1e-4) { torn++; worst = Math.max(worst, d); }
        } else seen.set(key, w);
      }
    }
  }
  console.log(JSON.stringify({ file: file.split('/').slice(-2).join('/'), shared_vertices: total, torn, worst: +worst.toFixed(3) }));
}
