// game/units.js
// ---------------------------------------------------------------------------
// The spin ladder and its two units, in ONE place.
//
// Everything here is re-exported or derived from flip3d/contract.js. Nothing is
// restated. That is the entire point: the preview declared its own
// `SPIN_MIN=8, SPIN_MAX=40, MEDIAN=24` and its own `QUADS=['NE',...]` beside
// contract.js's, and the two drifted until the builds disagreed about what a
// quadrant was called — a divergence that survived every green suite because
// each side was internally consistent with itself.
//
// THE TWO UNITS, and the one boundary between them:
//   internal  half-flips, integers 8..40 excluding 24 (N = 32)
//   player    ROTATIONS = half-flips / 2, one decimal
//
// Excluding the median is what makes higher/lower an exact 50/50 and balances
// parity so P(same side as start) = 0.500 exactly.
//
// NEVER say "half flips" to a player. toRotations/toHalfFlips are the only
// places the two units meet.
// ---------------------------------------------------------------------------

export {
  SPIN_MIN, SPIN_MAX, SPIN_MEDIAN, SPIN_VALUES,
  QUADRANTS, QUAD_RANGES, CARDINALS,
  toRotations, toHalfFlips, spinLabel,
  quadrantFromOrientation, exactCardinal, roundOrientation, normDeg,
} from '../flip3d/contract.js';

import {
  SPIN_MIN as _MIN, SPIN_MAX as _MAX, SPIN_MEDIAN as _MED, SPIN_VALUES as _VALS,
} from '../flip3d/contract.js';

/** 32. Derived, so it cannot fall out of step with the ladder it counts. */
export const SPIN_N = _VALS.length;

/** The same bounds the player sees, in rotations: 4.0 .. 20.0, 12.0 excluded. */
export const ROT_MIN = _MIN / 2;
export const ROT_MAX = _MAX / 2;
export const ROT_MEDIAN = _MED / 2;
