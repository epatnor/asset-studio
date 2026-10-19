# Skogen: prestanda i 1× och 4× storlek

Mätt 2026-10-19 på `showcase/skogen.html`. Frågan var om datorn klarar en bana som är fyra gånger så stor som parken (120 × 120 m).

**Svar:** ja, med instansiering och LOD per avstånd, som Skogen nu ritas. Skogen i 4× yta (240 × 240 m, cirka 1 500 träd) tar ungefär 10 ms per bild på RTX 4070 och 21 ms på den integrerade Radeon 780M. Parkens sätt att rita, med en kopia per modell, klarar inte 4×: 30–58 ms på RTX och 54–108 ms på iGPU.

## Banan

Skogen är en tät, stiliserad granskog med inslag av björk och asp. Den har en slingrande stig (med två grenar i de större storlekarna), gläntor med äng och blommor, ormbunksbestånd, buskar i bryn, stenar, stubbar, lågor, svampar och marktäcke, samt gräsfältet. Allt kommer från generatorerna:

- Nya träd: `spruce_tall` (16 m), `spruce_mid` (11 m) och `spruce_young` (4 m), alla med `pine_*` och `checks.ok`.
- Ny växt: `fern1`. Den är ny art i `plants.json` och använder två nya bladparametrar i växtgeneratorn: `side` (småblad åt sidorna) och `taper` (kortare mot toppen).
- Befintliga modeller: `pine_v2`, `fir_small`, `birch_v2` och `aspen_v2`, buskar, props och gräs.

Placeringen styrs av täthet per ytenhet. 4× yta ger därför 4× så mycket innehåll, inte glesare skog. Storleken väljs i panelen eller med `?size=1|2|4` (sidan ×1, ×2, ×4), och ritsättet med `?mode=instanced|clone`.

| Storlek | Träd | Modeller | Växter | Grässtrån |
|---|---|---|---|---|
| 1× (120 m) | 374 | 676 | 1 117 | 97 000 |
| 4× yta (240 m) | 1 498 | 2 708 | 4 690 | 403 000 |
| 16× yta (480 m) | 5 990 | 10 828 | 20 127 | 1 780 000 |

## Hur det mättes

- `__bench()` i sidan ställer kameran på tre fasta platser: början av stigen, inne i skogen och översikten över hela banan. Varje plats ritas 30–60 gånger med tvingad synk (`readPixels`), så tiden är bildens verkliga kostnad och inte låst till skärmens 60 Hz. Skuggkartan ritas om var tredje bild, som i spelet.
- **RTX 4070 Laptop:** värdens Chrome, headless med PRIME offload (ANGLE/Vulkan, `NVIDIA GeForce RTX 4070 Laptop GPU`), 1024 × 768.
- **Radeon 780M (iGPU):** appens förhandsvisning, 1024 × 768. **Webbläsare väljer den integrerade GPU:n som standard på den här datorn.** Det gäller även Electron, om man inte ber om den andra.
- En körning per konfiguration. Bruset är ungefär ±2 ms: 1× på stigen mättes en gång till 7,3 ms och en gång till 9,3 ms.
- "Minne" är geometri och instansdata på GPU:n, plus JS-heapen. Texturerna är desamma i alla konfigurationer: 26 st, delade.

## Resultat, RTX 4070 Laptop

Medel (p95) i ms per bild, med ritanrop och trianglar (inklusive skuggpasset).

| Konfiguration | Stigen | Skogen | Översikt | Anrop | Trianglar | Geometri | JS-heap | Laddning |
|---|---|---|---|---|---|---|---|---|
| 1×, kopior (parkens sätt) | 12,4 (18,9) | 11,8 (19,6) | 20,2 (27,1) | 309–1 386 | 2,1–7,3 M | 91 MB | 133 MB | 1,3 s |
| 1×, instansierat | 9,3 (11,6) | 8,4 (14,0) | 6,3 (7,6) | 189–393 | 1,4–1,8 M | 32 MB | 77 MB | 1,0 s |
| 4×, kopior | 30,0 (44,7) | 31,9 (52,2) | 58,0 (101) | 1 072–5 168 | 6,7–27,4 M | 305 MB | 381 MB | 3,0 s |
| **4×, instansierat** | **10,2 (12,1)** | **10,5 (12,8)** | 16,8 (19,2) | 377–1 079 | 2,9–5,4 M | 65 MB | 159 MB | 1,5 s |
| 16×, instansierat | 14,1 (16,3) | 15,2 (17,5) | 49,1 (59,1) | 499–3 828 | 4,4–20,3 M | 202 MB | 311 MB | 3,9 s |

## Resultat, Radeon 780M (integrerad)

| Konfiguration | Stigen | Skogen | Översikt* |
|---|---|---|---|
| 1×, kopior | 54,5 (70,2) | 50,7 (70,5) | 61,8 (77,3) |
| 1×, instansierat | 11,9 (14,0) | 14,1 (17,4) | 16,1 (17,9) |
| 4×, kopior | 68,7 (94,3) | 54,2 (78,8) | 108 (128) |
| **4×, instansierat** | **21,0 (22,5)** | **20,8 (23,8)** | 21,3 (22,8) |
| 16×, instansierat | 31,7 (34,4) | 33,2 (37,2) | 34,3 (37,6) |

\* Översikten på iGPU mättes innan den fick hela banans sikt, alltså med spelets siktavstånd (190 m).

## Vad siffrorna säger

1. **Kopior skalar med banan, instanser med sikten.** Med en kopia per modell ritas allt i kamerans riktning i LOD0, hur långt bort det än står. I Skogen ser spelaren lika långt (190 m, dimma) i alla storlekar. Med instanser och LOD växer kostnaden för en vy bara tills banan blir större än sikten, och planar sedan ut: 9 → 10 → 14 ms från 1× till 16× på RTX.
2. **Det dyra är LOD2-träden långt bort.** Inne i 4×-skogen står cirka 1 100–1 400 träd i LOD2 med 2 500–2 700 trianglar vardera, alltså cirka 3 M trianglar. Träden närmast står för en liten del.
3. **Ritanropen är inte flaskhalsen** med instanser: under 550 anrop i förstaperson även i 16×.
4. **Minnet är litet jämfört med 8 GB VRAM.** I 4× tar geometrin 65 MB. Ett fel hittades och åtgärdades på vägen: draperat marktäcke (lövhögar, krypväxter), som i parken får en egen böjd kopia av alla tre LOD-nivåerna per exemplar, tog 245 av 306 MB i 4×. Skogen draperar nu i shadern mot en höjdtextur i stället (`instancing.js`, `drape`).
5. **Laddningen** tar 1–2 s i 4× med varm cache. Den domineras av placeringen och gräsfältet, som byggs på en gång.

## Rekommendation

**Kör 4× nu, med Skogens sätt att rita.** Det flyter redan: cirka 100 bilder/s på RTX och cirka 48 på iGPU, med marginal mot 60 Hz på RTX. För att det ska flyta även på svagare datorer, och för att kunna gå vidare mot 16×, i den här ordningen:

1. **Instansering, LOD per avstånd och culling per ruta** är klart (`showcase/instancing.js`). Parken bör ritas om på samma sätt, eftersom den fortfarande gör en kopia per modell.
2. **Impostorer som LOD3 för träd** ger störst vinst härnäst. En målad billboard eller en oktaedrisk impostor (cirka 2–8 trianglar) bortom cirka 60 m ersätter de cirka 3 M LOD2-trianglarna. Den bör göras i trädgeneratorn: generatorn renderar en atlas per träd, så att den följer samma recept.
3. **Billigare skuggor:** låt LOD2 eller impostorn kasta skugga långt bort, eller använd kaskader. Skuggpasset ritar i dag om LOD0/LOD1-träden.
4. **Gräs och placering per ruta, i en worker** (streaming), när banan blir större än cirka 4×. I 16× står gräsfältet (1,8 M strån) för det mesta av de 202 MB, och laddningen blir 4 s.
5. **Terrängen i rutor med LOD** (roadmap, Terräng). I 4× räcker ett enda rutnät med 481 × 481 hörn, men inte mycket större.
6. **Be om den starka GPU:n.** Både webbläsaren och en framtida Electron-app hamnar annars på Radeon 780M, som är cirka 2× långsammare här. I Electron: `app.commandLine.appendSwitch('force_high_performance_gpu')`, plus `powerPreference: 'high-performance'` i WebGL-kontexten. På Linux kan PRIME-variabler också behövas.

Med punkt 1, 2 och 6 bör 16× hålla 60 bilder/s även i översikten på RTX. I förstaperson gör den det redan.
