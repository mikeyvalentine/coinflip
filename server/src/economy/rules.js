// rules.js — the gates. Pure, clock-injected, no I/O, so every one of them can
// be tested against synthetic time instead of waiting 24 hours.
//
//   FLOOR        : bank down to 50, never below. The wallet can only reach 0 by
//                  losing, which is what keeps the free Broke Flip a safety net
//                  for busting rather than a payout you trigger by emptying out.
//   BANKING GATE : banking is only permitted while the cooldown timer is
//                  RUNNING. Once the flip is available the stake is frozen —
//                  you commit your stake BEFORE the timer reaches 00:00 and
//                  cannot change it once the flip is live.
//   24h GATE     : one flip per player per 24h, per-player, never shared.

import { WALLET_FLOOR, FLIP_COOLDOWN_MS } from './constants.js';

export function cooldownState(user, now) {
  const availableAt = user.next_flip_at ?? 0;
  const msRemaining = Math.max(0, availableAt - now);
  return {
    availableAt,
    msRemaining,
    running: msRemaining > 0, // timer counting down -> stake still editable
    flipAvailable: msRemaining === 0,
  };
}

// How much of the wallet sits above the floor and could be banked.
export function bankableMax(wallet) {
  return Math.max(0, Math.floor(wallet) - WALLET_FLOOR);
}

// The full banking decision. `hasActiveRound` is true while a round is open or
// locked — the stake is pinned then too, so banking is closed.
export function bankQuote(user, now, { hasActiveRound = false } = {}) {
  const cd = cooldownState(user, now);
  const max = bankableMax(user.wallet);
  const q = { max, floor: WALLET_FLOOR, allowed: false, reason: null, cooldown: cd };

  if (hasActiveRound) q.reason = 'round_in_progress';
  else if (!cd.running) q.reason = 'stake_frozen'; // flip is live: stake is committed
  else if (max <= 0) q.reason = 'at_floor';
  else q.allowed = true;

  return q;
}

// Validate a requested banking amount. Returns the applied amount or a reason.
export function bankDecision(user, amount, now, opts = {}) {
  const quote = bankQuote(user, now, opts);
  if (!quote.allowed) return { ok: false, reason: quote.reason, quote };

  const requested = Math.floor(Number(amount));
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, reason: 'bad_amount', quote };
  }
  // Never breach the floor: silently clamping would be a surprise, so refuse.
  if (requested > quote.max) {
    return { ok: false, reason: 'exceeds_bankable', quote };
  }
  return {
    ok: true,
    amount: requested,
    walletAfter: Math.floor(user.wallet) - requested,
    bankAfter: Math.floor(user.bank) + requested,
    quote,
  };
}

// The 24h gate. One flip per player per 24h.
export function flipGate(user, now, { hasActiveRound = false } = {}) {
  const cd = cooldownState(user, now);
  if (!cd.flipAvailable) {
    return {
      allowed: false,
      reason: 'cooldown',
      availableAt: cd.availableAt,
      msRemaining: cd.msRemaining,
    };
  }
  return { allowed: true, reason: hasActiveRound ? 'round_in_progress' : null, ...cd };
}

export function nextFlipAt(now) {
  return now + FLIP_COOLDOWN_MS;
}

// A wallet of 0 is the Broke Flip: one free heads-or-tails call for 50.
export function isBroke(user) {
  return Math.floor(user.wallet) <= 0;
}
