// A scripted playthrough: a new player from 0, through the free bet, into real
// betting, showing the loop + share card each day.
import { playDay, resolveFlip, SPIN_MIN, SPIN_MAX, OU_LINE } from './game.js';
import { buildShareCard } from './shareCard.js';
import { randomBytes } from 'node:crypto';

const seed = () => randomBytes(16).toString('hex');
let player = { balance: 0, history: [], daringness: undefined };

function show(label, out) {
  console.log(`\n===== ${label} =====`);
  console.log(`start face shown: ${out.flip.startFace}  ->  landed ${out.flip.side}, ${out.flip.spins} half-flips`);
  console.log(`bankroll: ${out.startBalance} -> ${out.endBalance} ₿`);
  const card = buildShareCard({
    before: out.startBalance || 1, after: out.endBalance,
    side: out.flip.side, rotations: out.flip.spins,
    daringness: out.player.daringness,
    bets: out.resolved.map((r) => ({
      kind: r.kind === 'exactSpin' ? 'exactRot' : r.kind,
      side: r.side, rotations: r.spins, overUnder: r.overUnder, line: r.line,
      parity: r.parity, bracket: r.bracket, won: r.won,
    })),
  });
  console.log('--- share card ---');
  console.log(card);
}

// Day 1: broke -> free heads/tails bet
let out = playDay(player, [{ kind: 'side', side: 'Heads' }], seed());
player = out.player;
show('DAY 1 — free bet (broke mode)', out);

// If the free bet lost, keep flipping free until we have seed money
let d = 1;
while (player.balance === 0 && d < 6) {
  d++;
  out = playDay(player, [{ kind: 'side', side: 'Tails' }], seed());
  player = out.player;
  show(`DAY ${d} — free bet again`, out);
}

// Now with ~50, place a modest spread
out = playDay(player, [
  { kind: 'side', side: 'Heads', stake: 20 },
  { kind: 'overUnder', overUnder: 'under', line: OU_LINE, stake: 15 },
], seed());
player = out.player;
show(`DAY ${d + 1} — first real bets`, out);

// A daring day: a Called Shot
out = playDay(player, [
  { kind: 'calledShot', side: 'Tails', spins: 22, stake: Math.min(30, player.balance) },
], seed());
player = out.player;
show(`DAY ${d + 2} — called shot swing`, out);
