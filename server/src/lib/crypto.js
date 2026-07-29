// crypto.js — WebCrypto only. No node: imports, so every function here runs
// unchanged in the Worker, in `node --test`, and in the browser.

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- hex / base64url --------------------------------------------------------

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function b64uEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const b64uEncodeString = (s) => b64uEncode(enc.encode(s));
export const b64uDecodeString = (s) => dec.decode(b64uDecode(s));

// --- hashing ----------------------------------------------------------------

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

// Take the first `bits` of a sha256 as a BigInt, then reduce mod n.
// This is the one primitive every outcome axis goes through, so the whole
// selection is "avalanched hash mod N" and nothing else.
export async function hashMod(message, n, bits = 64) {
  const hex = await sha256Hex(message);
  return Number(BigInt('0x' + hex.slice(0, bits / 4)) % BigInt(n));
}

// Same reduction over an already-computed hash hex.
export function hexMod(hex, n, bits = 64) {
  return Number(BigInt('0x' + hex.slice(0, bits / 4)) % BigInt(n));
}

// --- randomness -------------------------------------------------------------

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const randomHex = (n = 32) => toHex(randomBytes(n));

// --- HMAC + JWT (HS256) -----------------------------------------------------

async function hmacKey(secret, usages = ['sign', 'verify']) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

export async function hmacSha256(secret, message) {
  const key = await hmacKey(secret, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Compact JWS, HS256. Used for our own session and for the OAuth state cookie.
// We do NOT use this to *verify* Google — that is RS256 against Google's JWKS.
export async function signJwtHS256(payload, secret) {
  const header = b64uEncodeString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64uEncodeString(JSON.stringify(payload));
  const sig = b64uEncode(await hmacSha256(secret, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}

export async function verifyJwtHS256(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  let head;
  try {
    head = JSON.parse(b64uDecodeString(header));
  } catch {
    return null;
  }
  if (head.alg !== 'HS256') return null; // never honour alg:none / alg confusion

  const expected = await hmacSha256(secret, `${header}.${body}`);
  if (!timingSafeEqual(b64uDecode(sig), expected)) return null;

  let payload;
  try {
    payload = JSON.parse(b64uDecodeString(body));
  } catch {
    return null;
  }
  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= nowSec) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return null;
  return payload;
}
