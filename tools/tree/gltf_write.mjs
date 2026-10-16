// Gemensam glTF-skrivare för generatorerna: geometrin hamnar i <name>.gltf + <name>.bin, men texturerna
// bäddas INTE in. De refereras med relativa sökvägar till de delade filerna i assets/textures/, så att
// samma bark- och lövtextur laddas en gång för alla träd och props (i stället för en kopia per modell).
import fs from 'node:fs';
import path from 'node:path';

// Skapa en textur som pekar på en delad fil (relativt modellens mapp). Bilddatan behövs bara för att
// gltf-transform ska kunna skriva dokumentet; den skrivs aldrig ut igen.
export function sharedTexture(doc, file, name, outPath) {
  const uri = path.relative(path.dirname(outPath), file).split(path.sep).join('/');
  return doc.createTexture(name).setImage(new Uint8Array(fs.readFileSync(file))).setMimeType('image/png').setURI(uri);
}

// NodeIO skickas in av anroparen: generatorerna har var sin kopia av @gltf-transform/core (tools/tree och
// tools/props), och två kopior av biblioteket känner inte igen varandras objekt (då skrivs inga accessorer).
export async function writeGltf(doc, outPath, NodeIO) {
  const base = path.basename(outPath, path.extname(outPath));
  for (const b of doc.getRoot().listBuffers()) b.setURI(`${base}.bin`);
  const { json, resources } = await new NodeIO().writeJSON(doc, { basename: base });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(json));
  // Bara geometribufferten skrivs; bilderna finns redan som delade filer
  for (const [uri, data] of Object.entries(resources)) {
    if (uri.endsWith('.bin')) fs.writeFileSync(path.join(path.dirname(outPath), uri), data);
  }
  return outPath;
}
