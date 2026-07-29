// dev.js — LOCAL DEVELOPMENT AND TESTS ONLY.
//
// These routes exist so the test suite can PROVE the rules rather than assert
// them: mint a session without Google, wind the 24h cooldown, and force a
// specific flip outcome by supplying the round salt (that is how the Edge sweep
// is tested end to end — a 1-in-500 event you would otherwise never see).
//
// They are unreachable unless DEV_ROUTES_ENABLED === 'true' AND ENVIRONMENT is
// not 'production'. `wrangler secret put DEV_ROUTES_ENABLED` must never be run.
// When disabled they 404 — the deployment does not even admit they exist.

import { json, readJson, bad, notFound } from '../lib/http.js';
import { requireUser } from '../auth/middleware.js';
import { upsertGoogleUser } from '../db/users.js';
import { openRoundWithSalt } from '../db/rounds.js';
import { issueSessionToken, sessionCookieHeader } from '../auth/session.js';

export function devEnabled(env) {
  return String(env.DEV_ROUTES_ENABLED ?? 'false') === 'true' && env.ENVIRONMENT !== 'production';
}

function guard(ctx) {
  if (!devEnabled(ctx.env)) throw notFound();
}

export async function login(ctx) {
  guard(ctx);
  const body = await readJson(ctx.request);
  const sub = String(body.sub ?? `dev-${Math.random().toString(36).slice(2)}`);
  const { user, created } = await upsertGoogleUser(
    ctx.env.DB,
    {
      googleSub: sub,
      email: body.email ?? `${sub}@example.test`,
      emailVerified: 1,
      displayName: body.name ?? sub,
      avatarUrl: null,
    },
    ctx.now
  );
  const token = await issueSessionToken(ctx.env, {
    userId: user.id,
    sessionEpoch: user.session_epoch,
    now: ctx.now,
  });
  return json(
    { token, userId: user.id, created },
    { headers: { 'set-cookie': sessionCookieHeader(ctx.request, ctx.env, token) } }
  );
}

// Wind the 24h gate forwards or backwards without waiting a day.
export async function cooldown(ctx) {
  guard(ctx);
  const user = await requireUser(ctx);
  const body = await readJson(ctx.request);
  const next =
    body.nextFlipAt != null ? Number(body.nextFlipAt) : ctx.now + Number(body.msFromNow ?? 0);
  if (!Number.isFinite(next)) throw bad('bad_time', 'nextFlipAt or msFromNow required');
  await ctx.env.DB.prepare('UPDATE users SET next_flip_at = ? WHERE id = ?')
    .bind(Math.round(next), user.id)
    .run();
  return json({ nextFlipAt: Math.round(next), now: ctx.now });
}

export async function setMoney(ctx) {
  guard(ctx);
  const user = await requireUser(ctx);
  const body = await readJson(ctx.request);
  const wallet = Math.max(0, Math.floor(Number(body.wallet ?? user.wallet)));
  const bank = Math.max(0, Math.floor(Number(body.bank ?? user.bank)));
  await ctx.env.DB.prepare('UPDATE users SET wallet = ?, bank = ? WHERE id = ?')
    .bind(wallet, bank, user.id)
    .run();
  return json({ wallet, bank });
}

// Open a round with a CHOSEN salt, so a test can force any outcome it needs.
export async function roundWithSalt(ctx) {
  guard(ctx);
  const user = await requireUser(ctx);
  const body = await readJson(ctx.request);
  if (!/^[0-9a-f]{8,128}$/i.test(String(body.salt ?? ''))) {
    throw bad('bad_salt', 'salt must be 8..128 hex characters');
  }
  const startFace = body.startFace === 'Tails' ? 'Tails' : 'Heads';
  const mode = body.mode ?? (user.wallet <= 0 ? 'broke' : 'normal');
  const { round, created } = await openRoundWithSalt(ctx.env.DB, {
    userId: user.id,
    mode,
    salt: String(body.salt),
    startFace,
    now: ctx.now,
  });
  return json({
    round: {
      id: round.id,
      state: round.state,
      mode: round.mode,
      saltCommit: round.salt_commit,
      startFace: round.start_face,
    },
    created,
  });
}

export async function reset(ctx) {
  guard(ctx);
  const user = await requireUser(ctx);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM rounds WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare('DELETE FROM bank_events WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare(
      `UPDATE users SET wallet = 0, bank = 0, next_flip_at = 0, flips = 0, wins = 0, busts = 0,
        edge_hits = 0, peak_wallet = 0, best_multiple = 0, banked_total = 0, total_staked = 0,
        total_returned = 0, daringness = 0.5, legacy_imported_at = NULL WHERE id = ?`
    ).bind(user.id),
  ]);
  return json({ ok: true });
}
