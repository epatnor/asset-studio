# Karta: stiliserade träd (rapport 2026-10-24) mot trädgeneratorn

Källa: [knowledge/reports/2026-10-24-stylized-trees.md](../../reports/2026-10-24-stylized-trees.md).
Rapporten är skriven för Godot; Tinkertown är Three.js + glTF, så motor-delarna är översatta.

Arterna i `species.json`: 14 `crown` (v4-kronan: mjuk union av klumpar, ogenomskinlig massa + lövkort),
2 `canopy` (äldre: k-means-kluster med kort, utan massa), 3 `leafdome` (solida blad, ingen alfa),
2 `fronds` (gran/barr), 1 utan lövverk.

| # | Teknik | Läge | Var | Kort |
|---|---|---|---|---|
| 1 | Lövkort i kluster | **Finns** | `canopy.mjs` (k-means → ellipsoider → kort), `crown.mjs` (klumpar → avståndsfält → kort på ytan) | [foliage-clustered-cards](foliage-clustered-cards.md) |
| 2 | Sfäriska normaler | **Finns, delvis** | `normalBlend` (crown 0,95, canopy 0,8): `crown.mjs:235`, `canopy.mjs:81`. Saknas: lyft av centrum (ljusare toppar). glTF-normalerna läses som de är av GLTFLoader och Blender | [foliage-normal-lift](foliage-normal-lift.md) |
| 3 | Dubbelsidiga löv | **Saknas (medvetet)** | `gen_tree.mjs:150` sätter `doubleSided(false)`. I `crown` döljer massan baksidorna; i `canopy` kan hål synas underifrån | [foliage-double-sided](foliage-double-sided.md) |
| 4 | Alfahantering | **Delvis** | Alpha bleed finns (`post_textures.py:68`, MaxFilter 9). MASK med cutoff 0,45. Saknas: mjukad alfa, alpha-to-coverage | [foliage-alpha-soft](foliage-alpha-soft.md) |
| 5 | Ingen spekular på löv | **Delvis** | Roughness 0,85–0,9, metallic 0, men spekularen (F0 0,04) finns kvar och ger glans i strykljus | [foliage-no-specular](foliage-no-specular.md) |
| 6 | Inre kronfärg i stället för punktljus | **Delvis** | Vertexfärgsgradient i `crown.mjs:175` (höjd, normal uppåt, djup, skrevor). Mörka änden är gråblå `[0.42, 0.46, 0.52]`, alltså avmättad, inte "rik grön". Genomlysning finns i klienten (`materials.js:46`) | [foliage-inner-tint](foliage-inner-tint.md) |
| 7 | Scenljus | **Finns** (klient) | `showcase/world.js`: AgX, HemisphereLight (kall himmel, grön mark), varm sol. Mättnad/kontrast i `effects.js` (GradeShader). Blenders förhandsbild (`tools/preview/preview_glb.py`) har eget ljus | [scene-lighting](scene-lighting.md) |
| 8 | Vind | **Finns** | `_WIND` + `COLOR_1` (R höjd, G rörlighet, B fas), kontrollen `wind_torn` (`gen_tree.mjs:164`), gungning i `materials.js:104` | [foliage-wind](foliage-wind.md) |
| 9 | Avstånd: LOD, impostorer, instansiering | **Delvis** | LOD0–2 för bark och löv, `showcase/instancing.js` (InstancedMesh per del och LOD, i chunkar). Saknas: impostorer; bortom `lodDist[2]` (160 m) ritas inget | [tree-impostors](tree-impostors.md) |

Avsnittet om stenar i rapporten gäller propsgeneratorn (`tools/props/`), som redan finns, och kantljus
(krökning bakad till vertexfärg) kan bli ett eget kort för bark och trä senare. Inte kartlagt här.

## Föreslagen ordning

Rapporten kallar sfäriska normaler högst prioritet, men de finns redan. Störst vinst per arbete nu:

1. **foliage-inner-tint** (6): ren data i generatorn, påverkar alla 14 kronarter, ingen kostnad i körning.
2. **foliage-no-specular** (5): några rader i klientens lövshader.
3. **foliage-normal-lift** (2): en parameter, ljusare toppar.
4. **foliage-alpha-soft** (4): mjukare silhuett; alpha-to-coverage kräver MSAA i composerns render target.
5. **foliage-double-sided** (3): bara för `canopy`-arterna, och kräver att Three.js inte vänder normalen på baksidan.
6. **tree-impostors** (9): störst arbete; behövs när skogen blir stor.
