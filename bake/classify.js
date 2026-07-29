// classify.js — turning a quaternion track into honest metadata.
// ---------------------------------------------------------------------------
// This file decides the odds. A wrong half-flip count silently corrupts the
// posted payouts, so every claim here is either provable or gated.
//
// HOW THE HALF-FLIP COUNT IS DEFINED
//   Let n(t) be the heads-face normal in world space and c(t) = n(t).y.
//   The coin starts heads-up, c(0) = +1.
//   A half-flip is a CONFIRMED transit of the normal between the up cap
//   (c > +0.5, i.e. within 60 deg of up) and the down cap (c < -0.5).
//
//   Why hysteresis caps and not zero-crossings of c: a coin is the classic
//   thin-disc problem. Two motions add angle without adding flips —
//     * rim-rolling / Euler-disk settling: theta hovers at ~90 deg and the
//       normal precesses around the equator. Zero-crossing counters fire
//       many times here. The caps never see it.
//     * pole wobble after landing: theta oscillates near 0 (or 180). Again
//       no cap transit, so no count.
//   A genuine half-flip must take the normal from one cap to the other, so
//   the caps cannot miss one either (as long as the sampling rate resolves
//   180 deg of rotation, which PHYS.dt guarantees by a factor of ~15).
//
// THE PARITY INVARIANT (the self-check that protects the odds)
//   The counter's state flips on every count and starts "up", so
//       count is even  <=>  state is up  <=>  coin rests heads
//   Because a settled coin is flat (|c| > 0.99, far outside the caps), the
//   resting face is forced to agree with the counter state. assertParity()
//   below re-derives it independently and throws if they ever disagree.
//   That is the guarantee that `side` and `halfFlips` can never contradict
//   each other in the shipped library.
// ---------------------------------------------------------------------------

import { CLASSIFY, COIN, PHYS, HALF_FLIP_MIN, HALF_FLIP_MAX, HALF_FLIP_EXCLUDED } from './config.js';
import { headsNormal, bodyXAxis, angleBetween, heading } from './quat.js';

// --- the half-flip counter --------------------------------------------------

export function makeFlipCounter(band = CLASSIFY.flipBand) {
  let state = +1;          // +1 = heads-side up, -1 = tails-side up
  let count = 0;
  let arc = 0;             // accumulated great-circle arc of the normal (rad)
  let prevNormal = null;
  const ticks = [];        // sim time (s) of each half-flip, for beat tags

  return {
    /** feed one sample; t in seconds */
    push(q, t) {
      const n = headsNormal(q);
      if (prevNormal) arc += angleBetween(prevNormal, n);
      prevNormal = n;

      const c = n[1];
      if (state === +1 && c <= -band) { state = -1; count++; ticks.push(t); }
      else if (state === -1 && c >= band) { state = +1; count++; ticks.push(t); }
      return c;
    },
    get count() { return count; },
    get state() { return state; },
    /** arc length / pi — should equal `count` while the motion is pure tumbling */
    get arcHalfFlips() { return arc / Math.PI; },
    get ticks() { return ticks; },
  };
}

// --- the settle detector ----------------------------------------------------

export function makeSettleDetector(cfg = CLASSIFY) {
  let heldMs = 0;
  let settledAt = null;

  return {
    /** returns true once stillness has been held long enough */
    push({ linvel, angvel, cosTheta, tMs, dtMs }) {
      const still =
        Math.hypot(linvel.x, linvel.y, linvel.z) < cfg.settleLinVel &&
        Math.hypot(angvel.x, angvel.y, angvel.z) < cfg.settleAngVel &&
        Math.abs(cosTheta) > cfg.settleFlatCos;

      if (still) {
        heldMs += dtMs;
        if (heldMs >= cfg.settleHoldMs && settledAt === null) settledAt = tMs;
      } else {
        heldMs = 0;          // any twitch restarts the hold — this is the
        settledAt = null;    // jitter gate
      }
      return settledAt !== null;
    },
    get settledAtMs() { return settledAt; },
    get holdMs() { return heldMs; },
  };
}

// --- final classification ---------------------------------------------------

/**
 * Turn an ended simulation into metadata + a pass/fail verdict.
 * `sim` is the object produced by simulateClip().
 */
export function classify(sim, cfg = CLASSIFY) {
  const q = sim.finalRot;
  const n = headsNormal(q);
  const cosTheta = n[1];
  const halfFlips = sim.counter.count;

  // side: purely geometric, read off the final orientation.
  const side = cosTheta > 0 ? 'Heads' : 'Tails';

  // ORIENTATION — the coin's settled yaw. This is "which way the face design
  // is pointing", NOT where on the table it ended up. Design doc §2 cut table
  // position from the betting entirely; §6.5 wants the hundredths digit to be
  // the literal truth, so it is rounded to 2 dp and no further.
  const bx = bodyXAxis(q);                       // local +X taken to world
  const orientationDeg = +heading(bx[0], bx[2]).toFixed(2);   // clockwise from -Z
  const quadrant = headingToQuadrant(orientationDeg);

  // Displacement is kept ONLY as a quality gate (did it roll off the table).
  // It no longer has any bearing on the outcome.
  const dx = sim.finalPos.x - sim.launchPos.x;
  const dz = sim.finalPos.z - sim.launchPos.z;
  const displacement = Math.hypot(dx, dz);

  const meta = {
    halfFlips,
    side,
    quadrant,
    orientationDeg,
    durationMs: Math.round(sim.durationMs),
    // Same value as orientationDeg. Retained because the original shared
    // contract named this key; see the report — these two should be collapsed
    // into one once the renderer agent agrees.
    settleAngleDeg: orientationDeg,
  };

  const reject = firstFailure(sim, { cosTheta, displacement, halfFlips, side });

  return {
    meta,
    ok: reject === null,
    reject,
    diag: {
      cosTheta: +cosTheta.toFixed(6),
      displacement: +displacement.toFixed(5),
      arcHalfFlips: +sim.counter.arcHalfFlips.toFixed(3),
      airborneArcHalfFlips: +sim.airborneArcHalfFlips.toFixed(3),
      airborneCount: sim.airborneCount,
      arcExcess: +(sim.airborneArcHalfFlips - sim.airborneCount).toFixed(3),
      bounces: sim.bounces,
      apexY: +sim.apexY.toFixed(4),
      peakImpactSpeed: +sim.peakImpactSpeed.toFixed(4),
      steps: sim.steps,
      ticks: sim.counter.ticks.map((t) => +(t * 1000).toFixed(1)),
      contactsMs: sim.contactsMs.map((t) => +t.toFixed(1)),
    },
  };
}

function firstFailure(sim, { cosTheta, displacement, halfFlips, side }) {
  // Order matters: a coin that rolled off the table also fails to settle, and
  // reporting that as "no-settle" would hide the real reason and make the
  // damping tuning look like it was doing work it was not.
  if (sim.leftTable) return 'off-surface';
  if (!sim.settled) return 'no-settle';                       // timed out / jittered
  if (Math.abs(cosTheta) <= CLASSIFY.settleFlatCos) return 'edge-landing';

  const lim = PHYS.tableHalfExtent - CLASSIFY.tableMargin;
  if (Math.abs(sim.finalPos.x) > lim || Math.abs(sim.finalPos.z) > lim) return 'off-surface';
  if (sim.finalPos.y < -0.001 || sim.finalPos.y > 0.05) return 'off-surface';

  // No minimum-displacement gate any more: orientation is a yaw, so a coin
  // that settles exactly where it launched has a perfectly valid outcome.
  if (displacement > CLASSIFY.maxDisplacement) return 'too-far';

  // Precession made the flip count ambiguous: while airborne the motion must
  // be a clean tumble, so the swept arc must track the confirmed cap count.
  const excess = sim.airborneArcHalfFlips - sim.airborneCount;
  if (excess < CLASSIFY.arcExcessMin || excess > CLASSIFY.arcExcessMax) {
    return 'ambiguous-spin';
  }

  // PARITY INVARIANT — never ship a clip whose count contradicts its face.
  const parityFace = halfFlips % 2 === 0 ? 'Heads' : 'Tails';
  if (parityFace !== side) return 'parity-violation';

  if (halfFlips < HALF_FLIP_MIN || halfFlips > HALF_FLIP_MAX) return 'out-of-range';
  if (halfFlips === HALF_FLIP_EXCLUDED) return 'excluded-median';

  return null;
}

/**
 * Coarse bucket of orientationDeg, per the corrected contract:
 *   NE = [0,90)  SE = [90,180)  SW = [180,270)  NW = [270,360)
 * The betting UI still bets on quadrants; orientationDeg is the fine truth.
 * Named for the two cardinals a bucket spans BETWEEN, since orientation is
 * measured clockwise from north.
 */
export function headingToQuadrant(deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d < 90) return 'NE';
  if (d < 180) return 'SE';
  if (d < 270) return 'SW';
  return 'NW';
}

/** Half-open orientation range [lo,hi) covered by a quadrant. */
export function quadrantRange(qd) {
  return { NE: [0, 90], SE: [90, 180], SW: [180, 270], NW: [270, 360] }[qd];
}

/**
 * Independent re-derivation of the parity invariant, run over the FINAL clip
 * frames rather than the sim's live counter. Throws on disagreement.
 * This is the audit: if the exported frames and the exported meta ever drift
 * apart, the bake stops instead of shipping corrupt odds.
 */
export function assertParity(clip) {
  const last = clip.frames[clip.frames.length - 1];
  const n = headsNormal({ x: last.quat[0], y: last.quat[1], z: last.quat[2], w: last.quat[3] });
  const faceFromFrames = n[1] > 0 ? 'Heads' : 'Tails';
  const faceFromParity = clip.meta.halfFlips % 2 === 0 ? 'Heads' : 'Tails';
  if (faceFromFrames !== clip.meta.side || faceFromParity !== clip.meta.side) {
    throw new Error(
      `PARITY VIOLATION: meta.side=${clip.meta.side} frames=${faceFromFrames} ` +
      `parity(${clip.meta.halfFlips})=${faceFromParity}`);
  }
  // The coin must also be flat in the exported final frame.
  if (Math.abs(n[1]) < CLASSIFY.settleFlatCos) {
    throw new Error(`NOT FLAT at export: |cos|=${Math.abs(n[1]).toFixed(4)}`);
  }
}

/** Resting height of a flat coin — handy sanity constant. */
export const RESTING_Y = COIN.halfHeight;
