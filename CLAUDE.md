# Tinkertown – anvisningar för AI-agenter

Läs README.md för visionen. Det viktigaste här är tokenekonomin: **låt verktygen göra jobbet.**

## Regler

- Skapa aldrig geometri eller texturer "för hand" i tokens. Använd eller bygg ett verktyg.
- Anropa befintliga verktyg med recept och läs bara deras en-rads JSON-svar. Läs inte deras källkod om de fungerar.
- Titta på bilder (förhandsrenderingar) sparsamt: bara när ett nytt verktyg testas eller användaren ber om det.
- Filtrera stora utskrifter (modellistor, workflow-JSON) innan de hamnar i kontexten.
- Nya verktyg ska följa samma mönster: JSON-recept in, en rad JSON ut, resultat under `assets/`, mellanfiler under `build/`.

## Miljö (den här maskinen)

- Claude körs i toolbox-containern `claude-desktop` (Ubuntu 24.04, Python 3.12). Värden är Fedora med Python 3.14.
- Blender är en Flatpak på värden. Kör den med `host-spawn flatpak run --filesystem=<projektrot> org.blender.Blender --background ...`. `make_tree.py` gör det automatiskt (överstyr med env `BLENDER`).
- Systemd-tjänster körs på värden via `host-spawn systemctl --user ...`.
- ComfyUI: `127.0.0.1:8188`. Krea-2 Turbo: UNET `krea2_turbo_int8_convrot.safetensors`, CLIP `qwen3vl_4b_fp8_scaled.safetensors` (typ `krea2`), VAE `qwen_image_vae.safetensors`, 8 steg, cfg 1, euler/simple.
- Python-verktyg som behöver paket körs med `uv run --no-project --python 3.12 --with ...` för att fungera både i containern och på värden.

## Verktyg

Använd i första hand MCP-servern `tinkertown` (`create_tree`, `generate_texture`, `list_assets`). Nya verktyg läggs till i `tools/mcp/server.py` som tunna omslag runt ett skript i `tools/<område>/`.

Fallgrop: ez-tree faller tyst tillbaka på standardträdet vid okänt preset-namn. `gen_tree.mjs` översätter `oak_medium` → `"Oak Medium"` och avbryter vid miss; ta inte bort den kontrollen.

Kommandoradsvarianter:

| Kommando | Gör |
|---|---|
| `python3 -I tools/tree/make_tree.py '<recept>'` | Träd → `assets/trees/<name>/<name>.glb` |
| `python3 -I tools/texture/krea2.py "<prompt>" W H <ut.png> [seed]` | Bild från Krea-2 |
| `post_textures.py tile\|cutout <in> <ut>` | Sömlös textur / sprite med alfa |
