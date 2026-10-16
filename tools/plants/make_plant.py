"""En växt från ett recept -> assets/plants/<name>/<name>.gltf + .bin (3 LOD, inga texturer).

  python3 -I tools/plants/make_plant.py '{"name":"daisy1","preset":"daisy","seed":3}'

Receptfält (alla utom name är valfria):
  preset   en nyckel i tools/plants/plants.json: grass_tuft, grass_tall, grass_seeded, feather_grass,
           reed, cattail, wheat, barley, daisy, poppy, buttercup, tulip, cornflower, lavender, lupine, water_lily, pondweed
  seed     samma recept ger samma växt
  params   överstyr artens fält, t.ex. {"scale": 1.3} eller {"colors": {"petal": "#F08CB0"}}

Vanligt gräs i stora mängder är inte en modell utan klientens gräsfält (showcase/grass.js).
Svarar med en rad JSON inklusive "checks" (rötter under marken, blad och huvuden fästa vid stjälken,
strånas normaler uppåt, vind hel, inom budget).
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = Path(__file__).resolve().parent


def main():
    recipe = json.loads(sys.argv[1])
    name = recipe["name"]
    plants = json.loads((TOOL / "plants.json").read_text())
    preset = recipe.get("preset", "grass_tuft")
    if preset not in plants or preset.startswith("_"):
        sys.exit(json.dumps({"error": f"unknown preset {preset}"}))
    out_dir = ROOT / "assets" / "plants" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    model = out_dir / f"{name}.gltf"
    gen = {"name": name, "preset": preset, "seed": recipe.get("seed", 0), "out": str(model), "params": recipe.get("params", {})}
    run = subprocess.run(["node", str(TOOL / "gen_plant.mjs"), json.dumps(gen)], cwd=TOOL, capture_output=True, text=True)
    if run.returncode:
        sys.exit(json.dumps({"error": run.stderr.strip()[-600:]}))
    result = json.loads(run.stdout.strip().splitlines()[-1])
    (out_dir / "recipe.json").write_text(json.dumps(recipe, indent=2))
    result["model"] = str(model.relative_to(ROOT))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
