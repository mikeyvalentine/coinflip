// tools/verify-orient-arrow.mjs
// ---------------------------------------------------------------------------
// Headless sweep for the ORIENTATION HELPER ARROW — the small yellow arrow that
// appears when the coin settles, pointing the way the design's 12 o'clock ended
// up, with the angle to two decimals.
//
// Runs in Node with no GPU and no DOM. The projection maths is exported at
// module scope so it can be hammered directly, and the view is exercised
// against a stub document — the same split tools/verify-pickup.mjs uses on
// scene.js, and the only way to get a real assertion out of a preview pane that
// never renders and freezes every CSS transition.
//
// What this is here to prove, in order of how much it matters:
//
//   1. THE FORESHORTENING IS REAL. The settle camera sits at elevDeg 66, not
//      top-down, so the table plane is slanted and an arrow rotated naively by
//      orientationDeg is wrong everywhere except the four cardinals. Section (2)
//      is written so that replacing the function with the IDENTITY fails it —
//      a test that passes against both implementations proves nothing.
//   2. It agrees with scene.js#cameraBasis, the shared camera source of truth,
//      everywhere cameraBasis is well defined. The closed form exists only
//      because cameraBasis goes singular at elevDeg 90; section (6) makes sure
//      that is the ONLY place the two differ.
//   3. The number shown never disagrees with the quadrant it is bucketed into,
//      and both come from contract.js#roundOrientation — the same call
//      player.js makes for report.played.landedOrientationDeg.
//
// Run: node tools/verify-orient-arrow.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  orientationToScreenAngle, screenAngleToOrientation, arrowState,
  createOrientArrow, SETTLE_ELEV_DEG, ARROW_COLOUR,
  projectPoint, markerWorldPos, markerState, shotBasis,
  MARKER_OFFSET_M, FOV_DEG, SECTOR_ALPHA, dialRimPoint, DIAL_R, DIAL_BOX,
} from '../flip3d/orientArrow.js';
import { cameraBasis, screenYToWorldY } from '../flip3d/scene.js';
import { SETTLE_CAM } from '../flip3d/player.js';
import { COIN_RADIUS_M, COIN_HALF_THICKNESS_M } from '../flip3d/contract.js';

/** The settle framing, exactly as player.js#SETTLE_CAM builds it. */
// Read from SETTLE_CAM, not retyped. A verifier that hardcodes the camera it is
// checking is independent of the IMPLEMENTATION, which is the point — and
// independent of the INPUT, which is just wrong: it goes on asserting a camera
// that no longer exists, and passes. That exact flaw was found in
// tools/verify-pickup.mjs, and this file had it too.
const SETTLE_SHOT = {
  target: [0, COIN_HALF_THICKNESS_M, 0],
  distance: SETTLE_CAM.distance, elevDeg: SETTLE_CAM.elevDeg, azimuthDeg: 0,
};
/** The canvas the scene actually resizes to: capped at 880 wide, 1.6 aspect. */
const RECT = { left: 0, top: 0, width: 880, height: 550 };
import {
  roundOrientation, quadrantFromOrientation, normDeg, compassToDir, QUADRANTS,
} from '../flip3d/contract.js';
import { loadClipLibrary } from '../flip3d/library.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };
const f2 = (n) => +n.toFixed(2);
/** Smallest absolute difference between two compass angles, degrees. */
const angDelta = (a, b) => { const d = Math.abs(normDeg(a - b)); return d > 180 ? 360 - d : d; };

// ===========================================================================
console.log('=== (1) the four cardinals land exactly on up / right / down / left ===');
{
  const rows = [];
  let worst = 0;
  for (const [name, world, want] of [
    ['N', 0, 0], ['E', 90, 90], ['S', 180, 180], ['W', 270, 270],
  ]) {
    const got = orientationToScreenAngle(world, SETTLE_ELEV_DEG);
    const d = angDelta(got, want);
    worst = Math.max(worst, d);
    rows.push({ cardinal: name, world, screen: +got.toFixed(9), want });
  }
  console.table(rows);
  // Exact, not approximate: at the cardinals one of the two components is
  // identically zero, so the squash cannot bite and atan2 has an exact answer.
  ok(worst < 1e-9, 'a cardinal does not point where it must', { worst });
  console.log(`  worst cardinal error ${worst.toExponential(2)} deg`);

  // and they must be exact at EVERY elevation — the squash only ever touches
  // the north-south component, which is zero at E and W and dominant at N and S
  let anyElev = 0;
  for (let e = 1; e <= 90; e++) {
    for (const [world] of [[0], [90], [180], [270]]) {
      anyElev = Math.max(anyElev, angDelta(orientationToScreenAngle(world, e), world));
    }
  }
  ok(anyElev < 1e-9, 'a cardinal moves with camera elevation', { anyElev });
  console.log(`  cardinals hold at every elevation 1..90 (worst ${anyElev.toExponential(2)} deg)`);
}

// ===========================================================================
console.log('\n=== (2) THE SQUASH IS REAL — this section fails against the identity ===');
{
  const e = SETTLE_ELEV_DEG;
  const at45 = orientationToScreenAngle(45, e);
  console.log(`  a 45.00 deg heading renders at ${at45.toFixed(2)} deg on screen `
    + `(elev ${e}, sin e = ${Math.sin(e * Math.PI / 180).toFixed(4)})`);

  // It must NOT be 45. If someone replaces the function with the identity this
  // is the assertion that goes red.
  ok(angDelta(at45, 45) > 1, 'the projection is the identity — the foreshortening is missing', { at45 });

  // And it must lean the RIGHT way. Elevation squashes the north-south
  // component only, so every heading is pulled TOWARDS the nearest horizontal
  // (90 or 270) and never away from it. At 45 that means a LARGER angle.
  ok(at45 > 45, 'the 45 deg heading leans away from East, not toward it', { at45 });

  const rows = [];
  let worstDeviation = 0, wrongWay = 0;
  for (let th = 0; th < 360; th += 5) {
    const s = orientationToScreenAngle(th, e);
    const nearestH = angDelta(th, 90) <= angDelta(th, 270) ? 90 : 270;
    const before = angDelta(th, nearestH);
    const after = angDelta(s, nearestH);
    // pulled toward the horizontal: never further from it than it started
    if (after > before + 1e-9) wrongWay++;
    const dev = angDelta(s, th);
    if (dev > worstDeviation) worstDeviation = dev;
    if (th % 45 === 0) rows.push({ world: th, screen: +s.toFixed(2), deviation: +dev.toFixed(2) });
  }
  console.table(rows);
  ok(wrongWay === 0, 'a heading was pushed AWAY from the horizontal', { wrongWay });
  ok(worstDeviation > 2, 'the squash is too weak to be the real projection', { worstDeviation });
  console.log(`  every heading is pulled toward the horizontal; worst deviation ${worstDeviation.toFixed(2)} deg`);

  // the squash must strengthen as the camera drops
  const deviationAt = (elev) => {
    let m = 0;
    for (let th = 0; th < 360; th += 1) m = Math.max(m, angDelta(orientationToScreenAngle(th, elev), th));
    return m;
  };
  const d80 = deviationAt(80), d66 = deviationAt(66), d40 = deviationAt(40);
  ok(d80 < d66 && d66 < d40, 'the squash does not grow as the camera lowers', { d80, d66, d40 });
  console.log(`  worst deviation by elevation: 80 deg -> ${d80.toFixed(2)}, 66 deg -> ${d66.toFixed(2)}, 40 deg -> ${d40.toFixed(2)}`);
}

// ===========================================================================
console.log('\n=== (3) monotone and continuous the whole way round, seam included ===');
{
  const e = SETTLE_ELEV_DEG;
  // Index the sweep by an INTEGER rather than accumulating a float step. With
  // `for (th = 0.05; th <= 360; th += 0.05)` the accumulated error means the
  // loop stops around 359.95 and never samples 360 at all — so the seam is
  // never crossed and a wrap that genuinely happens is never observed. The
  // first version of this test asserted the wrap and then failed to sample it.
  const N = 7200;
  let wraps = 0, backwards = 0, worstJump = 0, jumpAt = null;
  let prev = orientationToScreenAngle(0, e);
  for (let i = 1; i <= N; i++) {
    const th = 360 * i / N;                     // i === N gives exactly 360
    const s = orientationToScreenAngle(th, e);
    let d = s - prev;
    if (d < -180) { d += 360; wraps++; }        // the single legitimate wrap
    if (d < -1e-9) backwards++;
    if (d > worstJump) { worstJump = d; jumpAt = f2(th); }
    prev = s;
  }
  ok(backwards === 0, 'the screen angle goes backwards somewhere', { backwards });
  ok(wraps === 1, 'the 0/360 seam does not wrap exactly once', { wraps });
  // a 0.05 deg step must never move the arrow more than a fraction of a degree
  ok(worstJump < 0.2, 'the screen angle jumps', { worstJump, jumpAt });
  console.log(`  7200 samples: strictly increasing, exactly ${wraps} wrap, worst step ${worstJump.toFixed(4)} deg`);

  // continuity ACROSS the seam specifically: 359.99 and 0.01 must be neighbours
  const a = orientationToScreenAngle(359.99, e);
  const b = orientationToScreenAngle(0.01, e);
  ok(angDelta(a, b) < 0.1, 'the 0/360 seam is discontinuous', { a, b });
  console.log(`  359.99 -> ${a.toFixed(4)} and 0.01 -> ${b.toFixed(4)} are ${angDelta(a, b).toFixed(4)} deg apart`);
}

// ===========================================================================
console.log('\n=== (4) round-trip: screen angle -> world heading recovers the input ===');
{
  const rows = [];
  let worst = 0, worstCase = null;
  for (const e of [20, 40, 66, 80, 89.9, 90]) {
    let m = 0;
    for (let th = 0; th < 360; th += 0.25) {
      const back = screenAngleToOrientation(orientationToScreenAngle(th, e), e);
      const d = angDelta(back, th);
      if (d > m) m = d;
      if (d > worst) { worst = d; worstCase = { e, th }; }
    }
    rows.push({ elevDeg: e, worstErrorDeg: +m.toExponential(2) });
  }
  console.table(rows);
  ok(worst < 1e-9, 'the projection does not round-trip', { worst, worstCase });
  console.log(`  worst round-trip error ${worst.toExponential(2)} deg over 1440 headings x 6 elevations`);

  // azimuth must rotate the compass rigidly and still round-trip
  let azWorst = 0;
  for (const a of [-90, -30, 0, 30, 90, 180]) {
    for (let th = 0; th < 360; th += 3) {
      const back = screenAngleToOrientation(orientationToScreenAngle(th, 66, a), 66, a);
      azWorst = Math.max(azWorst, angDelta(back, th));
    }
  }
  ok(azWorst < 1e-9, 'round-trip fails at non-zero azimuth', { azWorst });
  console.log(`  holds at azimuth -90..180 too (worst ${azWorst.toExponential(2)} deg)`);
}

// ===========================================================================
console.log('\n=== (5) degenerate input is total — nothing may return NaN ===');
{
  const rows = [];
  let bad = 0;
  const inputs = [
    ['negative', -45], ['very negative', -3600.5], ['over 360', 405],
    ['huge', 1e9], ['NaN', NaN], ['+Infinity', Infinity], ['-Infinity', -Infinity],
    ['null', null], ['undefined', undefined], ['string', '45'],
  ];
  for (const [name, v] of inputs) {
    const s = orientationToScreenAngle(v, SETTLE_ELEV_DEG);
    const good = Number.isFinite(s) && s >= 0 && s < 360;
    if (!good) bad++;
    rows.push({ input: name, screen: Number.isFinite(s) ? +s.toFixed(2) : String(s), ok: good });
  }
  console.table(rows);
  ok(bad === 0, 'a degenerate heading produced a non-finite screen angle', { bad });

  // -45 and 315 are the same heading and must render identically
  ok(angDelta(orientationToScreenAngle(-45), orientationToScreenAngle(315)) < 1e-9,
    'a negative heading does not normalise');
  ok(angDelta(orientationToScreenAngle(405), orientationToScreenAngle(45)) < 1e-9,
    'a heading over 360 does not normalise');
  console.log('  -45 == 315 and 405 == 45');

  // elevation 90 is TOP-DOWN: the squash vanishes and the map is the identity.
  // This is the case scene.js#cameraBasis cannot do (its lookAt goes singular
  // when the view direction is parallel to world up), and it is exactly where
  // the right answer is most obvious — which is why the closed form exists.
  let topDown = 0;
  for (let th = 0; th < 360; th += 0.5) topDown = Math.max(topDown, angDelta(orientationToScreenAngle(th, 90), th));
  ok(topDown < 1e-9, 'top-down is not the identity', { topDown });
  console.log(`  elevDeg 90 is the identity (worst ${topDown.toExponential(2)} deg)`);

  // elevation 0 is edge-on: the table projects to a line and EVERY heading
  // collapses onto the horizontal. Genuinely many-to-one, so the only
  // requirement is that it stays finite and the inverse refuses to guess.
  let flat = 0, flatBad = 0;
  for (let th = 0; th < 360; th += 0.5) {
    const s = orientationToScreenAngle(th, 0);
    if (!Number.isFinite(s) || s < 0 || s >= 360) flatBad++;
    flat = Math.max(flat, Math.min(angDelta(s, 90), angDelta(s, 270), angDelta(s, 0)));
  }
  ok(flatBad === 0, 'edge-on elevation produced a non-finite angle', { flatBad });
  ok(Number.isNaN(screenAngleToOrientation(90, 0)), 'the inverse invents an answer at elevDeg 0');
  console.log('  elevDeg 0 collapses onto the horizontal, stays finite, and the inverse returns NaN');

  // a degenerate elevation must not poison the result either
  ok(Number.isFinite(orientationToScreenAngle(45, NaN)), 'a NaN elevation produced a non-finite angle');
  ok(Number.isFinite(orientationToScreenAngle(45, 66, NaN)), 'a NaN azimuth produced a non-finite angle');
  console.log('  a NaN elevation or azimuth falls back rather than propagating');
}

// ===========================================================================
console.log('\n=== (6) it agrees with scene.js#cameraBasis, the shared camera ===');
{
  // The closed form is a derivation, and a derivation can be wrong. This
  // projects the heading through the SAME basis builder the renderer's camera
  // uses and demands the two match — everywhere cameraBasis is non-degenerate.
  const viaBasis = (th, elevDeg, azimuthDeg) => {
    const { xAxis, yAxis } = cameraBasis({ target: [0, 0, 0], distance: 1, elevDeg, azimuthDeg });
    const d = compassToDir(th * Math.PI / 180);
    const right = d[0] * xAxis[0] + d[1] * xAxis[1] + d[2] * xAxis[2];
    const up = d[0] * yAxis[0] + d[1] * yAxis[1] + d[2] * yAxis[2];
    return normDeg(Math.atan2(right, up) * 180 / Math.PI);
  };
  let worst = 0, worstCase = null, n = 0;
  for (let e = 1; e <= 90; e += 1) {            // 90 INCLUDED — see below
    for (const a of [0, 25, -40, 90]) {
      for (let th = 0; th < 360; th += 7) {
        const d = angDelta(orientationToScreenAngle(th, e, a), viaBasis(th, e, a));
        n++;
        if (d > worst) { worst = d; worstCase = { e, a, th }; }
      }
    }
  }
  ok(worst < 1e-9, 'the closed form disagrees with cameraBasis', { worst, worstCase });
  console.log(`  ${n} cases over elevation 1..90 x 4 azimuths: worst disagreement ${worst.toExponential(2)} deg`);

  // ---------------------------------------------------------------------
  // An earlier version of this section asserted that cameraBasis goes SINGULAR
  // at elevDeg 90 and used that to justify the closed form. It does not, and
  // the assertion caught the bad reasoning: at 90 it returns a clean [1,0,0].
  //
  // What is true is thinner. It survives only because Math.cos(Math.PI/2) is
  // 6.1e-17 and not 0, so the cross product it normalises has a length of
  // 6.1e-17 instead of zero. Below is that number, on the record — the margin
  // the shared camera has at the pole is 17 orders of magnitude of luck, and
  // the `|| 1` guard is what would catch it if the luck ran out.
  // ---------------------------------------------------------------------
  const b90 = cameraBasis({ target: [0, 0, 0], distance: 1, elevDeg: 90, azimuthDeg: 0 });
  ok(Math.abs(Math.hypot(...b90.xAxis) - 1) < 1e-9,
    'cameraBasis really is singular at elevDeg 90 after all', { xAxis: b90.xAxis });
  const cosAtPole = Math.cos(90 * Math.PI / 180);
  ok(cosAtPole !== 0, 'cos(90 deg) is exactly zero here — cameraBasis WOULD collapse', { cosAtPole });
  console.log(`  cameraBasis at elevDeg 90 gives xAxis ${JSON.stringify(b90.xAxis)} — not singular`);
  console.log(`  it holds only because cos(90 deg) = ${cosAtPole.toExponential(2)}, not 0; `
    + 'the closed form needs no such luck');
}

// ===========================================================================
console.log('\n=== (7) the readout and the quadrant can never disagree ===');
{
  // Both come from ONE roundOrientation() call, which is the same call
  // player.js makes for report.played.landedOrientationDeg. Deriving the label
  // from the raw value and the bucket from the rounded one would print
  // "90.00" beside quadrant N.
  const rows = [];
  let bad = 0;
  const cases = [
    0, 0.004, 45.678, 89.994, 89.995, 89.999, 90, 179.999, 180, 269.996,
    270, 359.994, 359.995, 359.999, 137.425, 212.005,
  ];
  for (const v of cases) {
    const st = arrowState(v);
    const wantDeg = roundOrientation(v);
    const wantQuad = quadrantFromOrientation(wantDeg);
    const good = st.orientationDeg === wantDeg
      && st.label === wantDeg.toFixed(2) + '°'
      && st.quadrant === wantQuad
      && QUADRANTS.includes(st.quadrant);
    if (!good) { bad++; rows.push({ raw: v, deg: st.orientationDeg, label: st.label, quad: st.quadrant, wantQuad, ok: false }); }
    else if (rows.length < 8) rows.push({ raw: v, deg: st.orientationDeg, label: st.label, quad: st.quadrant, wantQuad, ok: true });
  }
  console.table(rows);
  ok(bad === 0, 'a readout disagrees with its own quadrant', { bad });

  // the wrap case in particular: 359.999 rounds to 360.00, which IS 0.00 / N
  const wrap = arrowState(359.999);
  ok(wrap.label === '0.00°' && wrap.quadrant === QUADRANTS[0],
    '359.999 does not wrap to 0.00 / the first bucket',
    { label: wrap.label, quadrant: wrap.quadrant, want: QUADRANTS[0] });
  console.log(`  359.999 -> ${wrap.label} quadrant ${wrap.quadrant}`);

  // random fuzz over the full circle
  let fuzzBad = 0;
  for (let i = 0; i < 20000; i++) {
    const v = Math.random() * 360;
    const st = arrowState(v);
    const want = roundOrientation(v);
    if (st.label !== want.toFixed(2) + '°' || st.quadrant !== quadrantFromOrientation(want)) fuzzBad++;
  }
  ok(fuzzBad === 0, 'the readout and quadrant disagree on random input', { fuzzBad });
  console.log('  20000 random headings: label and quadrant always agree with roundOrientation');
}

// ===========================================================================
console.log('\n=== (8) THE REAL LIBRARY — all 1024 baked settle angles ===');
{
  const fetchShim = async (url) => {
    const rel = url.replace(/^\.\//, '');
    try {
      const buf = await fs.readFile(path.join(ROOT, rel), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(buf) };
    } catch (e) { return { ok: false, status: 404, json: async () => { throw e; } }; }
  };
  const library = await loadClipLibrary({ base: './bake/out/', fetch: fetchShim });
  console.log(`  library: ${library.stats.clips} clips, ${library.stats.cells} cells`);

  let bad = 0, n = 0;
  const perQuad = { N: 0, E: 0, S: 0, W: 0 };
  const badRows = [];
  for (const e of library.index) {
    const st = arrowState(e.orientationDeg, SETTLE_ELEV_DEG);
    n++;
    perQuad[st.quadrant]++;
    // COMPARE THE BUCKET, NOT THE NAME. The bake's stored `quadrant` string is
    // a NAME, and the names were just changed (N/E/S/W -> NE/SE/SW/NW, because
    // [0,90) runs from north TO east and so is the north-east sector; bare
    // cardinals are now reserved for exact 90-degree multiples). The baked
    // metadata still carries the old spelling and is not this file's to rewrite.
    //
    // What must actually hold is that the dial fills the same 90-degree BUCKET
    // the bet resolves in, and that its name is whatever contract.js currently
    // calls that bucket. Indexing by floor(deg/90) is name-agnostic, so this
    // assertion survives the rename instead of being a second place that has to
    // be edited in lockstep — which is how the two spellings drifted apart in
    // the first place.
    const wantIndex = Math.floor(normDeg(roundOrientation(e.orientationDeg)) / 90) % 4;
    const good = st.quadrantIndex === wantIndex
      && st.quadrant === QUADRANTS[wantIndex]
      && Number.isFinite(st.screenAngleDeg)
      && st.screenAngleDeg >= 0 && st.screenAngleDeg < 360
      && st.label === roundOrientation(e.orientationDeg).toFixed(2) + '°';
    if (!good) { bad++; if (badRows.length < 4) badRows.push({ id: e.id, declared: e.orientationDeg, wantIndex, got: st }); }
  }
  ok(bad === 0, 'a baked clip renders into the wrong quadrant', { bad, badRows });
  console.log(`  ${n} baked settle angles: 0 quadrant mismatches, every screen angle finite`);
  console.log(`  quadrant spread ${JSON.stringify(perQuad)}`);

  // the screen angle must be a genuine function of the settle angle, not a
  // constant that happens to satisfy the range check
  const angles = library.index.map((e) => arrowState(e.orientationDeg).screenAngleDeg);
  const spread = Math.max(...angles) - Math.min(...angles);
  ok(spread > 300, 'every clip renders to nearly the same screen angle', { spread });
  console.log(`  screen angles span ${spread.toFixed(2)} deg across the library`);
}

// ===========================================================================
console.log('\n=== (9) the view paints a dial, and writes its state where a hidden pane can be read ===');
{
  // No DOM in Node, so a stub document. This does NOT prove the dial looks
  // right — nothing headless can — but it does prove the element carries the
  // state and the geometry, which is the only thing a hidden pane could ever be
  // asked for.
  const doc = {
    createElement: (tag) => mk(tag),
    createElementNS: (ns, tag) => mk(tag),
  };
  function mk(tag) {
    return {
      tagName: tag, style: {}, dataset: {}, children: [], attrs: {},
      ownerDocument: doc, className: '', textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; },
    };
  }
  const host = mk('div');
  const dial = createOrientArrow(host, {});

  ok(host.children.length === 1, 'the dial did not mount into its host');
  ok(dial.el.style.display === 'none', 'the dial is visible before the coin lands');
  console.log('  starts hidden — it appears when the coin settles, not before');

  const st = dial.show(137.42, { shot: SETTLE_SHOT, rect: RECT });
  ok(dial.el.style.display === 'block', 'show() did not reveal the dial');
  ok(dial.el.dataset.shown === '1', 'dataset.shown not set');
  ok(dial.el.dataset.orientation === '137.42', 'dataset.orientation wrong', { v: dial.el.dataset.orientation });
  ok(dial.el.dataset.quadrant === st.quadrant, 'dataset.quadrant disagrees with the state');
  ok(dial.el.dataset.quadrantIndex === String(st.quadrantIndex), 'dataset.quadrantIndex wrong');

  // THE DEGREE NUMBER IS GONE FROM THE UI. It is still carried in the state for
  // telemetry, but nothing in the element may render it — the wager is on the
  // quadrant, and two decimals was precision nobody bets on.
  const textNodes = [];
  (function walk(n) { if (n.textContent) textNodes.push(n.textContent); (n.children || []).forEach(walk); }(dial.el));
  ok(!textNodes.some((t) => /[0-9]/.test(t)), 'the dial renders a number somewhere', { textNodes });
  console.log('  no number is rendered anywhere in the element (state still carries it)');

  const svg = dial.el.children.find((c) => c.tagName === 'svg');
  const paths = svg.children.filter((c) => c.tagName === 'path');
  const sectors = paths.filter((c) => c.dataset.landed !== undefined);
  ok(sectors.length === 4, 'there are not exactly four sectors', { n: sectors.length });

  // exactly one sector is filled brighter, and it is the one the coin landed in
  const landed = sectors.filter((q) => q.dataset.landed === '1');
  ok(landed.length === 1, 'not exactly one sector is marked landed', { n: landed.length });
  ok(sectors.indexOf(landed[0]) === st.quadrantIndex,
    'the wrong sector is filled', { filled: sectors.indexOf(landed[0]), want: st.quadrantIndex });
  // THE SECTORS ARE NO LONGER SHADED. Filling three quadrants you did not land
  // in washed over most of the coin's face, which is the thing the guide exists
  // to help you read. What must still hold is that the landed sector is
  // IDENTIFIED — the information survives in the dataset even though the fill
  // is gone — and that nothing paints over the face.
  const alphas = sectors.map((q) => parseFloat(q.getAttribute('fill-opacity')));
  ok(alphas.every((a) => a === 0),
    'a sector is being painted over the coin face', { alphas });
  ok(sectors.filter((q) => q.dataset.landed === '1').length === 1,
    'the landed sector is no longer identifiable now that the fill is gone');
  ok(SECTOR_ALPHA.landed < 0.5 && SECTOR_ALPHA.idle < 0.2,
    'the dial is too opaque — the coin face must read through it', { SECTOR_ALPHA });
  console.log('  four sectors, alpha ' + SECTOR_ALPHA.idle + ' idle / ' + SECTOR_ALPHA.landed + ' landed');

  // the transform is a matrix3d — an affine matrix() cannot carry the
  // perspective divide, and this element spans the whole coin
  ok(/^matrix3d\(/.test(dial.el.style.transform), 'the dial is not transformed by matrix3d',
    { t: dial.el.style.transform });
  ok(dial.el.style.transformOrigin === '0 0', 'the transform origin is not the box corner');
  console.log('  transform is matrix3d with origin 0 0 — the homography does the placing');

  // NOTHING may animate: a hidden pane never advances a transition, so anything
  // driven by one would be frozen at its start value forever.
  const anim = [];
  (function walk(n) {
    const stl = n.style || {};
    if (stl.transition || stl.animation) anim.push(n.tagName);
    (n.children || []).forEach(walk);
  }(dial.el));
  ok(anim.length === 0, 'something animates via CSS', { anim });
  console.log('  no CSS transition or animation anywhere on the element');

  dial.hide();
  ok(dial.el.style.display === 'none' && dial.el.dataset.shown === '0', 'hide() did not clear');
  ok(dial.el.dataset.orientation === undefined, 'hide() left a stale reading');
  console.log('  hide() clears the element and the state together');
}

// ===========================================================================
console.log('\n=== (10) it cannot reach the outcome ===');
{
  const src = await fs.readFile(path.join(ROOT, 'flip3d/orientArrow.js'), 'utf8');
  // Strip comments before scanning. The first version regex-matched raw source
  // and flagged the file for naming "player.js" — in a doc comment explaining
  // which quantity it mirrors. Naming a module in prose is the opposite of
  // depending on it, and a guard that punishes documentation is a guard people
  // work around. What must be true is that no CODE reaches the draw.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const banned = ['outcome.js', 'library.js', 'player.js', 'resolveFlip', 'SPIN_VALUES', 'coinRoot', 'setCoinPose'];
  const codeHits = banned.filter((b) => code.includes(b));
  ok(codeHits.length === 0, 'orientArrow.js reaches into the outcome path', { codeHits });
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  ok(imports.length > 0 && imports.every((i) => i === './contract.js'),
    'orientArrow.js imports something other than contract.js', { imports });
  console.log(`  imports exactly ${JSON.stringify([...new Set(imports)])} — no draw, no library, no transform`);
  console.log(`  ${banned.length} banned identifiers, 0 present in code (comments may name them)`);
}

// ===========================================================================
console.log('\n=== (11) THE PLACEMENT: cardinals land exactly up / right / down / left ===');
{
  const c = projectPoint(SETTLE_SHOT.target, SETTLE_SHOT, RECT);
  ok(c.inFront && c.inViewport, 'the coin centre does not project into the viewport', { c });
  const rows = [];
  for (const [name, deg] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const st = markerState(deg, { shot: SETTLE_SHOT, rect: RECT });
    const dx = st.screen.x - c.x, dy = st.screen.y - c.y;
    rows.push({
      bearing: name, deg,
      'dx px': +dx.toFixed(2), 'dy px': +dy.toFixed(2),
      'gap px': +Math.hypot(dx, dy).toFixed(1),
    });
    // North is straight UP the screen: no horizontal component at all, and a
    // negative dy. Screen-up is -Z = North only because azimuth is pinned to 0;
    // this is the assertion that catches the day someone unpins it.
    if (name === 'N') { ok(Math.abs(dx) < 1e-9 && dy < 0, 'North is not straight up', { dx, dy }); }
    if (name === 'S') { ok(Math.abs(dx) < 1e-9 && dy > 0, 'South is not straight down', { dx, dy }); }
    if (name === 'E') { ok(Math.abs(dy) < 1e-9 && dx > 0, 'East is not straight right', { dx, dy }); }
    if (name === 'W') { ok(Math.abs(dy) < 1e-9 && dx < 0, 'West is not straight left', { dx, dy }); }
  }
  console.table(rows);
  const n = rows.find((r) => r.bearing === 'N'); const s = rows.find((r) => r.bearing === 'S');
  ok(Math.abs(n['dy px']) < Math.abs(s['dy px']),
    'North is not nearer the centre than South — perspective is missing', { n, s });
  console.log(`  North sits ${Math.abs(n['dy px']).toFixed(1)} px from centre, South ${Math.abs(s['dy px']).toFixed(1)} px.`);
  console.log('  Not a bug: the camera is due SOUTH, so the coin\'s north rim is further');
  console.log('  away and projects smaller. An orthographic projection would tie.');
}

// ===========================================================================
console.log('\n=== (12) REGISTRATION: the dial rim sits on the coin rim ===');
{
  // THE HEADLINE TEST. The overlay is painted on the coin, so its boundary must
  // land on the coin's boundary the whole way round. A dial 3 px out at one
  // bearing looks broken in a way a numeric readout never could — and it is the
  // failure mode a linearised transform produces silently.
  const rows = [];
  let worstAll = 0;
  for (const W of [1400, 880, 640, 474, 360]) {
    const rect = { left: 0, top: 0, width: W, height: Math.round(W / 1.6) };
    const st = markerState(0, { shot: SETTLE_SHOT, rect });
    let worst = 0, at = 0;
    for (let deg = 0; deg < 360; deg += 1) {
      const rp = dialRimPoint(deg);                 // where the dial DRAWS its rim
      const drawn = st.dial.at(rp[0], rp[1]);
      const truth = projectPoint(markerWorldPos(deg, SETTLE_SHOT.target, 0), SETTLE_SHOT,
        { left: 0, top: 0, width: rect.width, height: rect.height });
      const e = Math.hypot(drawn.x - truth.x, drawn.y - truth.y);
      if (e > worst) { worst = e; at = deg; }
    }
    worstAll = Math.max(worstAll, worst);
    rows.push({ canvas: W + ' px', 'worst rim error': worst.toExponential(2) + ' px', 'at bearing': at + ' deg' });
  }
  console.table(rows);
  ok(worstAll < 0.01, 'the dial does not register with the coin rim', { worstAll });
  console.log('  worst disagreement anywhere, any canvas: ' + worstAll.toExponential(2) + ' px');
  console.log('  that is float noise rather than approximation — a plane-to-plane');
  console.log('  projective map IS a homography, so four correspondences reproduce it.');

  // AND THE COMPARISON THAT JUSTIFIES THE CHOICE: what the cheaper obvious
  // approach, an affine Jacobian about the centre, costs over this footprint.
  const rect = { left: 0, top: 0, width: 880, height: 550 };
  const c = SETTLE_SHOT.target;
  const eps = 1e-4;
  const p0 = projectPoint(c, SETTLE_SHOT, rect);
  const pe = projectPoint([c[0] + eps, c[1], c[2]], SETTLE_SHOT, rect);
  const pn = projectPoint([c[0], c[1], c[2] - eps], SETTLE_SHOT, rect);
  const Je = [(pe.x - p0.x) / eps, (pe.y - p0.y) / eps];
  const Jn = [(pn.x - p0.x) / eps, (pn.y - p0.y) / eps];
  let worstAffine = 0, affineAt = 0;
  for (let deg = 0; deg < 360; deg += 1) {
    const t = deg * Math.PI / 180;
    const east = Math.sin(t) * COIN_RADIUS_M;
    const north = Math.cos(t) * COIN_RADIUS_M;
    const ax = p0.x + Je[0] * east + Jn[0] * north;
    const ay = p0.y + Je[1] * east + Jn[1] * north;
    const truth = projectPoint(markerWorldPos(deg, c, 0), SETTLE_SHOT, rect);
    const e = Math.hypot(ax - truth.x, ay - truth.y);
    if (e > worstAffine) { worstAffine = e; affineAt = deg; }
  }
  console.log('  an affine Jacobian would be out by ' + worstAffine.toFixed(2) + ' px at ' + affineAt + ' deg');
  ok(worstAffine > 0.5,
    'the affine error is negligible, so this section is not discriminating',
    { worstAffine });
  console.log('  (asserted NON-negligible on purpose: if affine were good enough here,');
  console.log('   this test would prove nothing and the homography would be ceremony)');
}

// ===========================================================================
console.log('\n=== (13) it stays on screen at every bearing, and on small canvases ===');
{
  // A marker that leaves the frame at some bearings is a bug you would only
  // otherwise find by landing on that bearing by luck.
  const rows = [];
  for (const [w, h] of [[880, 550], [640, 400], [400, 250], [320, 200]]) {
    const rect = { left: 0, top: 0, width: w, height: h };
    let out = 0, worstMargin = Infinity, worstAt = null, labelOut = 0;
    for (let deg = 0; deg < 360; deg += 0.5) {
      const st = markerState(deg, { shot: SETTLE_SHOT, rect });
      if (!st.screen.inViewport) { out++; continue; }
      const m = Math.min(st.screen.x, w - st.screen.x, st.screen.y, h - st.screen.y);
      if (m < worstMargin) { worstMargin = m; worstAt = f2(deg); }
      // the label runs to the RIGHT of the triangle: 14 px glyph + 4 gap +
      // ~52 px for "359.99°" at 13 px bold tabular figures
      if (st.screen.x + 7 + 4 + 52 > w) labelOut++;
    }
    rows.push({
      canvas: `${w}x${h}`, 'marker off-screen': out,
      'tightest margin px': out ? '-' : +worstMargin.toFixed(1),
      at: out ? '-' : worstAt, 'label clipped': labelOut,
    });
    ok(out === 0, 'the marker leaves the viewport', { canvas: `${w}x${h}`, out });
  }
  console.table(rows);
  console.log('  label width is ESTIMATED (13 px bold tabular, "359.99°" ~= 52 px) — the');
  console.log('  real metric needs a font engine, so a clipped label at 320 px is a');
  console.log('  warning to check on a device, not a proof either way.');
}

// ===========================================================================
console.log('\n=== (14) the placement and the rotation agree — two derivations, one answer ===');
{
  // orientationToScreenAngle() is a closed form from the camera basis.
  // markerState() places a world point through a full perspective projection.
  // They are independent routes to the same fact, so the DIRECTION from the coin
  // centre to the marker must equal the screen angle. If either drifts, this
  // goes red — which is the point of computing the same thing twice.
  const c = projectPoint(SETTLE_SHOT.target, SETTLE_SHOT, RECT);
  let worst = 0, worstAt = null;
  for (let deg = 0; deg < 360; deg += 0.5) {
    const st = markerState(deg, { shot: SETTLE_SHOT, rect: RECT });
    const dx = st.screen.x - c.x, dy = st.screen.y - c.y;
    // screen angle is clockwise from screen-up; screen y grows DOWNWARD
    const fromPos = normDeg(Math.atan2(dx, -dy) * 180 / Math.PI);
    const d = angDelta(fromPos, st.screenAngleDeg);
    if (d > worst) { worst = d; worstAt = f2(deg); }
  }
  // I expected this to be small-but-nonzero — perspective is not orthographic,
  // the near rim is 10% closer than the far one, so surely the projected
  // direction drifts. It does not: measured 1.1e-13 deg, floating-point exact.
  //
  // The reason is specific and worth writing down, because it is also the
  // reason this can STOP being true. The shot TARGETS the coin centre, so the
  // centre lands exactly on the view axis and projects to the NDC origin. The
  // marker is at C + r*d, so in camera space it is (0,0,-distance) + r*u, and
  // its NDC works out to r*(u.x, u.y) / (distance - r*u.z) — the depth appears
  // only as a SCALAR on the displacement. A scalar changes the marker's
  // distance from the centre, never its bearing.
  //
  // So: exact while the camera looks at the coin. Point it somewhere else, or
  // pass a `centre` that is not the shot target, and the two derivations WILL
  // separate. The tight bound below is the tripwire for that day.
  ok(worst < 1e-9, 'the projected direction disagrees with the closed form', { worst, worstAt });
  console.log(`  worst disagreement ${worst.toExponential(2)} deg at ${worstAt} deg bearing`);
  console.log('  Exact, because the shot targets the coin centre: the centre lands on the');
  console.log('  NDC origin, so the perspective divide scales the marker\'s displacement');
  console.log('  without rotating it. Depths still differ by 10% (0.0996 m vs 0.1104 m).');

  // and it must genuinely separate when the camera is NOT on the coin, or the
  // assertion above is proving a tautology rather than a projection
  const offShot = { ...SETTLE_SHOT, target: [0.02, COIN_HALF_THICKNESS_M, 0.015] };
  const offC = projectPoint([0, COIN_HALF_THICKNESS_M, 0], offShot, RECT);
  let offWorst = 0;
  for (let deg = 0; deg < 360; deg += 1) {
    const st = markerState(deg, { shot: offShot, rect: RECT, centre: [0, COIN_HALF_THICKNESS_M, 0] });
    const fromPos = normDeg(Math.atan2(st.screen.x - offC.x, -(st.screen.y - offC.y)) * 180 / Math.PI);
    offWorst = Math.max(offWorst, angDelta(fromPos, st.screenAngleDeg));
  }
  ok(offWorst > 0.01, 'an off-axis camera does not separate the two derivations — '
    + 'the agreement above may be tautological', { offWorst });
  console.log(`  with the camera aimed 25 mm off the coin they separate by ${offWorst.toFixed(2)} deg,`);
  console.log('  which is what shows the exactness above is a real property and not a no-op');
}

// ===========================================================================
console.log('\n=== (15) it agrees with scene.js, the shared camera, on a real point ===');
{
  // scene.js#screenYToWorldY unprojects a screen row onto the lift line (x=0,
  // z=0). Project a point ON that line and the two must be inverses. This is
  // what stops the local shotBasis copy drifting from the renderer's camera.
  let worst = 0, worstAt = null;
  for (const y of [0.001, 0.005, 0.012, 0.02, 0.03]) {
    const p = [0, y, 0];
    const s = projectPoint(p, SETTLE_SHOT, RECT, FOV_DEG);
    const back = screenYToWorldY(s.y, RECT, SETTLE_SHOT, FOV_DEG);
    const d = Math.abs(back - y);
    if (d > worst) { worst = d; worstAt = y; }
  }
  // scene.js clamps its result to the LIFT band, so only heights inside it can
  // round-trip; that is a property of its clamp, not of the projection.
  ok(worst < 1e-6, 'projectPoint and scene.js#screenYToWorldY are not inverses',
    { worstMm: worst * 1000, worstAt });
  console.log(`  worst round-trip against scene.js ${(worst * 1e6).toFixed(3)} microns`);

  // and the local basis must equal the shared one exactly
  let bWorst = 0;
  for (const e of [10, 34, 66, 80]) {
    for (const a of [0, 45, -60]) {
      const shot = { target: [0, 0.001, 0], distance: 0.1, elevDeg: e, azimuthDeg: a };
      const mine = shotBasis(shot); const theirs = cameraBasis(shot);
      for (const k of ['pos', 'xAxis', 'yAxis', 'zAxis']) {
        for (let i = 0; i < 3; i++) bWorst = Math.max(bWorst, Math.abs(mine[k][i] - theirs[k][i]));
      }
    }
  }
  ok(bWorst < 1e-12, 'the local shotBasis has drifted from scene.js#cameraBasis', { bWorst });
  console.log(`  local shotBasis == scene.js#cameraBasis to ${bWorst.toExponential(2)}`);
}

// ===========================================================================
console.log('\n=== (16) degenerate placement input is total ===');
{
  const rows = [];
  let bad = 0;
  const cases = [
    ['NaN degrees', NaN, SETTLE_SHOT, RECT],
    ['Infinity degrees', Infinity, SETTLE_SHOT, RECT],
    ['negative degrees', -720.5, SETTLE_SHOT, RECT],
    ['over 360', 1080.25, SETTLE_SHOT, RECT],
    ['no shot', 45, null, RECT],
    ['no rect', 45, SETTLE_SHOT, null],
    ['zero-size rect', 45, SETTLE_SHOT, { left: 0, top: 0, width: 0, height: 0 }],
    ['negative rect', 45, SETTLE_SHOT, { left: 0, top: 0, width: -880, height: -550 }],
    ['zero distance', 45, { ...SETTLE_SHOT, distance: 0 }, RECT],
    ['elev 90 (top-down)', 45, { ...SETTLE_SHOT, elevDeg: 90 }, RECT],
    ['elev 0 (edge-on)', 45, { ...SETTLE_SHOT, elevDeg: 0 }, RECT],
  ];
  for (const [name, deg, shot, rect] of cases) {
    let threw = false; let st = null;
    try { st = markerState(deg, { shot, rect }); } catch { threw = true; }
    const placed = st && st.screen && st.screen.inFront;
    const finite = !placed || (Number.isFinite(st.screen.x) && Number.isFinite(st.screen.y));
    if (threw || !finite) bad++;
    rows.push({
      case: name, threw, placed: !!placed,
      x: placed ? +st.screen.x.toFixed(1) : '-', y: placed ? +st.screen.y.toFixed(1) : '-',
      ok: !threw && finite,
    });
  }
  console.table(rows);
  ok(bad === 0, 'a degenerate placement threw or produced a non-finite position', { bad });
  console.log('  nothing throws; anything unplaceable reports inFront:false rather than');
  console.log('  parking the marker at 0,0 where it would look like a real reading');

  // a point BEHIND the camera must be refused, not mirrored onto the screen
  const behind = projectPoint([0, 0.001, 1], SETTLE_SHOT, RECT);
  ok(!behind.inFront, 'a point behind the camera was projected anyway', { behind });
  console.log('  a point behind the camera reports inFront:false');
}

// ===========================================================================
console.log('\n=== (17) reposition() survives a resize without changing the reading ===');
{
  const doc = { createElement: (t) => mk2(t), createElementNS: (n, t) => mk2(t) };
  function mk2(tag) {
    return {
      tagName: tag, style: {}, dataset: {}, children: [], attrs: {},
      ownerDocument: doc, className: '', textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; },
    };
  }
  const dial = createOrientArrow(mk2('div'), {});
  const a = dial.show(212.34, { shot: SETTLE_SHOT, rect: RECT });
  const small = { left: 0, top: 0, width: 440, height: 275 };
  const b = dial.reposition({ rect: small });
  ok(b.orientationDeg === a.orientationDeg && b.quadrant === a.quadrant,
    'reposition() changed the reading', { a: a.orientationDeg, b: b.orientationDeg });

  // Halving the canvas halves every projected coordinate, so the dial's centre
  // and its radius must both halve. Checked THROUGH the homography rather than
  // against a stored position, because the homography is the placement now.
  const ca = a.dial.at(DIAL_R, DIAL_R), cb = b.dial.at(DIAL_R, DIAL_R);
  ok(Math.abs(cb.x - ca.x / 2) < 1e-6 && Math.abs(cb.y - ca.y / 2) < 1e-6,
    'the dial centre did not rescale with the canvas', { ca, cb });
  const ea = a.dial.at(DIAL_BOX, DIAL_R), eb = b.dial.at(DIAL_BOX, DIAL_R);
  const ra = Math.hypot(ea.x - ca.x, ea.y - ca.y);
  const rb = Math.hypot(eb.x - cb.x, eb.y - cb.y);
  ok(Math.abs(rb - ra / 2) < 1e-6, 'the dial radius did not rescale with the canvas', { ra, rb });
  console.log('  212.34 deg: centre (' + ca.x.toFixed(1) + ', ' + ca.y.toFixed(1) + ') r ' + ra.toFixed(1) + ' at 880x550');
  console.log('  -> centre (' + cb.x.toFixed(1) + ', ' + cb.y.toFixed(1) + ') r ' + rb.toFixed(1) + ' at 440x275, reading unchanged');

  dial.hide();
  ok(dial.reposition() === null, 'reposition() after hide() resurrected a stale reading');
  console.log('  reposition() after hide() is inert — no stale dial comes back');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
