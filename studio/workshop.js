// Texturverkstaden i Asset Studio (docs/texture-workshop.md): en textur är ett recept, en källa och en stapel steg.
// Spakarna kommer från tools/texture/workshop.json; förhandsvisning och sparande går via studioserverns API.

const fmt = (n, d = 0) => (n ?? 0).toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d });

export async function createWorkshop({ api, el, side, view, footer }) {
  const W = await api('/api/workshop');
  const allTextures = await api('/api/textures?kind=all');
  const recipe = { source: { type: 'bark' }, steps: [{ op: 'range' }] };
  const valueIn = (obj, p) => obj[p.key] ?? p.default;

  // --- Förhandsvisning: textur upprepad med zoom och panorering, sömmarna markerade ---
  const canvas = el('canvas');
  view.append(canvas);
  const ctx = canvas.getContext('2d');
  const viewState = { zoom: 1, panX: 0, panY: 0, tiles: 3, seams: true, img: null };
  const bar = el('div', 'wbar glass');
  const tilesSel = el('select');
  for (const t of [1, 3, 5]) { const o = el('option', null, `${t} × ${t}`); o.value = t; tilesSel.append(o); }
  tilesSel.value = 3;
  tilesSel.onchange = () => { viewState.tiles = Number(tilesSel.value); fit(); };
  const seamBox = el('input', 'switch');
  seamBox.type = 'checkbox'; seamBox.checked = true;
  seamBox.onchange = () => { viewState.seams = seamBox.checked; draw(); };
  const zoomOut = el('span', 'zoom');
  const fitBtn = el('button', null, 'Rama in');
  fitBtn.onclick = fit;
  bar.append(el('span', null, 'Upprepning'), tilesSel, el('span', null, 'Sömmar'), seamBox, zoomOut, fitBtn);
  view.append(bar);
  function resize() {
    canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio;
    canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`;
    draw();
  }
  function fit() {
    if (!viewState.img) return;
    const area = viewState.img.width * viewState.tiles, avail = Math.min(innerWidth - 400, innerHeight - 160);
    viewState.zoom = Math.max(0.05, avail / area);
    viewState.panX = 0; viewState.panY = 0;
    draw();
  }
  function draw() {
    const dpr = devicePixelRatio, w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2b2f36';
    ctx.fillRect(0, 0, w, h);
    const img = viewState.img;
    if (!img) return;
    const s = viewState.zoom * dpr, size = img.width * s, total = size * viewState.tiles;
    const cx = (innerWidth - 360) / 2 * dpr + viewState.panX * dpr, cy = (innerHeight / 2) * dpr + viewState.panY * dpr;
    const x0 = cx - total / 2, y0 = cy - total / 2;
    ctx.imageSmoothingEnabled = viewState.zoom < 2;
    for (let i = 0; i < viewState.tiles; i++) for (let j = 0; j < viewState.tiles; j++) ctx.drawImage(img, x0 + i * size, y0 + j * size, size, size);
    if (viewState.seams && viewState.tiles > 1) {
      ctx.strokeStyle = 'rgba(255, 220, 80, 0.55)';
      ctx.setLineDash([6 * dpr, 6 * dpr]);
      ctx.lineWidth = dpr;
      for (let k = 1; k < viewState.tiles; k++) {
        ctx.beginPath(); ctx.moveTo(x0 + k * size, y0); ctx.lineTo(x0 + k * size, y0 + total); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, y0 + k * size); ctx.lineTo(x0 + total, y0 + k * size); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    zoomOut.textContent = `${fmt(viewState.zoom * 100)} %`;
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    viewState.zoom = Math.min(16, Math.max(0.05, viewState.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    draw();
  }, { passive: false });
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, px: viewState.panX, py: viewState.panY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (!drag) return; viewState.panX = drag.px + e.clientX - drag.x; viewState.panY = drag.py + e.clientY - drag.y; draw(); });
  canvas.addEventListener('pointerup', () => { drag = null; });
  addEventListener('resize', resize);

  // --- Uppdatering: när en spak släpps räknas förhandsvisningen om (cachad per recept på servern) ---
  let latest = 0, firstFit = true;
  const status = el('span');
  async function update() {
    const id = ++latest;
    status.textContent = 'Räknar…';
    const res = await api('/api/texture/preview', { recipe: { ...recipe, size: 512 } });
    if (id !== latest) return;
    if (res.error) { status.textContent = 'Fel'; stats.innerHTML = `<span class="bad">${res.error}</span>`; return; }
    const img = new Image();
    img.onload = () => {
      if (id !== latest) return;
      viewState.img = img;
      if (firstFit) { fit(); firstFit = false; } else draw();
      status.textContent = '';
      showChecks(res);
    };
    img.src = res.url;
  }
  const stats = el('div', 'vals');
  function showChecks(res) {
    const c = res.checks ?? {};
    stats.innerHTML = [
      `<span>Söm <b class="${c.seamless ? 'good' : 'bad'}">${c.seamless ? 'sömlös' : 'syns'} (${c.seam})</b></span>`,
      `<span>Utanför paletten <b>${fmt((c.off_palette ?? 0) * 100)} %</b></span>`,
      `<span>Medelfärg <i class="swatch" style="background:${c.mean}"></i><b>${c.mean}</b></span>`,
      `<span>Valörer <b>${fmt((c.value_range?.[0] ?? 0) * 100)}–${fmt((c.value_range?.[1] ?? 0) * 100)} %</b></span>`,
      `<span>Räknetid <b>${res.cached ? 'cachad' : `${fmt(res.ms / 1000, 1)} s`}</b></span>`,
    ].join('');
  }
  footer.append(Object.assign(el('div', 'block'), { innerHTML: '<b>Texturen</b>' }));
  footer.lastChild.append(stats);
  footer.append(Object.assign(el('div', 'block'), { innerHTML: '<b>Status</b>' }));
  footer.lastChild.append(status);

  // --- Spakar ---
  function control(p, get, set, onCommit) {
    const row = el('div', 'row');
    if (p.help) row.title = p.help;
    const label = el('label', null, p.label);
    const sync = [];
    if (p.type === 'select' || p.type === 'texture') {
      row.classList.add('span2');
      const sel = el('select');
      const opts = p.type === 'texture' ? allTextures.map((t) => [t.name, t.name]) : Object.entries(p.options);
      for (const [lab, val] of opts) { const o = el('option', null, lab); o.value = JSON.stringify(val); sel.append(o); }
      sel.onchange = () => { set(JSON.parse(sel.value)); onCommit(); };
      sync.push(() => { sel.value = JSON.stringify(get()); });
      row.append(label, sel);
    } else if (p.type === 'bool') {
      row.classList.add('span2');
      const box = el('input', 'switch'); box.type = 'checkbox';
      box.onchange = () => { set(box.checked); onCommit(); };
      sync.push(() => { box.checked = !!get(); });
      row.append(label, box);
    } else if (p.type === 'color') {
      row.classList.add('span2');
      const c = el('input'); c.type = 'color';
      c.onchange = () => { set(c.value); onCommit(); };
      sync.push(() => { c.value = get(); });
      row.append(label, c);
    } else if (p.type === 'seed') {
      const n = el('input'), b = el('button', null, 'Nytt');
      n.type = 'number'; n.min = 0; n.max = 99999;
      n.onchange = () => { set(Number(n.value)); onCommit(); };
      b.onclick = () => { set(Math.floor(Math.random() * 99999)); refresh(); onCommit(); };
      sync.push(() => { n.value = get(); });
      row.append(label, n, b);
    } else {
      const r = el('input'), out = el('output');
      r.type = 'range'; r.min = p.min; r.max = p.max; r.step = p.type === 'int' ? 1 : p.step;
      const dec = p.type === 'int' ? 0 : Math.max(0, Math.ceil(-Math.log10(p.step ?? 0.01) - 1e-9));
      const show = () => { out.textContent = Number(r.value).toFixed(dec); };
      r.oninput = show;
      r.onchange = () => { set(Number(r.value)); onCommit(); };
      sync.push(() => { r.value = get(); show(); });
      row.append(label, r, out);
    }
    for (const s of sync) s();
    return { row, sync: () => sync.forEach((s) => s()) };
  }
  const commit = () => update();
  let syncs = [];
  function refresh() { for (const s of syncs) s(); }

  // Kort: Källa
  const srcCard = card('Källa', '#7a4e2d');
  const srcType = el('select');
  for (const [k, v] of Object.entries(W.sources)) { const o = el('option', null, v.label); o.value = k; srcType.append(o); }
  srcType.onchange = () => { recipe.source = { type: srcType.value }; renderSource(); commit(); };
  const srcRow = el('div', 'row span2');
  srcRow.append(el('label', null, 'Typ'), srcType);
  const srcRows = el('div', 'rows');
  srcCard.body.append(srcRow, srcRows);
  function renderSource() {
    srcType.value = recipe.source.type;
    srcRows.replaceChildren();
    syncs = [];
    for (const p of W.sources[recipe.source.type].params) {
      const c = control(p, () => valueIn(recipe.source, p), (v) => { recipe.source[p.key] = v; }, commit);
      srcRows.append(c.row);
      syncs.push(c.sync);
    }
  }

  // Kort: Steg (en stapel; ordningen spelar roll)
  const stepCard = card('Steg', '#3d5a80');
  const stepList = el('div', 'steps');
  const addSel = el('select');
  addSel.append(Object.assign(el('option', null, 'Lägg till steg…'), { value: '' }));
  for (const [k, v] of Object.entries(W.steps)) { const o = el('option', null, v.label); o.value = k; addSel.append(o); }
  addSel.onchange = () => { if (!addSel.value) return; recipe.steps.push({ op: addSel.value, on: true }); addSel.value = ''; renderSteps(true); commit(); };
  const addRow = el('div', 'row span2');
  addRow.append(el('label', null, 'Nytt steg'), addSel);
  stepCard.body.append(stepList, addRow);
  function renderSteps(openLast = false) {
    stepList.replaceChildren();
    recipe.steps.forEach((s, i) => {
      const def = W.steps[s.op];
      const box = el('details', 'step');
      box.open = openLast && i === recipe.steps.length - 1;
      const sum = el('summary');
      const on = el('input', 'switch'); on.type = 'checkbox'; on.checked = s.on !== false;
      on.title = 'Av/på';
      on.onclick = (e) => e.stopPropagation();
      on.onchange = () => { s.on = on.checked; box.classList.toggle('off', !on.checked); commit(); };
      box.classList.toggle('off', s.on === false);
      const btn = (t, title, fn) => { const b = el('button', 'mini', t); b.title = title; b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); }; return b; };
      sum.append(on, el('span', 'name', def?.label ?? s.op),
        btn('↑', 'Flytta upp', () => { if (i > 0) { [recipe.steps[i - 1], recipe.steps[i]] = [recipe.steps[i], recipe.steps[i - 1]]; renderSteps(); commit(); } }),
        btn('↓', 'Flytta ned', () => { if (i < recipe.steps.length - 1) { [recipe.steps[i + 1], recipe.steps[i]] = [recipe.steps[i], recipe.steps[i + 1]]; renderSteps(); commit(); } }),
        btn('✕', 'Ta bort', () => { recipe.steps.splice(i, 1); renderSteps(); commit(); }));
      box.append(sum);
      if (def?.help) box.title = def.help;
      const rows = el('div', 'rows');
      for (const p of def?.params ?? []) rows.append(control(p, () => valueIn(s, p), (v) => { s[p.key] = v; }, commit).row);
      box.append(rows);
      stepList.append(box);
    });
  }

  // Kort: Spara (och öppna en textur som gjorts i verkstaden)
  const saveCard = card('Spara', '#4e8a2f');
  const nameIn = Object.assign(el('input'), { type: 'text', placeholder: 'bark_min_ek' });
  const profSel = el('select');
  for (const [k, v] of Object.entries(W.profiles)) { const o = el('option', null, v.label); o.value = k; profSel.append(o); }
  profSel.onchange = () => { const pre = W.profiles[profSel.value].prefix; if (!nameIn.value || Object.values(W.profiles).some((x) => nameIn.value === x.prefix)) nameIn.value = pre; };
  const tagsIn = Object.assign(el('input'), { type: 'text', placeholder: 'ek, mörk, sommar' });
  const metersIn = Object.assign(el('input'), { type: 'number', min: 0.1, max: 50, step: 0.1, value: 2 });
  const sizeSel = el('select');
  for (const s of [512, 1024, 2048, 4096]) { const o = el('option', null, `${s} px`); o.value = s; sizeSel.append(o); }
  sizeSel.value = 1024;
  const saveBtn = el('button', 'primary', 'Spara textur');
  const saveMsg = el('div', 'note');
  const openSel = el('select');
  const rowOf = (lab, input, title) => { const r = el('div', 'row span2'); if (title) r.title = title; r.append(el('label', null, lab), input); return r; };
  saveCard.body.append(
    rowOf('Profil', profSel, 'Vem som använder texturen: styr namn, kartor och kontroller'),
    rowOf('Namn', nameIn), rowOf('Taggar', tagsIn), rowOf('Meter per upprepning', metersIn, 'Hur stor texturen är i världen'),
    rowOf('Storlek', sizeSel), saveBtn, saveMsg, rowOf('Öppna sparad', openSel, 'Texturer gjorda i verkstaden (med recept)'),
  );
  for (const el2 of [nameIn, tagsIn, metersIn]) el2.classList.add('text');
  async function listSaved() {
    const cat = await fetch('/assets/textures/catalog.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { textures: [] })).catch(() => ({ textures: [] }));
    openSel.replaceChildren(Object.assign(el('option', null, cat.textures.length ? 'Välj…' : 'Inga än'), { value: '' }));
    for (const t of cat.textures) { const o = el('option', null, `${t.name} (${W.profiles[t.profile]?.label ?? t.profile})`); o.value = t.name; openSel.append(o); }
  }
  openSel.onchange = async () => {
    if (!openSel.value) return;
    const r = await api(`/api/texture/recipe?name=${encodeURIComponent(openSel.value)}`);
    if (r.error) { saveMsg.textContent = r.error; return; }
    recipe.source = r.source; recipe.steps = r.steps ?? [];
    nameIn.value = r.name; profSel.value = r.profile; tagsIn.value = (r.tags ?? []).join(', '); metersIn.value = r.meters ?? 2;
    renderSource(); renderSteps(); commit();
  };
  saveBtn.onclick = async () => {
    const name = nameIn.value.trim().toLowerCase();
    const payload = { recipe, name, profile: profSel.value, tags: tagsIn.value.split(','), meters: Number(metersIn.value), size: Number(sizeSel.value) };
    saveMsg.textContent = 'Sparar…';
    let res = await api('/api/texture/save', payload);
    if (res.exists && confirm(`${name} finns redan. Skriva över?`)) res = await api('/api/texture/save', { ...payload, overwrite: true });
    saveMsg.textContent = res.error ? `Sparades inte: ${res.error}` : `Sparad: ${res.out} (${res.size} px, ${res.checks?.seamless ? 'sömlös' : 'söm syns'})`;
    if (!res.error) listSaved();
  };

  function card(title, accent) {
    const c = el('section', 'card glass');
    c.style.setProperty('--part', accent);
    const head = el('header');
    head.append(el('h2', null, title));
    const body = el('div', 'rows');
    c.append(head, body);
    side.append(c);
    return { card: c, body };
  }

  renderSource();
  renderSteps();
  listSaved();
  return {
    show() { resize(); if (!viewState.img) update(); },
    hide() {},
  };
}
