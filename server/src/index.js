// index.js — the Worker entry point.
//
// COINFLIP backend. Server-authoritative: the client renders, the server
// decides. Money, outcomes, cooldowns and multipliers are all settled here and
// none of them are ever taken from the request body.

import { Router } from './router.js';
import {
  json,
  errorResponse,
  corsHeaders,
  withHeaders,
  assertSameOrigin,
  ApiError,
} from './lib/http.js';
import { shouldRenew, issueSessionToken, sessionCookieHeader } from './auth/session.js';

import * as meta from './routes/meta.js';
import * as auth from './routes/auth.js';
import * as player from './routes/player.js';
import * as round from './routes/round.js';
import * as leaderboard from './routes/leaderboard.js';
import * as migrate from './routes/migrate.js';
import * as dev from './routes/dev.js';

const router = new Router()
  .get('/api/health', meta.health)
  .get('/api/config', meta.config)
  .get('/api/fairness', meta.fairness)

  // auth
  .get('/api/auth/nonce', auth.nonce)
  .post('/api/auth/google', auth.googleCredential)
  .get('/api/auth/google/start', auth.googleStart)
  .get('/api/auth/google/callback', auth.googleCallback)
  .post('/api/auth/logout', auth.logout)
  .post('/api/auth/logout-everywhere', auth.logoutEverywhere)

  // player
  .get('/api/me', player.me)
  .get('/api/state', player.state)
  .post('/api/bank', player.bank)
  .post('/api/identity/signals', player.identitySignals)
  .get('/api/history', player.history)

  // the flip
  .post('/api/round', round.open)
  .get('/api/round/:id', round.show)
  .post('/api/round/:id/bets', round.lock)
  .post('/api/round/:id/flip', round.flip)

  // §6.8
  .get('/api/leaderboard', leaderboard.top)
  .get('/api/leaderboard/me', leaderboard.mine)
  .get('/api/stats/population', leaderboard.population)

  // §5 migration
  .post('/api/migrate/localstorage', migrate.importLocalStorage)

  // local only
  .post('/api/dev/login', dev.login)
  .post('/api/dev/cooldown', dev.cooldown)
  .post('/api/dev/money', dev.setMoney)
  .post('/api/dev/round', dev.roundWithSalt)
  .post('/api/dev/reset', dev.reset);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const match = router.match(request.method, url.pathname);
    if (!match) {
      return withHeaders(
        json({ error: 'not_found', message: `No route for ${request.method} ${url.pathname}` }, { status: 404 }),
        cors
      );
    }
    if (match.methodNotAllowed) {
      return withHeaders(json({ error: 'method_not_allowed' }, { status: 405 }), cors);
    }

    const context = {
      request,
      env,
      url,
      params: match.params,
      now: Date.now(),
      waitUntil: (p) => ctx.waitUntil(p),
      user: null,
      session: null,
    };

    try {
      assertSameOrigin(request, env);
      let response = await match.handler(context);

      // Slide the session forward while it is being used, so an active player
      // is never logged out mid-round by a one-hour token.
      if (context.session && shouldRenew(context.session, context.now)) {
        const token = await issueSessionToken(env, {
          userId: context.session.sub,
          sessionEpoch: context.session.sid,
          now: context.now,
        });
        response = withHeaders(response, { 'set-cookie': sessionCookieHeader(request, env, token) });
      }
      return withHeaders(response, cors);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        console.error('unhandled', url.pathname, err?.stack ?? err);
      }
      return withHeaders(errorResponse(err), cors);
    }
  },

  // Keep the leaderboard and population aggregates warm off the request path.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      leaderboard
        .refreshAllSnapshots(env, Date.now())
        .then((r) => console.log('snapshots refreshed', JSON.stringify(r)))
        .catch((e) => console.error('snapshot refresh failed', e?.stack ?? e))
    );
  },
};
