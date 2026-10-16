// Stiliserat vatten (dammar och sjöar). Ren klientkod (ingen Node).
//
// Knepen, i stil med WoW: inga riktiga speglingar eller djupbuffertar.
// - Djupet räknas ur terrängen (vattenytan minus marken) och bakas in per hörn; färgen går från turkost
//   grunt till blått djupt, och vattnet är genomskinligt där det är grunt.
// - Himlen speglas falskt med fresnel (himlens gradient i stället för en spegelbild).
// - Två lager rörliga krusningar ger normaler, ett skarpt stiliserat solglitter och lätta vågor.
// - Skum: en vit kant mot land och band som rör sig mot stranden.
// Kaustik och våt mark på botten görs i markens shader (se park.html).

export function createPond(W, { heightAt, level, center, radius, inside = () => true, colors = {} }) {
  const { THREE, scene } = W;
  const c = { shallow: '#52CDBE', deep: '#1B6898', foam: '#F2FBFF', ...colors };
  const size = radius * 3, seg = Math.ceil(size * 4);
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const P = geo.attributes.position, depth = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i) + center.x, z = P.getZ(i) + center.z;
    depth[i] = inside(x, z) ? level - heightAt(x, z) : -1; // utanför vattnets mask finns ingen yta, även om marken ligger lägre
  }
  geo.setAttribute('depth', new THREE.BufferAttribute(depth, 1));

  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uShallow: { value: new THREE.Color(c.shallow) }, uDeep: { value: new THREE.Color(c.deep) }, uFoam: { value: new THREE.Color(c.foam) },
    uSky: { value: new THREE.Color('#8fbdf0') }, uHorizon: { value: new THREE.Color('#d9ecff') },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5).normalize() }, uSunColor: { value: new THREE.Color('#fff1d6') },
  }]);
  uniforms.uTime = W.wind.uTime; uniforms.uWind = W.wind.uWind; // delade, inte kopior
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: true,
    vertexShader: `
      attribute float depth;
      uniform float uTime;
      varying vec3 vW; varying float vD;
      #include <fog_pars_vertex>
      void main() {
        vec3 p = position;
        p.y += (sin(p.x * 1.3 + uTime * 1.1) + sin(p.z * 1.7 - uTime * 0.9)) * 0.008 * smoothstep(0.0, 0.4, depth);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vW = wp.xyz; vD = depth;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 uShallow, uDeep, uFoam, uSky, uHorizon, uSunDir, uSunColor;
      uniform float uTime, uWind;
      varying vec3 vW; varying float vD;
      #include <fog_pars_fragment>
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float waves(vec2 p) {
        return vnoise(p * 1.7 + vec2(uTime * 0.35, uTime * 0.2)) * 0.6 + vnoise(p * 3.9 - vec2(uTime * 0.25, -uTime * 0.42)) * 0.4;
      }
      void main() {
        if (vD < -0.02) discard; // över land
        vec2 p = vW.xz, e = vec2(0.06, 0.0);
        float k = 0.08 + uWind * 0.18; // krusningarnas styrka följer vinden
        vec3 n = normalize(vec3(-(waves(p + e.xy) - waves(p - e.xy)) * k, 2.0 * e.x, -(waves(p + e.yx) - waves(p - e.yx)) * k));
        vec3 V = normalize(cameraPosition - vW);
        float fres = clamp(0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0), 0.0, 1.0) * 0.6;
        vec3 r = reflect(-V, n);
        vec3 sky = mix(uHorizon, uSky, clamp(r.y * 1.6, 0.0, 1.0));
        vec3 col = mix(uShallow, uDeep, smoothstep(0.05, 1.3, vD));
        col = mix(col, sky, fres);
        // Stiliserat glitter: en skarp tröskel ovanpå ett mjukt högdager
        float s = pow(max(dot(n, normalize(uSunDir + V)), 0.0), 280.0);
        col += uSunColor * (smoothstep(0.35, 0.45, s) * 1.4 + s * 0.4);
        // Skum: kant mot land och band som vandrar in mot stranden
        float edge = 1.0 - smoothstep(0.0, 0.07, vD);
        float bands = smoothstep(0.55, 0.6, fract(vD * 4.0 + uTime * 0.18 + vnoise(p * 1.8) * 0.7)) * (1.0 - smoothstep(0.02, 0.25, vD));
        float foam = max(edge * 0.8, bands * 0.3) * smoothstep(0.35, 0.75, vnoise(p * 6.0 + uTime * 0.4));
        col = mix(col, uFoam, foam);
        float alpha = clamp(mix(0.3, 0.92, smoothstep(0.0, 0.9, vD)) + fres * 0.3 + foam, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(center.x, level, center.z);
  mesh.renderOrder = 1;
  scene.add(mesh);
  // Solens riktning följer världens sol
  const tmp = new THREE.Vector3();
  W.onFrame(() => uniforms.uSunDir.value.copy(tmp.subVectors(W.sun.position, W.sun.target.position).normalize()));
  return { mesh, uniforms };
}
