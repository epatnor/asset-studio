# Plan: karaktärsgeneratorn (`tools/character/`, MCP `create_character`)

Samma mönster som trädgeneratorn: ett skelett först, allt annat byggs från skelettet. Recept in, glTF ut, en rad JSON med kontroller. Stilen är halvrealistisk fantasy key art översatt till 3D; se stilguiden avsnitt 6 och `character` i `style.json`.

**Karaktärerna byggs i delar.** En spelkaraktär är en kropp plus utbytbara delar: kläder, rustning, frisyr, skägg, huvudbonad och vapen. Delarna delar skelett och kan bytas i spelet. Kroppar är data (arketyper eller raser i `characters.json`), och delar är också data (recept i `parts.json`), inte färdiga meshar.

## Grundidé: delar som recept, inte meshar

Kläderna genereras mot kroppens avståndsfält: ett plagg är ett område på kroppen (vilka kroppsdelar det täcker och hur långt) plus ett lager utanpå (uppblåsning, veck, bårder, material). Därför passar varje plagg på varje kropp av sig självt, och att byta ras är att generera samma recept mot en ny kropp. En tunika på en ork och på en gnom är samma recept men två meshar. Det fungerar inte för färdiga, handgjorda meshar (importerade rustningar); de behöver en variant per kroppstyp eller anpassning i efterhand (se "Senare").

## 1. Skelett och proportioner (klart)
- Humanoidskelett med standardnamn: Hips, Spine, Chest, Neck, Head, Left/Right Shoulder, UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot, Toe. Vänster = +X, karaktären tittar mot +Z, y uppåt, meter.
- **Samma hierarki och samma namn för alla kroppar.** Proportionerna skiljer (benlängderna), men klippen roterar bara leder (translation bara på Hips), så samma animation fungerar på alla arketyper och raser.
- Bindpose i A-pose (armarna cirka 40° från lodlinjen), som ger bättre skinning i armhålorna än T-pose.
- Läggs till: `LeftEye`/`RightEye` (blick), `Jaw` (tal och mun senare) och **sockets**: tomma noder under ben där stela delar fästs: `socket_hand_R` och `socket_hand_L` (grepp), `socket_back` (sköld, ryggsäck, vapen på ryggen), `socket_hip_L`/`socket_hip_R` (svärd i skida, verktyg), `socket_head` (hjälm, hatt). Sockets placeras per kropp, så att ett svärd hamnar rätt i både en dvärgs och en hjältes hand.
- Ledernas lägen räknas ur kroppens värden (height, heads, build, shoulders, waist, hips, belly, hands, feet, legs, neck, hunch), med lite variation per seed. Hjältar 7,5–8 huvuden; inte chunky, inte chibi.

## 2. Kropp i regioner med gemensamma sömmar
- Kroppen är fortfarande ett avståndsfält (mjuk union av rundade koner och ellipsoider, platt sula vid y = 0, mesh med surface nets) men **meshen delas i regioner** längs sömmar där kläder brukar sluta, så att skarven alltid kan döljas: huvud (söm vid kragen), bål, överarmar, underarmar, händer (söm vid handleden), bäcken, lår, underben, fötter (söm vid fotleden).
- Regionerna skärs ur samma mesh, så hörnen i sömmarna är identiska mellan grannregioner: inga glipor, och normalerna stämmer över skarven.
- Ett plagg som täcker en region **döljer kroppen under sig** (regionen renderas inte). Det tar bort genomstick när kroppen rör sig och sparar trianglar.
- Byst och andra könsformer är kroppsdata (t.ex. `bust` för heroine), inte plagg.

## 3. Delarna, sorterade efter hur svåra de är att sätta ihop och animera

| Nivå | Vad | Hur det sitter ihop | Animation |
|---|---|---|---|
| A. Stela delar | vapen, sköldar, verktyg, stela hjälmar, smycken, ryggsäckar | fästs i en socket; ingen skinning | följer sitt ben; greppunkt och riktning enligt en konvention (handtaget längs +Y, eggen mot +Z) |
| B. Huvuddelar | ögon, ögonbryn, hår, skägg, hattar, öron per ras | skinnas 100 % på Head (ögon på Eye-benen); långt hår blandas med Neck och Chest | enkla; ögonen kan titta, käken öppnas senare |
| C. Tajta plagg | tröjor, byxor, handskar, stövlar, armskydd, bälten, tajta rustningsdelar | genereras som ett lager utanpå kroppens fält i de regioner plagget täcker; vikterna kopieras från närmaste kroppspunkt | följer kroppen exakt, eftersom formen och vikterna kommer från samma kropp |
| D. Lösa plagg | kjolar, rockar, kappor, mantlar, långt fladdrande hår | som C, men behöver egna ben (kjol- och kappben) eller simulering, och särskilda vikter mellan benen | svårast: benen får inte skära igenom kjolen; görs sist |

- **Lager** för nivå C: under (skjorta, byxor), över (väst, rustning, rock) och ytterst (kappa). Varje lager blåses upp lite mer än det under, och ett lager som täcker ett annat helt döljer det.
- **Hår och huvudbonader:** en hatt eller hjälm anger om håret ska döljas, klippas (håret skärs mot hattens fält, så att det inte sticker igenom) eller behållas.
- **Färg:** varje del har sina färger (bas och accent) och sitt material (Skin, Cloth, Leather, Metal, Hair; roughness ur `character.materials`). Regeln om en accent gäller hela den sammansatta karaktären. Den målade looken (ljusare uppåt, AO i veck, varmare hud vid öron, näsa och händer) ligger i vertexfärgen per del.
- **Ansikte och ögon:** ögonen är egna delar, stora och mandelformade (`eye_scale`), med iris, pupill och blank hornhinna; de sitter delvis under ögonlocken. Ögonbrynen har hårfärg.

## 4. Filer och format
- `characters.json`: kroppar (arketyper och raser) med proportioner, hudfärger och en standardutrustning, t.ex. `"outfit": {"torso": "tunic_short", "legs": "trousers", "feet": "boots_mid", "hair": "spiky"}`.
- `parts.json`: delrecept per plats (slot): `head`, `hair`, `beard`, `torso`, `legs`, `hands`, `feet`, `belt`, `back`, `hand_R`, `hand_L` ... med vilka regioner delen täcker och döljer, lager, parametrar (ärmlängd, längd, uppblåsning, veck, bårder), material och färglistor.
- Ett karaktärsrecept: `{"name": "...", "body": "dwarf", "seed": 3, "outfit": {...}, "equip": {"hand_R": "axe_short"}}`.
- Utdata: `assets/characters/<name>/<name>.gltf` med skelett, ett skin och **en meshnod per del** (`body_torso`, `part_torso_tunic_short`, `part_hair_spiky` ...), så att klienten kan visa och dölja delar. Delar kan också genereras var för sig mot en kropp (`assets/characters/<body>/parts/<del>.gltf`) och bytas i klienten, som binder dem till karaktärens skelett efter bennamn.
- Komprimering som de andra (meshopt); JOINTS och WEIGHTS lämnas okvantiserade.

## 5. Karaktärsskapande
Spelaren väljer det som receptet redan beskriver: ras eller kropp, man eller kvinna, kroppsbyggnad, längd inom rasens spann, ansikte, hudton, frisyr, hårfärg, skägg och ögonfärg. Varje val är ett fält i receptet, och samma recept används av generatorn, av spelet och av AI:n.
- **Kroppsform som reglage:** kön (byst, höfter, axlar, käke), build, midja, mage och längd är kroppsvärden som redan styr skelettet och fältet.
- **Ansikte:** en uppsättning ansiktsvärden (käke, haka, kindben, näsa, ögonens storlek och vinkel, panna, läppar, öron) med färdiga förval (`faces` i `characters.json`) som spelaren kan finjustera.
- **Frisyr, skägg och hårfärg:** delar på nivå B med färg som parameter.
- **Ändra direkt utan att generera om:** inom en ras har alla kroppar **samma topologi**. En mallmesh görs en gång per ras ur en referenskropp, och varje variant projiceras på sitt eget fält (samma hörn flyttas till den nya ytan). Då blir reglagen morph targets (blend shapes) som klienten blandar i realtid, och sömmar och regioner följer med. Hår och kläder genereras om när ett val är klart, eller väljs ur förgenererade varianter.
- Rasbyte byter mall och genererar om delarna mot den nya kroppen.

## 6. Skinning och animation
- Kroppens vikter automatiskt: varje hörn får sin primitivs ben och dess grannben som kandidater, med mjuk avståndsviktning mot bensegmenten, högst 4 vikter.
- Nivå C-plagg kopierar vikterna från närmaste kroppspunkt; nivå B skinnas på Head; nivå A har inga vikter.
- glTF-skin med inverse bind matrices (lederna har bara translation i bindpose).
- Genererade klipp: `idle` och `walk` (cykel på 1 s, gånghastigheten i extras). Samma klipp för alla kroppar. Senare: klipp som använder sockets (hugg, block) och IK för tvåhandsgrepp och fötter.

## 7. Kontroller (`checks.ok`)
- Kropp: fötterna på marken, exakt symmetri, uppmätt antal huvuden, inom budget (klart). Sömmarna mellan regionerna har identiska hörn.
- Delar: inga kroppshörn utanför plagget i de täckta regionerna, både i bindpose och i några poser ur klippen (genomstickskontroll). Alla hörn viktade (summa 1). Varje stel del sitter i en socket som finns.
- Hela karaktären: inom budget med dolda regioner borträknade, en accentregion, basfärger enligt `character.colors`.

## 8. Klienten
- Laddar en karaktär, spelar `idle` och `walk` med AnimationMixer, kloner med SkeletonUtils.clone.
- Byter delar under körning: laddar delens glTF, binder den till karaktärens skelett efter bennamn och döljer kroppsregionerna som delen täcker.
- Kantljus (fresnel, `character.rim`) i karaktärsmaterialet.
- En lineup-sida där man kan byta utrustning och kropp, för att se att delarna passar; den blir grunden för spelets karaktärsskapande (reglage som morph targets, val av delar och färger).

## 9. Stilreferens och uppföljning
- Konceptbilder per arketyp med `tools/character/concept.py` (gruppen "Tinkertown character concepts" i Apparition).
- Varje steg får en egen grupp i Apparition med skärmbilder ("Character generator N: ...").

## Ordning
1. **Klart:** skelett, kroppsfält och mesh; alla arketyper klarar kontrollerna (`skeleton.mjs`, `body.mjs`, `gen_character.mjs`, `make_character.py`).
2. Kroppen i regioner med gemensamma sömmar; mallmesh per ras med fast topologi (varianter projiceras på sina fält); kön och byst; sockets och Eye- och Jaw-ben; formatet med en nod per del. Förhandsbild med regionerna i olika färger.
3. Ansiktsvärden och förval; huvuddelar (nivå B): ögon, ögonbryn, hår per stil, skägg, hårfärg; vertexfärg och material.
4. Tajta plagg (nivå C) ur `parts.json`: tunika, skjorta, byxor, stövlar, handskar, bälte; täckning, döljning, lager, accent. Arketypernas `sleeves`, `pants` och `boots` blir standardutrustning.
5. Skinning och klippen; genomstickskontroll i poser; lineup-sida med utbyte av delar och reglage som morph targets (början på karaktärsskapandet).
6. Stela delar (nivå A): sockets i bruk, vapen och verktyg via props-generatorn eller `import_model`.
7. MCP-verktyget `create_character`, katalograd, stilgranskning mot Apparition; parken med gående karaktärer.

Senare: lösa plagg (nivå D: kjol, rock, kappa, långt hår med egna ben), hjälmar som klipper håret, rasbyte som test (samma utrustning på dvärg och goblin), anpassning av importerade rustningar till våra kroppar, ansiktsuttryck och fler klipp.
