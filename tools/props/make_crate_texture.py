"""Texturen till lådorna i propsgeneratorn (kind "crate"): en atlas med två rutor (2048 × 1024), vänster = ren plank­sida
(topp, botten, avfasningar, sidor utan stämpel), höger = sidan med stämpel (eller samma ren sida), och en normalkarta
ur plankornas ljushet (springorna mörka och nedsänkta). Plank­sidan görs med Krea-2 (tools/texture/krea2.py), stämpeln
här: målad, lite sliten, med träets ådring igenom.

  uv run -q --no-project --python 3.12 --with pillow --with numpy python -I tools/props/make_crate_texture.py '<recept>'

Recept: face (plank­sidans bild), out (texturnamn i assets/textures), stamp (null eller "red_cross"), color (stämpelns
färg, hex), normal (namn på normalkartan, skrivs om den anges), strength (normalkartans styrka), seed.
Svarar med en rad JSON.
"""
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
TEX = ROOT / "assets" / "textures"
N = 1024


def noise(seed, scale):
    r = np.random.default_rng(seed)
    a = Image.fromarray((r.random((N // scale, N // scale)) * 255).astype(np.uint8)).resize((N, N), Image.BICUBIC)
    return np.asarray(a.filter(ImageFilter.GaussianBlur(scale / 3)), np.float32) / 255


def cross_mask(seed):
    """Ett rött kors i mitten, med lite ojämna kanter och några slitna fläckar."""
    y, x = np.mgrid[0:N, 0:N].astype(np.float32) / N - 0.5
    arm, size = 0.085, 0.27
    m = ((np.abs(x) < arm) & (np.abs(y) < size)) | ((np.abs(y) < arm) & (np.abs(x) < size))
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.5)), np.float32) / 255
    edge = noise(seed, 16) - 0.5                                   # ojämn penselkant
    m = np.clip((m - 0.5 + edge * 0.35) * 6 + 0.5, 0, 1)
    worn = noise(seed + 1, 32)                                     # slitna fläckar där träet syns
    return m * np.clip((worn - 0.28) * 4, 0.25, 1) * 0.92


def main():
    r = json.loads(sys.argv[1])
    face = Image.open(ROOT / r["face"]).convert("RGB").resize((N, N), Image.LANCZOS)
    f = np.asarray(face, np.float32) / 255
    right = f.copy()
    if r.get("stamp") == "red_cross":
        col = np.array([int(r.get("color", "#b3302a")[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)
        a = cross_mask(r.get("seed", 1))[..., None]
        lum = f.mean(axis=2, keepdims=True)
        paint = np.clip(col * (0.55 + 0.9 * lum), 0, 1)          # färgen tar upp träets ljushet: ådringen syns igenom
        right = f * (1 - a) + paint * a
    atlas = np.concatenate([f, right], axis=1)
    out = TEX / f"{r['out']}.png"
    Image.fromarray((np.clip(atlas, 0, 1) * 255).astype(np.uint8)).save(out, optimize=True)
    res = {"ok": True, "texture": str(out.relative_to(ROOT)), "size": [2 * N, N], "stamp": r.get("stamp")}
    if r.get("normal"):
        h = np.asarray(face.convert("L").filter(ImageFilter.GaussianBlur(1.5)), np.float32) / 255
        s = r.get("strength", 3.0)
        dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * s
        dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * s
        n = np.stack([-dx, dy, np.ones_like(h)], axis=2)
        n /= np.linalg.norm(n, axis=2, keepdims=True)
        nm = np.concatenate([n, n], axis=1) * 0.5 + 0.5
        nout = TEX / f"{r['normal']}.png"
        Image.fromarray((nm * 255).astype(np.uint8)).save(nout, optimize=True)
        res["normal"] = str(nout.relative_to(ROOT))
    print(json.dumps(res))


if __name__ == "__main__":
    main()
