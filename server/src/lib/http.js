// http.js — JSON responses, error shape, CORS, and the CSRF origin check.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (code, message, extra) => new ApiError(400, code, message, extra);
export const unauthorized = (code = 'unauthenticated', message = 'Sign in required') =>
  new ApiError(401, code, message);
export const forbidden = (code, message, extra) => new ApiError(403, code, message, extra);
export const notFound = (code = 'not_found', message = 'Not found') =>
  new ApiError(404, code, message);
export const conflict = (code, message, extra) => new ApiError(409, code, message, extra);

export function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof ApiError) {
    return json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
  }
  return json({ error: 'internal_error', message: 'Unexpected server error' }, { status: 500 });
}

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const list = allowedOrigins(env);
  const headers = { vary: 'Origin' };
  if (origin && list.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
    headers['access-control-allow-headers'] = 'content-type, authorization';
    headers['access-control-allow-methods'] = 'GET, POST, DELETE, OPTIONS';
    headers['access-control-max-age'] = '86400';
  }
  return headers;
}

export function withHeaders(response, headers) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

// CSRF. A browser cannot suppress the Origin header on a cross-site POST, so:
// origin present and not allow-listed -> refuse. Origin absent (curl, native
// clients, tests) -> allow; those cannot be CSRF'd because there is no ambient
// cookie. Bearer-token callers are exempt entirely (no ambient credential).
export function assertSameOrigin(request, env) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (request.headers.get('authorization')) return;
  const origin = request.headers.get('origin');
  if (!origin) return;
  if (allowedOrigins(env).includes(origin)) return;
  throw forbidden('bad_origin', `Origin ${origin} is not allowed`);
}

export async function readJson(request, { maxBytes = 256 * 1024 } = {}) {
  const raw = await request.text();
  if (raw.length > maxBytes) throw bad('payload_too_large', 'Request body too large');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      throw bad('bad_json', 'Body must be a JSON object');
    }
    return parsed;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw bad('bad_json', 'Body is not valid JSON');
  }
}
