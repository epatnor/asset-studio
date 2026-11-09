// Gör om en GLB med det gamla spec-gloss-materialet (KHR_materials_pbrSpecularGlossiness) till vanlig metall/ruffighet,
// som three.js, Godot och Blender läser. Skrivs till en ny fil; originalet rörs inte.
//   node tools/mesh/to_metalrough.mjs '{"in": "a.glb", "out": "a_mr.glb"}'
// Svarar med en rad JSON.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { metalRough } from "@gltf-transform/functions";

const r = JSON.parse(process.argv[2]);
try {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(r.in);
  const before = doc.getRoot().listExtensionsUsed().map(e => e.extensionName);
  await doc.transform(metalRough());
  await io.write(r.out, doc);
  const after = doc.getRoot().listExtensionsUsed().map(e => e.extensionName);
  console.log(JSON.stringify({ ok: true, out: r.out, extensions_before: before, extensions_after: after }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }));
  process.exit(1);
}
