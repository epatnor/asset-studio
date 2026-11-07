# Operatören: en billig modell sköter körningarna

Patrik och Claude ska prata om riktning, stil och nya verktyg. Själva ruljansen ska skötas av en billig modell, DeepSeek
via OpenRouter, samma modell som redan granskar: köra beställningar, läsa granskningen, ta om med andra värden och sortera
resultaten. Det gäller Asset Studio, body-gen och Darrowmere på samma sätt, eftersom alla går via beställningar till runnern
(`tools/darrowmere/runner/`).

## Arbetsfördelning

| Vem | Gör |
|---|---|
| **Patrik** | Bestämmer vad som ska göras och hur det ska se ut. Godkänner betalda steg. Säger ja eller nej till resultat. |
| **Claude** (dyr, sällan) | Bygger och rättar verktyg, skriver spelböcker, tar fall som spelboken inte täcker och förklarar varför något inte fungerar. |
| **Operatören** (DeepSeek, billig, ofta) | Kör en spelbok: lägger beställningar, läser granskningen, väljer nästa drag ur spelbokens meny och lämnar ett kort besked. |
| **Runnern** (vanlig kod) | Kör stegen, håller budgeten och godkännandena, renderar och sparar. Ingen AI i själva runnern. |

Grundregeln: operatören hittar aldrig på nya steg och läser aldrig kod. Den väljer bara ur en meny med avgränsade spakar.
Allt nytt går tillbaka till Patrik och Claude.

## Det som redan finns

- Verktygen tar ett recept (JSON) och svarar med en rad JSON. En liten modell klarar dem utan att läsa koden.
- Runnern kör beställningar med steg (comfy, script, blender, meshy3d, remesh, review), också när laptopen är stängd.
- Granskningen (`review`) ger nivå (pass, warning, fail), betyg 0–10, en sammanfattning, en lista med fel och en
  riggbedömning. Den ser en rundtur i Blender och nätets siffror.
- `retry` i ett granskningssteg kör om ett tidigare steg med nytt frö, högst `max` gånger.
- Budgeten per beställning och godkännandet av molnsteg ligger i Settings (`cloud_gate`).
- Panelen visar varje beställning, och galleriet visar allt som gjorts.

Det som saknas är att retry bara kan byta frö. Operatören ska kunna vrida på fler spakar, och den ska kunna ge upp och
fråga på ett ordnat sätt.

## Spelböcker

En spelbok är data, `tools/darrowmere/playbooks/<namn>.json`:

- **mall**: beställningen som ska köras, med platshållare för spakarna (som `make_sheet6_order.py` i dag skriver i kod).
- **spakar**: varje spak med namn, tillåtna värden eller gränser och en mening om vad den gör. Till exempel
  `sheet_denoise` 0,3–0,5 ("högre: Krea-2 målar friare, lägre: följer underlaget"), `seed`, `blend` best/stitch.
- **mål**: kriterierna som granskningen ska döma efter, och vilken nivå som räcker (till exempel pass med betyg minst 7).
- **drag**: kända åtgärder per typ av fel, som en tabell. "Fläckig hjässa" → nytt frö för arket eller lägre denoise.
  "Suddigt" → blend best eller stitch i stället för en blandning. Operatören väljer bland dragen och motiverar valet med en
  mening.
- **gränser**: högst antal varv, högst kostnad (krediter, minuter på Darrowmere) och vad som alltid kräver Patrik.

Spelböckerna skrivs av Claude, när ett verktyg har blivit stabilt, och uppdateras med det vi lär oss.

## Loopen

1. Patrik (eller Claude) startar en spelbok med ett mål: "textur på roboten, Krea-2:s look, utan skarvar".
2. Runnern lägger första beställningen ur mallen med spakarnas startvärden.
3. Efter granskningen frågar runnern operatören. Operatören får spelboken, alla tidigare varv (spakar, betyg och fel) och
   den senaste granskningen, och svarar med en rad JSON: `{"action": "retry", "levers": {...}, "why": "..."}`, `"done"`
   eller `"escalate"`.
4. Runnern kontrollerar svaret mot spelboken (bara tillåtna spakar och värden, inom budget) och kör nästa varv. Ett svar
   utanför spelboken blir `escalate`.
5. Varje varv syns i panelen som en egen beställning i samma kedja, med operatörens motivering.

## Eskalering

Operatören lämnar över till Patrik och Claude när

- målet är nått: ett kort besked med det bästa resultatet och länk i galleriet,
- varven eller budgeten tar slut, eller samma fel kommer tillbaka två varv i rad efter olika drag,
- ett drag kräver något som inte står i spelboken: ett nytt verktyg, en betald tjänst eller ändrad stil.

Beskedet är kort: vad som provades, vad som blev bäst, vilket fel som är kvar och vad operatören tror att det beror på.
Patrik och Claude pratar sedan om orsaken, inte om vilket frö som ska provas.

## Första spelboken: textur på figur

Texturflödet passar som första fall. Spakarna är tydliga och granskningen ger redan betyg.

- Mall: underlag (UltraTex eller Meshy) → sex vyer i ett ark med Krea-2 → förfining per vy → projicering → granskning.
- Spakar: `sheet_denoise` 0,3–0,5, `refine_denoise` 0,15–0,3, `seed`, `blend` best/stitch, `fill` baked/nearest,
  `bias` för sidvyerna 0,4–1,0.
- Mål: pass med betyg minst 7, inga anmärkningar på huvudet.
- Gränser: högst 6 varv, inga betalda steg utan Patrik.

## Steg för att bygga

1. Spelboksformatet och den första spelboken (textur på figur), med mallen flyttad ur `make_sheet6_order.py`.
2. `kind: "operator"` i runnern: frågar DeepSeek, kontrollerar svaret mot spelboken och lägger nästa varv.
3. Kedjan i panelen: varven efter varandra, med spakarna och motiveringen per varv, och beskedet överst.
4. Nästa spelböcker när verktygen är stabila: låg modell av hög (remesh och 4K-textur), kroppar i body-gen, träd och props
   i Asset Studio.
