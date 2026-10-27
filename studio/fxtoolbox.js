// Häxkittelns verktygslåda i andra avdelningar (docs/avdelningar.md, Korsbefrukning): små snabbknappar för de effekter
// som klarar sig utan kastare och figur (besvärjelser vars lager bara använder marken, himlen och platsen, och alla
// partiklar och markörer). Man väljer en knapp och klickar på marken eller i gräset, och effekten spelas upp där med
// samma kod (shared/effects/vfx.js, spells.js) och samma recept (tools/vfx/vfx.json) som i Häxkitteln. Bara för prov:
// inget sparas. Texten i appen är på engelska.
import * as THREE from 'three/webgpu';
import { uniform, length, smoothstep, abs, fract, atan, sin, PI2 } from 'three/tsl';
import { createEffect, depthDecal, decalMesh, placeDecal } from '../shared/effects/vfx.js';

// Fästpunkter som en besvärjelse får använda för att gå att spela fristående (allt utgår från klicket)
const FREE_ANCHORS = new Set(['target', 'targetGround', 'sky', 'spot', 'spotUp', 'spotPortal']);
const MAX = 8;

// root: där lådan läggs; view: elementet man klickar i; ground: det man kan klicka på; windAt(x, z): vindens fart
export async function createFxToolbox({ api, el, root, view, scene, camera, renderer, ground, groundY = () => 0, windAt }) {
  const info = await api('/api/vfx');
  const defaults = (kind) => Object.fromEntries(info.kinds.find((k) => k.id === kind).params.map((q) => [q.key, q.default]));
  const free = (spellId) => (info.spells[spellId]?.layers ?? []).every((L) =>
    (!L.anchor || FREE_ANCHORS.has(L.anchor)) && (!L.from || FREE_ANCHORS.has(L.from)) && (!L.to || FREE_ANCHORS.has(L.to)) && L.type !== 'aura');
  const strip = ({ label: _l, ...rest }) => rest;
  // Knapparna: besvärjelser som klarar sig själva, partiklar och markörer (färdiga och sparade)
  const groups = [
    { title: 'Spells', items: Object.entries(info.presets.spell ?? {}).filter(([, p]) => free(p.spell)).map(([id, p]) => ({ id: `spell:${id}`, kind: 'spell', label: p.label, settings: strip(p) })) },
    { title: 'Particles', items: Object.entries(info.presets.particles ?? {}).map(([id, p]) => ({ id: `particles:${id}`, kind: 'particles', label: p.label, settings: strip(p) })) },
    { title: 'Markers', items: Object.entries(info.presets.marker ?? {}).map(([id, p]) => ({ id: `marker:${id}`, kind: 'marker', label: p.label, settings: strip(p) })) },
  ];
  for (const x of info.saved) {
    if (x.kind === 'spell' && !free(x.settings.spell)) continue;
    const g = groups.find((gg) => gg.title.toLowerCase().startsWith(x.kind.slice(0, 5)));
    g?.items.push({ id: `saved:${x.name}`, kind: x.kind, label: x.name, settings: x.settings });
  }

  // --- Lådan ---
  const box = el('div', 'fxbox glass');
  const head = el('header'), title = el('b', null, 'Cauldron'), hint = el('span', 'note', 'Pick an effect, then click in the grass');
  const clear = el('button', null, 'Clear');
  clear.title = 'Remove every effect you have placed (Esc unselects the effect)';
  head.append(title, hint, clear);
  const body = el('div', 'fxbody');
  box.append(head, body);
  root.append(box);
  let picked = null;
  head.onclick = (e) => { if (e.target !== clear) box.classList.toggle('closed'); };
  const btns = [];
  // Välj en effekt (eller ingen): knappen markeras, pekaren blir ett hårkors och ringen får effektens färg
  function pick(it) {
    picked = it;
    for (const [i2, b2] of btns) b2.classList.toggle('on', i2 === picked);
    hint.textContent = picked ? `Click in the grass to place ${it.label}` : 'Pick an effect, then click in the grass';
    renderer.domElement.style.cursor = picked ? 'crosshair' : '';
    if (picked) cu.color.value.set(colorOf(picked)); else cursor.visible = false;
  }
  // Esc avmarkerar
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && picked && view.clientWidth > 0) pick(null); });
  for (const g of groups) {
    if (!g.items.length) continue;
    const row = el('div', 'fxrow');
    row.append(el('small', null, g.title));
    for (const it of g.items) {
      const b = el('button', 'chip', it.label);
      const [kind, id] = it.id.split(':'), icon = el('img');
      icon.alt = '';
      icon.src = `/assets/icons/vfx/${kind}/${id}.png`; // samma ikon som i Häxkittelns låda
      icon.onerror = () => icon.remove();
      b.prepend(icon);
      b.onclick = () => pick(picked === it ? null : it);
      btns.push([it, b]);
      row.append(b);
    }
    body.append(row);
  }

  // --- Effekterna ---
  // Varje effekt byggs vid origo i en grupp, och det är gruppen som flyttas dit man klickar: inget byggs om och inga
  // shaders kompileras vid klicket. Färdiga effekter går tillbaka till en pool och återanvänds. Den första instansen
  // skapas och kompileras uttonad när man väljer knappen ("Brewing…"), så att kostnaden hamnar där. Ljusen i en
  // besvärjelse ligger kvar i scenen släckta (ändrat antal ljus skulle kompilera om gläntans alla material).
  const pools = new Map(); // knappens id -> instanser { it, fx, group, s, live, ready, born, life, lights }
  // Ljusbudget: fyra gemensamma punktljus som alltid finns i scenen. Effekternas egna ljus tas ur scenen och ger bara
  // värden (plats, färg, styrka); de starkaste styr de gemensamma varje bild. Antalet ljus ändras då aldrig, och
  // gläntans material (gräset, träden) behöver aldrig kompileras om när en effekt läggs till.
  const LIGHTS = [0, 1, 2, 3].map(() => { const l = new THREE.PointLight('#ffffff', 0, 10, 2); scene.add(l); return l; });
  let time = 0, warmLeft = 0;
  const O = new THREE.Vector3();
  function make(it) {
    const s = { ...defaults(it.kind), ...it.settings };
    const anchors = {
      target: new THREE.Vector3(0, 1.0, 0), targetGround: O.clone(), sky: new THREE.Vector3(-0.9, 14, -0.7),
      spot: O.clone(), spotUp: new THREE.Vector3(0, 1.1, 0), spotPortal: new THREE.Vector3(0, 1.2, 0),
    };
    const ctx = { at: new THREE.Vector3(0, it.kind === 'particles' ? 0.05 : 0, 0), top: 1.6, ground, spells: info.spells, templates: info.layerTemplates,
      defaults: { particles: defaults('particles'), marker: defaults('marker'), glow: defaults('glow') }, anchors, groundY: () => 0 };
    let fx;
    try { fx = createEffect(it.kind, s, ctx); } catch (err) { console.warn(err); return null; }
    if (it.kind === 'marker') fx.place(ctx.at, ctx.top);
    const group = new THREE.Group();
    group.add(fx.object);
    scene.add(group);
    const lights = [];
    group.traverse((o) => { if (o.isLight) lights.push(o); });
    for (const l of lights) { const parent = l.parent; parent.remove(l); l.userData.parent = parent; }
    // Uttonad den första bilden: shaders kompileras utan att något syns
    if (fx.prepare) fx.prepare(time, camera); else fx.setFade?.(0);
    const inst = { it, fx, group, s, live: false, ready: false, born: 0, life: Infinity, lights, warm: 2 }; // warm: bilder kvar att kompilera på
    if (!pools.has(it.id)) pools.set(it.id, []);
    pools.get(it.id).push(inst);
    warmLeft = 2;
    return inst;
  }
  const liveList = () => [...pools.values()].flat().filter((i) => i.live);
  // Ur bild: gruppen döljs helt (ljusen ligger utanför scenen i ljusbudgeten, så antalet ljus ändras inte)
  function retire(inst) {
    inst.live = false;
    if (inst.it.kind !== 'spell') inst.fx.setFade?.(0);
    inst.group.visible = false;
  }
  clear.onclick = () => { for (const i of liveList()) retire(i); };
  function start(inst) {
    inst.ready = true;
    inst.born = time;
    inst.group.visible = true;
    const { kind } = inst.it, s = inst.s;
    if (kind === 'spell') { inst.fx.play(time); inst.life = inst.fx.ambient ? Infinity : inst.fx.duration + 0.5; return; }
    inst.fx.setFade?.(1);
    if (kind === 'particles' && s.mode === 'burst') { inst.fx.play(time); inst.life = s.lifetime + (s.burstSpread ?? 0) + 0.5; }
    else if (kind === 'marker') inst.fx.play?.(time);
  }
  function spawn(it, at) {
    const live = liveList();
    if (live.length >= MAX) retire(live.sort((a, b) => a.born - b.born)[0]);
    const inst = (pools.get(it.id) ?? []).find((i) => !i.live) ?? make(it);
    if (!inst) return;
    inst.group.position.copy(at);
    inst.live = true;
    inst.ready = false; // startar nästa bild (en ny instans har då hunnit kompileras)
  }
  // --- Pekarens AOE: en ring på marken i effektens färg och storlek där effekten kommer att hamna ---
  const cu = { color: uniform(new THREE.Color('#a07ef6')), time: uniform(0) };
  const cD = depthDecal({ slope: -1 }); // ingen lutningsmask: ringen är en visare och får ligga på strån och stenar
  const cp = cD.uv.mul(2).sub(1), cr = length(cp);
  const ca = atan(cp.y, cp.x).add(cu.time.mul(0.8));
  const pulse = sin(cu.time.mul(4)).mul(0.04).add(1);
  const rim = smoothstep(0.07, 0.0, abs(cr.sub(0.92).div(pulse)));
  const dashes = smoothstep(0.55, 0.45, fract(ca.div(PI2).mul(28))).mul(smoothstep(0.035, 0.0, abs(cr.sub(0.8))));
  const fill = smoothstep(0.95, 0.2, cr).mul(0.12);
  const cMat = new THREE.MeshBasicNodeMaterial();
  const cA = rim.add(dashes.mul(0.8)).add(fill);
  cMat.colorNode = cu.color.mul(rim.mul(0.6).add(1.2));
  cMat.opacityNode = cA.mul(cD.mask).clamp(0, 1);
  const cursor = decalMesh(cMat, 9);
  cursor.visible = false;
  scene.add(cursor);
  const colorOf = (it) => it.settings.color ?? it.settings.colorMid ?? '#a07ef6';
  // Hur stor effekten blir på marken: markörens radie, besvärjelsens område (cirkel, brännmärke, ring) eller utsändaren
  function radiusOf(it) {
    const s = { ...defaults(it.kind), ...it.settings };
    if (it.kind === 'marker') return s.radius;
    if (it.kind === 'particles') return Math.max(0.5, (s.emit === 'point' ? 0.2 : s.radius) * 1.4 + 0.3);
    const layers = info.spells[s.spell]?.layers ?? [];
    const r = (t, k = 1) => Math.max(0, ...layers.filter((L) => L.type === t).map((L) => (L.set?.radius ?? 0) * k));
    return Math.max(r('marker'), r('scorch'), r('portal'), r('ring', 0.5), 0.8) * (s.size ?? 1);
  }

  // Klick i gräset (inte en dragning med kameran, och inte på lådans knappar); ringen följer pekaren
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  const groundAt = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(ground)[0]?.point ?? null;
  };
  view.addEventListener('pointerdown', (e) => { down = e.target === renderer.domElement ? [e.clientX, e.clientY] : null; });
  view.addEventListener('pointerup', (e) => {
    if (!picked || !down || e.button !== 0 || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    down = null;
    const p = groundAt(e);
    if (p) spawn(picked, p);
  });
  view.addEventListener('pointermove', (e) => {
    const p = picked && e.target === renderer.domElement ? groundAt(e) : null;
    cursor.visible = !!p;
    if (p) placeDecal(cursor, p, radiusOf(picked), { height: 3 });
  });
  view.addEventListener('pointerleave', () => { cursor.visible = false; });

  // Välj: förbered en instans redan nu, så att klicket inte väntar
  for (const [it, b] of btns) b.addEventListener('click', () => { if (picked === it && !pools.has(it.id)) { make(it); hint.textContent = `Brewing ${it.label}… then click in the grass`; } });

  return {
    // dt i sekunder (följer flikens slow motion och paus)
    update(dt) {
      time += dt;
      cu.time.value += dt;
      if (warmLeft > 0 && --warmLeft === 0 && picked) hint.textContent = `Click in the grass to place ${picked.label}`;
      // Förvärmda instanser döljs när deras shaders har kompilerats (annars lämnar delar som inte tonas, t.ex.
      // meteorens rök längs banan, spår vid origo)
      for (const inst of [...pools.values()].flat()) if (inst.warm > 0 && --inst.warm === 0 && !inst.live) inst.group.visible = false;
      const wanted = [];
      for (const inst of liveList()) {
        if (!inst.ready) { start(inst); continue; }
        if (time - inst.born > inst.life) { retire(inst); continue; }
        const p = inst.group.position;
        inst.fx.update(time, { camera, wind: windAt ? windAt(p.x, p.z) : [0, 0, 0] });
        for (const l of inst.lights) if (l.intensity > 0.01) wanted.push(l);
      }
      wanted.sort((a, b) => b.intensity - a.intensity);
      LIGHTS.forEach((L, i) => {
        const w = wanted[i];
        if (!w) { L.intensity = 0; return; }
        w.userData.parent.updateWorldMatrix(true, false);
        L.position.copy(w.position).applyMatrix4(w.userData.parent.matrixWorld);
        L.color.copy(w.color); L.intensity = w.intensity; L.distance = w.distance; L.decay = w.decay;
      });
    },
    count: () => liveList().length,
    shown: () => [...pools.values()].flat().filter((i) => i.group.visible).length, // för prov: grupper som syns
    spawn: (id, at) => { const it = groups.flatMap((g) => g.items).find((x) => x.id === id); if (it) spawn(it, at); }, // för prov
    items: () => groups.flatMap((g) => g.items.map((x) => x.id)),
  };
}
