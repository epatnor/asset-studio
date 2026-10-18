# MakeHuman-data (basmesh hm08, targets, skelett)

Hämtat från MPFB2, MakeHumans tillägg för Blender: https://github.com/makehumancommunity/mpfb2
Commit `3af0cd5a2ffba072e93a34e5f6f494fdc4813ddf` (2026-10-13), hämtat 2026-10-18.

**Licens: CC0 1.0** (`LICENSE.md` och `LICENSE.ASSETS.md` här). Enligt MPFB:s LICENSE.md gäller CC0 basmeshen, targets och modifierare, riggar, poser och uttryck och JSON med meshinformation. Koden (Python, skript) är GPLv3 och är inte med. MPFB:s FAQ uppmuntrar uttryckligen att man bygger en egen karaktärsgenerator på basmeshen och targets: https://static.makehumancommunity.org/mpfb/faq/build_other_chargen.html

Filerna ligger inte i git (63 MB). Hämta dem så här:

```bash
git clone --filter=blob:none --no-checkout --depth 1 https://github.com/makehumancommunity/mpfb2.git /tmp/mpfb2
git -C /tmp/mpfb2 sparse-checkout set --no-cone '/LICENSE.md' '/LICENSE.ASSETS.md' '/src/mpfb/data/3dobjs/base.obj' '/src/mpfb/data/mesh_metadata/' '/src/mpfb/data/rigs/standard/' '/src/mpfb/data/targets/' '!/src/mpfb/data/targets/_images/'
git -C /tmp/mpfb2 checkout master
```

och kopiera sedan till den här mappen: `LICENSE*`, `src/mpfb/data/3dobjs/base.obj` → `3dobjs/`, `mesh_metadata/`, `rigs/standard/` → `rigs/standard/`, `targets/`.

| Här | Innehåll |
|---|---|
| `3dobjs/base.obj` | basmeshen hm08: kropp (hörn 0–13379) plus hjälpgeometri (ögon, tänder, tunga, leder som "joint cubes", kläd- och hårhjälpare) |
| `mesh_metadata/` | vertexgrupper per kroppsdel, spegeltabell (`hm08.mirror`), tabeller mellan ytor och hörn |
| `rigs/standard/` | skelett (`rig.default`, `rig.game_engine`, `rig.mixamo` ...) och vikter per skelett |
| `targets/` | 1 258 targets (`.target.gz`): kön, ålder, vikt, muskler och proportioner (`macrodetails`) samt huvud, ansikte, bål, armar, ben, byst och uttryck |
