# Roadmap

Azshara Asset Studio består av **specialiserade generatorer**, en per typ av spelobjekt, som alla följer samma [stilguide](style-guide.md) och samma kontrakt. Allt de skapar hamnar i ett gemensamt **bibliotek**, där spelskaparen snabbt väljer och placerar objekt och där AI:n snabbt kan generera nya varianter.

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

**Kortbollar** (`cardball.mjs`, arterna `cardtree`, `cardbirch` och `cardbush`; teknik från stiliserade Blender-träd, kort i `knowledge/cards/trees/`):
- [x] Bollar av lövkort i klasar på skelettets kvistar, med båda kortsidorna som egen geometri och sfäriska normaler. Treor (x, y, z), hängande kort och draperier (fem böjda remsor från en rundad topp, björken) som korttyper.
- [x] Fast kortstorlek i meter (höjd och bredd), täthet per m² bollyta, spridning i bollen, spetsbollar på grenspetsar och täckningssteg, så att inga kala kvistar sticker ut.
- [x] Lövark från `make_leafsheet.py`: åtta bladformer, solfjäder, kvistar, hängande kvistar och tät kärna; vita, målade eller i paletten.
- [x] Korten kastar och tar inte emot skugga (skärningarna syns annars); en osynlig skuggform av bollarna kastar kronans skugga. Rollerna står i materialens extras.
- [x] Lövshadern: dämpad glans, genomlysning som väger in normal och tunn ytterkant, kort som tonas bort när de ses från kanten.
- [x] Stamlösa buskar på marken med ett mjukt golv per boll, och lyft från marken.
- [x] Barkens texturblandning: påväxt vid foten och grön textur i grentopparna (`bark_blend`, blandas i klientens shader). Barktexturer i 2048 px (`bark_birch_hd3` m.fl.).
- [ ] Impostor (LOD3) för kortbollsträd på långt avstånd.
- [ ] Kronans rundning för draperier som en spak (lyft och häng i ett), och en spak som skalar bollar och kort tillsammans.
- [ ] Palmer och ormbunkar med draperidelen.
- [ ] Mät kortbollar mot crown och bladkupoler i Skogen (alfakortens kostnad i tät skog).

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
- [ ] Katalog över alla tillgångar: typ, kategori, taggar, miniatyrbild, receptfamilj och varianter. Påbörjat: Asset Studio sparar recept, modell, miniatyr och taggar till `assets/library.json`.
- [ ] Sökning och filtrering (typ, biom, storlek, taggar).
- [ ] Favoriter och "senast använda".
- [ ] Dra och släpp från biblioteket ut i världen.
- [ ] Knappen "Fler varianter" genererar nya seeds i bakgrunden.

### Import av färdiga modeller (`tools/import/`, MCP `import_model`)
Andras modeller (Sketchfab, Kenney, egna) ska fungera som våra egna. Idé från NoirStage ("import and normalize any 3D asset").
- [x] Import av GLB/glTF, och FBX, OBJ, DAE och blend via Blender headless.
- [x] Normalisering: meter (gissar centimeter och millimeter), valfri höjd, centrerad med pivot vid markkontakten, dubbletter sammanslagna, oanvänt bortrensat.
- [x] Komprimering som våra egna: texturer till WebP med maxstorlek, geometri med meshopt. Kontroller och en rad i katalogen.
- [ ] LOD-nivåer med förenkling (meshoptimizer simplify) för det som placeras i stort antal.
- [ ] Stilanpassning: tona texturer och färger mot paletten i `style.json`, så att importerat inte sticker ut.
- [ ] Kollisionsform och fotavtryck i metadata.
- [ ] Miniatyrbild till biblioteket.

### Placering
- [ ] Placera där spelaren tittar. Fäster mot terrängen, med valfri anpassning till markens normal.
- [ ] Slumpvis rotation och skala inom intervall per objekttyp.
- [ ] Spridningsborste: måla ut skog, buskar eller stenar med densitet och regler (lutning, höjd, avstånd till vatten).
- [ ] Undvik överlapp via fotavtryck.
- [ ] Flytta, rotera och skala med gizmo. Duplicera. Gruppera.

## Fas 2: Naturen

### Naturliga objekt (propsgeneratorn, `tools/props/`)
- [x] Fristående propsgenerator med samma mönster som trädgeneratorn: recept in, GLB (3 LOD) ut till `assets/props/`, arter som data i `props.json`, MCP-verktyget `create_prop`.
- [x] Stenar, stengrupper och bumlingar: mjuk union av ellipsoider med lågfrekvent brus, mjuka fasetter, platt botten nedsänkt i marken (`stone`, `stones`, `boulder`).
- [x] Mossa på uppåtvända ytor som eget material (`mossy_stone`, `mossy_boulder`).
- [x] Svampar i klungor: svarvade hattar, skivor och fötter (`fly_agaric`, `porcini`, `chanterelle`).
- [x] Stubbar med rötter och årsringar på snittytan, även mossiga (`stump`, `mossy_stump`).
- [x] Lövhögar av höstlöv (`leafpile`, `autumn_atlas`).
- [x] Krypväxter: rankor längs marken med solida blad (`creeper`, `ivy`).
- [ ] Stockar och nedfallna grenar, blommor och gräs (gräs är en egen generator), svampar på stubbar.
- [x] Mossan: mjuk, brusig övergång mot stenen, med triplanar sten och mossa i världskoordinater i klientens shader (`showcase/materials.js`).
- [ ] Biomer: regeluppsättningar som väljer vilka props som sprids var.

### Gräs
Referens: "Stylized Grass Tutorial" (akbutea), med en Genshin Impact-liknande stil. Det mesta av looken sitter i shadern och i att gräset tar färg från marken.

Generator (tillgång):
- [x] Gräsknippe (`create_grass_patch`): strån från lätt böjda plan, duplicerade, skalade och roterade till ett oregelbundet, fylligt knippe. Recept: antal strån, höjd, bredd, böj, spridning.
- [x] Växtgeneratorn (`create_plant`, `tools/plants/`): samma kurvbyggsten för gräsknippen, vass, kaveldun, säd (vete, korn) och blommor (prästkrage, vallmo, smörblomma, tulpan, blåklint, lavendel, lupin). Stjälkar är platta band som klienten vrider mot kameran; 3 LOD; kontroller för rötter, fästen, normaler, vind och budget.
- [x] Gräsfältet (`showcase/grass.js`): hundratusentals instansierade strån i tuvor per ruta, täthet och höjd från marken, brusfläckar, skugga under kronor och hinder, rotfärg från marktexturen, vindbyar som böjer och ljusar, glesare på avstånd.
- [ ] Gräsfältet: PCG-graf som data (punkter → täthet → filter → attribut → utplacering) i stället för parkens egna funktioner, och omräkning per ruta när marken ändras.
- [x] Pivot vid basen, och **alla normaler pekar rakt upp**, så att knippet inte får svarta skuggor.
- [x] UV med strånas bas längst ner (v=0 vid marken), plus `_WIND` 0 vid basen och 1 i toppen.
- [x] Varianter: kort, medel och högt gräs (högt i övergångar och kanter), och några med blommor.

Klient (shader och placering):
- [x] Gräset tar sin basfärg från markens färg under sig. Motsvarigheten till Unreals Runtime Virtual Texture: sampla terrängens färg- och splatkarta på världens xz. Målar man marken rosa blir gräset rosa där.
- [x] Gradient från mörk bas till ljus topp, i shadern i stället för per strå.
- [x] Vind i vertexshadern via `_WIND` (förankrad bas, rörlig topp).
- [x] "Rullande vind": en panorerande brustextur som tillfälligt gör stråk av gräset ljusare, som vindvågor över fältet.
- [x] **Inga kastade skuggor från gräs** (för dyrt). Djupet kommer från färgskiftningarna. Gräset tar däremot emot skuggor från träd och byggnader.
- [ ] Instansiering (`InstancedMesh`) och utmålning med spridningsborsten. Densitet och längd styrs av markens material.
- [ ] Målade stråk av ljusare och mörkare mark som gräset plockar upp.
- [ ] Stockar, stubbar, rötter.
- [ ] Biomer: regeluppsättningar som väljer vilka naturobjekt som sprids var.

### Ytor (texturgeneratorn, `tools/texture/make_surface.py`)
- [x] Sömlösa, stiliserade yttexturer med Krea-2: generera, förskjut ett halvt varv, måla om sömkorset (inpainting med `SetLatentNoiseMask`), lägg bara tillbaka korset, harmonisera kanterna och jämna ut stora ljusskillnader (FFT-oskärpa med wrap). Normalkarta ur ljusheten. `seam_score` i svaret.
- [x] Ytor som data i `surfaces.json`: plankor, jord, gräs, äng, stig, väg, klippvägg, sten, grus, flodbädd, lera, sand, skogsmark och snö. MCP-verktyget `generate_surface`.
- [x] Parken (`showcase/park.html`): kuperad terräng, slingrande stigar, blandad mark (gräs, äng, skogsmark, stig) i en shader med motmedel mot synlig upprepning, och växter och props placerade efter regler.
- [ ] Normalkartorna används ännu inte i parkens markshader.
- [ ] Väg och grus visar fortfarande svagt korset från sömlagningen vid upprepning; prova bredare mask eller två omgångar.
- [x] Gräs, blommor, vass och säd utspridda i parken (småstenar återstår).
- [ ] Höjd- och roughness-kartor; blandning efter höjd (stenar sticker upp ur gräset) i stället för linjär blandning.
- [ ] Ytorna flyttar in i texturverkstaden (profilen `terrain`) med höjdkartor, upprepningsskydd och lagerregler; se [texture-workshop.md](texture-workshop.md).

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
- [ ] Automatisk rigg av importerade eller genererade humanoider (befintligt skelett), och fria animationer ovanpå (idé från NoirStage).
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

## Genomgående: Asset Studio

Verkstaden där Patrik själv drar i generatorernas spakar, ser resultatet direkt och sparar det han är nöjd med till biblioteket. Plan och detaljer: [asset-studio.md](asset-studio.md). Starta med `node tools/studio/server.mjs` och öppna http://localhost:8770/studio/.

**Klart (fas 1 och mer):**
- [x] Studioserver (`tools/studio/server.mjs`) med API: generatorer och spakar, förhandsvisning, texturer med miniatyrer, biblioteket. Klienten kör aldrig verktygen själv.
- [x] Spakarna som data per generator (`tools/<område>/params.json`): delar (`parts`), grupper, villkor (`when`), flikar (`kinds`), av/på-reglage. En ny generator får en studio genom sin `params.json`.
- [x] Träd och buskar: ombyggnad på under en sekund när en spak släpps, kort per del (Krona och Stam) med texturernas förhandsbilder och en miniatyrväljare.
- [x] Header med flikar per tillgångstyp och verktyg: Fäst (jämför bredvid), Ångra, Gör om, Rama in, Spara till biblioteket (recept, modell, miniatyr, taggar).
- [x] Footer med tillgångens siffror (trianglar, alfa, kort, silhuett, grenar i kronan) och renderingens kostnad mätt per bild, jämfört med förra mätningen och vad som ändrades.
- [x] Spaken Stamhöjd (m) (`bole`): den kala stammen till den lägsta grenen sträcks eller kortas och kronan flyttas oförändrad (`setBoleHeight` i `skeleton.mjs`); Höjd styr då trädets storlek, och footern visar den verkliga höjden. Byggd 2026-10-26.
- [x] Kortet Rendering och skuggor: skugga på marken (skuggform, lövkort, av), skuggor inom trädet (fejkade, mjuka, fulla), skuggkvalitet och mjukhet, GTAO med alfaklippt djup, sol och exponering.

**Nästa:**
- [ ] **Fas 2, texturer:** Nytt lövark med arkets spakar och direktvisning (`make_leafsheet.py`), Ny bark eller annan textur via Krea med förlopp och kö (ett jobb i taget på grafikkortet), kontrastspak (`soften`).
- [ ] **Fas 3, bibliotek:** biblioteksvy med miniatyrer, sök och taggar; ladda tillbaka ett recept i studion; Fler varianter (nya frön); ta bort.
- [ ] **Fas 4, fler generatorer:** Sten och Prop via propsgeneratorn, Byggnadsdel via byggnadsgeneratorn, var och en med sin `params.json`; servern kör rätt skript per flik.
- [ ] **Fas 5, hopkoppling:** biblioteket i Tinkertown, och Electron tillsammans med världsbyggaren.
- [ ] Spara en ny art (`species.json`) från studion, som andra recept utgår från.
- [ ] Jämförelse: fästa tillgångar med etikett, A/B-växling på samma plats.
- [ ] Prestanda i en skog: en instansierad uppställning med många exemplar, så att skuggval och alfakort visar sin verkliga kostnad; GPU-tid via timer queries där de finns.
- [ ] Debugvyer: bara korten, normaler, bollarna, LOD-växling på avstånd.
- [ ] Fotoläge: spårad stillbild (path tracing) för miniatyrer och jämförelser. Raytracing i realtid finns inte i WebGL.
- [ ] MCP: AI:n läser biblioteket och de sparade recepten, och en knapp "Be Claude" i studion.
- [x] Professionellt utseende: designtokens, ljust och mörkt tema (följer systemet eller väljs i headern). Byggt 2026-10-26.

**Öppna verktyg:** vad vi kan låna eller härma i stället för att bygga själva (RedGPU, impostors, EZ-Tree, Material Maker, KTX2) står i [oppna-verktyg.md](oppna-verktyg.md).

**Biblioteket: familjer och fasta modeller** (plan 2026-10-26, [asset-studio.md](asset-studio.md)): en *familj* är ett recept som ger obegränsat med varianter och sprids ut som proxys (familj och frö); en *fast modell* är en bestämd modell med egna texturer. Frys och Tina växlar mellan dem.
- [x] **B1, biblioteksvy:** fliken Bibliotek (`studio/library.js`): sidopanel med Biblioteket och Ej tillagda (modeller under `assets/` som inte ligger i katalogen), Familj och Fast, kategorier med antal och taggar; rutnät med sök och sortering; detaljpanel med Öppna i studion, Frys (kopia under `assets/fixed/`), Tina i studion, kategori, taggar och fakta; miniatyrer renderas i studion och sparas bredvid modellen. Byggd 2026-10-26. Kvar: Öppna i studion för andra generatorer än träd och buskar (fas 4), och mossan syns inte i miniatyrerna (den läggs på av spelets shader).
- [x] **B2, familjer:** variantpool med 4–16 färdigbyggda varianter (samma recept, nya frön, under `<familj>/variants/`), byggd som ett jobb med förlopp och miniatyrer; utplaceringsdata (`scatter`: storlek, lutning med marken, största lutning, vridning, radie, avstånd, vikt, biomer) med standard per kategori och radie ur modellens mått. Generatorerna för props, växter och byggnader tar `out_root` som trädgeneratorn. Byggd 2026-10-26. Formatet står i [asset-studio.md](asset-studio.md).
- [ ] **B3, proxys och PCG i Tinkertown:** byggt 2026-10-26: Tinkertowns lager Spridning (`client/src/world/scatter.js`) läser `assets/library.json` och sprider ut familjerna efter biomernas regler (punkter → dungar → filter för höjd och lutning → familj efter vikt → avstånd → variant, skala, vridning), instansierat med LOD; katalograderna skrivs självbärande (kategori, mått, hel utplacering). En första skogsuppsättning ligger i biblioteket (9 familjer med biomen skog och 5 varianter var). Kvar: prestanda (111 fps mot 211 utan spridning, processorbundet av cirka 230 ritanrop; BatchedMesh och impostors), handplacerade proxys (familj och frö i lagret Handplacerat) och målade biomer.
- [ ] **B4, texturera modellen:** lagerpanel i verkstaden (Marmoset-lik); krökning, AO, position och tjocklek bakade i Blender; lagren bakas till modellens UV-texturer, och modellen blir fast.
- [ ] **B5, sammansättningar och maskpensel:** egna props som recept av recept (sten med svampar, lägereld); måla var ett lager syns.

**Texturverkstaden** ([texture-workshop.md](texture-workshop.md)): fliken Texturer i studion, men projektets gemensamma texturkälla. Den försörjer tillgångarna i studion, terrängen och marken i Tinkertown, gräset, byggnaderna och stenarna via en texturkatalog med målprofiler (bark, löv, terräng, makro, gräs, sten, byggnad, blandlager, dekaler). En textur är ett recept: en källa (procedurell algoritm, lokal Krea-2, extern generator via OpenRouter eller import) och en stapel steg med spakar. Byggordning: T1, T1b och T3a klara; T3c, T2, T3b, T4 och T5 till största delen byggda (se varje punkt för det som är kvar).
- [x] **T1, grund:** `workshop.py` med recept; procedurella källor (brus, bark, sten, tegel, plankor) och import; stegen sömlöst, nivåer, nyans och mättnad, palett, gråskala, mjukare kontrast och skala; 2D-vy med zoom och 3×3-tiling; spara till katalogen. Byggd 2026-10-25: fliken Texturer i studion, källorna bark, sten, tegel, plankor, brus och befintlig textur, nio steg, kontroller (söm, palett, medelfärg, valörer) och `assets/textures/catalog.json`.
- [x] **T1b, ingredienser:** under-texturer (sparade eller inbäddade recept) som källan och stegen pekar på; höjden genom stapeln; steget `layer` med masker; utspridning av stämplar; kortet Ingredienser med brödsmulor. Byggd 2026-10-25, med cache per ingrediens i `build/studio/texcache/`. Kvar: katalogen håller reda på vilka texturer som använder en sparad ingrediens, så att de kan byggas om.
- [x] **T3a, materiallabbet och 3D:** kartor ur höjden (normal, ruffighet, metall, AO, höjd, emission; bump som alternativ); 3D-vy (`studio/lab3d.js`) med block, sfär, cylinder, terrängbit, drakstaty och det aktuella trädet, vridbord, fyra ljusförval, avstånd 5, 20 och 60 m; texturinställningar (upprepning i meter, förskjutning, vridning, filtrering med eller utan mipmappar, anisotrop filtrering, wrap, färgrymd för färg- och datakartor, ORM-packning när man sparar). Profilen väljer modell. Byggd 2026-10-25.
- [ ] **T3c, avancerade egenskaper:** byggt 2026-10-25 i labbet: emission, alfa (urklipp och blend), transmission och brytning, stiliserad SSS, specular, clearcoat, sheen, anisotropi, iridescens, parallax occlusion mapping, förskjutning på täta modeller och detaljkarta. Kvar: export som glTF-material (i dag sparas egenskaperna i receptet, `material`).
- [ ] **T2, generativt:** byggt 2026-10-25: källan Krea med text till bild och bild till bild från en ingrediens (algoritmen ger formen, Krea målar), varianter (fyra frön), jobbkö med förlopp och cache. Kvar: extern generator med pris och bekräftelse.
- [ ] **T3b, terräng:** byggt 2026-10-25: terrängbit på 60 m i labbet, lager efter lutning (riktning), höjd och brus, fördjupningar först (höjdkartan), upprepningsskydd och makrovariation, avståndsvyn. Kvar: lagerregler som kan sparas som biomregler, fukt, kontroll av texeltäthet och färgnivå mellan lager, och att Tinkertown läser katalogen.
- [ ] **T4, blandning med riktningar:** byggt 2026-10-25 i labbets shader: upp till fyra lager med masker för riktning, höjd i modellen, höjdkarta, brus och krökning (kanter eller skrymslen), med egen ruffighet, utjämnad relief och egen relief; sparas i receptet (`blend.layers`). Kvar: vertexvikt, samma lagerstack i klientens shader (`showcase/materials.js`) och att den ersätter barkens `bark_blend` och stenarnas mossa.
- [ ] **T5, resten:** byggt 2026-10-25: alfaverktyg (urklipp, bleed, mjukare kant, halokontroll), frekvensseparation, målad look (Kuwahara), färre valörer, färgramp, kanter och skrymslen, förvrängning, varianter och versioner (`assets/textures/versions/`), kontroll av små former, MCP-verktyget `texture_recipe`, ångra och gör om. Kvar: lövark och atlas i verkstaden.
- [x] **G1, AI-flödet med en knapp:** kortet AI-målning med *Måla med AI*: det som syns blir formen och Krea målar den, med spaken *Fri tolkning*, hela prompten synlig, relief från formen, sömutjämning som inte flyttar formerna och *Tillbaka till formen*. Byggd 2026-10-26.
- [ ] **G2, bildbandet:** alla genererade bilder i en remsa med status (i kö, målar steg x/8, klar), stjärna för att behålla, kö som inte stoppar arbetet, avbryt.
- [ ] **G3, snabba utkast:** utkast i låg upplösning eller med SDXL, sedan *Gör klar* i full kvalitet. Mät tiderna först.
- [ ] **G4, prompter efter profil:** vy och formulering per profil (`surface_view`, `facade_view`), ordknappar, sömmen lagas som i `make_surface.py`.
- [ ] **G5, referenser:** referensbild från Apparition som stilstöd; OpenRouter med pris och bekräftelse.

## Genomgående: GUI

Editorn ligger som ett lager ovanpå spelet. Man växlar mellan att spela och att bygga med en tangent, utan att lämna världen.

- [ ] **Lägesbyte** (till exempel Tab) mellan spel och editor. Kameran stannar där den är.
- [ ] **Snabbfält** med de senast valda objekten, som i ett byggspel. Siffertangenter väljer, klick placerar.
- [ ] **Bibliotekspanel:** rutnät med miniatyrbilder, sök, filter, kategorier.
- [ ] **Inspektör:** receptets parametrar som reglage. När man drar i ett reglage genereras objektet om live. Prototypen finns i Asset Studio (spakar från `params.json`); samma panel kan bli editorns inspektör.
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
