// Häxkittelns effektmodul (docs/effektlabb.md, E6): spelets effekter som recept, i TSL, så att samma kod körs i
// studions Häxkittel och i Tinkertown (WebGPU, med WebGL2 som reserv). Recepten är data (tools/vfx/vfx.json,
// sparade i assets/vfx/<namn>.vfx.json): { kind, settings }, där settings har alla spakar ifyllda.
//
//   const fx = createEffect('particles', settings, { at, target, ground, from, to });
//   scene.add(fx.object);
//   fx.update(time, { camera, wind });   // varje bild; wind är vindens hastighet i m/s ([x, y, z])
//   fx.set(settings);                    // nya spakar (uniforms; inget byggs om)
//   fx.play(time);                       // en gång: en partikelsmäll, ett hugg eller ett skott
//   fx.dispose();
//
// Fyra slag:
//   glow       glöd och aura runt en figur (target): kant som lyser (fresnel), en pelare av ljus, glöd på marken, ljus
//              och gnistor som stiger
//   marker     markörer på marken (ground, at): valring, sikte, område med laddning och vågor, utropstecken ovanför
//              figuren. Ringen projiceras på marken som en dekal, så att den följer sluttningar
//   particles  ett partikelsystem helt på grafikkortet: varje partikels liv räknas ur tiden och dess nummer, utan
//              tillstånd, så att tusentals partiklar kostar nästan ingenting på processorn
//   trail      spår och träffar: svärdshugg med ett band efter klingan, eller en projektil med svans och gnistor från
//              (from) till (to) som slår ned i en träff (gnistor, chockring och blixt)
import * as THREE from 'three/webgpu';
import {
  uniform, attribute, float, vec2, vec3, vec4, uint, instanceIndex, hash, sin, cos, exp, floor, fract, mix, smoothstep, select,
  length, atan, pow, max, min, clamp, abs, sqrt, normalize, dot, uv, positionLocal, normalLocal, normalView, positionView,
  positionWorld, modelWorldMatrix, cameraViewMatrix, mx_noise_float, varying, PI2,
} from 'three/tsl';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

export const KINDS = ['glow', 'marker', 'particles', 'trail'];
const SPRITES = ['soft', 'spark', 'smoke', 'star', 'leaf', 'ring'];
const EMITS = ['point', 'sphere', 'disc', 'ring'];
const MARKS = ['ring', 'target', 'area', 'exclaim'];
const DEG = Math.PI / 180;
const additive = (m, on) => { const b = on ? THREE.AdditiveBlending : THREE.NormalBlending; if (m.blending !== b) { m.blending = b; m.needsUpdate = true; } };

export function createEffect(kind, settings, ctx = {}) {
  if (kind === 'glow') return createAura(settings, ctx);
  if (kind === 'marker') return createMarker(settings, ctx);
  if (kind === 'particles') return createParticles(settings, ctx);
  if (kind === 'trail') return createTrail(settings, ctx);
  throw new Error(`unknown effect kind: ${kind}`);
}

// --- Partiklar ---
// Partikel i föds med jämna mellanrum över en livstid (löpande) eller alla på en gång (smäll), och får nya slumptal
// varje varv. Position, storlek, färg och genomskinlighet räknas ur åldern: utsändarens form, fart i en kon, utåt,
// tyngd, luftmotstånd, virvel, turbulens och vind. Med en bana (path) föds partiklarna längs projektilens väg.
export function createParticles(s, { at, max: maxCount = 4000 } = {}) {
  const V = () => uniform(new THREE.Vector3());
  const C = () => uniform(new THREE.Color());
  const u = {
    time: uniform(0), count: uniform(1), life: uniform(1), lifeVar: uniform(0), burst: uniform(0), t0: uniform(-1e4), salt: uniform(0), stagger: uniform(0),
    emit: uniform(0), radius: uniform(0), origin: V(),
    speed: uniform(0), speedVar: uniform(0), cone: uniform(0), radial: uniform(0), gravity: uniform(0), drag: uniform(0), swirl: uniform(0), turb: uniform(0),
    wind: V(), windAmt: uniform(0),
    size0: uniform(0.1), size1: uniform(0.1), sizeVar: uniform(0), stretch: uniform(0), spin: uniform(0),
    c0: C(), c1: C(), c2: C(), alpha: uniform(1), fadeIn: uniform(0.1), fadeOut: uniform(0.3), glow: uniform(1), flicker: uniform(0), sprite: uniform(0),
    path: uniform(0), pFrom: V(), pTo: V(), pArc: uniform(0), pT0: uniform(-1e4), pDur: uniform(1),
  };
  const idx = float(instanceIndex);
  const loop = u.burst.lessThan(0.5);
  // Löpande: födda jämnt över en livstid, ett nytt varv (round) med nya slumptal varje gång
  const local = u.time.sub(idx.div(u.count).mul(u.life)).add(u.life.mul(1000));
  const round = floor(local.div(u.life));
  const ageLoop = local.sub(round.mul(u.life));
  const ageBurst = u.time.sub(u.t0).sub(hash(instanceIndex.add(uint(911))).mul(u.stagger));
  const age = select(loop, ageLoop, ageBurst);
  const seed = instanceIndex.add(select(loop, round, float(0)).toUint().mul(uint(7919))).add(u.salt.toUint().mul(uint(104729)));
  const rnd = (k) => hash(seed.mul(uint(16)).add(uint(k)));
  const life = u.life.mul(float(1).sub(u.lifeVar.mul(rnd(0))));
  const lt = clamp(age.div(life), 0, 1);

  // Utsändarens form
  const a = rnd(1).mul(PI2), r2 = rnd(2), zc = rnd(3).mul(2).sub(1);
  const ring = vec3(cos(a), 0, sin(a));
  const sxy = sqrt(max(float(1).sub(zc.mul(zc)), 0));
  const sphere = vec3(sxy.mul(cos(a)), zc, sxy.mul(sin(a))).mul(pow(r2, 1 / 3));
  const off = select(u.emit.equal(1), sphere, select(u.emit.equal(2), ring.mul(sqrt(r2)), select(u.emit.equal(3), ring, vec3(0)))).mul(u.radius);
  // Längs en bana: där projektilen var när partikeln föddes; utanför flygningen syns den inte
  const sp = u.time.sub(age).sub(u.pT0).div(u.pDur);
  const onPath = mix(u.pFrom, u.pTo, sp).add(vec3(0, u.pArc.mul(4).mul(sp).mul(float(1).sub(sp)), 0));
  const origin = select(u.path.greaterThan(0.5), onPath, u.origin);
  const pathOk = u.path.lessThan(0.5).or(sp.greaterThanEqual(0).and(sp.lessThanEqual(1)));

  // Farten: i en kon kring uppåt, plus utåt från utsändarens mitt
  const th = u.cone.mul(sqrt(rnd(4))), ph = rnd(5).mul(PI2);
  const dir = vec3(sin(th).mul(cos(ph)), cos(th), sin(th).mul(sin(ph)));
  const outward = select(length(off.xz).greaterThan(1e-4), normalize(vec3(off.x, 0, off.z)), vec3(cos(ph), 0, sin(ph)));
  const v0 = dir.mul(u.speed.mul(float(1).sub(u.speedVar.mul(rnd(6))))).add(outward.mul(u.radial));
  const k = max(u.drag, 0.001), w = rnd(7).mul(PI2);
  const posAt = (t) => {
    // Luftmotstånd k: farten går mot noll (och tyngden mot en gränsfart), exakt lösning av v' = g − k·v
    const f = float(1).sub(exp(k.negate().mul(t))).div(k);
    let p = off.add(v0.mul(f)).add(vec3(0, u.gravity.negate(), 0).mul(t.sub(f).div(k)));
    const sa = u.swirl.mul(t); // virvel kring utsändarens lodlinje
    p = vec3(p.x.mul(cos(sa)).sub(p.z.mul(sin(sa))), p.y, p.x.mul(sin(sa)).add(p.z.mul(cos(sa))));
    p = p.add(vec3(sin(t.mul(2.1).add(w)), sin(t.mul(1.3).add(w.mul(2))).mul(0.6), cos(t.mul(1.7).add(w.mul(3)))).mul(u.turb).mul(min(t, 1)));
    // Vinden drar partikeln mot sin fart på ungefär en halv sekund
    p = p.add(u.wind.mul(u.windAmt).mul(t.sub(float(1).sub(exp(t.mul(-2))).div(2))));
    return origin.add(p);
  };
  const pos = posAt(age);
  const vel = pos.sub(posAt(max(age.sub(0.04), 0))).div(0.04);
  const vv = cameraViewMatrix.mul(vec4(vel, 0)).xy;
  const alive = age.greaterThanEqual(0).and(age.lessThan(life)).and(idx.lessThan(u.count)).and(pathOk);
  const size = mix(u.size0, u.size1, lt).mul(float(1).sub(u.sizeVar.mul(rnd(8))));
  const streak = float(1).add(u.stretch.mul(length(vv)).mul(0.12));

  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  mat.positionNode = pos;
  mat.scaleNode = vec2(size.mul(streak), size).mul(select(alive, float(1), float(0)));
  mat.rotationNode = select(u.stretch.greaterThan(0), atan(vv.y, vv.x), rnd(9).mul(PI2).add(u.spin.mul(rnd(10).mul(2).sub(1)).mul(age)));
  const vt = varying(lt), vr = varying(rnd(11));
  const col = select(vt.lessThan(0.5), mix(u.c0, u.c1, vt.mul(2)), mix(u.c1, u.c2, vt.mul(2).sub(1)));
  const sh = spriteShape(u.sprite, vr, u.time);
  const fade = smoothstep(0, max(u.fadeIn, 0.001), vt).mul(float(1).sub(smoothstep(float(1).sub(max(u.fadeOut, 0.001)), 1, vt)));
  const flick = float(1).sub(u.flicker.mul(0.5).mul(sin(u.time.mul(23).add(vr.mul(60))).add(1)));
  mat.colorNode = col.mul(u.glow).mul(sh.shade);
  mat.opacityNode = clamp(sh.alpha.mul(fade).mul(u.alpha).mul(flick), 0, 1);
  const sprite = new THREE.Sprite(mat);
  sprite.frustumCulled = false;
  sprite.count = 1;

  const fx = {
    object: sprite, uniforms: u,
    set(p) {
      s = p;
      sprite.count = Math.max(1, Math.min(maxCount, Math.round(p.count)));
      u.count.value = sprite.count;
      u.life.value = Math.max(0.05, p.lifetime);
      u.lifeVar.value = p.lifeVar;
      u.burst.value = p.mode === 'burst' ? 1 : 0;
      u.stagger.value = p.burstSpread ?? 0;
      u.emit.value = Math.max(0, EMITS.indexOf(p.emit));
      u.radius.value = p.radius;
      for (const key of ['speed', 'speedVar', 'radial', 'gravity', 'drag', 'swirl', 'stretch', 'spin', 'alpha', 'fadeIn', 'fadeOut', 'glow', 'flicker', 'sizeVar']) u[key].value = p[key];
      u.cone.value = p.spread * DEG;
      u.turb.value = p.turbulence;
      u.windAmt.value = p.wind;
      u.size0.value = p.sizeStart; u.size1.value = p.sizeEnd;
      u.c0.value.set(p.colorStart); u.c1.value.set(p.colorMid); u.c2.value.set(p.colorEnd);
      u.sprite.value = Math.max(0, SPRITES.indexOf(p.sprite));
      additive(mat, p.additive);
    },
    // Var partiklarna sänds ut ifrån (i världen)
    place(v) { u.origin.value.copy(v); },
    play(time) { u.t0.value = time; u.salt.value = (u.salt.value + 1) % 4096; },
    update(time, { wind } = {}) { u.time.value = time; if (wind) u.wind.value.set(...wind); },
    // Längs en bana (projektilens svans): från, till, bågens höjd, start och flygtid
    path(from, to, arc, t0, dur) { u.path.value = 1; u.pFrom.value.copy(from); u.pTo.value.copy(to); u.pArc.value = arc; u.pT0.value = t0; u.pDur.value = Math.max(0.01, dur); },
    dispose() { mat.dispose(); },
  };
  fx.set(s);
  if (at) fx.place(at);
  return fx;
}

// Spritens form ur uv: mjuk prick, gnista, rökmoln, stjärna, löv och ring. shade mörkar löven längs nerven.
function spriteShape(kind, r, time) {
  const p = uv().mul(2).sub(1), d = length(p), inv = clamp(float(1).sub(d), 0, 1);
  const soft = inv.mul(inv);
  const spark = pow(inv, 1.5).add(smoothstep(0.35, 0, d).mul(0.6));
  const n = mx_noise_float(vec3(p.mul(1.7), r.mul(40).add(time.mul(0.25)))).mul(0.5).add(0.5);
  const smoke = smoothstep(1, 0.15, d).mul(n.mul(0.9).add(0.35)).mul(0.8);
  const star = soft.mul(0.6).add(inv.mul(clamp(float(0.012).div(abs(p.x.mul(p.y)).add(0.012)), 0, 1)));
  const half = float(0.5).mul(float(1).sub(p.y.mul(p.y)));
  const leaf = smoothstep(0.05, 0, abs(p.x).sub(half));
  const ring = smoothstep(0.16, 0.02, abs(d.sub(0.7)));
  const alpha = select(kind.equal(1), spark, select(kind.equal(2), smoke, select(kind.equal(3), star, select(kind.equal(4), leaf, select(kind.equal(5), ring, soft)))));
  const shade = select(kind.equal(4), float(1).sub(smoothstep(0.06, 0, abs(p.x)).mul(0.35)).mul(float(0.8).add(p.y.mul(0.2))), float(1));
  return { alpha: clamp(alpha, 0, 1), shade };
}

// --- Glöd och aura ---
// Ett skal runt figurens alla delar (normalen ut en bit) som lyser i kanten och flimrar uppåt, en pelare av ljus,
// glöd på marken, ett punktljus och stigande gnistor (partiklar). Figuren ändras inte; skalen tas bort i dispose.
export function createAura(s, { target }) {
  const C = () => uniform(new THREE.Color());
  const u = {
    time: uniform(0), c: C(), c2: C(), intensity: uniform(1), rim: uniform(2), thick: uniform(0.03), fill: uniform(0), noise: uniform(0),
    nScale: uniform(3), flow: uniform(1), pulse: uniform(0), pulseSpeed: uniform(1), y0: uniform(0), y1: uniform(2),
    pillar: uniform(0), ground: uniform(0),
  };
  const pulse = float(1).add(u.pulse.mul(sin(u.time.mul(u.pulseSpeed).mul(PI2))));
  const hT = clamp(positionWorld.y.sub(u.y0).div(u.y1.sub(u.y0)), 0, 1);
  const n = mx_noise_float(positionWorld.mul(u.nScale).sub(vec3(0, u.time.mul(u.flow), 0))).mul(0.5).add(0.5);
  const noiseF = mix(float(1), n.mul(2), u.noise);
  const nv = abs(dot(normalize(normalView), normalize(positionView).negate()));
  const col = mix(u.c, u.c2, hT);

  const group = new THREE.Group();
  const shellMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  shellMat.positionNode = positionLocal.add(normalLocal.mul(u.thick.div(max(length(modelWorldMatrix[0].xyz), 1e-4))));
  shellMat.colorNode = col.mul(pow(float(1).sub(nv), u.rim).add(u.fill)).mul(noiseF).mul(pulse).mul(u.intensity);
  const shells = [];
  target.traverse((o) => {
    if (!o.isMesh || o.userData.vfxShell || o.material?.colorWrite === false) return;
    const sh = new THREE.Mesh(o.geometry, shellMat);
    sh.userData.vfxShell = true;
    sh.renderOrder = 2;
    shells.push([o, sh]);
  });
  target.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(target);
  for (const [o, sh] of shells) o.add(sh);
  const feet = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const tall = Math.max(0.5, box.max.y - box.min.y);
  u.y0.value = box.min.y; u.y1.value = box.max.y;

  // Pelaren: en öppen cylinder, ljusast i kanterna, strimmor som stiger och tonar ut uppåt och nedåt
  const pMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const v = uv().y, ang = atan(positionLocal.z, positionLocal.x);
  const streaks = mx_noise_float(vec3(cos(ang).mul(3), sin(ang).mul(3), v.mul(3).sub(u.time.mul(u.flow).mul(0.6)))).mul(0.5).add(0.5);
  const pFade = smoothstep(0, 0.12, v).mul(pow(float(1).sub(v), 1.6));
  pMat.colorNode = mix(u.c, u.c2, v).mul(pow(float(1).sub(nv), 1.4).mul(0.8).add(0.12)).mul(mix(float(1), streaks.mul(2), u.noise)).mul(pFade).mul(pulse).mul(u.pillar);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 48, 1, true).translate(0, 0.5, 0), pMat);
  pillar.position.copy(feet);
  pillar.renderOrder = 3;
  group.add(pillar);

  // Glöd på marken: en ljus fläck som tonar ut, med en svag ring i kanten
  const gMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4 });
  const gd = length(uv().mul(2).sub(1));
  gMat.colorNode = u.c.mul(pow(clamp(float(1).sub(gd), 0, 1), 2).add(smoothstep(0.12, 0, abs(gd.sub(0.85))).mul(0.25))).mul(pulse).mul(u.ground);
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), gMat);
  disc.position.copy(feet).y += 0.02;
  group.add(disc);

  const light = new THREE.PointLight('#ffffff', 0, 7, 2);
  light.position.copy(feet).y += tall * 0.55;
  group.add(light);

  const motes = createParticles(moteSettings(s), { at: feet, max: 1000 });
  group.add(motes.object);

  const fx = {
    object: group, uniforms: u,
    set(p) {
      s = p;
      u.c.value.set(p.color); u.c2.value.set(p.color2);
      for (const key of ['intensity', 'rim', 'fill', 'noise', 'flow', 'pulse', 'pulseSpeed', 'pillar']) u[key].value = p[key];
      u.thick.value = p.thickness; u.nScale.value = p.noiseScale; u.ground.value = p.groundGlow;
      pillar.scale.set(p.pillarRadius, p.pillarHeight, p.pillarRadius);
      pillar.visible = p.pillar > 0;
      disc.scale.setScalar(p.groundRadius);
      disc.visible = p.groundGlow > 0;
      light.color.set(p.color);
      motes.set(moteSettings(p));
      motes.object.visible = p.motes > 0;
    },
    play() {},
    update(time, ctx = {}) {
      u.time.value = time;
      motes.update(time, ctx);
      const pl = 1 + s.pulse * Math.sin(time * s.pulseSpeed * Math.PI * 2);
      const fl = 1 - s.flicker * (0.5 + 0.5 * Math.sin(time * 17.3) * Math.sin(time * 7.1 + 1.3));
      light.intensity = s.light * pl * fl;
    },
    dispose() {
      for (const [o, sh] of shells) o.remove(sh);
      shellMat.dispose(); pMat.dispose(); gMat.dispose(); pillar.geometry.dispose(); disc.geometry.dispose(); motes.dispose();
    },
  };
  fx.set(s);
  return fx;
}
// Auran gnistor som partikelrecept
function moteSettings(p) {
  return {
    mode: 'loop', count: Math.max(1, p.motes), lifetime: 2.2, lifeVar: 0.4, emit: 'disc', radius: Math.max(0.15, p.groundRadius * 0.6),
    speed: p.moteSpeed, speedVar: 0.5, spread: 12, radial: 0.08, gravity: 0, drag: 0.15, swirl: p.moteSwirl, turbulence: 0.25, wind: 0.2,
    sprite: 'soft', additive: true, sizeStart: p.moteSize, sizeEnd: p.moteSize * 0.3, sizeVar: 0.4, stretch: 0, spin: 0,
    colorStart: p.color2, colorMid: p.color, colorEnd: p.color, alpha: 1, fadeIn: 0.2, fadeOut: 0.5, glow: Math.max(0.5, p.intensity * 1.2), flicker: 0.3,
  };
}

// --- Markörer ---
// Ritas ur uv på en dekal som projiceras på marken (DecalGeometry), så att den följer sluttningar. Dekalen byggs om när
// markören flyttas eller radien ändras. Utropstecknet är en sprite som guppar ovanför figuren.
export function createMarker(s, { ground, at, top }) {
  const PAD = 1.4; // dekalen är lite större än radien, för glorian
  const C = () => uniform(new THREE.Color());
  const u = {
    time: uniform(0), shape: uniform(0), c: C(), c2: C(), w: uniform(0.1), soft: uniform(0.03), dashes: uniform(0), dashFill: uniform(0.6),
    fill: uniform(0), glow: uniform(1), spin: uniform(0), pulse: uniform(0), pulseSpeed: uniform(1), ripples: uniform(0), rippleSpeed: uniform(0.5),
    charge: uniform(0), size: uniform(0.5),
  };
  const p = uv().mul(2).sub(1).mul(PAD);
  const sw = sin(u.time.mul(u.pulseSpeed).mul(PI2));
  const r = length(p).div(float(1).add(u.pulse.mul(0.06).mul(sw)));
  const a = atan(p.y, p.x).add(u.time.mul(u.spin));
  const band = (r0, wd) => float(1).sub(smoothstep(wd.mul(0.5), wd.mul(0.5).add(u.soft).add(0.004), abs(r.sub(r0))));
  const ring = band(float(1).sub(u.w.mul(0.5)), u.w);
  const dash = select(u.dashes.greaterThan(0.5), smoothstep(u.dashFill.add(0.03), u.dashFill.sub(0.03), fract(a.div(PI2).mul(u.dashes))), float(1));
  let lines = ring.mul(dash);
  // Sikte: fyra streck in mot mitten och en prick
  const ticks = smoothstep(0.09, 0.04, abs(sin(a.mul(2)))).mul(smoothstep(0.33, 0.38, r)).mul(smoothstep(0.78, 0.72, r)).add(smoothstep(0.1, 0.06, r));
  lines = lines.add(select(u.shape.equal(1), ticks, float(0)));
  // Område: en inre runring som går åt andra hållet, och en laddning som fylls ut från mitten
  const a2 = atan(p.y, p.x).sub(u.time.mul(u.spin).mul(1.5));
  const runes = band(float(0.8), u.w.mul(0.6)).mul(smoothstep(0.55, 0.45, fract(a2.div(PI2).mul(24))));
  const ch = select(u.charge.greaterThan(0), fract(u.time.div(max(u.charge, 0.01))), float(2));
  const charge = smoothstep(ch, ch.sub(0.02), r).mul(r.div(max(ch, 0.01)).mul(0.5).add(0.3)).add(band(ch, float(0.05))).mul(step01(u.charge)).mul(smoothstep(1.01, 0.97, r));
  lines = lines.add(select(u.shape.equal(2), runes.add(charge), float(0)));
  // Vågor: ringar som går utåt (eller inåt med negativ fart) och tonar in och ut
  let rip = float(0);
  for (let k = 0; k < 4; k++) {
    const ph = fract(u.time.mul(u.rippleSpeed).add(float(k).div(max(u.ripples, 1))));
    rip = rip.add(band(ph, float(0.05)).mul(sin(ph.mul(Math.PI))).mul(select(float(k).lessThan(u.ripples), float(0.8), float(0))));
  }
  lines = lines.add(rip);
  const fill = u.fill.mul(smoothstep(1, 0.97, r)).mul(pow(r, 3).mul(0.65).add(0.35));
  const halo = exp(max(r.sub(1), 0).mul(-9)).mul(smoothstep(0.98, 1.0, r)).mul(0.3);
  const bright = float(1).add(u.pulse.mul(0.5).mul(sw));
  const dim = select(u.shape.equal(3), float(0.45), float(1)); // utropstecknets ring på marken är svag
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  mat.colorNode = u.c.mul(clamp(lines, 0, 1.5)).add(u.c2.mul(fill)).add(u.c.mul(halo)).mul(u.glow).mul(bright).mul(dim);
  mat.opacityNode = clamp(lines.add(fill).add(halo), 0, 1).mul(dim);

  const group = new THREE.Group();
  let decal = null, where = (at ?? new THREE.Vector3()).clone(), built = '';
  function rebuild() {
    const key = `${where.toArray().map((x) => x.toFixed(3))}|${s.radius}`;
    if (key === built || !ground) return;
    built = key;
    if (decal) { group.remove(decal); decal.geometry.dispose(); }
    const size = s.radius * 2 * PAD;
    decal = new THREE.Mesh(new DecalGeometry(ground, where, new THREE.Euler(-Math.PI / 2, 0, 0), new THREE.Vector3(size, size, 6)), mat);
    decal.renderOrder = 4;
    group.add(decal);
  }

  // Utropstecknet: ett avrundat streck och en prick, med en mörkare kant
  const sMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const q = uv().mul(2).sub(1).mul(vec2(1, -1));
  const halfW = mix(float(0.1), float(0.17), clamp(q.y.negate().mul(0.5).add(0.5), 0, 1));
  const bar = max(abs(q.x).sub(halfW), abs(q.y.add(0.27)).sub(0.53));
  const dot0 = length(q.sub(vec2(0, 0.68))).sub(0.15);
  const sd = min(bar, dot0);
  const inner = smoothstep(0.015, -0.015, sd), outline = smoothstep(0.11, 0.08, sd);
  sMat.colorNode = mix(u.c2.mul(0.35), u.c.mul(u.glow), inner);
  sMat.opacityNode = outline;
  sMat.scaleNode = vec2(u.size.mul(0.62), u.size);
  const sign = new THREE.Sprite(sMat);
  sign.renderOrder = 5;
  group.add(sign);
  const topY = () => (top ?? where.y + 1.8) + 0.15;

  const fx = {
    object: group, uniforms: u,
    set(v) {
      s = v;
      u.shape.value = Math.max(0, MARKS.indexOf(v.shape));
      u.c.value.set(v.color); u.c2.value.set(v.color2);
      u.w.value = Math.min(0.9, v.width / Math.max(0.05, v.radius));
      u.soft.value = v.softness;
      for (const key of ['dashes', 'dashFill', 'fill', 'glow', 'spin', 'pulse', 'pulseSpeed', 'ripples', 'rippleSpeed', 'charge']) u[key].value = v[key];
      u.size.value = v.signSize;
      sign.visible = v.shape === 'exclaim';
      additive(mat, v.additive);
      rebuild();
    },
    // Flytta markören till en punkt på marken; top är figurens höjd (för utropstecknet)
    place(v, topAt) { where.copy(v); if (topAt !== undefined) top = topAt; rebuild(); },
    play() {},
    update(time) {
      u.time.value = time;
      sign.position.set(where.x, topY() + s.signSize * 0.5 + s.bob * Math.sin(time * 3), where.z);
    },
    dispose() { if (decal) decal.geometry.dispose(); mat.dispose(); sMat.dispose(); },
  };
  fx.set(s);
  return fx;
}
const step01 = (x) => select(x.greaterThan(0), float(1), float(0));

// --- Spår och träffar ---
// Ett band (triangelremsa) som följer två punkter och tonar ut med åldern: svärdets klinga, eller projektilens svans.
function createRibbon(maxSeg = 160) {
  const pos = new Float32Array(maxSeg * 2 * 3), born = new Float32Array(maxSeg * 2), side = new Float32Array(maxSeg * 2);
  const index = [];
  for (let i = 0; i < maxSeg - 1; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  for (let i = 0; i < maxSeg; i++) { side[i * 2] = 0; side[i * 2 + 1] = 1; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aBorn', new THREE.BufferAttribute(born, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geo.setIndex(index);
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, null);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  const pts = []; // { a, b, t }
  return {
    mesh,
    push(a, b, t) { pts.push({ a: a.clone(), b: b.clone(), t }); if (pts.length > maxSeg) pts.shift(); },
    clear() { pts.length = 0; geo.setDrawRange(0, 0); },
    update(time, len) {
      while (pts.length && time - pts[0].t > len) pts.shift();
      pts.forEach((q, i) => { q.a.toArray(pos, i * 6); q.b.toArray(pos, i * 6 + 3); born[i * 2] = born[i * 2 + 1] = q.t; });
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aBorn.needsUpdate = true;
      geo.setDrawRange(0, Math.max(0, pts.length - 1) * 6);
    },
  };
}

export function createTrail(s, { from, to, figure }) {
  const C = () => uniform(new THREE.Color());
  const u = { time: uniform(0), len: uniform(0.25), head: C(), tail: C(), glow: uniform(1), soft: uniform(0.5), sym: uniform(0), size: uniform(0.2), hitT: uniform(-10), hitR: uniform(1), hit: C() };
  const group = new THREE.Group();
  const ribbon = createRibbon();
  const rMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const lt = clamp(u.time.sub(attribute('aBorn', 'float')).div(u.len), 0, 1);
  const sd = attribute('aSide', 'float');
  // Svärdet: ljusast ytterst vid spetsen; svansen: ljusast i mitten
  const across = select(u.sym.greaterThan(0.5), float(1).sub(abs(sd.mul(2).sub(1))), sd);
  const edge = smoothstep(0, max(u.soft, 0.02), across);
  rMat.colorNode = mix(u.head, u.tail, lt).mul(u.glow);
  rMat.opacityNode = pow(float(1).sub(lt), 1.5).mul(edge);
  ribbon.mesh.material = rMat;
  group.add(ribbon.mesh);

  // Klingan: en stand-in som visar var spåret kommer ifrån
  const sword = new THREE.Group();
  const tilt = new THREE.Group(), arm = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.015).translate(0.75, 0, 0), new THREE.MeshStandardNodeMaterial({ color: '#d9dde3', metalness: 0.9, roughness: 0.25 }));
  const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.035, 0.035).translate(0.12, 0, 0), new THREE.MeshStandardNodeMaterial({ color: '#4a3020', roughness: 0.8 }));
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.04).translate(0.25, 0, 0), new THREE.MeshStandardNodeMaterial({ color: '#b08a3a', metalness: 0.7, roughness: 0.4 }));
  blade.castShadow = hilt.castShadow = true;
  arm.add(blade, hilt, guard);
  tilt.add(arm);
  sword.add(tilt);
  group.add(sword);
  // Klingan pekar mot målet (to) i vila; svingen går kring lodlinjen och lutas kring riktningen mot målet
  if (figure) { sword.position.copy(figure.position).add(new THREE.Vector3(0, 1.25, 0)); if (to) sword.rotation.y = Math.atan2(-(to.z - sword.position.z), to.x - sword.position.x); }

  // Projektilen: ett glödande huvud med ljus, gnistor längs vägen och en träff
  const hMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const hp = uv().mul(2).sub(1), hd = length(hp);
  hMat.colorNode = mix(u.tail, vec3(1, 1, 1), smoothstep(0.45, 0, hd).mul(0.7)).mul(u.glow).mul(1.5);
  hMat.opacityNode = pow(clamp(float(1).sub(hd), 0, 1), 1.8);
  const headS = new THREE.Sprite(hMat);
  const headL = new THREE.PointLight('#ffffff', 0, 6, 2);
  group.add(headS, headL);
  const sparks = createParticles(tailSparks(s), { max: 1000 });
  const burst = createParticles(hitSparks(s), { max: 2000 });
  group.add(sparks.object, burst.object);
  sparks.path(from, to, 0, -1e4, 1); // svansens gnistor syns bara under en flygning
  // Chockringen: en ring som vidgas och tonar ut där projektilen slår ned
  const kMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const kt = clamp(u.time.sub(u.hitT).div(0.35), 0, 1);
  const kd = length(uv().mul(2).sub(1));
  kMat.colorNode = u.hit.mul(u.glow).mul(2);
  kMat.opacityNode = smoothstep(0.12, 0.0, abs(kd.sub(0.85))).mul(float(1).sub(kt)).mul(select(u.time.sub(u.hitT).lessThan(0.35), float(1), float(0)));
  kMat.scaleNode = vec2(u.hitR.mul(pow(kt, 0.5)).mul(2).add(0.01));
  const shock = new THREE.Sprite(kMat);
  const flash = new THREE.PointLight('#ffffff', 0, 8, 2);
  group.add(shock, flash);

  const A = new THREE.Vector3(), B = new THREE.Vector3(), P = new THREE.Vector3(), Q = new THREE.Vector3(), dirV = new THREE.Vector3(), camV = new THREE.Vector3(), sideV = new THREE.Vector3();
  let shotT = -1e9, lastShot = -1e9, hitDone = true, swingT0 = 0;
  const flight = () => from.distanceTo(to) / Math.max(1, s.speed);
  const pathAt = (k, out) => out.lerpVectors(from, to, k).setY(out.y + s.arcHeight * 4 * k * (1 - k));
  function fire(time) {
    shotT = time; hitDone = false;
    sparks.path(from, to, s.arcHeight, time, flight());
    ribbon.clear();
  }

  const fx = {
    object: group, uniforms: u, loop: true, // loop: hugg och skott upprepas (annars bara med play)
    set(v) {
      const modeChanged = s.mode !== v.mode;
      s = v;
      u.len.value = v.trailTime; u.head.value.set(v.colorHead); u.tail.value.set(v.colorTail); u.glow.value = v.glow; u.soft.value = v.softness;
      u.sym.value = v.mode === 'projectile' ? 1 : 0; u.hitR.value = v.hitRing; u.hit.value.set(v.hitColor);
      additive(rMat, v.glow > 0.05);
      sword.visible = v.mode === 'sword';
      sparks.object.visible = v.mode === 'projectile';
      tilt.rotation.x = v.tilt * DEG;
      headS.scale.setScalar(v.size * 2.5);
      headL.color.set(v.colorHead); flash.color.set(v.hitColor);
      sparks.set(tailSparks(v)); burst.set(hitSparks(v));
      if (modeChanged) ribbon.clear();
    },
    // Ett hugg eller ett skott
    play(time) { if (s.mode === 'sword') swingT0 = time; else fire(time); },
    update(time, { camera, wind } = {}) {
      u.time.value = time;
      sparks.update(time, { wind }); burst.update(time, { wind });
      if (s.mode === 'sword') {
        headS.visible = false; headL.intensity = 0;
        // Ett hugg tar 55 % av varvet med mjuk start och inbromsning, sedan en paus; varannat hugg går tillbaka
        let ph = (time - swingT0) * s.swingSpeed;
        if (!fx.loop) ph = Math.min(Math.max(ph, 0), 0.999);
        const cyc = Math.floor(ph), f = ph - cyc;
        const e = f < 0.55 ? ease(f / 0.55) : 1;
        const k = cyc % 2 === 0 ? e : 1 - e;
        arm.rotation.y = (-s.arc / 2 + s.arc * k) * DEG;
        sword.updateMatrixWorld(true);
        A.set(0.25 + (1 - s.cover) * 1.0, 0, 0).applyMatrix4(arm.matrixWorld);
        B.set(1.25, 0, 0).applyMatrix4(arm.matrixWorld);
        ribbon.push(A, B, time);
      } else {
        const dur = flight();
        if (fx.loop && time - lastShot > s.interval) { lastShot = time; fire(time); }
        const k = (time - shotT) / dur;
        const flying = k >= 0 && k <= 1;
        headS.visible = flying;
        headL.intensity = flying ? s.glow * 3 : 0;
        if (flying) {
          pathAt(k, P);
          pathAt(Math.max(0, k - 0.01), Q);
          headS.position.copy(P); headL.position.copy(P);
          // Svansen ligger mot kameran: bredden vinkelrätt mot både färdriktningen och blicken
          dirV.subVectors(P, Q).normalize();
          camera?.getWorldDirection(camV);
          sideV.crossVectors(dirV, camV).normalize().multiplyScalar(s.width / 2);
          ribbon.push(A.copy(P).sub(sideV), B.copy(P).add(sideV), time);
        }
        if (!hitDone && k >= 1) {
          hitDone = true;
          burst.place(to); burst.play(time);
          u.hitT.value = time;
          shock.position.copy(to); flash.position.copy(to);
        }
        flash.intensity = s.flash * Math.exp(-(time - u.hitT.value) * 10);
      }
      ribbon.update(time, s.trailTime);
    },
    dispose() {
      ribbon.mesh.geometry.dispose(); rMat.dispose(); hMat.dispose(); kMat.dispose(); sparks.dispose(); burst.dispose();
      for (const m of [blade, hilt, guard]) { m.geometry.dispose(); m.material.dispose(); }
    },
  };
  fx.set(s);
  return fx;
}
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
function tailSparks(p) {
  return {
    mode: 'loop', count: Math.max(1, p.sparks), lifetime: 0.5, lifeVar: 0.5, emit: 'sphere', radius: p.size * 0.5,
    speed: 0.8, speedVar: 0.6, spread: 180, radial: 0.3, gravity: 1.5, drag: 1.5, swirl: 0, turbulence: 0.3, wind: 0.3,
    sprite: 'soft', additive: true, sizeStart: p.size * 0.5, sizeEnd: 0.01, sizeVar: 0.5, stretch: 0, spin: 0,
    colorStart: p.colorHead, colorMid: p.colorTail, colorEnd: p.colorTail, alpha: 1, fadeIn: 0.05, fadeOut: 0.6, glow: Math.max(0.5, p.glow), flicker: 0.3,
  };
}
function hitSparks(p) {
  return {
    mode: 'burst', count: Math.max(1, p.hitSparks), lifetime: 0.7, lifeVar: 0.5, burstSpread: 0.03, emit: 'sphere', radius: 0.05,
    speed: p.hitSpeed, speedVar: 0.6, spread: 180, radial: 0, gravity: 6, drag: 1.8, swirl: 0, turbulence: 0.1, wind: 0.1,
    sprite: 'spark', additive: true, sizeStart: 0.06, sizeEnd: 0.01, sizeVar: 0.4, stretch: 1.5, spin: 0,
    colorStart: '#ffffff', colorMid: p.hitColor, colorEnd: p.colorTail, alpha: 1, fadeIn: 0.02, fadeOut: 0.5, glow: Math.max(1, p.glow * 1.5), flicker: 0,
  };
}
