"""Efterbehandling av genererade texturer.

  tile   <in.png> <out.png>   gör en textur sömlös (för bark, mark, sten ...)
  cutout <in.png> <out.png>   ger en sprite på vit bakgrund alfakanal och beskär
                              så att foten/stjälken hamnar i nederkant (UV v=0)

Kör med: uv run --no-project --python 3.12 --with pillow==11.1.0 --with numpy==2.2.3 python -I post_textures.py ...
"""
import json
import sys

import numpy as np
from PIL import Image


def tile(src, dst):
    # Blanda med en halvt förskjuten kopia så att kanterna möts vid upprepning
    a = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    h, w, _ = a.shape
    s = np.roll(a, (h // 2, w // 2), axis=(0, 1))
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum.reduce([xx, w - 1 - xx, yy, h - 1 - yy]) / (min(h, w) / 2)
    wgt = np.clip(edge * 2.5, 0, 1)[..., None] ** 1.5
    Image.fromarray((a * wgt + s * (1 - wgt)).astype(np.uint8)).save(dst)
    return {"out": dst, "size": [w, h]}


def cutout(src, dst, size=512):
    # Alfa från avstånd till vit bakgrund
    img = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    alpha = np.clip((np.linalg.norm(255 - img, axis=2) - 18) / 40, 0, 1)
    ys, xs = np.nonzero(alpha > 0.5)
    cx = (xs.min() + xs.max()) // 2
    side = int(max(xs.max() - xs.min(), ys.max() - ys.min()) * 1.04)
    x0 = max(cx - side // 2, 0)
    y0 = max(ys.max() + 2 - side, 0)
    rgba = np.dstack([img, alpha * 255]).astype(np.uint8)[y0:y0 + side, x0:x0 + side]
    Image.fromarray(rgba, "RGBA").resize((size, size), Image.LANCZOS).save(dst)
    return {"out": dst, "size": [size, size]}


if __name__ == "__main__":
    cmd, src, dst = sys.argv[1:4]
    print(json.dumps({"tile": tile, "cutout": cutout}[cmd](src, dst)))
