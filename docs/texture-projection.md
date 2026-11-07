# Texturer genom projicering: plan

Mål: Krea-2:s målade yta (den Patrik tycker bäst om) på hela modellen, utan skarvar, överlappningar och kryss där vyerna möts.
Verktygen är `tools/texture/project_views.py` (projicering) och beställningsrunnern på Darrowmere (`tools/darrowmere/runner/`),
som målar vyer med Krea-2, projicerar, renderar i Blender och låter DeepSeek granska.

## Läget (2026-11-06)

Gjort och provat på roboten (`build/robot/`):

- **Toppvy** mot krysset på hjässan, där fyra sneda vyer möttes.
- **Ett gemensamt ark** för fyra vyer, så att Krea-2 målar dem lika, och **förfining** av varje vy i full storlek med låg denoise (0,25).
- **Symmetri** för kroppar: höger = speglad vänster, och `mirror_axis` gör vänster och höger lika över spegelplanet. Inte för
  kläder och rustning som inte är symmetriska.
- **Uppriktning** mot renderingen med optiskt flöde (bara betrodda punkter, kontroll fram och tillbaka) och **två frekvensband** i
  blandningen. Flödet räddar bara en del av Krea-2:s förskjutning (4–6 px); orsaken ligger i målningen.
- **Nio vyer** (8 runt om + toppen): de sneda målas över renderingar av den redan texturerade modellen, med låg denoise.
  Patriks bedömning (2026-11-06): **suddig och sneda texturer, inte bra.** Fler vyer som blandas ihop gör ytan suddigare
  (Krea-2:s detaljer hamnar några pixlar olika i varje vy och medelvärdet smetar ut dem), och de sneda vyerna målade över
  den redan texturerade modellen förstärker suddet.
- **En vy per yta** (`"blend": "best"`, 2026-11-06): ingen blandning, varje yta från den vy som ser den rakast. Skarpare
  (Laplace-varians +35–40 %), men fläckigt där Krea-2:s vyer inte är överens (tydligast på hjässan, där topp- och
  snettvyerna målat olika). Blandningen gömde alltså oenigheten som sudd; grundproblemet är att vyerna inte är samstämmiga.
- **Sömnad** (`"blend": "stitch"`, 2026-11-07): en vy per yta, men vyvalet görs över ett grannskapsnät av 60 000
  ytpunkter där en skarv kostar efter färgskillnaden mellan vyerna, och den skillnad som är kvar jämnas ut med en mjuk
  korrektion per vy över hela nätet (glesa minsta kvadrater, som Waechter m.fl. 2014). På 6-vyersarket: färgskillnaden över
  skarvarna 0,13 → 0,05, skärpan behållen (huvudet 140 mot 137). Hjässan och huvudets sida blev enhetligt mörka i stället
  för vita fläckar; DeepSeek gav ändå warning 6 för hjässan. Kvar: där Krea-2 målat **olika design** (vit hjälm i en vy,
  mörk i en annan) kan sömnaden bara välja en av dem, inte göra dem lika. Det löses vid källan (idé 1 och 3).
  Order `robot-sheet6-stitch`, ark i `build/robot/stitch/cmp/`.
- **Krea-2 över UltraTex** (2026-11-07, order `robot-ultratex-krea-stitch`): UltraTex-robotens jämna textur som underlag
  (sex renderingar med samma kameror som projiceringen, toppvyn med zoom 2), Krea-2 över arket med denoise 0,35 och
  förfining 0,2, stitch-projicering och `"fill": "baked"` (det ingen vy ser behåller UltraTex). **Bästa hittills:**
  hjässan är en sammanhängande mörk hjälm, sidan och ryggen hänger ihop, DeepSeek warning 7 (mot 6). Kvar: ansiktet
  lite smetigt, händerna utsmetade, några små turkosa prickar på axlarna. Obs. licensen: UltraTex (FLUX.2 Klein 9B) är
  icke-kommersiell, så underlaget måste bytas (Meshy eller eget) innan det används i ett spel som säljs.
  GLB: `build/robot/ultra_krea/robot_ultratex_krea_stitch.glb`.
- **Granskning** med en rundtur i Blender (32 bilder, huvudet från alla håll, lera, trådnät), nätets siffror och rigg-bedömning.

## Idéerna, i ordning

1. **Djupstyrd målning** (påbörjad). Krea-2 målar varje vy styrd av modellens djupkarta (Krea2 Control-LoRA för djup, noderna
   finns i ComfyUI-GGUF-Loader) i stället för fri img2img. Detaljerna hamnar där geometrin är, så förskjutningen och skarvarna
   från den försvinner vid källan. Mät förskjutningen före och efter (samma flödesmått som nu).
2. **Varv på varv med DeepSeek som pekare.** Efter projiceringen pekar granskningen ut zoner med skarvar; runnern renderar just
   dem med en kamera rakt mot ytan, förfinar med låg denoise och projicerar igen.
3. **DeepSeek som art director.** 2–3 frön per vy, DeepSeek väljer bästa vyn per vinkel innan projiceringen.
4. **Materialsegmentering** med SAM 3 (textprompter: vit plastplåt, mörk metalled, lysande öga, röd detalj; för människor hud,
   hår, ögon, läppar, tyg). Maskerna projiceras som färgerna och röstas fram per punkt; varje material får egna PBR-värden
   (ruffighet, metall, emission). Ger roboten riktig metall och blank plast.
5. **Texturering per del.** Inom varje del en ren grundfärg (texturverkstadens målade variation) och bara detaljerna från
   projiceringen; skarvar läggs längs delarnas kanter, där de inte syns.
6. **Kröknings- och kavitetskartor** bakade i Blender för stilguidens stiliserade PBR: ljusare kanter, mörkare fördjupningar,
   slitage. Ingen AI, helt samstämmigt.
7. **Bakning till spelmodellen.** Hela kedjan på den högupplösta modellen, sedan färg, material och normaler bakade till
   spelmodellens UV (Meshys låga modell eller kroppsmallen i body-gen).

Varje steg körs som en beställning (`order.py submit`), syns i panelen och granskas av DeepSeek; jämför alltid med föregående
steg på samma vinklar (Blenders rundtur med samma `front_yaw`).
