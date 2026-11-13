# Läget: vad vi har och vad vi ska ha

Skrivet 2026-11-13, när vi tog ett steg tillbaka. Projektet hade vuxit till ungefär 1 600 filer och 18 GB, med många spår samtidigt. Den här sidan säger vad som hör till målet, vad som är färdigt och vad som parkeras eller skrotas. Den uppdateras när ett spår byter läge.

## Målet

**Den första spelbara biten är en liten testö:** gjord i Kartrummet, spelad i Godot, utan historia. Den är provbänken för hela kedjan:

1. Generatorerna ger modellerna.
2. Kartrummet bygger ön.
3. `export_world.mjs` för över den till Godot.
4. Godot visar ön och man går runt på den.

Ett riktigt spel kan sedan växa ur testön eller börja om på samma grund.

Beslut på vägen (2026-11-13):

- **Tinkertown** är vårt eget verktyg (världsredigeraren), inte ett spel. Idén lever vidare i Kartrummet (World till Populate, sedan Explore och Life) och följer med när Asset Studio flyttar till Godot. Koden parkeras som arkiv.
- **Azshara Island** blir inget spel. Det goda tas med (se nedan), sedan skrotas banan.
- **Asset Studio delas i tre projekt som samverkar:** Asset Studio (världens tillgångar och testön), Figurverkstaden (figurerna; Patrik: "vi har varit så nära en bra lösning", body-gen är bra) och Darrowmere (den delade räknetjänsten). Plan och frågor i [uppdelning.md](uppdelning.md). Figurspåren är alltså inte parkerade: de fortsätter i Figurverkstaden. Kedjan beställning → fit_human → bakning → make_final är det spåret ska göra klart. Lågpolykvinnan skrotas.

## Märkning

- **Mål**: behövs för testön nu.
- **Färdig**: fungerar och lämnas i fred tills testön behöver något.
- **Parkerad**: står kvar orörd. Tas inte upp utan ett beslut.
- **Skrotas**: tas bort när det goda är hämtat.

Märkningen nedan är ett förslag och har ännu inte gåtts igenom med Patrik.

## Delarna

| Del | Var | Märkning (förslag) | Kommentar |
|---|---|---|---|
| Godot-labbet | `../godot-lab` | Mål | Är redan nästan testön: demo_isle och flag_isle, gående spelare, vind, budgetar. Saknar kollision på träd och något att göra |
| Kartrummet, World–Populate | `studio/terrain.js`, `shared/terrain/` | Färdig | Bygger ön |
| Kartrummet, Explore och Life | – | Mål, senare | Tinkertowns markläge och liv |
| Export till Godot | `tools/terrain/export_world.mjs` | Mål | Kedjans länk |
| Smedjan: träd, buskar, stenar, props, växter | `tools/tree`, `props`, `plants` | Färdig | |
| Byggnader | `tools/building` | Färdig, med kända fel | |
| Ateljén (texturer, Krea-2) | `tools/texture` | Färdig | |
| Väderkvarnen: vind, vatten, väder | `tools/wind`, `water`, `weather` | Färdig | Godot har egen vind och eget hav |
| Häxkitteln (effekter) | `tools/vfx` | Färdig | |
| Skattkammaren | `studio/library.js` | Färdig | |
| Asset Studio till Godot | – | Parkerad | Planerad från 2026-11-02, inte påbörjad. Testön först |
| Figurer: Character Creator (MPFB) | `tools/character/human`, `studio/human*.js` | Figurverkstaden | Kedjan till en riggad figur görs klar |
| Figurer: body-gen | `tools/character/body` | Figurverkstaden | Patrik: "body-gen är bra" |
| Figurer: beställningar (Pixal3D, Tripo, Meshy) | `tools/darrowmere/character*` | Figurverkstaden | Första länken i kedjan |
| Figurer: UltraTex-texturforskning | `tools/darrowmere/comfy_nodes`, `docs/ultratex-4b.md` | Figurverkstaden | Nästa steg vore ett mått på likhet med referensbilden |
| Figurer: lågpolykvinnan | `tools/character/lowpoly` | Skrotas | Patrik: "som lego" |
| Darrowmere (runner, panel) | `tools/darrowmere` | Eget projekt, delat | Maskinfrågan är avgjord: Darrowmere |
| Lånade maskiner (HP Z4, Ravenholdt) | – | Skrotas | Tillbaka till jobbet |
| Showcase-banorna (Azshara, Skogen, Parken, Byggnader, Vatten) | `showcase/` | Skrotas | Three.js från tiden före Godot |
| Tinkertown | `../tinkertown` | Parkerad som arkiv | |

## Att ta med från Azshara Island

- **Stämningen:** himmel, dygnsrytm och väder (`showcase/atmosphere.js`).
- **Ljuseffekterna:** ljusstrålar, markdimma, molnskuggor, svävande partiklar och regnstänk (`showcase/effects.js`).
- **Vattenfallet**, och anteckningarna om strand och vatten (`docs/azshara/shore_and_water_notes.md`).
- **Designprinciperna och zonidéerna** (`docs/azshara/`): frodig öst, höstig väst och en mörk ö bortom kanalen.

Koden blir förlagor när motsvarande byggs i Godot. Dokumenten flyttar som de är.
