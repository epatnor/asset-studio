# UltraTex för Klein 4B: plan för en egen LoRA

Plan 2026-11-08. Inget är startat, och inga betalda steg körs utan Patriks ja.

## Varför

UltraTex 9B gav den hittills bästa texturen (Maren 2026-11-08: inga armskuggor och samma utseende runt om), men
de enda vikterna är byggda på FLUX.2 Klein 9B och FLUX.1-dev, som båda har BFL:s icke-kommersiella licens. Den licensen
gör det inte tillåtet att använda modellen till ett kommersiellt spel, även om bilderna i sig får användas fritt. Klein 4B
har Apache 2.0. En egen UltraTex-LoRA på 4B ger samma metod utan NC-licens, och den bör dessutom gå snabbare på våra 8 GB-kort
(9B Q4 tog 35 min för Maren på T1000).

## Varför vi inte kan krympa 9B-LoRA:n

- 9B och 4B är två separat tränade modeller med olika bredd (4096 mot 3072) och olika antal block (8 + 24 mot 5 + 20).
  En LoRA är en ändring av just 9B:s vikter och har ingen motsvarighet i 4B:s vikter. Att skära eller projicera den ger brus.
- Att destillera, alltså låta 9B UltraTex göra träningsbilder åt en 4B-LoRA, är uttryckligen förbjudet i FLUX-licensen
  ("train, fine tune, or distill other models for commercial use" räknas inte som icke-kommersiellt, och utdata får inte
  användas för att träna en konkurrerande modell). Resultatet skulle också ärva frågan om licensen.
- Därför tränar vi från början på det öppna datat, precis som forskarna gjorde.

## Licenskedjan för resultatet

| Del | Licens |
|---|---|
| FLUX.2 Klein base 4B + textkodaren Qwen3 4B | Apache 2.0 |
| FLUX.2 VAE | Apache 2.0 |
| UltraTex-koden (`yiboz2001/UltraTex`), ComfyUI-noden (`visualbruno/ComfyUI-UltraTex`) | MIT |
| SLA-kärnorna (sparse attention) | Apache 2.0 |
| Träningsdatat G-buffer TexVerse | CC0 |
| Vår LoRA och vår dekoder | våra egna |

UltraTex-dekodern `flux2/decoder.pt` (finjusterad VAE-dekoder) ligger i samma paket som NC-licensen. Vi tränar därför
en egen dekoder också. Den är billig (forskarna: 1 200 steg).

## Data

- G-buffer TexVerse: 351 847 objekt i 256 zip-buckets (`canonical/bsdf/00.zip` … `ff.zip`), cirka 16 GB och 1 400 objekt
  per bucket. Varje objekt har sex vyer med albedo, normaler (kamera och värld), position, ruffighet/metall, renderingar och
  referensvyer, plus kamerapositioner. Det är exakt det format som `train_flux2.py` läser (`data/train_demo.json`).
- Vi börjar med 6 buckets (ca 8 000 objekt, ca 100 GB). Det laddas ner direkt till den hyrda maskinen, inte till laptopen
  eller Darrowmere.
- Om manifestet (`00.manifest.jsonl`) har kategorier kan vi vikta mot figurer och stiliserade objekt. Det kollas i steg 1.

## Steg

1. **Förberedelse, gratis (laptop/Darrowmere):** klona UltraTex på en fast commit och läs `train_flux2.py`. Ladda ner en bucket
   till Darrowmere och kontrollera formatet: bygg `train.json`/`eval.json` med ett litet skript och läs manifestet.
   Kontrollera att noden laddar en 4B-LoRA genom att göra en tom LoRA med rätt form (rang 64, 4B:s lager) och ladda den i
   ComfyUI på M4000. Den ska ge Klein 4B:s vanliga bild, inget fel.
2. **Provkörning, betald (ca 1 h, några dollar):** hyr ett H100 80 GB (RunPod, Lambda eller Vast; vilket konto avgör Patrik).
   Kör `bash scripts/train_flux2_9b_2048.sh 4b` i 1024 px i 200 steg med `BOOTSTRAP_CHECKPOINT=""` (annars försöker skriptet
   läsa 9B-LoRA:n). Mät sekunder per steg och minnet. Det ger det verkliga priset för steg 3.
3. **Albedo-LoRA, betald:** 15 000 steg i 1024 px (samma som Qwen-porten), checkpoint var 1 000:e steg. Uppskattning
   2–4 s per steg, alltså 8–17 timmar, ungefär 20–50 USD. Det exakta priset tas fram i steg 2 och visas innan start.
4. **Dekoder, betald men kort:** `scripts/train_vae_flux2.sh` i 1 200 steg på samma data, cirka 1 timme.
5. **Ruffighet/metall (valfritt):** `TASK=mr`, lika långt som steg 3. Det tas bara om albedon blir bra. Vi kan klara oss
   med ruffighet ur vår vanliga kedja tills dess.
6. **Utvärdering, gratis:** ladda ner checkpoints 5 000, 10 000 och 15 000 till Darrowmere. Kör Maren (nätet
   `maren_trellis2_323`) och roboten genom samma flöde som 9B, i 1024 px. Ett kontaktark: 9B mot 4B, framifrån, från sidan och
   bakifrån, platt ljus.
7. **In i flödet:** byt LoRA och dekoder i `build/robot/pbr_api.json`-kopian till 4B, lägg in ett ordermönster i
   `tools/darrowmere/runner/examples/` och uppdatera `docs/texture-projection.md` och minnet om modellicenser.

## Godkännande

- 4B ska klara samma kriterier som 9B på Maren: inga skuggbilder av armarna, samma utseende runt om, och ett ansikte som
  liknar referensen. Patrik avgör på kontaktarket.
- Tiden på T1000 noteras i `docs/darrowmere-baseline.md`. Målet är under 20 min för sex vyer och bakning.
- Blir 4B klart sämre stannar vi efter steg 6. Kostnaden är då provkörningen och en natt på H100.

## Risker

- Forskarna har stöd för 4B i koden men släppte bara 9B. Det kan betyda att 4B blev sämre. Det vet vi först efter steg 6.
- Sparse attention-kärnorna är skrivna för H100 (Triton 3.x). Ett annat kort kan kräva `SPARSE_ATTENTION=false`, som är
  långsammare.
- Dataladdningen (100 GB) tar tid på den hyrda maskinen. Den räknas in i priset i steg 2.

## Resultat av steg 1 (2026-11-08)

- UltraTex klonad på Darrowmere i `/data/texverse/UltraTex`, commit `a726678` (2026-10-07). Träningskoden lägger LoRA:n på
  samma lager för 4B som för 9B (`_lora_targets`: attention i dubbelblocken, linear1/linear2 i enkelblocken), 60 lager för 4B.
- ComfyUI-noden `UltraTexLoraLoader` laddar en LoRA i 4B:s form (PEFT, rang 64): 60 av 60 lager patchade på M4000.
  En LoRA med nollor gav en bild identisk med körningen utan LoRA (skillnad 0,0/255), en med slumpvärden ändrade bilden
  (11/255). Vägen från träning till användning fungerar alltså för 4B.
- Bucket `00` (16,3 GB, 4–5 MB/s, ca 55 min) uppackad till `/data/texverse/extracted` med `tools/ultratex4b/prep_texverse.py`:
  1 388 objekt, alla med albedo, position, normaler och renderingar; 588 har ruffighet/metall. Källupplösning: 1024: 423,
  2048: 579, 4096: 309, 8192: 77. Förgrunden täcker i snitt 18 % av vyerna; 69 objekt under 5 %.
  Listor: `train.json` (1 372), `eval.json` (16), `foreground_ratios.json`.
- Manifestet har bara id, filantal, storlek och status, inga kategorier. Viktning mot figurer går inte att göra ur
  manifestet. Vi tar buckets i följd som forskarna.
- Uppackning och förgrundsmätning tog 45 min på i7-920. På den hyrda maskinen körs flera buckets parallellt.

## Resultat av steg 2, provkörningen (2026-11-08)

Körd med `tools/ultratex4b/runpod_smoke.py` (nu `runpod_train.py` och `pod_train.sh`; startar poden, kör skriptet, följer,
hämtar loggar och tar bort poden; syns i panelen som pipelinen `ultratex4b-smoke`). Community-H100 SXM var slut, så det blev **H100 NVL** (94 GB) för 2,59 USD/h.

| Mätning | Värde |
|---|---|
| Kostnad totalt | **1,30 USD** (ca 30 min inklusive fyra startfel som rättades på samma pod) |
| Nedladdning | bucket 00 (16 GB) + Klein base 4B + Qwen3 4B + VAE (16 GB): under en minut |
| Uppackning, 300 objekt | 6 min (prep-skriptet är enkeltrådat) |
| Träning 1024 px | **3,9 s/steg**, stadigt före och efter valideringen |
| Validering vid steg 100 | 5 min 45 s för 2 eval-objekt (8 vyer, 25 steg) |
| GPU-minne | högst 27 GB av 94 |
| Loss | 0,46 (steg 1–20) → 0,32 (steg 181–200); inga NaN, LoRA:n tränas från noll |

Det som fungerade: bara öppna delar (Klein base 4B och Qwen3 4B från BFL:s Apache-repo, VAE:n från Comfy-Orgs Apache-repo
`Comfy-Org/Flux-2-Klein-4B`, samma fil som ComfyUI använder) och en dekoder tagen ur bas-VAE:n i stället för UltraTex:s
NC-dekoder. Sparse attention-kärnorna går på H100 NVL.

Startfel som är rättade i skripten: uv behöver `--index-strategy unsafe-best-match` (PyTorch-indexet först), `hf`-kommandot
behöver typer/click, `--include` med en fil och mönster tog inte med modellfilen, och skript som startas via ssh ärver inte
podens `RUNPOD_*`-variabler (vakthunden läser dem nu ur `/proc/1/environ`). Valideringsbilderna hämtades inte (de är större än
gränsen i `fetch`); nästa körning ska hämta dem.

**Pris för steg 3** (15 000 steg, H100 NVL 2,59 USD/h): 15 000 × 3,9 s = 16,3 h träning. Validering var 1 000:e steg med
2 eval-objekt ger 15 × 6 min = 1,5 h, var 2 500:e steg 6 × 6 min = 0,6 h. Med uppstart och data blir det **ungefär 17–18 h,
44–47 USD**. Före steg 3: gör prep-skriptet parallellt (300 objekt tog 6 min; 6 buckets enkeltrådat skulle ta timmar) och
håll eval-mängden liten (16 objekt skulle ta ~45 min per validering). Krea 2-forken mättes inte i den här körningen.

## Steg 3, första körningen (startad 2026-11-08)

Patrik valde 10 000 steg först (i stället för 15 000): checkpoints 5 000 och 10 000 provas på Maren, och körningen fortsätter
till 15 000 från sista checkpointen bara om bilderna blir bättre.

- `run1`: H100 NVL (2,59 USD/h), buckets 00–05 (ca 8 300 objekt), 1024 px, eval 2 objekt, validering var 2 500:e steg,
  LoRA-checkpoint var 1 000:e. Beräknat ca 11–12 h, ca 30 USD; vakthunden stoppar poden efter 14 h (högst 36 USD).
- Styrningen körs på Darrowmere, som alltid är på: `/data/texverse/runpod/` (kopior av `runpod_train.py`, `pod_train.sh`,
  `prep_texverse.py`, `pipeline.py`; nyckeln i en egen `.env` med 600-rättigheter). Vakten
  (`ULTRATEX_RUNS=/data/texverse/runs PIPELINE_HOST=local python3 -I runpod_train.py watch '{"run": "run1"}'`) hämtar varje ny
  checkpoint till `/data/texverse/runs/run1/checkpoint-*/` var tionde minut, valideringsbilder och loggar på slutet, och tar
  bort poden. Panelen visar pipelinen `ultratex4b-run1` med steg, s/steg, kostnad och tid kvar.
- Skydd mot glömda poddar: vakthunden på poden *stoppar* den (disken med checkpoints finns kvar) efter `max_min`, poden
  stoppar sig själv om ingen hämtat resultatet inom två timmar efter träningen, och en stoppad pod tas inte bort av vakten
  förrän någon har tittat.

**Utfall (2026-11-09):** poden gick i 12,3 h (14:48–03:05 UTC), ca 31,8 USD, som beräknat. Vakten dog när Darrowmere
hängde 2026-11-08 kväll (vid steg ~6 900, så panelens kostnad fastnade på 18 USD). Träningen gick klart av sig själv och
poden stoppade sig efter två timmars väntan. Checkpoints 100–6 000 finns på Darrowmere; 7 000–10 000 ligger på poddens
disk. Värden hade inget ledigt kort vid omstart (community-moln), och start utan GPU gick inte. `runpod_train.py recover`
(i bakgrunden på Darrowmere, `recover.out`) försöker därför var tionde minut i högst ett dygn. Den hämtar alla
checkpoints, loggar och hela `checkpoint-10000` med optimerarens läge (för att kunna fortsätta mot 15 000) och tar bort
poden först när den sista finns hemma. Medan den väntar kostar poden bara lagring, ca 0,08 USD/h.

Allt kom hem 2026-11-09 (podden startades på CPU, 1,30 USD/h, i ca 20 minuter, och togs sedan bort): 13 checkpoints i
`/data/texverse/runs/run1/`, loggar och valideringsbilder. Hela run1 kostade ca 32,6 USD. Träningen sparar bara LoRA:n,
inget optimerarläge, så en fortsättning mot 15 000 börjar om optimeraren från `checkpoint-10000`.

**Valideringen** (2 objekt, en staty och ett monster; ark i `build/ultratex4b/run1_eval/`): bildernas rader 0–1 är facit
och samma i alla steg, rad 2–3 kolumn 4–6 är modellens kartor. Steg 100 ger fel färger (orange och grönt på båda), och vid
5 000 har modellen lärt sig uppgiften: stenfärg på statyn, mörkt med rätt ton på monstret. Mellan 5 000 och 10 000 syns
ingen tydlig vinst. Medelavvikelsen mot facit (0–255, på objektet) är för statyn 22–31 vid 5 000, 41–53 vid 10 000 och
54–84 vid 7 500, för monstret 35–42 vid 5 000 och 35–43 vid 10 000. Två objekt är för få för att lita på skillnaden, så
provet på Maren avgör. Det talar inte för att 15 000 steg är det som behövs.

Lärdom till nästa körning: de två timmarnas väntan med kortet igång kostade ca 5 USD. Vakten ska köras där den inte dör
(som runnersteg, se [agent-team.md](agent-team.md), fas 0), och väntan efter träningen kortas till 20 minuter.

## Krea 2 som andra spår

Forken `Atlas3DSS/UltraTex` (grenen `qwen21-krea2-port`) har kod för Krea 2 som stomme, men inga tränade vikter och inget
som visar att Krea 2-vägen har körts. Krea 2 är den modell vars utseende vi gillar mest, och UltraTex löser det som brast
när vi använde Krea 2 för texturer (vyerna stämde inte överens). Det talar för en Krea 2-version. Men:

- Krea 2 är större än Klein 4B: dyrare att träna och långsammare på 8 GB (redan en vanlig bild tar ~5 min på T1000).
- Licensen är kommersiell under en omsättningsgräns, inte Apache. Den är mindre värd att dela med andra.
- Koden är en otestad fork, medan 4B stöds direkt av forskarnas skript.

Ordning: 4B först, eftersom det lär oss hela kedjan (data, hyrd maskin, utvärdering) billigast. I provkörningen (steg 2) mäts
också Krea 2-forken i 200 steg på samma maskin, så vi vet vad den skulle kosta. Om 4B:s texturer saknar stilen tränas Krea 2
som andra körning på samma data.

## Uppföljning i panelen

Den betalda träningen ska synas i Darrowmere-panelen som en beställning med uppdraget `ultratex-4b`. Steget startar maskinen,
läser loggen, hämtar checkpoints och stänger av maskinen när den är klar eller om den står still. Första gången kan det göras
med `tools/pipeline.py` som pipeline-kort, innan runnern får ett eget steg för molnträning.
