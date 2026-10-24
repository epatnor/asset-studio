---
id: tree-impostors
area: trees
technique: 9
status: untested
priority: medium
source: knowledge/reports/2026-10-24-stylized-trees.md
---
# Avstånd: impostorer

**Läge:** LOD0–2 finns (bark utan yngsta grennivån, färre och större kort). `showcase/instancing.js` ritar en InstancedMesh per del och LOD i chunkar, med `lodDist = [25, 60, 160]`. Bortom 160 m ritas inga träd alls.
**Idé:** Rapportens MultiMesh = vår InstancedMesh (finns). Det som saknas är impostorer: en LOD3 som är ett eller några kort med förrenderad bild av trädet (oktaedrisk impostor eller korsade kort), så att skogen fortsätter till horisonten.
**Ändring:** Nytt steg i generatorn: rendera trädet från N vinklar till en atlas (färg + normal) med samma ljusmodell, skriv `_LOD3` med ett kort. Klienten: LOD3 i `instancing.js`, vänd mot kameran i vertexshadern.
**Parametrar:** `impostor: { views, size }` i receptet (standard av); `lodDist[3]` i klienten.
**Test:** Med kod: tris och draw calls per chunk. Kontaktark: samma träd LOD2 vs LOD3 på 160 m, och övergången.
**Risker:** Störst arbete av korten. Rendering till atlas måste ske utan webbläsare (Blender eller headless) för att följa verktygsmönstret. Popping vid övergången.
