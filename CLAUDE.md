# Tinkertown – anvisningar för AI-agenter

Läs README.md för visionen. Det viktigaste här är tokenekonomin: **låt verktygen göra jobbet.**

## Arkitektur

Three.js-klient (spel och editor) och en lokal Node-server (världsrecept, verktyg, MCP), som kopplas ihop via ett eget API. Målet är först webbläsaren, sedan en desktopapp med Electron. Klientkod får inte förutsätta Node eller Electron, och serverkod får inte förutsätta en webbläsare. Se "Plattform och arkitektur" i README.md.

## Stil

Allt som skapas ska följa [docs/style-guide.md](docs/style-guide.md): stiliserad PBR (inte cel-shading), chunky former med bevel + weighted normals, låg-frekventa målade texturer, klumpiga trädkronor med canopy-normaler. Verktyg läser stilvärden ur `tools/style.json` i stället för att hårdkoda dem. Läs guiden innan ett nytt verktyg byggs; läs den inte vid varje vanligt verktygsanrop.

## Regler

- Skapa aldrig geometri eller texturer "för hand" i tokens. Använd eller bygg ett verktyg.
- Anropa befintliga verktyg med recept och läs bara deras en-rads JSON-svar. Läs inte deras källkod om de fungerar.
- Filtrera stora utskrifter (modellistor, workflow-JSON) innan de hamnar i kontexten.
- Nya verktyg ska följa samma mönster: JSON-recept in, en rad JSON ut, resultat under `assets/`, mellanfiler under `build/`.

## Bilder

En bild kostar ungefär bredd × höjd / 750 tokens (1024×1024 ≈ 1 400), oavsett modell, och den ligger sedan kvar i kontexten resten av sessionen. Därför, i den här ordningen:

1. **Kontrollera med kod först.** Triangelantal, alfatäckning, upplösta recept, färger mot paletten, filstorlekar. Det mesta som "ser fel ut" syns redan i data.
2. **Små bilder.** Rendera förhandsbilder i låg upplösning. Lägg flera varianter i ett kontaktark eller en lineup i stället för separata bilder.
3. **Faktagranskning av bilder delegeras** till en underagent med `model: "haiku"`: rättstavad text, kanter och halo runt alfa, antal objekt, acceptanstester med tydliga kriterier. Underagenten svarar med en kort lista, så att bilden aldrig hamnar i huvudkontexten. Det lönar sig vid flera bilder; för en enda liten bild är underagentens startkostnad ofta högre än bilden.
4. **Stilbedömningar** (följer det stilguiden, vilken variant är bäst) görs av huvudagenten, på ett nedskalat kontaktark, och bara när det behövs: när ett verktyg är nytt eller ändrat, eller när användaren ber om det.

## Miljö (den här maskinen)

- Claude körs i toolbox-containern `claude-desktop` (Ubuntu 24.04, Python 3.12). Värden är Fedora med Python 3.14.
- Blender är en Flatpak på värden. Kör den med `host-spawn flatpak run --filesystem=<projektrot> org.blender.Blender --background ...`. `make_tree.py` gör det automatiskt (överstyr med env `BLENDER`).
- Systemd-tjänster körs på värden via `host-spawn systemctl --user ...`.
- ComfyUI: `127.0.0.1:8188`. Krea-2 Turbo: UNET `krea2_turbo_int8_convrot.safetensors`, CLIP `qwen3vl_4b_fp8_scaled.safetensors` (typ `krea2`), VAE `qwen_image_vae.safetensors`, 8 steg, cfg 1, euler/simple.
- Python-verktyg som behöver paket körs med `uv run --no-project --python 3.12 --with ...` för att fungera både i containern och på värden.

## Verktyg

Använd i första hand MCP-servern `tinkertown` (`create_tree`, `generate_texture`, `list_assets`). Nya verktyg läggs till i `tools/mcp/server.py` som tunna omslag runt ett skript i `tools/<område>/`.

Trädgeneratorn är till för alla större växter (träd och buskar; gräs och blommor är en egen generator). **Skapa eller justera aldrig enskilda träd för hand**: förbättringar görs i generatorns kod eller som artdata i `species.json`, och varje träd är ett recept som körs genom generatorn. Allt (bark, lövkluster, granens barr) byggs från samma skelett i `skeleton.mjs`. Lägg aldrig till lövverk eller grenar som inte utgår från skelettet; då försvinner garantin att delarna sitter ihop. Arter och stil-parametrar ändras i `species.json`, inte i koden. Kontrollera `checks.ok` i svaret i stället för att titta på bilder.

Propsgeneratorn (`tools/props/`, MCP `create_prop`) gör naturprops för skog, stig och fält: stenar, bumlingar, mossa, svampar, stubbar, lövhögar och krypväxter. Samma regel som för träden: nya varianter görs som data i `props.json` eller i generatorns kod, aldrig för hand.

Växtgeneratorn (`tools/plants/`, MCP `create_plant`) gör gräsknippen, vass, säd och blommor som data i `plants.json`. Vanligt gräs i stora mängder är inte modeller utan klientens gräsfält i `showcase/grass.js` (instansierade strån som tar rotfärgen från marken).

Färdiga modeller från andra (GLB, glTF, FBX, OBJ, DAE, blend) importeras med `import_model` (`tools/import/`): de normaliseras till meter med pivot vid marken och komprimeras som våra egna.

Kommandoradsvarianter:

| Kommando | Gör |
|---|---|
| `python3 -I tools/tree/make_tree.py '<recept>'` | Träd → `assets/trees/<name>/<name>.gltf` (+ .bin) |
| `python3 -I tools/props/make_prop.py '<recept>'` | Prop → `assets/props/<name>/<name>.gltf` (+ .bin) |
| `python3 -I tools/plants/make_plant.py '<recept>'` | Växt → `assets/plants/<name>/<name>.gltf` (+ .bin) |
| `python3 -I tools/import/make_import.py '<recept>'` | Färdig modell (GLB, FBX ...) → `assets/imported/<name>/`, normaliserad och komprimerad |
| `python3 -I tools/texture/krea2.py "<prompt>" W H <ut.png> [seed]` | Bild från Krea-2 |
| `post_textures.py tile\|cutout <in> <ut>` | Sömlös textur / sprite med alfa |
