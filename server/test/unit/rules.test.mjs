// The three gates: the 50 floor, the banking window, and the 24h flip gate.
// Proved over exhaustive grids, not over a handful of examples.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bankableMax,
  bankQuote,
  bankDecision,
  flipGate,
  cooldownState,
  nextFlipAt,
  isBroke,
} from '../../src/economy/rules.js';
import { WALLET_FLOOR, FLIP_COOLDOWN_MS } from '../../src/economy/constants.js';

const NOW = 1_800_000_000_000;
const running = (user = {}) => ({ wallet: 0, bank: 0, next_flip_at: NOW + 60_000, ...user });
const available = (user = {}) => ({ wallet: 0, bank: 0, next_flip_at: NOW - 1, ...user });

test('the floor is 50 and the bankable amount is whatever sits above it', () => {
  assert.equal(WALLET_FLOOR, 50);
  assert.equal(bankableMax(0), 0);
  assert.equal(bankableMax(49), 0);
  assert.equal(bankableMax(50), 0);
  assert.equal(bankableMax(51), 1);
  assert.equal(bankableMax(1000), 950);
});

test('EXHAUSTIVE: no accepted banking request can ever leave the wallet below 50', () => {
  let accepted = 0;
  for (let wallet = 0; wallet <= 400; wallet++) {
    for (let amount = -5; amount <= 400; amount++) {
      const user = running({ wallet });
      const d = bankDecision(user, amount, NOW);
      if (!d.ok) continue;
      accepted++;
      assert.ok(d.walletAfter >= WALLET_FLOOR, `wallet ${wallet} - ${amount} = ${d.walletAfter}`);
      assert.equal(d.walletAfter + d.amount, wallet, 'banking must conserve money');
      assert.equal(d.bankAfter, user.bank + d.amount);
      assert.ok(d.amount > 0 && Number.isInteger(d.amount));
    }
  }
  assert.ok(accepted > 1000, `sanity: the grid should accept plenty (accepted ${accepted})`);
});

test('the wallet can therefore only ever reach 0 by losing', () => {
  // there is no amount, at any wallet, that banks you to zero
  for (let wallet = 0; wallet <= 300; wallet++) {
    for (let amount = 1; amount <= 300; amount++) {
      const d = bankDecision(running({ wallet }), amount, NOW);
      if (d.ok) assert.notEqual(d.walletAfter, 0);
    }
  }
});

test('banking is open only while the cooldown is RUNNING', () => {
  const rich = { wallet: 500, bank: 0 };

  // timer counting down -> you may still move your stake
  const during = bankQuote({ ...rich, next_flip_at: NOW + 1 }, NOW);
  assert.equal(during.allowed, true);
  assert.equal(during.max, 450);

  // timer at 00:00, the flip is live -> the stake is frozen
  const live = bankQuote({ ...rich, next_flip_at: NOW }, NOW);
  assert.equal(live.allowed, false);
  assert.equal(live.reason, 'stake_frozen');

  // and a round in flight is frozen too
  const mid = bankQuote({ ...rich, next_flip_at: NOW + 1 }, NOW, { hasActiveRound: true });
  assert.equal(mid.allowed, false);
  assert.equal(mid.reason, 'round_in_progress');

  // at the floor there is simply nothing to move
  const floored = bankQuote({ wallet: 50, bank: 0, next_flip_at: NOW + 1 }, NOW);
  assert.equal(floored.allowed, false);
  assert.equal(floored.reason, 'at_floor');
});

test('EXHAUSTIVE: banking and flipping are never open at the same time', () => {
  for (let offset = -5; offset <= 5; offset++) {
    for (const wallet of [0, 50, 51, 500]) {
      for (const hasActiveRound of [false, true]) {
        const user = { wallet, bank: 0, next_flip_at: NOW + offset };
        const bank = bankQuote(user, NOW, { hasActiveRound });
        const flip = flipGate(user, NOW, { hasActiveRound });
        assert.ok(
          !(bank.allowed && flip.allowed),
          `both open at offset ${offset}, wallet ${wallet}`
        );
      }
    }
  }
});

test('the 24h gate: one flip per player, and the next is exactly 24h later', () => {
  assert.equal(FLIP_COOLDOWN_MS, 86_400_000);
  assert.equal(nextFlipAt(NOW), NOW + 86_400_000);

  // the boundary, to the millisecond
  assert.equal(flipGate({ next_flip_at: NOW + 1 }, NOW).allowed, false);
  assert.equal(flipGate({ next_flip_at: NOW }, NOW).allowed, true);
  assert.equal(flipGate({ next_flip_at: NOW - 1 }, NOW).allowed, true);

  // a fresh account (next_flip_at 0) may flip immediately
  assert.equal(flipGate({ next_flip_at: 0 }, NOW).allowed, true);

  // and having flipped, they are shut out for the full 24h and not a moment less
  const after = { next_flip_at: nextFlipAt(NOW) };
  for (const t of [NOW, NOW + 1, NOW + 3600_000, NOW + 86_399_999]) {
    assert.equal(flipGate(after, t).allowed, false, `should still be closed at +${t - NOW}ms`);
  }
  assert.equal(flipGate(after, NOW + 86_400_000).allowed, true);
});

test('the cooldown report the client renders is consistent with the gate', () => {
  const user = { next_flip_at: NOW + 5000 };
  const cd = cooldownState(user, NOW);
  assert.equal(cd.msRemaining, 5000);
  assert.equal(cd.running, true);
  assert.equal(cd.flipAvailable, false);
  assert.equal(flipGate(user, NOW).allowed, cd.flipAvailable);
});

test('a zero wallet is the Broke Flip', () => {
  assert.equal(isBroke({ wallet: 0 }), true);
  assert.equal(isBroke({ wallet: 0.4 }), true);
  assert.equal(isBroke({ wallet: 1 }), false);
  assert.equal(isBroke({ wallet: 50 }), false);
});

test('banking refuses rather than silently clamping to the floor', () => {
  const d = bankDecision(running({ wallet: 100 }), 60, NOW); // max is 50
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'exceeds_bankable');
  assert.equal(d.quote.max, 50);
});

test('nonsense amounts are refused', () => {
  for (const amount of [0, -1, NaN, Infinity, null, undefined, 'lots']) {
    const d = bankDecision(running({ wallet: 500 }), amount, NOW);
    assert.equal(d.ok, false, `amount ${amount}`);
  }
  // fractional amounts floor to whole ₿
  const frac = bankDecision(running({ wallet: 500 }), 10.9, NOW);
  assert.equal(frac.ok, true);
  assert.equal(frac.amount, 10);
});
