# Universal Base Characters (Standard) – Quaternius

- Källa: https://quaternius.itch.io/universal-base-characters (gratisversionen "Standard", uppladdad 2025-12-16)
- Hämtad: 2026-11-14 av Patrik i webbläsaren, `Universal Base Characters[Standard].zip`, 128 968 391 byte,
  sha256 `fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40`
- Licens: **CC0 1.0** (`License_Standard.txt` i paketet). Fri även kommersiellt; källan anges ändå i CREDITS.
- Upphovsperson: Quaternius

Filerna ligger utanför git (bara den här filen checkas in). Uppackat i `standard/Universal Base Characters[Standard]/`:

| Mapp | Innehåll |
|---|---|
| `Base Characters/Godot - UE/` | `Superhero_Female_FullBody.gltf` och `Superhero_Male_FullBody.gltf` med texturer (färg mörk, normal, ruffighet; ögon och bryn) |
| `Base Characters/Textures/` | samma texturer plus ljus hud (`T_Superhero_Female_Light_BaseColor.png`, `T_Superhero_Male_Ligh.png`) |
| `Base Characters/Unity/` | samma i FBX |
| `Hairstyles/` | två frisyrer, riggade till huvudbenet eller med origo i 0 |

Gratisversionen har bara superhjältekropparna. Källversionen (betald) har alla 26 modeller, med vanlig och tonårig
kroppsbyggnad, riggade .blend-filer och 20 frisyrer.

**Mätt 2026-11-14:**

- Kvinnan har 12 812 trianglar i kroppen och 15 060 totalt med bryn och ögon. Mannen har 12 566 respektive 14 318.
- Skelettet har 65 ben, samma som Universal Animation Library (`../quaternius_ual/`), så animationerna passar direkt.
- Båda står i T-pose, med bh och trosa respektive kalsonger målade i texturen.
- Händerna har fem riktiga fingrar. MPFB-figurernas händer gick sönder när fingrarna böjdes (se `../../../character-studio/docs/character-creator.md`).

Bilder: `character-studio/build/base_models/ubc/ubc_sheet.png`.
