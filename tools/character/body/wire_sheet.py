"""Kontaktark: färgbilder i Blender med nätets kanter ritade ovanpå, för att se var polygonerna ligger.
  .venv/bin/python tools/wire_sheet.py <in.glb> <ut.png> [--axis z|x]
--axis: vart modellen är vänd i glTF (mallen +Z, Tripo +X)."""
import json, shutil, subprocess, sys, tempfile
from pathlib import Path

import cv2
import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
SIZE = (864, 1152)
SHARE = 0.92
THUMB_H = 560

a = sys.argv[1:]
glb, out = Path(a[0]).resolve(), Path(a[1]).resolve()
axis = a[a.index("--axis") + 1] if "--axis" in a else "z"
front = np.array([0, 0, 1.0]) if axis == "z" else np.array([1.0, 0, 0])
side = np.cross(np.array([0, 1.0, 0]), front)
VIEWS = {"front": front, "three_quarter": front + side, "side": side, "back": -front}

folder = HERE / "build" / "wire_sheet"
folder.mkdir(parents=True, exist_ok=True)
args = {"glb": str(glb), "folder": str(folder), "size": list(SIZE), "share": SHARE, "views": {k: v.tolist() for k, v in VIEWS.items()}}
pre = ["host-spawn"] if shutil.which("host-spawn") else []
run = subprocess.run(pre + ["flatpak", "run", f"--filesystem={ROOT}", f"--filesystem={glb.parent}", "org.blender.Blender", "--background", "--python-exit-code", "1",
                            "--python", str(TOOLS / "blender/render_views.py"), "--", json.dumps(args)], capture_output=True, text=True, errors="replace")
if run.returncode:
    sys.exit(run.stdout[-800:] + run.stderr[-800:])

mesh = trimesh.load(glb, force="scene").to_geometry()
V, F = np.asarray(mesh.vertices), np.asarray(mesh.faces)
normals = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
low, high = V.min(0), V.max(0)
center, height = (low + high) / 2, high[1] - low[1]
scale = SIZE[1] * SHARE / height
rows = []
for name, direction in VIEWS.items():
    d = direction / np.linalg.norm(direction)
    right = np.cross(-d, np.array([0, 1.0, 0]))
    right /= np.linalg.norm(right)
    u = (V - center) @ right * scale + SIZE[0] / 2
    v = -(V - center)[:, 1] * scale + SIZE[1] / 2
    image = cv2.imread(str(folder / f"{name}.png"))
    wire = image.copy()
    for tri in F[normals @ d > 0]:
        cv2.polylines(wire, [np.round(np.stack([u[tri], v[tri]], 1)).astype(np.int32)], True, (25, 20, 15), 1, cv2.LINE_AA)
    rows.append((image, wire))
width = THUMB_H * SIZE[0] // SIZE[1]
sheet = np.vstack([np.hstack([cv2.resize(pair[i], (width, THUMB_H), interpolation=cv2.INTER_AREA) for pair in rows]) for i in (1, 0)])
cv2.imwrite(str(out), sheet)
print(json.dumps({"sheet": str(out), "triangles": int(len(F)), "size": sheet.shape[1::-1]}))
