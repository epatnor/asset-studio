# Azshara Island i Tinkertown

Azshara Island var ett fristående prototypprojekt i Godot (`~/Spelutveckling/azshara-island`, 2026-10-12–13). Den 2026-10-19 slogs det ihop med Tinkertown som banan **Azshara Island** (`showcase/azshara.html`), och det fristående projektet togs bort.

Det här finns kvar från det:

| Fil | Vad |
|---|---|
| `design.md` | Projektets CLAUDE.md: spelidé, zoner (lummig huvudö, höst västerut, den mörka ön), art direction |
| `plan.md` | Arbetsordningen och vad som gjordes steg för steg |
| `designprinciper.md` | Patriks designprinciper |
| `foliage_notes.md`, `shore_and_water_notes.md`, `visual_references.md` | Anteckningar om växtlighet, strand och vatten, och referenserna (WoW, Valheim) |
| `../../tools/levels/azshara/terrain_generator.gd` | Terränggeneratorn (GDScript) som formade öarna, med sina kontroller |
| `../../tools/levels/azshara/export_from_godot.gd` | Exporten som bakade terrängen till `assets/levels/azshara/` |
| `../../tools/levels/azshara/bake_level.py` | Omvandlingen till banans filer (höjder som uint16, masker som PNG, platser som JSON) |

Det som flyttades in i Tinkertown:

- **Terrängen** (höjder, zoner, stig, bäck, sjö, strand, klippor, tomter) är bakad ur Azsharas generator. Allt ovanpå kommer från generatorerna i Azshara Asset Studio: träd och växter (även höstträd för den västra zonen), husen från byggnadsgeneratorn (fantasy, WoW) på Azsharas tomter, och vattnet från vattengeneratorn. Bron, lyktstolparna och bryggan är Azsharas egna modeller, importerade med `import_model`.
- **Atmosfären** (`showcase/atmosphere.js`) gäller alla banor: himmel med sol- och månskiva, stjärnor och volymetriska moln, tid på dygnet, dimma, regn, snö, storm med blixtar och färgton. På Azshara stormar det över den mörka ön, som i originalet.

- **Effekterna** (`showcase/effects.js`, 2026-10-20) gäller också alla banor: volymetriskt solljus genom diset (läser solens skuggkarta, så strålar bildas genom kronor, hus och bro), ljusstrålar mellan kronorna, glöd (bloom) och vinjett, dimma som blir varm åt solen, markdimma i den mörka öns sänkor, molnskuggor som driver över landskapet, stoftkorn som glimmar i motljus och regnstänk. Tända fönster och lyktor lyser starkare i mörker. Vattenfallet ner i sjön finns också.

Inte överfört än: stenblocken från bron i vattnet, istappar i snö, vindstreck på skärmen i storm och minikartan.
