// game.js — COINFLIP lite (text-only) core loop
// ---------------------------------------------------------------------------
// The playable economy prototype: no 3D, no orientation, no Edge. Just the two
// axes that matter for tuning — SIDE and SPINS — plus the free-bet broke mode.
// Purpose: feel out whether chip allocation is fun and whether the economy is
// balanced, BEFORE any renderer exists.
//
// Locked rules (from design):
//   - Start bankroll 0. At 0₿ you get a "Broke Flip": a FREE 50/50 heads-or-tails bet for 50₿.
//   - Spins are HALF-STEPS. Live counter would tick once per half-flip.
//   - Real-physics anchor: ~4–20 full rotations => 8–40 half-flips.
//   - Coin's starting face is RANDOM each day and SHOWN before the flip.
//     Landing side = start face flipped once per half-flip (parity of count).
//   - Per-player flips; outcome seeded uniform (identity is provenance only).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { computeDaringness, daringnessLabel } from './daringness.js';

// --- axis definition -------------------------------------------------------

export const SPIN_MIN = 8;    // half-flips (== 4 full rotations)
export const SPIN_MAX = 40;   // half-flips (== 20 full rotations)
export const SPIN_VALUES = []; // integer half-flip counts 8..40
for (let s = SPIN_MIN; s <= SPIN_MAX; s++) SPIN_VALUES.push(s);
const SPIN_N = SPIN_VALUES.length; // 33 possible outcomes

// The over/under line sits at the middle of the range.
export const OU_LINE = (SPIN_MIN + SPIN_MAX) / 2; // 24 half-flips

// Four brackets across the range for the "dozens"-style mid bet.
export const SPIN_BRACKETS = [
  { name: '8-15',  lo: 8,  hi: 15 },
  { name: '16-23', lo: 16, hi: 23 },
  { name: '24-31', lo: 24, hi: 31 },
  { name: '32-40', lo: 32, hi: 40 },
];

// --- payout table (SEEDED sketch values — the primary tuning knobs) --------
// EV is intentionally a hair player-positive so the population drifts richer.
// True odds noted; multiplier is what a winning stake returns (stake * mult).
export const PAYOUTS = {
  side:      2.05,   // 1 in 2
  overUnder: 2.05,   // 1 in 2 (line at 24)
  parity:    2.05,   // 1 in 2 (even/odd half-flips)
  bracket:   4.2,    // ~1 in 4 (8-value brackets vs 33 range; see note)
  exactSpin: 30.0,   // 1 in 33
  calledShot: 60.0,  // side + exact spin, ~1 in 66 (sweetened)
};

// Free-bet (broke mode) constants.
export const FREE_BET_RETURN = 50; // ₿ paid on a winning Broke Flip
export const BROKE_FLIP_NAME = 'Broke Flip';

// --- deterministic per-player daily outcome --------------------------------
function sha(s) { return createHash('sha256').update(s).digest('hex'); }
function big(hex, bits = 64) { return BigInt('0x' + hex.slice(0, bits / 4)); }

// Produces the day's flip: shown start face + landing side + half-flip count.
// seed should already fold identity+clock+salt (see identity.js). Here we take
// a resolved seed hex for determinism in the prototype.
export function resolveFlip(seedHex) {
  // start face: random, shown before flip
  const startHeads = (big(sha('start::' + seedHex), 8) % 2n) === 0n;

  // half-flip count: uniform over SPIN_VALUES
  const idx = Number(big(sha('spins::' + seedHex), 32) % BigInt(SPIN_N));
  const spins = SPIN_VALUES[idx];

  // landing side: each half-flip flips the face. parity of spins decides.
  // even half-flips -> same as start; odd -> opposite.
  const landsHeads = (spins % 2 === 0) ? startHeads : !startHeads;

  return {
    startFace: startHeads ? 'Heads' : 'Tails',
    side: landsHeads ? 'Heads' : 'Tails',
    spins, // half-flips
  };
}

// --- bet resolution --------------------------------------------------------
// A bet: { kind, stake, side?, overUnder?, parity?, bracket?, spins? }
// Returns { ...bet, won, payout } where payout is total returned (0 if lost).
export function resolveBet(bet, flip) {
  let won = false;
  switch (bet.kind) {
    case 'side':
      won = bet.side === flip.side; break;
    case 'overUnder':
      won = bet.overUnder === 'over' ? flip.spins > OU_LINE : flip.spins < OU_LINE;
      break;
    case 'parity':
      won = (bet.parity === 'even') === (flip.spins % 2 === 0); break;
    case 'bracket': {
      const b = SPIN_BRACKETS.find((x) => x.name === bet.bracket);
      won = b && flip.spins >= b.lo && flip.spins <= b.hi; break;
    }
    case 'exactSpin':
      won = bet.spins === flip.spins; break;
    case 'calledShot':
      won = bet.side === flip.side && bet.spins === flip.spins; break;
  }
  const mult = PAYOUTS[bet.kind] ?? 0;
  return { ...bet, won, payout: won ? bet.stake * mult : 0 };
}

// --- a full day ------------------------------------------------------------
// player: { balance, history: [dayRecords], daringness }
// bets:   array of bets (stakes in ₿). If balance is 0, only a free side bet
//         is allowed (busker mode).
// seedHex: the resolved daily seed.
export function playDay(player, bets, seedHex) {
  const flip = resolveFlip(seedHex);
  const broke = player.balance <= 0;

  let resolved, staked, returned, endBalance;

  if (broke) {
    // Busker mode: ignore submitted stakes, grant ONE free heads/tails bet.
    // Use the player's side pick if present, else default Heads.
    const sidePick = bets.find((b) => b.kind === 'side')?.side ?? 'Heads';
    const won = sidePick === flip.side;
    resolved = [{ kind: 'side', stake: 0, side: sidePick, won, payout: won ? FREE_BET_RETURN : 0, free: true }];
    staked = 0;
    returned = won ? FREE_BET_RETURN : 0;
    endBalance = returned; // was 0, now either 0 or 50
  } else {
    staked = bets.reduce((a, b) => a + b.stake, 0);
    if (staked > player.balance) throw new Error('stake exceeds balance');
    resolved = bets.map((b) => resolveBet(b, flip));
    returned = resolved.reduce((a, r) => a + r.payout, 0);
    endBalance = player.balance - staked + returned;
  }

  const dayRecord = {
    date: new Date().toISOString().slice(0, 10),
    startBalance: broke ? 0 : player.balance,
    endBalance,
    totalStaked: staked,
    bets: resolved.map((r) => ({ stake: r.stake, payoutMultiple: PAYOUTS[r.kind] ?? 0, kind: r.kind, side: r.side, spins: r.spins, won: r.won })),
    bustedYesterday: broke,
    edgeBets: 0,
    totalBets: resolved.length,
  };

  const newHistory = [...(player.history ?? []), dayRecord];
  const daring = computeDaringness(newHistory, player.daringness);

  return {
    flip,
    resolved,
    staked,
    returned,
    startBalance: dayRecord.startBalance,
    endBalance,
    broke,
    mode: broke ? 'brokeFlip' : 'normal',
    player: { balance: endBalance, history: newHistory, daringness: daring.value },
    daringnessLabel: daringnessLabel(daring.value),
  };
}
