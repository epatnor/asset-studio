# Tinkertown – anvisningar för AI-agenter

Läs README.md för visionen. Det viktigaste här är tokenekonomin: **låt verktygen göra jobbet.**

## Arkitektur

Three.js-klient (spel och editor) och en lokal Node-server (världsrecept, verktyg, MCP), som kopplas ihop via ett eget API. Målet är först webbläsaren, sedan en desktopapp med Electron. Klientkod får inte förutsätta Node eller Electron, och serverkod får inte förutsätta en webbläsare. Se "Plattform och arkitektur" i README.md.

## Stil

Allt som skapas ska följa [docs/style-guide.md](docs/style-guide.md): stiliserad PBR (inte cel-shading), chunky former med bevel + weighted normals, låg-frekventa målade texturer, klumpiga trädkronor med canopy-normaler. Verktyg läser stilvärden ur `tools/style.json` i stället för att hårdkoda dem. Läs guiden innan ett nytt verktyg byggs; läs den inte vid varje vanligt verktygsanrop.

## Referenser (Apparition)

Referensbilder och underlag för Tinkertown och Aszhara Studio samlas på moodboarden Apparition (MCP `apparition`). Boarden är indelad i grupper så att man bara läser det uppgiften kräver:

1. `get_board` först: där syns grupperna och vad var och en är till för.
2. Sedan `list_items` eller `get_style` för **en** grupp. Det är text (palett, taggar, anteckningar) och räcker oftast.
3. Titta bara på bilder via `contact_sheet` för gruppen, och bara när texten inte räcker. Läs aldrig hela boarden.

Skriv tillbaka det du lär dig med `update_item` och `set_description`. Apparition är under utveckling och boarden kan tömmas, så den är ett komplement: stilguiden och `tools/style.json` gäller före boarden.

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

Byggnadsgeneratorn (`tools/building/`, MCP `create_building`) gör hus, värdshus, torn, stadshus och butiker från recept: typ (`preset`), spelstil (`style`: fantasy, rpg, steampunk, modern, future, cyberpunk) och stiliseringsgrad (`stylization`: realistic, overwatch, wow eller 0..1). Alla hus byggs av samma delar (grund, väggar per våning, tak, torn, flygel, skorsten, fönster, dörr med trappa och litet tak, lykta, blomlådor, rankor, props). Typer och stilar är data i `buildings.json`. Saknade texturer för en stil genereras första gången (Krea-2, cirka 3 minuter styck); `textures: false` hoppar över det. Kontrollera `checks.ok`, och bygg aldrig hus för hand.

Växtgeneratorn (`tools/plants/`, MCP `create_plant`) gör gräsknippen, vass, säd och blommor som data i `plants.json`. Vanligt gräs i stora mängder är inte modeller utan klientens gräsfält i `showcase/grass.js` (instansierade strån som tar rotfärgen från marken).

Färdiga modeller från andra (GLB, glTF, FBX, OBJ, DAE, blend) importeras med `import_model` (`tools/import/`): de normaliseras till meter med pivot vid marken och komprimeras som våra egna. Ange alltid `origin`, `license` och `author`. De hamnar i den genererade `assets/CREDITS.md` (`tools/import/make_credits.py`, där också `third_party/*/SOURCE.md` ingår). Saknas licens, eller är den NC, ND eller editorial, blir `checks.ok` false.

**Asset Studio** (`studio/`, server `tools/studio/server.mjs`, plan i [docs/asset-studio.md](docs/asset-studio.md)): Patrik drar själv i generatorernas spakar och sparar till biblioteket `assets/library.json`. Spakarna är data i `tools/<område>/params.json`; en ny spak i en generator ska också in där. Läs biblioteket och de sparade recepten när Patrik hänvisar till något han sparat. Fliken Texturer är texturverkstaden ([docs/texture-workshop.md](docs/texture-workshop.md)): ett material är ett recept (källa, steg, ingredienser, material, blandningslager) som körs av `tools/texture/workshop.py` (MCP `texture_recipe`), med alla spakar i `tools/texture/workshop.json` och katalogen `assets/textures/catalog.json`; 3D-labbet är `studio/lab3d.js`. Nya källor, steg och materialegenskaper läggs till där, inte som enstaka bilder; vanliga spakar syns direkt, finare får `adv: true` (under Avancerat). Färdiga material i bibliotekets tumnaglar är `presets` i samma fil; formatera den med `tools/texture/write_workshop.py`.

Kommandoradsvarianter:

| Kommando | Gör |
|---|---|
| `python3 -I tools/tree/make_tree.py '<recept>'` | Träd → `assets/trees/<name>/<name>.gltf` (+ .bin) |
| `python3 -I tools/props/make_prop.py '<recept>'` | Prop → `assets/props/<name>/<name>.gltf` (+ .bin) |
| `python3 -I tools/plants/make_plant.py '<recept>'` | Växt → `assets/plants/<name>/<name>.gltf` (+ .bin) |
| `python3 -I tools/character/make_character.py '<recept>'` | Karaktär → `assets/characters/<name>/<name>.gltf` (+ .bin), under arbete |
| `python3 -I tools/building/make_building.py '<recept>'` | Byggnad → `assets/buildings/<name>/<name>.gltf` (+ .bin), texturer genereras vid behov |
| `python3 -I tools/import/make_import.py '<recept>'` | Färdig modell (GLB, FBX ...) → `assets/imported/<name>/`, normaliserad och komprimerad |
| `python3 -I tools/texture/make_leafsheet.py '<recept>'` | Procedurellt lövark (2x2, runda lövklasar för kortbollar): white, painted eller color |
| `python3 -I tools/texture/workshop.py '<recept>'` | Material från recept (källa, steg, ingredienser) → kartor (färg, normal, höjd, ruffighet …) som förhandsvisning eller `assets/textures/<namn>*.png` + recept + katalograd |
| `python3 -I tools/texture/krea2.py "<prompt>" W H <ut.png> [seed]` | Bild från Krea-2 |
| `post_textures.py tile\|cutout <in> <ut>` | Sömlös textur / sprite med alfa |
