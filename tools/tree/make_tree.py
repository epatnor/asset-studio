"""Ett träd från ett recept -> assets/trees/<name>/<name>.gltf + .bin (texturer delas i assets/textures) (v3: skelett, bark och lövverk som sitter ihop, 3 LOD).

  python3 -I tools/tree/make_tree.py '{"name":"oak42","preset":"oak_medium","seed":42,"height":9}'

Receptfält (alla utom name är valfria):
  preset                  <art>_<storlek>: oak, aspen, ash, cherry, pine (gran), bush; small/medium/large
                          (bush_1, bush_2 ... är olika varianter)
  seed, height            samma recept ger samma träd; höjd i meter (buskar 0,8–1,6)
  species                 överstyr artens parametrar i species.json, t.ex. {"levels": [{"count": [8, 10]}]}
  bark, leaves            texturnamn i assets/textures (leaves är en 2x2-atlas; standard enligt arten)
  leaf_mass               sömlös lövmassa för kronans volymer (standard: <atlas>_mass, annars leaf_mass)
  leaf_tint               "#RRGGBB": tinta löven i materialet (t.ex. höstfärg) med gråskaleatlas
  bark_repeat             meter per upprepning av barktexturen (standard 1,08)
  canopy                  överstyr lövkronan: clusters, cards, flattenY, fill, union, normalBlend
  conifer                 överstyr granens barr: width, lobes, lobeDepth, chunk, asymmetry, dryShare
  frond_texture           för granar: målad barratlas (standard enligt arten), false = solida grenar utan alfa
  preview                 rendera förhandsbild via Blender (standard false)

Svarar med en rad JSON inklusive "checks" (anslutna grenar, inget under marken, fäst lövverk).
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = Path(__file__).resolve().parent
TEX = ROOT / "assets" / "textures"


def blender_cmd():
    # Claude körs i en toolbox-container; Blender finns som Flatpak på värden
    if os.environ.get("BLENDER"):
        return [os.environ["BLENDER"]]
    if shutil.which("blender"):
        return ["blender"]
    flatpak = ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender"]
    return (["host-spawn"] if shutil.which("host-spawn") else []) + flatpak


def preview(glbs, out, lod=0, size=(1024, 512), backlight=False):
    # Blender körs i en annan arbetskatalog, så alla sökvägar måste vara absoluta
    absolute = lambda p: str((ROOT / p).resolve())
    # Blenders glTF-importör saknar meshopt-avkodaren: packa upp varje modell till en tillfällig kopia
    # bredvid originalet (så att de relativa texturvägarna stämmer) och ta bort den efteråt
    temp, unpacked = [], {}

    def meshopt(path):
        # Bara meshopt-komprimerade filer behöver packas upp (andra, t.ex. med inbäddade texturer, läses direkt)
        data = Path(path).read_bytes()
        if data[:4] == b"glTF":
            n = int.from_bytes(data[12:16], "little")
            info = json.loads(data[20:20 + n])
        else:
            info = json.loads(data)
        return "EXT_meshopt_compression" in info.get("extensionsUsed", [])

    for g in glbs:
        src = absolute(g["glb"] if isinstance(g, dict) else g)
        if src not in unpacked and not meshopt(src):
            unpacked[src] = src
        if src not in unpacked:
            dst = str(Path(src).with_name(Path(src).stem + "_blender.gltf"))
            subprocess.run(["node", str(ROOT / "tools" / "preview" / "decompress.mjs"), src, dst], check=True, capture_output=True)
            unpacked[src] = dst
            temp += [Path(dst), Path(dst).with_suffix(".bin")]
    items = [{**g, "glb": unpacked[absolute(g["glb"])]} if isinstance(g, dict) else unpacked[absolute(g)] for g in glbs]
    args = {"glbs": items, "out": absolute(out), "style": str(ROOT / "tools" / "style.json"),
            "lod": lod, "size": list(size), "backlight": backlight}
    try:
        run = subprocess.run(blender_cmd() + ["--background", "--factory-startup", "--python-exit-code", "1",
                                              "--python", str(ROOT / "tools" / "preview" / "preview_glb.py"), "--", json.dumps(args)],
                             capture_output=True, text=True)
    finally:
        for t in temp:
            t.unlink(missing_ok=True)
    if run.returncode or "TINKER_RESULT" not in run.stdout:
        log = Path(out).with_suffix(".log")
        log.write_text(run.stdout + run.stderr)
        raise RuntimeError(f"blender preview failed, see {log}")


def gray_version(src):
    # Gråskaleversion i assets/textures/gray/ (delas av alla modeller som tintar, och publiceras med dem);
    # görs om bara när källan är nyare. En fil som redan är gråskala används som den är.
    if src.stem.endswith("_gray"):
        return src
    dst = TEX / "gray" / f"{src.stem}_gray.png"
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        dst.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["uv", "run", "--quiet", "--no-project", "--python", "3.12", "--with", "pillow==11.1.0",
                        "--with", "numpy==2.2.3", "python", "-I", str(ROOT / "tools" / "texture" / "post_textures.py"),
                        "gray", str(src), str(dst)], check=True, capture_output=True)
    return dst


def main():
    recipe = json.loads(sys.argv[1])
    name = recipe["name"]
    preset = recipe.get("preset", "oak_medium")
    species = json.loads((TOOL / "species.json").read_text())
    sp = species[species["_presets"].get(preset.split("_")[0], "oak")]
    conifer = sp["foliage"]["type"] == "fronds"
    bark = recipe.get("bark", sp.get("bark", "bark_stylized_color"))
    leaves = recipe.get("leaves", sp.get("leaves", "leaf_atlas"))
    out_dir = ROOT / "assets" / "trees" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    glb = out_dir / f"{name}.gltf"

    gen = {k: v for k, v in recipe.items() if k in ("preset", "seed", "height", "species", "canopy", "conifer")}
    # Lövmassan till kronans volymer: <atlas utan _atlas>_mass om den finns, annars leaf_mass
    mass = recipe.get("leaf_mass") or next((m for m in (sp.get("mass"), leaves.replace("_atlas", "") + "_mass", "leaf_mass") if m and (TEX / f"{m}.png").exists()), None)
    if mass:
        gen["leafMass"] = str(TEX / f"{mass}.png")
    gen |= {"name": name, "out": str(glb), "bark": str(TEX / f"{bark}.png"), "leaves": str(TEX / f"{leaves}.png"),
            "barkRepeat": recipe.get("bark_repeat", 1.08)}
    # leaf_tint: färgen blir en materialparameter (som Material Instances) i stället för en ny textur.
    # Atlas och lövmassa används i gråskala och tintas via baseColorFactor.
    # Granar: målad barratlas med alfakant om den finns (frond_texture: false ger solida grenar)
    if conifer:
        ft = recipe.get("frond_texture", leaves)
        if ft and (TEX / f"{ft}.png").exists():
            # Gråskala: texturen ger penseldrag och alfakant, färgen kommer från paletten (vertexfärg)
            gen["frondTexture"] = str(gray_version(TEX / f"{ft}.png"))
    bark_tint = recipe.get("bark_tint", sp.get("bark_tint"))
    if bark_tint:
        gen["barkTint"] = bark_tint
        gen["bark"] = str(gray_version(TEX / f"{bark}.png"))
    if sp["foliage"]["type"] == "leafdome" and (TEX / f"{leaves}.png").exists():
        gen["leaves"] = str(gray_version(TEX / f"{leaves}.png"))
    tint = recipe.get("leaf_tint", sp.get("leaf_tint"))
    if tint and tint.startswith("palette:"):
        tint = json.loads((ROOT / "tools" / "style.json").read_text())["palette"][tint.split(":", 1)[1]]
    if tint:
        gen["leafTint"] = tint
        for key in ("leaves", "leafMass"):
            if key in gen and Path(gen[key]).exists():  # bladkupoler har ingen lövtextur
                gen[key] = str(gray_version(Path(gen[key])))
    run = subprocess.run(["node", str(TOOL / "gen_tree.mjs"), json.dumps(gen)], cwd=TOOL, capture_output=True, text=True)
    if run.returncode:
        sys.exit(json.dumps({"error": run.stderr.strip()[-500:]}))
    result = json.loads(run.stdout.strip().splitlines()[-1])

    (out_dir / "recipe.json").write_text(json.dumps({**recipe, "bark": bark, "leaves": leaves, "leaf_mass": mass}, indent=2))
    if recipe.get("preview"):
        preview([glb], out_dir / f"{name}_preview.png")
        result["preview"] = str((out_dir / f"{name}_preview.png").relative_to(ROOT))
    result["model"] = str(glb.relative_to(ROOT))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
