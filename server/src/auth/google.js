// google.js — Sign in with Google, verified server-side.
//
// The client is never trusted. Whichever flow the browser used, the ID token is
// verified here against Google's published JWKS (RS256, WebCrypto) and every
// claim that matters is checked: issuer, audience (our client id), expiry, and
// the nonce we minted. A forged or replayed token cannot mint a session.

import { b64uDecode, b64uDecodeString, randomHex } from '../lib/crypto.js';
import { bad, unauthorized } from '../lib/http.js';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const CLOCK_SKEW_SEC = 120;

// Module-scope JWKS cache. A Worker isolate serves many requests, so this saves
// a fetch on nearly every login; the TTL comes from Google's cache-control.
let jwksCache = { keys: null, expiresAt: 0 };

async function fetchJwks() {
  const res = await fetch(GOOGLE_JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  const cc = res.headers.get('cache-control') ?? '';
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 3600);
  jwksCache = { keys: body.keys ?? [], expiresAt: Date.now() + Math.max(300, maxAge) * 1000 };
  return jwksCache.keys;
}

export async function getSigningKey(kid, { force = false } = {}) {
  if (force || !jwksCache.keys || Date.now() >= jwksCache.expiresAt) await fetchJwks();
  let jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk && !force) {
    // unknown kid: Google rotated. Refetch once before giving up.
    await fetchJwks();
    jwk = jwksCache.keys.find((k) => k.kid === kid);
  }
  return jwk ?? null;
}

// Exported for tests: lets a test install a fixed key set instead of the network.
export function __setJwksForTest(keys, ttlMs = 60_000) {
  jwksCache = { keys, expiresAt: Date.now() + ttlMs };
}

function decodeSegment(seg) {
  return JSON.parse(b64uDecodeString(seg));
}

export async function verifyGoogleIdToken(idToken, { clientId, nonce, now = Date.now() } = {}) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw unauthorized('bad_id_token', 'Malformed Google ID token');
  }
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured');

  const [h, p, s] = idToken.split('.');
  let header;
  try {
    header = decodeSegment(h);
  } catch {
    throw unauthorized('bad_id_token', 'Unreadable token header');
  }
  if (header.alg !== 'RS256') throw unauthorized('bad_id_token', `Unsupported alg ${header.alg}`);

  const jwk = await getSigningKey(header.kid);
  if (!jwk) throw unauthorized('unknown_kid', 'Token was not signed by a published Google key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64uDecode(s),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) throw unauthorized('bad_signature', 'Google ID token signature is invalid');

  let payload;
  try {
    payload = decodeSegment(p);
  } catch {
    throw unauthorized('bad_id_token', 'Unreadable token payload');
  }

  const nowSec = Math.floor(now / 1000);
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw unauthorized('bad_issuer', `Unexpected iss ${payload.iss}`);
  if (payload.aud !== clientId) throw unauthorized('bad_audience', 'Token was issued for a different client');
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SEC < nowSec) {
    throw unauthorized('token_expired', 'Google ID token has expired');
  }
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_SEC > nowSec) {
    throw unauthorized('token_future', 'Google ID token is not yet valid');
  }
  if (nonce && payload.nonce !== nonce) throw unauthorized('bad_nonce', 'Login nonce did not match');
  if (!payload.sub) throw unauthorized('bad_id_token', 'Token carries no subject');

  return payload;
}

// --- authorization-code flow ------------------------------------------------

export function buildAuthUrl({ clientId, redirectUri, state, nonce, loginHint }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('prompt', 'select_account');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET is not configured');
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw bad('code_exchange_failed', body.error_description ?? body.error ?? 'Google rejected the code');
  }
  if (!body.id_token) throw bad('no_id_token', 'Google returned no ID token');
  return body; // { id_token, access_token, expires_in, ... } — we only use id_token
}

export const newNonce = () => randomHex(16);
export const newState = () => randomHex(16);

// The user-facing fields we keep. Nothing beyond this is stored.
export function profileFromClaims(claims) {
  return {
    googleSub: claims.sub,
    email: claims.email ?? null,
    emailVerified: claims.email_verified ? 1 : 0,
    displayName: claims.name ?? claims.given_name ?? null,
    avatarUrl: claims.picture ?? null,
  };
}
