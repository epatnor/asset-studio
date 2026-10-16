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
- [x] **v3: egen generator där allt växer ur ett skelett** (`skeleton.mjs`): stam och grennivåer, där varje gren startar på förälderns axel och är smalare än den (da Vincis regel). Placering enligt gyllene vinkeln, plus ljus, gravitation och krokighet. Kransar för gran. Arter som data i `species.json` (ek, asp, ask, körsbär, gran, buske).
- [x] Bark som sammanhängande rör (parallellförflyttade ramar), UV i meter, rotutsvängning, och LOD även för grenar (LOD1 utan yngsta nivån, LOD2 bara stam och första nivån).
- [x] Lövkluster placeras vid och förankras i kvistarna; granens barrgrenar följer exakt de riktiga grenarna; toppskott.
- [x] Kontroller i svaret (`checks`): frånkopplade grenar, barn tjockare än förälder, delar under marken, svävande kluster. `ok: true` när allt hänger ihop.
- [x] ez-tree och three borttagna ur trädverktyget.
- [x] **v4-krona för lövträd** (`crown.mjs`): underklumpar vid kvistarna, en kärnklump som binder ihop dem, polynomisk smooth min till ett molnlikt fält, en ogenomskinlig kronmesh via surface nets, och tusentals små lövkort (`leaflet_atlas`) med normaler från fältet. Inspirerat av målbilderna och "Stylized Tree Generator" (Superhive).
- [x] Stammen: mjuk S-böj, kraftigare rotutsvängning. Lövfärg per art via `leaf_tint` i `species.json` (pekar på paletten). Klarare förhandsljus (AgX Punchy).
- [x] Bulliga kronor enligt "Stil- och Teknikguide: Stiliserad Vegetation" (Painterly/Ghibli): kupolläge med stora runda puffar på kronans yta (Fibonacci-fördelning), mindre bullar ovanpå, täckningspuffar på varje kvist (inga kala grenar, kontrollen `uncovered_twigs`), puffnormaler (α ≈ 0,85) och mörkare skrevor mellan bullarna. Kronmassan har bara vertexfärg.
- [x] Vinddata i `COLOR_1` enligt guiden: R = höjd, G = rörlighet, B = fas per kluster (läsbar i Unreal, Godot och Unity).
- [x] Dynamiska stammar: flikigt tvärsnitt (3–5 utbuktningar) som vrider sig uppåt och avtar med höjden, svällningar längs grenen, starkare S-böj, och jämna normaler från geometrin. Allt styrs av `lobes`, `lobeAmp`, `twist`, `bulge` och `bend` per art.
- [x] Målade texturer: `bark_painted` (långa, flytande fåror) och `foliage_painted` (flikiga lövklumpar) på kronmassan, med lådprojektion per quad (inga ränder), tintad som löven.
- [ ] Generering 2–6 s per träd med många puffar: snabba upp fältet (spatialt rutnät över klumparna) om det blir ett problem.
- [ ] Jämfört med målbilderna saknas fortfarande: genomlysning, vind och färgvariation per klump (shader i klienten), finare blad i silhuetten, och en mer målad bark.
- [ ] Granens övre kransar: tätare, så att stammen inte syns mellan dem. Granen behöver också samma ljusa, mättade färgskala som lövträden.
- [x] ez-tree-geometri med UV, recept → GLB.
- [x] Stiliserade bark- och lövtexturer via Krea-2.
- [x] MCP-verktyget `create_tree`.
- [x] v2 enligt [vegetationsguiden](Stiliserad_vegetation_ThreeJS_med_bildreferenser.pdf): lövpunkter → 8–20 kluster, böjda lövkort på klustrens skal, glesare inre löv, utstickande kvistar.
- [x] Klusternormaler: `n = normalize(vertex − klustercentrum)`, blandat 80 % med kortets normal.
- [x] Gradient i kronan via vertexfärg: mörkt och kallt inåt och nedåt, ljust och varmt utåt och uppåt.
- [x] 2×2-lövatlaser (löv, körsbärsblom, barr) via `generate_leaf_atlas`, utan vit halo (verifierat med `check_alpha.py`).
- [x] Barrträd byggs i våningar (höjdband → platta skivor) med smala, hängande barrkort.
- [x] Tre LOD-nivåer för kronan (100 / 50 / 20 % av korten, större kort).
- [x] Vindvikt (`_WIND`) och kluster-id (`_CLUSTER`) som vertexattribut, för vindshadern i klienten.
- [x] GLB skrivs direkt från Node (gltf-transform); Blender används bara för förhandsbilder.
- [x] Klustervolymer: ojämna, ogenomskinliga ikosfärer med målad lövmassa (`leaf_mass`, `blossom_mass`, `needle_mass`) fyller kronan. Korten ligger på ytan och har samma normaler och gradient, så de smälter in. Ungefär hälften så många alfatestade trianglar (mindre overdraw), samma totala antal.
- [x] "Fluffy"-skuggning: normaler från en mjuk sammanslagning (smooth union) av alla klusterellipsoider, så att kronan skuggas som en form.
- [ ] Helt sammanslagen kronmesh (marching cubes över samma fält), så att silhuetten också blir en mjuk form i stället för separata klumpar.
- [x] `leaf_tint`: lövfärgen är en materialparameter (gråskaleatlas × baseColorFactor), som Material Instances i referensvideon. Höst- eller vårvariant utan nya texturer.
- [ ] Jämför mot ArtStation-referensen g2vxrL (sidan går inte att läsa automatiskt, så en skärmdump behövs).

**Lövmaterial i klienten** (från "Stylized Fluffy Trees Tutorial", akbutea; det mesta av looken sitter i shadern):
- [ ] Färgvariation per kluster: hasha `_CLUSTER` till en liten nyans- och ljushetsförskjutning.
- [ ] Genomlysning (subsurface/translucency): ljusare löv i motljus, på `onBeforeCompile` i `MeshStandardMaterial`.
- [ ] Vind i vertexshadern via `_WIND` (0 vid fästen, mer vid spetsar), med fas per kluster och instans, som "Simple Grass Wind".
- [ ] Materialparametrar i editorn som reglage: tint, vindstyrka, lövstorlek, genomlysning (motsvarar Material Instances).
- [x] Gran (`pine_*`): egen generator (`conifer.mjs`) med tjock stam och ringar av solida, nedåthängande barrgrenar med flikiga spetsar. Inga alfakort och ingen textur, och färger ur `style.json` (`conifer_*`). Cirka 30 000 / 12 000 / 4 000 trianglar för LOD0–2.
- [x] Granen enligt "Stylized 3D Pine Tree" (ZugZug Art): asymmetri per våning, enstaka saknade grenar, varma torra toner på cirka 12 % av grenarna, och en målad 2×2-barratlas (`frond_atlas`) med alfa bara i kanten, så att silhuetten blir spretig. `frond_texture: false` ger helt solida grenar utan alfa (för LOD eller svag hårdvara).
- [x] Granen: grenarna går ut nästan vågrätt och bågnar ner mot spetsen (`droopCurve`), brantare högre upp (`angleTop`); solfjäderformade barrgrenar (`fan`), färre och större per krans, en uppåtriktad tofs i toppen och stammen kapad under tofsen.
- [x] Generatorn täcker alla större växter som data i `species.json`: ek, lönn, ask, asp, björk (vit bark via `bark_tint`), körsbär, pil (hängande lövgardiner, `hang`), akacia (paraplykrona), cypress (pelare), japansk tall (platta kuddar, `mode: clusters` + `coverFlatten`), gran, palm (en krans i toppen), dött träd (`foliage: none`), hög buske och rund buske. MCP-verktyget läser arterna direkt ur filen.
- [x] Stamlösa buskar (`stemless`): bara bulliga former som vilar på marken, utan synlig stam. `ballbush` (rund, `round`) och `moundbush` (låg och bred). Skelettet är dolt men styr var bullarna sitter, så kontrollerna gäller fortfarande.
- [x] Egna busktexturer: `bush_atlas` (små täta busklöv) och `bush_mass` (finkornig lövmassa), plus `bush_green` i paletten.
- [x] Bladkupoler (`foliage: leafdome`): buskar av solida, facetterade blad i ringar som överlappande fjäll över en bred kupol (referens: stiliserade low-poly-buskar). Ingen alfatextur, 2 500–8 000 trianglar. Arterna `leafbush` (spetsiga), `petalbush` (runda) och `serratebush` (flikiga); `leaf_tint` ger färgvarianter. Bladen har en målad bladyta (`leaf_surface`, gråskala, UV över varje blads faktiska bredd) med mittnerv och sidonerver. Standardlayouten är `scatter`: bladen ligger oregelbundet (Fibonacci-sfär med jitter, slumpvis vridning och lyft) över en ellipsoid som fortsätter förbi ekvatorn, så att undersidan böjer in mot marken. Den gamla ringlayouten finns kvar.
- [ ] Pil: jämnare krona och en stamfot som inte delar sig. Palm: synliga småblad (fler segment längs bladet).
- [ ] Solid gran (`frond_texture: false`): fingrar i barrgrenarnas ytterkant, så att de inte blir kantiga paddlar.
- [ ] Ta bort eller slå ihop små, ensamma kluster långt från resten av kronan (körsbärets lösa nedre klump, tallens skivor vid grenändar).
- [ ] Tydligare skuggkontrast i kronorna (granskningen tycker fortfarande att den är svag).
- [ ] Tallen: tätare och tjockare våningar, och kapa lösa, kala grenar och den tunna toppspetsen.
- [ ] Buskar: tät mitt även för `bush_2`, och grenar inom buskbudgeten (`bush_1` har cirka 8 000 grentrianglar).
- [ ] LOD för grenar och stam (nu delar alla LOD samma grenmesh, så LOD2 sparar för lite).
- [ ] Impostor (billboard) på långt avstånd, som LOD3.
- [ ] Translucens i löven (görs i klientens shader).
- [ ] Vind i shadern och debugvyer (wireframe, kort, normaler, kluster, LOD), enligt guidens acceptanstest. Görs när klienten finns.
- [ ] Ek och körsbär har liknande runda kronor. Mer variation i klustrens form och placering.
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
- [ ] Blommor och svamp.

### Gräs
Referens: "Stylized Grass Tutorial" (akbutea), med en Genshin Impact-liknande stil. Det mesta av looken sitter i shadern och i att gräset tar färg från marken.

Generator (tillgång):
- [ ] Gräsknippe (`create_grass_patch`): strån från lätt böjda plan, duplicerade, skalade och roterade till ett oregelbundet, fylligt knippe. Recept: antal strån, höjd, bredd, böj, spridning.
- [ ] Pivot vid basen, och **alla normaler pekar rakt upp**, så att knippet inte får svarta skuggor.
- [ ] UV med strånas bas längst ner (v=0 vid marken), plus `_WIND` 0 vid basen och 1 i toppen.
- [ ] Varianter: kort, medel och högt gräs (högt i övergångar och kanter), och några med blommor.

Klient (shader och placering):
- [ ] Gräset tar sin basfärg från markens färg under sig. Motsvarigheten till Unreals Runtime Virtual Texture: sampla terrängens färg- och splatkarta på världens xz. Målar man marken rosa blir gräset rosa där.
- [ ] Gradient från mörk bas till ljus topp, i shadern i stället för per strå.
- [ ] Vind i vertexshadern via `_WIND` (förankrad bas, rörlig topp).
- [ ] "Rullande vind": en panorerande brustextur som tillfälligt gör stråk av gräset ljusare, som vindvågor över fältet.
- [ ] **Inga kastade skuggor från gräs** (för dyrt). Djupet kommer från färgskiftningarna. Gräset tar däremot emot skuggor från träd och byggnader.
- [ ] Instansiering (`InstancedMesh`) och utmålning med spridningsborsten. Densitet och längd styrs av markens material.
- [ ] Målade stråk av ljusare och mörkare mark som gräset plockar upp.
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
