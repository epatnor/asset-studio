# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp==1.30.0", "pillow==11.1.0", "numpy==2.2.3"]
# ///
"""Tinkertown MCP-server: ger AI-agenter höga verb för att bygga spelvärlden.

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
TREE_PRESETS = [f"{t}_{s}" for t in ("oak", "pine", "aspen", "ash") for s in ("small", "medium", "large")] + \
               ["bush_1", "bush_2", "bush_3"]
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

mcp = FastMCP("tinkertown")


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
                options: dict | None = None, bark: str | None = None, leaves: str | None = None,
                bark_scale: list[float] | None = None, preview: bool = False) -> dict:
    """Skapa ett stiliserat träd som GLB i assets/trees/<name>/.

    preset: oak_*, pine_*, aspen_*, ash_* (small/medium/large) eller bush_1..3.
    seed: samma seed + preset ger samma träd. height: meter.
    options: ez-tree-överstyrningar, t.ex. {"branch": {"segments": {"0": 6, "1": 4}}} för färre polygoner.
    bark/leaves: texturnamn från assets/textures (utan .png), standard är husets bark och löv.
    preview: rendera även en förhandsbild (långsammare; behövs sällan).
    """
    _check_name(name)
    if preset not in TREE_PRESETS:
        raise ValueError(f"okänt preset, välj bland: {', '.join(TREE_PRESETS)}")
    recipe = {"name": name, "preset": preset, "seed": seed, "height": height, "preview": preview}
    if options:
        recipe["options"] = options
    for key, tex in (("bark", bark), ("leaves", leaves)):
        if tex:
            _check_name(tex)
            if not (ROOT / "assets" / "textures" / f"{tex}.png").exists():
                raise ValueError(f"texturen {tex} finns inte; skapa den med generate_texture")
            recipe[key] = f"assets/textures/{tex}.png"
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
def list_assets() -> dict:
    """Lista genererade träd och texturer (bara namn)."""
    a = ROOT / "assets"
    return {
        "trees": sorted(p.name for p in (a / "trees").iterdir() if p.is_dir()) if (a / "trees").exists() else [],
        "textures": sorted(p.stem for p in (a / "textures").glob("*.png")),
    }


if __name__ == "__main__":
    mcp.run()
