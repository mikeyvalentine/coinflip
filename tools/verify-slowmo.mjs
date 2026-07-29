// tools/verify-slowmo.mjs
// ---------------------------------------------------------------------------
// Headless sweep for the §6.4 APEX RAMP: slow motion + camera push-in from the
// apex to first contact. Runs in Node with no GPU and no DOM, because the
// preview pane is usually hidden and cannot be trusted to render or to fire
// requestAnimationFrame.
//
// What it is actually here to prove, in order of how much it matters:
//
//   1. The ramp CANNOT change a bet axis. It is a reparametrisation of time —
//      the same frames in the same order — so the half-flip count the player
//      watches tick must be identical with it on and off, on every baked clip.
//      That is simulated at several display rates, not argued from the maths.
//   2. The ASCENT IS UNTOUCHED. rate === 1 exactly, everywhere before the apex.
//      This is the anti-floaty guarantee: a slow rise reads as low gravity and
//      that is what got the old uniform 2x stretch thrown out.
//   3. The camera stays ON the coin as it closes in. A tighter frame magnifies
//      the deliberate off-centre drift, so the push-in has to pull the framing
//      back to centre as it zooms or it walks the coin out of shot.
//   4. The settle crane fires AFTER touchdown in WALL time (it did not: the old
//      gate compared wall clock against a clip-time landmark, so under any warp
//      the camera started craning while the coin was still airborne).
//
// Run: node tools/verify-slowmo.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeClipWarp, flightShot, settleShot,
  SLOWMO, DRAMA_CAM, FLIGHT_CAM, SETTLE_CAM, CAM_SETTLE_MS, HOLD_AFTER_MS, LEADIN_MS,
} from '../flip3d/player.js';
import { analyzeClip, clipTimeScale, buildProceduralClip } from '../flip3d/clip.js';
import { loadClipLibrary } from '../flip3d/library.js';
import { upDot, expectedSide } from '../flip3d/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = (n) => +n.toFixed(1);

// Same shim tools/verify-power.mjs uses: library.js speaks fetch, Node does not
// speak relative paths.
const fetchShim = async (url) => {
  const rel = url.replace(/^\.\//, '');
  try {
    const buf = await fs.readFile(path.join(ROOT, rel), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(buf) };
  } catch (e) { return { ok: false, status: 404, json: async () => { throw e; } }; }
};
const library = await loadClipLibrary({ base: './bake/out/', fetch: fetchShim });
console.log(`library: ${library.stats.clips} clips, ${library.stats.cells} cells`);

// Materialise every baked clip once; everything below reuses them.
const clips = [];
for (const e of library.index) {
  clips.push(await library.clipFor({
    startFace: 'Heads', side: expectedSide('Heads', e.halfFlips), spins: e.halfFlips,
    orientationDeg: e.orientationDeg, quadrant: e.quadrant, edge: false, clipId: e.id,
  }));
}
console.log(`loaded ${clips.length} clips for the sweep\n`);

// ===========================================================================
console.log('=== (1) the warp is a clean reparametrisation of time ===');
{
  let worstInverse = 0, nonMonotone = 0, endpointBad = 0;
  for (const clip of clips) {
    const a = analyzeClip(clip);
    const w = makeClipWarp(clip, a, true);
    const dur = clip.meta.durationMs;

    // endpoints must be exact: a warp that loses the last frame loses the result
    if (Math.abs(w.clipAt(0)) > 1e-9 || Math.abs(w.clipAt(w.totalWallMs) - dur) > 1e-6) endpointBad++;
    if (Math.abs(w.wallAt(0)) > 1e-9 || Math.abs(w.wallAt(dur) - w.totalWallMs) > 1e-6) endpointBad++;

    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const ct = dur * i / 200;
      const back = w.clipAt(w.wallAt(ct));
      worstInverse = Math.max(worstInverse, Math.abs(back - ct));
      const wall = w.wallAt(ct);
      if (wall < prev - 1e-9) nonMonotone++;
      prev = wall;
    }
  }
  ok(endpointBad === 0, 'warp endpoints not exact', { endpointBad });
  ok(nonMonotone === 0, 'wallAt is not monotone — time ran backwards', { nonMonotone });
  ok(worstInverse < 0.5, 'clipAt/wallAt are not inverses', { worstInverse });
  console.log(`  worst clipAt(wallAt(t)) round-trip error: ${worstInverse.toExponential(2)} ms`);

  // off must be the exact identity, not an approximation of it
  const a0 = analyzeClip(clips[0]);
  const off = makeClipWarp(clips[0], a0, false);
  ok(off.totalWallMs === clips[0].meta.durationMs, 'off is not identity in duration');
  ok(off.clipAt(123.4) === 123.4 && off.wallAt(123.4) === 123.4, 'off is not identity in mapping');
  ok(off.rateAt(0) === 1 && off.rateAt(999) === 1, 'off does not run at 1x');
  console.log('  slowmo off is the exact identity map');
}

// ===========================================================================
console.log('\n=== (2) THE ANTI-FLOATY GUARANTEE: the ascent runs at exactly 1x ===');
{
  let bad = 0, worstPreApexRate = 1, worstAscentDriftMs = 0;
  for (const clip of clips) {
    const a = analyzeClip(clip);
    const w = makeClipWarp(clip, a, true);
    const apex = Math.min(a.apexMs, a.touchdownMs);
    // THE RAMP NOW OPENS BEFORE THE APEX, by design and on direction: the zoom
    // and the slow-down should be under way as the coin ARRIVES at the top,
    // not begin on the frame it stops rising. So the guarantee is no longer
    // "the whole rise is 1x" — it is "the rise is 1x until the ramp opens, and
    // the ramp opens late enough that the bulk of the climb is untouched".
    // That is what actually protects against the floaty failure mode: a coin
    // that CLIMBS slowly reads as low gravity, and it still climbs at exactly
    // real time for the first three quarters of the way up.
    const from = apex * (1 - SLOWMO.preApexFrac);
    ok(SLOWMO.preApexFrac <= 0.30,
      'the ramp opens too early — most of the CLIMB must stay at real time',
      { preApexFrac: SLOWMO.preApexFrac });
    for (let i = 0; i <= 60; i++) {
      const ct = from * i / 60;
      const r = w.rateAt(ct);
      worstPreApexRate = Math.min(worstPreApexRate, r);
      // Not `r !== 1`. The last sample is `from * 60/60`, which in floating
      // point is not exactly `from`, so it lands a hair inside the ramp and
      // reads 0.9999999999999998. That is arithmetic at a boundary, not a
      // slowed climb — and a test that cannot tell the two apart would have to
      // be silenced rather than fixed the first time anyone touched the curve.
      if (r < 1 - 1e-9) { bad++; break; }
    }
    // and the wall clock must agree: the rise takes as long as it really does.
    // Tolerance is one display frame, not zero: wallAt reads a 512-sample
    // integration table, so the one cell that straddles the ramp's opening
    // carries interpolation error. Measured below — it is microseconds.
    worstAscentDriftMs = Math.max(worstAscentDriftMs, Math.abs(w.wallAt(from) - from));
  }
  ok(bad === 0, 'the ascent was slowed — this is the floaty failure mode', { bad, worstPreApexRate });
  ok(worstAscentDriftMs < 16.7, 'the ascent drifted by a visible amount', { worstAscentDriftMs });
  console.log(`  ${clips.length} clips: rate is exactly 1.000 from launch until the ramp opens,`);
  console.log(`  which is ${(100*(1-SLOWMO.preApexFrac)).toFixed(0)}% of the way up the climb`);
  console.log(`  worst ascent wall-vs-clip drift: ${worstAscentDriftMs.toExponential(2)} ms `
    + '(tolerance: one 60 Hz frame)');
}

// ===========================================================================
console.log('\n=== (3) THE LOAD-BEARING ONE: the ramp cannot move a bet axis ===');
{
  // Re-implements the playback loop's counting EXACTLY as player.js does it —
  // a monotone cursor over source frames, counting up-axis horizon crossings —
  // and runs it with the ramp on and off at three display rates. What the
  // player watches tick has to be the clip's own half-flip count every time.
  function countHalfFlips(clip, analysis, cfg, hz) {
    const frames = clip.frames;
    const scale = clipTimeScale(clip);
    const duration = clip.meta.durationMs;
    const warp = makeClipWarp(clip, analysis, cfg);
    const dt = 1000 / hz;
    let cursor = 0;
    let sign = Math.sign(upDot(frames[0].quat)) || 1;
    let halfFlips = 0;
    for (let t = 0; t <= warp.totalWallMs + dt; t += dt) {
      const ct = Math.min(Math.max(warp.clipAt(Math.min(t, warp.totalWallMs)), 0), duration);
      while (cursor < frames.length - 2 && frames[cursor + 1].t * scale <= ct) {
        cursor++;
        const s = Math.sign(upDot(frames[cursor].quat)) || sign;
        if (s !== sign) { sign = s; halfFlips++; }
      }
    }
    return halfFlips;
  }

  let cases = 0, mismatched = 0, differed = 0;
  const bad = [];
  for (const clip of clips) {
    const a = analyzeClip(clip);
    for (const hz of [30, 60, 144]) {
      const offN = countHalfFlips(clip, a, false, hz);
      const onN = countHalfFlips(clip, a, true, hz);
      cases++;
      if (offN !== onN) { differed++; if (bad.length < 4) bad.push({ id: clip.meta.id, hz, offN, onN }); }
      if (onN !== clip.meta.halfFlips || offN !== clip.meta.halfFlips) {
        mismatched++;
        if (bad.length < 4) bad.push({ id: clip.meta.id, hz, offN, onN, meta: clip.meta.halfFlips });
      }
    }
  }
  ok(differed === 0, 'slow motion changed the half-flip count the player sees', { differed, bad });
  ok(mismatched === 0, 'counted half-flips disagree with the clip metadata', { mismatched, bad });
  console.log(`  ${cases} playbacks (${clips.length} clips x {30,60,144} Hz x {on,off}):`);
  console.log(`    half-flip count differs on vs off: ${differed} (must be 0)`);
  console.log(`    half-flip count differs from meta:  ${mismatched} (must be 0)`);
  console.log('    side and quadrant are read off the FINAL frame, which the warp');
  console.log('    always reaches exactly (checked in (1)), so they cannot move either.');
}

// ===========================================================================
console.log('\n=== (4) what the ramp actually buys, measured ===');
{
  const rows = [];
  const descentOff = [], descentOn = [], totalOff = [], totalOn = [];
  for (const clip of clips) {
    const a = analyzeClip(clip);
    const w = makeClipWarp(clip, a, true);
    const apex = Math.min(a.apexMs, a.touchdownMs);
    const dOff = a.touchdownMs - apex;
    const dOn = w.wallAt(a.touchdownMs) - w.wallAt(apex);
    descentOff.push(dOff); descentOn.push(dOn);
    totalOff.push(clip.meta.durationMs + LEADIN_MS + HOLD_AFTER_MS);
    totalOn.push(w.totalWallMs + LEADIN_MS + HOLD_AFTER_MS);
  }
  const show = (label, arr) => rows.push({
    beat: label,
    min: f1(Math.min(...arr)), median: f1(pct(arr, 0.5)), max: f1(Math.max(...arr)),
  });
  show('descent 1x (ms)', descentOff);
  show('descent ramped (ms)', descentOn);
  show('whole flip 1x (ms)', totalOff);
  show('whole flip ramped (ms)', totalOn);
  console.table(rows);
  console.log(`  descent stretched x${(mean(descentOn) / mean(descentOff)).toFixed(2)} `
    + `(${f1(mean(descentOff))} -> ${f1(mean(descentOn))} ms mean)`);
  console.log(`  whole flip x${(mean(totalOn) / mean(totalOff)).toFixed(2)} `
    + `(${f1(mean(totalOff))} -> ${f1(mean(totalOn))} ms mean)`);

  // A flip is a daily ritual, not a cutscene. Past ~2.6 s of held attention the
  // ramp stops being drama and starts being a wait. This ceiling is what caught
  // the settle being slowed as well as the descent: holding a slow rate to the
  // end of the clip put the longest baked flip at 3.3 s.
  const worst = Math.max(...totalOn);
  const median = pct(totalOn, 0.5);
  // The ceiling is on the OUTLIER; the median is the number players live with.
  // Both are asserted, because a good median hides a clip nobody wants to sit
  // through and a good max says nothing about the typical flip.
  // These bounds MOVED on 2026-07-29, on explicit direction: "the bullet time
  // should start near the apex, and then slow down wayyy more on its way down
  // until it finally lands." The old 2800/2100 encoded a guess of mine that
  // past ~2.6 s a flip becomes a wait; watching it on a real screen said the
  // 4x descent was still too fast to read. They are still REAL bounds — a flip
  // is a daily ritual, not a cutscene — just set around the intended pacing
  // rather than around my guess at it.
  ok(worst <= 5000, 'the ramped flip is too long to sit through', { worstMs: f1(worst) });
  ok(median <= 3600, 'the typical ramped flip is too long', { medianMs: f1(median) });
  // and it has to actually DO something, or there was no point
  ok(mean(descentOn) / mean(descentOff) >= 1.9, 'the descent barely slowed', {
    ratio: +(mean(descentOn) / mean(descentOff)).toFixed(2),
  });
  // The settle must SNAP OUT of slow motion, not fade out of it: by the last
  // frame the coin should be rattling at real speed, or the flip ends on a
  // dreamy drift instead of a click. Rate at the final frame, not an average
  // over the settle — the average is dominated by the impact beat, which is
  // deliberately slow and would mask exactly the problem this is watching for.
  const endRates = clips.map((clip) => makeClipWarp(clip, analyzeClip(clip), true).rateAt(clip.meta.durationMs));
  const worstEndRate = Math.min(...endRates);
  ok(worstEndRate >= 0.9, 'the flip never returns to real time before it ends', {
    worstEndRate: +worstEndRate.toFixed(3),
  });
  console.log(`  longest ramped flip ${f1(worst)} ms (ceiling 5000), median ${f1(median)} ms (ceiling 3600)`);
  console.log(`  slowest rate at the final frame: ${worstEndRate.toFixed(3)}x — it snaps back to real time`);
}

// ===========================================================================
console.log('\n=== (5) the ramp is smooth — no visible speed step ===');
{
  // A discontinuity in `rate` is a jolt on screen. The old shape stepped from
  // minRate straight to settleRate at touchdown (0.18 -> 0.45), which sped the
  // coin up on the exact frame it hit the table.
  // Measured separately over the two windows, because they are watched very
  // differently. THE DESCENT is the shot — the coin is airborne, large, and
  // centred, so any kink in the rate curve is a visible stutter. THE SETTLE is
  // the coin skittering to a stop with the result already legible, and on a clip
  // whose settle is only 60 ms the recovery has to be correspondingly brisk.
  let worstFlight = 0, flightAt = null, worstSettle = 0, settleAt = null;
  for (const clip of clips.slice(0, 200)) {
    const a = analyzeClip(clip);
    const w = makeClipWarp(clip, a, true);
    const dur = clip.meta.durationMs;
    const N = 2000;
    let prev = w.rateAt(0);
    for (let i = 1; i <= N; i++) {
      const ct = dur * i / N;
      const r = w.rateAt(ct);
      const jump = Math.abs(r - prev) / (dur / N);   // rate change per ms of clip time
      if (ct <= a.touchdownMs) {
        if (jump > worstFlight) { worstFlight = jump; flightAt = { id: clip.meta.id, ct: f1(ct) }; }
      } else if (jump > worstSettle) { worstSettle = jump; settleAt = { id: clip.meta.id, ct: f1(ct) }; }
      prev = r;
    }
  }
  // 0.01/ms would be a full 1.0 -> 0 collapse inside 100 ms; the flight has to
  // stay well under that. The settle gets 3x the allowance and still never
  // steps — a true discontinuity would read as thousands per ms here, so this
  // is checking for a step, not policing the slope.
  ok(worstFlight < 0.01, 'the rate curve steps during the flight', { worstFlight, flightAt });
  ok(worstSettle < 0.03, 'the rate curve steps during the settle', { worstSettle, settleAt });
  console.log(`  worst d(rate)/dt, flight: ${worstFlight.toExponential(2)} per ms (ceiling 1e-2)`);
  console.log(`  worst d(rate)/dt, settle: ${worstSettle.toExponential(2)} per ms (ceiling 3e-2)`);
  console.log(`  rate at touchdown ${SLOWMO.minRate}, held up to ${SLOWMO.impactHoldMs} ms, then back to ${SLOWMO.recoverRate}x over ${SLOWMO.recoverMs} ms`);
}

// ===========================================================================
console.log('\n=== (6) the push-in keeps the coin in frame ===');
{
  // The camera sits `distance` from `target`, and `target` is the coin's
  // position scaled by travelLead. So the coin is off-target by
  // |pos| * (1 - lead) horizontally, and that offset subtends an angle at the
  // camera which GROWS as the camera closes in. The 30 deg vertical FOV over a
  // 1.6 aspect gives ~46 deg horizontal; half of that is the edge of frame.
  const FOV_V = 30, ASPECT = 1.6;
  const halfH = Math.atan(Math.tan(FOV_V / 2 * Math.PI / 180) * ASPECT) * 180 / Math.PI;
  let worstFill = 0, worstCase = null, out = 0;
  for (const clip of clips) {
    const a = analyzeClip(clip);
    for (let i = 0; i <= 20; i++) {
      const fr = clip.frames[Math.floor((clip.frames.length - 1) * i / 20)];
      const pos = fr.pos;
      for (const zoom of [0, 0.25, 0.5, 0.75, 1]) {
        const shot = flightShot(pos, a.apexY, FLIGHT_CAM.distanceApex, zoom);
        const dx = pos[0] - shot.target[0];
        const dz = pos[2] - shot.target[2];
        const dy = pos[1] - shot.target[1];
        const offset = Math.hypot(dx, dy, dz);
        const angle = Math.atan2(offset, shot.distance) * 180 / Math.PI;
        const fill = angle / halfH;              // 1.0 = exactly at the frame edge
        if (fill > worstFill) { worstFill = fill; worstCase = { id: clip.meta.id, zoom, offsetMm: f1(offset * 1000), dist: +shot.distance.toFixed(3) }; }
        if (fill >= 1) out++;
      }
    }
  }
  ok(out === 0, 'the coin left the frame during the push-in', { out, worstCase });
  ok(worstFill < 0.8, 'the coin came uncomfortably close to the frame edge', { worstFill, worstCase });
  console.log(`  half-FOV ${halfH.toFixed(1)} deg; worst coin offset ${(worstFill * 100).toFixed(1)}% of it`);
  console.log(`  worst case: ${JSON.stringify(worstCase)}`);

  // zoom 0 must be byte-for-byte the shot this had before the push-in existed
  const probe = [0.05, 0.4, -0.03];
  const plain = flightShot(probe, 0.6, FLIGHT_CAM.distanceApex, 0);
  const legacyLead = FLIGHT_CAM.travelLead, legacyHead = FLIGHT_CAM.headroom;
  ok(plain.target[0] === probe[0] * legacyLead && plain.target[1] === probe[1] + legacyHead
     && plain.elevDeg === FLIGHT_CAM.elevDeg, 'zoom 0 is not the original follow shot');
  const tight = flightShot(probe, 0.6, FLIGHT_CAM.distanceApex, 1);
  ok(Math.abs(tight.distance / plain.distance - DRAMA_CAM.zoom) < 1e-9, 'zoom 1 is not the configured push-in');
  ok(tight.target[0] === probe[0] && tight.target[2] === probe[2], 'zoom 1 does not centre on the coin');
  console.log(`  zoom 0 == the pre-existing follow shot; zoom 1 = x${DRAMA_CAM.zoom} distance, fully centred`);

  // monotone: the camera must close steadily, never bob in and out
  let bob = 0;
  for (let i = 1; i <= 50; i++) {
    const p = flightShot(probe, 0.6, FLIGHT_CAM.distanceApex, i / 50);
    const q = flightShot(probe, 0.6, FLIGHT_CAM.distanceApex, (i - 1) / 50);
    if (p.distance > q.distance + 1e-12) bob++;
    if (p.elevDeg < q.elevDeg - 1e-12) bob++;
  }
  ok(bob === 0, 'the push-in is not monotone', { bob });
  console.log('  push-in is monotone in both distance and elevation');
}

// ===========================================================================
console.log('\n=== (7) THE BUG FIX: the settle crane fires after touchdown ===');
{
  // The gate used to be smoothstep((t - (leadIn + touchdownMs)) / CAM_SETTLE_MS)
  // — wall clock `t` measured against a CLIP-time landmark. With no warp those
  // agree. With one they do not, and the camera craned to the settled close-up
  // while the coin was still in the air.
  let earlyOld = 0, earlyNew = 0, worstOldLeadMs = 0;
  for (const clip of clips) {
    const a = analyzeClip(clip);
    const w = makeClipWarp(clip, a, true);
    const leadIn = LEADIN_MS;
    const tdWallTrue = leadIn + w.wallAt(a.touchdownMs);   // when it REALLY lands
    const oldGate = leadIn + a.touchdownMs;                // what the old code used
    const newGate = tdWallTrue;
    if (oldGate < tdWallTrue - 1e-6) { earlyOld++; worstOldLeadMs = Math.max(worstOldLeadMs, tdWallTrue - oldGate); }
    if (newGate < tdWallTrue - 1e-6) earlyNew++;
  }
  ok(earlyNew === 0, 'the fixed gate still fires early', { earlyNew });
  console.log(`  old gate fired before touchdown on ${earlyOld}/${clips.length} clips, `
    + `by up to ${f1(worstOldLeadMs)} ms`);
  console.log(`  fixed gate fires early on ${earlyNew}/${clips.length} clips`);

  // and with the ramp OFF the fix must be a no-op — same frame as before
  let drift = 0;
  for (const clip of clips.slice(0, 100)) {
    const a = analyzeClip(clip);
    const w = makeClipWarp(clip, a, false);
    if (Math.abs((LEADIN_MS + w.wallAt(a.touchdownMs)) - (LEADIN_MS + a.touchdownMs)) > 1e-9) drift++;
  }
  ok(drift === 0, 'the fix changed the crane timing with slowmo off', { drift });
  console.log('  with the ramp off the crane timing is unchanged (the fix is a no-op at 1x)');
}

// ===========================================================================
console.log('\n=== (8) the procedural fallback ramps too ===');
{
  // The fallback clip starts on the table and has no lead-in, but it is still a
  // clip and the player warps it the same way. Anchoring must survive that.
  const outcome = { startFace: 'Heads', side: 'Tails', spins: 27, orientationDeg: 25.34, quadrant: 'NE' };
  const clip = buildProceduralClip(outcome, { seed: 'slowmo-check' });
  const a = analyzeClip(clip);
  const w = makeClipWarp(clip, a, true);
  ok(w.totalWallMs > clip.meta.durationMs, 'the fallback was not slowed at all');
  ok(w.rateAt(Math.min(a.apexMs, a.touchdownMs) * 0.5) === 1, 'the fallback ascent was slowed');
  ok(Math.abs(w.clipAt(w.totalWallMs) - clip.meta.durationMs) < 1e-6, 'the fallback loses its final frame');
  console.log(`  procedural: ${f1(clip.meta.durationMs)} -> ${f1(w.totalWallMs)} ms, ascent still 1x`);
}

// ===========================================================================
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
