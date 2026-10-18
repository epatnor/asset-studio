# Plan: karaktärsgeneratorn (`tools/character/`, MCP `create_character`)

Samma mönster som trädgeneratorn: ett skelett först, allt annat byggs från skelettet. Recept in, glTF ut, en rad JSON med kontroller. Arketyper och proportioner är data (`characters.json`: hero, heroine, dwarf, kid, elder, merchant, goblin). Stilen är halvrealistisk fantasy key art översatt till 3D; se stilguiden avsnitt 6 och `character` i `style.json`.

## 1. Skelett och proportioner
- Humanoidskelett med standardnamn: Hips, Spine, Chest, Neck, Head, Left/Right Shoulder, UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot, Toe. Vänster = +X, karaktären tittar mot +Z, y uppåt, meter.
- Bindpose i A-pose (armarna cirka 40° från lodlinjen), som ger bättre skinning i armhålorna än T-pose.
- Ledernas lägen räknas ur arketypens värden (height, heads, build, shoulders, waist, hips, belly, hands, feet, legs, neck, hunch), med lite variation per seed (±3–5 %). Huvudhöjden är height / heads.
- Eleganta, halvrealistiska proportioner: verklig anatomi med förskjutna förhållanden. Hjältar 7,5–8 huvuden, långa ben, V-form eller smal midja och bredare höfter; händer och fötter högst 10 % större än verkligt. Inte chunky, inte chibi.

## 2. Kropp som avståndsfält
- Mjuk union (polynomisk smooth-min, olika k per region) av rundade koner för lemmar och ryggrad, och ellipsoider för bröst, midja, mage, bäcken, huvud, käke, haka, kindben, näsa, öron, händer och fötter. Stora k där kroppen böjer (mjuka gradienter), litet k där plagg slutar (krispiga kanter).
- Händer: handflata, tumme och fingrar som två–tre sammansmälta grupper, inte en vante; halvrealismen kräver läsbara fingrar.
- Platt sula: fältet skärs vid y = 0, så fötterna står på marken.
- Mesh med `surfaceNets` från `tools/tree/crown.mjs`, sedan ett Newtonsteg mot ytan och normaler ur fältets gradient. LOD0 cirka 2 cm cell, LOD1 cirka 3,5 cm.
- Budget: 30 000–60 000 trianglar (style.json, character).

## 3. Kläder, ansikte och hår
- Kläder som regioner i fältet: tröja (bröst, mage, axlar, ärmar till `sleeves`), byxor (bäcken, ben till `pants`), skor eller stövlar (`boots`), bälte och bårder vid ärm- och fållkanter. Kläderna blåses upp 4–12 mm (`clothing_inflate_m`), så att kanterna syns som ett skarpt steg. Några få stora veck vid armbåge, knä och midja; ingen mikrodetalj.
- Färg per hörn efter region (närmaste primitiv), färger ur arketypens listor med seed. Basfärgerna är dämpade, och accentfärgen hamnar på exakt en region ur `accentOn`.
- Målad look i vertexfärgen: ljusare uppåt, AO i veck ur fältet (sampla fältet längs normalen), varmare hud vid öron, näsa, kinder och händer.
- Material som delar hörnen (inga sprickor): Skin, Cloth, Leather (skor, bälte), Hair, med roughness ur `style.json` (`character.materials`). Läder och hår är blanka med breda högdagrar.
- Ögon: egna delar, stora mandelformade (cirka 25 % större än verkligt, `eye_scale`), med iris i ögonfärg, pupill och en blank hornhinna som fångar högdager. Delvis inbäddade under ögonlocken. Ögonbryn i hårfärg.
- Hår som eget fält: stora klumpar som följer en flödesriktning från hårfästet, med fåror mellan klumparna, per stil (short, spiky, bob, bun, long, bald). Skägg (beard 0–1) i samma mesh.

## 4. Skinning och animation
- Vikter automatiskt: varje hörn får sin primitivs ben och dess grannben som kandidater (så att ett ben aldrig påverkar det andra), med mjuk avståndsviktning mot bensegmenten, högst 4 vikter. Hår, ögon och skägg: 100 % Head.
- glTF-skin med inverse bind matrices (lederna har bara translation i bindpose).
- Genererade klipp i filen: `idle` (andning, lätt svaj, armarna sänkta) och `walk` (cykel på 1 s: ben, knän, fötter, armar i motfas, höftguppning och rotation). Gånghastigheten sparas i extras, så att klienten kan flytta karaktären i takt med stegen.

## 5. Kontroller (`checks.ok`)
- Fötterna på marken, symmetri i x, alla hörn viktade (summa 1), ögonen sitter i ansiktet, klippen `idle` och `walk` finns, inom budget.
- Stil: uppmätt antal huvuden inom ±0,25 av arketypen, basfärger och accent enligt `character.colors` (kroma och värde), exakt en accentregion.

## 6. Klienten
- `world.js` och radsidan spelar upp `idle` med AnimationMixer; kloner görs med SkeletonUtils.clone.
- Karaktärsmaterialet får ett kantljus (fresnel, `character.rim`) via onBeforeCompile, så att figurerna lossnar från bakgrunden i världens ljus.
- Parken: några karaktärer går längs stigarna med `walk`, i takt med den sparade hastigheten.
- Komprimering som de andra (meshopt); JOINTS och WEIGHTS lämnas okvantiserade.

## 7. Stilreferens och konceptbilder
- Stilen är bestämd: halvrealistisk fantasy key art med eleganta proportioner (gruppen "Stylized female fantasy characters" på boarden `untitled-board` i Apparition). Världen förblir chunky; kontrasten är avsiktlig.
- Konceptbilder per arketyp med Krea-2: motivet först, sedan `prompt.character_art`, sist `prompt.character_remove` (vikter via Krea2PromptWeight i `krea2.py`). De används som referens för proportioner och färger, inte som texturer.
- Granskning: rendera en lineup (LOD0, standardljus plus motljuset `preview_backlight`), lägg in den i Apparition med `add_image`, kör `compare` mot gruppen och justera arketyperna efter avvikelserna.

## Ordning
1. Skelett, kroppsfält och mesh för `hero`; kontroll av fötter och symmetri.
2. Kläder, ansikte, ögon, hår, vertexfärg; alla arketyper.
3. Skinning och klippen; uppspelning i en lineup-sida under `build/`.
4. make-skript, MCP-verktyg, katalograd; stilgranskning mot Apparition.
5. Parken: gående karaktärer.

Senare: fler frisyrer och kläder (kjol, rock, hatt), utrustning som separata delar, ansiktsuttryck, fler klipp (spring, hopp, vinka), och import av externa animationer till samma skelett.
