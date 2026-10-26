"""Appikon ur en bild: beskär, lägg en iOS-liknande "squircle" (superellips) med genomskinliga hörn, spara i flera storlekar.

  uv run --no-project --python 3.12 --with pillow==11.1.0 --with numpy==2.2.3 python -I tools/texture/make_icon.py '<recept>'
  recept: {"src": "patriks_input/bild.png", "out": "studio/img/icon", "crop": [cx, cy, size] (andelar av bilden),
           "sizes": [1024, 512, 192, 180, 64, 32], "n": 5, "inset": 0}

Formen är en superellips |x|^n + |y|^n = 1 (n = 5 ligger nära iOS hörn, som är mjukare än en rundad rektangel).
Masken ritas i fyra gånger storleken och skalas ned, så att kanten blir mjuk. inset lämnar en genomskinlig marginal
(andel), som macOS-ikoner har. Svarar med en rad JSON: {"files": [...], "crop_px": [...]}.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def squircle_mask(size, n, inset):
    s = size * 4
    c = (s - 1) / 2
    r = c * (1 - inset)
    y, x = np.mgrid[0:s, 0:s]
    inside = (np.abs((x - c) / r) ** n + np.abs((y - c) / r) ** n) <= 1.0
    m = Image.fromarray((inside * 255).astype(np.uint8), "L")
    return m.resize((size, size), Image.LANCZOS)


def main():
    r = json.loads(sys.argv[1])
    src = (ROOT / r["src"]).resolve()
    out = (ROOT / r.get("out", "studio/img/icon")).resolve()
    if ROOT not in src.parents or ROOT not in out.parents:
        sys.exit(json.dumps({"error": "src and out must be under the project root"}))
    im = Image.open(src).convert("RGB")
    w, h = im.size
    cx, cy, cs = r.get("crop", [0.5, 0.5, 1.0])
    side = round(min(w, h) * cs)
    x0 = min(max(0, round(cx * w - side / 2)), w - side)
    y0 = min(max(0, round(cy * h - side / 2)), h - side)
    sq = im.crop((x0, y0, x0 + side, y0 + side))
    out.mkdir(parents=True, exist_ok=True)
    n, inset = r.get("n", 5), r.get("inset", 0)
    files = []
    for size in r.get("sizes", [1024, 512, 192, 180, 64, 32]):
        img = sq.resize((size, size), Image.LANCZOS).convert("RGBA")
        img.putalpha(squircle_mask(size, n, inset))
        f = out / f"icon-{size}.png"
        img.save(f, optimize=True)
        files.append(str(f.relative_to(ROOT)))
    print(json.dumps({"files": files, "crop_px": [x0, y0, side]}))


if __name__ == "__main__":
    main()
