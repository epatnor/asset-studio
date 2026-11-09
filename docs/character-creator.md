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
4. **Lager.**
   - Kläder är egna nät som följer kroppen: MPFB:s klädproxies eller en egen klädgenerator, som byggnadsgeneratorns delar.
   - Hår är egna nättyper: knut, hästsvans, fläta.
   - Ögon och ögonbryn också.
   - Allt följer reglagen, eftersom det sitter på samma nät.
5. **Textur.** UltraTex målar på den gemensamma UV-kartan. En hudtextur kan återanvändas mellan figurer och detaljeras per figur.
6. **Rigg och animation.** MPFB:s game_engine-skelett = Quaternius UAL-benen ([[animation-route]]). En gång för alla figurer.

## Första steget

**Kusinen** (A-pose, baddräkt, slät kropp nära grundnätet) är det perfekta första testet. Passa in MPFB:s kvinnokropp efter
hennes Pixal3D-form, mät avståndet, baka UltraTex-texturen på den gemensamma UV-kartan och jämför med
Pixal3D-versionen i Compare. Därefter Maren (kläder som lager) och en man (könsreglaget).

## Tid

- **Bygga en gång:** inpassningen och spelupplösningen tar några dagar, lagren är ett eget spår.
- **Per figur sedan:** några minuter för inpassning och bakning. Pixal3D och UltraTex blir hjälpmedel och inte slutprodukt.
