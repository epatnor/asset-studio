"""Jämförelseark för ett byggt huvud: bilderna, det nya huvudet med och utan polygoner, och ett annat huvud.

  .venv/bin/python tools/head_sheet.py <huvud.glb> <jämförelse.glb> <ut.png>

Allt ritas i lera med samma kameror, utan perspektiv. Polygonerna hämtas ur build/head/<huvud>.json."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
SIZE = 330
CENTER = [0.0, 1.53, 0.0]
SPAN = 0.46
# Valfritt: en närmare kamera på ansiktet.
if len(sys.argv) > 4:
    CENTER = [0.0, float(sys.argv[4]), 0.0]
    SPAN = float(sys.argv[5])
VIEWS = {"front": (0, 0, 1), "three_quarter": (-0.7, 0.05, 0.7), "side": (1, 0, 0)}
REFERENCES = {"front": "front.png", "side": "left.png"}

head, other, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
folder = HERE / "build/head/shots"
folder.mkdir(parents=True, exist_ok=True)
views = [{"name": name, "dir": list(direction), "center": CENTER, "span": SPAN} for name, direction in VIEWS.items()]
args = {"glbs": {"new": str(head), "other": str(other)}, "folder": str(folder), "size": SIZE, "views": views}
pre = ["host-spawn"] if shutil.which("host-spawn") else []
run = subprocess.run(pre + ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender", "--background", "--python-exit-code", "1",
                            "--python", str(TOOLS / "blender/render_closeups.py"), "--", json.dumps(args)], capture_output=True, text=True, errors="replace")
if run.returncode:
    sys.exit(run.stdout[-800:] + run.stderr[-800:])

data = json.loads((HERE / f"build/head/{head.stem}.json").read_text())
points = np.array(data["positions"]).reshape(-1, 3)
polygons = data["polygons"]


def with_wire(image, direction):
    d = np.array(direction, float)
    d /= np.linalg.norm(d)
    right = np.cross(-d, [0, 1.0, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, -d)
    relative = points - np.array(CENTER)
    u = relative @ right / SPAN * SIZE + SIZE / 2
    v = -(relative @ up) / SPAN * SIZE + SIZE / 2
    wire = image.copy()
    draw = ImageDraw.Draw(wire)
    for polygon in polygons:
        a, b, c = (points[polygon[k]] for k in range(3))
        if np.dot(np.cross(b - a, c - a), d) <= 0:
            continue
        draw.polygon([(u[p], v[p]) for p in polygon], outline=(20, 20, 25))
    return wire


rows = []
marks = data["marks"]
pictures = []
reference_folder = SPEL / "lowpoly-test/references/yvonne/closeup_head"
for name in ("front", "three_quarter", "side"):
    source = "right_front.png" if name == "three_quarter" else REFERENCES[name]
    path = reference_folder / source
    picture = Image.open(path).convert("RGB")
    # Bilderna ritas i samma skala som lerorna.
    scale = SIZE / (SPAN * 1440)
    picture = picture.resize((int(picture.width * scale), int(picture.height * scale)), Image.LANCZOS)
    top = int((marks["rows"][0] - 0) * scale - (1.702 - CENTER[1] - SPAN / 2 + SPAN) * 0)
    canvas = Image.new("RGB", (SIZE, SIZE), (196, 196, 198))
    row_top = (1.702 - (CENTER[1] + SPAN / 2)) * 1440
    canvas.paste(picture, ((SIZE - picture.width) // 2, int(-row_top * scale + (0 - marks["rows"][0]) * scale)))
    pictures.append(canvas)
new = [Image.open(folder / f"new_{name}.png").convert("RGB") for name in VIEWS]
wires = [with_wire(image, direction) for image, direction in zip(new, VIEWS.values())]
others = [Image.open(folder / f"other_{name}.png").convert("RGB") for name in VIEWS]
sheet = Image.new("RGB", (SIZE * 3, SIZE * 4 + 72), "white")
draw = ImageDraw.Draw(sheet)
for index, (title, row) in enumerate((("your image", pictures), ("new head", new), ("new head, polygons", wires), ("compare", others))):
    draw.text((6, index * (SIZE + 18) + 3), title, fill="black")
    for column, picture in enumerate(row):
        sheet.paste(picture, (column * SIZE, index * (SIZE + 18) + 18))
sheet.save(out)
print(json.dumps({"sheet": str(out), "size": sheet.size}))
