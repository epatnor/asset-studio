# Plan: Terrängen (marken som hänger ihop)

Planerad 2026-10-28. Underlag: `patriks_input/AAA_Terrain_Worldbuilding_Texturing_ThreeJS_Reference.md` (huvudkällan), avsnitten om bäckar, flodbankar och strandskum i `AAA_Water_Simulation_ThreeJS_Reference.md` (6, 8, 14, 16), om markmaterial och upprepning i `AAA_Procedural_Textures_Stylization_ThreeJS_Reference.md` (3, 8) och `AAA_Reference_Guided_Procedural_Textures_Tiling_ThreeJS_Reference.md` (6, 7), och Tinkertowns terräng (`../tinkertown/client/src/world/`).

## Varför

Marken i Asset Studios scener är i dag gjord för stunden: varje vattenscen bygger sitt eget rutnät med en egen höjdfunktion (`grid`, `axis` och `bedAt` i `studio/water.js`). Patrik ser att geometrin är hackig och ful i kanterna, tydligast i bäcken. Marken ska vara **en modul i studion** (`shared/terrain/`), som vattnet, vinden och vädret redan är (`shared/effects/`).

**Bara i studion (Patrik, 2026-10-28):** Tinkertown skrotas senare och byggs upp på nytt med studions verktyg. Vi rör alltså inte Tinkertown. Dess terrängmotor (höjddata, brus, erosion på GPU:n, chunks med LOD och kjolar, markmaterial) är en förlaga som vi hämtar idéer och kod ur, och det nya Tinkertown ska läsa terrängen härifrån.

## Varför bäcken blir hackig (läst i koden)

1. **Fåran räknas mot närmaste punkt, inte närmaste sträcka.** `bedAt` mäter avståndet till bäckens provpunkter (var 0,4 m, grovsökning var 0,8 m) i stället för till linjen mellan dem. Bankarna får då små bucklor mellan varje punkt och ett hack där närmaste punkt byter.
2. **Hårda veck.** Fåran läggs in med `Math.min(base, chan)`. Där bankens överkant möter ängen blir det en skarp kant i stället för en mjuk övergång, och `computeVertexNormals` gör kanten synlig i ljuset.
3. **Strandlinjen följer trianglarna.** Vattnet är ett platt band som skär marken. Marken har rutor på 0,35 m som alla delas med samma diagonal, så skärningslinjen blir en sågtand längs en böjd strand. Längre ut glesnar rutnätet (`axis`, 7 % per steg), och då blir det kantigare.
4. **Våtheten tar slut med ett hopp.** `wlevel` sätts till −50 längre ut än tre bredder från bäcken. Det interpoleras över trianglarna och syns som ränder.
5. **Vattnets kant sticker fram.** Vattenbandet är 1,35 gånger fårans bredd och ska gömmas av marken, men där bankarna är låga syns bandets raka kant.

Strand- och sjöscenerna har samma rutnät och samma typ av strandlinje, men mjukare former, så felet syns mindre där.

## Grundprincip

- **En höjdfunktion och ett rutnät för allt:** marken, vattnets botten, modellernas fötter och kollisionen läser samma höjddata. `heightAt(x, z)` interpolerar exakt som trianglarna ritas, så en sten står på marken och inte i den.
- **Normaler ur höjddatan** (centrala differenser i fältet, som Tinkertowns `auxTexture`), inte ur trianglarna. Då blir ljuset mjukt och lika över chunkgränser.
- **Utgrävningar som avståndsfält:** åar, bäckar, vägar, sjöar och husgrunder är former (spline eller polygon) med avstånd till *sträckan*, en profil över bredden och en mjuk övergång (smooth min) till marken runt om. Inga `min` eller `max` med skarpa kanter.
- **Vattnet byggs ur samma data:** vattenytan och dess attribut (`bed`, `bedSlope`, `flow`) räknas ur höjdfältet och formen som grävde ut fåran. Ytan rinner aldrig uppför. Strandlinjen mjukas av vattnets djup (vattnet läser redan djupbufferten), inte av att ett band göms.
- **Recept, inte meshar:** en terräng är ett JSON-recept (seed, preset, spakar, former, penslar). Höjddatan räknas fram och sparas inte, utom som valfri bakad export.

## Delar

### 1. Delad kärna (`shared/terrain/`)

Byggs i studion, med Tinkertowns terräng som förlaga (kolumnen Förlaga). Kärnan är ren JavaScript utan Three.js där det går, så att kontrollerna kan köras i Node.

| Fil | Innehåll | Förlaga |
|---|---|---|
| `field.js` | Rutnätet (tätt där det behövs, glesare utåt) med diagonaler som följer höjdkurvorna, normaler ur höjdfunktionen och `sample(x, z)` som interpolerar exakt som trianglarna | nytt (T2) |
| `shapes.js` | Avståndsfält för splines och polygoner (avstånd till sträckan, med rutnät för fart); profiler för å, bäck, väg, sjö och platå; smooth min | nytt (T2) |
| `heightfield.js` | Höjd, fukt och hålighet som data; texturerna `heightTexture` och `auxTexture` för shadrarna | Tinkertown `heightfield.js` |
| `noise.js` | Seedat brus, fbm, domänvridning, åsbrus | Tinkertown `noise.js` |
| `generator.js` | Brus med presetens mask, termisk och hydraulisk erosion på GPU:n (CPU-reserv utan erosion) | Tinkertown `terrainGenerator.js` |
| `chunks.js` | Chunks med LOD och kjolar, höjden läses i vertexshadern | Tinkertown `terrain.js` |
| `material.js` | Marklagren efter regler (höjd, lutning, hålighet, fukt, avstånd till vatten) plus målad mask; triplanar bara i branter | Tinkertown `groundMaterial.js` |

### 2. Kartrummet (The Map Room), fliken Landscape (`studio/terrain.js`, `#kartrummet`)

- En testplats på 256 × 256 m, som referensen föreslår: först en övertygande biom som laddar snabbt, sedan större.
- Presets: ö, kullar, berg, slätt och skärgård (finns i Tinkertown). Spakarna är data i `tools/terrain/terrain.json`, med `adv: true` för de finare, och sparade terränger hamnar i `assets/terrain/`.
- Felsökningsvyer: höjd, lutning, fukt, lagervikter, LOD och trådmodell.
- Kvalitetsnivåer låg, mellan och hög (rutnät 33, 65 och 129 per chunk; 2 lager mot 5–8 lager), med uppmätt GPU-tid och antal ritanrop.
- Samma upplägg som de andra flikarna: scener och färdiga lägen till vänster, spakar och Spara till höger, vädret ur Väder-fliken.

**Byggt 2026-10-28 (T3):** terrängen blev en egen avdelning, **Kartrummet** (The Map Room, *Shape the land*, terrakotta), med flikarna Landscape (byggd) och Sculpt, Rivers & roads och Biomes (kommer, T5–T7). Namnet följer de andra platserna i studion: ett kartrum där landet formas på ett bord. Landskapet står som ett block på kartbordet, med jordlager på sidorna.

- **Generatorn** `shared/terrain/generate.js` (ren JavaScript, körs i `shared/terrain/worker.js` så att bilden inte står still): seedat gradientbrus i oktaver, åsbrus med rundade krön (mjukt |n|), domänvridning, formerna Open land, Island, Archipelago, Coast, Valley och Canyon, mjuka terrasser, droppar som eroderar med en rund pensel (radie 2 rutor) och stannar vid havet, rasvinkel, och sist en rensning av enstaka spetsar och gropar. Dropparnas spår blir fuktkartan. 256 × 256 m med 0,5 m mellan hörnen (263 000 hörn) på 0,25–0,6 s.
- **Marken** byggs med `field.js` (`byDifference`: diagonalen med minst höjdskillnad). Lagren efter höjd, lutning och fukt: gräs (torrt till frodigt), äng, fuktigare dalar, rännor, sten mot snögränsen, sand vid havet, klippa (triplanar) i branter och snö. Havet är vattenmodulen (Tropical lagoon) med havsbotten utanför platsen; former med hav sjunker utåt mot −16 m.
- **Vyerna** (raden överst i bilden): Shaded, Height, Slope, Wetness och Wireframe.
- **Färdiga landskap** (`tools/terrain/terrain.json`): Island, Archipelago, Rolling hills, Mountains, Plains, River valley, Canyon, Highlands och Coast; sparade i `assets/terrain/`.
- **Ikoner** (`assets/icons/maproom/`, arken `maproom_land` och `maproom_tools` i `tools/icons/icons.json`): de nio landskapen, de fem vyerna och redan nu verktygen som kommer: penslarna raise, lower, smooth, flatten, ramp och noise, och formerna river, road, path, lake och plateau. Landningssidans bild är `studio/img/maproom.webp`.
- **Kontroller** (`node tools/terrain/check_terrain.mjs '{"scene": "landscapes"}'`): inga NaN, inga spetsar eller gropar på enstaka rutor (ett hörn som sticker ut åt alla fyra håll utan att marken fortsätter så två rutor ut), och ön och skärgården har kanten minst 1 m under havet. Erosionen gav först 39–984 spetsar per landskap (gropar från dropparnas fyra hörn, högar där de saktade in i havet); nu 0 i alla nio.

### 3. Rätt mark i vattenscenerna

Bäcken, sjön och stranden byggs om på kärnan:

- Fåran grävs ut med `shapes.js`: avstånd till sträckan, en jämn profil (botten, slänt, bankkrön) och smooth min mot ängen.
- Rutnätet är finare nära vattnet: LOD0 med cirka 0,25 m där kameran är, och diagonalerna läggs längs lutningen.
- Vattenytan byggs bara där vattnet är djupare än noll plus en marginal. Kanten mjukas av djupet och skummet, så inget band behöver gömmas.
- Våtheten och kaustiken läser avståndet till vattnet ur fältet, så den tonar bort mjukt i stället för att ta slut.
- Bildläget (`?shot=`) ska fotografera rätt scen även när skärmen är låst (headless-provet, se nedan).

**Byggt 2026-10-28 (T2 för bäcken och sjön):** marken i alla fyra vattenscenerna byggs med `shared/terrain/field.js` (diagonaler längs höjdkurvorna, normaler ur höjdfunktionen). Bäckens fåra är `createChannel` i `shared/terrain/shapes.js`: avstånd till sträckan, profilen parabel plus rak fortsättning (inget veck i vattenlinjen), smooth min mot ängen och en vall (`levee`, 0,3 m) som håller marken närmast bäcken över vattnet, så att ytan inte rinner ut åt sidan där ängen sjunker. Vattnet läggs bara inom 1,3 bredder från mitten, och kanten ligger alltid under marken. Sjöns skål fick samma profil. Mätt med `tools/terrain/check_terrain.mjs` (bäcken) och samma mått på sjön och stranden:

| | Bäcken före | Bäcken nu | Sjön före | Sjön nu | Stranden |
|---|---|---|---|---|---|
| Strandlinjens vinkel per steg, p95 | 42,5° | 5,3° | 2,9° | 3,3° | 3,6° |
| Hack över 60° i strandlinjen | 6 | 0 | 0 | 0 | 0 |
| Största veck mellan grannhörn | 32,7° | 10,9° | 39,9° | 7,6° | 6,7° |
| Brantaste steg mellan grannar | 1,25 | 0,58 | 0,88 | 0,54 | 0,25 |

Bildläget ritade inte när skärmen var låst (0 fps, och bilden blev den förra scenen). `/api/gpu/launch` tar nu `headless: true` (med `test: true`): Chrome utan fönster på samma kort, WebGL2 i stället för WebGPU, stängs när bilden är sparad eller efter 3 minuter.

### 4. Markmaterialen

- Lagren gräs, äng, jord, flodbotten, sand, klippa, sten och snö (Tinkertowns `GROUND_TEXTURES`) får vikter efter reglerna, normaliserade så att de summerar till 1.
- Lagren blandas efter höjd, så att stenar sticker upp ur gräset. Våt mark ligger vid vattnet.
- Upprepningen bryts med `antitile.js` och en storskalig ton.
- Texturerna görs i Ateljén med profilen `terrain` och jämförs mot CC0-referenserna (`reference_analysis.py`), som barken.

### 5. Former: åar, bäckar, vägar, sjöar och platåer

- En å eller bäck dras som en linje. Den gräver en fåra med bankar, och vattenytan sluttar bara nedströms.
- En väg eller stig plattar till marken längs linjen, målar den och håller undan växterna.
- "Gräv en sjö här" sänker marken, lägger en vattenyta och sätter strandmaterial.
- Platåer ger husen en jämn grund med mjuka slänter runt om.
- Detta motsvarar Tinkertowns steg 5 (Splines), som det nya Tinkertown sedan får härifrån.

### 6. Penslar och följsamhet

- Penslarna höj, sänk, jämna ut, platta till, ramp och brus, där bara de chunks som ändrats räknas om.
- Placerade objekt sparar sin höjd relativt marken (`anchor: "ground"`). Stenar och buskar lutar med marken, husen står lodrätt.

### 7. Stora världar: biomer, uppdelning och strömning

Referensens ordning: först en övertygande testplats på 256 × 256 m, sedan en sömlös stor värld som delas upp och strömmas.

- **Uppdelning:** världen delas i chunks (förslag 128 m, som Tinkertowns `CHUNK_SIZE`) i ett quadtree. Varje chunk räknas fram ur receptet och seed, så att en chunk ser likadan ut vem som än bygger den. Grannar delar exakt samma kanthörn och normaler (höjden provas en bit utanför chunken för normalerna).
- **Strömning:** `streamer.js` laddar och släpper chunks efter kamerans avstånd, i en worker så att bilden inte hackar. LOD per chunk (rutnät 129, 65, 33, 17), kjolar eller sömmar mot sprickor, och morfning mellan nivåerna så att inget hoppar. Långt bort ersätts marken av en grov horisont och skogen av impostors.
- **Biomer:** `biomes.js` klassar varje punkt ur kartorna höjd, lutning, temperatur, fukt, flödesackumulation, hålighet och avstånd till vatten, plus en målad biomkarta som går före reglerna. Biomen väljer marklager (fas 4) och vad som sprids ut (bibliotekets familjer, B3). Övergångarna är mjuka (vikter som summerar till 1), inte gränser.
- **Kartorna som data:** höjd, lutning, fukt, flöde, biom, splat-vikter och vattenmask hålls isär som egna kartor per chunk, inte bakade i en färgbild, och kan exporteras (`heightmap`, `biome`, `splatRGBA`, `watermask`) till det nya Tinkertown eller andra motorer.
- **Texturer i stor skala:** världskoordinater för texturerna (samma täthet överallt), storskalig ton mot upprepning, och virtuell texturering först om det verkligen behövs.
- **Kontroller:** sömmar från alla fyra håll och vid varje LOD-övergång, 100+ cykler av strömning utan läckor (minne, geometrier, texturer), tider per chunk och `renderer.info` loggat.

## Kontroller (`checks`)

Kontrollerna räknas i Node utan bilder, som `checks.ok` i generatorerna:

- **Sömmar:** grannchunks har samma höjd och normal i kanten, från alla fyra håll och vid varje LOD-övergång.
- **Jämnhet:** största normalvinkel mellan grannhörn, och inga veck över en gräns i fåror och bankar.
- **Höjder:** `heightAt` mot meshens trianglar (fel under 1 mm), och inga NaN.
- **Vatten:** vattenytan sluttar aldrig uppför längs en å, och strandlinjens krökning har inga sågtänder (vinkeln mellan stegen längs linjen).
- **Tider:** generering och erosion mäts i ms, ritanrop och trianglar per kvalitetsnivå.

## Arbetsgången i Kartrummet (Patrik, 2026-10-28)

Kartrummet går hela vägen från tom karta till levande värld. Flikarna följer stegen i den ordning man arbetar:

| Steg | Flik | Vad man gör | Bygger på |
|---|---|---|---|
| 1 | **World** | Världen: nio gånger av tio en ö i havet. Världens storlek, öns form (rund, vulkan, atoll, två öar, halvmåne med vik), berg, kullar och erosion | T1–T3 (byggda) |
| 2 | **Biomes** | Biomer ur geografin (höjd, lutning, fukt, temperatur, avstånd till havet), plus en målad biomkarta som går före reglerna | del 7 |
| 3 | **Sculpt** | Forma världen för hand: penslar (höj, sänk, jämna ut, platta till, ramp, brus) och gräv bäck, å och vik | delarna 5 och 6 |
| 4 | **Paint** | Texturmålning: marklagren efter regler (höjd, lutning, fukt, biom) och med pensel | del 4 |
| 5 | **Populate** | Halvautomatisk utplacering av naturtillgångar som en PCG-graf: bibliotekets familjer efter geografi, biom och marktextur | B3 i asset-studio.md |
| 6 | **Explore** | Äventyrsläget: gå eller flyg i världen, finjustera och placera ut strategiska objekt och hus. Kräver chunks, LOD och strömning nära kameran | del 7 |
| 7 | **Life** | Monster, djur och NPC:er, sist | karaktärerna |

Varje steg sparar sitt lager i världens recept (som Tinkertowns lagerstack: terräng, biomer, skulptering, målning, utplacering, placerat, liv), så att ett tidigare steg kan göras om utan att det senare försvinner.

**Byggt 2026-10-28 (steg 1, World):** fliken Landscape blev World, och flikraden följer arbetsgången (Biomes, Sculpt, Paint, Populate, Explore och Life är markerade som kommande). Spaken *World size* väljer 256 m, 512 m, 1 km, 2 km eller 4 km; rutnätet har alltid högst 1025 × 1025 hörn (`worldGrid` i `generate.js`: 0,5 m upp till 512 m, sedan size / 1024), och havet, havsbottnen (−16 m, djupare i större världar), skuggornas räckvidd (`atm.setShadowRange`), diset och kameran följer storleken. Nya former: Volcano (kon med krater), Atoll (ring av låga öar runt en lagun, bruten av öppningar), Twin isles (två öar med ett sund) och Crescent bay (en ö runt en skyddad vik); Island fick en kupol som stiger inåt land i stället för en platå. Färdiga världar i 1 km: Green isle, Mountain isle, Volcano, Atoll, Twin isles, Crescent bay och Archipelago; de övriga sju är 256 m-landskap. En värld på 1 km byggs på 1,0–1,7 s i workern. Nya ikoner i arket `maproom_isles`.

Felsökt: Mountain isle blev helt svart. En enstaka pixel med NaN eller oändligt i de brantaste sluttningarna spreds av glöden över hela bilden (utan glöd var bilden hel). Bilden före glöden sätts nu till svart där värdet inte är ändligt. Bildläget fick `only=<id>,<id>` och `set=<nyckel>:<värde>` för att prova en sak i taget; i `/api/gpu/launch` skrivs `:` och `,` som `%3A` och `%2C`.

## Faser

| Fas | Innehåll | Klart när | Status |
|---|---|---|---|
| T1. Kärnan | `shared/terrain/`: `field.js`, `shapes.js`, `noise.js`, `generate.js`, `worker.js`; `tools/terrain/check_terrain.mjs` | Studions scener ritar marken ur samma kod, kontrollerna är gröna | Byggd 2026-10-28 |
| T2. Rätt mark vid vattnet | Bäcken, sjön och stranden byggda på kärnan; bildläget utan fönster | Bäckens bankar och strandlinje är mjuka, utan hack eller sågtänder | Byggd 2026-10-28 |
| T3. Kartrummet, Landscape | Generatorn i en worker, nio landskap, felsökningsvyer, ikoner | Patrik kan dra i spakarna och spara en terräng | Byggd 2026-10-28 |
| Steg 1. World | Världens storlek (256 m–4 km), öformer (vulkan, atoll, två öar, halvmåne), ön som förval | En ö i havet i spelets storlek går att skapa och spara | Byggd 2026-10-28 (närbilden i stora världar väntar på Explore) |
| Steg 2. Biomes | Klassning ur kartorna, målad biomkarta, mjuka övergångar | Biomerna syns på ön och går att måla om | Planerad |
| Steg 3. Sculpt | Penslar; bäck, å och vik som linjer som gräver (`createChannel`) | Ön går att forma för hand och få vatten genom | Planerad |
| Steg 4. Paint | Marklager efter regler och med pensel, texturer ur Ateljén | Marken ser målad och avsiktlig ut | Planerad |
| Steg 5. Populate | PCG-graf: punkter → filter (biom, lutning, höjd, marktextur, avstånd till vatten) → familj → variant | Ön blir skog, äng och strand med en knapp, och kan justeras | Planerad |
| Steg 6. Explore | Gå och flyg, chunks med LOD och strömning, placera och flytta hus och objekt | Man kan gå runt på ön och ställa ut ett hus | Planerad |
| Steg 7. Life | Monster, djur och NPC:er | | Sist |

## Beslut

- Bara i studion; Tinkertown är en förlaga och byggs senare om med studions verktyg (2026-10-28).
- Terrängen är en egen avdelning, Kartrummet (The Map Room), med flikarna Landscape, Sculpt, Rivers & roads och Biomes (2026-10-28).
- Ordning: arbetsgången ovan (Patrik 2026-10-28); karaktärer, djur och monster sist.
