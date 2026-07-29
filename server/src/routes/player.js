// player.js — who you are, what you have, and the two things you can do
// between flips: bank, and look at your history.

import { json, readJson, bad, conflict, forbidden } from '../lib/http.js';
import { requireUser } from '../auth/middleware.js';
import { applyBank, setFingerprint } from '../db/users.js';
import { getActiveRound, listRounds } from '../db/rounds.js';
import { bankQuote, bankDecision, cooldownState, isBroke } from '../economy/rules.js';
import { WALLET_FLOOR, FREE_BET_RETURN } from '../economy/constants.js';
import { computeFingerprint, assembleIdentity, visualSignature } from '../economy/identity.js';
import { daringnessLabel } from '../../../daringness.js';

// Never leak google_sub, email or session_epoch to other players. `me` gets a
// little more than the leaderboard does, but still not the Google subject.
export function publicUser(user) {
  return {
    id: user.id,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    wallet: user.wallet,
    bank: user.bank,
    netWorth: user.wallet + user.bank,
    daringness: user.daringness,
    daringnessLabel: daringnessLabel(user.daringness),
    flips: user.flips,
    wins: user.wins,
    busts: user.busts,
    edgeHits: user.edge_hits,
    peakWallet: user.peak_wallet,
    bestMultiple: user.best_multiple,
    bankedTotal: user.banked_total,
    createdAt: user.created_at,
  };
}

export async function me(ctx) {
  const user = await requireUser(ctx);
  return json({ user: { ...publicUser(user), email: user.email } });
}

// One call that renders the whole board. Deliberately shaped so the existing
// prototype can drop it straight in: `legacy` carries the exact localStorage
// key names it uses today (see MIGRATION in ../../../DEPLOYMENT.md).
export async function state(ctx) {
  const user = await requireUser(ctx);
  const active = await getActiveRound(ctx.env.DB, user.id);
  const cd = cooldownState(user, ctx.now);
  const bq = bankQuote(user, ctx.now, { hasActiveRound: !!active });
  const identity = await assembleIdentity({
    daringness: user.daringness,
    fingerprintHex: user.fingerprint_hex ?? user.id,
  });

  return json({
    user: publicUser(user),
    wallet: user.wallet,
    bank: user.bank,
    floor: WALLET_FLOOR,
    // the wallet IS the stake; there is no stake field anywhere
    stake: user.wallet,
    cooldown: cd,
    banking: { allowed: bq.allowed, max: bq.max, reason: bq.reason, floor: WALLET_FLOOR },
    flip: {
      available: cd.flipAvailable,
      availableAt: cd.availableAt,
      msRemaining: cd.msRemaining,
      mode: isBroke(user) ? 'broke' : 'normal',
      brokeFlipReturn: FREE_BET_RETURN,
    },
    activeRound: active
      ? {
          id: active.id,
          state: active.state,
          mode: active.mode,
          saltCommit: active.salt_commit,
          startFace: active.start_face,
          stake: active.stake,
          openedAt: active.opened_at,
        }
      : null,
    signature: visualSignature(identity.identityHex, user.daringness),
    legacy: { balance: user.wallet, bank: user.bank },
  });
}

// POST /api/bank { amount }
// Banking is one-way and only while the cooldown is RUNNING: you commit your
// stake before the timer reaches 00:00, and once the flip is live it is frozen.
export async function bank(ctx) {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.request);
  const active = await getActiveRound(ctx.env.DB, user.id);
  const decision = bankDecision(user, body.amount, ctx.now, { hasActiveRound: !!active });

  if (!decision.ok) {
    const map = {
      stake_frozen: [
        forbidden,
        'The flip is live — the stake is frozen. Banking is only open while the cooldown is running.',
      ],
      round_in_progress: [conflict, 'A round is open. Settle it before banking.'],
      at_floor: [forbidden, `Wallet is at the ${WALLET_FLOOR}₿ floor — there is nothing above it to bank.`],
      bad_amount: [bad, 'amount must be a positive whole number'],
      exceeds_bankable: [
        forbidden,
        `You may bank at most ${decision.quote.max}₿ — the wallet may never go below ${WALLET_FLOOR}₿.`,
      ],
    };
    const [make, message] = map[decision.reason] ?? [bad, 'Banking refused'];
    throw make(decision.reason, message, { max: decision.quote.max, floor: WALLET_FLOOR });
  }

  const applied = await applyBank(ctx.env.DB, {
    userId: user.id,
    amount: decision.amount,
    walletBefore: user.wallet,
    now: ctx.now,
  });
  if (!applied) throw conflict('bank_race', 'Wallet changed underneath the request — retry');

  return json({
    banked: decision.amount,
    wallet: decision.walletAfter,
    bank: decision.bankAfter,
    floor: WALLET_FLOOR,
    bankableRemaining: Math.max(0, decision.walletAfter - WALLET_FLOOR),
  });
}

// POST /api/identity/signals — device signals, hashed server-side with a
// server-held salt (see ../../../fingerprint.js). Provenance and presentation
// only; it can never touch an outcome.
export async function identitySignals(ctx) {
  const user = await requireUser(ctx);
  const body = await readJson(ctx.request);
  if (!ctx.env.FINGERPRINT_SALT) throw bad('not_configured', 'FINGERPRINT_SALT is not set');
  const fingerprintHex = await computeFingerprint(body.signals ?? body, ctx.env.FINGERPRINT_SALT);
  await setFingerprint(ctx.env.DB, user.id, fingerprintHex);
  const identity = await assembleIdentity({ daringness: user.daringness, fingerprintHex });
  return json({
    ok: true,
    signature: visualSignature(identity.identityHex, user.daringness),
    note: 'Identity feeds seed provenance and presentation only. It never selects an outcome.',
  });
}

// Rounds newest first, in both the server shape and the shape the prototype's
// localStorage history[] uses, so nothing on the client has to be rewritten.
export async function history(ctx) {
  const user = await requireUser(ctx);
  const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 30)));
  const before = ctx.url.searchParams.get('before');
  const { results } = await listRounds(ctx.env.DB, user.id, {
    limit,
    before: before ? Number(before) : null,
  });

  const rounds = results.map(roundToHistoryEntry);
  return json({
    rounds,
    legacyHistory: rounds.map((r) => r.legacy),
    nextBefore: results.length === limit ? results[results.length - 1].opened_at : null,
  });
}

export function roundToHistoryEntry(row) {
  let outcome = null;
  let lines = [];
  try {
    const parsed = row.outcome_json ? JSON.parse(row.outcome_json) : null;
    outcome = parsed?.flip ?? null;
    lines = parsed?.lines ?? [];
  } catch {
    /* legacy or malformed rows degrade to no detail */
  }
  return {
    id: row.id,
    state: row.state,
    mode: row.mode,
    openedAt: row.opened_at,
    settledAt: row.settled_at,
    stake: row.stake,
    returned: row.returned,
    profit: row.profit,
    multiple: row.multiple,
    walletBefore: row.wallet_before,
    walletAfter: row.wallet_after,
    edge: !!row.edge_hit,
    outcome,
    lines,
    imported: !!row.imported,
    verifiable: !row.imported && row.state === 'settled',
    saltCommit: row.salt_commit,
    // exactly the localStorage day-record shape the prototype writes today
    legacy: {
      startBalance: row.wallet_before ?? 0,
      endBalance: row.wallet_after ?? 0,
      totalStaked: row.stake ?? 0,
      bustedYesterday: false,
      bets: lines.map((l) => ({
        stake: l.risked,
        payoutMultiple: l.mult,
        kind: l.key,
        won: l.won,
      })),
    },
  };
}
