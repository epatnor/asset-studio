"""En karaktär från ett recept -> assets/characters/<name>/<name>.gltf + .bin

  python3 -I tools/character/make_character.py '{"name":"hero1","archetype":"hero","seed":1}'

Receptfält (alla utom name är valfria):
  archetype   arketyp i characters.json (standard hero)
  seed        samma recept ger samma karaktär
  overrides   överstyr arketypens värden, t.ex. {"heads": 7.5, "hair": "long"}
  cell        meshens cellstorlek i meter (standard efter höjden, inom triangelbudgeten)
  preview     rendera förhandsbild via Blender, framifrån och i profil (standard false)

Svarar med en rad JSON inklusive "checks" (fötterna på marken, symmetri, en sammanhängande mesh,
uppmätt antal huvuden, budget).
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tools" / "tree"))
from make_tree import preview  # noqa: E402  (samma Blender-förhandsvisning som träden)


def main():
    recipe = json.loads(sys.argv[1])
    name = recipe["name"]
    out_dir = ROOT / "assets" / "characters" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    gltf = out_dir / f"{name}.gltf"
    gen = {k: v for k, v in recipe.items() if k in ("archetype", "seed", "overrides", "cell")} | {"name": name, "out": str(gltf)}
    run = subprocess.run(["node", str(TOOL / "gen_character.mjs"), json.dumps(gen)], cwd=TOOL, capture_output=True, text=True)
    if run.returncode:
        print(json.dumps({"ok": False, "error": run.stderr[-800:]}))
        sys.exit(1)
    result = json.loads(run.stdout.strip().splitlines()[-1])
    result["out"] = str(gltf.relative_to(ROOT))
    if recipe.get("preview"):
        png = out_dir / f"{name}_preview.png"
        preview([{"glb": str(gltf), "rot": 0}, {"glb": str(gltf), "rot": 90}], png, size=(640, 480), backlight=True)
        result["preview"] = str(png.relative_to(ROOT))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
