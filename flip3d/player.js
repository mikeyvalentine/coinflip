// flip3d/player.js
// ---------------------------------------------------------------------------
// The playback path. ONE path: playClip(clip). The Rapier bake is the producer;
// buildProceduralClip() emits the same shape, so the fallback is a swap of the
// producer, not of the player.
//
// TIMING IS REAL TIME. A clip's `t` is milliseconds of actual physics and it is
// played back at 1 ms per ms. The bake's median clip is 897 ms and its longest
// is 1690 ms, so a flip is about a second — a real coin flip is airborne
// 0.5-1.0 s and is a visual blur. Bullet time (§6.4) is a deliberate effect
// layered on top and is OFF unless asked for; it is never the baseline.
//
// The lead-in is the only motion the player invents. Baked clips start at the
// release point, 0.22 m above the table, so something has to get the coin from
// resting on the table up to there: LEADIN_MS of accelerating lift whose
// terminal speed matches the clip's launch. It is pre-flight — it tumbles
// nothing and counts nothing.
//
// The spin counter is deliberately NOT read out of the outcome. It counts the
// coin's up-axis actually crossing the horizon, frame by frame, exactly like
// the lite preview counts face swaps — so what the player sees ticking is what
// the coin is really doing. The count is asserted against meta.halfFlips at the
// end; a mismatch is reported, never hidden.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { analyzeClip, buildProceduralClip, clipTimeScale, clipTargetOrientation } from './clip.js';
import {
  upDot, toRotations, COIN_HALF_THICKNESS_M, ORIENT_TOL_DEG, assertOutcome,
  orientationFromQuat, quadrantFromOrientation, roundOrientation, normDeg,
} from './contract.js';
import { READY_SHOT, lerpShot } from './scene.js';
import { throwProfile, clipLaunchSpeed, clamp01, LEADIN } from './power.js';
import { selectVariant } from './variant.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

// --- pacing ----------------------------------------------------------------
// LEADIN_MS is now only the no-power / unreadable-clip default; a throw with a
// power meter behind it derives its lead-in from the clip's own launch speed.
// See power.js#LEADIN.
export const LEADIN_MS = 110;      // rest -> the clip's release point
export const HOLD_AFTER_MS = 220;  // beat on the settled coin before resolving
export const CAM_PULLOUT_MS = 240; // ready framing -> flight framing (power 0.5-ish)
export const CAM_SETTLE_MS = 420;  // flight framing -> settled close-up

// --- the bridge: released pose -> the clip's first frame --------------------
// With the pick-up gesture the player lets go wherever they like, so the lead-in
// is no longer a fixed 0.22 m lift from the table — it is whatever gap is left
// between their hand and the clip's release point. power.js#LEADIN sizes the
// lead-in for the FULL lift and clamps it to 70..280 ms; that floor is correct
// for a lift off the table and wrong for a short bridge, where it forces the
// coin to crawl (a 2 cm gap in 70 ms is 0.57 m/s into a clip that opens at
// ~2.6 m/s, so the clip visibly snatches the coin out of the air). When a
// release pose is supplied the duration is therefore re-derived from the bridge
// that actually exists — see bridgeLeadInMs() in playClip.
export const LEADIN_BRIDGE = {
  /** One display frame. A lift shorter than this is a cut, so don't pretend. */
  minMs: 16,
  /**
   * Ceiling on the pre-flight yaw reconciliation, deg/s.
   *
   * The released coin sits at the player's orientation and the clip opens at
   * whatever yaw the bake launched from — up to 180 deg apart. Turning that
   * inside one frame is a snap, so the bridge is allowed to run long enough to
   * cover it. 2000 deg/s is brisk in isolation and negligible against the flip
   * it precedes: the coin tumbles at 42-209 rad/s, i.e. 2400-12000 deg/s, from
   * the very next frame.
   */
  maxTurnDegPerSec: 2000,
  /**
   * How far the turn is allowed to stretch the bridge beyond the velocity
   * match, as a multiple of it.
   *
   * Without this the turn wins outright on a short bridge and the result is the
   * worst reading of all: the coin hangs almost still at the release point for
   * ~100 ms, slowly rotating, and is then yanked to 2.6 m/s by the clip.
   * Measured over the library at a 5 mm bridge, a 180 deg reconciliation pinned
   * the lead-in at 103 ms while the match wanted 4 ms. Delivering the coin at
   * the right SPEED is the bridge's job; squaring up the yaw is a courtesy, and
   * a courtesy does not get to triple the wait. Where the two conflict the turn
   * is simply taken faster — which is invisible, because the coin is about to
   * tumble at 2400-12000 deg/s from the very next frame.
   *
   * The value is set BY the speed it costs, not picked for feel: stretching the
   * bridge by k divides the arrival speed by k, and power.js aims the coin at
   * 0.80-1.30x the clip's launch speed, so k = 1.4 is the most stretch that
   * still lands the slowest intended throw above 0.75x. At k = 2 the sweep
   * measured 0.57x on a 3 cm bridge with a half-turn to make — the clip
   * visibly snatching the coin, which is the exact fault this whole
   * re-derivation exists to remove. A half-turn taken inside that budget runs
   * at ~6500 deg/s, still inside the flight's own range.
   */
  turnStretchMax: 1.4,
};

/**
 * The shortest bridge over which the velocity match is achievable, in metres.
 *
 * Below this the s^2 profile cannot reach the clip's launch speed inside
 * `minMs`, so the coin is handed over moving too slowly however the duration is
 * chosen — no amount of tuning in here fixes it. THE GESTURE MUST NOT RELEASE
 * THE COIN CLOSER TO THE CLIP'S OPENING POINT THAN THIS: for a 2.6 m/s launch
 * that is about 18 mm, so a grab that tops out ~2 cm below the 0.22 m release
 * point keeps every throw inside the matched regime.
 */
export function minBridgeMetres(launchSpeed, anticipation = 0) {
  const movingFrac = Math.max(1 - clamp01(anticipation), 1e-3);
  return launchSpeed * (LEADIN_BRIDGE.minMs / 1000) * movingFrac / 2;
}

/** Angle between two quaternions, in degrees. */
function quatAngleDeg(a, b) {
  let d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  if (d > 1) d = 1;
  return 2 * Math.acos(d) * 180 / Math.PI;
}

// --- camera ----------------------------------------------------------------
// Azimuth stays 0 (camera due SOUTH) the whole way through: screen-up is -Z =
// NORTH and screen-right is +X = EAST, which is the only reason the settled
// ORIENTATION is readable at all.
//
// The flight shot FOLLOWS the coin rather than framing a bounding box. Baked
// clips travel up to 0.397 m and peak at 0.775 m; a box that size needs the
// camera ~1.5 m back, which makes a 20.5 mm coin a dozen pixels. Following it
// keeps the coin large and lets the table and the HDRI carry the motion.
export const FLIGHT_CAM = {
  distanceNear: 0.26,   // at the table
  distanceApex: 0.40,   // at the top of the arc
  elevDeg: 20,
  travelLead: 0.85,     // <1 lets the coin drift across frame as it travels
  headroom: 0.018,      // target sits above the coin, so it rides low in frame
};
export const SETTLE_CAM = { distance: 0.105, elevDeg: 66 };

// --- the apex push-in ------------------------------------------------------
// The zoom half of §6.4. It runs over the SAME window as the slow-down below —
// apex to first contact — so the two read as one gesture: the coin reaches the
// top of its arc, time thickens, and the camera closes on it while it falls.
//
// Zooming alone is not enough. At 0.26 m the coin sits comfortably off-centre
// (travelLead 0.85 deliberately lets it drift across frame), but that same
// offset at 0.16 m walks it out of shot. So the push-in also pulls `travelLead`
// to 1 and drops the headroom: the tighter the frame, the more exactly it is
// centred on the coin. Elevation lifts a little too, which means the crane to
// the near-top-down settle shot starts from part-way there instead of jolting.
//
// PRESENTATION ONLY. Nothing here touches pos/quat — the coin's path is the
// clip's, frame for frame, at every zoom level.
export const DRAMA_CAM = {
  zoom: 0.60,             // distance multiplier at touchdown: 0.26 m -> 0.156 m
  elevAddDeg: 14,         // 20 -> 34 deg, part-way to the settle shot's 66
  travelLeadAtZoom: 1.0,  // fully centred once tight
  headroomAtZoom: 0.006,  // the coin rides mid-frame rather than low
};

// --- slow motion (§6.4) — an effect, never the baseline ---------------------
// `rate` is clip seconds per wall-clock second. THE RAMP IS ANCHORED TO THE
// APEX: full speed all the way up, then a decelerating fall into the landing.
//
// That anchoring is the whole design. The old default stretched the WHOLE
// flight uniformly (2x) and read floaty — because a coin that rises slowly
// looks like it is under low gravity, and no amount of tuning fixes that. A
// coin that rises at 1x and then falls slowly reads as a replay, not as broken
// physics, because the ascent has already established the real gravity.
//
// THE SETTLE RUNS BACK UP TO REAL TIME. Holding a slow rate to the end of the
// clip (the old shape did, at 0.45) doubles the bounce-and-rattle, which is the
// one part of a flip nobody is reading — the result is already decided and the
// coin is just noisy. Measured over the 1024 baked clips that turned the
// longest flip into a 3.3 s sit. Slowing the DESCENT is drama; slowing the
// rattle is a wait. So the rate holds at its slowest across the impact, then
// recovers to 1x over the settle, which also snaps the coin to rest.
//
// Continuity is checked, not assumed: rate is continuous at both joins, because
// at the old numbers it stepped 0.18 -> 0.45 on the frame of first contact and
// the coin visibly sped up at the exact moment it should have hit hardest.
export const SLOWMO = {
  startFrac: 0,        // where in apex->touchdown the ramp opens. 0 = at the apex
  minRate: 0.26,       // slowest, reached exactly at first contact (~4x slow)
  impactHoldMs: 70,    // clip-time held at minRate across the landing
  recoverMs: 180,      // clip-time over which it climbs back to recoverRate
  recoverRate: 1.0,    // real time again by the time it stops rattling
};

/**
 * Where the camera should be for a coin at `pos` mid-flight.
 *
 * Module scope, and pure: it reads nothing but its arguments and the constants
 * above, which is what lets tools/verify-slowmo.mjs check the framing headlessly
 * instead of trusting a pane that does not render.
 *
 * @param {number} zoom 0..1 — the apex push-in. 0 is the plain follow shot.
 */
export function flightShot(pos, apexY, distanceApex = FLIGHT_CAM.distanceApex, zoom = 0) {
  const k = clamp(pos[1] / Math.max(apexY, 1e-4), 0, 1);
  const z = clamp(zoom, 0, 1);
  const lead = FLIGHT_CAM.travelLead + (DRAMA_CAM.travelLeadAtZoom - FLIGHT_CAM.travelLead) * z;
  const headroom = FLIGHT_CAM.headroom + (DRAMA_CAM.headroomAtZoom - FLIGHT_CAM.headroom) * z;
  const follow = FLIGHT_CAM.distanceNear + (distanceApex - FLIGHT_CAM.distanceNear) * k;
  return {
    target: [pos[0] * lead, pos[1] + headroom, pos[2] * lead],
    distance: follow * (1 + (DRAMA_CAM.zoom - 1) * z),
    elevDeg: FLIGHT_CAM.elevDeg + DRAMA_CAM.elevAddDeg * z,
    azimuthDeg: 0,
  };
}

export function settleShot(finalPos) {
  return {
    target: [finalPos[0], COIN_HALF_THICKNESS_M, finalPos[2]],
    distance: SETTLE_CAM.distance,
    elevDeg: SETTLE_CAM.elevDeg,
    azimuthDeg: 0,
  };
}

/**
 * Wall-clock <-> clip-time map. Identity unless slow motion is on.
 *
 * `wallAt` is the inverse of `clipAt` and is not optional garnish: the camera
 * schedule is written in CLIP time (apex, touchdown) but is stepped in WALL
 * time, and the two stop agreeing the moment a warp exists. Without it the
 * settle crane fires on `leadIn + touchdownMs` of wall clock, which under any
 * slow-down is while the coin is still in the air.
 */
export function makeClipWarp(clip, analysis, cfg) {
  const duration = clip.meta.durationMs;
  if (!cfg) {
    return {
      totalWallMs: duration,
      clipAt: (w) => clamp(w, 0, duration),
      wallAt: (c) => clamp(c, 0, duration),
      rateAt: () => 1,
    };
  }
  const c = { ...SLOWMO, ...(cfg === true ? {} : cfg) };
  const td = analysis.touchdownMs;
  // A clip whose apex IS its touchdown (or that never rose) still has to ramp
  // somewhere, so fall back to a fixed run-up rather than dividing by zero.
  const apex = Math.min(analysis.apexMs ?? 0, td);
  const from = td > apex ? apex + (td - apex) * clamp(c.startFrac, 0, 1)
    : Math.max(0, td - 240);
  // The impact beat and the recovery are FRACTIONS OF THE CLIP'S OWN SETTLE, not
  // fixed millisecond counts, so every clip is back at real time by its final
  // frame. Baked settles run 60 ms to 1090 ms; against a fixed 70+180 ms budget
  // the short ones simply ended mid-recovery, still in slow motion, which is a
  // dreamy fade-out instead of the click of a coin coming to rest.
  const settleSpan = Math.max(duration - td, 0);
  const hold = Math.min(c.impactHoldMs, settleSpan * 0.30);
  const recover = Math.min(c.recoverMs, settleSpan * 0.65);
  const rate = (ct) => {
    if (ct <= from) return 1;                                   // the rise: untouched
    if (ct < td) {                                              // the fall: decelerating
      return 1 + (c.minRate - 1) * smoothstep((ct - from) / Math.max(td - from, 1e-6));
    }
    const after = ct - td;
    if (after <= hold) return c.minRate;                        // the landing: held
    const k = smoothstep((after - hold) / Math.max(recover, 1e-6));
    return c.minRate + (c.recoverRate - c.minRate) * k;         // the rattle: back to 1x
  };
  const N = 512, step = duration / N;
  const wall = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    wall[i] = wall[i - 1] + 0.5 * (1 / rate((i - 1) * step) + 1 / rate(i * step)) * step;
  }
  const total = wall[N];
  return {
    totalWallMs: total,
    rateAt: rate,
    clipAt(w) {
      if (w <= 0) return 0;
      if (w >= total) return duration;
      let lo = 0, hi = N;
      while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (wall[mid] <= w) lo = mid; else hi = mid; }
      const span = wall[hi] - wall[lo] || 1e-12;
      return (lo + (w - wall[lo]) / span) * step;
    },
    wallAt(ct) {
      const x = clamp(ct, 0, duration) / step;
      const i = Math.min(N - 1, Math.floor(x));
      return wall[i] + (wall[i + 1] - wall[i]) * (x - i);
    },
  };
}

/**
 * The half-flip crossing times for a clip, or null if it has none.
 *
 * TWO SOURCES, DELIBERATELY. `meta.flipTimesMs` on the clip wins, and the
 * sidecar map is the fallback. That ordering is the migration: the beats are a
 * sidecar today because the clip files are being rewritten into a compressed
 * format by a separate pass, and two writers on one file is how a library gets
 * corrupted. When the encoder lands it will carry the array inline, the inline
 * copy will start winning automatically, and the sidecar retires without
 * another change in here.
 *
 * Anything malformed returns null rather than throwing, and null means "count
 * frames like we always did". A bad beat file must degrade to the old
 * behaviour, never interrupt a flip that is already on screen.
 */
function beatsForClip(clip, beatMap) {
  const inline = clip && clip.meta && clip.meta.flipTimesMs;
  const id = clip && clip.meta ? clip.meta.id : null;
  const side = beatMap && id != null
    ? (typeof beatMap.get === 'function' ? beatMap.get(id) : beatMap[id])
    : null;
  const times = Array.isArray(inline) ? inline : (Array.isArray(side) ? side : null);
  if (!times || times.length === 0) return null;
  // A track that is not sorted, or carries a non-finite time, would step the
  // counter backwards mid-flip. Refuse it outright and fall back.
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i])) return null;
    if (i > 0 && times[i] < times[i - 1]) return null;
  }
  return times;
}

export function createFlipper(sceneApi, hooks = {}) {
  const onSpin = hooks.onSpin ?? (() => {});
  const onPhase = hooks.onPhase ?? (() => {});
  const library = hooks.library ?? null;
  const blur = hooks.blur ?? null;
  // id -> crossing times. See beatsForClip. Absent, everything below counts
  // frames exactly as it did before beats existed.
  const beatMap = hooks.beats ?? null;
  let busy = false;

  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qm = new THREE.Quaternion();
  // Separate scratch for the random-access sampler: motion blur calls it from
  // the draw hook, and it must not be able to disturb the playback cursor's.
  const sa = new THREE.Quaternion(), sb = new THREE.Quaternion(), sm = new THREE.Quaternion();

  /**
   * Play a clip. Resolves when the coin has settled.
   * @returns {Promise<object>} verification report (never thrown away silently)
   */
  function playClip(clip, opts = {}) {
    if (busy) return Promise.reject(new Error('a flip is already playing'));
    busy = true;

    const frames = clip.frames;
    const scale = clipTimeScale(clip);
    const analysis = analyzeClip(clip);
    const duration = clip.meta.durationMs;
    // `slowmo` is the name; `bulletTime` is the old one and still works.
    const slowmoCfg = opts.slowmo ?? opts.bulletTime ?? false;
    const warp = makeClipWarp(clip, analysis, slowmoCfg);

    // --- random-access sampling off the frame track -----------------------
    // Motion blur samples backwards across the shutter, so it needs to read the
    // track out of order. This is deliberately NOT the playback cursor below:
    // that one is monotone precisely so it can count every horizon crossing the
    // frames describe, and a blur sample must never be able to move it.
    const frameIndexAt = (ct) => {
      let lo = 0, hi = frames.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid].t * scale <= ct) lo = mid; else hi = mid;
      }
      return lo;
    };
    function sampleAt(ct, out) {
      const c = clamp(ct, 0, duration);
      const i = frameIndexAt(c);
      const f0 = frames[i], f1 = frames[Math.min(i + 1, frames.length - 1)];
      const t0 = f0.t * scale, t1 = f1.t * scale;
      const k = t1 > t0 ? clamp((c - t0) / (t1 - t0), 0, 1) : 0;
      out.pos[0] = f0.pos[0] + (f1.pos[0] - f0.pos[0]) * k;
      out.pos[1] = f0.pos[1] + (f1.pos[1] - f0.pos[1]) * k;
      out.pos[2] = f0.pos[2] + (f1.pos[2] - f0.pos[2]) * k;
      sa.fromArray(f0.quat); sb.fromArray(f1.quat);
      sm.copy(sa).slerp(sb, k);
      out.quat[0] = sm.x; out.quat[1] = sm.y; out.quat[2] = sm.z; out.quat[3] = sm.w;
      return out;
    }
    /**
     * ANGULAR SPEED, rad/s, straight off the clip's QUATERNION TRACK — the one
     * number the blur magnitude is derived from.
     *
     * It is measured between ADJACENT CLIP FRAMES (4 ms apart in the bake), not
     * across a display frame. That matters: 2*acos(|dot|) can only report an
     * angle in [0,180], and across a 60 Hz display frame the coin really does
     * sweep up to 225 deg, which would alias to a smaller number and understate
     * the blur exactly where it is needed most. Between baked frames the step
     * peaks at ~54 deg, so it is unambiguous.
     */
    function omegaAt(ct) {
      const i = frameIndexAt(clamp(ct, 0, duration));
      const f0 = frames[i], f1 = frames[Math.min(i + 1, frames.length - 1)];
      const dt = (f1.t - f0.t) * scale / 1000;
      if (!(dt > 0)) return 0;
      const a = f0.quat, b = f1.quat;
      let d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
      if (d > 1) d = 1;
      return 2 * Math.acos(d) / dt;
    }

    // --- the throw's power decides the lead-in ----------------------------
    // The lead-in is the only motion the player invents: the released pose ->
    // the clip's release point. Its length is set by the exit speed the pull
    // asked for, measured against the clip's OWN launch speed, so the handoff
    // stays smooth at every power. See power.js#LEADIN.
    //
    // `opts.fromPose` is where the player let go — the pick-up gesture's output.
    // Without it the coin starts at rest on the table, which is where it always
    // was before the gesture existed. Note the two spellings of that rest height
    // agree exactly: the old code wrote COIN_HALF_THICKNESS_M where restPos[1]
    // already held it, so the default path below is unchanged arithmetic.
    const fromPose = opts.fromPose ?? null;
    const launchPos = frames[0].pos, launchQuat = frames[0].quat;
    const restPos = fromPose ? fromPose.pos.slice() : [0, COIN_HALF_THICKNESS_M, 0];
    const restQuat = fromPose ? fromPose.quat.slice() : sceneApi.coinRoot.quaternion.toArray();
    const launchHeight = Math.max(launchPos[1] - restPos[1], 0);
    const profile = opts.profile ?? throwProfile(opts.power ?? 0.5, {
      launchSpeed: clipLaunchSpeed(clip, scale),
      launchHeight,
      daringness: opts.daringness,
    });
    const powered = opts.power != null || opts.profile != null;
    const antic = powered ? clamp01(profile.leadInAnticipation) : 0;

    // --- how long the bridge takes ----------------------------------------
    // Only for a supplied release pose; the default path keeps power.js's own
    // number so nothing about today's throw moves.
    //
    // The easing below covers the whole gap as e = s^2 over the MOVING span of
    // the lead-in — that is (1 - antic) of it, the rest being the wind-up — so
    // the coin's exit speed is 2*dist / (L * (1-antic)). Solving that for L is
    // the velocity match. Two things claim L and the longer wins:
    //
    //   * the MATCH, so there is no speed step at the handoff;
    //   * the TURN, because a released coin sits at the player's yaw and the
    //     clip opens at the bake's (LEADIN_BRIDGE.maxTurnDegPerSec) — but only
    //     up to turnStretchMax of the match, or a short bridge degenerates into
    //     a hover.
    //
    // When the turn wins, the coin arrives slower than the clip opens. That is
    // the deliberate direction to err in: an undershoot reads as the clip
    // picking the coin up, an overshoot reads as the coin hitting a wall. Both
    // are measured per-throw into report.throw.bridge rather than assumed.
    //
    // Below minBridgeMetres() the match is unreachable at any duration and the
    // coin is handed over slow no matter what. That is a constraint ON THE
    // GESTURE, not a bug here: see that function.
    const bridgeVec = [launchPos[0] - restPos[0], launchPos[1] - restPos[1], launchPos[2] - restPos[2]];
    const bridgeDist = Math.hypot(bridgeVec[0], bridgeVec[1], bridgeVec[2]);
    const bridgeTurnDeg = quatAngleDeg(restQuat, launchQuat);
    const movingFrac = Math.max(1 - antic, 1e-3);
    function bridgeLeadInMs() {
      const v = profile.leadInExitSpeed;
      const match = v > 0 ? (2000 * bridgeDist) / (v * movingFrac) : profile.leadInMs;
      const turn = (1000 * bridgeTurnDeg / LEADIN_BRIDGE.maxTurnDegPerSec) / movingFrac;
      const padded = Math.max(match, Math.min(turn, match * LEADIN_BRIDGE.turnStretchMax));
      return clamp(padded, LEADIN_BRIDGE.minMs, LEADIN.msMax);
    }
    // Without a release pose the lead-in exists only for clips that begin in the
    // air (every baked one does; the procedural fallback starts on the table and
    // needs none). WITH one it always exists, because the coin is in the
    // player's hand and has to reach the clip's first frame wherever that is —
    // including downwards, onto a procedural clip that opens on the table.
    const leadIn = opts.leadInMs
      ?? (fromPose ? bridgeLeadInMs()
        : (analysis.startsAirborne ? (powered ? profile.leadInMs : LEADIN_MS) : 0));
    // What the coin will ACTUALLY be doing as the clip takes over, from the
    // profile that is about to run rather than from the one that was requested.
    const achievedExitSpeed = leadIn > 0
      ? (2 * bridgeDist) / ((leadIn / 1000) * movingFrac) : null;
    const readyShot = { ...READY_SHOT, target: READY_SHOT.target.slice() };
    const settle = settleShot(analysis.finalPos);
    const wallDuration = leadIn + warp.totalWallMs;

    // put the coin where the flip starts before anything else moves
    if (leadIn > 0) sceneApi.setCoinPose(restPos, restQuat);
    else sceneApi.setCoinPose(launchPos, launchQuat);

    // --- the spin counter -------------------------------------------------
    // THE COUNT IS A BET AXIS. The player types a rotation line, is paid on it,
    // and reads the counter to watch it happen — so what ticks has to be what
    // the coin really did, and it has to survive whatever the frame track looks
    // like.
    //
    // With a beat track the count is read off RECORDED CROSSING TIMES: measured
    // once at the bake's full 256 fps and compared against clip time. That is
    // exact at any display rate, under slow motion, and after the frame track is
    // decimated — because it never consults the frame track at all.
    //
    // The frame-derived count is KEPT ANYWAY, running alongside. It is the
    // witness: it is what the beats were derived from, so when the two agree the
    // recording is confirmed against the geometry on every single flip, and when
    // they disagree that is reported rather than hidden. Deleting it would save
    // nothing and would throw away the only thing that can catch a stale or
    // mismatched beat file.
    const beats = beatsForClip(clip, beatMap);
    let beatIdx = 0;               // beats consumed so far
    let cursor = 0;
    let sign = Math.sign(upDot(frames[0].quat)) || 1;
    let frameHalfFlips = 0;        // the witness: crossings the FRAMES describe
    let halfFlips = 0;             // what the player is shown and paid on
    let started = 0;
    let off = null;
    let prevClipMs = 0;          // for the blur's real per-frame clip-time step
    let peakOmega = 0;
    let ctNow = 0;               // clip time this display frame — drives the push-in
    // Camera schedule, converted ONCE from clip time into wall time. Under a
    // warp these differ by hundreds of ms, and the crane must fire on what the
    // player is watching, not on what the physics clock says.
    const tdWall = leadIn + warp.wallAt(analysis.touchdownMs);
    const apexClipMs = Math.min(analysis.apexMs ?? 0, analysis.touchdownMs);
    const dramaSpan = Math.max(analysis.touchdownMs - apexClipMs, 1e-6);
    onSpin(0, 0);
    onPhase(leadIn > 0 ? 'launch' : 'flight');
    let phase = leadIn > 0 ? 'launch' : 'flight';

    return new Promise((resolve) => {
      off = sceneApi.onFrame((now) => {
        if (!started) started = now;
        const t = clamp(now - started, 0, wallDuration + HOLD_AFTER_MS);

        let pos, quat;
        if (t < leadIn) {
          // Accelerating lift. `antic` is the wind-up: at high power the coin
          // sits still for a beat and then whips, which is what makes a hard
          // pull read as hard. The remaining span is constant-acceleration
          // (y ~ s^2), so the coin leaves the hand at 2h/L — and L was chosen
          // in power.js precisely so that speed brackets the clip's own launch
          // speed. The coin therefore never drifts up into the clip, and never
          // out-runs it either.
          const raw = t / leadIn;
          const s = antic >= 1 ? 0 : clamp((raw - antic) / (1 - antic), 0, 1);
          const e = s * s;
          pos = [
            restPos[0] + (launchPos[0] - restPos[0]) * e,
            restPos[1] + (launchPos[1] - restPos[1]) * e,
            restPos[2] + (launchPos[2] - restPos[2]) * e,
          ];
          // A clip opens at whatever yaw the bake launched it from, and the coin
          // is sitting at the rest pose's ORIENTATION 0 (North) — or, once the
          // player can pick it up, at whatever yaw they were holding it at — so
          // this slerp is also what reconciles the two. Same easing as the lift,
          // so the coin turns into the release rather than arriving already
          // turned. The bridge duration is sized to cover this angle without a
          // snap; see LEADIN_BRIDGE.maxTurnDegPerSec.
          qa.fromArray(restQuat); qb.fromArray(launchQuat);
          qm.copy(qa).slerp(qb, e);
          quat = [qm.x, qm.y, qm.z, qm.w];
          // No blur on the lead-in: it tops out around 20 rad/s, well under the
          // rate that strobes, and it is invented motion rather than clip data.
          if (blur) blur.clearPlan();
        } else {
          const ct = clamp(warp.clipAt(t - leadIn), 0, duration);
          ctNow = ct;

          // advance through source frames, counting every horizon crossing they
          // describe (so a slow display can never lose a half-flip)
          while (cursor < frames.length - 2 && frames[cursor + 1].t * scale <= ct) {
            cursor++;
            const s = Math.sign(upDot(frames[cursor].quat)) || sign;
            if (s !== sign) {
              sign = s; frameHalfFlips++;
              if (!beats) { halfFlips = frameHalfFlips; onSpin(toRotations(halfFlips), halfFlips); }
            }
          }

          // With a beat track the count is time-driven: consume every crossing
          // the clock has passed. Note this is a WHILE, not an if — under slow
          // motion a display frame covers little clip time, but a dropped frame
          // or a background tab can cover a lot, and a beat that is stepped over
          // must still be counted rather than lost.
          if (beats) {
            while (beatIdx < beats.length && beats[beatIdx] <= ct) {
              beatIdx++; halfFlips = beatIdx;
              onSpin(toRotations(halfFlips), halfFlips);
            }
          }

          const f0 = frames[cursor], f1 = frames[Math.min(cursor + 1, frames.length - 1)];
          const t0 = f0.t * scale, t1 = f1.t * scale;
          const k = t1 > t0 ? clamp((ct - t0) / (t1 - t0), 0, 1) : 0;

          pos = [
            f0.pos[0] + (f1.pos[0] - f0.pos[0]) * k,
            f0.pos[1] + (f1.pos[1] - f0.pos[1]) * k,
            f0.pos[2] + (f1.pos[2] - f0.pos[2]) * k,
          ];
          qa.fromArray(f0.quat); qb.fromArray(f1.quat);
          qm.copy(qa).slerp(qb, k);
          quat = [qm.x, qm.y, qm.z, qm.w];

          const s = Math.sign(upDot(quat)) || sign;
          if (s !== sign) {
            sign = s; frameHalfFlips++;
            if (!beats) { halfFlips = frameHalfFlips; onSpin(toRotations(halfFlips), halfFlips); }
          }

          if (phase === 'launch') { phase = 'flight'; onPhase('flight'); }
          if (phase === 'flight' && ct >= analysis.touchdownMs) { phase = 'settle'; onPhase('settle'); }

          // --- motion blur -------------------------------------------------
          // Hand the blur the real clip-time step this display frame consumed
          // and the instantaneous angular speed read off the quaternion track.
          // Measuring the step AFTER the warp means bullet time is accounted
          // for without the blur knowing bullet time exists.
          if (blur) {
            const w = omegaAt(ct);
            if (w > peakOmega) peakOmega = w;
            blur.setPlan({
              sample: sampleAt,
              clipMs: ct,
              dClipMs: Math.max(ct - prevClipMs, 0),
              omega: w,
              touchdownMs: analysis.touchdownMs,
              durationMs: duration,
            });
          }
          prevClipMs = ct;
        }

        sceneApi.setCoinPose(pos, quat);

        // camera: out of the ready shot at launch, follow the coin, PUSH IN from
        // the apex, then crane to near-top-down over where it stopped so the
        // settled yaw reads. A hard pull gets the camera out of the way faster
        // and further, so the toss reads bigger.
        // PRESENTATION ONLY — none of this moves the coin.
        const pullMs = powered ? profile.camPulloutMs : CAM_PULLOUT_MS;
        const apexDist = powered ? profile.camDistanceApex : FLIGHT_CAM.distanceApex;
        const pull = smoothstep(t / pullMs);
        // The push-in shares the slow-down's window exactly: it opens at the
        // apex and is fully closed at first contact, so the zoom and the time
        // ramp are two halves of one move. On the pre-apex rise it is 0, which
        // is the plain follow shot this had before.
        const zoom = slowmoCfg ? smoothstep((ctNow - apexClipMs) / dramaSpan) : 0;
        const close = smoothstep((t - tdWall) / CAM_SETTLE_MS);
        const base = lerpShot(readyShot, flightShot(pos, analysis.apexY, apexDist, zoom), pull);
        sceneApi.applyShot(lerpShot(base, settle, close));

        if (t >= wallDuration + HOLD_AFTER_MS) {
          off(); off = null;
          // The settled coin is NEVER blurred: the plan is torn down before the
          // final pose is set, so the frame the player reads the result off is
          // an ordinary sharp render.
          if (blur) blur.clearPlan();
          // snap to the exact authored rest pose — no interpolation residue
          const last = frames[frames.length - 1];
          sceneApi.setCoinPose(last.pos, last.quat);
          // Both counters land here. The beats are what the player was paid on;
          // the frame walk is the witness they were derived from. Report a
          // disagreement between them separately from a disagreement with the
          // metadata — the first means the beat file is stale or belongs to a
          // different clip, the second means the clip itself is wrong, and
          // conflating them would hide whichever came second.
          if (beats && frameHalfFlips !== halfFlips) {
            console.warn(`[flip3d] beat track says ${halfFlips} half-flips, the frames describe `
              + `${frameHalfFlips} — the recording disagrees with the geometry (clip ${clip.meta.id ?? '?'})`);
          }
          if (halfFlips !== clip.meta.halfFlips) {
            console.warn(`[flip3d] counted ${halfFlips} half-flips, clip says ${clip.meta.halfFlips}`);
          }
          onSpin(toRotations(clip.meta.halfFlips), clip.meta.halfFlips);
          onPhase('done');
          busy = false;

          // Everything below is read back off the live scene, not off the clip.
          const landedFace = sceneApi.currentFace();
          const modelFace = sceneApi.modelHeadsUp() ? 'Heads' : 'Tails';
          const landedOrientation = roundOrientation(orientationFromQuat(sceneApi.coinRoot.quaternion.toArray()));
          const modelOrientation = roundOrientation(sceneApi.modelOrientationDeg());
          const landedQuad = quadrantFromOrientation(landedOrientation);
          const wantOrientation = clipTargetOrientation(clip);
          const dOrient = wantOrientation == null ? 0
            : Math.min(normDeg(landedOrientation - wantOrientation), normDeg(wantOrientation - landedOrientation));
          // the design's 12 o'clock on the rendered mesh vs the canonical body +X
          const dModel = Math.min(normDeg(modelOrientation - landedOrientation), normDeg(landedOrientation - modelOrientation));
          const report = {
            meta: clip.meta,
            analysis,
            timing: {
              clipMs: duration,
              leadInMs: leadIn,
              holdMs: HOLD_AFTER_MS,
              // press -> coin still, excluding the hold. THIS is the flip's length.
              wallMs: wallDuration,
              wallSec: +(wallDuration / 1000).toFixed(3),
              slowmo: !!slowmoCfg,
              bulletTime: !!slowmoCfg,      // old name, same thing
              rate: +(duration / warp.totalWallMs).toFixed(3),
              // The ramp, in the units it is actually experienced in. apexWallMs
              // is when the push-in opens; tdWall - leadIn when it is fully in.
              apexMs: +apexClipMs.toFixed(1),
              apexWallMs: +(leadIn + warp.wallAt(apexClipMs)).toFixed(1),
              touchdownWallMs: +tdWall.toFixed(1),
              // wall ms spent on the descent — the beat the player reads the
              // coin in. This is the number the effect exists to raise.
              descentWallMs: +(tdWall - (leadIn + warp.wallAt(apexClipMs))).toFixed(1),
              rateAtTouchdown: +warp.rateAt(analysis.touchdownMs).toFixed(3),
            },
            throw: {
              power: powered ? profile.power : null,
              leadInMs: leadIn,
              leadInAnticipation: +antic.toFixed(4),
              leadInExitSpeed: profile.leadInExitSpeed,
              clipLaunchSpeed: clipLaunchSpeed(clip, scale),
              launchHeightM: +launchHeight.toFixed(5),
              // THE BRIDGE. Where the player let go, how far that left to
              // travel, and — the number that matters — how fast the coin was
              // actually moving as the clip took over versus how fast it was
              // supposed to be. A ratio away from 1 is a visible speed step at
              // the handoff, so it is reported rather than left to be felt.
              bridge: {
                fromPose: !!fromPose,
                releasedY: +restPos[1].toFixed(5),
                heightM: +launchHeight.toFixed(5),
                distM: +bridgeDist.toFixed(5),
                turnDeg: +bridgeTurnDeg.toFixed(2),
                intendedExitSpeed: profile.leadInExitSpeed == null ? null
                  : +profile.leadInExitSpeed.toFixed(4),
                achievedExitSpeed: achievedExitSpeed == null ? null
                  : +achievedExitSpeed.toFixed(4),
                exitSpeedRatio: (profile.leadInExitSpeed > 0 && achievedExitSpeed != null)
                  ? +(achievedExitSpeed / profile.leadInExitSpeed).toFixed(4) : null,
              },
              camPulloutMs: powered ? profile.camPulloutMs : CAM_PULLOUT_MS,
              peakOmega: +peakOmega.toFixed(2),
              apexY: analysis.apexY,
              airborneMs: +analysis.touchdownMs.toFixed(1),
            },
            played: {
              halfFlipsCounted: halfFlips,
              // the witness, and which source the player was actually shown
              halfFlipsFromFrames: frameHalfFlips,
              countSource: beats ? 'beats' : 'frames',
              beatsAvailable: beats ? beats.length : 0,
              rotationsShown: toRotations(halfFlips),
              landedFace,            // read back off the canonical coinRoot
              modelFace,             // read back off the GLB mesh's world orientation
              landedOrientationDeg: landedOrientation,
              modelOrientationDeg: modelOrientation,
              landedQuadrant: landedQuad,
              travelDistM: Math.hypot(last.pos[0], last.pos[2]),   // meaningless by design
              restY: last.pos[1],
              elapsedMs: t,
            },
            ok: {
              side: landedFace === clip.meta.side,
              sideOnModel: modelFace === clip.meta.side,
              orientation: dOrient <= ORIENT_TOL_DEG,
              orientationOnModel: dModel <= ORIENT_TOL_DEG * 2,
              quadrant: landedQuad === clip.meta.quadrant,
              halfFlips: halfFlips === clip.meta.halfFlips,
              // the recording still matches the geometry it was taken from
              beatsMatchFrames: !beats || frameHalfFlips === halfFlips,
              restsOnTable: Math.abs(last.pos[1] - COIN_HALF_THICKNESS_M) < 1e-5,
              flat: analysis.ok.flat,
            },
          };
          report.pass = Object.values(report.ok).every(Boolean);
          resolve(report);
        }
      });
    });
  }

  /**
   * Outcome -> clip -> playback. The BAKED LIBRARY IS THE DEFAULT; the
   * procedural builder is the fallback and says so in report.source.
   */
  async function playFlip(outcome, opts = {}) {
    assertOutcome(outcome);
    const power = opts.power == null ? null : clamp01(opts.power);
    let clip = null;
    let fallbackReason = null;
    let variant = null;
    if (library && !opts.forceProcedural) {
      try {
        const sel = { ...opts };
        // ==============================================================
        // POWER -> VARIANT. The one place the pull reaches the library.
        // ==============================================================
        // `flickForce` IS the power, which is exactly what identity.js's
        // selectVariant() was built to receive. It picks among the 8 clips of
        // the cell the seed ALREADY drew, so side, half-flip count and quadrant
        // are all fixed before this runs and cannot be moved by it.
        // library.js#select() re-checks the pick into the cell anyway.
        //
        // What it DOES change, measured over all 128 cells rather than assumed
        // (tools/verify-power.mjs §8): the coin's horizontal launch velocity,
        // so a brutal pull skitters ~17 cm across the table where a feather
        // stops at ~11 cm (+54%), and the measured settle yaw inside the
        // already-won quadrant. What it does NOT change, because the bake fixes
        // halfFlips per cell: tumble rate, apex, flight time, bounce count —
        // all flat to within 2% across the 8 variants. Travel is the design
        // doc's §2 quantity that deliberately carries no bet, which makes it
        // the safest carrier there is for visible violence.
        if (power != null && opts.seedHex) {
          variant = selectVariant(library.pool(outcome), {
            daringness: opts.daringness ?? 0.5,
            flickForce: power,
            seedHex: opts.seedHex,
          });
          if (variant) sel.variant = variant;
        }
        clip = await library.clipFor(outcome, sel);
      } catch (err) {
        fallbackReason = String(err && err.message || err);
        console.warn('[flip3d] baked clip unavailable, falling back to procedural:', fallbackReason);
      }
    } else if (!library) {
      fallbackReason = 'no clip library loaded';
    }
    // Bullet time is applied ONCE, by the player, so it works identically for a
    // baked clip and a procedural one. buildProceduralClip() can bake its own
    // stretch into the frame timestamps, so that option is deliberately not
    // forwarded — otherwise the slow-down would land twice.
    if (!clip) {
      // `slowmo` is stripped alongside `bulletTime` for the same reason — they
      // are two spellings of one effect. `fromPose` is stripped because it
      // describes the player's hand, which is the PLAYER's business: the builder
      // authors a flight from an already-decided outcome and must not see it.
      const { bulletTime, slowmo, fromPose, ...proc } = opts;
      // The procedural builder is the ONE path where the renderer owns the
      // flight, so it is the one path where power really does set apex height:
      // airborne time is the only knob and apex = g*T^2/8 follows from it.
      if (power != null && proc.airborneSec == null) {
        proc.airborneSec = throwProfile(power, { daringness: opts.daringness }).airborneSec;
      }
      clip = buildProceduralClip(outcome, proc);
    }
    const report = await playClip(clip, opts);
    report.source = clip.meta.source;
    report.clipId = clip.meta.id ?? null;
    report.fallbackReason = fallbackReason;
    report.outcome = outcome;
    report.variant = variant ? { id: variant.id, energy: variant.energy } : null;
    // The variant may have moved the settle yaw inside the drawn quadrant, so
    // the outcome that was actually PLAYED is reported alongside the one that
    // was drawn. The bet axes below are asserted identical between the two.
    report.resolvedOutcome = {
      ...outcome,
      orientationDeg: clip.meta.orientationDeg ?? outcome.orientationDeg,
      quadrant: clip.meta.quadrant ?? outcome.quadrant,
      clipId: clip.meta.id ?? null,
      energy: clip.meta.energy ?? null,
    };
    // The renderer must have played the outcome it was handed, not one it liked.
    report.ok.matchesOutcome =
      report.played.landedFace === outcome.side &&
      report.played.landedQuadrant === outcome.quadrant &&
      clip.meta.halfFlips === outcome.spins;
    // THE FAIRNESS ASSERTION, checked on every single throw: whatever power did,
    // the clip that played belongs to the cell the seed drew. If a future change
    // ever lets the pull leak into the outcome, this goes red on flip one.
    report.ok.betAxesPreserved =
      clip.meta.halfFlips === outcome.spins &&
      clip.meta.quadrant === outcome.quadrant &&
      clip.meta.side === outcome.side &&
      clip.meta.startFace === outcome.startFace;
    report.ok.exactOrientation = outcome.orientationDeg == null
      || clip.meta.exactOrientation !== false;
    report.pass = Object.values(report.ok).every(Boolean);
    return report;
  }

  /**
   * Park the coin at the launch origin showing `face`, camera on the ready shot.
   * scene.setRestFace() puts the design's 12 o'clock at ORIENTATION 0 = NORTH,
   * so the coin the player presses on is sitting at the dial's zero.
   */
  function ready(face, { animate = true, ms = 380 } = {}) {
    if (blur) blur.clearPlan();
    return new Promise((resolve) => {
      const fromPos = sceneApi.coinRoot.position.toArray();
      const fromQuat = sceneApi.coinRoot.quaternion.toArray();
      const fromShot = { ...sceneApi.shot, target: sceneApi.shot.target.slice() };
      sceneApi.setRestFace(face);
      const toPos = sceneApi.coinRoot.position.toArray();
      const toQuat = sceneApi.coinRoot.quaternion.toArray();
      onSpin(0, 0);
      onPhase('ready');
      if (!animate) { sceneApi.applyShot({ ...READY_SHOT, target: READY_SHOT.target.slice() }); return resolve(); }
      sceneApi.setCoinPose(fromPos, fromQuat);
      let started = 0;
      const off = sceneApi.onFrame((now) => {
        if (!started) started = now;
        const k = smoothstep((now - started) / ms);
        qa.fromArray(fromQuat); qb.fromArray(toQuat);
        qm.copy(qa).slerp(qb, k);
        sceneApi.setCoinPose(
          [fromPos[0] + (toPos[0] - fromPos[0]) * k,
            fromPos[1] + (toPos[1] - fromPos[1]) * k,
            fromPos[2] + (toPos[2] - fromPos[2]) * k],
          [qm.x, qm.y, qm.z, qm.w],
        );
        sceneApi.applyShot(lerpShot(fromShot, READY_SHOT, k));
        if (k >= 1) { off(); resolve(); }
      });
    });
  }

  return { playClip, playFlip, ready, library, blur, get busy() { return busy; } };
}
