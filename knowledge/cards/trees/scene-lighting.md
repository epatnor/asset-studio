---
id: scene-lighting
area: trees
technique: 7
status: implemented
priority: low
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Scenljus (inte generatorn)

**Läge:** Finns i klienten: `showcase/world.js` har AgX (`toneMapping`), HemisphereLight `#cfe6ff`/`#5d7a3a` och varm sol `#ffe9c7`. Mättnad och kontrast styrs av GradeShader i `effects.js` (`W.grade.sat`, `W.grade.con`). Dygnet i `atmosphere.js`.
**Idé:** Rapportens Godot-ljus är redan vår uppsättning.
**Ändring:** Ingen i klienten. Möjligen: låt Blenders förhandsbild (`tools/preview/preview_glb.py`) få samma solfärg och kall himmel ur `tools/style.json`, så att kontaktarken stämmer med spelet.
**Parametrar:** —
**Test:** —
**Risker:** —
