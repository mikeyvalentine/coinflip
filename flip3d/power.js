// flip3d/power.js
// ---------------------------------------------------------------------------
// POWER 0..1 -> the visible character of a throw. Pure maths: no DOM, no scene,
// no three.js, no time. charge.js produces the number, this file decides what it
// means, player.js spends it.
//
// ===========================================================================
// THE BOUNDARY. READ BEFORE ADDING ANYTHING TO THIS FILE.
// ===========================================================================
// Power may change how a flip LOOKS. It may not change WHAT IT IS.
//
//   the outcome  = startFace, spins (half-flips), side, quadrant
//                  -> drawn uniformly from the seed in outcome.js. Power is not
//                     an input to that draw and must never become one here.
//   the telling  = which of the cell's 8 variants plays, how long the lead-in
//                  runs, how the camera behaves
//                  -> power owns all of this.
//
// The intended FINAL design is that power narrows the reachable band of spin
// counts (a limp toss cannot produce 20 rotations). That changes the betting
// odds, so it is deliberately NOT wired up. The seam it will attach to is
// `outcomeBand()` at the bottom of this file, which today returns the full 32
// values and is asserted to do so by tools/verify-power.mjs.
// ===========================================================================

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;

// --- gesture thresholds ----------------------------------------------------
/** Below this the release is a CANCEL, not a limp throw. */
export const MIN_POWER = 0.06;
/** Drag distance, in CSS px, that spans 0 -> 1. */
export const CHARGE_TRAVEL_PX = 190;

// --- lead-in ---------------------------------------------------------------
// The lead-in is the only motion the player invents: it carries the coin from
// resting on the table up to the clip's release point at 0.22 m. It used to be
// a flat 110 ms for every throw, which is why every flip started identically.
//
// It is now derived from the CLIP'S OWN LAUNCH SPEED, measured off frames[0] ->
// frames[1], times a power-scaled multiplier. Constant-acceleration over a
// known height h with a known exit speed v fixes the duration exactly:
//   h = v/2 * L   ->   L = 2h/v
// so matching the handoff velocity and choosing the duration are the same act.
// A hard pull exits ~1.30x the clip's launch speed (short, snappy lead-in); a
// feather exits ~0.80x (long, floaty one). The bake's launch range is
// vy 2.05..3.30 m/s, so the reachable lead-in is roughly 100..270 ms.
export const LEADIN = {
  exitScaleMin: 0.80,   // power 0: slower than the clip's own launch -> a lob
  exitScaleMax: 1.30,   // power 1: faster -> a whip
  msMin: 70,
  msMax: 280,
  fallbackMs: 110,      // clip launch speed unreadable: the old constant
  /** Fraction of the lead-in spent winding up before the coin moves. */
  anticipationMax: 0.26,
};

// --- procedural fallback ---------------------------------------------------
// Only the procedural builder lets the renderer choose the flight, so it is the
// one path where power really does set apex height. Airborne time is the single
// knob and apex follows from it (h = g*T^2/8), so this cannot read floaty.
// T 0.44..0.78 s -> apex 0.24..0.75 m, which brackets what the bake produced.
//
// ON THE BAKED PATH APEX IS NOT REACHABLE, and pretending otherwise would mean
// time-warping a real simulation. Within one cell the bake fixes the half-flip
// count, which fixes the flight time, which fixes the apex — measured across
// all 128 cells the 8 variants differ in apex by under 2%. So on the default
// path power buys: a shorter, harder lead-in (215 -> 131 ms), a coin that
// travels half again as far, a faster camera, and a different measured settle
// yaw. If apex is wanted there too, the bake needs an apex-ranked variant axis;
// `energy` is explicitly not one (bake/curate.js#energyRaw).
export const PROC_AIRBORNE = { min: 0.44, max: 0.78 };

// --- camera ----------------------------------------------------------------
// Presentation, and labelled as such. A hard pull gets out of the way faster and
// further, so the toss reads bigger. It does not move the coin.
export const CAM_POWER = {
  pulloutMsMax: 320,    // power 0: camera lingers
  pulloutMsMin: 165,    // power 1: camera snaps out
  distanceApexMin: 0.35,
  distanceApexMax: 0.47,
};

/**
 * Everything a throw needs from its power, in one object.
 *
 * @param {number} power 0..1
 * @param {object} [ctx]
 * @param {number} [ctx.launchSpeed] the clip's own launch speed in m/s, measured
 *        off its first two frames. Omit for the procedural path.
 * @param {number} [ctx.launchHeight] metres from rest to the clip's first frame.
 * @param {number} [ctx.daringness] 0..1 trait, passed straight to selectVariant.
 */
export function throwProfile(power, ctx = {}) {
  const p = clamp01(power);
  const daringness = ctx.daringness ?? 0.5;

  // --- lead-in ---
  const h = ctx.launchHeight;
  const v = ctx.launchSpeed;
  let leadInMs = LEADIN.fallbackMs;
  let exitSpeed = null;
  if (Number.isFinite(h) && h > 0 && Number.isFinite(v) && v > 0.05) {
    exitSpeed = v * lerp(LEADIN.exitScaleMin, LEADIN.exitScaleMax, p);
    leadInMs = clamp((2 * h / exitSpeed) * 1000, LEADIN.msMin, LEADIN.msMax);
  }

  return {
    power: p,
    // The mandated hook: identity.js#selectVariant(variants, {..., flickForce}).
    // flickForce IS the power. Nothing else about the pull reaches the library.
    flickForce: p,
    daringness,

    leadInMs,
    leadInExitSpeed: exitSpeed,
    /** Fraction of the lead-in the coin stays put, winding up. */
    leadInAnticipation: LEADIN.anticipationMax * p * p,

    /** Procedural path only: real ballistics, apex = g*T^2/8 follows from this. */
    airborneSec: lerp(PROC_AIRBORNE.min, PROC_AIRBORNE.max, p),
    /** Derived, never chosen — stated here so the report can quote it. */
    proceduralApexM: 0.00075 + 9.81 * lerp(PROC_AIRBORNE.min, PROC_AIRBORNE.max, p) ** 2 / 8,

    camPulloutMs: lerp(CAM_POWER.pulloutMsMax, CAM_POWER.pulloutMsMin, p),
    camDistanceApex: lerp(CAM_POWER.distanceApexMin, CAM_POWER.distanceApexMax, p),
  };
}

/** Launch speed in m/s from a clip's first two frames, or null if unreadable. */
export function clipLaunchSpeed(clip, timeScale = 1) {
  const f = clip && clip.frames;
  if (!f || f.length < 2) return null;
  const dt = (f[1].t - f[0].t) * timeScale / 1000;
  if (!(dt > 0)) return null;
  const dx = f[1].pos[0] - f[0].pos[0];
  const dy = f[1].pos[1] - f[0].pos[1];
  const dz = f[1].pos[2] - f[0].pos[2];
  return Math.hypot(dx, dy, dz) / dt;
}

// ===========================================================================
// ***  THE SEAM  ***
// ===========================================================================
// This is the ONE function that would make power change the odds, and it is
// deliberately inert. It returns the full spin ladder no matter what it is
// handed, so outcome.js's draw is bit-for-bit what it was before power existed.
//
// TO WIRE IT UP LATER (once the pricing is settled), the whole change is:
//   1. set POWER_NARROWS_BAND = true
//   2. fill in the body of bandForPower() with the agreed mapping
//   3. pass { band: bandForPower(power) } through resolveFlip's third argument
//      from the ONE call site in coinflip-3d.html#arm()
// and nothing else moves. outcome.js already accepts the band and already
// divides the hash modulo band.length instead of 32.
//
// The reason it is off: narrowing the band changes P(spins) and therefore the
// posted payout on the spin axis, and the pricing is not settled. Leaving the
// mapping stubbed is safer than leaving it plausible.
// ===========================================================================
export const POWER_NARROWS_BAND = false;

/**
 * The spin values a throw of this power may reach.
 * @param {number[]} allValues the full ladder (contract.js#SPIN_VALUES)
 * @param {number} power 0..1
 * @returns {number[]} today: `allValues`, always, unchanged, same array order.
 */
export function outcomeBand(allValues, power) {
  if (!POWER_NARROWS_BAND) return allValues;
  return bandForPower(allValues, power);   // unreachable until the flag flips
}

/** Intentionally unimplemented. See the block above. */
export function bandForPower(allValues, power) {   // eslint-disable-line no-unused-vars
  throw new Error(
    'power->spin band is not designed yet: narrowing the band changes the posted ' +
    'odds on the spin axis. See flip3d/power.js#THE SEAM.',
  );
}
