"""Importera en färdig modell -> assets/imported/<name>/<name>.gltf (+ .bin och WebP-texturer).

  python3 -I tools/import/make_import.py '{"name":"bench","source":"/väg/till/bench.fbx","height":0.9}'

Receptfält (name och source krävs):
  source       GLB eller glTF; FBX, OBJ, DAE, blend, STL och PLY konverteras först med Blender headless
  height       önskad höjd i meter (annars skala, eller en gissning av enheten: cm och mm känns igen)
  scale        fast skalfaktor
  max_texture  största texturstorlek i pixlar (standard 1024)
  category     budgetkategori i style.json (standard prop_medium)

Svarar med en rad JSON: storlek i meter, trianglar mot budget, och "checks" (vilar på marken, centrerad, normaler).
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = Path(__file__).resolve().parent
NATIVE = {".glb", ".gltf"}


def blender_cmd():
    if os.environ.get("BLENDER"):
        return [os.environ["BLENDER"]]
    flatpak = ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender"]
    return (["host-spawn"] if shutil.which("host-spawn") else []) + flatpak


def main():
    recipe = json.loads(sys.argv[1])
    name, src = recipe["name"], Path(recipe["source"]).expanduser().resolve()
    if not src.exists():
        sys.exit(json.dumps({"error": f"hittar inte {src}"}))
    work = ROOT / "build" / "import" / name
    work.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() in NATIVE:
        source = src
    else:
        # Blender (Flatpak) når bara projektmappen, så källan kopieras in först
        local = work / src.name
        shutil.copy2(src, local)
        source = work / f"{name}.glb"
        run = subprocess.run(blender_cmd() + ["--background", "--python", str(TOOL / "to_glb.py"), "--", str(local), str(source)],
                             capture_output=True, text=True)
        if run.returncode or not source.exists():
            sys.exit(json.dumps({"error": "Blender kunde inte konvertera", "log": (run.stdout + run.stderr)[-600:]}))
    out_dir = ROOT / "assets" / "imported" / name
    if out_dir.exists():
        shutil.rmtree(out_dir)
    model = out_dir / f"{name}.gltf"
    gen = {"name": name, "source": str(source), "out": str(model), "height": recipe.get("height"), "scale": recipe.get("scale"),
           "maxTexture": recipe.get("max_texture", 1024), "category": recipe.get("category", "prop_medium")}
    run = subprocess.run(["node", str(TOOL / "import_model.mjs"), json.dumps(gen)], cwd=TOOL, capture_output=True, text=True)
    if run.returncode:
        sys.exit(json.dumps({"error": run.stderr.strip()[-600:]}))
    result = json.loads(run.stdout.strip().splitlines()[-1])
    (out_dir / "recipe.json").write_text(json.dumps(recipe, indent=2, ensure_ascii=False))
    result["model"] = str(model.relative_to(ROOT))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
