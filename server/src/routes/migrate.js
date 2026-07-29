// migrate.js — moving the prototype off localStorage.
//
// The prototype persists to localStorage under the key `coinflip`:
//     { balance: Number, bank: Number, history: [ dayRecord ] }
// and each dayRecord is
//     { startBalance, endBalance, totalStaked, bustedYesterday,
//       bets: [ { stake, payoutMultiple, kind, won } ] }
//
// MAPPING
//   balance                 -> users.wallet
//   bank                    -> users.bank
//   history[]               -> rounds rows, mode 'legacy', imported = 1
//   history[].bets[]        -> rounds.bets_json
//
// TRUST. A client-held balance is a client-held claim, and this backend exists
// precisely so money stops being a client-held claim. So by default the money
// in the blob is NOT applied: the history is imported as provenance (it feeds
// daringness, which is presentation-only and can never move an outcome) and the
// wallet/bank stay whatever the server says. Set ALLOW_LEGACY_BALANCE_IMPORT
// to "true" for a one-off prototype migration window if the user decides the
// existing localStorage balances should carry over; it is capped by
// LEGACY_IMPORT_CAP and can only ever run once per account.

import { json, readJson, bad, conflict } from '../lib/http.js';
import { requireUser } from '../auth/middleware.js';
import { insertLegacyRound } from '../db/rounds.js';
import { getUserById } from '../db/users.js';
import { newImportId } from '../lib/ids.js';
import { computeDaringness } from '../../../daringness.js';

const MAX_DAYS = 400;

export async function importLocalStorage(ctx) {
  const user = await requireUser(ctx);
  if (user.legacy_imported_at) {
    throw conflict('already_imported', 'This account has already imported a localStorage save.');
  }

  const body = await readJson(ctx.request);
  const blob = body.coinflip ?? body.payload ?? body;
  if (typeof blob !== 'object' || blob === null) throw bad('bad_payload', 'Expected the localStorage `coinflip` object');

  const history = Array.isArray(blob.history) ? blob.history.slice(-MAX_DAYS) : [];
  const claimedWallet = Number.isFinite(blob.balance) ? Math.max(0, Math.floor(blob.balance)) : 0;
  const claimedBank = Number.isFinite(blob.bank) ? Math.max(0, Math.floor(blob.bank)) : 0;

  const allowMoney = String(ctx.env.ALLOW_LEGACY_BALANCE_IMPORT ?? 'false') === 'true';
  const cap = Number(ctx.env.LEGACY_IMPORT_CAP ?? 100000);
  const walletApplied = allowMoney ? Math.min(claimedWallet, cap) : null;
  const bankApplied = allowMoney ? Math.min(claimedBank, cap) : null;

  const importId = newImportId();
  const statements = [
    ctx.env.DB.prepare(
      `INSERT INTO legacy_imports (id, user_id, payload_json, days, claimed_wallet, claimed_bank, money_applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      importId,
      user.id,
      JSON.stringify(blob).slice(0, 200000),
      history.length,
      claimedWallet,
      claimedBank,
      allowMoney ? 1 : 0,
      ctx.now
    ),
    ...history.map((day, i) =>
      insertLegacyRound(ctx.env.DB, { userId: user.id, day, index: history.length - i, now: ctx.now })
    ),
  ];

  if (allowMoney) {
    statements.push(
      ctx.env.DB.prepare(
        'UPDATE users SET wallet = ?, bank = ?, legacy_imported_at = ? WHERE id = ? AND legacy_imported_at IS NULL'
      ).bind(walletApplied, bankApplied, ctx.now, user.id)
    );
  } else {
    statements.push(
      ctx.env.DB.prepare(
        'UPDATE users SET legacy_imported_at = ? WHERE id = ? AND legacy_imported_at IS NULL'
      ).bind(ctx.now, user.id)
    );
  }

  await ctx.env.DB.batch(statements);

  // History is worth importing for exactly one reason: the daringness trait is
  // a rolling 30-day read, and a returning player should not be reset to the
  // cold-start neutral. It never touches money or outcomes.
  const days = history.map((d, i) => ({
    date: new Date(ctx.now - (history.length - i) * 86400000).toISOString().slice(0, 10),
    startBalance: d.startBalance ?? 0,
    endBalance: d.endBalance ?? 0,
    totalStaked: d.totalStaked ?? 0,
    bets: Array.isArray(d.bets) ? d.bets : [],
    bustedYesterday: !!d.bustedYesterday,
    edgeBets: 0,
    totalBets: Array.isArray(d.bets) ? d.bets.length : 0,
  }));
  const trait = computeDaringness(days, user.daringness);
  await ctx.env.DB.prepare('UPDATE users SET daringness = ? WHERE id = ?')
    .bind(trait.value, user.id)
    .run();

  const after = await getUserById(ctx.env.DB, user.id);
  return json({
    importId,
    daysImported: history.length,
    claimed: { wallet: claimedWallet, bank: claimedBank },
    moneyApplied: allowMoney,
    wallet: after.wallet,
    bank: after.bank,
    daringness: after.daringness,
    note: allowMoney
      ? 'Legacy balances were applied because ALLOW_LEGACY_BALANCE_IMPORT is true. Turn it off once the migration window closes.'
      : 'History imported as provenance. Balances were NOT applied — money is server-authoritative. See DEPLOYMENT.md.',
  });
}
