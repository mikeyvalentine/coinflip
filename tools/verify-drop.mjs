// tools/verify-drop.mjs
// ---------------------------------------------------------------------------
// Headless sweep for the DROP — the coin let go rather than thrown. Runs in Node
// with no GPU and no DOM, because the preview pane is usually hidden and cannot
// be trusted to render or to fire requestAnimationFrame.
//
// What it is here to prove, in order of how much it matters:
//
//   1. THE COIN NEVER TURNS OVER. The face showing at release is the face
//      showing at rest, at every height, in every variant. This is not cosmetic:
//      the start face is a declared input to the next bet (expectedSide() is
//      pure parity off it), so a drop that flipped the coin would resolve the
//      following flip against a lie.
//   2. It ends on the EXACT rest pose — height, zero tilt, same face, and
//      ORIENTATION 0.00 = NORTH, which verify-clips.mjs asserts the resting coin
//      reads and which the orientation dial's zero depends on.
//   3. It never sinks through the table and never rises above where it was let
//      go. Both are geometry, and both are checked at heights nobody would think
//      to try by hand.
//   4. The fall is REAL free fall. Measured by second difference off the pose
//      track, not asserted from the algebra that produced it — an eased fall is
//      the failure mode this project already rejected once as floaty.
//
// Run: node tools/verify-drop.mjs
// ---------------------------------------------------------------------------

import {
  dropParams, dropPoseAt, contactHeight, maxTiltForHeight, playDrop,
  DROP_VARIANTS, REST_Y, TILT_HARD_CAP_DEG, DROP_REF_M, TILT_HEADROOM,
} from '../flip3d/drop.js';
import {
  upDot, orientationFromQuat, roundOrientation, restQuatForFace,
  REST_ORIENTATION_DEG, COIN_HALF_THICKNESS_M, COIN_RADIUS_M, GRAVITY_MS2,
} from '../flip3d/contract.js';
import { LIFT, SHADOW_RADIUS } from '../flip3d/scene.js';

let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = (n) => +n.toFixed(1);
const f3 = (n) => +n.toFixed(3);
const DEG = 180 / Math.PI;

// The sweep: every variant against a spread of release heights from "barely
// lifted" to the ceiling the frame allows.
const HEIGHTS = [0.001, 0.002, 0.004, 0.008, 0.012, 0.016, 0.020, 0.026, 0.030, LIFT.maxY];
const FACES = ['Heads', 'Tails'];
const ALL = [];
for (const v of DROP_VARIANTS) {
  for (const y of HEIGHTS) {
    for (const face of FACES) {
      ALL.push({ v: v.name, y, face, p: dropParams({ fromY: y, face, seed: `sweep::${v.name}::${y}::${face}`, variant: v.name }) });
    }
  }
}
console.log(`${DROP_VARIANTS.length} variants x ${HEIGHTS.length} heights x ${FACES.length} faces = ${ALL.length} drops`);
console.log(`lift range ${REST_Y} .. ${LIFT.maxY} m (drop reference ${f3(DROP_REF_M * 1000)} mm)\n`);

// ===========================================================================
console.log('=== (1) the parameters are sane and the tilt caps bind ===');
{
  let capBad = 0, overCap = 0, zeroEnergyBad = 0;
  for (const c of ALL) {
    const p = c.p;
    // A cap that never binds is a cap nobody tested.
    if (p.tiltDeg > TILT_HARD_CAP_DEG + 1e-9) overCap++;
    // The geometric cap: a coin cannot rock higher than it was released from.
    if (p.tiltRad > maxTiltForHeight(p.y0) + 1e-9) capBad++;
    if (!(p.durationMs > 0)) zeroEnergyBad++;   // every swept height really does fall
  }
  ok(overCap === 0, 'a variant exceeded TILT_HARD_CAP_DEG', { overCap });
  ok(capBad === 0, 'a drop exceeded the geometric tilt cap for its height', { capBad });
  ok(zeroEnergyBad === 0, 'a drop had no duration', { zeroEnergyBad });

  // maxTiltForHeight must actually be the solution of the contact equation.
  let worstSolve = 0;
  for (let i = 0; i <= 200; i++) {
    const y = REST_Y + (LIFT.maxY - REST_Y) * i / 200;
    const th = maxTiltForHeight(y);
    if (th >= TILT_HARD_CAP_DEG / DEG - 1e-12) continue;   // the hard cap took over
    worstSolve = Math.max(worstSolve, Math.abs(contactHeight(th) - y));
  }
  ok(worstSolve < 1e-12, 'maxTiltForHeight is not the exact contact solution', { worstSolve });
  console.log(`  maxTiltForHeight inverts contactHeight to ${worstSolve.toExponential(2)} m`);

  // The cap has to bite somewhere in the real range, or it is decoration. Note
  // it is measured against the HEADROOMED height, which is the cap the code
  // actually applies — checking maxTiltForHeight(y0) instead would be testing a
  // bound nothing is computed from.
  const capAt = (y0) => maxTiltForHeight(REST_Y + Math.max(y0 - REST_Y, 0) * TILT_HEADROOM);
  const bound = ALL.filter((c) => Math.abs(c.p.tiltRad - capAt(c.p.y0)) < 1e-9).length;
  ok(bound > 0, 'the geometric cap never binds anywhere in the sweep', { bound });
  console.log(`  the geometric cap binds on ${bound}/${ALL.length} drops (it is load-bearing, not decorative)`);

  // and the headroom must leave a REAL fall at every height, which is the whole
  // reason it exists — a fall shorter than a frame is a snap, not a drop
  const shortest = Math.min(...ALL.map((c) => c.p.fallMs));
  ok(shortest > 0.5, 'a drop has a fall too short to lean into', { shortestMs: shortest });
  console.log(`  shortest fall anywhere in the sweep: ${f1(shortest)} ms (was 2e-7 before TILT_HEADROOM)`);

  // at zero drop the coin must not stir at all
  // A coin released where it already sits must resolve AT ONCE. Before this was
  // checked, the ring-down floor held the caller's promise open for up to 332 ms
  // (rim-roll) of a coin sitting perfectly still — which on screen is the game
  // appearing to hang after a fumble.
  let worstInert = 0;
  for (const v of DROP_VARIANTS) {
    const still = dropParams({ fromY: REST_Y, face: 'Heads', seed: 'zero', variant: v.name });
    ok(still.tiltRad === 0, 'a coin lowered to the table still wobbles', { variant: v.name });
    worstInert = Math.max(worstInert, still.durationMs);
  }
  ok(worstInert === 0, 'a drop with nothing to animate still took time', { worstInert });
  console.log('  released at rest height: 0 tilt, 0 fall, 0 ms — it resolves on the first frame');

  // The hard cap has to be reachable code, or it is a comment pretending to be a
  // guard. No shipped variant gets near 40 deg, so exercise the function itself.
  ok(Math.abs(maxTiltForHeight(100) - TILT_HARD_CAP_DEG / DEG) < 1e-12,
    'the hard tilt cap is unreachable', { got: maxTiltForHeight(100) * DEG });
  console.log(`  maxTiltForHeight() saturates at the ${TILT_HARD_CAP_DEG} deg hard cap when height is unlimited`);
}

// ===========================================================================
console.log('\n=== (2) THE HEADLINE: the coin never turns over ===');
{
  // 4 kHz. The fastest angular motion in the set is `chatter`: 11 oscillations
  // over a 620 ms window whose instantaneous rate rises to (1+2s)/(1+s) = 1.75x
  // the mean, i.e. a peak of ~195 rad/s of PHASE, one full rock every ~32 ms. At
  // 0.25 ms steps that is ~128 samples per rock, so a sign change cannot hide
  // between samples. (The tilt is also bounded by its own envelope below 40 deg,
  // so there are two independent reasons this cannot fail — the dense sampling
  // is here to catch a bug in the machinery, not to catch the physics.)
  const STEP_MS = 0.25;
  let flips = 0, maxTiltDeg = 0, samples = 0;
  const bad = [];
  for (const c of ALL) {
    const p = c.p;
    const want = Math.sign(upDot(restQuatForFace(c.face)));
    for (let t = 0; t <= p.durationMs; t += STEP_MS) {
      const pose = dropPoseAt(t, p);
      samples++;
      maxTiltDeg = Math.max(maxTiltDeg, Math.abs(pose.tiltRad) * DEG);
      if (Math.sign(upDot(pose.quat)) !== want) {
        flips++;
        if (bad.length < 3) bad.push({ variant: c.v, y: c.y, face: c.face, t: f1(t), tiltDeg: f1(pose.tiltRad * DEG) });
      }
    }
  }
  ok(flips === 0, 'THE COIN TURNED OVER DURING A DROP', { flips, bad });
  ok(maxTiltDeg < 90, 'a tilt reached the face-inversion angle', { maxTiltDeg });
  console.log(`  ${samples.toLocaleString('en-US')} poses at ${STEP_MS} ms: 0 face changes`);
  console.log(`  worst tilt anywhere in the sweep: ${f1(maxTiltDeg)} deg (inverts at 90, hard cap ${TILT_HARD_CAP_DEG})`);

  // and the face that comes up is the face that went down
  let endFaceBad = 0;
  for (const c of ALL) {
    const end = dropPoseAt(c.p.durationMs, c.p);
    if (Math.sign(upDot(end.quat)) !== Math.sign(upDot(restQuatForFace(c.face)))) endFaceBad++;
  }
  ok(endFaceBad === 0, 'the settled face differs from the released face', { endFaceBad });
  console.log(`  released face == settled face on all ${ALL.length} drops`);
}

// ===========================================================================
console.log('\n=== (3) it ends on the EXACT rest pose ===');
{
  let yBad = 0, tiltBad = 0, orientBad = 0, quatBad = 0;
  let worstY = 0, worstOrient = 0, worstQuat = 0;
  for (const c of ALL) {
    const end = dropPoseAt(c.p.durationMs, c.p);
    const restQ = restQuatForFace(c.face);
    worstY = Math.max(worstY, Math.abs(end.pos[1] - REST_Y));
    if (Math.abs(end.pos[1] - REST_Y) > 1e-12) yBad++;
    if (Math.abs(end.tiltRad) > 1e-12) tiltBad++;
    const o = roundOrientation(orientationFromQuat(end.quat));
    worstOrient = Math.max(worstOrient, Math.abs(o - REST_ORIENTATION_DEG));
    if (o !== REST_ORIENTATION_DEG) orientBad++;
    const dq = Math.max(...end.quat.map((q, i) => Math.abs(q - restQ[i])));
    worstQuat = Math.max(worstQuat, dq);
    if (dq > 0) quatBad++;
  }
  ok(yBad === 0, 'the settled height is not exactly the rest height', { yBad, worstY });
  ok(tiltBad === 0, 'the settled tilt is not exactly zero', { tiltBad });
  ok(orientBad === 0, 'the settled orientation is not 0.00 North', { orientBad, worstOrient });
  ok(quatBad === 0, 'the settled quaternion is not bit-identical to the rest quat', { quatBad, worstQuat });
  console.log(`  settled height error ${worstY.toExponential(2)} m, orientation error ${worstOrient} deg`);
  console.log('  the settled quaternion is BIT-IDENTICAL to restQuatForFace(face) on every drop');
  console.log('  (the (1-u)^2 terminal taper is what buys this — a bare exponential only approaches zero)');

  // and it stays settled if a late frame arrives
  const late = dropPoseAt(ALL[0].p.durationMs * 5, ALL[0].p);
  ok(late.pos[1] === REST_Y && late.phase === 'rest', 'a late frame did not hold the rest pose', { late });
  console.log('  a frame arriving 5x late still reads the rest pose, not an extrapolation');
}

// ===========================================================================
console.log('\n=== (4) it stays on the table and under its release height ===');
{
  const STEP_MS = 0.5;
  let under = 0, over = 0, worstUnder = 0, worstOver = 0;
  const bad = [];
  for (const c of ALL) {
    const p = c.p;
    for (let t = 0; t <= p.durationMs; t += STEP_MS) {
      const pose = dropPoseAt(t, p);
      const y = pose.pos[1];
      // Below the table is a hard error: the rim would be inside the wood.
      if (y < REST_Y - 1e-12) {
        under++; worstUnder = Math.max(worstUnder, REST_Y - y);
        if (bad.length < 3) bad.push({ why: 'below table', variant: c.v, t: f1(t), y });
      }
      // Above the release height would be energy from nowhere.
      if (y > p.y0 + 1e-12) {
        over++; worstOver = Math.max(worstOver, y - p.y0);
        if (bad.length < 3) bad.push({ why: 'above release', variant: c.v, t: f1(t), y, y0: p.y0 });
      }
    }
  }
  ok(under === 0, 'the coin went below the table', { under, worstUnder, bad });
  ok(over === 0, 'the coin rose above where it was released', { over, worstOver, bad });
  console.log(`  every pose satisfies ${REST_Y} <= y <= y0, exactly (tolerance 1e-12 m)`);

  // The rim must never intersect the table either — the centre being high enough
  // is only correct if it accounts for the tilt, which is the whole point of
  // contactHeight(). Check the LOWEST POINT of the disc, not the centre.
  let rimBad = 0, worstRim = 0;
  for (const c of ALL) {
    const p = c.p;
    for (let t = 0; t <= p.durationMs; t += STEP_MS) {
      const pose = dropPoseAt(t, p);
      const a = Math.abs(pose.tiltRad);
      const lowest = pose.pos[1] - (COIN_RADIUS_M * Math.sin(a) + COIN_HALF_THICKNESS_M * Math.cos(a));
      if (lowest < -1e-12) { rimBad++; worstRim = Math.min(worstRim, lowest); }
    }
  }
  ok(rimBad === 0, 'the tilted rim cut into the table', { rimBad, worstRim });
  console.log(`  the tilted rim never cuts the table (worst penetration ${worstRim.toExponential(2)} m)`);
}

// ===========================================================================
console.log('\n=== (5) continuity — no teleport at any display rate ===');
{
  const rows = [];
  let worstPos = 0, worstAng = 0, bad = 0;
  for (const hz of [30, 60, 144]) {
    const dt = 1000 / hz;
    let wp = 0, wa = 0;
    for (const c of ALL) {
      const p = c.p;
      let prev = dropPoseAt(0, p);
      for (let t = dt; t <= p.durationMs + dt; t += dt) {
        const pose = dropPoseAt(Math.min(t, p.durationMs), p);
        wp = Math.max(wp, Math.abs(pose.pos[1] - prev.pos[1]));
        // angle between quaternions, in degrees
        const d = Math.abs(pose.quat.reduce((s, q, i) => s + q * prev.quat[i], 0));
        wa = Math.max(wa, 2 * Math.acos(Math.min(d, 1)) * DEG);
        prev = pose;
      }
    }
    // At 30 Hz a coin in free fall covers real ground between frames, so the
    // bound has to be what free fall actually does, not a round number: the
    // impact speed at the tallest drop is sqrt(2*g*h) = 0.78 m/s, which is
    // 26 mm in a 33 ms frame. Anything under that is honest motion.
    const maxFallStep = Math.sqrt(2 * GRAVITY_MS2 * DROP_REF_M) * (dt / 1000);
    rows.push({ hz, worstPosMm: f3(wp * 1000), boundMm: f3(maxFallStep * 1000), worstAngDeg: f1(wa) });
    if (wp > maxFallStep + 1e-9) { bad++; }
    worstPos = Math.max(worstPos, wp); worstAng = Math.max(worstAng, wa);
  }
  console.table(rows);
  ok(bad === 0, 'a position step exceeded what free fall can cover in one frame', { bad });
  // 30 deg, not the 160 that 4x the hard cap would allow. The measured worst is
  // 12.1 deg at 30 Hz, so this leaves 2.5x headroom while still being tight
  // enough that a coin actually tumbling between frames would trip it — which is
  // the only thing this check is for. A ceiling nothing can hit tests nothing.
  ok(worstAng < 30, 'an orientation step was implausibly large', { worstAng });
  console.log(`  worst orientation step ${f1(worstAng)} deg (ceiling 30)`);

  // THE PHASE JOIN. Fall and settle are separate expressions that must agree at
  // the instant of touchdown; a mismatch there is a jolt at exactly the moment
  // the eye is on the coin, and none of the per-frame sampling above is
  // guaranteed to land close enough to either side of it to notice.
  let worstJoinY = 0, worstJoinTilt = 0;
  for (const c of ALL) {
    const p = c.p;
    if (!(p.fallMs > 0)) continue;
    // Proportional epsilon: a fixed 1e-6 ms probe steps clean past t=0 when the
    // fall is itself sub-microsecond, and then compares the release pose against
    // the landing pose and calls the difference a jolt.
    const eps = Math.min(1e-6, p.fallMs * 0.01);
    const before = dropPoseAt(p.fallMs - eps, p);
    const after = dropPoseAt(p.fallMs + eps, p);
    worstJoinY = Math.max(worstJoinY, Math.abs(after.pos[1] - before.pos[1]));
    worstJoinTilt = Math.max(worstJoinTilt, Math.abs(after.tiltRad - before.tiltRad) * DEG);
  }
  ok(worstJoinY < 1e-9, 'the coin jumps in height at touchdown', { worstJoinY });
  ok(worstJoinTilt < 1e-6, 'the coin jumps in tilt at touchdown', { worstJoinTilt });
  console.log(`  fall -> settle join: height step ${worstJoinY.toExponential(2)} m, `
    + `tilt step ${worstJoinTilt.toExponential(2)} deg`);
}

// ===========================================================================
console.log('\n=== (6) the fall is REAL free fall, measured off the track ===');
{
  // Differentiate the sampled height twice. If anyone eases the fall to pad the
  // animation, this is what says so — and easing a descent is the exact mistake
  // this project already threw out once as floaty.
  const rows = [];
  let worstG = 0;
  for (const c of ALL) {
    const p = c.p;
    if (!(p.fallMs > 8)) continue;              // too short to differentiate
    const h = p.fallMs / 400 / 1000;            // seconds per sample
    let worstLocal = 0;
    for (let i = 1; i < 399; i++) {
      const t = (i * p.fallMs) / 400;
      const y0 = dropPoseAt(t - h * 1000, p).pos[1];
      const y1 = dropPoseAt(t, p).pos[1];
      const y2 = dropPoseAt(t + h * 1000, p).pos[1];
      const acc = (y2 - 2 * y1 + y0) / (h * h);
      worstLocal = Math.max(worstLocal, Math.abs(acc + GRAVITY_MS2));
    }
    worstG = Math.max(worstG, worstLocal);
  }
  ok(worstG < 1e-3, 'the fall does not obey g = 9.81', { worstG });
  console.log(`  measured acceleration matches -${GRAVITY_MS2} m/s^2 to ${worstG.toExponential(2)}`);

  // and the fall TIME is the analytic one
  let worstT = 0;
  const fallRows = [];
  for (const v of DROP_VARIANTS) {
    const p = dropParams({ fromY: LIFT.maxY, face: 'Heads', seed: 'fall', variant: v.name });
    const want = Math.sqrt(2 * (p.y0 - p.yLand) / GRAVITY_MS2) * 1000;
    worstT = Math.max(worstT, Math.abs(p.fallMs - want));
    fallRows.push({
      variant: v.name, landsAtTiltDeg: f1(p.tiltDeg),
      fallMm: f3((p.y0 - p.yLand) * 1000), fallMs: f1(p.fallMs), analyticMs: f1(want),
    });
  }
  console.table(fallRows);
  ok(worstT < 1e-9, 'the fall duration is not sqrt(2h/g)', { worstT });
  // Stated plainly: this one is a CONSISTENCY check, not an independent one —
  // fallMs is derived from this same expression, so it can only catch a later
  // edit that breaks the relation. The acceleration measurement above is the
  // test with teeth, because it differentiates the sampled track and would
  // expose an eased fall no matter what the parameters claimed.
  console.log(`  fall time == sqrt(2h/g) to ${worstT.toExponential(2)} ms (consistency check)`);
}

// ===========================================================================
console.log('\n=== (7) the wobble rings DOWN and reaches zero ===');
{
  // Extract the successive peaks of |tilt| from the sampled track. The envelope
  // is only claimed to be monotone; measuring the peaks rather than reading the
  // formula is what makes that a test instead of a restatement.
  let nonMonotone = 0, neverZero = 0, tooFewPeaks = 0;
  const bad = [];
  for (const c of ALL) {
    const p = c.p;
    if (p.tiltRad < 1e-6) continue;             // nothing to ring
    const peaks = [];
    let prev = 0, cur = 0;
    for (let t = p.fallMs; t <= p.durationMs; t += 0.25) {
      const a = Math.abs(dropPoseAt(t, p).tiltRad);
      if (cur > prev && cur > a) peaks.push(cur);
      prev = cur; cur = a;
    }
    for (let i = 1; i < peaks.length; i++) {
      if (peaks[i] > peaks[i - 1] + 1e-12) {
        nonMonotone++;
        if (bad.length < 3) bad.push({ variant: c.v, y: c.y, i, prev: peaks[i - 1], next: peaks[i] });
        break;
      }
    }
    if (peaks.length < 2) tooFewPeaks++;
    if (Math.abs(dropPoseAt(p.durationMs, p).tiltRad) !== 0) neverZero++;
  }
  ok(nonMonotone === 0, 'the wobble envelope grew at some point', { nonMonotone, bad });
  ok(neverZero === 0, 'the wobble did not reach exactly zero', { neverZero });
  ok(tooFewPeaks === 0, 'a drop produced fewer than two rocks — that is not a wobble', { tooFewPeaks });
  console.log(`  every drop's successive |tilt| peaks are non-increasing, and end at exactly 0`);

  // the frequency really does rise — that is the Euler's-disk character
  const p = dropParams({ fromY: LIFT.maxY, face: 'Heads', seed: 'freq', variant: 'chatter' });
  const zeros = [];
  let prevT = null;
  for (let t = p.fallMs; t <= p.durationMs; t += 0.05) {
    const a = dropPoseAt(t, p).tiltRad;
    if (prevT != null && Math.sign(a) !== Math.sign(prevT) && prevT !== 0) zeros.push(t);
    prevT = a;
  }
  const gaps = zeros.slice(1).map((z, i) => z - zeros[i]);
  const firstGap = gaps[0], lastGap = gaps[gaps.length - 1];
  ok(gaps.length >= 3 && lastGap < firstGap, 'the wobble frequency does not rise', { firstGap, lastGap });
  console.log(`  chatter: half-rock takes ${f1(firstGap)} ms at first, ${f1(lastGap)} ms at the end `
    + `(x${f1(firstGap / lastGap)} faster) — it speeds up as it flattens`);
}

// ===========================================================================
console.log('\n=== (8) the variants are actually distinct ===');
{
  // "Five variants" is a claim. Measured here with everything else held equal —
  // same height, same face, same tip direction — so the only difference left is
  // the variant itself.
  const at = LIFT.maxY;
  const built = DROP_VARIANTS.map((v) => {
    const p = dropParams({ fromY: at, face: 'Heads', seed: 'distinct', variant: v.name });
    p.azimuthRad = 0;                          // hold the tip direction equal
    return { name: v.name, p };
  });
  const rows = built.map((b) => ({
    variant: b.name,
    tiltDeg: f1(b.p.tiltDeg),
    fallMs: f1(b.p.fallMs),
    settleMs: f1(b.p.settleMs),
    totalMs: f1(b.p.durationMs),
    bounces: b.p.arcs.length,
  }));
  console.table(rows);

  const pairs = [];
  let tooSimilar = 0;
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      const a = built[i], b = built[j];
      const span = Math.max(a.p.durationMs, b.p.durationMs);
      let maxTiltDiff = 0, maxYDiff = 0;
      for (let t = 0; t <= span; t += 0.5) {
        const pa = dropPoseAt(t, a.p), pb = dropPoseAt(t, b.p);
        maxTiltDiff = Math.max(maxTiltDiff, Math.abs(pa.tiltRad - pb.tiltRad) * DEG);
        maxYDiff = Math.max(maxYDiff, Math.abs(pa.pos[1] - pb.pos[1]));
      }
      const durDiff = Math.abs(a.p.durationMs - b.p.durationMs);
      // Distinct means one of: a visibly different tilt at some moment (2 deg is
      // about 7 px of rim movement at this framing), a different height at some
      // moment (1 mm is a twentieth of the coin's diameter), or a noticeably
      // different length (80 ms is ~5 frames).
      const distinct = maxTiltDiff > 2 || maxYDiff > 0.001 || durDiff > 80;
      if (!distinct) tooSimilar++;
      pairs.push({
        pair: `${a.name} / ${b.name}`,
        maxTiltDiffDeg: f1(maxTiltDiff),
        maxYDiffMm: f3(maxYDiff * 1000),
        durDiffMs: f1(durDiff),
        distinct,
      });
    }
  }
  console.table(pairs);
  ok(tooSimilar === 0, 'two variants are not visibly different', { tooSimilar });
  console.log(`  all ${pairs.length} pairs differ by >2 deg of tilt, >1 mm of height, or >80 ms of length`);
}

// ===========================================================================
console.log('\n=== (9) determinism and variant spread ===');
{
  // Same seed, byte-identical track.
  const a = dropParams({ fromY: 0.02, face: 'Heads', seed: 'repeat-me' });
  const b = dropParams({ fromY: 0.02, face: 'Heads', seed: 'repeat-me' });
  let drift = 0;
  for (let t = 0; t <= a.durationMs; t += 0.5) {
    const pa = dropPoseAt(t, a), pb = dropPoseAt(t, b);
    drift = Math.max(drift, Math.abs(pa.pos[1] - pb.pos[1]),
      ...pa.quat.map((q, i) => Math.abs(q - pb.quat[i])));
  }
  ok(drift === 0, 'the same seed produced a different track', { drift });
  ok(a.variant === b.variant && a.azimuthRad === b.azimuthRad, 'the same seed chose differently');
  console.log(`  the same seed replays bit-identically (max drift ${drift})`);

  // Different seeds spread over the variants.
  const counts = Object.fromEntries(DROP_VARIANTS.map((v) => [v.name, 0]));
  const N = 6000;
  const azimuths = [];
  for (let i = 0; i < N; i++) {
    const p = dropParams({ fromY: 0.02, face: 'Heads', seed: 'spread::' + i });
    counts[p.variant]++;
    azimuths.push(p.azimuthRad);
  }
  const expect = N / DROP_VARIANTS.length;
  const chi = Object.values(counts).reduce((s, n) => s + (n - expect) ** 2 / expect, 0);
  console.table([counts]);
  // df = 4, 99.9th percentile is 18.47. A fair picker clears this essentially
  // always; a stuck or biased one does not.
  ok(chi < 18.47, 'the variant picker is biased', { chi, counts });
  ok(Object.values(counts).every((n) => n > 0), 'a variant is unreachable', { counts });
  console.log(`  ${N} seeds over ${DROP_VARIANTS.length} variants: chi-square ${f1(chi)} (df=4, want < 18.47)`);
  // and the tip direction really does cover the circle
  const quads = [0, 0, 0, 0];
  azimuths.forEach((r) => { quads[Math.floor(r / (Math.PI / 2)) % 4]++; });
  ok(quads.every((q) => q > N * 0.2), 'the coin tips into only part of the circle', { quads });
  console.log(`  tip direction covers the circle: ${JSON.stringify(quads)}`);
}

// ===========================================================================
console.log('\n=== (10) degenerate input ===');
{
  const cases = [
    ['NaN height', NaN], ['+Infinity height', Infinity], ['-Infinity height', -Infinity],
    ['negative height', -0.5], ['zero height', 0], ['at rest height', REST_Y],
    ['above the ceiling', 10], ['undefined', undefined],
  ];
  const rows = [];
  for (const [label, y] of cases) {
    const p = dropParams({ fromY: y, face: 'Heads', seed: 'degenerate' });
    let finite = true;
    for (let t = -50; t <= p.durationMs + 50; t += 1) {
      const pose = dropPoseAt(t, p);
      if (!pose.pos.every(Number.isFinite) || !pose.quat.every(Number.isFinite)) { finite = false; break; }
    }
    const end = dropPoseAt(p.durationMs, p);
    rows.push({
      case: label, y0mm: f3(p.y0 * 1000), tiltDeg: f1(p.tiltDeg), durationMs: f1(p.durationMs),
      allFinite: finite, endsAtRest: end.pos[1] === REST_Y,
    });
    ok(finite, 'a degenerate height produced a non-finite pose', { label });
    ok(p.y0 >= REST_Y && p.y0 <= LIFT.maxY, 'a degenerate height escaped the lift range', { label, y0: p.y0 });
    ok(end.pos[1] === REST_Y, 'a degenerate drop did not end at rest', { label });
  }
  console.table(rows);

  // NaN time must not produce NaN pose
  const p = dropParams({ fromY: 0.02, face: 'Heads', seed: 'nan-t' });
  const nanPose = dropPoseAt(NaN, p);
  ok(nanPose.pos.every(Number.isFinite) && nanPose.quat.every(Number.isFinite),
    'a NaN timestamp produced a NaN pose', { nanPose });
  console.log('  a NaN timestamp falls back to the release pose rather than poisoning the coin');
}

// ===========================================================================
console.log('\n=== (11) how long a drop takes ===');
{
  const rows = [];
  for (const v of DROP_VARIANTS) {
    const ds = HEIGHTS.map((y) => dropParams({ fromY: y, face: 'Heads', seed: 'dur', variant: v.name }).durationMs);
    rows.push({ variant: v.name, minMs: f1(Math.min(...ds)), medianMs: f1(pct(ds, 0.5)), maxMs: f1(Math.max(...ds)) });
  }
  console.table(rows);
  const all = ALL.map((c) => c.p.durationMs);
  const worst = Math.max(...all);
  // A drop is a nothing-happened event: the player let go without throwing. It
  // must not cost more than about a second of their attention, or the recovery
  // from a fumble becomes more expensive than the fumble.
  ok(worst <= 1200, 'a drop takes too long for an action that did nothing', { worstMs: f1(worst) });
  console.log(`  every drop: ${f1(Math.min(...all))} .. ${f1(worst)} ms, median ${f1(pct(all, 0.5))} (ceiling 1200)`);
  console.log(`  the fall is at most ${f1(Math.max(...ALL.map((c) => c.p.fallMs)))} ms of that — the rest is the wobble`);
}

// ===========================================================================
console.log('\n=== (12) the drop cannot reach the outcome ===');
{
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../flip3d/drop.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const banned = ['outcome.js', 'resolveFlip', 'SPIN_VALUES', 'library.js', 'expectedSide', 'assertOutcome'];
  const hits = banned.filter((b) => code.includes(b));
  ok(hits.length === 0, 'drop.js references the outcome path', { hits });
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  console.log(`  imports ${JSON.stringify(imports)}; names none of ${JSON.stringify(banned)} in code`);
  console.log('  a drop has no outcome, spends no flip, and cannot change the declared start face');
}


// ===========================================================================
console.log('\n=== (13) playDrop against a stub scene ===');
{
  // The pure core is hammered above; this is the part the host actually calls,
  // and none of the above would notice if it never resolved, leaked its frame
  // subscription, or left the coin mid-wobble. A stub scene with a clock this
  // file drives means no rAF and no GPU are involved.
  function stubScene(startY) {
    const cbs = new Set();
    const poses = [];
    return {
      poses,
      key: { shadow: { radius: SHADOW_RADIUS.lifted } },
      coinRoot: { position: { y: startY } },
      heldY: startY,
      setCoinPose(pos, quat) { poses.push({ pos: pos.slice(), quat: quat.slice() }); },
      onFrame(cb) { cbs.add(cb); return () => cbs.delete(cb); },
      get subscribers() { return cbs.size; },
      run(totalMs, hz) {
        const dt = 1000 / hz;
        for (let t = 0; t <= totalMs && cbs.size; t += dt) {
          for (const cb of [...cbs]) cb(t);
        }
      },
    };
  }

  const rows = [];
  for (const v of DROP_VARIANTS) {
    const sc = stubScene(LIFT.maxY);
    let done = null;
    playDrop(sc, { fromY: LIFT.maxY, face: 'Tails', seed: 'play::' + v.name, variant: v.name })
      .then((r) => { done = r; });
    sc.run(2000, 60);
    // The promise resolves on a microtask; drain it.
    await Promise.resolve(); await Promise.resolve();

    const last = sc.poses[sc.poses.length - 1];
    const restQ = restQuatForFace('Tails');
    rows.push({
      variant: v.name,
      resolved: !!done,
      poses: sc.poses.length,
      subsLeft: sc.subscribers,
      endsAtRestY: last.pos[1] === REST_Y,
      endQuatExact: last.quat.every((q, i) => q === restQ[i]),
      shadowRadius: sc.key.shadow.radius,
    });
    ok(done, 'playDrop never resolved', { variant: v.name });
    ok(sc.subscribers === 0, 'playDrop leaked its frame subscription', { variant: v.name });
    ok(last.pos[1] === REST_Y, 'playDrop left the coin off the table', { variant: v.name, y: last.pos[1] });
    ok(last.quat.every((q, i) => q === restQ[i]), 'playDrop left the coin rotated', { variant: v.name });
    ok(sc.key.shadow.radius === SHADOW_RADIUS.rest, 'playDrop left the held shadow behind', { variant: v.name });
    ok(sc.poses.length > 5, 'playDrop wrote almost no poses', { variant: v.name, n: sc.poses.length });
  }
  console.table(rows);
  console.log('  every variant resolves, unsubscribes, and lands the coin on the exact rest pose');
  console.log(`  the held shadow (radius ${SHADOW_RADIUS.lifted}) is eased back to ${SHADOW_RADIUS.rest} across the fall`);

  // an inert drop must not hang the caller
  const sc = stubScene(REST_Y);
  let inertDone = false;
  playDrop(sc, { fromY: REST_Y, face: 'Heads', seed: 'inert' }).then(() => { inertDone = true; });
  sc.run(100, 60);
  await Promise.resolve(); await Promise.resolve();
  ok(inertDone, 'a drop with nothing to do never resolved');
  ok(sc.subscribers === 0, 'the inert drop leaked its subscription');
  console.log('  a coin released at rest resolves immediately instead of hanging the caller');
}

// ===========================================================================
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
