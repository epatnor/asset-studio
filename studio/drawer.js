// Smedjans låda (docs/avdelningar.md, Lådan): mallarna till vänster, samma mönster som Väderkvarnen, Vädret och
// Vattnet. Färdiga är en mall per familj (tools/tree/templates.json, stenarnas presets) med sin ikon; Sparade är det
// biblioteket har av fliken typ, med modellens miniatyr som ikon. Ett klick öppnar mallen eller familjen i studion
// (en fast modell tinas, så att det som sparas blir en ny familj); Vault visar saken i The Vault, där Frys, Varianter
// och Spridning finns. Ctrl+Mellanslag fäller ihop lådan (studio/studio.js).
import { renderThumb } from './library.js';
import { withIcon } from './cards.js';

const KIND_CAT = { tree: 'tree', bush: 'bush', rock: 'rock', prop: 'prop', part: 'building' };

export function createForgeDrawer({ api, el, root, templates, openTemplate, canOpen, open, reveal, prepare }) {
  let items = [], kind = null, q = '', current = null;
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  const title = el('h2', null, 'Templates');
  const search = Object.assign(el('input', 'search'), { type: 'search', placeholder: 'Search…' });
  search.oninput = () => { q = search.value.trim().toLowerCase(); render(); };
  const hint = el('div', 'note');
  head.append(title, hint, search);
  const foot = el('div', 'drawerfoot');
  const toVault = el('button', null, 'Open The Vault →');
  toVault.onclick = () => reveal(null);
  foot.append(toVault);
  root.append(head, body, foot);

  // Saknade miniatyrer renderas en i taget (samma renderare som The Vault) och sparas via servern
  let queue = Promise.resolve();
  function thumbLater(box, i) {
    queue = queue.then(async () => {
      if (!box.isConnected || i.thumbnail) return;
      try {
        const r = await api('/api/library/thumb', { model: i.model, thumbnail: await renderThumb(`/${i.model}`, prepare) });
        if (!r.thumbnail) return;
        i.thumbnail = r.thumbnail;
        const img = Object.assign(el('img'), { alt: '', src: `/${r.thumbnail}?v=${Date.now()}` });
        box.classList.remove('letter');
        box.replaceChildren(img);
      } catch (e) { console.warn('miniatyr', i.model, e); }
    });
  }
  const matches = (...words) => !q || words.some((w) => w && String(w).toLowerCase().includes(q));

  function templateTile(t) {
    const f = el('button', `wprof${t.model && t.model === current ? ' on' : ''}`);
    f.dataset.model = t.model ?? '';
    f.append(el('b', null, t.label));
    if (t.help) f.append(el('span', 'wmeta', t.help));
    f.title = `${t.label}: click to start from this template`;
    f.onclick = () => { openTemplate(t); };
    return withIcon(el, f, 'forge', t.id, t.label);
  }
  function savedTile(i) {
    const f = el('button', `wprof${i.model === current ? ' on' : ''}`);
    f.dataset.model = i.model;
    f.append(el('b', null, i.name));
    const n = i.variants?.items.length ?? 0;
    const meta = [i.kind === 'fixed' ? 'Fixed model' : 'Family', n > 1 ? `×${n} variants` : '', ...(i.tags ?? []).slice(0, 3)].filter(Boolean).join(' · ');
    f.append(el('span', 'wmeta', meta));
    const openable = canOpen(i);
    f.title = openable
      ? `${i.name}: click to ${i.kind === 'fixed' ? 'thaw it (saving makes a new family)' : 'open it with its sliders'}`
      : `${i.name}: the studio has no sliders for this species yet; click to show it in The Vault`;
    f.onclick = () => (openable ? open(i) : reveal(i.model));
    withIcon(el, f, null, null, i.name, i.thumbnail ? `/${i.thumbnail}` : null);
    if (!i.thumbnail) thumbLater(f.querySelector('.ticon'), i);
    const v = el('span', 'mini vault', 'Vault');
    v.title = 'Show in The Vault (freeze, variants, scatter, tags)';
    v.onclick = (e) => { e.stopPropagation(); reveal(i.model); };
    f.append(v);
    return f;
  }
  function section(label, tiles) {
    if (!tiles.length) return;
    const g = el('section', 'libgroup'), grid = el('div', 'wprofs');
    grid.append(...tiles);
    g.append(el('h3', null, label), grid);
    body.append(g);
  }
  function render() {
    body.replaceChildren();
    if (!kind) return;
    const cat = KIND_CAT[kind.id] ?? kind.id;
    title.textContent = `${kind.label} templates`;
    const ready = templates(kind).filter((t) => matches(t.label, t.id, t.help));
    const taken = new Set(ready.map((t) => t.model).filter(Boolean));
    const mine = items.filter((i) => i.category === cat && !taken.has(i.model) && matches(i.name, i.preset, ...(i.tags ?? [])));
    const byNew = (a, b) => String(b.saved ?? '').localeCompare(String(a.saved ?? '')) || a.name.localeCompare(b.name);
    section('Ready-made', ready.map(templateTile));
    section('Saved', mine.filter((i) => i.kind !== 'fixed').sort(byNew).map(savedTile));
    section('Fixed models', mine.filter((i) => i.kind === 'fixed').sort(byNew).map(savedTile));
    hint.textContent = q && !body.children.length ? 'Nothing matches.' : 'Click a template to start from it. Adjust on the right and save your own at the bottom.';
  }
  async function refresh() {
    items = (await api('/api/library').catch(() => ({ items: [] }))).items ?? [];
    render();
  }

  refresh();
  return {
    refresh,
    setKind(k) { if (k !== kind) { kind = k; render(); } },
    mark(model) { current = model; for (const b of body.querySelectorAll('.wprof')) b.classList.toggle('on', !!model && b.dataset.model === model); },
  };
}
