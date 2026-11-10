// Var jobben körs (docs/asset-studio.md): knappen i headern växlar studions ComfyUI-jobb (texturer, Krea) mellan
// Darrowmere, som är standard, och den här datorn, så att RTX 4070 kan arbeta samtidigt som Darrowmeres T1000.
// Servern sparar valet (build/studio/jobs.json) och tools/comfy_target.py provar det målet först.

const NAMES = { darrowmere: 'Darrowmere', local: 'This PC' };
const ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2.5" width="12" height="4" rx="1"/><rect x="2" y="9.5" width="12" height="4" rx="1"/><circle cx="4.6" cy="4.5" r=".6" fill="currentColor"/><circle cx="4.6" cy="11.5" r=".6" fill="currentColor"/></svg>';

export function createJobsButton({ api, button }) {
  let info = null;
  const draw = () => {
    if (!info) return;
    const t = info.targets.find((x) => x.name === info.target);
    const other = info.targets.find((x) => x.name !== info.target);
    button.innerHTML = `<span class="gpuicon">${ICON}</span><span class="gpuname">${NAMES[info.target] ?? info.target}</span>`;
    button.classList.toggle('off', !!t && !t.up);
    button.title = `ComfyUI jobs run on ${NAMES[info.target] ?? info.target}${t && !t.up ? ' (not answering: jobs fall back to the next one that does)' : ''}.`
      + (other ? ` Click to run them on ${NAMES[other.name] ?? other.name}${other.up ? '' : ' (not running now)'}.` : '')
      + (info.target !== info.default ? ` Default: ${NAMES[info.default] ?? info.default}.` : '');
  };
  const load = () => api('/api/jobs').then((r) => { info = r; draw(); }).catch(() => {});
  button.onclick = async () => {
    if (!info) return;
    const other = info.targets.find((x) => x.name !== info.target);
    if (!other) return;
    const r = await api('/api/jobs', { target: other.name }).catch(() => null);
    if (r?.ok) { info = r; draw(); }
  };
  load();
  setInterval(load, 60000);
}
