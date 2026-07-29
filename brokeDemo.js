import { buildShareCard } from './shareCard.js';

console.log('===== BROKE FLIP — WON =====');
console.log(buildShareCard({ mode: 'brokeFlip', before: 0, after: 50, pick: 'Tails' }));

console.log('\n===== BROKE FLIP — LOST =====');
console.log(buildShareCard({ mode: 'brokeFlip', before: 0, after: 0, pick: 'Heads' }));

console.log('\n===== NORMAL DAY (unchanged) =====');
console.log(buildShareCard({
  before: 10, after: 100, side: 'Tails', rotations: 22, daringness: 0.8,
  bets: [{ kind: 'exactRot', rotations: 22, won: true }],
}));
