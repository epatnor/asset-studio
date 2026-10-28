# Texturer med Krea-2 (från 2026-10-29)

Helt procedurella texturer, eller texturer skrivna i kod, har varit svåra att få att se målade ut. Från och med nu görs materialen med Krea-2 i den lokala ComfyUI, sömlösa redan när de genereras. Koden bestämmer bara det AI:n är dålig på: struktur som måste stämma (murverkets skift, takets rader), skala, värden och kartor.

## Backup

Alla texturer som fanns före bytet:

- **Kopia av hela mappen:** `~/Spelutveckling/azshara-studio/backups/textures-2026-10-29/` (995 MB, även de filer som inte ligger i git: `hd/`, `raw/`, `versions/`, `gray/`).
- **Git-taggen `textures-before-krea`:** de spårade texturerna som de var. En enskild fil återställs med `git checkout textures-before-krea -- assets/textures/<fil>`.

Recepten för de procedurella materialen (`assets/textures/*.texture.json`) och verktygen finns kvar. Ett material kan alltså göras om procedurellt när som helst, och Texturverkstaden fungerar som förut.

## Försöken hittills

| När | Försök | Vad det gav | Vad som var fel |
|---|---|---|---|
| okt (första veckan) | `generate_texture`: Krea-bild + `post_textures.py tile` (tona mot en halvt förskjuten kopia) | Bra på bark och fibrösa ytor | Toningen ger halvgenomskinliga "spökformer" på oregelbundna mönster (kullersten, stenar) |
| okt | `make_surface.py`: Krea, förskjut ett halvt varv, måla om sömkorset (inpainting), lägg tillbaka korset, jämna ut kanterna och ljusheten | Sömlösa marker och fasader (`surface_*`, `surface_bld_*`) | Två körningar (cirka 3 min). Där korset når bildkanten har sidorna målats var för sig och måste tonas (`harmonize_edges`). Det ommålade korset får ofta en annan ton och syns som ett rutnät på stora ytor |
| 2026-10-26 | GPT Image 2 via OpenRouter för marken under gräset (`ground_*`) + toning | Fem marker för ungefär 4 cent | Samma spökformer vid kanterna, och ingen sömlös generering |
| 2026-10-25–26 | Texturverkstaden T1–G1: procedurella källor (brus, bark, sten, tegel, plankor) med steg, och Krea som målar över en procedurell form | Full kontroll över skala och form, sömlöst från början, recept som går att göra om | Ser datorgjort ut: regelbundna Voronoiceller, för jämnt och platt. Många spakar för att komma nära, och den målade karaktären uteblev |
| 2026-10-27 | Efter AAA-referensen: Stylize (Kuwahara, k-means i OKLab), Remove lighting, storebror i 2048 | Lugnare, mer målat, samma mönster i alla upplösningar | Fortfarande procedurell grund; bark och sten blev "snyggt brus" snarare än målat |
| 2026-10-28 | Referensstyrt: CC0-referenser från Poly Haven mäts (palett, skala, riktning, relief); `fit_reference.py`, barkkällan v3, `antitile.js` | Rätt skala och palett (fårorna gick från 23 cm till ungefär 5 cm för ek) | Rätt mått räckte inte för att det skulle se målat ut |
| 2026-10-28 | Byggsatsen: murverk och skiffer bakade ur samma layout som geometrin (`tools/building/kit/bake.mjs`) | Lätta moduler, mönstret fortsätter mellan moduler | Stenarna är platta polygoner med brus, inte målade stenar |

Lärdomen: kod är bra på *var* saker ska ligga och *hur stora* de ska vara, men dålig på hur de ska se ut. AI är tvärtom. Därför används koden som form och som mätare, och Krea målar.

## Sömlöst redan i genereringen

ComfyUI har två noder för det (`custom_nodes/apparition_seamless`, skrivna för Apparition):

- **`Krea2SeamlessRoll`** rullar latenten en ny slumpad bit före varje modellsteg och tillbaka efteråt. Bildens kanter hamnar hela tiden någonstans mitt i bilden, där modellen ser båda sidorna samtidigt, så att innehållet målas ihop runt kanten. Transformern har inga faltningar som kan göras cirkulära, därför rullning.
- **`VAEDecodeSeamless`** lånar några latentpixlar från motsatt kant före avkodningen och skär sedan bort dem, så att även VAE:n ser över sömmen.

Resultatet är sömlöst utan efterarbete: `seam_raw` (skillnaden över kanten delad med skillnaden mellan vanliga grannpixlar) är 0,4–1,0, där 1,0 betyder att sömmen inte syns mer än vilken pixelgräns som helst. Det tar en körning (cirka 60 s för 1024 × 1024 på RTX 4070 Laptop) i stället för två.

`krea2.py --seamless` och Texturverkstadens källa `krea` (standard, spaken `seamless`) använder samma noder. Verkstaden tonar alltså inte längre sömmen efteråt.

## Sömlöst för andra bilder: snitt i stället för toning

Bilder som inte kommer från Krea (foton, GPT, äldre bilder) görs sömlösa med `post_textures.py tile <in> <ut>`. Metoden `cut` är numera standard. `fade` (den gamla toningen) finns kvar som tillval.

Frågan var om man kan använda pixel shift eller ett smudge-verktyg längs kanterna i stället för att tona. Toning blandar två olika bilder, och det ger dubbla, halvgenomskinliga former. Smudge drar ut pixlar, vilket blir streck i mönster med struktur, som stenar och tegel. Metoden `cut` gör i stället som image quilting:

1. Bilden förskjuts ett halvt varv. Sömmarna blir då ett kors i mitten, och kanterna består av bildens egna inre pixlar, som redan passar ihop.
2. Korset täcks med bitar ur bilden själv: en lodrät remsa, en vågrät remsa och en mittruta, där varje bit är hel och utan söm på den plats där den hamnar.
3. Varje bit klistras in med ett **snitt**: den billigaste vägen genom överlappet, där bitarna redan är mest lika (dynamisk programmering). Längs snittet tonas bara en pixel.

Former klipps alltså i stället för att blandas. I jämförelsen på kullersten (`build/tilecut/zoom.jpg`) ger toningen dubbelstenar, medan snittet ger hela stenar med en och annan avklippt kant. Det tar under en sekund.

**När vilken metod:**

| Fall | Metod |
|---|---|
| Ny textur | Krea med rullning (`krea_tex.py`, `krea2.py --seamless`, verkstadens `krea`) |
| Befintlig bild | `tile` med `cut` |
| Befintlig bild med stark struktur (tegel i rader) | `make_surface.py`-metoden (måla om sömkorset med Krea), eller bättre: generera om med struktur som bas (nedan) |
| Upprepning över stora ytor (inte själva sömmen) | `antitile.js` i klienten, och `flatten` i verktyget |

## Verktyget: `tools/texture/krea_tex.py`

Materialen är data i `tools/texture/krea_set.json` (57 material i grupperna ground, grassground, bark, rock, kit och building). Varje material har:

- `prompt`: bara materialet.
- `view`: `surface` (uppifrån), `facade` (rakt framifrån) eller `tile` (närbild av ytan, för bark och sten).
- `normal`: normalkartans styrka.
- `targets`: vilka filer en vald variant ersätter.

Struktur som måste stämma ges som `base`: en sömlös layoutbild som Krea målar över (bild till bild, `denoise`). Byggsatsens murverk utgår från det bakade `kit_masonry`, så att skiften har samma period, 6 × 3 m.

```bash
uv run --quiet --script tools/texture/krea_tex.py '{"only": ["bark_oak"], "variants": 3}'
```

```bash
uv run --quiet --script tools/texture/krea_tex.py '{"sheet": true, "group": "bark"}'
```

```bash
uv run --quiet --script tools/texture/krea_tex.py '{"install": {"bark_oak": 1}}'
```

Efter genereringen:

1. **`flatten`:** stora ljusfläckar delas bort mot en kraftigt suddad kopia, med wrap, så att inget rutnät syns på stora ytor.
2. **Värdena:** ljusheten pressas in i stilguidens 8–90 %.
3. **Kartorna:** höjd (16 bit, bara relief), normal, AO, ruffighet och ORM räknas ur ljusheten, med wrap.

Måtten i `meta.json`:

- `seam` och `seam_raw`: sömmen.
- `blotch`: hur mycket den lågfrekventa ljusheten varierar. Över 0,09 syns den som rutnät.
- Medelfärg och tid.
- `ok`: sömmen och fläckigheten är inom gränserna.

Kandidaterna ligger i `build/krea/<namn>/v<i>*.png`, och kontaktarket visar varje variant 2 × 2 gånger, så att sömmen syns mitt i rutan.

`install` kopierar en vald variant till målfilerna (i målets upplösning, och WebP-syskon skrivs om) och antecknar materialet, varianten, fröet och prompten i `assets/textures/krea_installed.json`.

## Resultat 2026-10-29

(fylls i när satsen är klar)
