// Texturverkstaden i Asset Studio (docs/texture-workshop.md): ett material är ett recept, med en källa, en stapel
// steg, ingredienser (under-texturer), materialets kartor och blandningslager. Spakarna kommer från
// tools/texture/workshop.json; förhandsvisning och sparande går via studioserverns API. 2D-vyn visar kartorna
// upprepade, 3D-vyn (lab3d.js) materialet på testmodeller. Detaljer ligger under Avancerat i varje kort.

import { createLab, MODELS, LIGHTS } from './lab3d.js';

const fmt = (n, d = 0) => (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const clone = (o) => JSON.parse(JSON.stringify(o));
const getPath = (o, key) => key.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const setPath = (o, key, v) => { const ks = key.split('.'); const last = ks.pop(); let a = o; for (const k of ks) a = a[k] ??= {}; a[last] = v; };
const ING_NAME = /^[a-z0-9åäö_-]{1,24}$/i;
const MAP_LABELS = { color: 'Color', height: 'Height', normal: 'Normal', rough: 'Roughness', ao: 'AO', metal: 'Metal', emissive: 'Emission' };

const LIB_W = 300, SIDE_W = 372; // bibliotekets och panelens bredd (index.html)

export async function createWorkshop({ api, el, side, view, footer, lib, tools, getAssetUrl }) {
  const W = await api('/api/workshop');
  let allTextures = await api('/api/textures?kind=all');
  const doc = { source: { type: 'stone' }, steps: [{ op: 'range' }], inputs: {}, material: {}, blend: { layers: [] } };
  let path = []; // ingrediensen som redigeras: namn för namn från roten
  const cur = () => path.reduce((r, n) => r.inputs[n].recipe, doc);
  const scope = () => {
    let sc = { ...doc.inputs }, r = doc;
    for (const n of path) { r = r.inputs[n].recipe; sc = { ...sc, ...(r.inputs ?? {}) }; }
    return sc;
  };
  const MAT_PARAMS = W.material.groups.flatMap((g) => g.params);
  const CLIENT_KEYS = MAT_PARAMS.filter((p) => p.client).map((p) => p.key);
  const fullMaterial = () => { const m = clone(doc.material); for (const p of MAT_PARAMS) if (getPath(m, p.key) === undefined) setPath(m, p.key, p.default); return m; };
  const pyMaterial = () => {
    // Bara det som påverkar bilderna skickas till servern, så att en spak som bara gäller 3D-vyn inte räknar om
    const m = fullMaterial();
    for (const k of CLIENT_KEYS) { const ks = k.split('.'); if (ks.length === 1) delete m[k]; else if (m[ks[0]]) delete m[ks[0]][ks[1]]; }
    return m;
  };

  // --- Vyerna: 2D (kartorna upprepade) och 3D (materiallabbet) ---
  const canvas = el('canvas');
  view.append(canvas);
  const ctx = canvas.getContext('2d');
  const lab = createLab({ getAssetUrl });
  lab.setInsets(LIB_W, SIDE_W);
  lab.canvas.style.display = 'none';
  view.append(lab.canvas);
  const vs = { mode: '2d', map: 'color', zoom: 1, panX: 0, panY: 0, tiles: 3, seams: true, img: null, model: null };
  let maps = {};

  const bar = el('div', 'wbar glass');
  const seg = el('div', 'seg');
  const b2 = el('button', 'on', '2D'), b3 = el('button', null, '3D');
  b2.onclick = () => setMode('2d'); b3.onclick = () => setMode('3d');
  seg.append(b2, b3);
  const sel = (opts, value, onchange, title) => {
    const s = el('select');
    for (const [v, l] of opts) { const o = el('option', null, l); o.value = v; s.append(o); }
    s.value = value; s.onchange = () => onchange(s.value);
    if (title) s.title = title;
    return s;
  };
  const sw = (checked, onchange, title) => { const b = el('input', 'switch'); b.type = 'checkbox'; b.checked = checked; b.onchange = () => onchange(b.checked); if (title) b.title = title; return b; };
  const mapSel = sel(Object.entries(MAP_LABELS), 'color', (v) => { vs.map = v; showMap(); }, 'Which map is shown');
  const tilesSel = sel([[1, '1 × 1'], [3, '3 × 3'], [5, '5 × 5']], 3, (v) => { vs.tiles = Number(v); fit(); });
  const zoomOut = el('span', 'zoom');
  // Ikonknappar som i headern (index.html): ram, ångra, gör om
  const SVG = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const iconBtn = (title, d) => Object.assign(el('button', 'icon'), { title, innerHTML: SVG(d) });
  const fitBtn = iconBtn('Frame', '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>');
  fitBtn.onclick = () => (vs.mode === '2d' ? fit() : lab.setDistance('fit'));
  const g2 = el('span', 'grp');
  g2.append(mapSel, el('span', null, 'Repeat'), tilesSel, el('span', null, 'Seams'), sw(true, (v) => { vs.seams = v; draw(); }), zoomOut);
  const modelSel = sel(Object.entries(MODELS).map(([k, v]) => [k, v.label]), 'sphere', (v) => { vs.model = v; setModel(v); });
  const lightSel = sel(Object.entries(LIGHTS).map(([k, v]) => [k, v.label]), 'sun', (v) => lab.setLight(v));
  const distSel = sel([['fit', 'Framed'], ['5', '5 m'], ['20', '20 m'], ['60', '60 m']], 'fit', (v) => lab.setDistance(v), 'Distance: how the texture looks from afar (mipmaps, repetition)');
  const g3 = el('span', 'grp');
  const advBtn = el('button', null, 'Advanced ▾');
  const pop = el('div', 'popover glass');
  const popRow = (label, input) => { const r = el('div', 'row span2'); r.append(el('label', null, label), input); pop.append(r); };
  const range = (min, max, step, value, oninput) => { const r = el('input'); r.type = 'range'; Object.assign(r, { min, max, step, value }); r.oninput = () => oninput(Number(r.value)); return r; };
  popRow('Projection', sel([['auto', 'Auto (triplanar on the statue)'], ['uv', 'UV'], ['tri', 'Triplanar']], 'auto', (v) => lab.setProjection(v)));
  popRow('Exposure', range(0.4, 2.5, 0.05, 1, (v) => lab.setExposure(v)));
  popRow('Environment reflections', range(0, 3, 0.05, 1, (v) => lab.setEnv(v)));
  popRow('Wireframe', sw(false, (v) => lab.setWire(v)));
  advBtn.onclick = () => pop.classList.toggle('open');
  g3.append(modelSel, lightSel, el('span', null, 'Turntable'), sw(false, (v) => lab.setTurntable(v)), distSel, advBtn);
  const undoBtn = iconBtn('Undo', '<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/>');
  const redoBtn = iconBtn('Redo', '<path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9"/>');
  const nameTag = el('span', 'curname');
  bar.append(seg, nameTag, g2, g3, fitBtn);
  // Ångra och Gör om sitter i flikraden, som i The Forge (studions verktygsfält, synliga i texturläget)
  for (const b of [undoBtn, redoBtn]) b.classList.add('atelier-tool');
  tools.prepend(undoBtn, redoBtn);
  view.append(bar, pop);
  const varBox = el('div', 'wvar glass');
  view.append(varBox);

  function setMode(m) {
    vs.mode = m;
    b2.classList.toggle('on', m === '2d'); b3.classList.toggle('on', m === '3d');
    g2.style.display = m === '2d' ? '' : 'none';
    g3.style.display = m === '3d' ? '' : 'none';
    pop.classList.remove('open');
    canvas.style.display = m === '2d' ? 'block' : 'none';
    note2d.style.display = m === '2d' ? '' : 'none';
    if (m === '3d') { lab.show(); pushToLab(); } else { lab.hide(); resize(); }
  }
  async function setModel(id) {
    status.textContent = 'Loading the model…';
    try { await lab.setModel(id); status.textContent = ''; } catch (e) { status.textContent = e.message; }
  }
  function pushToLab() {
    if (maps.color) lab.setMaps(maps);
    lab.setMaterial(fullMaterial());
    lab.setLayers(doc.blend.layers);
  }

  function resize() {
    canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio;
    canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`;
    draw();
  }
  function fit() {
    if (!vs.img) return;
    const area = vs.img.width * vs.tiles, avail = Math.min(innerWidth - LIB_W - SIDE_W - 40, innerHeight - 160);
    vs.zoom = Math.max(0.05, avail / area);
    vs.panX = 0; vs.panY = 0;
    draw();
  }
  function draw() {
    const dpr = devicePixelRatio, w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim() || '#2b2f36';
    ctx.fillRect(0, 0, w, h);
    const img = vs.img;
    if (!img) return;
    const s = vs.zoom * dpr, size = img.width * s, total = size * vs.tiles;
    const cx = (LIB_W + (innerWidth - LIB_W - SIDE_W) / 2) * dpr + vs.panX * dpr, cy = (innerHeight / 2) * dpr + vs.panY * dpr;
    const x0 = cx - total / 2, y0 = cy - total / 2;
    ctx.imageSmoothingEnabled = vs.zoom < 2;
    // Hela ytan ritas med ett upprepat mönster: kopior ritade var för sig på decimalpositioner kantutjämnas mot
    // bakgrunden och ger ett tunt streck mellan sig, som ser ut som en söm fast texturen är sömlös
    const pattern = ctx.createPattern(img, 'repeat');
    pattern.setTransform(new DOMMatrix().translateSelf(x0, y0).scaleSelf(s, s));
    ctx.fillStyle = pattern;
    ctx.fillRect(x0, y0, total, total);
    if (vs.seams && vs.tiles > 1) {
      ctx.strokeStyle = 'rgba(255, 220, 80, 0.55)';
      ctx.setLineDash([6 * dpr, 6 * dpr]);
      ctx.lineWidth = dpr;
      for (let k = 1; k < vs.tiles; k++) {
        ctx.beginPath(); ctx.moveTo(x0 + k * size, y0); ctx.lineTo(x0 + k * size, y0 + total); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, y0 + k * size); ctx.lineTo(x0 + total, y0 + k * size); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    zoomOut.textContent = `${fmt(vs.zoom * 100)} %`;
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    vs.zoom = Math.min(16, Math.max(0.05, vs.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    draw();
  }, { passive: false });
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, px: vs.panX, py: vs.panY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (!drag) return; vs.panX = drag.px + e.clientX - drag.x; vs.panY = drag.py + e.clientY - drag.y; draw(); });
  canvas.addEventListener('pointerup', () => { drag = null; });
  addEventListener('resize', () => { if (vs.mode === '2d') resize(); });
  addEventListener('studio-theme', () => { if (vs.mode === '2d') draw(); });
  const note2d = el('div', 'wnote');
  view.append(note2d);
  let firstFit = true;
  function showMap() {
    const url = maps[vs.map];
    if (!url) { vs.img = null; draw(); note2d.textContent = maps.color ? `${MAP_LABELS[vs.map]} is off in the material` : ''; return; }
    note2d.textContent = '';
    const img = new Image();
    img.onload = () => { vs.img = img; if (firstFit) { fit(); firstFit = false; } else draw(); };
    img.src = url;
  }

  // --- Förhandsvisning: räknas när en spak släpps; långa jobb (Krea) följs tills de är klara ---
  async function preview(recipe) {
    let res = await api('/api/texture/preview', { recipe });
    while (res.pending) {
      status.textContent = `${res.krea ? 'Krea is painting' : 'Computing'}… ${fmt((Date.now() - res.since) / 1000)} s`;
      await new Promise((ok) => setTimeout(ok, 1500));
      res = await api(`/api/texture/job?id=${res.job}`);
    }
    return res;
  }
  const levelRecipe = (size = 512) => ({ source: cur().source, steps: cur().steps, inputs: scope(), material: pyMaterial(), size });
  let latest = 0;
  async function update() {
    const id = ++latest;
    status.textContent = 'Computing…';
    const res = await preview(levelRecipe());
    if (id !== latest) return;
    if (res.error) { status.textContent = 'Error'; stats.innerHTML = `<span class="bad">${res.error}</span>`; return; }
    maps = res.maps ?? {};
    status.textContent = '';
    // En textur med genomskinlighet (löv, dekaler) får urklipp direkt när den läggs på modellen
    if (autoAlpha && res.alpha && (doc.material.alpha?.mode ?? 'off') === 'off') { setPath(doc.material, 'alpha.mode', 'cutout'); renderMaterial(); }
    autoAlpha = false;
    showChecks(res);
    showMap();
    if (vs.mode === '3d') pushToLab();
    refreshIngredientThumbs();
  }
  const stats = el('div', 'vals');
  const status = el('span');
  function showChecks(res) {
    const c = res.checks ?? {};
    stats.innerHTML = [
      `<span title="The difference across the seam compared with differences near the edge">Seam <b class="${c.seamless ? 'good' : 'bad'}">${c.seamless ? 'seamless' : 'visible'} (${c.seam})</b></span>`,
      `<span title="Share of the variation in small shapes (the style guide wants low frequency)">Small shapes <b class="${c.low_frequency ? 'good' : 'bad'}">${fmt((c.high_freq ?? 0) * 100)} %</b></span>`,
      `<span>Off palette <b>${fmt((c.off_palette ?? 0) * 100)} %</b></span>`,
      `<span>Mean color <i class="swatch" style="background:${c.mean}"></i><b>${c.mean}</b></span>`,
      `<span>Values <b>${fmt((c.value_range?.[0] ?? 0) * 100)}–${fmt((c.value_range?.[1] ?? 0) * 100)} %</b></span>`,
      c.halo !== undefined ? `<span title="Edge brightness against the fully visible; positive = light fringe">Halo <b class="${c.halo > 0.08 ? 'bad' : 'good'}">${c.halo}</b></span>` : '',
      `<span>Compute time <b>${res.cached ? 'cached' : `${fmt(res.ms / 1000, 1)} s`}</b></span>`,
    ].join('');
  }
  footer.append(Object.assign(el('div', 'block'), { innerHTML: '<b>Texture</b>' }));
  footer.lastChild.append(stats);
  footer.append(Object.assign(el('div', 'block'), { innerHTML: '<b>Status</b>' }));
  footer.lastChild.append(status);

  // --- Ångra och gör om: en ögonblicksbild av hela receptet per ändring ---
  const history = [clone({ ...doc, path })];
  let hpos = 0;
  function snapshot() {
    history.length = hpos + 1;
    history.push(clone({ ...doc, path }));
    if (history.length > 80) history.shift();
    hpos = history.length - 1;
  }
  function restore(k) {
    hpos = k;
    const s = clone(history[k]);
    path = s.path ?? [];
    delete s.path;
    Object.assign(doc, s);
    renderMaterial(); renderLayers(); renderAll();
    update();
  }
  undoBtn.onclick = () => { if (hpos > 0) restore(hpos - 1); };
  redoBtn.onclick = () => { if (hpos < history.length - 1) restore(hpos + 1); };
  let curName = '', edited = false;
  const showName = () => { nameTag.textContent = curName ? `${curName}${edited ? ' (edited)' : ''}` : ''; };
  const commit = () => { snapshot(); edited = true; showName(); update(); };
  const commitLook = () => { snapshot(); edited = true; showName(); lab.setMaterial(fullMaterial()); lab.setLayers(doc.blend.layers); };

  // --- Spakar ---
  const inputNames = () => Object.keys(scope()).filter((n) => !path.includes(n));
  const defaultOf = (o, k) => {
    const all = [...MAT_PARAMS, ...W.blend.params, ...(W.sources[o?.type]?.params ?? []), ...(W.steps[o?.op]?.params ?? [])];
    return all.find((q) => q.key === k)?.default;
  };
  function control(p, obj, onCommit) {
    const get = () => { const v = getPath(obj(), p.key); return v === undefined ? p.default : v; };
    const set = (v) => setPath(obj(), p.key, v);
    const row = el('div', 'row');
    if (p.help) row.title = p.help;
    const label = el('label', null, p.label);
    let sync = () => {};
    if (p.type === 'select' || p.type === 'texture' || p.type === 'input') {
      row.classList.add('span2');
      const s = el('select');
      const fill = () => {
        const opts = p.type === 'texture' ? allTextures.map((t) => [t.name, t.name])
          : p.type === 'input' ? [['– none –', ''], ...inputNames().map((n) => [n, n])] : Object.entries(p.options);
        s.replaceChildren();
        for (const [l, val] of opts) { const o = el('option', null, l); o.value = JSON.stringify(val); s.append(o); }
      };
      fill();
      s.onchange = () => { set(JSON.parse(s.value)); onCommit(); };
      sync = () => { if (p.type === 'input') fill(); s.value = JSON.stringify(get()); };
      row.append(label, s);
    } else if (p.type === 'bool') {
      row.classList.add('span2');
      const box = el('input', 'switch'); box.type = 'checkbox';
      box.onchange = () => { set(box.checked); onCommit(); };
      sync = () => { box.checked = !!get(); };
      row.append(label, box);
    } else if (p.type === 'color') {
      row.classList.add('span2');
      const c = el('input'); c.type = 'color';
      c.onchange = () => { set(c.value); onCommit(); };
      sync = () => { c.value = get(); };
      row.append(label, c);
    } else if (p.type === 'text') {
      row.classList.add('span2');
      const t = el('textarea', 'text'); t.rows = 2;
      t.onchange = () => { set(t.value); onCommit(); };
      sync = () => { t.value = get(); };
      row.append(label, t);
    } else if (p.type === 'seed') {
      const n = el('input'), b = el('button', null, 'New');
      n.type = 'number'; n.min = 0; n.max = 99999;
      n.onchange = () => { set(Number(n.value)); onCommit(); };
      b.onclick = () => { set(Math.floor(Math.random() * 99999)); sync(); onCommit(); };
      sync = () => { n.value = get(); };
      row.append(label, n, b);
    } else {
      const r = el('input'), out = el('output');
      r.type = 'range'; r.min = p.min; r.max = p.max; r.step = p.type === 'int' ? 1 : p.step;
      const dec = p.type === 'int' ? 0 : Math.max(0, Math.ceil(-Math.log10(p.step ?? 0.01) - 1e-9));
      const show = () => { out.textContent = Number(r.value).toFixed(dec); };
      r.oninput = show;
      r.onchange = () => { set(Number(r.value)); onCommit(); };
      sync = () => { r.value = get(); show(); };
      row.append(label, r, out);
    }
    // Villkor (when): raden visas bara när ett annat värde stämmer
    const visible = () => Object.entries(p.when ?? {}).every(([k, cond]) => {
      let v = getPath(obj(), k);
      if (v === undefined) v = defaultOf(obj(), k);
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) return 'not' in cond ? v !== cond.not : 'gt' in cond ? v > cond.gt : true;
      return Array.isArray(cond) ? cond.includes(v) : v === cond;
    });
    const refresh = () => { sync(); row.style.display = visible() ? '' : 'none'; };
    refresh();
    return { row, refresh };
  }
  // Spakar i en behållare: grundspakarna direkt, resten under en hopfälld "Avancerat"
  function paramRows(params, obj, onCommit, into) {
    const refs = [];
    const adv = el('details', 'adv');
    adv.append(el('summary', null, 'Advanced'));
    const advRows = el('div', 'rows');
    adv.append(advRows);
    for (const p of params) {
      const c = control(p, obj, () => { onCommit(); refs.forEach((r) => r.refresh()); });
      refs.push(c);
      (p.adv ? advRows : into).append(c.row);
    }
    if (advRows.children.length) into.append(adv);
    return refs;
  }

  // --- Kort ---
  function card(title, accent, opts = {}) {
    const c = el('section', 'card glass');
    c.style.setProperty('--part', accent);
    const head = el('header');
    const h = el('h2', null, title);
    head.append(h);
    if (opts.help) head.title = opts.help;
    const body = el('div', 'rows');
    c.append(head, body);
    // Klick på rubriken fäller ihop kortet
    head.onclick = (e) => { if (e.target === head || e.target === h) c.classList.toggle('closed'); };
    if (opts.closed) c.classList.add('closed');
    side.append(c);
    return { card: c, head, body, h };
  }
  const crumbs = el('div', 'crumbs glass');
  side.append(crumbs);

  // Källa
  const srcCard = card('Base', '#7a4e2d', { help: 'The base of the material: an algorithm, an existing texture, an ingredient or Krea' });
  const varBtn = el('button', 'mini', 'Variants');
  varBtn.title = 'Four variants with new seeds to choose from';
  srcCard.head.append(varBtn);
  const srcType = el('select');
  for (const [k, v] of Object.entries(W.sources)) { const o = el('option', null, v.label); o.value = k; srcType.append(o); }
  srcType.onchange = () => { cur().source = { type: srcType.value }; renderSource(); renderAI(); commit(); };
  const srcRow = el('div', 'row span2');
  srcRow.append(el('label', null, 'Type'), srcType);
  const srcRows = el('div', 'rows sub');
  srcCard.body.append(srcRow, srcRows);
  function renderSource() {
    srcType.value = cur().source.type;
    srcRows.replaceChildren();
    const def = W.sources[cur().source.type];
    srcType.title = def.help ?? '';
    paramRows(def.params, () => cur().source, () => { renderAI(); commit(); }, srcRows);
  }

  // Varianter: samma recept med fyra nya frön
  varBtn.onclick = async () => {
    const src = cur().source;
    if (!W.sources[src.type].params.some((p) => p.type === 'seed')) { status.textContent = 'The source has no seed'; return; }
    if (src.type === 'krea' && !confirm('Four Krea images take about 12 minutes. Continue?')) return;
    const base = Number(src.seed ?? 1);
    const seeds = [1, 2, 3, 4].map((k) => (base * 31 + k * 7919) % 99999);
    const grid = el('div', 'vgrid');
    const close = el('button', 'mini', 'Close');
    close.onclick = () => varBox.classList.remove('open');
    varBox.replaceChildren(Object.assign(el('div', 'vhead'), { textContent: 'Pick a variant' }), grid, close);
    varBox.classList.add('open');
    for (const seed of seeds) {
      const fig = el('figure');
      const img = el('img');
      fig.append(img, el('figcaption', null, `seed ${seed}`));
      grid.append(fig);
      fig.onclick = () => { cur().source.seed = seed; varBox.classList.remove('open'); renderSource(); commit(); };
      preview({ ...levelRecipe(256), source: { ...src, seed } }).then((r) => { if (r.maps) img.src = r.maps.color; else fig.lastChild.textContent = r.error ?? 'fel'; });
    }
  };

  // AI-målning (docs/texture-workshop.md, AI-flödet): Form → Måla → Material. Det som syns blir en ingrediens, och
  // Krea målar den som bild till bild. Prompten som skickas visas i sin helhet.
  const aiCard = card('AI painting', '#6a4c93', { help: 'Krea-2 in the local ComfyUI paints what is shown in the house style. About 3 minutes the first time; the result is cached' });
  const aiRows = el('div', 'rows');
  aiCard.body.append(aiRows);
  const KREA = Object.fromEntries(W.sources.krea.params.map((p) => [p.key, p.default]));
  const aiDraft = { prompt: '', denoise: KREA.denoise };
  const fullPrompt = (s) => [s.prompt ?? KREA.prompt, (s.style ?? KREA.style) ? W.ai.house_style : '', W.ai.tile].filter(Boolean).join(', ');
  function freeName(base) { let k = 1, n = base; while (scope()[n]) n = `${base}${++k}`; return n; }
  function paintWithAI() {
    const r = cur(), prompt = aiDraft.prompt.trim();
    if (!prompt) { status.textContent = 'Describe what Krea should paint'; return; }
    const name = freeName('form');
    (r.inputs ??= {})[name] = { recipe: { source: r.source, steps: r.steps ?? [] } };
    r.source = { type: 'krea', prompt, base: name, denoise: aiDraft.denoise, seed: KREA.seed };
    r.steps = [];
    renderAll(); commit();
  }
  function backToForm() {
    const r = cur(), name = r.source.base, form = r.inputs?.[name]?.recipe;
    if (!form) return;
    r.source = form.source; r.steps = form.steps ?? [];
    delete r.inputs[name];
    renderAll(); commit();
  }
  function renderAI() {
    aiRows.replaceChildren();
    const src = cur().source;
    if (src.type === 'krea') {
      const form = src.base && cur().inputs?.[src.base]?.recipe;
      aiRows.append(el('div', 'note', form ? `Krea paints the shape ${src.base}. Description, free interpretation and relief are set in Base.` : 'Krea paints freely from the description in Base.'));
      const det = el('details', 'sub');
      det.append(el('summary', null, 'The prompt that is sent'), el('div', 'prompt', fullPrompt(src)));
      const again = el('button', 'mini', 'Try again'), back = el('button', 'mini', 'Back to the shape');
      again.title = 'The same description with a new seed';
      again.onclick = () => { src.seed = Math.floor(Math.random() * 99999); renderSource(); commit(); };
      back.title = 'Remove the painting and continue with the shape';
      back.onclick = backToForm;
      back.disabled = !form;
      const btns = el('div', 'btns');
      btns.append(again, back);
      aiRows.append(det, btns);
      return;
    }
    aiDraft.prompt ||= W.ai.suggest[src.type] ?? '';
    aiRows.append(el('div', 'note', 'What is shown becomes the shape, and Krea paints it. Describe only the material; the house style is added.'));
    const t = Object.assign(el('textarea', 'text'), { rows: 2, value: aiDraft.prompt, placeholder: 'mossy grey cobblestones' });
    t.oninput = () => { aiDraft.prompt = t.value; };
    const r = Object.assign(el('input'), { type: 'range', min: 0.1, max: 1, step: 0.05, value: aiDraft.denoise });
    const out = el('output', null, Number(aiDraft.denoise).toFixed(2));
    r.oninput = () => { aiDraft.denoise = Number(r.value); out.textContent = aiDraft.denoise.toFixed(2); };
    const free = el('div', 'row');
    free.title = W.sources.krea.params.find((p) => p.key === 'denoise').help;
    free.append(el('label', null, 'Free interpretation'), r, out);
    const ends = el('div', 'ends');
    ends.append(el('span', null, '← shape'), el('span', null, 'free →'));
    const go = el('button', 'primary', 'Paint with AI');
    go.title = 'About 3 minutes. You can move other sliders meanwhile; the result is cached';
    go.onclick = paintWithAI;
    const desc = el('div', 'row span2');
    desc.append(el('label', null, 'Description'), t);
    aiRows.append(desc, free, ends, go);
  }

  // Ingredienser
  const ingCard = card('Ingredients', '#8a6d1f', { closed: true, help: 'Sub-textures that the source and the Layer and Scatter steps can use: moss, blobs, a saved stone …' });
  const ingList = el('div', 'ings');
  const ingAdd = el('div', 'row span2');
  const addProc = el('button', 'mini', '+ Procedural'), addTex = el('button', 'mini', '+ Saved texture');
  const addBox = el('div', 'btns');
  addBox.append(addProc, addTex);
  ingAdd.append(el('label', null, 'New ingredient'), addBox);
  ingCard.body.append(ingList, ingAdd);
  const ingThumbs = new Map();
  function newIngredient(def) {
    const r = cur();
    let name = prompt('Ingredient name (e.g. moss, stone, blobs)', '');
    if (name === null) return;
    name = name.trim().toLowerCase();
    if (!ING_NAME.test(name)) { alert('The name may have letters, digits, _ and - (at most 24 characters)'); return; }
    if (scope()[name]) { alert(`${name} already exists`); return; }
    (r.inputs ??= {})[name] = def;
    snapshot();
    if (def.recipe) { path.push(name); renderAll(); update(); } else { renderIngredients(); refreshIngredientThumbs(); }
  }
  addProc.onclick = () => newIngredient({ recipe: { source: { type: 'noise' }, steps: [] } });
  addTex.onclick = () => newIngredient({ texture: allTextures[0]?.name ?? 'bark_painted' });
  function renderIngredients() {
    ingList.replaceChildren();
    const own = cur().inputs ?? {};
    const inherited = Object.keys(scope()).filter((n) => !(n in own) && !path.includes(n));
    for (const [name, def] of Object.entries(own)) {
      const item = el('div', 'ing');
      const img = el('img');
      img.dataset.ing = name;
      const info = el('div', 'info');
      info.append(el('b', null, name));
      if (def.texture) {
        const s = el('select');
        for (const t of allTextures) { const o = el('option', null, t.name); o.value = t.name; s.append(o); }
        s.value = def.texture;
        s.onchange = () => { def.texture = s.value; refreshIngredientThumbs(); commit(); };
        info.append(s);
      } else {
        info.append(el('span', null, `${W.sources[def.recipe.source.type]?.label ?? def.recipe.source.type}${def.recipe.steps?.length ? `, ${def.recipe.steps.length} steg` : ''}`));
        const open = el('button', 'mini', 'Edit');
        open.onclick = () => { path.push(name); renderAll(); update(); };
        img.onclick = open.onclick;
        img.style.cursor = 'pointer';
        info.append(open);
      }
      const del = el('button', 'mini', '✕');
      del.title = 'Remove the ingredient';
      del.onclick = () => { if (!confirm(`Remove ${name}?`)) return; delete own[name]; renderAll(); commit(); };
      item.append(img, info, del);
      ingList.append(item);
    }
    if (inherited.length) ingList.append(el('div', 'note', `Also inherited: ${inherited.join(', ')}`));
    if (!ingList.children.length) ingList.append(el('div', 'note', 'None yet. An ingredient is a small texture of its own, e.g. moss to put in the stone joints with the Layer step.'));
  }
  function refreshIngredientThumbs() {
    const sc = scope();
    for (const img of ingList.querySelectorAll('img[data-ing]')) {
      const name = img.dataset.ing, def = sc[name];
      if (!def) continue;
      if (def.texture) { img.src = `/assets/textures/${def.texture}.png`; continue; }
      const r = { source: def.recipe.source, steps: def.recipe.steps ?? [], inputs: { ...sc, ...(def.recipe.inputs ?? {}) }, material: { normal: { on: false }, ao: { on: false } }, size: 128 };
      const key = JSON.stringify(r);
      if (ingThumbs.get(name)?.key === key) { img.src = ingThumbs.get(name).url; continue; }
      api('/api/texture/preview', { recipe: r }).then((res) => {
        if (res.maps) { ingThumbs.set(name, { key, url: res.maps.color }); img.src = res.maps.color; }
        else if (res.pending) img.alt = 'computing …';
      });
    }
  }
  function renderCrumbs() {
    crumbs.replaceChildren();
    crumbs.style.display = path.length ? '' : 'none';
    const go = (k) => { path = path.slice(0, k); renderAll(); update(); };
    const root = el('a', null, 'Texture'); root.onclick = () => go(0);
    crumbs.append(root);
    path.forEach((n, i) => {
      crumbs.append(el('span', null, ' ▸ '));
      const a = el(i === path.length - 1 ? 'b' : 'a', null, n);
      if (i < path.length - 1) a.onclick = () => go(i + 1);
      crumbs.append(a);
    });
    const back = el('button', 'mini', 'Back');
    back.onclick = () => go(path.length - 1);
    crumbs.append(back);
  }

  // Steg (en stapel; ordningen spelar roll)
  const stepCard = card('Filters', '#3d5a80', { help: 'Image processing in order from top to bottom. More in the library under Filters.' });
  const stepList = el('div', 'steps');
  const addSel = el('select');
  addSel.append(Object.assign(el('option', null, 'Add filter…'), { value: '' }));
  for (const g of W.step_groups) {
    const og = el('optgroup'); og.label = g.label;
    for (const k of g.ops) { const o = el('option', null, W.steps[k].label); o.value = k; o.title = W.steps[k].help ?? ''; og.append(o); }
    addSel.append(og);
  }
  addSel.onchange = () => { if (!addSel.value) return; cur().steps.push({ op: addSel.value, on: true }); addSel.value = ''; renderSteps(true); commit(); };
  const addRow = el('div', 'row span2');
  addRow.append(el('label', null, 'New filter'), addSel);
  stepCard.body.append(stepList, addRow);
  function renderSteps(openLast = false) {
    const steps = cur().steps;
    stepList.replaceChildren();
    steps.forEach((s, i) => {
      const def = W.steps[s.op];
      const box = el('details', 'step');
      box.open = openLast && i === steps.length - 1;
      const sum = el('summary');
      const on = el('input', 'switch'); on.type = 'checkbox'; on.checked = s.on !== false;
      on.title = 'On/off';
      on.onclick = (e) => e.stopPropagation();
      on.onchange = () => { s.on = on.checked; box.classList.toggle('off', !on.checked); commit(); };
      box.classList.toggle('off', s.on === false);
      const btn = (t, title, fn) => { const b = el('button', 'mini', t); b.title = title; b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); }; return b; };
      sum.append(on, el('span', 'name', def?.label ?? s.op),
        btn('↑', 'Move up', () => { if (i > 0) { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; renderSteps(); commit(); } }),
        btn('↓', 'Move down', () => { if (i < steps.length - 1) { [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; renderSteps(); commit(); } }),
        btn('✕', 'Ta bort', () => { steps.splice(i, 1); renderSteps(); commit(); }));
      box.append(sum);
      if (def?.help) box.title = def.help;
      const rows = el('div', 'rows');
      paramRows(def?.params ?? [], () => s, commit, rows);
      box.append(rows);
      stepList.append(box);
    });
    if (!steps.length) stepList.append(el('div', 'note', 'No filters: the base is shown as it is.'));
  }

  // Material: grunden direkt, varje avancerad grupp som en egen undermeny under Avancerat
  const matCard = card('Surface', '#6b4fa0', { help: 'The material maps and properties. Best seen in 3D.' });
  function renderMaterial() {
    matCard.body.replaceChildren();
    const adv = el('details', 'adv');
    adv.append(el('summary', null, 'Advanced'));
    const refs = [];
    for (const g of W.material.groups) {
      let into = matCard.body;
      if (g.adv) {
        const sub = el('details', 'sub');
        sub.append(el('summary', null, g.label));
        into = el('div', 'rows');
        sub.append(into);
        adv.append(sub);
      }
      for (const p of g.params) {
        const c = control(p, () => doc.material, () => { (p.client ? commitLook : commit)(); refs.forEach((r) => r.refresh()); });
        refs.push(c);
        into.append(c.row);
      }
    }
    matCard.body.append(adv);
  }

  // Blandning: lager som läggs på modellen i 3D (mossa uppifrån, snö, smuts nerifrån, nötta kanter)
  const blendCard = card('Blending', '#2f7a6b', { help: 'Layers blended onto the model by direction, height, hollows and edges. Seen in 3D.' });
  const layerList = el('div', 'steps');
  const layerAdd = el('select');
  layerAdd.append(Object.assign(el('option', null, 'Add layer…'), { value: '' }));
  for (const k of [...Object.keys(W.layer_presets), 'Empty layer']) { const o = el('option', null, k); o.value = k; layerAdd.append(o); }
  layerAdd.onchange = () => {
    if (!layerAdd.value) return;
    if (doc.blend.layers.length >= 4) { alert('At most four layers'); layerAdd.value = ''; return; }
    const defaults = Object.fromEntries(W.blend.params.map((p) => [p.key, p.default]));
    doc.blend.layers.push({ name: layerAdd.value, on: true, ...defaults, ...(W.layer_presets[layerAdd.value] ?? {}) });
    layerAdd.value = '';
    renderLayers(true);
    commitLook();
    if (vs.mode !== '3d') setMode('3d');
  };
  const layerAddRow = el('div', 'row span2');
  layerAddRow.append(el('label', null, 'New layer'), layerAdd);
  blendCard.body.append(layerList, layerAddRow);
  function renderLayers(openLast = false) {
    const layers = doc.blend.layers;
    layerList.replaceChildren();
    layers.forEach((l, i) => {
      const box = el('details', 'step');
      box.open = openLast && i === layers.length - 1;
      const sum = el('summary');
      const on = el('input', 'switch'); on.type = 'checkbox'; on.checked = l.on !== false;
      on.onclick = (e) => e.stopPropagation();
      on.onchange = () => { l.on = on.checked; box.classList.toggle('off', !on.checked); commitLook(); };
      box.classList.toggle('off', l.on === false);
      const del = el('button', 'mini', '✕');
      del.onclick = (e) => { e.preventDefault(); layers.splice(i, 1); renderLayers(); commitLook(); };
      sum.append(on, el('span', 'name', l.name ?? `Layer ${i + 1}`), del);
      const rows = el('div', 'rows');
      paramRows(W.blend.params, () => l, commitLook, rows);
      box.append(sum, rows);
      layerList.append(box);
    });
    if (!layers.length) layerList.append(el('div', 'note', 'No layers. Try Moss or Snow on the dragon statue.'));
  }

  // Spara (och öppna en textur som gjorts i verkstaden)
  const saveCard = card('Save', '#4e8a2f');
  const nameIn = Object.assign(el('input', 'text'), { type: 'text', placeholder: 'rock_mossig_kullersten' });
  const profSel = el('select');
  for (const [k, v] of Object.entries(W.profiles)) { const o = el('option', null, v.label); o.value = k; profSel.append(o); }
  const tagsIn = Object.assign(el('input', 'text'), { type: 'text', placeholder: 'stone, moss, forest' });
  const sizeSel = el('select');
  for (const s of [512, 1024, 2048, 4096]) { const o = el('option', null, `${s} px`); o.value = s; sizeSel.append(o); }
  sizeSel.value = 1024;
  const saveBtn = el('button', 'primary', 'Save texture');
  const saveMsg = el('div', 'note');
  const rowOf = (l, input, title) => { const r = el('div', 'row span2'); if (title) r.title = title; r.append(el('label', null, l), input); return r; };
  const mapBoxes = {};
  const saveAdv = el('details', 'adv');
  saveAdv.append(el('summary', null, 'Advanced'));
  const saveAdvRows = el('div', 'rows');
  saveAdv.append(saveAdvRows);
  for (const k of ['normal', 'height', 'rough', 'ao', 'metal', 'emissive']) {
    mapBoxes[k] = el('input', 'switch'); mapBoxes[k].type = 'checkbox';
    saveAdvRows.append(rowOf(`Save ${MAP_LABELS[k].toLowerCase()}`, mapBoxes[k]));
  }
  const ormBox = el('input', 'switch'); ormBox.type = 'checkbox';
  const webpBox = el('input', 'switch'); webpBox.type = 'checkbox';
  saveAdvRows.append(rowOf('ORM packing', ormBox, 'AO in red, roughness in green, metal in blue (as glTF)'), rowOf('WebP copy', webpBox, 'Smaller file for the client'),
    el('div', 'note', 'Overwriting a texture moves the previous one to assets/textures/versions/.'));
  function profileDefaults() {
    const pr = W.profiles[profSel.value];
    const m = fullMaterial();
    for (const k of Object.keys(mapBoxes)) mapBoxes[k].checked = pr.maps.includes(k) || (k === 'metal' && m.metal.on) || (k === 'emissive' && m.emission.on);
  }
  profSel.onchange = () => {
    const pre = W.profiles[profSel.value].prefix;
    if (!nameIn.value || Object.values(W.profiles).some((x) => nameIn.value === x.prefix)) nameIn.value = pre;
    profileDefaults();
    if (!vs.model) { modelSel.value = W.profiles[profSel.value].model; if (vs.mode === '3d') setModel(modelSel.value); }
  };
  saveCard.body.append(
    rowOf('Profile', profSel, 'Who uses the texture: sets the name, the maps and which model the 3D view shows'),
    rowOf('Name', nameIn), rowOf('Tags', tagsIn), rowOf('Size', sizeSel), saveAdv, saveBtn, saveMsg,
  );
  let catalog = [];
  async function listSaved() {
    const cat = await fetch('/assets/textures/catalog.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { textures: [] })).catch(() => ({ textures: [] }));
    catalog = cat.textures;
    if (libTab === 'mine') renderLib();
  }
  async function openSaved(name) {
    const r = await api(`/api/texture/recipe?name=${encodeURIComponent(name)}`);
    if (r.error) { saveMsg.textContent = r.error; return; }
    Object.assign(doc, { source: r.source, steps: r.steps ?? [], inputs: r.inputs ?? {}, material: r.material ?? {}, blend: r.blend ?? { layers: [] } });
    path = [];
    nameIn.value = r.name; profSel.value = r.profile; tagsIn.value = (r.tags ?? []).join(', ');
    for (const k of Object.keys(mapBoxes)) mapBoxes[k].checked = (r.maps ?? []).includes(k);
    renderMaterial(); renderLayers(); renderAll();
    snapshot(); curName = r.name; edited = false; showName(); update();
  }
  saveBtn.onclick = async () => {
    const name = nameIn.value.trim().toLowerCase();
    const recipe = { source: doc.source, steps: doc.steps, inputs: doc.inputs, material: fullMaterial(), blend: doc.blend };
    const payload = { recipe, name, profile: profSel.value, tags: tagsIn.value.split(','), size: Number(sizeSel.value),
      maps: ['color', ...Object.keys(mapBoxes).filter((k) => mapBoxes[k].checked)], pack: ormBox.checked ? 'orm' : null, webp: webpBox.checked };
    saveMsg.textContent = 'Sparar…';
    let res = await api('/api/texture/save', payload);
    if (res.exists && confirm(`${name} already exists. Overwrite? (The previous one is kept in versions/)`)) res = await api('/api/texture/save', { ...payload, overwrite: true });
    saveMsg.textContent = res.error ? `Not saved: ${res.error}` : `Saved: ${res.out} with ${res.entry.maps.join(', ')} (${res.size} px, ${res.checks?.seamless ? 'seamless' : 'seam visible'})`;
    if (!res.error) { listSaved(); allTextures = await api('/api/textures?kind=all'); }
  };

  // --- Biblioteket till vänster: färdiga material, befintliga texturer, filter och egna, som tumnaglar ---
  // Ett klick lägger materialet på modellen (eller filtret sist i stapeln); knapparna på en textur blandar in
  // den som lager eller gör den till en ingrediens i stället.
  let libTab = 'material', libQuery = '';
  const libHead = el('div', 'libhead');
  const libSeg = el('div', 'seg');
  const LIB_TABS = { material: 'Materials', textures: 'Textures', filters: 'Filters', mine: 'Mine' };
  for (const [k, l] of Object.entries(LIB_TABS)) {
    const b = el('button', k === libTab ? 'on' : null, l);
    b.dataset.tab = k;
    b.onclick = () => { libTab = k; libSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.tab === k)); renderLib(); };
    libSeg.append(b);
  }
  const libSearch = Object.assign(el('input', 'search'), { type: 'search', placeholder: 'Search…' });
  libSearch.oninput = () => { libQuery = libSearch.value.trim().toLowerCase(); renderLib(); };
  const libHint = el('div', 'note');
  libHead.append(el('h2', null, 'Library'), libSeg, libSearch, libHint);
  const libBody = el('div', 'libbody');
  lib.append(libHead, libBody);

  // Tumnaglarna räknas av servern (cachade) en i taget, så att de dyker upp i ordning
  const thumbCache = new Map();
  let thumbQueue = Promise.resolve();
  function thumb(img, recipe) {
    const r = { source: recipe.source, steps: recipe.steps ?? [], inputs: recipe.inputs ?? {}, material: { normal: { on: false }, ao: { on: false } }, size: 128 };
    const key = JSON.stringify(r);
    if (thumbCache.has(key)) { img.src = thumbCache.get(key); return; }
    thumbQueue = thumbQueue.then(async () => {
      if (!img.isConnected) return;
      const res = await api('/api/texture/preview', { recipe: r });
      if (res.maps) { thumbCache.set(key, res.maps.color); img.src = res.maps.color; }
    });
  }
  function tile(label, { src, recipe, badge, onclick, actions = [], title }) {
    const f = el('figure', 'tile');
    const img = el('img');
    img.alt = '';
    f.append(img);
    if (src) img.src = src; else if (recipe) thumb(img, recipe);
    if (badge) f.append(el('span', 'badge', badge));
    f.append(el('figcaption', null, label));
    f.title = title ?? label;
    f.onclick = onclick;
    if (actions.length) {
      const a = el('div', 'acts');
      for (const [t, tip, fn] of actions) { const b = el('button', 'mini', t); b.title = tip; b.onclick = (e) => { e.stopPropagation(); fn(); }; a.append(b); }
      f.append(a);
    }
    return f;
  }
  function libGroup(title, tiles) {
    if (!tiles.length) return;
    const g = el('section', 'libgroup');
    const grid = el('div', 'tiles');
    grid.append(...tiles);
    g.append(el('h3', null, title), grid);
    libBody.append(g);
  }
  const match = (...words) => !libQuery || words.some((w) => (w ?? '').toLowerCase().includes(libQuery));
  const TEX_GROUPS = [['Bark', /^bark_/], ['Ground and surfaces', /^surface_(?!bld_)/], ['Buildings', /^surface_bld_/], ['Leaves and needles', /^(leaf|leaves|needle|blossom|autumn|foliage)/],
    ['Moss and growth', /^(moss|lichen|blend_)/], ['Stone', /^(rock_|stone)/], ['Other', /./]];
  const FILTER_REF = { inputs: W.presets.cobble_moss.recipe.inputs, source: { type: 'stone' } };
  function renderLib() {
    libBody.replaceChildren();
    if (libTab === 'material') {
      libHint.textContent = 'Click a material to put it on the model.';
      for (const g of W.preset_groups) {
        libGroup(g, Object.entries(W.presets).filter(([, p]) => p.group === g && match(p.label, g)).map(([id, p]) => tile(p.label, p.ai
          ? { badge: 'AI', onclick: () => applyPreset(id), title: `${p.label}: painted by Krea in ComfyUI, about 1–3 minutes the first time` }
          : { recipe: p.recipe, onclick: () => applyPreset(id) })));
      }
    } else if (libTab === 'textures') {
      libHint.textContent = 'Click to put the texture on the model. + Layer blends it on top, + Ingr. makes it an ingredient.';
      const left = allTextures.filter((t) => match(t.name));
      for (const [g, re] of TEX_GROUPS) {
        const these = left.filter((t) => re.test(t.name));
        for (const t of these) left.splice(left.indexOf(t), 1);
        libGroup(g, these.map((t) => tile(t.name.replace(/^(surface_bld_|surface_|bark_)/, ''), { src: t.thumb, title: t.name, onclick: () => applyTexture(t.name), actions: [
          ['+ Layer', 'Blend in as a layer on the model (the Blending card)', () => addBlendLayer(t.name)],
          ['+ Ingr.', 'Add as an ingredient', () => addTextureIngredient(t.name)]] })));
      }
    } else if (libTab === 'filters') {
      libHint.textContent = 'Click to add the filter at the end of the stack. The images show the filter on a cobblestone.';
      for (const g of W.step_groups) {
        libGroup(g.label, g.ops.filter((op) => match(W.steps[op].label, g.label)).map((op) => tile(W.steps[op].label, {
          recipe: { ...FILTER_REF, steps: [{ op, ...(op === 'layer' ? { input: 'moss' } : {}) }] }, title: W.steps[op].help ?? W.steps[op].label, onclick: () => addFilter(op) })));
      }
    } else {
      libHint.textContent = catalog.length ? 'Textures you saved in the Atelier. Click to open them again.' : 'Nothing saved yet. What you save in the Save card ends up here.';
      libGroup('Saved', catalog.filter((t) => match(t.name, ...(t.tags ?? []))).map((t) => tile(t.name, {
        src: `/assets/textures/${t.name}.png?v=${encodeURIComponent(t.saved)}`, title: `${t.name} (${W.profiles[t.profile]?.label ?? t.profile})`, onclick: () => openSaved(t.name) })));
    }
  }
  const openCard = (c) => c.card.classList.remove('closed');
  let autoAlpha = false;
  function startFresh(recipe, name, profile) {
    path = [];
    Object.assign(doc, { source: clone(recipe.source), steps: clone(recipe.steps ?? []), inputs: clone(recipe.inputs ?? {}), material: clone(recipe.material ?? {}) });
    if (profile && W.profiles[profile]) { profSel.value = profile; nameIn.value = ''; profSel.onchange(); }
    renderMaterial(); renderAll();
    snapshot(); curName = name; edited = false; showName();
    autoAlpha = true;
    update();
  }
  function applyPreset(id) { const p = W.presets[id]; startFresh(p.recipe, p.label, p.profile); }
  function applyTexture(name) {
    if (catalog.some((t) => t.name === name)) return openSaved(name);
    const profile = /^bark_/.test(name) ? 'bark' : /^surface_bld_/.test(name) ? 'building' : /^surface_/.test(name) ? 'terrain' : /^(moss|lichen)/.test(name) ? 'blend' : /^(leaf|leaves|needle|blossom)/.test(name) ? 'decal' : 'rock';
    startFresh({ source: { type: 'image', name }, steps: [] }, name, profile);
  }
  function addBlendLayer(texture) {
    if (doc.blend.layers.length >= 4) { alert('At most four layers'); return; }
    const defaults = Object.fromEntries(W.blend.params.map((q) => [q.key, q.default]));
    doc.blend.layers.push({ name: texture, on: true, ...defaults, texture, dir: 'none', amount: 0.5 });
    renderLayers(true);
    openCard(blendCard);
    commitLook();
    if (vs.mode !== '3d') setMode('3d');
  }
  function addTextureIngredient(texture) {
    let name = texture.replace(/^(surface_bld_|surface_|bark_)/, '').slice(0, 24);
    while (scope()[name]) name = `${name.slice(0, 22)}_${Math.floor(Math.random() * 9)}`;
    (cur().inputs ??= {})[name] = { texture };
    renderIngredients();
    openCard(ingCard);
    snapshot();
    refreshIngredientThumbs();
  }
  function addFilter(op) {
    const st = { op, on: true };
    if (op === 'layer') {
      // Lager behöver en ingrediens: saknas en, skapas mossa
      let names = inputNames();
      if (!names.length) { (cur().inputs ??= {}).moss = { recipe: clone(W.presets.moss.recipe) }; names = ['moss']; renderIngredients(); }
      st.input = names[0];
    }
    cur().steps.push(st);
    renderSteps(true);
    openCard(stepCard);
    commit();
  }

  function renderAll() {
    renderCrumbs();
    srcCard.h.textContent = path.length ? `Base: ${path[path.length - 1]}` : 'Base';
    renderSource();
    renderAI();
    renderIngredients();
    renderSteps();
    for (const c of [matCard, blendCard, saveCard]) c.card.style.display = path.length ? 'none' : '';
  }

  renderMaterial();
  renderLayers();
  renderAll();
  profileDefaults();
  listSaved();
  renderLib();
  setMode('3d');
  applyPreset('cobble');
  return {
    show() { if (vs.mode === '3d') lab.show(); else resize(); if (!maps.color) update(); },
    hide() { lab.hide(); },
    shot: () => lab.shot(),
    lab,
  };
}
