---
id: foliage-wind
area: trees
technique: 8
status: implemented
priority: low
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Vind

**Läge:** Finns. Generatorn skriver `_WIND` (0 vid fästet, 1 i spetsen) och `COLOR_1` enligt stilguiden (R höjd, G rörlighet, B fas per kluster), så att Unreal/Godot/Unity kan läsa det. `checks.wind_torn` (`gen_tree.mjs:164`) säkrar att hörn i samma punkt har samma vikt. Klienten gungar i `materials.js:104` med `uWind` och `uTime`.
**Idé:** Som i rapporten.
**Ändring:** Ingen.
**Parametrar:** `uWind` i klienten.
**Test:** `checks.wind_torn == 0`; `tools/tree/check_wind.mjs`.
**Risker:** —
