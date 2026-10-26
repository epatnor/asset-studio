"""En byggnad från ett recept -> assets/buildings/<name>/<name>.gltf + .bin (3 LOD, texturerna delas i assets/textures).

  python3 -I tools/building/make_building.py '{"name":"inn1","preset":"tavern","style":"fantasy","stylization":"wow","seed":3}'

Receptfält (alla utom name är valfria):
  preset        typ i tools/building/buildings.json: cottage, house, tavern, townhouse, tower, shop
  style         spelstil: fantasy, rpg, steampunk, modern (vanlig tid), future, cyberpunk
  stylization   "realistic", "overwatch", "wow" eller ett tal 0..1 (0,5 = Overwatch, 1 = WoW)
  seed          samma recept ger samma hus
  params        överstyr typen, t.ex. {"floors": [3, 3], "footprint": [[9, 9], [6, 6]], "roof": "hip"}
  style_params  överstyr stilen, t.ex. {"vines": 1.0, "timber": false, "tints": {"roof": ["#C0503A"]}}
  textures      true (standard): saknade texturer genereras med Krea-2 (make_surface.py, ca 3 min styck);
                false: använd bara texturer som redan finns, annars enfärgat material

Svarar med en rad JSON inklusive "checks" (dörr, trappa, öppningar som inte krockar, skorsten genom taket,
står på marken, budget, LOD) och vilka texturer som genererades.
"""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = Path(__file__).resolve().parent
TEX = ROOT / "assets" / "textures"
ROLES = ("base", "wall", "roof", "trim", "door")


def comfy_up() -> bool:
    try:
        urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=3)
        return True
    except OSError:
        return False


def ensure_texture(spec: dict, allow_generate: bool, log: list) -> Path | None:
    """Texturen för ett material; genereras (sömlös, med normalkarta) om den saknas och det är tillåtet."""
    path = TEX / f"surface_{spec['name']}.png"
    if path.exists():
        return path
    if not allow_generate or not spec.get("prompt") and not spec.get("preset"):
        return None
    recipe = {"name": spec["name"], "seed": spec.get("seed", 11)}
    if spec.get("preset"):
        recipe["preset"] = spec["preset"]
    else:
        recipe["params"] = {"prompt": spec["prompt"], "view": spec.get("view", "facade"), "normal": spec.get("normal", 1.0)}
    run = subprocess.run(["uv", "run", "--quiet", "--script", str(ROOT / "tools" / "texture" / "make_surface.py"), json.dumps(recipe)],
                         cwd=ROOT, capture_output=True, text=True, timeout=1500)
    if run.returncode or not path.exists():
        log.append({"texture": spec["name"], "error": (run.stderr or run.stdout).strip()[-300:]})
        return None
    log.append({"texture": spec["name"], "generated": True})
    return path


def main():
    recipe = json.loads(sys.argv[1])
    name = recipe["name"]
    data = json.loads((TOOL / "buildings.json").read_text())
    style = recipe.get("style", "fantasy")
    if style not in data["_styles"]:
        sys.exit(json.dumps({"error": f"unknown style {style}; available: {', '.join(data['_styles'])}"}))
    st = {**data["_styles"][style], **recipe.get("style_params", {})}
    allow = recipe.get("textures", True) is not False
    log = []
    if allow and not comfy_up():
        allow = False
        log.append({"warning": "ComfyUI svarar inte på 127.0.0.1:8188; saknade texturer blir enfärgade"})

    textures = {}
    for role in ROLES:
        spec = st.get("textures", {}).get(role)
        if not spec:
            continue
        path = ensure_texture(spec, allow, log)
        if path:
            textures[role] = str(path)
            normal = path.with_name(path.stem + "_normal.png")
            if normal.exists():
                textures[f"{role}_normal"] = str(normal)

    if any(e.get("generated") for e in log):  # WebP för nedladdning, som för övriga texturer (PNG är källan)
        subprocess.run(["uv", "run", "--quiet", "--script", str(ROOT / "tools" / "texture" / "to_webp.py"), str(TEX)],
                       cwd=ROOT, capture_output=True, text=True, timeout=600)

    out_dir = (ROOT / recipe.get("out_root", "assets/buildings")).resolve() / name  # out_root: t.ex. bibliotekets variantpool
    out_dir.mkdir(parents=True, exist_ok=True)
    gltf = out_dir / f"{name}.gltf"
    gen = {k: v for k, v in recipe.items() if k != "textures"}
    gen.update({"out": str(gltf), "textures": textures})
    run = subprocess.run(["node", str(TOOL / "gen_building.mjs"), json.dumps(gen)], cwd=TOOL, capture_output=True, text=True)
    if run.returncode:
        sys.exit(json.dumps({"error": run.stderr.strip()[-800:]}))
    result = json.loads(run.stdout.strip().splitlines()[-1])
    (out_dir / "recipe.json").write_text(json.dumps({k: v for k, v in recipe.items() if k != "out_root"}, indent=2, ensure_ascii=False))
    result["model"] = str(gltf.relative_to(ROOT))
    if log:
        result["texture_log"] = log
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
