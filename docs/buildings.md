# Byggnader: modulära hus med en strukturgraf och en taklösare

Plan för byggnadsgeneratorns nästa version, efter `patriks_input/AAA_Procedural_Modular_Buildings_ThreeJS_Reference.md` (2026-10-27). Påbörjad 2026-10-28.

## Varför

Dagens generator (`tools/building/gen_building.mjs`) gör snygga detaljer: avfasade former, utsvängda takfall, takrader i relief, korsvirke, sex spelstilar och tre LOD-nivåer. Men huset är en enda rektangel med ett sadel- eller valmtak, plus ett torn eller en flygel bredvid. Referensbilden (`Asset_Studio_Nine_Inspiration_Images/08_Modular_Buildings.png`) har det som ger en fantasyby dess charm: korsande branta gavlar, utkragade övervåningar, stengrund med korsvirke ovanpå, ränndalar där taken möts, torn, skorstenar och djupa fönster med varmt ljus.

Referensen säger att **taklösaren, korsvirket, materialens sammanhang och fogarna** ska vara förstaklassdelar, och att huset sparas som en redigerbar graf. Meshen är en härledd cache. Därför byggs en ny generator bredvid den gamla, som finns kvar tills den nya täcker allt.

## Principer

- **En strukturgraf** (`tools/building/house/graph.mjs`): huset är volymer (rektanglar med våningar, utkragning och tak) som sitter ihop. Ur dem räknas väggspann per volym och våning (den del av väggen som syns: inte inne i en annan volym, upp till taket), öppningar (dörrar och fönster i fack) och skorstenar. Samma graf kan senare redigeras för hand (Explore i Kartrummet, det nya Tinkertown).
- **En grammatik per hustyp** (`tools/building/houses.json`): huvudhus, framgavel, flygel, vinkel (L), T-hus, utbyggnad med pulpettak, fyrkantigt torn. Måtten är intervall, och allt slumpas ur seed med en egen hash per del, så att ett nytt fönster inte flyttar taket.
- **En taklösare** (`tools/building/house/roof.mjs`): varje volym ger sina takplan, och husets tak är det högsta av volymernas tak. En synlig takyta blir ett konvext område minus konvexa områden där ett annat tak ligger högre, uppdelat i konvexa bitar med halvplansklippning. Ränndalar och nockar hamnar exakt där taken möts, och kanterna klassas (takfot, nock, ränndal, steg mot en högre vägg). Gavelväggarna följer takets höjd, så gavelröstet blir rätt även när två tak möts.
- **Stilarna är data** (`_styles` i `buildings.json`, samma som den gamla generatorn): texturer, färger, fönsterform, korsvirke, utkragning, takets lutning och detaljer. En stil byter material och detaljer, inte topologin.
- **Fogar och sammanhang:** korsvirkets syll och hammarband löper obrutna över väggspannen, hörnstolpar sitter i ytterhörnen, fönstren är djupa (smyg, bröstning, foder), och takets rader följer varje takyta.
- **Verktygsmönstret:** recept in (`make_building.py` med `archetype`), glTF med LOD0–LOD2 ut, en rad JSON med `checks` (dörr, taket täcker väggarna, inga överlapp, öppningar inom väggarna, skorstenar genom taket, står på marken, budget, LOD minskar).

## Delar och ordning (vertikala skivor)

| Del | Innehåll | Klart när | Status |
|---|---|---|---|
| 1. Taklösaren | Takplan per volym, övre höljet, konvexa bitar, kantklassning | Inga glipor eller överlapp i sadel-, valm-, kors-, L- och tornfall (provat i Node) | Byggd 2026-10-28 |
| 2. Grafen och massan | Hustyper som grammatik, volymer med våningar och utkragning, väggspann upp till taket, öppningar i fack, skorstenar | Hus med korsande gavlar, vinkel och T går att generera | Byggd 2026-10-28 (sju hustyper) |
| 3. Geometrin | Väggar med hål, djupa fönster och dörrar, korsvirke, sockel, takytor med rader och takfot, nockpannor, skorstenar, LOD0–LOD2, glTF | Kontaktark av alla hustyper ser ut som hus | Byggd 2026-10-28 (första skivan) |
| 4. Sammanhang | Takkupor, balkonger, trappor, lyktor, rankor, väderbitning (ålder, mossa, sot) | Huset ser bott i ut | |
| 5. Fler stilar och former | Runda torn i lösaren, valmade korsningar, mansard, stadsvärn, ruiner | Hela referensens lista (§17: hydda, korsvirkeshus, gård, stadshus, torn, borg, ruin) | |
| 6. Studion och Kartrummet | Hustyperna i Smedjan med spakar; hus att ställa ut i Explore; redigering av grafen | Patrik kan dra i spakarna och ställa hus i en värld | Smedjan byggd 2026-10-28 |

## Byggt 2026-10-28 (första skivan)

- **Taklösaren** (`house/roof.mjs`) provad i Node på sadeltak, valmat tak, korsande gavlar, vinkelhus och ett hus med pulpettak och torn: inga glipor, inga överlapp, rätt höjd i varje provpunkt. Kanterna klassas som takfot, nock, ränndal, steg och inre skarv (där en takyta delats i flera konvexa bitar).
- **Grafen** (`house/graph.mjs`) och **hustyperna** (`houses.json`): stuga (med utbyggnad), korsvirkeshus (stengrund, utkragning, framgavel), stadshus (gaveln mot gatan, varje våning sticker ut), gård (vinkel med flygel och farstukvist), herrgård (T, valmat eller sadeltak), värdshus (två framgavlar och kökslänga) och tornhus (fyrkantigt torn med pyramidtak). 0–6 ms per hus.
- **Geometrin** (`gen_house.mjs`, `house/geom.mjs`): väggar med riktiga hål och smyg, fönster med foder, bröstning, båge, spröjs, luckor och blomlådor, dörrar med trappa, litet tak och lykta, korsvirke med obrutna syllar och hammarband, hörnstolpar, snedstag, kungsstolpe och hanbjälke i gavlarna, utkragningens bjälkändar, hörnkedja på stenvåningar, sockel, takytor i rader av pannbitar (förskjutna varannan rad, egen ton, mossa i fläckar), takfot med tjocklek, vindskivor längs gavlarna, nockpannor och skorstenar. Grafen följer med i modellen (`extras.graph`).
- **Kontrollerna:** dörr, inga glipor eller överlapp i taket, öppningarna inom väggarna och inte över varandra, skorstenarna genom taket, står på marken, budget och att LOD minskar. Alla sju hustyper i alla sex stilar och två frön är gröna. 6 000–35 000 trianglar i LOD0.
- **Granskning:** `tools/building/house_sheet.py` bygger husen och renderar dem på rad i Blender, snett ovanifrån (`preview_glb.py` fick kamerahöjd `elev`). Felsökt på vägen: takradernas kanter var vända uppför (lutningen `(a, b)` pekar uppåt) och gallrades bort, så att marken syntes genom springorna.
- **Takkupor** (`base: eave` i `houses.json`): en liten volym som står på takfoten. Taklösaren gömmer dess väggar under huvudtaket och låter dess tak möta huvudtaket i ränndalar. Den sida som sitter inne i huset får inget takutsprång (`roof.inner`), annars sticker kupans tak ut på andra sidan nocken. Stuga, korsvirkeshus, gård, herrgård och värdshus har takkupor.
- **Balkong:** ett fönster mitt på huvudvolymens framsida på övervåningen blir en glasdörr med balkong (golv på konsoler, räcke med spjälor), oftare i stilar med korsvirke (`balcony` i stilen styr).
- **WoW-stilisering:** takfoten svänger upp med avståndet utanför väggen i kvadrat (stilens `roof.flare`, mer ju högre stiliseringen). Det är en funktion av läget, så takytor, takfot och vindskivor som möts följer med lika mycket. Nockändarna böjs uppåt där nocken slutar i gavelns takutsprång (`roof.tips`).
- **Kontrollen för överlapp** räknar bara punkter som ligger klart inne i två takytor: på en kant där en högre takfot står över ett annat tak får båda finnas. Alla sju hustyper i fyra stilar, tre frön och två stiliseringsgrader (168 hus) är gröna.
- **Smedjan:** fliken House (i stället för den kommande Building part) bygger med den nya generatorn: lådan har en mall per hustyp, kortet House har hustyp, frö, stil och stiliseringsgrad (`tools/building/params.json`), och footern visar storlek, volymer, fönster, trianglar och takets glipor och överlapp. Spara lägger huset i biblioteket som vanligt. Servern läser hustyperna ur `houses.json` (`speciesKey: archetypes`). Testat med `tools/studio/ui_tests/house.json`.
- **Kvar:** utvändiga trappor, rankor och props kring huset, runda torn i lösaren, och att öppna ett sparat hus i Smedjan igen.
