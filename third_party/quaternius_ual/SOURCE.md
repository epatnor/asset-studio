# Universal Animation Library (Standard) – Quaternius

- Källa: https://quaternius.itch.io/universal-animation-library (gratisversionen "Standard", v3.0 från 2026-06-16)
- Hämtad: 2026-11-07, `Universal Animation Library[Standard].zip`, 15 904 933 byte,
  sha256 `cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724`
- Licens: **CC0 1.0** (License.txt i paketet). Fri även kommersiellt; källan anges ändå i CREDITS.
- Upphovsperson: Quaternius (animationer delvis av Gonzalo Furnier)

Filerna ligger utanför git (bara den här filen checkas in). Uppackat i `standard/`:

| Fil | Innehåll |
|---|---|
| `Unreal-Godot/UAL1_Standard.glb` | 43 animationer, rotrörelsen avstängd (för Godot) |
| `Unreal-Godot/UAL1_Standard_RM.glb` | samma med rotrörelse inbakad |
| `Unity/*.fbx` | samma i FBX |

Skelett: 65 ben med Unreals namn (`root`, `pelvis`, `spine_01–03`, `neck_01`, `Head`, `clavicle/upperarm/lowerarm/hand`,
fingrar 01–03 + leaf, `thigh/calf/foot/ball` + leaf). Mannekäng 13 744 trianglar.

**Passar MPFB:s rigg `game_engine` ben för ben:** alla dess 53 ben finns här; skillnaden är bara versaler
(`Root`/`root`, `head`/`Head`) och 12 spetsben (`*_leaf`) som MPFB saknar. Klippen kan alltså läggas direkt på en
MPFB-figur med `game_engine`-riggen, eller målriktas i Godot via humanoidprofilen.

Animationer (längd i sekunder): A_TPose 2.5, Crouch_Fwd_Loop 2.0, Crouch_Idle_Loop 2.9, Dance_Loop 1.0, Death01 2.4,
Driving_Loop 1.7, Fixing_Kneeling 5.2, Hit_Chest 0.3, Hit_Head 0.4, Idle_Loop 2.5, Idle_Talking_Loop 2.9,
Idle_Torch_Loop 1.3, Interact 2.0, Jog_Fwd_Loop 0.9, Jump_Land 1.3, Jump_Loop 2.5, Jump_Start 1.3, PickUp_Table 0.8,
Pistol_Aim_Down/Neutral/Up 0.2, Pistol_Idle_Loop 1.7, Pistol_Reload 1.7, Pistol_Shoot 0.6, Punch_Cross 1.0,
Punch_Jab 0.9, Push_Loop 2.7, Roll 1.5, Sitting_Enter 1.3, Sitting_Exit 1.0, Sitting_Idle_Loop 1.7,
Sitting_Talking_Loop 2.9, Spell_Simple_Enter 0.5, Spell_Simple_Exit 0.4, Spell_Simple_Idle_Loop 2.1,
Spell_Simple_Shoot 0.5, Sprint_Loop 0.7, Swim_Fwd_Loop 1.3, Swim_Idle_Loop 3.3, Sword_Attack 1.5, Sword_Idle 1.7,
Walk_Formal_Loop 1.3, Walk_Loop 1.3.

Saknas i gratisversionen (finns i Pro, 9,99 USD): gång och spring i 8 riktningar, fler strids- och känslorörelser.
Universal Animation Library 2 (parkour, kombon, jordbruk, zombiegång) är ett eget paket, inte kontrollerat.
