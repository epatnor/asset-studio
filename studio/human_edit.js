// Redigeringsläget i The Character Creator (docs/asset-studio.md, tools/character/human/EDITS.md): Patrik drar själv i
// en MPFB-figurs punkter. Nätet ritas ur figurens <namn>_edit.json (hörnen i bygget egen ordning, i vila och i
// inpassningens pose), och allt lagras som förflyttning i vila: en dragning i posen räknas om med pose_to_rest.
// Verktygen kommer från Body Editor (tools/character/body/editor/), utan topologiverktygen (topologin är gemensam):
// Point (välj flera, flytta med falloff), Brush (mjuk pensel), Smooth, In/out längs normalen, spegling i x, See through,
// platta vyer (1/3/7, Ctrl för motsatt sida, 5 för 3D) med låst vy, ångra och gör om, och referensbilder bakom.
// Save skriver en ny ändringsfil (build/human/edits/<namn>_v<n>.json, aldrig över) och bygger om till ett nytt namn.
// Texten i appen är på engelska.
import * as THREE from 'three';

const FIG = '#c9a58e', HEAT = new THREE.Color('#e0507a'), SEL = new THREE.Color('#ffd04a'), DOT = new THREE.Color('#2b2f36');

export function createPointEditor({ el, api, side, view, scene, renderer, controls, persp, setCam, getCam, hideFigure, aiShow, onSaved, say }) {
  // --- Läget ---
  let D = null, name = null, recipeOk = false;         // editorfilen och figurens namn
  let N = 0, F = null, M = null, MI = null, base = null; // hörn, trianglar, pose_to_rest och dess invers, base_rest
  let rest = null, pose = null, mirror = null, nbr = null;
  let shape = 'pose', tool = 'point', active = false, dirty = false;
  let restLift = 0; // vilans hörn ligger i den riggade figurens nätrum (fötterna under marken): lyfts till marken när de visas
  const P = { radius: 3, hard: 0.3, strength: 0.5, falloff: true, mirror: true, see: false, lock: false, ai: false };
  const selected = new Set();
  const undo = [], redo = [];

  // --- Nätet, punkterna och penselns ring ---
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.62, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  const dotGeo = new THREE.BufferGeometry();
  const dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true, depthTest: true }));
  dots.renderOrder = 3;
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 48 }, (_, i) => new THREE.Vector3(Math.cos(i / 48 * Math.PI * 2), Math.sin(i / 48 * Math.PI * 2), 0))),
    new THREE.LineBasicMaterial({ color: '#e0507a', depthTest: false }));
  ring.renderOrder = 4; ring.visible = false;
  const boxEl = el('div', 'hu-box');
  boxEl.hidden = true;
  view.append(boxEl);
  const group = new THREE.Group();
  group.add(mesh, dots, ring);
  group.visible = false;
  scene.add(group);

  // --- Den platta kameran (1/3/7) ---
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 50);
  let viewName = '3d';
  function frameOrtho() {
    const a = innerWidth / innerHeight, h = 1.15 / ortho.zoom;
    Object.assign(ortho, { left: -h * a, right: h * a, top: h, bottom: -h });
    ortho.updateProjectionMatrix();
  }
  const VIEWS = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0] };
  function setView(v) {
    viewName = v;
    const t = new THREE.Vector3(0, figTop() * 0.55, 0);
    if (v === '3d') { setCam(persp); persp.position.set(0.9, 1.3, 4.6); controls.target.copy(t); }
    else {
      ortho.zoom = 1; frameOrtho();
      ortho.up.set(0, v === 'top' || v === 'bottom' ? 0 : 1, v === 'top' ? -1 : v === 'bottom' ? 1 : 0);
      ortho.position.copy(t).addScaledVector(new THREE.Vector3(...VIEWS[v]), 10);
      setCam(ortho);
      controls.target.copy(t);
    }
    getCam().lookAt(controls.target);
    controls.update();
    setLock(v !== '3d');
    for (const b of viewBtns.querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === v);
    placeRefs();
  }
  function setLock(on) {
    P.lock = on;
    controls.enableRotate = !on;
    controls.mouseButtons.LEFT = on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    lockBox && (lockBox.checked = on);
  }
  const figTop = () => { if (!rest) return 1.7; let m = -Infinity; const X = cur(); for (let i = 1; i < X.length; i += 3) m = Math.max(m, X[i]); return m + (shape === 'rest' ? restLift : 0); };

  // --- Data ---
  const cur = () => (shape === 'pose' ? pose : rest);
  async function open(fig) {
    say(`Loading ${fig.name} for editing…`);
    const d = await fetch(`${fig.edit}?v=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!d?.faces) { say(`${fig.name} has no editor file (only fitted figures with a wrap have one)`); return false; }
    D = d; name = fig.name; recipeOk = !!fig.recipe;
    N = d.nverts; F = Uint32Array.from(d.faces); base = Float32Array.from(d.base_rest);
    rest = Float32Array.from(d.rest); pose = Float32Array.from(d.pose); M = Float32Array.from(d.pose_to_rest);
    MI = new Float32Array(9 * N);
    for (let i = 0; i < N; i++) MI.set(inv3(M.subarray(9 * i, 9 * i + 9)), 9 * i);
    // Grannar och spegelpar (MPFB-proxyn är symmetrisk: paren räknas ur viloläget före ändringarna)
    const nb = Array.from({ length: N }, () => new Set());
    for (let t = 0; t < F.length; t += 3) for (const [a, b] of [[F[t], F[t + 1]], [F[t + 1], F[t + 2]], [F[t + 2], F[t]]]) { nb[a].add(b); nb[b].add(a); }
    nbr = nb.map((s) => Int32Array.from(s));
    mirror = new Int32Array(N).fill(-1);
    const key = (x, y, z) => `${Math.round(x * 2000)},${Math.round(y * 2000)},${Math.round(z * 2000)}`, at = new Map();
    for (let i = 0; i < N; i++) at.set(key(base[3 * i], base[3 * i + 1], base[3 * i + 2]), i);
    let paired = 0;
    for (let i = 0; i < N; i++) {
      if (Math.abs(base[3 * i]) < 2e-4) { mirror[i] = i; paired++; continue; }
      let j = at.get(key(-base[3 * i], base[3 * i + 1], base[3 * i + 2]));
      if (j === undefined) { // närmaste inom 1 mm
        let best = 1e-6;
        for (let k = 0; k < N; k++) { const dx = base[3 * k] + base[3 * i], dy = base[3 * k + 1] - base[3 * i + 1], dz = base[3 * k + 2] - base[3 * i + 2], d2 = dx * dx + dy * dy + dz * dz; if (d2 < best) { best = d2; j = k; } }
      }
      if (j !== undefined) { mirror[i] = j; paired++; }
    }
    selected.clear(); undo.length = 0; redo.length = 0; dirty = false;
    geo.setIndex(new THREE.BufferAttribute(F, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * N), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * N), 3));
    dotGeo.setAttribute('position', geo.getAttribute('position'));
    dotGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * N), 3));
    let minY = Infinity;
    for (let i = 1; i < rest.length; i += 3) minY = Math.min(minY, rest[i]);
    restLift = -minY;
    stats.paired = paired;
    show();
    return true;
  }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C || 1e-9;
    return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
  }
  const mul = (Ms, i, v) => { const o = 9 * i; return [Ms[o] * v[0] + Ms[o + 1] * v[1] + Ms[o + 2] * v[2], Ms[o + 3] * v[0] + Ms[o + 4] * v[1] + Ms[o + 5] * v[2], Ms[o + 6] * v[0] + Ms[o + 7] * v[1] + Ms[o + 8] * v[2]]; };

  // Visningen: hörnen ur den valda formen, färgen (penselns räckvidd i rosa) och punkterna (de valda gula)
  let heat = null;
  function show() {
    const pos = geo.getAttribute('position');
    pos.array.set(cur());
    pos.needsUpdate = true;
    group.position.y = shape === 'rest' ? restLift : 0;
    group.updateMatrixWorld(true);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    paint();
  }
  function paint() {
    const c = geo.getAttribute('color'), dc = dotGeo.getAttribute('color'), base_ = new THREE.Color(FIG), tmp = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const w = heat?.get(i) ?? 0;
      tmp.copy(base_).lerp(HEAT, w * 0.75);
      c.setXYZ(i, tmp.r, tmp.g, tmp.b);
      const s = selected.has(i) ? SEL : DOT;
      dc.setXYZ(i, s.r, s.g, s.b);
    }
    c.needsUpdate = true; dc.needsUpdate = true;
    dots.visible = tool === 'point';
    mat.transparent = P.see; mat.opacity = P.see ? 0.45 : 1; mat.depthWrite = !P.see;
    dots.material.depthTest = !P.see;
    updateInfo();
  }

  // --- Att flytta: allt går via förflyttningen i vila (rd); posen följer med inversen ---
  function applyRest(i, rd) {
    rest[3 * i] += rd[0]; rest[3 * i + 1] += rd[1]; rest[3 * i + 2] += rd[2];
    const pd = mul(MI, i, rd);
    pose[3 * i] += pd[0]; pose[3 * i + 1] += pd[1]; pose[3 * i + 2] += pd[2];
  }
  // deltas: Map hörn -> förflyttning i den visade formen. Speglingen: egen och tvillingens speglade förflyttning, i medel
  function move(deltas) {
    const R = new Map();
    for (const [i, d] of deltas) R.set(i, shape === 'pose' ? mul(M, i, d) : d);
    const out = new Map();
    if (P.mirror) {
      const touched = new Set();
      for (const i of R.keys()) { touched.add(i); if (mirror[i] >= 0) touched.add(mirror[i]); }
      for (const i of touched) {
        const own = R.get(i), j = mirror[i], tw = j >= 0 ? R.get(j) : undefined, mt = tw ? [-tw[0], tw[1], tw[2]] : null;
        let rd = own && mt ? [(own[0] + mt[0]) / 2, (own[1] + mt[1]) / 2, (own[2] + mt[2]) / 2] : own ?? mt;
        if (!rd) continue;
        if (j === i) rd = [0, rd[1], rd[2]];
        out.set(i, rd);
      }
    } else for (const [i, rd] of R) out.set(i, rd);
    for (const [i, rd] of out) applyRest(i, rd);
    dirty = true;
    show();
  }
  function snapshot() { undo.push({ rest: rest.slice(), pose: pose.slice() }); if (undo.length > 60) undo.shift(); redo.length = 0; updateInfo(); }
  function step(from, to) {
    const s = from.pop();
    if (!s) return;
    to.push({ rest: rest.slice(), pose: pose.slice() });
    rest = s.rest; pose = s.pose; dirty = true;
    show();
  }

  // Räckvidden längs ytan (som Body Editor): 1 vid fröna, ned till 0 vid penselns kant; hardness är den fasta kärnan
  const falloff = (t) => { if (t <= P.hard) return 1; const s = (1 - t) / (1 - P.hard); return s * s * (3 - 2 * s); };
  function reach(seeds, radius) {
    const X = cur(), dist = new Map(seeds.map((v) => [v, 0])), queue = [...seeds];
    while (queue.length) {
      let bi = 0;
      for (let k = 1; k < queue.length; k++) if (dist.get(queue[k]) < dist.get(queue[bi])) bi = k;
      const v = queue.splice(bi, 1)[0];
      for (const n of nbr[v]) {
        const s = Math.hypot(X[3 * v] - X[3 * n], X[3 * v + 1] - X[3 * n + 1], X[3 * v + 2] - X[3 * n + 2]), t = dist.get(v) + s;
        if (t < radius && t < (dist.get(n) ?? Infinity)) { if (!dist.has(n)) queue.push(n); dist.set(n, t); }
      }
    }
    return dist;
  }
  function influence(seeds, withFalloff = true) {
    const w = new Map();
    if (!withFalloff) { for (const v of seeds) w.set(v, 1); return w; }
    const r = P.radius / 100;
    for (const [v, d] of reach(seeds, r)) w.set(v, falloff(d / r));
    return w;
  }

  // --- Att peka ---
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function aim(e) { const b = renderer.domElement.getBoundingClientRect(); ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1); ray.setFromCamera(ndc, getCam()); }
  function hitAt(e) { aim(e); return ray.intersectObject(mesh, false)[0] ?? null; }
  const vpos = (i) => { const X = cur(); return new THREE.Vector3(X[3 * i], X[3 * i + 1], X[3 * i + 2]).applyMatrix4(group.matrixWorld); };
  function screenOf(i) { const b = renderer.domElement.getBoundingClientRect(), p = vpos(i).project(getCam()); return [b.left + (p.x + 1) / 2 * b.width, b.top + (1 - p.y) / 2 * b.height, p.z]; }
  function nearestCorner(h) { const f = h.face; let best = f.a, bd = Infinity; for (const v of [f.a, f.b, f.c]) { const d = vpos(v).distanceToSquared(h.point); if (d < bd) { bd = d; best = v; } } return best; }
  // Punkten under muspekaren: närmast på skärmen inom 12 px, bland de synliga (eller alla med See through)
  function pointUnder(e) {
    if (!P.see) { const h = hitAt(e); if (!h) return -1; const v = nearestCorner(h); const [x, y] = screenOf(v); return Math.hypot(x - e.clientX, y - e.clientY) < 14 ? v : -1; }
    let best = -1, bd = 14;
    for (let i = 0; i < N; i++) { const [x, y, z] = screenOf(i); if (z > 1) continue; const d = Math.hypot(x - e.clientX, y - e.clientY); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  // Var muspekaren träffar planet genom punkten p, vinkelrätt mot kameran
  function onPlane(e, p) {
    aim(e);
    const n = new THREE.Vector3(); getCam().getWorldDirection(n);
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p), o = new THREE.Vector3();
    return ray.ray.intersectPlane(pl, o) ? o : null;
  }
  function showRing(h) {
    if (!h || tool === 'point') { ring.visible = false; return; }
    ring.visible = true;
    ring.position.copy(h.point);
    const n = h.face.normal.clone().transformDirection(mesh.matrixWorld);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    ring.scale.setScalar(P.radius / 100);
  }

  let drag = null;
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', (e) => {
    if (!active || e.button !== 0) return;
    if (tool === 'point') {
      const v = pointUnder(e);
      if (v < 0) {
        if (e.shiftKey || e.ctrlKey) { drag = { kind: 'box', x: e.clientX, y: e.clientY, remove: e.ctrlKey }; stop(e); }
        else if (!e.altKey && selected.size && !hitAt(e)) { /* klick utanför: vrid som vanligt */ }
        return;
      }
      if (e.ctrlKey) { selected.delete(v); if (P.mirror && mirror[v] >= 0) selected.delete(mirror[v]); paint(); stop(e); return; }
      if (!selected.has(v)) { if (!e.shiftKey) selected.clear(); selected.add(v); }
      else if (e.shiftKey) { /* redan vald */ }
      paint();
      const w = influence([...selected], P.falloff);
      heat = P.falloff ? w : null;
      snapshot();
      drag = { kind: 'move', w, from: onPlane(e, vpos(v)), anchor: vpos(v) };
      stop(e);
    } else {
      const h = hitAt(e);
      if (!h) return;
      snapshot();
      const v = nearestCorner(h), w = influence([v]);
      heat = w;
      drag = tool === 'brush' ? { kind: 'move', w, from: onPlane(e, h.point), anchor: h.point.clone() } : { kind: tool, y: e.clientY, x: e.clientX, last: performance.now() };
      paint();
      stop(e);
    }
  }, { capture: true });
  dom.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (drag && e.buttons === 0) { end(); return; }
    if (!drag) {
      if (tool === 'point') { const v = pointUnder(e); dom.style.cursor = v >= 0 ? 'grab' : ''; }
      else { const h = hitAt(e); showRing(h); dom.style.cursor = h ? 'crosshair' : ''; }
      return;
    }
    if (drag.kind === 'box') { const x0 = Math.min(drag.x, e.clientX), y0 = Math.min(drag.y, e.clientY), b = view.getBoundingClientRect(); Object.assign(boxEl.style, { left: `${x0 - b.left}px`, top: `${y0 - b.top}px`, width: `${Math.abs(e.clientX - drag.x)}px`, height: `${Math.abs(e.clientY - drag.y)}px` }); boxEl.hidden = false; drag.x1 = e.clientX; drag.y1 = e.clientY; return; }
    if (drag.kind === 'move') {
      const to = onPlane(e, drag.anchor);
      if (!to || !drag.from) return;
      const d = to.clone().sub(drag.from);
      drag.from = to;
      const deltas = new Map();
      for (const [i, w] of drag.w) deltas.set(i, [d.x * w, d.y * w, d.z * w]);
      move(deltas);
      return;
    }
    const h = hitAt(e);
    if (h) showRing(h);
    if (drag.kind === 'smooth') {
      if (!h) return;
      const w = influence([nearestCorner(h)]), X = cur(), deltas = new Map();
      heat = w;
      for (const [i, wi] of w) {
        const n = nbr[i]; let ax = 0, ay = 0, az = 0;
        for (const k of n) { ax += X[3 * k]; ay += X[3 * k + 1]; az += X[3 * k + 2]; }
        const s = wi * P.strength * 0.5;
        deltas.set(i, [(ax / n.length - X[3 * i]) * s, (ay / n.length - X[3 * i + 1]) * s, (az / n.length - X[3 * i + 2]) * s]);
      }
      move(deltas);
    } else if (drag.kind === 'inout') {
      // Uppåt drar ut, nedåt trycker in, längs varje hörns normal; en millimeter per fyra bildpunkter gånger styrkan
      const dy = drag.y - e.clientY;
      drag.y = e.clientY;
      const amt = dy * 0.00025 * P.strength * 2, nrm = geo.getAttribute('normal'), deltas = new Map();
      for (const [i, wi] of heat) deltas.set(i, [nrm.getX(i) * amt * wi, nrm.getY(i) * amt * wi, nrm.getZ(i) * amt * wi]);
      move(deltas);
    }
  });
  function end() {
    if (drag?.kind === 'box' && drag.x1 !== undefined) {
      const x0 = Math.min(drag.x, drag.x1), x1 = Math.max(drag.x, drag.x1), y0 = Math.min(drag.y, drag.y1), y1 = Math.max(drag.y, drag.y1);
      const front = P.see ? null : visibleSet();
      for (let i = 0; i < N; i++) {
        const [x, y, z] = screenOf(i);
        if (z > 1 || x < x0 || x > x1 || y < y0 || y > y1 || (front && !front.has(i))) continue;
        if (drag.remove) selected.delete(i); else selected.add(i);
        if (P.mirror && mirror[i] >= 0) { if (drag.remove) selected.delete(mirror[i]); else selected.add(mirror[i]); }
      }
    }
    boxEl.hidden = true;
    if (drag?.kind === 'move' || drag?.kind === 'smooth' || drag?.kind === 'inout') { heat = tool === 'point' && P.falloff ? null : null; }
    drag = null;
    paint();
  }
  // De hörn som syns (inte skymda): en stråle mot varje hörn ska träffa nätet nära hörnet
  function visibleSet() {
    const s = new Set(), cam = getCam(), cp = cam.getWorldPosition(new THREE.Vector3());
    for (let i = 0; i < N; i++) {
      const p = vpos(i), dir = cam.isOrthographicCamera ? cam.getWorldDirection(new THREE.Vector3()) : p.clone().sub(cp).normalize();
      const o = cam.isOrthographicCamera ? p.clone().addScaledVector(dir, -5) : cp;
      ray.set(o, dir);
      const h = ray.intersectObject(mesh, false)[0];
      if (h && h.point.distanceTo(p) < 0.004) s.add(i);
    }
    return s;
  }
  addEventListener('pointerup', () => { if (active && drag) end(); });
  const stop = (e) => { e.stopImmediatePropagation(); e.preventDefault(); controls.enabled = false; setTimeout(() => { controls.enabled = true; }, 0); };
  dom.addEventListener('pointerleave', () => { ring.visible = false; });
  addEventListener('keydown', (e) => {
    if (!active || e.target.closest?.('input, select, textarea')) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? step(redo, undo) : step(undo, redo); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); step(redo, undo); return; }
    if (k === 'Escape') { selected.clear(); heat = null; paint(); }
    else if (k === '1' || e.code === 'Numpad1') setView(e.ctrlKey ? 'back' : 'front');
    else if (k === '3' || e.code === 'Numpad3') setView(e.ctrlKey ? 'left' : 'right');
    else if (k === '7' || e.code === 'Numpad7') setView(e.ctrlKey ? 'bottom' : 'top');
    else if (k === '5' || k === '0') setView('3d');
    else if (k === '[') { P.radius = Math.max(0.5, P.radius / 1.25); cardsSync(); }
    else if (k === ']') { P.radius = Math.min(15, P.radius * 1.25); cardsSync(); }
    else if (k.toLowerCase() === 'l') setLock(!P.lock);
    else if (k.toLowerCase() === 'x') { P.see = !P.see; cardsSync(); paint(); }
  });

  // --- Referensbilder bakom figuren (framifrån och från sidan) ---
  const refs = {};
  const tl = new THREE.TextureLoader();
  const RP = { opacity: 0.6, size: 1.12, height: 0 };
  function setRef(slot, file) {
    const url = URL.createObjectURL(file);
    tl.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      refs[slot]?.removeFromParent();
      const m = new THREE.Mesh(new THREE.PlaneGeometry(t.image.width / t.image.height, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: RP.opacity, depthWrite: false, side: THREE.DoubleSide }));
      m.renderOrder = -1;
      refs[slot] = m;
      scene.add(m);
      placeRefs();
    });
  }
  function placeRefs() {
    const h = figTop();
    for (const [slot, m] of Object.entries(refs)) {
      m.scale.setScalar(h * RP.size);
      m.material.opacity = RP.opacity;
      if (slot === 'front') { m.position.set(0, h * RP.size / 2 + RP.height, -0.6); m.rotation.set(0, 0, 0); }
      else { m.position.set(-0.6, h * RP.size / 2 + RP.height, 0); m.rotation.set(0, Math.PI / 2, 0); }
      m.visible = active && ((slot === 'front' && (viewName === 'front' || viewName === 'back')) || (slot === 'side' && (viewName === 'right' || viewName === 'left')));
    }
  }

  // --- Kortet ---
  let lockBox = null, cardsSync = () => {};
  const stats = { paired: 0 };
  const card = el('section', 'card glass hu-edit');
  card.style.setProperty('--part', '#e0507a');
  const head = el('header'); head.append(el('h2', null, 'Edit points'));
  const rows = el('div', 'rows');
  card.append(head, rows);
  const seg = (label, items, get, set, help) => {
    const row = el('div', 'row span2'), s = el('div', 'seg hu-seg');
    if (help) row.title = help;
    const bs = items.map(([id, text, tip]) => { const b = el('button', null, text); b.dataset.id = id; if (tip) b.title = tip; b.onclick = () => { set(id); sync(); }; s.append(b); return b; });
    const sync = () => { for (const b of bs) b.classList.toggle('on', b.dataset.id === get()); };
    syncs.push(sync);
    row.append(el('label', null, label), s);
    return row;
  };
  const syncs = [];
  const slider = (label, key, min, max, stepV, help, obj = P, onSet) => {
    const row = el('div', 'row'), r = Object.assign(el('input'), { type: 'range', min, max, step: stepV }), out = el('output');
    if (help) row.title = help;
    const dec = stepV >= 1 ? 0 : stepV >= 0.1 ? 1 : 2;
    const sync = () => { r.value = obj[key]; out.textContent = Number(obj[key]).toFixed(dec); };
    r.oninput = () => { obj[key] = Number(r.value); out.textContent = Number(r.value).toFixed(dec); onSet?.(); };
    syncs.push(sync);
    row.append(el('label', null, label), r, out);
    return row;
  };
  const toggle = (label, sub, key, help, onSet) => {
    const row = el('div', 'row span2'), box = el('input', 'switch'), lab = el('label', 'twoline');
    box.type = 'checkbox';
    lab.append(document.createTextNode(label), el('small', null, sub));
    if (help) row.title = help;
    syncs.push(() => { box.checked = !!P[key]; });
    box.onchange = () => { P[key] = box.checked; onSet?.(box.checked); };
    row.append(lab, box);
    if (key === 'lock') lockBox = box;
    return row;
  };
  cardsSync = () => { for (const s of syncs) s(); };
  const viewBtns = el('div', 'seg hu-seg');
  for (const [id, text, tip] of [['3d', '3D', '5'], ['front', 'Front', '1 (Ctrl+1 back)'], ['right', 'Side', '3 (Ctrl+3 the other side)'], ['top', 'Top', '7 (Ctrl+7 bottom)']]) {
    const b = el('button', null, text); b.dataset.view = id; b.title = `Key ${tip}`; b.onclick = () => setView(id); viewBtns.append(b);
  }
  const viewRow = el('div', 'row span2'); viewRow.append(el('label', null, 'View'), viewBtns);
  const refFile = Object.assign(el('input'), { type: 'file', accept: 'image/*', hidden: true });
  let refSlot = 'front';
  refFile.onchange = () => { if (refFile.files[0]) setRef(refSlot, refFile.files[0]); refFile.value = ''; };
  const refBtns = el('div', 'hu-btns');
  for (const [slot, text] of [['front', 'Front image…'], ['side', 'Side image…']]) {
    const b = el('button', null, text);
    b.title = `A reference picture behind the figure, seen in the ${slot === 'front' ? 'front (1)' : 'side (3)'} view`;
    b.onclick = () => { refSlot = slot; refFile.click(); };
    refBtns.append(b);
  }
  refBtns.append(refFile);
  const undoBtn = el('button', null, 'Undo'), redoBtn = el('button', null, 'Redo');
  undoBtn.title = 'Ctrl+Z'; redoBtn.title = 'Ctrl+Shift+Z';
  undoBtn.onclick = () => step(undo, redo); redoBtn.onclick = () => step(redo, undo);
  const histRow = el('div', 'hu-btns'); histRow.append(undoBtn, redoBtn);
  const info_ = el('div', 'note');
  const saveBtn = el('button', 'primary', 'Save edits and build');
  saveBtn.title = 'Writes the edits as a new file (build/human/edits/<name>_v<n>.json, never overwritten) and builds the figure again under a new name';
  const doneBtn = el('button', null, 'Close the editor');
  const endRow = el('div', 'hu-btns'); endRow.append(saveBtn, doneBtn);
  const msg = el('div', 'note');
  rows.append(
    seg('Shape', [['pose', 'Pose', 'The fit\'s pose, like the AI shape (moves are converted to the rest pose)'], ['rest', 'Rest', 'The rest pose the rig is built on']], () => shape, (v) => { shape = v; heat = null; show(); placeAi(); }),
    seg('Tool', [['point', 'Point', 'Click, Shift+click or Shift+drag a box to select points, then drag one of them'], ['brush', 'Brush', 'Soft brush: drag the surface'], ['smooth', 'Smooth', 'Drag over bumps to even them out'], ['inout', 'In/out', 'Drag up to pull the surface out, down to push it in, along the normals']],
      () => tool, (v) => { tool = v; heat = null; ring.visible = false; paint(); }),
    slider('Radius (cm)', 'radius', 0.5, 15, 0.1, 'The brush or falloff radius, along the surface ([ and ])', P),
    slider('Hardness', 'hard', 0, 0.95, 0.01, 'How much of the radius moves fully before it softens'),
    slider('Strength', 'strength', 0.05, 1, 0.01, 'How hard Smooth and In/out work'),
    toggle('Falloff', 'neighbours follow', 'falloff', 'Point: the points around the selection follow within the radius'),
    toggle('Mirror in x', 'both sides move', 'mirror', 'Moves the twin on the other side too (pairs from the symmetric MPFB mesh)'),
    toggle('See through', 'pick hidden points (X)', 'see', 'The mesh turns see-through, and points behind it can be picked', () => paint()),
    toggle('Show the AI shape', 'as a ghost (Pose)', 'ai', 'The fit\'s AI shape as a ghost over the figure (Pose only)', () => placeAi()),
    viewRow,
    toggle('Lock view', 'drag pans (L)', 'lock', 'Stops the view from turning; the flat views lock by themselves', (v) => setLock(v)),
    refBtns,
    slider('Picture opacity', 'opacity', 0.1, 1, 0.01, 'How strongly the reference pictures show', RP, placeRefs),
    slider('Picture size', 'size', 0.5, 2, 0.01, 'The reference pictures\' height compared with the figure', RP, placeRefs),
    slider('Picture height', 'height', -0.5, 0.5, 0.01, 'Moves the reference pictures up or down (m)', RP, placeRefs),
    histRow, info_, endRow, msg,
  );
  function placeAi() { aiShow(active && P.ai && shape === 'pose'); }
  function updateInfo() {
    if (!rest) return;
    let moved = 0, max = 0;
    for (let i = 0; i < N; i++) { const d = Math.hypot(rest[3 * i] - D.rest[3 * i], rest[3 * i + 1] - D.rest[3 * i + 1], rest[3 * i + 2] - D.rest[3 * i + 2]); if (d > 1e-5) moved++; max = Math.max(max, d); }
    info_.textContent = `${name}: ${N.toLocaleString('en')} points, ${stats.paired.toLocaleString('en')} mirrored · ${selected.size} selected · ${moved} moved this session, at most ${(max * 1000).toFixed(1)} mm`;
    undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length;
    saveBtn.disabled = !dirty || !recipeOk;
    if (!recipeOk) saveBtn.title = `${name} has no recipe, so it cannot be built again; open a figure with a recipe`;
  }
  saveBtn.onclick = async () => {
    const offsets = new Array(3 * N);
    for (let k = 0; k < 3 * N; k++) offsets[k] = Math.round((rest[k] - base[k]) * 1e6) / 1e6;
    saveBtn.disabled = true;
    msg.textContent = 'Saving the edits…';
    const r = await api('/api/human/edits', { name, proxy: D.proxy, nverts: N, offsets });
    if (r.error) { msg.textContent = `Not saved: ${r.error}`; saveBtn.disabled = false; return; }
    msg.textContent = `Saved ${r.file}; building ${r.name}…`;
    const res = await onSaved(r);
    if (res?.glb) { dirty = false; msg.textContent = `Built ${r.name} with the edits (${r.file})`; }
    else msg.textContent = `The build failed: ${res?.error ?? 'no model'}`;
    updateInfo();
  };
  doneBtn.onclick = () => { if (dirty && !confirm('Close the editor and drop the unsaved edits?')) return; close(); };
  side.prepend(card);
  card.hidden = true;

  function close() {
    active = false; group.visible = false; card.hidden = true; ring.visible = false; heat = null;
    side.classList.remove('hu-editing');
    hideFigure(false); aiShow(null);
    setView('3d'); setLock(false);
    for (const m of Object.values(refs)) m.visible = false;
  }
  return {
    async start(fig) {
      if (!(await open(fig))) return false;
      active = true; group.visible = true; card.hidden = false;
      side.classList.add('hu-editing');
      side.scrollTop = 0;
      hideFigure(true);
      cardsSync();
      setView('3d');
      placeAi();
      say(`Editing ${fig.name}: drag points, or pick a brush in the Edit points card`);
      return true;
    },
    close, get active() { return active; }, get dirty() { return dirty; },
    resize() { frameOrtho(); },
    // För prov: flytta hörn i den visade formen (deltas: [[hörn, [dx, dy, dz]], ...]), läs hörnen, spegelparet, skärmläget
    test: {
      move: (list) => { snapshot(); move(new Map(list)); }, rest: (i) => [rest[3 * i], rest[3 * i + 1], rest[3 * i + 2]], pose: (i) => [pose[3 * i], pose[3 * i + 1], pose[3 * i + 2]],
      base: (i) => [base[3 * i], base[3 * i + 1], base[3 * i + 2]], twin: (i) => mirror[i], screen: (i) => screenOf(i), get n() { return N; }, get selected() { return [...selected]; },
      set: (k, v) => { if (k === 'shape') shape = v; else if (k === 'tool') tool = v; else P[k] = v; cardsSync(); show(); }, undo: () => step(undo, redo), setView,
      bbox: () => { const X = cur(), lift = shape === 'rest' ? restLift : 0, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) { const v = X[3 * i + k] + (k === 1 ? lift : 0); lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); } return [lo, hi]; },
      find: (fn) => { const out = []; for (let i = 0; i < N; i++) { const p = vpos(i); if (fn(p.x, p.y, p.z, i)) out.push(i); } return out; },
    },
  };
}
