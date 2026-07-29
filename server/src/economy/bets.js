// bets.js — the bet slip: validation, fair pricing, the risk-spread split, and
// win resolution. Pure functions, no I/O, no clock — everything here is decided
// by the numbers alone so it can be tested exhaustively.

import { bad } from '../lib/http.js';
import {
  MULT_SIDE,
  MULT_EDGE,
  ORIENTATION_POOL,
  QUADRANTS,
  SPIN_POOL,
  SPIN_ROTATION_VALUES,
  SPIN_MODES,
  SIDE_PICKS,
  SPREAD_A,
  SPREAD_T_DEFAULT,
  ROT_MIN,
  ROT_MAX,
  ROT_MEDIAN,
} from './constants.js';

// --- pricing ----------------------------------------------------------------
// One rule for every axis: multiplier = pool size / outcomes covered. That is
// the fair (zero-edge) price of exactly what you covered; the ONLY house edge
// in the game comes from The Edge sweeping (see constants.js).

// How many of the 32 spin outcomes a line+mode covers.
export function spinCoverage(line, mode) {
  const pool = SPIN_ROTATION_VALUES;
  if (mode === 'higher') return pool.filter((v) => v > line).length;
  if (mode === 'lower') return pool.filter((v) => v < line).length;
  return pool.filter((v) => v === line).length; // exact
}

export function spinMultiplier(line, mode) {
  const covered = spinCoverage(line, mode);
  return covered ? SPIN_POOL / covered : 0;
}

export function orientationMultiplier(quadrants) {
  const n = quadrants.length;
  return n ? ORIENTATION_POOL / n : 0;
}

export function sideMultiplier(pick) {
  return pick === 'Edge' ? MULT_EDGE : MULT_SIDE;
}

// A rotation line is any half-rotation step in 4..20; the median 12 is
// unattainable by design, so it can never be an exact call.
export function isValidLine(line) {
  if (typeof line !== 'number' || !Number.isFinite(line)) return false;
  if (Math.round(line * 2) !== line * 2) return false; // 0.5 steps only
  if (line < ROT_MIN || line > ROT_MAX) return false;
  return line !== ROT_MEDIAN;
}

// --- risk spread ------------------------------------------------------------
// weight_i = mult_i^alpha / sum(mult^alpha),  alpha = SPREAD_A * (2t - 1).
// t=0.5 -> alpha=0 -> every weight 1/n (the plain even split).
// t<0.5 piles the wallet onto the short-odds money; t>0.5 pushes it out to the
// long shots. Weights always sum to 1, so the total EV is unchanged.
export function spreadWeights(multipliers, t = SPREAD_T_DEFAULT) {
  const alpha = SPREAD_A * (2 * t - 1);
  const raw = multipliers.map((m) => Math.pow(m, alpha));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    return multipliers.map(() => 1 / multipliers.length);
  }
  return raw.map((r) => r / sum);
}

// --- slip validation --------------------------------------------------------

const MODE_ALIASES = { gt: 'higher', lt: 'lower', over: 'higher', under: 'lower', exact: 'exact' };

export function normalizeSlip(raw = {}) {
  const slip = { side: null, orientation: [], spin: null, spread: SPREAD_T_DEFAULT };

  if (raw.side != null) {
    if (!SIDE_PICKS.includes(raw.side)) {
      throw bad('bad_side', `side must be one of ${SIDE_PICKS.join(', ')}`);
    }
    slip.side = raw.side;
  }

  if (raw.orientation != null) {
    if (!Array.isArray(raw.orientation)) throw bad('bad_orientation', 'orientation must be an array');
    const seen = new Set();
    for (const q of raw.orientation) {
      if (!QUADRANTS.includes(q)) throw bad('bad_orientation', `unknown quadrant ${q}`);
      seen.add(q);
    }
    slip.orientation = QUADRANTS.filter((q) => seen.has(q));
  }

  if (raw.spin != null) {
    const line = typeof raw.spin.line === 'string' ? Number(raw.spin.line) : raw.spin.line;
    const mode = MODE_ALIASES[raw.spin.mode] ?? raw.spin.mode ?? 'exact';
    if (!SPIN_MODES.includes(mode)) throw bad('bad_spin_mode', `spin.mode must be one of ${SPIN_MODES.join(', ')}`);
    if (!isValidLine(line)) {
      throw bad(
        'bad_spin_line',
        `spin.line must be a 0.5 step in ${ROT_MIN}..${ROT_MAX} and not ${ROT_MEDIAN}`
      );
    }
    if (spinCoverage(line, mode) === 0) {
      // "lower" at 4 (or "higher" at 20) covers nothing and can never win.
      // Refuse it outright rather than quietly taking money for a dead bet.
      throw bad('spin_covers_nothing', `${mode} ${line} covers no outcome`);
    }
    slip.spin = { line, mode };
  }

  if (raw.spread != null) {
    const t = typeof raw.spread === 'string' ? Number(raw.spread) : raw.spread;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
      throw bad('bad_spread', 'spread must be a number in 0..1');
    }
    slip.spread = t;
  }

  // Calling Edge puts the WHOLE stake on the rim. The other axes are locked out
  // rather than auto-filled: on a rim landing they are swept anyway, and on any
  // other landing they would quietly carry stake the player never chose to place.
  if (slip.side === 'Edge' && (slip.orientation.length || slip.spin)) {
    throw bad('edge_is_exclusive', 'Calling Edge stakes the whole wallet on the rim; clear the other rows');
  }

  return slip;
}

// --- portions ---------------------------------------------------------------
// The wallet IS the stake and it splits across the placed bets by the spread
// weights. A 1x "bet" hands the stake straight back whatever the coin does, so
// covering all four quadrants is a REFUND and is dropped: left in the split it
// would be an escape hatch, letting a player look all-in while actually risking
// a fraction, ducking both the forced all-in and the floor.

export function buildPortions(slip) {
  const ignored = [];

  if (slip.side === 'Edge') {
    return { portions: [{ key: 'side', pick: 'Edge', mult: MULT_EDGE, weight: 1 }], ignored };
  }

  const candidates = [];
  if (slip.side) candidates.push({ key: 'side', pick: slip.side, mult: sideMultiplier(slip.side) });
  if (slip.orientation.length) {
    candidates.push({
      key: 'orientation',
      pick: [...slip.orientation],
      mult: orientationMultiplier(slip.orientation),
    });
  }
  if (slip.spin) {
    candidates.push({
      key: 'spin',
      pick: { ...slip.spin },
      mult: spinMultiplier(slip.spin.line, slip.spin.mode),
    });
  }

  const live = candidates.filter((c) => {
    if (c.mult > 1) return true;
    ignored.push({ key: c.key, reason: c.mult === 1 ? 'refund_not_a_bet' : 'covers_nothing' });
    return false;
  });

  if (live.length) {
    const w = spreadWeights(live.map((c) => c.mult), slip.spread);
    live.forEach((c, i) => {
      c.weight = w[i];
    });
  }

  return { portions: live, ignored };
}

// The headline number: the stake-weighted multiple if every placed bet wins.
export function totalMultiple(portions) {
  return portions.reduce((sum, p) => sum + p.weight * p.mult, 0);
}

// --- resolution -------------------------------------------------------------
// A rim landing sweeps the table. The only thing that can win on an Edge is
// having called the Edge.

export function resolvePortion(portion, flip) {
  if (portion.key === 'side') {
    if (portion.pick === 'Edge') return !!flip.edge;
    return !flip.edge && portion.pick === flip.side;
  }
  if (flip.edge) return false; // swept
  if (portion.key === 'orientation') return portion.pick.includes(flip.quadrant);
  if (portion.key === 'spin') {
    const { line, mode } = portion.pick;
    const landed = flip.rotations;
    if (mode === 'higher') return landed > line;
    if (mode === 'lower') return landed < line;
    return landed === line;
  }
  return false;
}
