---
id: foliage-clustered-cards
area: trees
technique: 1
status: implemented
priority: low
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Lövkort i kluster

**Läge:** Finns i två varianter. `canopy.mjs`: lövpunkter från skelettet → k-means → 8–20 ellipsoider → böjda kort på klustrens skal (`flattenY`, `droop`, `innerShare`, `cardAspect`). `crown.mjs` (v4, 14 arter): klumpar vid kvistarna smälts ihop till ett avståndsfält, ytan blir en ogenomskinlig massa och täcks av små kort.
**Idé:** Som i rapporten, men vi har gått ett steg längre: korten sitter på ett sammanhängande fält i stället för fria sfärer, och allt utgår från skelettet.
**Ändring:** Ingen.
**Parametrar:** Rapportens `cards_per_cluster`, `cluster_radius`, `cluster_shape`, `card_size_range`, `rotation_jitter` motsvaras av `cards`, `clumps`, `cardSize`, `bottom`, `lump`, `fill` i `species.json`.
**Test:** `checks.floating_cards`, `checks.floating_clusters`, `checks.uncovered_twigs`.
**Risker:** —
