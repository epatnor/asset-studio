---
id: foliage-no-specular
area: trees
technique: 5
status: implemented
priority: high
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Ingen spekular på löv

**Läge:** Löv har roughness 0,85, massan 0,9, metallic 0. Men MeshStandardMaterial har alltid F0 = 0,04, så strykljus ger ljus glans i kronkanten.
**Idé:** Rapportens `specular_mode = disabled`. I glTF finns `KHR_materials_specular`, men det gör materialet till MeshPhysicalMaterial (dyrare). Billigare: stäng av spekularen i klientens lövshader.
**Ändring:** `showcase/materials.js`, för `FOLIAGE`: nolla `reflectedLight.directSpecular` och `indirectSpecular` före `opaque_fragment`, styrt av en uniform. Generatorn sätter roughness 1,0 på löv.
**Parametrar:** Klientuniform `uSpec` (standard 1 = som nu); `foliage.roughness` i artdata (standard 0,85).
**Test:** Kontaktark i motljus/strykljus, före/efter. Med kod: inga.
**Risker:** Kronan kan se matt och platt ut; genomlysningen (`uTrans`) får bära ljuset.

**Gjort 2026-10-24:** `uLeafSpec` (standard 0,15) i `showcase/materials.js` dämpar spekularen på löv; genomlysningen viktas nu också mot normalen (sidan bort från solen) och kronans tunna ytterkant (ljus vertexfärg).
