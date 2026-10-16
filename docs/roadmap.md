# Roadmap

Tinkertown byggs av **specialiserade generatorer**, en per typ av spelobjekt, som alla följer samma [stilguide](style-guide.md) och samma kontrakt. Allt de skapar hamnar i ett gemensamt **bibliotek**, där spelskaparen snabbt väljer och placerar objekt och där AI:n snabbt kan generera nya varianter.

Ordningen är en rekommendation. Fas 0 behövs för allt annat, och därefter byggs det som gör att man tidigast kan gå runt i en egen värld.

---

## Gemensamt kontrakt för alla generatorer

Varje generator ska uppfylla detta, så att biblioteket, editorn och AI:n kan behandla dem likadant:

- [ ] **Recept in:** JSON med `type`, `preset`, `seed` och typspecifika parametrar. Samma recept ger alltid samma objekt.
- [ ] **Tillgång ut:** GLB under `assets/<typ>/<namn>/`, plus `recipe.json` och en miniatyrbild för biblioteket.
- [ ] **Metadata:** bounding box, fotavtryck, pivot vid markkontakt, kollisionsform, taggar och trianglar per LOD.
- [ ] **Stil:** läser `tools/style.json` (palett, bevel, weighted normals, budget). Inga egna hårdkodade stilvärden.
- [ ] **LOD:** minst två detaljnivåer för det som placeras i stort antal (träd, stenar, buskar, props).
- [ ] **Varianter:** `variants(recept, antal)` ger N varianter med nya seeds, och `mutate(recept, ändring)` justerar enskilda parametrar.
- [ ] **AI-gränssnitt:** exponeras som MCP-verktyg som svarar med en rad JSON.
- [ ] **Förhandsvisning:** standardljuset från stilguiden, så att objekt från olika generatorer går att jämföra.

---

## Fas 0: Grunden

- [ ] Projektstruktur: `client/` (Three.js) och `server/` (Node), enligt arkitekturen i README.
- [ ] Lokal Node-server: API för världsrecept, tillgångar och verktygskörningar.
- [ ] Bestäm om MCP-servern skrivs om i Node eller om Node anropar dagens Python-verktyg.
- [ ] Världsformat: världen som en fil med recept (terräng, placerade objekt, system). Inga inbakade meshar.
- [ ] Spelläge från start: WASD, mouselook, gå och spring, hopp, flyg (editorläge), interaktionsknapp, enkel attack.
- [ ] Fysik och kollision med Rapier.
- [ ] Rendering enligt stilguiden: PBR, AgX-tonemapping, SSAO, bloom, mjuka skuggor.
- [ ] Hot reload: när ett recept ändras uppdateras objektet i världen utan omstart.
- [ ] Ångra och gör om för alla ändringar, även de som AI:n gör.
- [ ] Spara och ladda världar.

## Fas 1: Gå runt i en egen värld

### Terräng
- [ ] Heightmap i chunks med LOD.
- [ ] Generator: brusbaserad bas (FastNoiseLite) plus erosion. Presets: ö, kullar, berg, slätt.
- [ ] Material via splatmap: gräs, jord, sten, sand, snö. Automatisk blandning efter lutning och höjd, plus manuell målning.
- [ ] **Terrängborstar:** höj, sänk, jämna ut, platta till, ramp, brus. Storlek, styrka och falloff.
- [ ] **Objekt följer terrängen:** varje placerat objekt sparar sin höjd *relativt marken* (`anchor: "ground"`), så när marken höjs eller sänks flyttas objektet med. Läget `"absolute"` finns för broar, flygande öar och liknande.
- [ ] Objekt som lutar med marken (stenar, buskar) räknar om sin lutning när terrängen ändras. Byggnader står kvar lodräta.
- [ ] Vegetationsspridning räknas om lokalt i det område som ändrats.

### Träd (påbörjat)
- [x] ez-tree-geometri med UV, recept → GLB.
- [x] Stiliserade bark- och lövtexturer via Krea-2.
- [x] MCP-verktyget `create_tree`.
- [ ] Canopy-normaler (sfärisk normalöverföring), så kronan skuggas som mjuka bollar.
- [ ] Gradient i kronan: mörkt inåt och nedåt, ljust utåt och uppåt (vertexfärg).
- [ ] Translucens i löven.
- [ ] Barr-kluster för barrträd.
- [ ] LOD och impostor (billboard) på långt avstånd.
- [ ] Vind i shadern.
- [ ] Ersätt den nuvarande `tile`-metoden, som ger spökformer på oregelbundna mönster.

### Bibliotek (första version)
- [ ] Katalog över alla tillgångar: typ, kategori, taggar, miniatyrbild, receptfamilj och varianter.
- [ ] Sökning och filtrering (typ, biom, storlek, taggar).
- [ ] Favoriter och "senast använda".
- [ ] Dra och släpp från biblioteket ut i världen.
- [ ] Knappen "Fler varianter" genererar nya seeds i bakgrunden.

### Placering
- [ ] Placera där spelaren tittar. Fäster mot terrängen, med valfri anpassning till markens normal.
- [ ] Slumpvis rotation och skala inom intervall per objekttyp.
- [ ] Spridningsborste: måla ut skog, buskar eller stenar med densitet och regler (lutning, höjd, avstånd till vatten).
- [ ] Undvik överlapp via fotavtryck.
- [ ] Flytta, rotera och skala med gizmo. Duplicera. Gruppera.

## Fas 2: Naturen

### Naturliga objekt
- [ ] Stenar och block: procedurell form (brus på deformerad kub eller sfär), bevel och weighted normals, mossa ovanpå.
- [ ] Buskar och gräs: gräs som instansierade kort eller shader-gräs, blommor, svamp.
- [ ] Stockar, stubbar, rötter.
- [ ] Biomer: regeluppsättningar som väljer vilka naturobjekt som sprids var.

### Vatten och hav
- [ ] Hav: stiliserad vattenshader med djupfärg (grunt turkos, djupt blått), skumkant mot land och mjuka vågor.
- [ ] Sjöar: vattenyta på en angiven nivå, som klipps mot terrängen.
- [ ] Floder: spline som gräver i terrängen och har flödesriktning i shadern.
- [ ] Undervattensvy: dimma och färg.

### Stora förändringar
- [ ] **Klippor:** kit av klippformer som stämplas in i terrängen och smälter ihop med den.
- [ ] **Sjöar:** "gräv en sjö här" sänker terrängen, lägger vattenyta och sätter strandmaterial.
- [ ] **Vattenfall:** en flod når en klippkant, och då genereras vattenridå, partiklar, skum och en bassäng nedanför.
- [ ] **Floder:** dra en linje, så gräver verktyget fåran och lägger vatten.
- [ ] **Vägar och stigar:** spline som plattar till och målar terrängen.

### Ljussystem
- [ ] Sol och himmel med tid på dygnet, och varmt ljus mot kall skugga enligt stilguiden.
- [ ] Atmosfär och dimma med luftperspektiv.
- [ ] Punktljus och lampor för facklor, fönster och magi.
- [ ] Ljusinställningar per scen eller biom (presets).

### Vädersystem
- [ ] Vind som påverkar vegetationen globalt.
- [ ] Regn och snö (partiklar, våta ytor, snötäcke på ovansidor).
- [ ] Moln och dimma.
- [ ] Övergångar mellan väderlägen, gärna styrda per biom.

## Fas 3: Bebyggelse

### Skapade objekt och props
- [ ] Parametriska props: lådor, tunnor, staket, skyltar, bänkar, vagnar, lyktor.
- [ ] Bevel och weighted normals på allt, plus lätt lutning och asymmetri (stilguiden, avsnitt 1).
- [ ] Trim sheets och delade texturer för trä, metall och sten.
- [ ] Generering via Blender headless, på samma sätt som träden.

### Byggnader
- [ ] Modulärt kit: väggar, hörn, tak, dörrar, fönster, trappor.
- [ ] Generator: byggnadsrecept (våningar, takform, material, stil) → sammansatt byggnad.
- [ ] Interiörer, först enkla.
- [ ] Byggnader anpassar sin grund till terrängen (sockel), i stället för att sväva eller sjunka.
- [ ] Byar och bosättningar: regler för placering av flera byggnader, vägar och props.

## Fas 4: Liv

### Varelser och djur
- [ ] Basformer per kategori: fyrfotadjur, fåglar, fiskar, insekter, fantasivarelser.
- [ ] Rigg och animationer: gå, spring, idle, attack.
- [ ] Beteenden: vandra, fly, flock, attackera.

### Karaktärer
- [ ] Basmodell att utgå från (undersök MPFB/MakeHuman, och kontrollera licensen för användning i spel).
- [ ] Stiliserade proportioner enligt stilguiden: större händer, huvud och fötter.
- [ ] Kläder, hår och utrustning som lager.
- [ ] Animationer: undersök fria källor. Mixamo är inte öppen källkod, så kontrollera villkoren.
- [ ] Spelarkaraktär: rörelse, kamera, animationsövergångar.
- [ ] NPC:er: rutiner, dialog och att ge uppdrag.
- [ ] Fiender: AI-tillstånd (patrullera, jaga, attackera), aggro, hälsa och skada.

## Fas 5: Spelsystem

### Interaktiva objekt
- [ ] Komponentsystem: `interactable` med tillstånd och handlingar (öppna, plocka upp, använda, prata).
- [ ] Dörrar, kistor, spakar, knappar, plockbara föremål, skyltar.
- [ ] Triggers: zoner som startar händelser.

### Inventory
- [ ] Föremålsdefinitioner som data (namn, ikon, typ, stackbar, egenskaper).
- [ ] Spelarens inventory med UI, plus utrustning (vapen, rustning).
- [ ] Ikoner genereras automatiskt från föremålets 3D-modell eller via Krea-2.

### Quest system
- [ ] Uppdrag som data: mål (hämta, döda, prata, gå till), villkor och belöningar.
- [ ] Questlogg och spårning i UI.
- [ ] Koppling till NPC:er, interaktiva objekt och inventory.
- [ ] AI-genererade uppdrag från ett kort recept ("en fiskarby behöver hjälp med X").

## Genomgående: GUI

Editorn ligger som ett lager ovanpå spelet. Man växlar mellan att spela och att bygga med en tangent, utan att lämna världen.

- [ ] **Lägesbyte** (till exempel Tab) mellan spel och editor. Kameran stannar där den är.
- [ ] **Snabbfält** med de senast valda objekten, som i ett byggspel. Siffertangenter väljer, klick placerar.
- [ ] **Bibliotekspanel:** rutnät med miniatyrbilder, sök, filter, kategorier.
- [ ] **Inspektör:** receptets parametrar som reglage. När man drar i ett reglage genereras objektet om live.
- [ ] **Verktygsfält för terräng:** borstar, storlek, styrka, material.
- [ ] **AI-ruta:** skriv "lägg en skog där jag tittar" eller "gör den här stenen större", och AI:n anropar verktygen.
- [ ] **Kommandopalett** (Ctrl+K) för alla funktioner.
- [ ] **Minikarta** eller översiktsvy.
- [ ] **Historik:** lista över ändringar med ångra, även AI:ns.
- [ ] **Bakgrundsjobb:** en indikator när generatorer arbetar, så att editorn aldrig fryser.
- [ ] Stiliserat UI som matchar spelets stil, med tydlig typografi och snabba genvägar.

## Genomgående: AI och MCP

- [ ] Varje generator som MCP-verktyg enligt kontraktet ovan.
- [ ] Rumsliga frågor: vad spelaren tittar på, objekt inom en radie, terränghöjd, vilket biom det är.
- [ ] Världsverb på hög nivå: `place_forest`, `carve_lake`, `add_waterfall`, `build_village`.
- [ ] Alla AI-ändringar går via samma ångra-system som manuella ändringar.
- [ ] Mät tokenkostnaden per verb, så att vi ser att varje verb fortfarande är billigt.

## Senare

- [ ] Desktopapp med Electron.
- [ ] Prestanda: instansiering, culling, LOD-strömning för stora världar.
- [ ] Ljud: miljöljud per biom, steg, interaktioner.
- [ ] Export eller delning av världar.
