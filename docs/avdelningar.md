# Plan: Asset Studios avdelningar

Skriven 2026-10-26. Studion har vuxit från en trädstudio till flera arbetsflöden: att bygga ett träd, måla ett material, ställa in ett oväder och göra en trollformel är olika sätt att arbeta. Därför delas den i fyra verkstäder och ett storbibliotek, var och en med eget namn, underrubrik och accentfärg ovanpå det ljusa eller mörka temat.

Appen är på engelska (planerna och dokumenten på svenska). Namnen i appen står inom parentes.

| Avdelning (i appen) | Innehåller | Underrubrik i appen | Accent | Plan |
|---|---|---|---|---|
| **Smedjan** (The Forge) | Träd, Buske, Sten, Prop, Byggnad, Växt, Karaktär | Build assets from recipes | Grön (träd och gräs) | [asset-studio.md](asset-studio.md) |
| **Väderkvarnen** (The Windmill) | Vind, Vatten, Väder | Wind, water and weather | Blå | [effektlabb.md](effektlabb.md) |
| **Ateljén** (The Atelier) | Texturverkstaden, materiallabbet | Paint materials and textures | Guld | [texture-workshop.md](texture-workshop.md) |
| **Häxkitteln** (The Cauldron) | Glöd och aura, Markörer, Partiklar, Spår och träffar | Spells and game effects | Lila | [effektlabb.md](effektlabb.md) |
| **Skattkammaren** (The Vault) | Allt som sparats, alla typer (familjer, fasta modeller, texturer, recept) | Everything you have saved | Neutral (hör till alla) | [asset-studio.md](asset-studio.md) |

Tinkertown är världen där allt används; den är en egen app.

## Landningssidan

Studion öppnar på en landningssida: en illustration per avdelning i dess färg, namnet, underrubriken och en mening om vad man gör där, plus genvägar till det senast öppnade. Ett klick tar en till avdelningen; märket i headern tar en tillbaka. Illustrationerna görs med en bildmodell via OpenRouter (`tools/texture/openrouter_image.py`) eller Krea-2 och ligger i `studio/img/`.

## Headern

- Vänster: märket och "Asset Studio", sedan avdelningen och underrubriken (*Väderkvarnen · Vind, vatten och väder*).
- Avdelningsväljaren: Smedjan, Väderkvarnen, Ateljén, Häxkitteln och Skattkammaren.
- Andra raden: avdelningens flikar.
- Accenten (`--accent` per avdelning, justerad för kontrast i båda temana) syns i en tunn linje under headern, märket, primärknapparna, spakarna och vald flik. Ytorna är desamma överallt, så att det är en app.

## Lådan (som Content Drawer i Unreal)

Varje flik har en låda med den typ av tillgångar den arbetar med: Träd visar trädfamiljer och fasta träd, Vatten vattentyper, Partiklar partikelrecept, Texturer material och texturer. Ett klick laddar in saken i scenen; därifrån finns Spara som ny, Frys, Varianter och **Visa i Skattkammaren**. Texturverkstadens bibliotek till vänster (Material, Texturer, Filter, Mina) är mallen. Lådan ligger till vänster i alla avdelningar, kan fällas ihop och öppnas och stängs med Ctrl+Mellanslag.

**Mönstret i alla vyer (Patrik 2026-10-27):** huvudsaken till vänster, mallarna (ritningarna) man utgår från; justeringarna till höger, där man också sparar en ny produkt. Lådan har *Ready-made* (mallarna) och *Saved* (det man sparat), och varje mall har en egen ikon (`assets/icons/<område>/<id>.png`, ritade av gpt-image-2 med `tools/icons/make_icons.py`, recepten i `tools/icons/icons.json`). En sparad produkt minns mallen den byggdes från (`from`) och får dess ikon. Panelen till höger har spakarna och sist kortet Save. Det som bara är provplatsen och inte sparas (vattnets fyra scener, himlen i Vatten-fliken, arenans vy i Häxkitteln) hör inte till mallarna: scenerna väljs i en rad ikonknappar överst i bilden (`.stagebar`), inställningar för vyn är kort till höger. Nya mallar får en ikon genom en rad i `icons.json` och en körning av verktyget.

Byggt (A3): Smedjans låda (`studio/drawer.js`) visar bibliotekets familjer och fasta modeller av flikens typ; ett klick öppnar familjen med spakarna (en fast modell tinas), och Vault visar den i Skattkammaren. Ateljéns låda är texturverkstadens bibliotek; under Mine har varje sparat material Vault. Skattkammaren har kategorin Materials med Ateljéns sparade material (`assets/textures/catalog.json`) och Open in The Atelier, och dess sidopanel är dess låda. Knappen längst till vänster i flikraden och Ctrl+Mellanslag fäller ihop lådan; läget sparas per avdelning i webbläsaren. Miniatyrer som saknas renderas i lådan med studions material, utan skuggformen.

## Länkar mellan avdelningarna

Det en annan avdelning äger öppnas där: trädets bark i Ateljén, trädets vindprofil i Väderkvarnen, allt sparat i Skattkammaren. Färgen byts, så man ser vart man går.

## Korsbefrukning mellan avdelningarna

Önskat av Patrik 2026-10-27. Utöver länkarna ovan ska en avdelnings saker gå att prova i en annans scen, för att se hur de fungerar tillsammans (bara för prov; inget sparas i den andra avdelningen).

- **Häxkittelns verktygslåda i Väderkvarnen:** en liten låda med snabbknappar, en per besvärjelse (färdiga och sparade), i Vind-fliken och Väder-fliken. Man väljer en effekt och klickar i gräset eller på marken, och den spelas upp där med samma `shared/effects/spells.js` och samma recept som i Häxkitteln (kastaren är kameran eller en punkt bredvid, målet är klicket). Lådan går att fälla ihop och stör inte Väderkvarnens egen låda.
  **Byggt 2026-10-27** (`studio/fxtoolbox.js`, i Vind- och Väder-flikarna): lådan nederst i vyn har de fristående effekterna, alltså besvärjelser vars lager bara använder marken, himlen och platsen (Thunderbolt, Meteor, Campfire, Arcane och Void portal; vilka som räknas avgörs av fästpunkterna), alla partiklar och alla markörer, färdiga och sparade. Man väljer en knapp, och pekaren får en AOE-ring på marken i effektens färg och storlek (markörens radie, besvärjelsens område eller utsändaren; en djupdekal utan lutningsmask, så att den syns i gräset) som visar var effekten hamnar; ett klick placerar den där. Högst åtta effekter åt gången, Clear tar bort dem. Vind-fliken ritar sedan dess genom ett scenpass med 4× MSAA i stället för direkt på duken, så att djupbufferten går att läsa (djupdekalerna var annars tomma där). För att inget ska rycka: den första instansen av en effekt byggs och kompileras uttonad när man väljer knappen ("Brewing…"); effekten byggs vid origo i en grupp som flyttas dit man klickar, och färdiga effekter går tillbaka till en pool och återanvänds. Effekternas egna ljus tas ur scenen och styr i stället fyra gemensamma punktljus (de starkaste just då), så att antalet ljus aldrig ändras och gläntans gräs och träd aldrig kompileras om. Uppmätt i gläntan: att välja fyra effekter 0,33 s (var 3,1 s), att klicka ut dem utan ryck (101 fps), en andra kopia medan den första pågår 0,17 s (var 3,3 s). Partiklarna drivs av gläntans vind. Kvar: kastare och figur för de andra besvärjelserna, och punkterna nedan.
- **Effekterna och gräset:** träffar ger en kort tryckvåg i det gemensamma vindfältet (`wind.js`), så att stråna lägger sig i en ring som vidgas och reser sig igen; ljusen från träffen lyser upp ängen. Markeffekterna (djupdekaler) maskas mot gräset, så att brännmärken och spår hamnar på marken och inte på strånas toppar, eller får ett eget utseende där (brända strån).
- **Prestanda:** mät bildtiderna med gläntans cirka 300 000 strån plus besvärjelsernas partiklar och lager, på båda grafikkorten.
- **Fler korsningar senare:** Ateljéns material på arenans mark i Häxkitteln, Väderkvarnens väderlägen (ljus och dis) i Häxkittelns arena, och Smedjans modeller som mål för effekterna.

## Faser

| Fas | Innehåll | Klart när |
|---|---|---|
| A1. Landningssidan | Illustrationer, kort per avdelning, märket tar en tillbaka; befintliga vyer (trädstudion, texturverkstaden, biblioteket) nås därifrån | Studion öppnar på en sida som visar vad den kan |
| A2. Headern och färgerna | Avdelningsväljaren, underrubriken, flikarna i en andra rad, accent per avdelning | Man ser alltid vilken avdelning man är i  (byggd 2026-10-26) |
| A3. Lådorna | Låda per flik med rätt typ, Visa i Skattkammaren, Ctrl+Mellanslag | Det man arbetar med finns alltid ett klick bort (byggd 2026-10-26) |
| A2b. Engelska | All text i appen på engelska: studio/, spakarna i params.json och workshop.json, biblioteket, felmeddelanden som visas | Appen är på engelska rakt igenom |
| A4. Väderkvarnen och Häxkitteln | Flikarna enligt effektlabb.md | Alla fyra verkstäder är i bruk |
| A5. Korsbefrukning | Häxkittelns verktygslåda i Väderkvarnen (snabbknappar, klicka i gräset; byggd 2026-10-27), tryckvåg i vindfältet, markeffekter maskade mot gräset; senare Ateljéns material och väderlägen i arenan | Effekterna provas i gläntan bland gräs, träd och vind |
