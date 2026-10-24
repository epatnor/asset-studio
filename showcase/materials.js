// Klientens tillägg till generatorernas material. Ren klientkod (ingen Node). Används av alla visningssidor.
//
// - Vind: _WIND (0 vid fästet, 1 i spetsen) gungar hörnen.
// - Platta stjälkar: _STEM (förskjutning från mittlinjen) vrids runt mittlinjen mot kameran.
// - Löv (Leaves, LeafMass, Fronds): färgvariation per klump (_CLUSTER), genomlysning i motljus (starkast i
//   kronans tunna ytterkant), dämpad spekular (uLeafSpec) och kort som tonar bort när de ses från kanten
//   (uEdgeFade) och valfritt mjukare skugga på löven (uLeafShadow), enligt docs/Stiliserad_vegetation_ThreeJS.
// - Bark med extras.blend: påväxt vid foten och grön textur i grentopparna, viktade per hörn med brusig kant.
// - Sten (material med extras.triplanar): stentexturen läggs triplanart i världskoordinater, så att det inte
//   blir sömmar mellan ytor, och mossa växer på uppåtvända ytor med en brusig, mjuk kant (extras.moss =
//   mängd, extras.mossTexture = fil relativt modellen, extras.mossTint). Samma teknik som "world aligned
//   blend" i spelmotorer. Utan klienten ser stenen fortfarande rätt ut, bara utan mossa.

import { patchFog } from './effects.js';

// Skuggroller från generatorn (materialets extras, i userData): castShadow/receiveShadow false stänger av
// skuggan för delen (kortbollarnas lövkort, vars skärningar annars syns i skuggorna), och shadowProxy är en
// osynlig form som bara kastar skugga. Anropas efter att standardvärdena satts på en mesh.
export function applyShadowRole(mesh) {
  const u = mesh.material?.userData ?? {};
  if (u.castShadow === false) mesh.castShadow = false;
  if (u.receiveShadow === false) mesh.receiveShadow = false;
  if (u.shadowProxy) {
    mesh.receiveShadow = false;
    mesh.material.colorWrite = false;
    mesh.material.depthWrite = false;
  }
}

export function createMaterialPatcher(THREE, { wind, sunDir, snow = { value: 0 }, fogU = null }) {
  const foliage = { uSunDir: sunDir, uTrans: { value: 0.55 }, uVary: { value: 1 }, uLeafSpec: { value: 0.15 }, uEdgeFade: { value: 1 }, uLeafShadow: { value: 1 } };
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

  const patch = function (material, modelUrl) {
    const leafy = FOLIAGE.test(material.name);
    const tri = material.userData?.triplanar && material.map ? material.userData : null;
    const rock = tri ? {
      tMoss: { value: tri.mossTexture ? texture(new URL(tri.mossTexture, new URL(modelUrl, location.href)).href) : null },
      uMoss: { value: tri.moss ?? 0 }, uMossTint: { value: new THREE.Color(tri.mossTint ?? '#ffffff') },
      uStoneScale: { value: tri.stoneScale ?? 1 }, uMossScale: { value: tri.mossScale ?? 4 },
    } : null;
    // Texturblandning på bark (extras.blend från trädgeneratorn): påväxt vid foten och grön textur i grentopparna,
    // viktade per hörn (_BLENDBASE, _BLENDTIP) och med en brusig kant
    const bl = material.userData?.blend && material.map ? material.userData.blend : null;
    const part = (b) => ({
      t: { value: b ? texture(new URL(b.texture, new URL(modelUrl, location.href)).href) : null },
      str: { value: b?.strength ?? 0 }, tint: { value: new THREE.Color(b?.tint ?? '#ffffff') }, scale: { value: b?.scale ?? 1 }, dark: { value: b?.dark ?? 0 },
    });
    const blend = bl ? (() => {
      const b = part(bl.base), t = part(bl.tip);
      return { tBase: b.t, uBaseStr: b.str, uBaseTint: b.tint, uBaseScale: b.scale, uBaseDark: b.dark, tTip: t.t, uTipStr: t.str, uTipTint: t.tint, uTipScale: t.scale };
    })() : null;
    material.customProgramCacheKey = () => `tinkertown-${leafy}-${!!tri}-${!!bl}`;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = wind.uTime;
      shader.uniforms.uWind = wind.uWind;
      Object.assign(shader.uniforms, foliage, rock ?? {}, blend ?? {});
      patchFog(shader, fogU); // dimma åt solen, markdimma och molnskuggor (effects.js)
      // Snö (atmosphere.js): uppåtvända ytor vitnar
      shader.uniforms.uSnow = snow;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSnow;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n      { float upW = (vec4(normal, 0.0) * viewMatrix).y; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.98), uSnow * smoothstep(0.25, 0.75, upW)); }');
      if (leafy) shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir;\nuniform float uTrans, uVary, uLeafSpec, uEdgeFade, uLeafShadow;\nvarying vec3 vVary;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(1.0), vVary, uVary);')
        // Lövkort som ses från kanten blir utdragna strimmor (syns tydligt i korsade kortbollar). Kortets riktiga
        // ytnormal räknas ur skärmderivator (normalerna är ju kronans) och alfagränsen höjs när kortet vänder
        // kanten mot kameran, så att det tonar bort. Skuggpasset använder hela kortet som förut.
        .replace('#include <alphatest_fragment>', `
          #ifdef USE_ALPHATEST
            vec3 tkGeoN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
            float tkFacing = abs(dot(tkGeoN, normalize(vViewPosition)));
            if (diffuseColor.a < mix(alphaTest, 1.01, uEdgeFade * (1.0 - smoothstep(0.12, 0.4, tkFacing)))) discard;
          #endif`)
        // Mjukare skugga på löv (uLeafShadow < 1): kort som skuggar varandra ger skarpa fläckar som avslöjar
        // korten. Löven tar då bara emot en del av solskuggan (även från andra föremål).
        .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin
          .replace(/\? getShadow\(/g, '? (1.0 - uLeafShadow) + uLeafShadow * getShadow('))
        // Begränsade högdagrar (vegetationsguiden): löv glänser inte i solen
        .replace('#include <aomap_fragment>', 'reflectedLight.directSpecular *= uLeafSpec;\nreflectedLight.indirectSpecular *= uLeafSpec;\n#include <aomap_fragment>')
        .replace('#include <opaque_fragment>', `
          // Genomlysning: ljust och varmt där man ser mot solen genom lövverket. En smal glöd runt solen
          // och en bredare svagare; starkast på sidan som vänder sig bort från solen och i kronans tunna
          // ytterkant (ljus vertexfärg), svagast i det täta, mörka inre.
          vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          float vdl = max(dot(-normalize(vViewPosition), sunV), 0.0);
          float back = pow(vdl, 4.0) + 0.25 * pow(vdl, 1.5);
          float away = mix(0.35, 1.0, clamp(0.5 - 0.5 * dot(normal, sunV), 0.0, 1.0));
          float thin = 1.0;
          #ifdef USE_COLOR
            thin = smoothstep(0.2, 0.85, dot(vColor.rgb, vec3(0.3, 0.5, 0.2)));
          #endif
          outgoingLight += diffuseColor.rgb * vec3(1.0, 0.92, 0.7) * back * away * mix(0.4, 1.0, thin) * uTrans;
          #include <opaque_fragment>`);
      if (bl) shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tBase, tTip;
          uniform float uBaseStr, uBaseScale, uBaseDark, uTipStr, uTipScale;
          uniform vec3 uBaseTint, uTipTint;
          varying vec2 vBlend;
          float blHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float blNoise(vec2 p) { // mjukt värdebrus för blandningens kant
            vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
            return mix(mix(blHash(i), blHash(i + vec2(1, 0)), u.x), mix(blHash(i + vec2(0, 1)), blHash(i + vec2(1, 1)), u.x), u.y);
          }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          {
            float bn = blNoise(vMapUv * 7.0) * 0.6 + blNoise(vMapUv * 19.0) * 0.4;
            // Foten: påväxt med tungor uppåt, och mörkare ju närmare marken
            float wb = smoothstep(0.35, 0.65, vBlend.x + (bn - 0.5) * 0.7) * uBaseStr;
            diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(tBase, vMapUv * uBaseScale).rgb * uBaseTint, wb) * (1.0 - uBaseDark * vBlend.x);
            // Grentopparna: grön textur ytterst
            float wt = smoothstep(0.3, 0.7, vBlend.y + (bn - 0.5) * 0.6) * uTipStr;
            diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(tTip, vMapUv * uTipScale).rgb * uTipTint, wt);
          }`);
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
          ${bl ? 'attribute float _blendbase, _blendtip;\nvarying vec2 vBlend;' : ''}
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
          ${tri ? 'vTriPos = (tkModel * vec4(transformed, 1.0)).xyz; vTriNormal = normalize(mat3(tkModel) * objectNormal);' : ''}
          ${bl ? 'vBlend = vec2(_blendbase, _blendtip);' : ''}`);
    };
    material.needsUpdate = true;
  };
  patch.uniforms = foliage; // lövens uniformer, för felsökning och reglage
  return patch;
}
