"""Texturverkstaden: en textur från ett recept (en källa och en stapel steg). Plan: docs/texture-workshop.md.

  python3 -I tools/texture/workshop.py '<recept>'

Recept:
  source   {"type": "bark" | "stone" | "bricks" | "planks" | "noise" | "image", ...spakar}   (se workshop.json)
  steps    [{"op": "tile" | "levels" | "hsv" | "palette" | "gray" | "soften" | "range" | "blur" | "repeat", "on": true, ...}]
  size     sida i px (förhandsvisning 512, sparad textur 1024 eller 2048)
  out      PNG relativt projektroten (förhandsvisning), eller
  save     {"name", "profile", "tags", "meters"} -> assets/textures/<name>.png, <name>.texture.json och en rad i
           assets/textures/catalog.json (texturkatalogen som studion, generatorerna och Tinkertown 2 läser)

Alla procedurella källor är sömlösa från början (brus filtreras i frekvensrummet, celler mäts runt kanterna,
fåror, rader och plankor har ett helt antal per textur), så steget "tile" behövs bara för importerade bilder.
Svarar med en rad JSON: fil, storlek, tid och kontroller (söm, palett, medelfärg, valörer).
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageFilter
except ImportError:  # kör om sig själv med paketen via uv (fungerar i containern och på värden)
    os.execvp("uv", ["uv", "run", "--quiet", "--no-project", "--python", "3.12", "--with", "pillow==11.1.0",
                     "--with", "numpy==2.2.3", "python", "-I", __file__, *sys.argv[1:]])

ROOT = Path(__file__).resolve().parents[2]
TEX = ROOT / "assets" / "textures"
STYLE = json.loads((ROOT / "tools" / "style.json").read_text())
SCHEMA = json.loads((Path(__file__).resolve().parent / "workshop.json").read_text())


def with_defaults(kind, part, values):
    # Spakar som saknas i receptet får standardvärdet ur workshop.json (som i studion)
    spec = SCHEMA[kind].get(part, {})
    return {**{q["key"]: q["default"] for q in spec.get("params", []) if "default" in q}, **values}
NAME_OK = set("abcdefghijklmnopqrstuvwxyz0123456789_")


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)


def grid(n):
    c = (np.arange(n, dtype=np.float32) + 0.5) / n
    return np.meshgrid(c, c)  # x (vågrätt), y (lodrätt), båda 0..1


# --- Sömlöst brus: vitt brus filtrerat i frekvensrummet upprepar sig av sig självt ---
def lowpass(n, freq, rng, sx=1.0, sy=1.0):
    f = np.fft.fftfreq(n) * n
    fx, fy = np.meshgrid(f, f)
    r2 = (fx / sx) ** 2 + (fy / sy) ** 2
    spec = np.fft.fft2(rng.standard_normal((n, n))) * np.exp(-r2 / (2 * max(freq, 0.5) ** 2))
    a = np.real(np.fft.ifft2(spec))
    return (a - a.mean()) / (a.std() + 1e-9)


def fbm(n, scale, octaves, rng, sx=1.0, sy=1.0):
    out, amp, total = np.zeros((n, n), np.float32), 1.0, 0.0
    for i in range(octaves):
        out += amp * lowpass(n, scale * 2 ** i, rng, sx, sy)
        total += amp
        amp *= 0.5
    out /= total
    return np.clip(0.5 + out * 0.22, 0, 1)


# --- Sömlösa Voronoi-celler: avstånden räknas runt kanterna (texturen är en torus) ---
def voronoi(n, pts, weights=None):
    x, y = grid(n)
    f1 = np.full((n, n), np.inf, np.float32)
    f2 = np.full((n, n), np.inf, np.float32)
    idx = np.zeros((n, n), np.int32)
    w = np.ones(len(pts), np.float32) if weights is None else weights
    for i, (px, py) in enumerate(pts):
        dx = np.abs(x - px); dx = np.minimum(dx, 1 - dx)
        dy = np.abs(y - py); dy = np.minimum(dy, 1 - dy)
        d = np.sqrt(dx * dx + dy * dy) / w[i]
        closer = d < f1
        f2 = np.where(closer, f1, np.minimum(f2, d))
        idx = np.where(closer, i, idx)
        f1 = np.where(closer, d, f1)
    return f1, f2, idx


# --- Källor: varje källa ger färg (n, n, 3) och höjd (n, n), båda 0..1 ---
def src_noise(n, p, rng):
    kind = p.get("type", "fbm")
    if kind == "worley":
        pts = rng.random((max(4, int(p.get("scale", 6)) ** 2), 2))
        f1, _, _ = voronoi(n, pts)
        h = 1 - f1 / (f1.max() + 1e-9)
    else:
        h = fbm(n, p.get("scale", 6), int(p.get("octaves", 4)), rng)
    s = p.get("sharpness", 0.3)
    if kind == "blobs" or s > 0:
        h = smooth(0.5 - (1 - s) * 0.5 - 0.01, 0.5 + (1 - s) * 0.5 + 0.01, h)
    return mix(p, h), h


def mix(p, h, dark="dark", light="light"):
    return hexrgb(p.get(dark, "#333333")) + (hexrgb(p.get(light, "#cccccc")) - hexrgb(p.get(dark, "#333333"))) * h[..., None]


def src_bark(n, p, rng):
    x, y = grid(n)
    ridges = int(p.get("ridges", 7))
    warp = (fbm(n, 3, 3, rng, sx=1, sy=0.5) - 0.5) * p.get("wiggle", 0.45) * 0.35 / ridges * 6
    u = x + warp
    phase = (u * ridges) % 1.0
    dg = np.minimum(phase, 1 - phase) * 2  # 0 mitt i fåran, 1 mitt på åsen
    groove = 1 - smooth(0, p.get("width", 0.22) * 2, dg)
    h = (1 - groove * p.get("depth", 0.6)) * (0.8 + 0.2 * np.sin(np.pi * np.clip(dg, 0, 1)))
    if p.get("plates", 0) > 0:
        # Tvärgående sprickor, förskjutna per ås, så att åsarna delas i plattor
        j = np.floor(u * ridges).astype(np.int64) % ridges
        offs = rng.random(ridges)[j]
        k = int(round(2 + p["plates"] * 8))
        pv = (y * k + offs) % 1.0
        crack = 1 - smooth(0, 0.035, np.minimum(pv, 1 - pv))
        h = h * (1 - crack * 0.5 * p["plates"] * (dg > 0.15))
    detail = fbm(n, 24, 3, rng, sx=1, sy=0.35)
    h = np.clip(h * (1 - p.get("detail", 0.25) * 0.35 + p.get("detail", 0.25) * 0.35 * detail * 2 - p.get("detail", 0.25) * 0.15), 0, 1)
    return mix(p, h ** 1.15), h


def src_stone(n, p, rng):
    # Punkter i ett skakat rutnät: jämnt fördelade stenar med raka (kantiga) gränser; variation = hur mycket
    # punkterna får flytta sig, vilket ger olika stora stenar
    g = max(2, int(round(np.sqrt(p.get("cells", 28)))))
    gy, gx = np.mgrid[0:g, 0:g]
    jit = (rng.random((g, g, 2)) - 0.5) * np.clip(p.get("variation", 0.5), 0, 1) * 0.95
    pts = (np.stack([gx, gy], -1) + 0.5 + jit).reshape(-1, 2) / g % 1.0
    cells = len(pts)
    f1, f2, idx = voronoi(n, pts)
    size = 1 / np.sqrt(cells)
    edge = f2 - f1  # 0 vid gränsen mellan två stenar
    gap = p.get("gap", 0.08) * size
    stone = smooth(gap * 0.6, gap * 1.4, edge)
    dome = smooth(0, max(p.get("round", 0.6), 0.05) * size * 0.6, edge - gap)
    tint = 1 + (rng.random(cells) - 0.5) * 2 * p.get("tint", 0.15)
    detail = fbm(n, 18, 3, rng)
    light = hexrgb(p.get("light", "#A9A39A"))[None, None, :] * tint[idx][..., None] * (0.72 + 0.28 * dome[..., None]) * (0.85 + 0.3 * detail[..., None])
    dark = hexrgb(p.get("dark", "#4C4636"))[None, None, :] * (0.8 + 0.4 * detail[..., None])
    h = stone * (0.5 + 0.5 * dome)
    return dark + (light - dark) * stone[..., None], h


def src_bricks(n, p, rng):
    x, y = grid(n)
    rows, cols = int(p.get("rows", 8)), int(p.get("cols", 4))
    if p.get("offset", 0.5) > 0 and rows % 2:
        rows += 1  # förbandet kräver ett jämnt antal rader för att gå runt
    r = np.floor(y * rows).astype(np.int64)
    jit = (fbm(n, 10, 2, rng) - 0.5) * p.get("jitter", 0.35) * 0.06
    uu = x * cols + (r % 2) * p.get("offset", 0.5) + jit * cols
    fu, fv = uu % 1.0, (y * rows + jit * rows) % 1.0
    c = np.floor(uu).astype(np.int64) % cols
    mv = p.get("mortar", 0.07) / 2
    mu = mv * cols / rows
    du, dv = np.minimum(fu, 1 - fu) / mu, np.minimum(fv, 1 - fv) / mv  # 1 vid fogens kant
    corner = np.hypot(np.clip(1.6 - du, 0, None), np.clip(1.6 - dv, 0, None))
    chip = p.get("chip", 0.3)
    brick = smooth(0.8, 1.2, np.minimum(du, dv)) * (1 - smooth(1.0, 1.4, corner * chip * 1.5))
    tint = 1 + (rng.random((rows, cols)) - 0.5) * 2 * p.get("tint", 0.12)
    detail = fbm(n, 20, 3, rng)
    light = hexrgb(p.get("light", "#B5563A"))[None, None, :] * tint[r % rows, c][..., None] * (0.85 + 0.3 * detail[..., None])
    dark = hexrgb(p.get("dark", "#D9CBB0"))[None, None, :] * (0.9 + 0.2 * detail[..., None])
    return dark + (light - dark) * brick[..., None], brick * (0.8 + 0.2 * detail)


def src_planks(n, p, rng):
    x, y = grid(n)
    planks = int(p.get("planks", 5))
    i = np.floor(x * planks).astype(np.int64) % planks
    fu = (x * planks) % 1.0
    joints = int(p.get("length", 1))
    offs = rng.random(planks)
    fv = (y * max(joints, 1) + offs[i]) % 1.0
    gap = p.get("gap", 0.025)
    board = smooth(0, gap, np.minimum(fu, 1 - fu) / planks * planks) * (smooth(0, gap * 0.6, np.minimum(fv, 1 - fv)) if joints else 1)
    g = fbm(n, 4, 3, rng, sx=planks * 2, sy=0.5)  # ådringen löper längs plankan
    grain = 0.5 + 0.5 * np.sin(2 * np.pi * (g * 7 + fu * 0.8 + offs[i] * 3))
    shade = 1 - p.get("grain", 0.5) * 0.35 * grain
    for _ in range(int(p.get("knots", 3))):  # kvistar: mörka ringar
        kx, ky = rng.random(2)
        dx = np.abs(x - kx); dx = np.minimum(dx, 1 - dx)
        dy = np.abs(y - ky); dy = np.minimum(dy, 1 - dy)
        d = np.hypot(dx * 3, dy)
        shade = shade * (1 - 0.45 * np.exp(-(d / 0.025) ** 2) - 0.12 * np.exp(-(d / 0.06) ** 2) * (0.5 + 0.5 * np.sin(d * 260)))
    tint = 1 + (rng.random(planks) - 0.5) * 2 * p.get("tint", 0.12)
    h = np.clip(shade * tint[i], 0, 1)
    col = mix(p, h)
    return col * board[..., None] * 0.85 + col * 0.15 * board[..., None] + hexrgb(p.get("dark", "#5A3A22")) * 0.4 * (1 - board[..., None]), h * board


def src_image(n, p, rng):
    im = Image.open(TEX / f"{p.get('name', 'bark_painted')}.png").convert("RGBA").resize((n, n), Image.LANCZOS)
    a = np.asarray(im, np.float32) / 255
    lum = a[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    return a, lum


SOURCES = {"noise": src_noise, "bark": src_bark, "stone": src_stone, "bricks": src_bricks, "planks": src_planks, "image": src_image}


# --- Steg: arbetar på färgen (n, n, 3 eller 4), 0..1 ---
def wrap_blur(img, radius):
    # Gaussisk oskärpa i frekvensrummet: går runt kanterna av sig själv, så texturen förblir sömlös
    if radius <= 0:
        return img
    n = img.shape[0]
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f, f)
    g = np.exp(-2 * (np.pi * radius) ** 2 * (fx * fx + fy * fy))
    return np.stack([np.real(np.fft.ifft2(np.fft.fft2(img[..., c]) * g)) for c in range(img.shape[2])], -1).astype(np.float32)


def lum(c):
    return c[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)


PALETTE_GROUPS = {
    "foliage": ("foliage_", "bush_green", "grass_tip"), "conifer": ("conifer_",), "bark": ("bark", "cattail", "straw"),
    "stone": ("stone",), "ground": ("sand", "straw", "bark_shadow", "stone_shadow"),
}


def step(img, s, n):
    op = s.get("op")
    rgb, alpha = img[..., :3], img[..., 3:]
    if op == "tile":
        # Förskjut en tredjedel, inte ett halvt varv: texturer som redan sömlagts har sin skarv i mitten
        sh = np.roll(rgb, (n // 3, n // 3), axis=(0, 1))
        yy, xx = np.mgrid[0:n, 0:n]
        edge = np.minimum.reduce([xx, n - 1 - xx, yy, n - 1 - yy]) / (n / 2)
        w = np.clip(edge / max(s.get("width", 0.25), 0.01), 0, 1)[..., None] ** 1.5
        rgb = rgb * w + sh * (1 - w)
    elif op == "levels":
        rgb = np.clip((rgb - 0.5) * s.get("contrast", 1) + 0.5 + s.get("lift", 0), 0, 1) ** (1 / max(s.get("gamma", 1), 0.05))
    elif op == "hsv":
        flat = rgb.reshape(-1, 3)
        mx, mn = flat.max(1), flat.min(1)
        d = mx - mn + 1e-9
        r, g, b = flat[:, 0], flat[:, 1], flat[:, 2]
        h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6
        sat = np.where(mx > 0, (mx - mn) / (mx + 1e-9), 0)
        h = (h + s.get("hue", 0) / 360) % 1
        sat = np.clip(sat * s.get("saturation", 1), 0, 1)
        v = np.clip(mx * s.get("value", 1), 0, 1)
        i = np.floor(h * 6).astype(int) % 6
        f = h * 6 - np.floor(h * 6)
        pp, q, t = v * (1 - sat), v * (1 - f * sat), v * (1 - (1 - f) * sat)
        out = np.choose(i[:, None], [np.stack(c, 1) for c in ((v, t, pp), (q, v, pp), (pp, v, t), (pp, q, v), (t, pp, v), (v, pp, q))])
        rgb = out.reshape(rgb.shape).astype(np.float32)
    elif op == "palette":
        keys = PALETTE_GROUPS.get(s.get("group", "all"))
        cols = [hexrgb(v) for k, v in STYLE["palette"].items() if keys is None or k.startswith(keys)]
        pal = np.stack(cols)
        flat = rgb.reshape(-1, 3)
        d = ((flat[:, None, :] - pal[None, :, :]) ** 2).sum(-1)
        near = pal[d.argmin(1)].reshape(rgb.shape)
        rgb = rgb + (near - rgb) * s.get("amount", 0.4)
    elif op == "gray":
        l = lum(rgb)
        vis = alpha[..., 0] > 0.45 if alpha.size else np.ones_like(l, bool)
        g = np.clip(l * s.get("mean", 0.82) / max(float(l[vis].mean()), 1e-3), 0, 1)
        rgb = np.repeat(g[..., None], 3, -1)
    elif op == "soften":
        a = s.get("amount", 1)
        blur = wrap_blur(rgb, max(2, n / 80))
        local = blur + (rgb - blur) * (1 - 0.45 * a)
        mean = local.reshape(-1, 3).mean(0)
        rgb = np.clip(mean + (local - mean) * (1 - 0.2 * a), 0, 1)
    elif op == "range":
        lo, hi = s.get("low", 0.08), s.get("high", 0.9)
        rgb = lo + np.clip(rgb, 0, 1) * (hi - lo)
    elif op == "blur":
        rgb = wrap_blur(rgb, s.get("radius", 1.5) * n / 1024)
    elif op == "repeat":
        t = max(1, int(s.get("times", 2)))
        if t > 1:
            m = max(8, n // t)
            small = np.asarray(Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).resize((m, m), Image.LANCZOS), np.float32) / 255
            tiled = np.tile(small, (t + 1, t + 1, 1))[:n, :n]
            if tiled.shape[0] < n:
                tiled = np.asarray(Image.fromarray((tiled * 255).astype(np.uint8)).resize((n, n), Image.LANCZOS), np.float32) / 255
            return tiled
    return np.concatenate([np.clip(rgb, 0, 1), alpha], -1) if alpha.size else np.clip(rgb, 0, 1)


# --- Kontroller, som generatorernas checks ---
def checks(img):
    rgb = img[..., :3]
    # Söm: skillnaden över kanten (sista mot första raden och kolumnen) jämförs med skillnaderna mellan
    # grannrader närmast kanten (90:e percentilen av 16 rader på varje sida). Lokalt, så att steg som jämnar
    # ut mitten inte påverkar, och så att naturliga kanter som fogar inte räknas som söm.
    def ratio(a):
        n, k = a.shape[0], 16
        near = np.r_[0:k, n - 1 - k:n - 1]
        d = np.abs(a[near + 1] - a[near]).mean(axis=tuple(range(1, a.ndim)))
        return np.abs(a[0] - a[-1]).mean() / (np.percentile(d, 90) + 1e-6)
    seam_r, seam_c = ratio(rgb), ratio(rgb.transpose(1, 0, 2))
    pal = np.stack([hexrgb(v) for v in STYLE["palette"].values()])
    sample = rgb.reshape(-1, 3)[:: max(1, rgb.shape[0] * rgb.shape[1] // 40000)]
    dmin = np.sqrt(((sample[:, None] - pal[None]) ** 2).sum(-1)).min(1)
    l = lum(rgb)
    mean = rgb.reshape(-1, 3).mean(0)
    seam = float(max(seam_r, seam_c))
    return {
        "seam": round(seam, 2), "seamless": seam < 1.3,
        "off_palette": round(float((dmin > 0.22).mean()), 3),
        "mean": "#%02X%02X%02X" % tuple(int(c * 255) for c in mean),
        "value_range": [round(float(np.percentile(l, 2)), 2), round(float(np.percentile(l, 98)), 2)],
    }


def build(recipe):
    n = int(recipe.get("size", 512))
    src = recipe.get("source", {"type": "noise"})
    src = with_defaults("sources", src.get("type", "noise"), src)
    rng = np.random.default_rng(int(src.get("seed", 1)))
    color, _height = SOURCES[src.get("type", "noise")](n, src, rng)
    img = color.astype(np.float32)
    for s in recipe.get("steps", []):
        if s.get("on", True):
            img = step(img, with_defaults("steps", s.get("op"), s), n)
    return np.clip(img, 0, 1)


def save_png(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "RGBA" if img.shape[2] == 4 else "RGB"
    Image.fromarray((img * 255 + 0.5).astype(np.uint8), mode).save(path)


def main():
    recipe = json.loads(sys.argv[1])
    t0 = time.time()
    save = recipe.get("save")
    if save:
        name = save.get("name", "")
        if not name or set(name) - NAME_OK or len(name) > 48:
            sys.exit(json.dumps({"error": "namnet får bara ha a–z, 0–9 och _ (högst 48 tecken)"}))
        out = TEX / f"{name}.png"
        meta = TEX / f"{name}.texture.json"
        if out.exists() and not meta.exists():
            sys.exit(json.dumps({"error": f"{name} finns redan och är inte gjord i verkstaden; välj ett annat namn"}))
        if out.exists() and not save.get("overwrite"):
            sys.exit(json.dumps({"error": f"{name} finns redan", "exists": True}))
        recipe = {**recipe, "size": int(recipe.get("size", 1024))}
    else:
        out = (ROOT / recipe.get("out", "build/studio/tex/preview.png")).resolve()
        if ROOT not in out.parents:
            sys.exit(json.dumps({"error": "out måste ligga under projektroten"}))
    img = build(recipe)
    save_png(img, out)
    result = {"out": str(out.relative_to(ROOT)), "size": img.shape[0], "ms": int((time.time() - t0) * 1000), "checks": checks(img)}
    if save:
        clean = {k: v for k, v in recipe.items() if k not in ("save", "out")}
        entry = {"name": name, "profile": save.get("profile", "terrain"), "maps": ["color"], "meters": save.get("meters", 2.0),
                 "tags": [t.strip().lower() for t in save.get("tags", []) if t.strip()], "recipe": f"assets/textures/{name}.texture.json",
                 "size": img.shape[0], "saved": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        # Receptet sparas med alla spakar utskrivna (även standardvärden), så att texturen går att göra om
        # exakt även om standardvärdena i workshop.json ändras senare
        src = with_defaults("sources", clean["source"].get("type", "noise"), clean["source"])
        steps = [with_defaults("steps", st.get("op"), st) for st in clean.get("steps", [])]
        meta.write_text(json.dumps({**entry, "source": src, "steps": steps}, indent=2, ensure_ascii=False) + "\n")
        cat_path = TEX / "catalog.json"
        cat = json.loads(cat_path.read_text()) if cat_path.exists() else {"textures": []}
        cat["textures"] = [t for t in cat["textures"] if t["name"] != name] + [entry]
        cat_path.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n")
        result["entry"] = entry
    print(json.dumps(result))


if __name__ == "__main__":
    main()
