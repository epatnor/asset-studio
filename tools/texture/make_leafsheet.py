"""Procedurellt lövark: 2x2-atlas med runda lövklasar (många små löv per cell) för lövkort och kortbollar.

  python3 -I tools/texture/make_leafsheet.py '{"name": "leafball_white", "mode": "white"}'

Recept:
  name       texturnamn -> assets/textures/<name>.png (celler i build/leafsheet/<name>/)
  mode       white   = vita löv, bara form och alfa; all färg kommer från tint och vertexfärg
             painted = gråskala med enkel målning per löv (valör, mittnerv, veck, mörkare under), tintbar
             color   = samma målning i paletten (foliage_shadow -> foliage_mid -> foliage_light)
  shape      oval | pointed | round | lance (pil) | birch (sågad kant) | oak (flikig) | heart (lind) | maple (lönn, handflikig)
  leaves     löv per cell (standard 34)
  spread     klasens radie i andel av cellen (standard 0.42)
  outer_bias exponent för lövens avstånd från mitten (standard 0.4; 0.5 = jämnt över ytan)
  leaf_size  [min, max] lövlängd i andel av cellen (standard [0.17, 0.27])
  sprig      löv per kvist (standard 1 = lösa löv; 4–7 ger små kvistar med växelvisa löv)
  stem       kvistens tjocklek i andel av cellen (standard 0.004; 0 = ingen synlig kvist). Kvisten slutar vid
             sista lövets fäste och ritas under alla löv, så den syns bara i gluggarna, aldrig utanför klasen
  aspect     lövets bredd/längd (standard efter form)
  alpha_blur pixlar gaussisk oskärpa på alfakanalen (0 = skarp)
  seed, size atlasens sida i px (standard 1024)
Svarar med en rad JSON.
"""
import json
import os
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageFilter
except ImportError:  # kör om sig själv med paketen via uv (fungerar i containern och på värden)
    os.execvp("uv", ["uv", "run", "--quiet", "--no-project", "--python", "3.12", "--with", "pillow==11.1.0",
                     "--with", "numpy==2.2.3", "python", "-I", __file__, *sys.argv[1:]])

ROOT = Path(__file__).resolve().parents[2]
SS = 2  # supersampling

# Halv bredd längs lövet (u = 0 vid fästet, 1 i spetsen), i andel av bredden
PROFILES = {
    "oval": lambda u: (4 * u * (1 - u)).clip(0) ** 0.55,
    "pointed": lambda u: np.sin(np.pi * u.clip(0, 1) ** 0.7) * (1 - u).clip(0) ** 0.3 * 1.15,
    "round": lambda u: np.sqrt((1 - (2 * u - 1) ** 2).clip(0)),
    "lance": lambda u: np.sin(np.pi * u.clip(0, 1) ** 0.6) * (1 - u).clip(0) ** 0.4 * 1.1,
    "birch": lambda u: np.sin(np.pi * u.clip(0, 1) ** 0.55) * (1 - u).clip(0) ** 0.35 * 1.2 * (1 - 0.09 * np.abs(np.sin(u * np.pi * 10))),
    "oak": lambda u: (4 * u * (1 - u)).clip(0) ** 0.5 * (0.68 + 0.32 * np.abs(np.sin(u * np.pi * 4.5 + 0.4)) ** 0.7),
    "heart": lambda u: np.sin(np.pi * (0.1 + 0.9 * u.clip(0, 1)) ** 0.8) ** 0.8 * (1 - u).clip(0) ** 0.2 * 1.05,
}
ASPECT = {"oval": 0.5, "pointed": 0.42, "round": 0.72, "lance": 0.2, "birch": 0.62, "oak": 0.6, "heart": 0.85, "maple": 1.0}


def leaf_d(shape, u, v, aspect):
    # Ungefärligt avstånd till lövets kant i lövlängder (< 0 inne i lövet); u längs lövet, v tvärs
    if shape == "maple":
        # Fem spetsiga flikar runt lövets mitt; mellan de två nedre sitter fästet
        du = u - 0.5
        th = np.arctan2(v, du)
        return np.hypot(du, v) - 0.5 * (0.5 + 0.5 * np.abs(np.cos(2.5 * th)) ** 1.6)
    d = np.maximum(np.abs(v) - PROFILES[shape](u) * aspect * 0.5, np.maximum(-u, u - 1))
    if shape == "heart":  # hjärtformad inskärning vid fästet
        d = np.where(u < 0.14, np.maximum(d, (0.14 - u) * 0.8 - np.abs(v)), d)
    return d


def hex_lin(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)], dtype=np.float32)


def cell(r, n, S, o):
    shape = o.get("shape", "oval")
    aspect = o.get("aspect", ASPECT[shape])
    lo, hi = o.get("leaf_size", [0.17, 0.27])
    spread = o.get("spread", 0.42)
    val = np.zeros((S, S), np.float32)
    alpha = np.zeros((S, S), np.float32)
    group = o.get("sprig", 1)  # löv per kvist: > 1 ger små kvistar med löv växelvis längs en axel
    leaves, stems = [], []
    for _ in range(max(1, n // group)):
        rel = r.uniform() ** o.get("outer_bias", 0.4)  # < 0.5: fler löv ute i kanten än i mitten
        ang = r.uniform(0, 2 * np.pi)
        # Solfjäder: ju längre ut, desto mer pekar lövet utåt (men aldrig exakt); i mitten åt vilket håll som helst
        out = ang + r.normal(0, 1.4 - 1.1 * rel) if rel > 0.15 else r.uniform(0, 2 * np.pi)
        sx, sy = S / 2 + np.cos(ang) * rel * spread * S, S / 2 + np.sin(ang) * rel * spread * S
        Ls = [r.uniform(lo, hi) * S for _ in range(group)]
        step = np.mean(Ls) * 0.45
        for g in range(group):
            L = Ls[g]
            # Längs kvisten, bakåt från spetsen; löven vinklas ut åt varannan sida (spetslövet rakt fram)
            t = (g - (group - 1) / 2) * step
            a = out if g == group - 1 else out + (1 if g % 2 else -1) * r.uniform(0.5, 0.9)
            bx, by = sx + np.cos(out) * t, sy + np.sin(out) * t
            cx, cy = bx + np.cos(a) * L / 2, by + np.sin(a) * L / 2
            # Håll spetsen inne i cellen
            tip = np.array([cx + np.cos(a) * L * 0.5, cy + np.sin(a) * L * 0.5])
            over = np.linalg.norm(tip - S / 2) - 0.48 * S
            if over > 0:
                cx -= np.cos(ang) * over; cy -= np.sin(ang) * over
            leaves.append((np.hypot(cx - S / 2, cy - S / 2), L, cx, cy, a))
        if group > 1:  # kvisten: från första till sista lövets fäste
            t0, t1 = -(group - 1) / 2 * step, (group - 1) / 2 * step
            stems.append((sx + np.cos(out) * t0, sy + np.sin(out) * t0, sx + np.cos(out) * t1, sy + np.sin(out) * t1))
    stem_mask = np.zeros((S, S), np.float32)
    sw = o.get("stem", 0.004) * S
    for x0f, y0f, x1f, y1f in stems if sw > 0 else []:
        x0, x1 = int(max(0, min(x0f, x1f) - sw - 2)), int(min(S, max(x0f, x1f) + sw + 3))
        y0, y1 = int(max(0, min(y0f, y1f) - sw - 2)), int(min(S, max(y0f, y1f) + sw + 3))
        if x1 <= x0 or y1 <= y0:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32) + 0.5
        ex, ey = x1f - x0f, y1f - y0f
        t = (((xs - x0f) * ex + (ys - y0f) * ey) / max(ex * ex + ey * ey, 1e-6)).clip(0, 1)
        cov = (0.5 - (np.hypot(xs - x0f - t * ex, ys - y0f - t * ey) - sw / 2) / SS).clip(0, 1)
        win = (slice(y0, y1), slice(x0, x1))
        val[win] = val[win] * (1 - cov) + (1.0 if o["mode"] == "white" else 0.42) * cov
        alpha[win] = np.maximum(alpha[win], cov)
        stem_mask[win] = np.maximum(stem_mask[win], cov)
    # Ytterst först (under), mitten sist (överst): klasen buktar mot betraktaren
    leaves.sort(key=lambda t: -t[0])
    for k, (rad, L, cx, cy, a) in enumerate(leaves):
        dx, dy = np.cos(a), np.sin(a)
        bx, by = cx - dx * L / 2, cy - dy * L / 2  # fästet
        # Rita bara inom lövets egen ruta (snabbt även med hundratals löv)
        x0, x1 = int(max(0, cx - L / 2 - 2)), int(min(S, cx + L / 2 + 3))
        y0, y1 = int(max(0, cy - L / 2 - 2)), int(min(S, cy + L / 2 + 3))
        if x1 <= x0 or y1 <= y0:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32) + 0.5
        px, py = xs - bx, ys - by
        u = (px * dx + py * dy) / L
        v = (-px * dy + py * dx) / L
        d = leaf_d(shape, u, v, aspect) * L  # ungefärligt avstånd i px, < 0 inne i lövet
        cov = (0.5 - d / SS).clip(0, 1)
        if not cov.any():
            continue
        if o["mode"] == "white":
            shade = np.ones_like(u)
        else:
            depth = 0.72 + 0.28 * (k + 1) / len(leaves)  # löv under andra är mörkare
            base = r.uniform(0.78, 1.0) * depth
            shade = base * (0.78 + 0.22 * u.clip(0, 1))  # mörkare vid fästet
            shade = shade * np.where(v < 0, 0.9, 1.0)  # mittveck: ena halvan i skugga
            if L > 60 * SS:  # nerven syns bara på stora löv
                rib = (np.abs(v) < 0.018) & (u > 0.04) & (u < 0.85)
                shade = shade * np.where(rib, 0.82, 1.0)
            shade = shade * (0.86 + 0.14 * (1 - ys / S))  # ljus uppifrån
        win = (slice(y0, y1), slice(x0, x1))
        val[win] = val[win] * (1 - cov) + shade * cov
        alpha[win] = np.maximum(alpha[win], cov)
        stem_mask[win] *= 1 - cov
    return val, alpha, stem_mask


def main():
    o = json.loads(sys.argv[1])
    name = o["name"]
    o.setdefault("mode", "painted")
    size = o.get("size", 1024)
    half = size // 2
    S = half * SS
    r = np.random.default_rng(o.get("seed", 1))
    work = ROOT / "build" / "leafsheet" / name
    work.mkdir(parents=True, exist_ok=True)
    pal = json.loads((ROOT / "tools" / "style.json").read_text())["palette"]
    ramp = [hex_lin(pal[k]) for k in ("foliage_shadow", "foliage_mid", "foliage_light")]
    atlas = np.zeros((size, size, 4), np.float32)
    for i in range(4):
        val, alpha, stem = cell(r, o.get("leaves", 34), S, o)
        if o["mode"] == "color":
            t = ((val - 0.55) / 0.45).clip(0, 1)
            rgb = np.where((t < 0.5)[..., None], ramp[0] + (ramp[1] - ramp[0]) * (t * 2)[..., None],
                           ramp[1] + (ramp[2] - ramp[1]) * (t * 2 - 1).clip(0)[..., None])
            rgb = rgb * (1 - stem[..., None]) + hex_lin(pal["bark"]) * stem[..., None]
        else:
            rgb = np.repeat(val[..., None], 3, -1)
        im = Image.fromarray((np.dstack([rgb, alpha]) * 255).astype(np.uint8), "RGBA").resize((half, half), Image.LANCZOS)
        im.save(work / f"cell{i}.png")
        atlas[(i // 2) * half:(i // 2 + 1) * half, (i % 2) * half:(i % 2 + 1) * half] = np.asarray(im, np.float32) / 255
    out = Image.fromarray((atlas * 255).astype(np.uint8), "RGBA")
    a = out.getchannel("A")
    if o.get("alpha_blur"):
        a = a.filter(ImageFilter.GaussianBlur(o["alpha_blur"]))
    # Fyll genomskinliga pixlar med närliggande lövfärg, så att mipmaps inte får mörka kanter
    filled = Image.composite(out.convert("RGB"), out.convert("RGB").filter(ImageFilter.MaxFilter(9)), a)
    filled.putalpha(a)
    dst = ROOT / "assets" / "textures" / f"{name}.png"
    filled.save(dst)
    cover = float((np.asarray(a) > 115).mean())
    print(json.dumps({"atlas": str(dst.relative_to(ROOT)), "mode": o["mode"], "shape": o.get("shape", "oval"),
                      "alpha_coverage": round(cover, 3), "size": [size, size]}))


if __name__ == "__main__":
    main()
