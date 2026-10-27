# Plan: Texturverkstaden

Status: T1, T1b och T3a byggda 2026-10-25, och det mesta av T3c, T2, T3b, T4 och T5 (se Faser och roadmapen för det som är kvar). AI-flödet (G1–G5) planerat 2026-10-26, G1 byggd samma dag. Filer: `tools/texture/workshop.py` (motorn), `tools/texture/workshop.json` (alla spakar), `studio/workshop.js` (panelen), `studio/lab3d.js` (materiallabbet i 3D). Skriven 2026-10-25. Bor i Asset Studio ([asset-studio.md](asset-studio.md)) men är projektets gemensamma texturkälla: den försörjer tillgångarna i studion, terrängen och marken i Tinkertown, gräset, byggnaderna och allt annat som behöver texturer.

## Så ser den ut (byggd)

Upplägget följer verktyg som Substance Sampler och Quixel Mixer: bibliotek till vänster, modellen i mitten, egenskaper till höger.

**Biblioteket** (vänster) har tumnaglar i fyra flikar, med sökruta:
- **Material:** färdiga material (`presets` i `workshop.json`) i grupperna Sten, Trä och bark, Mur och tak, Mark, Blandlager, Former och AI (Krea). Ett klick lägger materialet på modellen.
- **Texturer:** alla texturer i `assets/textures/`, grupperade (bark, mark, byggnader, löv, mossa, sten). Ett klick lägger texturen på modellen; **+ Lager** blandar in den ovanpå (kortet Blandning) och **+ Ingr.** gör den till en ingrediens. Texturer med genomskinlighet får urklipp direkt.
- **Filter:** alla steg, med en tumnagel som visar filtret på en kullersten. Ett klick lägger filtret sist i stapeln (Lager skapar en mossingrediens om ingen finns).
- **Mina:** det du sparat i verkstaden; ett klick öppnar receptet igen.

**Mitten** startar i 3D med materialet på en modell som passar profilen (bark på cylindern, sten på drakstatyn, mark på terrängbiten) tills man själv väljer modell. Verktygsraden visar materialets namn (och "ändrad"), 2D eller 3D, modell, ljus, vridbord och avstånd; under Avancerat projektion, exponering, miljöreflexer och trådram. 2D visar en karta i taget upprepad, med sömmarna markerade.

**Panelen** (höger) har hopfällbara kort. Det vanliga syns direkt; allt annat ligger under **Avancerat**, i Ytegenskaper som undermenyer per grupp:

| Kort | Direkt | Under Avancerat |
|---|---|---|
| Bas | typ, de viktigaste spakarna, frö, färger; knappen Varianter (fyra frön) | resten av basens spakar |
| Ingredienser (hopfällt) | under-texturer med miniatyr: procedurella (Redigera öppnar dem med brödsmulor) eller sparade texturer | |
| Filter | stapeln: av och på, flytta, ta bort; nytt filter ur listan eller biblioteket | filtrets finare spakar |
| Ytegenskaper | meter per upprepning, normalkarta och styrka, ruffighet och variation, AO, metall | Kartorna i detalj; Form (förskjutning, parallax, bump); Ljus (emission, alfa, transmission, SSS); Ytskikt (specular, lack, sheen, anisotropi, iridescens); Detaljkarta; Upprepning och stora ytor; Texturinställningar |
| Blandning | lager (Mossa, Snö, Smuts nerifrån, Lav på norrsidan, Nötta kanter, eller en textur från biblioteket): textur, färgton, täckning, riktning, vinkelbredd, fördjupningar först | skärpa, brus, höjd i modellen, kanter eller skrymslen, skala, ruffighet, utjämnad och egen relief |
| Spara | profil, namn, taggar, storlek | vilka kartor som sparas, ORM-packning, WebP |

Ytegenskaper, Blandning och Spara gäller hela texturen och döljs medan en ingrediens redigeras. Spakar märkta `client` i `workshop.json` ändrar bara 3D-vyn; övriga räknar om kartorna (cachat, så att bara det som ändrats räknas om). `workshop.json` formateras med `tools/texture/write_workshop.py` (en spak eller ett material per rad).

## Varför

Texturerna avgör hur mycket av stilen som når fram: barken, lövarken, stenarnas mossa, markytorna. I dag görs de genom att Patrik beskriver och Claude kör verktyg. Verkstaden låter Patrik själv ta fram och justera texturer med spakar, se dem på en tillgång direkt och spara dem till samma bibliotek som studion använder.

## Vem använder texturerna: målprofiler

Verkstaden är inte bara till för studions tillgångar. Varje textur sparas med en **målprofil** som säger vad den är till för, vilka kartor som ska med och vilken skala den har i världen. Den som använder texturen (studion, terrängen, gräset, byggnadsgeneratorn, Tinkertown) läser profilen ur samma katalog.

| Profil | Används av | Kartor och krav |
|---|---|---|
| `bark` | träd och stubbar (studion, props) | färg, normal; sömlös i båda led; meter per upprepning längs stammen |
| `leaves` | lövkort, kortbollar | 2×2-atlas med alfa, bleed, ingen halo; gråskala eller färg |
| `terrain` | terrängens marklager i Tinkertown, ytorna i `make_surface.py` | färg, normal, **höjd** (för höjdbaserad blandning mellan lager); sömlös; meter per upprepning; låg upprepningskänsla över stora ytor |
| `terrain_macro` | stora variationer över terrängen (fuktfläckar, ljusare och mörkare partier) | gråskala eller färg, mycket stor skala, lågfrekvent |
| `grass` | gräsfältet (`showcase/grass.js`) och växterna | rotfärg och spetsfärg, strå- eller tuvatextur med alfa |
| `rock` | stenar och klippor (props, terrängens branter) | färg, normal, höjd; triplanar i världskoordinater |
| `building` | fasader, tak, trä, puts (byggnadsgeneratorn) | färg, normal, ruffighet; rätt skala mot våningshöjd; stil per spelstil |
| `blend` | lager som blandas in (mossa, snö, smuts, påväxt) | färg, gärna höjd; används av lagerstacken nedan |
| `decal` | fläckar, sprickor, löv på marken | färg med alfa, ej sömlös |

Profilen styr vilka steg som föreslås (en terrängtextur får automatiskt höjdkarta och upprepningskontroll), vilka kontroller som körs och hur förhandsvisningen ser ut (en terrängtextur visas på en terrängbit, en bark på en stam).

## Grundidé: en textur är ett recept

En textur byggs av en **källa** och en **stapel steg**, precis som en tillgång byggs av ett recept:

```json
{
  "name": "bark_oak_soft",
  "source": { "type": "procedural", "generator": "bark", "params": { "ridges": 7, "depth": 0.6, "seed": 12 } },
  "steps": [
    { "op": "tile", "method": "patch" },
    { "op": "levels", "contrast": 0.8, "lift": 0.1 },
    { "op": "palette", "toward": ["bark", "bark_shadow"], "amount": 0.4 },
    { "op": "normal", "strength": 0.7 }
  ],
  "output": { "size": 2048, "maps": ["color", "normal", "height"] }
}
```

- Samma recept ger alltid samma textur. Sparas receptet bredvid bilden kan texturen göras om i högre upplösning, varieras med ett nytt frö eller justeras ett steg i taget.
- Varje steg kan slås av och på och flyttas, och har sina spakar. Det motsvarar en lagerstack i ett bildprogram, men allt är data.
- Ett nytt skript, `tools/texture/workshop.py`, kör recept enligt verktygsmönstret: JSON in, en rad JSON ut, resultat i `assets/textures/`, mellanfiler i `build/`. Det återanvänder de verktyg som finns (`post_textures.py`, `make_surface.py`, `make_leafsheet.py`, `krea2.py`).
- Förhandsvisningen räknas i låg upplösning (512 px) och cachas per receptsteg, så att en spak bara räknar om stegen efter den ändrade. Full upplösning görs när man sparar.

## Ingredienser (under-texturer)

Ett recept kan ha namngivna **ingredienser** (`inputs`): en sparad textur ur katalogen eller ett inbäddat eget recept, som i sin tur kan ha egna ingredienser. Källan och stegen pekar på dem med namn:

```json
{
  "inputs": {
    "sten":  { "texture": "rock_cobble" },
    "mossa": { "recipe": { "source": { "type": "noise" }, "steps": [] } },
    "fläck": { "recipe": { "source": { "type": "noise", "kind": "blobs", "scale": 4 } } }
  },
  "source": { "type": "input", "input": "sten" },
  "steps": [ { "op": "layer", "input": "mossa", "mask": "fläck", "mode": "height", "scale": 2 } ]
}
```

- Varje ingrediens räknas för sig och cachas, så att en ändring i mossan inte räknar om stenen. Den skalas med ett helt antal upprepningar, så att resultatet förblir sömlöst.
- **Höjden följer med genom hela stapeln** (källorna räknar redan ut den). Då kan en ingrediens styras av en annans form: mossa i fogarna, smuts i barkens fåror, gräs mellan stigens stenar.
- Användning: lager med mask, masker (från höjd, ljushet, lutning, brus), detaljlager i annan skala (multiplicera, overlay), **utspridning av stämplar** (löv, småsten, blommor över skogsbotten, sömlöst), struktur till Krea (T2), materialets kartor (T3), färgramp.
- I studion: kortet **Ingredienser** med miniatyrer. Klick redigerar ingrediensens recept med samma kort, med en brödsmula (*Skogsbotten ▸ Mossa*) tillbaka. En ingrediens kan sparas som egen textur och återanvändas; katalogen håller reda på vilka texturer som använder vilka, så att de kan byggas om när en ingrediens ändras.

## Källor

### Fasta algoritmer (procedurellt, sekunder, inga GPU-jobb)
| Källa | Spakar |
|---|---|
| Brus | typ (värde, Perlin, simplex, Worley/cellulärt, fBm), skala, oktaver, skärpa, frö |
| Bark | åsar, djup, fårornas bredd, slingrighet, plattor (0–0,4 sammanhängande åsar, upp till 1 korta block), sprickor, plattornas toner, flagor/lav och deras färg, frö. Byggd efter referensens barkrecept (2026-10-27): anisotropa voronoiplattor längs stammen, lågfrekvent domänförvrängning, egna lager för fåror, sekundära sprickor (ridged brus) och glesa flagor, och en målad färg (svalt i fårorna, varmt på topparna, ton per platta). Träden får också materialets normalkarta (`<namn>_normal.png`) |
| Sten och kullersten | Voronoi-celler, storlek och variation, fogbredd, rundning, frö |
| Murverk och tegel | rader, förband, fogbredd, variation i färg och form, avslagna hörn |
| Plankor och trä | plankbredd, längd, ådring, kvistar, fogar, nötning |
| Takpannor och spån | form, överlapp, variation, mossa i skarvarna |
| Mark och splats | blandning av fläckar (jord, gräs, grus) med skala och kanter |
| Lövark | allt i `make_leafsheet.py`: bladform, antal, storlek, kvistar, solfjäder, hängande, kärna |
| Gradient och form | linjär, radiell, kant, för masker och enkla målade ytor |

### Lokal ComfyUI (Krea-2)
- Text till bild med husets stil (`tools/style.json`), frö och antal varianter (fyra i ett rutnät att välja bland).
- **Bild till bild från en procedurell bas:** algoritmen bestämmer formen (fåror, stenar, plankor) och Krea målar den i husets stil, med en spak för hur mycket Krea får ändra (denoise). Det ger målade texturer med kontroll över layouten.
- Jobbkö med förlopp: ett jobb i taget på grafikkortet (8 GB), som kan avbrytas. Servern kontrollerar att ComfyUI är igång.

### Extern bildgenerator
- Via OpenRouter (samma väg som Apparition), när Krea inte räcker, till exempel för text i bilder eller svåra motiv.
- Visar modell och uppskattat pris före varje körning och kräver ett klick för att bekräfta. Nyckeln läses ur `.env` och skrivs aldrig ut.

### Import
- Dra in en egen bild. Den blir källan i ett recept och kan sedan behandlas som allt annat.

## AI-flödet: Form → Måla → Material

Skrivet 2026-10-26, efter att T2 byggts. Krea fanns då som en av tio typer i Bas-kortets lista, och bild till bild krävde att man själv skapade en ingrediens, bytte källa och pekade ut formen. Varje bild tar cirka 3 minuter, resultaten syntes inte efteråt, prompten fick tillägg man inte såg, och höjden räknades ur bildens ljushet fast formen under redan hade rätt höjd. Målet är att AI-målning ska vara ett tydligt eget steg, att väntan inte ska stoppa arbetet och att man ska kunna jämföra försök.

Arbetsgången har tre synliga steg:
1. **Form:** det som syns i vyn (en algoritm, en sparad textur eller inget alls).
2. **Måla:** Krea målar formen i husets stil. En spak säger hur fritt (lågt: formen behålls och bara ytan målas; högt: Krea hittar på mer).
3. **Material:** normal, AO och ruffighet räknas ur formens höjd och Kreas färg, så att reliefen följer stenarna och fårorna.

| Fas | Innehåll | Klart när |
|---|---|---|
| G1. En knapp | Kortet **AI-målning** med knappen **Måla med AI**: det som syns blir formen (en ingrediens som skapas automatiskt) och Krea målar den. Spaken *Fri tolkning* i stället för denoise. Hela prompten som skickas kan fällas ut. Relief från formen (eller bilden, eller blandat), och sömmen jämnas ut utan att formerna flyttas. *Tillbaka till formen* tar bort målningen igen. | Från en procedurell sten till en målad sten med ett klick, med relief som följer stenarna |
| G2. Bildbandet | En remsa längst ner med alla genererade bilder (prompt, frö, form), med status: i kö, målar (steg x/8 från ComfyUI), klar. Klick använder bilden, stjärna behåller den. Kön stoppar inte arbetet och jobb kan avbrytas. | Fyra försök kan köas medan man jobbar vidare, och jämföras efteråt |
| G3. Snabba utkast | Utkastläge (låg upplösning och färre steg, eller SDXL som får plats i 8 GB) och sedan *Gör klar* i full kvalitet på den valda bilden. Tiderna mäts först. | Varianter kan jämföras på någon minut i stället för 12 |
| G4. Prompter efter profil | Profilen väljer vy och formulering (`surface_view` för mark, `facade_view` för byggnader, tile för bark och sten); ordknappar för material och stil. Sömmen lagas med `make_surface.py`-metoden (sömkorset målas om). Prompten byggs då bara i `workshop.py`. | Mark och fasader blir rätt vända och sömlösa utan handpåläggning |
| G5. Referenser och extern generator | Referensbild från en grupp i Apparition som stilstöd (om modellerna klarar det); OpenRouter med pris och bekräftelse (det som är kvar av T2). | Stilen kan styras med en bild, inte bara med ord |

## Bildbehandling (steg)

| Grupp | Steg | Spakar |
|---|---|---|
| Sömlöst | `tile` | metod (förskjutning och blandning, patchbaserad syntes), kantbredd; 3×3-vy med sömmarna markerade |
| Färg | `levels`, `hsv`, `palette`, `gray`, `range` | kontrast, lyft, gamma; nyans, mättnad, ljushet; dra mot paletten i `style.json` med styrka; gråskala för tint; håll värdena inom 8–90 % (stilguiden: inget rent svart eller vitt) |
| Detalj | `frequency`, `blur`, `sharpen`, `posterize`, `paint` | låg- och högfrekvensens styrka var för sig (stilguiden vill låg frekvens), oskärpa, skärpa, färre valörer, målad look (Kuwahara-filter) med penselstorlek |
| Kontrast | `soften` | finns redan: drar ner fåror och skåror men behåller stora former |
| Alfa | `cutout`, `bleed`, `alphablur`, `halo` | bakgrund bort, fyll genomskinliga pixlar med närliggande färg, mjukare kant, kontroll av vit halo (`check_alpha.py`) |
| Kartor | `height`, `normal`, `ao`, `roughness`, `pack` | höjd ur ljushet eller ur den procedurella källan, normalkartans styrka, AO ur höjd, ruffighet ur ljushet; packa till en ORM-karta |
| Geometri | `scale`, `offset`, `rotate`, `crop`, `mirror` | zoom (hur mycket mönster per upprepning), förskjutning, vridning, utsnitt |
| Atlas | `atlas` | fyra celler från olika källor eller frön till en 2×2-atlas |
| Utdata | `size`, `webp` | 512–4096 px, WebP-version för klienten |

## Förhandsvisning

- **2D:** zoom och panorering, tiling 1×1, 3×3 eller 5×5 med sömmarna markerade, en delare för före och efter, histogram och en palettmätare (andel pixlar långt från paletten).
- **Avstånd:** samma textur som den ser ut på 5, 20 och 60 m (mipmappar), så att mönster som flimrar eller blir grått syns.
- **3D:** på en kub, sfär, cylinder (stam) eller plan, eller direkt på den aktuella tillgången i studion (byt barken på trädet medan du drar). Skalan anges i meter per upprepning, så att texturens täthet stämmer med världen.

## Materiallabbet: alla egenskaper

Verkstaden gör inte bara en färgtextur utan ett **material**: en uppsättning kartor och värden, där varje egenskap kan slås på och av och styras med spakar, och provas på testmodeller. Kartorna kommer från ingredienser eller räknas fram ur källans höjd. three.js `MeshPhysicalMaterial` har det mesta inbyggt, och glTF för det vidare (KHR-tillägg) till klienten och Godot.

| Grupp | Egenskap | Hur verkstaden gör den | I klienten |
|---|---|---|---|
| Grund | **Färg (albedo)** | källan och stegen; kontroll att inget ljus är inbakat (valörer, AO-andel) | `map`, sRGB |
| | **Normalkarta** | ur höjden (styrka, skärpa) eller från en ingrediens | `normalMap`, linjär |
| | **Ruffighet** | ur ljusheten, höjden eller en ingrediens, med kurva; glans (inverterad) som val | `roughnessMap` |
| | **Metall** | mask (ingrediens eller tröskel), nästan alltid 0 eller 1 | `metalnessMap` |
| | **AO** | ur höjden (radie, styrka) | `aoMap` (andra UV-kanalen eller samma) |
| Form | **Höjd och förskjutning** | höjden; testmodellerna finns i täta versioner | `displacementMap` |
| | **Parallax occlusion mapping** | höjden; djup och antal steg | egen shader |
| | **Bump** | gråskala, äldre alternativ till normalkartan | `bumpMap` |
| Ljus | **Emission** | mask och färg, styrka (lava, runor, fönster) | `emissiveMap`, sRGB |
| | **Alfa och urklipp** | alfakanal, tröskel (urklipp), mjuk kant | `alphaMap`, `alphaTest` |
| | **Transmission och brytning** | mängd, tjocklek, IOR (glas, vatten, is) | `transmission`, `thickness`, `ior` |
| | **Subsurface (SSS)** | stiliserad genomlysning (som lövens), färg och styrka | egen shader |
| Avancerat | **Specular** | styrka och färg (äldre arbetsflöde, eller glTF-tillägget) | `specularIntensity`, `specularColor` |
| | **Clearcoat** | lacklager med egen ruffighet och normal | `clearcoat*` |
| | **Sheen** | tyg och sammet: färg och ruffighet | `sheen*` |
| | **Anisotropi** | utdragna reflexer: styrka, riktning, riktningskarta | `anisotropy*` |
| | **Iridescens** | regnbågsskimmer: styrka, IOR, tjockleksintervall | `iridescence*` |
| | **Detaljkartor** | en fin ingrediens (färg och normal) i hög tiling, som tonas in på nära håll | egen shader |
| | **Masker och ID-kartor** | RGB-mask som styr vilket lager som hamnar var (smuts, rost, slitage) | lagerstacken (T4) |

**Inställningar på texturen** (en panel per karta, med förklaring):
- **UV-tiling, förskjutning och vridning.**
- **Filtrering:** nearest, linear, trilinear, och anisotrop filtrering med nivå.
- **Mipmappar:** av och på, med en vy av hur de ser ut på avstånd.
- **Wrap mode:** repeat, clamp eller mirror.
- **Färgrymd per karta:** sRGB för färg och emission, linjär för alla datakartor. Verkstaden varnar om en datakarta står som sRGB, en klassisk felkälla.
- **Kanalpackning:** ORM, med AO i R, ruffighet i G och metall i B, som glTF väntar sig, och egna packningar.

### Testmodeller

Förhandsvisningen i 3D har en modellväljare, så att material och blandning kan provas på olika former:
- **Block med fasade kanter:** platta ytor, kanter och hörn (nötning och kantljus).
- **Sfär:** alla riktningar (riktningsmasker som mossa på norrsidan och snö uppifrån), ljusets fall.
- **Cylinder:** stam och pelare (barkens upprepning längs och runt).
- **Terrängbit med kullar:** lutning och höjd, för markprofilen.
- **Stiliserad drakstaty:** en avancerad form med veck, fjäll och utskott, där AO, krökning, höjdblandning och riktningar syns tydligt.
- **Den aktuella tillgången från studion.**

Varje modell finns i en tät version för höjdförskjutning. Visningen har vridbord, ljusförval (spelets sol och himmel, studioljus, motljus, kväll och Lights off, där bara det som lyser själv syns) och en miljö för reflexer och omgivningsljus: studiorummet eller en HDRI från Poly Haven (CC0, `third_party/polyhaven_hdri/`, hämtas med `tools/hdri/fetch_hdri.py`), valfritt också som bakgrund. Lysande material (emission) lyser upp plattan: ett punktljus i modellen med emissionskartans medelfärg, starkare ju mer som lyser och ju större modellen är (Advanced: Glow on the plinth). Material och texturer i lådan byter aldrig modell; det gör bara profilväljaren.

## Terräng och stora ytor

Marken i Tinkertown täcker stora ytor, där upprepning och skarvar mellan lager syns mest. Verkstaden får därför egna verktyg för profilen `terrain`:

- **Upprepningsskydd:** förhandsvisning över 50 × 50 m, där mönster som upprepas syns. Steg som minskar det: stokastisk tiling (texturen delas i plattor som slumpas och vrids, "texture bombing" eller hex-tiling i shadern), en makrotextur ovanpå, och varianter av samma lager som blandas med brus.
- **Höjdbaserad blandning mellan marklager:** varje lager har en höjdkarta, så att gräs växer upp mellan stenarna i en stig i stället för att tonas in som en dimma. Spak för hur skarp övergången är.
- **Lagerregler som i biomerna:** förhandsvisning på en terrängbit med kullar, där lagren läggs efter lutning (brant blir berg), höjd och fukt med spakar, samma regler som Tinkertowns biomer. Det man ställer in kan sparas som en biomregel.
- **Samma texeltäthet och färgnivå:** kontroll att lagren har samma meter per upprepning och ungefär samma ljushet och mättnad, så att inget lager sticker ut i övergångarna.
- **Avstånd:** hur marken ser ut på 5, 50 och 200 m, där detaljer blir mipmappar och makrovariationen tar över.

## Texturblandning med riktningar

Det som i dag finns separat (barkens påväxt vid foten och i topparna, stenarnas mossa på ovansidan) blir en gemensam **lagerstack** som klientens shader förstår, och som verkstaden kan förhandsvisa och styra:

| Mask | Gör | Spakar |
|---|---|---|
| Riktning | lagret där ytan pekar åt ett håll: mossa på norrsidan, snö uppifrån, smuts nerifrån | riktning (kompass och höjdvinkel, eller vektor), vinkelbredd, skärpa |
| Höjd | efter höjd över marken eller inom tillgången | från, till, kurva |
| Höjdkarta | lagret fyller i fördjupningarna först (mossa i fogarna, stenarnas toppar sticker fram) | mängd, skärpa |
| Brus | bryter upp kanten | skala, styrka, frö |
| Krökning och kanter | nötning och ljusare kanter på utstickande delar, smuts i skrymslen | mängd, bredd |
| Vertexvikt | det generatorn räknat ut (som barkens fot och toppar) | styrka |

Masker kan kombineras (till exempel riktning × brus). Resultatet sparas som materialrecept i glTF-filens extras (`blend.layers`), som ersätter dagens `bark_blend` och stenarnas `triplanar`-mossa med en gemensam modell. Projektionen kan vara UV eller triplanar i världskoordinater (inga sömmar på stenar).

## Bibliotek och kontroller

- Sparade texturer hamnar i `assets/textures/` med receptet bredvid (`<namn>.texture.json`), en miniatyr och en rad i texturkatalogen `assets/textures/catalog.json` (namn, profil, kartor, meter per upprepning, taggar). Katalogen läses av studions texturväljare, av generatorerna och av Tinkertown (som redan serverar `assets/` under `/asset-studio/assets/`). Taggar: bark, sten, mark, trä, löv, tak.
- "Fler varianter": samma recept med nya frön. Versioner: att spara över behåller den förra versionen.
- Kontroller i svaret, som generatorernas `checks`: sömlöshet (skillnad över kanterna), vit halo, avvikelse från paletten, för mycket högfrekvent brus (mot stilguiden), upplösning och filstorlek.

## I studion

- En ny flik i headern: **Texturer**. Layout: källan och stegen som kort till höger (lägg till steg, dra för att flytta, slå av och på), förhandsvisningen i mitten (2D, avstånd eller 3D), och kontroller och siffror i footern.
- Texturväljaren i studions kort får knappen **Öppna i verkstaden**, som öppnar den valda texturens recept, och **Ny…**, som börjar ett nytt recept av rätt slag (bark, lövark, sten ...).
- MCP-verktyget `texture_recipe` låter AI:n köra och ändra samma recept, och en knapp **Be Claude** föreslår steg eller en prompt utifrån vad man vill uppnå.

## Faser

Ordningen nedan är den föreslagna byggordningen: ingredienser, materiallabbet med testmodellerna och blandningen först, så att texturblandning kan provas på riktiga former.

| Fas | Innehåll | Klart när |
|---|---|---|
| T1. Grund (klar) | `workshop.py` med recept; procedurella källor (brus, bark, sten, tegel, plankor) och import; stegen tile, levels, hsv, palette, gray, soften, scale; fliken Texturer med 2D-vy, zoom och 3×3-tiling; spara till biblioteket | Patrik kan göra och spara en sömlös bark eller sten med spakar |
| T1b. Ingredienser | höjden genom stapeln; ingredienser (sparade och inbäddade) med cache per ingrediens; steget `layer` med masker; kortet Ingredienser med brödsmulor; utspridning av stämplar | Mossa i stenens fogar och löv strödda över marken, byggda av ingredienser |
| T3a. Materiallabbet och 3D | kartor ur höjden och ingredienser (normal, ruffighet, metall, AO, höjd, bump); 3D-vy med testmodellerna (block, sfär, cylinder, terrängbit, drakstaty, aktuell tillgång), vridbord och ljusförval; texturinställningarna (tiling, filtrering, mipmappar, wrap, färgrymd, kanalpackning); avståndsvyn; målprofiler | Ett material går att bedöma och justera på olika former |
| T4. Blandning | lagerstacken med masker (riktning, höjd, höjdkarta, brus, krökning, vertexvikt) i klientens shader, styrd och förhandsvisad i verkstaden; ersätter `bark_blend` och stenmossan | Mossa på norrsidan och snö uppifrån med spakar |
| T3c. Avancerade egenskaper | emission, alfa och urklipp, transmission och brytning, stiliserad SSS, specular, clearcoat, sheen, anisotropi, iridescens; parallax occlusion mapping och detaljkartor i shadern; export som glTF-material | Alla egenskaper i listan kan provas en i taget |
| T2. Generativt | Krea text till bild och bild till bild från en procedurell bas, med varianter och jobbkö; extern generator med pris och bekräftelse | Målade texturer med kontrollerad form, utan att be Claude |
| T3b. Terräng | profilen `terrain`: förhandsvisning på en terrängbit med lagerregler (lutning, höjd, fukt), höjdbaserad blandning, upprepningsskydd och makrotextur; katalogen läses av Tinkertown | Marklagren till Tinkertown görs och provas i verkstaden |
| T5. Resten | lövark och atlas i verkstaden, alfaverktyg, detaljsteg (frekvens, målad look), varianter och versioner, kontroller, MCP | Alla texturer i projektet kan göras och underhållas i verkstaden |
| G1–G5. AI-flödet | Form → Måla → Material, bildbandet, utkast, prompter efter profil, referenser; se AI-flödet ovan | Krea är ett tydligt eget steg som inte stoppar arbetet |

## Texturens skala på en tillgång (byggd 2026-10-26)

Materialet äger sin verkliga skala (meter per upprepning, `meters` i katalogen) och gäller överallt. En tillgångs recept (ett träd i Smedjan) sparar bara en avvikelse relativt materialet: tiling ×, sträckning längs och runt stammen och förskjutning, som Material Instances i Unreal; trädet har redan `bark_repeat`. Knappen *Use as material default* lyfter en avvikelse till materialet i Ateljén, men bara när man ber om det. Lövkronan är lövkort med en atlas, så där motsvaras skalan av kortens storlek och bladen per kort, i kronans spakar.

Byggt för barken: trädets recept har `bark_uv` (`tiling`, `along`, `around`, relativt materialet; runt avrundas till hela varv så att ingen söm syns), som spakarna Bark tiling, Stretch along och Stretch around under Bark and growth. Materialets skala läses ur katalogen: `meters` för texturer från verkstaden, `scales` för övriga (`make_tree.py`, `material_meters`). Use as material default (`/api/texture/scale`) gör tilingen till materialets skala (katalograden och receptet, eller `scales`) och sätter trädets tiling till 1 igen; sträckningarna stannar på trädet.

## Efter AAA-referensen för procedurella texturer (byggd 2026-10-27)

Granskning mot `patriks_input/AAA_Procedural_Textures_Stylization_ThreeJS_Reference.md`. Motorn hade redan det referensen bygger på: källorna ger färg och höjd ur samma struktur, och normal, ruffighet och AO räknas ur den höjden. Bruset är periodiskt och sömlöst, och recepten går att göra om. Det som lades till:

- **Samma mönster i alla upplösningar:** brus, bark och mark (`lowpass`) drog vitt brus i full upplösning, så förhandsvisningen (512) och den sparade texturen (1024 eller 2048) fick olika mönster. Korrelationen mellan 512 och 2048 var 0,23 för bark och −0,08 för brus. Nu dras slumpen i ett band som bara beror på frekvensen, så korrelationen är 0,996–1,0 för alla källor, och förhandsvisningen tar lika lång tid som förut. Gamla recept med de källorna får ett nytt mönster med samma karaktär; redan sparade PNG-filer påverkas inte.
- **Stylize** (gruppen Style): referensens samordnade stilreglage, från foto mot målat spelmaterial. En styrka styr kantbevarande utjämning (Kuwahara), mikrodetaljer som tonas bort, de stora formerna ur höjden (fogar, sprickor, åsar) som lyfts och mörkas, färre färger (k-means i OKLab med mjuk tilldelning, så att inga trappsteg uppstår), mättnad och en förenklad höjd. Allt går runt kanterna. Ett stilprov vid 0, 0,5 och 1 sänkte högfrekvensen från 0,83 till 0,28 på ett ängsfoto och från 0,32 till 0,04 på ett barkfoto.
- **Remove lighting** (gruppen Style): tar bort inbakat ljus ur foton och AI-bilder genom att dela bort den storskaliga ljusheten och lyfta lokala skuggor. Körs före Stylize.
- **Nya källor:** *Sand, snow and ripples* (vindrippel med lång lovartsida och brant läsida; vågvektorn är heltal, så att ripplen går runt kanterna i alla riktningar; slingrar sig och planar ut i fläckar) och *Cracked ground and ice* (Voronoi-plattor med sprickor av varierande bredd, kanter som böjer upp som i torkad lera, finare sprickor i en del av plattorna).
- **Nya färdiga material:** Sand ripples, Snow drift, Dry mud och Cracked ice under Ground, och gruppen Stylized: Painted stone, Painted bark, Painted cliff och Painted meadow. De två sista utgår från bilder och kör Remove lighting och Stylize.
- **Storebror och lillebror:** Spara har *Big brother* (av, 2048 eller 4096, normalt 2048). Texturen ritas först i den storleken och sparas i `assets/textures/hd/<namn>_hd*.png`. Den vanliga texturen (Size) skalas sedan ned ur den, och normalen normeras om. Lillebrodern blir översamplad, med renare kanter och lugnare mipmaps än om den ritades direkt i låg upplösning, och storebrodern finns kvar för närbilder och vidare arbete. Katalograden får `hd: {size, files}`. Det fungerar bara för att samma recept nu ger samma mönster i alla upplösningar.

Fler färdiga material samma dag: Lava crust (självlysande sprickor), Basalt columns, Snowy cobblestone (snö i fogarna), Riverbed pebbles, Desert dunes, Swamp mud, Autumn forest floor, Weathered wood, Mossy bark, Temple tiles och Glowing moss (självlysande). Sparade som texturer: `rock_stylized` (bergyta för stenarna), `bark_stylized` och `bark_mossy` (för träden), alla med storebror i `hd/`.

## Frågor till Patrik

0. ~~Drakstatyn~~: beställd från Tripo P2 (`assets/imported/dragon_statue`), används i labbet.

1. **Terrängen:** ska verkstadens lagerregler (lutning, höjd, fukt) kunna sparas direkt som biomregler i Tinkertown, eller räcker det att texturerna och deras höjdkartor delas?
2. **Extern generator:** räcker OpenRouter (som Apparition), och finns det en modell du föredrar? Varje körning bekräftas med pris.
3. **Ordning:** T1 först (procedurellt och bildbehandling), eller vill du ha Krea i verkstaden tidigt (T2)?
4. **Blandningen:** ska den gemensamma lagerstacken (T4) ersätta barkens och stenarnas nuvarande blandning direkt, eller leva bredvid tills den är klar?
