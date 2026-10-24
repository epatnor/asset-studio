---
id: foliage-double-sided
area: trees
technique: 3
status: untested
priority: low
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Dubbelsidiga löv

**Läge:** `gen_tree.mjs:150` sätter `doubleSided(false)`. För `crown` är det rätt: den ogenomskinliga massan döljer kortens baksidor och sparar fragment. För de två `canopy`-arterna (utan massa) kan kort som pekar bort synas som hål underifrån.
**Idé:** Rapportens `CULL_DISABLED` motsvaras av glTF `doubleSided: true` (Three.js `side: DoubleSide`). Viktigt: Three.js vänder normalen på baksidan (`faceDirection` i `normal_fragment_begin`), vilket förstör de sfäriska normalerna. Lövshadern i `showcase/materials.js` måste då hoppa över vändningen för löv.
**Ändring:** Parameter per art; `gen_tree.mjs` sätter `doubleSided` därefter. Klienten: för `FOLIAGE` ersätt `normal *= faceDirection` med att behålla normalen.
**Parametrar:** `foliage.doubleSided` (standard false).
**Test:** Kontaktark underifrån för `canopy`-arterna, före/efter. Med kod: `alpha_tris_lod` oförändrat (samma geometri), men räkna med dubbel fragmentkostnad.
**Risker:** Overdraw i skogen. Bör inte slås på för `crown`.
