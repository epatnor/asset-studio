# Plan: Asset Studio delas i tre projekt

Beslutat 2026-11-13 (Patrik: "ja dela upp asset studio i tre produkter. men den kan ju få samverka med varandra"). Bakgrund i [lage.md](lage.md). Den här planen är ett förslag. Frågorna längst ner tas en i taget innan något flyttas.

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
4. **Historiken:** följa med (förslaget) eller börja om?
