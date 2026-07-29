// brokeDemo.js — the RECOVERY card: what you get for cleaning a coin back into
// the game from 0 B.
//
// It has NO multiplier, and that is the whole reason it is a separate shape.
// You came from zero, so after/before divides by zero and any "x" figure is a
// fiction. The old free-flip card forced this through the profit template and
// printed exactly that fiction — logged in the README as a known defect.
//
// Run: node brokeDemo.js
import { buildShareCard } from './shareCard.js';

console.log('===== CLEANED, barely scrubbed =====');
console.log(buildShareCard({ mode: 'clean', before: 0, after: 41, daringness: 0.12 }));

console.log('\n===== CLEANED, a thorough job =====');
console.log(buildShareCard({ mode: 'clean', before: 0, after: 60, daringness: 0.44 }));

console.log('\n===== the SUPERSEDED mode name still lands on the right card =====');
console.log(buildShareCard({ mode: 'brokeFlip', before: 0, after: 50, daringness: 0.3 }));

console.log('\n===== a real flip, for contrast =====');
console.log(buildShareCard({
  before: 50, after: 128, mode: 'spread', daringness: 0.8,
  bets: [
    { kind: 'side', pick: 'Tails', won: true },
    { kind: 'spins', line: 11, lineMode: 'exact', won: true },
  ],
}));
