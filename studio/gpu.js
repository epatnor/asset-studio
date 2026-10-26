// Grafikkortet (docs/asset-studio.md, Grafikkort): vilket kort studion ritar på, ett önskemål till renderarna
// (powerPreference) och, där studioservern kan det, att öppna studion i ett eget fönster på ett annat kort.
// Webbläsaren väljer kort när den startar (på Linux) eller efter önskemålet (ofta på Windows och Mac). Ren klientkod.

const KEY = 'studio-gpu';
// high-performance som standard: studion är ett 3D-verktyg
// ?gpu= i adressen (studioservern sätter det när den öppnar ett fönster på ett visst kort) sparas för den profilen
export function gpuPreference() {
  try {
    const q = new URLSearchParams(location.search).get('gpu');
    if (['high-performance', 'low-power', 'default'].includes(q)) localStorage.setItem(KEY, q);
    return localStorage.getItem(KEY) || 'high-performance';
  } catch { return 'high-performance'; }
}

// Bildtakten: ett tak för hur många bilder per sekund 3D-vyerna ritar (0 = skärmens takt). Bärbara datorer har ofta
// skärmar på 165–240 Hz; full takt med tungt gräs ger värme, fläktljud och coilwhine (spolarna på grafikkortet
// sjunger i bildtakten). 60 är standard.
const FPS_KEY = 'studio-fps';
// ?fps= i adressen (0, 30, 60 …) sätter taket för den profilen, som ?gpu= gör för kortet
let fpsCap = (() => {
  try {
    const q = new URLSearchParams(location.search).get('fps');
    if (q !== null && /^\d{1,3}$/.test(q)) localStorage.setItem(FPS_KEY, q);
    const v = localStorage.getItem(FPS_KEY);
    return v === null ? 60 : Number(v);
  } catch { return 60; }
})();
export const fpsLimit = () => fpsCap;
// En spärr per ritslinga: frameGate()(now) är sann när det är dags för nästa bild under taket
export function frameGate() {
  let last = -Infinity;
  return (now) => {
    if (!fpsCap) return true;
    // Lite marginal, så att en skärm på 165 Hz ger cirka 55 och en på 240 Hz exakt 60 bilder per sekund
    if (now - last < (1000 / fpsCap) * 0.92) return false;
    last = now;
    return true;
  };
}

// Kortets namn ur WebGL (ANGLE (AMD, AMD Radeon 780M Graphics (radeonsi ...), OpenGL ES 3.2)) och WebGPU:s adapter
export async function detectGpu() {
  let gl = null;
  try {
    const c = document.createElement('canvas'), ctx = c.getContext('webgl2', { powerPreference: gpuPreference() });
    const ext = ctx?.getExtension('WEBGL_debug_renderer_info');
    gl = ctx ? String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER)) : null;
    ctx?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {}
  let webgpu = null;
  try {
    const a = navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: gpuPreference() === 'default' ? undefined : gpuPreference() }) : null;
    if (a) webgpu = [a.info?.vendor, a.info?.architecture, a.info?.description].filter(Boolean).join(' ') || 'yes';
  } catch {}
  return { name: cleanName(gl), raw: gl, webgpu };
}
export function cleanName(s) {
  if (!s) return 'Unknown graphics card';
  // ANGLE på Vulkan: ANGLE (NVIDIA, Vulkan 1.3.x (NVIDIA GeForce RTX 4070 Laptop GPU (0x...)), NVIDIA-615.78)
  const vk = s.match(/Vulkan[^(]*\(([^(]+?)\s*\(/);
  if (vk) return vk[1].trim();
  const m = s.match(/^ANGLE \(([^,]+), (.+?)(?:\s\(|, [^,]*$)/);
  let n = (m ? m[2] : s).replace(/\/PCIe\/SSE2|Direct3D\S*|vs_\S+|ps_\S+/g, '').trim();
  return n.replace(/\s+/g, ' ');
}
// Kort etikett till knappen: "RTX 4070 Laptop", "Radeon 780M"
export const shortName = (n) => n.replace(/^(NVIDIA|AMD|Intel\(R\)|Intel)\s+/i, '').replace(/^GeForce\s+/i, '').replace(/\s+(Graphics|GPU)$/i, '').replace(/\s+GPU$/i, '');

/**
 * Menyn i headern. button: knappen, root: där popovern hamnar, api: studions api(), el: elementhjälparen
 */
export async function createGpuMenu({ el, api, button, root }) {
  const info = await detectGpu();
  const label = el('span', 'gpuname', shortName(info.name));
  button.replaceChildren(Object.assign(el('span', 'gpuicon'), { innerHTML: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><circle cx="6" cy="8" r="1.8"/><path d="M10 6.5h2.5M10 9.5h2.5M3.5 12v1.5M7 12v1.5"/></svg>' }), label);
  button.title = `Graphics card: ${info.name}`;
  // Sidan berättar för servern vilket kort den ritar på (menyn i andra fönster kan visa det)
  api('/api/gpu/seen', { gpu: info.name, api: info.webgpu ? 'WebGPU' : 'WebGL2', webgpu: info.webgpu, page: location.hash || '/' }).catch(() => {});

  const pop = el('div', 'gpupop glass');
  root.append(pop);
  async function render() {
    pop.replaceChildren();
    pop.append(el('h3', null, 'This window draws on'));
    const now = el('div', 'gpunow');
    now.append(el('b', null, info.name), el('span', null, info.webgpu ? `WebGL2, and WebGPU on ${info.webgpu}` : 'WebGL2 (no WebGPU in this browser)'));
    pop.append(now);

    pop.append(el('h3', null, 'Preference'));
    const seg = el('div', 'seg');
    for (const [v, l, tip] of [['high-performance', 'Performance', 'Ask for the fast, dedicated card'], ['low-power', 'Power saving', 'Ask for the integrated card'], ['default', 'Auto', 'Let the browser choose']]) {
      const b = el('button', gpuPreference() === v ? 'on' : null, l);
      b.title = tip;
      b.onclick = () => { try { localStorage.setItem(KEY, v); } catch {} render(); hint.textContent = 'Reload the page to use it.'; };
      seg.append(b);
    }
    const hint = el('div', 'note', 'Sent to every 3D view. Windows and macOS often switch cards on it; on Linux the browser picks its card when it starts, so open the studio on a card below.');
    pop.append(seg, hint);

    pop.append(el('h3', null, 'Frame rate'));
    const fseg = el('div', 'seg');
    for (const [v, l, tip] of [[0, 'Display', 'As fast as the screen refreshes (165–240 Hz on many laptops)'], [60, '60 fps', 'Smooth, and much less load'], [30, '30 fps', 'Coolest and quietest']]) {
      const b = el('button', fpsCap === v ? 'on' : null, l);
      b.title = tip;
      b.onclick = () => { fpsCap = v; try { localStorage.setItem(FPS_KEY, String(v)); } catch {} render(); };
      fseg.append(b);
    }
    pop.append(fseg, el('div', 'note', 'A cap on how often the 3D views draw. Lower is cooler and quieter: coil whine and fan noise usually come from very high frame rates.'));

    const L = await api('/api/gpus').catch(() => null);
    if (L?.gpus?.length) {
      pop.append(el('h3', null, 'Open the studio on'));
      for (const g of L.gpus) {
        const b = el('button', 'gpuopen');
        b.append(el('b', null, g.name), el('span', null, [g.discrete ? 'dedicated' : 'integrated', g.default ? 'default' : null].filter(Boolean).join(' · ')));
        b.disabled = !L.canLaunch;
        b.title = `Opens the studio in its own window on ${g.name}`;
        b.onclick = async () => {
          const r = await api('/api/gpu/launch', { id: g.id, path: location.pathname + location.search + location.hash });
          msg.textContent = r.error ? r.error : `Opening on ${r.gpu}… (its own window, takes a few seconds)`;
        };
        pop.append(b);
      }
      const msg = el('div', 'note', L.canLaunch ? '' : 'The studio server cannot start a browser here.');
      pop.append(msg);
    }
  }
  button.onclick = (e) => { e.stopPropagation(); const open = !pop.classList.contains('open'); if (open) render(); pop.classList.toggle('open', open); };
  addEventListener('click', (e) => { if (!pop.contains(e.target)) pop.classList.remove('open'); });
  return info;
}
