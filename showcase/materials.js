// Klientens tillägg till generatorernas material. Ren klientkod (ingen Node). Används av alla visningssidor.
//
// - Vind: _WIND (0 vid fästet, 1 i spetsen) gungar hörnen.
// - Platta stjälkar: _STEM (förskjutning från mittlinjen) vrids runt mittlinjen mot kameran.
// - Löv (Leaves, LeafMass, Fronds): färgvariation per klump (_CLUSTER) och genomlysning i motljus.
// - Sten (material med extras.triplanar): stentexturen läggs triplanart i världskoordinater, så att det inte
//   blir sömmar mellan ytor, och mossa växer på uppåtvända ytor med en brusig, mjuk kant (extras.moss =
//   mängd, extras.mossTexture = fil relativt modellen, extras.mossTint). Samma teknik som "world aligned
//   blend" i spelmotorer. Utan klienten ser stenen fortfarande rätt ut, bara utan mossa.

export function createMaterialPatcher(THREE, { wind, sunDir }) {
  const foliage = { uSunDir: sunDir, uTrans: { value: 0.55 }, uVary: { value: 1 } };
  const FOLIAGE = /^(Leaves|LeafMass|Fronds)$/;
  const textures = new Map();
  const loader = new THREE.TextureLoader();
  const texture = (url) => {
    if (!textures.has(url)) {
      const t = loader.load(url);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      textures.set(url, t);
    }
    return textures.get(url);
  };

  return function patch(material, modelUrl) {
    const leafy = FOLIAGE.test(material.name);
    const tri = material.userData?.triplanar && material.map ? material.userData : null;
    const rock = tri ? {
      tMoss: { value: tri.mossTexture ? texture(new URL(tri.mossTexture, new URL(modelUrl, location.href)).href) : null },
      uMoss: { value: tri.moss ?? 0 }, uMossTint: { value: new THREE.Color(tri.mossTint ?? '#ffffff') },
      uStoneScale: { value: tri.stoneScale ?? 1 }, uMossScale: { value: tri.mossScale ?? 4 },
    } : null;
    material.customProgramCacheKey = () => `tinkertown-${leafy}-${!!tri}`;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = wind.uTime;
      shader.uniforms.uWind = wind.uWind;
      Object.assign(shader.uniforms, foliage, rock ?? {});
      if (leafy) shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir;\nuniform float uTrans, uVary;\nvarying vec3 vVary;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(1.0), vVary, uVary);')
        .replace('#include <opaque_fragment>', `
          // Genomlysning: ljust och varmt där man ser mot solen genom lövverket
          vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          float back = pow(max(dot(-normalize(vViewPosition), sunV), 0.0), 4.0);
          outgoingLight += diffuseColor.rgb * vec3(1.0, 0.92, 0.7) * back * uTrans;
          #include <opaque_fragment>`);
      if (tri) shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tMoss;
          uniform float uMoss, uStoneScale, uMossScale;
          uniform vec3 uMossTint;
          varying vec3 vTriPos, vTriNormal;
          float triHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
          float triNoise(vec3 p) { // mjukt värdebrus i 3D för mossans kant
            vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(triHash(i), triHash(i + vec3(1, 0, 0)), u.x), mix(triHash(i + vec3(0, 1, 0)), triHash(i + vec3(1, 1, 0)), u.x), u.y),
                       mix(mix(triHash(i + vec3(0, 0, 1)), triHash(i + vec3(1, 0, 1)), u.x), mix(triHash(i + vec3(0, 1, 1)), triHash(i + vec3(1, 1, 1)), u.x), u.y), u.z);
          }
          vec3 triplanar(sampler2D t, vec3 p, vec3 w, float s) {
            return texture2D(t, p.zy * s).rgb * w.x + texture2D(t, p.xz * s).rgb * w.y + texture2D(t, p.xy * s).rgb * w.z;
          }`)
        .replace('#include <map_fragment>', `
          vec3 tw = pow(abs(vTriNormal), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
          vec3 stone = triplanar(map, vTriPos, tw, uStoneScale);
          float mw = 0.0;
          if (uMoss > 0.0) {
            // Mossa på ovansidan; bruset bryter upp kanten i tungor och fläckar
            float n = triNoise(vTriPos * 3.1) * 0.6 + triNoise(vTriPos * 9.0) * 0.4;
            float edge = 1.0 - uMoss * 1.25;
            mw = smoothstep(edge - 0.06, edge + 0.06, vTriNormal.y + (n - 0.5) * 0.55);
          }
          vec3 moss = uMoss > 0.0 ? triplanar(tMoss, vTriPos, tw, uMossScale) * uMossTint : stone;
          diffuseColor.rgb = mix(diffuseColor.rgb * stone, moss, mw);`);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float _wind;
          attribute vec3 _stem;
          attribute float _cluster;
          uniform float uTime, uWind;
          varying vec3 vVary;${tri ? '\nvarying vec3 vTriPos, vTriNormal;' : ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          mat4 tkModel = modelMatrix; // med instansiering (skogen) har varje exemplar sin egen matris
          #ifdef USE_INSTANCING
            tkModel = modelMatrix * instanceMatrix;
          #endif
          if (dot(_stem, _stem) > 0.0) {
            vec3 c = transformed - _stem;
            vec3 toCam = cameraPosition - (tkModel * vec4(c, 1.0)).xyz;
            vec3 sideW = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
            vec3 sideL = normalize(transpose(mat3(tkModel)) * sideW), perp = cross(sideL, vec3(0.0, 1.0, 0.0));
            transformed = c + sideL * length(_stem) * sign(dot(_stem, sideL) * 1000.0 + dot(_stem, perp));
          }
          vec4 wp = tkModel * vec4(position, 1.0);
          float ph = wp.x * 0.35 + wp.z * 0.25;
          float sway = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 3.1 + ph * 2.3) * 0.25;
          transformed.xz += vec2(sway, sway * 0.6) * _wind * _wind * uWind * 0.12;
          float h1 = fract(sin(_cluster * 12.9898 + 1.7) * 43758.5453), h2 = fract(sin(_cluster * 78.233 + 4.1) * 24634.6345);
          vVary = vec3(1.0 + (h2 - 0.5) * 0.1, 1.0, 1.0 - (h2 - 0.5) * 0.12) * (0.9 + h1 * 0.2);
          ${tri ? 'vTriPos = (tkModel * vec4(transformed, 1.0)).xyz; vTriNormal = normalize(mat3(tkModel) * objectNormal);' : ''}`);
    };
    material.needsUpdate = true;
  };
}
