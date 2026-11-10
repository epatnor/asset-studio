# Egna ändringar på MPFB-figurerna (Body Editor i Character Creator)

Patrik drar själv i figurens punkter. Ändringen sparas per hörn och läggs sist när figuren byggs (`human_blender.py`:
reglage, wrap, mons, sedan ändringarna), så den överlever en ny byggning, följer riggen och delar topologi med alla
andra figurer. Gäller figurer som har en wrap (alla inpassade figurer); utan wrap skrivs ingen editorfil.

## Editorfilen (skrivs av bygget)

`assets/characters/<namn>/<namn>_edit.json`, i glTF-rummet (y uppåt, meter, samma som GLB-filerna):

| Fält | Innehåll |
|---|---|
| `proxy`, `nverts` | proxyns namn (female1605/male1591) och antal hörn (efter uppdelning och glesare händer) |
| `faces` | trianglarna, index i hörnen (platt lista, tre per triangel) |
| `base_rest` | hörnen i vila före ändringarna (platt x, y, z) |
| `offsets` | de ändringar som är inlagda nu (samma form; nollor om inga) |
| `rest` | `base_rest + offsets`: figuren som den byggdes, i vila |
| `pose` | samma hörn i inpassningens pose (AI-formens pose), som `<namn>_pose.glb` |
| `pose_to_rest` | per hörn en 3x3-matris (9 tal, rad för rad): en förflyttning `d` i posen blir `M @ d` i vilan |

Hörnordningen är bygget eget, inte GLB-filens (glTF delar hörn vid UV-sömmar). Rita och redigera därför på `faces` och
`rest`/`pose` ur den här filen, inte på GLB:n.

## Ändringsfilen (skrivs av editorn)

`{"proxy": "female1605", "nverts": 5319, "offsets": [x, y, z, ...]}`: förflyttning per hörn i vila, glTF-rummet. En
dragning i posen räknas om med `pose_to_rest` innan den sparas. Filen läggs i receptet som `"edits": "<sökväg>"`
(relativt projektet). Stämmer inte `proxy` eller `nverts` hoppas ändringarna över, och bygget säger det
(`sliders.edits` i svaret).

Spara varje version i en ny fil (skriv aldrig över), till exempel `build/human/edits/<namn>_v<n>.json`, och bygg till
ett nytt namn.

Prov 2026-11-10: nästippen på `syssling_wrap16` 6 mm framåt i posen gav 6,0 mm i vila och i pose, inga andra hörn rörde
sig.
