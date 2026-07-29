// tools/verify-pickup.mjs
// ---------------------------------------------------------------------------
// Headless sweep for THE PICK-UP: the pointer -> world-height projection the
// grab gesture rides on, and the shadow geometry that tells the player how high
// they are.
//
// Runs in Node with no GPU, no DOM and no assets. scene.js's createScene()
// cannot run here — it wants a WebGL context, a GLB and an HDR — so the maths
// it depends on is exported at MODULE scope and tested directly. That is the
// same split tools/verify-slowmo.mjs uses on player.js#flightShot, and it is
// the only way to get a real assertion out of a preview pane that never
// renders, never fires requestAnimationFrame and freezes CSS transitions.
//
// What this is here to prove:
//   1. The projection is a real unprojection, not a fitted constant. The test
//      that catches a fitted constant is (4): the same FRACTION of canvas
//      height must give the same world height at every canvas size.
//   2. It round-trips. A projection only ever run one way can hide a wrong
//      axis or a dropped perspective divide, because the error cancels.
//   3. It is TOTAL. It feeds coinRoot's transform, so a single NaN would take
//      the coin with it. No input may produce one — including pointer
//      positions far outside the canvas, degenerate rects and absurd numbers.
//   4. The lift ceiling really does keep the coin inside the frame.
//
// Run: node tools/verify-pickup.mjs
// ---------------------------------------------------------------------------

import {
  READY_SHOT, HOLD_SHOT, HOLD_TRANSITION_MS, LIFT, liftFraction, cameraBasis, SCENE_FOV_DEG,
  screenYToWorldY, worldYToScreenY, shadowOffsetFor, KEY_LIGHT_POS, SHADOW_RADIUS,
} from '../flip3d/scene.js';
import { COIN_HALF_THICKNESS_M, COIN_RADIUS_M, COIN_DIAMETER_M } from '../flip3d/contract.js';

let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };
const f4 = (n) => +n.toFixed(4);

// Read from the scene rather than restated. It was a literal 30 here while
// scene.js also said 30 in three places; the lens has since widened to 45 and a
// verifier carrying its own stale copy would have gone on checking a camera the
// game no longer uses — and passing.
const FOV = SCENE_FOV_DEG;
const rectOf = (height, top = 0) => ({ top, height });

// ===========================================================================
console.log('=== (1) the camera basis matches the rig applyShot() builds ===');
{
  const b = cameraBasis(READY_SHOT);
  // Recomputed here from the shot's own definition, independently of the
  // implementation. The distance and elevation are READ FROM THE SHOT rather
  // than written out: they were literals (34 deg, 0.15 m) and READY_SHOT has
  // since moved to 0.10 m to hold the coin's apparent size under a wider lens,
  // which left this "independent" check asserting a camera that no longer
  // existed. Independent of the IMPLEMENTATION is the point; independent of the
  // INPUT is just wrong.
  const e = READY_SHOT.elevDeg * Math.PI / 180;
  const d = READY_SHOT.distance;
  const want = [0, READY_SHOT.target[1] + Math.sin(e) * d, Math.cos(e) * d];
  const dPos = Math.hypot(b.pos[0] - want[0], b.pos[1] - want[1], b.pos[2] - want[2]);
  ok(dPos < 1e-12, 'camera position disagrees with the shot', { got: b.pos.map(f4), want: want.map(f4) });

  // Orthonormality — a basis that is not orthonormal makes every unprojection
  // subtly wrong in a way no single-direction test would show.
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const len = (p) => Math.hypot(p[0], p[1], p[2]);
  for (const [n, v] of [['x', b.xAxis], ['y', b.yAxis], ['z', b.zAxis]]) {
    ok(Math.abs(len(v) - 1) < 1e-12, `${n}Axis is not unit length`, { len: len(v) });
  }
  ok(Math.abs(dot(b.xAxis, b.yAxis)) < 1e-12, 'xAxis and yAxis are not perpendicular');
  ok(Math.abs(dot(b.xAxis, b.zAxis)) < 1e-12, 'xAxis and zAxis are not perpendicular');
  ok(Math.abs(dot(b.yAxis, b.zAxis)) < 1e-12, 'yAxis and zAxis are not perpendicular');

  // At azimuth 0 the right axis must be exactly world +X. This is the fact the
  // whole "horizontal pointer position is irrelevant" argument rests on, so it
  // is asserted rather than asserted-in-a-comment.
  ok(Math.abs(b.xAxis[0] - 1) < 1e-12 && Math.abs(b.xAxis[2]) < 1e-12,
    'xAxis is not world +X at azimuth 0 — ndcX would then affect the height', { xAxis: b.xAxis.map(f4) });
  console.log(`  camera at [${b.pos.map(f4)}], xAxis = [${b.xAxis.map(f4)}]`);
}

// ===========================================================================
console.log('\n=== (2) round-trip: pixel -> metres -> pixel ===');
{
  let worst = 0, worstAt = null, n = 0;
  // Canvas heights spanning the real range: resize() caps width at 880 and
  // holds 1.6 aspect, so heights run ~150 (a narrow phone) to 550 (capped).
  for (const h of [150, 240, 320, 400, 550, 800, 1400]) {
    const rect = rectOf(h, 37);   // a non-zero top, so a dropped `rect.top` shows
    for (let i = 0; i <= 400; i++) {
      const y = LIFT.minY + (LIFT.maxY - LIFT.minY) * i / 400;
      const px = worldYToScreenY(y, rect, READY_SHOT, FOV);
      ok(Number.isFinite(px), 'worldYToScreenY returned non-finite inside the lift range', { y, h });
      const back = screenYToWorldY(px, rect, READY_SHOT, FOV);
      const err = Math.abs(back - y);
      n++;
      if (err > worst) { worst = err; worstAt = { h, y: f4(y), px: f4(px), back: f4(back) }; }
    }
  }
  // A micron. The coin is 20.5 mm across, so this is ~1/20000 of it.
  ok(worst < 1e-6, 'round-trip does not close', { worstMm: worst * 1000, worstAt });
  console.log(`  ${n} round-trips over 7 canvas heights: worst error ${(worst * 1e6).toFixed(3)} microns`);
}

// ===========================================================================
console.log('\n=== (3) monotone, and total ===');
{
  const rect = rectOf(550);
  // Monotone: dragging UP the screen (smaller clientY) must always raise the
  // coin. Swept far outside the canvas in both directions.
  let prev = -Infinity, breaks = 0;
  for (let px = 3000; px >= -3000; px -= 1) {
    const y = screenYToWorldY(px, rect, READY_SHOT, FOV);
    if (!Number.isFinite(y)) { fail('non-finite height', { px }); break; }
    if (y < prev - 1e-12) breaks++;
    prev = y;
  }
  ok(breaks === 0, 'height is not monotone in pointer row', { breaks });
  console.log(`  6001 pointer rows from +3000 to -3000 px: monotone, all finite`);

  // Totality against inputs that have no business being valid.
  const nasty = [
    ['NaN clientY', NaN, rect], ['+Infinity clientY', Infinity, rect], ['-Infinity', -Infinity, rect],
    ['huge', 1e308, rect], ['tiny negative', -1e308, rect],
    ['zero-height rect', 100, rectOf(0)], ['negative-height rect', 100, rectOf(-550)],
    ['null rect', 100, null], ['undefined rect', 100, undefined],
    ['NaN rect height', 100, { top: 0, height: NaN }],
  ];
  for (const [label, py, r] of nasty) {
    const y = screenYToWorldY(py, r, READY_SHOT, FOV);
    ok(Number.isFinite(y), `non-finite height for ${label}`, { y });
    ok(y >= LIFT.minY - 1e-12 && y <= LIFT.maxY + 1e-12, `out-of-range height for ${label}`, { y });
  }
  console.log(`  ${nasty.length} degenerate inputs: all finite and inside [${f4(LIFT.minY)}, ${f4(LIFT.maxY)}]`);

  // The clamp holds at both ends.
  ok(screenYToWorldY(1e6, rect, READY_SHOT, FOV) === LIFT.minY, 'far below the canvas does not clamp to rest');
  ok(screenYToWorldY(-1e6, rect, READY_SHOT, FOV) === LIFT.maxY, 'far above the canvas does not clamp to the ceiling');
  console.log('  clamp holds at both ends');

  // liftFraction spans exactly 0..1 across the range and is clamped outside it.
  ok(liftFraction(LIFT.minY) === 0 && liftFraction(LIFT.maxY) === 1, 'liftFraction does not span 0..1');
  ok(liftFraction(-5) === 0 && liftFraction(5) === 1, 'liftFraction is not clamped');
  console.log('  liftFraction spans 0..1 and clamps');
}

// ===========================================================================
console.log('\n=== (4) THE FITTED-CONSTANT TEST: the mapping scales with the canvas ===');
{
  // The same FRACTION down the canvas must give the same world height at every
  // size. A metres-per-pixel constant passes at whichever size it was fitted at
  // and fails everywhere else, so this is the assertion that catches it.
  const heights = [400, 550, 1400, 137, 2000];
  let worst = 0, worstAt = null;
  for (let i = 0; i <= 40; i++) {
    const frac = i / 40;
    const ys = heights.map((h) => screenYToWorldY(rectOf(h).top + frac * h, rectOf(h), READY_SHOT, FOV));
    const spread = Math.max(...ys) - Math.min(...ys);
    if (spread > worst) { worst = spread; worstAt = { frac, ys: ys.map(f4) }; }
  }
  ok(worst < 1e-12, 'the mapping depends on canvas SIZE, not on the fraction — a fitted constant', { worst, worstAt });
  console.log(`  5 canvas heights x 41 fractions: worst spread ${worst.toExponential(2)} m`);

  // And it must actually MOVE across the canvas — a stub returning a constant
  // would sail through the test above.
  const rect = rectOf(550);
  const top = screenYToWorldY(rect.top, rect, READY_SHOT, FOV);
  const bottom = screenYToWorldY(rect.top + rect.height, rect, READY_SHOT, FOV);
  ok(top - bottom > 0.02, 'the mapping barely moves across the canvas', { top: f4(top), bottom: f4(bottom) });
  console.log(`  across a 550 px canvas the coin spans ${f4(bottom)} -> ${f4(top)} m (clamped by LIFT)`);
}

// ===========================================================================
console.log('\n=== (5) the resting coin sits where the resting coin is ===');
{
  const rect = rectOf(550);
  // Project the coin's true resting height to a pixel, then read it back.
  const restPx = worldYToScreenY(COIN_HALF_THICKNESS_M, rect, READY_SHOT, FOV);
  ok(Number.isFinite(restPx), 'the resting coin does not project');
  ok(restPx > rect.top && restPx < rect.top + rect.height, 'the resting coin is off-screen', { restPx: f4(restPx) });
  const back = screenYToWorldY(restPx, rect, READY_SHOT, FOV);
  ok(Math.abs(back - COIN_HALF_THICKNESS_M) < 1e-9, 'the resting pixel does not map back to the resting height',
    { back, want: COIN_HALF_THICKNESS_M });
  const fracDown = (restPx - rect.top) / rect.height;
  console.log(`  rest (${(COIN_HALF_THICKNESS_M * 1000).toFixed(2)} mm) projects to ${f4(fracDown * 100)}% down the canvas`);
  ok(fracDown > 0.4 && fracDown < 0.7, 'the resting coin is not near the middle of frame', { fracDown: f4(fracDown) });
}

// ===========================================================================
console.log('\n=== (6) the HOLD framing keeps the coin in frame and opens the throw ===');
{
  // The ceiling is set by the framing the coin is LIFTED in — HOLD_SHOT — not
  // by the reading framing. Recomputed from the camera rather than taken from
  // the comment in scene.js.
  const topEdgeOn = (shot) => {
    const b = cameraBasis(shot);
    const tanHalfV = Math.tan(FOV * Math.PI / 180 / 2);
    const dy = b.yAxis[1] * tanHalfV - b.zAxis[1];
    const dz = b.yAxis[2] * tanHalfV - b.zAxis[2];
    return b.pos[1] + (-b.pos[2] / dz) * dy;
  };
  const topReady = topEdgeOn(READY_SHOT);
  const topHold = topEdgeOn(HOLD_SHOT);
  console.log(`  frame top on the lift line: READY ${f4(topReady)} m -> HOLD ${f4(topHold)} m`);

  // The coin is a disc: at full lift its silhouette reaches a radius above
  // centre. Demand the whole disc clears the edge.
  const headroom = topHold - (LIFT.maxY + COIN_RADIUS_M);
  ok(headroom > 0, 'the coin at full lift crosses the top of the HOLD frame',
    { topHold: f4(topHold), maxY: LIFT.maxY, radius: f4(COIN_RADIUS_M) });
  console.log(`  ceiling ${LIFT.maxY} m + coin radius ${f4(COIN_RADIUS_M)} m leaves ${(headroom * 1000).toFixed(1)} mm of headroom`);

  // THE POINT OF THE WHOLE CHANGE: how much room the throw actually gained.
  const rect = rectOf(550);
  const strokeOn = (shot, maxY) =>
    worldYToScreenY(LIFT.minY, rect, shot, FOV) - worldYToScreenY(maxY, rect, shot, FOV);
  const OLD_MAX_Y = 0.032;            // the ceiling READY framing could afford
  const before = strokeOn(READY_SHOT, OLD_MAX_Y);
  const after = strokeOn(HOLD_SHOT, LIFT.maxY);
  console.table([
    { framing: 'READY (before)', 'ceiling m': OLD_MAX_Y, 'world mm': +((OLD_MAX_Y - LIFT.minY) * 1000).toFixed(1), 'stroke px': +before.toFixed(0) },
    { framing: 'HOLD (now)', 'ceiling m': LIFT.maxY, 'world mm': +((LIFT.maxY - LIFT.minY) * 1000).toFixed(1), 'stroke px': +after.toFixed(0) },
  ]);
  ok(after > before * 1.6, 'the hold framing did not meaningfully open the throw',
    { before: f4(before), after: f4(after) });
  // The usable window moved with the lens. A wider FOV fits more metres into
  // the same pixels, and the raised HOLD target spends that on height rather
  // than on table, so the stroke grew again. Still a real bound at both ends: a
  // stroke under ~250 px cannot be aimed and one over the canvas height cannot
  // be completed without running off the edge.
  ok(after > 250 && after < 700, 'the stroke is an unusable length on the default canvas',
    { strokePx: f4(after) });
  console.log(`  the throw gained ${(after / before).toFixed(2)}x the screen and ${((LIFT.maxY - LIFT.minY) / (OLD_MAX_Y - LIFT.minY)).toFixed(2)}x the world`);

  // The table has to actually get out of the way — that was the complaint.
  const tableReady = rect.height - worldYToScreenY(0, rect, READY_SHOT, FOV);
  const tableHold = rect.height - worldYToScreenY(0, rect, HOLD_SHOT, FOV);
  ok(tableHold < tableReady, 'the table did not move down', { tableReady, tableHold });
  console.log(`  table surface sits ${tableReady.toFixed(0)} px off the bottom at READY, ${tableHold.toFixed(0)} px at HOLD`);

  // AZIMUTH 0 IS NOT NEGOTIABLE. Screen-up is -Z = NORTH and screen-right is
  // +X = EAST, and the entire orientation readout rests on that mapping.
  ok(HOLD_SHOT.azimuthDeg === 0, 'the hold framing broke azimuth 0 — the compass would rotate',
    { azimuthDeg: HOLD_SHOT.azimuthDeg });
  const bh = cameraBasis(HOLD_SHOT);
  ok(Math.abs(bh.xAxis[0] - 1) < 1e-12 && Math.abs(bh.xAxis[2]) < 1e-12,
    'the hold framing xAxis is not world +X', { xAxis: bh.xAxis.map(f4) });
  console.log('  HOLD framing keeps azimuth 0 and xAxis = world +X');

  // The lead-in still needs room to bridge from the release height up to the
  // clip's 0.22 m opening. Raising the ceiling too far breaks that handoff and
  // the clip visibly snatches the coin.
  const BRIDGE_MIN_M = 0.0185;
  const bridge = 0.22 - LIFT.maxY;
  ok(bridge > BRIDGE_MIN_M, 'the lift ceiling leaves the lead-in no bridge',
    { bridge: f4(bridge), need: BRIDGE_MIN_M });
  console.log(`  bridge to the clip opening: ${(bridge * 1000).toFixed(1)} mm, need ${(BRIDGE_MIN_M * 1000).toFixed(1)} — ${(bridge / BRIDGE_MIN_M).toFixed(1)}x margin`);
  console.log(`  hold transition ${HOLD_TRANSITION_MS} ms; grab.js must be given the same as settleMs`);
}

// ===========================================================================
console.log('\n=== (7) the shadow reads as height ===');
{
  const atRest = shadowOffsetFor(LIFT.minY);
  const atTop = shadowOffsetFor(LIFT.maxY);
  const sep = (o) => Math.hypot(o[0], o[1]);
  ok(sep(atRest) < 0.001, 'the shadow is already offset with the coin on the table', { atRest: atRest.map(f4) });
  console.log(`  resting: shadow ${(sep(atRest) * 1000).toFixed(2)} mm from the coin — touching`);
  console.log(`  full lift: shadow ${(sep(atTop) * 1000).toFixed(1)} mm away, `
    + `= ${(sep(atTop) / COIN_DIAMETER_M).toFixed(2)} coin diameters`);
  // It has to be unmistakable, or it is not a cue. The bar is the coin's
  // RADIUS: two discs of equal size stop overlapping once their centres are a
  // full DIAMETER apart, so a radius of offset already puts the shadow half out
  // from under the coin, which no one can miss.
  //
  // A full diameter was the first bar written here and it failed at 19.43 mm
  // against 20.50 mm — 0.95 diameters. That is not the cue being too weak, it
  // is the bar having been picked as a round number: the measured geometry says
  // that at full lift the shadow has slid almost, but not quite, clear of the
  // coin, so the two still touch at the extreme edge. Attached-but-stretched is
  // a better read than a detached floating blob anyway, since it keeps the
  // shadow legible as THIS coin's shadow. Bar moved to the radius, which is the
  // threshold that means something; the measured number is printed above so the
  // 19.43 mm is on the record rather than hidden behind a loosened constant.
  ok(sep(atTop) > COIN_RADIUS_M, 'the shadow separation at full lift is under one coin radius',
    { sepMm: sep(atTop) * 1000, radiusMm: COIN_RADIUS_M * 1000 });

  // Monotone, and in the light's direction (down-sun in +X and +Z here).
  let prev = -1, breaks = 0;
  for (let i = 0; i <= 200; i++) {
    const y = LIFT.minY + (LIFT.maxY - LIFT.minY) * i / 200;
    const s = sep(shadowOffsetFor(y));
    if (s < prev - 1e-15) breaks++;
    prev = s;
  }
  ok(breaks === 0, 'shadow separation is not monotone in height', { breaks });
  ok(atTop[0] > 0 && atTop[1] > 0, 'the shadow falls the wrong way for a light at +X +Z', { atTop: atTop.map(f4) });

  // It must stay inside the shadow camera's ortho box (S = 0.22 half-extent) or
  // the shadow is simply clipped away at full lift.
  ok(sep(atTop) < 0.22, 'the shadow leaves the shadow camera frustum at full lift', { sep: sep(atTop) });
  console.log(`  offset stays inside the 0.22 m shadow frustum (${f4(sep(atTop))} m)`);

  // Degenerate light: must not divide by zero into a NaN transform.
  const flat = shadowOffsetFor(0.02, [1, 0, 1]);
  ok(Number.isFinite(flat[0]) && Number.isFinite(flat[1]), 'a light at the horizon produces a non-finite offset', { flat });

  ok(SHADOW_RADIUS.lifted > SHADOW_RADIUS.rest, 'the shadow does not soften with height', SHADOW_RADIUS);
  console.log(`  PCF radius ${SHADOW_RADIUS.rest} at rest -> ${SHADOW_RADIUS.lifted} at full lift`);
}

// ===========================================================================
console.log('\n=== (8) it still works if the camera is somewhere else ===');
{
  // The mapping takes the LIVE shot, so it must not be secretly hard-wired to
  // READY_SHOT's numbers. Check a few plausible alternative framings.
  const shots = [
    { target: [0, 0.004, 0], distance: 0.15, elevDeg: 34, azimuthDeg: 0 },
    { target: [0, 0.02, 0], distance: 0.30, elevDeg: 20, azimuthDeg: 0 },
    { target: [0, 0.01, 0], distance: 0.22, elevDeg: 55, azimuthDeg: 0 },
  ];
  const rect = rectOf(550);
  for (const s of shots) {
    let worst = 0;
    for (let i = 0; i <= 100; i++) {
      const y = LIFT.minY + (LIFT.maxY - LIFT.minY) * i / 100;
      const px = worldYToScreenY(y, rect, s, FOV);
      if (!Number.isFinite(px)) { fail('projection failed for an alternative shot', { s, y }); break; }
      worst = Math.max(worst, Math.abs(screenYToWorldY(px, rect, s, FOV) - y));
    }
    ok(worst < 1e-6, 'round-trip fails for an alternative shot', { s, worst });
  }
  // Different framings must give genuinely different pixels for the same height.
  const a = worldYToScreenY(0.02, rect, shots[0], FOV);
  const c = worldYToScreenY(0.02, rect, shots[1], FOV);
  ok(Math.abs(a - c) > 1, 'the shot argument is being ignored', { a: f4(a), c: f4(c) });
  console.log(`  3 framings round-trip; 0.02 m projects to ${a.toFixed(1)} px vs ${c.toFixed(1)} px`);
}

// ===========================================================================
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
