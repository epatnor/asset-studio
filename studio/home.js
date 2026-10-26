// Landningssidan (docs/avdelningar.md): fyra verkstäder och storbiblioteket, var och en med illustration,
// accentfärg, underrubrik och en mening om vad man gör där. Texten i appen är på engelska.

export const DEPARTMENTS = [
  { id: 'forge', name: 'The Forge', sub: 'Build assets from recipes', accent: '#3f9a45', img: 'img/forge.webp',
    text: 'Trees, bushes, rocks, props, buildings and plants, grown from recipes and tuned with sliders.', ready: true },
  { id: 'windmill', name: 'The Windmill', sub: 'Wind, water and weather', accent: '#2f7fd8', img: 'img/windmill.webp',
    text: 'One wind for every tree and blade of grass, every kind of water, and weather that ties it together.', ready: true },
  { id: 'atelier', name: 'The Atelier', sub: 'Paint materials and textures', accent: '#c99a1c', img: 'img/atelier.webp',
    text: 'Seamless textures and full materials from recipes, painted by algorithms or by AI, tried on real shapes.', ready: true },
  { id: 'cauldron', name: 'The Cauldron', sub: 'Spells and game effects', accent: '#8b5cf6', img: 'img/cauldron.webp',
    text: 'Glows and auras, markers on the ground, particles, trails and hits, brewed as recipes for the game.', ready: false },
];
export const VAULT = { id: 'vault', name: 'The Vault', sub: 'Everything you have saved', accent: '#8a8f98', img: 'img/vault.webp',
  text: 'Families that grow new variants, fixed models with their own textures, and every recipe, in one place.', ready: true };

export function createHome({ el, root, api, open }) {
  const page = el('div', 'home');
  root.append(page);

  const hero = el('header', 'home-hero');
  hero.append(Object.assign(el('img', 'home-icon'), { src: 'img/icon/icon-192.png', alt: '' }), el('p', 'home-kicker', 'Azshara Studio'), el('h1', null, 'Asset Studio'),
    el('p', 'home-lead', 'The asset forge for our games: everything is a recipe, every recipe is a slider away from the next variant.'));
  page.append(hero);

  const card = (d, wide = false) => {
    const c = el('button', `home-card${wide ? ' wide' : ''}${d.ready ? '' : ' soon'}`);
    c.style.setProperty('--dept', d.accent);
    const pic = el('div', 'home-pic');
    const img = Object.assign(el('img'), { src: d.img, alt: '', loading: 'lazy' });
    img.onerror = () => img.remove(); // utan bild syns avdelningens färg
    pic.append(img);
    const body = el('div', 'home-body');
    body.append(el('span', 'home-sub', d.sub), el('h2', null, d.name), el('p', null, d.text));
    body.append(el('span', 'home-go', d.ready ? 'Open →' : 'Planned'));
    c.append(pic, body);
    c.onclick = () => { if (d.ready) open(d.id); };
    if (!d.ready) c.title = 'Planned; see docs/effektlabb.md';
    return c;
  };
  const grid = el('section', 'home-grid');
  grid.append(...DEPARTMENTS.map((d) => card(d)));
  page.append(grid, card(VAULT, true));

  // Senast sparat i biblioteket: små genvägar in i The Vault
  const recent = el('section', 'home-recent');
  page.append(recent);
  async function refreshRecent() {
    const lib = await api('/api/library').catch(() => ({ items: [] }));
    const items = (lib.items ?? []).filter((i) => i.thumbnail).sort((a, b) => String(b.saved ?? '').localeCompare(String(a.saved ?? ''))).slice(0, 6);
    recent.replaceChildren();
    if (!items.length) return;
    recent.append(el('h3', null, 'Recently saved'));
    const row = el('div', 'home-row');
    for (const i of items) {
      const f = el('button', 'home-item');
      f.append(Object.assign(el('img'), { src: `/${i.thumbnail}`, alt: '' }), el('span', null, i.name));
      f.onclick = () => open('vault');
      row.append(f);
    }
    recent.append(row);
  }

  return {
    show() { document.body.classList.add('home-mode'); refreshRecent(); },
    hide() { document.body.classList.remove('home-mode'); },
  };
}
