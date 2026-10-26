# HDRI från Poly Haven

Miljöljus för Ateljéns materiallabb (`studio/lab3d.js`, Environment), som komplement till spelsolen. Hämtat 2026-10-26 från https://polyhaven.com, upplösning 2k (.hdr, cirka 25 MB tillsammans).

**Licens: CC0 1.0**: fria att använda, ändra och sprida, även kommersiellt, utan krav på erkännande. Upphovspersonerna står ändå här och i `index.json`.

| Fil | Namn | Av |
|---|---|---|
| `kloofendal_48d_partly_cloudy_puresky_2k.hdr` | Kloofendal 48d Partly Cloudy (Pure Sky) | Greg Zaal, Jarod Guest |
| `forest_slope_2k.hdr` | Forest Slope | Andreas Mischok |
| `qwantani_dusk_2_2k.hdr` | Qwantani Dusk 2 | Greg Zaal, Jarod Guest |
| `studio_small_08_2k.hdr` | Studio Small 08 | Sergej Majboroda |

Filerna ligger inte i git. Hämta dem (kontrollsumman jämförs med Poly Havens) så här:

```bash
python3 -I tools/hdri/fetch_hdri.py '{"ids": ["kloofendal_48d_partly_cloudy_puresky", "forest_slope", "qwantani_dusk_2", "studio_small_08"], "res": "2k"}'
```
