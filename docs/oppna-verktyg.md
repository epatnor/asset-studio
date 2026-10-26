# Öppna verktyg: vad vi kan använda eller härma

Skrivet 2026-10-26, efter frågan "uppfinner vi hjulet på nytt?". Det här är en lista att utvärdera, inte beslut. Kontrollera licensen i varje repo innan något tas in (källorna nedan är sammanfattningar).

## Kort svar

Delvis. Det som är vårt eget och värt att bygga själva är **receptmodellen** (generatorer, bibliotek med familjer och fasta modeller, texturrecept), **husets stil** och **AI-loopen** (Claude och Krea kör samma verktyg som Patrik). Det som är allmän renderingsteknik för en öppen värld i webbläsaren (terräng med LOD, impostors, komprimerade texturer, vind, vatten) har andra redan löst, och där ska vi låna eller härma i stället för att uppfinna.

Rekommendation: stanna på three.js (vi har r186, som har WebGPU-renderaren och TSL) och använd andra motorer som **referenser** att härma, inte som byte av motor.

## RedGPU v4.4 (WebGPU, alfa): checklista mot oss

[RedGPU](https://x.com/redcamel15/status/2114606572165046472) visar vad en öppen värld i webbläsaren behöver. Varje punkt jämförd med var vi står:

| RedGPU | Hos oss | Vad vi gör |
|---|---|---|
| Terräng: strömmade 16-bitars höjdkartor i rutor, LOD med geomorphing, frustum- och ocklusionsval på GPU:n | Tinkertowns terräng är ett rutnät; "terrängen i rutor med LOD" står i [skogen-prestanda.md](skogen-prestanda.md) | Härma: rutor med CDLOD och geomorphing |
| Splatting med 4 PBR-lager, stokastisk tiling, bakad virtuell texturatlas | Stokastisk tiling och lagerregler finns i verkstadens labb (T3b); Tinkertown läser inte katalogen än | Härma bakningen av en atlas per ruta |
| Utspridning på GPU:n efter terränglagrens vikter och lutning | Planerad som PCG (B3) | Samma idé; räkna utspridningen i en compute-shader (TSL) |
| Tre mesh-LOD:er plus octahedral impostors med ditherövergång | Byggt 2026-10-26 i Tinkertown (`impostor.js`): LOD0–2 i en BatchedMesh per familj och material, impostors bortom 220 m; ingen ditherövergång än | Klart utom övergången |
| Strömmat gräs per ruta som tar markens färg | Finns (`showcase/grass.js`, rotfärg från marken) | Klart; jämför prestanda |
| Sjö: absorption efter djup, mjuk strandkant, SSR, kaustik, krusningar från figurer | Saknas | Härma när Azshara Island behöver vatten |
| Global vind som styr både löv och vågor | Vind i vertexshadern står som punkt i roadmapen | Gör vinden till en gemensam tjänst från början |
| KTX2 (BC7, ASTC, ETC2) med Basis-omkodare | Vi komprimerar till WebP (mindre filer men okomprimerat i grafikminnet) | Lägg till KTX2 via gltf-transform och three.js `KTX2Loader` |

Att undersöka: RedGPU:s licens och hur aktivt projektet är (det är alfa, med en huvudutvecklare).

## Kandidater per område

| Område | Verktyg | Licens (enligt källorna) | Använda eller härma |
|---|---|---|---|
| Impostors | [octahedral-impostor](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735) (agargaro, three.js) med InstancedMesh2 och BVH-val; demo med 200 000 träd | kontrollera | **Använda** som LOD3 för skogen |
| Träd | [EZ-Tree](https://github.com/dgreenheck/ez-tree) (three.js, npm `@dgreenheck/ez-tree`) | MIT (kod); bark CC0 | Härma: jämför parametrar och vind; vår kortbollsstil är egen |
| Texturgrafer | [Material Maker](https://www.linuxlinks.com/material-maker-procedural-texture-authoring-3d-painting-tool/) (Godot, nodgraf, PBR-kartor, målning på glTF) | MIT | Härma: nodtyper och export; vår verkstad är receptbaserad och AI-styrd |
| Målning på modell | ArmorPaint | kontrollera | Alternativ till att bygga en full pensel (B4–B5) |
| Bakning | Blender (har vi) | GPL | **Använda** för krökning, AO, position och tjocklek (B4) |
| Tygsimulering | Thom Chiovolonis tygdemo (Baraff och Witkin, implicit med konjugerad gradient) | MIT | **Använd** (portad till `shared/effects/cloth.js`, licensen i filen) |
| Blender-arbete via agenter | [blender-skills](https://github.com/arjun988/blender-skills) (94 färdigheter för Claude Code m.fl. via Blender MCP: karaktärer, retopologi, rigg, hår, export) | MIT | Titta på för karaktärsskapandet ([character-generator.md](character-generator.md)) |
| Komprimering | gltf-transform | MIT | **Använda** för KTX2 bredvid meshopt |
| Utspridning (PCG) | Unreal PCG (som modell), ProtonScatter för Godot | (Unreal: inte öppen) / kontrollera | Härma grafens steg i B3 |
| Motor | Babylon.js, PlayCanvas | MIT | Referens för nodmaterial och editor-GUI |

## Källor

- [EZ-Tree på GitHub](https://github.com/dgreenheck/ez-tree), [CG Channel om EZ-Tree](https://www.cgchannel.com/2025/04/ez-tree-is-a-lightweight-free-open-source-tree-generator)
- [Material Maker (LinuxLinks)](https://www.linuxlinks.com/material-maker-procedural-texture-authoring-3d-painting-tool/), [Chocolatey-paketet](https://chocolatey.org/packages/material-maker.portable/1.0)
- [A forest of octahedral impostors (three.js-forumet)](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735), [Octahedral Impostors for three.js](https://discourse.threejs.org/t/octahedral-impostors-for-three-js/80318), [Godot Octahedral Impostors](https://github.com/SIsilicon/Godot-Octahedral-Impostors)
- RedGPU v4.4.0-Alpha, inlägget som Patrik klistrade in (x.com/redcamel15, 2026-10-26)
