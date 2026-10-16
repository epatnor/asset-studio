// Komprimera alla genererade modeller (meshopt + WebP-texturer) utan att generera om dem.
// Nya modeller komprimeras redan av generatorerna (tools/tree/gltf_write.mjs); det här är för äldre filer.
//   node tools/compress_assets.mjs        -> en rad JSON
import fs from 'node:fs';
import path from 'node:path';
import { io, writeGltf } from './tree/gltf_write.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const reader = await io();
let done = 0, skipped = 0, before = 0, after = 0;
for (const kind of ['trees', 'props', 'plants']) {
  const dir = path.join(ROOT, 'assets', kind);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, `${name}.gltf`), bin = path.join(dir, name, `${name}.bin`);
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    before += fs.statSync(bin).size;
    if (json.extensionsUsed?.includes('EXT_meshopt_compression')) { skipped++; after += fs.statSync(bin).size; continue; }
    await writeGltf(await reader.read(file), file);
    after += fs.statSync(bin).size; done++;
  }
}
console.log(JSON.stringify({ compressed: done, already: skipped, bin_mb_before: +(before / 1e6).toFixed(1), bin_mb_after: +(after / 1e6).toFixed(1) }));
