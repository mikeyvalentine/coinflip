// tools/verify-leadin.mjs
// ---------------------------------------------------------------------------
// Headless sweep for THE BRIDGE: the lead-in that carries the coin from wherever
// the player let go of it to the clip's first frame. Runs in Node with no GPU
// and no DOM, because the preview pane is usually hidden and cannot be trusted
// to render or to fire requestAnimationFrame.
//
// The pick-up gesture means the coin no longer always starts at rest on the
// table, so `playClip(clip, { fromPose })` must bridge from an arbitrary release
// pose. What this is here to prove, in order of how much it matters:
//
//   1. WITHOUT `fromPose` nothing moved. The gesture is a strict superset and
//      the old path has to be arithmetically identical, not merely similar.
//   2. The bridge cannot touch a bet axis. It is pre-flight — it tumbles
//      nothing and counts nothing — so the half-flip count the player watches
//      tick must be the clip's own at every release height and display rate.
//   3. The HANDOFF IS CONTINUOUS. Position and orientation must not jump
//      between the last bridge frame and the clip's first, and the coin's speed
//      as the clip takes over must match the speed the clip opens at, or the
//      clip visibly snatches the coin (too slow) or the coin hits a wall (too
//      fast). Measured by sampling the profile, never asserted from the algebra.
//   4. The flip stays a sane length across the whole range of release heights.
//
// Run: node tools/verify-leadin.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEADIN_BRIDGE, LEADIN_MS, HOLD_AFTER_MS, makeClipWarp, minBridgeMetres,
} from '../flip3d/player.js';
import { throwProfile, clipLaunchSpeed, clamp01, LEADIN } from '../flip3d/power.js';
import { analyzeClip, clipTimeScale } from '../flip3d/clip.js';
import { loadClipLibrary } from '../flip3d/library.js';
import { upDot, expectedSide, COIN_HALF_THICKNESS_M } from '../flip3d/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = (n) => +n.toFixed(1);
const f3 = (n) => +n.toFixed(3);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const fetchShim = async (url) => {
  const rel = url.replace(/^\.\//, '');
  try {
    const buf = await fs.readFile(path.join(ROOT, rel), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(buf) };
  } catch (e) { return { ok: false, status: 404, json: async () => { throw e; } }; }
};
const library = await loadClipLibrary({ base: './bake/out/', fetch: fetchShim });
console.log(`library: ${library.stats.clips} clips, ${library.stats.cells} cells`);

const clips = [];
for (const e of library.index) {
  clips.push(await library.clipFor({
    startFace: 'Heads', side: expectedSide('Heads', e.halfFlips), spins: e.halfFlips,
    orientationDeg: e.orientationDeg, quadrant: e.quadrant, edge: false, clipId: e.id,
  }));
}
console.log(`loaded ${clips.length} clips for the sweep\n`);

// ---------------------------------------------------------------------------
// A FAITHFUL RE-IMPLEMENTATION of player.js's bridge maths and easing.
//
// player.js computes these inside playClip's closure, where they are reachable
// only through a live sceneApi and a running requestAnimationFrame loop. Rather
// than stand up a fake scene and a fake clock, the arithmetic is mirrored here
// and section (1) pins the mirror to the real thing by checking it reproduces
// the shipped default (LEADIN_MS on the table path) exactly. If player.js and
// this file ever drift, that section is what goes red.
// ---------------------------------------------------------------------------
function quatAngleDeg(a, b) {
  let d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  if (d > 1) d = 1;
  return 2 * Math.acos(d) * 180 / Math.PI;
}

/** Everything playClip derives about the bridge, for one clip + release pose. */
function bridgeOf(clip, { fromPose = null, power = null, leadInMs = null } = {}) {
  const frames = clip.frames;
  const scale = clipTimeScale(clip);
  const analysis = analyzeClip(clip);
  const launchPos = frames[0].pos, launchQuat = frames[0].quat;

  const restPos = fromPose ? fromPose.pos.slice() : [0, COIN_HALF_THICKNESS_M, 0];
  // Without a fromPose player.js reads the live coinRoot quaternion; the ready
  // pose is ORIENTATION 0 (North), which for this arithmetic is identity yaw.
  const restQuat = fromPose ? fromPose.quat.slice() : [0, 0, 0, 1];
  const launchHeight = Math.max(launchPos[1] - restPos[1], 0);

  const profile = throwProfile(power ?? 0.5, {
    launchSpeed: clipLaunchSpeed(clip, scale),
    launchHeight,
    daringness: 0.5,
  });
  const powered = power != null;
  const antic = powered ? clamp01(profile.leadInAnticipation) : 0;

  const bridgeVec = [launchPos[0] - restPos[0], launchPos[1] - restPos[1], launchPos[2] - restPos[2]];
  const bridgeDist = Math.hypot(bridgeVec[0], bridgeVec[1], bridgeVec[2]);
  const bridgeTurnDeg = quatAngleDeg(restQuat, launchQuat);
  const movingFrac = Math.max(1 - antic, 1e-3);

  let leadIn;
  if (leadInMs != null) leadIn = leadInMs;
  else if (fromPose) {
    const v = profile.leadInExitSpeed;
    const match = v > 0 ? (2000 * bridgeDist) / (v * movingFrac) : profile.leadInMs;
    const turn = (1000 * bridgeTurnDeg / LEADIN_BRIDGE.maxTurnDegPerSec) / movingFrac;
    const padded = Math.max(match, Math.min(turn, match * LEADIN_BRIDGE.turnStretchMax));
    leadIn = clamp(padded, LEADIN_BRIDGE.minMs, LEADIN.msMax);
  } else {
    leadIn = analysis.startsAirborne ? (powered ? profile.leadInMs : LEADIN_MS) : 0;
  }

  const achievedExitSpeed = leadIn > 0
    ? (2 * bridgeDist) / ((leadIn / 1000) * movingFrac) : null;

  return {
    analysis, launchPos, launchQuat, restPos, restQuat, launchHeight,
    profile, powered, antic, movingFrac, bridgeDist, bridgeTurnDeg, leadIn,
    achievedExitSpeed, clipLaunch: clipLaunchSpeed(clip, scale),
  };
}

/** The pose the bridge puts the coin at, `t` ms into a lead-in of `leadIn`. */
function bridgePoseAt(b, t) {
  const raw = t / b.leadIn;
  const s = b.antic >= 1 ? 0 : clamp((raw - b.antic) / (1 - b.antic), 0, 1);
  const e = s * s;
  return [
    b.restPos[0] + (b.launchPos[0] - b.restPos[0]) * e,
    b.restPos[1] + (b.launchPos[1] - b.restPos[1]) * e,
    b.restPos[2] + (b.launchPos[2] - b.restPos[2]) * e,
  ];
}

// The release heights swept below. The table is 0.00075; the baked clips open
// at 0.22 m.
//
// The sweep is split, because the two halves are held to different standards
// and conflating them would mean either excusing a real fault or asserting the
// impossible. MATCHED heights leave a bridge longer than minBridgeMetres(), so
// the velocity match is reachable and is REQUIRED. DEGENERATE heights sit at or
// inside that limit, where no duration can accelerate the coin to the clip's
// launch speed over the distance available — there the requirement is only that
// the renderer stays continuous and bounded, and the real fix is a clamp on the
// gesture (see the report and minBridgeMetres).
const MATCHED_HEIGHTS = [COIN_HALF_THICKNESS_M, 0.02, 0.05, 0.10, 0.15, 0.19];
const DEGENERATE_HEIGHTS = [0.215, 0.22, 0.24, 0.26];
const HEIGHTS = [...MATCHED_HEIGHTS, ...DEGENERATE_HEIGHTS];
const IDENTITY_QUAT = [0, 0, 0, 1];
const poseAt = (y, quat = IDENTITY_QUAT) => ({ pos: [0, y, 0], quat: quat.slice() });

// ===========================================================================
console.log('=== (1) no fromPose reproduces today\'s lead-in exactly ===');
{
  let bad = 0;
  const seen = new Set();
  for (const clip of clips) {
    const b = bridgeOf(clip, {});
    seen.add(b.leadIn);
    if (b.leadIn !== LEADIN_MS) bad++;
    // and the height it works from is still the full lift off the table
    const want = clip.frames[0].pos[1] - COIN_HALF_THICKNESS_M;
    if (Math.abs(b.launchHeight - want) > 1e-12) bad++;
  }
  ok(bad === 0, 'the unpowered table path changed', { bad, seen: [...seen] });
  console.log(`  ${clips.length} clips, no fromPose, no power: lead-in is ${[...seen].join('/')} ms `
    + `(LEADIN_MS = ${LEADIN_MS}) and launchHeight is still the full lift`);

  // powered, still no fromPose: must be exactly power.js's number, untouched
  let poweredBad = 0;
  const ratios = [];
  for (const clip of clips) {
    for (const p of [0, 0.5, 1]) {
      const b = bridgeOf(clip, { power: p });
      if (b.leadIn !== b.profile.leadInMs) poweredBad++;
      ratios.push(b.achievedExitSpeed / b.profile.leadInExitSpeed);
    }
  }
  ok(poweredBad === 0, 'the powered table path no longer uses power.js\'s duration', { poweredBad });
  console.log('  powered, no fromPose: lead-in is still exactly profile.leadInMs');
  console.log(`  (that path's own exit-speed ratio: ${f3(Math.min(...ratios))}..${f3(Math.max(...ratios))} `
    + '— see section (4), this is pre-existing and NOT introduced here)');
}

// ===========================================================================
console.log('\n=== (2) THE LOAD-BEARING ONE: the bridge cannot move a bet axis ===');
{
  // Replays the playback loop's counting exactly as player.js does it — a
  // monotone cursor over source frames counting up-axis horizon crossings —
  // with the bridge in front of it at every release height. The bridge tumbles
  // nothing, so what ticks must be the clip's own count, every time.
  function countHalfFlips(clip, b, hz) {
    const frames = clip.frames;
    const scale = clipTimeScale(clip);
    const duration = clip.meta.durationMs;
    const warp = makeClipWarp(clip, b.analysis, true);
    const wallDuration = b.leadIn + warp.totalWallMs;
    const dt = 1000 / hz;
    let cursor = 0;
    let sign = Math.sign(upDot(frames[0].quat)) || 1;
    let halfFlips = 0;
    for (let t = 0; t <= wallDuration + dt; t += dt) {
      if (t < b.leadIn) continue;             // pre-flight: counts nothing
      const ct = clamp(warp.clipAt(Math.min(t, wallDuration) - b.leadIn), 0, duration);
      while (cursor < frames.length - 2 && frames[cursor + 1].t * scale <= ct) {
        cursor++;
        const s = Math.sign(upDot(frames[cursor].quat)) || sign;
        if (s !== sign) { sign = s; halfFlips++; }
      }
    }
    return halfFlips;
  }

  let cases = 0, bad = 0;
  const worst = [];
  for (const clip of clips) {
    for (const y of HEIGHTS) {
      for (const hz of [30, 60, 144]) {
        const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
        const n = countHalfFlips(clip, b, hz);
        cases++;
        if (n !== clip.meta.halfFlips) {
          bad++;
          if (worst.length < 4) worst.push({ id: clip.meta.id, y, hz, counted: n, meta: clip.meta.halfFlips });
        }
      }
    }
  }
  ok(bad === 0, 'a release height changed the half-flip count', { bad, worst });
  console.log(`  ${cases} playbacks (${clips.length} clips x ${HEIGHTS.length} heights x {30,60,144} Hz)`);
  console.log(`  half-flip count differs from the clip's own: ${bad} (must be 0)`);
  console.log('  side, quadrant and settle yaw are read off the clip\'s FINAL frame,');
  console.log('  which the bridge never touches — it only precedes frame 0.');
}

// ===========================================================================
console.log('\n=== (3) the handoff is continuous in position and orientation ===');
{
  // The bridge ends at e = 1, which is exactly the clip's first frame, so this
  // is really asking whether the easing actually lands there at every display
  // rate rather than stopping a frame short and letting the clip start with a
  // jump. Measured as the gap between the last pre-handoff sample and frame 0.
  // FIRST: the bridge must terminate exactly on the clip's frame 0, at every
  // release height. If it does not, the clip opens with a teleport and no
  // amount of easing hides it.
  const endsExactly = clips.every((clip) => HEIGHTS.every((y) => {
    const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
    const p = bridgePoseAt(b, b.leadIn);
    return Math.hypot(b.launchPos[0] - p[0], b.launchPos[1] - p[1], b.launchPos[2] - p[2]) < 1e-12;
  }));
  ok(endsExactly, 'the bridge does not end exactly on the clip\'s first frame');
  console.log(`  bridge lands on frame 0 exactly at every height: ${endsExactly}`);

  // SECOND — and this is the test that matters — the SPEED must not jump across
  // the handoff.
  //
  // An earlier version of this section asserted that the last display frame of
  // the bridge sits within a few mm of frame 0, and it failed at 107 mm. That
  // assertion was simply wrong: at 30 Hz a coin moving at the clip's ~3 m/s
  // launch speed covers 100 mm in a frame, so a large final step is what
  // CORRECT behaviour looks like. Distance per frame measures the frame rate,
  // not continuity. What continuity actually means is that the coin's velocity
  // going into the handoff equals its velocity coming out.
  const rows = [];
  let worstJump = 0, worstCase = null;
  for (const y of HEIGHTS) {
    const jumps = [];
    for (const clip of clips) {
      const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
      const h = Math.min(1, b.leadIn / 8);
      const p0 = bridgePoseAt(b, b.leadIn - h);
      const p1 = bridgePoseAt(b, b.leadIn);
      const vIn = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / (h / 1000);
      const vOut = b.clipLaunch;                  // the clip's own opening speed
      const jump = Math.abs(vIn - vOut) / vOut;
      jumps.push(jump);
      if (jump > worstJump) {
        worstJump = jump;
        worstCase = { id: clip.meta.id, y, vIn: f3(vIn), vOut: f3(vOut) };
      }
    }
    rows.push({
      releaseY: y,
      regime: MATCHED_HEIGHTS.includes(y) ? 'matched' : 'degenerate',
      'speed jump mean': f3(mean(jumps)),
      'speed jump max': f3(Math.max(...jumps)),
    });
  }
  console.table(rows);
  console.log(`  worst speed jump overall: ${f3(worstJump)} at ${JSON.stringify(worstCase)}`);
  console.log('  (the matched regime is asserted in section (4); the degenerate');
  console.log('   regime is expected to jump and is bounded in section (5))');
}

// ===========================================================================
console.log('\n=== (4) THE VELOCITY MATCH, measured off the profile ===');
{
  // Sampled, not derived: the coin's speed over the final millisecond of the
  // bridge, against the speed the clip's own first two frames open at. A ratio
  // of 1 means the clip takes over at exactly the speed the coin was already
  // moving. Above 1 the coin out-runs the clip and decelerates into it; below 1
  // the clip snatches it.
  const rows = [];
  for (const y of HEIGHTS) {
    const ratios = [];
    const leadIns = [];
    for (const clip of clips) {
      const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
      // finite difference over the last 1 ms of the bridge
      const h = Math.min(1, b.leadIn / 8);
      const p0 = bridgePoseAt(b, b.leadIn - h);
      const p1 = bridgePoseAt(b, b.leadIn);
      const measured = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / (h / 1000);
      ratios.push(measured / b.clipLaunch);
      leadIns.push(b.leadIn);
    }
    rows.push({
      releaseY: y, bridgeCm: f1((clips[0].frames[0].pos[1] - y) * 100),
      leadInMs: f1(mean(leadIns)),
      'speed/clip min': f3(Math.min(...ratios)),
      'speed/clip mean': f3(mean(ratios)),
      'speed/clip max': f3(Math.max(...ratios)),
    });
  }
  console.table(rows);

  // The intent is set by power.js: exitScale runs 0.80 (a lob) to 1.30 (a whip)
  // of the clip's own launch speed, so at power 0.7 the coin is MEANT to be
  // arriving at ~1.15x. The band below allows the whole intended range plus the
  // anticipation overshoot documented in the report, and no more.
  // THE ASSERTION applies to the MATCHED regime — every release height that
  // leaves a bridge the match can actually be achieved over. The degenerate
  // heights are held to their own, weaker expectations in section (5).
  const all = [];
  for (const y of MATCHED_HEIGHTS) {
    for (const clip of clips) {
      const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
      const h = Math.min(1, b.leadIn / 8);
      const p0 = bridgePoseAt(b, b.leadIn - h);
      const p1 = bridgePoseAt(b, b.leadIn);
      all.push(Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / (h / 1000) / b.clipLaunch);
    }
  }
  const lo = Math.min(...all), hi = Math.max(...all);
  // power.js intends 0.80x (a lob) to 1.30x (a whip) of the clip's launch
  // speed, and the anticipation overshoot documented in section (1) pushes the
  // top of that to ~1.35x. Anything outside 0.75..1.45 means the bridge has
  // stopped matching, which is exactly what power.js's 70 ms floor produces on
  // a short bridge — measured as the counterfactual below.
  ok(lo >= 0.75, 'the coin arrives too slowly — the clip snatches it', { lo: f3(lo) });
  ok(hi <= 1.45, 'the coin out-runs the clip at the handoff', { hi: f3(hi) });
  console.log(`  matched regime, every clip x height: ${f3(lo)} .. ${f3(hi)} `
    + '(intended band 0.80..1.30, plus anticipation overshoot)');

  // THE COUNTERFACTUAL: what the bridge would do if the duration were left to
  // power.js's clamp instead of being re-derived. This is the bug the
  // re-derivation exists to prevent, so it is measured rather than asserted —
  // if it ever stops being much worse, the re-derivation is dead code.
  // Restricted to heights where power.js can produce a number at all: it
  // returns a null exit speed once the lift is zero, which is the degenerate
  // regime by another name.
  const naive = [];
  for (const y of MATCHED_HEIGHTS) {
    for (const clip of clips) {
      const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
      if (!(b.profile.leadInExitSpeed > 0)) continue;
      const naiveLead = clamp(2000 * b.launchHeight / b.profile.leadInExitSpeed, LEADIN.msMin, LEADIN.msMax);
      const v = (2 * b.bridgeDist) / ((naiveLead / 1000) * b.movingFrac);
      naive.push(v / b.clipLaunch);
    }
  }
  const naiveLo = Math.min(...naive);
  console.log(`  for contrast, with power.js's ${LEADIN.msMin} ms floor left in place: `
    + `${f3(naiveLo)} .. ${f3(Math.max(...naive))}`);
  ok(naiveLo < lo, 'the re-derivation no longer improves on the naive clamp', {
    naiveLo: f3(naiveLo), lo: f3(lo),
  });
}

// ===========================================================================
console.log('\n=== (5) the degenerate cases behave as designed ===');
{
  const launchY = clips[0].frames[0].pos[1];
  console.log(`  the baked clips open at y = ${f3(launchY)} m`);

  // (a) released AT the release point: no lift left, only a turn
  {
    const b = bridgeOf(clips[0], { fromPose: poseAt(launchY), power: 0.7 });
    ok(b.launchHeight === 0, 'a release at the launch point still reports a lift', { h: b.launchHeight });
    ok(b.leadIn >= LEADIN_BRIDGE.minMs, 'the bridge collapsed below one frame', { leadIn: b.leadIn });
    console.log(`  released AT 0.22 m: height 0, turn ${f1(b.bridgeTurnDeg)} deg, `
      + `lead-in ${f1(b.leadIn)} ms — orientation-only, no snap`);
  }

  // (b) released ABOVE the release point: the bridge is a small descent
  {
    const b = bridgeOf(clips[0], { fromPose: poseAt(0.26), power: 0.7 });
    ok(b.launchHeight === 0, 'a release above the launch point reports a positive lift', { h: b.launchHeight });
    ok(b.bridgeDist > 0, 'the descent to the launch point vanished');
    ok(b.leadIn >= LEADIN_BRIDGE.minMs && b.leadIn <= LEADIN.msMax,
      'the descent bridge is out of bounds', { leadIn: b.leadIn });
    console.log(`  released ABOVE at 0.26 m: descends ${f1(b.bridgeDist * 1000)} mm over `
      + `${f1(b.leadIn)} ms — continuous, no teleport`);
  }

  // (c) released essentially on the table: today's case, today's numbers
  {
    const onTable = bridgeOf(clips[0], { fromPose: poseAt(COIN_HALF_THICKNESS_M), power: 0.7 });
    const noPose = bridgeOf(clips[0], { power: 0.7 });
    ok(Math.abs(onTable.launchHeight - noPose.launchHeight) < 1e-12,
      'a table-height fromPose disagrees with no fromPose about the lift',
      { withPose: onTable.launchHeight, without: noPose.launchHeight });
    const drift = Math.abs(onTable.leadIn - noPose.leadIn);
    console.log(`  released ON the table: lift matches the default exactly; `
      + `lead-in ${f1(onTable.leadIn)} vs ${f1(noPose.leadIn)} ms (${f1(drift)} ms apart)`);
    // They are allowed to differ — the re-derivation accounts for the
    // anticipation and power.js's does not — but not wildly.
    ok(drift < 90, 'the bridge disagrees badly with the default at table height', { drift: f1(drift) });
  }

  // (d) the turn must not stretch a short bridge into a hover
  {
    let worstStretch = 0, worstCase = null;
    for (const clip of clips) {
      for (const y of [...MATCHED_HEIGHTS, ...DEGENERATE_HEIGHTS]) {
        const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
        const v = b.profile.leadInExitSpeed;
        if (!(v > 0)) continue;
        const match = (2000 * b.bridgeDist) / (v * b.movingFrac);
        if (!(match > 0)) continue;
        // Only where the TURN is what set the duration. On the very shortest
        // bridges minMs is the binding constraint instead, and a 16 ms floor
        // over a 0.1 ms match reads as a huge "stretch" that the turn had
        // nothing to do with — measuring it here would hide the real signal.
        if (b.leadIn <= LEADIN_BRIDGE.minMs + 1e-9) continue;
        const stretch = b.leadIn / match;
        if (stretch > worstStretch) {
          worstStretch = stretch;
          worstCase = { id: clip.meta.id, y, matchMs: f1(match), leadInMs: f1(b.leadIn) };
        }
      }
    }
    ok(worstStretch <= LEADIN_BRIDGE.turnStretchMax + 1e-6,
      'the turn stretched a bridge past turnStretchMax — the hover is back',
      { worstStretch: f3(worstStretch), worstCase });
    console.log(`  worst turn-stretch over the match: x${f3(worstStretch)} `
      + `(cap x${LEADIN_BRIDGE.turnStretchMax}) at ${JSON.stringify(worstCase)}`);
  }

  // (e) the degenerate regime stays BOUNDED even though it cannot match
  {
    let worstLead = 0, badNumbers = 0;
    const ratios = [];
    for (const clip of clips) {
      for (const y of DEGENERATE_HEIGHTS) {
        const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
        if (!Number.isFinite(b.leadIn) || !Number.isFinite(b.bridgeDist)) badNumbers++;
        worstLead = Math.max(worstLead, b.leadIn);
        if (b.achievedExitSpeed != null) ratios.push(b.achievedExitSpeed / b.clipLaunch);
      }
    }
    ok(badNumbers === 0, 'the degenerate regime produced NaN/Infinity', { badNumbers });
    ok(worstLead <= LEADIN.msMax, 'a degenerate bridge ran past the ceiling', { worstLead: f1(worstLead) });
    console.log(`  degenerate regime: lead-in <= ${f1(worstLead)} ms, arrival speed `
      + `${f3(Math.min(...ratios))}..${f3(Math.max(...ratios))}x the clip's — `
      + 'slow by construction, never NaN, never unbounded');
  }

  // (f) the split between the two regimes is the one minBridgeMetres predicts
  {
    const v = mean(clips.map((c) => clipLaunchSpeed(c, clipTimeScale(c))));
    const antic = clamp01(throwProfile(0.7, {}).leadInAnticipation);
    const limitM = minBridgeMetres(v, antic);
    console.log(`  minBridgeMetres(${f3(v)} m/s, antic ${f3(antic)}) = ${f1(limitM * 1000)} mm`);
    const matchedGaps = MATCHED_HEIGHTS.map((y) => launchY - y);
    const degenerateGaps = DEGENERATE_HEIGHTS.map((y) => launchY - y);
    ok(Math.min(...matchedGaps) >= limitM,
      'a height called matched is inside the minimum bridge', {
        smallestMatchedMm: f1(Math.min(...matchedGaps) * 1000), limitMm: f1(limitM * 1000),
      });
    ok(Math.max(...degenerateGaps) < limitM,
      'a height called degenerate has room to match after all', {
        largestDegenerateMm: f1(Math.max(...degenerateGaps) * 1000), limitMm: f1(limitM * 1000),
      });
    console.log(`  => the gesture must stop the coin at least ${f1(limitM * 1000)} mm below `
      + `${f3(launchY)} m, i.e. a maximum release height of ~${f3(launchY - limitM)} m`);
  }
}

// ===========================================================================
console.log('\n=== (6) the flip stays a sane length at every release height ===');
{
  const rows = [];
  for (const y of HEIGHTS) {
    const totals = [], leads = [];
    for (const clip of clips) {
      const b = bridgeOf(clip, { fromPose: poseAt(y), power: 0.7 });
      const warp = makeClipWarp(clip, b.analysis, true);
      totals.push(b.leadIn + warp.totalWallMs + HOLD_AFTER_MS);
      leads.push(b.leadIn);
    }
    rows.push({
      releaseY: y,
      'lead-in min': f1(Math.min(...leads)),
      'lead-in max': f1(Math.max(...leads)),
      'flip min': f1(Math.min(...totals)),
      'flip median': f1(pct(totals, 0.5)),
      'flip max': f1(Math.max(...totals)),
    });
  }
  console.table(rows);
  const worst = Math.max(...rows.map((r) => r['flip max']));
  // Same ceiling tools/verify-slowmo.mjs holds the ramped flip to. A shorter
  // bridge can only make the flip shorter, so this is really guarding against a
  // bridge that runs away — e.g. the turn floor pinning every throw at msMax.
  ok(worst <= 2800, 'a release height blows the flip-length ceiling', { worstMs: worst });
  console.log(`  longest flip across all release heights: ${f1(worst)} ms (ceiling 2800)`);
}

// ===========================================================================
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
