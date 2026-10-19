// Atmosfär för alla banor: himmel, sol och måne, tid på dygnet, dimma, väder och färgton.
// Ren klientkod (ingen Node). Överförd från Azshara Island (Godot), anpassad till Three.js och stilguiden.
//
// - Himlen är en kupol som följer kameran: gradient horisont–zenit, solskiva med glöd, måne mitt emot solen,
//   stjärnor på natten, och ett volymetriskt molnlager som marscheras per pixel (några steg genom lagret,
//   med en kort vandring mot solen för självskugga). Molnen ljusa i kanten och skuggade undertill.
// - Tiden (0–24) flyttar solen i en båge: upp i öster (+x), högst i söder (+z), ner i väster. Låg sol blir
//   varm (Rayleigh), natten blå med svagt månljus. Solljus, himmelsljus, dimma och himmel följer samma värden.
// - Väder: molntäcke och molnsort (fjädermoln till bomullsmoln), vind (träd, gräs och molndrift), regn och
//   snö som partiklar runt kameran, snö som vitnar uppåtvända ytor, och storm med mörk himmel och blixtar.
// - Färgton (gradering) med ett CSS-filter på duken: mättnad och kontrast efter väder och tid, utan extra pass.
//
// createAtmosphere(W) läggs till av createWorld; banor ändrar W.atmo.state eller kallar setWeather/setTime.

export const WEATHER = {
  klart:   { clouds: 0.18, cloudKind: 0.8, wind: 0.25, rain: 0, snow: 0, storm: 0, haze: 0 },
  molnigt: { clouds: 0.62, cloudKind: 0.85, wind: 0.4, rain: 0, snow: 0, storm: 0, haze: 0.15 },
  regn:    { clouds: 0.85, cloudKind: 0.9, wind: 0.55, rain: 0.85, snow: 0, storm: 0.25, haze: 0.4 },
  storm:   { clouds: 0.95, cloudKind: 1, wind: 1, rain: 1, snow: 0, storm: 1, haze: 0.5 },
  snö:     { clouds: 0.75, cloudKind: 0.6, wind: 0.3, rain: 0, snow: 0.9, storm: 0.1, haze: 0.35 },
  dimma:   { clouds: 0.55, cloudKind: 0.3, wind: 0.1, rain: 0, snow: 0, storm: 0, haze: 1 },
};

const SKY_VERT = `
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // alltid längst bort
}`;
const SKY_FRAG = `
precision highp sampler3D;
in vec3 vDir;
out vec4 skyColor; // GLSL3: egen utgång (Three definierar inte gl_FragColor här)
uniform vec3 zenith, horizon, groundCol, sunColor, sunDir, moonDir, moonColor, stormZenith, stormHorizon, stormCloud, lightningColor;
uniform float sunStrength, moonStrength, cloudCover, cloudType, storm, uTime, flash, sunVis;
uniform vec2 cloudDrift;
uniform sampler3D cloudVolume;
uniform sampler2D tSun, tMoon;
const float DISC = 0.035;
float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
vec2 discUv(vec3 dir, vec3 c) {
  vec3 up = abs(c.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 right = normalize(cross(up, c)), dup = cross(c, right);
  return vec2(dot(dir, right), -dot(dir, dup)) / DISC * 0.58 + 0.5;
}
float cloudDensity(vec2 p, float t, float cover, float type) {
  vec3 q = vec3(p * 0.9, t * 0.7);
  float cumulus = texture(cloudVolume, q).r * 0.65 + texture(cloudVolume, q * 2.7 + vec3(0.3, 0.1, 0.7)).r * 0.35;
  float cirrus = texture(cloudVolume, vec3(p.x * 0.25, p.y * 2.2, t * 0.3) + vec3(0.2, 0.5, 0.1)).r;
  float n = mix(cirrus, cumulus, type), th = 1.0 - cover;
  float d = smoothstep(th, th + mix(0.4, 0.22, type), n);
  return d * mix(1.0, sin(t * 3.14159) * 0.8 + 0.2, type) * mix(0.45, 1.0, type);
}
void main() {
  vec3 dir = normalize(vDir);
  vec3 zen = mix(zenith, stormZenith, storm), hor = mix(horizon, stormHorizon, storm);
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 color = mix(hor, zen, pow(smoothstep(0.0, 0.65, up), 0.75));
  color = mix(color, groundCol * mix(1.0, 0.45, storm), smoothstep(0.0, -0.2, dir.y));
  float sd = dot(dir, sunDir), vis = (1.0 - storm * 0.9) * sunStrength;
  float glow = pow(max(sd, 0.0), 5.0) * 0.45 * sunVis + pow(max(sd, 0.0), 80.0) * 0.8;
  vec3 disc = sd > 0.99 ? texture(tSun, discUv(dir, sunDir)).rgb : vec3(0.0);
  color += sunColor * (glow + disc * 2.0 * sunVis) * vis;
  float md = dot(dir, moonDir);
  vec3 moonImg = md > 0.99 ? texture(tMoon, discUv(dir, moonDir)).rgb : vec3(0.0);
  color += moonColor * (pow(max(md, 0.0), 40.0) * 0.25 + moonImg * 2.0) * moonStrength * (1.0 - storm * 0.9);
  if (moonStrength > 0.0 && dir.y > 0.0) { // stjärnor
    vec3 g = dir * 90.0, cell = floor(g);
    float h = hash3(cell);
    if (h > 0.97) {
      float tw = 0.75 + 0.25 * sin(uTime * (1.5 + h * 3.0) + h * 60.0);
      color += vec3(0.85, 0.9, 1.0) * smoothstep(0.3, 0.0, length(fract(g) - 0.5)) * (h - 0.97) / 0.03 * tw * moonStrength * (1.0 - storm) * (1.0 - cloudCover * 0.8);
    }
  }
  float cover = mix(cloudCover, 0.95, storm), fade = smoothstep(0.0, 0.14, dir.y);
  if (fade > 0.0) {
    vec2 toSun = sunDir.xz / max(sunDir.y, 0.15) * 0.05;
    vec3 sunLight = sunColor * sunStrength * (1.0 - storm * 0.8) * mix(0.7, 1.4, pow(max(sd, 0.0), 3.0));
    vec3 amb = mix(hor * 0.9 + zen * 0.1, stormCloud * 2.0, storm) * mix(0.55, 1.0, sunStrength) + moonColor * moonStrength * 0.35;
    vec3 rgb = vec3(0.0);
    float tr = 1.0;
    for (int i = 0; i < 6; i++) {
      float t = (float(i) + 0.5) / 6.0;
      vec2 p = dir.xz / max(dir.y, 0.03) * mix(0.5, 1.5, t) * 0.2 + cloudDrift;
      float d = cloudDensity(p, t, cover, cloudType);
      if (d > 0.002) {
        float sh = cloudDensity(p + toSun, t, cover, cloudType) + cloudDensity(p + toSun * 2.0, t, cover, cloudType) * 0.6;
        float ab = 1.0 - exp(-d * 0.5);
        rgb += tr * ab * (sunLight * exp(-sh * 1.8) + amb);
        tr *= 1.0 - ab;
        if (tr < 0.02) break;
      }
    }
    rgb += lightningColor * flash * (1.0 - tr) * 0.9;
    color = mix(color, rgb / max(1.0 - tr, 0.001), (1.0 - tr) * fade);
  }
  skyColor = vec4(color, 1.0);
}`;

// Sömlöst brus i 3D (värdebrus i fyra oktaver, lindat runt kanterna) för molnen
function cloudTexture(THREE, N = 64) {
  const data = new Uint8Array(N * N * N), f = new Float32Array(N * N * N);
  let seed = 9;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const octaves = [[4, 0.5], [8, 0.27], [16, 0.15], [32, 0.08]];
  for (const [P, amp] of octaves) {
    const lat = Float32Array.from({ length: P * P * P }, rnd), s = N / P;
    const L = (x, y, z) => lat[((z % P) * P + (y % P)) * P + (x % P)];
    const sm = (t) => t * t * (3 - 2 * t);
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const gx = x / s, gy = y / s, gz = z / s, x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz);
      const tx = sm(gx - x0), ty = sm(gy - y0), tz = sm(gz - z0);
      const a = L(x0, y0, z0) + (L(x0 + 1, y0, z0) - L(x0, y0, z0)) * tx, b = L(x0, y0 + 1, z0) + (L(x0 + 1, y0 + 1, z0) - L(x0, y0 + 1, z0)) * tx;
      const c = L(x0, y0, z0 + 1) + (L(x0 + 1, y0, z0 + 1) - L(x0, y0, z0 + 1)) * tx, d = L(x0, y0 + 1, z0 + 1) + (L(x0 + 1, y0 + 1, z0 + 1) - L(x0, y0 + 1, z0 + 1)) * tx;
      f[(z * N + y) * N + x] += amp * ((a + (b - a) * ty) + ((c + (d - c) * ty) - (a + (b - a) * ty)) * tz);
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < f.length; i++) data[i] = Math.round(((f[i] - lo) / (hi - lo)) * 255);
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RedFormat; tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// Regn (streck) och snö (flingor) i en låda som följer kameran; allt rör sig i vertexshadern
function precipitation(THREE, { count, box, snow }) {
  const seeds = new Float32Array(count * (snow ? 3 : 6)), end = new Float32Array(count * (snow ? 1 : 2)), idx = new Float32Array(count * (snow ? 1 : 2));
  for (let i = 0; i < count; i++) {
    const s = [Math.random(), Math.random(), Math.random()];
    if (snow) { seeds.set(s, i * 3); idx[i] = i / count; }
    else { seeds.set([...s, ...s], i * 6); end.set([0, 1], i * 2); idx.set([i / count, i / count], i * 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  geo.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
  const uniforms = { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uAmount: { value: 0 }, uWind: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(snow ? '#F4F8FF' : '#B8C8D8') } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader: `
      attribute float aEnd, aIdx;
      uniform vec3 uCam; uniform float uTime, uAmount; uniform vec2 uWind;
      varying float vA;
      void main() {
        const vec3 B = vec3(${box[0].toFixed(1)}, ${box[1].toFixed(1)}, ${box[0].toFixed(1)});
        float speed = ${snow ? '1.3' : '17.0'};
        vec3 p = position * B;
        p.y = mod(p.y - uTime * speed * (0.8 + position.x * 0.4), B.y);
        ${snow ? 'p.x += sin(uTime * 0.9 + position.z * 40.0) * 0.6; p.z += cos(uTime * 0.7 + position.x * 30.0) * 0.6;' : ''}
        p.xz += uWind * (B.y - p.y) * ${snow ? '0.6' : '0.25'};
        vec3 w = vec3(mod(p.x - uCam.x, B.x) + uCam.x - B.x * 0.5, p.y + uCam.y - B.y * 0.45, mod(p.z - uCam.z, B.z) + uCam.z - B.z * 0.5);
        ${snow ? '' : 'w += vec3(uWind.x * 0.06, 0.55, uWind.y * 0.06) * aEnd;'}
        vA = step(aIdx, uAmount);
        vec4 mv = modelViewMatrix * vec4(w, 1.0);
        gl_Position = vA > 0.5 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
        ${snow ? 'gl_PointSize = clamp(90.0 / -mv.z, 1.5, 6.0);' : ''}
      }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vA;
      void main() {
        ${snow ? 'float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(uColor, (1.0 - d * 2.0) * 0.9);' : 'gl_FragColor = vec4(uColor, 0.32);'}
      }`,
  });
  const obj = snow ? new THREE.Points(geo, mat) : new THREE.LineSegments(geo, mat);
  obj.frustumCulled = false;
  obj.renderOrder = 10;
  return { obj, uniforms };
}

const C = (THREE, h) => new THREE.Color(h);
export function createAtmosphere(W, { time = 10, weather = 'klart', noonElevation = 52 } = {}) {
  const { THREE, scene, camera, renderer } = W;
  const state = { time, auto: false, dayMinutes: 12, ...WEATHER[weather], weather };
  const target = { ...WEATHER[weather] }; // vädret glider mot target
  const pal = {
    sun: C(THREE, '#ffe9c7'), sunset: C(THREE, '#ff8c4d'), stormSun: C(THREE, '#9eb8e6'), moon: C(THREE, '#b3c7f2'),
    zenith: C(THREE, '#5a8fd8'), horizon: C(THREE, '#d9ecff'), nightZenith: C(THREE, '#0a1021'), nightHorizon: C(THREE, '#1a2133'),
    stormZenith: C(THREE, '#1a1c21'), stormHorizon: C(THREE, '#2b3038'), stormCloud: C(THREE, '#12141c'),
    hemiSky: C(THREE, '#cfe6ff'), hemiGround: C(THREE, '#5d7a3a'), nightHemi: C(THREE, '#40527f'), stormHemi: C(THREE, '#4a5566'),
    fog: C(THREE, '#d9ecff'), nightFog: C(THREE, '#141a29'), stormFog: C(THREE, '#3a4248'), hazeFog: C(THREE, '#c8d2da'),
  };
  // Himmel
  const tl = new THREE.TextureLoader();
  const disc = (n) => { const t = tl.load(`../assets/textures/sky_${n}.webp`); t.colorSpace = THREE.SRGBColorSpace; return t; };
  const U = {
    zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, groundCol: { value: C(THREE, '#6b8090') },
    sunColor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, moonDir: { value: new THREE.Vector3(0, -1, 0) }, moonColor: { value: pal.moon },
    stormZenith: { value: pal.stormZenith }, stormHorizon: { value: pal.stormHorizon }, stormCloud: { value: pal.stormCloud }, lightningColor: { value: C(THREE, '#c0ccff') },
    sunStrength: { value: 1 }, moonStrength: { value: 0 }, cloudCover: { value: 0.3 }, cloudType: { value: 0.8 }, storm: { value: 0 }, uTime: { value: 0 }, flash: { value: 0 }, sunVis: { value: 1 },
    cloudDrift: { value: new THREE.Vector2() }, cloudVolume: { value: cloudTexture(THREE) }, tSun: { value: disc('sun') }, tMoon: { value: disc('moon') },
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: U, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  }));
  sky.frustumCulled = false; sky.renderOrder = -10;
  scene.add(sky);
  if (W.skyMesh) scene.remove(W.skyMesh); // den enkla gradienten i world.js ersätts

  const rain = precipitation(THREE, { count: 2600, box: [44, 26], snow: false });
  const snow = precipitation(THREE, { count: 3500, box: [36, 20], snow: true });
  scene.add(rain.obj, snow.obj);

  // Snö på uppåtvända ytor: delad uniform som materialen läser (materials.js, ground.js, grass.js)
  W.snow = W.snow ?? { value: 0 };
  const drift = new THREE.Vector2();
  let flashT = 0, nextFlash = 2;
  const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), tmp = new THREE.Color();
  const lerpColor = (out, a, b, t) => out.copy(a).lerp(b, t);
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const base = { sun: W.sun.intensity, hemi: W.hemi?.intensity ?? 1.1, exposure: renderer.toneMappingExposure };

  function sunDirection(h) {
    const ha = ((h - 12) / 12) * Math.PI, noon = (noonElevation * Math.PI) / 180;
    return sunDir.set(Math.sin(ha), Math.cos(ha) * Math.sin(noon), Math.cos(ha) * Math.cos(noon)).normalize();
  }
  function update(dt) {
    // Tid och väder glider
    if (state.auto) state.time = (state.time + (dt * 24) / (state.dayMinutes * 60)) % 24;
    const k = 1 - Math.exp(-dt / 2.5);
    for (const key of Object.keys(target)) state[key] += (target[key] - state[key]) * k;
    const s = sunDirection(state.time), day = smooth(-0.1, 0.12, s.y), night = 1 - day;
    moonDir.copy(s).multiplyScalar(-1);
    const low = 1 - smooth(0.05, 0.45, s.y), storm = state.storm;
    const sunVis = Math.min(1, Math.max(0.05, 1 - 0.85 * state.clouds - 0.3 * state.rain));
    const lightFactor = 1 - 0.55 * state.clouds - 0.1 * state.rain;
    // Himlens färger: dag/natt, solnedgång och storm
    lerpColor(U.zenith.value, pal.zenith, pal.nightZenith, night);
    lerpColor(U.horizon.value, pal.horizon, pal.nightHorizon, night).lerp(pal.sunset, low * 0.35 * day);
    lerpColor(U.sunColor.value, pal.sun, pal.sunset, low * 0.7);
    U.sunDir.value.copy(s); U.moonDir.value.copy(moonDir);
    U.sunStrength.value = day; U.moonStrength.value = night; U.sunVis.value = sunVis;
    U.cloudCover.value = state.clouds; U.cloudType.value = state.cloudKind; U.storm.value = storm;
    U.uTime.value += dt;
    const wd = W.grassUniforms?.uWindDir?.value ?? new THREE.Vector2(0.8, 0.6);
    drift.addScaledVector(wd, (0.002 + 0.018 * state.wind) * dt); U.cloudDrift.value.copy(drift);
    // Blixtar i storm: korta blinkningar som lyser upp molnen och marken
    nextFlash -= dt;
    if (storm > 0.5 && nextFlash < 0) { flashT = 0.35; nextFlash = 2 + Math.random() * 7; }
    flashT = Math.max(0, flashT - dt);
    const flash = flashT > 0 ? (Math.sin(flashT * 60) > 0 ? 1 : 0.3) * storm : 0;
    U.flash.value = flash;
    // Ljuset: solen på dagen, månen (samma skuggande ljus, svagare och kallt) på natten
    W.setSunDir(s.y > -0.05 ? s : moonDir);
    tmp.copy(U.sunColor.value).lerp(pal.stormSun, storm);
    if (s.y <= -0.05) tmp.copy(pal.moon);
    W.sun.color.copy(tmp);
    W.sun.intensity = (s.y > -0.05 ? base.sun * day : base.sun * 0.12 * night) * Math.max(0.15, lightFactor) * (1 - storm * 0.6);
    if (W.hemi) {
      lerpColor(W.hemi.color, pal.hemiSky, pal.nightHemi, night).lerp(pal.stormHemi, storm).lerp(pal.sunset, low * 0.15 * day);
      W.hemi.intensity = base.hemi * (0.35 + 0.65 * day) * (1 - 0.15 * state.clouds) + flash * 2.5;
    }
    // Dimma (färg och sikt) och himlens horisont följer varandra
    if (scene.fog) {
      lerpColor(scene.fog.color, pal.fog, pal.nightFog, night).lerp(pal.sunset, low * 0.2 * day).lerp(pal.stormFog, storm * 0.8).lerp(pal.hazeFog, state.haze * 0.5 * day);
      W.fogBase ??= { near: scene.fog.near, far: scene.fog.far };
      const thick = 1 - 0.55 * state.haze - 0.25 * state.rain - 0.2 * state.snow;
      scene.fog.near = W.fogBase.near * thick; scene.fog.far = W.fogBase.far * Math.max(0.35, thick);
      U.horizon.value.lerp(scene.fog.color, 0.5);
    }
    renderer.toneMappingExposure = base.exposure * (0.75 + 0.25 * day);
    // Färgton: lite mättnad på dagen, gråare i storm, dämpat på natten
    const sat = (1.08 - 0.38 * storm - 0.15 * night).toFixed(3), con = (1.02 + 0.06 * storm).toFixed(3);
    renderer.domElement.style.filter = `saturate(${sat}) contrast(${con})`;
    // Vind, regn och snö
    W.wind.uWind.value = 0.25 + state.wind * 1.4;
    const cam = camera.position, wv = wd.clone().multiplyScalar(state.wind * 3);
    for (const p of [rain, snow]) { p.uniforms.uCam.value.copy(cam); p.uniforms.uTime.value += dt; p.uniforms.uWind.value.copy(wv); }
    rain.uniforms.uAmount.value = state.rain; snow.uniforms.uAmount.value = state.snow;
    rain.obj.visible = state.rain > 0.01; snow.obj.visible = state.snow > 0.01;
    W.snow.value = Math.min(1, state.snow * 1.1);
    sky.position.copy(cam);
    sky.scale.setScalar(camera.far * 0.9);
  }
  W.onFrame(update);
  const atmo = {
    state, target, sky,
    setTime: (h) => { state.time = ((h % 24) + 24) % 24; },
    setWeather: (name, now = false) => { Object.assign(target, WEATHER[name]); state.weather = name; if (now) Object.assign(state, WEATHER[name]); },
    sunDirection: () => sunDir.clone(),
  };
  return atmo;
}
