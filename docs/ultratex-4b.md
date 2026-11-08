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
