"""Blandningar mellan två passningar i samma topologi: formen och de bakade kartorna tonas med samma vikt.

  .venv/bin/python tools/blend.py <a> <b> <nivå> [vikter ...]      t.ex. male female 3 0 0.25 0.5 0.75 1

För varje vikt w: hörnen (1-w)*a + w*b (nivå 6, så att alla nivåer går att ta ut) och kartorna build/maps/<a>_L<nivå>_*.png
och <b>_L<nivå>_*.png tonade lika (normalkartan normeras om). Modellen sätts ihop i Blender utan bakning
(blender/bake_template.py med maps_in) till out/blend_<a>_<b>_<w>_L<nivå>.glb."""
import json, shutil, subprocess, sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
a, b, level = sys.argv[1], sys.argv[2], int(sys.argv[3])
weights = [float(w) for w in sys.argv[4:]] or [0, 0.25, 0.5, 0.75, 1]
fa, fb = np.load(HERE / f"build/fit/{a}.npz"), np.load(HERE / f"build/fit/{b}.npz")
ma = {k: np.asarray(Image.open(HERE / f"build/maps/{a}_L{level}_{k}.png").convert("RGB"), float) for k in ("basecolor", "normal")}
mb = {k: np.asarray(Image.open(HERE / f"build/maps/{b}_L{level}_{k}.png").convert("RGB"), float) for k in ("basecolor", "normal")}
pre = ["host-spawn"] if shutil.which("host-spawn") else []
outs = []
for w in weights:
    tag = f"blend_{a}_{b}_{int(round(w * 100)):03d}"
    np.savez(HERE / f"build/fit/{tag}.npz", X6=(1 - w) * fa["X6"] + w * fb["X6"])
    maps = {}
    for k in ("basecolor", "normal"):
        img = (1 - w) * ma[k] + w * mb[k]
        if k == "normal":
            n = img / 127.5 - 1
            n /= np.linalg.norm(n, axis=2, keepdims=True) + 1e-9
            img = (n + 1) * 127.5
        p = HERE / f"build/maps/{tag}_L{level}_{k}.png"
        Image.fromarray(img.clip(0, 255).astype(np.uint8)).save(p)
        maps[k] = str(p)
    low = HERE / f"build/export/{tag}_L{level}.glb"
    subprocess.run([sys.executable, str(TOOLS / "export.py"), tag, str(level), str(low)], check=True,
                   capture_output=True)
    args = {"low": str(low), "out": str(HERE / f"out/{tag}_L{level}.glb"), "maps": str(HERE / "build/maps"),
            "name": f"{tag}_L{level}", "maps_in": maps}
    r = subprocess.run(pre + ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender", "--background", "--factory-startup",
                              "--python", str(TOOLS / "blender/bake_template.py"), "--", json.dumps(args)],
                       capture_output=True, text=True, errors="replace")
    if "BODYGEN_RESULT" not in r.stdout:
        sys.exit(r.stdout[-1500:] + r.stderr[-1500:])
    outs.append(args["out"])
print(json.dumps(outs))
