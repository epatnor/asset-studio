// Biblioteket i Asset Studio (docs/asset-studio.md, Familjer och fasta modeller): en vy som FAB eller Quixel, med
// kategorier, Familj och Fast, taggar och sök. En familj är ett recept som kan öppnas i studion och varieras; en fast
// modell ligger kvar som den är. Frys gör en familj till en fast modell, Tina öppnar en fast modells recept i studion.
// Miniatyrer som saknas renderas här (three.js, PNG med alfa) och sparas bredvid modellen via servern.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const CATS = [['all', 'Alla'], ['tree', 'Träd'], ['bush', 'Buskar'], ['plant', 'Växter'], ['rock', 'Stenar'], ['prop', 'Props'], ['building', 'Byggnader']];
const CAT_LABEL = Object.fromEntries(CATS);
const SOURCE_LABEL = { tree: 'Trädgeneratorn', prop: 'Propsgeneratorn', plant: 'Växtgeneratorn', building: 'Byggnadsgeneratorn', imported: 'Importerad', fixed: 'Fast modell' };
const KIND_LABEL = { family: 'Familj', fixed: 'Fast' };
const KIND_HELP = {
  family: 'Familj: ett recept som generatorn kan göra om, med nya frön och ändrade spakar',
  fixed: 'Fast modell: en bestämd modell som ligger kvar som den är',
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
async function renderThumb(modelUrl) {
  const { renderer, scene, camera, loader } = thumbRenderer();
  const obj = (await loader.loadAsync(modelUrl)).scene;
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

export function createLibrary({ api, el, root, canOpen, openInStudio }) {
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
  const search = Object.assign(el('input', 'search'), { type: 'search', placeholder: 'Sök namn, art, tagg …' });
  search.oninput = () => { f.q = search.value.trim().toLowerCase(); renderGrid(); };
  const sortSel = el('select');
  for (const [v, l] of [['new', 'Nyast först'], ['name', 'Namn'], ['cat', 'Kategori']]) { const o = el('option', null, l); o.value = v; sortSel.append(o); }
  sortSel.onchange = () => { f.sort = sortSel.value; renderGrid(); };
  const count = el('span', 'lcount');
  const thumbsBtn = el('button', null, 'Gör miniatyrer');
  thumbsBtn.title = 'Renderar miniatyrer för de synliga tillgångar som saknar en';
  const refreshBtn = Object.assign(el('button', 'icon'), { title: 'Läs om biblioteket',
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
    side.append(el('h2', null, 'Bibliotek'));
    side.append(seg([['lib', `Biblioteket ${items.length}`], ['loose', `Ej tillagda ${loose.length}`]], f.source, (v) => { f.source = v; f.tags.clear(); sel = null; renderAll(); }));
    side.lastChild.title = 'Ej tillagda: modeller under assets/ som ännu inte ligger i biblioteket';
    side.append(el('h3', null, 'Sort'));
    const ks = seg([['all', 'Alla'], ['family', 'Familj'], ['fixed', 'Fast']], f.kind, (v) => { f.kind = v; renderAll(); });
    ks.title = `${KIND_HELP.family}. ${KIND_HELP.fixed}.`;
    side.append(ks);
    side.append(el('h3', null, 'Kategorier'));
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
      side.append(el('h3', null, 'Taggar'));
      const chips = el('div', 'chips');
      for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
        const c = el('button', `chip${f.tags.has(t) ? ' on' : ''}`, t);
        c.title = `${n} st`;
        c.onclick = () => { if (f.tags.has(t)) f.tags.delete(t); else f.tags.add(t); renderAll(); };
        chips.append(c);
      }
      side.append(chips);
    }
  }

  // --- Rutnätet ---
  const thumbUrl = (i) => (i.thumbnail ? `/${i.thumbnail}${bust.has(i.model) ? `?v=${bust.get(i.model)}` : ''}` : null);
  function card(i) {
    const fig = el('figure', `lcard${i.model === sel ? ' sel' : ''}`);
    const box = el('div', 'lthumb');
    const url = thumbUrl(i);
    if (url) box.append(Object.assign(el('img'), { src: url, loading: 'lazy', alt: '' }));
    else box.append(el('span', 'ph', CAT_LABEL[i.category] ?? i.type));
    const kb = el('span', `kindb ${i.kind}`, KIND_LABEL[i.kind]);
    kb.title = KIND_HELP[i.kind];
    box.append(kb);
    if (i.checks_ok === false) box.append(Object.assign(el('span', 'warnb', '!'), { title: 'Kontrollerna gick inte igenom när den sparades' }));
    if (f.source === 'loose') {
      const add = el('button', 'mini primary addb', '+ Lägg till');
      add.onclick = (e) => { e.stopPropagation(); addToLibrary(i); };
      box.append(add);
    }
    const cap = el('figcaption');
    cap.append(el('b', null, i.name), el('span', null, [CAT_LABEL[i.category], i.seed != null ? `frö ${i.seed}` : SOURCE_LABEL[i.type]].filter(Boolean).join(' · ')));
    fig.append(box, cap);
    fig.onclick = () => { sel = i.model; renderGrid(); renderDetail(); };
    fig.ondblclick = () => { if (canOpen(i)) openInStudio(i); };
    return fig;
  }
  function renderGrid() {
    const list = visible();
    count.textContent = `${list.length} st`;
    const missing = list.filter((i) => !i.thumbnail).length;
    thumbsBtn.textContent = missing ? `Gör miniatyrer (${missing})` : 'Miniatyrer klara';
    thumbsBtn.disabled = !missing || making;
    grid.replaceChildren(...list.map(card));
    if (!list.length) grid.append(el('div', 'lempty', f.source === 'lib' && !items.length
      ? 'Biblioteket är tomt. Spara från studion, eller lägg till modeller under Ej tillagda.'
      : 'Inget matchar urvalet.'));
  }

  // --- Detaljpanelen ---
  function renderDetail() {
    const i = sel && find(sel);
    detail.classList.toggle('open', !!i);
    main.classList.toggle('narrow', !!i);
    detail.replaceChildren();
    if (!i) return;
    const inLib = items.includes(i);
    const close = Object.assign(el('button', 'icon lclose'), { title: 'Stäng', innerHTML: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>' });
    close.onclick = () => { sel = null; renderGrid(); renderDetail(); };
    const big = el('div', 'lbig');
    const url = thumbUrl(i);
    if (url) big.append(Object.assign(el('img'), { src: url, alt: '' })); else big.append(el('span', 'ph', 'Ingen miniatyr än'));
    const head = el('div', 'lhead');
    head.append(el('h2', null, i.name));
    const badges = el('div', 'btns');
    badges.append(Object.assign(el('span', `kindb ${i.kind}`, KIND_LABEL[i.kind]), { title: KIND_HELP[i.kind] }), el('span', 'catb', CAT_LABEL[i.category] ?? i.category));
    head.append(badges);
    detail.append(close, big, head);

    // Åtgärder
    const acts = el('div', 'lacts');
    const openable = canOpen(i);
    if (i.kind === 'family') {
      const open = el('button', 'primary', 'Öppna i studion');
      open.disabled = !openable;
      open.title = openable ? 'Ladda receptet i studion för att ändra och variera det' : 'Studion har inga spakar för den här generatorn eller arten än';
      open.onclick = () => openInStudio(i);
      const freeze = el('button', null, 'Frys…');
      freeze.title = 'Gör en fast modell av den här (kopia under assets/fixed/, receptet följer med)';
      freeze.onclick = () => freezeItem(i);
      acts.append(open, freeze);
    } else {
      const thaw = el('button', 'primary', 'Tina i studion');
      thaw.disabled = !openable;
      thaw.title = openable ? 'Öppna receptet i studion; sparar du blir det en ny familj' : i.recipe ? 'Studion har inga spakar för den här generatorn eller arten än' : 'Saknar recept (importerad modell)';
      thaw.onclick = () => openInStudio(i);
      acts.append(thaw);
    }
    const mk = el('button', null, i.thumbnail ? 'Ny miniatyr' : 'Gör miniatyr');
    mk.onclick = async () => { mk.disabled = true; await makeThumb(i); renderAll(); };
    acts.append(mk);
    if (inLib) {
      const rm = el('button', 'danger', 'Ta bort ur biblioteket');
      rm.title = 'Tar bara bort raden i katalogen; filerna ligger kvar under Ej tillagda';
      rm.onclick = async () => { if (!confirm(`Ta bort ${i.name} ur biblioteket? Filerna ligger kvar.`)) return; await post('remove', { model: i.model }); sel = null; await load(); };
      acts.append(rm);
    } else {
      const add = el('button', null, '+ Lägg till i biblioteket');
      add.onclick = () => addToLibrary(i);
      acts.append(add);
    }
    detail.append(acts);

    // Kategori och taggar (bara för det som ligger i biblioteket)
    if (inLib) {
      const catRow = el('div', 'row span2');
      const cs = el('select');
      for (const [c, l] of CATS.slice(1)) { const o = el('option', null, l); o.value = c; cs.append(o); }
      cs.value = i.category;
      cs.onchange = async () => { await post('update', { model: i.model, category: cs.value }); await load(); };
      catRow.append(el('label', null, 'Kategori'), cs);
      const tagBox = el('div', 'chips');
      const setTags = async (tags) => { await post('update', { model: i.model, tags }); await load(); };
      for (const t of i.tags ?? []) {
        const c = el('span', 'chip on', t);
        const x = el('button', 'x', '×');
        x.title = `Ta bort ${t}`;
        x.onclick = () => setTags(i.tags.filter((y) => y !== t));
        c.append(x);
        tagBox.append(c);
      }
      const add = Object.assign(el('input', 'text tagin'), { placeholder: '+ tagg' });
      add.onkeydown = (e) => { if (e.key === 'Enter' && add.value.trim()) setTags([...(i.tags ?? []), ...add.value.split(',')]); };
      tagBox.append(add);
      const sec = el('div', 'rows lsec');
      sec.append(catRow, el('label', 'lab', 'Taggar'), tagBox);
      detail.append(sec);
    }

    // Fakta
    const dl = el('dl', 'linfo');
    const fact = (k, v) => { if (v == null || v === '') return; dl.append(el('dt', null, k), el('dd', null, String(v))); };
    fact('Källa', SOURCE_LABEL[i.type] ?? i.type);
    fact('Recept', i.preset ? `${i.preset}${i.seed != null ? `, frö ${i.seed}` : ''}` : i.recipe ? 'finns' : 'saknas');
    fact('Frusen från', i.from?.name);
    fact('Ursprung', i.origin);
    fact('Licens', i.license);
    fact('Kontroller', i.checks_ok == null ? null : i.checks_ok ? 'godkända' : 'gick inte igenom');
    fact('Sparad', i.saved ? new Date(i.saved).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }) : null);
    fact('Modell', i.model);
    detail.append(dl);
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
    const name = prompt('Namn på den fasta modellen (a–z, 0–9 och _):', `${i.name}_fast`);
    if (!name) return;
    const r = await post('freeze', { model: i.model, name: name.trim().toLowerCase() });
    if (r.error) return;
    f.source = 'lib';
    sel = r.entry.model;
    await load();
  }
  async function makeThumb(i) {
    try {
      const png = await renderThumb(`/${i.model}`);
      const r = await api('/api/library/thumb', { model: i.model, thumbnail: png });
      if (r.thumbnail) { i.thumbnail = r.thumbnail; bust.set(i.model, Date.now()); }
    } catch (e) { console.warn('miniatyr', i.model, e); }
  }
  let making = false;
  thumbsBtn.onclick = async () => {
    const todo = visible().filter((i) => !i.thumbnail);
    making = true;
    thumbsBtn.disabled = true;
    for (const [k, i] of todo.entries()) {
      thumbsBtn.textContent = `Miniatyrer ${k + 1}/${todo.length} …`;
      await makeThumb(i);
      // Byt bara kortets bild, så att rutnätet inte hoppar medan det pågår
      const img = [...grid.children].find((c) => c.querySelector('figcaption b')?.textContent === i.name)?.querySelector('.lthumb');
      if (img && i.thumbnail) { img.querySelector('.ph')?.remove(); if (!img.querySelector('img')) img.prepend(Object.assign(el('img'), { src: thumbUrl(i), alt: '' })); }
    }
    making = false;
    renderAll();
  };

  async function load() {
    const [lib, scan] = await Promise.all([api('/api/library'), api('/api/library/scan')]);
    items = lib.items ?? [];
    loose = scan.items ?? [];
    if (sel && !find(sel)) sel = null;
    renderAll();
  }

  return { show: load, hide() {} };
}
