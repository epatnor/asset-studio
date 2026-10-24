---
id: foliage-alpha-soft
area: trees
technique: 4
status: untested
priority: medium
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Alfa: mjukare kanter och alpha-to-coverage

**Läge:** Alpha bleed finns i atlasen (`post_textures.py:68`, MaxFilter 9 + composite). Löven är `MASK` med cutoff 0,45 (motsvarar Godots alpha scissor). `tools/texture/check_alpha.py` finns för kontroll.
**Idé:** Lätt gaussisk oskärpa på alfakanalen innan atlasen sparas ger fluffigare silhuett. Alpha-to-coverage (Three.js `material.alphaToCoverage = true`) ger mjuka kanter utan sorteringsproblem, men bara med MSAA.
**Ändring:** `atlas()` får `alpha_blur` (px, standard 0). Klienten slår på `alphaToCoverage` för `Leaves`/`Fronds` när render target har MSAA; `effects.js` använder EffectComposer, så dess render target behöver `samples > 0` (renderern har redan `antialias: true`).
**Parametrar:** `alpha_blur` i atlasreceptet; `foliage.alphaToCoverage` i klientens kvalitetsnivåer.
**Test:** Med kod: alfatäckning och andel halvgenomskinliga pixlar före/efter (`check_alpha.py`). Kontaktark: närbild av kronans kant, före/efter.
**Risker:** MSAA i composern kostar minne och fyllnad på 8 GB-laptopen; ska vara en kvalitetsnivå. Mer oskärpa = mer genomskinligt nära cutoff, kronan kan tunnas ut.
