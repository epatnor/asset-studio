// Tätt gräs i stil med Ghost of Tsushima och Genshin Impact (docs/effektlabb.md), i TSL så att studion, visningen
// och Tinkertown kan dela det. Bygger vidare på Parkens gräsfält (showcase/grass.js): strån i tuvor, rotfärg som
// marken, normaler som skuggar fältet som en yta och byar som ljusar upp stråken. Nytt här:
// - mycket tätare (hundratals strån per m² nära kameran), i rutor med två detaljnivåer; glesare och bredare på avstånd
// - böjda strån: mittlinjen är en båge med konstant krökning, så att strået behåller sin längd hur det än böjs
// - tuvor (klumpar) där stråna lutar ut från mitten och delar höjd och färgton
// - rundade normaler (strået är lite kupat) som lutar mot uppåt, genomlysning i motljus
// - vinden från shared/effects/wind.js (samma byar, svängning och styrka som träden), plus gräsets egna vågor: band
//   som rullar över fältet med vinden, böjer stråna och glänser, med egen storlek, fart, skärpa och uppbrytning
//
// Gräset är ett recept (tools/grass/grass.json): färger, toning, form, längd och vågor är uniforms och ändras direkt
// med set({...}); bara tuvornas storlek och de fria ytorna (exclude) bygger om stråna.
//
//   const grass = createGrass(wind, { radius: 30, exclude: [{ x, z, r }] }, settings);
//   scene.add(grass.group); varje bild: grass.update(camera)
import { InstancedBufferGeometry, InstancedBufferAttribute, Float32BufferAttribute, Mesh, Group, Sphere, Vector3, Color, DoubleSide, MeshLambertNodeMaterial } from 'three/webgpu';
import {
  attribute, positionGeometry, uniform, vec2, vec3, float, cos, sin, max, min, pow, mix, smoothstep, normalize, cross, dot, length,
  varying, transformNormalToView, positionWorld, cameraPosition, clamp, fract,
} from 'three/tsl';

const TAU = Math.PI * 2;
// Standardvärden för receptet (samma nycklar som spakarna i tools/grass/grass.json)
export const GRASS_SETTINGS = {
  base: '#1c3a0e', mid: '#3a7a1a', tip: '#8cc63a', dry: '#c8bd55',
  dryAmount: 0.25, patches: 1, patchSize: 6, clumpShade: 0.5, ao: 0.6, translucency: 1,
  heightMin: 0.17, heightMax: 0.38, width: 0.035, taper: 1.8, curve: 0.55, curveVar: 0.6, clumpLean: 1, stiffness: 1, density: 1,
  clumpSize: 0.7,
  waveBend: 0.45, waveSheen: 1, waveSize: 9, waveSpeed: 4, waveSharp: 3, waveBreakup: 0.6,
};
export const GRASS_FIELD = { radius: 30, inner: 13, counts: [280, 70], chunk: 5, seed: 11, lod: [12, 30] };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash2 = (x, z) => { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); };

// Ett strå: rader med två hörn (x = -0.5 och 0.5) och en spets; y = andel av längden. Formen görs i shadern.
function bladeGeometry(rows) {
  const pos = [], idx = [];
  for (let i = 0; i < rows; i++) { const t = i / rows; pos.push(-0.5, t, 0, 0.5, t, 0); }
  pos.push(0, 1, 0);
  for (let i = 0; i < rows - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  idx.push((rows - 1) * 2, (rows - 1) * 2 + 1, rows * 2);
  return { pos, idx };
}

export function createGrass(wind, field = {}, settings = {}) {
  const f = { ...GRASS_FIELD, ...field };
  const s0 = { ...GRASS_SETTINGS, ...settings };
  const u = Object.fromEntries(Object.entries(s0).map(([k, v]) => [k, uniform(typeof v === 'string' ? new Color(v) : v)]));
  Object.assign(u, { sun: uniform(new Vector3(0.5, 0.7, 0.4).normalize()), lodNear: uniform(f.lod[0]), lodFar: uniform(f.lod[1]) });
  let clumpSize = s0.clumpSize, exclude = f.exclude ?? [];

  // --- Stråna, på processorn: läge, riktning, tuva och slumptal; höjd, form och färg räknas i shadern ---
  function bladesFor() {
    const r = rng(f.seed), C = clumpSize;
    const clumpAt = (x, z) => {
      const cx = Math.floor(x / C), cz = Math.floor(z / C);
      let best = null;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const gx = cx + i, gz = cz + j, h = hash2(gx, gz);
        const px = (gx + h) * C, pz = (gz + hash2(gz + 7.31, gx - 3.17)) * C; // var som helst i cellen, så att inget rutnät syns
        const d = (px - x) ** 2 + (pz - z) ** 2;
        if (!best || d < best.d) best = { d, px, pz, h };
      }
      return best;
    };
    // exclude: { x, z, r, h }: inget gräs inom r, eller (h < 1) kortare gräs, så att blommor och småväxter syns
    const excluded = (x, z) => exclude.some((e) => !(e.h > 0) && (x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r);
    const shorter = (x, z) => exclude.reduce((m, e) => {
      if (!(e.h > 0)) return m;
      const d = Math.sqrt((x - e.x) ** 2 + (z - e.z) ** 2) / e.r;
      return d < 1 ? Math.min(m, e.h + (1 - e.h) * d * d) : m;
    }, 1);
    const n = Math.ceil((2 * f.radius) / f.chunk), out = [];
    for (let ci = 0; ci < n; ci++) for (let cj = 0; cj < n; cj++) {
      const x0 = -f.radius + ci * f.chunk, z0 = -f.radius + cj * f.chunk;
      const cx = x0 + f.chunk / 2, cz = z0 + f.chunk / 2, cd = Math.hypot(cx, cz);
      if (cd > f.radius + f.chunk) continue;
      // Tätheten följer varje strås avstånd från mitten (inte rutans), så att rutorna inte syns som trappsteg
      const densAt = (d) => (d < f.inner ? 1 : (f.counts[0] + (f.counts[1] - f.counts[0]) * Math.min(1, (d - f.inner) / (f.radius - f.inner))) / f.counts[0]);
      const P = [], S = [], V = [];
      for (let k = 0, count = Math.round(f.counts[0] * f.chunk * f.chunk); k < count; k++) {
        const x = x0 + r() * f.chunk, z = z0 + r() * f.chunk, d = Math.hypot(x, z);
        if (r() > densAt(d) || d > f.radius * (0.92 + 0.08 * hash2(x, z)) || excluded(x, z)) continue;
        const c = clumpAt(x, z);
        P.push(x, 0, z, Math.atan2(z - c.pz, x - c.px) + (r() - 0.5) * 1.1);
        S.push(r(), shorter(x, z), r(), r()); // höjdslump, kortare-faktor, breddslump, böjslump
        V.push(c.h, r(), r() * TAU, Math.sqrt(c.d)); // tuvans ton, styvhetsslump, fas, avstånd till tuvans mitt
      }
      // Ordningstal 0..1 i slumpad ordning: gallringen på avstånd tar bort stråna med högst tal först
      const n = P.length / 4, R = Float32Array.from({ length: n }, (_, i) => (i + 0.5) / n);
      if (n) out.push({ c: new Vector3(cx, 0, cz), P, S, V, R, n });
    }
    return out;
  }

  // --- Shadern ---
  const dir = wind.uniforms.dir, W = vec3(cos(dir), 0, sin(dir)), W2 = vec2(cos(dir), sin(dir)), side2 = vec2(sin(dir).negate(), cos(dir));
  const iPos = attribute('iPos', 'vec4'), iShape = attribute('iShape', 'vec4'), iVar = attribute('iVar', 'vec4');
  const x = positionGeometry.x, t = positionGeometry.y;
  const root = iPos.xyz, yaw = iPos.w;
  const facing = vec3(cos(yaw), 0, sin(yaw)), side = vec3(sin(yaw).negate(), 0, cos(yaw));
  const far = smoothstep(u.lodNear, u.lodFar, length(root.xz.sub(cameraPosition.xz)));
  // Fläckar i höjd och färg (mjukt brus, storleken i meter), tuvans ton och stråets egen slump
  const q = root.xz.mul(float(6).div(u.patchSize));
  const d1 = dot(q, vec2(0.21, 0.09)), d2 = dot(q, vec2(-0.08, 0.24)), d3 = dot(q, vec2(0.17, -0.19));
  const patchN = clamp(float(0.5).add(sin(d1.add(sin(d2.mul(1.3)).mul(1.6))).mul(0.24)).add(sin(d2.mul(1.1).add(0.7)).mul(0.17)).add(sin(d3.mul(1.7).add(2.1)).mul(0.12)), 0, 1);
  const clumpH = iVar.x;
  const pv = clamp(patchN.mul(0.8).add(clumpH.sub(0.5).mul(0.5)).add(fract(iVar.z.mul(7.13)).sub(0.5).mul(0.15)), 0, 1);
  // Gräsets vågor: band vinkelräta mot vinden som rullar med den (waveSize meter mellan banden, waveSpeed m/s),
  // skärpta med waveSharp och uppbrutna på tvären med waveBreakup, plus ett svagare, snabbare band ovanpå
  const S = wind.uniforms.strength, time = wind.uniforms.time;
  const along = dot(root.xz, W2), across = dot(root.xz, side2);
  const ph = along.sub(time.mul(u.waveSpeed)).div(u.waveSize).mul(TAU)
    .add(sin(across.div(u.waveSize.mul(1.9)).mul(TAU)).mul(u.waveBreakup.mul(2.2)))
    .add(sin(across.div(u.waveSize.mul(0.7)).mul(TAU).add(time.mul(0.4))).mul(u.waveBreakup.mul(0.8)));
  const w1 = pow(float(0.5).add(sin(ph).mul(0.5)), u.waveSharp);
  const w2 = pow(float(0.5).add(sin(ph.mul(1.73).add(1.3).add(across.div(u.waveSize).mul(2.1))).mul(0.5)), u.waveSharp).mul(0.45);
  const wave = max(w1, w2).mul(smoothstep(0.0, 0.25, S).mul(0.7).add(S.mul(0.5))); // syns redan i en bris, starkare i blåst
  // Vinden: kraften vid roten (byarna), en svängning med stråets egen fas och vågen; mjuka strån böjer mer
  const osc = sin(time.mul(float(2.1).add(iVar.y.mul(1.6))).add(iVar.z)).add(sin(time.mul(5.3).add(iVar.z.mul(3.1))).mul(0.3));
  const windA = wind.force(root.xz).mul(1.25).add(S.mul(wind.uniforms.sway).mul(osc).mul(0.35)).add(wave.mul(u.waveBend))
    .div(u.stiffness.mul(float(0.7).add(iVar.y.mul(0.6))));
  // Lutningen: stråets egen böj (med variation) ut från tuvan plus vinden; bågen har vinkeln theta i spetsen
  const ownBend = u.curve.mul(mix(1, float(0.3).add(iShape.w.mul(1.4)), u.curveVar)).add(u.clumpLean.mul(iVar.w).mul(1.5));
  const lean = facing.mul(ownBend).add(W.mul(windA));
  const theta = max(length(lean), 0.001), L = lean.div(theta);
  // Gallring på avstånd, per strå (inte per ruta): strån vars ordningstal ligger över andelen som ska synas krymper bort
  const distC = length(root.xz.sub(cameraPosition.xz));
  const keep = min(max(float(0.28), float(1).sub(distC.sub(u.lodNear).div(u.lodFar.sub(u.lodNear)).mul(0.72))), 1).mul(u.density);
  const thin = float(1).sub(smoothstep(keep.sub(0.06), keep, attribute('iRank', 'float')));
  const h = mix(u.heightMin, u.heightMax, clumpH.mul(0.35).add(patchN.mul(0.65))).mul(float(0.78).add(iShape.x.mul(0.4))).mul(iShape.y).mul(thin);
  const a = theta.mul(t);
  // Mittlinjen: en båge med konstant krökning, längden h * t
  const center = L.mul(float(1).sub(cos(a))).add(vec3(0, 1, 0).mul(sin(a))).mul(h.div(theta));
  const tangent = L.mul(sin(a)).add(vec3(0, 1, 0).mul(cos(a)));
  // Bredare och färre på avstånd (rutorna ritar färre strån där); taper styr hur spetsigt strået är
  const width = u.width.mul(float(0.75).add(iShape.z.mul(0.5))).mul(mix(1, 2.2, far)).mul(float(1).sub(pow(t, u.taper)));
  // Normalen: ytans normal, kupad över bredden och lutad mot uppåt så att fältet skuggas som en sammanhängande yta
  const face = normalize(cross(side, tangent));
  const nrm = normalize(face.add(side.mul(x).mul(1.4)).add(vec3(0, 1, 0).mul(0.9)));
  const vN = varying(transformNormalToView(nrm));
  const vT = varying(t), vPv = varying(pv), vPatch = varying(patchN), vClump = varying(clumpH), vFar = varying(far);
  // Glansen: där vågen och byarna går visar stråna sin ljusare sida
  const vShine = varying(max(wave, wind.gust(root.xz).mul(S)).mul(t));

  const mat = new MeshLambertNodeMaterial({ side: DoubleSide });
  mat.positionNode = root.add(center).add(side.mul(x).mul(width));
  mat.normalNode = normalize(vN);
  // Färgen: mörk bas, mellanton och ljus topp; torra fläckar (dryAmount) drar topparna mot den torra färgen
  const dryMask = smoothstep(float(0.95).sub(u.dryAmount.mul(0.9)), float(1.2).sub(u.dryAmount.mul(0.9)), vPv);
  const tipCol = mix(u.tip, u.dry, dryMask);
  const body = mix(u.base, mix(u.mid, u.dry.mul(0.7), dryMask.mul(0.4)), smoothstep(0.0, 0.45, vT));
  let col = mix(body, tipCol, smoothstep(0.35, 1.0, vT));
  col = col.mul(mix(1, float(0.75).add(vClump.mul(0.5)), u.clumpShade)); // tuvorna lite olika ljusa
  col = col.mul(mix(float(1).sub(u.ao.mul(0.6)), 1.0, smoothstep(0.0, 0.55, vT))); // mörkare vid roten
  // Stora fläckar: mörkare och blågrönare där fältet är lågt, varmare och gulare där det är högt
  col = col.mul(mix(vec3(1), mix(vec3(0.8, 0.92, 0.88), vec3(1.1, 1.05, 0.86), vPatch), u.patches));
  col = col.add(mix(vec3(0.24, 0.27, 0.1), tipCol.mul(0.35), 0.5).mul(vShine).mul(u.waveSheen)).mul(mix(1.0, 0.92, vFar));
  mat.colorNode = col;
  // Genomlysning: ljust och varmt i topparna när man ser mot solen
  const back = pow(max(dot(normalize(positionWorld.sub(cameraPosition)), u.sun), 0), 5);
  mat.emissiveNode = tipCol.mul(back.mul(0.55).mul(u.translucency).add(0.04)).mul(smoothstep(0.3, 1.0, vT));

  // --- Rutorna: två detaljnivåer som delar strånas attribut; andelen strån följer avståndet ---
  const hi = bladeGeometry(6), lo = bladeGeometry(3);
  const group = new Group();
  let chunks = [], total = 0;
  function build() {
    for (const ch of chunks) for (const m of [ch.hi, ch.lo]) { m.geometry.dispose(); group.remove(m); }
    chunks = bladesFor();
    total = 0;
    for (const ch of chunks) {
      const attrs = { iPos: new InstancedBufferAttribute(new Float32Array(ch.P), 4), iShape: new InstancedBufferAttribute(new Float32Array(ch.S), 4),
        iVar: new InstancedBufferAttribute(new Float32Array(ch.V), 4), iRank: new InstancedBufferAttribute(ch.R, 1) };
      const make = (g) => {
        const geo = new InstancedBufferGeometry();
        geo.setAttribute('position', new Float32BufferAttribute(g.pos, 3));
        geo.setIndex(g.idx);
        for (const [k, v] of Object.entries(attrs)) geo.setAttribute(k, v);
        geo.instanceCount = ch.n;
        geo.boundingSphere = new Sphere(ch.c.clone().setY(0.4), f.chunk * 0.75 + 1.5);
        const m = new Mesh(geo, mat);
        m.receiveShadow = true; m.castShadow = false;
        group.add(m);
        return m;
      };
      ch.hi = make(hi); ch.lo = make(lo);
      total += ch.n;
    }
  }
  build();
  const tmp = new Vector3();
  return {
    group, uniforms: u,
    get blades() { return total; },
    // Receptets värden: färger som '#rrggbb', resten som tal. clumpSize bygger om stråna.
    set(values) {
      for (const [k, v] of Object.entries(values)) {
        if (k === 'clumpSize') { if (v !== clumpSize) { clumpSize = v; build(); } continue; }
        if (!u[k]) continue;
        if (u[k].value?.isColor) u[k].value.set(v); else u[k].value = v;
      }
    },
    // Nya fria ytor (till exempel runt utslumpade blommor): stråna byggs om
    setExclude(list) { exclude = list; build(); },
    // Varje bild: närmaste rutorna med den fina geometrin, glesare längre bort
    update(camera) {
      for (const ch of chunks) {
        const d = tmp.copy(ch.c).sub(camera.position).setY(0).length();
        const near = d < f.lod[0], dMin = Math.max(0, d - f.chunk * 0.71); // rutans närmaste hörn
        const keep = Math.min(1, Math.max(0.28, 1 - ((dMin - f.lod[0]) / (f.lod[1] - f.lod[0])) * 0.72)) * u.density.value;
        ch.hi.visible = near; ch.lo.visible = !near;
        (near ? ch.hi : ch.lo).geometry.instanceCount = Math.max(1, Math.ceil(ch.n * Math.min(1, keep + 0.02)));
      }
    },
    visibleBlades() { return chunks.reduce((s, ch) => s + (ch.hi.visible ? ch.hi : ch.lo).geometry.instanceCount, 0); },
  };
}
