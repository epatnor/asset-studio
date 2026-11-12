# Arbetsmaskinerna: Darrowmere och Dell T5810

Darrowmere (i7-920, Gigabyte X58, 48 GB, Quadro M4000 + T1000, Linux Mint 22.3) kör beställningarna. En Dell Precision T5810 kom hem 2026-11-11. Den här sidan beskriver hur verktygen hittar arbetsmaskinen, hur den sover när den inte används och hur en ny maskin sätts upp.

## En maskin, en rad i `machines.json`

Alla verktyg som pratar med arbetsmaskinen läser adressen ur `tools/darrowmere/machines.json` via `tools/darrowmere/machine.py`. Det gäller order.py, character_order.py, pipeline.py, gen_view.py, deliver.py, bench.py, deploy_runner.sh och panelens installation på Winterspring.

- `worker` anger vilken maskin som används som standard.
- Miljövariabeln `DARROWMERE_WORKER=ravenholdt` väljer en annan maskin för ett enstaka anrop.
- `DARROWMERE_HOST` byter bara adressen.

```
python3 -I tools/darrowmere/machine.py show [maskin]   # en rad JSON
python3 -I tools/darrowmere/machine.py ssh  [maskin]   # epatnor@<adress>
python3 -I tools/darrowmere/machine.py wake [maskin]   # Wake-on-LAN om den inte svarar, väntar tills ssh svarar
bash tools/darrowmere/runner/deploy_runner.sh [maskin]
```

`tools/comfy.json` (laptopens val av ComfyUI) och `LANES` i gen_view.py har egna adresser och portar. Lägg till T5810 där när den har en ComfyUI.

## Strömsparläge (förberett 2026-11-11, avstängt)

I tomgång drar Darrowmere ungefär 135 W från väggen, enligt panelens modell. Det blir ungefär 3,2 kWh per dygn eller ungefär 100 kWh i månaden. I viloläge (S3, `mem_sleep` = deep) drar den bara några watt.

**Runnern somnar själv.** Läget slås på med `"power": {"auto_suspend": true}` i `runner.json` eller i maskinens egen `runner.local.json`. Vilan börjar när allt nedan har gällt i `idle_min` minuter (standard 30):

- ingen beställning väntar eller körs (en beställning som väntar på godkännande räknas inte),
- alla ComfyUI-köer är tomma,
- alla grafikkort ligger under `max_gpu_util` % (standard 10),
- femminuterslasten ligger under `max_load` (standard 1,5); en träning som startats för hand håller därför maskinen vaken,
- filen `/data/runner/stay_awake` finns inte.

Med `runner.py --idle` ser man varför maskinen håller sig vaken just nu. Innan den somnar skriver runnern `/data/utdata/power.json`.

**Den väcks med Wake-on-LAN**, ett magiskt paket till trådportens MAC-adress i `machines.json`:

- `order.py submit`, `approve` och `cancel` väcker den. Det gör inte `status`, som i stället svarar `asleep`.
- Panelens beställningssida (`character_order.submit`) och panelens Approve väcker den.
- Panelens knapp **Wake** finns vid "Darrowmere offline". Den skickar paketet från Winterspring, som alltid är igång.
- deploy_runner.sh väcker den.
- deliver.py väcker den inte. Den hämtar bara det som redan är klart.
- Laptopens direkta ComfyUI-jobb (`comfy_target.py`) väcker den inte heller. De går till laptopens egen ComfyUI när Darrowmere sover.

**Krav.** USB-wifin (Ralink RT3572) kan inte väcka maskinen, så det krävs en kabel. Gör så här:

1. Dra en kabel till trådporten enp9s0 (Realtek RTL8111, MAC `00:24:1d:ce:b6:34`).
2. Ställ in BIOS: *Power Management Setup* → "PME Event Wake Up" Enabled och "ErP" Disabled.
3. Ändra `host` i `machines.json` till trådadressen, eller reservera adressen i routern.
4. Kör `sudo bash /data/runner/install_power.sh` på maskinen. Skriptet gör fyra saker:
   - slår på WoL (magic) i NetworkManager och vid varje uppstart,
   - låter runnern köra `systemctl suspend` utan lösenord,
   - startar om ComfyUI-tjänsterna efter vaknandet,
   - visar portarnas WoL-läge.
5. Testa för hand: `sudo systemctl suspend` på maskinen, sedan `machine.py wake` på laptopen.
6. Först därefter: `auto_suspend: true`.

**Elpris (2026-11-11).** Hittills i november har spotpriset i snitt legat på ungefär 1,95 kr/kWh i SE3 och 3,26 kr/kWh i SE4. Orsaken är reaktorer som står still. Prognoserna för december ligger runt 1,0 kr i SE3 och 1,5 kr i SE4. Om Darrowmere står på dygnet runt kostar den alltså ungefär 300–420 kr i månaden med novemberpriser. Om den bara är vaken när den arbetar försvinner det mesta av den kostnaden.

## Dell Precision T5810

**Vårt exemplar** (avläst 2026-11-11 från ett Mint-USB-minne):

| | |
|---|---|
| Service tag | 8CYXTB2 |
| Processor | Xeon E5-1680 v3: 8 kärnor och 16 trådar, 3,2–3,8 GHz, AVX2 och FMA |
| Minne | 16 GB: 4 × 4 GB DDR4-2133 ECC RDIMM (SK hynix HMA451R7MFR8N-TF), 4 platser lediga |
| Disk | Samsung SM871, 256 GB SATA-SSD |
| Grafikkort | **Quadro T1000 8 GB** och GTX 980; planen är två T1000 |
| Nätverk | Intel I217-LM (enp0s25, MAC 64:00:6a:79:23:1e): Wake-on-LAN klarar `g` och är redan påslaget. Wifi-stickan är tillfällig. |
| Viloläge | `deep` (S3) stöds |
| BIOS | A02 från 2014, mycket gammal |
| SATA | står i RAID-läge |
| Nätaggregat | 685 W |

**Det här bör göras före installationen:**

- **Uppdatera BIOS** till Dells senaste version för T5810, via service-taggen på Dells supportsida.
- **Ställ SATA på AHCI** i BIOS. Linux vill ha AHCI, och RAID-läget behövs inte för en enda disk.
- **Mer minne.** 16 GB räcker inte, eftersom varje ComfyUI håller sin egen kopia av modellen och Krea-2 tar ungefär 21 GB per kort. Darrowmere har 48 GB. Fyra platser är lediga, och begagnade DDR4 ECC RDIMM är billiga. Darrowmeres DDR3 passar inte. Samma typ, till exempel 4 × 16 GB RDIMM 2133 eller snabbare, ger 80 GB.
- **Disken.** 256 GB räcker för systemet men inte för `/data`: på Darrowmere används 169 GB, varav 85 GB modeller. NVMe-disken som `/data` ligger på i Darrowmere kan flyttas över via ett PCIe-kort. Den används bara för data, så BIOS behöver inte kunna starta från NVMe.

Resten av uppgifterna gäller alla T5810, enligt Dell.

| | Darrowmere (X58) | T5810 |
|---|---|---|
| Processor | i7-920 (4 kärnor och 8 trådar), ingen AVX | E5-1680 v3 (8 kärnor och 16 trådar), AVX2 |
| Minne | 48 GB DDR3 | 16 GB DDR4 ECC, 8 platser, 4 lediga |
| PCIe | 2.0 (kontrollerat: gen 2 ×16 för båda korten) | 3.0, två ×16-platser |
| Nätverk | Realtek RTL8111 ×2, WoL | Intel I217, WoL |
| Nätaggregat | | 685 W (vårt exemplar) |
| Grafikkort | M4000 (8 GB, Maxwell) + T1000 (8 GB) | T1000 (8 GB) + GTX 980 (4 GB) nu, planerat 2 × T1000 |

AVX2 löser Darrowmeres största risk (ingen AVX, se [darrowmere-baseline.md](darrowmere-baseline.md)). PCIe 3.0 ger dubbel bandbredd när modeller flyttas till korten.

**Två T1000:** varje kort drar 50 W och får strömmen från PCIe-platsen. Det behövs alltså inga extra kontakter, och 685 W räcker med god marginal. Båda korten är Turing (sm_75) och kan köra samma venv och samma flöden. Det försvinner då ett problem som finns i Darrowmere i dag: M4000 (Maxwell, sm_52) klarar inte alla flöden och behöver en egen venv.

Den andra ComfyUI-instansen startas i dag av `comfy_m4000.sh` med venv-m4000. Med två T1000 behövs en variant som startar den med huvudvenv:en, ett annat kort och port 8189. Körspåren blir till exempel `{"lanes": {"t1000a": "http://127.0.0.1:8188", "t1000b": "http://127.0.0.1:8189"}}` i runner.local.json. Panelen visar i dag korten som T1000 och M4000; namnen kommer från `DARROWMERE_COMFY_LANES` på Winterspring.

**Drivrutinen:** NVIDIA 580 är den sista grenen som stöder Maxwell. Det gäller M4000 och GTX 980. Darrowmere kör 580.178.04. Med bara T1000 i maskinen går det att uppgradera förbi 580. GTX 980 duger för ett första test (4 GB räcker inte för Krea-2 eller Pixal3D).

**Att kontrollera på maskinen:**

- processor och minne,
- BIOS-version,
- om BIOS startar från NVMe (Darrowmeres `/data` ligger på en 469 GB NVMe, varav 169 GB används och modellerna tar 85 GB),
- att två kort med enkel bredd får plats med luft emellan,
- *Wake on LAN/WLAN: LAN Only* och *Deep Sleep Control: Disabled* under Power Management.

### Sätta upp en ny arbetsmaskin

1. Installera Linux Mint 22.x med användaren `epatnor`. Lägg in ssh-nycklarna från laptopen och från Winterspring (`id_ed25519_darrowmere`).
2. Installera NVIDIA 580 (om M4000 är med) och ethtool.
3. Kopiera `/data` från Darrowmere med rsync: venv, ComfyUI med anpassade noder, modeller, Blender, orders och utdata. Sökvägarna är fasta i runnern och i flödena.
4. Fyll i maskinens rad i `machines.json` (host, mac, comfy, lanes) och kör `deploy_runner.sh <maskin>`. Kör sedan med sudo `install_runner.sh`, `install_comfy_m4000.sh` (om M4000 är med) och `install_power.sh`.
5. Lägg körspåren i `/data/runner/runner.local.json` om korten skiljer sig, till exempel `{"lanes": {"t1000": "http://127.0.0.1:8188"}, "auto_lanes": ["t1000"]}`. Den filen skrivs aldrig över av deploy.
6. När maskinen ska bli den nya standardmaskinen:
   - sätt `"worker": "ravenholdt"`,
   - kör `deploy.sh` (panelen) och `install_on_winterspring.sh` på Winterspring, så att panelen pekar dit,
   - uppdatera `tools/comfy.json`.

Om T5810 ska ersätta Darrowmere eller bli en andra arbetsmaskin är inte bestämt. En andra maskin skulle behöva ett eget grafikkort, och dessutom en kö som fördelar beställningar mellan maskinerna, vilket inte är byggt.

## Mätningar: Darrowmere mot Ravenholdt (2026-11-11/12)

Samma jobb kördes samtidigt på båda maskinernas T1000, med samma ComfyUI-commit, samma paketversioner och samma modellfiler. Verktyget är `tools/darrowmere/bench_comfy.py` och resultaten ligger i `build/bench/`. Ravenholdt hade 16 GB RAM och 18 GB swap. Darrowmere hade 48 GB.

| Jobb | Darrowmere (i7-920, DDR3, PCIe 2) | Ravenholdt (E5-1680 v3, DDR4, PCIe 3) |
|---|---|---|
| Krea-2, 1024², 8 steg: kall / varm | 272 / 262 s | 307 / 282 s (swap 4 GB ut) |
| Klein 4B, 1024², 4 steg: kall / varm | 122 / 108 s | 134 / 113 s |
| Pixal3D: totalt | 902 s | **805 s** |
| Pixal3D: grafikkortsdelen | 674 s vid 1416 MHz | 654 s vid 1503 MHz |
| Pixal3D: processordelen (bakning, remesh, UV) | 226 s | **148 s** |
| Pixal3D: RAM högst | 19,7 GB | 13,5 GB, 2,9 GB swap ut |

Tolkning:
- **T1000-korten** är identiska (samma VBIOS). Bildmodellernas steg begränsas av kortet, och där spelar resten av datorn knappt någon roll.
- **Ravenholdt var 5–8 % långsammare med Krea-2 och Klein.** Kortet arbetade då på lägre klocka utan att slå i effekttaket. Troligen väntade det på överföringar, eftersom ComfyUI bara kan låsa 11,8 GB RAM för överföringar mot 43 GB på Darrowmere.
- **I Pixal3D vinner Ravenholdt med 11 %.** Det är processorstegen som är 35 % snabbare. 16 GB räckte för ett flöde i taget, med lite swap.
- **En hel figurbeställning**, `squiggly-quad-1112-0028`, startade 2026-11-12 00:28 på båda maskinerna. Tiderna per steg finns i `/data/utdata/pipelines/<id>.json` på respektive maskin, och fasernas tider i `journalctl -u comfyui`.

### Hela beställningen, natten till 2026-11-12

Ingen av maskinerna kom hela vägen:
- **Darrowmere** fick slut på grafikminne i Pixal3D, i sista avkodningen (`VaeDecodeTextureTrellis`). Den begärde 1,7 GB när det bara fanns 30 MB kvar.
- **Ravenholdt** blev klar med modellen men stannade i UltraTex-steget (`XOpenDisplay`). Darrowmeres UltraTex har en lokal ändring som öppnar GL med EGL i stället för X11, och den saknades på Ravenholdt. Den är nu inlagd (`render.py`, originalet i `render.py.orig`).

Krea-2 gav inte samma bild med samma seed på de två maskinerna (filerna skiljer sig åt), så Pixal3D fick inte exakt samma indata.

| Fas | Darrowmere | Ravenholdt |
|---|---|---|
| Krea-2-bild | 270 s | 270 s |
| Haiku-granskning | 7 s | 13 s |
| Pixal3D: förbehandling (BiRefNet, MoGe, DINO) | 31 s | 30 s |
| Pixal3D: gles struktur och nästa steg | 282 s | 277 s |
| Pixal3D: formen (Trellis2) | 854 s | 854 s |
| Pixal3D: avkodning av formen (`ShapeVae`, RAM-tung) | **37 s** | **151 s** |
| Pixal3D: texturen (Trellis2) | 445 s | 446 s |
| Pixal3D: avkodning av texturen och export | slut på grafikminne efter 30 s | 76 s |

Tolkning:
- **Grafikkortsdelarna tog lika lång tid**, på sekunden. Den äldre processorn, DDR3 och PCIe 2 kostade ingenting här.
- **16 GB RAM kostade knappt 2 minuter** i avkodningen av formen. Ravenholdt swappade ungefär 5 GB under natten. Hela modellsteget blev 1 850 s.
- **Grafikminnet i T1000 är den verkliga gränsen** för den här figuren, inte resten av datorn. På Darrowmere har M4000-instansen av ComfyUI en GL-kontext på T1000 (cirka 360 MB, eftersom EGL väljer enhet 0). Huvudinstansen har cirka 540 MB när den står stilla, mot cirka 200 MB på Ravenholdt.
- **En hårig figur är dyrare än en slät.** `squiggly-1111-0937` tog 892 s i Pixal3D, den här figuren ungefär dubbelt så lång tid.
