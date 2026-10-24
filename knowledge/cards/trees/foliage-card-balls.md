---
id: foliage-card-balls
area: trees
technique: 1
status: untested
priority: high
source: videon i knowledge/reports/2026-10-24-stylized-trees.md (Patriks genomgång 2026-10-24)
---
# Kortbollar

**Läge:** Testat 2026-10-24 som lövtypen `cardball` (`tools/tree/cardball.mjs`, arten `cardtree` i `species.json`). Bilder på Apparition-tavlan "Tinkertown - Träd", grupperna "Lövark (test)" och "Kortbollar (test)".
**Idé:** 6–9 lövkort korsas i samma centrum med olika rotation och bildar en rund buske. Ungefär fem bollar i klasar på skelettets kvistar blir en trädkrona.
**Ändring:** Korten är dubbelsidiga som egen geometri (fram- och baksida med egna normaler), så att materialet kan vara enkelsidigt och de sfäriska normalerna hålls hela. Vertexfärgen ger mörkt mättat inre och sval undersida (kort 6 inbyggt). Atlaser görs med `tools/texture/make_leafsheet.py` (white, painted, color; fina löv i kvistar, `leaffine_sprig`, är standard: grova löv blev för klumpiga för träd) eller med Krea-2 (`make_atlas.py`).
**Parametrar:** `clusters`, `ballsPerCluster`, `cardsPerBall`, `ballScale`, `cardScale`, `cardOffset`, `cardGrid`, `minBall`, `maxGrow`, `normalBlend`, `normalOffset`, `normalLift`, `innerTint`, `bottomCool`, `bottomCoolStrength`, `gradientFalloff`.
**Test:** `checks.uncovered_twigs == 0` och `checks.ok`. Fem bollar: 38 kort, 1 368 alfatrianglar i LOD0 (crown-eken har fler).
**Risker:** Stora alfakort ger overdraw i tät skog. `color`-atlasen blir för mörk eftersom vertexfärgen mörkar en redan mörk palett, så den behöver ljusare `innerTint`.

**Kortstorlek (2026-10-24):** Med 6–9 kort genom centrum blev varje kort 4 m och löven ca 31 cm, vilket gav en grovhuggen krona. Standarden är nu 30–36 mindre kort per boll, spridda mot skalet: `ballScale` 1,8, `cardScale` 0,37, `cardOffset` 0,75 och `cardGrid` 3. Det ger kort på ca 1,7 m och löv på ca 13 cm. Fylligheten mäts med `checks.silhouette_m2`, kronans yta framifrån utan genomskinliga korthörn: 29,5 m² mot 27,4 för de stora korten, och 2 768 alfatrianglar i LOD0. Kvistar utanför bollarna får närmaste boll att växa, högst 40 % (`maxGrow`). Den kluvna stammen samlar kvistarna tätt och ger mindre kronor även med `minBall` 0,15.
