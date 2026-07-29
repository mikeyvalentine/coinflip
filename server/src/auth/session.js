// session.js — our own short-lived session, keyed to the internal user id.
//
// The Google ID token is used ONCE, to prove who is signing in. After that the
// browser carries our session: an HS256 JWT in an HttpOnly cookie, one hour,
// silently renewed while it is being used. `sid` pins it to the user's
// session_epoch, so bumping that column invalidates every outstanding session
// for that account without a session table.

import { signJwtHS256, verifyJwtHS256 } from '../lib/crypto.js';
import { parseCookies, serializeCookie, isSecureRequest } from '../lib/cookies.js';
import { unauthorized } from '../lib/http.js';

export const SESSION_COOKIE = 'coinflip_session';
export const OAUTH_COOKIE = 'coinflip_oauth';
const RENEW_WHEN_REMAINING_SEC = 15 * 60;

function ttlSeconds(env) {
  const n = Number(env.SESSION_TTL_SECONDS ?? 3600);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

function secret(env) {
  if (!env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is not set — copy .dev.vars.example to .dev.vars (see DEPLOYMENT.md)');
  }
  return env.SESSION_SECRET;
}

export async function issueSessionToken(env, { userId, sessionEpoch, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  return signJwtHS256(
    { v: 1, sub: userId, sid: sessionEpoch, iat, exp: iat + ttlSeconds(env) },
    secret(env)
  );
}

export function sessionCookieHeader(request, env, token) {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: ttlSeconds(env),
    httpOnly: true,
    secure: isSecureRequest(request) || env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
  });
}

export function clearSessionCookieHeader(request, env) {
  return serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    secure: isSecureRequest(request) || env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
  });
}

// Cookie first, then `Authorization: Bearer <session jwt>` for non-browser
// clients (and the test suite). Bearer callers carry no ambient credential, so
// they are exempt from the CSRF origin check.
export function readSessionToken(request) {
  const auth = request.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return parseCookies(request)[SESSION_COOKIE] ?? null;
}

export async function readSession(request, env, now = Date.now()) {
  const token = readSessionToken(request);
  if (!token) return null;
  return verifyJwtHS256(token, secret(env), { now });
}

export function shouldRenew(payload, now = Date.now()) {
  if (!payload?.exp) return false;
  return payload.exp - Math.floor(now / 1000) < RENEW_WHEN_REMAINING_SEC;
}

// --- OAuth state/nonce ------------------------------------------------------
// Kept in a short-lived signed cookie rather than a table: no DB write on the
// login path, and it is bound to the browser that started the flow.

export async function issueOAuthStateCookie(request, env, { state, nonce, next }) {
  const iat = Math.floor(Date.now() / 1000);
  const token = await signJwtHS256({ state, nonce, next, iat, exp: iat + 600 }, secret(env));
  return serializeCookie(OAUTH_COOKIE, token, {
    maxAge: 600,
    httpOnly: true,
    secure: isSecureRequest(request) || env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
  });
}

export async function readOAuthState(request, env) {
  const raw = parseCookies(request)[OAUTH_COOKIE];
  if (!raw) throw unauthorized('missing_oauth_state', 'Login session expired — start again');
  const payload = await verifyJwtHS256(raw, secret(env));
  if (!payload) throw unauthorized('bad_oauth_state', 'Login state is invalid or expired');
  return payload;
}

export function clearOAuthStateCookie(request, env) {
  return serializeCookie(OAUTH_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    secure: isSecureRequest(request) || env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
  });
}
