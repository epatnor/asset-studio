// Gemensam glTF-skrivare för generatorerna: geometrin hamnar i <name>.gltf + <name>.bin, men texturerna
// bäddas INTE in. De refereras med relativa sökvägar till de delade filerna i assets/textures/, så att
// samma bark- och lövtextur laddas en gång för alla träd och props (i stället för en kopia per modell).
//
// Nedladdningen hålls liten på två sätt:
// - Geometrin komprimeras med meshopt (EXT_meshopt_compression). Normaler och vertexfärger kvantiseras
//   (KHR_mesh_quantization); positioner och egna attribut (_WIND, _STEM ...) lämnas som float, eftersom
//   klientens shaders räknar med dem i modellens egna meter.
// - Texturer pekar på en WebP-version om den finns (tools/texture/to_webp.py), annars PNG.
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const webpOf = (file) => file.replace(/\.png$/i, '.webp');

// Skapa en textur som pekar på en delad fil (relativt modellens mapp). Bilddatan behövs bara för att
// gltf-transform ska kunna skriva dokumentet; den skrivs aldrig ut igen.
export function sharedTexture(doc, file, name, outPath) {
  const use = fs.existsSync(webpOf(file)) ? webpOf(file) : file;
  const uri = path.relative(path.dirname(outPath), use).split(path.sep).join('/');
  return doc.createTexture(name).setImage(new Uint8Array(fs.readFileSync(use))).setMimeType(use.endsWith('.webp') ? 'image/webp' : 'image/png').setURI(uri);
}

export const io = async () => {
  await MeshoptEncoder.ready; await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
};

export async function compress(doc, outPath) {
  await MeshoptEncoder.ready;
  // Byt till WebP där det finns, även för dokument som lästs in från äldre filer
  for (const t of doc.getRoot().listTextures()) {
    const uri = t.getURI();
    if (uri?.endsWith('.png') && fs.existsSync(path.join(path.dirname(outPath), webpOf(uri)))) { t.setURI(webpOf(uri)); t.setMimeType('image/webp'); }
  }
  await doc.transform(
    reorder({ encoder: MeshoptEncoder }),
    quantize({ pattern: /^(NORMAL|COLOR_\d)$/, quantizeNormal: 10, quantizeColor: 8 }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
}

export async function writeGltf(doc, outPath) {
  await compress(doc, outPath);
  const base = path.basename(outPath, path.extname(outPath));
  for (const b of doc.getRoot().listBuffers()) b.setURI(`${base}.bin`);
  const { json, resources } = await (await io()).writeJSON(doc, { basename: base });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(json));
  // Bara geometribufferten skrivs; bilderna finns redan som delade filer
  for (const [uri, data] of Object.entries(resources)) {
    if (uri.endsWith('.bin')) fs.writeFileSync(path.join(path.dirname(outPath), uri), data);
  }
  return outPath;
}
