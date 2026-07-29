// shareDemo.js — every card shape, in both layouts.
// Run: node shareDemo.js
import { buildShareCard } from './shareCard.js';

const cases = {
  'SPREAD · two of three landed': {
    before: 50, after: 128, mode: 'spread', daringness: 0.82,
    bets: [
      { kind: 'side', pick: 'Heads', won: true },
      { kind: 'orient', quadrants: ['NE'], won: false },
      { kind: 'spins', line: 10, lineMode: 'exact', won: true },
    ],
  },
  'RIDE · the whole board landed': {
    before: 50, after: 6400, mode: 'ride', daringness: 0.93,
    bets: [
      { kind: 'side', pick: 'Heads', won: true },
      { kind: 'orient', quadrants: ['NE'], won: true },
      { kind: 'spins', line: 10, lineMode: 'exact', won: true },
    ],
  },
  'SPREAD · safe board, wide calls': {
    before: 1000, after: 1390, mode: 'spread', daringness: 0.42,
    bets: [
      { kind: 'side', pick: 'Tails', won: true },
      { kind: 'orient', quadrants: ['NE', 'SE', 'SW'], won: true },
      { kind: 'spins', line: 5, lineMode: 'gt', won: false },
    ],
  },
  'SPREAD · wipeout': {
    before: 120, after: 0, mode: 'spread', daringness: 0.58,
    bets: [
      { kind: 'side', pick: 'Tails', won: false },
      { kind: 'orient', quadrants: ['SE', 'SW'], won: false },
      { kind: 'spins', line: 12.5, lineMode: 'lt', won: false },
    ],
  },
  'THE EDGE · 1 in 500': {
    before: 50, after: 24950, mode: 'spread', daringness: 0.97,
    bets: [{ kind: 'side', pick: 'Edge', won: true }],
  },
  'RIDE · missed': {
    before: 300, after: 0, mode: 'ride', daringness: 0.71,
    bets: [
      { kind: 'side', pick: 'Heads', won: true },
      { kind: 'spins', line: 16, lineMode: 'gt', won: false },
    ],
  },
  'CLEANED · back into the game': {
    before: 0, after: 47, mode: 'clean', daringness: 0.24,
  },
};

for (const [name, r] of Object.entries(cases)) {
  console.log('\n############ ' + name + ' ############');
  console.log(buildShareCard(r));
}

// The columns layout, monospace only — see shareCard.js's header for why it is
// not the default.
console.log('\n\n############ COLUMNS layout (monospace destinations only) ############');
console.log(buildShareCard(cases['SPREAD · two of three landed'], { layout: 'columns' }));
