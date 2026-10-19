# Designprinciper för realtidsrendering i spel

Sammanställning av principer för ljus, moln, regn, vind och atmosfär. Underlaget kommer från forskningsarbeten och tekniska dokument, men sammanfattningen är skriven för praktisk användning i Azshara Studio (Godot). Punkter markerade med **(eget förslag)** är egna slutsatser snarare än något källorna uttryckligen säger.

---

## 1. Ljustekniker

| Teknik | Vad den gör | Vanliga namn/varianter |
|---|---|---|
| **Skuggor** | Skuggor från ljuskällor, oftast för solen och lampor | Shadow maps, Cascaded Shadow Maps (CSM) för solen, cube shadow maps för punktljus, PCF/PCSS för mjuka kanter |
| **Ambient occlusion (AO)** | Mörknar vrår, hörn och kontaktpunkter där ljuset inte når fram | SSAO, HBAO, GTAO (modern standard), förberäknad "baked AO" |
| **Global illumination (GI)** | Ljus som studsar mellan ytor och färgar omgivningen, inklusive bounce light | Baked lightmaps, light probes, screen-space GI, realtids-GI som SDFGI, DDGI, VXGI eller Lumen i Unreal 5 |
| **Reflektioner** | Speglingar i blanka och blöta ytor | Cubemaps, Screen-Space Reflections (SSR), raytraced reflections |
| **Subsurface scattering (SSS)** | Ljus som tränger in i material och sprids, t.ex. hud, vax, bladverk, marmor | Screen-space SSS, separable SSS, pre-integrated skin shading |
| **Volumetriskt ljus / fog** | Ljusstrålar och dimma som fångar ljus | Volumetric fog, volumetric lighting, light shafts, froxel-baserade system |
| **Raytracing** | Skuggor, reflektioner och GI genom att följa strålar i scenen | RT shadows, RT reflections, RT GI, path tracing |

**Anmärkningar**
- Raytracing är inget eget visuellt effektområde utan ett sätt att räkna ut skuggor, reflektioner och GI. Det är dyrt, och hybridlösningar är vanliga.
- Bounce light är en del av GI. Det är ofta GI som avgör skillnaden mellan en platt och en trovärdig scen.
- **(eget förslag)** Godot 4 har inbyggda varianter av SSAO, SSIL, SDFGI, VoxelGI, LightmapGI, SSR och volumetrisk fog. Vilka som finns i aktuell version bör kontrolleras i dokumentationen.

---

## 2. Volymetriska moln

**Varför volymetriska moln**
- Skybox-moln fungerar när kameran alltid är långt från molnen. I öppna världar och flygspel ger de ett statiskt intryck och kan visa artefakter.
- Volymetriska moln är dynamiska och realistiska, och de kan styras av speldesign.
- Redan 2002 gällde samma logik för flygsimulatorer, där kameran ska kunna flyga genom och runt molnen.

**Prestanda**
- Raymarching är dyrt, så systemen bygger på approximationer som ger skalbar prestanda över många plattformar.
- Tomt eller glest utrymme kan hoppas över, vilket ger bättre övergripande prestanda.
- Förberäknade 3D-texturer kombinerade med realtidsshaders sparar beräkningar.

**Form**
- Formen byggs ofta upp av kombinerat brus. Frostbite-lösningen använder Perlin- och Worley-brus i raymarching för grundform och detaljer.
- Procedurellt brus gör att molntyper kan varieras utan att skapas för hand.

**Ljussättning**
- Moln är ljusspridande medium och kräver mer än en enkel skugga.
- Ett bra system stödjer flerfaldig ljusspridning, skuggor från och på molnen, och ljus från marken som träffar molnens undersida.
- Molnen bör också påverka omgivningen, till exempel reflektioner. I Unreal används en Sky Light för detta.

**Statiskt kontra dynamiskt**
- Dynamiska moln som förändras över tid och svarar på ljus är dyrare än moln med konstant form.
- Ett hybridupplägg är vanligt: volymetriska moln nära betraktaren och billigare moln högre upp.

**Styrbarhet**
- Parametrarna bör kunna justeras i realtid, så att utseendet kan finjusteras utan ombyggnad.

---

## 3. Regn

**Regn är flera effekter**
- Enkla spel har ofta bara utsträckta, transparenta partiklar. Då reagerar inte regnet på omgivningen och ser overkligt ut.
- Ett realistiskt regn består av flera samverkande delar: fallande droppar, stänk, droppar som rinner, blöta ytor, pölar och ringar i vattnet.

**Hybridmetod**
- Regn i luften kan göras med ett bildbaserat efterbehandlingssteg. Närliggande droppar och stänk sköts av partiklar.
- Det ger både täckning över stora ytor och detaljer nära kameran.

**Påverkan på ytor**
- Pölar och vattenytor får rörelse där droppar träffar.
- Speglingar bör förvrängas av vattnet.
- Droppar som rinner nedför glasrutor kräver en egen behandling.

**Ljus och miljö**
- Regnet ska reagera på ljusförändringar i miljön, till exempel blixtar och solens ljus.
- Regndroppar bör behandlas som en del av scenens ljus, inte bara som en textur.

**Prestanda**
- Regn kräver många partiklar. Nivåer av detalj, där antalet partiklar anpassas efter avstånd och förhållanden, hjälper att hålla prestandan stabil.

**Styrbarhet för artister**
- Intensitet, droppstorlek, vindriktning och ytans blötighet bör kunna justeras i realtid.

**Verklighetsbaserat underlag**
- Vissa metoder analyserar riktiga regnvideor, extraherar droppar och använder dem som underlag för partiklarna. Det ger trovärdigt utseende till låg kostnad.

**(eget förslag) Praktiskt**
- Börja med färre partiklar än du tror behövs.
- Variera storlek och form på dropparna.
- Låt regnet också påverka spelet, till exempel genom sikt och spänning.

---

## 4. Vind

**Vind som fält**
- Vind bör beskrivas som ett fält som varierar i rum och tid, inte som en konstant riktning.
- Ett vanligt sätt är att modellera vinden som en stationär slumpprocess, där byar och lugn ger naturlig variation.
- Parametrar som hastighet, riktning och byighet kan hämtas från meteorologiska data eller tidigare simuleringar.

**Rörelse i lager**
- Träd består av tusentals sammanlänkade grenar och löv som reagerar olika.
- Löv kan animeras stokastiskt utifrån fysiska egenskaper. Stammen rör sig långsammare och mjukare än grenarna.
- Grenarna behöver vara flexibla. Stela grenar ger onaturlig animation.

**Förenkla för prestanda**
- Full luftflödessimulering runt varje träd är för dyr för realtid.
- Vegetation kan representeras som tvådimensionella billboard-lager som rör sig tillsammans, vilket ger naturlig rörelse till lägre kostnad.
- En förenklad karta över vindmotstånd kan ersätta detaljerade luftflödesberäkningar.
- Nivåer av detalj kan användas för trädmodellen, grenarnas rörelse och vindfältet, beroende på visuell betydelse.

**Styrbarhet för artister**
- Varje växttyp bör reagera rimligt på vinden.
- Animationens utseende bör kunna justeras i realtid.
- Simuleringen är iterativ och bör testas över olika vindstyrkor och miljöer.

**Små effekter**
- Fallande löv kan göras med ett litet antal partiklar som följer olika banor. Det kräver lite minne och är ofta bättre än att simulera varje löv.

**(eget förslag) Gemensamt vindfält**
- Samma vindfält bör påverka gräs, löv, partiklar, flaggor och rök. Annars ser världen inte sammanhängande ut.

**(eget förslag) Praktiskt i Godot**
- Låt en shader förskjuta vertexpositionerna med en global vinduniform och en scrollande brustextur.
- Använd vertexfärger för att styra rörelsen, med noll vid rötterna och mer vid topparna.
- Gör fallande löv med GPU-partiklar som använder samma vindriktning som växterna.

---

## 5. Atmosfär och solnedgång

**Två typer av spridning**
- **Rayleigh-spridning** sker på små luftmolekyler. Den ger en blå himmel och är nästan riktningsoberoende. Den tonas ner när solen står högt, och den orsakar den orange-röda solnedgången.
- **Mie-spridning** sker på större partiklar som damm, dis och fukt. Den är starkt riktad framåt och ger en ljus gloria runt solen samt dis vid horisonten.

**Solens vinkel styr färgen**
- När solen står lågt passerar ljuset en mycket längre väg genom atmosfären.
- Blått ljus sprids bort, och kvar blir det rödare ljuset.
- Därför behöver solnedgången inte fejkas. Den följer av att vägen genom atmosfären räknas ut för varje riktning.

**Förberäkning**
- Full fysisk beräkning per pixel är för långsam i realtid.
- Det vanliga sättet är att förberäkna tabeller över spridning för olika vinklar och solhöjder, och sedan slå upp värden i realtid.
- Tabellerna kan uppdateras när solen rör sig, vilket ger dygnsövergångar med liten påverkan på prestandan.

**Solen som parallell ljuskälla**
- Solen är så långt bort att ljusstrålarna kan behandlas som parallella. Det förenklar beräkningarna.

**Vanlig fallgrop**
- Att bara lägga på en blå gradient ger ingen riktig solnedgång. Himlen förblir blå när solen är låg, om rätt parametrar och enheter saknas.

**Referens**
- Hillaires "A scalable and production ready sky and atmosphere rendering technique" är en modern referens för realtidsatmosfär.

**(eget förslag) Praktiskt i Godot**
- Låt solens riktning styra både himmelns shader och riktningsljuset.
- Använd samma horisontfärg för dimma och himmel.
- Färga skuggor och omgivningsljus efter solhöjden, så de blir varmare vid solnedgång.
- Kontrollera i Godots dokumentation vilka himmelsverktyg som finns i aktuell version.

---

## Källor

- Tatarchuk, N. & Isidoro, J. (2006). *Artist-Directable Real-Time Rain Rendering in City Environments*. SIGGRAPH 2006.
- Harris, M. (2002). *Real-Time Cloud Rendering for Games*. GDC 2002.
- Chalmers tekniska högskola. *Convincing Cloud Rendering – An Implementation of Real-Time Dynamic Volumetric Clouds in Frostbite*. Masteruppsats.
- Chalmers tekniska högskola. *Efficient and Dynamic Atmospheric Scattering*. Masteruppsats.
- Epic Games. Dokumentation för *Volumetric Cloud Component in Unreal Engine*.
- Chen, K. & Johan, H. (2015). *Animating 3D vegetation in real-time using a 2D approach*. SIGGRAPH Asia 2015.
- Vázquez, P.-P. & Balsa, M. (2007). *Real Time Falling Leaves*.
- Kusternig, A. (2008). *Real-time Rendering of Dynamic Vegetation*. CESCG 2008.
- Gerndt, T. et al. *Physically Based Real-Time Rendering of Atmospheres using Mie Theory*. Eurographics 2024.
- Hillaire, S. *A scalable and production ready sky and atmosphere rendering technique*.
- Bruneton, E. & Neyret, F. *Precomputed atmospheric scattering*.
