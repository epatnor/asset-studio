# Agentteamet: Azshara Studio som ett lag av agenter

Plan, 2026-11-09. I dag går allt genom en Claude-session i taget: träning i molnet, panelen, props, licenser och felsökning
i samma kontext. Det blir dyrt och skört. Den 2026-11-08 hängde Darrowmere två gånger för att två jobb laddade modeller
samtidigt (det ena gick förbi runnerns kö), och H100-vakten dog med den. Den här planen delar upp arbetet i roller med
egna ansvarsområden, egna regler och en gemensam lägesbild som Patrik ser från mobilen.

Planen bygger vidare på det som redan finns. Den ersätter det inte.

## Det som redan finns

| Del | Var | Vad den redan gör |
|---|---|---|
| **Runnern** | Darrowmere, `tools/darrowmere/runner/` | Kör beställningar (comfy, script, blender, meshy3d, remesh, review) även när laptopen är stängd. Ett tungt jobb åt gången (`serial_lanes`). Budget och godkännanden i Settings. |
| **Operatören** | i runnern, [operator.md](operator.md) | DeepSeek väljer nästa varv ur en spelbok, kontrollerad mot spelbokens spakar och gränser. Den ger upp ordnat (escalate). |
| **Granskningen** | runnerns `review`-steg | DeepSeek dömer resultatet: nivå, betyg och fel. |
| **Panelen** | Winterspring :8790 (alltid på) | Visar jobb, kö, GPU:er, moln och DeepSeek. Fungerar som webbapp på mobilen. |
| **Postbox** | `../postbox/` | Brevlåda och filreservationer mellan agenter (`claim`/`release`). I dag bara på laptopen (filer i `postbox/data/`). |
| **Verktygen** | `tools/*` | JSON-recept in, en rad JSON ut. Precis det en agent behöver. |
| **Hermes Agent** | laptopen, `~/.hermes/` | Installerad 2026-05-20 med en Discord-kanal ("allmänt" i Patriks server). Gatewayn är stoppad sedan dess. |

Det som saknas är **roller** (vem äger vad), **en ingång** för Patrik (en enda kanal i stället för många terminaler) och
**hårda regler** för delade resurser.

## Rollerna

| Agent | Ansvar | Hjärna | Bor på |
|---|---|---|---|
| **Producenten** | Patriks enda samtalspartner när han inte sitter vid datorn. Tar emot önskemål, bryter ner dem i uppdrag, delar ut, följer upp och rapporterar. Samlar ihop alla frågor som väntar på Patrik och ställer dem en i taget. | Hermes Agent: en billig modell för vardagen och Claude när en plan ska skrivas | Winterspring (alltid på, hänger inte med Darrowmere) |
| **Driften** | Äger Darrowmere: kön, korten, RAM, ComfyUI-tjänsterna, omstarter och molnvakter (RunPod, Tripo, Meshy). Ingen annan rör ComfyUI direkt. | Mest vanlig kod (runnern), DeepSeek för beslut | Darrowmere |
| **Operatörerna** | Kör spelböcker: varv på varv mot ett mål och ger upp ordnat. | DeepSeek, i runnern | Darrowmere |
| **Specialisterna** | Bygger och rättar verktyg inom sitt område: *props/träd/växter*, *Kartrummet*, *hus*, *karaktärer*, *panel/Darrowmere*, *Godot*. Var och en äger sina mappar. | Claude Code, en session per uppdrag | Laptopen |
| **Granskaren** | Kontrollerar innan något går in i `assets/`: `checks.ok`, budgetar, licenser, stilguiden (kontaktark i liten storlek) och att docs och CLAUDE.md stämmer. | Billig modell, Claude bara för stilomdömen | Darrowmere eller laptopen |

Patrik bestämmer riktning och stil och säger ja eller nej till pengar och resultat. Claude (dyr) används för att bygga
verktyg och spelböcker och för fall som ingen spelbok täcker, precis som i [operator.md](operator.md).

## Reglerna

1. **GPU och RAM bara via runnern.** Inga direkta anrop till ComfyUI eller `krea2.py` mot Darrowmere från någon agent.
   Det som behöver en GPU blir en beställning. Driften är den enda som får starta om eller frigöra.
2. **Ett område per agent.** En specialist ändrar bara sina mappar. Delade filer (`CLAUDE.md`, `README.md`, `props.json`,
   `runner.py` …) reserveras med postbox `claim` först och släpps efter commit.
3. **Pengar kräver Patriks ja i panelen**, alltid med pris först. Ingen agent har betalnycklar utom runnern, som kräver
   godkännande per steg (`cloud_gate`).
4. **Allt som väntar på Patrik hamnar på ett ställe**: panelens kö för godkännanden och producentens kanal. Det får inte
   ligga i ett fönster som kräver att han sitter vid datorn.
5. **Nycklar skrivs aldrig ut** och ligger bara där de behövs (`.env` med läge 600). Producenten på Winterspring får ingen
   nyckel utom sin egen modellnyckel med ett taklimit.
6. **Varje agent har en budget per dag** (tokens eller USD). Driften och operatörerna räknar redan med kostnad. Producenten
   och specialisterna får ett tak som syns i panelen.
7. **Allt syns i panelen**: varje agent som en rad (namn, ikon, vad den gör nu, förfluten tid), i samma stil som jobbraderna.

## Faserna

Varje fas är användbar för sig. Vi stannar och utvärderar mellan faserna.

### Fas 0: Härda Darrowmere (behövs oavsett team)

- Runnern frigör en lanes modeller **efter** varje jobb, inte bara före nästa.
- RAM-tak för ComfyUI-tjänsterna (`MemoryMax` i systemd), så att en tjänst som växer dör ensam i stället för att hela
  lådan hamnar i swap.
- RunPod-vakten blir ett runnersteg (`kind: "cloud_train"`) i stället för en lös process. Den syns i panelen och startar
  om med runnern.
- 48 GB RAM (beslutat 2026-11-08) tar bort det mesta av problemet. Reglerna gäller ändå.

**Klart när** Krea-2 och Klein 4B kan beställas samtidigt utan att lådan hänger, och vakten överlever en omstart av runnern.

### Fas 1: Postbox för hela hemmanätet

- Postbox får ett HTTP-läge (MCP över HTTP) på Winterspring, så att agenter på laptopen, Darrowmere och Winterspring delar
  samma brevlåda. Filerna flyttar till Winterspring. Laptopen pratar med den när den är på.
- Panelen får en postboxvy: trådar, vem som har reserverat vad, och Patriks egen inkorg.

**Klart när** en agent på Darrowmere och en Claude-session på laptopen kan skicka post till varandra, och Patrik ser den
från mobilen.

### Fas 2: Producenten

- Hermes Agent installeras på Winterspring som en användartjänst, i samma stil som panelen. Den gamla installationen på
  laptopen lämnas orörd.
- Kanal till Patrik: Discord (finns redan) eller Telegram. Se besluten nedan.
- Färdigheter (skills) i Hermes som tunna omslag runt det vi har: lägga en beställning (`order.py submit`), starta en
  spelbok, läsa panelens status, skriva och läsa postbox, och sammanfatta dagen.
- Producenten kör inga verktyg själv och läser ingen kod. Den lägger beställningar, startar spelböcker och skickar uppdrag
  till specialister via postbox.
- En sammanfattning varje morgon: vad som kördes, vad det kostade, vad som väntar på Patrik (en fråga i taget).

**Klart när** Patrik kan skriva "gör tre varianter av kistan med mossa" från mobilen och få tillbaka ett kontaktark och en
kostnad utan att öppna laptopen.

### Fas 3: Specialisterna

- Varje område får en kort instruktionsfil (`docs/agents/<område>.md`): vilka mappar det äger, vilka verktyg och kontroller
  som gäller och vilka filer det inte rör. CLAUDE.md pekar dit i stället för att växa.
- Producenten startar en specialist när ett uppdrag kräver kod: en Claude Code-session på laptopen (eller i molnet) med
  uppdraget som brief och en egen git-worktree och gren. Patrik eller producenten slår ihop grenen när granskaren har sagt ok.
- Specialisten skriver spelböcker när ett verktyg är stabilt, så att operatörerna kan ta över ruljansen.

**Klart när** två specialister har jobbat samtidigt i olika områden utan krockar och utan att Patrik har behövt flytta
information mellan dem.

### Fas 4: Granskaren

- Granskningen flyttar från "efter varje jobb" till "innan något går in i `assets/` eller på `main`": kontroller,
  budgetar, licenser (`CREDITS.md`), stilguiden och att dokumenten stämmer.
- Stilomdömen görs på ett litet kontaktark, och bara när ett verktyg är nytt eller ändrat (som i CLAUDE.md).

## Kostnad och risker

- **Samordning kostar tokens.** Ett team lönar sig först när agenterna kan arbeta på egen hand i timmar. Därför billiga
  modeller för ruljansen (DeepSeek, redan cirka 0,001 USD per granskning) och Claude bara för att bygga.
- **Hermes med skalåtkomst** på en maskin i hemmanätet: kör den som en egen användare på Winterspring, utan sudo och utan
  andra nycklar än sin egen. Den når Darrowmere bara via beställningar och panelens API.
- **Publikt repo:** asset-studio är publikt. Agenter pushar aldrig själva. Grenen slås ihop efter granskning, och pushen
  går som i dag via värden.
- **Darrowmere har 18 GB RAM** tills uppgraderingen. Fas 0 är därför först.

## Beslut som väntar på Patrik

Tas ett i taget, i den här ordningen:

1. **Kanal till producenten:** Discord (servern finns redan) eller Telegram.
2. **Producentens hjärna:** DeepSeek för vardagen med Claude vid planering, eller Claude hela tiden (dyrare, bättre
   omdöme).
3. **Var specialisterna kör:** Claude Code på laptopen (gratis inom abonnemanget, men laptopen måste vara på) eller i molnet
   (går när laptopen är stängd).
