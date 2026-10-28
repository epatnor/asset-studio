"""UI-test av studion i Chrome utan fönster (headless) på RTX-kortet, styrt med Chromes felsökningsprotokoll (CDP).
Klickar, drar i spakar, svarar på dialogrutor, läser konsolen och tar skärmdumpar av hela gränssnittet, även när
skärmen är låst eller släckt (då står ett vanligt fönster på 0 fps). Studioservern måste vara igång (port 8770).

  python3 -I tools/studio/ui_test.py '<recept>'

Receptet: {"name": "maproom", "url": "/studio/#kartrummet", "size": [1600, 1000], "steps": [...]}. Stegen körs i
ordning; varje steg är ett av:
  {"wait": ms}                                 vänta
  {"until": "<js>", "timeout": ms}             vänta tills uttrycket är sant (standard 60 s)
  {"eval": "<js>"}                             kör JavaScript (await går bra); svaret hamnar i resultatet
  {"expect": "<js>", "label": "..."}           ett krav: uttrycket ska vara sant, annars blir ok false
  {"click": "<text>", "in": "<css>"}           klicka på den knapp (eller det element) i in vars text innehåller text
  {"slider": "<etikett>", "value": v, "in": "<css>"}   sätt en spak (input range bredvid etiketten) och skicka input
  {"select": "<etikett>", "value": "<id>", "in": "<css>"} välj i en lista (select bredvid etiketten)
  {"drag": [[x, y], [x, y], ...], "button": "left"}  musen trycks ned i första punkten, dras genom de andra och släpps
                                               (bildpunkter i fönstret; riktiga pekarhändelser, som penseln läser)
  {"prompt": "<svar>"}                         nästa prompt() eller confirm() besvaras så
  {"shot": "<namn>", "minLight": 40}           skärmdump av hela sidan → build/ui/<recept>_<namn>.png; med minLight ska
                                               mitten av bilden (3D-vyn) ha minst den ljusstyrkan (0–255), annars ok false
Hjälparna finns i sidan som window.__ui (click, slider, select, text). Svaret är en rad JSON: ok, stegen med resultat,
konsolfel och skärmdumparna. Chrome stängs alltid efteråt.
"""
import asyncio
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PORT = 9333
PROFILE = Path.home() / '.var/app/com.google.Chrome/data/asset-studio-test-ui'

HELPERS = r"""
window.__ui = {
  els(sel) { return [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null || e.tagName === 'BODY'); },
  click(text, sel = 'button') {
    const e = this.els(sel).find((x) => x.textContent.trim().includes(text));
    if (!e) throw new Error(`no ${sel} with "${text}"`);
    e.click();
    return e.textContent.trim().slice(0, 60);
  },
  slider(label, value, sel = 'body') {
    const lab = this.els(`${sel} label`).find((l) => l.textContent.trim() === label);
    const r = lab && lab.parentElement.querySelector('input[type=range]');
    if (!r) throw new Error(`no slider "${label}"`);
    r.value = value;
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return Number(r.value);
  },
  select(label, value, sel = 'body') {
    const lab = this.els(`${sel} label`).find((l) => l.textContent.trim() === label);
    const s = lab && lab.parentElement.querySelector('select');
    if (!s) throw new Error(`no list "${label}"`);
    s.value = value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.value;
  },
  text(sel) { return this.els(sel).map((e) => e.textContent.trim()).join(' | '); },
};
"""


def on_host(cmd):
    return ['host-spawn', *cmd] if Path('/run/.toolboxenv').exists() or Path('/run/.containerenv').exists() else cmd


def launch(url, size):
    close()  # ett tidigare test som inte hunnit stänga
    time.sleep(1)
    subprocess.run(on_host(['rm', '-rf', str(PROFILE)]), check=False)
    env = ['env', '__NV_PRIME_RENDER_OFFLOAD=1', '__GLX_VENDOR_LIBRARY_NAME=nvidia']
    cmd = on_host(['systemd-run', '--user', '--collect', '--unit=asset-studio-ui-test', *env, 'flatpak', 'run', 'com.google.Chrome',
                   '--headless=new', f'--user-data-dir={PROFILE}', f'--remote-debugging-port={PORT}', f'--window-size={size[0]},{size[1]}',
                   '--enable-features=Vulkan', '--no-first-run', '--no-default-browser-check', url])
    subprocess.run(cmd, check=True, capture_output=True)


def close():
    subprocess.run(on_host(['systemctl', '--user', 'stop', 'asset-studio-ui-test']), check=False, capture_output=True)
    subprocess.run(on_host(['sh', '-c', 'pkill -f "[a]sset-studio-test-ui"; true']), check=False, capture_output=True)


def page_ws(timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=2) as r:
                pages = [p for p in json.load(r) if p.get('type') == 'page']
            if pages:
                return pages[0]['webSocketDebuggerUrl']
        except OSError:
            pass
        time.sleep(0.5)
    raise RuntimeError('Chrome did not start (no debugging port)')


async def run(recipe):
    import websockets  # körs genom uv (se nedan)

    name = recipe.get('name', 'ui')
    out_dir = ROOT / 'build/ui'
    out_dir.mkdir(parents=True, exist_ok=True)
    url = f"http://localhost:8770{recipe.get('url', '/studio/')}"
    launch(url, recipe.get('size', [1600, 1000]))
    result = {'ok': True, 'steps': [], 'console': [], 'shots': []}
    try:
        async with websockets.connect(page_ws(), max_size=64 * 1024 * 1024) as ws:
            seq = 0
            pending = {}
            answer = {'text': None}

            async def reader():
                async for raw in ws:
                    m = json.loads(raw)
                    if 'id' in m and m['id'] in pending:
                        pending.pop(m['id']).set_result(m)
                    elif m.get('method') == 'Runtime.consoleAPICalled' and m['params']['type'] in ('error', 'warning'):
                        txt = ' '.join(str(a.get('value', a.get('description', ''))) for a in m['params']['args'])
                        result['console'].append(f"{m['params']['type']}: {txt[:300]}")
                    elif m.get('method') == 'Runtime.exceptionThrown':
                        d = m['params']['exceptionDetails']
                        result['console'].append(f"exception: {d.get('exception', {}).get('description', d.get('text'))[:300]}")
                    elif m.get('method') == 'Page.javascriptDialogOpening':
                        asyncio.ensure_future(send('Page.handleJavaScriptDialog', {'accept': True, 'promptText': answer['text'] or ''}))

            async def send(method, params=None):
                nonlocal seq
                seq += 1
                fut = asyncio.get_event_loop().create_future()
                pending[seq] = fut
                await ws.send(json.dumps({'id': seq, 'method': method, 'params': params or {}}))
                return await asyncio.wait_for(fut, 120)

            async def js(expr):
                r = await send('Runtime.evaluate', {'expression': f'(async () => {{ {HELPERS}; return ({expr}); }})()', 'awaitPromise': True, 'returnByValue': True})
                res = r.get('result', {})
                if res.get('exceptionDetails'):
                    raise RuntimeError(res['exceptionDetails'].get('exception', {}).get('description', 'error')[:300])
                return res.get('result', {}).get('value')

            task = asyncio.ensure_future(reader())
            await send('Runtime.enable')
            await send('Page.enable')
            for st in recipe.get('steps', []):
                rec = {k: v for k, v in st.items() if k in ('wait', 'until', 'eval', 'expect', 'click', 'slider', 'select', 'drag', 'prompt', 'shot', 'label')}
                try:
                    if 'wait' in st:
                        await asyncio.sleep(st['wait'] / 1000)
                    elif 'until' in st:
                        t0 = time.time()
                        while not await js(st['until']):
                            if time.time() - t0 > st.get('timeout', 60000) / 1000:
                                raise RuntimeError('timed out')
                            await asyncio.sleep(0.25)
                        rec['ms'] = round((time.time() - t0) * 1000)
                    elif 'eval' in st:
                        rec['value'] = await js(st['eval'])
                    elif 'expect' in st:
                        rec['pass'] = bool(await js(st['expect']))
                        if not rec['pass']:
                            result['ok'] = False
                    elif 'click' in st:
                        rec['value'] = await js(f"__ui.click({json.dumps(st['click'])}, {json.dumps(st.get('in', 'button'))})")
                    elif 'slider' in st:
                        rec['value'] = await js(f"__ui.slider({json.dumps(st['slider'])}, {json.dumps(st['value'])}, {json.dumps(st.get('in', 'body'))})")
                    elif 'select' in st:
                        rec['value'] = await js(f"__ui.select({json.dumps(st['select'])}, {json.dumps(st['value'])}, {json.dumps(st.get('in', 'body'))})")
                    elif 'drag' in st:
                        pts, btn = st['drag'], st.get('button', 'left')
                        mask = {'left': 1, 'right': 2, 'middle': 4}[btn]
                        await send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': pts[0][0], 'y': pts[0][1]})
                        await send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': pts[0][0], 'y': pts[0][1], 'button': btn, 'buttons': mask, 'clickCount': 1})
                        for a, b in zip(pts, pts[1:]):
                            for k in range(1, 9):  # mellanpunkter, så att draget blir jämnt
                                x, y = a[0] + (b[0] - a[0]) * k / 8, a[1] + (b[1] - a[1]) * k / 8
                                await send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y, 'button': btn, 'buttons': mask})
                                await asyncio.sleep(0.03)
                        await send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': pts[-1][0], 'y': pts[-1][1], 'button': btn, 'buttons': 0, 'clickCount': 1})
                    elif 'prompt' in st:
                        answer['text'] = st['prompt']
                    elif 'shot' in st:
                        r = await send('Page.captureScreenshot', {'format': 'png'})
                        f = out_dir / f"{name}_{st['shot']}.png"
                        f.write_bytes(base64.b64decode(r['result']['data']))
                        result['shots'].append(str(f.relative_to(ROOT)))
                        if 'minLight' in st:
                            from PIL import Image, ImageStat
                            im = Image.open(f).convert('L')
                            w, h = im.size
                            rec['light'] = round(ImageStat.Stat(im.crop((w * 0.3, h * 0.2, w * 0.7, h * 0.7))).mean[0])
                            rec['pass'] = rec['light'] >= st['minLight']
                            if not rec['pass']:
                                result['ok'] = False
                except Exception as e:  # noqa: BLE001
                    rec['error'] = str(e)[:300]
                    result['ok'] = False
                result['steps'].append(rec)
            task.cancel()
    finally:
        close()
    if result['console']:
        result['ok'] = result['ok'] and not any(c.startswith('exception') for c in result['console'])
    return result


def main():
    recipe = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    try:
        import websockets  # noqa: F401
        import PIL  # noqa: F401
    except ImportError:
        # Utan paketen: kör om skriptet genom uv med websockets och Pillow
        os.execvp('uv', ['uv', 'run', '--quiet', '--no-project', '--python', '3.12', '--with', 'websockets', '--with', 'pillow', 'python', '-I', __file__, *sys.argv[1:]])
    try:
        out = asyncio.run(run(recipe))
    except Exception as e:  # noqa: BLE001
        out = {'ok': False, 'error': str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
