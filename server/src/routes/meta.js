// meta.js — health, the public rule book, and the fairness explainer.
// GET /api/config is what the client should render its multipliers from, so the
// numbers on screen can never drift from the numbers being enforced.

import { json } from '../lib/http.js';
import * as C from '../economy/constants.js';
import { SEED_ALGORITHM, OUTCOME_ALGORITHM } from '../economy/outcome.js';

export function health() {
  return json({ ok: true, service: 'coinflip-api', time: Date.now() });
}

export function config() {
  return json({
    currency: '₿',
    walletFloor: C.WALLET_FLOOR,
    brokeFlipReturn: C.FREE_BET_RETURN,
    flipCooldownMs: C.FLIP_COOLDOWN_MS,
    spin: {
      // player-facing unit is ROTATIONS. Never "half flips".
      unit: 'rotations',
      min: C.ROT_MIN,
      max: C.ROT_MAX,
      step: 0.5,
      unattainable: C.ROT_MEDIAN,
      outcomes: C.SPIN_N,
      values: C.SPIN_ROTATION_VALUES,
    },
    orientation: { quadrants: C.QUADRANTS, precision: 2 },
    multipliers: {
      side: C.MULT_SIDE,
      orientation: `${C.ORIENTATION_POOL} / quadrants selected`,
      spin: `${C.SPIN_POOL} / outcomes covered`,
      edge: C.MULT_EDGE,
      note: 'All fair prices: pool size / outcomes covered. A 1x selection is a refund, not a bet.',
    },
    edge: {
      probability: C.EDGE_P,
      denominator: C.EDGE_DENOM,
      multiplier: C.MULT_EDGE,
      sweeps: true,
      note: 'The rim. Sweeps side, orientation and spin. Priced N-1 on N like roulette prices its zero.',
    },
    houseEdge: C.HOUSE_EDGE,
    spread: { alpha: `${C.SPREAD_A} * (2t - 1)`, tDefault: C.SPREAD_T_DEFAULT, equalSplitAt: 0.5 },
    stake: 'The wallet IS the stake. There is no stake field; the whole wallet always rides.',
    banking: 'One-way, wallet -> bank, and only while the cooldown timer is running.',
  });
}

export function fairness() {
  return json({
    model: 'pre-committed server salt, commit at bet-lock, reveal after settle',
    steps: [
      'POST /api/round draws a 32-byte salt, stores it, and returns ONLY sha256(salt) plus the coin start face. Neither has seen your bets.',
      'POST /api/round/:id/bets freezes your bets and your flick entropy (clockMs + flickHex) and hashes them.',
      'POST /api/round/:id/flip derives the seed, resolves the outcome, settles, and REVEALS the salt.',
      'Check sha256(revealedSalt) === saltCommit from step 1, then recompute the seed and outcome yourself.',
    ],
    seed: SEED_ALGORITHM,
    outcome: OUTCOME_ALGORITHM,
    guarantee:
      'The commit is published before any bet exists, so the salt cannot have been chosen in response to it. ' +
      'Player identity enters the seed as provenance only and cannot steer a cell — see identity.js and test.js.',
  });
}
