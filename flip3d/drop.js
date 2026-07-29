// flip3d/drop.js
// ---------------------------------------------------------------------------
// THE COIN, LET GO. Fall, wobble, settle.
//
// grab.js lets the player pick the coin up off the table. A downward pull is a
// throw; anything less is a release, and nobody sets a coin down gently — they
// open their hand. Until now that path called flipper.ready(), which slerped the
// coin home through the air. A coin held 3 cm up and released does not glide
// home. It drops.
//
// ===========================================================================
// THIS IS NOT A FLIP AND MUST NEVER BE MISTAKEN FOR ONE.
// ===========================================================================
// It has no outcome, it does not spend the daily flip, and above all THE COIN
// DOES NOT TURN OVER. The face showing at release is the face showing at rest.
//
// That is not a stylistic preference. The game shows the coin's starting face
// before the flip, and side and spin are independent betting axes precisely
// BECAUSE the start face is known — expectedSide() is pure parity off it. A drop
// that turned the coin over would silently change the declared start face and
// the next bet would be resolved against a lie.
//
// The guarantee is structural rather than tested-in. Every pose here is
//     qTilt(theta, azimuth) * restQuatForFace(face)
// where qTilt is a rotation about a HORIZONTAL axis. The coin's local +Y under
// the rest quat is exactly +/-world Y, so tilting it by theta puts the up-axis
// at +/-cos(theta): the sign can only change if |theta| exceeds 90 degrees.
// TILT_HARD_CAP is 40, and the wobble's own envelope is monotone decreasing from
// its initial amplitude, so |theta| never exceeds that amplitude either. There
// are two independent reasons the face cannot invert, and verify-drop.mjs §2
// samples it at 4 kHz anyway.
// ---------------------------------------------------------------------------
//
// THE SHAPE OF THE MOTION, and why it is arranged this way.
//
// The numbers first, because they dictate the design: LIFT.maxY is 0.032 m and
// a coin rests at 0.00075 m, so the longest fall is 3.1 cm and takes 79 ms. The
// fall is essentially invisible. Almost all of the animation's PERCEIVED length
// is the wobble, and the temptation is therefore to stretch the fall to give the
// eye something to follow. That is exactly the mistake this project already made
// once with bullet time: slowing a descent reads as low gravity, not as drama,
// and it was thrown out. The fall here is honest free fall under 9.81 and gets
// no help at all.
//
//   FALL     y = y0 - g t^2 / 2, straight down the lift line. The coin leans in
//            over the fall, from flat to the amplitude it will land on, so it
//            arrives on an edge rather than slapping down perfectly flat. The
//            lean is a lean, never a turn.
//   SETTLE   a damped rock: tilt oscillates about zero with a monotonically
//            decaying envelope and a RISING frequency, which is the Euler's-disk
//            character the eye recognises as a coin rather than a pendulum.
//   BOUNCE   an optional additive hop on the height, for the variants that have
//            one. Real restitution off the measured impact speed.
//
// THE HEIGHT DURING THE ROCK IS NOT INVENTED. A disc of radius r and half
// thickness h tilted by theta touches the table when its centre is at
//     r*sin|theta| + h*cos|theta|
// so the bobbing as it rocks is just that expression following the tilt. This is
// why the coin cannot sink into the table and why it lands lower each cycle
// without any of that being animated separately: geometry does it. It also means
// the height bob runs at DOUBLE the tilt frequency (the coin passes through flat
// twice per rock), which is correct and would have been fiddly to fake.
//
// AMPLITUDE IS CAPPED BY THE DROP, twice over. Once by energy — the initial tilt
// scales with impact speed, so a coin lifted 2 mm barely stirs — and once by
// geometry, since a coin cannot rock up higher than it was released from.
// maxTiltForHeight() solves that second cap exactly rather than fudging it, and
// it is what keeps "never rises above the release height" true at every height
// instead of only at the ones anyone thought to check.
// ---------------------------------------------------------------------------

import { makeRng } from '../bake/prng.js';
import {
  COIN_RADIUS_M, COIN_HALF_THICKNESS_M, GRAVITY_MS2,
  restQuatForFace,
} from './contract.js';
import { LIFT, SHADOW_RADIUS } from './scene.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

/** Resting centre height. The floor for everything below. */
export const REST_Y = COIN_HALF_THICKNESS_M;

/**
 * The largest tilt any variant may reach, in DEGREES.
 *
 * 40 is not a look, it is a margin. The face inverts at 90; the envelope already
 * bounds the tilt by its own initial amplitude; this is the third guard, so that
 * a future variant table edited without reading this header still cannot produce
 * a coin that turns over.
 */
export const TILT_HARD_CAP_DEG = 40;

/** Drop distance that counts as "full energy" — the whole lift range. */
export const DROP_REF_M = LIFT.maxY - REST_Y;

/**
 * Fraction of the available drop the tilt may claim, leaving the rest as fall.
 *
 * Without it, a coin released a fraction of a millimetre up gets a tilt whose
 * contact height IS the release height: the fall becomes 2e-7 ms, the lean-in
 * has no duration to happen over, and the coin snaps to its landing angle in a
 * single frame. 0.85 keeps a real fall at every height and never binds above
 * ~11 mm, where the hard cap is already the limit.
 */
export const TILT_HEADROOM = 0.85;

// --- the variants ----------------------------------------------------------
// FIVE. The request was "a few", and five is where the axes stop producing
// anything the eye can tell apart: the ones that read as different are how far
// it tips, how long it rings, how fast the ringing accelerates, and whether it
// bounces first. Beyond that the differences land inside the noise of a 3 cm
// drop, and a sixth entry would be a claim with nothing behind it —
// verify-drop.mjs §8 measures pairwise distinctness and would say so.
//
//   tiltDeg      the amplitude it lands on, before energy and geometry caps
//   wobbleMs     the ring-down, at full drop energy
//   oscillations rocks over that window
//   freqRise     how much faster the last rock is than the first: (1+2s)/(1+s)
//   damping      exponential decay on top of the (1-u)^2 terminal taper
//   bounces      micro-hops before the rock takes over
//   restitution  speed kept per bounce
export const DROP_VARIANTS = [
  // The near-miss: barely tips, buzzes down quickly. What a coin does when it
  // lands almost flat, which is most of the time.
  { name: 'settle-flat', tiltDeg: 3, wobbleMs: 380, oscillations: 5, freqRise: 1.2, damping: 2.5, bounces: 0, restitution: 0 },
  // The showpiece: catches an edge and rolls round it, long and slow.
  { name: 'rim-roll', tiltDeg: 22, wobbleMs: 950, oscillations: 7, freqRise: 2.5, damping: 1.6, bounces: 0, restitution: 0 },
  // Lands, hops twice, then rocks. The bounce is what makes it read as dropped
  // rather than placed.
  { name: 'double-bounce', tiltDeg: 12, wobbleMs: 700, oscillations: 6, freqRise: 2.0, damping: 2.2, bounces: 2, restitution: 0.35 },
  // Small amplitude, many fast rocks — the metallic chatter of a coin refusing
  // to lie down. The strongest frequency rise of the five.
  { name: 'chatter', tiltDeg: 8, wobbleMs: 620, oscillations: 11, freqRise: 3.0, damping: 2.0, bounces: 1, restitution: 0.28 },
  // Hits and stops. Heavily damped, short. Keeps the set from feeling uniformly
  // lively — sometimes a dropped coin just dies.
  { name: 'dead-drop', tiltDeg: 5, wobbleMs: 300, oscillations: 3, freqRise: 0.8, damping: 4.0, bounces: 0, restitution: 0 },
];

// --- geometry --------------------------------------------------------------

/**
 * Centre height of a disc tilted by `tiltRad` and touching the table.
 * PURE. This is the whole height model for the settle — see the header.
 */
export function contactHeight(tiltRad) {
  const a = Math.abs(tiltRad);
  return COIN_RADIUS_M * Math.sin(a) + COIN_HALF_THICKNESS_M * Math.cos(a);
}

/**
 * The largest tilt a coin released from `y0` can reach without rising above
 * where it was let go. Radians.
 *
 * Solved, not approximated: r*sin(t) + h*cos(t) = R*sin(t + phi) with
 * R = hypot(r, h) and phi = atan2(h, r), so the inverse is one asin. Above
 * y0 = R the equation has no solution because the coin simply has more room than
 * it can use, and the hard cap takes over.
 */
export function maxTiltForHeight(y0) {
  const hardCap = TILT_HARD_CAP_DEG * Math.PI / 180;
  if (!Number.isFinite(y0)) return 0;
  const R = Math.hypot(COIN_RADIUS_M, COIN_HALF_THICKNESS_M);
  const phi = Math.atan2(COIN_HALF_THICKNESS_M, COIN_RADIUS_M);
  if (y0 >= R) return hardCap;
  return clamp(Math.asin(clamp(y0 / R, -1, 1)) - phi, 0, hardCap);
}

/**
 * Quaternion product a*b, (x, y, z, w).
 *
 * Written out rather than pulled from THREE so the pure core has no three.js in
 * it and the verifier can exercise it with nothing loaded. Note the identity is
 * EXACT here: with a = (0,0,0,1) every term but one multiplies by zero, so the
 * settled pose is bit-for-bit the rest quaternion rather than a rounding of it.
 */
function qmul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by + ay * bw + az * bx - ax * bz,
    aw * bz + az * bw + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotation by `tiltRad` about the horizontal axis at compass `azimuthRad`. */
function tiltQuat(tiltRad, azimuthRad) {
  const s = Math.sin(tiltRad / 2);
  return [Math.cos(azimuthRad) * s, 0, Math.sin(azimuthRad) * s, Math.cos(tiltRad / 2)];
}

// --- the parameters of one drop --------------------------------------------

/**
 * Everything a drop needs, decided once and then never re-decided.
 *
 * PURE and DETERMINISTIC: the same (fromY, face, seed) always produces the same
 * object, and therefore the same pose track. Nothing here reads the clock or
 * Math.random — the variant and the direction of the tip both come out of the
 * seeded stream, which is what lets the verifier assert byte-identical replays.
 *
 * @param {object} opts
 * @param {number} opts.fromY   release height, metres. Clamped into LIFT.
 * @param {string} opts.face    'Heads' | 'Tails' — the face that stays up.
 * @param {string} opts.seed    any string.
 * @param {string} [opts.variant] force a variant by name. For tests and debug;
 *        play always lets the seed choose.
 */
export function dropParams({ fromY, face = 'Heads', seed = 'drop', variant = null } = {}) {
  // A non-finite height is a broken caller, not a gesture. Treat it as "already
  // resting" rather than propagating NaN into every pose downstream.
  const y0 = Number.isFinite(fromY) ? clamp(fromY, REST_Y, LIFT.maxY) : REST_Y;

  const rng = makeRng(seed, 'drop');
  const idx = variant
    ? Math.max(0, DROP_VARIANTS.findIndex((v) => v.name === variant))
    : rng.int(0, DROP_VARIANTS.length - 1);
  const v = DROP_VARIANTS[idx];
  // Which way it tips is a free draw over the whole circle. It carries no
  // meaning — translation and heading are deliberately meaningless in this game
  // (design doc §2) — it exists so the same variant does not tip the same way
  // twice in a row.
  const azimuthRad = rng.range(0, Math.PI * 2);

  // Impact speed scales as sqrt(drop), and the tilt a landing kicks up scales
  // with impact speed, so this is sqrt and not linear. At zero drop it is zero
  // and the coin does not stir, which is the correct answer for a coin lowered
  // to the table rather than a special case bolted on.
  const energy = clamp(Math.sqrt(Math.max(y0 - REST_Y, 0) / DROP_REF_M), 0, 1);

  // The geometric cap is applied against a FRACTION of the available room, not
  // all of it. Spending every millimetre on tilt means the coin lands at its
  // full amplitude the instant it is released — contactHeight(tilt) equals y0,
  // the fall is 2e-7 ms long, and the lean-in has no time to occur, so the coin
  // SNAPS to its landing angle instead of leaning into it. Reserving a slice of
  // the drop as actual falling keeps the lean a lean at every height. It costs
  // nothing at the heights that matter: above ~11 mm the hard cap is binding
  // anyway and this term never enters.
  const room = Math.max(y0 - REST_Y, 0);
  const tiltRad = Math.min(
    v.tiltDeg * (Math.PI / 180) * energy,
    maxTiltForHeight(REST_Y + room * TILT_HEADROOM),
    TILT_HARD_CAP_DEG * Math.PI / 180,
  );

  // The coin lands ON the tilt it leaned into, so the fall ends at that tilt's
  // contact height, not at the flat rest height. Getting this wrong is what
  // would put a visible jolt at touchdown.
  const yLand = contactHeight(tiltRad);
  const fallM = Math.max(y0 - yLand, 0);
  const fallMs = Math.sqrt(2 * fallM / GRAVITY_MS2) * 1000;

  // Bounces come off the real impact speed, so a small drop bounces small
  // without any separate scaling.
  const v0 = Math.sqrt(2 * GRAVITY_MS2 * fallM);
  const arcs = [];
  let arcStart = 0;
  for (let i = 0; i < v.bounces; i++) {
    const vi = v0 * Math.pow(v.restitution, i + 1);
    const dur = 2 * vi / GRAVITY_MS2;               // seconds, up and back down
    if (!(dur > 1e-4)) break;                       // below a frame: not a bounce
    arcs.push({ start: arcStart, dur, v: vi });
    arcStart += dur;
  }
  const bounceMs = arcStart * 1000;

  // The ring-down shortens with the drop, because a coin barely lifted barely
  // rings. The floor stops a tiny drop from ending in a single frame.
  //
  // NOTHING TO DO IS NOT A THING TO ANIMATE. A coin released at rest height has
  // no fall and no tilt, so every pose in that window is the pose it is already
  // in — the ring-down floor would otherwise hold the caller's promise open for
  // up to 332 ms (rim-roll) of a coin sitting perfectly still, which reads as
  // the game having hung. Zero duration resolves it on the first frame.
  const inert = fallM <= 0 && tiltRad <= 0;
  const settleMs = inert ? 0 : Math.max(v.wobbleMs * (0.35 + 0.65 * energy), bounceMs + 60);

  return {
    variant: v.name,
    variantIndex: idx,
    face,
    seed,
    y0,
    yLand,
    restY: REST_Y,
    fallM,
    fallMs,
    settleMs,
    bounceMs,
    durationMs: fallMs + settleMs,
    tiltRad,
    tiltDeg: tiltRad * 180 / Math.PI,
    azimuthRad,
    energy,
    oscillations: v.oscillations,
    freqRise: v.freqRise,
    damping: v.damping,
    arcs,
    restQuat: restQuatForFace(face),
  };
}

/** Additive bounce height at `tSec` after touchdown. Zero once the hops end. */
function bounceHeight(p, tSec) {
  for (const a of p.arcs) {
    if (tSec >= a.start && tSec < a.start + a.dur) {
      const u = tSec - a.start;
      return Math.max(a.v * u - 0.5 * GRAVITY_MS2 * u * u, 0);
    }
  }
  return 0;
}

/**
 * The coin's pose `t` milliseconds into the drop. PURE — no scene, no THREE, no
 * clock. Everything the verifier checks, it checks through this.
 *
 * Past `durationMs` it returns the exact rest pose, so a late frame settles the
 * coin rather than extrapolating it through the table.
 */
export function dropPoseAt(t, p) {
  const restPose = () => ({
    pos: [0, REST_Y, 0],
    quat: p.restQuat.slice(),
    tiltRad: 0,
    phase: 'rest',
  });
  if (!Number.isFinite(t) || t <= 0) {
    // t <= 0 is the instant of release: the coin is exactly where it was held,
    // flat. Not the rest pose — it has not fallen yet.
    return {
      pos: [0, p.y0, 0],
      quat: p.restQuat.slice(),
      tiltRad: 0,
      phase: p.durationMs > 0 ? 'fall' : 'rest',
    };
  }
  if (t >= p.durationMs) return restPose();

  let y;
  let tilt;
  let phase;

  if (t < p.fallMs) {
    const ts = t / 1000;
    // Free fall. Reaching yLand at exactly fallMs is not enforced afterwards, it
    // falls out of fallMs having been derived from this same expression.
    y = p.y0 - 0.5 * GRAVITY_MS2 * ts * ts;
    // The lean in. Smoothstep so the coin does not appear to be yanked over at
    // the moment of release; its zero end-slope also means the only kink in the
    // tilt curve is at the impact, where a kink is what an impact looks like.
    tilt = p.tiltRad * smoothstep(t / p.fallMs);
    phase = 'fall';
  } else {
    const tau = (t - p.fallMs) / 1000;
    const u = clamp((t - p.fallMs) / p.settleMs, 0, 1);

    // (1-u)^2 is a terminal taper and exp(-damping*u) is the ring-down. The
    // taper is there so the envelope reaches EXACTLY zero at u = 1 — a pure
    // exponential only approaches it, and the coin would be left microscopically
    // tilted, which is precisely the residue that would make the settled
    // orientation reading wrong in the last decimal.
    const env = p.tiltRad * (1 - u) * (1 - u) * Math.exp(-p.damping * u);

    // Frequency rises across the window: phase advances as (u + s*u^2)/(1+s), so
    // the instantaneous rate goes from 1/(1+s) to (1+2s)/(1+s) — the last rock is
    // (1+2s) times faster than the first. A constant frequency reads as a
    // pendulum; a coin speeds up as it flattens.
    const s = p.freqRise;
    const phi = 2 * Math.PI * p.oscillations * ((u + s * u * u) / (1 + s));
    tilt = env * Math.cos(phi);

    y = contactHeight(tilt) + bounceHeight(p, tau);
    phase = 'settle';
  }

  return {
    pos: [0, y, 0],
    quat: qmul(tiltQuat(tilt, p.azimuthRad), p.restQuat),
    tiltRad: tilt,
    phase,
  };
}

/**
 * Play a drop. Resolves when the coin is at rest.
 *
 * Shaped like player.js#ready(): subscribe to the frame loop, write poses, drop
 * the subscription on the way out. It does not touch the camera — the coin was
 * released from the ready framing and is going straight back to it, so there is
 * nothing to reframe, and a camera move here would fight the one flipper.ready()
 * makes if a flip follows.
 *
 * @param {object} sceneApi
 * @param {object} opts
 * @param {number} [opts.fromY] release height. Defaults to sceneApi.heldY, then
 *        to the coin's current height, so the host can just call it.
 * @param {object} [opts.fromPose] `{pos}` — an alternative to fromY.
 */
export function playDrop(sceneApi, opts = {}) {
  const y = opts.fromY
    ?? (opts.fromPose && opts.fromPose.pos && opts.fromPose.pos[1])
    ?? sceneApi.heldY
    ?? (sceneApi.coinRoot ? sceneApi.coinRoot.position.y : REST_Y);

  const p = dropParams({ fromY: y, face: opts.face, seed: opts.seed, variant: opts.variant });

  // The shadow was widened while the coin was held (scene.js#SHADOW_RADIUS). Ease
  // it back across the FALL rather than letting endHold() snap it, because the
  // snap is visible: the shadow is the height cue, so it has to arrive at the
  // table with the coin.
  const shadow = sceneApi.key && sceneApi.key.shadow ? sceneApi.key.shadow : null;
  const shadow0 = shadow ? shadow.radius : null;

  return new Promise((resolve) => {
    sceneApi.setCoinPose([0, p.y0, 0], p.restQuat);
    let started = 0;
    const off = sceneApi.onFrame((now) => {
      if (!started) started = now;
      const t = now - started;
      const pose = dropPoseAt(t, p);
      sceneApi.setCoinPose(pose.pos, pose.quat);
      if (shadow && shadow0 != null && p.fallMs > 0) {
        const k = clamp(t / p.fallMs, 0, 1);
        shadow.radius = shadow0 + (SHADOW_RADIUS.rest - shadow0) * k;
      }
      if (t >= p.durationMs) {
        off();
        // Land on the authored rest pose exactly — no interpolation residue, and
        // no chance of the settled orientation reading anything but 0.00 North.
        const rest = dropPoseAt(p.durationMs, p);
        sceneApi.setCoinPose(rest.pos, rest.quat);
        if (shadow) shadow.radius = SHADOW_RADIUS.rest;
        resolve({ params: p, elapsedMs: t });
      }
    });
  });
}
