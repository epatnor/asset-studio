# Character creator: ett nät, reglage, och AI som visar vart reglagen ska

Plan 2026-11-09, efter samtal med Patrik. Receptverktyget och inpassningens första omgång (reglagen) är byggda, se nedan.

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

## Byggt: receptverktyget (steg 1, 2026-11-09)

`tools/character/human/make_human.py` gör en människa ur ett recept med reglage, på MPFB:s grundnät. Alla figurer delar
topologi, UV-karta och skelett. Reglagen är data i `human_sliders.json` (vänliga namn på engelska ovanpå MPFB:s mål):

- **Makro** (0..1): `sex`, `age` (år, minst 18), `muscle`, `weight`, `height`, `proportions`, `bust_size`, `bust_firmness`.
- **Reglage** (-1..1, negativt drar åt `-decr`, positivt åt `-incr`): axlar, byst, bröstmuskler, midja, mage, höfter,
  stuss, lår, lårmuskler, vader, lårbens- och underbenslängd, överarmar, armmuskler, hals.
- **Fritt:** `targets` (vilket MakeHuman-mål som helst med vikt) och `macro` (råa MPFB-värden).
- **Upplösning:** proxyn `female1605` eller `male1591` efter kön, delad en gång (`subdiv: 1`): ca 12 700 trianglar plus
  ögonen 172. `subdiv: 0` ger ca 3 200.
- **Ut:** `assets/characters/<name>/<name>.glb` (riggad, game_engine, 53 ben) och `<name>_pose.glb` (bakad T- eller
  A-pose, `pose`). Inget hår. Tar ca 3 sekunder.
- **Kontroller:** fötterna på marken, symmetri (speglade punkter mot ytan, 99:e percentilen under 2 mm), budget
  (standard 14 000), riggad, vuxen.

Provfigurerna (kvinna, kraftigare kvinna, man) ligger i `build/human/` och i Darrowmeres galleri under
`characters/creator`. Nästa steg är inpassningen mot kusinens Pixal3D-form.

## Byggt: inpassningen, omgång 1 (reglagen, 2026-11-09)

`tools/character/human/fit_human.py` letar fram receptet som gör grundnätet likt en AI-form (Pixal3D-GLB) och bygger
figuren med `make_human.py`. Ingen punkt flyttas fritt: resultatet är bara ett recept, så topologi, UV och skelett förblir
de gemensamma. Omgång 2 (den lilla personliga förskjutningen per punkt) återstår.

- **Placering:** AI-formen skalas till mallens längd och centreras efter kroppen under axlarna, så att hår och knut inte
  räknas. Riktningen avgörs av fötterna: tårna pekar framåt från smalbenen. Att avgöra den efter bålen gav fel på en man
  med plant bröst, och Patrik såg att figurerna stod åt olika håll.
- **Pose:** armarnas och benens vinkel letas fram med ett rutnät och hamnar i receptet (`pose`, `leg_spread`).
- **Gauss-Newton, 5 varv:** varje reglage är en kolumn. Förflyttning, skala och lutning framåt eller bakåt hör till
  AI-formens placering. Avstånden tas åt båda hållen: mallen mot AI-ytan längs normalen, AI-ytan mot mallens närmaste
  punkt. Händerna räknas inte. Dragningen mot standardvärdena (`reg`, 1e-5) håller reglagen rimliga; 3e-4 låste dem på
  noll, 1e-6 gav orimliga värden utan att passa bättre.
- **Hållningen:** Pixal3D gör figurerna onaturligt framåtlutade, och Patrik tycker att mallens hållning ser bra ut. Lutningen
  räknas därför som AI-formens placering och följer aldrig med in i receptet. En framåtböjd bröstrygg i AI-formen blir kvar
  som fel i bålen, och så ska det vara.
- **Bevis:** `build/human/fit/<namn>/overlay.png`, framifrån och från sidan före och efter (rött = AI, blått = mallen,
  vitt = båda), och mått per område.
- **MPFB-fällan:** `feet_on_ground` flyttar nätet men inte skelettet, så armarna roterade kring bäckenets höjd. Figuren
  ställs nu på marken genom att skelettet flyttas, efter proxyn som exporteras.

| Prov (body-gens Pixal3D-kroppar) | Medel före → efter | Bål | Ben | Armar | Huvud |
|---|---|---|---|---|---|
| Man (`body_male_swim`) | 38,7 → 16,5 mm | 8,9 | 9,0 | 14,2 | 6,8 |
| Kvinna (`body_yvonne`, CFG 3,5) | 35,4 → 17,6 mm | 10,7 | 7,2 | 13,8 | 8,3 |

Kvinnoprovet gjordes först mot `body_female_swim` (1 november, före CFG 3,5). Den kroppen har den extra rumpan fram och en
framåtböjd bröstrygg, och receptet härmade felen. Patrik underkände den, så den är struken som provmål. Armarnas vinkel
framåt (`arm_forward`) kom till efter Yvonne-provet: mallens armar hängde bakom ryggen, och felet i armarna gick från 28
till 14 mm.

Patrik om Yvonne-provet (2026-11-09): kroppen, armarna, magen, ryggen och benen ser bra ut och duger till prov. Kvar:

- **Armhålorna** kläms när armarna vrids från viloläget (vanliga hudvikter). Deformationstestet ska mäta det. Rättningen
  blir korrigerande former eller bättre vikter vid axeln.
- **Fingrarna** sitter ihop i spelnätet female1605: 2–3 bitar nära topparna mot 3–4 i det fulla nätet. Rättningen blir ett
  eget spelnät med en egen budget för händerna, eller händer från det fulla nätet.
- **Ansiktet** är MPFB:s standardansikte, eftersom det inte finns några ansiktsreglage än. Nästa steg är inpassning med
  MediaPipe-punkter (som body-gens `fit_face.py`).

**Kusinen (2026-11-10)** mot sin Pixal3D-form ur 1024-bilden: 45,9 → 30,5 mm i medel (ben 9,7, bål 20,2, huvud 23,4,
armar 34,0). Två rättningar kom ur provet:

- **Reglaget `head_size`** drar MPFB:s `head-scale` i tre riktningar. Stiliserade figurer har större huvuden, och
  kusinen fick +0,22.
- **Höjdförflyttningen är låst.** Båda står på marken. Utan låset sänkte inpassningen AI-formen 10 cm genom golvet för att
  kompensera för huvudet.

Armarna ligger kvar på 34 mm.

Det tar ungefär 25 sekunder. Figurerna och AI-formerna finns i Darrowmeres galleri under `characters/creator`.

## Läget (kväll 2026-11-09)

- **Kusinen:** runda 7 gav hår i alla åtta försök. A/B-provet (`build/characters/cousin/ab_bald.py`) visade att stilorden
  inte var boven. Det var att "bald" kom sent i en lång inledning. **Regel för Krea-2:** motivet först och kort ("bald
  young woman, straight-on front view, body and face square to the camera, ..."), detaljerna efteråt. Alla åtta i E/F blev
  skalliga, rakt framifrån och i T-pose (galleriet `characters/cousin/ab/`). Nästa steg är att välja en bild och köra
  Pixal3D, inpassningen och UltraTex (`run_after.sh`, som behöver peka på den nya ordern).
- **Nästa i creatorn:** omgång 2 (personlig förskjutning per punkt), ansiktet (MediaPipe), ett spelnät med riktiga
  fingrar och armhålor som klarar deformationstestet.

## Första steget

**Kusinen** (A-pose, baddräkt, slät kropp nära grundnätet) är det perfekta första testet. Passa in MPFB:s kvinnokropp efter
hennes Pixal3D-form, mät avståndet, baka UltraTex-texturen på den gemensamma UV-kartan och jämför med
Pixal3D-versionen i Compare. Därefter Maren (kläder som lager) och en man (könsreglaget).

## Tid

- **Bygga en gång:** inpassningen och spelupplösningen tar några dagar, lagren är ett eget spår.
- **Per figur sedan:** några minuter för inpassning och bakning. Pixal3D och UltraTex blir hjälpmedel och inte slutprodukt.

**Body-gen inflyttad (2026-11-10):** mallpassningen med fast topologi finns nu i `tools/character/body/` ([body-generator.md](body-generator.md)). Den sitter tight (sysslingen 0,13 mm mot Pixal3D) där reglagen inte räcker (3–8 cm); nästa steg är samma passning på MPFB-nätet, sparad som shape key ovanpå reglagen.

**I Asset Studio (2026-11-10):** avdelningen The Character Creator (`studio/human.js`) bygger figurer ur reglagen och
kör inpassningen med overlay-bilden; se [asset-studio.md](asset-studio.md#the-character-creator-byggd-2026-11-10).

## Wrap: tight mot AI-formen (2026-11-10)

Efter reglagen drar `fit_blender.py` det nät som exporteras tight mot AI-ytan (som body-gens `fit.py`): proxyn
(female1605/male1591, uppdelad som i `human_blender.py`), inte grundnätet. Första försöket wrappade grundnätet; proxyns
uppdelning krymper formen 1–2 cm (bröstdjup 0,220 m i passningen mot 0,198 m i exporten), så wrapen försvann och figuren
såg ut som MPFB-modellen (Patrik: "uppblåsbar docka"). Mät därför alltid åt båda hållen, yta mot yta, och på det
exporterade nätet; hörn mot yta ensamt såg bra ut fast formen inte täcktes.

Metoden: närmaste punkt med normalkontroll, en utjämning mot grannarna som släpps i fem steg (dragavstånd 10 cm ned till
8 mm), förflyttningen speglad. Händer, fötter och en tunn ring runt ögonen (1,7–2,5 cm från ögats mitt, så att fransar
inte blir geometri) har ingen egen dragning utan följer grannarna. Förflyttningen räknas om till vilopose (per hörn en
3x3-matris ur tre provnycklar) och sparas som `build/human/fit/<namn>/wrap.npz` (offsets, proxy, uppdelning, antal hörn);
`human_blender.py` delar upp proxyn på samma sätt och bakar in den. `{"wrap": false}` hoppar över steget.

Sysslingen (`syssling_wrap6`, AI-ytan till proxyns yta i medel): 20,1 → 10,7 mm, huvud 0,6, bröst 1,2, smalben 1,3 mm.
Kvar: höfter 16 och lår 23 mm, där armarna och händerna hänger (händerna följer bara armarna, AI-händerna står
annorlunda), och huvud, hals och axlar som fortfarande ser smalare ut än Pixal3D:s i lerbilden
(`build/characters/syssling/sheet/clay6_front.png`). Filerna `syssling_wrap4*` (med texturer) är från den felaktiga
wrapen på grundnätet.

**Omgång 9 (2026-11-10, `syssling_wrap9`):** posesökningen ställer också armbågen (`elbow_flex` framåt, `elbow_carry`
utåt; sysslingen 17° och 5°, som `human_blender.py` använder för `_pose.glb`), brynbågen och öronen följer grannarna (de
målade brynen och de fransiga öronen i AI-nätet följer inte med) och bysten jämnas ut 70 % mindre. AI-ytan till kroppen:
4,4 mm i medel, p95 25 mm (omgång 6: 10,7 och 79); höfter 3,8, lår 8,8 mm. Kvar enligt Patrik: skötet ska bulla ut mer med
ett litet veck vid ljumsken (eget reglage, Pixal3D har trosor där), och små detaljer (navel, nyckelben, revben, vecket i
sidan, skinkornas spricka) i en gemensam normalkarta på MPFB:s UV, inte i geometrin.

**Skötet (mons, omgång 10):** receptets `mons` (0..1) i `human_blender.py` buktar ut området framför blygdbenet (högst
9 mm vid 1) och lägger ett grunt veck längs ljumskarna (3 mm), längs proxyns normaler; platsen räknas ur kroppen (grenens
topp på mittlinjen), så reglaget gäller alla kroppar. Sysslingen 0,8: 19 hörn rörde sig, högst 7,2 mm; utbuktningen syns
svagt och vecket knappt, så vecket hör till normalkartan.

**Detaljerna som normalkarta (omgång 11):** `tools/character/human/bake_detail.py` bakar AI-ytan (ur inpassningens
`wrap_debug.npz`) som normalkarta i tangentrum på MPFB:s UV och lägger den på den riggade figuren; ögon och bryn tonas
till plant. Sysslingen: nyckelben, navel, bystens form, ansiktets drag och underkläderna som svag relief; nätet är
oförändrat. Kvar: lodräta ränder på låren, som är veck i Pixal3D-nätet. Inriktningen sker efter de omslutande lådornas
mitt (exporten och passningens proxy är samma, 0,01 mm); närmaste punkt mellan två glesa punktmängder konvergerade fel.
Inpassningen ställer också posen på nytt med receptets exakta vinklar innan wrapen.

**Omgång 12 (armar och händer):** armbågen och handleden (hittade i nätet där vikterna går över mellan benen) behåller
MPFB:s form, underarmen jämnas ut fyra gånger hårdare, och händerna flyttas stelt med handleden. Händerna delas inte upp
(`tools/character/human/proxy_ops.py`, ett fast topologisteg som inpassningen och bygget gör lika, så alla kroppar får
samma nät): sysslingen 10 554 trianglar i stället för 12 672, händerna 2 586 i stället för 4 648, inga nya öppna kanter
(proxyn har 84 från början). Knycken vid handleden försvann; armbågen är fortfarande mjuk (MPFB:s egen), Pixal3D:s
armbågsbula kommer med normalkartan. Tätheten per område styrs på riktigt bara med en egen proxy (mhclo), som MPFB
passar in på varje kropp.

Omgångarna syns i Darrowmere-galleriet som beställningen `syssling-mpfb` (ett steg per omgång, lerjämförelsen som
förhandsbild): `build/characters/syssling/publish_round.py`.

**Texturen på MPFB:s UV (2026-11-10):** UltraTex lägger en egen UV och tappar riggen (och flyttar nätet 0,83 m uppåt).
`tools/character/human/transfer_texture.py` bakar därför källans färg (selected to active, Cycles på processorn) till
MPFB-kroppens egen UV i samma pose och lägger bilden på den riggade figuren, med påfyllning runt öarna (16 px).
UltraTex ska få figuren i referensens pose (`<namn>_pose.glb`), inte viloposen, annars hamnar projektionen fel på armarna.
Prov på viloposens textur: 99,9 % täckning, rigg och ögon kvar (`assets/characters/syssling_fit/syssling_fit_tex_test.glb`).
Sysslingen på riktigt: UltraTex (Best, `syssling-wrap-pose-1110-1116`) på `syssling_wrap4_pose.glb`, överbakad till
`assets/characters/syssling_wrap4/syssling_wrap4_tex_mix70.glb` och `_mix90.glb`: riggad, MPFB-UV, täckning 100 %,
underkläderna som målad textur (bild `build/characters/syssling/sheet/wrap_tex.png`). Ej granskat: närbild på ansikte,
händer och sömmar, och hur huden ser ut i rörelse.
