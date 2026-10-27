// Mot synlig upprepning på stora ytor (patriks_input/AAA_Reference_Guided_Procedural_Textures_Tiling_ThreeJS_Reference.md,
// avsnitt 6): en sömlös ruta kan ändå visa ett tydligt rutnät när den upprepas 16 × 16. Två billiga lager:
// - Två samplingar i samma skala, den andra vriden och förskjuten, blandade med lågfrekvent brus. Blandningen räknas
//   mot texturens medelfärg (minsta mipnivån), så att kontrasten bevaras där samplingarna möts (annars blir ytan grå
//   och urvattnad): ut = medel + (blandning − medel) / √(w² + (1 − w)²).
// - Storskalig tonvariation i världen (macro, ±andel), som döljer att varje ruta har samma ljushet.
// Vridningen passar riktningslösa material (mark, sand, sten), inte bark eller trä med fibrer. Ren TSL.
import { texture, vec2, vec3, float, mix, smoothstep, sqrt, mx_noise_float } from 'three/tsl';

/**
 * @param {THREE.Texture} tex  en upprepande textur (RepeatWrapping, mipmaps)
 * @param {Node} uv  texturkoordinater i rutor (t.ex. världens xz / meter per ruta)
 * @param {{macro?: number, rotate?: boolean}} o
 * @returns {Node} rgb
 */
export function antiTiled(tex, uv, { macro = 0.1, rotate = true } = {}) {
  // ?noantitile i adressen stänger av skyddet, för att jämföra före och efter
  if (globalThis.location?.search.includes('noantitile')) return texture(tex, uv).rgb;
  const a = texture(tex, uv).rgb;
  let c = a;
  if (rotate) {
    const uvB = vec2(uv.x.mul(0.8).sub(uv.y.mul(0.6)), uv.x.mul(0.6).add(uv.y.mul(0.8))).add(vec2(0.37, 0.71));
    const b = texture(tex, uvB).rgb;
    const w = smoothstep(0.3, 0.7, mx_noise_float(vec3(uv.mul(0.23), 0.5)).mul(0.5).add(0.5));
    const mean = texture(tex, vec2(0.5, 0.5)).level(12).rgb;
    const norm = sqrt(w.mul(w).add(float(1).sub(w).mul(float(1).sub(w))));
    c = mean.add(mix(a, b, w).sub(mean).div(norm)).max(0);
  }
  if (macro > 0) {
    const g = mx_noise_float(vec3(uv.mul(0.07), 1.7)).mul(0.5).add(0.5);
    c = c.mul(mix(float(1 - macro), float(1 + macro * 0.8), g));
  }
  return c;
}
