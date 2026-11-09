# Character creator: ett nät, reglage, och AI som visar vart reglagen ska

Plan 2026-11-09, efter samtal med Patrik. Inget är byggt än.

## Målet

Patriks mål för modellgeneratorerna: lära upp dem en gång och sedan göra nya modeller snabbt, helst matematiskt, ur en
algoritm. Maren och frostsystern ser olika ut men är nästan samma: båda är kvinnor. Det som skiljer är kläder, hår och
proportioner (Maren är lite kraftigare). Män skiljer sig från kvinnor främst i kroppsform, könsorgan och bröstmuskler i
stället för bröst. Det är samma nät där vissa punkter har flyttats.

Det är så MakeHuman och MPFB fungerar: ett grundnät för alla människor, och reglage (morph targets) som flyttar punkterna.
Kön, ålder, vikt, muskler, längd, proportioner, byst och bröstmuskler är alla reglage på samma topologi, UV-karta och skelett.
MPFB 2.0.18 och de fria CC0-paketen är redan installerade ([[mpfb-installed]] i minnet). Det är också det
[character-generator.md](character-generator.md) avsnitt 5 beskriver: samma topologi inom en ras, och reglage för kropp
och ansikte.

## Varför inte bara bättre automatisk topologi

- **Pixal3D + UltraTex + `make_low.py`** (i dag) ger snygga, lätta modeller, 12 000 trianglar på några minuter. Men varje
  modell har sin egen topologi: ingen gemensam rigg, UV-karta eller kläder, och inga reglage.
- **QuadriFlow eller Instant Meshes** ger fyrhörningar, men också där får varje modell sin egen topologi. Blenders QuadriFlow
  vägrade dessutom frostsysterns nät (se [ultratex-4b.md](ultratex-4b.md)).
- **Ett gemensamt nät** tar några dagar att bygga en gång. Sedan går varje ny figur på minuter, och topologin görs en gång för
  hand eller av MakeHuman, inte för varje modell. Det är svaret på "en egen Tripo P2".

## Delarna

1. **Grundnätet.** MPFB:s nät (hm08, CC0) är en topologi för kvinnor och män. Spelupplösningen, ca 12 000 trianglar, blir en
   proxy med samma reglage: MPFB:s egna eller body-gens nivå s, med Yvonne som grundkropp för kvinnor.
2. **Reglagen.** MPFB:s mål (kön, ålder, vikt, muskler, längd, proportioner, byst, bäcken och ansiktsdelar), och egna mål
   senare. Ett recept är en lista med reglagevärden, alltså en rad JSON, som de andra generatorerna.
3. **Inpassning, AI:ns nya roll.** Pixal3D (eller en Krea-bild) visar hur figuren ska se ut. Ett optimeringssteg letar fram de
   reglagevärden som gör grundnätet likt Pixal3D-formen: avstånd i 3D och silhuetter från samma kameror, i samma A-pose.
   Det som reglagen inte når sparas som en liten egen förskjutning per punkt, ett personligt mål.
4. **Lager.** Hår ingår aldrig i figuren när den skapas (Patrik, 2026-11-09). Koncepten görs skalliga, så att ansikte, öron
   och skalle blir rena. Håret kommer från en hårgenerator byggd som trädgeneratorn:
   - Styrkurvor från hårbotten är skelettet. Frisyren är ett recept (knut, hästsvans, fläta, kort, långt).
   - Kurvorna kläs med chunky skulpterade lockar och hårkort.
   - Färg och slingor är spakar.
   - Håret sitter på grundnätets hårbotten, så en frisyr passar alla.
   - MPFB:s CC0-frisyrer kan användas tills generatorn finns.
   Övriga lager:
   - Kläder är egna nät som följer kroppen: MPFB:s klädproxies eller en egen klädgenerator, som byggnadsgeneratorns delar.
   - Ögon och ögonbryn också.
   - Allt följer reglagen, eftersom det sitter på samma nät.
5. **Textur.** UltraTex målar på den gemensamma UV-kartan. En hudtextur kan återanvändas mellan figurer och detaljeras per figur.
6. **Rigg och animation.** MPFB:s game_engine-skelett = Quaternius UAL-benen ([[animation-route]]). En gång för alla figurer.

## Tillägg efter ChatGPT:s genomgång (2026-11-09)

ChatGPT föreslog samma väg: Pixal3D som skulptör och en mall med färdig topologi som lindas runt. Det som var nytt och
värt att ta med:

- **Inpassning i två omgångar, inte ren shrinkwrap.** Först grovt: reglagen (MPFB) och anatomiska landmärken (ögonvrår,
  mungipor, nästipp, haka, axlar, armbågar, knän, anklar). Sedan lokalt mot Pixal3D-ytan, med en regularisering som
  bevarar mallens form och slingor (Laplace eller as-rigid-as-possible), så att fingrar, armhålor och mun inte förstörs.
- **Landmärken automatiskt.** Rendera Pixal3D-modellen framifrån och från sidan, hitta punkterna i 2D med en fri
  landmärkesmodell (till exempel MediaPipe Pose och Face Mesh, Apache 2.0) och skjut strålar tillbaka till ytan.
- **Deformationstest som kontroll (`checks.ok`).** Den riggade figuren höjer armarna, böjer armbågar och knän, sätter sig
  på huk och öppnar munnen. Testet mäter töjning, volymförlust och självskärningar och fångar dåliga figurer före export.
- **Budget per kroppsdel** som kontroll, startförslag för 10 000 trianglar: huvud 2 200, bål 2 000, armar och händer
  1 800, ben och fötter 2 200, hår 1 200, övrigt 600.
- **Verktygen** (kontrollerade 2026-11-09):
  - **BWrap** (skalin.org) lindar en mall med motsvarande punkter. Gratisversionen tar högst 50 punkter och ger 256 px
    texturer, den fulla kostar 29,99 EUR. Inget skript-API är beskrivet, så den passar inte ett automatiskt flöde. Vi
    bygger inpassningen själva.
  - **ReQuad** (github mlstr0m/requad) är QuadWild bi-MDF som Blender-tillägg. Licens GPL-3.0 (verktyget, inte de nät
    det gör), kör utan fönster i `blender -b`. Mycket nytt (3 stjärnor). Kandidat för kläder, hår och props i stället för
    QuadriFlow, som vägrade.
  - **Instant Meshes** (BSD) är också en kandidat för samma delar.
  - Ingen av dem ger slingor för ansikte och leder. Det gör mallen.

## Första steget

**Kusinen** (A-pose, baddräkt, slät kropp nära grundnätet) är det perfekta första testet. Passa in MPFB:s kvinnokropp efter
hennes Pixal3D-form, mät avståndet, baka UltraTex-texturen på den gemensamma UV-kartan och jämför med
Pixal3D-versionen i Compare. Därefter Maren (kläder som lager) och en man (könsreglaget).

## Tid

- **Bygga en gång:** inpassningen och spelupplösningen tar några dagar, lagren är ett eget spår.
- **Per figur sedan:** några minuter för inpassning och bakning. Pixal3D och UltraTex blir hjälpmedel och inte slutprodukt.
