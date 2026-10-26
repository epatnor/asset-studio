# Plan: Effektlabben – Väderkvarnen (vind, vatten, väder) och Häxkitteln (spelets effekter)

Skriven 2026-10-26; delad i två avdelningar samma dag (se [avdelningar.md](avdelningar.md)): **Väderkvarnen** (blå) har miljön som alltid finns i världen, **Häxkitteln** (lila) spelets effekter som utlöses av händelser. Väderkvarnen har tre flikar i Asset Studio. Varje flik har en **grundscen** att prova effekterna i, spakar för allt, och sparar det man är nöjd med som recept (vindprofil, vattentyp, väderläge) som studion, visningen och Tinkertown läser. Det är samma tanke som texturverkstaden: effekterna är gemensamma moduler som alla objekt och alla klienter delar, inte något varje bana gör själv.

## Vad som finns

| Del | Var | Teknik |
|---|---|---|
| Vind på träd och växter: hörnen skjuts i sidled med en vikt (`_WIND`), utan hierarki | `showcase/materials.js` | GLSL (WebGL) |
| Gräs med byar som rullande vågor; egen vindriktning | `showcase/grass.js` | GLSL |
| Vattengeneratorn: dammar, sjöar, bäckar, åar, floder och hav som recept (`basin`, `channel`, `sea`), gräver gropar och fåror | `showcase/water.js`, `showcase/water.html` | WebGL |
| Atmosfär och väder: himmel, sol och måne, dygn, volymetriska moln, regn, snö, storm med blixtar, färgton | `showcase/atmosphere.js` | WebGL |
| Bildeffekter: dimma, markdimma, molnskuggor, volymetriskt solljus, glöd | `showcase/effects.js` | WebGL |
| Havet i Tinkertown: Gerstner-vågor, färg efter djup, strandvågor, skum | `../tinkertown/client/src/world/ocean.js` | TSL (WebGPU) |

Problemet: samma sak finns i två versioner (WebGL i studion och visningen, WebGPU/TSL i Tinkertown), och vinden är inte gemensam (gräset, träden och havet har var sin).

## Grundprincip: gemensamma effektmoduler i TSL

Effekterna skrivs en gång, i TSL (three.js nodspråk), i `shared/effects/`. TSL kompileras till WebGPU och faller tillbaka på WebGL2, så samma kod körs i studions nya flikar, i visningen och i Tinkertown (som läser filerna via `/asset-studio/`, på samma sätt som `assets/`). Flikarna använder WebGPURenderer, som texturverkstadens labb har en egen renderare. De befintliga WebGL-modulerna flyttas över en i taget och tas bort när visningen läser de nya.

| Modul | Gör |
|---|---|
| `wind.js` | Vindfältet (riktning, styrka, byar som rullande vågor, tid) och deformationen för vindriggen (nedan) |
| `water.js` | Vattenytor efter typ: färg och absorption efter djup, strandkant, skum, flöde, vågor, reflexer, brytning, kaustik och krusningar |
| `weather.js` | Himmel, sol och dygn, moln, nederbörd, våta ytor, snö på uppåtvända ytor, dimma och blixtar; styr vindens styrka |
| `vfx.js` | Häxkittelns effekter: glöd och auror, markörer som dekaler på marken, partikelsystem på grafikkortet, spår och träffar |

Alla tre läser samma tid och samma vind, så att ett oväder gör att träden böjer sig, gräset rullar och vågorna växer samtidigt.

## Fliken Vind

**Vindriggen** (`tools/wind/`, verktygsmönstret, körs av generatorerna innan de skriver sin glTF):
- In: delarna som en hierarki (fäste, riktning, längd, radie, förälder, vilka hörn som hör till delen). Träd: stam → grenar → klasar och kort. Växter och blommor: stjälkar från marken → blomhuvud och blad. Byggnader och props: flaggor, rankor och lyktor med fäste i huset. Importerade modeller utan hierarki får en enkel rigg (ett fäste i marken, böjning efter höjden).
- Riggen räknar fram luftmotstånd (ytan som delen och dess barn bär), styvhet (radie⁴ / längd³), böjning och svängningstakt per del, och fladder för blad och kort. Kronan drar alltså i grenen och grenen i stammen, och det som sitter i marken står still.
- Ut: en liten deltabell i glTF-filens extras och ett delnummer per hörn, plus `checks`: inget slits isär, ingen vind ger exakt viloläget, inget i marken rör sig.

**Deformationen** roterar uppifrån och ned i hierarkin (fladder, gren, föräldragren, stammens böjning), så att inget sträcks ut. Gräset använder samma vindfält och böjs med rotation.

**Gräset** (`shared/effects/grass.js`, byggt 2026-10-26, i stil med Ghost of Tsushima och Genshin Impact): hundratals strån per m² nära kameran (gläntan cirka 300 000), i rutor med två detaljnivåer, glesare och bredare på avstånd. Varje strå är en båge med konstant krökning, så att det behåller sin längd när vinden böjer det; stråna växer i tuvor och lutar ut från mitten. Färgen går från en mörk bas till en ljus topp, med stora fläckar (varmare och gulare, mörkare och blågrönare), och normalerna är kupade och lutar mot uppåt så att ängen skuggas som en yta. Genomlysning i motljus och en glans där byarna går. Det som står i gläntan (`clear` i `wind.json`) får inget gräs runt foten, och blommorna (`short`) kortare gräs. Parkens gräs (`showcase/grass.js`) och Tinkertown går över till modulen i E2.

**Gräset som recept** (byggt 2026-10-26): gräset ligger mellan textur och spelobjekt, så det är ett eget recept med spakarna i `tools/grass/grass.json`, i Väderkvarnens kort Grass colour (rot, mitt, topp och torr färg, torra fläckar, fläckarnas kontrast och storlek, tuvornas variation, mörkt vid roten, genomlysning), Grass shape (längd lågt och högt, bredd, avsmalning, böj och dess variation, hur tuvorna sprider sig, tuvornas storlek, styvhet, täthet) och Grass waves. Allt utom tuvornas storlek är uniforms och ändras direkt. **Vågorna** är gräsets egna band som rullar med vinden ovanpå byarna: hur långt stråna böjs och hur mycket de glänser, avståndet mellan banden, fart, skärpa (mjuka dyningar eller smala ljusa band) och uppbrytning (raka eller vågiga fronter). Färdiga gräs i lådan: Meadow, Lush (Genshin), Pampas (Tsushima), Lawn och Dry steppe; egna sparas i `assets/grass/<namn>.grass.json` tillsammans med blomklungorna.

**Flaggan** (byggd 2026-10-26): en svensk flagga målad av GPT Image 2 (vävd bomull, fransar i den fria kanten, cirka 0,6 cent), urklippt med `post_textures.py matte` (alfa ur den vita bakgrunden, bildens proportioner, hål inne i tyget fyllda) till `assets/textures/flag_sweden.png`. Tyget är en riktig tygsimulering (`shared/effects/cloth.js`): implicit integration efter Baraff och Witkin, "Large Steps in Cloth Simulation", portad från Thom Chiovolonis tygdemo (MIT, licensen i filen), med 22 × 14 partiklar, fjädrar för sträckning (stum), skjuvning och böjning (mjuka, så att tyget veckar sig och hänger), fäst stångkant, riktig massa och vinden ur vindfältet (`wind.velocityAt`, tryck längs normalen och friktion längs tyget, turbulens som växer med farten). Provat i Node: hänger cirka 60° i stiltje, 48° vid 2 m/s, 28° vid 5 m/s och 10° vid 15 m/s, töjning under 2 %, cirka 1,6 ms per steg. Klicka och dra i flaggan för att dra i tyget. Den uträknade flaggan finns kvar som `wind.flag(L, H)` för klienter som vill ha en billig flagga: den svarar som en blomma på svag vind: hänger längs stången i stiltje och lyfts mot vågrätt när det blåser, mest ytterst; vågor löper från stången mot den fria kanten med utslag som växer mot kanten och med byarna, en svagare våg korsar dem, vecken tar längd från bredden och fransarna rycker snabbt. Normalerna räknas ur den veckade ytan. Med `?shot=<namn>` i adressen sparar Väderkvarnen en bild när gläntan har laddat (`build/shots/studio_<namn>_webgpu.png`), för att kunna se fönster på RTX-kortet.

**Svar på svag och stark vind** (byggt 2026-10-26): tunga och lätta saker svarar olika på vindstyrkan S. Kraften går som S^(2 + separation · d) och svängningen som S^(1 + separation · d), med d per slag (`RESPONSE` i `wind.js`): träd 0,4 och 0,8, buskar 0,1 och 0,3, blommor och växter −0,6 och −0,2, gräs −0,9 och −0,3. Med spaken Size separation = 1 får gräset i stiltje (S = 0,12) ungefär 16 gånger trädens kraft och 10 gånger deras svängning; i storm (S = 1) är alla lika, så riggens kontroller gäller som förut. Långa strån böjer mer (ungefär längden^0,6 mot ett strå på 30 cm), så pampas rör sig mer än gräsmatta. Gläntan ger varje modell sitt slag: växtgeneratorns växter är växter, trädgeneratorns modeller under 2,5 m buskar, resten träd.

**Marken under gräset** (byggd 2026-10-26): kortet Ground väljer en marktextur (Ground texture, med skala och ljushet) som fyller luckorna mellan stråna, särskilt när man ser ned i gräset, och reglaget Grass root color (Follow ground texture color) låter varje strå ta rotfärgen från marken där det står (samma koordinater som marken, en suddig mipnivå). Fem marker gjordes med GPT Image 2 via OpenRouter (cirka 4 cent för alla) och gjordes sömlösa med `post_textures.py tile`: `ground_meadow`, `ground_lush`, `ground_pampas`, `ground_lawn` och `ground_steppe`, en till varje färdigt gräs; texturerna `surface_*` går också att välja.

**Blomklungor:** kortet Flowers slumpar ut klungor av växter från växtgeneratorn (prästkrage, smörblomma, vallmo, blåklint, lupin, lavendel, tulpan, gräs med frö, fjädergräs, vete, ormbunke): antal klungor, växter per klunga, klungans storlek, växternas storlek, hur blandade klungorna är, område och frö (New scatter). Varje art byggs riggad i tre frön av servern (`/api/wind/plant`, `build/wind/plants/`) och ritas instansierat: en ritning per art, frö och del, där riggen räknas i växtens rum och placeras sist (`iPlace` och `placedNormal` i `wind.js`). Gräset blir kortare i klungorna. 96 blommor och cirka 300 000 strån gick i 60–65 fps i webbläsarpanelen.

**Grundscenen:** en glänta med ett par träd av olika arter ur biblioteket, buskar, blommor, en gräsplätt och en flagga, med en vindpil. Spakar: styrka, riktning, byar (våglängd, fart, styrka), fladder; slow motion; felsökningsvy som färgar per del och visar fästen. Vindprofiler sparas som recept (bris, blåsigt, storm).

## Fliken Vatten

**Grundscenen:** en testbassäng i terräng med alla sorters vatten bredvid varandra: en damm, en sjö med sluttande strand, en bäck och en å i en fåra med fall, ett vattenfall från en klippa, en strand mot hav och en pöl. Vattengeneratorns recept (`basin`, `channel`, `sea`) bygger dem; något som flyter och något som går i vattnet visar krusningar.

**Spakar per vattentyp:** färg i grunt och djupt, absorption och klarhet, strandkantens mjukhet, skum (vid strand, vid fall, i strömt vatten), flödets fart och riktning, vågor (höjd, längd, vind), reflexer (himmel, skärmrymd), brytning, kaustik på botten och krusningar. Typer att spara som recept: damm, sjö, bäck, å, flod, vattenfall, hav, träsk, pöl, is.

## Fliken Väder

**Grundscenen:** en liten plats med ett hus, några träd, mark, en pöl och lite vatten, så att alla effekter syns på riktiga ytor.

**Spakar:** tid på dygnet; molntäcke och molnsort; regn (täthet, droppstorlek, stänk, våta ytor som mörknar och blir blanka); snö (fall och snö som lägger sig på uppåtvända ytor); dimma och markdimma; storm med blixtar; vindens styrka och byar (vindmodulen); färgton. Väderlägen sparas som recept (klart, mulet, regn, storm, snö, dimma) och kan blandas över tid.

## Häxkitteln: spelets effekter

Fyra flikar med en gemensam grundscen: en liten arena med en figur (stand-in tills karaktärerna är klara), en träningsdocka, mark i några material och en lykta. Knappar spelar upp effekten en gång, i loop eller på den valda figuren.

- **Glöd och aura:** glödkanter, pulserande ljus och auror runt figurer och föremål, med bildeffekternas glöd (bloom).
- **Markörer:** valringen runt vald spelare, målmarkörer, områden för förmågor och utropstecken, projicerade på terrängen som dekaler som följer sluttningar och inte lägger sig på gräset.
- **Partiklar:** gnistor, rök, magi, löv som virvlar, damm vid fotsteg. Ett partikelsystem är ett recept (utsändare, form, takt, livslängd, färg och storlek över tid, rörelse, textur), räknat på grafikkortet; byarna kan driva partiklarna med Väderkvarnens vind.
- **Spår och träffar:** svärdsspår, projektiler med svans och träffeffekter som kombinerar delarna ovan.

Texturerna (flipbooks, gnistor, rökmoln, runor) görs i Ateljén, gärna med Krea. Effekterna är recept i Skattkammaren, och Tinkertown spelar upp samma recept med `shared/effects/vfx.js`.

## Faser

| Fas | Innehåll | Klart när |
|---|---|---|
| E1. Fliken Vind | Vindriggen (W1) i träd- och växtgeneratorn; `shared/effects/wind.js`; fliken med gläntan, spakar och felsökningsvyn; gräset böjs med rotation och läser samma vind | Ett träd böjer sig från roten, grenarna svajar på sina fästen och blommorna nickar, i samma byar som gräset (byggd 2026-10-26) |
| E2. Vinden i alla klienter | Visningen och Tinkertown läser vindmodulen (batchar, instansierade växter och impostors); vinden blir ett lager i Tinkertowns värld som havet delar; flaggor, rankor och lyktor riggas | Samma vind överallt |
| E3. Fliken Vatten | `shared/effects/water.js` från visningens vattengenerator och Tinkertowns hav; bassängen med alla typer; vattentyper som recept | Alla sorters vatten provas och sparas i en scen |
| E4. Fliken Väder | `shared/effects/weather.js` från visningens atmosfär och effekter; platsen; väderlägen som recept | Väderlägen provas och sparas, och styr vind och vatten |
| E6. Häxkitteln | `shared/effects/vfx.js`; arenan; glöd och aura, markörer, partiklar, spår och träffar som recept | Spelets effekter görs och provas i studion och spelas upp i Tinkertown |
| E5. Export | vindriggen i ett format som Pivot Painter i Unreal, Godot och Unity kan läsa; recepten dokumenterade | Effekterna följer med ut ur projektet |
