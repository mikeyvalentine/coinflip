// constants.js — the locked numbers. Every one of these is enforced server-side.
// The client may render them (GET /api/config) but may never assert them.

// --- money ------------------------------------------------------------------

// The wallet is ALWAYS fully at risk: there is no stake field, the stake IS the
// wallet balance. You may bank DOWN TO this floor but never below it, so the
// wallet can only reach 0 by losing — never by being emptied on purpose.
export const WALLET_FLOOR = 50;

// The Broke Flip: free heads-or-tails call at 0₿, pays this. Consumes the day.
export const FREE_BET_RETURN = 50;

// One flip per player per 24h. Per-player, never a shared daily flip.
export const FLIP_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// --- the spin axis ----------------------------------------------------------
// Internally an integer count of HALF-FLIPS, 8..40, excluding the median 24.
// N = 32 outcomes. Excluding 24 makes higher/lower an exact 50/50 (16 either
// side) and balances parity 16 even / 16 odd, so P(same side as start) = 0.5.
//
// PLAYER-FACING everything is ROTATIONS = half-flips / 2 (4..20 in 0.5 steps,
// 12 unattainable). Never say "half flips" to a player. The two units meet at
// toRotations/toHalfFlips and nowhere else.
export const SPIN_MIN_HALF = 8;
export const SPIN_MAX_HALF = 40;
export const SPIN_MEDIAN_HALF = 24;

export const SPIN_HALF_VALUES = [];
for (let s = SPIN_MIN_HALF; s <= SPIN_MAX_HALF; s++) {
  if (s !== SPIN_MEDIAN_HALF) SPIN_HALF_VALUES.push(s);
}
export const SPIN_N = SPIN_HALF_VALUES.length; // 32

export const toRotations = (halfFlips) => halfFlips / 2;
export const toHalfFlips = (rotations) => Math.round(rotations * 2);

export const ROT_MIN = SPIN_MIN_HALF / 2;       // 4
export const ROT_MAX = SPIN_MAX_HALF / 2;       // 20
export const ROT_MEDIAN = SPIN_MEDIAN_HALF / 2; // 12, unattainable
export const SPIN_ROTATION_VALUES = SPIN_HALF_VALUES.map(toRotations);

// --- the orientation axis ---------------------------------------------------
// The angle the coin's face is turned to once it settles — about the coin
// itself, never where on the table it landed. Resolved to two decimals; the
// quadrants are the coarse buckets the current UI bets on.
// Named for the two cardinals each bucket spans BETWEEN: orientation is
// clockwise from north, so [0,90) is the north-east sector. N/E/S/W are
// reserved for exact 90-degree multiples.
export const QUADRANTS = ['NE', 'SE', 'SW', 'NW'];
export const ORIENTATION_PRECISION = 100; // hundredths of a degree

// --- multipliers (all fair / zero-edge) -------------------------------------
// side        : 2x                  (1 of 2)
// orientation : 4 / quadrants       (1 quad 4x, 2 quads 2x, 3 quads 1.33x)
// spin        : 32 / outcomes covered
// A 1x "bet" hands the stake straight back whatever the coin does, so covering
// all four quadrants is a REFUND, not a wager, and is never treated as a bet.
export const MULT_SIDE = 2;
export const ORIENTATION_POOL = QUADRANTS.length; // 4
export const SPIN_POOL = SPIN_N;                  // 32

// --- THE EDGE ---------------------------------------------------------------
// The coin lands on its rim. 1/500. It SWEEPS: side, orientation and spin all
// lose. Priced the way roulette prices its zero — N-1 on N, i.e. 499x on a
// 1-in-500 shot, not 500x — which is the single thing that creates the house
// edge, and creates exactly the SAME edge on every bet:
//   any fairly-priced bet:  EV = (499/500) * (pool/covered) * (covered/pool) = 0.998
//   the Edge itself:        EV = (1/500)   * 499                             = 0.998
// => a uniform 0.20% house edge, everywhere, always.
export const EDGE_DENOM = 500;
export const EDGE_P = 1 / EDGE_DENOM;
export const MULT_EDGE = EDGE_DENOM - 1; // 499
export const HOUSE_EDGE = 1 - MULT_EDGE / EDGE_DENOM; // 0.002 exactly

// --- risk spread ------------------------------------------------------------
// One slider instead of per-row amount fields. Each placed bet is weighted by
// mult^alpha, alpha = SPREAD_A * (2t - 1). t = 0.5 -> alpha 0 -> equal split, so
// the midpoint IS the plain even split and doing nothing changes nothing.
// EV is identical at every position (every bet is fairly priced), so the slider
// moves volatility only and can never change the edge.
export const SPREAD_A = 2;
export const SPREAD_T_DEFAULT = 0.5;

export const SIDES = ['Heads', 'Tails'];
export const SIDE_PICKS = ['Heads', 'Tails', 'Edge'];
export const SPIN_MODES = ['exact', 'higher', 'lower'];
