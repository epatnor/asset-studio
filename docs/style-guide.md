# Stilguide

Gäller allt som skapas i Tinkertown och Azshara Island, oavsett om det görs av ett verktyg, en AI-agent eller för hand. Värden som verktygen läser automatiskt ligger i [`tools/style.json`](../tools/style.json); den här guiden förklarar varför.

## Kärnan

**Stiliserad, halvrealistisk 3D i stil med Overwatch och Fortnite.** Tecknade former med verklig ljussättning.

- Det är **stiliserad PBR, inte cel-shading.** Ytor reagerar på riktigt ljus, med mjuka övergångar, reflektioner och skuggor. Det stiliserade sitter i former, färger och texturer, inte i en toon-shader.
- **Läsbarhet går före detalj.** Ett objekt ska kunna kännas igen på sin silhuett på 30 meters avstånd.
- **Mid-poly.** Vi optimerar inte för gamla integrerade grafikkort. Polygoner läggs där de syns: på silhuetter och rundade kanter, inte på platta ytor.

## Huvudreferens för helheten

Målbilden för världen som helhet är stilen i asset-paketet **Pure Nature** (Unreal Engine): mjuka gröna kullar, stora låg-poly-klippor med platta ljusa ytor och skarpa kanter, täta stiliserade granar, runda bulliga buskar och lövträd, klar blå himmel med mjuka moln, och mättade men harmoniska färger med mycket ljus. Allt läses tydligt på avstånd, och formerna är förenklade utan att bli leksaksaktiga.

Det betyder för generatorerna:
- **Vegetation:** bulliga kronor och runda buskar (redan i trädgeneratorn), granar i tydliga våningar.
- **Terräng och klippor:** stora, enkla former med plana fasetter och fasade kanter, ljusa toppar och kallare skuggsidor. Inget brusigt detaljberg.
- **Ljus:** klar sol, ljus himmel och luftperspektiv som tonar bort bakgrunden mot blått.



| Regel | Praktiskt |
|---|---|
| Tydlig formhierarki | Stor–medel–liten i ungefär 60/30/10. En stor huvudform, några medelstora, få små detaljer. |
| Överdrivna proportioner | Tjockare, kortare och tyngre än verkligheten. Stammar, stolpar och handtag är kraftiga. Toppar ofta bredare än baser (eller tvärtom) för att få karaktär. |
| Inga perfekt raka linjer | Lätt lutning, svag kurva, liten asymmetri. Planka, tak och staket "lutar" något, men aldrig så mycket att det ser trasigt ut. |
| Generösa avfasningar | Alla hårda kanter får bevel som fångar ljus. Tumregel: 2–4 % av objektets minsta mått, 2–3 segment. |
| Weighted normals | Platta ytor ska skuggas platt, avfasningarna rundat. I Blender: Bevel-modifierare följd av **Weighted Normal** (läge Face Area, Keep Sharp). Det är tekniken bakom "chunky"-utseendet. |
| Chunky, inte spetsigt | Spetsar och tunna delar rundas av och förtjockas. Inga knivskarpa vinklar. |

## 2. Polygonbudget (riktvärden)

| Typ | Trianglar |
|---|---|
| Liten prop (låda, tunna, sten) | 500–3 000 |
| Medelstor prop (vagn, bänk, staket-sektion) | 3 000–15 000 |
| Byggnad (modulär del) | 2 000–10 000 per modul |
| Träd | 10 000–40 000 |
| Buske | 2 000–8 000 |
| Karaktär | 30 000–60 000 |

Över budget är okej om det syns. Under budget är okej om silhuetten fortfarande är rund där den ska vara.

## 3. Texturer och material

| Regel | Praktiskt |
|---|---|
| Låg frekvens | Stora, lugna färgfält. Inget fotobrus, inga skanningar, ingen fin repa-detalj. Detaljer ska vara målade drag, inte mikrostruktur. |
| Gradient uppifrån | Ljusare upptill, mörkare nedtill på nästan allt (väggar, stammar, stenar). Kan göras i textur, vertexfärg eller shader. |
| Kanthighlights | Kanter och utstickande delar är ljusare och lite mer mättade. Fördjupningar mörkare. |
| Inget inbakat direktljus | Texturen får ha mjuk AO och målad gradient, men inga hårda skuggor eller ljuskällor. Ljuset kommer från scenen. |
| Hög roughness | De flesta ytor 0,6–0,9. Få metaller. Metall är polerad och ren med målade highlights, inte rostig och realistisk. |
| Texeltäthet | Cirka 512 px per meter för miljö, mer för det spelaren ser nära. |
| Återanvändning | Sömlösa texturer och trim sheets före unika texturer. Variation med vertexfärg, tint och decals. |

Krea-2-prompter ska beskriva materialet enkelt och lämna stilen till husets stilsträng i `style.json`. Skriv "flaky pine bark with reddish plates", inte en lång stilbeskrivning.

## 4. Färg

- **Mättat men kontrollerat.** Klara färger, men varje scen har en dominerande palett och 1–2 accentfärger.
- **Varmt ljus, kall skugga.** Solsidan går mot gult och orange, skuggsidan mot blått och lila.
- **Värdehierarki.** Det viktiga (vägar, interaktiva saker, karaktärer) har högst kontrast. Bakgrund är ljusare och mindre mättad (luftperspektiv).
- **Inget rent svart eller rent vitt** i texturer. Mörkast cirka 8–10 % ljushet, ljusast cirka 90 %.

Grundpaletten finns i `style.json` under `palette`.

## 5. Vegetation

| Regel | Praktiskt |
|---|---|
| Klumpiga kronor | Kronan består av några stora, mjuka "moln" av löv, inte tusen enskilda löv. Silhuetten ska vara rund och lätt att läsa. |
| Canopy-normaler | Lövens normaler pekar utåt från kronans centrum (överför normaler från en sfär eller uppblåst hölje). Då skuggas kronan som en mjuk boll i stället för som brus. Det här är det viktigaste tricket för stiliserade träd. |
| Gradient i kronan | Mörkare och kallare inåt och nedåt, ljusare och varmare utåt och uppåt. |
| Lövkort med kluster | Varje lövkort är ett kluster av flera stiliserade löv, inte ett enskilt löv. Alfa med mask, inte blend. |
| Translucens | Löv släpper igenom lite ljus (subsurface eller translucency) så motljus glöder. |
| Stammar | Tjocka, tydlig avsmalning, få men karaktärsfulla grenar. Bark med låg frekvens och tydliga, målade fåror. |
| Barrträd | Barrträd har egna barr-kluster, inte lövkluster. |

## 6. Ljus (förhandsvisning och spel)

- Klar himmel som ger mycket ambient ljus, så att skuggor aldrig blir svarta.
- Varm sol, cirka 45° höjd, med mjuka skuggor.
- Svag kall fyllning från himlen, gärna kantljus på karaktärer.
- Tonemapping: AgX med medel- till hög kontrast. Inga utbrända högdagrar.

## 7. Undvik

- Fotorealism, skannade texturer, fotobrus.
- Cel-shading eller tjocka svarta konturer (det är en annan stil).
- Perfekt geometri: helt raka kanter, exakt symmetri, vassa hörn.
- Inbakade hårda skuggor i texturer.
- Grått, smutsigt eller brunt "realistiskt" färgschema.
- Tunna, spretiga former som försvinner på avstånd.

## 8. Checklista per verktyg

Varje generator ska uppfylla detta innan den räknas som klar:

- [ ] Läser stil (prompter, palett, bevel, budget) från `tools/style.json` i stället för egna hårdkodade värden.
- [ ] Former följer formreglerna: avfasade kanter med weighted normals där det finns hårda kanter.
- [ ] Inom polygonbudgeten för sin typ.
- [ ] Texturer följer texturreglerna och exporteras med rätt alfaläge.
- [ ] Har en förhandsvisning med standardljuset i avsnitt 6, för jämförelse mellan verktyg.

## Status för befintliga verktyg

| Verktyg | Följer guiden | Saknas |
|---|---|---|
| `create_tree` | Till stor del (v2) | Tydligare skuggkontrast, translucens och vind (i klienten), LOD för grenar. Se roadmapen. |
| `generate_texture` | Ja (via `style.json`) | Normal- och roughness-kartor. `tile` blandar med en förskjuten kopia, vilket ger genomskinliga "spökformer" på oregelbundna mönster (kullersten); fungerar bra på bark och fibrösa ytor. Behöver en bättre sömlös metod (t.ex. sömlös generering i ComfyUI eller graph-cut-sömmar). |
