// game/wallet.js
// ---------------------------------------------------------------------------
// THE MONEY RULES. Pure: no DOM, no storage of its own — the caller supplies a
// storage object so this runs in a verifier with nothing installed.
//
// WALLET vs BANK. The wallet is always fully at risk; there is no stake field,
// the stake IS whatever was not banked. Banking is ONE-WAY and never below
// WALLET_FLOOR, so the wallet can only reach 0 by LOSING — which is what keeps
// the cleaning recovery a safety net for busting rather than a payout anyone can
// trigger by emptying the wallet on purpose.
//
// THREE BUGS ARE DESIGNED OUT HERE RATHER THAN PATCHED AT THE CALL SITE, because
// each of them was individually invisible and only showed up in sequence:
//
//   1. MONEY MOVING MID-FLIGHT. doFlip captured the stake, awaited ~3 s of
//      reveal, then RE-READ the balance to settle. Banking during that window
//      subtracted the original stake from a reduced balance: a 1000 B wallet
//      with 500 banked mid-reveal settled to wallet -500, with 500 B destroyed.
//      settle() therefore takes the stake it was given and never consults live
//      state, and canBank() takes an explicit inFlight flag.
//   2. A CORRUPT SAVE STRANDED THE PLAYER. localStorage is not trusted input.
//      `{"balance":"lots"}` is valid JSON and passes `<= 0` — because
//      `"lots" <= 0` is false — then settles to NaN, and NaN fails EVERY
//      comparison, so both the flip gate and the recovery gate read false and
//      there is no route back. money() coerces at the door so every rule
//      downstream can assume a finite non-negative integer.
//   3. AN EXCEPTION HELD THE IN-FLIGHT LOCK FOREVER. That one belongs to the
//      caller (try/finally), but the gates here are written so a stuck lock
//      fails CLOSED — refusing to move money — rather than open.
// ---------------------------------------------------------------------------

export const WALLET_FLOOR = 50;

/**
 * Coerce anything into spendable B: a finite, non-negative integer.
 *
 * Capped at MAX_SAFE_INTEGER, and not arbitrarily — above it integer arithmetic
 * stops being exact and B silently stops being countable. A restored 1e308 is
 * finite and passes every other check, then meets the Edge's 499x and becomes
 * Infinity, and the next arithmetic makes it NaN: the same dead end by a longer
 * road.
 */
export function money(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

/** A player with nothing. The shape every other function here assumes. */
export function emptyPlayer() {
  return { balance: 0, bank: 0, history: [], nextFlipAt: 0 };
}

/**
 * Read a saved player, sanitising at the door.
 *
 * @param {{getItem:Function}} storage
 */
export function loadPlayer(storage, key = 'coinflip') {
  try {
    const raw = JSON.parse(storage.getItem(key));
    if (!raw || typeof raw !== 'object') return emptyPlayer();
    return {
      balance: money(raw.balance),
      bank: money(raw.bank),
      history: Array.isArray(raw.history) ? raw.history : [],
      // A corrupt cooldown is as capable of bricking the game as a corrupt
      // balance: a NaN or a far-future timestamp locks the flip permanently
      // with no way to clear it. Coerced to a plain number, and anything
      // unusable becomes 0, which means "ready now".
      nextFlipAt: Number.isFinite(Number(raw.nextFlipAt)) ? Math.max(0, Number(raw.nextFlipAt)) : 0,
    };
  } catch { return emptyPlayer(); }
}

/** Persist. Storage failures are non-fatal — Safari private mode throws. */
export function savePlayer(storage, player, key = 'coinflip') {
  try { storage.setItem(key, JSON.stringify(player)); return true; } catch { return false; }
}

// --- banking ---------------------------------------------------------------

/** How much sits above the floor, and is therefore bankable. */
export function bankMax(player) {
  return Math.max(0, Math.round(money(player.balance)) - WALLET_FLOOR);
}

/**
 * May money move to the bank right now?
 *
 * `inFlight` is explicit and NOT optional in practice: the design's own rule is
 * that the stake freezes when the flip goes live, but only the flip gate ever
 * enforced it, and only against the cooldown. The moment a cooldown began during
 * a reveal, banking re-opened mid-settlement. Passing it in means the caller
 * cannot forget it silently — it reads as a missing argument, not as `false`.
 */
export function canBank(player, { timerRunning, inFlight }) {
  return bankMax(player) > 0 && !!timerRunning && !inFlight;
}

/**
 * Move `amt` to the bank, clamped so the floor is never breached.
 * @returns {{balance:number, bank:number, moved:number}} the NEW state
 */
export function applyBank(player, amt) {
  const max = bankMax(player);
  const moved = Math.min(Math.max(Math.floor(Number(amt) || 0), 0), max);
  if (moved <= 0) return { balance: money(player.balance), bank: money(player.bank), moved: 0 };
  return {
    balance: money(player.balance) - moved,
    bank: money(player.bank) + moved,
    moved,
  };
}

// --- gates -----------------------------------------------------------------

/**
 * Can the player throw?
 *
 * Note `!Number.isFinite` rather than a bare `<= 0`: NaN fails every comparison,
 * so a corrupted balance sailed straight through the old guard and staked
 * garbage. money() should make that unreachable now, and this stays anyway —
 * the cost is one comparison and the failure it prevents is a dead account.
 */
export function canFlip(player, { timerRunning, inFlight, hasBet, rideDead }) {
  if (timerRunning) return false;          // the stake is frozen once live
  if (inFlight) return false;
  if (!Number.isFinite(player.balance) || player.balance <= 0) return false;
  if (!hasBet) return false;
  if (rideDead) return false;              // an unwinnable RIDE is a donation
  return true;
}

/**
 * Can the player clean for a stake?
 *
 * THE SAFETY NET HAS TO CATCH A BROKEN WALLET TOO, not only an empty one.
 * `NaN <= 0` is false, so a corrupted balance used to slip past this and leave
 * the player with no way back in at all. Anything that is not a usable positive
 * number counts as broke, because the alternative is a dead account.
 */
export function canClean(player, { timerRunning, inFlight }) {
  if (inFlight) return false;
  const b = player.balance;
  return (!Number.isFinite(b) || b <= 0) && !timerRunning;
}

// --- settlement ------------------------------------------------------------

/**
 * Apply a settled return to the player. Pure — returns the NEW player.
 *
 * `stake` is the balance AS IT WAS WHEN THE FLIP WENT LIVE, passed in by the
 * caller, never re-read from live state. The whole wallet is the stake, so the
 * end balance is simply the return, rounded once.
 */
export function settle(player, { stake, returned, flip, bets }) {
  const end = Math.max(0, Math.round(returned));
  return {
    ...player,
    balance: end,
    history: player.history.concat([{
      startBalance: stake,
      endBalance: end,
      totalStaked: stake,
      bustedYesterday: false,
      edge: !!(flip && flip.edge),
      bets: bets || [],
    }]),
  };
}

/**
 * A cleaning payout lands in the WALLET, never the bank.
 *
 * Banking is a separate, deliberate act; money that arrived straight in the bank
 * could never be risked, which would make the recovery a way of accumulating
 * safely rather than a way back to the table.
 */
export function settleClean(player, { paid, cleaned }) {
  const p = money(paid);
  return {
    ...player,
    balance: p,
    history: player.history.concat([{
      startBalance: 0,
      endBalance: p,
      totalStaked: 0,
      bustedYesterday: true,
      bets: [{ stake: 0, payoutMultiple: 0, kind: 'clean', cleaned, won: true }],
    }]),
  };
}
