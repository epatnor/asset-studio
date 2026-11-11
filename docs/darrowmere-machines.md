# Arbetsmaskinerna: Darrowmere och Dell T5810

Darrowmere (i7-920, Gigabyte X58, 48 GB, Quadro M4000 + T1000, Linux Mint 22.3) kör beställningarna. En Dell Precision T5810 kom hem 2026-11-11. Den här sidan beskriver hur verktygen hittar arbetsmaskinen, hur den sover när den inte används och hur en ny maskin sätts upp.

## En maskin, en rad i `machines.json`

Alla verktyg som pratar med arbetsmaskinen läser adressen ur `tools/darrowmere/machines.json` via `tools/darrowmere/machine.py`. Det gäller order.py, character_order.py, pipeline.py, gen_view.py, deliver.py, bench.py, deploy_runner.sh och panelens installation på Winterspring.

- `worker` anger vilken maskin som används som standard.
- Miljövariabeln `DARROWMERE_WORKER=t5810` väljer en annan maskin för ett enstaka anrop.
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

Det här är maskinen från tillverkarens uppgifter. Det mesta är inte kontrollerat på just vårt exemplar.

| | Darrowmere (X58) | T5810 |
|---|---|---|
| Processor | i7-920, ingen AVX | Xeon E5-16xx/26xx v3/v4, AVX2 |
| Minne | 48 GB DDR3 | DDR4 (ECC RDIMM), 8 platser |
| PCIe | 2.0 (kontrollerat: gen 2 ×16 för båda korten) | 3.0, två ×16-platser |
| Nätverk | Realtek RTL8111 ×2, WoL | Intel I217, WoL |
| Nätaggregat | | 685 W (vissa 825 W) |

AVX2 löser Darrowmeres största risk (ingen AVX, se [darrowmere-baseline.md](darrowmere-baseline.md)). PCIe 3.0 ger dubbel bandbredd när modeller flyttas till korten.

M4000 kräver en 6-poligs PCIe-kontakt och T1000 tar strömmen från platsen. Båda bör därför få plats i T5810, men kontakterna och det fysiska utrymmet måste kontrolleras.

**Drivrutinen:** NVIDIA 580 är den sista grenen som stöder Maxwell (M4000). Darrowmere kör 580.178.04, och en ny maskin med M4000 måste stanna på 580. Med bara T1000 eller nyare kort går det att uppgradera.

**Att kontrollera på maskinen:**

- processor och minne,
- BIOS-version,
- om BIOS startar från NVMe (Darrowmeres `/data` ligger på en 469 GB NVMe, varav 169 GB används och modellerna tar 85 GB),
- 6-poliga kontakter,
- *Wake on LAN/WLAN: LAN Only* och *Deep Sleep Control: Disabled* under Power Management.

### Sätta upp en ny arbetsmaskin

1. Installera Linux Mint 22.x med användaren `epatnor`. Lägg in ssh-nycklarna från laptopen och från Winterspring (`id_ed25519_darrowmere`).
2. Installera NVIDIA 580 (om M4000 är med) och ethtool.
3. Kopiera `/data` från Darrowmere med rsync: venv, ComfyUI med anpassade noder, modeller, Blender, orders och utdata. Sökvägarna är fasta i runnern och i flödena.
4. Fyll i maskinens rad i `machines.json` (host, mac, comfy, lanes) och kör `deploy_runner.sh <maskin>`. Kör sedan med sudo `install_runner.sh`, `install_comfy_m4000.sh` (om M4000 är med) och `install_power.sh`.
5. Lägg körspåren i `/data/runner/runner.local.json` om korten skiljer sig, till exempel `{"lanes": {"t1000": "http://127.0.0.1:8188"}, "auto_lanes": ["t1000"]}`. Den filen skrivs aldrig över av deploy.
6. När maskinen ska bli den nya standardmaskinen:
   - sätt `"worker": "t5810"`,
   - kör `deploy.sh` (panelen) och `install_on_winterspring.sh` på Winterspring, så att panelen pekar dit,
   - uppdatera `tools/comfy.json`.

Om T5810 ska ersätta Darrowmere eller bli en andra arbetsmaskin är inte bestämt. En andra maskin skulle behöva ett eget grafikkort, och dessutom en kö som fördelar beställningar mellan maskinerna, vilket inte är byggt.
