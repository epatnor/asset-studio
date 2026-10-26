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

## Länkar mellan avdelningarna

Det en annan avdelning äger öppnas där: trädets bark i Ateljén, trädets vindprofil i Väderkvarnen, allt sparat i Skattkammaren. Färgen byts, så man ser vart man går.

## Faser

| Fas | Innehåll | Klart när |
|---|---|---|
| A1. Landningssidan | Illustrationer, kort per avdelning, märket tar en tillbaka; befintliga vyer (trädstudion, texturverkstaden, biblioteket) nås därifrån | Studion öppnar på en sida som visar vad den kan |
| A2. Headern och färgerna | Avdelningsväljaren, underrubriken, flikarna i en andra rad, accent per avdelning | Man ser alltid vilken avdelning man är i  (byggd 2026-10-26) |
| A3. Lådorna | Låda per flik med rätt typ, Visa i Skattkammaren, Ctrl+Mellanslag | Det man arbetar med finns alltid ett klick bort |
| A2b. Engelska | All text i appen på engelska: studio/, spakarna i params.json och workshop.json, biblioteket, felmeddelanden som visas | Appen är på engelska rakt igenom |
| A4. Väderkvarnen och Häxkitteln | Flikarna enligt effektlabb.md | Alla fyra verkstäder är i bruk |
