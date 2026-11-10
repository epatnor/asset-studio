"""Picks the reference image with the most natural head size for the 3D model (a runner script step).

Krea-2 often draws heads too big for an adult (Cassandra 2026-11-10: 6.96 heads tall, Pixal3D then made the skull
about 20 cm wide). This measures every reference image in code, on the figure's silhouette against the flat
background: the head runs from the top of the figure to the narrowest point of the neck, and "heads tall" is the
figure's height divided by the head's height. An adult is about 7.5; the image closest to target wins.

  python3 -I pick_reference.py '{"images": ["a.png", "b.png"], "out_dir": "...", "name": "asset", "min_heads": 7.3}'

Writes <name>_front_pick.png (a copy of the winner) and answers with one line of JSON: files, picked, per image
heads tall and head width / height. Fails when no image reaches min_heads, so the order does not build a model
from a big-headed reference.
"""
import json
import re
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def silhouette(path):
    """Mask of the figure: pixels that differ from the background colour (median of the four corners)."""
    a = np.asarray(Image.open(path).convert("RGB")).astype(float)
    c = 8
    corners = np.concatenate([a[:c, :c], a[:c, -c:], a[-c:, :c], a[-c:, -c:]]).reshape(-1, 3)
    return np.abs(a - np.median(corners, axis=0)).sum(2) > 40


def measure(path):
    m = silhouette(path)
    rows = np.where(m.any(1))[0]
    if len(rows) < 50:
        return None
    top, bot = rows[0], rows[-1]
    height = bot - top
    width = np.array([np.ptp(np.where(r)[0]) if r.any() else 0 for r in m[top:bot + 1]])
    # A few rows can drop out of the silhouette where the colour is close to the background (the bearded man's chest,
    # 2026-11-10: two rows 17 px wide). Only rows far narrower than the median of their 11 neighbours are filled (with
    # that median), so the real neck, dozens of rows long, keeps its exact rows.
    k = 5
    padded = np.pad(width, k, mode="edge")
    med = np.median(np.stack([padded[i:i + len(width)] for i in range(2 * k + 1)]), axis=0)
    width = np.where(width < 0.5 * med, med, width)
    # The neck: the narrowest row between 1/20 and 1/4 of the figure height from the top
    lo, hi = max(2, height // 20), height // 4
    neck = lo + int(np.argmin(width[lo:hi]))
    head_w = width[:neck].max()
    return {"heads_tall": round(height / neck, 2), "head_width": round(head_w / height, 3)}


def main():
    r = json.loads(sys.argv[1])
    target, min_heads = float(r.get("target_heads", 7.6)), float(r.get("min_heads", 7.3))
    found = []
    for p in r["images"]:
        m = measure(p)
        found.append({"image": Path(p).name, **(m or {"error": "no figure found"})})
    ok = [f for f in found if f.get("heads_tall")]
    if not ok:
        raise SystemExit("no figure found in any reference image")
    best = min(ok, key=lambda f: abs(f["heads_tall"] - target))
    short = lambda n: (re.search(r"_(s\d+)_", n) or re.search(r"(.{1,12})\.\w+$", n)).group(1)   # seed tag, e.g. s22
    summary = ", ".join(f"{short(f['image'])} {f.get('heads_tall', '?')}" for f in found)
    if best["heads_tall"] < min_heads:
        raise SystemExit(f"every reference has a big head (heads tall {summary}; need at least {min_heads})")
    out = Path(r["out_dir"]) / f"{r.get('name') or 'figure'}_front_pick.png"
    shutil.copyfile(next(p for p in r["images"] if Path(p).name == best["image"]), out)
    print(json.dumps({"ok": True, "files": [out.name], "picked": best["image"], "images": found,
                      "note": f"picked {short(best['image'])} · {best['heads_tall']} heads tall ({summary})"}))


if __name__ == "__main__":
    main()
