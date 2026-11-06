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
