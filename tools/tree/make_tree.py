"""Ett träd från ett recept: ez-tree-geometri -> Blender-montering -> GLB i assets/trees/<name>/.

  python3 -I tools/tree/make_tree.py '{"name":"oak42","preset":"oak_medium","seed":42,"height":9}'

Receptfält (alla utom name är valfria):
  preset, seed, options   skickas till ez-tree (se gen_tree.mjs)
  height                  målhöjd i meter (standard 9)
  bark, leaves            texturer, relativt projektroten
  bark_scale              [u, v] upprepning av barktexturen
  preview                 rendera förhandsbild (standard true)

Skriver ut en enda rad JSON, avsedd att läsas av en AI-agent.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = Path(__file__).resolve().parent

DEFAULTS = {
    "preset": "oak_medium",
    "seed": 0,
    "height": 9.0,
    "bark": "assets/textures/bark_stylized_color.png",
    "leaves": "assets/textures/leaf_cluster_stylized.png",
    "bark_scale": [2.0, 1.0],
    "preview": True,
}


def blender_cmd():
    # Claude körs i en toolbox-container; Blender finns som Flatpak på värden
    if os.environ.get("BLENDER"):
        return [os.environ["BLENDER"]]
    if shutil.which("blender"):
        return ["blender"]
    flatpak = ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender"]
    return (["host-spawn"] if shutil.which("host-spawn") else []) + flatpak


def main():
    recipe = {**DEFAULTS, **json.loads(sys.argv[1])}
    name = recipe["name"]
    out_dir = ROOT / "assets" / "trees" / name
    work = ROOT / "build" / "trees" / name
    out_dir.mkdir(parents=True, exist_ok=True)

    ez = {k: recipe[k] for k in ("preset", "seed") } | {"out": str(work), "options": recipe.get("options", {})}
    gen = subprocess.run(["node", str(TOOL / "gen_tree.mjs"), json.dumps(ez)],
                         cwd=TOOL, capture_output=True, text=True, check=True)
    geo = json.loads(gen.stdout.strip().splitlines()[-1])

    asm = {
        "src": str(work), "out_dir": str(out_dir), "name": name,
        "bark": str(ROOT / recipe["bark"]), "leaves": str(ROOT / recipe["leaves"]),
        "height": recipe["height"], "bark_scale": recipe["bark_scale"], "preview": recipe["preview"],
    }
    run = subprocess.run(blender_cmd() + ["--background", "--factory-startup", "--python-exit-code", "1",
                                          "--python", str(TOOL / "assemble_tree.py"), "--", json.dumps(asm)],
                         capture_output=True, text=True)
    line = next((l for l in run.stdout.splitlines() if l.startswith("TINKER_RESULT ")), None)
    if run.returncode or not line:
        (work / "blender.log").write_text(run.stdout + run.stderr)
        sys.exit(json.dumps({"error": "blender failed", "log": str(work / "blender.log")}))

    shutil.copy(work / "recipe.json", out_dir / "recipe.json")
    result = json.loads(line.split(" ", 1)[1])
    result["glb"] = os.path.relpath(result["glb"], ROOT)
    result["source_height_m"] = geo["heightM"]
    print(json.dumps(result))


if __name__ == "__main__":
    main()
