"""Texturverkstaden: ett material från ett recept (källa, stapel steg, ingredienser och materialets kartor).
Plan: docs/texture-workshop.md.

  python3 -I tools/texture/workshop.py '<recept>'

Recept:
  source   {"type": "bark" | "stone" | "bricks" | "planks" | "shingles" | "splat" | "noise" | "gradient" | "krea"
            | "image" | "input", ...spakar}   (se workshop.json)
  steps    [{"op": "layer" | "scatter" | "tile" | "levels" | ..., "on": true, ...spakar}]
  inputs   ingredienser: {"namn": {"texture": "rock_cobble"} | {"recipe": {source, steps, inputs}}}. Källan
           "input" och stegen layer och scatter pekar på dem med namn; en ingrediens ser sina egna och
           förälderns ingredienser. Varje ingrediens räknas för sig och cachas i build/studio/texcache/.
  material kartornas spakar (normal, roughness, ao, metal, emission; se workshop.json, material). Spakar
           märkta client gäller bara 3D-vyn och påverkar inte bilderna.
  size     sida i px (förhandsvisning 512, sparad textur 1024 eller 2048)
  save.hd  storebror: ritas i den här storleken (t.ex. 2048) och sparas i assets/textures/hd/; texturen (lillebror,
           size) skalas då ned ur den i stället för att ritas för sig
  out      prefix relativt projektroten för förhandsvisningen: <out>_color.png, <out>_height.png, ...
  save     {"name", "profile", "tags", "maps", "pack", "webp", "overwrite"} -> assets/textures/<name>.png,
           <name>_<karta>.png, <name>.texture.json och en rad i assets/textures/catalog.json. En textur som
           skrivs över flyttas först till assets/textures/versions/.

Höjden följer med genom hela stapeln (källorna räknar ut den), så att lager, normaler, AO och blandning kan
styras av formen. Alla procedurella källor är sömlösa från början; steget "tile" behövs bara för bilder.
Svarar med en rad JSON: kartor, storlek, tid och kontroller (söm, palett, medelfärg, valörer, högfrekvens).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:  # kör om sig själv med paketen via uv (fungerar i containern och på värden)
    os.execvp("uv", ["uv", "run", "--quiet", "--no-project", "--python", "3.12", "--with", "pillow==11.1.0",
                     "--with", "numpy==2.2.3", "python", "-I", __file__, *sys.argv[1:]])

ROOT = Path(__file__).resolve().parents[2]
TEX = ROOT / "assets" / "textures"
CACHE = ROOT / "build" / "studio" / "texcache"
STYLE = json.loads((ROOT / "tools" / "style.json").read_text())
SCHEMA = json.loads((Path(__file__).resolve().parent / "workshop.json").read_text())
CODE_VERSION = str(int(Path(__file__).stat().st_mtime))  # cachen gäller bara samma version av koden
NAME_OK = set("abcdefghijklmnopqrstuvwxyz0123456789_")
MAP_NAMES = ("color", "normal", "height", "rough", "ao", "metal", "emissive")


def with_defaults(kind, part, values):
    # Spakar som saknas i receptet får standardvärdet ur workshop.json (som i studion)
    spec = SCHEMA[kind].get(part, {})
    return {**{q["key"]: q["default"] for q in spec.get("params", []) if "default" in q}, **values}


def material_defaults(m):
    # Materialets spakar har punktade nycklar ("normal.strength") som blir nästlade fält i recipe.material
    out = json.loads(json.dumps(m or {}))
    for g in SCHEMA["material"]["groups"]:
        for q in g["params"]:
            node, *rest = q["key"].split(".")
            if rest:
                out.setdefault(node, {}).setdefault(rest[0], q["default"])
            else:
                out.setdefault(node, q["default"])
    return out


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)


def smooth(e0, e1, x):
    # Fungerar åt båda hållen (e0 > e1 ger en fallande kant) och med e0, e1 som fält
    d = np.asarray(e1 - e0, np.float32)
    d = np.where(np.abs(d) < 1e-6, 1e-6, d)
    t = np.clip((x - e0) / d, 0, 1)
    return t * t * (3 - 2 * t)


def grid(n):
    c = (np.arange(n, dtype=np.float32) + 0.5) / n
    return np.meshgrid(c, c)  # x (vågrätt), y (lodrätt), båda 0..1


# --- Sömlöst brus: vitt brus filtrerat i frekvensrummet upprepar sig av sig självt ---
# Slumpen dras i ett band som bara beror på frekvensen (k × k, k minst 8σ), inte på upplösningen, och läggs in i
# n × n-spektrumet. Samma frö ger då samma mönster i 256, 512 (förhandsvisningen), 1024 och 2048, och slumpen som
# dras efteråt (celler, plattor) förskjuts inte av upplösningen.
def lowpass(n, freq, rng, sx=1.0, sy=1.0):
    sig = max(freq, 0.5)
    k = int(min(1024, max(32, 2 ** np.ceil(np.log2(8 * sig * max(sx, sy, 1.0))))))
    band = np.fft.fft2(rng.standard_normal((k, k)).astype(np.float32))
    f = np.round(np.fft.fftfreq(n) * n).astype(np.int64)
    keep = np.where(np.abs(f) < min(k, n) // 2)[0]
    spec = np.zeros((n, n), np.complex64)
    spec[np.ix_(keep, keep)] = band[np.ix_(f[keep] % k, f[keep] % k)]
    fx, fy = np.meshgrid(f, f)
    spec *= np.exp(-((fx / sx) ** 2 + (fy / sy) ** 2) / (2 * sig ** 2)).astype(np.float32)
    a = np.real(np.fft.ifft2(spec))
    return ((a - a.mean()) / (a.std() + 1e-9)).astype(np.float32)


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
    kind = p.get("kind", "fbm")  # inte "type": det namnet anger vilken källa receptet har
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
    # Bark efter referenserna (patriks_input/AAA_Reference_Guided_Procedural_Textures_Tiling_ThreeJS_Reference.md, Bark;
    # mätt mot Poly Havens bark med tools/texture/reference_analysis.py). Stammen går längs y.
    # 1. Plattor: långsträckta voronoiceller i tegelförband, ridges kolumner tvärs och aspect gånger längre än breda
    #    (rows ger antalet direkt; plates är den äldre spaken). Lågfrekvent förvrängning (wiggle) gör fårorna slingrande.
    # 2. Fårorna: längsgående fåror mellan kolumnerna, tunnare tvärsprickor mellan plattorna i samma kolumn (cracks).
    # 3. Fibrer: fina längsgående streck i höjd och färg (detail), som i riktig bark.
    # 4. Färg: valör ur höjden, en ton per platta, egen färg i fårorna (crevice, t.ex. tallens orange innerbark), stora
    #    mjuka lav- eller mossfläckar (lichen, lichenColor), glesa ljusa flagor (flakes, accent) och lenticeller.
    x, y = grid(n)
    cols = max(2, int(p.get("ridges", 7)))
    if p.get("rows"):
        rows = max(1, int(p["rows"]))
    elif p.get("aspect"):
        rows = max(1, int(round(cols / max(p["aspect"], 0.5))))
    else:
        rows = max(1, int(round(float(np.clip(p.get("plates", 0.5), 0, 1)) * 4)))
    wig = p.get("wiggle", 0.45)
    u = (x + (fbm(n, 2, 3, rng, sx=1, sy=0.6) - 0.5) * wig * 2.4 / cols) % 1.0
    v = (y + (fbm(n, 2, 3, rng) - 0.5) * wig * 1.2 / rows) % 1.0
    jit = rng.random((cols, rows, 2)) - 0.5
    # Närmaste plattor: varje pixel söker bara bland grannarna i rutnätet (15 kandidater), så att hundratals plattor
    # går lika fort som ett fåtal. Kolumnerna är förskjutna en halv rad som tegel. Avståndet mäts i cellenheter, så
    # plattorna blir lika långsträckta som cellerna
    ci = np.floor(u * cols).astype(np.int64)
    f1 = np.full((n, n), np.inf, np.float32)
    f2 = np.full((n, n), np.inf, np.float32)
    idx = np.zeros((n, n), np.int64)
    idx2 = np.zeros((n, n), np.int64)
    sy = 0.35 if rows == 1 else 1.0  # utan rader blir åsarna sammanhängande
    for di in (-1, 0, 1):
        cc = (ci + di) % cols
        off = 0.5 * (cc % 2)
        r0 = np.floor(v * rows - off).astype(np.int64)
        for dj in (-2, -1, 0, 1, 2):
            rr = (r0 + dj) % rows
            px = (cc + 0.5 + jit[cc, rr, 0] * 0.5) / cols
            py = ((rr + 0.5 + off + jit[cc, rr, 1] * 0.6) / rows) % 1.0
            dx = (u - px + 0.5) % 1.0 - 0.5
            dy = (v - py + 0.5) % 1.0 - 0.5
            d = np.sqrt((dx * cols) ** 2 + (dy * rows * sy) ** 2).astype(np.float32)
            kk = cc * rows + rr
            # Med få rader eller kolumner kan samma platta komma igen bland kandidaterna (rutnätet går runt); den
            # får inte räknas som näst närmaste, annars blir fogen noll överallt
            closer = d < f1
            second = ~closer & (d < f2) & (kk != idx)
            idx2 = np.where(closer, idx, np.where(second, kk, idx2))
            f2 = np.where(closer, f1, np.where(second, d, f2))
            idx = np.where(closer, kk, idx)
            f1 = np.where(closer, d, f1)
    k = cols * rows
    edge = f2 - f1  # 0 i fogen mellan två plattor
    width = p.get("width", 0.22)
    # Tvärspricka: den näst närmaste plattan ligger i samma kolumn. Den är tunnare än en längsgående fåra
    across = (idx // rows == idx2 // rows).astype(np.float32)
    w = width * (1 - across * (1 - p.get("cracks", 0.45)))
    crevice = 1 - smooth(0, w * 1.1 + 1e-4, edge)
    dome = smooth(0, 0.45 + width, edge) ** 0.7
    tilt = (rng.random(k) - 0.5)[idx] * 0.25
    plate_h = 0.55 + 0.45 * dome + tilt * dome
    detail = p.get("detail", 0.25)
    # Fibrer: fina längsgående streck (ridged brus utsträckt längs stammen) och glesare djupare sprickor
    fibre = 1 - np.abs(2 * fbm(n, 38, 2, rng, sx=1, sy=0.1) - 1)  # ~2,5 cm på en meter: finare än fårorna
    ridged = 1 - np.abs(2 * fbm(n, 9, 3, rng, sx=1, sy=0.22) - 1)
    fine = smooth(0.78, 0.97, ridged) * detail
    h = plate_h * (1 - crevice * p.get("depth", 0.6)) - fine * 0.3 * dome - (fibre - 0.5) * detail * 0.12 * dome
    flakes = smooth(0.62, 0.7, fbm(n, 7, 2, rng)) * smooth(0.3, 0.7, dome) * p.get("flakes", 0.0)
    h = np.clip(h + flakes * 0.06, 0, 1)
    # Lav och mossa: stora mjuka fläckar, mest på plattorna
    lichen = smooth(0.5, 0.6, fbm(n, 5, 3, rng)) * (0.35 + 0.65 * dome) * p.get("lichen", 0.0)
    # Lenticeller (körsbär, björk): korta vågräta mörka streck, spridda i ett skakat rutnät
    lent = np.zeros((n, n), np.float32)
    if p.get("lenticels", 0) > 0:
        lc, lr = 9, 26
        lj = rng.random((lc, lr, 3))
        gx, gy = np.floor(x * lc).astype(np.int64), np.floor(y * lr).astype(np.int64)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                cx, cy = (gx + di) % lc, (gy + dj) % lr
                px, py = (cx + lj[cx, cy, 0]) / lc, (cy + lj[cx, cy, 1]) / lr
                dx, dy = (x - px + 0.5) % 1.0 - 0.5, (y - py + 0.5) % 1.0 - 0.5
                L = (0.25 + 0.5 * lj[cx, cy, 2]) / lc  # streckets halva längd
                e = np.sqrt((dx / L) ** 2 + (dy / (0.12 / lr)) ** 2)
                keep = (lj[cx, cy, 2] < p["lenticels"]).astype(np.float32)
                lent = np.maximum(lent, (1 - smooth(0.6, 1.0, e)) * keep)
        h = np.clip(h - lent * 0.15, 0, 1)
    # Färgen: valör ur höjden, en ton per platta, egen färg i fårorna, varmt på topparna, stora mjuka fläckar
    col = mix(p, np.clip(h, 0, 1) ** 1.1)
    tone = 1 + (rng.random(k) - 0.5)[idx][..., None] * 2 * p.get("tint", 0.12)
    warm = 1 + (dome * (1 - crevice))[..., None] * np.array([0.06, 0.02, -0.04], np.float32)
    mottle = 1 + (fbm(n, 3, 2, rng) - 0.5)[..., None] * 0.35
    streak = 1 + (fibre - 0.5)[..., None] * detail * 0.25
    col = col * tone * warm * mottle * streak
    if p.get("crevice"):
        col = col + (hexrgb(p["crevice"]) - col) * (crevice * (1 - across * 0.5))[..., None] * 0.85
    else:
        col = col * (1 + crevice[..., None] * np.array([-0.06, -0.02, 0.08], np.float32) * p.get("depth", 0.6))
    col = col + (hexrgb(p.get("lichenColor", "#9DA67A")) - col) * lichen[..., None] * 0.8
    col = col + (hexrgb(p.get("accent", "#C9C2B0")) - col) * flakes[..., None] * 0.85
    col = col + (hexrgb(p.get("dark", "#333333")) * 0.8 - col) * lent[..., None] * 0.9
    return np.clip(col, 0, 1), h


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
    # Fogarna en kvarts sten och en halv rad in från kanten, så att ingen fog ligger exakt i texturens skarv
    x, y = (x + 0.25 / cols) % 1.0, (y + 0.5 / rows) % 1.0
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
    x = (x + 0.5 / planks) % 1.0  # springorna mellan plankorna inte exakt i texturens skarv
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


def resize_wrap(a, m):
    # Omskalning som behandlar texturen som upprepad: kanterna lindas runt innan och skärs bort efter, annars
    # ser Pillow bildkanten som ett slut och resultatet får en söm där texturen upprepas
    n = a.shape[0]
    pad = max(4, n // 16)
    big = np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode="wrap")
    scale = m / n
    size = int(round(big.shape[0] * scale))
    chans = [np.asarray(Image.fromarray(big[..., c].astype(np.float32), "F").resize((size, size), Image.LANCZOS), np.float32) for c in range(a.shape[2])]
    out = np.stack(chans, -1)
    o = int(round(pad * scale))
    return np.clip(out[o:o + m, o:o + m], 0, 1)




def wrap_blur(img, radius):
    # Gaussisk oskärpa i frekvensrummet: går runt kanterna av sig själv, så texturen förblir sömlös
    if radius <= 0:
        return img
    flat = img.ndim == 2
    a = img[..., None] if flat else img
    n = a.shape[0]
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f, f)
    g = np.exp(-2 * (np.pi * radius) ** 2 * (fx * fx + fy * fy))
    out = np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[..., c]) * g)) for c in range(a.shape[2])], -1).astype(np.float32)
    return out[..., 0] if flat else out


def norm01(a):
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    return np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1).astype(np.float32)


def lum(c):
    return c[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)


def sample_wrap(img, x, y):
    # Bilinjär avläsning med koordinater i pixlar, runt kanterna
    n = img.shape[0]
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    x0 %= n; y0 %= n
    x1, y1 = (x0 + 1) % n, (y0 + 1) % n
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy).astype(np.float32)


# --- Fler källor ---
def src_shingles(n, p, rng):
    x, y = grid(n)
    rows, cols = int(p.get("rows", 8)), int(p.get("cols", 6))
    y = (y + 0.5 / rows) % 1.0  # radernas skarv mitt i texturen, inte vid kanten
    jit = (fbm(n, 8, 2, rng) - 0.5) * p.get("jitter", 0.3) * 0.08
    r = np.floor(y * rows).astype(np.int64)
    u = x * cols + 0.25 + (r % 2) * 0.5 + jit * cols
    fu, fv = u % 1.0, (y * rows) % 1.0  # fv: 0 överst i raden, 1 vid pannans nedre kant
    c = np.floor(u).astype(np.int64) % cols
    du = np.abs(fu - 0.5) * 2  # 0 mitt på pannan, 1 vid kanten
    shape = p.get("shape", "round")
    if shape == "round":
        edge = 0.55 + np.sqrt(np.clip(1 - du ** 2, 0, 1)) * 0.45  # rundad nedre kant, längst i mitten
    elif shape == "pointed":
        edge = 1 - du * 0.45
    else:
        edge = np.ones_like(du)
    gap = p.get("gap", 0.03)
    tile = smooth(0, gap, edge - fv) * smooth(0, gap * cols / rows * 0.6 + 1e-3, 1 - du)
    # Raden ovanför täcker överkanten: mörkare där pannan försvinner in under nästa rad
    shadow = 1 - p.get("overlap", 0.5) * 0.6 * (1 - smooth(0, 0.45, fv))
    tint = 1 + (rng.random((rows, cols)) - 0.5) * 2 * p.get("tint", 0.12)
    detail = fbm(n, 22, 3, rng)
    h = tile * (0.35 + 0.65 * fv / np.maximum(edge, 1e-3)) * (0.9 + 0.1 * detail)
    light = hexrgb(p.get("light", "#9C4A32")) * (tint[r % rows, c] * shadow * (0.85 + 0.3 * detail))[..., None]
    dark = hexrgb(p.get("dark", "#3A2420"))
    col = dark + (light - dark) * tile[..., None]
    # Mellan pannorna syns raden under, som också ligger i skugga
    return col, np.clip(h, 0, 1)


def src_splat(n, p, rng):
    # Mark: fläckar av jord, gräs och grus med mjuka eller skarpa kanter
    sc = p.get("scale", 4)
    e = 0.02 + (1 - p.get("edge", 0.5)) * 0.18
    g1 = fbm(n, sc, 4, rng)
    g2 = fbm(n, sc * 1.6, 4, rng)
    grass = smooth(1 - p.get("grass", 0.45) - e, 1 - p.get("grass", 0.45) + e, norm01(g1))
    gravel = smooth(1 - p.get("gravel", 0.25) - e, 1 - p.get("gravel", 0.25) + e, norm01(g2)) * (1 - grass)
    d = p.get("detail", 0.35)
    fine = fbm(n, 40, 3, rng)
    grit = fbm(n, 90, 2, rng)
    soil = hexrgb(p.get("soil", "#6B4E32")) * (1 - d * 0.3 + d * 0.6 * fine)[..., None]
    gc = hexrgb(p.get("grass_color", "#5E8A3A")) * (1 - d * 0.35 + d * 0.7 * fbm(n, 60, 3, rng))[..., None]
    gr = hexrgb(p.get("gravel_color", "#9A9384")) * (0.75 + 0.5 * grit)[..., None]
    col = soil * (1 - grass - gravel)[..., None] + gc * grass[..., None] + gr * gravel[..., None]
    h = 0.35 + 0.25 * fine + grass * 0.25 + gravel * (0.2 + 0.3 * grit)
    return col, np.clip(h, 0, 1)


def src_gradient(n, p, rng):
    x, y = grid(n)
    b = max(1, int(p.get("bands", 1)))
    kind = p.get("kind", "linear")
    if kind == "linear":
        t = ((y if p.get("vertical") else x) * b) % 1.0
        h = 1 - np.abs(t - 0.5) * 2  # triangelvåg: sömlös
    else:
        fx, fy = (x * b) % 1.0 - 0.5, (y * b) % 1.0 - 0.5
        r = np.sqrt(fx * fx + fy * fy) * 2
        h = np.clip(1 - r, 0, 1) if kind == "radial" else np.clip(1 - np.maximum(np.abs(fx), np.abs(fy)) * 2, 0, 1) ** 0.5
    s = p.get("softness", 1)
    if s < 1:
        h = smooth(0.5 - s * 0.5 - 0.01, 0.5 + s * 0.5 + 0.01, h)
    return mix(p, h), h.astype(np.float32)


def src_image(n, p, rng):
    name = p.get("name", "bark_painted")
    im = Image.open(TEX / f"{name}.png").convert("RGBA")
    a = resize_wrap(np.asarray(im, np.float32) / 255, n)
    hp = TEX / f"{name}_height.png"
    if hp.exists():
        h = resize_wrap((np.asarray(Image.open(hp).convert("F"), np.float32) / (65535 if Image.open(hp).mode.startswith("I") else 255))[..., None], n)[..., 0]
    else:
        h = wrap_blur(lum(a), n / 512)
    return a, h


def comfy_up():
    try:
        urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=2).read()
        return True
    except Exception:
        return False


def src_krea(n, p, rng, ctx):
    # Krea-2 i den lokala ComfyUI: text till bild, eller bild till bild från en ingrediens. Resultatet (1024 px)
    # cachas per prompt, frö, stil och bas, så att spakarna efteråt bara räknar om stegen.
    style = STYLE["prompt"]
    prompt = ", ".join(x for x in [p.get("prompt", ""), style["house_style"] if p.get("style", True) else "", style["kinds"]["tile"]] if x)
    base = p.get("base") or ""
    key = {"prompt": prompt, "seed": int(p.get("seed", 1)), "base": base and ctx.key_of(base, 1024), "denoise": p.get("denoise", 0.6) if base else None}
    h = hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()[:16]
    out = CACHE / "krea" / f"{h}.png"
    if not out.exists():
        if not comfy_up():
            raise RuntimeError("ComfyUI is not running (127.0.0.1:8188). Start it and try again.")
        out.parent.mkdir(parents=True, exist_ok=True)
        cmd = [sys.executable, "-I", str(ROOT / "tools/texture/krea2.py"), prompt, "1024", "1024", str(out), str(int(p.get("seed", 1)))]
        if base:
            t = ctx.get(base, 1024)
            bp = CACHE / "krea" / f"{h}_base.png"
            save_png(t["rgb"], bp)
            cmd += ["--base", str(bp), "--denoise", str(p.get("denoise", 0.6))]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if r.returncode or not out.exists():
            raise RuntimeError("Krea failed: " + (r.stderr or r.stdout).strip()[-300:])
    img = np.asarray(Image.open(out).convert("RGB"), np.float32) / 255
    if p.get("seamless", True):
        # Med en sömlös bas är Krea redan nästan sömlös och formerna ligger kvar där formen har dem: skarven jämnas då
        # ut på plats, så att reliefen från formen fortfarande passar
        img = seam_even(img, 0.06) if base else tile_blend(img, 0.25)
    img = resize_wrap(img, n)
    h = wrap_blur(lum(img), n / 512)
    relief = p.get("relief", "form")
    if base and relief != "image":
        hb = ctx.get(base, n)["h"]
        h = hb if relief == "form" else 0.7 * hb + 0.3 * norm01(h)
    return img, h


# Sand och snö: vindrippel med lång mjuk lovartsida och kort brant läsida. Vågvektorn är heltal i båda led, så att
# ripplen går runt kanterna; låg-frekvent förvrängning gör dem slingriga och brytning låter dem dö ut i fläckar
def src_ripples(n, p, rng):
    x, y = grid(n)
    k = max(2, int(p.get("ripples", 14)))
    ang = np.radians(p.get("direction", 20))
    kx, ky = int(round(np.cos(ang) * k)), int(round(np.sin(ang) * k))
    if kx == 0 and ky == 0:
        kx = k
    wob = p.get("wobble", 0.4)
    warp = (fbm(n, 2.5, 3, rng) - 0.5) / 0.22 * wob * 0.55
    up = 1 - np.clip(p.get("sharpness", 0.6), 0, 0.95) * 0.8  # andel av våglängden som stiger

    def ripple(kx, ky, warp):
        ph = (kx * x + ky * y + warp) % 1.0
        return smooth(0, 1, np.where(ph < up, ph / up, (1 - ph) / (1 - up)))
    prof = ripple(kx, ky, warp)
    # En svagare andra ripple i lite annan riktning, som i riktig sand där två vindar mötts
    a2 = ang + np.radians(28)
    prof2 = ripple(int(round(np.cos(a2) * k * 1.6)) or 1, int(round(np.sin(a2) * k * 1.6)), warp * 1.3)
    br = p.get("breakup", 0.35)
    calm = smooth(0.3, 0.7, fbm(n, 3, 3, rng))  # där ripplen planar ut
    h = (prof * 0.8 + prof2 * 0.2) * (1 - br * 0.85 * calm) + 0.5 * br * 0.85 * calm * 0.6
    h = np.clip(h * 0.88 + (fbm(n, 90, 2, rng) - 0.5) * p.get("grains", 0.3) * 0.5, 0, 1)
    col = mix(p, h) + (smooth(0.8, 1, prof) * (1 - calm * br) * 0.035)[..., None]
    return col, h


# Spruckna plattor (torkad lera, sprucken jord, is): Voronoi-celler vars kanter blir sprickor med varierande bredd,
# kanterna böjer upp (curl) som i torkad lera, och finare sprickor delar en del av plattorna
def src_cracks(n, p, rng):
    def cells(count, jitter):
        g = max(2, int(round(np.sqrt(count))))
        jit = (rng.random((g, g, 2)) - 0.5) * jitter
        gy, gx = np.mgrid[0:g, 0:g]
        return ((np.stack([gx, gy], -1) + 0.5 + jit) / g).reshape(-1, 2) % 1, 1 / g
    pts, size = cells(int(p.get("cells", 30)), 0.9)
    f1, f2, idx = voronoi(n, pts)
    edge = f2 - f1  # 0 mitt i sprickan
    wob = (fbm(n, 8, 3, rng) - 0.5) / 0.22 * size * 0.07 * p.get("wobble", 0.5)
    w = p.get("width", 0.05) * size * (0.5 + 1.0 * fbm(n, 4, 2, rng))
    crack = 1 - smooth(0, w + 1e-4, edge + wob)
    fine = p.get("fine", 0.4)
    crack2 = np.zeros_like(crack)
    if fine > 0:
        pts2, size2 = cells(min(160, int(p.get("cells", 30)) * 4), 0.9)
        g1, g2, _ = voronoi(n, pts2)
        crack2 = (1 - smooth(0, p.get("width", 0.05) * size2 * 0.6 + 1e-4, g2 - g1 + wob * 0.5)) * smooth(0.45, 0.6, fbm(n, 5, 3, rng)) * fine
    curl = p.get("curl", 0.5)
    plate = 0.72 + curl * 0.28 * (1 - smooth(0, size * 0.3, edge))
    tint = (1 + (rng.random(len(pts)) - 0.5) * 2 * p.get("tint", 0.12))[idx]
    h = np.clip(plate * (1 - crack) * (1 - crack2 * 0.45) + (fbm(n, 30, 2, rng) - 0.5) * 0.06, 0, 1)
    body = mix(p, smooth(0.2, 0.8, fbm(n, 5, 3, rng))) * tint[..., None]
    col = body + (hexrgb(p.get("crack", "#3A2C20")) - body) * np.clip(crack + crack2 * 0.8, 0, 1)[..., None]
    return np.clip(col, 0, 1), h


def seam_even(img, width):
    # Fördelar skillnaden över skarven på en smal kant på båda sidor (utjämnad längs kanten, så att inga streck blir
    # kvar). Formerna flyttas inte, till skillnad från tile_blend.
    n = img.shape[0]
    w = max(2, int(n * width))
    ramp = (1 - np.arange(w) / w)[:, None] * 0.5
    out = img.copy()
    for axis in (1, 0):
        a, b = np.take(out, 0, axis=axis), np.take(out, -1, axis=axis)
        d = a - b
        f = np.exp(-0.5 * (np.fft.fftfreq(n) * 2 * np.pi * n / 64) ** 2)[:, None]
        d = np.real(np.fft.ifft(np.fft.fft(d, axis=0) * f, axis=0))
        for k in range(w):
            sl0 = [slice(None)] * 3; sl0[axis] = k
            sl1 = [slice(None)] * 3; sl1[axis] = n - 1 - k
            out[tuple(sl0)] -= d * ramp[k]
            out[tuple(sl1)] += d * ramp[k]
    return np.clip(out, 0, 1)


SOURCES = {"noise": src_noise, "bark": src_bark, "stone": src_stone, "bricks": src_bricks, "planks": src_planks, "ripples": src_ripples, "cracks": src_cracks,
           "shingles": src_shingles, "splat": src_splat, "gradient": src_gradient, "image": src_image}


# --- Ingredienser: namngivna under-texturer, cachade var för sig ---
def tex_files(obj, acc):
    # Texturfiler som ett recept läser (för cachenyckeln: ändras filen ska cachen inte gälla)
    if isinstance(obj, dict):
        if obj.get("type") == "image" and obj.get("name"):
            acc.add(obj["name"])
        if isinstance(obj.get("texture"), str):
            acc.add(obj["texture"])
        for v in obj.values():
            tex_files(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            tex_files(v, acc)
    return acc


def stamp_key(obj):
    files = sorted(tex_files(obj, set()))
    mt = [int((TEX / f"{f}.png").stat().st_mtime) if (TEX / f"{f}.png").exists() else 0 for f in files]
    return hashlib.sha1(json.dumps({"o": obj, "f": files, "m": mt, "v": CODE_VERSION}, sort_keys=True).encode()).hexdigest()[:20]


class Ctx:
    def __init__(self, scope, chain=()):
        self.scope = scope or {}
        self.chain = chain
        self.memo = {}

    def key_of(self, name, n):
        return stamp_key({"in": name, "def": self.scope.get(name), "scope": self.scope, "n": n})

    def get(self, name, n):
        if not name:
            raise RuntimeError("an ingredient is missing: pick one in the slider")
        if name in self.chain:
            raise RuntimeError(f"the ingredient {name} uses itself")
        d = self.scope.get(name)
        if d is None:
            raise RuntimeError(f"the ingredient {name} does not exist")
        k = (name, n)
        if k in self.memo:
            return self.memo[k]
        key = self.key_of(name, n)
        f = CACHE / "ing" / f"{key}.npz"
        if f.exists():
            z = np.load(f)
            t = {"rgb": z["rgb"], "a": z["a"] if z["a"].size else None, "h": z["h"]}
        else:
            if "texture" in d:
                rgba, h = src_image(n, {"name": d["texture"]}, None)
                t = {"rgb": rgba[..., :3], "a": rgba[..., 3] if (rgba[..., 3] < 0.99).any() else None, "h": h}
            else:
                sub = d.get("recipe", {})
                t = build_tex(sub, n, Ctx({**self.scope, **sub.get("inputs", {})}, self.chain + (name,)))
            f.parent.mkdir(parents=True, exist_ok=True)
            np.savez(f, rgb=t["rgb"].astype(np.float32), a=(t["a"] if t["a"] is not None else np.zeros(0, np.float32)), h=t["h"].astype(np.float32))
        self.memo[k] = t
        return t


# --- Steg: arbetar på {"rgb", "a", "h"} ---
PALETTE_GROUPS = {
    "foliage": ("foliage_", "bush_green", "grass_tip"), "conifer": ("conifer_",), "bark": ("bark", "cattail", "straw"),
    "stone": ("stone",), "ground": ("sand", "straw", "bark_shadow", "stone_shadow"),
}


def stack(t):
    parts = [t["rgb"], t["h"][..., None]] + ([t["a"][..., None]] if t["a"] is not None else [])
    return np.concatenate(parts, -1)


def unstack(arr, had_alpha):
    return {"rgb": arr[..., :3], "h": arr[..., 3], "a": arr[..., 4] if had_alpha else None}


def tile_blend(img, width):
    n = img.shape[0]
    # Förskjut en tredjedel, inte ett halvt varv: texturer som redan sömlagts har sin skarv i mitten
    sh = np.roll(img, (n // 3, n // 3), axis=(0, 1))
    yy, xx = np.mgrid[0:n, 0:n]
    edge = np.minimum.reduce([xx, n - 1 - xx, yy, n - 1 - yy]) / (n / 2)
    w = np.clip(edge / max(width, 0.01), 0, 1)[..., None] ** 1.5
    return img * w + sh * (1 - w)


def mask_from(kind, t, n, rng):
    if kind in ("low", "high"):
        m = norm01(t["h"])
        return 1 - m if kind == "low" else m
    if kind in ("dark", "light"):
        m = norm01(lum(t["rgb"]))
        return 1 - m if kind == "dark" else m
    if kind == "slope":
        h = t["h"]
        g = np.hypot(np.roll(h, -1, 1) - np.roll(h, 1, 1), np.roll(h, -1, 0) - np.roll(h, 1, 0))
        return norm01(wrap_blur(g, n / 512))
    if kind == "noise":
        return norm01(fbm(n, 6, 4, rng))
    return np.ones((n, n), np.float32)


def kuwahara(rgb, r):
    # Målad look: för varje pixel medelvärdet i den av fyra kvadranter som har minst variation
    n = rgb.shape[0]
    r = max(1, int(round(r)))
    l = lum(rgb)
    best_v = np.full((n, n), np.inf, np.float32)
    out = np.zeros_like(rgb)
    F = lambda a: np.fft.fft2(a, axes=(0, 1))
    data = np.concatenate([rgb, l[..., None], (l * l)[..., None]], -1)
    Fd = F(data)
    for sy, sx in ((0, 0), (0, 1), (1, 0), (1, 1)):
        k = np.zeros((n, n), np.float32)
        ys = np.arange(0, r + 1) * (1 if sy else -1)
        xs = np.arange(0, r + 1) * (1 if sx else -1)
        k[np.ix_(ys % n, xs % n)] = 1.0 / ((r + 1) ** 2)
        Fk = np.fft.fft2(k)[..., None]
        m = np.real(np.fft.ifft2(Fd * Fk, axes=(0, 1))).astype(np.float32)
        var = m[..., 4] - m[..., 3] ** 2
        better = var < best_v
        best_v = np.where(better, var, best_v)
        out = np.where(better[..., None], m[..., :3], out)
    return out


def stamp(shape, rad, rng, dark, light, shade, src=None):
    # En stämpel (färg, alfa, höjd) i en ruta runt mitten. rad = halva storleken i pixlar
    m = int(np.ceil(rad * 1.15)) + 1
    yy, xx = np.mgrid[-m:m + 1, -m:m + 1].astype(np.float32) / rad
    ang = rng.random() * 2 * np.pi
    u = xx * np.cos(ang) + yy * np.sin(ang)
    v = -xx * np.sin(ang) + yy * np.cos(ang)
    e = 1.5 / rad
    t = rng.random()
    col = dark + (light - dark) * t
    if shape == "input" and src is not None:
        im = Image.fromarray((np.concatenate([src["rgb"], (src["a"] if src["a"] is not None else np.ones(src["rgb"].shape[:2], np.float32))[..., None]], -1) * 255).astype(np.uint8), "RGBA")
        im = im.resize((2 * m + 1, 2 * m + 1), Image.LANCZOS).rotate(np.degrees(ang), resample=Image.BILINEAR)
        arr = np.asarray(im, np.float32) / 255
        a = arr[..., 3] * (np.hypot(xx, yy) < 1.15)
        return arr[..., :3], a, a * 0.8
    if shape == "leaf":
        w = 0.48 + 0.12 * rng.random()
        prof = w * np.clip(1 - u * u, 0, 1) ** 0.75
        d = prof - np.abs(v)
        a = smooth(-e, e, d) * (np.abs(u) < 1)
        rib = 1 - 0.35 * smooth(0.06, 0.0, np.abs(v)) * (np.abs(u) < 0.9)
        side = 1 + shade * 0.25 * np.sign(v) * (np.abs(v) > 0.02)
        h = np.clip(d / np.maximum(w, 1e-3), 0, 1) ** 0.5
        c = col * (rib * side * (0.85 + 0.15 * (1 - np.abs(u))))[..., None]
        return c, a, h
    if shape == "pebble":
        ry = 0.6 + 0.35 * rng.random()
        r = np.sqrt(u * u + (v / ry) ** 2)
        a = smooth(1 + e, 1 - e, r)
        h = np.sqrt(np.clip(1 - r * r, 0, 1))
        light_dir = (-0.5 * xx - 0.6 * yy)  # ljus uppifrån vänster i bilden
        c = col * (1 - shade * 0.35 + shade * 0.35 * h + shade * 0.15 * light_dir)[..., None]
        return c, a, h
    if shape == "flower":
        r = np.hypot(u, v)
        th = np.arctan2(v, u)
        pr = 0.55 + 0.45 * np.abs(np.cos(2.5 * th))
        a = smooth(-e, e, pr - r)
        centre = smooth(0.28, 0.2, r)
        c = col * (1 - shade * 0.3 * r)[..., None]
        c = c * (1 - centre[..., None]) + np.array([0.95, 0.78, 0.25], np.float32) * centre[..., None]
        return c, a, np.clip(1 - r, 0, 1) * 0.7 + centre * 0.3
    if shape == "twig":
        d = 0.07 * (1 - 0.4 * np.abs(u)) - np.abs(v + 0.08 * u * u)
        a = smooth(-e, e, d) * (np.abs(u) < 1)
        c = col * (0.8 + 0.2 * smooth(-0.02, 0.05, -v))[..., None]
        return c, a, np.clip(d / 0.07, 0, 1)
    r = np.hypot(u, v)  # dot
    a = smooth(1 + e, 1 - e, r)
    return np.broadcast_to(col, u.shape + (3,)) * (1 - shade * 0.3 * r)[..., None], a, np.sqrt(np.clip(1 - r * r, 0, 1))


def scatter(t, s, n, ctx, rng):
    count = int(s.get("count", 60))
    size = s.get("size", 0.06)
    clump = s.get("clump", 0.3)
    shape = s.get("shape", "leaf")
    src = ctx.get(s.get("input"), max(32, int(n * size * 2.4))) if shape == "input" else None
    dark, light = hexrgb(s.get("dark", "#8A4E22")), hexrgb(s.get("light", "#D89A3A"))
    centres = rng.random((max(1, count // 6), 2))
    rgb, h = t["rgb"].copy(), t["h"].copy()
    alpha = t["a"]
    for i in range(count):
        if rng.random() < clump:
            c = centres[rng.integers(len(centres))] + rng.normal(0, 0.06, 2)
        else:
            c = rng.random(2)
        rad = max(1.5, size * n / 2 * (1 + (rng.random() - 0.5) * 2 * s.get("size_var", 0.4)))
        c3, a, sh = stamp(shape, rad, rng, dark, light, s.get("shade", 0.5), src)
        m = (a.shape[0] - 1) // 2
        cy, cx = int(c[1] % 1 * n), int(c[0] % 1 * n)
        ys, xs = (np.arange(-m, m + 1) + cy) % n, (np.arange(-m, m + 1) + cx) % n
        ix = np.ix_(ys, xs)
        a3 = a[..., None]
        rgb[ix] = rgb[ix] * (1 - a3) + c3 * a3
        h[ix] = h[ix] * (1 - a) + a * np.maximum(h[ix], 0.55 + 0.45 * sh)
        if alpha is not None:
            alpha[ix] = np.maximum(alpha[ix], a)
    return {"rgb": rgb, "a": alpha, "h": h}


def layer(t, s, n, ctx, rng):
    src = ctx.get(s.get("input"), n)
    rep = max(1, int(s.get("repeat", 1)))
    top = stack(src)[..., :4]
    if rep > 1:
        m = int(np.ceil(n / rep))
        top = resize_wrap(np.tile(resize_wrap(top, m), (rep, rep, 1)), n)
    trgb, th = top[..., :3], top[..., 3]
    kind = s.get("mask", "low")
    amount = s.get("amount", 0.5)
    if kind == "none":
        m = np.full((n, n), amount, np.float32)
    else:
        base = norm01(lum(ctx.get(s.get("mask_input"), n)["rgb"])) if kind == "input" else mask_from(kind, t, n, rng)
        if s.get("breakup", 0.3) > 0:
            base = base + (norm01(fbm(n, s.get("breakup_scale", 10), 3, rng)) - 0.5) * s.get("breakup", 0.3)
        soft = s.get("softness", 0.08)
        m = smooth(1 - amount - soft, 1 - amount + soft, base)
    if src["a"] is not None:
        a = src["a"]
        if rep > 1:
            a = resize_wrap(np.tile(resize_wrap(a[..., None], int(np.ceil(n / rep))), (rep, rep, 1)), n)[..., 0]
        m = m * a
    m = (m * s.get("opacity", 1)).astype(np.float32)
    base_rgb = t["rgb"]
    mode = s.get("mode", "mix")
    if mode == "multiply":
        blend = base_rgb * trgb * 2
    elif mode == "overlay":
        blend = np.where(base_rgb < 0.5, 2 * base_rgb * trgb, 1 - 2 * (1 - base_rgb) * (1 - trgb))
    elif mode == "screen":
        blend = 1 - (1 - base_rgb) * (1 - trgb)
    else:
        blend = trgb
    rgb = base_rgb + (np.clip(blend, 0, 1) - base_rgb) * m[..., None]
    hm = s.get("height", "fill")
    h = t["h"]
    if hm == "fill":
        h = h + m * (0.12 + 0.25 * th)
        h = h / max(1.0, float(h.max()))
    elif hm == "mix":
        h = h * (1 - m) + th * m
    return {"rgb": rgb, "a": t["a"], "h": h.astype(np.float32)}


# --- OKLab (perceptuellt jämn färgrymd) för stiliseringens palett ---
_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]], np.float32)
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]], np.float32)


def srgb_to_oklab(rgb):
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    return np.cbrt(c @ _M1.T) @ _M2.T


def oklab_to_srgb(lab):
    c = np.clip(((lab @ np.linalg.inv(_M2).T) ** 3) @ np.linalg.inv(_M1).T, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055).astype(np.float32)


def palette_kmeans(lab, k, iters=12):
    # Ett glest, jämnt urval (oberoende av slump och nästan av upplösningen), startat i ljushetens kvantiler
    flat = lab.reshape(-1, 3)
    sample = flat[:: max(1, len(flat) // 40000)]
    order = np.argsort(sample[:, 0])
    cent = sample[order[((np.arange(k) + 0.5) / k * len(order)).astype(int)]].copy()
    for _ in range(iters):
        near = ((sample[:, None, :] - cent[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            m = near == j
            if m.any():
                cent[j] = sample[m].mean(0)
    return cent


def soft_quantize(lab, cent, tau):
    # Mjuk tilldelning: nära en palettfärg dras pixeln dit, mellan två blir övergången mjuk (inga trappsteg)
    flat, out = lab.reshape(-1, 3), np.empty((lab.size // 3, 3), np.float32)
    for i in range(0, len(flat), 1 << 18):
        f = flat[i:i + (1 << 18)]
        d = ((f[:, None, :] - cent[None]) ** 2).sum(-1)
        w = np.exp(-(d - d.min(1, keepdims=True)) / (2 * tau * tau))
        out[i:i + len(f)] = (w / w.sum(1, keepdims=True)) @ cent
    return out.reshape(lab.shape)


def step(t, s, n, ctx):
    op = s.get("op")
    rng = np.random.default_rng(int(s.get("seed", 1)) * 7919 + 11)
    rgb, a, h = t["rgb"], t["a"], t["h"]
    if op == "layer":
        return layer(t, s, n, ctx, rng)
    if op == "scatter":
        return scatter(t, s, n, ctx, rng)
    if op in ("tile", "repeat", "offset", "rotate", "mirror", "warp"):
        arr, had = stack(t), a is not None
        if op == "tile":
            arr = tile_blend(arr, s.get("width", 0.25))
        elif op == "repeat":
            k = max(1, int(s.get("times", 2)))
            if k > 1:
                # Exakt n/k per kopia (även när n inte är jämnt delbart), skalat med kanterna lindade runt
                m = int(np.ceil(n / k))
                arr = np.tile(resize_wrap(arr, m), (k, k, 1))[:n, :n] if m * k == n else resize_wrap(np.tile(resize_wrap(arr, m), (k, k, 1)), n)
        elif op == "offset":
            arr = np.roll(arr, (int(s.get("y", 0) * n), int(s.get("x", 0.5) * n)), axis=(0, 1))
        elif op == "rotate":
            arr = np.rot90(arr, -int(s.get("angle", 90)) // 90, axes=(0, 1)).copy()
        elif op == "mirror":
            arr = arr[:, ::-1] if s.get("axis", "x") == "x" else arr[::-1]
        elif op == "warp":
            sc = s.get("scale", 4)
            wx = (fbm(n, sc, 3, rng) - 0.5) / 0.22 * s.get("amount", 0.03) * n
            wy = (fbm(n, sc, 3, rng) - 0.5) / 0.22 * s.get("amount", 0.03) * n
            yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
            arr = sample_wrap(arr, xx + wx, yy + wy)
        return unstack(np.ascontiguousarray(arr, np.float32), had)
    if op == "levels":
        rgb = np.clip((rgb - 0.5) * s.get("contrast", 1) + 0.5 + s.get("lift", 0), 0, 1) ** (1 / max(s.get("gamma", 1), 0.05))
    elif op == "hsv":
        flat = rgb.reshape(-1, 3)
        mx, mn = flat.max(1), flat.min(1)
        d = mx - mn + 1e-9
        r, g, b = flat[:, 0], flat[:, 1], flat[:, 2]
        hh = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6
        sat = np.where(mx > 0, (mx - mn) / (mx + 1e-9), 0)
        hh = (hh + s.get("hue", 0) / 360) % 1
        sat = np.clip(sat * s.get("saturation", 1), 0, 1)
        v = np.clip(mx * s.get("value", 1), 0, 1)
        i = np.floor(hh * 6).astype(int) % 6
        f = hh * 6 - np.floor(hh * 6)
        pp, q, tt = v * (1 - sat), v * (1 - f * sat), v * (1 - (1 - f) * sat)
        out = np.choose(i[:, None], [np.stack(c, 1) for c in ((v, tt, pp), (q, v, pp), (pp, v, tt), (pp, q, v), (tt, pp, v), (v, pp, q))])
        rgb = out.reshape(rgb.shape).astype(np.float32)
    elif op == "palette":
        keys = PALETTE_GROUPS.get(s.get("group", "all"))
        pal = np.stack([hexrgb(v) for k, v in STYLE["palette"].items() if keys is None or k.startswith(keys)])
        flat = rgb.reshape(-1, 3)
        d = ((flat[:, None, :] - pal[None, :, :]) ** 2).sum(-1)
        near = pal[d.argmin(1)].reshape(rgb.shape)
        rgb = rgb + (near - rgb) * s.get("amount", 0.4)
    elif op == "colorramp":
        tv = norm01(h if s.get("by", "height") == "height" else lum(rgb))
        mp = s.get("mid_pos", 0.5)
        lo, mid, hi = hexrgb(s.get("low", "#3B3A33")), hexrgb(s.get("mid", "#7D7766")), hexrgb(s.get("high", "#C9C2AE"))
        t1 = np.clip(tv / mp, 0, 1)[..., None]
        t2 = np.clip((tv - mp) / (1 - mp), 0, 1)[..., None]
        ramp = np.where(tv[..., None] < mp, lo + (mid - lo) * t1, mid + (hi - mid) * t2)
        l = lum(rgb)
        detail = (l - wrap_blur(l, n / 256))[..., None] * s.get("keep_detail", 0.4) * 2
        rgb = rgb + (np.clip(ramp + detail, 0, 1) - rgb) * s.get("amount", 1)
    elif op == "edges":
        c = h - wrap_blur(h, s.get("radius", 4) * n / 1024)
        c = c / (3 * float(c.std()) + 1e-6)
        rgb = rgb * (1 + s.get("edge", 0.35) * 0.6 * np.clip(c, 0, 1))[..., None] * (1 - s.get("cavity", 0.35) * 0.6 * np.clip(-c, 0, 1))[..., None]
    elif op == "height":
        src = {"keep": h, "lum": lum(rgb)}.get(s.get("from", "keep"))
        if src is None:
            src = h * (1 - s.get("mix", 0.5)) + norm01(lum(rgb)) * s.get("mix", 0.5)
        src = norm01(src)
        if s.get("blur", 0) > 0:
            src = wrap_blur(src, s["blur"] * n / 1024)
        src = np.clip((src - 0.5) * s.get("contrast", 1) + 0.5, 0, 1)
        h = 1 - src if s.get("invert") else src
    elif op == "gray":
        l = lum(rgb)
        vis = a > 0.45 if a is not None else np.ones_like(l, bool)
        g = np.clip(l * s.get("mean", 0.82) / max(float(l[vis].mean()), 1e-3), 0, 1)
        rgb = np.repeat(g[..., None], 3, -1)
    elif op == "soften":
        k = s.get("amount", 1)
        blur = wrap_blur(rgb, max(2, n / 80))
        local = blur + (rgb - blur) * (1 - 0.45 * k)
        mean = local.reshape(-1, 3).mean(0)
        rgb = np.clip(mean + (local - mean) * (1 - 0.2 * k), 0, 1)
    elif op == "frequency":
        low = wrap_blur(rgb, s.get("radius", 6) * n / 1024)
        mean = rgb.reshape(-1, 3).mean(0)
        rgb = mean + (low - mean) * s.get("low", 1) + (rgb - low) * s.get("high", 0.6)
    elif op == "sharpen":
        rgb = rgb + (rgb - wrap_blur(rgb, s.get("radius", 1.5) * n / 1024)) * s.get("amount", 0.5)
    elif op == "paint":
        rgb = kuwahara(rgb, s.get("radius", 4) * n / 1024)
    elif op == "stylize":
        # Från foto mot målat spelmaterial, som en samordnad omvandling (patriks_input/AAA_Procedural_Textures_Stylization):
        # kantbevarande utjämning, mikrodetaljer bort, de stora formerna ur höjden förstärkta, färre färger i OKLab,
        # konstnärlig mättnad och en förenklad höjd, allt styrt av samma styrka. Allt går runt kanterna (sömlöst).
        st, sc = float(s.get("strength", 0.6)), n / 1024
        if st > 0:
            sm = kuwahara(rgb, (1 + 7 * st) * sc)
            rgb = rgb + (sm - rgb) * min(1.0, 0.4 + st)
            # Mikrodetaljer: allt mindre än ungefär 1/40 av texturen tonas bort, nästan helt vid full styrka
            low = wrap_blur(rgb, (2 + 12 * st) * sc)
            rgb = low + (rgb - low) * (1 - 0.92 * st) ** 1.5
        hs = wrap_blur(h, (1 + 3 * st) * sc)
        c = hs - wrap_blur(hs, 10 * sc)
        c = c / (3 * float(c.std()) + 1e-6)
        sh = s.get("shape", 0.5) * (0.3 + 0.7 * st)
        rgb = rgb * (1 + sh * 0.35 * np.clip(c, 0, 1))[..., None] * (1 - sh * 0.4 * np.clip(-c, 0, 1))[..., None]
        lab = srgb_to_oklab(np.clip(rgb, 0, 1))
        q = soft_quantize(lab, palette_kmeans(lab, max(2, int(s.get("colors", 8)))), 0.008 + 0.05 * (1 - st))
        lab = lab + (q - lab) * (0.25 + 0.75 * st)
        lab[..., 1:] *= s.get("saturation", 1.08) ** st
        rgb = oklab_to_srgb(lab)
        if s.get("relief", True):
            h = h + (wrap_blur(h, (2 + 6 * st) * sc) - h) * 0.75 * st
    elif op == "delight":
        # Ta bort inbakat ljus ur foton och AI-bilder: dela bort den storskaliga ljusheten (belysningen), lyft sedan de
        # lokala skuggorna mot omgivningen, så att färgen blir ett material och inte en belyst bild
        l = lum(rgb) + 1e-3
        illum = wrap_blur(l, s.get("scale", 0.12) * n)
        rgb = np.clip(rgb * ((float(l.mean()) / np.maximum(illum, 0.02)) ** s.get("amount", 0.8))[..., None], 0, 1)
        if s.get("shadows", 0.4) > 0:
            loc = wrap_blur(rgb, n / 48)
            rgb = rgb + np.clip(loc - rgb, 0, None) * s.get("shadows", 0.4) * 0.6
    elif op == "posterize":
        lv = max(2, int(s.get("levels", 6))) - 1
        q = np.clip(rgb, 0, 1) * lv
        f = q - np.floor(q)
        sw = s.get("softness", 0.3) * 0.5 + 0.01
        rgb = (np.floor(q) + smooth(0.5 - sw, 0.5 + sw, f)) / lv
    elif op == "range":
        lo, hi = s.get("low", 0.08), s.get("high", 0.9)
        rgb = lo + np.clip(rgb, 0, 1) * (hi - lo)
    elif op == "blur":
        rgb = wrap_blur(rgb, s.get("radius", 1.5) * n / 1024)
    elif op == "cutout":
        src = lum(rgb) if s.get("from", "lum") == "lum" else norm01(h)
        th, so = s.get("threshold", 0.5), s.get("soft", 0.05) + 1e-3
        m = smooth(th - so, th + so, src)
        m = 1 - m if s.get("invert") else m
        a = m if a is None else np.minimum(a, m)
    elif op == "bleed" and a is not None:
        # Fyll genomskinliga pixlar inifrån och ut med allt större oskärpa av de synliga
        out, done = rgb.copy(), a > 0.5
        for r in (1, 2, 4, 8, 16, 32, 64):
            w = wrap_blur(a, r * n / 1024)
            c = wrap_blur(rgb * a[..., None], r * n / 1024) / np.maximum(w, 1e-4)[..., None]
            fill = ~done & (w > 0.01)
            out = np.where(fill[..., None], c, out)
            done |= fill
        rgb = out
    elif op == "alphablur" and a is not None:
        a = np.clip(wrap_blur(a, s.get("radius", 1.5) * n / 1024), 0, 1)
    return {"rgb": np.clip(rgb, 0, 1).astype(np.float32), "a": a, "h": np.clip(h, 0, 1).astype(np.float32)}


def build_tex(recipe, n, ctx):
    src = recipe.get("source", {"type": "noise"})
    kind = src.get("type", "noise")
    src = with_defaults("sources", kind, src)
    rng = np.random.default_rng(int(src.get("seed", 1)))
    if kind == "input":
        t0 = ctx.get(src.get("input"), n)
        t = {"rgb": t0["rgb"].copy(), "a": None if t0["a"] is None else t0["a"].copy(), "h": t0["h"].copy()}
    else:
        col, h = src_krea(n, src, rng, ctx) if kind == "krea" else SOURCES[kind](n, src, rng)
        col = col.astype(np.float32)
        t = {"rgb": np.clip(col[..., :3], 0, 1), "a": col[..., 3] if col.shape[2] == 4 and (col[..., 3] < 0.99).any() else None,
             "h": np.clip(h, 0, 1).astype(np.float32)}
    for s in recipe.get("steps", []):
        if s.get("on", True):
            t = step(t, with_defaults("steps", s.get("op"), s), n, ctx)
    return t


def build_cached(recipe, n):
    # Hela stapeln cachas (utan materialet), så att en materialspak bara räknar om kartorna
    core = {k: recipe.get(k) for k in ("source", "steps", "inputs")}
    key = stamp_key({"core": core, "n": n})
    f = CACHE / "base" / f"{key}.npz"
    if f.exists():
        z = np.load(f)
        return {"rgb": z["rgb"], "a": z["a"] if z["a"].size else None, "h": z["h"]}
    t = build_tex(recipe, n, Ctx(recipe.get("inputs", {})))
    f.parent.mkdir(parents=True, exist_ok=True)
    np.savez(f, rgb=t["rgb"], a=(t["a"] if t["a"] is not None else np.zeros(0, np.float32)), h=t["h"])
    return t


# --- Materialets kartor ur färg och höjd ---
def pick(kind, t):
    if kind in ("low", "high"):
        m = norm01(t["h"])
        return 1 - m if kind == "low" else m
    if kind in ("dark", "light"):
        m = norm01(lum(t["rgb"]))
        return 1 - m if kind == "dark" else m
    return np.ones(t["h"].shape, np.float32)


def derive_maps(t, mat, n):
    m = material_defaults(mat)
    h = t["h"]
    maps = {"color": t["rgb"] if t["a"] is None else np.concatenate([t["rgb"], t["a"][..., None]], -1), "height": h}
    hs = wrap_blur(h, m["normal"]["soft"] * n / 1024)
    k = m["normal"]["strength"] * 0.04 * n
    dx = (np.roll(hs, -1, 1) - np.roll(hs, 1, 1)) / 2 * k
    dy = (np.roll(hs, -1, 0) - np.roll(hs, 1, 0)) / 2 * k
    nv = np.stack([-dx, dy, np.ones_like(dx)], -1)  # OpenGL-konvention (grönt uppåt), som glTF och three.js
    nv /= np.linalg.norm(nv, axis=-1, keepdims=True)
    if m["normal"]["on"]:
        maps["normal"] = nv * 0.5 + 0.5
    src = norm01(lum(t["rgb"]) if m["roughness"]["from"] == "lum" else h)
    sign = -1 if m["roughness"]["invert"] else 1
    rough = m["roughness"]["base"] + m["roughness"]["amount"] * (src - 0.5) * sign
    metal = None
    if m["metal"]["on"]:
        th = m["metal"]["threshold"]
        metal = np.ones_like(h) if m["metal"]["from"] == "all" else smooth(th - 0.04, th + 0.04, pick(m["metal"]["from"], t))
        maps["metal"] = metal
        rough = rough * (1 - metal) + m["metal"]["rough"] * metal
    maps["rough"] = np.clip(rough, 0.04, 1)
    if m["ao"]["on"]:
        r = m["ao"]["radius"] * n / 1024
        occ = np.clip((wrap_blur(h, r) - h) * 3 + (wrap_blur(h, r * 2.5) - h) * 2, 0, 1)
        maps["ao"] = 1 - m["ao"]["strength"] * occ
    if m["emission"]["on"]:
        th = m["emission"]["threshold"]
        mask = smooth(1 - th - 0.05, 1 - th + 0.05, pick(m["emission"]["from"], t))
        maps["emissive"] = hexrgb(m["emission"]["color"]) * mask[..., None]
    return maps


# --- Storebror och lillebror: lillebrodern skalas ned ur storebroderns kartor (översampling: renare kanter och
# lugnare mipmaps än om den ritades direkt i låg upplösning). Normalen normeras om efter nedskalningen ---
def downsample(img, n):
    if img.shape[0] == n:
        return img
    chans = img[..., None] if img.ndim == 2 else img
    out = np.stack([np.asarray(Image.fromarray(chans[..., c].astype(np.float32), "F").resize((n, n), Image.LANCZOS), np.float32) for c in range(chans.shape[2])], -1)
    return np.clip(out[..., 0] if img.ndim == 2 else out, 0, 1)


def downsample_maps(maps, n):
    out = {k: downsample(v, n) for k, v in maps.items()}
    if "normal" in out:
        v = out["normal"] * 2 - 1
        out["normal"] = v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-6) * 0.5 + 0.5
    return out


# --- Kontroller, som generatorernas checks ---
def checks(img, alpha=None):
    rgb = img[..., :3]
    # Söm: skillnaden över kanten (sista mot första raden och kolumnen) jämförs med skillnaderna mellan
    # grannrader närmast kanten (90:e percentilen av 16 rader på varje sida). Lokalt, så att steg som jämnar
    # ut mitten inte påverkar, och så att naturliga kanter som fogar inte räknas som söm.
    def ratio(a):
        n, k = a.shape[0], 16
        near = np.r_[0:k, n - 1 - k:n - 1]
        d = np.abs(a[near + 1] - a[near]).mean(axis=tuple(range(1, a.ndim)))
        return np.abs(a[0] - a[-1]).mean() / (np.percentile(d, 90) + 1e-6)
    seam = float(max(ratio(rgb), ratio(rgb.transpose(1, 0, 2))))
    pal = np.stack([hexrgb(v) for v in STYLE["palette"].values()])
    sample = rgb.reshape(-1, 3)[:: max(1, rgb.shape[0] * rgb.shape[1] // 40000)]
    dmin = np.sqrt(((sample[:, None] - pal[None]) ** 2).sum(-1)).min(1)
    l = lum(rgb)
    mean = rgb.reshape(-1, 3).mean(0)
    # Högfrekvens: andel av ljushetens variation som ligger i former mindre än 1/32 av texturen (stilguiden
    # vill låg frekvens; brusiga texturer flimrar och ser fotografiska ut)
    n = l.shape[0]
    P = np.abs(np.fft.fft2(l - l.mean())) ** 2
    f = np.fft.fftfreq(n) * n
    r = np.hypot(*np.meshgrid(f, f))
    hf = float(P[r > 32].sum() / (P.sum() + 1e-9))
    out = {
        "seam": round(seam, 2), "seamless": seam < 1.3,
        "off_palette": round(float((dmin > 0.22).mean()), 3),
        "mean": "#%02X%02X%02X" % tuple(int(c * 255) for c in mean),
        "value_range": [round(float(np.percentile(l, 2)), 2), round(float(np.percentile(l, 98)), 2)],
        "high_freq": round(hf, 3), "low_frequency": hf < 0.3,
    }
    if alpha is not None:
        # Vit halo: kantens färg (halvgenomskinligt) jämfört med det helt synliga
        edge = (alpha > 0.05) & (alpha < 0.5)
        solid = alpha > 0.9
        if edge.any() and solid.any():
            out["halo"] = round(float(l[edge].mean() - l[solid].mean()), 3)
        out["alpha_cover"] = round(float((alpha > 0.5).mean()), 3)
    return out


def save_png(img, path, bits16=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if img.ndim == 2:
        if bits16:
            Image.fromarray((np.clip(img, 0, 1) * 65535 + 0.5).astype(np.uint16)).save(path)
        else:
            Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), "L").save(path)
        return
    mode = "RGBA" if img.shape[2] == 4 else "RGB"
    Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), mode).save(path)


def main():
    recipe = json.loads(sys.argv[1])
    t0 = time.time()
    save = recipe.get("save")
    n = int(recipe.get("size", 1024 if save else 512))
    if save:
        name = save.get("name", "")
        if not name or set(name) - NAME_OK or len(name) > 48:
            sys.exit(json.dumps({"error": "the name may only have a–z, 0–9 and _ (at most 48 characters)"}))
        out = TEX / f"{name}.png"
        meta = TEX / f"{name}.texture.json"
        if out.exists() and not meta.exists():
            sys.exit(json.dumps({"error": f"{name} already exists and was not made in the Atelier; pick another name"}))
        if out.exists() and not save.get("overwrite"):
            sys.exit(json.dumps({"error": f"{name} already exists", "exists": True}))
    else:
        prefix = (ROOT / recipe.get("out", "build/studio/tex/preview")).resolve()
        if ROOT not in prefix.parents:
            sys.exit(json.dumps({"error": "out must be under the project root"}))
    hd = int(save.get("hd") or 0) if save else 0
    hd = hd if hd > n else 0
    try:
        t = build_cached(recipe, hd or n)
    except (RuntimeError, OSError, KeyError) as e:
        sys.exit(json.dumps({"error": str(e).strip("'\"")}))
    maps = derive_maps(t, recipe.get("material"), hd or n)
    big = None
    if hd:
        # Storebrodern (hd) är det som ritades; lillebrodern (n) skalas ned ur den
        big, maps = maps, downsample_maps(maps, n)
        t = {"rgb": maps["color"][..., :3], "a": maps["color"][..., 3] if maps["color"].shape[-1] == 4 else None}
    result = {"size": n, "ms": 0, "checks": checks(t["rgb"], t["a"]), "alpha": t["a"] is not None}
    if not save:
        result["maps"] = {}
        for k, v in maps.items():
            p = Path(f"{prefix}_{k}.png")
            save_png(v, p)
            result["maps"][k] = str(p.relative_to(ROOT))
    else:
        want = [k for k in save.get("maps") or ["color"] if k in maps] or ["color"]
        if "color" not in want:
            want.insert(0, "color")
        # Skriv över: den förra versionen flyttas till assets/textures/versions/
        if out.exists():
            vdir = TEX / "versions"
            vdir.mkdir(exist_ok=True)
            k = 1
            while (vdir / f"{name}_v{k}.png").exists():
                k += 1
            for f in [out, meta] + [TEX / f"{name}_{m}.png" for m in MAP_NAMES[1:]] + [TEX / f"{name}_orm.png", TEX / f"{name}.webp"] + [TEX / "hd" / f"{name}_hd{'' if m == 'color' else '_' + m}.png" for m in MAP_NAMES]:
                if f.exists():
                    shutil.move(str(f), str(vdir / f.name.replace(name, f"{name}_v{k}", 1)))
            result["previous"] = f"assets/textures/versions/{name}_v{k}.png"
        files = {}
        for k in want:
            p = out if k == "color" else TEX / f"{name}_{k}.png"
            save_png(maps[k], p, bits16=(k == "height"))
            files[k] = str(p.relative_to(ROOT))
        hd_files = {}
        if big is not None:
            for k in want:
                p = TEX / "hd" / f"{name}_hd{'' if k == 'color' else '_' + k}.png"
                save_png(big[k], p, bits16=(k == "height"))
                hd_files[k] = str(p.relative_to(ROOT))
        if save.get("pack") == "orm":
            ones = np.ones((n, n), np.float32)
            orm = np.stack([maps.get("ao", ones), maps["rough"], maps.get("metal", ones * 0)], -1)
            p = TEX / f"{name}_orm.png"
            save_png(orm, p)
            files["orm"] = str(p.relative_to(ROOT))
        if save.get("webp"):
            p = TEX / f"{name}.webp"
            Image.open(out).save(p, quality=88)
            files["webp"] = str(p.relative_to(ROOT))
        entry = {"name": name, "profile": save.get("profile", "terrain"), "maps": list(files), "files": files,
                 "meters": (recipe.get("material") or {}).get("meters", save.get("meters", 2.0)),
                 "tags": [x.strip().lower() for x in save.get("tags", []) if x.strip()], "recipe": f"assets/textures/{name}.texture.json",
                 "size": n, "saved": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        if hd_files:
            entry["hd"] = {"size": hd, "files": hd_files}
        # Receptet sparas med alla spakar utskrivna (även standardvärden), så att texturen går att göra om
        # exakt även om standardvärdena i workshop.json ändras senare
        src = with_defaults("sources", recipe["source"].get("type", "noise"), recipe["source"])
        steps = [with_defaults("steps", st.get("op"), st) for st in recipe.get("steps", [])]
        full = {**entry, "source": src, "steps": steps, "inputs": recipe.get("inputs", {}),
                "material": material_defaults(recipe.get("material")), "blend": recipe.get("blend", {"layers": []})}
        meta.write_text(json.dumps(full, indent=2, ensure_ascii=False) + "\n")
        cat_path = TEX / "catalog.json"
        cat = json.loads(cat_path.read_text()) if cat_path.exists() else {"textures": []}
        cat["textures"] = [x for x in cat["textures"] if x["name"] != name] + [entry]
        cat_path.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n")
        result["entry"] = entry
        result["out"] = files["color"]
    result["ms"] = int((time.time() - t0) * 1000)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
