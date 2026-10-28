# Byggsatsen: hus av riktiga byggdelar

Plan efter kritiken 2026-10-28 (ChatGPT, via Patrik): vi bygger inte en generator av lådor med texturer, utan en **fabrik för en modulär byggsats**. Byggsatsen är som ett påkostat miljökit till ett fantasy-RPG (Enshrouded som förebild för hantverket), men med vanliga polygonmodeller i stället för voxlar. Varje modul ska vara vacker även ensam, och samma moduler ska kunna sättas ihop för hand (Explore, nya Tinkertown) och av recept (stuga, värdshus, borg).

## Fyra nivåer

| Nivå | Vad | Var |
|---|---|---|
| A. Byggelement | Enskilda stenar (huggna, avfasade, kantstött), hörnstenar, valvstenar, fönsterbänkar, bjälkar (avfasade, lätt skeva, ändträ), snedstag, takpannor, nockpannor | `tools/building/kit/elements.mjs` |
| B. Byggdelar | Stenmur i skift med förskjutna fogar, hörn med hörnkedja, fönster med smyg, valv och bänk, korsvirkesvägg med syll, hammarband, stolpar, stag och puts, takfall med takfot och synliga takfötter, nock och vindskiva | `tools/building/kit/modules.mjs` |
| C. Modulerna | Byggdelar med standardmått, sockets (anslutningspunkter) och regler för vad som passar ihop | `tools/building/kit/kit.json` |
| D. Byggnadsrecept | En lista med placeringar av moduler (modul, variant, läge, vridning). Det är samma format som redigeraren använder | `kit.json` (`assemblies`), `gen_kit.mjs` |

## Inventering av den nuvarande generatorn

| Del | Beslut | Varför |
|---|---|---|
| Taklösaren (`house/roof.mjs`) | **Behålls** | Den räknar ut var taken möts (ränndalar, nockar, steg). Byggsatsen behöver den för att välja rätt takmoduler i sammansatta hus (korsande gavlar) och för kontroller. |
| Strukturgrafen och hustyperna (`house/graph.mjs`, `houses.json`) | **Görs om** | Grafen och hustyperna är rätt idé (hus som data, seed per del), men måtten är fria decimaltal. De ska i stället följa rutnätet (0,5 m, väggar 2 m, våningar 3 m), och grafen ska ge placeringar av moduler i stället för fria väggspann. |
| Geometrihjälparna (`house/geom.mjs`) | **Behålls som grund** | Hjälparna för delar, vertexfärger och texturkoordinater i meter används vidare. Nivå A får egna former ovanpå dem: sexsidingar som kan formas fritt (sten, kil, valvsten) och bjälkar med ändträ. |
| Husgeometrin (`gen_house.mjs`) | **Ersätts** | Väggen är i dag en plan yta med en textur av sten. Korsvirket är lådor ovanpå putsen, och taket är rader av långa bitar. Den byggs om av modulerna. Den gamla filen finns kvar tills byggsatsen täcker hustyperna. |
| Stilarna (`buildings.json` `_styles`) | **Behålls delvis** | Paletter och fönsterformer gäller fortfarande. Konstruktionsfamiljerna (sten, korsvirke, tak) blir egna data i `kit.json`, så att nya byggnadsfamiljer kan läggas till utan kod. |
| glTF med LOD och kontroller | **Behålls** | Verktygsmönstret gäller fortfarande: recept in, en rad JSON ut, `checks.ok` och LOD0–LOD2. |
| Kontaktark i Blender (`house_sheet.py`) | **Behålls** | `kit_sheet.py` gör samma sak för modulerna. |

## Mått och koordinater

- **Rutnät:** 0,5 m. En vägg är 2 m bred och en våning 3 m hög. Allt vrids i steg om 90°. Halva och dubbla bredder och andra höjder är varianter.
- **Rutnätslinjen är väggens yttersida.** Väggen ligger inåt, så sten (0,5 m tjock) och korsvirke (0,3 m) har sina utsidor i liv med varandra, och husets mått är yttermått.
- **En moduls lokala axlar:** x längs väggen (0–2 m), y uppåt (0 = modulens fot) och z ut från huset (utsidan vid z = 0, väggen åt −z).
- **Ändarnas sockets:**
  - `open`: en rak fortsättning. Murens skift tandas ihop: varannan skift sticker ut 0,25 m in i grannen.
  - `corner`: ett ytterhörn. Hörnmodulen äger hörnrutan och hörnkedjan.
  - `end`: en fri ände.
  - `verge`: takets gavelände.
- **Varje skarv har en ägare.** En stolpe i korsvirket hör till modulen till höger om skarven, och takpannan som ligger över skarven hör också dit. Det ger inga dubbla stolpar och inga glipor, och modulen ser likadan ut var den än står, så den kan instansieras.
- **Murens skift är gemensamma** för hela stenfamiljen (höjder ur familjens seed). Därför möts murar, hörn och fönster i samma fogar. Fönster och dörrar läggs i skiftens fogar.

## Prototypen (del 1)

Sju moduler visas var för sig och sätts sedan ihop till en liten byggnad:

1. en stenmur, 2 × 3 m, av huggna, oregelbundna stenar i skift
2. ett hörn med hörnkedja som passar muren
3. en stenmur med ett fönster: smyg, båge, valv av kilstenar med slutsten, och en fönsterbänk
4. en korsvirkesvägg
5. en korsvirkesvägg med fönster
6. ett brant takfall med takfot, synliga takfötter och pannor i rader
7. en nock och takets hörn vid gaveln: vindskiva, utstickande bjälkändar och nockens ände

För att byggnaden ska stå behövs också gavelns korsvirke (halva gavlar). Byggnaden är 4 × 4 m och har en bottenvåning av sten, en övervåning av korsvirke och ett sadeltak.

**Kontrollerna (`checks`):**
- Alla sockets har en partner av rätt typ på samma plats.
- Inga stenar eller bjälkar från olika moduler går in i varandra, och inga bjälkar är dubbla.
- Inga glipor i murens yta eller i taket (prov i ett rutnät).
- Varje sten vilar på marken eller på något under sig.
- Skiften är lika på båda sidor om varje skarv.
- Budget och att LOD minskar.

## Prestanda

Genereringen får ta tid, men visningen ska vara billig:
- Varje modul sparas sammanslagen per material: en sten är inte ett eget anrop.
- LOD1 har enklare stenar.
- LOD2 är en låda per byggdel.
- Dolda ytor tas bort: stenarnas baksidor och ytor inne i muren.
- Moduler som upprepas kan instansieras.
- Receptet (placeringarna) sparas för sig, så att meshen alltid kan byggas om.

## Senare

- Dörrar och innerhörn.
- Utkragade övervåningar med konsoler.
- Takkupor och korsande tak via taklösaren.
- Trappor, pelare, valvbågar och balkonger.
- Material med finare detalj (porer, ådring) som normalkartor ur texturverkstaden.
- Modulerna i Smedjan och i Explore.
- Hustyperna i `houses.json` som recept på moduler.

## Byggt 2026-10-28 (prototypen)

- **Elementen** (`kit/elements.mjs`):
  - En sexsiding med avfasade kanter, som kan formas fritt: kilsten, sned ände, bjälke med vridning och böj, takpanna.
  - Vägda normaler ger plana ytor och mjuka fasar. Ojämnheterna hashas på läget, så att delade hörn alltid blir lika.
  - Stenarna kan vara kantstötta och välvas lite. De får sin färg målad per sten, ljusare upptill. Kanterna är ljusare och slitna, och bergnormalen ger den fina ytan.
  - Bjälkarna har ljust ändträ. De böjer sig ut ur väggens plan, aldrig in i grannmodulen.
  - Varje element registreras med sin utbredning, så att kontrollerna kan pröva mot dem.
- **Murverket** (`kit/modules.mjs`):
  - Skiften är gemensamma för stenfamiljen, högre nertill.
  - Fogarna hålls minst 12 cm från fogarna i skiftet under, och ibland går en sten över två skift.
  - Ändarna mot en granne tandas: varannan skift sticker ut 25 cm. Ändstenarna är långa, så att fogarna inte hamnar i linje över skarven.
  - Fogbruket ligger 3 cm in bakom stenarna, tandat som stenarna.
  - Hörnet är en hörnkedja av tuktade stenar, varannan lång åt var arm.
  - Fönster och dörr ligger i skiftens fogar. De har smyg av tuktade stenar (lång och kort växelvis), ett valv av fem kilstenar med radiella fogar och slutsten, och en fönsterbänk som sticker ut. Fönstret har båge med spröjs och blyspröjs, dörren plankor med järnband och en tröskelsten.
- **Korsvirket:**
  - Syll och hammarband går över hela modulen, och stolpen vid skarven hör till modulen till höger.
  - Väggen har en mittstolpe, en regel, Andreaskors nertill och sparrar i V upptill.
  - Fönstret har fönsterstolpar, bröstregel och överregel, Andreaskors under fönstret och sneda stag vid sidan.
  - Putsen ligger 3,5 cm in. Hörnstolpen är en egen modul.
  - Den halva gaveln följer takets undersida. Kungsstolpen hör till den fallande halvan.
- **Taket:**
  - Fotrem.
  - Sparrar med lodräta snitt vid takfoten och mot nockbjälken.
  - Brädor som syns underifrån.
  - Skifferpannor i rader, förskjutna en halv panna varannan rad. Pannan över skarven hör till modulen till höger, så att det aldrig blir dubbla pannor eller glipor.
  - Vid gaveln: vindskiva med en svarvad droppe vid takfoten, och pannor ut över vindskivan.
  - Nocken: nockbjälke, rundade nockpannor med vidare ände, och en svarvad spira vid gaveln.
- **Recept och placeringar** (`gen_kit.mjs`):
  - Ett hus är en lista med placeringar (modul, ändar, läge, vridning), räknad ur ett recept (`footprint`, våningar per sida, sadeltak) eller skriven för hand (`corner_demo`).
  - Huset sparas sammanslaget per material, med placeringarna i `extras`, så att det kan byggas om och redigeras.
- **Kontroller:**
  - Huset på 6 × 4 m (41 moduler, 32 unika): alla 144 sockets parade, inga överlapp mellan moduler, inga glipor i 45 908 prov i väggarna och 7 524 på taket, inga svävande stenar, samma skift överallt.
  - Två fel som kontrollerna hittade och som rättades:
    - Öppningar i en modul bredvid ett hörn krockade med hörnkedjan. Regeln är nu att öppningar i sten kräver öppna ändar.
    - Hörnet saknade fogbruk.
- **Bilder:** `tools/building/kit_sheet.py` (katalogen och husen).

**Kvar och kända svagheter:**
- **LOD0 är tungt.** Huset har 110 000 trianglar i LOD0, 76 000 i LOD1 och 17 000 i LOD2. Stenarna står för två tredjedelar. Nästa steg:
  - en enklare LOD0 för stenarna (välvningen bara på framsidan)
  - instansiering av modulerna, med tre varianter per modul i stället för en unik per placering
  - en LOD1 med stenarna bakade i en normalkarta på en plan mur
- Öppningar i sten bredvid ett hörn: en kortare hörnkedja eller en smalare fönstermodul.
- Dörrar i korsvirke.
- Innerhörn.
- Utkragning med konsoler.
- Takkupor och korsande tak via taklösaren.
- Moduler i Smedjan och i Explore.
