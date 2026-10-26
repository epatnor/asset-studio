// Smedjans låda (docs/avdelningar.md, Lådan): det biblioteket har av fliken typ, som tumnaglar till vänster, som
// Content Drawer i Unreal. Ett klick öppnar familjen i studion (en fast modell tinas, så att det som sparas blir en
// ny familj); Vault visar saken i The Vault, där Frys, Varianter och Spridning finns. Ateljéns låda är
// texturverkstadens bibliotek (studio/workshop.js). Ctrl+Mellanslag fäller ihop lådan (studio/studio.js).
import { renderThumb } from './library.js';

const KIND_CAT = { tree: 'tree', bush: 'bush', rock: 'rock', prop: 'prop', part: 'building' };

export function createForgeDrawer({ api, el, root, canOpen, open, reveal, prepare }) {
  let items = [], kind = null, q = '', current = null;
  const head = el('div', 'libhead'), body = el('div', 'libbody');
  const title = el('h2', null, 'Drawer');
  const search = Object.assign(el('input', 'search'), { type: 'search', placeholder: 'Search…' });
  search.oninput = () => { q = search.value.trim().toLowerCase(); render(); };
  const hint = el('div', 'note');
  head.append(title, search, hint);
  const foot = el('div', 'drawerfoot');
  const toVault = el('button', null, 'Open The Vault →');
  toVault.onclick = () => reveal(null);
  foot.append(toVault);
  root.append(head, body, foot);

  // Saknade miniatyrer renderas en i taget (samma renderare som The Vault) och sparas via servern
  let queue = Promise.resolve();
  function thumbLater(img, i) {
    queue = queue.then(async () => {
      if (!img.isConnected || i.thumbnail) return;
      try {
        const r = await api('/api/library/thumb', { model: i.model, thumbnail: await renderThumb(`/${i.model}`, prepare) });
        if (r.thumbnail) { i.thumbnail = r.thumbnail; img.src = `/${r.thumbnail}?v=${Date.now()}`; img.classList.remove('ph'); }
      } catch (e) { console.warn('miniatyr', i.model, e); }
    });
  }
  function tile(i) {
    const f = el('figure', `tile model${i.model === current ? ' on' : ''}`);
    const img = Object.assign(el('img'), { alt: '', loading: 'lazy' });
    if (i.thumbnail) img.src = `/${i.thumbnail}`; else { img.classList.add('ph'); thumbLater(img, i); }
    f.append(img);
    if (i.kind === 'fixed') f.append(el('span', 'badge fixed', 'Fixed'));
    const n = i.variants?.items.length ?? 0;
    if (n > 1) f.append(Object.assign(el('span', 'badge pool', `×${n}`), { title: `Variant pool: ${n} ready variants` }));
    f.append(el('figcaption', null, i.name));
    const openable = canOpen(i);
    f.title = openable
      ? `${i.name}: click to ${i.kind === 'fixed' ? 'thaw it (saving makes a new family)' : 'open it with its sliders'}`
      : `${i.name}: the studio has no sliders for this species yet; click to show it in The Vault`;
    f.onclick = () => (openable ? open(i) : reveal(i.model));
    const acts = el('div', 'acts');
    const v = el('button', 'mini', 'Vault');
    v.title = 'Show in The Vault (freeze, variants, scatter, tags)';
    v.onclick = (e) => { e.stopPropagation(); reveal(i.model); };
    acts.append(v);
    f.append(acts);
    return f;
  }
  function group(label, list) {
    if (!list.length) return;
    const g = el('section', 'libgroup'), grid = el('div', 'tiles');
    grid.append(...list.map(tile));
    g.append(el('h3', null, label), grid);
    body.append(g);
  }
  function render() {
    body.replaceChildren();
    if (!kind) return;
    const cat = KIND_CAT[kind.id] ?? kind.id;
    title.textContent = `${kind.label} drawer`;
    const mine = items.filter((i) => i.category === cat && (!q || [i.name, i.preset, ...(i.tags ?? [])].some((w) => w && String(w).toLowerCase().includes(q))));
    const byNew = (a, b) => String(b.saved ?? '').localeCompare(String(a.saved ?? '')) || a.name.localeCompare(b.name);
    group('Families', mine.filter((i) => i.kind !== 'fixed').sort(byNew));
    group('Fixed models', mine.filter((i) => i.kind === 'fixed').sort(byNew));
    hint.textContent = mine.length
      ? 'Click to open with the sliders. Vault shows it in The Vault.'
      : q ? 'Nothing matches.' : `No ${kind.label.toLowerCase()} in the library yet. Save one with Save.`;
  }
  async function refresh() {
    items = (await api('/api/library').catch(() => ({ items: [] }))).items ?? [];
    render();
  }

  refresh();
  return {
    refresh,
    setKind(k) { if (k !== kind) { kind = k; render(); } },
    mark(model) { current = model; render(); },
  };
}
