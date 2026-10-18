# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==11.1.0", "numpy==2.2.3"]
# ///
"""Målad hårtextur i stiliserad spelstil (gråskala som tintas, alfa i topparna):

  uv run --quiet --script tools/texture/paint_hair.py '{"name": "hair_painted", "seed": 3}'

Strukturen ligger på fasta höjder, så att hårgeneratorns UV (V = 0 vid roten, 1 vid toppen) placerar den rätt:
  rot (V 0–0,12)      mörkare, strån som växer fram;
  ljusband (runt hl)  ljusare strån tvärs över, brutet av strängarna (som en målad högdager);
  längden             mjuka drag i olika bredd och ton, mörka fåror mellan grupperna;
  toppar (V > tips)   spetsiga lockar i olika längd; varje kolumn har en sluthöjd, så alfan har inga lösa öar.
Upprepas i sidled (U), inte på höjden. Receptfält: name, seed, size, strokes, highlight (V för ljusbandet),
tips (V där topparna börjar), tip_clumps (antal spetsar), contrast. Skriver assets/textures/<name>.png (RGBA) och svarar med en rad JSON.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def main():
    r = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
    name = r.get("name", "hair_painted")
    size = int(r.get("size", 1024))
    rng = np.random.default_rng(int(r.get("seed", 3)))
    n = int(r.get("strokes", 70))
    hl = float(r.get("highlight", 0.3))
    tips = float(r.get("tips", 0.78))
    contrast = float(r.get("contrast", 1.0))

    W = H = size
    y = np.linspace(0, 1, H)[:, None]          # V nedåt: 0 = rot, 1 = topp
    x = np.arange(W)[None, :].astype(float)

    tone = np.zeros((H, W))                    # ljusare/mörkare drag
    cover = np.zeros((H, W))                   # hur mycket hår (för alfa i topparna)
    for _ in range(n):
        x0 = rng.uniform(0, W)
        w = rng.uniform(0.012, 0.045) * W      # dragets bredd
        amp, lam, ph = rng.uniform(0, 0.01) * W, rng.uniform(0.4, 1.2), rng.uniform(0, 2 * np.pi)
        end = rng.uniform(tips + 0.06, 1.0)     # draget slutar här (spetsen)
        val = rng.uniform(-1, 1)
        cx = x0 + amp * np.sin(2 * np.pi * y / lam + ph)
        d = np.abs(((x - cx) + W / 2) % W - W / 2)       # avstånd med omlindning i sidled
        # Smalnar av mot sin egen spets
        taper = np.clip((end - y) / max(1e-3, end - tips), 0, 1) ** 0.6
        prof = np.exp(-0.5 * (d / (w / 2 * np.maximum(taper, 0.05))) ** 2) * (y < end)
        tone += val * prof
        cover = np.maximum(cover, prof * np.where(y < tips, 1.0, taper))
    # Mörka fåror mellan grupperna
    for _ in range(n // 5):
        x0, w = rng.uniform(0, W), rng.uniform(0.003, 0.008) * W
        d = np.abs(((x - x0) + W / 2) % W - W / 2)
        tone -= 1.4 * np.exp(-0.5 * (d / w) ** 2) * (y < rng.uniform(0.6, 0.95))
    tone /= np.abs(tone).max() + 1e-6

    # Värde längs höjden: mörk rot, bas, ljusband, lite mörkare längre ned, ljusare toppar
    base = 0.72 - 0.26 * np.clip(1 - y / 0.12, 0, 1) - 0.05 * np.clip((y - 0.5) / 0.3, 0, 1) + 0.05 * np.clip((y - tips) / (1 - tips), 0, 1)
    band = np.exp(-0.5 * ((y - hl) / 0.055) ** 2)
    light = np.clip(tone, 0, 1)
    val = base + contrast * 0.14 * tone + band * (0.12 + 0.22 * light)
    val = np.clip(val, 0.25, 1.0)
    # Alfa: varje kolumn får EN sluthöjd (inga lösa öar): spetsiga lockar i olika längd, mjuk kant
    xs = np.arange(W).astype(float)
    end = np.full(W, tips + 0.03)
    for _ in range(int(r.get("tip_clumps", 22))):
        cx, w = rng.uniform(0, W), rng.uniform(0.03, 0.08) * W
        reach = rng.uniform(0.35, 1.0) * (1 - tips - 0.03)
        d = np.abs(((xs - cx) + W / 2) % W - W / 2)
        end = np.maximum(end, tips + 0.03 + reach * np.clip(1 - d / w, 0, 1) ** 1.6)
    alpha = np.clip((end[None, :] - y) * H / 3.0, 0, 1)
    # Mjuka upp lite i sidled (penseldrag, inga pixelkanter)
    k = 2
    val = sum(np.roll(val, s, axis=1) for s in range(-k, k + 1)) / (2 * k + 1)

    rgba = np.dstack([val, val, val, alpha])
    out = ROOT / "assets" / "textures" / f"{name}.png"
    Image.fromarray((rgba * 255).astype(np.uint8), "RGBA").save(out)
    print(json.dumps({"out": str(out.relative_to(ROOT)), "size": size, "mean": round(float(val[y[:, 0] < tips].mean()), 3),
                      "alpha_tips": round(float(alpha[y[:, 0] >= tips].mean()), 3)}))


if __name__ == "__main__":
    main()
