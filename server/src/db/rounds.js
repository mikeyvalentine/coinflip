// rounds.js — the round lifecycle and, with it, the commit/reveal.
//
//   open   -> salt drawn and stored, sha256(salt) published, start face pinned
//   lock   -> bets + player entropy frozen, hashed
//   settle -> seed derived, outcome resolved, money moved, SALT REVEALED
//
// The salt column is deliberately never in PUBLIC_COLUMNS. The only place it is
// read is the settle path and the proof of an already-settled round.

import { sha256Hex, randomHex, randomBytes } from '../lib/crypto.js';
import { newRoundId } from '../lib/ids.js';

// Safe to serve at any time. NOTE: no `salt`.
const PUBLIC_COLUMNS = `
  id, user_id, state, mode, salt_commit, start_face, opened_at, locked_at, settled_at,
  stake, spread_t, bets_json, bets_hash, client_entropy, client_clock_ms, identity_hex,
  seed_hex, outcome_json, returned, profit, multiple, wallet_before, wallet_after,
  edge_hit, imported`;

export function getActiveRound(db, userId) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM rounds WHERE user_id = ? AND state IN ('open','locked')`)
    .bind(userId)
    .first();
}

export function getRound(db, id, userId) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM rounds WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first();
}

// The salt. Callers must be either the settle path or a settled-round proof.
export function getRoundSalt(db, id) {
  return db.prepare('SELECT salt, state FROM rounds WHERE id = ?').bind(id).first();
}

export function listRounds(db, userId, { limit = 30, before = null } = {}) {
  if (before) {
    return db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM rounds WHERE user_id = ? AND opened_at < ?
         ORDER BY opened_at DESC LIMIT ?`
      )
      .bind(userId, before, limit)
      .all();
  }
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM rounds WHERE user_id = ? ORDER BY opened_at DESC LIMIT ?`)
    .bind(userId, limit)
    .all();
}

// Every settled round, oldest first — the material ../daringness.js grades.
export function listSettledForDaringness(db, userId, limit = 30) {
  return db
    .prepare(
      `SELECT settled_at, opened_at, stake, wallet_before, wallet_after, outcome_json, bets_json,
              returned, mode, edge_hit
       FROM rounds WHERE user_id = ? AND state = 'settled'
       ORDER BY COALESCE(settled_at, opened_at) DESC LIMIT ?`
    )
    .bind(userId, limit)
    .all();
}

// --- open: draw and COMMIT --------------------------------------------------
// The salt is drawn here, before the player has placed anything, and only its
// hash leaves the server. That ordering is the whole proof: the server cannot
// have chosen this salt in response to bets that did not exist yet.
export async function openRound(db, { userId, mode, now = Date.now() }) {
  const existing = await getActiveRound(db, userId);
  if (existing) return { round: existing, created: false };

  const salt = randomHex(32);
  const saltCommit = await sha256Hex(salt);
  const startFace = randomBytes(1)[0] % 2 === 0 ? 'Heads' : 'Tails';
  const id = newRoundId();

  try {
    await db
      .prepare(
        `INSERT INTO rounds (id, user_id, state, mode, salt, salt_commit, start_face, opened_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`
      )
      .bind(id, userId, mode, salt, saltCommit, startFace, now)
      .run();
  } catch (e) {
    // idx_rounds_one_active: someone raced us. Return whichever round won.
    const raced = await getActiveRound(db, userId);
    if (raced) return { round: raced, created: false };
    throw e;
  }
  return { round: await getRound(db, id, userId), created: true };
}

// Test-only variant: same path, but the salt is supplied so a test can force a
// specific outcome (e.g. a rim landing) end-to-end. Reachable only from
// /api/dev/*, which is compiled out unless DEV_ROUTES_ENABLED === 'true'.
export async function openRoundWithSalt(db, { userId, mode, salt, startFace, now = Date.now() }) {
  const existing = await getActiveRound(db, userId);
  if (existing) return { round: existing, created: false };
  const saltCommit = await sha256Hex(salt);
  const id = newRoundId();
  await db
    .prepare(
      `INSERT INTO rounds (id, user_id, state, mode, salt, salt_commit, start_face, opened_at)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`
    )
    .bind(id, userId, mode, salt, saltCommit, startFace, now)
    .run();
  return { round: await getRound(db, id, userId), created: true };
}

// --- lock: freeze the player's side ----------------------------------------
export async function lockRound(
  db,
  { roundId, userId, stake, slip, betsHash, clientEntropy, clientClockMs, identityHex, now = Date.now() }
) {
  const res = await db
    .prepare(
      `UPDATE rounds SET state = 'locked', locked_at = ?, stake = ?, spread_t = ?,
        bets_json = ?, bets_hash = ?, client_entropy = ?, client_clock_ms = ?,
        identity_hex = ?, wallet_before = ?
       WHERE id = ? AND user_id = ? AND state = 'open'`
    )
    .bind(
      now,
      Math.round(stake),
      slip.spread,
      JSON.stringify(slip),
      betsHash,
      clientEntropy,
      Math.round(clientClockMs),
      identityHex,
      Math.round(stake),
      roundId,
      userId
    )
    .run();
  return res.meta.changes === 1;
}

// --- settle: move money and REVEAL -----------------------------------------
// Both statements run in one D1 batch (one transaction). The users UPDATE is
// itself conditioned on the round still being 'locked', so the pair is
// all-or-nothing: a double-submitted flip can never pay out twice.
export async function settleRound(
  db,
  { roundId, userId, seedHex, flip, settlement, daringness, now = Date.now() }
) {
  const walletAfter = Math.round(settlement.walletAfter);
  const stake = Math.round(settlement.stake);
  const won = settlement.profit > 0 ? 1 : 0;
  const bust = walletAfter <= 0 ? 1 : 0;
  const edgeHit = flip.edge ? 1 : 0;
  const nextFlip = Math.round(now + 24 * 60 * 60 * 1000);

  const res = await db.batch([
    db
      .prepare(
        `UPDATE users SET
           wallet = ?1,
           next_flip_at = ?2,
           flips = flips + 1,
           wins = wins + ?3,
           busts = busts + ?4,
           edge_hits = edge_hits + ?5,
           peak_wallet = MAX(peak_wallet, ?1),
           best_multiple = MAX(best_multiple, ?6),
           total_staked = total_staked + ?7,
           total_returned = total_returned + ?8,
           daringness = ?9,
           last_seen_at = ?10
         WHERE id = ?11
           AND EXISTS (SELECT 1 FROM rounds WHERE id = ?12 AND user_id = ?11 AND state = 'locked')`
      )
      .bind(
        walletAfter,
        nextFlip,
        won,
        bust,
        edgeHit,
        settlement.multiple,
        stake,
        walletAfter,
        daringness,
        now,
        userId,
        roundId
      ),
    db
      .prepare(
        `UPDATE rounds SET state = 'settled', settled_at = ?, seed_hex = ?, outcome_json = ?,
           returned = ?, profit = ?, multiple = ?, wallet_after = ?, edge_hit = ?
         WHERE id = ? AND user_id = ? AND state = 'locked'`
      )
      .bind(
        now,
        seedHex,
        JSON.stringify({ flip, lines: settlement.lines }),
        walletAfter,
        Math.round(settlement.profit),
        settlement.multiple,
        walletAfter,
        edgeHit,
        roundId,
        userId
      ),
  ]);

  return res[1].meta.changes === 1;
}

export async function hashBets(slip, clientEntropy, clientClockMs) {
  return sha256Hex(
    `bets::${JSON.stringify(slip)}::${clientEntropy ?? ''}::${clientClockMs ?? ''}`
  );
}

// Legacy localStorage days, kept in the same table so history is one list.
// They carry no salt and no proof, and are flagged imported = 1.
export function insertLegacyRound(db, { userId, day, index, now }) {
  const id = newRoundId();
  return db
    .prepare(
      `INSERT INTO rounds (id, user_id, state, mode, opened_at, settled_at, stake,
        bets_json, outcome_json, returned, profit, multiple, wallet_before, wallet_after, imported)
       VALUES (?, ?, 'settled', 'legacy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .bind(
      id,
      userId,
      now - (index + 1) * 1000,
      now - (index + 1) * 1000,
      Math.round(day.totalStaked ?? 0),
      JSON.stringify(day.bets ?? []),
      JSON.stringify({ legacy: true }),
      Math.round(day.endBalance ?? 0),
      Math.round((day.endBalance ?? 0) - (day.startBalance ?? 0)),
      day.totalStaked ? (day.endBalance ?? 0) / day.totalStaked : 0,
      Math.round(day.startBalance ?? 0),
      Math.round(day.endBalance ?? 0)
    );
}
