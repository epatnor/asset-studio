// En skylt mitt i vyn medan något laddar (en värld, modeller, gräset): en rad per steg med en mätare. Ett steg utan
// känt slut (frac null) får en mätare som glider fram och tillbaka. När alla rader är klara tonar skylten bort, om
// inget nytt steg läggs till strax efter. Texten i appen är på engelska.
//
//   const splash = createSplash(el, view);
//   splash.start('Loading Demo isle', [['land', 'Shaping the land'], ['assets', 'Textures']]);
//   splash.set('assets', 3 / 10, '3 / 10 files'); splash.done('land'); splash.add('grass', 'Growing the grass')
//   splash.start('Placing the nature', steps, { delay: 300 })   // syns bara om det tar längre tid än så
export function createSplash(el, parent) {
  const box = el('div', 'splash glass'), head = el('b'), list = el('div', 'srows');
  box.hidden = true;
  box.append(head, list);
  parent.append(box);
  let rows = new Map(), t0 = 0, hideT = null, outT = null, showT = null, running = false;
  const log = []; // [steg, millisekunder från start] för UI-testerna

  function show(delay = 0) {
    clearTimeout(hideT); clearTimeout(outT);
    running = true;
    const reveal = () => { box.hidden = false; box.classList.remove('out'); };
    if (!delay || !box.hidden) reveal();
    else if (!showT) showT = setTimeout(() => { showT = null; if (running) reveal(); }, delay);
  }
  function paint(row, frac, text) {
    row.frac = frac;
    row.r.classList.toggle('busy', frac == null);
    row.r.classList.toggle('ok', frac >= 1);
    row.fill.style.width = frac == null ? '' : `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
    row.val.textContent = text ?? (frac == null ? '' : frac >= 1 ? 'done' : `${Math.round(frac * 100)} %`);
  }
  function add(id, label) {
    show(box.hidden ? 1e9 : 0); // ett nytt steg i en skylt som väntar på att synas ändrar inte väntan
    if (rows.has(id)) { paint(rows.get(id), null); return; }
    const r = el('div', 'srow'), bar = el('div', 'sbar'), fill = el('i'), val = el('span', 'sval');
    bar.append(fill);
    r.append(el('span', 'slabel', label), val, bar);
    list.append(r);
    const row = { r, fill, val, frac: null };
    rows.set(id, row);
    paint(row, null);
  }
  // Alla rader klara: skylten tonar bort (efter en kort stund, så att ett steg som följer direkt hinner läggas till)
  function maybeFinish() {
    if (![...rows.values()].every((x) => x.frac >= 1)) return;
    clearTimeout(hideT);
    hideT = setTimeout(() => {
      running = false;
      clearTimeout(showT); showT = null;
      box.classList.add('out');
      outT = setTimeout(() => { box.hidden = true; }, 350);
    }, 350);
  }
  function set(id, frac, text) {
    const row = rows.get(id);
    if (!row || !running) return;
    const was = row.frac;
    paint(row, frac, text);
    if (frac >= 1 && !(was >= 1)) { log.push([id, Math.round(performance.now() - t0)]); maybeFinish(); }
  }
  return {
    start(title, steps = [], { delay = 0 } = {}) {
      clearTimeout(showT); showT = null;
      if (delay) { box.hidden = true; box.classList.remove('out'); }
      head.textContent = title;
      list.replaceChildren();
      rows = new Map();
      t0 = performance.now();
      log.length = 0;
      show(delay);
      for (const [id, label] of steps) add(id, label);
    },
    add, set,
    done(id, text) { set(id, 1, text); },
    has: (id) => running && rows.has(id) && !(rows.get(id).frac >= 1),
    get active() { return running; },
    get log() { return log; },
  };
}
