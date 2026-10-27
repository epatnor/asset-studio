// Korten till höger i Väderkvarnen och Häxkitteln: ett kort per grupp, och en rad per spak (reglage, färg, av och på,
// val). Spakarna är data (tools/<område>/*.json): key, label, help, min, max, step, type, options. get och set läser
// och skriver värdet, changed körs efter varje ändring. sync() ställer alla rader efter värdena (efter en förinställning).
export function createCards({ el, side }) {
  const syncs = [];
  const sync = () => { for (const s of syncs) s(); };
  // Ett kort som fälls ihop med ett klick på rubriken
  function card(title, accent, { closed = false, help } = {}) {
    const c = el('section', `card glass${closed ? ' closed' : ''}`);
    c.style.setProperty('--part', accent);
    const head = el('header'), body = el('div', 'rows');
    head.append(el('h2', null, title));
    if (help) head.title = help;
    head.onclick = () => c.classList.toggle('closed');
    c.append(head, body);
    side.append(c);
    return body;
  }
  // Ett reglage. Spakar som bygger om (rebuild) gör det när man släpper, de andra medan man drar
  function slider(q, get, set, changed) {
    const row = el('div', 'row'), r = el('input'), out = el('output');
    if (q.help) row.title = q.help;
    Object.assign(r, { type: 'range', min: q.min, max: q.max, step: q.step });
    const dec = q.step >= 1 ? 0 : q.step >= 0.1 ? 1 : q.step >= 0.01 ? 2 : 3;
    syncs.push(() => { r.value = get(q.key); out.textContent = Number(r.value).toFixed(dec); });
    const apply = () => { set(q.key, Number(r.value)); out.textContent = Number(r.value).toFixed(dec); changed?.(q); };
    if (q.rebuild) { r.oninput = () => { out.textContent = Number(r.value).toFixed(dec); }; r.onchange = apply; } else r.oninput = apply;
    row.append(el('label', null, q.label), r, out);
    return row;
  }
  // Av och på (iOS-reglage); q.sub står under etiketten
  function toggleRow(q, get, set, changed) {
    const row = el('div', 'row span2'), box = el('input', 'switch'), lab = el('label', 'twoline');
    box.type = 'checkbox';
    lab.append(document.createTextNode(q.label), el('small', null, q.sub ?? ''));
    if (q.help) row.title = q.help;
    syncs.push(() => { box.checked = !!get(q.key); });
    box.onchange = () => { set(q.key, box.checked); changed?.(q); };
    row.append(lab, box);
    return row;
  }
  // En färg; med q.reset en knapp som återställer till förvalet (ingen ändring)
  function colorRow(q, get, set, changed) {
    const row = el('div', 'row span2'), c = el('input');
    c.type = 'color';
    if (q.help) row.title = q.help;
    syncs.push(() => { c.value = get(q.key); });
    c.oninput = () => { set(q.key, c.value); changed?.(q); };
    if (q.reset) {
      const wrap = el('div', 'colreset'), b = el('button', 'icon', '↺');
      b.title = 'Reset (no change)';
      b.onclick = () => { set(q.key, q.default); c.value = q.default; changed?.(q); };
      wrap.append(c, b);
      row.append(el('label', null, q.label), wrap);
    } else row.append(el('label', null, q.label), c);
    return row;
  }
  // Ett val bland q.options ({ id, label, help }): knappar sida vid sida när de är få, annars en lista
  function choiceRow(q, get, set, changed) {
    const row = el('div', 'row span2');
    if (q.help) row.title = q.help;
    if (q.options.length <= 3) {
      const seg = el('div', 'seg');
      const btns = q.options.map((o) => {
        const b = el('button', null, o.label);
        if (o.help) b.title = o.help;
        b.onclick = () => { set(q.key, o.id); sync1(); changed?.(q); };
        seg.append(b);
        return [o.id, b];
      });
      const sync1 = () => { for (const [id, b] of btns) b.classList.toggle('on', id === get(q.key)); };
      syncs.push(sync1);
      row.append(el('label', null, q.label), seg);
    } else {
      const s = el('select');
      for (const o of q.options) s.append(Object.assign(el('option', null, o.label), { value: o.id, title: o.help ?? '' }));
      syncs.push(() => { s.value = get(q.key); });
      s.onchange = () => { set(q.key, s.value); changed?.(q); };
      row.append(el('label', null, q.label), s);
    }
    return row;
  }
  const ROWS = { color: colorRow, bool: toggleRow, choice: choiceRow };
  const rowFor = (q) => ROWS[q.type] ?? slider;
  return { syncs, sync, card, slider, toggleRow, colorRow, choiceRow, rowFor };
}

// Mallarnas ikoner i lådorna (assets/icons/<område>/<id>.png, ritade av tools/icons/make_icons.py). withIcon lägger
// ikonen till vänster i en mallruta; en sparad produkt får ikonen från mallen den byggdes från (from), annars sin
// första bokstav. src ersätter mallikonen med en annan bild (Smedjans sparade modeller visar sin miniatyr).
export function withIcon(el, tile, area, id, label, src) {
  const box = el('span', 'ticon');
  const letter = () => { box.replaceChildren(el('i', null, String(label ?? '?').trim().charAt(0).toUpperCase())); box.classList.add('letter'); };
  if (src || id) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = src ?? `/assets/icons/${area}/${id}.png`;
    img.onerror = letter;
    box.append(img);
  } else letter();
  const text = el('span', 'tbody');
  text.append(...tile.childNodes);
  tile.classList.add('has-icon');
  tile.append(box, text);
  return tile;
}
