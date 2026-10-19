// Banorna i Tinkertown: menyn listar dem här. Ren klientkod (ingen Node).
// accent och sky ger kortets färger; desc är en mening om vad banan är; soon = visas men går inte att välja än.
export const LEVELS = [
  { id: 'azshara', name: 'Azshara Island', url: 'azshara.html', desc: 'Två öar i havet: by, bäck, sjö, stenbro och den mörka ön i väster.', accent: '#E8B04A', sky: ['#2E5E9E', '#F2C27A'], soon: true },
  { id: 'skogen', name: 'Skogen', url: 'skogen.html', desc: 'Tät granskog med stig, gläntor och ormbunkar. Kan göras 4× och 16× större.', accent: '#7FC25A', sky: ['#245A3A', '#9FD27A'] },
  { id: 'parken', name: 'Parken', url: 'park.html', desc: 'Generatorernas träd, buskar och blommor i en liten park med damm och bäck.', accent: '#9AD15A', sky: ['#3B7A4A', '#CDE89A'] },
  { id: 'vattnet', name: 'Vattnet', url: 'water.html', desc: 'Vattengeneratorns typer på en kust: hav, flod, å, bäck, sjö och damm.', accent: '#5FD3C8', sky: ['#1D5A7A', '#8FE0D8'] },
  { id: 'byggnader', name: 'Byggnader', url: 'byggnader.html', desc: 'Byggnadsgeneratorns hus på rad: stugor, värdshus, torn och stadshus.', accent: '#E0905A', sky: ['#5A3A2E', '#F0C090'] },
  { id: 'raderna', name: 'Raderna', url: 'index.html', desc: 'Allt generatorerna har gjort, på rader, med skyltar.', accent: '#B8A0E8', sky: ['#3A3060', '#C8B8F0'] },
];
