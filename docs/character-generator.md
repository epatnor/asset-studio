# Plan: karaktärsgeneratorn (`tools/character/`, MCP `create_character`)

Samma mönster som trädgeneratorn: ett skelett först, allt annat byggs från skelettet. Recept in, glTF ut, en rad JSON med kontroller. Arketyper och proportioner är data (`characters.json`, redan skapad: hero, dwarf, kid, elder, merchant, goblin).

## 1. Skelett och proportioner
- Humanoidskelett med standardnamn: Hips, Spine, Chest, Neck, Head, Left/Right Shoulder, UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot, Toe. Vänster = +X, karaktären tittar mot +Z, y uppåt, meter.
- Bindpose i A-pose (armarna cirka 40° från lodlinjen), som ger bättre skinning i armhålorna än T-pose.
- Ledernas lägen räknas ur arketypens multiplikatorer (height, head, build, shoulders, belly, hands, feet, legs, neck, hunch), med lite variation per seed (±4–6 %).
- Stiliserat enligt stilguiden: större huvud, händer och fötter, chunky former.

## 2. Kropp som avståndsfält
- Mjuk union (polynomisk smooth-min, olika k per region) av rundade koner för lemmar och ryggrad, och ellipsoider för bröst, mage, bäcken, huvud, haka, näsa, öron, händer (vante plus tumme) och fötter.
- Platt sula: fältet skärs vid y = 0, så fötterna står på marken.
- Mesh med `surfaceNets` från `tools/tree/crown.mjs`, sedan ett Newtonsteg mot ytan och normaler ur fältets gradient. LOD0 cirka 2 cm cell, LOD1 cirka 3,5 cm.
- Budget: 30 000–60 000 trianglar (style.json, character).

## 3. Kläder, ansikte och hår
- Kläder som regioner i fältet: tröja (bröst, mage, axlar, ärmar till `sleeves`), byxor (bäcken, ben till `pants`), skor (fötter). Kläderna blåses upp några millimeter, så att ärm- och byxkanter syns som ett steg.
- Färg per hörn efter region (närmaste primitiv), färger ur arketypens listor med seed. Två material som delar hörnen: Skin och Cloth (olika roughness), så att det inte blir sprickor.
- Ögon: egna sfärer (vitt och pupill), stora och stiliserade, delvis inbäddade i ansiktet. Ögonbryn i hårfärg.
- Hår som eget fält: huvudet uppblåst och avskuret vid hårfästet, plus stil (short, spiky, bob, bun, long, bald) och lågfrekventa klumpar. Skägg (beard 0–1) i samma mesh.

## 4. Skinning och animation
- Vikter automatiskt: varje hörn får sin primitivs ben och dess grannben som kandidater (så att ett ben aldrig påverkar det andra), med mjuk avståndsviktning mot bensegmenten, högst 4 vikter. Hår, ögon och skägg: 100 % Head.
- glTF-skin med inverse bind matrices (lederna har bara translation i bindpose).
- Genererade klipp i filen: `idle` (andning, lätt svaj, armarna sänkta) och `walk` (cykel på 1 s: ben, knän, fötter, armar i motfas, höftguppning och rotation). Gånghastigheten sparas i extras, så att klienten kan flytta karaktären i takt med stegen.

## 5. Kontroller (`checks.ok`)
- Fötterna på marken, symmetri i x, alla hörn viktade (summa 1), ögonen sitter i ansiktet, klippen `idle` och `walk` finns, inom budget.

## 6. Klienten
- `world.js` och radsidan spelar upp `idle` med AnimationMixer; kloner görs med SkeletonUtils.clone.
- Parken: några karaktärer går längs stigarna med `walk`, i takt med den sparade hastigheten.
- Komprimering som de andra (meshopt); JOINTS och WEIGHTS lämnas okvantiserade.

## 7. Stilreferens med Apparition
- Board "A Testboard" (`untitled-board`) har gruppen "Stylized female fantasy characters" med en utförlig stilbeskrivning (painterly, cirka 8 huvuden, smal midja, stora mandelögon, rim light, dämpade basfärger med en mättad accent).
- Vår stilguide säger Fortnite/Overwatch med kortare, chunky proportioner. Bestäm vilken som ska gälla, eller gör två arketypfamiljer (chunky och elongerad).
- Arbetsflöde: rendera en lineup (LOD0, standardljus), lägg in den i Apparition med `add_image`, kör `compare` mot gruppen och justera arketyperna efter avvikelserna (mättnad, kontrast, värme). Arketypernas färglistor kan hämtas ur `get_style`-paletten.
- Apparitions verktyg laddas bara i en ny session (servern lades till efter att den här startade).

## Ordning
1. Skelett, kroppsfält och mesh för `hero`; kontroll av fötter och symmetri.
2. Kläder, ansikte, hår; alla arketyper.
3. Skinning och klippen; uppspelning i en lineup-sida under `build/`.
4. make-skript, MCP-verktyg, katalograd; stilgranskning mot Apparition.
5. Parken: gående karaktärer.

Senare: fler frisyrer och kläder (kjol, rock, hatt), utrustning som separata delar, ansiktsuttryck, fler klipp (spring, hopp, vinka), och import av externa animationer till samma skelett.
