# Plan: karaktärsgeneratorn (`tools/character/`, MCP `create_character`)

Samma mönster som trädgeneratorn: ett skelett först, allt annat byggs från skelettet. Recept in, glTF ut, en rad JSON med kontroller. Stilen är halvrealistisk fantasy key art översatt till 3D; se stilguiden avsnitt 6 och `character` i `style.json`.

**Karaktärerna byggs i delar.** En spelkaraktär är en kropp plus utbytbara delar: kläder, rustning, frisyr, skägg, huvudbonad och vapen. Delarna delar skelett och kan bytas i spelet. Kroppar är data (arketyper eller raser i `characters.json`), och delar är också data (recept i `parts.json`), inte färdiga meshar.

## Kroppens källa: MakeHuman hm08

Primitivkroppen (`body.mjs`) såg ut som lera: smooth-min av bollar och koner ger inga plan, inga skarpa kanter och inga anatomiska markeringar, och anatomi går inte att skulptera med siffror. Människokroppar tas därför från **MakeHumans basmesh hm08** (CC0, `third_party/makehuman/`, se SOURCE.md): anatomiskt grundad, bara quads, 13 380 hörn i kroppen (26 800 trianglar), med targets för kön, ålder, muskler, vikt, längd och proportioner och "joint cubes" som skelettet placeras i. `hm08.mjs` läser meshen och blandar macro-targets, `gen_hm08.mjs` skriver en kropp. Stilen (cirka 8 huvuden, längre ben, större händer, fötter och ögon) läggs på som egna targets. hm08 blir mallen för människorasen; regioner, sömmar, sockets och delar byggs ovanpå. Primitivkroppen finns kvar för varelser utan mänsklig bas.

## Grundidé: en byggsats med sömkontrakt

En spelkaraktär är en byggsats: ett skelett plus **platser** (slots) där varje plats har utbytbara delar. Naken bål, skjorta och rustning är tre meshar för samma plats, inte lager ovanpå varandra. Så gör de flesta spel; fysisk tygsimulering i lager är för dyr för många figurer i webbläsaren, klipper igenom kroppen och ritar samma pixel flera gånger. Lösa delar (kappa, kjol, långt hår) får i stället några fjäderben eller svaj i vertexshadern.

**Sömkontraktet** gör delarna utbytbara:
- Sömmarna väljs en gång på hm08 som riktiga kantslingor: hals, axel, armbåge, handled, midja, ljumske, knä och fotled. De sparas som hörnindex i `hm08_kit.json`.
- Varje del slutar exakt i sina sömmar: samma hörn (antal, läge, normal och vikter) som den nakna kroppen i sömmen. Då passar vilken bål som helst med vilka armar som helst, utan glipor och utan synlig skarv i rörelse.
- Den nakna delen är hm08:s egen region. Kläder är andra meshar som slutar i samma sömmar; ett plagg som är tjockare än huden viker in fållen till sömmen inne i delen, så att kanten syns som ett steg på plagget men anslutningen är exakt.
- En del kan ta flera platser (en långärmad rock tar bål, överarmar och underarmar och slutar vid handlederna). Dess yttre kanter måste vara sömmar ur kontraktet.
- Delarna följer kroppsformen: varje hörn i en del binds till kroppens yta (som MakeHumans MHCLO: en triangel på basmeshen plus en förskjutning), så att en skjorta följer med när reglagen för vikt eller muskler ändras. Vikterna kopieras samma väg.
- Kombinationer i lager (skjorta + väst + rock) blir egna varianter för platsen eller små tilläggsdelar utanpå, inte fria lager.

## 1. Skelett och proportioner (klart)
- Humanoidskelett med standardnamn: Hips, Spine, Chest, Neck, Head, Left/Right Shoulder, UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot, Toe. Vänster = +X, karaktären tittar mot +Z, y uppåt, meter.
- **Samma hierarki och samma namn för alla kroppar.** Proportionerna skiljer (benlängderna), men klippen roterar bara leder (translation bara på Hips), så samma animation fungerar på alla arketyper och raser.
- Bindpose i A-pose (armarna cirka 40° från lodlinjen), som ger bättre skinning i armhålorna än T-pose.
- Läggs till: `LeftEye`/`RightEye` (blick), `Jaw` (tal och mun senare) och **sockets**: tomma noder under ben där stela delar fästs: `socket_hand_R` och `socket_hand_L` (grepp), `socket_back` (sköld, ryggsäck, vapen på ryggen), `socket_hip_L`/`socket_hip_R` (svärd i skida, verktyg), `socket_head` (hjälm, hatt). Sockets placeras per kropp, så att ett svärd hamnar rätt i både en dvärgs och en hjältes hand.
- Ledernas lägen räknas ur kroppens värden (height, heads, build, shoulders, waist, hips, belly, hands, feet, legs, neck, hunch), med lite variation per seed. Hjältar 7,5–8 huvuden; inte chunky, inte chibi.

## 2. Platser och sömmar på hm08
- 15 nakna delar: huvud (med hals till sömmen ovanför nyckelbenen), bål, bäcken, överarmar, underarmar, händer, lår, underben och fötter (vänster och höger).
- Sömmarna är kantslingor i hm08 nära lederna. Kontroll: varje söm är en sluten slinga, delas av exakt två delar, och delarna blir exakt 15 sammanhängande bitar.
- Byst och andra könsformer är kroppsdata (targets), inte delar.
- (Primitivkroppen hade samma 15 regioner, men med taggiga triangelgränser i stället för kantslingor.)

## 3. Delarna, sorterade efter hur svåra de är att sätta ihop och animera

| Nivå | Vad | Hur det sitter ihop | Animation |
|---|---|---|---|
| A. Stela delar | vapen, sköldar, verktyg, stela hjälmar, smycken, ryggsäckar | fästs i en socket; ingen skinning | följer sitt ben; greppunkt och riktning enligt en konvention (handtaget längs +Y, eggen mot +Z) |
| B. Huvuddelar | ögon, ögonbryn, hår, skägg, hattar, öron per ras | skinnas 100 % på Head (ögon på Eye-benen); långt hår blandas med Neck och Chest | enkla; ögonen kan titta, käken öppnas senare |
| C. Tajta plagg | tröjor, byxor, handskar, stövlar, armskydd, bälten, tajta rustningsdelar | ersätter de nakna delarna på sina platser och slutar i sömmarna; formen och vikterna binds till kroppens yta | följer kroppen exakt, eftersom formen och vikterna kommer från samma kropp |
| D. Lösa plagg | kjolar, rockar, kappor, mantlar, långt fladdrande hår | som C, men behöver egna ben (kjol- och kappben) eller simulering, och särskilda vikter mellan benen | svårast: benen får inte skära igenom kjolen; görs sist |

- **Lager** för nivå C: varje plagg är ett lager med täckningsområde; i varje punkt syns bara det översta, och lagren möts med invikta fållar (`outfit.mjs`). Kroppen under finns inte kvar som egen yta.
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
- **Inte användbar: Hunyuan Motion 1.0** (Tencent, text till animation, ComfyUI, cirka 8 GB VRAM, FBX). Licensen (`License.txt` i Tencent-Hunyuan/HY-Motion-1.0, kontrollerad 2026-10-19) gäller inte i EU, Storbritannien och Sydkorea, och varken modellen eller dess utdata får användas utanför licensens territorium. Samma gäller Hunyuan3D. Alternativ att utvärdera för rigg och animation: Mesh2Motion (öppen källkod; animationerna ska vara CC0, kontrollera), Tripos retarget (cirka 35 krediter per kropp) och Mixamo som reserv.

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

## Läge 2026-10-19 (öppen fråga)
Kropparna ska vara rätt innan kläder och hår byggs vidare. Referens: Apparition-gruppen "Patriks 3D game character reference" (stiliserat, 6 000–12 000 trianglar, förenklade plan, handmålad textur). Provat:
- MakeHuman-proxy (male1591/female1605) med stilisering anpassad mot referensens mått (`fit_style.mjs`, `fits.json`): rätt proportioner men ser ut som en provdocka.
- Tripo P1 (50 krediter) och P2 med quads (110 krediter) ur referensens vyer (`tools/tripo/make_tripo.py`): ligger nära referensen i form, ansikte, hår och textur. Plattan under fötterna måste bort. Modellerna ligger i `build/tripo/` och `assets/imported/tripo_*` (inte committade).
**Beslut att ta:** väg A (vår topologi passas in på Tripos form och texturen bakas till vår UV, så att reglage, sömmar och kläder behålls) eller väg B (Tripo-modellerna som de är, med Tripos riggning).

**Nästa steg (lokalt, utan krediter).** Tripo- och Meshy-krediter räcker inte långt, så det mesta ska göras lokalt. Formen har vi redan (proxyn inom 2 % av referensens mått); det Tripo gav och vi saknar är utseendet.
1. **Projektionsmålning på proxykroppen:** rendera kroppen i grått med djup- och normalkartor fram, sida och bak; låt bildgenereringen måla över varje vy i stilbladens stil, styrd av geometrin (SDXL med ControlNet djup och en stilreferens ryms på 8 GB; Krea-2 har en referensnod som provats i Apparition); projicera tillbaka och baka till proxyns UV i Blender headless. Jämför bredvid referensen och Tripo.
2. **Lokal 3D-generering av delar** (huvud med hår, hjälm, vapen): samma konceptbild av ett huvud med hår genom TRELLIS.2 (inbyggt i ComfyUI: Trellis2ShapeStage, Trellis2TextureStage m.fl.; officiellt 16–24 GB, prova med ComfyUI:s avlastning) och TripoSG (MIT, cirka 8 GB, bara geometri, communitynod), bredvid Tripo-resultatet. Notera tid, VRAM och kvalitet; texturen kan komma ur steg 1. TripoSG har testats för länge sedan, troligen på hela karaktärer; delar är ett lättare fall och modellerna har förbättrats.
3. **Licenskoll före användning:** TRELLIS.2 är MIT, men originalkedjan använder NVIDIA:s nvdiffrast/nvdiffrec (bara icke-kommersiellt); kontrollera om ComfyUI:s implementation slipper dem. Pixal3D: licens okänd. Tencent-modellerna (Hunyuan3D 2.0/2mini/2.1, HY-Motion) är uteslutna i EU, både modell och utdata. Stable Fast 3D: Stabilitys community-licens, kontrollera villkoren. Tripo och Meshy bara för enstaka hjältemodeller.

## Ordning
1. **Klart:** skelett, kroppsfält och mesh (primitivkroppen, finns kvar för varelser utan mänsklig bas).
2. **Klart:** regioner, mall per ras och sockets på primitivkroppen (`regions.mjs`, `template.mjs`); idéerna förs över till hm08.
3. **Klart:** människokroppar ur MakeHuman hm08 (`hm08.mjs`, `gen_hm08.mjs`); macro-targets ger tydligt olika kroppar ur samma mesh.
4. **Klart:** byggsatsens sömkontrakt på hm08 (`kit_hm08.mjs` → `hm08_kit.json`): 14 sömmar som kantslingor, 15 nakna delar, en meshnod per del.
5. Första klädvarianten för en plats: en tunika för bålen som slutar exakt i sömmarna, med invikt fåll; byte mellan naken och tunika i samma bild. **Klart:** `garment.mjs` och `parts.json` (`tunic`): skal ur bålens egna quads, utjämnat och minst 4 mm från huden, invikt fåll med bård i accentfärgen, sömfel 0 mm. Midjesömmen ligger under naveln, så att fållen inte faller in i navelgropen.
5b. **Klart:** korta ärmar och byxor (`sleeve_short`, `trousers`). Sömmar mellan två plagg är öppna: ingen fåll, båda kanterna på samma hörn med kroppens normal; bården sitter bara vid fållar mot hud.
5c. **Klart (som lager i stället för ägarskap):** `outfit.mjs` gör hela outfiten till EN yta. Varje plagg i `parts.json` är ett lager med täckningsområde (platser plus gränser i meter: above, below, limb, vneck, band). I varje punkt vinner det översta plagget, avstånden staplas, ytan skärs exakt längs gränserna och bårdernas inre kant, och där lager möts viks en fåll från det yttre lagret till det inre (eller huden). Tunikan hänger över byxorna och går rakt ned till dem, byxorna ser nedstoppade ut i stövlarna, bältet är ett band utanpå. Inga lager ligger på varandra. Ytan delas sedan per plats. Ersätter `garment.mjs` och de öppna sömmarna. Kvar: V-ringningens kant är lite vågig i närbild.
5d. Posetest i `checks`: skinna med hm08:s vikter (plaggen kopierar vikterna från sina kroppshörn) i några poser och mät genomstick och öppna sömmar. **Klart:** `skin.mjs` (game_engine-vikterna ihopslagna till våra ben, LBS, poserna bind, arms_down, elbows_90, step, crouch) och `posetest.mjs` (sömgap, kollaps, vända trianglar, hud i plagg per del). Sömgapet är 0 mm i alla poser; kollaps högst 1,9 % i huk. Spine och Chest sitter nu i joint-spine-4 och joint-spine-2, som vikterna förutsätter.
6. Egna targets: stilisering mot konceptet, köpmansmage, dvärgproportioner. **Delvis klart:** stiliseringen är procedurtargets i `hm08.mjs` (`stylizeRaw`: ben, händer, fötter, ögonområde, huvud, midja, axlar, räknade ur hm08:s vikter och joint cubes, på hela meshen så att skelett och ögon följer) med värden per kön i `style.json` (`character.stylize`); hero 8,1 och heroine 8,0 huvuden. Köpmansmage och dvärg återstår.
7. Ansikte och huvuddelar (nivå B): ögon (hm08:s hjälpgeometri), ögonbryn, hår, skägg, hårfärg; vertexfärg och material. **Delvis klart:** ansiktsförval som viktade MakeHuman-targets per kön (`style.json` `character.face`), ögonglober i `face.mjs` (vita, iris med limbalring, pupill, buktande hornhinna, på hm08:s ögonplatser), ögonbryn som tunt lager (`brows`). **Håret fungerar inte som lager på huden** (badmössa och hjälm): det behöver en egen hårgenerator med avsmalnande slingor svepta längs styrkurvor från hårbotten, som grenarna i trädgeneratorn. `hair_short` och `hair_bob` är platshållare. **Hårgeneratorn finns nu** (`hair.mjs`, frisyrer i `hair.json`), med förenklad grafik efter referenserna i Apparition (low poly-blockout, målat hår i WoW-stil): inga enskilda strån. Volymen bärs av ett tjockt, slätt hårskal (`hair_cap` med `boost` framtill och upptill, egen UV). Silhuetten kommer av få, stora, platta lock i jämna ringar innanför hårlinjen (kort hår) eller ett draperi (`sheets`) som faller från hjässan runt sidorna och bak (långt hår), jämnat i sidled med Taubin så att det inte krymper och kortare vid sidorna så att det slutar vid axlarna. Kurvorna följer skallen innanför hårlinjen och kolliderar mot ansikte, kropp och kläder. En mjuk målad textur (`hair_soft`), färgzoner och en glansring står för utseendet. short_swept cirka 1 200 och long_flowing cirka 1 500 trianglar plus skalet. Kvar: en riktig målad hårtextur med ljuspunkter och skuggdrag (det tunga lyftet), skägg som skal, fler frisyrer (knut och hästsvans som boxar), skinning av långt hår.
8. Skinning (hm08:s vikter för `game_engine` som grund) och klippen; sockets; lineup-sida med byte av delar och reglage.
9. Fler delar (byxor, stövlar, handskar, rock), stela delar i sockets, MCP-verktyget `create_character`, parken.

Att titta på (noterat 2026-10-26): [blender-skills](https://github.com/arjun988/blender-skills) (MIT), 94 färdiga färdigheter för AI-agenter som kör Blender via Blender MCP, bland annat character-artist, creature-artist, character-archetypes, sculpting, retopology, hair-groom, rigging och animation, plus export till Unity, Unreal och Godot. Kan bli ett stöd för karaktärsskapandet: retopologi och rigg av importerade eller skulpterade figurer, hårgroom som jämförelse med `hair.mjs`, och granskning i Patriks Blender. Läs först hur djupa färdigheterna är (sidan visar bara namnen), och kopiera bara de som behövs till `.claude/skills/`.

Senare: lösa plagg (nivå D: kjol, rock, kappa, långt hår med egna ben), hjälmar som klipper håret, rasbyte som test (samma utrustning på dvärg och goblin), anpassning av importerade rustningar till våra kroppar, ansiktsuttryck och fler klipp.
