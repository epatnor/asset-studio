// Delade texturer mellan glTF-filer. Generatorerna refererar samma PNG-filer i assets/textures/ från alla
// modeller, men GLTFLoader cachar bara inom en fil. Det här insticket gör cachen global (per URL och sampler),
// så att varje bild avkodas och laddas upp till GPU:n en gång, oavsett hur många modeller som använder den.
const cache = new Map();

export function shareTextures(loader) {
  return loader.register((parser) => ({
    name: 'tinkertown_shared_textures',
    loadTexture(index) {
      const { textures, images } = parser.json;
      const def = textures[index];
      const uri = images?.[def.source]?.uri;
      if (!uri || uri.startsWith('data:')) return null; // inbäddad bild: vanlig väg
      const base = new URL(parser.options.path || './', location.href);
      const key = `${new URL(uri, base).href}|${def.sampler ?? ''}`;
      if (!cache.has(key)) cache.set(key, parser.loadTextureImage(index, def.source, parser.textureLoader));
      return cache.get(key);
    },
  }));
}
