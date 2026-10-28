# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp==1.30.0", "pillow==11.1.0", "numpy==2.2.3"]
# ///
"""MCP-servern för Azshara Asset Studio: ger AI-agenter höga verb för att bygga spelvärlden.

Varje verktyg tar ett litet recept och svarar med en kort JSON, aldrig med geometri
eller bilddata. Resultat hamnar under assets/, mellanfiler under build/.

Körs av MCP-klienten med: uv run --script tools/mcp/server.py
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "texture"))
import post_textures  # noqa: E402

STYLE_FILE = ROOT / "tools" / "style.json"  # se docs/style-guide.md
def tree_presets() -> list[str]:
    # Läses från species.json vid varje anrop, så att en ny art blir tillgänglig utan kodändring
    sp = json.loads((ROOT / "tools" / "tree" / "species.json").read_text())
    return [f"{k}_{s}" for k in sp["_presets"] for s in sp["_sizes"]] + [f"bush_{n}" for n in (1, 2, 3)]


NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

mcp = FastMCP("asset-studio")


def _check_name(name: str) -> None:
    if not NAME_RE.fullmatch(name):
        raise ValueError("name: gemener, siffror, _ och -, max 64 tecken")


def _run(cmd: list[str], timeout: int) -> str:
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError((p.stderr or p.stdout).strip()[-800:])
    return p.stdout.strip().splitlines()[-1]


@mcp.tool()
def create_tree(name: str, preset: str = "oak_medium", seed: int = 0, height: float = 9.0,
                species: dict | None = None, bark: str | None = None, leaves: str | None = None,
                bark_scale: list[float] | None = None, canopy: dict | None = None,
                conifer: dict | None = None, leaf_tint: str | None = None, preview: bool = False) -> dict:
    """Skapa en större växt (träd eller buske) som glTF (3 LOD, delade texturer) i assets/trees/<name>/.

    preset: <art>_<small|medium|large>, arter i tools/tree/species.json: oak, maple, ash, aspen, birch,
      cherry, willow (hängande), acacia (paraplykrona), cypress (pelare), jpine (japansk tall, kuddar),
      pine/fir (gran), palm, deadtree (kal), shrub (hög buske), bush (rund buske; även bush_1..3),
      ballbush och moundbush (stamlösa bulliga buskar som vilar på marken),
      leafbush, petalbush och serratebush (bladkupoler av solida blad; leaf_tint ger färgvarianter).
      Gräs och blommor är en annan generator.
      bush_* ger buske, pine_* gran av solida barrgrenar i våningar, övriga lövträd.
    seed: samma seed + preset ger samma träd. height: meter (buskar 0,8–1,6).
    species: överstyr artens skelett (tools/tree/species.json), t.ex. {"levels": [{"count": [8, 10]}]}.
    Svaret har "checks": ok=true betyder att alla grenar är anslutna, inget är under marken och lövverket sitter fast.
    canopy: lövkronan, t.ex. {"clusters": 12, "cards": 1300, "fill": 1.2, "flattenY": 0.8, "union": 0.6}.
    conifer: granen, t.ex. {"tiers": 10, "frondsBase": 10, "droop": 0.65, "lobes": 3, "lobeDepth": 0.45,
      "chunk": 1.3, "crownBase": 0.24, "crownWidth": 0.7}.
    leaf_tint: "#RRGGBB" tintar löven i materialet, t.ex. höst "#E08A2E" eller vår "#9AD15A", utan nya texturer.
    bark: sömlös textur; leaves: 2x2-atlas (leaf_atlas, blossom_atlas, needle_atlas eller egen från generate_leaf_atlas).
    preview: rendera även en förhandsbild via Blender (långsammare; behövs sällan).
    """
    _check_name(name)
    if preset not in tree_presets():
        raise ValueError(f"okänt preset, välj bland: {', '.join(tree_presets())}")
    recipe = {"name": name, "preset": preset, "seed": seed, "height": height, "preview": preview}
    if species:
        recipe["species"] = species
    if canopy:
        recipe["canopy"] = canopy
    if conifer:
        recipe["conifer"] = conifer
    if leaf_tint:
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", leaf_tint):
            raise ValueError('leaf_tint ska vara "#RRGGBB"')
        recipe["leaf_tint"] = leaf_tint
    for key, tex in (("bark", bark), ("leaves", leaves)):
        if tex:
            _check_name(tex)
            if not (ROOT / "assets" / "textures" / f"{tex}.png").exists():
                raise ValueError(f"texturen {tex} finns inte; skapa den med generate_texture eller generate_leaf_atlas")
            recipe[key] = tex
    if bark_scale:
        recipe["bark_scale"] = bark_scale
    return json.loads(_run([sys.executable, "-I", "tools/tree/make_tree.py", json.dumps(recipe)], 600))


@mcp.tool()
def generate_texture(name: str, prompt: str, kind: str = "tile", size: int = 1024,
                     seed: int | None = None, house_style: bool = True) -> dict:
    """Generera en textur med Krea-2 Turbo (lokal ComfyUI) till assets/textures/<name>.png.

    kind: "tile" = sömlös yta (bark, sten, mark), beskriv den som platt, uppifrån, fyller bilden.
          "cutout" = sprite med alfa (löv, blommor), beskriv den som isolerad på vit bakgrund.
          "raw" = bilden som den är.
    house_style: lägg till husets stil (tools/style.json) så att texturen matchar resten av världen.
    Beskriv bara materialet i prompt; stilen sköts av house_style. Negativa prompter har ingen effekt.
    Originalet sparas i assets/textures/raw/<name>_raw.png.
    """
    _check_name(name)
    if kind not in ("tile", "cutout", "raw"):
        raise ValueError('kind måste vara "tile", "cutout" eller "raw"')
    if not 256 <= size <= 2048:
        raise ValueError("size: 256–2048")
    # Läses vid varje anrop så att ändringar i style.json slår igenom utan omstart
    style = json.loads(STYLE_FILE.read_text())["prompt"]
    parts = [prompt, style["house_style"] if house_style else "", style["kinds"][kind]]
    full = ", ".join(p for p in parts if p)
    raw = ROOT / "assets" / "textures" / "raw" / f"{name}_raw.png"
    raw.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-I", "tools/texture/krea2.py", full, str(size), str(size), str(raw)]
    if seed is not None:
        cmd.append(str(seed))
    gen = json.loads(_run(cmd, 600))
    out = ROOT / "assets" / "textures" / f"{name}.png"
    if kind == "raw":
        out.write_bytes(raw.read_bytes())
    else:
        getattr(post_textures, kind)(str(raw), str(out))
    return {"texture": name, "path": str(out.relative_to(ROOT)), "kind": kind, "seed": gen["seed"]}


@mcp.tool()
def generate_leaf_atlas(name: str, prompt: str, seed: int = 1000) -> dict:
    """Generera en 2x2-lövatlas (fyra varianter) för create_tree: assets/textures/<name>.png.

    prompt: beskriv ETT kluster, t.ex. "a dense cluster of autumn orange maple leaves on a short twig".
    Husets stil, vit bakgrund och placering av stjälken nere i mitten läggs till automatiskt.
    Tar ungefär 4 bildgenereringar.
    """
    _check_name(name)
    return json.loads(_run([sys.executable, "-I", "tools/texture/make_atlas.py", name, prompt, str(seed)], 1800))


def prop_presets() -> list[str]:
    sp = json.loads((ROOT / "tools" / "props" / "props.json").read_text())
    return [k for k in sp if not k.startswith("_")]


@mcp.tool()
def create_prop(name: str, preset: str = "stone", seed: int = 0, params: dict | None = None,
                stone_tint: str | None = None, moss_tint: str | None = None) -> dict:
    """Skapa en naturprop för skog, stig och fält som glTF (3 LOD, delade texturer) i assets/props/<name>/.

    preset: stone, stones (grupp), boulder, mossy_stone, mossy_boulder, fly_agaric, porcini,
      chanterelle, stump, mossy_stump, log, mossy_log, pebbles, leafpile, creeper, ivy (se tools/props/props.json).
    params: överstyr presetet, t.ex. {"size": 2.5, "moss": 0.7}, {"count": [6, 9]} eller {"tint": "#B5452A"}.
    stone_tint/moss_tint: "#RRGGBB" färgar sten eller mossa.
    Svaret har "checks" (delar genererade, vilar på marken).
    """
    _check_name(name)
    if preset not in prop_presets():
        raise ValueError(f"okänt preset, välj bland: {', '.join(prop_presets())}")
    recipe = {"name": name, "preset": preset, "seed": seed}
    if params:
        recipe["params"] = params
    for key, v in (("stone_tint", stone_tint), ("moss_tint", moss_tint)):
        if v:
            if not re.fullmatch(r"#[0-9A-Fa-f]{6}", v):
                raise ValueError(f'{key} ska vara "#RRGGBB"')
            recipe[key] = v
    return json.loads(_run([sys.executable, "-I", "tools/props/make_prop.py", json.dumps(recipe)], 600))


def plant_presets() -> list[str]:
    sp = json.loads((ROOT / "tools" / "plants" / "plants.json").read_text())
    return [k for k in sp if not k.startswith("_")]


@mcp.tool()
def create_plant(name: str, preset: str = "grass_tuft", seed: int = 0, params: dict | None = None) -> dict:
    """Skapa en växt för mark och äng som glTF (3 LOD) i assets/plants/<name>/: gräsknippen, vass, säd och blommor.

    preset: grass_tuft, grass_tall, grass_seeded, feather_grass, reed, cattail, wheat, barley, daisy, poppy,
      buttercup, tulip, cornflower, lavender, lupine, water_lily, pondweed (se tools/plants/plants.json).
    params: överstyr arten, t.ex. {"scale": 1.3} eller {"colors": {"petal": "#F08CB0"}}.
    Vanligt gräs i stora mängder är klientens gräsfält, inte en modell.
    Svaret har "checks" (rötter i marken, delar fästa vid stjälken, vind hel, budget).
    """
    _check_name(name)
    if preset not in plant_presets():
        raise ValueError(f"okänt preset, välj bland: {', '.join(plant_presets())}")
    recipe = {"name": name, "preset": preset, "seed": seed}
    if params:
        recipe["params"] = params
    return json.loads(_run([sys.executable, "-I", "tools/plants/make_plant.py", json.dumps(recipe)], 300))


def building_data() -> dict:
    return json.loads((ROOT / "tools" / "building" / "buildings.json").read_text())


@mcp.tool()
def create_building(name: str, preset: str = "house", style: str = "fantasy", stylization: str | float = "overwatch",
                    seed: int = 0, params: dict | None = None, style_params: dict | None = None, textures: bool = True,
                    archetype: str | None = None) -> dict:
    """Skapa en byggnad som glTF (3 LOD, delade texturer) i assets/buildings/<name>/.

    Alla hus byggs av samma delar: grund, väggar per våning, tak, torn, flygel, skorsten, fönster, dörr med
    trappa (efter grundens höjd) och litet tak, lykta, blomlådor, rankor och props.
    preset: cottage, house, tavern, townhouse, tower, shop (tools/building/buildings.json).
    style: fantasy, rpg, steampunk, modern (vanlig tid), future, cyberpunk.
    stylization: "realistic", "overwatch", "wow" eller ett tal 0..1 (0.5 = Overwatch, 1 = WoW).
    params: överstyr typen, t.ex. {"floors": [3, 3], "roof": "hip"}; style_params överstyr stilen,
      t.ex. {"vines": 1.0, "tints": {"roof": ["#C0503A"]}}.
    textures: saknade texturer för stilen genereras med Krea-2 (ca 3 min styck, bara första gången).
    archetype: i stället för preset, en hustyp ur tools/building/houses.json (cottage, timber_house, townhouse,
      farmhouse, manor, tavern, tower_house), byggd av den nya generatorn: volymer med korsande gavlar, vinklar och
      torn under ett gemensamt tak (docs/buildings.md).
    Svaret har "checks" (dörr, trappa, öppningar krockar inte, skorsten genom taket, står på marken, budget, LOD).
    """
    _check_name(name)
    data = building_data()
    presets = [k for k in data if not k.startswith("_")]
    if preset not in presets:
        raise ValueError(f"okänd typ, välj bland: {', '.join(presets)}")
    if style not in data["_styles"]:
        raise ValueError(f"okänd stil, välj bland: {', '.join(data['_styles'])}")
    recipe = {"name": name, "preset": preset, "style": style, "stylization": stylization, "seed": seed, "textures": textures}
    if archetype:
        houses = json.loads((ROOT / "tools" / "building" / "houses.json").read_text())["archetypes"]
        if archetype not in houses:
            raise ValueError(f"okänd hustyp, välj bland: {', '.join(houses)}")
        recipe["archetype"] = archetype
    if params:
        recipe["params"] = params
    if style_params:
        recipe["style_params"] = style_params
    result = json.loads(_run([sys.executable, "-I", "tools/building/make_building.py", json.dumps(recipe)], 3600))
    _run([sys.executable, "-I", "tools/showcase/build_catalog.py"], 60)
    return result


@mcp.tool()
def import_model(name: str, source: str, height: float | None = None, scale: float | None = None,
                 max_texture: int = 1024, category: str = "prop_medium", origin: str | None = None,
                 license: str | None = None, author: str | None = None) -> dict:
    """Importera en färdig modell (GLB/glTF, eller FBX/OBJ/DAE/blend/STL/PLY via Blender) till assets/imported/<name>/.

    Normaliseras till meter (cm och mm gissas, eller ange height i meter eller scale), centreras med pivot vid
    marken, komprimeras (WebP-texturer upp till max_texture px, meshopt-geometri) och läggs i katalogen.
    category: budgetkategori i style.json (prop_small, prop_medium, tree, bush, building_module, character).
    origin (varifrån, gärna URL), license (CC0-1.0, CC-BY-4.0, MIT, egen ...) och author (upphovsperson, krävs
    för CC-BY) hamnar i assets/CREDITS.md. Utan licens, eller med NC/ND/editorial, blir checks.ok false.
    Svaret har storlek, trianglar mot budget och "checks".
    """
    _check_name(name)
    recipe = {"name": name, "source": source, "max_texture": max_texture, "category": category}
    if height:
        recipe["height"] = height
    if scale:
        recipe["scale"] = scale
    for key, value in (("origin", origin), ("license", license), ("author", author)):
        if value:
            recipe[key] = value
    result = json.loads(_run([sys.executable, "-I", "tools/import/make_import.py", json.dumps(recipe)], 600))
    _run([sys.executable, "-I", "tools/showcase/build_catalog.py"], 60)
    return result


@mcp.tool()
def generate_surface(name: str, preset: str | None = None, prompt: str | None = None, seed: int | None = None,
                     normal: float | None = None) -> dict:
    """Generera en SÖMLÖS, stiliserad yttextur (mark, gräs, sten, plankor ...) + normalkarta.

    preset: planks, dirt, grass, meadow, path, road, cliff, stone, gravel, riverbed, mud, sand,
      forestfloor, snow (tools/texture/surfaces.json). Eget material: ange prompt (och valfritt namn som preset).
    Resultat: assets/textures/surface_<name>.png och surface_<name>_normal.png.
    Svaret har seam_score (under ~1,6 = sömlös). Tar ungefär 3 minuter (två bildgenereringar).
    """
    _check_name(name)
    recipe = {"name": name, "preset": preset or name}
    params = {}
    if prompt:
        params["prompt"] = prompt
    if normal is not None:
        params["normal"] = normal
    if params:
        recipe["params"] = params
        surfaces = json.loads((ROOT / "tools" / "texture" / "surfaces.json").read_text())
        if recipe["preset"] not in surfaces:
            recipe["preset"] = "dirt"  # bas för egna material; prompten ersätter presetets
    if seed is not None:
        recipe["seed"] = seed
    return json.loads(_run(["uv", "run", "--quiet", "--script", "tools/texture/make_surface.py", json.dumps(recipe)], 1200))


@mcp.tool()
def texture_recipe(recipe: dict, save: dict | None = None, size: int | None = None) -> dict:
    """Kör ett recept i texturverkstaden (samma som fliken Texturer i Asset Studio; docs/texture-workshop.md).

    recipe: {"source": {"type": "stone" | "bark" | "bricks" | "planks" | "shingles" | "splat" | "noise" | "gradient"
      | "krea" | "image" | "input", ...}, "steps": [{"op": "layer" | "scatter" | "colorramp" | "edges" | ...}],
      "inputs": {"namn": {"texture": "..."} | {"recipe": {...}}}, "material": {"normal": {"strength": 1}, ...}}.
      Spakar och standardvärden: tools/texture/workshop.json. Ett sparat recept: assets/textures/<namn>.texture.json.
    save: {"name": "rock_mossig", "profile": "rock", "tags": [...], "maps": ["color", "normal", "height"],
      "pack": "orm", "webp": true, "overwrite": false}. Utan save blir det en förhandsvisning i build/studio/tex/mcp.
    Källan "krea" kör Krea-2 i ComfyUI (cirka 1–3 minuter, cachas). Kontrollera checks (seamless, high_freq) i svaret.
    """
    r = dict(recipe)
    if size:
        r["size"] = size
    if save:
        _check_name(save.get("name", ""))
        r["save"] = save
    else:
        r["out"] = "build/studio/tex/mcp"
    return json.loads(_run([sys.executable, "-I", "tools/texture/workshop.py", json.dumps(r)], 1200))


@mcp.tool()
def list_assets() -> dict:
    """Lista genererade träd, props, växter, byggnader och texturer (bara namn)."""
    a = ROOT / "assets"
    return {
        "trees": sorted(p.name for p in (a / "trees").iterdir() if p.is_dir()) if (a / "trees").exists() else [],
        "props": sorted(p.name for p in (a / "props").iterdir() if p.is_dir()) if (a / "props").exists() else [],
        "plants": sorted(p.name for p in (a / "plants").iterdir() if p.is_dir()) if (a / "plants").exists() else [],
        "buildings": sorted(p.name for p in (a / "buildings").iterdir() if p.is_dir()) if (a / "buildings").exists() else [],
        "imported": sorted(p.name for p in (a / "imported").iterdir() if p.is_dir()) if (a / "imported").exists() else [],
        "textures": sorted(p.stem for p in (a / "textures").glob("*.png")),
    }


if __name__ == "__main__":
    mcp.run()
