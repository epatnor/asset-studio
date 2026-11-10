# Body-gen: kroppar med fast topologi (inflyttad 2026-11-10)

Body-gen (`~/Spelutveckling/body-gen`, utan git) flyttade in i asset-studio 2026-11-10. Originalmappen ligger kvar
orörd som arkiv tills Patrik tar bort den. Anteckningarna nedan är body-gens egna och skrivna med dess gamla sökvägar;
översätt så här:

| I texten nedan | Nu |
|---|---|
| `tools/<x>.py`, `tools/editor/`, `tools/blender/` | `tools/character/body/<x>.py` osv. |
| `build/…`, `out/…`, `images/…` | `build/body/build/…`, `build/body/out/…`, `build/body/images/…` (git ignorerar dem) |
| `.venv/bin/python tools/<x>.py` | `build/body/.venv/bin/python tools/character/body/<x>.py` (miljön: `tools/character/body/requirements.txt`) |
| `../lowpoly-test`, `../img2mesh` | oförändrat, `~/Spelutveckling/lowpoly-test` och `~/Spelutveckling/img2mesh` |

Skripten hittar själva sin arbetsyta (`HERE` = `build/body`, `TOOLS` = skriptets mapp), så de kan köras från vilken mapp
som helst. Body Editor startas från skrivbordsgenvägen (`tools/character/body/editor/launch.sh`, port 8772) eller
serverkonfigurationen `body-editor`; servern körs med arbetsytan som arbetskatalog.

**Passningen är det som gör kroppen tight** (Patriks "kroppsstrumpa"): `fit.py` drar mallen mot AI-ytan med landmärken,
strålar per del och icke-stel ICP. Sysslingens Pixal3D-kropp (2026-11-10, `build/characters/syssling/`):
`fit.py … syssling --height 1.65` gav 0,03 mm mall→AI och 0,13 mm AI→mall i medel (p95 0,25 mm), mot MPFB-reglagens
3–8 cm (`fit_human.py`, docs/character-creator.md). Planen framåt: samma passning på MPFB:s grundnät (kantloopar,
rigg) med händer, ansikte och fötter fasta, skillnaden som shape key.

---

Mål: människokroppar ur en egen mall med fast topologi, där AI-modeller bara är förlagor. Varianter blir morph targets med samma UV, sömmar och (senare) vikter. Inga befintliga modeller används (varken Tripo, hm08 eller MakeHuman).

**Läge:** två omgångar. Den andra (badkläder, nedan) ersätter den första som förlaga: kvinnan i bikini och mannen i korta badbyxor, så att hudton och toningar i huden syns. Båda kropparna finns i samma topologi med bakad basfärg och normalkarta på tre spelnivåer (`out/female_swim_L*.glb`, `out/male_swim_L*.glb`, kvinnan som morph target `female_swim` i `out/male_swim_L3.glb`, blandningar i `out/blend_male_swim_female_swim_*`). Första omgångens filer (`out/male_*`, `out/female_*`) finns kvar. Bilderna finns i Apparition, på tavlan Characters (Azshara Studio › Asset Studio › Characters): grupperna "Body generator: badkläder" (andra omgången), "Body generator: förlagor" och "Body generator: mall och passning" (första omgången). Tripo har inte använts (0 krediter). Delkörningarna för bål, ben, överarm och underarm stoppades: renderingen av foot_female hängde sig i GPU-kön i 71 minuter, och delarna var i de gamla kläderna.

## Andra omgången: badkläder

Förlagorna togs om med kläderna utbytta i `tools/gen_refs.py` (`WHO`) och en rad om hudens toningar (`SKIN`: varmare kinder, näsa, öron, knän, armbågar, knogar och tår). `gen_refs.py body <kön> <frö> --front` tar bara framvyn. Med `--base=förlaga.png --denoise=0.6` görs bild till bild ur förra förlagan, men då behöll mannen de långa shortsen, så det användes inte. Badbyxorna blev korta först när prompten sa "brief-cut swim briefs with high cut leg openings, upper thighs fully bare". Valda förlagor: kvinna frö 401, man frö 304 (händerna fria från bildkanten, benen isär).

| | Kvinna (bikini) | Man (badbyxor) |
|---|---|---|
| Förlaga | `images/female/body_front_401.png` | `images/male/body_front_304.png` |
| Pixal3D | `build/pixal3d/body_female_swim.glb` (700 000 tris) | `build/pixal3d/body_male_swim.glb` (700 000 tris) |
| Passning | `build/fit/female_swim.*` | `build/fit/male_swim.*` |

Ändringar i passningen som de nya kropparna krävde:
- **Hjässa** (`crown`): kvinnan fick en hästsvans som står upp, så det högsta snittet låg 12 cm över huvudet och halssömmen hamnade i ansiktet. Hjässan är nu det högsta snittet där mittdelen är bredare än 8 cm. Halsen, hakan och huvudets topp räknas från den.
- **Tårna:** tåns landmärke och skelettets tå ligger på tårnas egen höjd (medianen av de främsta 4 cm) i stället för 0,4 gånger fotledens höjd. Kvinnans platta tår missades annars helt (foten 2,7 mm, p95 22 mm; nu 0,1 mm).
- **Lösa bitar i etiketteringen:** varje del behåller sin största sammanhängande bit, och övriga bitar får etiketten från närmaste triangel utanför biten (förut: näst bästa del). Pixal3D lade mannens tår som en egen bit, som annars blev ben.
- **Knogarna:** andelen från glipdetekteringen begränsas till 0,6. Mannens krökta fingrar skiljs först nära topparna, och 0,71 gav handflata ända ut till fingertopparna.

Avstånd AI→mall i medel (p95), mm. Kvinnans hästsvans ovanför hjässan (1,8 % av ytan) är borträknad; huvudets rör ska inte täcka hår.

| Nivå | Trianglar | Kvinna | Man |
|---|---|---|---|
| 1 | 6 272 | 2,2 (6,8) | 2,6 (11,0) |
| 3 | 57 312 | 0,81 (1,35) | 0,72 (2,5) |
| 6 (passning) | 230 112 | 0,66 (0,49) | 0,51 (0,91) |

Per del på nivå 6 (AI→mall, medel): kvinnan har bål 0,2, ben 0,07, fötter 0,1 och händer 1,3–1,5. Mannen har bål 0,25, ben 0,09, huvud 0,12, fötter 2,0–2,2 (p95 18–20) och händer 2,5–3,3 (p95 18–20).

Vad som inte höll i andra omgången:
- **Mannens händer:** fingrarna är krökta och ligger an mot varandra vid roten. Banden tvärs över handen hittar inte fyra fingrar, så två fingrar blir tunna band. Tummen sitter rätt.
- **Mannens tåspetsar:** de sista 3–4 cm av tårna saknas. Tårna är ett eget skal i AI-nätet, och ICP drar tillbaka tåns pol även när den grova passningen når fram.
- **Hästsvansen** är inte med (hår blir en egen del).

## Tätare ansikte: nivå 1f (2026-11-02)

Nivå 1 med fler rader och kolumner i huvudet: 7 368 trianglar i stället för 6 272, nätet slutet och resten av kroppen oförändrad. Nivåerna 1, 2, 3 och 6 är som förut. Huvudet är ett urval ur nivå 6, så ingen ny passning behövs och atlasen är densamma. `tools/head_select.py` väljer urvalet och skriver `tools/head_face.json`, och `tools/bake.py <namn> 1f --cpu` bakar.

- **Urvalet:** 10 extra rader och 6 kolumnpar (3,8–50,6° från mittlinjen), valda girigt mot båda badkropparna med ansiktet viktat högst. Ansiktets kolumner finns bara på raderna 6–78, och där antalet ändras sys ringarna ihop med trianglar.
- **Diagonalerna:** väljs per ruta i vänster halva efter vad som ligger närmast den fina ytan och speglas sedan till höger. På nivå 1 har alla rutor samma diagonal, vilket gör ansiktet osymmetriskt.

Avstånd från Pixal3D-ytan till mallen, framsidan av huvudet, mm i medel (p95):

| Nivå | Trianglar | Kvinna | Man |
|---|---|---|---|
| 1 | 6 272 | 2,12 (8,59) | 1,34 (4,50) |
| 1f | 7 368 | 1,07 (4,78) | 0,46 (1,48) |
| 3 | 57 312 | 0,55 (2,53) | 0,16 (0,66) |

Käkvecket i leran är borta.

## Ansiktsprojektionen (2026-11-02)

Förlagan projiceras rakt framifrån på huvudets UV. Skriptet ligger än så länge i `asset-studio/build/body_compare/project_face.py`, och resultaten i `project_2f/` och `project_2m/` där. Utöver den affina passningen gör det tre saker:

- **Lokal passning:** en utjämnad förskjutning (högst 6 px) mellan nätets bakade textur och förlagan flyttar käklinje och hårfäste. Ansiktets inre (en ellips från haka till ögonbryn) flyttas bara som helhet, eftersom Pixal3D:s drag där är utsmetade och annars vrider ögon och mun. NCC i huvudfönstret: kvinnan 0,574→0,608, mannen 0,391→0,480.
- **Käkens sidor:** det mörka bandet längs mannens käke låg redan i Pixal3D:s textur (5:e percentilen mot medianen i luminans 0,26), inte i projektionen. Mörka texlar där målas igen med huden runt omkring (cv2.inpaint); mannens värde blir 0,49. På kvinnan sjunker samma värde från 0,73 till 0,58, eftersom mörka streck från förlagan hamnar på kinden och vid örat. Det syns som små streck från 75°.
- **Vilka ytor som tas:** utanför ansiktet krävs att ytan vetter tydligt mot kameran (normalens z 0,45–0,75), inne i ansiktet räcker 0,15–0,4. Annars faller ögonvrårna tillbaka på Pixal3D:s ögon.

Provat och förkastat: att fortsätta det säkra ansiktets färger runt huvudet i atlasens rader. Det drog ut ögonbryn och ögon till öronen.

Kvar: små mörka streck på kvinnans kind från sidan, en svart flisa framför mannens öra, utdragna drag från 75° (kräver en andra vy), ett huvud som bara är 117–127 px brett i förlagan och hår som egen del.

## Kedjan

| Steg | Verktyg | Tid |
|---|---|---|
| Förlagor: hel kropp i A-pose fram och från sidan | `tools/gen_refs.py body` (Krea-2 Turbo, `character_art` utan miljö och motljus, vit bakgrund) | ca 80 s per bild |
| 3D av helkroppen | `tools/pixal3d.py` (img2mesh:s Pixal3D-körning genom GPU-kön) | ca 7 min |
| Passning | `tools/fit.py` (landmärken, grov passning, icke-stel ICP i två omgångar) | ca 2 min, CPU |
| Delbilder | `tools/crop_parts.py` (delens yta ur passningen som mask på framvyn, sedan Krea bild till bild) | ca 80 s per del |
| 3D av delarna | `tools/pixal3d.py` | ca 7 min per del |
| Förfining mot delarna | `tools/refine_part.py` (fungerar inte än, se nedan) | 1–3 min per del |
| Bakning | `tools/bake.py` (Blender, samma metod som `img2mesh/blender/lowpoly_bake.py`) | ca 20 s, CPU |
| Blandningar | `tools/blend.py` | ca 15 s per blandning |
| Bilder | `tools/render.py` (asset-studios förhandsvisning i Cycles på processorn), `tools/show*.py` (snabba punktbilder) | |

Resultat: `out/<kropp>_L<nivå>.glb` (`male_L3.glb` har kvinnan som morph target `female`), kartorna i `build/maps/`, passningarna och mätvärdena i `build/fit/`.

## Mallen (`tools/template.py`)

- **Delar:** bål, huvud, överarm, underarm, hand (handflata, fyra fingrar, tumme), ben, fot. Varje del är ett rör av ringar; huvud, fingrar, tumme och fötter sluter med en pol.
- **Sömmar** med samma antal hörn på båda sidor: hals 32n, armhål 16n (ett hål med 4n x 4n celler i bålens sida), armbåge och handled 16n, benöppningar 20n (halva bålens bottenring plus en grenbrygga med 4n-1 hörn, delad av båda benen), fotled 20n. Fingrarna: knogslingan delas av tre bryggor (2n-1 hörn) i slingor med 6n, 8n, 8n och 6n hörn; tummen sitter i ett hål i handflatan (8n).
- **Extra ringar** vid säte och bröst (täta rader i bålen), axlarna (kring armhålen), ansiktet (täta rader från haka till panna) och knä och armbåge.
- **Nivåerna är inbäddade.** Nivå n har n gånger så många rader och kolumner, och hörnet (del, rad, kolumn) på nivå n är samma hörn som (del, rad*6/n, kolumn*6/n) på nivå 6. Passningen görs på nivå 6 (230 000 trianglar), och spelnivåerna är ett urval av hörnen. Lågpolyn läggs alltså sist, och mallen bestämmer var polygonerna sitter.

| Nivå | Trianglar | Hörn |
|---|---|---|
| 1 | 6 272 | 3 138 |
| 2 | 25 376 | 12 690 |
| 3 | 57 312 | 28 658 |
| 6 (passning) | 230 112 | 115 058 |

Kontroll: nätet är slutet och manifold på alla nivåer (Euler 2), och nivå 1–3 ligger helt i nivå 6.

## Passningen (`tools/fit.py`)

1. **Upprätning.** Pixal3D:s `--align` lade kvinnan på sidan. I stället: längsta huvudaxeln uppåt, den smala änden (huvudet) upp, tårna framåt.
2. **Landmärken ur vågräta snitt.** Gren, armhåla, halsens smalaste ställe, haka (där framprofilen hoppar från halsen), fotled, häl och tå. Grenen förfinas med strålar i sidled, eftersom snitten sluter den smala glipan mellan låren. Armarnas leder läggs längs armens mittlinje, och handleden där armen är smalast.
3. **Grov passning.** Varje mallhörn skjuts ut med en stråle från sin dels axel (ring t, vinkel runt axeln) till första träffen på sin egen del av AI-kroppen. Armhålens slinga skjuts ut från axelleden, och benöppningarna och grenbryggan läggs mellan bålen och benen.
4. **Icke-stel ICP.** Närmaste punkt på delens AI-yta (med normalkontroll) och en Laplace-term som håller mallens form, med vikten sänkt i fyra steg. Först på nivå 3, sedan uppsamplat till nivå 6.
5. **Två omgångar.** Omgång 1 etiketterar AI-kroppen grovt efter skelettet. Omgång 2 etiketterar den efter närmaste malltriangel och lägger handens axel genom AI-handens punkter. Fingrarnas axlar hittas genom att punkterna bortom knogarna delas i fyra band tvärs över handen (k-means); varje finger får en mittlinje och en egen AI-yta.

### Avstånd till AI-kroppen (mm)

Nivå 6, per del. "mall→AI" är medelavståndet från mallens hörn till AI-ytan. "AI→mall" mäts från AI-ytan till mallen och visar vad mallen missar.

| Del | Man: mall→AI | Man: AI→mall (medel / p95) | Kvinna: mall→AI | Kvinna: AI→mall (medel / p95) |
|---|---|---|---|---|
| huvud | 0,02 | 0,44 / 0,71 | 0,03 | 6,06 / 52,5 (hårknuten) |
| bål | 0,03 | 0,46 / 0,92 | 0,03 | 0,23 / 0,63 |
| överarm V/H | 0,04 | 0,66 / 1,4 | 0,04 | 0,33–0,44 / 0,4–0,5 |
| underarm V/H | 0,02 | 0,05 / 0,17 | 0,01 | 0,02 / 0,08 |
| hand V | 0,15 | 0,51 / 1,8 | 0,26 | 2,1 / 12,8 |
| hand H | 0,21 | 1,49 / 12,8 | 0,18 | 1,51 / 11,5 |
| ben V/H | 0,02 | 0,08 / 0,3 | 0,02 | 0,06 / 0,2 |
| fot V/H | 0,03 | 0,17 / 0,4 | 0,02 | 0,08 / 0,3 |
| hela kroppen | 0,05 | 0,36 / 0,63 | 0,06 | 0,82 / 0,64 |

Per spelnivå, AI→mall i medel (p95):

| Nivå | Trianglar | Man | Kvinna |
|---|---|---|---|
| 1 | 6 272 | 2,5 (9,1) | 2,4 (8,3) |
| 2 | 25 376 | 1,0 (3,5) | 1,3 (3,4) |
| 3 | 57 312 | 0,6 (1,8) | 1,0 (1,7) |

## Vad som höll

- **Fast topologi med hål och broar.** Bål, armar, ben, huvud och fötter passar AI-kropparna inom en millimeter, med samma hörn hos mannen och kvinnan. Samma trianglar ger kvinnans byst och mannens platta bröstmuskler.
- **Lågpoly sist.** Inbäddade nivåer i stället för decimering. Nivå 1 (6 300 trianglar) håller med normalkartan nästan samma utseende som nivå 3 (bild "lod_row").
- **Bakning till mallens UV** med Blender på processorn (ca 20 s). Atlasen (`tools/uv_layout.json`, 22 öar, mer yta åt ansiktet och händerna) är fast för alla kroppar och nivåer.
- **Morph targets och blandningar.** Kvinnan är en morph target på mannen i samma GLB, och formen blandas rent (bild "blend_row").
- **Hakan som ankare** för huvudets rader gjorde att ansiktsdragen hamnar på samma rader hos båda. Utan den gav texturblandningen dubbla ögon.
- **Fingrar på mannen.** Fyra fingrar och en tumme passar (handen 0,5–1,5 mm), när fingrarna är åtskilda i AI-modellen.
- **Krea-förlagorna** i husstil blev bra som 3D-förlagor med jämnt ljus och vit bakgrund. Pixal3D gav detaljerade kroppar (bröstmuskler, revben och ansikte) på 7 minuter.

## Vad som inte höll (än)

- **Förfining mot delmodellerna.** Huvud, hand och fot gjordes ur egna delbilder (bild till bild ur helkroppens beskärning) och blev betydligt mer detaljerade än helkroppen. Men de är inte samma kropp: huvudet blev nedåtböjt med något annat ansikte, och handen fick en annan fingerställning. `refine_part.py` riktar in delen mot den kroppspassade malldelen (likformig ICP) och drar sedan mallen mot delen. Det ger dubbla drag: helkroppens ögonbrynsbåge plus delens ögon, och tvinnade fingrar. Foten blev en kort, snett beskuren fot med en bakplatta och riktades in fel (AI-delen 24 mm från mallen före, 4 mm efter, men i fel läge). Delarna används därför inte i resultatet; jämförelsebilderna finns i Apparition.
  - **Nästa steg:** passa malldelen direkt mot delmodellen, med egna landmärken och samma kod som för helkroppen. Sätt sedan delen på kroppen genom att rikta in sömslingan (handleden, halsen) och jämna ut några rader. Baka delens textur till dess UV-ö med färgerna anpassade till kroppens.
  - **Delbilderna:** en lägre denoise (0,3) eller ControlNet med helkroppens beskärning skulle hålla samma pose och person.
- **Kvinnans fingrar.** De ligger tätt ihop i AI-modellen, så banden tvärs över handen hittar inte fyra separata fingrar, och fingrarna blir tunna band (handen 1,5–2 mm, p95 12 mm). Knogarnas läge (52 % av handen) är en fast andel; detekteringen av glipor hittade inga på någon av händerna.
- **Ringfingret** på mannens högra hand är tillplattat.
- **Hårknuten** täcks inte av huvudets rör (6 mm på huvudet). Hår ska ändå vara en egen del (`hair.mjs`).
- **Texturblandning** tonar kläder och smink genom varandra. I spelet bör huden vara en egen textur som tonas mot hudton, och kläder egna lager.
- **Sidovyerna** från Krea blev en annan person (mannen i heltäckande dräkt). De används bara som referens; Pixal3D använder framvyn.
- **Sym-läget** (`--sym`, medel av hörnet och spegelhörnet) är inte provat på resultaten.

## Att göra

1. Delmodellerna som egna mål (ovan), med huvud och händer först.
2. Fingrar ihop: en reservväg när banden inte separeras (fingrar som fasta rör längs handens bredd, bara utjämnade).
3. Vikter: segmenten ger skinning nästan gratis (varje del har sitt ben; sömringarna blandas mellan två ben).
4. Fler förlagor (dvärg, äldre, tung), passade i samma mall, som fler morph targets.
5. Sömmarna ur `docs/character-generator.md` (axel, armbåge, handled, midja, knä, fotled) som kläder i lager ovanpå mallen.

## Noras huvud med hästsvans (2026-11-02)

Fyra närbilder gav Pixal3D ett huvud med bra form och hästsvans (`compose_head_views.py`, 499 582 trianglar), men med utsmetat ansikte. `tools/project_head.py` lägger bilderna direkt på nätet och ersätter hela Pixal3D:s textur (4096), recept i `build/nora_head/proj_recipe.json`:

- **Passning:** skala och ögonlinje från `compose_head_views` håller sökningen nära rätt. Helt fri sökning gav vänstervyn 20 % fel skala. Konturens IoU: 0,89 / 0,89 / 0,92 / 0,94.
- **Ögonen:** Pixal3D gör målad ögonskugga och bryn till påsar i nätet, så de jämnas ut (`smooth`) före projektionen. Annars blir ringarna kvar.
- **Ansiktets inre** (`inner`) tar bara framvyn, annars ritar sidovyerna fransar över ögonvrårna.
- **Hästsvansen** (`hair_zone`) tar bara hårfärg, annars får spetsen hud från halsen i bilden.
- **Det ingen vy ser** får färgen från närmaste sedda punkt i 3D (30 % av texlarna, mest under håret).

Spelupplaga: `tools/blender/decimate_head.py` ger 20 000 trianglar, 16 993 hörn, 2048-textur och 2,4 MB, med 0,65 mm medelavvikelse (p95 1,3 mm, räknat på 15,5 cm huvudbredd). Normalerna måste rensas och sömmarna svetsas före förenklingen, annars blir det svarta prickar.

`split_ponytail.py` körs nu utan minnesproblem, men delningen är inte klar: håret får med bakre delen av skalpen och huvudet får ett stort hål där (1 023 öppna kanter). Tills vidare är huvud och hår ett nät. Kvar: sätta huvudet på kroppen (skala, halssöm) och ben i hästsvansen.

Huvudet på kroppen: `tools/fix_front_profile.py` drar in framsidan mot sidoreferensen (Pixal3D lägger en kudde över underlivet, som mallen följer), högst 10,7 mm och nu inom 3 mm från referensen. `tools/attach_head.py` riktar in huvudet, formar halsen radiellt och tonar färgen, `tools/figure_glb.py` sätter ihop figuren med mjuka normaler: `build/nora_head/on_body/nora_full.glb`, 25 215 trianglar. Kvar: en spik vid nacken, en svag linje vid halssömmen, Pixal3D:s fläckar på axlarna och en för platt korsrygg (inte rättad, armen skymmer i referensen).

## Nora med MPFB (2026-11-02, sista provet)

Kroppen från recept i stället för AI-form: `tools/blender/mpfb_human.py` (spakar, female1605, low-poly-ögon, ponytail01, skelett) och `tools/project_human.py` (målning från referensbilderna, ansiktet inriktat på pupiller och mun). Resultat `build/nora_mpfb/nora_mpfb.glb`: kropp 3 168 trianglar (allt fyrhörningar), ögon 172, hår 5 352, 163 ben i `human.glb`. Skötet är slätt eftersom ingen form kommer från Pixal3D. Kvar: hårfläckar på käke och hals från sidobilderna, streck på benen, gråa hälar, skarvar i huden, armarna i bara hudton och i vilopose (posen i skriptet fungerar inte: `arm_angle_deg` lyfter armen i stället för att sänka den), hår för tungt. Figuren är inte målad i `human.glb`, så färdig målad modell med skelett saknas.

Omgång 2 med MPFB: `tools/fit_silhouette.py` drar kroppens hörn mot referensens konturer (bredd till under armhålan, framsidan, baksidan under midjan, högst 50 mm), och `project_human.py` passar närbilderna mot hela huvudets kontur med tunn-plåt-funktion. Pupiller ensamma gav ett för litet ansikte, eftersom MakeHumans ögon sitter tätare än Noras. Patrik: upplösningen (female1605) räcker.

Omgång 3 med MPFB: `fit_silhouette.py` passar nu ryggen hela vägen upp (armen skymmer inte konturen, som jag först trodde), inom 1 mm på de mätta höjderna. `tools/fit_head.py` formar huvudet efter närbilderna med tunn-plåt-funktion (bredd, pupiller, mun, haka, profil) med skalan från helkroppsbilden: profilens fel 10 → 2,4 mm i medel (p95 9,4). Lärdom: läpparna ska sökas minst 2 cm under nästippen, annars skevar hela nedre ansiktet. Kvar: bred käke, hak i höften bakifrån, ring vid halsen, streck på benen, armarnas pose, skelett på den målade modellen.

Omgång 4 med MPFB, Patriks metod: `tools/fit_brush.py` lägger modellens kontur över referensen, drar konturhörnen till bildens kant med viktad pensel (radie 1,6–5 cm, mjuk avtoning, bara ytor åt samma håll) och ritar `build/nora_mpfb/overlay.png` före och efter. Felet längs konturen: huvud i profil 1,3 → 0,5 mm, bål framifrån 1,4 → 0,5 mm, kropp från sidan 16,5 → 7,0 mm (p95 68 mm, troligen hörn där armen eller handen ligger över kanten), huvud framifrån 5,7 → 3,5 mm (p95 33 mm). Överlagringen avslöjade att armfiltret (|x| > 19 cm) höll ytterhöften stilla, vilket gav haket i höften: rättat i `fit_silhouette.py` och `fit_brush.py`. Konturer passar bara utsidan; ögonhålor och käkvinkel syns inte i någon kontur.

Omgång 5 med MPFB, ansiktet: `tools/face_points.py` (MediaPipe) hittar 478 punkter på referensen och på modellen renderad med MakeHumans hud (`tools/blender/face_render.py`). `tools/blender/face_loops.py` lägger loopar kring ögon och haka (3 168 → 4 242 trianglar, mer än väntat). `tools/fit_face.py` drar hörnen till punkterna med konturen fastnålad. MediaPipe gav hakan på rad 1001 mot min egen mätning 945, alltså cirka 14 mm: det var därför hakan saknades. `project_human.py` lägger nu närbilderna rakt via kalibreringen. Normalerna måste räknas över sömmarna, annars blir ytan kantig. Kvar: tillplattad mun, kraftig haka, kant under hakan, veck vid ögonen. `head_calib.json` har kvar den gamla hakans höjd (`chin_y`), den styr bara gränsen mellan närbild och helkropp.

## Pixal3D, finmesh-inställningar (2026-11-02)

Nora från fyra vyer, samma seed, `img2mesh/fine_variants.py`. Jämförelse i lera: `build/nora_fine/compare.png`. Dagens inställningar: skåra och kulle vid underlivet, trasigt ansikte. CFG 3,5 i form och uppsampling (noderna 18 och 23): renast bäcken och slätast form, men rivna ögon. Uppsampling 1536 (nod 94): helt huvud med tydlig haka, men hårslingor utskurna i skallen och svag kulle kvar. 40+24 steg: sämst, ansiktet som en lös mask. Uppsampling under 1024 tillåts inte. Alla har hål i hästsvansen. Bara en körning per variant. Ej provat: CFG 3,5 tillsammans med 1536, lägre CFG, andra seeds, och nod 241 (remesh) och nod 4 (tröskel).

Kombinationen CFG 3,5 + uppsampling 1536 (`nora_fine_cfg35_res1536.glb`, jämförelse `build/nora_fine/compare2.png`) tar inte det bästa från båda: rund skalle och mjukare ansikte, men fransiga bikinikanter, veck i midjan och ojämnt hårfäste. Högre upplösning tar fram mer brus. CFG 3,5 är renast för bålen.

## Gles nivå s (2026-11-03)

Nivå `s` i `tools/sparse.py`: 2 492 trianglar och 1 248 hörn, nätet slutet (Euler 2), och alla hörn finns på nivå 6, så passningar, atlas och morph targets gäller. Budgeten kommer från Tripo P1-kroppar i `../lowpoly-test`, grovt per del (Yvonne / Sandra / nivå s): huvud 732 / 1 054 / 794, bål 906 / 740 / 524, armar 166 / 88 / 192, händer 372 / 564 / 344, ben 466 / 372 / 396, fötter 296 / 194 / 242. Delningen där är på höjd och avstånd från mitten, medan nivå s räknas på mallens egna delar, så bålen är inte helt jämförbar.

Kolumner: bål 18, arm 8, ben 11. Bakas med längre strålar (`tools/bake.py`: extrusion 0,03, ray 0,09), annars blir det grå fläckar på bröst och axlar. Bilder: `tools/wire_sheet.py` (körs med `../lowpoly-test/.venv`, som har OpenCV).

Inte klart: axlarna är kantiga och bysten glesare än hos P1, och armarna har inte provats i rörelse. Diagonalerna i ansiktet är bara speglade, inte valda mot ytan. Karaktärens ansikte är fortfarande Pixal3D:s.

## Yvonne som grund (2026-11-03)

Yvonne är den nya grunden för kvinnokroppen. Fyra vyer ur `../lowpoly-test/input/yvonne/` gav `build/pixal3d/body_yvonne.glb` (CFG 3,5, 699 993 trianglar). Passningen `build/fit/yvonne.npz` (längd 1,70 m) ligger 0,27 mm från ytan i medel. Nivå s: `out/yvonne_Ls.glb`, med ansiktet från närbilden `out/yvonne_Ls_face.glb` (`../lowpoly-test/recipes/yvonne_engine_face.json`).

Avstånd till ytan i medel: nivå s 3,9 mm (p95 13,7), 1f 1,6 mm (p95 6,0). Kvar: hudton och kläder från Pixal3D (rosa hud, grå behå, medan P1 ligger närmare förlagan), knuten saknas i mallen och behöver bli en egen del, axlar och byst är grova, och ingen rigg är provad.

## Nivå s efter domarvarven (2026-11-03)

3 250 trianglar. Zonen över byst, armhåla och axlar har 26 kolumner, armhålet 16 hörn och armen går ned till 8 efter två ringar. Grenen är ett band på 2 x 3 rutor mellan benen, och benen har 10 kolumner. Diagonalerna speglas kring mittlinjen på bålen.

`tools/refine_s.py` flyttar hörnen fritt mot AI-ytan (`build/fit/<namn>_s.npz`, läses av `export.py`). Yvonne: 1,66 mm i medel, 4,8 mm vid 95:e percentilen. `tools/closeups.py` ritar ark per problemområde åt en domare. Siffrorna räcker inte: ansiktet låg 1,8 mm från ytan men var ett slätt ägg.

Ansiktet är ett eget kapitel. Rutnätet är fel väg, även tätt: kanterna måste följa ögonhåla, näsrygg, mun och käke, från landmärken, och texturen fejkar resten.

## Roboten (2026-11-03)

`tools/make_robot.py` (körs med body-gens `.venv`), `out/yvonne_robot.glb`: 2 904 trianglar, sluten, 0,13 MB, 17 ben, testklipp. Kroppen är nivå s, huvudet Tripo P1:s, där kanterna följer hårgräns, öra, ögonhålor, näsa, mun, käke och nacke, sytt till bålens rad 108. Skelett och vikter räknas ur mallens delar. Bilder på poserna: `build/robot/poses.png`.

Domaren på låg upplösning, alla fynd misstänkta: knän 3/10, höfter 4, armbågar 5, axlar 6, hals 6. Kvar: knäet och höften behöver fler ringar eller andra vikter, underarmen har ingen vridled, fingrarna böjs inte och huvudet är Yvonnes eget, inte en mall som går att föra över på andra kroppar än. Nivå s egna huvud har onödigt tät hals: ansiktets kolumner börjar under hakan (`HEAD_FACE_ROWS`).

Knän och höfter (samma dag): `out/yvonne_robot_v3.glb`, 3 024 trianglar. Knäleden ligger i benets rad 7, där benet är smalast, med övergången över raderna 6 till 8. Höftleden ligger 3 cm över benöppningens överkant. Framsidan av höften följer bäckenet och skinkan följer låret (`make_robot.py`). Domaren före sista varvet: knän 6, höfter 5. Benets rader 3, 5 och 9 är nya.

## Body Editor (2026-11-03)

`tools/editor/` (öppnas på http://127.0.0.1:8772, serverkonfigurationen `body-editor`). Patrik drar i nätet med en pensel, med spegling, och kan se poserna och den täta ytan. Ändringar i en böjd pose gäller bara den posen. Anteckningar fästs på hörn.

Sparat: `build/fit/<namn>_edits.json` med `vertices` (ändring per mallhörn), `pose_vertices` (per pose) och `notes`, med en kopia per sparning i `build/edits/`. `make_robot.py` lägger `vertices` ovanpå det beräknade nätet och bygger en ny fil. Läs den här filen när Patrik sagt att han rättat något: stora ändringar i ett område är en signal om att mallen, vikterna eller lederna ska ändras där. `pose_vertices` påverkar bara poserna i `build/robot/`, inte GLB:n. Testet: `tools/editor/ui_test.json`; WebGL fungerar inte i appens webbläsarpanel.

Editorn fick polygoner (samma dag): verktygen Point, Soft, Faces, Loop cut, Draw cut och Note. Faces: Ring, Column, Grow row, Same slope, Halve rows, Merge rows, Merge columns, Into one, Add row, Add column. Sammanfogning sker bara där lutningen skiljer mindre än gränsen. Nätet sparas som `build/fit/<namn>_mesh.json`, och `build_mesh.py` bygger nästa robot ur det. `operations` och `removed_points` i `_edits.json` säger vilka rader som tagits bort: det är signalen för att ändra `TORSO_ROWS` och `KEEP` i `sparse.py`. Det sparade nätet följer inte med när `make_robot.py` körs på nytt; loggen måste då översättas till mallen.

Editorn, urval och återkoppling (samma dag): verktyget Edges (kantslingor, ta bort, flytta). Point väljer flera (shift, ctrl, ruta) och kan flytta med falloff. Brush har storlek och hårdhet. Det man pekar på lyser upp, shift och ctrl förhandsvisar band och slingor, och penseln färgar punkterna efter hur mycket de följer med. Tester: `tools/editor/ui_test.json` (sparar), `ui_test_select.json`, `ui_test_hover.json`.

Editorn, versioner och referenser (samma dag): varje sparning behåller sitt nät i `build/versions/<modell>.json` (`mesh` och `edits`), och listan Open version öppnar dem. Platta vyer med knappar och tangenterna 1, 3, 7, Ctrl+ för motsatt håll, 5 för 3D. Referensbilder per vy i `build/editor/refs/` med inställningarna i `<namn>.json`: placering bakom eller i mitten, opacitet, storlek, läge och Fit to body. Personens vyer i `../lowpoly-test/input/<namn>/` läggs in första gången. Målning återstår och kräver UV på roboten, som i dag saknar textur. Test: `tools/editor/ui_test_refs.json`.

Editorn, symmetri och In/Out (samma dag): Faces har Head, dragmarkering och Symmetry (Use this side, From left, From right). Symmetry skär de valda ytorna vid x = 0, speglar källsidan, tar bort motsvarande ytor på andra sidan och syr igen glipan; blir nätet inte slutet backar kommandot. Skelettvikterna byter sida. På Yvonnes huvud: spegelpunkter från 3,6 % till 98,6 % (grundnät) och 100 % (v4), men 166 respektive 90 fler ytor, och P1-huvudets mitt ligger inte exakt på x = 0. Move har Free och In / Out (längs varje punkts normal, tangent I), och See through tar dolda punkter (tangent X). Tester: `ui_test_symmetry.json`, `ui_test_inout.json`.

Editorn (samma dag, senare): menyerna delade, visning till vänster och verktyg till höger. Platta vyer låses från början (Lock view, tangent L): ingen vridning, men panorering och zoom. Nya sparningar heter `out/yvonne_v<n>.glb` och är enfärgade; "roboten" var bara ett steg på vägen, och `make_robot.py` heter så bara internt. Äldre filer `yvonne_robot*.glb` ligger kvar orörda.

Point har Row och Column (dubbelklick och Shift+Ctrl-klick tar raden). Rader stannar vid punkter som inte har fyra kanter. Genomskinligt läge färgar punkter och kanter efter avstånd till kameran, och den närmaste punkten vinner vid klick. Tester: `ui_test_rows.json`, `ui_test_depth.json`.

In / Out räknar "ut" från ytorna runt punkten, utan punktens egna (`outward` i `tools/editor/index.html`). Där grannarna tar ut varandra (smala delar, `THIN_PART`) gäller punktens egna ytor. Skillnad över 45° mot den gamla räkningen på grundnätet: 70 av 1 514 punkter, mest huvudet (40), armhålan och bålen; inte granskade en och en. Test: `ui_test_outward.json`.

## Huvud ur konturer (2026-11-03)

Patriks idé: inget mall-nät och ingen AI-modell, utan konturer och några få principer. `tools/head_measure.py` läser hårfäste, bryn, näsrot, näsans spets, läppar, haka, ögon och munhörn ur en framvy och en sidovy. `tools/head_builder.py` bygger volymen (superellips per höjd) och en tabell med polygoner för halva ansiktet: ögonhålans båge och kant, näskilen, munnen och käken. Andra halvan speglas. Bakhuvud, hjässa och hals är ett glest rutnät, knuten och öronen egna delar. Regler och tal, inga Yvonne-specifika hörn, men bara provat på Yvonne. `tools/head_sheet.py` ritar jämförelsen, `tools/head_attach.py` sätter huvudet på en sparad kropp som en ny version.

Resultat: `out/yvonne_head.glb` (562 trianglar, 102 ansiktspolygoner) och `out/yvonne_newhead.glb` (på v5, 2 848 trianglar, version `yvonne_newhead` i editorn). Kontur mot bilden 90 % framifrån, 92 % från sidan. Domaren: 3, 3, sedan 4 av 10, P1-huvudet 5, 5 och 3, så domarens tal är ostadiga. Kvar: tungt bryn, bred käke, blockig näsa, hårkanten viker sig vid tinningen, och ögon och mun saknar textur. Det domaren kallade för djup skalle och bred hals är uppmätt ur bilden; håret räknas in.

Patriks tre åtgärder på huvudet (samma dag): halsen krymps i x och z men inte i höjd (`NECK_SCALE` 0,82), valvet fick en punkt till (`b_peak`), och näsans ändpunkter dras rakt ut (`NOSE_OUT` 6 mm). Hakan och profilen blev tydligt bättre. `out/yvonne_newhead_2.glb`.

Halsen mot bålen (samma dag): `tools/fit_neck.py` gör bålens översta ring till halsens nederkant och låter ringarna under glida över i axlarna, och `tools/head_attach.py` gör det på nya huvuden. Patrik bad att få `yvonne_v7` överskriven; originalet ligger i `build/backups/yvonne_v7_before_neck.*`. Kvar: täta veck i kragen, där 26 kolumner trängs ihop.

## Högerklicksmenyn i Body Editor (2026-11-03)

Högerklick utan dragning öppnar en meny, högerdrag panorerar som förut. Menyn visar val för det verktyget pekar på: punkt/punktgrupp, kant, yta, och alltid Object.

- Point: Select row/column, Move in and out, Move freely, Merge into one, Smooth, Move to the middle, Copy to the other side.
- Edge: Select loop, Select this edge, Remove edges, Merge its two ends, Add a point here, Cut a loop here.
- Face: Select ring/column, Grow, Same slope, Halve/Merge rows, Merge columns, Merge into one, Add a row/column, Move the twin to match.
- Object: Select all faces, Select the head, Cut at the middle, Mirror this half onto the other, Delete the other half, Delete this half, Add a note. "This half" är sidan under muspekaren.

Merge vägrar om det skulle ge hål. Test: `tools/editor/ui_test_menu.json`, `ui_test_menu2.json` (öppnar grundnätet, sparar inget).

## Merge i Body Editor och svetsning av delar (2026-11-03)

Merge (knapp i Point, tangent M, menyn) gör alla markerade punkter till en, i deras mitt eller i den högerklickade punkten. Det stoppas aldrig: ytor som klappar ihop försvinner, och Undo tar tillbaka allt. Med spegling blir varje sida en punkt; är en mittpunkt med blir allt en punkt på mitten.

Poserna är dolda i editorn: nu modelleras det bara, nästa steg är kanske målning.

`tools/weld_parts.py` syr in lösa delar (öron, knut) i skalet. yvonne_v8 = v7 med det gjort, en ö och tät. Inte inkopplat i head_builder/head_attach än.

Mätt men inte rättat i v7/v8: huvudet är 7 mm smalare per sida än det byggda och näspunkterna har gått över mitten. Troligen en dragning av hela huvudet med spegling på: x-rörelsen speglas, så halvorna går mot varandra.

## Quad-verktygen i Body Editor (2026-11-03)

Show > Tris and n-gons färgar trianglar gula och n-hörningar röda, med antal. Statusraden visar quads, tris och n-gons efter varje operation. Under Faces och i menyn: Select tris, Select n-gons, Tris to quads (par av trianglar, med en gräns för hur mycket rutan får vika sig, 40° som standard) och Split n-gons. De gäller markeringen, eller allt utan markering, och görs på båda sidor med spegling.

På yvonne_v8: 330 tris blev 162 med 40° (84 quads). Med 90° blir 148 kvar, så resten saknar en grannetriangel att paras med. Test: `tools/editor/ui_test_quads.json`, sparar inget. Ansiktstabellen i head_builder är inte omskriven än.

## Dragning över mitten i Body Editor (2026-11-03)

Går punktmarkeringen över mitten (både en mittpunkt och tvillingpar är med) stängs sidledes rörelse av när speglingen är på, så att halvorna inte dras mot varandra. Upp, ned, fram och bak fungerar. In/Out och två skilda delar, som en rad på vardera benet, påverkas inte. Vill man ändra bredden markerar man en sida. Test: `tools/editor/ui_test_mirror_drag.json`, sparar inget.

## Buren i Body Editor (2026-11-03)

Cage (knapp under Point och Faces, tangent B, menyn) lägger en låda runt markeringen. Varje punkt behåller sin plats i lådan, så formen följer med. Hörn böjer, sidor sträcker längs lådans axel, mitten flyttar och Shift på ett hörn skalar jämnt. Med båda sidor markerade är lådan symmetrisk och tvillinghörnet speglas; med en sida följer tvillingpunkterna. I platt vy går hörn som ligger på varandra ihop, och sidor som vetter mot kameran döljs. Punkter utanför markeringen följer inte med. Test: `tools/editor/ui_test_cage.json`, sparar inget.

Elastisk räckvidd (Cage: elastic reach, 6 cm från början, 0 stänger av): punkter utanför lådan följer med längs ytan, nästan helt närmast och inte alls vid räckvidden. Spaken går att ändra medan lådan är öppen. Dragningar avslutas nu också om knappen släpps utanför fönstret.

## Redo och Undo på referenser i Body Editor (2026-11-03)

Undo och Redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y) gäller nu både nätet och referensbilderna, i samma ordning som ändringarna gjordes. En hel dragning i en spak är en ändring. Att ladda en ny bild går inte att ångra, eftersom filen skrivs över. `tools/editor/ui_test_history.json` skriver referensinställningar, så kör den med en kopia av `build/editor/refs/yvonne.json` och lägg tillbaka den efteråt.

## Smooth eller Faceted vid sparning (2026-11-03)

Knapparna ovanför Save and build väljer hur GLB:n skrivs. Smooth delar hörnen mellan ytorna. Faceted ger varje polygon egna hörn och en normal, så att quads blir plana utan synlig diagonal, och filen blir ungefär tre gånger större (v10: 1 537 hörn och 143 kB mot 6 406 hörn och 447 kB). Nätet i editorn och versionsfilen är desamma. Test: `tools/editor/ui_test_shading.json`, fångar sparningen i sidan.

## Spegelpunkten i valet (2026-11-03)

Med spegling väljer Shift-klick både punkten och dess tvilling, också för de punkter som redan var valda. Ctrl-klick tar bort båda. Rutdragning väljer som förut bara det som ligger i rutan. Buren: går markeringen över mitten blir lådan en runt allt; två skilda delar får en låda på ena sidan och tvillingarna följer speglat. Test: `tools/editor/ui_test_mirror_select.json`.

## Force quads och Square up (2026-11-03)

Force quads (knapp, Object i menyn) gör hela modellen till quads i ett steg: slår ihop trianglar som ger hyggliga rutor (högst 50° från rät vinkel, 60° vikning), delar n-hörningar, och drar en smal rad genom rutorna mellan de trianglar som är kvar. På ett slutet nät är antalet trianglar alltid jämnt, så alla får en partner. En rad som svänger lägger en punkt mitt i rutan. Till sist dras hörnen mot rät vinkel längs ytan: nya punkter fritt, gamla högst 6 mm. Med spegling görs det på vänstra halvan (+x) som speglas, så högersidan ersätts. Square up gör samma räta vinklar på markeringen eller allt, högst 12 mm. Allt är ett Undo. Test: `tools/editor/ui_test_force_quads.json`, sparar inget.

Resultat på yvonne_v13 med spegling: 1 410 quads, 286 tris och 8 n-hörningar blev 1 774 quads, sluten, alla ytor med tvilling, 1 574 punkter blev 1 782. Hörn över 60° från rät vinkel: 182 blev 60. Konkava eller raka rutor ökade dock från 33 till 56, och över 45° (inklusive de konkava) från 177 till 264. Grundnätet är osymmetriskt och går inte att spegla ihop: då ändras inget och ett meddelande visas.

## Genväg på skrivbordet (2026-11-03)

`tools/editor/install_launcher.sh` lägger Body Editor i appmenyn och på skrivbordet. `tools/editor/launch.sh` startar servern som enheten `body-editor-server` om den inte svarar och öppnar ett eget Chrome-fönster på RTX-kortet, med profilen `~/.var/app/com.google.Chrome/data/body-editor`. Finns fönstret lyfts det fram. Referensinställningar ligger på servern, men valet Smooth/Faceted sparas per Chrome-profil.
