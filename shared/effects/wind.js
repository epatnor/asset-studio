// Vindmodulen (docs/effektlabb.md): vindfältet och deformationen för vindriggen, i TSL, så att samma kod körs i
// studions Väderkvarn, i visningen och i Tinkertown (WebGPU, med WebGL2 som reserv). Formlerna är desamma som i
// tools/wind/rig.mjs (deformPoint), som generatorernas kontroller räknar med.
//
//   const wind = createWind();                 // ett vindfält; set({ strength, dir, ... }) och update(dt) varje bild
//   mat.positionNode = wind.rigged(table);      // en riggad modell (extras.wind i glTF, userData.wind i three.js)
//   mat.positionNode = wind.blades();           // gräsplätt med attributen groot, gt och gblade (se blades())
//   mat.positionNode = wind.flag(L, H);         // flagga längs +x från stången
//
// Vindfältet: riktning och styrka, byar som rullande vågor över marken (våglängd och fart), en svängning per del med
// egen takt (sway) och fladder i löven. Kraften går med styrkan i kvadrat, som luftmotstånd.
import { DataTexture, RGBAFormat, FloatType, NearestFilter } from 'three/webgpu';
import {
  Fn, uniform, attribute, float, int, vec3, vec4, ivec2, textureLoad, Loop, If, Break, positionLocal, normalGeometry,
  modelWorldMatrix, modelWorldMatrixInverse, cameraPosition, cross, normalize, dot, length, sin, cos, clamp, mix, max, pow,
  select, round, sign, smoothstep, fract, transformNormalToView, faceDirection,
} from 'three/tsl';

export const WIND_DEFAULTS = { strength: 0.5, dir: 0, gust: 0.5, gustScale: 18, gustSpeed: 6, sway: 0.35, flutter: 0.5, separation: 1, timeScale: 1 };
// Hur olika slags föremål svarar på vindstyrkan S (0–1,5): kraften går som S^(2 + separation * force) och svängningen
// som S^(1 + separation * sway). Tunga träd står nästan still i en bris och vaknar först i blåst; gräs och blommor
// rör sig redan i en svag bris. Vid S = 1 ger alla samma kraft, så riggens kontroller (full storm) gäller oförändrat.
export const RESPONSE = {
  tree: { force: 0.4, sway: 0.8 },
  bush: { force: 0.1, sway: 0.3 },
  plant: { force: -0.6, sway: -0.2 },
  grass: { force: -0.9, sway: -0.3 },
};
export const MAX_DEPTH = 6, STRIDE = 12, GROUND_BLEND = 0.15;
const TAU = Math.PI * 2;

// Riggtabellen (extras.wind) som en liten flyttalstextur: en kolumn per del, tre rader
//   rad 0: fäste xyz, förälder   rad 1: riktning xyz, tAttach   rad 2: amp, takt, fas, längd
export function rigTexture(w) {
  const n = w.count, data = new Float32Array(n * 3 * 4);
  for (let i = 0; i < n; i++) for (let row = 0; row < 3; row++) for (let k = 0; k < 4; k++) data[(row * n + i) * 4 + k] = w.parts[i * STRIDE + row * 4 + k];
  const tex = new DataTexture(data, n, 3, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export function createWind(params = {}) {
  const state = { ...WIND_DEFAULTS, ...params, time: 0 };
  const u = {
    time: uniform(0), strength: uniform(state.strength), dir: uniform(state.dir), gust: uniform(state.gust),
    gustScale: uniform(state.gustScale), gustSpeed: uniform(state.gustSpeed), sway: uniform(state.sway), flutter: uniform(state.flutter),
    separation: uniform(state.separation),
  };
  const UP = vec3(0, 1, 0);
  const rotY = (v, a) => vec3(v.x.mul(cos(a)).sub(v.z.mul(sin(a))), v.y, v.x.mul(sin(a)).add(v.z.mul(cos(a))));
  const windW = () => vec3(cos(u.dir), 0, sin(u.dir)); // vindens riktning i världen (dit den blåser)

  // Byarna: band vinkelräta mot vinden som rullar med den, med vågiga fronter (samma som gustAt i rig.mjs)
  const gustAt = Fn(([xz]) => {
    const a = xz.x.mul(cos(u.dir)).add(xz.y.mul(sin(u.dir))).sub(u.time.mul(u.gustSpeed)).div(u.gustScale);
    const b = xz.x.mul(sin(u.dir).negate()).add(xz.y.mul(cos(u.dir))).div(u.gustScale.mul(1.7));
    const s = float(0.5).add(sin(a.mul(TAU).add(sin(b.mul(TAU)).mul(1.3))).mul(0.5 * 0.7)).add(sin(a.mul(5.3).add(b.mul(3.1))).mul(0.15));
    return pow(clamp(s, 0, 1), 1.5);
  });
  const forceAt = Fn(([xz]) => u.strength.mul(u.strength).mul(float(1).sub(u.gust).add(u.gust.mul(gustAt(xz)))));
  // Styrkan genom ett föremåls svarskurva (RESPONSE): exponenten 2 + separation * d (aldrig under 0,3)
  const strengthFor = (d) => pow(max(u.strength, 0), max(float(2).add(u.separation.mul(d)), 0.3));
  const swayFor = (d) => pow(max(u.strength, 0), max(float(1).add(u.separation.mul(d)), 0.3));
  const forceFor = (xz, d) => strengthFor(d).mul(float(1).sub(u.gust).add(u.gust.mul(gustAt(xz))));
  const bendShape = (t) => { const x = clamp(t, 0, 1); return x.mul(float(3).sub(x)).mul(0.5); };
  // Rodrigues: v roterad vinkeln a runt enhetsaxeln k
  const rotate = (v, k, a) => {
    const c = cos(a), s = sin(a);
    return v.mul(c).add(cross(k, v).mul(s)).add(k.mul(dot(k, v).mul(float(1).sub(c))));
  };
  // Axeln en del böjs runt (bendAxis i rig.mjs)
  const bendAxis = (d, W) => {
    const n = cross(d, W), s = length(n), m = cross(UP, W);
    const sg = select(dot(n, m).greaterThanEqual(0), float(1), float(-1));
    return normalize(n.add(m.mul(float(1).sub(s).mul(sg))));
  };

  /**
   * Position för en riggad modell. tex = rigTexture(userData.wind).
   * response: 'tree', 'bush' eller 'plant' (RESPONSE), hur föremålet svarar på svag och stark vind,
   * flutter: löven fladdrar lite (efter _WIND och _CLUSTER-fasen), stem: platta stjälkar (_STEM) vrids mot kameran,
   * place: många exemplar i en ritning (InstancedBufferGeometry med attributet iPlace = x, z, vridning, skala). Riggen
   * räknas då i modellens eget rum och placeras sist; byarna läses där exemplaret står. Använd placedNormal() som
   * materialets normal, så att ljuset följer vridningen.
   */
  function rigged(tex, { flutter = false, stem = false, place = false, response = 'tree' } = {}) {
    const pl = place ? attribute('iPlace', 'vec4') : null;
    const R = RESPONSE[response] ?? RESPONSE.tree;
    // Modellens rum -> världen: vrid runt y, skala, flytta (utan place: modellens matris)
    const toWorld = (p) => (pl ? rotY(p.mul(pl.w), pl.z).add(vec3(pl.x, 0, pl.y)) : modelWorldMatrix.mul(vec4(p, 1)).xyz);
    const dirToLocal = (d) => (pl ? rotY(d, pl.z.negate()) : modelWorldMatrixInverse.mul(vec4(d, 0)).xyz);
    return Fn(() => {
      const rest = positionLocal.toVar();
      if (stem) {
        // Platt stjälk: vrid bandet runt mittlinjen mot kameran (som showcase/materials.js gör i GLSL)
        const st = attribute('_stem', 'vec3');
        If(dot(st, st).greaterThan(0), () => {
          const c = rest.sub(st);
          const camL = pl ? rotY(cameraPosition.sub(vec3(pl.x, 0, pl.y)), pl.z.negate()).div(pl.w) : modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
          const side = normalize(cross(UP, camL.sub(c))), perp = cross(side, UP);
          rest.assign(c.add(side.mul(length(st)).mul(sign(dot(st, side).mul(1000).add(dot(st, perp))))));
        });
      }
      const pos = vec3(rest).toVar();
      const cur = int(round(attribute('_part', 'float'))).toVar();
      const t = attribute('_pt', 'float').toVar();
      const W = normalize(dirToLocal(windW())).toVar();
      Loop(MAX_DEPTH, () => {
        If(cur.lessThan(0), () => { Break(); });
        const r0 = textureLoad(tex, ivec2(cur, int(0))), r1 = textureLoad(tex, ivec2(cur, int(1))), r2 = textureLoad(tex, ivec2(cur, int(2)));
        const pivot = r0.xyz, pw = toWorld(pivot);
        const osc = sin(u.time.mul(r2.y).mul(TAU).add(r2.z));
        const a = r2.x.mul(forceFor(pw.xz, R.force).add(u.sway.mul(swayFor(R.sway)).mul(osc))).mul(bendShape(t));
        pos.assign(pivot.add(rotate(pos.sub(pivot), bendAxis(r1.xyz, W), a)));
        t.assign(r1.w);
        cur.assign(int(round(r0.w)));
      });
      if (flutter) {
        // Fladder: små, snabba rörelser längs ytans normal, starkast ytterst (_WIND), med fas efter läget
        const w = attribute('_wind', 'float');
        const ph = dot(rest, vec3(3.1, 1.7, 2.3)).add(fract(attribute('_part', 'float').mul(0.618)).mul(TAU));
        const f = sin(u.time.mul(9.0).add(ph)).add(sin(u.time.mul(14.3).add(ph.mul(1.7))).mul(0.5));
        pos.addAssign(normalGeometry.mul(f.mul(w).mul(u.flutter).mul(u.strength).mul(0.035)));
      }
      // Det som rör marken står still
      const out = mix(rest, pos, clamp(rest.y.div(GROUND_BLEND), 0, 1));
      return pl ? toWorld(out) : out;
    })();
  }
  // Normalen för placerade exemplar (rigged med place): geometrins normal vriden som exemplaret, i kamerans rum
  const placedNormal = () => normalize(transformNormalToView(rotY(normalGeometry, attribute('iPlace', 'vec4').z)));

  /**
   * Gräs: varje strå har roten (groot, vec3 i modellens rum), höjden längs strået (gt, 0–1) och gblade
   * (vinkel vid full vind, takt i Hz, fas). Strået roteras runt roten, med samma byar och samma böjform.
   */
  function blades() {
    return Fn(() => {
      const p = positionLocal, root = attribute('groot', 'vec3'), h = attribute('gt', 'float'), b = attribute('gblade', 'vec3');
      const rw = modelWorldMatrix.mul(vec4(root, 1)).xyz;
      const W = normalize(modelWorldMatrixInverse.mul(vec4(windW(), 0)).xyz);
      const osc = sin(u.time.mul(b.y).mul(TAU).add(b.z));
      const a = b.x.mul(forceAt(rw.xz).add(u.sway.mul(u.strength).mul(osc))).mul(bendShape(h));
      return root.add(rotate(p.sub(root), normalize(cross(UP, W)), a));
    })();
  }

  /**
   * Flagga (tyg på en stång): hörnen ligger i stångens rum med x längs flaggan (0 vid stången, L vid den fria kanten)
   * och y nedåt från överkanten (0 till -H). Returnerar { positionNode, normalNode } till ett material med DoubleSide.
   * - Tyget är lätt och svarar på svag vind som en blomma (RESPONSE.plant): i stiltje hänger det längs stången, och
   *   ju mer det blåser desto mer lyfts det mot vågrätt (mest ytterst, där tyget är fritt).
   * - Vågor löper från stången mot den fria kanten; utslaget växer mot kanten och med byarna, farten med vinden, och
   *   en svagare, snabbare våg korsar den. Tyget tar längd från bredden när det veckar sig (ingen töjning).
   * - Den fria kanten (fransarna) rycker snabbt i blåst.
   * - Normalen räknas ur den deformerade ytan, så att vecken får rätt ljus och skugga.
   */
  function flag(L, H) {
    const pw = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const S = u.strength, F = forceFor(pw.xz, RESPONSE.plant.force), g = gustAt(pw.xz);
    const lift = smoothstep(0.0, 0.45, F); // 0 = hänger, 1 = flyger
    const speed = float(0.6).add(pow(max(F, 0.0001), 0.5).mul(3.4)); // vågor per sekund
    const lambda = mix(0.95, 0.55, lift); // våglängd i andelar av flaggans längd
    const shape = (x, y) => {
      const uu = x.div(L), vv = y.negate().div(H);
      const ph = uu.div(lambda).sub(u.time.mul(speed)).mul(TAU).add(vv.mul(0.7));
      const amp = float(L * 0.11).mul(pow(uu, 1.25)).mul(mix(0.3, 1.0, lift)).mul(float(0.75).add(g.mul(0.5))).mul(smoothstep(0, 0.06, S).mul(0.8).add(0.2));
      const z = amp.mul(sin(ph)).add(amp.mul(0.32).mul(sin(ph.mul(2.17).add(vv.mul(2.4)).add(u.time.mul(1.3)))));
      const fray = sin(u.time.mul(23).add(vv.mul(31))).mul(pow(uu, 6)).mul(L * 0.006).mul(lift);
      const yr = amp.mul(0.16).mul(sin(ph.mul(1.3).add(1.1)));
      // Veck tar längd: ju större utslag, desto kortare blir flaggan i sin riktning
      const xx = x.mul(float(1).sub(amp.div(L).mul(amp.div(L)).mul(18)));
      // Hängande tyg faller nedåt, mer ju längre ut
      const droop = float(1).sub(lift).mul(1.25).add(0.06).mul(float(0.3).add(uu.mul(0.7)));
      return vec3(xx.mul(cos(droop)), y.sub(xx.mul(sin(droop)).mul(0.9)).add(yr), z.add(fray));
    };
    // Vrid runt stången så att +x pekar med vinden
    const Wl = normalize(modelWorldMatrixInverse.mul(vec4(windW(), 0)).xyz);
    const toPole = (q) => vec3(q.x.mul(Wl.x).sub(q.z.mul(Wl.z)), q.y, q.x.mul(Wl.z).add(q.z.mul(Wl.x)));
    const x = positionLocal.x, y = positionLocal.y, e = L * 0.01;
    const P = shape(x, y);
    const n = normalize(cross(shape(x.add(e), y).sub(P), shape(x, y.add(e)).sub(P)));
    return {
      positionNode: toPole(P),
      normalNode: transformNormalToView(toPole(n)).mul(faceDirection),
    };
  }

  return {
    uniforms: u,
    state,
    set(p) {
      Object.assign(state, p);
      for (const k of ['strength', 'dir', 'gust', 'gustScale', 'gustSpeed', 'sway', 'flutter', 'separation']) u[k].value = state[k];
    },
    update(dt) { state.time += dt * state.timeScale; u.time.value = state.time; },
    rigged, placedNormal, blades, flag,
    force: forceAt, // kraften som nod (styrka² och byar) vid en punkt xz i världen
    forceFor, swayFor, // samma genom en svarskurva (RESPONSE.grass m.fl.): forceFor(xz, d), swayFor(d)
    gust: gustAt, // byarna som nod (0–1) vid en punkt xz i världen, t.ex. för att ljusa gräset
    // Samma byar på processorn (vindpilen, mätare)
    gustAt(x, z) {
      const s = state, c = Math.cos(s.dir), sn = Math.sin(s.dir);
      const a = (x * c + z * sn - s.time * s.gustSpeed) / s.gustScale, b = (-x * sn + z * c) / (s.gustScale * 1.7);
      const v = 0.5 + 0.5 * Math.sin(a * TAU + Math.sin(b * TAU) * 1.3) * 0.7 + 0.15 * Math.sin(a * 5.3 + b * 3.1);
      return Math.min(1, Math.max(0, v)) ** 1.5;
    },
    forceAt(x, z) { const s = state; return s.strength * s.strength * (1 - s.gust + s.gust * this.gustAt(x, z)); },
    // Vindens hastighet (m/s) i en punkt, genom ett föremåls svarskurva (RESPONSE): till tygsimuleringen (cloth.js).
    // Full storm (S = 1) är 16 m/s; byarna ändrar farten, kraften går som farten i kvadrat.
    velocityAt(x, z, response = 'plant') {
      const s = state, d = RESPONSE[response]?.force ?? 0;
      const f = Math.max(0, s.strength) ** Math.max(0.3, 2 + s.separation * d) * (1 - s.gust + s.gust * this.gustAt(x, z));
      const v = 16 * Math.sqrt(f);
      return [Math.cos(s.dir) * v, 0, Math.sin(s.dir) * v];
    },
  };
}
