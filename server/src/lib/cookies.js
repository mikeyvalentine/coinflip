// cookies.js — minimal cookie read/write.

export function parseCookies(request) {
  const header = request.headers.get('cookie');
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Secure is set whenever we are not on plain-http localhost, so the cookie
// works in `wrangler dev` and is still hardened everywhere real.
export function serializeCookie(name, value, opts = {}) {
  const {
    maxAge,
    path = '/',
    httpOnly = true,
    secure = true,
    sameSite = 'Lax',
    expires,
  } = opts;
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (typeof maxAge === 'number') bits.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (expires) bits.push(`Expires=${new Date(expires).toUTCString()}`);
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (sameSite) bits.push(`SameSite=${sameSite}`);
  return bits.join('; ');
}

export function isSecureRequest(request) {
  return new URL(request.url).protocol === 'https:';
}
