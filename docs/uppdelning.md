# Plan: Asset Studio delas i tre projekt

Beslutat 2026-11-13 (Patrik: "ja dela upp asset studio i tre produkter. men den kan ju få samverka med varandra"). Bakgrund i [lage.md](lage.md). **Genomförd samma dag**; vad som faktiskt gjordes, och var det skiljer sig från planen, står i [Gjort](#gjort-2026-11-13) längst ner.

## De tre projekten

| Projekt | Mapp (förslag) | Jobb | Mål just nu |
|---|---|---|---|
| **Asset Studio** | `azshara-studio/asset-studio` (som i dag) | Världens tillgångar: generatorerna (träd, props, växter, byggnader), Kartrummet, Ateljén, Väderkvarnen, Häxkitteln, Skattkammaren, exporten till Godot | Testön i Godot |
| **Figurverkstaden** (Character Studio) | `azshara-studio/character-studio` | Figurer: Character Creator (MPFB, reglage, inpassning, bakning, `make_final`), body-gen och Body Editor, beställningskedjan för figurer, texturforskningen (UltraTex 4B, mätverktygen) | En riggad, texturerad figur som kan gå på testön |
| **Darrowmere** | `azshara-studio/darrowmere` | Den delade räknetjänsten: runnern, panelen, ComfyUI-noderna, maskinerna, beställningsklienten | Tar jobb från båda projekten |

## Hur de samverkar

- **Darrowmere är en tjänst och inget bibliotek.** Projekten beställer jobb genom dess klient (`order.py submit`) och läser resultatet. Ingen av dem importerar Darrowmeres kod. Figurbeställningar, Krea-texturer och bilder går alla samma väg, och panelen visar allt.
- **Figurverkstaden levererar till Asset Studios bibliotek.** En färdig figur (`make_final`) hamnar i `asset-studio/assets/characters/` med recept och kontroller, så att Skattkammaren och exporten till Godot hittar den som vilken tillgång som helst. Spelen hämtar allt från ett ställe.
- **Stilen är gemensam.** `asset-studio/tools/style.json` och stilguiden gäller också figurerna. Figurverkstaden läser dem genom en relativ sökväg (`../asset-studio/...`), som Tinkertown redan gör.
- **Fliken The Character Creator** kan antingen stanna i Asset Studios app och anropa Figurverkstadens verktyg, eller flytta ut som en egen app som Body Editor (se fråga 3).
- **Agenterna** pratar med varandra via Postbox, som i dag.

## Vad som flyttar

**Till Figurverkstaden:**
- `tools/character/`
  - `lowpoly/` arkiveras; Patrik bedömde lågpolykvinnan som för fyrkantig.
- `tools/ultratex4b/`
- `tools/tripo/`
- `tools/texture/ultratex_metrics/`
- `studio/human*.js` och `tools/studio/human.mjs`, om fliken flyttar ut
- Figurbeställningens delar: `tools/darrowmere/character_order.py`, `character/` (options och grafer) och `character.html`. Darrowmere kör beställningen, men vad som beställs är Figurverkstadens sak.
- Dokumenten:
  - `character-creator.md`
  - `character-generator.md`
  - `body-generator.md`
  - `ultratex-4b.md`
  - `texture-projection.md`
  - `image-judges.md`
- Arbetsytorna (inte i git):
  - `build/body` (3,3 GB)
  - `build/characters` (1,2 GB)
  - `build/human`
  - `assets/characters` (257 MB; de färdiga figurerna levereras tillbaka)

**Till Darrowmere:**
- Resten av `tools/darrowmere/`:
  - runner, panel och html-sidor
  - `order.py`, `machine.py` och `machines.json`
  - `comfy_nodes/`
  - installationsskripten
- `tools/comfy_target.py` och `tools/comfy.json`, om Asset Studio kan läsa dem därifrån
- Dokumenten:
  - `darrowmere-machines.md`
  - `darrowmere-baseline.md`
  - `operator.md`
  - `agent-team.md`

**Stannar i Asset Studio:**
- Allt annat.
- Asset Studios egna verktyg som använder Darrowmere (`krea_tex.py`, `make_icons.py` och liknande) anropar Darrowmeres klient genom en sökväg i stället för att ha den i sitt eget träd.

## Hur flytten görs

1. **Historiken följer med** filerna (`git filter-repo --path ...` till de nya förråden), så att `git log` fungerar i de nya projekten. Asset Studio tar sedan bort de flyttade sökvägarna i en vanlig commit.
2. **Sökvägar uppdateras:**
   - MCP-servern
   - studioservern
   - `.claude/launch.json`
   - skrivbordsgenvägarna (Body Editor, Darrowmere-panelen)
   - systemd-enheterna
   - deploy-skripten till Darrowmere
3. **Varje projekt får sin egen `CLAUDE.md` och `README.md`.** Asset Studios `CLAUDE.md` krymper, och verktygstabellen delas upp.
4. **Kontroll:**
   - UI-testerna (`smoke.json` och `creator*.json`)
   - en figurbeställning till Darrowmere
   - en Krea-textur
5. **Minnet** delas per projekt.

Flytten görs i en egen session, ett projekt i taget: först Darrowmere, som båda behöver, sedan Figurverkstaden.

## Frågor, en i taget

1. ~~Namn och mappar~~: **`character-studio` och `darrowmere`** (2026-11-13). Mapparna är skapade, med README, CLAUDE.md och ett första commit; koden är inte flyttad än.
2. ~~GitHub~~: **bara lokal git än så länge** (Patrik 2026-11-13).
3. ~~Fliken The Character Creator~~: **egen app**, som Body Editor (Patrik 2026-11-13). `studio/human*.js` och `tools/studio/human.mjs` flyttar till Figurverkstaden, och Asset Studios app tappar fliken.
4. ~~Historiken~~: **följer med** (Patrik 2026-11-13: "gör det som är vettigast"), med `git filter-repo` som i "Hur flytten görs".

## Gjort (2026-11-13)

**Historiken.** `git filter-repo` fanns inte installerat, så flytten gjordes utan installation: `git fast-export main -- <sökvägar>` genom ett litet filter som byter namn på sökvägarna, in i ett tomt förråd med `git fast-import`, och sedan `git merge --allow-unrelated-histories` in i de nya projekten. Darrowmere fick 151 commits, Figurverkstaden 157. Träden kontrollerades blob för blob mot Asset Studios HEAD innan sammanslagningen. I Asset Studio togs sökvägarna bort i en vanlig commit.

**Darrowmere** (`../darrowmere`): allt i `tools/darrowmere/` utom figurbeställningen, platt i roten (`order.py`, `machine.py`, `machines.json`, `monitor.py` med sidorna, `runner/`, `comfy_nodes/`, installations- och deployskripten), och dokumenten `darrowmere-machines.md`, `darrowmere-baseline.md`, `operator.md`, `agent-team.md`. Arbetsytan `build/darrowmere` (logotyper, provbilder) och `build/ravenholdt` blev `darrowmere/build/`.
- `tools/comfy_target.py` och `tools/comfy.json` **stannar i Asset Studio**: de är klientens val av ComfyUI-mål och importeras av Asset Studios verktyg, så att flytta dem vore att importera Darrowmeres kod. Panelen läser `../asset-studio/tools/comfy.json` när den körs från en utcheckning.
- `tools/pipeline.py` stannar också (Asset Studios verktyg visar sina steg i panelen); den läser maskinlistan genom `../darrowmere/machine.py`.
- `deploy.sh` hämtar figurbeställningens sida från `../character-studio/tools/character_order/` och kopierar den till Winterspring bredvid panelen, som förut. `runner/deploy_runner.sh` hämtar efterbehandlingsverktygen från `../asset-studio/tools/`.
- Leveranstimern (`darrowmere-deliver` på laptopen) pekar på `../darrowmere/deliver.py`.
- Rättat på vägen: `order.py status` föll på planer sparade över flera rader.

**Figurverkstaden** (`../character-studio`): `tools/character/` (`lowpoly/` i `archive/lowpoly/`), `tools/ultratex4b/`, `tools/tripo/`, `tools/texture/ultratex_metrics/`, figurbeställningen i `tools/character_order/` (`character_order.py`, `character/`, `character.html`), The Character Creator (`studio/human*.js`, `tools/studio/human.mjs`, UI-testerna `creator*.json`, kortbilden och mallikonerna), de spårade experimenten i `build/characters`, `build/ultratex4b` och `build/judges`, och dokumenten `character-creator.md`, `character-generator.md`, `body-generator.md`, `ultratex-4b.md`, `texture-projection.md`, `image-judges.md`. Avsnittet om The Character Creator i `asset-studio.md` blev `docs/creator-app.md` där.
- Arbetsytorna flyttades med `mv`: `build/body`, `build/human`, `build/characters`, `assets/characters` som planerat, och dessutom figurernas andra arbetsmappar `build/maren`, `build/robot`, `build/character`, `build/body_compare`, `build/tripo`, `build/lowpoly`, `build/klein4b`, `build/studio/human` och Darrowmere-nedladdningarna `build/darrowmere/pixal3d` och `ultratex`.
- **The Character Creator är en egen app:** `node tools/studio/creator_server.mjs` (port 8773). Den läser Asset Studios stilmall (`studio/index.html`) och delade moduler (`gpu.js`, `cards.js`, `viewmodes.js`) live från `../asset-studio/studio/`, så att apparna inte glider isär. Därför står reglerna för `body.human-mode` kvar i Asset Studios `index.html`. Asset Studios app har inte längre fliken eller kortet på startsidan.
- Body Editor körs från den nya mappen: skrivbordsgenvägen är omskriven (`install_launcher.sh`) och systemd-enheten `body-editor-server` startad därifrån.
- `third_party/makehuman/` stannar i Asset Studio (krediterna för de levererade figurerna); figurverktygen läser den genom `../asset-studio/third_party/makehuman`.

**Kontroller:** Asset Studios röktest i Chrome utan fönster gick igenom; MCP-servern startar och listar sina verktyg; Body Editor svarar från den nya mappen; Character Creator-appen klarar `creator_viewmodes.json` (40 steg). `creator.json` går igenom mallar, reglage och sidfot men stannar vid ett klick på `syssling_wrap7`, som numera också matchar `syssling_wrap7_t_e` (en figur gjord efter att testet skrevs, inte ett fel från flytten). Panelen startar från `../darrowmere` och hittar figurbeställningen; `order.py status` når runnern (161 beställningar); en torr figurbeställning (`character_order.py plan`) fungerar. Inget betalt eller långt jobb beställdes. Panelen på Winterspring kör sin utplacerade kopia och har inte deployats om (koden där är oförändrad i sak).

**Kvar:**
- Testet `creator.json` behöver ett exaktare klick på `syssling_wrap7`.
- Minnet för de nya projekten: Claude Code har inget minne per mapp för `character-studio` och `darrowmere` än; Asset Studios minnesfiler pekar dit.

