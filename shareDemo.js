import { buildShareCard } from './shareCard.js';
const cases = {
  "MOCKUP (gold, exact spin hit)": {
    before: 10, after: 100, daringness: 0.82,
    bets: [
      { kind: 'exactRot', rotations: 9, won: true },
      { kind: 'overUnder', overUnder: 'under', line: 10, won: true },
      { kind: 'table', table: 'E', won: false },
    ],
  },
  "CALLED SHOT (gold, exact)": {
    before: 1200, after: 8400, daringness: 0.8,
    bets: [ { kind: 'calledShot', side: 'Tails', rotations: 14, won: true } ],
  },
  "SAFE DAY (silver, all soft)": {
    before: 1000, after: 1453, daringness: 0.55,
    bets: [
      { kind: 'side', side: 'Heads', won: true },
      { kind: 'overUnder', overUnder: 'under', line: 12.5, won: true },
      { kind: 'parity', parity: 'even', won: false },
    ],
  },
  "GRINDER (copper)": {
    before: 1000, after: 1205, daringness: 0.15,
    bets: [ { kind: 'side', side: 'Heads', won: true } ],
  },
  "LOSS (copper)": {
    before: 2000, after: 900, daringness: 0.58,
    bets: [
      { kind: 'side', side: 'Tails', won: false },
      { kind: 'exactRot', rotations: 13, won: false },
    ],
  },
};
for (const [name, r] of Object.entries(cases)) {
  console.log('\n############ ' + name + ' ############');
  console.log(buildShareCard(r));
}
