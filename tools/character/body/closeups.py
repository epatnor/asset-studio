"""Ett ark per problemområde: AI-kroppen till vänster och den glesa nivån till höger, med samma kameror, för domaren.
  ../lowpoly-test/.venv/bin/python tools/closeups.py <namn> <ut_mapp>
Skriver <ut_mapp>/<område>.png och en rad JSON."""
import json, shutil, subprocess, sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
SIZE = 340

name, out = sys.argv[1], (HERE / sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
low = HERE / f"build/closeup_raw/{name}_low.glb"
low.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, str(TOOLS / "export.py"), name, "s", str(low)], cwd=HERE, check=True, capture_output=True)
V = np.asarray(trimesh.load(low, force="scene").to_geometry().vertices)
H = V[:, 1].max() - V[:, 1].min()
y0 = V[:, 1].min()
shoulder_x = 0.1 * H
# Kropp i andelar av längden: ansiktet högt upp, axeln vid 0,82, bröstet vid 0,72, överarmen utanför axeln, grenen vid 0,47.
VIEWS = {
    "face": [("front", (0, 0, 1), (0, y0 + 0.89 * H, 0.03), 0.18 * H), ("three_quarter", (0.7, 0, 0.7), (0, y0 + 0.89 * H, 0.03), 0.18 * H)],
    "shoulders": [("front", (0, 0, 1), (shoulder_x, y0 + 0.81 * H, 0), 0.22 * H), ("back_side", (0.8, 0.3, -0.5), (shoulder_x, y0 + 0.81 * H, 0), 0.22 * H)],
    "chest": [("front", (0, 0, 1), (0, y0 + 0.72 * H, 0.04), 0.26 * H), ("three_quarter", (0.7, 0, 0.7), (0, y0 + 0.72 * H, 0.04), 0.26 * H)],
    "upperarm": [("front", (0, 0, 1), (0.17 * H, y0 + 0.72 * H, 0), 0.26 * H), ("side", (1, 0, 0), (0.17 * H, y0 + 0.72 * H, 0), 0.26 * H)],
    "crotch": [("front", (0, 0, 1), (0, y0 + 0.47 * H, 0), 0.22 * H), ("below", (0, -0.75, 0.66), (0, y0 + 0.47 * H, 0), 0.22 * H)],
}
views = [{"name": f"{region}_{tag}", "dir": direction, "center": center, "span": span} for region, entries in VIEWS.items() for tag, direction, center, span in entries]
folder = HERE / "build/closeup_raw"
folder.mkdir(parents=True, exist_ok=True)
args = {"glbs": {"dense": str(HERE / f"build/fit/{name}_ai.glb"), "low": str(low)}, "folder": str(folder), "size": SIZE, "views": views}
pre = ["host-spawn"] if shutil.which("host-spawn") else []
run = subprocess.run(pre + ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender", "--background", "--python-exit-code", "1",
                            "--python", str(TOOLS / "blender/render_closeups.py"), "--", json.dumps(args)], capture_output=True, text=True, errors="replace")
if run.returncode:
    sys.exit(run.stdout[-800:] + run.stderr[-800:])
sheets = []
for region, entries in VIEWS.items():
    sheet = Image.new("RGB", (SIZE * 2, SIZE * len(entries) + 16), "white")
    draw = ImageDraw.Draw(sheet)
    draw.text((4, 2), "target (dense AI)", fill="black")
    draw.text((SIZE + 4, 2), "low poly (level s)", fill="black")
    for row, (tag, *_rest) in enumerate(entries):
        for col, kind in enumerate(("dense", "low")):
            sheet.paste(Image.open(folder / f"{kind}_{region}_{tag}.png").convert("RGB"), (col * SIZE, 16 + row * SIZE))
    sheet.save(out / f"{region}.png")
    sheets.append(str(out / f"{region}.png"))
print(json.dumps({"sheets": sheets}))
