# Tinkertown

En speleditor där man spelar hela tiden. WASD, mouselook, spring, flyg, interagera och attack finns från start, och varje del av världen kan genereras inifrån editorn.

Tricket: AI:n gör inga tunga lyft. Den skickar små recept till verktyg (egna eller open source) som bygger träd, terräng, vatten, props, karaktärer och texturer. Ett träd ska kosta några hundra tokens, inte tiotusentals.

## Principer

1. **Världen är data.** Allt sparas som recept (parametrar + seed), inte som färdiga meshar. Små filer, reproducerbart, och AI:n kan ändra "gör träden högre" genom att ändra en siffra.
2. **Verktyg med höga verb.** `place_forest`, `carve_river`, `create_tree`, inte `create_vertex`.
3. **Korta svar till AI:n.** Verktyg svarar med en rad JSON (id, antal, sökväg), aldrig med geometri. Bilder bara när det behövs.
4. **Enhetlig stil.** Stiliserad, halvrealistisk mid-poly i stil med Overwatch och Fortnite. Se [stilguiden](docs/style-guide.md); värden som verktygen läser finns i [`tools/style.json`](tools/style.json).
5. **Bygg själv bara när inget bra gratis verktyg finns.**

## Status

| Område | Verktyg | Status |
|---|---|---|
| Träd | [ez-tree](https://github.com/dgreenheck/ez-tree) (MIT) + Blender | Fungerar: recept → GLB |
| Texturer | Krea-2 Turbo via lokal ComfyUI | Fungerar: bark (sömlös), lövsprite (alfa) |
| MCP-server | `tools/mcp/server.py` | Fungerar: `create_tree`, `generate_texture`, `list_assets` |
| Terräng, vatten, vegetation, props, karaktärer | – | Ej påbörjat |
| Editor/runtime | – | Ej påbörjat (motor ej vald) |

## Struktur

```
tools/mcp/        MCP-servern som exponerar verktygen för AI-agenter
tools/tree/       ez-tree-generator och Blender-montering
tools/texture/    Krea-2-generering och efterbehandling (sömlöst, alfa)
assets/textures/  delade, stiliserade texturer (raw/ = original från Krea-2)
assets/trees/     genererade träd: <namn>.glb, recipe.json, förhandsbild
docs/concept/     konceptbilder
build/            mellanfiler (OBJ m.m.), ignoreras av git
```

## Kom igång

Krav: Node 18+, Blender 5.2 (Flatpak räcker), uv, och ComfyUI på `127.0.0.1:8188` för texturer.

```bash
cd tools/tree && npm install && cd ../..
```

### Via MCP (det normala sättet)

Projektets `.mcp.json` registrerar servern `tinkertown`, som startas med `uv run --script tools/mcp/server.py` (beroenden installeras automatiskt av uv). Claude Code frågar om servern ska godkännas första gången projektet öppnas.

| Verktyg | Exempel | Svar |
|---|---|---|
| `create_tree` | `{"name":"pine3","preset":"pine_medium","seed":3,"height":11,"bark":"pine_bark"}` | `{"glb": "assets/trees/pine3/pine3.glb", "branch_tris": 10032, ...}` |
| `generate_texture` | `{"name":"pine_bark","prompt":"pine bark, flaky reddish plates","kind":"tile"}` | `{"path": "assets/textures/pine_bark.png", "seed": ...}` |
| `list_assets` | `{}` | `{"trees": [...], "textures": [...]}` |

`generate_texture` lägger automatiskt till husets stil (`house_style=true`) och rätt instruktioner för `tile` (sömlös yta) eller `cutout` (sprite med alfa på vit bakgrund).

### Direkt från kommandoraden

Ett träd:

```bash
python3 -I tools/tree/make_tree.py '{"name":"oak42","preset":"oak_medium","seed":42,"height":9}'
```

Svar: `{"glb": "assets/trees/oak42/oak42.glb", "height_m": 9.0, "branch_tris": 3166, "leaf_tris": 10640, ...}`

Presets: `oak_*`, `pine_*`, `aspen_*`, `ash_*` (small/medium/large), `bush_1..3`. Alla ez-tree-parametrar kan överstyras via `options`, t.ex. färre segment för lägre polygonantal:

```bash
python3 -I tools/tree/make_tree.py '{"name":"aspen7","preset":"aspen_medium","seed":7,"height":7,"options":{"branch":{"segments":{"0":6,"1":4,"2":3,"3":3}}}}'
```

En ny textur:

```bash
python3 -I tools/texture/krea2.py "<prompt>" 1024 1024 assets/textures/raw/<namn>_raw.png
```

```bash
uv run --no-project --python 3.12 --with pillow==11.1.0 --with numpy==2.2.3 python -I tools/texture/post_textures.py tile assets/textures/raw/<namn>_raw.png assets/textures/<namn>.png
```

(`cutout` i stället för `tile` för sprites på vit bakgrund, som löv.)
