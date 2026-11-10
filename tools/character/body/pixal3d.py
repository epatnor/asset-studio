"""3D ur en förlaga med Pixal3D lokalt i ComfyUI, genom GPU-kön (img2mesh/gpuq.py).

  python3 -I pixal3d.py <bild.png> <namn>      t.ex. images/male/body_front_101.png body_male

Kopierar img2mesh:s körning (workflows/run_creature_pixal3d.json) med bilden och namnet utbytta, lägger bilden i
ComfyUI:s input och kör den genom kön. gpuq hämtar resultatet till img2mesh/output/pixal3d/<namn>.glb (uppräthet
med to_glb.py --align, på marken) och renderar fyra vyer; här kopieras de till body-gen/build/pixal3d/."""
import json, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
I2M = SPEL / "img2mesh"
COMFY_IN = Path.home() / "Sandlåda/ComfyUI/input"

img, name = Path(sys.argv[1]).resolve(), sys.argv[2]
shutil.copy(img, COMFY_IN / f"bodygen_{name}.png")
wf = (I2M / "workflows/run_creature_pixal3d.json").read_text()
wf = wf.replace('"creature.png"', f'"bodygen_{name}.png"').replace("creature_pixal3d", f"{name}_pixal3d")
run = HERE / "build/workflows" / f"run_{name}_pixal3d.json"
run.parent.mkdir(parents=True, exist_ok=True)
run.write_text(wf)
r = subprocess.run(["python3", "-I", str(I2M / "gpuq.py"), "comfy", str(run), "--asset", name, "--stage", "pixal3d"],
                   capture_output=True, text=True)
print(r.stdout[-500:], r.stderr[-1500:])
out = HERE / "build/pixal3d"
out.mkdir(parents=True, exist_ok=True)
for suf in (".glb", "_raw.glb", "_views.png", ".json"):
    src = I2M / "output/pixal3d" / f"{name}{suf}"
    if src.exists():
        shutil.copy(src, out / src.name)
sys.exit(r.returncode)
