"""En naturprop från ett recept -> assets/props/<name>/<name>.glb (3 LOD).

  python3 -I tools/props/make_prop.py '{"name":"boulder1","preset":"mossy_boulder","seed":3}'

Receptfält (alla utom name är valfria):
  preset      en nyckel i tools/props/props.json: stone, stones, boulder, mossy_stone, mossy_boulder,
              fly_agaric, porcini, chanterelle, stump, mossy_stump, leafpile, creeper, ivy
  seed        samma recept ger samma prop
  params      överstyr presetets parametrar, t.ex. {"size": 2.5, "moss": 0.7} eller {"tint": "#B5452A"}
  stone_tint, moss_tint   färga sten eller mossa (texturen blir gråskala)

Svarar med en rad JSON inklusive "checks" (delar genererade, vilar på marken).
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = Path(__file__).resolve().parent
TEX = ROOT / "assets" / "textures"
sys.path.insert(0, str(ROOT / "tools" / "tree"))
from make_tree import gray_version  # noqa: E402  (samma cachade gråskalekonvertering som träden)

# Texturer per prop-typ: (roll, texturnamn, tintas?)
TEXTURES = {
    "rock": [("stone", "stone_painted", "stone_tint"), ("moss", "moss_painted", "moss_tint")],
    "mushroom": [("cap", None, "capTint")],
    "stump": [("bark", "bark_painted", None), ("rings", "stump_rings", None), ("moss", "moss_painted", "moss_tint")],
    "leafpile": [("leaves", None, "tint"), ("mass", None, "tint")],
    "creeper": [("leaves", "leaf_surface", "always")],
}


def main():
    recipe = json.loads(sys.argv[1])
    name = recipe["name"]
    props = json.loads((TOOL / "props.json").read_text())
    preset = recipe.get("preset", "stone")
    if preset not in props or preset.startswith("_"):
        sys.exit(json.dumps({"error": f"unknown preset {preset}"}))
    sp = {**props[preset], **recipe.get("params", {})}
    out_dir = ROOT / "assets" / "props" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    glb = out_dir / f"{name}.glb"

    textures = {}
    for role, default, tint_key in TEXTURES[sp["kind"]]:
        # Ett strängvärde med rollens namn i presetet är ett texturnamn (t.ex. "cap", "leaves", "mass");
        # andra värden med samma namn (som moss: 0.5) är parametrar, inte texturer
        tex_name = sp[role] if isinstance(sp.get(role), str) else default
        path = TEX / f"{tex_name}.png" if tex_name else None
        if not path or not path.exists():
            continue
        tinted = tint_key == "always" or bool(sp.get(tint_key) or recipe.get(tint_key))
        textures[role] = str(gray_version(path) if tinted else path)

    gen = {"name": name, "preset": preset, "seed": recipe.get("seed", 0), "out": str(glb), "textures": textures,
           "params": recipe.get("params", {}), "stoneTint": recipe.get("stone_tint"), "mossTint": recipe.get("moss_tint")}
    run = subprocess.run(["node", str(TOOL / "gen_prop.mjs"), json.dumps(gen)], cwd=TOOL, capture_output=True, text=True)
    if run.returncode:
        sys.exit(json.dumps({"error": run.stderr.strip()[-600:]}))
    result = json.loads(run.stdout.strip().splitlines()[-1])
    (out_dir / "recipe.json").write_text(json.dumps(recipe, indent=2))
    result["glb"] = str(glb.relative_to(ROOT))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
