# Azshara Asset Studio – anvisningar för AI-agenter

Azshara Asset Studio är tillgångsverkstaden i Azshara Studio: generatorerna för träd, props, växter och byggnader, GUI:t Asset Studio och texturverkstaden. Mappen ligger i `~/Spelutveckling/azshara-studio/asset-studio` (GitHub: `epatnor/asset-studio`). Tillgångarna används av studions spel, bland annat spelet och världsbyggaren Tinkertown i `../tinkertown` och banan Azshara Island (`showcase/azshara.html`).

Läs README.md för visionen. Det viktigaste här är tokenekonomin: **låt verktygen göra jobbet.**

## Arkitektur

Spelen görs i Godot 4 (beslut 2026-11-01; provet i `../godot-lab`). Webbläsaren är inget mål för spelen. Generatorerna är motoroberoende och förblir det: JSON-recept in, glTF ut, en rad JSON som svar, och de nås via MCP-servern eller kommandoraden. `tools/terrain/export_world.mjs` för över världar till Godot. Asset Studio är i dag en Three.js-app i webbläsaren med en lokal Node-server (recept, verktyg). Den ska flyttas till Godot, med start 2026-11-02. Klienten, i dag Three.js och sedan Godot, pratar bara med verktygen genom servern eller recepten. Se "Plattform och arkitektur" i README.md.

## Stil

Allt som skapas ska följa [docs/style-guide.md](docs/style-guide.md): stiliserad PBR (inte cel-shading), chunky former med bevel + weighted normals, låg-frekventa målade texturer, klumpiga trädkronor med canopy-normaler. Verktyg läser stilvärden ur `tools/style.json` i stället för att hårdkoda dem. Läs guiden innan ett nytt verktyg byggs; läs den inte vid varje vanligt verktygsanrop.

## Referenser (Apparition)

Referensbilder och underlag för Azshara Studio och dess spel samlas på moodboarden Apparition (MCP `apparition`). Boarden är indelad i grupper så att man bara läser det uppgiften kräver:

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
- ComfyUI: jobbdatorn Darrowmere (`192.168.0.33:8188`, en tjänst som alltid är igång, T1000 8 GB) eller `127.0.0.1:8188` på laptopen. Verktygen väljer via `tools/comfy_target.py` och `tools/comfy.json` per jobb: den som har kortast kö bland dem som svarar, Darrowmere vid lika, så att RTX 4070 och T1000 kan arbeta samtidigt; `COMFY_TARGET=local` eller `darrowmere` tvingar ett mål. Krea-2 Turbo: UNET `krea2_turbo_int8_convrot.safetensors`, CLIP `qwen3vl_4b_fp8_scaled.safetensors` (typ `krea2`), VAE `qwen_image_vae.safetensors`, 8 steg, cfg 1, euler/simple.
- Python-verktyg som behöver paket körs med `uv run --no-project --python 3.12 --with ...` för att fungera både i containern och på värden.

## Verktyg

Använd i första hand MCP-servern `asset-studio` (`create_tree`, `generate_texture`, `list_assets`). Nya verktyg läggs till i `tools/mcp/server.py` som tunna omslag runt ett skript i `tools/<område>/`.

Trädgeneratorn är till för alla större växter (träd och buskar; gräs och blommor är en egen generator). **Skapa eller justera aldrig enskilda träd för hand**: förbättringar görs i generatorns kod eller som artdata i `species.json`, och varje träd är ett recept som körs genom generatorn. Allt (bark, lövkluster, granens barr) byggs från samma skelett i `skeleton.mjs`. Lägg aldrig till lövverk eller grenar som inte utgår från skelettet; då försvinner garantin att delarna sitter ihop. Arter och stil-parametrar ändras i `species.json`, inte i koden. Kontrollera `checks.ok` i svaret i stället för att titta på bilder.

Propsgeneratorn (`tools/props/`, MCP `create_prop`) gör naturprops för skog, stig och fält: stenar, bumlingar, mossa, svampar, stubbar, lövhögar och krypväxter. Samma regel som för träden: nya varianter görs som data i `props.json` eller i generatorns kod, aldrig för hand.

Byggnadsgeneratorn (`tools/building/`, MCP `create_building`; plan i [docs/buildings.md](docs/buildings.md)) gör hus, värdshus, torn, stadshus och butiker från recept: typ (`preset`), spelstil (`style`: fantasy, rpg, steampunk, modern, future, cyberpunk) och stiliseringsgrad (`stylization`: realistic, overwatch, wow eller 0..1). Alla hus byggs av samma delar (grund, väggar per våning, tak, torn, flygel, skorsten, fönster, dörr med trappa och litet tak, lykta, blomlådor, rankor, props). Typer och stilar är data i `buildings.json`. Saknade texturer för en stil genereras första gången (Krea-2, cirka 3 minuter styck); `textures: false` hoppar över det. Kontrollera `checks.ok`, och bygg aldrig hus för hand. Den nya generatorn (`archetype` i stället för `preset`: hustyperna i `houses.json`, `gen_house.mjs`) bygger huset av volymer under ett gemensamt tak (taklösaren i `house/roof.mjs`); granska med `python3 -I tools/building/house_sheet.py` (kontaktark i Blender).

Växtgeneratorn (`tools/plants/`, MCP `create_plant`) gör gräsknippen, vass, säd och blommor som data i `plants.json`. Vanligt gräs i stora mängder är inte modeller utan klientens gräsfält i `showcase/grass.js` (instansierade strån som tar rotfärgen från marken).

Färdiga modeller från andra (GLB, glTF, FBX, OBJ, DAE, blend) importeras med `import_model` (`tools/import/`): de normaliseras till meter med pivot vid marken och komprimeras som våra egna. Ange alltid `origin`, `license` och `author`. De hamnar i den genererade `assets/CREDITS.md` (`tools/import/make_credits.py`, där också `third_party/*/SOURCE.md` ingår). Saknas licens, eller är den NC, ND eller editorial, blir `checks.ok` false.

**Asset Studio** (`studio/`, server `tools/studio/server.mjs`, plan i [docs/asset-studio.md](docs/asset-studio.md)): Patrik drar själv i generatorernas spakar och sparar till biblioteket `assets/library.json`. Spakarna är data i `tools/<område>/params.json`; en ny spak i en generator ska också in där. **Appen är på engelska:** etiketter, hjälptexter, knappar och meddelanden som visas skrivs på engelska (planer, dokument och kommentarer i koden på svenska). Läs biblioteket och de sparade recepten när Patrik hänvisar till något han sparat. Fliken Texturer är texturverkstaden ([docs/texture-workshop.md](docs/texture-workshop.md)): ett material är ett recept (källa, steg, ingredienser, material, blandningslager) som körs av `tools/texture/workshop.py` (MCP `texture_recipe`), med alla spakar i `tools/texture/workshop.json` och katalogen `assets/textures/catalog.json`; 3D-labbet är `studio/lab3d.js`. Nya källor, steg och materialegenskaper läggs till där, inte som enstaka bilder; vanliga spakar syns direkt, finare får `adv: true` (under Avancerat). Färdiga material i bibliotekets tumnaglar är `presets` i samma fil; formatera den med `tools/texture/write_workshop.py`. **Kartrummet** (The Map Room, `studio/terrain.js`, [docs/terrain.md](docs/terrain.md)) gör världen, steg för steg (World, Regions, Biomes, Sculpt, Paint, Populate, Explore, Life; World, Regions, Biomes, Sculpt, Paint och Populate är byggda): spakar och färdiga landskap i `tools/terrain/terrain.json`, generatorn i `shared/terrain/` (ren JavaScript, i en worker; regionerna i `regions.js`, penslarna och det grävda vattnet i `sculpt.js`, mönster och landformer i `stamps.js`, marklagren i `paint.js`, utplaceringen i `populate.js` och naturens nivåer i `studio/populate3d.js`), sparade i `assets/terrain/`. **The Character Creator** (`studio/human.js`, servern `tools/studio/human.mjs`, [docs/asset-studio.md](docs/asset-studio.md)) bygger figurer ur reglagen med make_human.py och passar in AI-former med fit_human.py: spakarna och mallarna i `tools/character/human/params.json` (reglagens mål i `human_sliders.json`), figurerna i `assets/characters/`. **Häxkitteln** (`studio/cauldron.js`) gör spelets effekter (glöd och aura, markörer, partiklar, spår och träffar) som recept: spakar och färdiga effekter i `tools/vfx/vfx.json` (formatera med `tools/vfx/write_vfx.py`), uppspelning i `shared/effects/vfx.js` och, för besvärjelserna (tidslinjer av lager under `spells` i samma fil), `shared/effects/spells.js`; sparade i `assets/vfx/`. **Väderkvarnens** flikar Vind, Vatten och Väder (`studio/windmill.js`, `studio/water.js`, `studio/weather.js`) har spakar, scener och färdiga lägen i `tools/wind/wind.json`, `tools/water/water.json` och `tools/weather/weather.json`; ytan och himlen är `shared/effects/water.js` och `shared/effects/weather.js` (brytande vågor på gångtiden från stranden i `shared/effects/shore.js`, spakarna Breakers och Lace foam), sparade vattentyper i `assets/water/`.

Kommandoradsvarianter:

| Kommando | Gör |
|---|---|
| `python3 -I tools/tree/make_tree.py '<recept>'` | Träd → `assets/trees/<name>/<name>.gltf` (+ .bin). `detail` (0.25–1) slimmar: färre varv runt grenarna, färre rutor per lövkort, samma silhuett |
| `python3 -I tools/props/make_prop.py '<recept>'` | Prop → `assets/props/<name>/<name>.gltf` (+ .bin); `detail` som för träden |
| `python3 -I tools/plants/make_plant.py '<recept>'` | Växt → `assets/plants/<name>/<name>.gltf` (+ .bin); `detail` som för träden |
| `python3 -I tools/character/make_character.py '<recept>'` | Karaktär → `assets/characters/<name>/<name>.gltf` (+ .bin), under arbete |
| `python3 -I tools/character/human/make_human.py '<recept>'` | Character creator ([docs/character-creator.md](docs/character-creator.md)): en människa på MPFB:s gemensamma nät ur reglage (`sex`, `age`, `weight` ..., `sliders` ur `human_sliders.json`), ca 12 700 trianglar, game_engine-skelett, utan hår → `assets/characters/<name>/<name>.glb` + `_pose.glb` (T/A) |
| `python3 -I tools/character/human/fit_human.py '{"name": ..., "target": "<pixal3d.glb>", "sex": 0}'` | Character creatorns inpassning: reglagevärdena som gör grundnätet likt en AI-form (pose, förflyttning och lutning räknas bort), sedan en wrap som drar nätet tight mot AI-ytan (shape key, händer, fötter och ögon fasta; `"wrap": false` hoppar över), sedan figuren med make_human; bevis i `build/human/fit/<name>/overlay.png` |
| `python3 -I tools/character/human/transfer_texture.py '{"source": ..., "pose": "<x>_pose.glb", "rigged": "<x>.glb", "out": ...}'` | Färgen från en texturerad figur (UltraTex m.fl., egen UV) bakad till MPFB:s UV på den riggade figuren, med påfyllning runt öarna |
| `build/body/.venv/bin/python tools/character/body/fit.py <ai.glb> <namn> --height 1.65` | Body-gen ([docs/body-generator.md](docs/body-generator.md), inflyttad 2026-11-10): mallen med fast topologi dras tight mot en AI-kropp (landmärken, strålar, icke-stel ICP; sysslingen 0,13 mm) → `build/body/build/fit/<namn>.*`; `export.py <namn> <nivå> <ut.glb>` ger spelnivåerna 1–6 och s. Body Editor: skrivbordsgenvägen eller serverkonfigurationen `body-editor` |
| `python3 -I tools/building/make_building.py '<recept>'` | Byggnad → `assets/buildings/<name>/<name>.gltf` (+ .bin), texturer genereras vid behov |
| `node tools/building/gen_kit.mjs '{"assembly": "cottage", "out": "build/kit/cottage.gltf"}'` | Byggsatsen ([docs/building-kit.md](docs/building-kit.md)): en modul (`module`, `ends`), katalogen (`catalog`) eller ett hus av moduler (`assembly`) med kontroller av sockets, överlapp, glipor och svävande stenar. Vanliga murar och takfall är plattor med bakad relief (`kit/bake.mjs`, `{"bake": true}` bakar om); bilder med `tools/building/kit_sheet.py` |
| `python3 -I tools/import/make_import.py '<recept>'` | Färdig modell (GLB, FBX ...) → `assets/imported/<name>/`, normaliserad och komprimerad |
| `python3 -I tools/tree/make_templates.py ['{"only": ["oak"]}']` | Smedjans mallar: ett träd eller en buske per familj ur `tools/tree/templates.json` → `assets/trees/<id>/` (`{"detail": 0.5, "out_root": "build/slim/trees"}` slimmade, någon annanstans) |
| `node tools/mesh/check_normals.mjs '{"paths": ["assets/trees"]}'` | Vända ytor och normaler i modellerna, utan bilder: trianglar vars lindning går mot normalerna (`flipped`) och slutna delar som är ut och in (`inside_out`, strålar från ytan). Lövkort, strån och tvåsidiga par räknas inte; `{"world": "<export>"}` kollar en exports modeller |
| `python3 -I tools/texture/make_leafsheet.py '<recept>'` | Procedurellt lövark (2x2, runda lövklasar för kortbollar): white, painted eller color |
| `python3 -I tools/texture/workshop.py '<recept>'` | Material från recept (källa, steg, ingredienser) → kartor (färg, normal, höjd, ruffighet …) som förhandsvisning eller `assets/textures/<namn>*.png` + recept + katalograd |
| `python3 -I tools/texture/krea2.py "<prompt>" W H <ut.png> [seed] [--seamless]` | Bild från Krea-2 (`--seamless`: sömlös redan i genereringen) |
| `uv run --quiet --script tools/texture/krea_tex.py '{"only": ["bark_oak"], "variants": 3}'` | **Material med Krea-2** ([docs/texture-krea.md](docs/texture-krea.md)): sömlösa redan i genereringen, med normal, höjd, AO och ORM, ur `tools/texture/krea_set.json`; `{"sheet": true, "group": ...}` kontaktark, `{"install": {"<namn>": <variant>}}` ersätter målfilerna. Förstahandsvalet för nya texturer |
| `python3 -I tools/icons/make_icons.py '{"sheet": "water"}'` | Ikoner för mallarna i lådorna: ett ark ur `tools/icons/icons.json` ritas av gpt-image-2 (OpenRouter, ca 0,05 USD) och skärs till `assets/icons/<område>/<id>.png` |
| `python3 -I tools/texture/fetch_references.py` | Referensbiblioteket: några CC0-texturer från Poly Haven med manifest (källa, licens, fysisk storlek) i `material-references/` |
| `python3 -I tools/texture/reference_analysis.py '{"all": true}'` | Mäter referens och vårt material lika (palett, skala i meter, riktning, relief); `sheet` ritar jämförelseark |
| `python3 -I tools/texture/fit_reference.py '<recept>'` | Barkrecept styrt mot en referens (färger ur paletten, skala × exaggerate), sparas som vanligt material |
| `node tools/terrain/check_terrain.mjs ['{"scene": "landscapes"}']` | Terrängens kontroller utan bilder: bäckscenen (veck, sågtänder i strandlinjen, vattenkanten under marken), Kartrummets landskap (spetsar och gropar, kanten under havet, regioner och biomer) `sculpt` (penslar, mönster, landformer, å, bäck, vik och målning) eller `populate` (utplaceringen); marken byggs med `shared/terrain/` ([docs/terrain.md](docs/terrain.md)) |
| `node tools/terrain/make_diorama.mjs "$(cat tools/terrain/dioramas/demo_isle.json)"` | Diorama-ö för Kartrummet: vulkanen i mitten och kustsektorer (strand, träsk, klippkust, äng) som det formade, målade biomer, regioner och bäckar → `assets/terrain/<namn>.terrain.json`, med kontroller (djup vid kusten, gölar, biomer per sektor) |
| `node tools/terrain/export_world.mjs '{"name": "demo_isle", "out": "../godot-lab/worlds/demo_isle"}'` | En sparad värld ur Kartrummet som rådata för en annan motor (Godot-provet i `../godot-lab`): höjder, biomer, målade lager, fukt, gräsets täthet, bäckarnas yta, utplaceringen och modellerna utan meshopt; `"budget": "lean"` väljer motorns stramare budget (`godot-lab/budgets.json`), `"models": "build/slim"` de slimmade modellerna där de finns |
| `python3 -I tools/studio/ui_test.py "$(cat tools/studio/ui_tests/smoke.json)"` | UI-test i Chrome utan fönster på RTX-kortet (CDP): klickar, drar i spakar, svarar på dialoger, läser konsolen och tar skärmdumpar av hela gränssnittet, även med låst skärm. `smoke.json` går igenom alla avdelningar, `maproom.json`, `regions.json`, `biomes.json`, `sculpt.json`, `paint.json` och `populate.json` Kartrummet, `house.json` Smedjans husflik, `creator.json` och `creator_fit.json` The Character Creator. Studioservern måste vara igång |
| `python3 -I tools/darrowmere/character_order.py plan '<recept>'` | Figurbeställning (samma som panelens Order a character, `/character`): referenser eller Krea-prompt → Pixal3D/Tripo/Meshy → UltraTex-projektion → efterbehandling och spelmodell på Darrowmere; `submit '<recept>' front=bild.png` beställer. Spakarna i `tools/darrowmere/character/options.json` ([docs/character-generator.md](docs/character-generator.md)) |
| `python3 -I tools/darrowmere/order.py submit <beställning.json>` | Beställning till Darrowmere: runnern där (`tools/darrowmere/runner/`) kör stegen själv, även när laptopen är stängd (ComfyUI-flöden, Tripo i molnet efter godkännande, DeepSeek-granskning via OpenRouter); läget syns i kontrollpanelen (http://192.168.0.17:8790, Settings för lokalt/moln och API-nycklar). `status`, `approve`, `cancel`; exempel i `runner/examples/`. `tools/pipeline.py` visar egna verktygs steg i samma pipeline-kort |
| `post_textures.py tile\|cutout <in> <ut>` | Sömlös textur (`tile`: snitt där bitarna är lika, inte toning) / sprite med alfa |
