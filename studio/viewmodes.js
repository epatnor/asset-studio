// A Blender-style viewport shading selector: a small bar on the 3D view of its own, apart from the cards, that
// switches how the models are drawn (wireframe, clay, matcap, normals, UV checker, albedo, material), with two
// overlays (edges on top, X-ray). Z opens a pie menu at the pointer (as in Blender), Shift+Z toggles the edges and
// Alt+Z the X-ray. Only the display changes: the models' own materials are kept in userData.own and come back in
// Material. The choice is remembered per viewer and view (localStorage). Used by The Character Creator
// (studio/human.js), the Forge (studio/studio.js) and The Map Room (studio/terrain.js, WebGPU: pass its THREE).
import * as THREE_GL from 'three';

const ALL = [
  { id: 'wire', label: 'Wireframe', help: 'The mesh\'s edges only' },
  { id: 'clay', label: 'Clay', help: 'One neutral material, lit: the shape only' },
  { id: 'matcap', label: 'Matcap', help: 'A studio sphere around the model: reads the form and its normal map, whatever the light' },
  { id: 'normals', label: 'Normals', help: 'The surface\'s direction as colour (view space), with the normal map' },
  { id: 'uv', label: 'UV checker', help: 'A checker on the UV: stretching and seams show' },
  { id: 'albedo', label: 'Albedo', help: 'The colour map as it is, without light' },
  { id: 'material', label: 'Material', help: 'The model\'s own materials, lit' },
];

// Small sphere icons in the spirit of Blender's shading buttons
const ICON = {
  wire: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.6" ry="6"/><path d="M2 8h12M3 5h10M3 11h10"/>',
  clay: '<circle cx="8" cy="8" r="6" fill="currentColor" stroke="none"/>',
  matcap: '<circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" opacity=".55"/><circle cx="6" cy="6" r="2.2" fill="currentColor" stroke="none"/>',
  normals: '<circle cx="8" cy="8" r="6"/><path d="M8 8l-3.5-3.5M8 8l4-1M8 8l1 4.5" stroke-linecap="round"/>',
  uv: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 8h11M8 2.5v11" /><rect x="2.5" y="2.5" width="5.5" height="5.5" fill="currentColor" stroke="none"/><rect x="8" y="8" width="5.5" height="5.5" fill="currentColor" stroke="none"/>',
  albedo: '<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none"/>',
  material: '<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 0 0 12" fill="currentColor" stroke="none" opacity=".5"/><circle cx="10.5" cy="5.5" r="1.4" fill="currentColor" stroke="none"/>',
  edges: '<path d="M2 12L8 3l6 9z"/><path d="M8 3v9M5 7.5h6"/>',
  xray: '<rect x="2" y="4" width="8" height="8" rx="1" opacity=".55"/><rect x="6" y="2" width="8" height="8" rx="1"/>',
};
const svg = (id) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3">${ICON[id]}</svg>`;

const canvas = (n) => { const c = document.createElement('canvas'); c.width = c.height = n; return c; };
// A clay-coloured studio matcap: a lit sphere with a soft key from the upper left, a dark rim and a little bounce below
function drawMatcap() {
  const c = canvas(256), g = c.getContext('2d');
  let r = g.createRadialGradient(96, 84, 6, 128, 128, 128);
  r.addColorStop(0, '#fbeee2'); r.addColorStop(0.35, '#d9b8a2'); r.addColorStop(0.8, '#8a6a58'); r.addColorStop(1, '#3d2f28');
  g.fillStyle = r; g.beginPath(); g.arc(128, 128, 128, 0, Math.PI * 2); g.fill();
  r = g.createRadialGradient(150, 225, 4, 150, 225, 90);
  r.addColorStop(0, 'rgba(190,200,215,0.45)'); r.addColorStop(1, 'rgba(190,200,215,0)');
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  return c;
}
// The normals as a matcap: each point of the disc is the view-space normal pointing there, as colour (n × 0.5 + 0.5).
// A matcap rather than MeshNormalMaterial, so that it takes the alpha of leaf cards like the other modes
function drawNormalcap() {
  const n = 128, c = canvas(n), g = c.getContext('2d'), img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n * 2 - 1, v = 1 - (y + 0.5) / n * 2, z = Math.sqrt(Math.max(0, 1 - u * u - v * v)), k = (y * n + x) * 4;
    const l = Math.hypot(u, v, z) || 1;
    img.data[k] = (u / l * 0.5 + 0.5) * 255; img.data[k + 1] = (v / l * 0.5 + 0.5) * 255; img.data[k + 2] = (z / l * 0.5 + 0.5) * 255; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
// A UV checker: grey squares, with a coloured line every fourth square so that rotated and mirrored islands show
function drawChecker() {
  const n = 16, s = 32, c = canvas(n * s), g = c.getContext('2d');
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = (x + y) % 2 ? '#8c9096' : '#d7dade'; g.fillRect(x * s, y * s, s, s); }
  g.lineWidth = 3;
  for (let i = 0; i <= n; i += 4) {
    g.strokeStyle = '#d94b4b'; g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, n * s); g.stroke();
    g.strokeStyle = '#3a7bd5'; g.beginPath(); g.moveTo(0, i * s); g.lineTo(n * s, i * s); g.stroke();
  }
  g.fillStyle = '#2b2b2b'; g.font = 'bold 20px sans-serif';
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) g.fillText(`${'ABCD'[x]}${4 - y}`, x * 4 * s + 6, y * 4 * s + 24);
  return c;
}

// WebGL only: the alpha map is read from the alpha channel (a leaf card's own colour map) instead of green
function alphaFromA(sh) { sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', '#ifdef USE_ALPHAMAP\n\tdiffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).a;\n#endif'); }
// WebGL only: the edges overlay is drawn a hair closer to the camera, so that it wins the depth test against its own
// surface (polygon offset does not apply to lines). The Map Room passes its own node material for WebGPU
function nearer(sh) { sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position.z -= 0.0006 * gl_Position.w;'); }

export function createViewModes({
  el, view, roots, three = THREE_GL, only = null, help = {}, keep = () => false, skip = () => false, cls = '',
  onChange = () => {}, active = () => true, storageKey = 'viewmodes', clay = null, edgeMaterial = null, initial = 'clay',
}) {
  const THREE = three;
  const MODES = ALL.filter((m) => !only || only.includes(m.id)).map((m, i) => ({ ...m, key: String(i + 1), help: help[m.id] ?? m.help }));
  const has = (id) => MODES.some((m) => m.id === id);
  const load = () => { try { return JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { return null; } };
  const saved = load() ?? {};
  const S = { mode: has(saved.mode) ? saved.mode : has(initial) ? initial : MODES[0].id, edges: !!saved.edges, xray: !!saved.xray, suspended: false };
  const store = () => { try { localStorage.setItem(storageKey, JSON.stringify({ mode: S.mode, edges: S.edges, xray: S.xray })); } catch { /* private window */ } };

  // --- The materials: shared ones per mode, and per-mesh ones where the own maps are needed ---
  const mine = new Set(); // every material made here (none of them belongs to the models)
  const mk = (m) => { mine.add(m); return m; };
  const tex = (c, srgb = true) => { const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; return t; };
  const matcap = tex(drawMatcap()), normalcap = tex(drawNormalcap(), false), checker = tex(drawChecker());
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  checker.anisotropy = 4;
  const shared = {
    clay: clay ?? mk(new THREE.MeshStandardMaterial({ color: '#c9a58e', roughness: 0.62, metalness: 0, side: THREE.DoubleSide })),
    wire: mk(new THREE.MeshBasicMaterial({ color: '#1f2328', wireframe: true })),
    uv: mk(new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8, side: THREE.DoubleSide })),
    edge: edgeMaterial ?? mk(new THREE.MeshBasicMaterial({ color: '#15181c', wireframe: true, transparent: true, opacity: 0.16, depthWrite: false })),
  };
  mine.add(shared.clay); mine.add(shared.edge);
  if (!edgeMaterial) { shared.edge.onBeforeCompile = nearer; shared.edge.customProgramCacheKey = () => 'vm-nearer'; }
  const xrayOf = new WeakMap();
  function xray(m) {
    let x = xrayOf.get(m);
    if (!x) {
      x = mk(m.clone());
      Object.assign(x, { transparent: true, opacity: Math.min(m.opacity ?? 1, 1) * 0.4, depthWrite: false, onBeforeCompile: m.onBeforeCompile, customProgramCacheKey: m.customProgramCacheKey });
      x.userData = { ...m.userData };
      xrayOf.set(m, x);
    }
    return x;
  }
  // A leaf card, a blade of grass: the own colour map has the shape in its alpha
  const cutout = (b) => !!b?.map && (b.alphaTest > 0 || b.transparent);
  // Per mesh: the model's own maps on a display material (normal map for matcap and normals, colour map for albedo,
  // the alpha of cut-out cards for every mode)
  function perMesh(o, mode) {
    const base = [o.userData.own].flat()[0] ?? {};
    o.userData.vm ??= {};
    if (o.userData.vm[mode]) return o.userData.vm[mode];
    const nm = base.normalMap ? { normalMap: base.normalMap, normalScale: base.normalScale?.clone?.() ?? new THREE.Vector2(1, 1) } : {};
    const cut = cutout(base) && mode !== 'albedo' ? { alphaMap: base.map, alphaTest: base.alphaTest || 0.5, side: base.side ?? THREE.DoubleSide } : null;
    let m;
    if (mode === 'clay') m = new THREE.MeshStandardMaterial({ color: shared.clay.color, roughness: shared.clay.roughness, metalness: 0, side: THREE.DoubleSide, ...cut });
    else if (mode === 'uv') m = new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8, side: THREE.DoubleSide, ...cut });
    else if (mode === 'matcap') m = new THREE.MeshMatcapMaterial({ matcap, side: THREE.DoubleSide, ...nm, ...cut });
    else if (mode === 'normals') m = new THREE.MeshMatcapMaterial({ matcap: normalcap, side: THREE.DoubleSide, toneMapped: false, ...nm, ...cut });
    else m = new THREE.MeshBasicMaterial({ map: base.map ?? null, color: base.color?.clone?.() ?? new THREE.Color('#ffffff'), side: base.side ?? THREE.FrontSide,
      transparent: !!base.transparent, alphaTest: base.alphaTest ?? 0, toneMapped: false });
    if (cut) { m.onBeforeCompile = alphaFromA; m.customProgramCacheKey = () => 'vm-alpha-a'; m.userData.vmAlpha = base.map; }
    o.userData.vm[mode] = mk(m);
    return m;
  }
  function materialFor(o, mode) {
    const base = [o.userData.own].flat()[0];
    if (mode === 'material' || ((mode === 'clay' || mode === 'matcap') && keep(o))) return o.userData.own;
    if (mode === 'wire') return shared.wire;
    if ((mode === 'clay' || mode === 'uv') && !cutout(base)) return shared[mode];
    return perMesh(o, mode);
  }

  // The edges overlay: a child sharing the geometry (and the skeleton and shape keys) with the wire material
  function setEdges(o, on) {
    let e = o.userData.vmEdge;
    if (!on) { if (e) { e.removeFromParent(); o.userData.vmEdge = null; } return; }
    if (e) return;
    if (o.isInstancedMesh) { e = new THREE.InstancedMesh(o.geometry, shared.edge, o.count); e.instanceMatrix = o.instanceMatrix; }
    else if (o.isSkinnedMesh) { e = new THREE.SkinnedMesh(o.geometry, shared.edge); e.bind(o.skeleton, o.bindMatrix); e.bindMode = o.bindMode; }
    else e = new THREE.Mesh(o.geometry, shared.edge);
    if (o.morphTargetInfluences) { e.morphTargetInfluences = o.morphTargetInfluences; e.morphTargetDictionary = o.morphTargetDictionary; }
    e.raycast = () => {};
    e.castShadow = e.receiveShadow = false;
    e.frustumCulled = o.frustumCulled;
    e.renderOrder = 3;
    e.userData.vmOverlay = true;
    o.userData.vmEdge = e;
    o.add(e);
  }

  // Applies the current mode to one root (or all): call it after a model is loaded, or after its own materials or
  // shadows were set again (the Forge's view, the Map Room's stage view)
  function apply(root) {
    const list = root ? [root] : roots().filter(Boolean);
    const mode = S.suspended ? 'material' : S.mode;
    const ghost = S.xray && !S.suspended && mode !== 'wire';
    for (const r of list) {
      const meshes = [];
      r.traverse((o) => { if (o.isMesh && !o.userData.vmOverlay) meshes.push(o); });
      for (const o of meshes) {
        o.userData.own ??= o.material;
        if (skip(o)) continue;
        let m = materialFor(o, mode);
        if (ghost) m = Array.isArray(m) ? m.map(xray) : xray(m);
        o.material = m;
        // Wireframe and X-ray cast no shadow; the model's own shadow comes back after
        if (mode === 'wire' || ghost) { o.userData.vmShadow ??= o.castShadow; o.castShadow = false; }
        else if (o.userData.vmShadow !== undefined) { o.castShadow = o.userData.vmShadow; delete o.userData.vmShadow; }
        setEdges(o, S.edges && !S.suspended && mode !== 'wire');
      }
    }
  }
  // A mesh gets a new own material (the Map Room's stage views): what was made from the old one is dropped
  function setOwn(o, m) {
    for (const x of Object.values(o.userData.vm ?? {})) { mine.delete(x); x.dispose(); }
    o.userData.vm = null;
    o.userData.own = m;
    o.material = m;
    apply(o);
  }
  // Drops what was made for a root's meshes (before the root is disposed); the root's own materials are left
  function release(root) {
    root?.traverse((o) => {
      if (!o.isMesh || o.userData.vmOverlay) return;
      for (const m of Object.values(o.userData.vm ?? {})) { mine.delete(m); m.dispose(); }
      o.userData.vm = null;
      setEdges(o, false);
      if (o.userData.own) o.material = o.userData.own;
      if (o.userData.vmShadow !== undefined) { o.castShadow = o.userData.vmShadow; delete o.userData.vmShadow; }
    });
  }

  // --- The bar ---
  const bar = el('div', `vm-bar glass ${cls}`.trim());
  const btns = {};
  const modeGroup = el('div', 'vm-group');
  for (const m of MODES) {
    const b = el('button', 'vm-btn');
    b.innerHTML = svg(m.id);
    b.title = `${m.label} (Z, then ${m.key}): ${m.help}`;
    b.dataset.mode = m.id;
    b.setAttribute('aria-label', m.label);
    b.onclick = () => set(m.id);
    btns[m.id] = b;
    modeGroup.append(b);
  }
  const optGroup = el('div', 'vm-group');
  const opt = (id, label, text) => {
    const b = el('button', 'vm-btn');
    b.innerHTML = svg(id);
    b.title = `${label}: ${text}`;
    b.setAttribute('aria-label', label);
    b.onclick = () => toggle(id);
    btns[id] = b;
    optGroup.append(b);
  };
  opt('edges', 'Edges', 'the mesh\'s edges over the surface (Shift+Z)');
  opt('xray', 'X-ray', 'see through the model (Alt+Z)');
  const label = el('span', 'vm-label');
  bar.append(label, modeGroup, optGroup);
  view.append(bar);

  function sync() {
    for (const m of MODES) btns[m.id].classList.toggle('on', S.mode === m.id);
    btns.edges.classList.toggle('on', S.edges);
    btns.xray.classList.toggle('on', S.xray);
    btns.edges.disabled = btns.xray.disabled = S.mode === 'wire';
    label.textContent = MODES.find((m) => m.id === S.mode).label;
    bar.hidden = S.suspended;
  }
  function set(mode) {
    if (!has(mode) || S.mode === mode) { sync(); return; }
    S.mode = mode; store(); sync(); apply(); onChange(S);
  }
  function toggle(k, v) {
    S[k] = v ?? !S[k]; store(); sync(); apply(); onChange(S);
  }

  // --- The pie menu (Z): the modes on a ring around the pointer; release Z over one to pick it, or click ---
  const pie = el('div', 'vm-pie');
  pie.hidden = true;
  const R = MODES.length > 5 ? 92 : 78;
  const slices = MODES.map((m, i) => {
    const a = -Math.PI / 2 + (i / MODES.length) * Math.PI * 2;
    const b = el('button', 'vm-slice glass');
    b.innerHTML = `${svg(m.id)}<span>${m.label}</span>`;
    b.style.left = `${Math.cos(a) * R}px`; b.style.top = `${Math.sin(a) * R}px`;
    b.onclick = () => { set(m.id); closePie(); };
    pie.append(b);
    return { id: m.id, a, b };
  });
  view.append(pie);
  let mouse = [innerWidth / 2, innerHeight / 2], pieAt = null, hot = null, zDown = 0;
  addEventListener('pointermove', (e) => {
    mouse = [e.clientX, e.clientY];
    if (!pieAt) return;
    const dx = e.clientX - pieAt[0], dy = e.clientY - pieAt[1];
    hot = null;
    if (Math.hypot(dx, dy) > 28) {
      const a = Math.atan2(dy, dx);
      let best = Infinity;
      for (const s of slices) { const d = Math.abs(Math.atan2(Math.sin(a - s.a), Math.cos(a - s.a))); if (d < best) { best = d; hot = s.id; } }
    }
    for (const s of slices) s.b.classList.toggle('hot', s.id === hot);
  });
  function openPie() {
    pieAt = [...mouse];
    pie.style.left = `${pieAt[0]}px`; pie.style.top = `${pieAt[1]}px`;
    for (const s of slices) s.b.classList.toggle('on', s.id === S.mode);
    hot = null;
    for (const s of slices) s.b.classList.remove('hot');
    pie.hidden = false;
  }
  function closePie() { pie.hidden = true; pieAt = null; hot = null; }
  const isZ = (e) => e.code === 'KeyZ' || e.key?.toLowerCase() === 'z';
  const typing = (e) => e.target.closest?.('input, select, textarea, [contenteditable]');
  addEventListener('keydown', (e) => {
    if (!active() || S.suspended || typing(e) || e.ctrlKey || e.metaKey) return;
    if (pieAt && e.key === 'Escape') { closePie(); return; }
    if (pieAt && /^[1-9]$/.test(e.key) && MODES[Number(e.key) - 1]) { set(MODES[Number(e.key) - 1].id); closePie(); return; }
    if (!isZ(e) || e.repeat) return;
    e.preventDefault();
    if (e.shiftKey) { toggle('edges'); return; }
    if (e.altKey) { toggle('xray'); return; }
    if (pieAt) { closePie(); return; }
    zDown = performance.now();
    openPie();
  });
  addEventListener('keyup', (e) => {
    if (!isZ(e) || !pieAt) return;
    // Held and released over a slice picks it; a quick tap leaves the pie open for a click (as in Blender)
    if (hot) { set(hot); closePie(); } else if (performance.now() - zDown > 350) closePie();
  });
  addEventListener('pointerdown', (e) => { if (pieAt && !e.target.closest('.vm-slice')) closePie(); });

  sync();
  apply(); // the roots that exist now get their own materials noted (and the remembered mode)
  return {
    el: bar, apply, release, setOwn, set, toggle, sync,
    owns: (m) => mine.has(m),
    get mode() { return S.mode; }, get edges() { return S.edges; }, get xray() { return S.xray; }, get pie() { return !pie.hidden; },
    // While another tool draws the model its own way (the paint mode), the bar hides and the own materials come back
    suspend(on) { S.suspended = !!on; if (on) closePie(); sync(); apply(); },
    modes: MODES.map((m) => m.id),
  };
}
