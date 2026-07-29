// flip3d/clip.js
// ---------------------------------------------------------------------------
// Clip authoring + inspection.
//
// A CLIP is the one thing the playback path consumes, whether it came from the
// Rapier bake or from the procedural fallback in here:
//
//   { meta:   { halfFlips, side:'Heads'|'Tails', orientationDeg, quadrant,
//               durationMs, settleAngleDeg },
//     frames: [ { t, pos:[x,y,z], quat:[x,y,z,w] }, ... ] }
//
// pos/quat are CANONICAL space (see contract.js): metres, y=0 is the table
// surface, body +Y is the heads normal, body +X is the design's 12 o'clock.
// `t` is milliseconds from the start of the clip (the player also tolerates
// seconds — see clipTimeScale).  settleAngleDeg is the same quantity as
// orientationDeg and is kept for the format's sake; orientationDeg wins.
//
// THE PROCEDURAL FALLBACK IS NOT PHYSICS.  It is a keyframed path built
// BACKWARDS from an already-decided outcome: the tumble is exactly
// halfFlips * 180 deg, and the spin about the coin's own axis is SOLVED so the
// coin comes to rest at exactly the decided orientation.  Nothing in here may
// ever influence which side comes up or which way the design points.
//
// Translation is deliberately meaningless: the travel direction is a free
// random draw over the whole circle, because betting is about the coin, never
// about where it lands (design doc §2).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  COIN_HALF_THICKNESS_M, COIN_RADIUS_M, GRAVITY_MS2, SETTLE_FLAT_TOL_DEG, ORIENT_TOL_DEG,
  dirToCompass, assertOutcome, upDot, faceUpFromQuat,
  orientationFromQuat, quadrantFromOrientation, orientationForQuadrant, normDeg, roundOrientation,
} from './contract.js';

// --- deterministic tiny rng ------------------------------------------------
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
/** shortest signed difference a-b in degrees, (-180,180] */
const degDelta = (a, b) => { const d = normDeg(a - b); return d > 180 ? d - 360 : d; };

// --- REAL FLIP PHYSICS -----------------------------------------------------
// The flight is a genuine ballistic arc under real gravity. Airborne time is
// the single knob; the apex follows from it (h = g*T^2/8), so the motion can
// never read floaty. T ~= 0.6 s gives a 44 cm apex and puts the whole 4..20
// rotation range at 42..209 rad/s — a real flipped coin is a blur.
//
// These match what the Rapier bake actually produced (measured over its 1024
// clips: airborne to first contact 0.50-0.73 s, settle 0.15-0.38 s after,
// median total 897 ms), so the fallback and the real thing are paced alike.
export const AIRBORNE_SEC = 0.60;
const AIRBORNE_JITTER = 0.04;
export const SETTLE_SEC = 0.28;

// --- BULLET TIME -----------------------------------------------------------
// A deliberate, controlled deviation from real time (§6.4) — NOT the baseline
// speed, and OFF unless asked for. `rate` is physical seconds per wall-clock
// second: 1 = real time. The toss plays at 1x, then ramps down into the landing
// so the last rotations are readable.
//
// DEFAULT IS REAL TIME. The old default (minRate 0.14, settleRate 0.5) stretched
// a 0.60 s flight to ~1.08 s of wall clock and a 0.42 s settle to 0.84 s — a
// 1.9 s flip. That, not the physics, is what read as floaty.
export const REAL_TIME = { startU: 1, minRate: 1, settleRate: 1 };
// NOTE: this is the builder's own stretch, baked into the emitted frame
// timestamps, and it only applies to a procedural clip. The bullet time the
// GAME uses lives in player.js and warps playback of any clip, baked or not —
// player.js#BULLET_TIME. playFlip() deliberately does not forward the option
// here, so the two can never both fire on one flip.
export const PROCEDURAL_BULLET_TIME = { startU: 0.68, minRate: 0.14, settleRate: 0.5 };

/** Builds the wall-clock <-> physical-time mapping for one flight. */
function makeTimeWarp(T, { startU, minRate }) {
  const rate = (u) => (u <= startU ? 1 : 1 + (minRate - 1) * smoothstep((u - startU) / (1 - startU)));
  const N = 1024;
  const table = new Float64Array(N + 1);
  let acc = 0;
  for (let i = 1; i <= N; i++) {
    const u0 = (i - 1) / N, u1 = i / N;
    acc += 0.5 * (1 / rate(u0) + 1 / rate(u1)) * (T / N);
    table[i] = acc;
  }
  return {
    totalWall: acc,
    rateAt: rate,
    uAt(tw) {
      if (tw <= 0) return 0;
      if (tw >= acc) return 1;
      let lo = 0, hi = N;
      while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (table[mid] <= tw) lo = mid; else hi = mid; }
      const span = table[hi] - table[lo] || 1e-12;
      return (lo + (tw - table[lo]) / span) / N;
    },
  };
}

const AXIS_Y = new THREE.Vector3(0, 1, 0);

/**
 * Solve the spin-about-own-axis needed to land on a target orientation.
 * orientation(R(axis,theta) * R_y(psi)) is exactly linear in psi with slope
 * +/-1 (a rotation composed with either identity or a reflection), so two
 * samples pin it down exactly.
 */
export function solveYawForOrientation(tumbleAxis, thetaEnd, targetDeg) {
  const T = new THREE.Quaternion().setFromAxisAngle(tumbleAxis, thetaEnd);
  const q = new THREE.Quaternion();
  const at = (psi) => orientationFromQuat(
    q.copy(T).multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, psi)).toArray(),
  );
  const phi0 = at(0);
  const probe = THREE.MathUtils.degToRad(10);
  const slope = Math.sign(degDelta(at(probe), phi0)) || 1;   // +1 or -1
  const psiDeg = degDelta(targetDeg, phi0) * slope;
  return THREE.MathUtils.degToRad(psiDeg);
}

/**
 * Build the continuous flight model for an outcome. Pure maths — no three.js
 * scene, no time, no rendering. sample(tMs) can be called in any order.
 */
export function buildFlightModel(outcome, opts = {}) {
  assertOutcome(outcome);
  const { startFace, spins } = outcome;

  const rng = mulberry32(hashStr(String(opts.seed ?? `${startFace}|${outcome.side}|${spins}|${outcome.quadrant}`)));
  const rand = (a, b) => a + (b - a) * rng();

  // The angle the coin must come to rest at. A legacy outcome carrying only a
  // quadrant gets a seeded angle inside that bucket — the bet axis is still
  // honoured exactly, only the hundredths are the renderer's.
  const targetOrientation = outcome.orientationDeg != null
    ? normDeg(outcome.orientationDeg)
    : orientationForQuadrant(outcome.quadrant, rng());

  // --- where it goes (free: translation means nothing) ---------------------
  const travelAngle = rand(0, Math.PI * 2);
  const dir = new THREE.Vector3(Math.sin(travelAngle), 0, -Math.cos(travelAngle));
  const restDist = opts.restDist ?? rand(0.030, 0.075);
  const tdDist = restDist * 0.62;                          // first contact

  // --- the arc: real gravity, real airborne time ---------------------------
  const T = opts.airborneSec ?? (AIRBORNE_SEC + rand(-AIRBORNE_JITTER, AIRBORNE_JITTER));
  const g = GRAVITY_MS2;
  const v0 = g * T / 2;                                    // up-velocity that lands at T
  const restY = COIN_HALF_THICKNESS_M;
  const apex = restY + g * T * T / 8;                      // derived, never chosen
  const arcAt = (tau) => restY + v0 * tau - 0.5 * g * tau * tau;

  // --- how it turns --------------------------------------------------------
  // Tumble about the horizontal axis perpendicular to travel, so the coin goes
  // over the top in the direction it is moving.
  const tumbleAxis = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
  const thetaStart = startFace === 'Heads' ? 0 : Math.PI;
  const thetaTotal = spins * Math.PI;                      // EXACTLY the decided count
  const thetaEnd = thetaStart + thetaTotal;

  // Spin about the coin's own face normal. Applied in the coin's local frame,
  // so it can never change which face is up — only where the design ends up
  // pointing, which is exactly what we are being told to hit.
  const yawSolved = solveYawForOrientation(tumbleAxis, thetaEnd, targetOrientation);
  const extraRevs = Math.floor(rand(1, 3)) * (rng() < 0.5 ? -1 : 1);
  const yawTotal = yawSolved + extraRevs * Math.PI * 2;    // whole turns are free

  // --- timing: physical seconds, then the bullet-time stretch --------------
  // Real time unless bullet time is explicitly asked for (see BULLET_TIME).
  // The object form overrides THIS builder's own preset — player.js#SLOWMO is a
  // different mechanism with different fields and is not in scope here. (It was
  // named as the base until now, which was an undefined reference: unreachable
  // from the game, because playFlip strips bulletTime before it calls in here,
  // but a ReferenceError for anyone calling the builder directly.)
  const bt = opts.bulletTime === true ? { ...PROCEDURAL_BULLET_TIME }
    : (opts.bulletTime && typeof opts.bulletTime === 'object')
      ? { ...PROCEDURAL_BULLET_TIME, ...opts.bulletTime }
      : { ...REAL_TIME };
  const warp = makeTimeWarp(T, bt);
  const settleSec = opts.settleSec ?? SETTLE_SEC;          // physical
  const flightMs = warp.totalWall * 1000;                  // wall clock
  const settleMs = (settleSec / bt.settleRate) * 1000;     // wall clock
  const durationMs = flightMs + settleMs;
  const omega = thetaTotal / T;                            // rad/s, real spin rate

  // --- reusable scratch ----------------------------------------------------
  const qTumble = new THREE.Quaternion();
  const qYaw = new THREE.Quaternion();
  const qRock = new THREE.Quaternion();

  const qRest = new THREE.Quaternion()
    .setFromAxisAngle(tumbleAxis, thetaEnd)
    .multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, yawTotal));

  const restOrientation = orientationFromQuat(qRest.toArray());
  if (Math.abs(degDelta(restOrientation, targetOrientation)) > 1e-6) {
    throw new Error(`orientation solve failed: wanted ${targetOrientation}, got ${restOrientation}`);
  }

  // Settle: two damped hops, plus a rock on the rim that decays to nothing.
  const HOP1 = 0.018, HOP1_END = 0.40;
  const HOP2 = 0.006, HOP2_END = 0.68;
  const ROCK_AMP = THREE.MathUtils.degToRad(9);
  function hop(tau) {
    if (tau < HOP1_END) return HOP1 * Math.sin(Math.PI * (tau / HOP1_END));
    if (tau < HOP2_END) return HOP2 * Math.sin(Math.PI * ((tau - HOP1_END) / (HOP2_END - HOP1_END)));
    return 0;
  }
  // 3 whole cycles so it is exactly 0 at tau=1, tapered so it is truly still.
  const rockAngle = (tau) => ROCK_AMP * Math.sin(2 * Math.PI * 3 * tau) * Math.exp(-3.2 * tau) * (1 - tau);

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();

  function sample(tMs, out = { pos: [0, 0, 0], quat: [0, 0, 0, 1] }) {
    const t = clamp(tMs, 0, durationMs);
    if (t <= flightMs) {
      // wall-clock ms -> normalised flight progress -> physical seconds
      const u = warp.uAt(t / 1000);
      pos.copy(dir).multiplyScalar(tdDist * u);
      pos.y = arcAt(u * T);
      qTumble.setFromAxisAngle(tumbleAxis, thetaStart + thetaTotal * u);
      qYaw.setFromAxisAngle(AXIS_Y, yawTotal * u);
      quat.copy(qTumble).multiply(qYaw);
    } else {
      const tau = clamp((t - flightMs) / settleMs, 0, 1);
      const d = tdDist + (restDist - tdDist) * easeOutCubic(tau);
      pos.copy(dir).multiplyScalar(d);
      const rock = rockAngle(tau);
      // A coin tilted by `rock` rides up on its rim — lift the centre to match
      // so the disc never sinks through the table.
      pos.y = restY * Math.cos(rock) + COIN_RADIUS_M * Math.abs(Math.sin(rock)) + hop(tau);
      qRock.setFromAxisAngle(tumbleAxis, rock);
      quat.copy(qRock).multiply(qRest);
    }
    out.pos[0] = pos.x; out.pos[1] = pos.y; out.pos[2] = pos.z;
    out.quat[0] = quat.x; out.quat[1] = quat.y; out.quat[2] = quat.z; out.quat[3] = quat.w;
    return out;
  }

  return {
    sample, durationMs, flightMs, settleMs, airborneSec: T, omega,
    restDist, apex, travelDeg: +THREE.MathUtils.radToDeg(dirToCompass(dir.x, dir.z)).toFixed(2),
    dir: dir.clone(), tumbleAxis: tumbleAxis.clone(),
    thetaTotal, thetaStart, yawTotal, yawSolved,
    orientationDeg: restOrientation,
    restPos: [dir.x * restDist, restY, dir.z * restDist],
    restQuat: [qRest.x, qRest.y, qRest.z, qRest.w],
  };
}

/**
 * Bake a flight model down to the shared clip format. Same shape the Rapier
 * bake will emit, so today's fallback and tomorrow's clips share one path.
 */
export function buildProceduralClip(outcome, opts = {}) {
  assertOutcome(outcome);
  const m = buildFlightModel(outcome, opts);
  const fps = opts.fps ?? 120;
  const step = 1000 / fps;
  const n = Math.ceil(m.durationMs / step);
  const frames = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.min(i * step, m.durationMs);
    const s = m.sample(t, { pos: [0, 0, 0], quat: [0, 0, 0, 1] });
    frames.push({ t: +t.toFixed(3), pos: s.pos, quat: s.quat });
  }
  // Nail the last frame to the exact resting pose — no interpolation drift.
  frames[frames.length - 1] = { t: m.durationMs, pos: m.restPos.slice(), quat: m.restQuat.slice() };

  const orientationDeg = roundOrientation(m.orientationDeg);
  return {
    meta: {
      halfFlips: outcome.spins,
      side: outcome.side,
      orientationDeg,
      quadrant: quadrantFromOrientation(orientationDeg),
      durationMs: m.durationMs,
      settleAngleDeg: orientationDeg,   // same quantity, legacy name
      startFace: outcome.startFace,     // extra: the renderer shows it pre-flip
      source: 'procedural',
    },
    frames,
  };
}

// --- clip inspection -------------------------------------------------------

/** Frame timestamps are ms by contract; tolerate seconds rather than misplay. */
export function clipTimeScale(clip) {
  const last = clip.frames[clip.frames.length - 1].t;
  const dur = clip.meta.durationMs;
  if (!(last > 0) || !(dur > 0)) return 1;
  const tol = Math.max(4, dur * 0.02);
  if (Math.abs(last - dur) <= tol) return 1;          // already ms
  if (Math.abs(last * 1000 - dur) <= tol) return 1000; // seconds
  return dur / last;                                   // whatever it is, normalise
}

/** Orientation a clip claims to land on (orientationDeg, or the legacy name). */
export function clipTargetOrientation(clip) {
  const m = clip.meta;
  return m.orientationDeg != null ? normDeg(m.orientationDeg)
    : m.settleAngleDeg != null ? normDeg(m.settleAngleDeg)
      : null;
}

/**
 * Everything worth knowing about a clip, derived ONLY from its frames — this is
 * the same treatment a baked Rapier clip will get, so it doubles as the bake's
 * quality gate.
 */
export function analyzeClip(clip) {
  const scale = clipTimeScale(clip);
  const f = clip.frames;
  const last = f[f.length - 1];

  // half-flips actually described by the frames: count sign changes of the
  // coin's up-axis. This is literally what a viewer sees flip past.
  let crossings = 0;
  let prev = Math.sign(upDot(f[0].quat)) || 1;
  const crossAt = [];
  for (let i = 1; i < f.length; i++) {
    const s = Math.sign(upDot(f[i].quat)) || prev;
    if (s !== prev) { crossings++; crossAt.push(f[i].t * scale); prev = s; }
  }

  // touchdown = FIRST CONTACT, not first rest: the first frame after the apex
  // whose centre is low enough that a tilted coin can already be touching. A
  // tilted disc contacts at up to COIN_RADIUS_M, so anything lower than that is
  // too late — a baked clip bounces, and the camera has to start craning on the
  // first hit, not on the last one.
  const CONTACT_H = COIN_RADIUS_M * 1.18;   // 12.1 mm; the bake gates at 12 mm
  let apexI = 0;
  for (let i = 1; i < f.length; i++) if (f[i].pos[1] > f[apexI].pos[1]) apexI = i;
  let tdI = f.length - 1;
  for (let i = apexI; i < f.length; i++) {
    if (f[i].pos[1] <= CONTACT_H) { tdI = i; break; }
  }

  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const fr of f) for (let k = 0; k < 3; k++) {
    bounds.min[k] = Math.min(bounds.min[k], fr.pos[k]);
    bounds.max[k] = Math.max(bounds.max[k], fr.pos[k]);
  }

  const finalSide = faceUpFromQuat(last.quat);
  const finalOrientationDeg = roundOrientation(orientationFromQuat(last.quat));
  const finalQuadrant = quadrantFromOrientation(finalOrientationDeg);
  const wantOrientation = clipTargetOrientation(clip);
  const tiltDeg = THREE.MathUtils.radToDeg(Math.acos(clamp(Math.abs(upDot(last.quat)), -1, 1)));

  return {
    durationMs: clip.meta.durationMs,
    frames: f.length,
    timeScale: scale,
    halfFlipsSeen: crossings,
    crossingsAtMs: crossAt,
    apexY: f[apexI].pos[1],
    apexMs: f[apexI].t * scale,
    touchdownMs: f[tdI].t * scale,
    launchY: f[0].pos[1],
    startsAirborne: f[0].pos[1] > COIN_HALF_THICKNESS_M * 3,
    finalPos: last.pos.slice(),
    travelDistM: Math.hypot(last.pos[0], last.pos[2]),
    finalSide,
    finalOrientationDeg,
    orientationErrorDeg: wantOrientation == null ? null : +degDelta(finalOrientationDeg, wantOrientation).toFixed(6),
    finalQuadrant,
    finalTiltDeg: tiltDeg,
    bounds,
    ok: {
      side: finalSide === clip.meta.side,
      orientation: wantOrientation == null ? true : Math.abs(degDelta(finalOrientationDeg, wantOrientation)) <= ORIENT_TOL_DEG,
      quadrant: finalQuadrant === clip.meta.quadrant,
      halfFlips: crossings === clip.meta.halfFlips,
      // The bake's own settle gate, not a stricter one invented here: a rigid
      // disc cannot rest tilted, so residual tilt is solver slop and the bake
      // already rejects anything past acos(0.9996). Measured across the 1024
      // baked clips: median 0.16 deg, p95 0.38 deg, max 1.51 deg.
      flat: tiltDeg <= SETTLE_FLAT_TOL_DEG,
      restsOnTable: Math.abs(last.pos[1] - COIN_HALF_THICKNESS_M) < 1e-5,
    },
  };
}

export function verifyClip(clip) {
  const a = analyzeClip(clip);
  a.pass = Object.values(a.ok).every(Boolean);
  return a;
}
