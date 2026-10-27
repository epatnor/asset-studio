"""Ikonerna för mallarna i lådorna (tools/icons/icons.json): ett ark per område ritas av gpt-image-2 via OpenRouter i ett
fast rutnät, sparas i build/icons/<ark>.png och skärs ut till assets/icons/<id>.png (kvadratisk, rundade hörn, alfa).

  python3 -I tools/icons/make_icons.py '{"sheet": "water"}'            # rita och skär ut
  python3 -I tools/icons/make_icons.py '{"sheet": "water", "cut": true}' # bara skär ut ett redan ritat ark
  python3 -I tools/icons/make_icons.py '{"sheet": "water", "dry": true}' # visa prompten, rita inget

Nyckeln OPENROUTER_API_KEY läses ur miljön eller ur ../../apparition-moodboard/.env (skrivs aldrig ut). Svarar med en
rad JSON. Pillow behövs: kör genom `uv run --no-project --python 3.12 --with pillow`, som skriptet gör själv om det saknas.
"""
import base64, json, os, subprocess, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / 'tools/icons/icons.json'


def key():
    k = os.environ.get('OPENROUTER_API_KEY')
    if k:
        return k
    env = ROOT.parents[1] / 'apparition-moodboard/.env'
    for line in env.read_text().splitlines() if env.exists() else []:
        if line.startswith('OPENROUTER_API_KEY='):
            return line.split('=', 1)[1].strip().strip('"\'')
    raise SystemExit(json.dumps({'ok': False, 'error': 'no OPENROUTER_API_KEY'}))


def prompt_for(spec, sheet):
    s = spec['sheets'][sheet]
    text = spec['style'].format(cols=s['cols'], rows=s['rows'], tint=s['tint'], page=s['page'])
    cells = []
    for i, it in enumerate(s['items']):
        r, c = divmod(i, s['cols'])
        cells.append(f"Row {r + 1}, column {c + 1}: " + (it['prompt'] if it else 'an empty tile with no symbol'))
    return text + ' The icons, read left to right and top to bottom: ' + '; '.join(cells) + '.'


def draw(spec, sheet, out):
    s = spec['sheets'][sheet]
    body = {'model': spec['model'], 'prompt': prompt_for(spec, sheet), 'aspect_ratio': s['aspect']}
    req = urllib.request.Request('https://openrouter.ai/api/v1/images', data=json.dumps(body).encode(), method='POST', headers={
        'authorization': f'Bearer {key()}', 'content-type': 'application/json',
        'http-referer': 'https://github.com/epatnor/asset-studio', 'x-title': 'Azshara Asset Studio'})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            j = json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(json.dumps({'ok': False, 'error': f'OpenRouter {e.code}: {e.read().decode()[:300]}'}))
    data = [d for d in j.get('data', []) if d.get('b64_json')]
    if not data:
        raise SystemExit(json.dumps({'ok': False, 'error': 'no image in the answer'}))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(data[0]['b64_json']))
    return (j.get('usage') or {}).get('cost')


def cut(spec, sheet, src):
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
    s, size = spec['sheets'][sheet], spec['size']
    im = Image.open(src).convert('RGB')
    W, H = im.size
    # Sidans färg: medianen av kanterna. Rutorna hittas som rader och kolumner som skiljer sig från sidan
    edge = [im.getpixel((x, 2)) for x in range(0, W, 7)] + [im.getpixel((2, y)) for y in range(0, H, 7)]
    page = tuple(sorted(c[i] for c in edge)[len(edge) // 2] for i in range(3))
    diff = ImageChops.difference(im, Image.new('RGB', im.size, page)).convert('L').point(lambda v: 255 if v > 28 else 0)
    diff = diff.filter(ImageFilter.MaxFilter(3))
    cols = [sum(1 for y in range(0, H, 2) if diff.getpixel((x, y))) for x in range(W)]
    rows = [sum(1 for x in range(0, W, 2) if diff.getpixel((x, y))) for y in range(H)]

    def spans(prof, n, length):
        # n band: kör längs profilen och ta sammanhängande bitar över tröskeln; faller tillbaka på ett jämnt rutnät
        thr = max(prof) * 0.25
        out, start = [], None
        for i, v in enumerate(prof + [0]):
            if v > thr and start is None:
                start = i
            elif v <= thr and start is not None:
                if i - start > length / n * 0.4:
                    out.append((start, i))
                start = None
        return out if len(out) == n else [(round(i * length / n), round((i + 1) * length / n)) for i in range(n)]

    xs, ys = spans(cols, s['cols'], W), spans(rows, s['rows'], H)
    made = []
    for i, it in enumerate(s['items']):
        if not it:
            continue
        r, c = divmod(i, s['cols'])
        (x0, x1), (y0, y1) = xs[c], ys[r]
        tile = im.crop((x0, y0, x1, y1))
        # Kvadratisk mitt av rutan, rundade hörn som alfa
        w, h = tile.size
        side = min(w, h)
        tile = tile.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side)).resize((size * 4, size * 4), Image.LANCZOS)
        mask = Image.new('L', tile.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, tile.size[0] - 1, tile.size[1] - 1), radius=int(size * 4 * 0.2), fill=255)
        tile.putalpha(mask)
        tile = tile.resize((size, size), Image.LANCZOS)
        out = ROOT / 'assets/icons' / f"{it['id']}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        tile.save(out, optimize=True)
        made.append(str(out.relative_to(ROOT)))
    return made, len(xs) == s['cols'] and len(ys) == s['rows']


def main():
    try:
        import PIL  # noqa: F401
    except ImportError:
        os.execvp('uv', ['uv', 'run', '--no-project', '--python', '3.12', '--with', 'pillow', 'python', '-I', __file__, *sys.argv[1:]])
    recipe = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    spec = json.loads(SPEC.read_text())
    sheet = recipe.get('sheet')
    if sheet not in spec['sheets']:
        print(json.dumps({'ok': False, 'error': f'unknown sheet; have {list(spec["sheets"])}'}))
        return
    if recipe.get('dry'):
        print(json.dumps({'ok': True, 'prompt': prompt_for(spec, sheet)}))
        return
    src = ROOT / 'build/icons' / f'{sheet}.png'
    cost = None if recipe.get('cut') else draw(spec, sheet, src)
    made, grid = cut(spec, sheet, src)
    print(json.dumps({'ok': grid, 'sheet': str(src.relative_to(ROOT)), 'icons': len(made), 'cost': cost, 'grid_found': grid}))


if __name__ == '__main__':
    main()
