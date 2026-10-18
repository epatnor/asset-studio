// Packa upp en meshopt-komprimerad glTF för Blender, vars importör saknar meshopt-avkodaren.
//   node decompress.mjs <in.gltf> <ut.gltf>
// Utfilen bör ligga i samma mapp som infilen, så att de relativa texturvägarna fortsätter att stämma.
// Bara geometribufferten skrivs; texturerna är delade filer.
import fs from 'node:fs';
import path from 'node:path';
import { io } from '../tree/gltf_write.mjs';

const [src, dst] = process.argv.slice(2);
const nio = await io();
const doc = await nio.read(src);
for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
const base = path.basename(dst, path.extname(dst));
for (const b of doc.getRoot().listBuffers()) b.setURI(`${base}.bin`);
const { json, resources } = await nio.writeJSON(doc, { basename: base });
fs.writeFileSync(dst, JSON.stringify(json));
for (const [uri, data] of Object.entries(resources)) if (uri.endsWith('.bin')) fs.writeFileSync(path.join(path.dirname(dst), uri), data);
