# Bildbedömare: vilken modell bedömer texturer som Patrik? (2026-11-09)

Test: `build/judges/run_judges.py` (resultat i `build/judges/results.json` och `summary.json`). Sju jämförelser där Patrik har
sagt vilken textur som är bättre. Varje modell får båda texturerna från samma kameravinklar (renderade platt i Blender:
helfigur, ansikte och bröst för Maren, rygg och toga för statyn) och referensen. Båda ordningarna (A/B och B/A) ställs, så att
en modell som alltid väljer A inte får poäng. Instruktionen ber om detaljer, fläckar, färgläckage, inbakade skuggor och
trohet mot referensen.

| Modell | Rätt (av 14) | Fall rätt i båda ordningarna (av 7) | USD för 14 frågor | s per svar |
|---|---|---|---|---|
| anthropic/claude-haiku-5.5 | 12 | 5 | 0,007 | 3,6 |
| z-ai/glm-5.3-flash | 11 | 5 | 0,010 | 12,6 |
| google/gemini-3.8-flash | 11 | 4 (väljer A 10 av 14) | 0,093 | 5,6 |
| anthropic/claude-sonnet-5.5 | 10 | 5 | 0,109 | 2,8 |
| google/gemini-4-argon | 10 | 5 | 0,214 | 9,2 |
| openai/gpt-6.1-sol | 10 | 4 | 0,102 | 4,1 |
| openai/gpt-6-luna | 10 | 4 | 0,002 | 6,3 |
| qwen/qwen3.8-flash | 9 (av 12 svar) | 4 | 0,006 | 16,3 |
| deepseek/deepseek-v4.1-flash-1017 (granskar i dag) | 8 (av 12 svar) | 3 | 0,007 | 6,3 |

Per fall:

| Fall (Patriks facit först) | Utfall |
|---|---|
| Statyn steg 4000 mot 6000 | nästan alla rätt |
| Statyn 9B mot steg 10000 | alla rätt |
| Maren steg 8000 mot 2000 och mot 4000 | alla rätt (DeepSeek missar en) |
| Maren 12 vinklar mot 6 | nästan alla rätt |
| Maren bas-dekodern (rå, mörkare och fylligare) mot forskarnas | **nästan alla fel**: modellerna föredrar den ljusare, som ligger närmare referensens ljushet. Det är en smakfråga (fylligare färger, fräknar) som måste stå som kriterium om en modell ska döma så |
| Maren fläckfri bakning mot den med fläckar vid näsa och tinning | **nästan alla fel**: små fläckar i ansiktet ser ingen modell säkert, inte ens på närbilden |

**Slutsatser:**
- Med bara sju fall är skillnaderna mellan modellerna små och osäkra. Grova kvalitetsskillnader klarar även de billiga,
  små fläckar klarar ingen. Fläckar mäts bättre med verktyg (`detail_score.py`, `coverage.py`) eller närbilder i högre
  upplösning.
- DeepSeek, som granskar i dag, kom sist och tappade svar (tänkte för länge för `max_tokens`).
- Claude Haiku 5.5 kom först, är snabb och kostar ungefär 0,0005 USD per jämförelse, i samma storleksordning som DeepSeek.
  De dyra modellerna (Sonnet, Gemini 4 Argon, GPT-6.1 Sol) var inte bättre här.
- Förslag (Patriks beslut, det rör pengar om än lite): Haiku 5.5 som granskare i stället för DeepSeek, eller som andra
  åsikt när DeepSeek är osäker. Utöka facit med fler fall när Patrik bedömer något, så att testet blir säkrare.
