// round.js — open, lock, flip. This is where the commit/reveal lives and where
// all the money moves.
//
// The client is told the outcome; it is never asked for one. It cannot set a
// stake (the wallet IS the stake), cannot pick its multipliers (they are priced
// from what it covered), and cannot settle twice (the settle is a compare-and-
// swap on the round row).

import { json, readJson, bad, conflict, notFound } from '../lib/http.js';
import { requireUser } from '../auth/middleware.js';
import {
  openRound,
  lockRound,
  settleRound,
  getRound,
  getRoundSalt,
  getActiveRound,
  hashBets,
  listSettledForDaringness,
} from '../db/rounds.js';
import { getUserById } from '../db/users.js';
import { normalizeSlip, buildPortions, totalMultiple } from '../economy/bets.js';
import { settleNormal, settleBroke, toDayRecord } from '../economy/settle.js';
import { resolveFlip, SEED_ALGORITHM, OUTCOME_ALGORITHM } from '../economy/outcome.js';
import { assembleIdentity, deriveFlipSeed } from '../economy/identity.js';
import { daringnessFor } from '../economy/history.js';
import { flipGate, isBroke, cooldownState } from '../economy/rules.js';
import { SIDES, FREE_BET_RETURN } from '../economy/constants.js';

const FLICK_RE = /^[0-9a-fA-F]{0,128}$/;

function roundPublic(round, extra = {}) {
  return {
    id: round.id,
    state: round.state,
    mode: round.mode,
    // THE COMMITMENT. Published before any bet exists. sha256(salt).
    saltCommit: round.salt_commit,
    startFace: round.start_face,
    stake: round.stake,
    openedAt: round.opened_at,
    lockedAt: round.locked_at,
    settledAt: round.settled_at,
    ...extra,
  };
}

// --- POST /api/round --------------------------------------------------------
// Draw the salt, publish its hash, pin the start face. Idempotent: while a
// round is unsettled this returns that same round, so a player cannot reopen
// to shop for a different start face.
export async function open(ctx) {
  const user = await requireUser(ctx);
  const active = await getActiveRound(ctx.env.DB, user.id);
  if (active) {
    return json({
      round: roundPublic(active),
      resumed: true,
      cooldown: cooldownState(user, ctx.now),
    });
  }

  const gate = flipGate(user, ctx.now);
  if (!gate.allowed) {
    throw conflict('cooldown', 'One flip per 24 hours — this one is not available yet.', {
      availableAt: gate.availableAt,
      msRemaining: gate.msRemaining,
    });
  }

  const mode = isBroke(user) ? 'broke' : 'normal';
  const { round } = await openRound(ctx.env.DB, { userId: user.id, mode, now: ctx.now });

  return json({
    round: roundPublic(round, { stake: mode === 'broke' ? 0 : user.wallet }),
    resumed: false,
    mode,
    wallet: user.wallet,
    brokeFlipReturn: FREE_BET_RETURN,
    commitment: {
      saltCommit: round.salt_commit,
      note: 'sha256 of the server salt for this round. It was drawn before you placed anything and is revealed when the round settles.',
    },
  });
}

// --- POST /api/round/:id/bets ----------------------------------------------
// Freeze the player's side of the round: the slip, the flick entropy, and the
// stake (which is simply the whole wallet).
export async function lock(ctx) {
  const user = await requireUser(ctx);
  const round = await getRound(ctx.env.DB, ctx.params.id, user.id);
  if (!round) throw notFound('no_such_round');
  if (round.state !== 'open') {
    throw conflict('round_not_open', `Round is ${round.state}; bets can only be placed while it is open.`);
  }

  const body = await readJson(ctx.request);

  // player-authored entropy — the flick. Optional: the pre-committed salt is
  // what makes the result unpredictable, this is what makes it theirs.
  const flickHex = String(body.flick ?? body.flickHex ?? '');
  if (!FLICK_RE.test(flickHex)) throw bad('bad_flick', 'flick must be up to 128 hex characters');
  const clockMs = Number(body.clockMs ?? ctx.now);
  if (!Number.isFinite(clockMs) || clockMs < 0 || clockMs > 1e15) {
    throw bad('bad_clock', 'clockMs must be a positive millisecond timestamp');
  }

  let slip;
  let stake;
  let portions = [];
  let ignored = [];

  if (round.mode === 'broke') {
    const call = body.call ?? body.side;
    if (!SIDES.includes(call)) {
      throw bad('bad_call', 'A Broke Flip is heads or tails only — no upgrades.');
    }
    slip = { call, spread: 0 };
    stake = 0;
  } else {
    if (user.wallet <= 0) throw conflict('wallet_empty', 'Wallet is empty — this must be a Broke Flip.');
    slip = normalizeSlip(body.bets ?? body);
    const built = buildPortions(slip);
    portions = built.portions;
    ignored = built.ignored;
    if (!portions.length) {
      throw bad(
        'nothing_at_risk',
        'No live bet. Covering all four quadrants is a refund, not a wager — call a side, or narrow the orientation or spin.'
      );
    }
    stake = Math.floor(user.wallet);
  }

  const identity = await assembleIdentity({
    daringness: user.daringness,
    fingerprintHex: user.fingerprint_hex ?? user.id,
  });
  const betsHash = await hashBets(slip, flickHex, clockMs);

  const ok = await lockRound(ctx.env.DB, {
    roundId: round.id,
    userId: user.id,
    stake,
    slip,
    betsHash,
    clientEntropy: flickHex,
    clientClockMs: clockMs,
    identityHex: identity.identityHex,
    now: ctx.now,
  });
  if (!ok) throw conflict('round_not_open', 'Round was locked or settled by another request.');

  return json({
    round: roundPublic({ ...round, state: 'locked', stake, locked_at: ctx.now }),
    stake,
    slip,
    bets: portions.map((p) => ({ key: p.key, pick: p.pick, mult: p.mult, weight: p.weight, risked: stake * p.weight })),
    ignored,
    totalMultiple: portions.length ? totalMultiple(portions) : 0,
    betsHash,
    commitment: { saltCommit: round.salt_commit, betsHash },
  });
}

// --- POST /api/round/:id/flip ----------------------------------------------
// Derive, resolve, settle, REVEAL.
export async function flip(ctx) {
  const user = await requireUser(ctx);
  const round = await getRound(ctx.env.DB, ctx.params.id, user.id);
  if (!round) throw notFound('no_such_round');

  // Idempotent: a dropped response must never cost a player their flip.
  if (round.state === 'settled') {
    return json(await settledPayload(ctx, round, { replayed: true }));
  }
  if (round.state !== 'locked') {
    throw conflict('round_not_locked', 'Place your bets before flipping.');
  }

  const saltRow = await getRoundSalt(ctx.env.DB, round.id);
  const salt = saltRow.salt;

  const seedHex = await deriveFlipSeed({
    identityHex: round.identity_hex,
    clockMs: round.client_clock_ms,
    flickHex: round.client_entropy ?? '',
    serverSalt: salt,
  });
  const outcome = await resolveFlip(seedHex, round.start_face);

  const slip = JSON.parse(round.bets_json);
  let settlement;
  if (round.mode === 'broke') {
    settlement = settleBroke({ call: slip.call, flip: outcome });
  } else {
    const { portions } = buildPortions(slip);
    settlement = settleNormal({ stake: round.stake, portions, flip: outcome });
  }

  // Recompute the trait from server-recorded history including this round.
  const { results: prior } = await listSettledForDaringness(ctx.env.DB, user.id, 30);
  const pendingDay = toDayRecord({
    settlement,
    dateISO: new Date(ctx.now).toISOString().slice(0, 10),
    bustedYesterday: round.mode === 'broke',
    edgeBets: slip.side === 'Edge' ? 1 : 0,
  });
  const daring = daringnessFor(prior, user.daringness, pendingDay);

  const applied = await settleRound(ctx.env.DB, {
    roundId: round.id,
    userId: user.id,
    seedHex,
    flip: outcome,
    settlement,
    daringness: daring.value,
    now: ctx.now,
  });

  if (!applied) {
    // Another request settled it first. Serve that result, not this one.
    const fresh = await getRound(ctx.env.DB, round.id, user.id);
    return json(await settledPayload(ctx, fresh, { replayed: true }));
  }

  const after = await getUserById(ctx.env.DB, user.id);
  return json({
    round: roundPublic({ ...round, state: 'settled', settled_at: ctx.now }),
    outcome,
    result: {
      stake: settlement.stake,
      returned: settlement.returned,
      profit: settlement.profit,
      multiple: settlement.multiple,
      maxMultiple: settlement.maxMultiple,
      swept: settlement.swept,
      bust: settlement.bust,
      lines: settlement.lines,
    },
    wallet: after.wallet,
    bank: after.bank,
    daringness: daring.value,
    cooldown: cooldownState(after, ctx.now),
    nextMode: after.wallet <= 0 ? 'broke' : 'normal',
    // THE REVEAL
    proof: {
      saltCommit: round.salt_commit,
      salt,
      startFace: round.start_face,
      identityHex: round.identity_hex,
      clockMs: round.client_clock_ms,
      flickHex: round.client_entropy ?? '',
      seedHex,
      betsHash: round.bets_hash,
      seedAlgorithm: SEED_ALGORITHM,
      outcomeAlgorithm: OUTCOME_ALGORITHM,
      verify: 'sha256(salt) must equal saltCommit, which you were given before you placed a single bet.',
    },
  });
}

// --- GET /api/round/:id -----------------------------------------------------
// The proof record. The salt is only ever present once the round is settled.
export async function show(ctx) {
  const user = await requireUser(ctx);
  const round = await getRound(ctx.env.DB, ctx.params.id, user.id);
  if (!round) throw notFound('no_such_round');
  if (round.state === 'settled') return json(await settledPayload(ctx, round));
  return json({
    round: roundPublic(round),
    commitment: { saltCommit: round.salt_commit },
    proof: null,
    note: 'The salt is revealed only after this round settles.',
  });
}

async function settledPayload(ctx, round, extra = {}) {
  const saltRow = await getRoundSalt(ctx.env.DB, round.id);
  let outcome = null;
  let lines = [];
  try {
    const parsed = JSON.parse(round.outcome_json ?? '{}');
    outcome = parsed.flip ?? null;
    lines = parsed.lines ?? [];
  } catch {
    /* ignore */
  }
  return {
    ...extra,
    round: roundPublic(round),
    outcome,
    result: {
      stake: round.stake,
      returned: round.returned,
      profit: round.profit,
      multiple: round.multiple,
      bust: (round.wallet_after ?? 0) <= 0,
      lines,
    },
    proof: {
      saltCommit: round.salt_commit,
      salt: saltRow?.salt ?? null,
      startFace: round.start_face,
      identityHex: round.identity_hex,
      clockMs: round.client_clock_ms,
      flickHex: round.client_entropy ?? '',
      seedHex: round.seed_hex,
      betsHash: round.bets_hash,
      seedAlgorithm: SEED_ALGORITHM,
      outcomeAlgorithm: OUTCOME_ALGORITHM,
    },
  };
}
