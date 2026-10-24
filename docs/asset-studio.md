# Plan: Asset Studio (först trädgeneratorn)

Status: plan, inget byggt. Skriven 2026-10-25.

## Varför

Hittills har Patrik beskrivit i ord vad som ser bra ut, och Claude har tolkat, byggt varianter, fotograferat och lagt upp bilder. Det är långsamt och tappar nyanser. Med en studio drar Patrik själv i spakarna och ser trädet direkt, gör nya texturer med en knapp och sparar det han är nöjd med till ett bibliotek. Claude bygger då generatorerna och spakarna, inte varje enskilt träd.

Samma studio blir prototypen till en generell tillgångsverkstad: stenar, props, växter, husdelar. Varje generator beskriver sina spakar som data, och studion bygger panelen utifrån det.

## Grundprincip

Studion följer arkitekturen i README: **klient** (Three.js-sida) och **lokal server** (Node) som pratar via ett eget API. Klienten kör aldrig verktygen själv.

```
Studio (webbsida)  ──API──>  Studioserver (Node, localhost)  ──>  generatorerna (make_tree.py, make_leafsheet.py, krea2 ...)
     │                              │
     └── visar GLB, reglage          └── skriver assets/, build/, biblioteket
```

Ett träd tar i dag cirka 0,7 s från recept till färdig GLB (uppmätt), och själva generatorn cirka 0,5 s. Det räcker för att bygga om trädet när man släpper en spak. Medan spaken dras visas det förra trädet, och efter en kort paus byggs ett nytt. Behövs det snabbare senare kan förhandsvisningen hoppa över komprimeringen.

## Delar

### 1. Spakar som data (kontraktet)

Varje generator får en **parameterbeskrivning** (`tools/<område>/params.json`): vilka spakar som finns, i vilka grupper, med etikett på svenska, typ, min, max, steg, standardvärde och en kort förklaring. Studion bygger panelen automatiskt utifrån den. En ny generator, till exempel stenar, behöver bara en egen `params.json` för att synas i studion.

Spaktyper: tal (reglage), heltal, av/på, val (lista), färg, frö (med tärningsknapp) och textur (väljare med miniatyrer och knappen "Ny ...").

Förslag på grupper för träd (samma namn som i koden inom parentes):

| Grupp | Spakar |
|---|---|
| Art och form | art (preset), höjd, frö, storlek |
| Stam | längd, tjocklek, krokighet (gnarl), vridning (twist), böj (bend), utsvängning vid roten (flare), rötter, flikar (lobes) |
| Grenar | antal per nivå, vinkel, längd, startpunkt, gravitation |
| Krona | antal klasar (clusters), bollstorlek (ballScale), minsta boll, kort per m² (cardsPerM2), kortstorlek (cardSize), spridning (cardOffset), korttyp (enkla / treor / hängande / draperi), spetsbollar (tipBall, tipCover) |
| Draperi | armar, lyft, häng, längd, bredd (bara synlig när korttypen är draperi) |
| Ljus och färg | lövfärg (leaf_tint), normaler (boll / rena boll / krona), inre ton, sval undersida, gröna grentoppar (barkTip) |
| Texturer | lövark, bark |
| Avancerat | resten, hopfällt |

Spakar som bara gäller i klienten (genomlysning, glans, kantuttoning, skugga på löv) ändras direkt i visningen utan att trädet byggs om.

### 2. Studioserver (`tools/studio/server.mjs`)

En liten Node-server som `shot_server.py` men med API. Ersätter den på sikt.

| Anrop | Gör |
|---|---|
| `GET /api/generators` | Lista generatorer och deras `params.json` |
| `POST /api/generate` | Bygg en förhandsvisning från ett recept, svara med modellens adress, `checks` och siffror (trianglar, alfatrianglar, silhuett, kort) |
| `POST /api/texture` | Starta ett texturjobb: lövark (procedurellt, några sekunder) eller Krea-bark/-löv (cirka 1–3 min) |
| `GET /api/jobs/:id` | Jobbets status och resultat (studion frågar eller lyssnar med SSE) |
| `GET /api/textures?kind=bark` | Befintliga texturer med miniatyrer |
| `POST /api/library` | Spara: recept, modell, miniatyrbild (från studions canvas) och taggar till biblioteket |
| `GET /api/library` | Bibliotekets katalog |

Förhandsvisningar hamnar i `build/studio/` och städas bort. Bara det som sparas hamnar i `assets/`. Texturjobb körs ett i taget på grafikkortet (8 GB). Servern kontrollerar att ComfyUI är igång och säger till annars.

### 3. Studion (`studio/index.html`)

- **Vy:** samma ljus, himmel och lövshader som visningen (`showcase/materials.js`, `world.js`), orbit och förstapersonsläge med musdrag. Mark med skugga, så att skuggformen syns.
- **Panel:** spakarna från `params.json`, grupperade och hopfällbara. MVP: lil-gui (finns redan i three/addons och kräver inget bygge). Senare en egen panel i husets stil.
- **Siffror och kontroller:** `checks.ok` som grön eller röd lampa, trianglar och alfatrianglar per LOD, silhuett, antal kort och bollar. Varningar på svenska, till exempel "3 kvistar sticker ut".
- **Jämför:** "Fäst" lägger det aktuella trädet bredvid, så att det går att jämföra A och B (det vi gjort med uppställningar hela tiden). Ångra och gör om för spakändringar.
- **Debugvyer** (enligt vegetationsguidens acceptanstest): trådram, bara korten, normaler, bollarna, skuggformen och LOD-nivå.
- **Texturer:** under spaken "lövark" finns knappen "Nytt lövark…", som öppnar arkets egna spakar (form, antal löv, storlek, kvistar, layout, kärna, läge) med direktvisning av arket. Under "bark" finns "Ny bark…" med en promptruta, frö och kontrastspak (`soften`). Krea-jobb visar förlopp.
- **Spara:** namn, taggar (art, biom, årstid) och knappen "Spara till biblioteket". Miniatyren tas från vyn.

### 4. Biblioteket (`assets/library.json`)

En katalog med en rad per tillgång: namn, typ (träd, buske, sten ...), taggar, miniatyr, sökväg till modell och recept, skapad, och vilken generatorversion som gjorde den. Recepten är fristående, så att en tillgång alltid kan byggas om, laddas tillbaka i studion och ändras, eller få fler varianter (samma recept, nya frön). Tinkertown 2 läser samma katalog via `/tinkertown/assets/` för sin biblioteksvy.

Det stämmer med roadmapens "Bibliotek (första version)" och generatorkontraktet (`recipe.json` och miniatyr per tillgång).

### 5. AI:n i samma loop

MCP-servern kan läsa biblioteket och Patriks sparade recept ("gör fem varianter av björken jag sparade i går") och använda samma API som studion. Studion kan senare få en knapp "Be Claude …" som skickar receptet och en fråga.

## Faser

| Fas | Innehåll | Klart när |
|---|---|---|
| 1. Trädstudio (MVP) | Studioserver med `generators` och `generate`; `tools/tree/params.json` för de viktigaste spakarna; studiosida med lil-gui, vy, siffror, Fäst/jämför; Spara till biblioteket (recept, modell, miniatyr, katalograd) | Patrik kan dra i spakarna, se trädet byggas om på under en sekund och spara det |
| 2. Texturer | Lövarkspanel med direktvisning; Krea-jobb för bark och löv med förlopp; kontrastspak; texturväljare med miniatyrer | Nytt lövark eller ny bark utan att be Claude |
| 3. Bibliotek | Biblioteksvy med miniatyrer, sökning och taggar; ladda tillbaka i studion; "Fler varianter" | Sparade träd går att hitta, ändra och variera |
| 4. Fler generatorer | `params.json` för props (stenar, stubbar), växter och byggnadsdelar; studion väljer generator | Samma studio gör stenar och props |
| 5. Hopkoppling | Tinkertown 2 visar biblioteket; Electron-paketering tillsammans med Tinkertown 2 | Det som sparas i studion går att placera i världen |

Det mesta i fas 1 finns redan: generatorerna, visningens ljus och shader, skärmdumpar till miniatyrer och mätvärdena i `checks`. Det nya är servern, `params.json` och panelen.

## Frågor till Patrik

1. **Var ska studion bo?** Förslag: i Tinkertown (tillgångsverkstaden), som en egen sida bredvid visningen. Tinkertown 2 läser bara biblioteket.
2. **Hur många spakar från början?** Förslag: ett urval (tabellen ovan) med "Avancerat" hopfällt, hellre än alla parametrar på en gång.
3. **Panel:** lil-gui för att komma igång snabbt, eller ett eget utseende från början?
4. **Bibliotekets namn och taggar:** räcker art, biom och årstid, eller behövs mer?
5. **Ska en sparad tillgång kunna bli en ny art** (en post i `species.json`) som andra träd utgår från, eller räcker det att varje sparat träd är ett fristående recept?
