"""En tung modell (Pixal3D, TRELLIS …) blir en spelmodell: decimerad till målantalet trianglar, ny UV, färg och normalkarta
bakade från originalet i Blender (tools/mesh/bake_low_blender.py). Recept in, GLB ut, en rad JSON som svar.

  python3 -I tools/mesh/make_low.py '{"high": "build/props/glb/chest.glb", "tris": 1500, "tex": 1024, "out": "build/props/low/chest_low.glb"}'

Recept: high (källmodellen), out (GLB; texturerna hamnar bredvid som <namn>_color.png och _normal.png), tris (mål),
tex (texturstorlek), quad (true: QuadriFlow-fyrhörningar i stället för decimering, sparas även som
<namn>_quads.blend), symmetry (spegelsymmetri i QuadriFlow), cage (bakningens avstånd som andel av storleken, 0.02), smooth_angle (grader), roughness.
Blender körs som Flatpak på värden (som tools/tree/make_tree.py); env BLENDER överstyr.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def blender_cmd():
    if os.environ.get("BLENDER"):
        return [os.environ["BLENDER"]]
    if shutil.which("blender"):
        return ["blender"]
    flatpak = ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender"]
    return (["host-spawn"] if shutil.which("host-spawn") else []) + flatpak


def main():
    r = json.loads(sys.argv[1])
    job = {**r, "high": str((ROOT / r["high"]).resolve()), "out": str((ROOT / r["out"]).resolve())}
    Path(job["out"]).parent.mkdir(parents=True, exist_ok=True)
    run = subprocess.run(blender_cmd() + ["--background", "--factory-startup", "--python-exit-code", "1",
                                          "--python", str(ROOT / "tools/mesh/bake_low_blender.py"), "--", json.dumps(job)],
                         capture_output=True, text=True)
    line = next((l for l in run.stdout.splitlines() if l.startswith("LOW_RESULT ")), None)
    if run.returncode or not line:
        log = Path(job["out"]).with_suffix(".log"); log.write_text(run.stdout + run.stderr)
        print(json.dumps({"ok": False, "error": (run.stderr or run.stdout).strip()[-400:], "log": str(log.relative_to(ROOT))}))
        sys.exit(1)
    res = json.loads(line[len("LOW_RESULT "):])
    res["out"] = r["out"]; res["mb"] = round(Path(job["out"]).stat().st_size / 1e6, 2)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
