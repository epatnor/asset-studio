# Kunskapsloopen

Hur externa tips (videor, artiklar, rapporter från andra AI:er) blir förbättringar i generatorerna
utan att någon gör något för hand.

1. **Rapport** i `knowledge/reports/<datum>-<ämne>.md`: tekniker, parametrar, källa.
2. **Karta** i `knowledge/cards/<område>/_generator_map.md`: varje teknik mot nuvarande kod
   (finns, delvis, saknas), med fil och rad.
3. **Kort**, ett per teknik, i `knowledge/cards/<område>/<id>.md` (format nedan).
4. **Ett kort i taget** på en egen gren `recipe/<id>`, bakom en parameter i artdata eller `tools/style.json`
   (av som standard tills det är godkänt). Bevis: `checks.ok`, siffror ur data, och ett nedskalat
   före/efter-kontaktark.
5. Patrik godkänner; parametern blir standard och kortets status `adopted` (eller `rejected` med skäl).

## Kortformat

```markdown
---
id: <kort-id, samma som grenen recipe/<id>>
area: trees
technique: <nummer i rapporten>
status: untested | implemented | adopted | rejected
priority: high | medium | low
source: knowledge/reports/<rapport>.md
---
# <Titel>

**Läge:** vad generatorn redan gör, med filhänvisningar.
**Idé:** tekniken i en eller två meningar, översatt till vår stack (Three.js, glTF).
**Ändring:** vad som ska byggas och var.
**Parametrar:** nya nycklar i `species.json` / `tools/style.json`, med standardvärde som behåller dagens utseende.
**Test:** hur det kontrolleras med kod först, och vilket kontaktark som behövs.
**Risker:** kostnad i skogen, saker som kan gå sönder.
```

`implemented` betyder att tekniken redan finns i generatorn; kortet dokumenterar då bara var och hur.
