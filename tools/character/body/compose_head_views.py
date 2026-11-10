"""Sätter ihop närbilder av ett huvud till kvadratiska vyer för Pixal3D: samma skala, samma ögonlinje, svart bakgrund.

  python3 -I tools/compose_head_views.py '{"out": "build/nora_head", "views": [{"name": "front", "img": ..., "eye_y": 590, "axis_x": 495, "scale": 1.0}], "cut": 600, "span": 1345, "center": 135}'

Delar under halsen (cut, i framvyns pixlar under ögonlinjen) tas bort utom håret, så att bilderna inte visar olika mycket axlar.
Skriver <name>.png (RGB på svart) och en rad JSON."""
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

r = json.loads(sys.argv[1])
out = Path(r["out"])
out.mkdir(parents=True, exist_ok=True)
SIZE = 1024
F = SIZE / 1.1 / r.get("span", 1345)
res = []
for v in r["views"]:
    img = np.asarray(Image.open(v["img"]).convert("RGB")).astype(np.float32) / 255
    edge = np.concatenate([img[:12].reshape(-1, 3), img[:, :12].reshape(-1, 3), img[:, -12:].reshape(-1, 3)])
    bg = np.median(edge, 0)
    lab, _ = ndimage.label(np.abs(img - bg).sum(2) < r.get("bg_tol", 0.13))
    keep = np.unique(np.concatenate([lab[0], lab[:, 0], lab[:, -1], lab[-1]]))
    mask = ~np.isin(lab, keep[keep > 0])
    s = v.get("scale", 1.0)
    # Under snittet: bara håret får vara kvar.
    R, G, B = img[..., 0], img[..., 1], img[..., 2]
    hair = (R + G + B < 1.15) & (R > G) & (G > B) & (R - B > 0.1)
    yy = np.arange(img.shape[0])[:, None]
    below = (yy - v["eye_y"]) * s > r.get("cut", 600)
    m = mask & (~below | hair)
    m = ndimage.binary_opening(m, iterations=2)
    lab2, n = ndimage.label(m)
    if n > 1:
        m = lab2 == 1 + np.argmax(ndimage.sum(m, lab2, range(1, n + 1)))
    m = ndimage.binary_erosion(m, iterations=2)
    rgba = np.dstack([img * m[..., None], m.astype(np.float32)])
    # Avbildning: utpixel -> bildpixel. Utbildens mitt är ögonlinjen plus center (i framvyns pixlar).
    k = F * s
    M = np.array([[k, 0, SIZE / 2 - k * v["axis_x"]], [0, k, SIZE / 2 - k * v["eye_y"] - F * r.get("center", 135)]])
    pil = Image.fromarray((rgba.clip(0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")
    inv = np.linalg.inv(np.vstack([M, [0, 0, 1]]))[:2].ravel().tolist()
    im = pil.transform((SIZE, SIZE), Image.AFFINE, inv, Image.BICUBIC)
    alpha = np.asarray(im)[..., 3] > 127
    ys, xs = np.where(alpha)
    Image.fromarray(np.asarray(im)[..., :3]).save(out / f"{v['name']}.png")
    res.append({"name": v["name"], "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())], "cover": round(float(alpha.mean()), 3)})
print(json.dumps({"size": SIZE, "px_per_front_px": round(F, 3), "views": res}))
