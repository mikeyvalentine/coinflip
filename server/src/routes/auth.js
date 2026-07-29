// auth.js — Sign in with Google.
//
// Two entry points, one verifier:
//   POST /api/auth/google           Google Identity Services ("One Tap" /
//                                   rendered button). The browser hands us a
//                                   credential; we verify it against Google's
//                                   JWKS. No client secret involved.
//   GET  /api/auth/google/start     Classic authorization-code flow. Uses the
//   GET  /api/auth/google/callback  client secret, server-side, never shipped.
//
// Either way the ID token is verified here — signature against the published
// JWKS, issuer, audience, expiry, and a nonce we minted and pinned to this
// browser. Nothing the client asserts about itself is believed.

import {
  verifyGoogleIdToken,
  buildAuthUrl,
  exchangeCode,
  newNonce,
  newState,
  profileFromClaims,
} from '../auth/google.js';
import {
  issueSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  issueOAuthStateCookie,
  readOAuthState,
  clearOAuthStateCookie,
} from '../auth/session.js';
import { requireUser } from '../auth/middleware.js';
import { upsertGoogleUser, bumpSessionEpoch } from '../db/users.js';
import { json, readJson, bad, unauthorized, allowedOrigins } from '../lib/http.js';
import { publicUser } from './player.js';

function requireClientId(env) {
  if (!env.GOOGLE_CLIENT_ID) {
    throw bad('not_configured', 'GOOGLE_CLIENT_ID is not set on this Worker — see DEPLOYMENT.md');
  }
  return env.GOOGLE_CLIENT_ID;
}

// Never redirect somewhere we were not told about: an open redirect on a login
// callback is a session-stealing primitive.
function safeRedirect(env, candidate) {
  const fallback = env.POST_LOGIN_REDIRECT || '/';
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate, fallback);
    const ok = allowedOrigins(env).includes(url.origin) || url.origin === new URL(fallback).origin;
    return ok ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

// --- a nonce for the GIS flow ----------------------------------------------
// The client asks for this, passes it to google.accounts.id.initialize({nonce}),
// and we require the returned token to carry it back. That is what stops an ID
// token minted for our client id on some other page being replayed here.
export async function nonce(ctx) {
  const value = newNonce();
  const cookie = await issueOAuthStateCookie(ctx.request, ctx.env, {
    state: 'gis',
    nonce: value,
    next: null,
  });
  return json({ nonce: value, expiresInSeconds: 600 }, { headers: { 'set-cookie': cookie } });
}

// --- POST /api/auth/google (GIS credential) ---------------------------------
export async function googleCredential(ctx) {
  const clientId = requireClientId(ctx.env);
  const body = await readJson(ctx.request);
  const credential = body.credential ?? body.id_token;
  if (!credential) throw bad('missing_credential', 'Body must carry the Google credential (ID token)');

  const state = await readOAuthState(ctx.request, ctx.env); // throws if absent/expired
  const claims = await verifyGoogleIdToken(credential, {
    clientId,
    nonce: state.nonce,
    now: ctx.now,
  });

  const { user, created } = await upsertGoogleUser(ctx.env.DB, profileFromClaims(claims), ctx.now);
  const token = await issueSessionToken(ctx.env, {
    userId: user.id,
    sessionEpoch: user.session_epoch,
    now: ctx.now,
  });

  return json(
    { user: publicUser(user), created, session: { token, expiresInSeconds: Number(ctx.env.SESSION_TTL_SECONDS ?? 3600) } },
    {
      headers: {
        'set-cookie': sessionCookieHeader(ctx.request, ctx.env, token),
      },
    }
  );
}

// --- GET /api/auth/google/start ---------------------------------------------
export async function googleStart(ctx) {
  const clientId = requireClientId(ctx.env);
  if (!ctx.env.GOOGLE_REDIRECT_URI) {
    throw bad('not_configured', 'GOOGLE_REDIRECT_URI is not set — see DEPLOYMENT.md');
  }
  const state = newState();
  const n = newNonce();
  const next = ctx.url.searchParams.get('next');
  const cookie = await issueOAuthStateCookie(ctx.request, ctx.env, { state, nonce: n, next });
  const location = buildAuthUrl({
    clientId,
    redirectUri: ctx.env.GOOGLE_REDIRECT_URI,
    state,
    nonce: n,
  });
  return new Response(null, { status: 302, headers: { location, 'set-cookie': cookie } });
}

// --- GET /api/auth/google/callback ------------------------------------------
export async function googleCallback(ctx) {
  const clientId = requireClientId(ctx.env);
  const code = ctx.url.searchParams.get('code');
  const returnedState = ctx.url.searchParams.get('state');
  const oauthError = ctx.url.searchParams.get('error');
  if (oauthError) throw bad('google_error', `Google returned: ${oauthError}`);
  if (!code) throw bad('missing_code', 'No authorization code on the callback');

  const saved = await readOAuthState(ctx.request, ctx.env);
  if (!returnedState || returnedState !== saved.state) {
    throw unauthorized('bad_state', 'OAuth state did not match — start the login again');
  }

  const tokens = await exchangeCode({
    code,
    clientId,
    clientSecret: ctx.env.GOOGLE_CLIENT_SECRET,
    redirectUri: ctx.env.GOOGLE_REDIRECT_URI,
  });
  const claims = await verifyGoogleIdToken(tokens.id_token, {
    clientId,
    nonce: saved.nonce,
    now: ctx.now,
  });

  const { user } = await upsertGoogleUser(ctx.env.DB, profileFromClaims(claims), ctx.now);
  const token = await issueSessionToken(ctx.env, {
    userId: user.id,
    sessionEpoch: user.session_epoch,
    now: ctx.now,
  });

  const headers = new Headers({ location: safeRedirect(ctx.env, saved.next) });
  headers.append('set-cookie', sessionCookieHeader(ctx.request, ctx.env, token));
  headers.append('set-cookie', clearOAuthStateCookie(ctx.request, ctx.env));
  return new Response(null, { status: 302, headers });
}

export async function logout(ctx) {
  return json(
    { ok: true },
    { headers: { 'set-cookie': clearSessionCookieHeader(ctx.request, ctx.env) } }
  );
}

// Log out everywhere: bumping session_epoch invalidates every token already out.
export async function logoutEverywhere(ctx) {
  const user = await requireUser(ctx);
  await bumpSessionEpoch(ctx.env.DB, user.id);
  return json(
    { ok: true },
    { headers: { 'set-cookie': clearSessionCookieHeader(ctx.request, ctx.env) } }
  );
}
