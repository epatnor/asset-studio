"""Närbilder av robotens underkropp i böjda poser, för domaren. Körs efter make_robot.py.
  ../lowpoly-test/.venv/bin/python tools/robot_closeups.py <ut.png>"""
import json, shutil, subprocess, sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
SIZE = 460
POSES = ["squat", "step"]
ANGLES = {"front": (0, 0, 1), "side": (1, 0, 0.15), "back": (-0.5, 0, -0.85)}

out = Path(sys.argv[1]).resolve()
folder = HERE / "build/robot/lower"
folder.mkdir(parents=True, exist_ok=True)
rows = []
for pose in POSES:
    V = np.asarray(trimesh.load(HERE / f"build/robot/{pose}.glb", force="scene").to_geometry().vertices)
    y0 = V[:, 1].min()
    lower = V[V[:, 1] < y0 + 0.95]
    center = [float((lower[:, 0].min() + lower[:, 0].max()) / 2), float(y0 + 0.55), float((lower[:, 2].min() + lower[:, 2].max()) / 2)]
    views = [{"name": name, "dir": list(direction), "center": center, "span": 1.15} for name, direction in ANGLES.items()]
    args = {"glbs": {pose: str(HERE / f"build/robot/{pose}.glb")}, "folder": str(folder), "size": SIZE, "views": views}
    pre = ["host-spawn"] if shutil.which("host-spawn") else []
    run = subprocess.run(pre + ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender", "--background", "--python-exit-code", "1",
                                "--python", str(TOOLS / "blender/render_closeups.py"), "--", json.dumps(args)], capture_output=True, text=True, errors="replace")
    if run.returncode:
        sys.exit(run.stdout[-600:] + run.stderr[-600:])
    rows.append(pose)
sheet = Image.new("RGB", (SIZE * len(ANGLES), SIZE * len(POSES)), "white")
draw = ImageDraw.Draw(sheet)
for r, pose in enumerate(rows):
    for c, name in enumerate(ANGLES):
        sheet.paste(Image.open(folder / f"{pose}_{name}.png").convert("RGB"), (c * SIZE, r * SIZE))
        draw.text((c * SIZE + 6, r * SIZE + 4), f"{pose} {name}", fill="white")
sheet.save(out)
print(json.dumps({"sheet": str(out), "size": sheet.size}))
