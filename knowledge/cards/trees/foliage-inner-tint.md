---
id: foliage-inner-tint
area: trees
technique: 6
status: untested
priority: high
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Inre kronfärg i stället för punktljus

**Läge:** Vertexfärgen bakas i `crown.mjs:175` (`shade`): ljus av höjd, normal uppåt, djup in i kronan och skrevor (`creviceDark`), blandat mellan gråblå `[0.42, 0.46, 0.52]` och varmvit `[1.0, 1.0, 0.94]`, sedan gånger löv- eller artfärgen. Mörka partier blir därför gråare, inte mer mättade. Ingen kall undersida utöver gråblått. Genomlysning finns i klienten.
**Idé:** Rapportens punktljus ersätts av vertexfärg (som vi redan gör): mörka änden blir en mättad, mörkare lövton i stället för grått, och nedåtvända ytor får en svag kall ton som studs från himlen.
**Ändring:** `shade()` i `crown.mjs` (och motsvarande i `canopy.mjs`): `dark = lerp(grå, innerTint, innerTintStrength)`, sedan `col = lerp(col, bottomCool, bottomCoolStrength * clamp01(-n[1]))`. Exponenten `0.8` blir `gradientFalloff`. Standardfärgerna läses ur `tools/style.json`.
**Parametrar:** `foliage.innerTint` (standard = dagens gråblå), `innerTintStrength` (0), `bottomCool` (`#9fb8d8`), `bottomCoolStrength` (0), `gradientFalloff` (0,8).
**Test:** Med kod: mättnad (HSV) för de 20 % mörkaste hörnen före/efter, och att de ljusaste är oförändrade. Kontaktark: tre kronarter, före/efter, LOD0 och LOD2.
**Risker:** Mättad inre färg gånger `leafTint` kan bli neonaktig; kör mot paletten i stilguiden.
