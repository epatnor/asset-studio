// Biblioteket i Asset Studio (docs/asset-studio.md, Familjer och fasta modeller): en vy som FAB eller Quixel, med
// kategorier, Familj och Fast, taggar och sök. En familj är ett recept som kan öppnas i studion och varieras; en fast
// modell ligger kvar som den är. Frys gör en familj till en fast modell, Tina öppnar en fast modells recept i studion.
// Texturverkstadens sparade material (assets/textures/catalog.json) ligger här som Material och öppnas i The Atelier.
// Miniatyrer som saknas renderas här (three.js, PNG med alfa) och sparas bredvid modellen via servern.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const CATS = [['all', 'All'], ['tree', 'Trees'], ['bush', 'Bushes'], ['plant', 'Plants'], ['rock', 'Rocks'], ['prop', 'Props'], ['building', 'Buildings'], ['texture', 'Materials']];
const CAT_LABEL = Object.fromEntries(CATS);
const SOURCE_LABEL = { tree: 'Tree generator', prop: 'Prop generator', plant: 'Plant generator', building: 'Building generator', imported: 'Imported', fixed: 'Fixed model', texture: 'Texture workshop' };
const KIND_LABEL = { family: 'Family', fixed: 'Fixed', material: 'Material' };
const KIND_HELP = {
  family: 'Family: a recipe the generator can rebuild, with new seeds and changed sliders',
  fixed: 'Fixed model: one specific model that stays as it is',
  material: 'Material: a texture recipe from The Atelier, with its maps',
};
const THUMB_PX = 384;

// --- Miniatyrer: en egen liten renderare, modellen inramad snett ovanifrån ---
let R = null;
function thumbRenderer() {
  if (R) return R;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(THUMB_PX, THUMB_PX, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#e2efff', '#55603f', 1.7));
  const sun = new THREE.DirectionalLight('#fff0da', 2.8);
  sun.position.set(4, 9, 6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  R = { renderer, scene, camera, loader: new GLTFLoader().setMeshoptDecoder(MeshoptDecoder) };
  return R;
}
function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}
// prepare(mesh, url): studions materialpatch (löv, bark, mossa), så att miniatyren ser ut som i studion
export async function renderThumb(modelUrl, prepare) {
  const { renderer, scene, camera, loader } = thumbRenderer();
  const obj = (await loader.loadAsync(modelUrl)).scene;
  // Skuggformen (bollarna som bara kastar skugga, applyShadowRole i showcase/materials.js) ska inte synas
  const proxies = [];
  obj.traverse((o) => { if (o.isMesh && o.material?.userData?.shadowProxy) proxies.push(o); });
  for (const o of proxies) { o.removeFromParent(); o.geometry.dispose(); o.material.dispose(); }
  if (prepare) obj.traverse((o) => { if (o.isMesh) prepare(o, modelUrl); });
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj), center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 0.9;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.55, 1.3).normalize(), dist);
  camera.near = dist / 100; camera.far = dist * 10;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(obj);
  dispose(obj);
  return url;
}

export function createLibrary({ api, el, root, canOpen, openInStudio, openInAtelier, prepare }) {
  let items = [], loose = [];
  const f = { source: 'lib', kind: 'all', cat: 'all', tags: new Set(), q: '', sort: 'new' };
  let sel = null; // modellsökvägen för det valda kortet
  const pool = () => (f.source === 'lib' ? items : loose);
  const find = (model) => items.find((i) => i.model === model) ?? loose.find((i) => i.model === model);
  const bust = new Map(); // nya miniatyrer: ladda om bilden trots cachen

  // --- Stommen: sidopanel, rutnät och detaljpanel ---
  const side = el('aside', 'lside glass'), main = el('section', 'lmain'), detail = el('aside', 'ldetail glass');
  root.append(side, main, detail);
  const bar = el('div', 'lbar glass');
  const search = Object.assign(el('input', 'search'), { type: 'search', placeholder: 'Search name, species, tag …' });
  search.oninput = () => { f.q = search.value.trim().toLowerCase(); renderGrid(); };
  const sortSel = el('select');
  for (const [v, l] of [['new', 'Newest first'], ['name', 'Name'], ['cat', 'Category']]) { const o = el('option', null, l); o.value = v; sortSel.append(o); }
  sortSel.onchange = () => { f.sort = sortSel.value; renderGrid(); };
  const count = el('span', 'lcount');
  const thumbsBtn = el('button', null, 'Make thumbnails');
  thumbsBtn.title = 'Renders thumbnails for the visible assets that lack one';
  const refreshBtn = Object.assign(el('button', 'icon'), { title: 'Reload the library',
    innerHTML: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>' });
  refreshBtn.onclick = () => load();
  bar.append(search, sortSel, count, thumbsBtn, refreshBtn);
  const grid = el('div', 'lgrid');
  main.append(bar, grid);

  function seg(options, value, onchange) {
    const s = el('div', 'seg');
    for (const [v, l] of options) {
      const b = el('button', v === value ? 'on' : null, l);
      b.onclick = () => { onchange(v); };
      s.append(b);
    }
    return s;
  }

  // --- Urval ---
  const matchesQ = (i) => !f.q || [i.name, i.preset, CAT_LABEL[i.category], ...(i.tags ?? [])].some((x) => x && String(x).toLowerCase().includes(f.q));
  const baseFilter = (i) => (f.kind === 'all' || i.kind === f.kind) && matchesQ(i) && [...f.tags].every((t) => i.tags?.includes(t));
  function visible() {
    const list = pool().filter((i) => baseFilter(i) && (f.cat === 'all' || i.category === f.cat));
    const by = { new: (a, b) => String(b.saved ?? '').localeCompare(String(a.saved ?? '')) || a.name.localeCompare(b.name),
                 name: (a, b) => a.name.localeCompare(b.name),
                 cat: (a, b) => CATS.findIndex((c) => c[0] === a.category) - CATS.findIndex((c) => c[0] === b.category) || a.name.localeCompare(b.name) };
    return list.sort(by[f.sort]);
  }

  // --- Sidopanelen: källa, sort, kategorier med antal, taggar ---
  function renderSide() {
    side.replaceChildren();
    side.append(el('h2', null, 'The Vault'));
    side.append(seg([['lib', `Library ${items.length}`], ['loose', `Not added ${loose.length}`]], f.source, (v) => { f.source = v; f.tags.clear(); sel = null; renderAll(); }));
    side.lastChild.title = 'Not added: models under assets/ that are not in the library yet';
    side.append(el('h3', null, 'Kind'));
    const ks = seg([['all', 'All'], ['family', 'Family'], ['fixed', 'Fixed']], f.kind, (v) => { f.kind = v; renderAll(); });
    ks.title = `${KIND_HELP.family}. ${KIND_HELP.fixed}.`;
    side.append(ks);
    side.append(el('h3', null, 'Categories'));
    const cats = el('nav', 'lcats');
    for (const [c, label] of CATS) {
      const n = pool().filter((i) => baseFilter(i) && (c === 'all' || i.category === c)).length;
      const b = el('button', c === f.cat ? 'on' : null);
      b.append(el('span', null, label), el('span', 'n', String(n)));
      b.onclick = () => { f.cat = c; renderAll(); };
      cats.append(b);
    }
    side.append(cats);
    const counts = new Map();
    for (const i of pool()) for (const t of i.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    if (counts.size) {
      side.append(el('h3', null, 'Tags'));
      const chips = el('div', 'chips');
      for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
        const c = el('button', `chip${f.tags.has(t) ? ' on' : ''}`, t);
        c.title = `${n}`;
        c.onclick = () => { if (f.tags.has(t)) f.tags.delete(t); else f.tags.add(t); renderAll(); };
        chips.append(c);
      }
      side.append(chips);
    }
  }

  // --- Rutnätet ---
  const thumbUrl = (i) => (i.thumbnail ? `/${i.thumbnail}${bust.has(i.model) ? `?v=${bust.get(i.model)}` : ''}` : null);
  function card(i) {
    const fig = el('figure', `lcard${i.model === sel ? ' sel' : ''}${i.type === 'texture' ? ' tex' : ''}`);
    const box = el('div', 'lthumb');
    const url = thumbUrl(i);
    if (url) box.append(Object.assign(el('img'), { src: url, loading: 'lazy', alt: '' }));
    else box.append(el('span', 'ph', CAT_LABEL[i.category] ?? i.type));
    const kb = el('span', `kindb ${i.kind}`, KIND_LABEL[i.kind]);
    kb.title = KIND_HELP[i.kind];
    box.append(kb);
    if (i.checks_ok === false) box.append(Object.assign(el('span', 'warnb', '!'), { title: 'The checks failed when it was saved' }));
    const nv = (i.variants?.items.length ?? 0);
    if (nv > 1) box.append(Object.assign(el('span', 'poolb', `×${nv}`), { title: `Variant pool: ${nv} ready variants` }));
    if (f.source === 'loose') {
      const add = el('button', 'mini primary addb', '+ Add');
      add.onclick = (e) => { e.stopPropagation(); addToLibrary(i); };
      box.append(add);
    }
    const cap = el('figcaption');
    cap.append(el('b', null, i.name), el('span', null, [CAT_LABEL[i.category], i.seed != null ? `seed ${i.seed}` : SOURCE_LABEL[i.type]].filter(Boolean).join(' · ')));
    fig.append(box, cap);
    fig.onclick = () => { sel = i.model; renderGrid(); renderDetail(); };
    fig.ondblclick = () => { if (i.type === 'texture') openInAtelier(i.name); else if (canOpen(i)) openInStudio(i); };
    return fig;
  }
  function renderGrid() {
    const list = visible();
    count.textContent = `${list.length} items`;
    const missing = list.filter((i) => !i.thumbnail && i.type !== 'texture').length;
    thumbsBtn.textContent = missing ? `Make thumbnails (${missing})` : 'Thumbnails done';
    thumbsBtn.disabled = !missing || making;
    grid.replaceChildren(...list.map(card));
    if (!list.length) grid.append(el('div', 'lempty', f.source === 'lib' && !items.length
      ? 'The library is empty. Save from the studio, or add models under Not added.'
      : 'Nothing matches the selection.'));
  }

  // --- Detaljpanelen ---
  function renderDetail() {
    const i = sel && find(sel);
    detail.classList.toggle('open', !!i);
    main.classList.toggle('narrow', !!i);
    detail.replaceChildren();
    if (!i) return;
    const inLib = items.includes(i);
    const close = Object.assign(el('button', 'icon lclose'), { title: 'Close', innerHTML: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>' });
    close.onclick = () => { sel = null; renderGrid(); renderDetail(); };
    const big = el('div', 'lbig');
    const url = thumbUrl(i);
    if (url) big.append(Object.assign(el('img'), { src: url, alt: '' })); else big.append(el('span', 'ph', 'No thumbnail yet'));
    const head = el('div', 'lhead');
    head.append(el('h2', null, i.name));
    const badges = el('div', 'btns');
    badges.append(Object.assign(el('span', `kindb ${i.kind}`, KIND_LABEL[i.kind]), { title: KIND_HELP[i.kind] }), el('span', 'catb', CAT_LABEL[i.category] ?? i.category));
    head.append(badges);
    detail.append(close, big, head);

    // Åtgärder
    const acts = el('div', 'lacts');
    const openable = canOpen(i);
    if (i.type === 'texture') {
      const open = el('button', 'primary', 'Open in The Atelier');
      open.title = 'Open the texture recipe in the texture workshop';
      open.onclick = () => openInAtelier(i.name);
      acts.append(open);
      detail.append(acts);
      const dl = el('dl', 'linfo');
      const fact = (k, v) => { if (v != null && v !== '') dl.append(el('dt', null, k), el('dd', null, String(v))); };
      fact('Source', SOURCE_LABEL.texture);
      fact('Profile', i.profile);
      fact('Maps', i.maps?.join(', '));
      fact('Size', i.size ? `${i.size} px` : null);
      fact('Tile', i.meters ? `${i.meters} m` : null);
      fact('Tags', i.tags?.join(', '));
      fact('Saved', i.saved ? new Date(i.saved).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : null);
      fact('Recipe', i.recipe);
      detail.append(dl);
      return;
    }
    if (i.kind === 'family') {
      const open = el('button', 'primary', 'Open in the studio');
      open.disabled = !openable;
      open.title = openable ? 'Load the recipe in the studio to change and vary it' : 'The studio has no sliders for this generator or species yet';
      open.onclick = () => openInStudio(i);
      const freeze = el('button', null, 'Freeze…');
      freeze.title = 'Make a fixed model of this (a copy under assets/fixed/, the recipe comes along)';
      freeze.onclick = () => freezeItem(i);
      acts.append(open, freeze);
    } else {
      const thaw = el('button', 'primary', 'Thaw in the studio');
      thaw.disabled = !openable;
      thaw.title = openable ? 'Open the recipe in the studio; saving makes it a new family' : i.recipe ? 'The studio has no sliders for this generator or species yet' : 'No recipe (imported model)';
      thaw.onclick = () => openInStudio(i);
      acts.append(thaw);
    }
    const mk = el('button', null, i.thumbnail ? 'New thumbnail' : 'Make thumbnail');
    mk.onclick = async () => { mk.disabled = true; await makeThumb(i); renderAll(); };
    acts.append(mk);
    if (inLib) {
      const rm = el('button', 'danger', 'Remove from the library');
      rm.title = 'Only removes the catalog row; the files stay under Not added';
      rm.onclick = async () => { if (!confirm(`Remove ${i.name} from the library? The files stay.`)) return; await post('remove', { model: i.model }); sel = null; await load(); };
      acts.append(rm);
    } else {
      const add = el('button', null, '+ Add to the library');
      add.onclick = () => addToLibrary(i);
      acts.append(add);
    }
    detail.append(acts);

    if (inLib && i.kind === 'family') detail.append(variantSection(i));
    if (inLib) detail.append(scatterSection(i));

    // Kategori och taggar (bara för det som ligger i biblioteket)
    if (inLib) {
      const catRow = el('div', 'row span2');
      const cs = el('select');
      for (const [c, l] of CATS.slice(1)) { const o = el('option', null, l); o.value = c; cs.append(o); }
      cs.value = i.category;
      cs.onchange = async () => { await post('update', { model: i.model, category: cs.value }); await load(); };
      catRow.append(el('label', null, 'Category'), cs);
      const tagBox = el('div', 'chips');
      const setTags = async (tags) => { await post('update', { model: i.model, tags }); await load(); };
      for (const t of i.tags ?? []) {
        const c = el('span', 'chip on', t);
        const x = el('button', 'x', '×');
        x.title = `Remove ${t}`;
        x.onclick = () => setTags(i.tags.filter((y) => y !== t));
        c.append(x);
        tagBox.append(c);
      }
      const add = Object.assign(el('input', 'text tagin'), { placeholder: '+ tag' });
      add.onkeydown = (e) => { if (e.key === 'Enter' && add.value.trim()) setTags([...(i.tags ?? []), ...add.value.split(',')]); };
      tagBox.append(add);
      const sec = el('div', 'rows lsec');
      sec.append(catRow, el('label', 'lab', 'Tags'), tagBox);
      detail.append(sec);
    }

    // Fakta
    const dl = el('dl', 'linfo');
    const fact = (k, v) => { if (v == null || v === '') return; dl.append(el('dt', null, k), el('dd', null, String(v))); };
    fact('Source', SOURCE_LABEL[i.type] ?? i.type);
    fact('Recipe', i.preset ? `${i.preset}${i.seed != null ? `, seed ${i.seed}` : ''}` : i.recipe ? 'yes' : 'missing');
    fact('Frozen from', i.from?.name);
    fact('Origin', i.origin);
    fact('License', i.license);
    fact('Checks', i.checks_ok == null ? null : i.checks_ok ? 'passed' : 'failed');
    fact('Saved', i.saved ? new Date(i.saved).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : null);
    fact('Model', i.model);
    detail.append(dl);
  }

  // --- Variantpoolen (B2): familjens modell plus N varianter med nya frön, byggda av servern ---
  const jobs = new Map(); // modell -> förlopp medan poolen byggs
  function variantSection(i) {
    const sec = el('section', 'lsec2');
    const pool = i.variants?.items ?? [];
    sec.append(el('h3', null, `Variants${pool.length ? ` (${pool.length})` : ''}`));
    if (pool.length) {
      const strip = el('div', 'vstrip');
      for (const v of pool) {
        const f = el('figure');
        if (v.thumbnail) f.append(Object.assign(el('img'), { src: `/${v.thumbnail}${bust.has(v.model) ? `?v=${bust.get(v.model)}` : ''}`, alt: '' }));
        else f.append(el('span', 'ph', '…'));
        f.append(el('figcaption', null, v.main ? `${v.seed} (own)` : String(v.seed)));
        if (v.checks_ok === false) f.classList.add('bad');
        f.title = `seed ${v.seed}${v.height_m ? `, ${v.height_m} m` : ''}${v.checks_ok === false ? ', checks red' : ''}`;
        strip.append(f);
      }
      sec.append(strip);
    } else sec.append(el('div', 'note', 'No pool yet. The world needs some ready variants of the family to scatter; it picks the one nearest the seed.'));
    const row = el('div', 'btns');
    const n = el('select');
    for (const k of [4, 8, 12, 16]) { const o = el('option', null, `${k} new`); o.value = k; n.append(o); }
    n.value = String(Math.min(16, Math.max(4, Math.round(((pool.length || 9) - 1) / 4) * 4)));
    const build = el('button', 'primary', pool.length ? 'Rebuild the pool' : 'Build variant pool');
    build.title = 'The same recipe with new seeds; the server builds them one at a time';
    const prog = el('span', 'note');
    const job = jobs.get(i.model);
    if (job) { build.disabled = true; prog.textContent = job; }
    build.onclick = () => buildPool(i, Number(n.value));
    row.append(n, build);
    if (pool.length > 1) {
      const del = el('button', 'danger', 'Remove');
      del.title = 'Remove the variant pool (the family’s own model stays)';
      del.onclick = async () => { if (!confirm('Remove the variant pool?')) return; await post('variants', { model: i.model, count: 0 }); await load(); };
      row.append(del);
    }
    sec.append(row, prog);
    return sec;
  }
  async function buildPool(i, count) {
    const r = await post('variants', { model: i.model, count });
    if (r.error || !r.job) return;
    jobs.set(i.model, `Building 0/${count} …`);
    renderDetail();
    let st;
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 1200));
      st = await api(`/api/library/job?id=${r.job}`);
      if (st.error || st.done) break;
      jobs.set(i.model, `Building ${st.k}/${st.n} …`);
      if (sel === i.model) renderDetail();
    }
    // Miniatyrer för de nya varianterna, sedan läses biblioteket om
    const items = st.entry?.variants?.items ?? [];
    for (const [k, v] of items.entries()) {
      jobs.set(i.model, `Thumbnails ${k + 1}/${items.length} …`);
      if (sel === i.model) renderDetail();
      if (!v.thumbnail) await makeThumb(v);
    }
    jobs.delete(i.model);
    if (st.errors?.length) alert(`Some variants failed:\n${st.errors.join('\n')}`);
    await load();
  }

  // --- Utplacering (B2): hur världen sprider ut familjen (läses av Tinkertowns PCG i B3) ---
  function scatterSection(i) {
    const s = i.scatter ?? {};
    const sec = el('section', 'lsec2');
    sec.append(el('h3', null, 'Scatter'));
    if (i.bounds) sec.append(el('div', 'note', `Size: ${i.bounds.width} × ${i.bounds.depth} m, ${i.bounds.height} m tall`));
    const save = (patch) => { Object.assign(s, patch); post('update', { model: i.model, scatter: patch }); };
    const rows = el('div', 'rows');
    const slider = (label, key, min, max, step, help, fmt = (v) => v) => {
      const r = el('div', 'row');
      r.title = help;
      const inp = Object.assign(el('input'), { type: 'range', min, max, step, value: s[key] ?? min });
      const out = el('output', null, String(fmt(s[key] ?? min)));
      inp.oninput = () => { out.textContent = String(fmt(Number(inp.value))); };
      inp.onchange = () => save({ [key]: Number(inp.value) });
      r.append(el('label', null, label), inp, out);
      rows.append(r);
    };
    // Storlek: två tal (min och max)
    const sz = el('div', 'row span2');
    sz.title = 'Random scale per instance';
    const pair = el('div', 'pair');
    const [a, b] = s.scale ?? [1, 1];
    const lo = Object.assign(el('input'), { type: 'number', min: 0.05, max: 20, step: 0.05, value: a });
    const hi = Object.assign(el('input'), { type: 'number', min: 0.05, max: 20, step: 0.05, value: b });
    lo.onchange = hi.onchange = () => save({ scale: [Number(lo.value), Number(hi.value)] });
    pair.append(lo, el('span', null, '–'), hi);
    sz.append(el('label', null, 'Scale (×)'), pair);
    rows.append(sz);
    slider('Align to ground', 'align', 0, 1, 0.05, '0: always stands straight up (trees). 1: follows the ground slope (rocks, moss)', (v) => v.toFixed(2));
    slider('Max slope', 'max_slope', 0, 90, 1, 'Not placed where the ground is steeper than this', (v) => `${v}°`);
    slider('Radius (m)', 'radius', 0.1, Math.max(20, Math.ceil((i.bounds?.radius ?? 5) * 2)), 0.1, 'Footprint: how much room an instance takes (default from the model size)', (v) => v.toFixed(1));
    slider('Spacing (× radius)', 'spacing', 0.1, 4, 0.05, 'Minimum distance between instances, in radii. Below 1 they may overlap', (v) => v.toFixed(2));
    slider('Weight', 'weight', 0, 10, 0.1, 'How often the family is picked compared with others in the same place', (v) => v.toFixed(1));
    const rot = el('div', 'row span2');
    const rs = el('select');
    for (const [v, l] of [['y', 'Only around the up axis'], ['free', 'Free (tilted too)']]) { const o = el('option', null, l); o.value = v; rs.append(o); }
    rs.value = s.rotate ?? 'y';
    rs.onchange = () => save({ rotate: rs.value });
    rot.append(el('label', null, 'Rotation'), rs);
    rows.append(rot);
    // Biomer: taggar för var familjen hör hemma
    const bio = el('div', 'chips');
    const setBiomes = async (list) => { await post('update', { model: i.model, scatter: { biomes: list } }); await load(); };
    for (const t of s.biomes ?? []) {
      const c = el('span', 'chip on', t);
      const x = el('button', 'x', '×');
      x.onclick = () => setBiomes(s.biomes.filter((y) => y !== t));
      c.append(x);
      bio.append(c);
    }
    for (const t of ['forest', 'meadow', 'beach', 'mountain', 'village', 'swamp'].filter((t) => !(s.biomes ?? []).includes(t))) {
      const c = el('button', 'chip', `+ ${t}`);
      c.onclick = () => setBiomes([...(s.biomes ?? []), t]);
      bio.append(c);
    }
    const lab = el('div', 'row span2');
    lab.append(el('label', null, 'Biomes'), bio);
    rows.append(lab);
    sec.append(rows);
    return sec;
  }

  function renderAll() { renderSide(); renderGrid(); renderDetail(); }

  // --- Åtgärder mot servern ---
  const post = async (op, payload) => {
    const r = await api(`/api/library/${op}`, payload);
    if (r.error) alert(r.error);
    return r;
  };
  async function addToLibrary(i) {
    const r = await post('add', { model: i.model, tags: [] });
    if (r.error) return;
    sel = i.model;
    await load();
  }
  async function freezeItem(i) {
    const name = prompt('Name of the fixed model (a–z, 0–9 and _):', `${i.name}_fixed`);
    if (!name) return;
    const r = await post('freeze', { model: i.model, name: name.trim().toLowerCase() });
    if (r.error) return;
    f.source = 'lib';
    sel = r.entry.model;
    await load();
  }
  async function makeThumb(i) {
    try {
      const png = await renderThumb(`/${i.model}`, prepare);
      const r = await api('/api/library/thumb', { model: i.model, thumbnail: png });
      if (r.thumbnail) { i.thumbnail = r.thumbnail; bust.set(i.model, Date.now()); }
    } catch (e) { console.warn('miniatyr', i.model, e); }
  }
  let making = false;
  thumbsBtn.onclick = async () => {
    const todo = visible().filter((i) => !i.thumbnail && i.type !== 'texture');
    making = true;
    thumbsBtn.disabled = true;
    for (const [k, i] of todo.entries()) {
      thumbsBtn.textContent = `Thumbnails ${k + 1}/${todo.length} …`;
      await makeThumb(i);
      // Byt bara kortets bild, så att rutnätet inte hoppar medan det pågår
      const img = [...grid.children].find((c) => c.querySelector('figcaption b')?.textContent === i.name)?.querySelector('.lthumb');
      if (img && i.thumbnail) { img.querySelector('.ph')?.remove(); if (!img.querySelector('img')) img.prepend(Object.assign(el('img'), { src: thumbUrl(i), alt: '' })); }
    }
    making = false;
    renderAll();
  };

  // Ateljéns material: nyckeln (model) är texture:<namn>, miniatyren färgkartan
  const texItem = (t) => ({ name: t.name, model: `texture:${t.name}`, type: 'texture', kind: 'material', category: 'texture',
    thumbnail: `${t.files?.color ?? `assets/textures/${t.name}.png`}?v=${encodeURIComponent(t.saved ?? '')}`,
    tags: t.tags ?? [], saved: t.saved, profile: t.profile, maps: t.maps, size: t.size, meters: t.meters, recipe: t.recipe });
  async function load() {
    const [lib, scan, cat] = await Promise.all([api('/api/library'), api('/api/library/scan'),
      fetch('/assets/textures/catalog.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))]);
    items = [...(lib.items ?? []), ...(cat.textures ?? []).map(texItem)];
    loose = scan.items ?? [];
    if (sel && !find(sel)) sel = null;
    renderAll();
  }

  // Visa i The Vault (lådorna): välj saken, rensa urvalet och visa dess kategori; null visar bara biblioteket
  async function reveal(key) {
    await load();
    const i = key && find(key);
    if (!i) return;
    Object.assign(f, { source: items.includes(i) ? 'lib' : 'loose', kind: 'all', cat: i.category ?? 'all', q: '' });
    f.tags.clear();
    search.value = '';
    sel = key;
    renderAll();
    grid.querySelector('.lcard.sel')?.scrollIntoView({ block: 'center' });
  }

  return { show: load, reveal, hide() {} };
}
