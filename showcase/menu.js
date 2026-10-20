// Spelmenyn för alla banor: en liten HUD i hörnet och en pausmeny (Esc eller M) med flikar för banor,
// värld (tid, väder, vind), grafik, banans egna inställningar och kontroller. Ren klientkod (ingen Node).
//
//   const menu = createMenu(W, { level: 'skogen' });
//   menu.addLevelControls(elementOrHtml, 'Rubrik');  // banans egna reglage hamnar under fliken Bana
//   menu.setStatus('Laddar 3 / 20');                 // laddningsrad längst ned; menu.ready() när banan är klar
//
// Inställningar som kvalitet och fps-mätare sparas i webbläsaren (localStorage) och gäller alla banor.
import { LEVELS } from './levels.js';
import { WEATHER } from './atmosphere.js';

const CSS = `
#tt-ui { --bg: rgba(16, 22, 19, 0.78); --line: rgba(255, 255, 255, 0.10); --ink: #F3EFE2; --dim: #A9B8A4; --gold: #E8C26A;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--ink); }
#tt-ui * { box-sizing: border-box; }
#tt-hud { position: fixed; top: 14px; left: 14px; display: flex; gap: 8px; align-items: center; z-index: 20; pointer-events: none; }
#tt-hud .pill { pointer-events: auto; background: var(--bg); backdrop-filter: blur(10px); border: 1px solid var(--line); border-radius: 999px;
  padding: 7px 14px; font-size: 13px; display: flex; gap: 10px; align-items: center; box-shadow: 0 6px 22px rgba(0,0,0,.25); }
#tt-hud .pill b { font-weight: 650; letter-spacing: .2px; }
#tt-hud .sep { opacity: .35; }
#tt-hud button { all: unset; cursor: pointer; pointer-events: auto; background: var(--bg); backdrop-filter: blur(10px); border: 1px solid var(--line);
  border-radius: 999px; padding: 7px 14px; font-size: 13px; color: var(--ink); box-shadow: 0 6px 22px rgba(0,0,0,.25); transition: background .15s; }
#tt-hud button:hover { background: rgba(40, 52, 44, 0.9); }
#tt-hud .fps { font-variant-numeric: tabular-nums; color: var(--dim); }
#tt-status { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 20; background: var(--bg); backdrop-filter: blur(10px);
  border: 1px solid var(--line); border-radius: 999px; padding: 8px 16px; font-size: 13px; transition: opacity .6s; max-width: calc(100vw - 32px); text-align: center; }
#tt-status.hide { opacity: 0; pointer-events: none; }
#tt-overlay { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 16px;
  background: radial-gradient(ellipse at center, rgba(10,14,12,.35), rgba(10,14,12,.65)); backdrop-filter: blur(3px);
  opacity: 0; pointer-events: none; transition: opacity .18s ease; }
#tt-overlay.open { opacity: 1; pointer-events: auto; }
#tt-panel { width: min(820px, 100%); max-height: min(640px, calc(100vh - 32px)); display: flex; flex-direction: column; background: var(--bg);
  backdrop-filter: blur(16px); border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 24px 80px rgba(0,0,0,.45);
  transform: translateY(8px) scale(.985); transition: transform .2s ease; overflow: hidden; }
#tt-overlay.open #tt-panel { transform: none; }
#tt-head { display: flex; align-items: center; gap: 14px; padding: 18px 22px 10px; }
#tt-head h2 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: .3px; }
#tt-head h2 span { color: var(--gold); }
#tt-head .grow { flex: 1; }
#tt-tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--line); overflow-x: auto; }
#tt-tabs button { all: unset; cursor: pointer; padding: 10px 14px; font-size: 14px; color: var(--dim); border-bottom: 2px solid transparent; white-space: nowrap; }
#tt-tabs button.on { color: var(--ink); border-color: var(--gold); }
#tt-body { padding: 18px 22px 22px; overflow-y: auto; }
#tt-body section { display: none; }
#tt-body section.on { display: block; animation: ttfade .2s ease; }
@keyframes ttfade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.tt-btn { all: unset; cursor: pointer; padding: 9px 16px; border-radius: 12px; background: rgba(255,255,255,.08); border: 1px solid var(--line);
  font-size: 14px; color: var(--ink); transition: background .15s, border-color .15s; text-align: center; }
.tt-btn:hover { background: rgba(255,255,255,.14); }
.tt-btn.primary { background: var(--gold); color: #1c1a12; border-color: transparent; font-weight: 650; }
.tt-btn.primary:hover { background: #F2D186; }
.tt-btn.on { border-color: var(--gold); background: rgba(232, 194, 106, .16); }
.tt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.tt-card { all: unset; cursor: pointer; display: flex; flex-direction: column; justify-content: flex-end; min-height: 128px; padding: 14px; border-radius: 16px;
  position: relative; overflow: hidden; border: 1px solid var(--line); transition: transform .15s, box-shadow .15s; }
.tt-card:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(0,0,0,.35); }
.tt-card::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.55)); }
.tt-card > * { position: relative; z-index: 1; }
.tt-card b { font-size: 16px; }
.tt-card small { font-size: 12.5px; opacity: .88; line-height: 1.35; margin-top: 4px; }
.tt-card .here { position: absolute; top: 10px; right: 10px; font-size: 11px; padding: 3px 8px; border-radius: 999px; background: rgba(0,0,0,.45); }
.tt-row { display: flex; align-items: center; gap: 12px; margin: 10px 0; flex-wrap: wrap; }
.tt-row > label { min-width: 120px; color: var(--dim); font-size: 13.5px; }
.tt-row input[type=range] { flex: 1; min-width: 160px; accent-color: var(--gold); }
.tt-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.tt-weather { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.tt-weather .tt-btn { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 8px; }
.tt-weather svg { width: 30px; height: 30px; }
.tt-clock { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 1px; }
.tt-h { font-size: 12px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--dim); margin: 18px 0 8px; }
.tt-h:first-child { margin-top: 0; }
.tt-keys { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; font-size: 14px; }
.tt-keys kbd { font: 600 12px ui-monospace, monospace; padding: 3px 8px; border-radius: 6px; background: rgba(255,255,255,.1); border: 1px solid var(--line); white-space: nowrap; }
.tt-level label { display: flex; align-items: center; gap: 10px; font-size: 13.5px; margin: 8px 0; color: var(--ink); }
.tt-level label > span { min-width: 140px; color: var(--dim); }
.tt-level select, .tt-level input[type=range] { flex: 1; accent-color: var(--gold); }
.tt-level select { background: rgba(255,255,255,.08); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
.tt-level select option { color: #111; }
.tt-level details summary { cursor: pointer; color: var(--gold); margin: 10px 0 4px; }
.tt-note { font-size: 13px; color: var(--dim); line-height: 1.45; }
@media (max-width: 560px) { #tt-hud .pill .opt { display: none; } .tt-row > label { min-width: 0; width: 100%; } }
`;
const ICONS = {
  klart: '<circle cx="16" cy="16" r="6" fill="#F7C948"/><g stroke="#F7C948" stroke-width="2" stroke-linecap="round"><path d="M16 3v4M16 25v4M3 16h4M25 16h4M6.8 6.8l2.8 2.8M22.4 22.4l2.8 2.8M6.8 25.2l2.8-2.8M22.4 9.6l2.8-2.8"/></g>',
  molnigt: '<circle cx="11" cy="12" r="5" fill="#F7C948"/><path d="M9 25h15a5 5 0 0 0 0-10 7 7 0 0 0-13 2 4 4 0 0 0-2 8z" fill="#DCE3EA"/>',
  regn: '<path d="M8 19h16a5 5 0 0 0 0-10 7 7 0 0 0-13 2 4 4 0 0 0-3 8z" fill="#AEB9C6"/><g stroke="#6FB0F0" stroke-width="2" stroke-linecap="round"><path d="M11 22l-1.5 4M17 22l-1.5 4M23 22l-1.5 4"/></g>',
  storm: '<path d="M8 18h16a5 5 0 0 0 0-10 7 7 0 0 0-13 2 4 4 0 0 0-3 8z" fill="#7D8794"/><path d="M17 17l-4 7h4l-2 6 6-9h-4l2-4z" fill="#F7D148"/>',
  snö: '<path d="M8 18h16a5 5 0 0 0 0-10 7 7 0 0 0-13 2 4 4 0 0 0-3 8z" fill="#D7E0EA"/><g fill="#FFFFFF"><circle cx="11" cy="23" r="1.6"/><circle cx="17" cy="26" r="1.6"/><circle cx="23" cy="23" r="1.6"/><circle cx="14" cy="28.5" r="1.3"/></g>',
  dimma: '<g stroke="#C8D2DA" stroke-width="2.4" stroke-linecap="round"><path d="M5 11h22M8 16h19M5 21h22M9 26h15"/></g>',
};
const QUALITY = {
  'Låg': { ratio: 0.75, shadows: false, map: 1024, grass: 0.35 },
  'Medel': { ratio: 1, shadows: true, map: 1024, grass: 0.6 },
  'Hög': { ratio: 1.5, shadows: true, map: 2048, grass: 0.8 },
  'Ultra': { ratio: 2, shadows: true, map: 4096, grass: 1 },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(`tinkertown.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`tinkertown.${k}`, JSON.stringify(v)); } catch { /* privat läge: inget sparas */ } },
};
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
const fmtTime = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

export function createMenu(W, { level } = {}) {
  const lv = LEVELS.find((l) => l.id === level) ?? { name: document.title.replace(/^Tinkertown – /, '') };
  document.head.append(el('style', {}, CSS));
  const root = el('div', { id: 'tt-ui' });
  document.body.append(root);

  // ---------- HUD ----------
  const hud = el('div', { id: 'tt-hud' });
  const pill = el('div', { className: 'pill' });
  const clock = el('span', { className: 'opt' }), fps = el('span', { className: 'fps' });
  pill.append(el('b', { textContent: lv.name }), el('span', { className: 'sep opt', textContent: '·' }), clock, fps);
  const menuBtn = el('button', { textContent: 'Meny  Esc' });
  hud.append(pill, menuBtn);
  const status = el('div', { id: 'tt-status', textContent: 'Laddar…' });
  root.append(hud, status);

  // ---------- Pausmenyn ----------
  const overlay = el('div', { id: 'tt-overlay' });
  const panel = el('div', { id: 'tt-panel' });
  const head = el('div', { id: 'tt-head' }, `<h2>Tinkertown · <span>${lv.name}</span></h2><div class="grow"></div>`);
  const resume = el('button', { className: 'tt-btn primary', textContent: 'Fortsätt' });
  head.append(resume);
  const tabs = el('div', { id: 'tt-tabs' }), body = el('div', { id: 'tt-body' });
  panel.append(head, tabs, body);
  overlay.append(panel);
  root.append(overlay);
  const sections = {};
  const addTab = (id, label) => {
    const b = el('button', { textContent: label }), s = el('section');
    b.onclick = () => showTab(id);
    tabs.append(b); body.append(s);
    sections[id] = { b, s };
    return s;
  };
  function showTab(id) {
    for (const [k, v] of Object.entries(sections)) { v.b.classList.toggle('on', k === id); v.s.classList.toggle('on', k === id); }
    store.set('tab', id);
  }

  // Banor
  const levels = addTab('banor', 'Banor');
  const grid = el('div', { className: 'tt-grid' });
  for (const l of LEVELS) {
    const c = el(l.soon ? 'div' : 'a', { className: 'tt-card', href: l.url });
    if (l.soon) c.style.cursor = 'default';
    c.style.background = `linear-gradient(135deg, ${l.sky[0]}, ${l.sky[1]})`;
    c.innerHTML = `${l.id === level ? '<span class="here">Du är här</span>' : l.soon ? '<span class="here">Kommer snart</span>' : ''}<b>${l.name}</b><small>${l.desc}</small>`;
    c.style.boxShadow = `inset 0 -3px 0 ${l.accent}`;
    grid.append(c);
  }
  levels.append(grid);

  // Värld: tid, dygnet, väder, vind
  const atmo = W.atmo;
  if (atmo) {
    const world = addTab('varld', 'Värld');
    world.innerHTML = `<div class="tt-h">Tid på dygnet</div>`;
    const big = el('div', { className: 'tt-clock' });
    const tRow = el('div', { className: 'tt-row' });
    const tRange = el('input', { type: 'range', min: 0, max: 24, step: 0.05, value: atmo.state.time });
    tRow.append(big, tRange);
    const chips = el('div', { className: 'tt-chips' });
    for (const [label, h] of [['Gryning', 6.4], ['Förmiddag', 10], ['Middag', 13], ['Skymning', 17.6], ['Natt', 23]]) {
      const b = el('button', { className: 'tt-btn', textContent: label });
      b.onclick = () => { atmo.setTime(h); tRange.value = h; };
      chips.append(b);
    }
    const autoRow = el('div', { className: 'tt-row' });
    const auto = el('button', { className: 'tt-btn', textContent: 'Dygnet går: av' });
    const speed = el('select', {}, ['2', '6', '12', '24'].map((m) => `<option value="${m}">1 dygn = ${m} min</option>`).join(''));
    speed.className = 'tt-btn'; speed.value = String(atmo.state.dayMinutes);
    const setAuto = (on) => { atmo.state.auto = on; auto.textContent = `Dygnet går: ${on ? 'på' : 'av'}`; auto.classList.toggle('on', on); store.set('autoDay', on); };
    auto.onclick = () => setAuto(!atmo.state.auto);
    speed.onchange = () => { atmo.state.dayMinutes = Number(speed.value); store.set('dayMinutes', atmo.state.dayMinutes); };
    autoRow.append(auto, speed);
    tRange.oninput = () => atmo.setTime(Number(tRange.value));
    world.append(tRow, chips, autoRow, el('div', { className: 'tt-h', textContent: 'Väder' }));
    const wx = el('div', { className: 'tt-weather' }), wxBtns = {};
    for (const name of Object.keys(WEATHER)) {
      const b = el('button', { className: 'tt-btn' }, `<svg viewBox="0 0 32 32">${ICONS[name]}</svg>${name[0].toUpperCase() + name.slice(1)}`);
      b.onclick = () => { atmo.setWeather(name); for (const [k, v] of Object.entries(wxBtns)) v.classList.toggle('on', k === name); windRange.value = atmo.target.wind; };
      wxBtns[name] = b; wx.append(b);
    }
    wxBtns[atmo.state.weather]?.classList.add('on');
    const windRow = el('div', { className: 'tt-row' });
    const windRange = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: atmo.target.wind });
    windRange.oninput = () => (atmo.target.wind = Number(windRange.value));
    windRow.append(el('label', { textContent: 'Vind' }), windRange);
    world.append(wx, windRow);
    W.onFrame(() => { const t = fmtTime(atmo.state.time); big.textContent = t; clock.textContent = `${t}  ${atmo.state.weather}`; if (document.activeElement !== tRange) tRange.value = atmo.state.time; });
    if (store.get('autoDay', false)) setAuto(true);
    atmo.state.dayMinutes = store.get('dayMinutes', atmo.state.dayMinutes); speed.value = String(atmo.state.dayMinutes);
  }

  // Grafik
  const gfx = addTab('grafik', 'Grafik');
  gfx.innerHTML = '<div class="tt-h">Kvalitet</div>';
  const qChips = el('div', { className: 'tt-chips' }), qBtns = {};
  const applyQuality = (name) => {
    const q = QUALITY[name];
    W.renderer.setPixelRatio(Math.min(devicePixelRatio, q.ratio));
    W.renderer.shadowMap.enabled = q.shadows;
    if (W.sun?.shadow) { W.sun.castShadow = q.shadows; if (W.sun.shadow.mapSize.x !== q.map) { W.sun.shadow.mapSize.set(q.map, q.map); W.sun.shadow.map?.dispose(); W.sun.shadow.map = null; } }
    for (const u of W.grassFields ?? []) u.uDensity.value = q.grass;
    W.scene?.traverse((o) => { if (o.material && !Array.isArray(o.material)) o.material.needsUpdate = true; });
    W.renderer.shadowMap.needsUpdate = true;
    W.fx?.setQuality(name); // glöd, vinjett och volymetriskt ljus på Hög och Ultra
    for (const [k, b] of Object.entries(qBtns)) b.classList.toggle('on', k === name);
    store.set('quality', name);
  };
  for (const name of Object.keys(QUALITY)) { const b = el('button', { className: 'tt-btn', textContent: name }); b.onclick = () => applyQuality(name); qBtns[name] = b; qChips.append(b); }
  const fpsBtn = el('button', { className: 'tt-btn' });
  const setFps = (on) => { fps.style.display = on ? '' : 'none'; fpsBtn.textContent = `Bildfrekvens i hörnet: ${on ? 'på' : 'av'}`; fpsBtn.classList.toggle('on', on); store.set('fps', on); };
  fpsBtn.onclick = () => setFps(fps.style.display === 'none');
  const info = el('div', { className: 'tt-note' });
  gfx.append(qChips, el('div', { className: 'tt-h', textContent: 'Visning' }), fpsBtn, el('div', { className: 'tt-h', textContent: 'Just nu' }), info);
  setFps(store.get('fps', true));
  const startQuality = store.get('quality', null);

  // Banans egna inställningar
  const levelTab = addTab('bana', 'Bana');
  levelTab.classList.add('tt-level');
  sections.bana.b.style.display = 'none';
  const addLevelControls = (content, title) => {
    if (title) levelTab.append(el('div', { className: 'tt-h', textContent: title }));
    if (typeof content === 'string') levelTab.insertAdjacentHTML('beforeend', content); else levelTab.append(content);
    sections.bana.b.style.display = '';
    return levelTab;
  };

  // Kontroller
  const keys = addTab('kontroller', 'Kontroller');
  keys.innerHTML = `<div class="tt-keys">
    <kbd>Klick</kbd><span>Gå in i världen (förstaperson)</span>
    <kbd>W A S D</kbd><span>Gå</span><kbd>Shift</kbd><span>Spring</span><kbd>Space</kbd><span>Hoppa</span>
    <kbd>Mus</kbd><span>Titta</span><kbd>Tab</kbd><span>Växla mellan förstaperson och översikt</span>
    <kbd>Esc</kbd> <span>Släpp musen och öppna menyn</span><kbd>M</kbd><span>Öppna och stäng menyn</span>
    <kbd>1–5</kbd><span>Byt flik när menyn är öppen</span></div>`;

  // ---------- Öppna och stäng ----------
  let open = false, closingByUs = false;
  const setOpen = (on) => {
    open = on;
    overlay.classList.toggle('open', on);
    if (on) {
      W.fp?.keys?.clear();
      if (document.pointerLockElement) { closingByUs = true; document.exitPointerLock(); }
      showTab(sections[store.get('tab', 'banor')] && sections[store.get('tab', 'banor')].b.style.display !== 'none' ? store.get('tab', 'banor') : 'banor');
    }
  };
  resume.onclick = () => { setOpen(false); if (W.fp?.active) W.renderer.domElement.requestPointerLock(); };
  menuBtn.onclick = () => setOpen(!open);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) setOpen(false); });
  // Esc i förstaperson släpper musen (webbläsaren tar tangenten); då öppnas menyn, som en paus
  let lockReleased = 0;
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && !closingByUs && W.fp?.active) { setOpen(true); lockReleased = performance.now(); }
    closingByUs = false;
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'Escape' || e.code === 'KeyM') {
      e.stopImmediatePropagation();
      if (e.code === 'Escape' && performance.now() - lockReleased < 300) return; // samma Esc som släppte musen
      setOpen(!open);
      return;
    }
    if (!open) return;
    e.stopImmediatePropagation(); // spelet ska inte röra sig medan menyn är öppen
    const n = Number(e.key);
    if (n >= 1 && n <= 5) { const ids = Object.keys(sections).filter((k) => sections[k].b.style.display !== 'none'); if (ids[n - 1]) showTab(ids[n - 1]); }
  }, { capture: true });

  // ---------- Bildfrekvens ----------
  let frames = 0, t0 = performance.now();
  W.onFrame?.(() => {
    frames++;
    const now = performance.now();
    if (now - t0 < 500) return;
    const f = (frames * 1000) / (now - t0), r = W.renderer.info.render;
    fps.textContent = `${f.toFixed(0)} fps`;
    info.textContent = `${f.toFixed(0)} bilder/s · ${(1000 / f).toFixed(1)} ms · ${r.calls} ritanrop · ${(r.triangles / 1e6).toFixed(2)} M trianglar`;
    frames = 0; t0 = now;
  });

  // Tar över en sidas gamla infopanel: reglagen flyttas till fliken Bana, statusraden speglas i menyns
  // laddningsrad, och vind och fps (som menyn sköter) göms men finns kvar för sidans egen kod
  function adoptPanel(old) {
    if (!old) return;
    const st = old.querySelector('#status');
    for (const hide of old.querySelectorAll('#perf, #status, #wind')) (hide.closest('label') ?? hide).style.display = 'none';
    const about = el('div', { className: 'tt-note' });
    if (st) new MutationObserver(() => {
      const t = st.textContent.trim();
      about.textContent = t;
      if (/^Laddar/i.test(t)) menu.setStatus(t); else if (!readyDone) menu.ready();
    }).observe(st, { childList: true, characterData: true, subtree: true });
    const keep = [...old.children].filter((c) => !/^(H1|P)$/.test(c.tagName) && c.style.display !== 'none' && !c.matches('#perf, #status'));
    addLevelControls(about, 'Om banan');
    if (keep.length) { const box = el('div'); box.append(...keep); addLevelControls(box, 'Inställningar'); }
    old.style.display = 'none';
  }
  let readyDone = false;
  const menu = {
    adoptPanel,
    open: () => setOpen(true), close: () => setOpen(false), addLevelControls,
    setStatus: (t) => { status.textContent = t; status.classList.remove('hide'); },
    // Banan är klar: visa en kort hjälptext och tona bort raden
    ready: (text) => {
      readyDone = true;
      status.textContent = text ?? 'Klicka för att gå runt · Esc öppnar menyn';
      setTimeout(() => status.classList.add('hide'), 6000);
      applyQuality(startQuality ?? 'Hög');
    },
  };
  return menu;
}
