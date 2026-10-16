"""Mät vit halo i sprites/atlaser utan att titta på bilden.

  uv run ... python -I check_alpha.py <bild.png> [alphaTest=0.45]

För pixlarna som syns med alphaTest och ligger i kanten (granne till en osynlig pixel)
jämförs ljushet och mättnad med det inre. Vit halo = kanten mycket ljusare och blekare.
"""
import json
import sys

import numpy as np
from PIL import Image

img = np.asarray(Image.open(sys.argv[1]).convert("RGBA")).astype(np.float32) / 255
cut = float(sys.argv[2]) if len(sys.argv) > 2 else 0.45
rgb, a = img[..., :3], img[..., 3]
vis = a >= cut
hidden = ~vis
nb = np.zeros_like(vis)
for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
    nb |= np.roll(hidden, (dy, dx), axis=(0, 1))
edge = vis & nb
inner = vis & ~nb
lum = rgb.mean(axis=2)
sat = rgb.max(axis=2) - rgb.min(axis=2)
res = {
    "visible_frac": round(float(vis.mean()), 3),
    "edge_lum": round(float(lum[edge].mean()), 3), "inner_lum": round(float(lum[inner].mean()), 3),
    "edge_sat": round(float(sat[edge].mean()), 3), "inner_sat": round(float(sat[inner].mean()), 3),
    "edge_near_white_frac": round(float(((lum > 0.8) & (sat < 0.15))[edge].mean()), 3),
}
res["halo"] = res["edge_near_white_frac"] > 0.05 or res["edge_lum"] > res["inner_lum"] + 0.15
print(json.dumps(res))
