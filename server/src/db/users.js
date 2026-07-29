// users.js — everything that touches the users table.

import { newUserId } from '../lib/ids.js';

const USER_COLUMNS = `
  id, google_sub, email, email_verified, display_name, avatar_url,
  wallet, bank, next_flip_at, daringness, fingerprint_hex,
  flips, wins, busts, edge_hits, peak_wallet, best_multiple,
  banked_total, total_staked, total_returned,
  session_epoch, created_at, last_seen_at, legacy_imported_at`;

export function getUserById(db, id) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
}

export function getUserByGoogleSub(db, sub) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = ?`).bind(sub).first();
}

// First login creates the account. Repeat logins refresh the profile fields
// only — money, cooldown and counters are never touched by a login.
export async function upsertGoogleUser(db, profile, now = Date.now()) {
  const existing = await getUserByGoogleSub(db, profile.googleSub);
  if (existing) {
    await db
      .prepare(
        `UPDATE users SET email = ?, email_verified = ?, display_name = COALESCE(?, display_name),
         avatar_url = COALESCE(?, avatar_url), last_seen_at = ? WHERE id = ?`
      )
      .bind(
        profile.email,
        profile.emailVerified,
        profile.displayName,
        profile.avatarUrl,
        now,
        existing.id
      )
      .run();
    return { user: await getUserById(db, existing.id), created: false };
  }

  const id = newUserId();
  await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, email_verified, display_name, avatar_url,
        wallet, bank, next_flip_at, daringness, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0.5, ?, ?)`
    )
    .bind(
      id,
      profile.googleSub,
      profile.email,
      profile.emailVerified,
      profile.displayName,
      profile.avatarUrl,
      now,
      now
    )
    .run();
  // Wallet 0 with the cooldown at 0 means a brand-new player's first action is
  // the Broke Flip, immediately. That is the intended onboarding.
  return { user: await getUserById(db, id), created: true };
}

export function touchLastSeen(db, id, now = Date.now()) {
  return db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, id).run();
}

export function setFingerprint(db, id, fingerprintHex) {
  return db.prepare('UPDATE users SET fingerprint_hex = ? WHERE id = ?').bind(fingerprintHex, id).run();
}

export function bumpSessionEpoch(db, id) {
  return db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').bind(id).run();
}

// Banking. Guarded in SQL as well as in rules.js so a race can never breach the
// floor: the UPDATE only applies if the wallet still holds what we costed.
export async function applyBank(db, { userId, amount, walletBefore, now = Date.now() }) {
  const res = await db.batch([
    db
      .prepare(
        `UPDATE users SET wallet = wallet - ?, bank = bank + ?, banked_total = banked_total + ?
         WHERE id = ? AND wallet = ? AND wallet - ? >= 0`
      )
      .bind(amount, amount, amount, userId, walletBefore, amount),
    db
      .prepare(
        `INSERT INTO bank_events (user_id, amount, wallet_after, bank_after, created_at)
         SELECT ?, ?, wallet, bank, ? FROM users WHERE id = ?`
      )
      .bind(userId, amount, now, userId),
  ]);
  return res[0].meta.changes === 1;
}

export function leaderboardPage(db, { metric, limit, offset }) {
  const expr = {
    bank: 'bank',
    net_worth: '(bank + wallet)',
    best_multiple: 'best_multiple',
    flips: 'flips',
    wins: 'wins',
    peak_wallet: 'peak_wallet',
  }[metric];
  return db
    .prepare(
      `SELECT id, display_name, avatar_url, bank, wallet, (bank + wallet) AS net_worth,
              flips, wins, busts, best_multiple, peak_wallet, daringness,
              ${expr} AS score
       FROM users WHERE flips > 0
       ORDER BY score DESC, flips DESC, id ASC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all();
}

// Rank without scanning: count how many sit strictly above the player's score.
export async function rankFor(db, { metric, userId }) {
  const expr = {
    bank: 'bank',
    net_worth: '(bank + wallet)',
    best_multiple: 'best_multiple',
    flips: 'flips',
    wins: 'wins',
    peak_wallet: 'peak_wallet',
  }[metric];
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE flips > 0 AND ${expr} > (SELECT ${expr} FROM users WHERE id = ?1)) AS above,
         (SELECT COUNT(*) FROM users WHERE flips > 0) AS population,
         (SELECT ${expr} FROM users WHERE id = ?1) AS score`
    )
    .bind(userId)
    .first();
  const rank = (row?.above ?? 0) + 1;
  const population = row?.population ?? 0;
  return {
    metric,
    rank,
    population,
    score: row?.score ?? 0,
    // fraction of the population at or below this player
    percentile: population > 0 ? Math.round(((population - rank + 1) / population) * 1000) / 10 : null,
  };
}
