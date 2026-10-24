---
id: foliage-normal-lift
area: trees
technique: 2
status: untested
priority: medium
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Sfäriska normaler: lyft centrum

**Läge:** Finns. Kortens normal blandas mot fältets gradient (`crown.mjs:235`, `normalBlend` 0,95) eller mot klustrets centrum (`canopy.mjs:81`, standard 0,8). Normalerna skrivs till glTF `NORMAL`; GLTFLoader och Blenders import räknar inte om dem.
**Idé:** Rapportens `normal_center_offset`: flytta centrum nedåt (eller böj normalen uppåt) så att toppen av varje puff får mer himmelsljus och kronan läser som ljusare upptill.
**Ändring:** I `crown.mjs` och `canopy.mjs`: `n = norm(lerp(n, add(n, [0, lift, 0]), …))` innan normalen skrivs; samma för massans hörn så att kort och massa skuggas lika. `normal_sphere_scale` behövs inte: vi räknar normalen analytiskt, ingen sfär överförs.
**Parametrar:** `foliage.normalLift` (standard 0 = dagens utseende; prova 0,15–0,35).
**Test:** Med kod: medel av `normal.y` för kort i övre tredjedelen före/efter. Kontaktark: ek, lönn, björk, före/efter, LOD0.
**Risker:** För mycket lyft gör undersidan platt och ljus. Massa och kort måste få samma lyft, annars syns skarven.
