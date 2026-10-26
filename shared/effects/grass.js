// Tätt gräs i stil med Ghost of Tsushima och Genshin Impact (docs/effektlabb.md), i TSL så att studion, visningen
// och Tinkertown kan dela det. Bygger vidare på Parkens gräsfält (showcase/grass.js): strån i tuvor, rotfärg som
// marken, normaler som skuggar fältet som en yta och byar som ljusar upp stråken. Nytt här:
// - mycket tätare (hundratals strån per m² nära kameran), i rutor med två detaljnivåer; glesare och bredare på avstånd
// - böjda strån: mittlinjen är en båge med konstant krökning, så att strået behåller sin längd hur det än böjs
// - tuvor (klumpar) där stråna lutar ut från mitten och delar höjd och färgton
// - rundade normaler (strået är lite kupat) som lutar mot uppåt, genomlysning i motljus och en glans i byarna
// - vinden från shared/effects/wind.js: stråna böjs med samma byar, svängning och styrka som träden
//
//   const grass = createGrass(wind, { radius: 30, exclude: [{ x, z, r }] });
//   scene.add(grass.group); varje bild: grass.update(camera)
import { InstancedBufferGeometry, InstancedBufferAttribute, Float32BufferAttribute, Mesh, Group, Sphere, Vector3, Color, DoubleSide, MeshLambertNodeMaterial } from 'three/webgpu';
import {
  attribute, positionGeometry, uniform, vec3, float, cos, sin, max, pow, mix, smoothstep, normalize, cross, dot, length,
  varying, transformNormalToView, positionWorld, cameraPosition,
} from 'three/tsl';

export const GRASS_DEFAULTS = {
  radius: 30, inner: 13, density: [260, 70], height: [0.22, 0.46], width: 0.035, chunk: 5, seed: 11,
  lod: [12, 30], colors: { base: '#1c3a0e', mid: '#3a7a1a', tip: '#8cc63a', dry: '#c8bd55' },
};

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash2 = (x, z) => { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); };
// Mjukt brus för fläckar i höjd och färg
const patch = (x, z) => 0.5 + 0.28 * Math.sin(x * 0.23 + Math.sin(z * 0.19) * 2.1) + 0.22 * Math.sin(z * 0.31 - x * 0.17 + 0.7);

// Ett strå: rader med två hörn (x = -0.5 och 0.5) och en spets; y = andel av längden. Formen görs i shadern.
function bladeGeometry(rows) {
  const pos = [], idx = [];
  for (let i = 0; i < rows; i++) { const t = i / rows; pos.push(-0.5, t, 0, 0.5, t, 0); }
  pos.push(0, 1, 0);
  for (let i = 0; i < rows - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  idx.push((rows - 1) * 2, (rows - 1) * 2 + 1, rows * 2);
  return { pos, idx };
}

export function createGrass(wind, opts = {}) {
  const o = { ...GRASS_DEFAULTS, ...opts, colors: { ...GRASS_DEFAULTS.colors, ...(opts.colors ?? {}) } };
  const r = rng(o.seed);
  const u = {
    height: uniform(1), stiffness: uniform(1), density: uniform(1), sun: uniform(new Vector3(0.5, 0.7, 0.4).normalize()),
    lodNear: uniform(o.lod[0]), lodFar: uniform(o.lod[1]),
    base: uniform(new Color(o.colors.base)), mid: uniform(new Color(o.colors.mid)), tip: uniform(new Color(o.colors.tip)), dry: uniform(new Color(o.colors.dry)),
  };

  // --- Stråna, på processorn: tuvor på ett skakat rutnät, glesare utanför den inre ringen, inte i det som är uteslutet ---
  const CLUMP = 0.7;
  const clumpAt = (x, z) => {
    const cx = Math.floor(x / CLUMP), cz = Math.floor(z / CLUMP);
    let best = null;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const gx = cx + i, gz = cz + j, h = hash2(gx, gz);
      const px = (gx + 0.2 + 0.6 * h) * CLUMP, pz = (gz + 0.2 + 0.6 * hash2(gz + 7, gx - 3)) * CLUMP;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (!best || d < best.d) best = { d, px, pz, h };
    }
    return best;
  };
  // exclude: { x, z, r, h }: inget gräs inom r, eller (h < 1) kortare gräs, så att blommor och småväxter syns
  const excluded = (x, z) => (o.exclude ?? []).some((e) => !(e.h > 0) && (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);
  const shorter = (x, z) => (o.exclude ?? []).reduce((m, e) => {
    if (!(e.h > 0)) return m;
    const d = Math.sqrt((x - e.x) ** 2 + (z - e.z) ** 2) / e.r;
    return d < 1 ? Math.min(m, e.h + (1 - e.h) * d * d) : m;
  }, 1);
  const n = Math.ceil((2 * o.radius) / o.chunk);
  const chunks = [];
  let total = 0;
  for (let ci = 0; ci < n; ci++) for (let cj = 0; cj < n; cj++) {
    const x0 = -o.radius + ci * o.chunk, z0 = -o.radius + cj * o.chunk;
    const cx = x0 + o.chunk / 2, cz = z0 + o.chunk / 2, cd = Math.hypot(cx, cz);
    if (cd > o.radius + o.chunk) continue;
    const dens = cd < o.inner ? o.density[0] : o.density[0] + (o.density[1] - o.density[0]) * Math.min(1, (cd - o.inner) / (o.radius - o.inner));
    const count = Math.round(dens * o.chunk * o.chunk);
    const P = [], S = [], V = [];
    for (let k = 0; k < count; k++) {
      const x = x0 + r() * o.chunk, z = z0 + r() * o.chunk, d = Math.hypot(x, z);
      if (d > o.radius * (0.92 + 0.08 * hash2(x, z)) || excluded(x, z)) continue;
      const c = clumpAt(x, z);
      const out = Math.atan2(z - c.pz, x - c.px);
      const yaw = Number.isFinite(out) ? out + (r() - 0.5) * 1.1 : r() * Math.PI * 2;
      const p = patch(x, z);
      const h = (o.height[0] + (o.height[1] - o.height[0]) * (0.35 * c.h + 0.65 * p)) * (0.78 + r() * 0.4) * shorter(x, z);
      P.push(x, 0, z, yaw);
      S.push(h, o.width * (0.75 + r() * 0.5), 0.25 + r() * 0.65 + Math.sqrt(c.d) * 0.6, 0.7 + r() * 0.6);
      V.push(Math.min(1, Math.max(0, p * 0.8 + (c.h - 0.5) * 0.5 + (r() - 0.5) * 0.15)), c.h, r() * Math.PI * 2, r());
    }
    if (!P.length) continue;
    chunks.push({ c: new Vector3(cx, 0, cz), P, S, V, n: P.length / 4 });
    total += P.length / 4;
  }

  // --- Shadern ---
  const W = () => vec3(cos(wind.uniforms.dir), 0, sin(wind.uniforms.dir));
  const iPos = attribute('iPos', 'vec4'), iShape = attribute('iShape', 'vec4'), iVar = attribute('iVar', 'vec4');
  const x = positionGeometry.x, t = positionGeometry.y;
  const root = iPos.xyz, yaw = iPos.w;
  const facing = vec3(cos(yaw), 0, sin(yaw)), side = vec3(sin(yaw).negate(), 0, cos(yaw));
  const dist = length(root.xz.sub(cameraPosition.xz));
  const far = smoothstep(u.lodNear, u.lodFar, dist);
  // Vinden: kraften vid roten (byarna) och en svängning med stråets egen fas; mjuka strån böjer mer
  const S = wind.uniforms.strength;
  const osc = sin(wind.uniforms.time.mul(float(2.1).add(iVar.w.mul(1.6))).add(iVar.z)).add(sin(wind.uniforms.time.mul(5.3).add(iVar.z.mul(3.1))).mul(0.3));
  const windA = wind.force(root.xz).mul(1.25).add(S.mul(wind.uniforms.sway).mul(osc).mul(0.35)).div(iShape.w.mul(u.stiffness));
  // Lutningen: stråets egen böj ut från tuvan plus vinden; bågen har vinkeln theta i spetsen
  const lean = facing.mul(iShape.z).add(W().mul(windA));
  const theta = max(length(lean), 0.001), L = lean.div(theta);
  const h = iShape.x.mul(u.height);
  const a = theta.mul(t);
  // Mittlinjen: en båge med konstant krökning, längden h * t
  const center = L.mul(float(1).sub(cos(a))).add(vec3(0, 1, 0).mul(sin(a))).mul(h.div(theta));
  const tangent = L.mul(sin(a)).add(vec3(0, 1, 0).mul(cos(a)));
  // Bredare och färre på avstånd (rutorna ritar färre strån där), spetsigt mot toppen
  const width = iShape.y.mul(mix(1, 2.2, far)).mul(float(1).sub(pow(t, 1.8)));
  const pos = root.add(center).add(side.mul(x).mul(width));
  // Normalen: ytans normal, kupad över bredden och lutad mot uppåt så att fältet skuggas som en sammanhängande yta
  const face = normalize(cross(side, tangent));
  const nrm = normalize(face.add(side.mul(x).mul(1.4)).add(vec3(0, 1, 0).mul(0.9)));
  const vN = varying(transformNormalToView(nrm));
  const vT = varying(t), vVar = varying(iVar.xy), vGust = varying(wind.gust(root.xz).mul(S).mul(t)), vFar = varying(far);

  const mat = new MeshLambertNodeMaterial({ side: DoubleSide });
  mat.positionNode = pos;
  mat.normalNode = normalize(vN);
  // Färgen: mörk bas (som marken), mellanton och ljus topp; torrare ton i fläckar, tuvorna lite olika ljusa
  const tipCol = mix(u.tip, u.dry, smoothstep(0.7, 1.0, vVar.x).mul(0.45));
  const body = mix(u.base, u.mid, smoothstep(0.0, 0.45, vT));
  let col = mix(body, tipCol, smoothstep(0.35, 1.0, vT));
  col = col.mul(float(0.78).add(vVar.y.mul(0.32))).mul(mix(0.45, 1.0, smoothstep(0.0, 0.55, vT)));
  // Stora fläckar: mörkare och blågrönare där fältet är lågt, varmare och gulare där det är högt
  col = col.mul(mix(vec3(0.8, 0.92, 0.88), vec3(1.1, 1.05, 0.86), vVar.x));
  // Glansen i byarna: stråna som böjs visar sin ljusare sida, som de svepande vågorna i Tsushima
  col = col.add(vec3(0.24, 0.27, 0.1).mul(vGust)).mul(mix(1.0, 0.92, vFar));
  mat.colorNode = col;
  // Genomlysning: ljust och varmt i topparna när man ser mot solen
  const view = normalize(positionWorld.sub(cameraPosition));
  const back = pow(max(dot(view, u.sun), 0), 5);
  mat.emissiveNode = tipCol.mul(back.mul(0.55).add(0.04)).mul(smoothstep(0.3, 1.0, vT));

  // --- Rutorna: två detaljnivåer som delar strånas attribut; andelen strån följer avståndet ---
  const hi = bladeGeometry(6), lo = bladeGeometry(3);
  const group = new Group();
  for (const ch of chunks) {
    const attrs = { iPos: new InstancedBufferAttribute(new Float32Array(ch.P), 4), iShape: new InstancedBufferAttribute(new Float32Array(ch.S), 4), iVar: new InstancedBufferAttribute(new Float32Array(ch.V), 4) };
    const make = (g) => {
      const geo = new InstancedBufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(g.pos, 3));
      geo.setIndex(g.idx);
      for (const [k, v] of Object.entries(attrs)) geo.setAttribute(k, v);
      geo.instanceCount = ch.n;
      geo.boundingSphere = new Sphere(ch.c.clone().setY(0.3), o.chunk * 0.75 + 1);
      const m = new Mesh(geo, mat);
      m.receiveShadow = true; m.castShadow = false;
      group.add(m);
      return m;
    };
    ch.hi = make(hi); ch.lo = make(lo);
  }
  const tmp = new Vector3();
  return {
    group, uniforms: u, blades: total,
    // Varje bild: närmaste rutorna med den fina geometrin, glesare längre bort
    update(camera) {
      for (const ch of chunks) {
        const d = tmp.copy(ch.c).sub(camera.position).setY(0).length();
        const near = d < o.lod[0];
        const keep = (near ? 1 : Math.max(0.28, 1 - (d - o.lod[0]) / (o.lod[1] - o.lod[0]) * 0.72)) * u.density.value;
        ch.hi.visible = near; ch.lo.visible = !near;
        (near ? ch.hi : ch.lo).geometry.instanceCount = Math.max(1, Math.floor(ch.n * Math.min(1, keep)));
      }
    },
    visibleBlades() { return chunks.reduce((s, ch) => s + (ch.hi.visible ? ch.hi : ch.lo).geometry.instanceCount, 0); },
  };
}
