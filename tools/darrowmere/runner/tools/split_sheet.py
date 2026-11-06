"""Delar ett målat vyark (rader × kolumner) i en bild per vy och skalar varje vy till målstorleken.
  python -I split_sheet.py '<json>'   {"image": <ark>, "out_dir": ..., "grid": [2, 2], "names": ["front", "left", "back", "right"], "size": [864, 1152]}
Skriver en rad JSON med filerna."""
import json, sys
from pathlib import Path
from PIL import Image
a = json.loads(sys.argv[1])
im = Image.open(a["image"]).convert("RGB")
rows, cols = a.get("grid", [2, 2])
w, h = im.width // cols, im.height // rows
out = Path(a["out_dir"]); out.mkdir(parents=True, exist_ok=True)
files = []
for i, name in enumerate(a["names"]):
    r, c = divmod(i, cols)
    tile = im.crop((c * w, r * h, (c + 1) * w, (r + 1) * h)).resize(tuple(a.get("size", [864, 1152])), Image.LANCZOS)
    p = out / f"view_{name}.png"; tile.save(p); files.append(p.name)
print(json.dumps({"ok": True, "files": files}))
