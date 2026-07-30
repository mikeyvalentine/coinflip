// game/bets.js
// ---------------------------------------------------------------------------
// THE BETTING MATHS. Pure: no DOM, no canvas, no globals.
//
// This is the preview's pricing logic lifted out verbatim in behaviour and
// parameterised in shape. Every function that used to read a module-level `bet`,
// `betMode` or `shownStart` now takes them, which is the whole reason the merged
// page can share this file instead of owning a second copy.
//
// WHY EXTRACTING IT MATTERED. The 2D game and the 3D renderer each grew their
// own copy of the outcome model, and the copies drifted until they disagreed
// about what a quadrant was CALLED — a bug that survived every green suite for
// weeks because each build was internally consistent. The constants here are
// imported from flip3d/contract.js and flip3d/outcome.js rather than restated,
// so there is exactly one definition of the spin ladder, the quadrant names and
// the rim probability in the project.
//
// THE `bet` SHAPE, unchanged from the preview:
//   { side?: 'Heads'|'Tails'|'Edge',
//     orientation?: string[],          // quadrant names, multi-select
//     spins?: { line: number, mode: 'exact'|'gt'|'lt' } }   // line in ROTATIONS
// ---------------------------------------------------------------------------

import {
  SPIN_VALUES, SPIN_N, QUADRANTS,
  toRotations, ROT_MIN, ROT_MAX, ROT_MEDIAN,
} from './units.js';
import { EDGE_P } from '../flip3d/outcome.js';

export { EDGE_P };

/**
 * Fair (zero-edge) multipliers for the fixed axes.
 *
 * Spin is NOT here: it is priced from the line you type (see spinMultFor), so a
 * constant would be a lie. Edge is priced N-1 on N — 499x on a 1-in-500 shot,
 * not 500x — which is the only thing creating a house edge and is what makes it
 * a uniform 0.20% on every bet rather than a tax on one axis.
 */
export const MULT = { side: 2, orientation: 4, edge: 499 };

export const fmtMult = (m) => (Number.isInteger(m) ? m : Math.round(m * 100) / 100);

// --- the spin line ---------------------------------------------------------

/** The 32 outcomes, in ROTATIONS — the unit the player types and reads. */
export function spinPool() { return SPIN_VALUES.map(toRotations); }

export function countFor(line, mode, pool = spinPool()) {
  return mode === 'gt' ? pool.filter((x) => x > line).length
    : mode === 'lt' ? pool.filter((x) => x < line).length
      : pool.filter((x) => x === line).length;
}

/**
 * poolSize / winning-outcomes — the fair price of whatever the line covers.
 * 0 means the bet covers nothing and can never win (a line at either extreme
 * with the modifier pointing off the end).
 */
export function spinMultFor(line, mode, pool = spinPool()) {
  const c = countFor(line, mode, pool);
  return c ? pool.length / c : 0;
}

/**
 * ACCEPT ANY SPELLING OF A HALF STEP.
 *
 * This was `/^\d+(\.5)?$/`, which rejected "10.0" — the exact string the game
 * puts on screen. The live counter reads "spin: 10.0" and a lost line reports
 * "10.0", so the player read a value off the display, typed it straight back,
 * and got silence: no multiplier, no bet, and nothing saying why. A validator
 * that refuses its own program's output format is never the player's mistake.
 */
export function validLine(s) {
  if (!/^\d+(\.\d+)?$/.test(s)) return false;
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return false;
  if (Math.abs(v * 2 - Math.round(v * 2)) > 1e-9) return false;   // must land on a half step
  const r = Math.round(v * 2) / 2;
  return r >= ROT_MIN && r <= ROT_MAX && r !== ROT_MEDIAN;
}

/** The canonical half-step the typed text means, so 10.00 and 10.0 are one line. */
export function lineValue(s) { return Math.round(parseFloat(s) * 2) / 2; }

// --- per-axis multipliers --------------------------------------------------

export function orientSel(bet) { return (bet && bet.orientation) || []; }

/** 4 / quadrants selected. 0 or 4 is a REFUND, not a wager — see placedBets. */
export function orientMult(bet) {
  const k = orientSel(bet).length;
  return (k === 0 || k === 4) ? 1 : 4 / k;
}

export function sideMult(bet) {
  return bet && bet.side === 'Edge' ? MULT.edge : MULT.side;
}

export function spinsMult(bet) {
  return !(bet && bet.spins) ? 0 : spinMultFor(bet.spins.line, bet.spins.mode);
}

/**
 * The calls actually on the board.
 *
 * Edge takes the whole wallet and locks the other axes out, so it is its own
 * board of one — on a rim landing they are swept anyway, and on any other
 * landing they would quietly carry real stake the player never chose to place.
 *
 * A 1x "bet" hands the wallet straight back whatever the coin does, so covering
 * all four quadrants is a refund rather than a wager and never takes a share.
 * Left in, it becomes an escape hatch: park the wallet there and you are
 * nominally all-in while actually risking a fraction.
 */
export function placedBets(bet) {
  if (bet && bet.side === 'Edge') return [{ key: 'side', mult: MULT.edge }];
  const list = [];
  if (bet && bet.side) list.push({ key: 'side', mult: sideMult(bet) });
  if (orientSel(bet).length) list.push({ key: 'orient', mult: orientMult(bet) });
  if (bet && bet.spins) list.push({ key: 'spins', mult: spinsMult(bet) });
  return list.filter((x) => x.mult > 1);
}

// --- resolution ------------------------------------------------------------

export function resolveSide(bet, flip) {
  return bet.side === 'Edge' ? !!flip.edge : (!flip.edge && bet.side === flip.side);
}

export function resolveOrient(bet, flip) {
  return orientSel(bet).includes(flip.quadrant);
}

export function resolveSpins(bet, flip) {
  // Both sides in ROTATIONS — the unit the player typed and the counter showed.
  const landed = toRotations(flip.spins);
  const { line, mode } = bet.spins;
  return mode === 'gt' ? landed > line : mode === 'lt' ? landed < line : landed === line;
}

/**
 * Did this line win?
 *
 * A rim landing SWEEPS the table: the only thing that can win is having called
 * Edge. The `flip.edge` guard is load-bearing beyond the odds — the shared draw
 * NULLS spins/quadrant/orientationDeg on a rim landing, so reaching
 * resolveSpins() with one would compare against NaN and silently return false
 * for the wrong reason. Returning early means the nulls are never touched.
 */
export function winOf(x, bet, flip) {
  if (x.key === 'side') return resolveSide(bet, flip);
  if (flip.edge) return false;
  return x.key === 'orient' ? resolveOrient(bet, flip) : resolveSpins(bet, flip);
}

// --- the two presets -------------------------------------------------------

/**
 * SPREAD weights go as 1/mult, which is the ONLY split where every call that
 * lands pays the same: back a 32x line with a sliver and a 2x call with the
 * bulk, sized so both come home identical. K is that shared payout.
 *
 *   K = 1 / sum(1/mult)
 *
 * It also removes "right but poorer" wherever K >= 1 — under an even split,
 * calling the coin correctly LOST a third of the wallet 36% of the time,
 * because the long shot placed alongside it ate the rest.
 */
export function spreadWeights(mults) {
  const inv = mults.map((m) => 1 / m);
  const t = inv.reduce((a, b) => a + b, 0);
  return inv.map((v) => v / t);
}

export function spreadK(bet) {
  const b = placedBets(bet);
  return b.length ? 1 / b.map((x) => 1 / x.mult).reduce((a, c) => a + c, 0) : 0;
}

/**
 * The outcome space, enumerated exactly: 32 spin values x 4 quadrants, plus the
 * rim. 129 atoms is nothing to walk, and walking it is the only honest way to
 * price RIDE — because SIDE IS NOT INDEPENDENT OF SPIN. Side is spin parity read
 * against the shown start face, so "Heads" and "exactly 10.0 rotations" is one
 * call wearing two hats. Multiplying the marginals posts 256x on a bet whose
 * true price is 128x, and hands that 2x away every day forever.
 */
export function atomsFor(startFace) {
  const out = [];
  const startHeads = startFace === 'Heads';
  for (const sp of SPIN_VALUES) {
    for (const q of QUADRANTS) {
      out.push({
        p: (1 - EDGE_P) / (SPIN_N * QUADRANTS.length),
        spins: sp,
        quadrant: q,
        side: ((sp % 2 === 0) === startHeads) ? 'Heads' : 'Tails',
        edge: false,
      });
    }
  }
  out.push({ p: EDGE_P, edge: true });   // the rim sweeps the table
  return out;
}

/**
 * RIDE: one compound call, priced on the TRUE JOINT probability of every placed
 * call landing together — never the product of their multipliers.
 *
 * The rim is left out of the pricing on purpose: it sweeps the table, and that
 * sweep IS the house edge, so excluding it here keeps RIDE on the same uniform
 * 0.20% as everything else.
 */
export function rideProb(bet, startFace) {
  const b = placedBets(bet);
  if (!b.length) return 0;
  if (bet.side === 'Edge') return EDGE_P;
  let n = 0;
  for (const a of atomsFor(startFace)) {
    if (a.edge) continue;
    if (b.every((x) => winOf(x, bet, a))) n++;
  }
  return n / (SPIN_N * QUADRANTS.length);
}

export function rideMult(bet, startFace) {
  if (bet && bet.side === 'Edge') return MULT.edge;
  const p = rideProb(bet, startFace);
  return p > 0 ? 1 / p : 0;
}

/**
 * What each preset is offering, in the two numbers that matter: how often it
 * pays NOTHING, and the best it can do.
 *
 * Both, together, on purpose. The ladder this replaced showed only the second,
 * so every rung of a SHARP board paid more than every rung of a loose one and
 * being specific read as a free upgrade — it displayed the reward and hid the
 * risk.
 */
export function modeStats(bet, startFace) {
  const b = placedBets(bet);
  if (!b.length) return null;
  let sNothing = 0;
  let rNothing = 0;
  for (const a of atomsFor(startFace)) {
    const hits = b.map((x) => winOf(x, bet, a));
    if (!hits.some(Boolean)) sNothing += a.p;
    if (!hits.every(Boolean)) rNothing += a.p;
  }
  return {
    spread: { nothing: sNothing, best: spreadK(bet) * b.length },
    ride: { nothing: rNothing, best: rideMult(bet, startFace) },
  };
}

/** The placed calls with their stake weights. RIDE has no split, so w = 0. */
export function portions(bet, betMode) {
  const b = placedBets(bet);
  if (!b.length) return [];
  if (betMode === 'ride') { b.forEach((x) => { x.w = 0; }); return b; }
  const w = spreadWeights(b.map((x) => x.mult));
  b.forEach((x, i) => { x.w = w[i]; });
  return b;
}

/**
 * THE SETTLEMENT, computed WITHOUT animating anything.
 *
 * The preview's reveal returned the money as a side effect of animating it,
 * which welded the amount a player is paid to a chain of awaited timeouts. That
 * is fine until the animation throws, or is skipped, or a renderer replaces it —
 * and then the payout is whatever the animation happened to reach. Here the
 * arithmetic stands alone and the reveal animates TOWARD a number already
 * decided, so tools/verify-merged.mjs can assert the two agree rather than hope.
 *
 * @returns {number} the wallet AFTER the flip, in whole B, never negative.
 */
export function settleReturn(bet, betMode, flip, stake, startFace) {
  const p = portions(bet, betMode);
  if (!p.length) return stake;              // nothing placed: nothing at risk

  if (betMode === 'ride') {
    // One compound call: every placed line must land, or it pays nothing.
    const allLanded = p.every((x) => winOf(x, bet, flip));
    return allLanded ? stake * rideMult(bet, startFace) : 0;
  }

  let running = stake;
  for (const x of p) {
    const perBet = x.w * stake;
    running += winOf(x, bet, flip) ? perBet * (x.mult - 1) : -perBet;
  }
  return Math.max(0, running);
}
