# Plan: Texturverkstaden

Status: T1 byggd 2026-10-25 (fliken Texturer i studion, `tools/texture/workshop.py`, `tools/texture/workshop.json`, `studio/workshop.js`); resten är plan. Skriven 2026-10-25. Bor i Asset Studio ([asset-studio.md](asset-studio.md)) men är projektets gemensamma texturkälla: den försörjer tillgångarna i studion, terrängen och marken i Tinkertown 2, gräset, byggnaderna och allt annat som behöver texturer.

## Varför

Texturerna avgör hur mycket av stilen som når fram: barken, lövarken, stenarnas mossa, markytorna. I dag görs de genom att Patrik beskriver och Claude kör verktyg. Verkstaden låter Patrik själv ta fram och justera texturer med spakar, se dem på en tillgång direkt och spara dem till samma bibliotek som studion använder.

## Vem använder texturerna: målprofiler

Verkstaden är inte bara till för studions tillgångar. Varje textur sparas med en **målprofil** som säger vad den är till för, vilka kartor som ska med och vilken skala den har i världen. Den som använder texturen (studion, terrängen, gräset, byggnadsgeneratorn, Tinkertown 2) läser profilen ur samma katalog.

| Profil | Används av | Kartor och krav |
|---|---|---|
| `bark` | träd och stubbar (studion, props) | färg, normal; sömlös i båda led; meter per upprepning längs stammen |
| `leaves` | lövkort, kortbollar | 2×2-atlas med alfa, bleed, ingen halo; gråskala eller färg |
| `terrain` | terrängens marklager i Tinkertown 2, ytorna i `make_surface.py` | färg, normal, **höjd** (för höjdbaserad blandning mellan lager); sömlös; meter per upprepning; låg upprepningskänsla över stora ytor |
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

## Källor

### Fasta algoritmer (procedurellt, sekunder, inga GPU-jobb)
| Källa | Spakar |
|---|---|
| Brus | typ (värde, Perlin, simplex, Worley/cellulärt, fBm), skala, oktaver, skärpa, frö |
| Bark | antal fåror, djup, slingrighet, plattor mellan fårorna, sprickor, frö |
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

## Terräng och stora ytor

Marken i Tinkertown 2 täcker stora ytor, där upprepning och skarvar mellan lager syns mest. Verkstaden får därför egna verktyg för profilen `terrain`:

- **Upprepningsskydd:** förhandsvisning över 50 × 50 m, där mönster som upprepas syns. Steg som minskar det: stokastisk tiling (texturen delas i plattor som slumpas och vrids, "texture bombing" eller hex-tiling i shadern), en makrotextur ovanpå, och varianter av samma lager som blandas med brus.
- **Höjdbaserad blandning mellan marklager:** varje lager har en höjdkarta, så att gräs växer upp mellan stenarna i en stig i stället för att tonas in som en dimma. Spak för hur skarp övergången är.
- **Lagerregler som i biomerna:** förhandsvisning på en terrängbit med kullar, där lagren läggs efter lutning (brant blir berg), höjd och fukt med spakar, samma regler som Tinkertown 2:s biomer. Det man ställer in kan sparas som en biomregel.
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

- Sparade texturer hamnar i `assets/textures/` med receptet bredvid (`<namn>.texture.json`), en miniatyr och en rad i texturkatalogen `assets/textures/catalog.json` (namn, profil, kartor, meter per upprepning, taggar). Katalogen läses av studions texturväljare, av generatorerna och av Tinkertown 2 (som redan serverar `assets/` under `/tinkertown/assets/`). Taggar: bark, sten, mark, trä, löv, tak.
- "Fler varianter": samma recept med nya frön. Versioner: att spara över behåller den förra versionen.
- Kontroller i svaret, som generatorernas `checks`: sömlöshet (skillnad över kanterna), vit halo, avvikelse från paletten, för mycket högfrekvent brus (mot stilguiden), upplösning och filstorlek.

## I studion

- En ny flik i headern: **Texturer**. Layout: källan och stegen som kort till höger (lägg till steg, dra för att flytta, slå av och på), förhandsvisningen i mitten (2D, avstånd eller 3D), och kontroller och siffror i footern.
- Texturväljaren i studions kort får knappen **Öppna i verkstaden**, som öppnar den valda texturens recept, och **Ny…**, som börjar ett nytt recept av rätt slag (bark, lövark, sten ...).
- MCP-verktyget `texture_recipe` låter AI:n köra och ändra samma recept, och en knapp **Be Claude** föreslår steg eller en prompt utifrån vad man vill uppnå.

## Faser

| Fas | Innehåll | Klart när |
|---|---|---|
| T1. Grund | `workshop.py` med recept; procedurella källor (brus, bark, sten, tegel, plankor) och import; stegen tile, levels, hsv, palette, gray, soften, scale; fliken Texturer med 2D-vy, zoom och 3×3-tiling; spara till biblioteket | Patrik kan göra och spara en sömlös bark eller sten med spakar |
| T2. Generativt | Krea text till bild och bild till bild från en procedurell bas, med varianter och jobbkö; extern generator med pris och bekräftelse | Målade texturer med kontrollerad form, utan att be Claude |
| T3. Kartor och 3D | höjd, normal, AO, ruffighet; 3D-förhandsvisning på former och på aktuell tillgång, med meter per upprepning; avståndsvyn; målprofiler och texturkatalogen | Texturen går att bedöma där den ska användas |
| T3b. Terräng | profilen `terrain`: förhandsvisning på en terrängbit med lagerregler (lutning, höjd, fukt), höjdbaserad blandning, upprepningsskydd och makrotextur; katalogen läses av Tinkertown 2 | Marklagren till Tinkertown 2 görs och provas i verkstaden |
| T4. Blandning | lagerstacken med masker (riktning, höjd, höjdkarta, brus, krökning, vertexvikt) i klientens shader, styrd och förhandsvisad i verkstaden; ersätter `bark_blend` och stenmossan | Mossa på norrsidan och snö uppifrån med spakar |
| T5. Resten | lövark och atlas i verkstaden, alfaverktyg, detaljsteg (frekvens, målad look), varianter och versioner, kontroller, MCP | Alla texturer i projektet kan göras och underhållas i verkstaden |

## Frågor till Patrik

1. **Terrängen:** ska verkstadens lagerregler (lutning, höjd, fukt) kunna sparas direkt som biomregler i Tinkertown 2, eller räcker det att texturerna och deras höjdkartor delas?
2. **Extern generator:** räcker OpenRouter (som Apparition), och finns det en modell du föredrar? Varje körning bekräftas med pris.
3. **Ordning:** T1 först (procedurellt och bildbehandling), eller vill du ha Krea i verkstaden tidigt (T2)?
4. **Blandningen:** ska den gemensamma lagerstacken (T4) ersätta barkens och stenarnas nuvarande blandning direkt, eller leva bredvid tills den är klar?
