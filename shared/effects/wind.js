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
  select, round, sign, smoothstep, fract, transformNormalToView,
} from 'three/tsl';

export const WIND_DEFAULTS = { strength: 0.5, dir: 0, gust: 0.5, gustScale: 18, gustSpeed: 6, sway: 0.35, flutter: 0.5, timeScale: 1 };
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
   * flutter: löven fladdrar lite (efter _WIND och _CLUSTER-fasen), stem: platta stjälkar (_STEM) vrids mot kameran,
   * place: många exemplar i en ritning (InstancedBufferGeometry med attributet iPlace = x, z, vridning, skala). Riggen
   * räknas då i modellens eget rum och placeras sist; byarna läses där exemplaret står. Använd placedNormal() som
   * materialets normal, så att ljuset följer vridningen.
   */
  function rigged(tex, { flutter = false, stem = false, place = false } = {}) {
    const pl = place ? attribute('iPlace', 'vec4') : null;
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
        const a = r2.x.mul(forceAt(pw.xz).add(u.sway.mul(u.strength).mul(osc))).mul(bendShape(t));
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
   * Flagga: hörnen ligger i stångens rum med x = längs flaggan (0 vid stången) och y uppåt. Flaggan vänder sig
   * med vinden runt stången, fladdrar i vågor som löper mot den fria kanten och hänger när det är stilla.
   */
  function flag(L) {
    return Fn(() => {
      const p = positionLocal, x = p.x.div(L);
      const pw = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
      const k = smoothstep(0, 0.7, u.strength.mul(u.strength).mul(0.5).add(forceAt(pw.xz)).add(0.05));
      const wave = sin(x.mul(7.0).sub(u.time.mul(float(4).add(u.strength.mul(6))))).mul(x).mul(L * 0.09).mul(k.add(0.25));
      const flap = sin(x.mul(3.0).sub(u.time.mul(2.3)).add(p.y)).mul(x).mul(L * 0.04);
      // Hängande: flaggan faller ned längs stången; flygande: rakt ut med vågor
      const hang = vec3(p.x.mul(0.18), p.y.sub(p.x.mul(0.85)), wave.mul(0.3));
      const fly = vec3(p.x, p.y.sub(x.mul(x).mul(L * 0.12).mul(float(1).sub(k))), wave.add(flap));
      const q = mix(hang, fly, k);
      // Vrid runt stången så att +x pekar med vinden
      const W = normalize(modelWorldMatrixInverse.mul(vec4(windW(), 0)).xyz);
      return vec3(q.x.mul(W.x).sub(q.z.mul(W.z)), q.y, q.x.mul(W.z).add(q.z.mul(W.x)));
    })();
  }

  return {
    uniforms: u,
    state,
    set(p) {
      Object.assign(state, p);
      for (const k of ['strength', 'dir', 'gust', 'gustScale', 'gustSpeed', 'sway', 'flutter']) u[k].value = state[k];
    },
    update(dt) { state.time += dt * state.timeScale; u.time.value = state.time; },
    rigged, placedNormal, blades, flag,
    force: forceAt, // kraften som nod (styrka² och byar) vid en punkt xz i världen
    gust: gustAt, // byarna som nod (0–1) vid en punkt xz i världen, t.ex. för att ljusa gräset
    // Samma byar på processorn (vindpilen, mätare)
    gustAt(x, z) {
      const s = state, c = Math.cos(s.dir), sn = Math.sin(s.dir);
      const a = (x * c + z * sn - s.time * s.gustSpeed) / s.gustScale, b = (-x * sn + z * c) / (s.gustScale * 1.7);
      const v = 0.5 + 0.5 * Math.sin(a * TAU + Math.sin(b * TAU) * 1.3) * 0.7 + 0.15 * Math.sin(a * 5.3 + b * 3.1);
      return Math.min(1, Math.max(0, v)) ** 1.5;
    },
    forceAt(x, z) { const s = state; return s.strength * s.strength * (1 - s.gust + s.gust * this.gustAt(x, z)); },
  };
}
