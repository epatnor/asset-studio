// Testindata för importen, utan nedladdning: tar en egen modell och "förstör" den som en typisk
// extern fil (centimeter, flyttad från origo, inbäddade texturer, en enda GLB).
//   node test_inputs.mjs <in.gltf> <ut.glb>
import { io } from '../tree/gltf_write.mjs';
const [src, dst] = process.argv.slice(2);
const rw = await io();
const doc = await rw.read(src);
for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
for (const n of scene.listChildren()) n.setScale([100, 100, 100]).setTranslation([530, 270, -180]);
for (const t of doc.getRoot().listTextures()) t.setURI('');
await rw.write(dst, doc);
console.log(JSON.stringify({ wrote: dst }));
