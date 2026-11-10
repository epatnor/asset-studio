# Darrowmere: mätvärden före och efter uppgraderingen

Utgångsläge 2026-11-07, före Xeon X5680 och 48 GB minne (beställda 2026-11-07, X5680 väntas 18–23 nov).
Samma mätningar görs igen efter bytet. Mätskriptet är `tools/darrowmere/bench.py`
(`python3 -I tools/darrowmere/bench.py --remote`, körs när Darrowmere är ledig).

**2026-11-10: minnet isatt, processorn kvar.** 48 GB sitter i: 6 × 8 GB, två moduler i var och en av de tre kanalerna, och
EDAC ser alla sex (49 152 MB, kärnan 47 GiB). Processorn är fortfarande i7-920. bench.py 16:52 (last 0,4) ger samma värden
som före, som väntat, eftersom mängden minne inte ändrar bandbredden: Python 1,82 s, sha256 230/814 MB/s, AES 192 MB/s,
minneskopiering 1,69 GB/s, NVMe 1 500 MB/s, nedladdning 91 Mbit/s. Båda korten och båda ComfyUI-tjänsterna (8188 T1000,
8189 M4000) kom upp. Minnesskyddet (taken 14G/10G och earlyoom) togs bort 16:54 med `install_memory_guard.sh remove`;
båda ComfyUI-tjänsterna ser nu hela minnet (47 GiB). Skriptet finns kvar om det behövs igen.

## Hårdvara

| Del | Före (2026-11-07) | Efter |
|---|---|---|
| Moderkort | Gigabyte X58A-UD7, BIOS F8 | samma |
| Processor | Core i7-920, 4 kärnor / 8 trådar, 2,67 GHz, BCLK 133, ingen AVX, **ingen AES-NI** | Xeon X5680, 6 / 12, 3,33 GHz, AES-NI, ingen AVX |
| Minne | 18 GB: 3 × 2 GB + 3 × 4 GB, blandat (dmidecode säger felaktigt 400 MT/s) | 48 GB: 6 × 8 GB SK Hynix PC3-12800U 2Rx8 (kortet har 6 platser A0–A5, max 48 GB enligt dmidecode 2026-11-08) |
| GPU 0 | Nvidia T1000 8 GB (Turing, sm_75), effektgräns 50 W, rapporterar ingen effekt | samma |
| GPU 1 | Quadro M4000 8 GB (Maxwell, sm_52), effektgräns 120 W | samma |
| Diskar | 840 EVO (system, `/`), NVMe (`/data`, 469 GB) | samma |
| Nät | Wifi: Linksys WUSB600N v2 (Ralink RT3572, 802.11n, USB 2.0), 5 GHz kanal 36, −49 dBm; två gigabitportar oanvända | |

## Genereringstider (ComfyUI:s egen körtid)

| Jobb | Kort | Inställningar | Tid |
|---|---|---|---|
| Krea-2 Turbo, en bild | T1000 | 1024 × 1024, 8 steg | 326 s första, 291 s varm |
| TRELLIS.2 modell + textur | T1000 | 1024, 28 steg (robot r05) | 1 705 s (28 min) |
| TRELLIS.2 modell + textur | T1000 | 1280, 28 steg (robot r07) | 2 663 s (44 min) |
| TRELLIS.2 modell + textur | T1000 | 1536, 28 steg (robot r01) | 4 702 s (78 min); hi-res-steget ~240 s/steg |
| Pixal3D modell + textur | T1000 | 1024, 28 steg (robot r06) | 991 s (17 min) |
| Krea-2 vyark + förfining (6 vyer) | T1000 | ark 711 s, förfining 304–333 s per vy | |
| Klein 4B fp8, bild | M4000 | 1024 × 1024, 4 steg, kall | 101 s |
| Klein 4B fp8, bild | M4000 | samma, modellen redan inladdad | 94 s (≈ 20 s/steg; Maxwell räknar om fp8 till fp32) |
| Klein 4B GGUF Q8_0, bild | M4000 | samma prompt och frö, kall | 108 s (inte snabbare än fp8; bilden nästan identisk, medelavvikelse 4/255) |
| TRELLIS.2 modell + textur | T1000 | 1024, 28 steg (Maren), med M4000:s modeller i RAM | 3 443 s (57 min): dubbelt mot r05, swap |
| Pixal3D modell + textur | T1000 | 1024, frö 142, CFG 3.5 (Maren), RAM frigjort först | 860 s (14 min) |
| DeepSeek-granskning | moln | 3 kriterier, bilder | 60–80 s |

## Minne under last

- Darrowmere har 18 GB RAM. Med Klein 4B laddad i M4000:s ComfyUI (modell + textkodaren Qwen3 4B) tog den processen
  **13 GB RAM**, och TRELLIS på T1000 trängdes ut i swap (5,2 GB). Marens nät (1024, 28 steg) gick då klart långsammare
  än r05 med samma inställningar. Att frigöra M4000:s modeller släppte 12 GB.
- Att köra båda korten samtidigt med tunga modeller kräver alltså mer RAM; 48 GB bör lösa det.
- 2026-11-08 19:00–19:15 hängde Darrowmere sig när Krea-2 (T1000) och Klein 4B (M4000) kördes samtidigt: "Under memory
  pressure" i journalen, sedan tappade wifi-stickan basstationen (beacon loss 19:09) och journalen slutade 19:15; ingen OOM-kill,
  utan swap-trassel tills maskinen fick startas om hårt. Sedan dess kör runnern ett tungt ComfyUI-jobb åt gången över båda
  korten och släpper det andra kortets modeller först (`serial_lanes` i `runner.json`). Stängs av när 48 GB sitter i.

## Nät

| Mätning | Före |
|---|---|
| Nedladdning från internet (Hugging Face, stor fil) | 8,5 MB/s ≈ 68 Mbit/s |
| Darrowmere → laptop över ssh (aes128-gcm) | 1,6 MB/s ≈ 13 Mbit/s, under samtidig nedladdning; i7-920 saknar AES-NI |

## Effekt

| Läge | Värde |
|---|---|
| M4000 vid generering | 118 W uppmätt (gräns 120 W) |
| T1000 | rapporterar inte effekt; uppskattas i panelen |
| Hela datorn | bara uppskattad i panelen (moderkort, CPU och nätagg utan mätare); ett vägguttag med mätare behövs för riktiga värden |

## Temperaturer

| Del | Före |
|---|---|
| T1000 under långa jobb | upp till 88 °C, throttlar (sm-klocka 1320 MHz) |
| M4000 | 772 MHz vid lätt last; 44 °C |
| CPU (coretemp) | 57 °C vid lätt last |

## Mätskriptet (bench.py)

Resultat per körning (en rad JSON) läggs in här:

| Mätning | Före (2026-11-08 00:41, last 0,5) | Efter |
|---|---|---|
| Ren Python, en tråd (s, lägre är bättre) | 1,85 | |
| sha256, 1 tråd (MB/s) | 229 | |
| sha256, alla trådar (MB/s) | 801 (8 trådar) | |
| AES-128-GCM, 1 tråd (MB/s) | 194 (utan AES-NI) | |
| Minneskopiering 1 GB (GB/s) | 1,67 | |
| Diskläsning `/data`, NVMe (MB/s) | 1 500 | |
| Nedladdning (Mbit/s) | 69 | |
| UltraTex 9B Q4, 6 vyer + 2 bakningar (T1000) | 2 074 s (35 min) | |

## Hängningen 2026-11-09 kl. 14:36

ComfyUI på T1000 laddade Krea-2 (14 GB) för frostsysterns första bild direkt efter ett UltraTex-jobb (Klein 4B fp8,
Qwen3 4B, LoRA) utan att släppa de förra modellerna ("0 models unloaded"), och Darrowmere hamnade i swap (18 GB). Runnern
släppte bara det andra kortets modeller (`serial_lanes`). Nu tömmer runnern kortets modeller när nästa jobb på samma kort
använder andra modellfiler (`LAST_MODELS` i `runner.py`). Galleriets förhandsbilder för 3D-modeller (Blender) görs bara när
ComfyUI är ledigt och i en minnesbegränsad scope (`systemd-run --user --scope -p MemoryMax=4G`).

## Hängningen 2026-11-09 kl. 15:27 och minnesskyddet

Krea-2 laddades om efter en promptreparation: textkodaren (5 GB) och modellen (14 GB) är ca 19 GB, mer än de 18 GB som finns.
Maskinen låg under minnestryck i en halvtimme och dog. Inget skyddade resten av systemet. Sedan dess (installerat med
`sudo bash ~/install_memory_guard.sh`, skriptet i `tools/darrowmere/`):

- **Minnestak per ComfyUI-tjänst** (systemd-drop-in `memory-guard.conf`): T1000 `MemoryHigh` 13G / `MemoryMax` 14G, M4000
  9G / 10G, båda `MemorySwapMax` 10G och `Restart=always`. Krea-2 får swappa inom sin egen grupp (långsammare), och SSH,
  runnern och panelen behåller sitt minne.
- **earlyoom** (`-m 4 -s 10`, föredrar python och blender, undviker sshd och systemd): avslutar ComfyUI hellre än att
  maskinen fryser.
- Borttaget 2026-11-10 när 48 GB satt i (`sudo bash ~/install_memory_guard.sh remove`).
