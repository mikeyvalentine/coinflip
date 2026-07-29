// middleware.js — session -> user.

import { readSession } from './session.js';
import { getUserById } from '../db/users.js';
import { unauthorized } from '../lib/http.js';

export async function loadUser(ctx) {
  const session = await readSession(ctx.request, ctx.env, ctx.now);
  if (!session?.sub) return null;
  const user = await getUserById(ctx.env.DB, session.sub);
  if (!user) return null;
  // session_epoch pins the token to a generation; bumping the column logs the
  // account out everywhere without needing a session table.
  if (Number(user.session_epoch) !== Number(session.sid)) return null;
  ctx.session = session;
  ctx.user = user;
  return user;
}

export async function requireUser(ctx) {
  const user = await loadUser(ctx);
  if (!user) throw unauthorized();
  return user;
}
