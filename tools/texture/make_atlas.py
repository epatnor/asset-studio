"""Bygg en 2x2-lövatlas: fyra Krea-2-sprites (olika seeds) -> cutout -> atlas.

  python3 -I tools/texture/make_atlas.py <namn> "<materialbeskrivning>" [startseed]

Resultat: assets/textures/<namn>.png, celler i build/atlas/<namn>/. Svarar med en rad JSON.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
name, desc = sys.argv[1], sys.argv[2]
seed0 = int(sys.argv[3]) if len(sys.argv) > 3 else 1000

style = json.loads((ROOT / "tools" / "style.json").read_text())["prompt"]
prompt = ", ".join([
    desc,
    "centered, filling most of the square frame, the stem or attachment point at the bottom center",
    style["house_style"],
    style["kinds"]["cutout"],
])
work = ROOT / "build" / "atlas" / name
work.mkdir(parents=True, exist_ok=True)
UV = ["uv", "run", "--quiet", "--no-project", "--python", "3.12", "--with", "pillow==11.1.0", "--with", "numpy==2.2.3",
      "python", "-I", str(ROOT / "tools" / "texture" / "post_textures.py")]

cells = []
for i in range(4):
    raw, cut = work / f"cell{i}_raw.png", work / f"cell{i}.png"
    # Samma prompt och seed ger samma bild, så återanvänd en befintlig råbild (prompten sparas bredvid)
    meta = work / f"cell{i}_raw.json"
    cached = raw.exists() and meta.exists() and json.loads(meta.read_text()) == {"prompt": prompt, "seed": seed0 + i}
    if not cached:
        subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "texture" / "krea2.py"), prompt, "1024", "1024", str(raw), str(seed0 + i)],
                       check=True, capture_output=True)
        meta.write_text(json.dumps({"prompt": prompt, "seed": seed0 + i}))
    subprocess.run(UV + ["cutout", str(raw), str(cut)], check=True, capture_output=True)
    cells.append(str(cut))

out = ROOT / "assets" / "textures" / f"{name}.png"
subprocess.run(UV + ["atlas", str(out), *cells], check=True, capture_output=True)
print(json.dumps({"atlas": str(out.relative_to(ROOT)), "cells": [str(Path(c).relative_to(ROOT)) for c in cells], "seeds": [seed0 + i for i in range(4)]}))
