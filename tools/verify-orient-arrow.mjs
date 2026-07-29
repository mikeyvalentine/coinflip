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
} from '../flip3d/orientArrow.js';
import { cameraBasis } from '../flip3d/scene.js';
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
  ok(wrap.label === '0.00°' && wrap.quadrant === 'N',
    '359.999 does not wrap to 0.00 / N', { label: wrap.label, quadrant: wrap.quadrant });
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
    // The bake's own declared quadrant is the authority; the arrow must never
    // put the coin in a different bucket from the one the bet pays out on.
    const good = st.quadrant === e.quadrant
      && Number.isFinite(st.screenAngleDeg)
      && st.screenAngleDeg >= 0 && st.screenAngleDeg < 360
      && st.label === roundOrientation(e.orientationDeg).toFixed(2) + '°';
    if (!good) { bad++; if (badRows.length < 4) badRows.push({ id: e.id, declared: e.orientationDeg, quad: e.quadrant, got: st }); }
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
console.log('\n=== (9) the view writes its state where a hidden pane can be read ===');
{
  // No DOM in Node, so a stub document. This does NOT prove the arrow looks
  // right — nothing headless can — but it does prove the element carries the
  // state, which is the only thing a hidden pane could ever be asked.
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
  const arrow = createOrientArrow(host, {});

  ok(host.children.length === 1, 'the arrow did not mount into its host');
  ok(arrow.el.style.display === 'none', 'the arrow is visible before the coin lands');
  ok(arrow.el.dataset.shown === undefined || arrow.el.dataset.shown === '0', 'the arrow starts shown');
  console.log('  starts hidden — it appears when the coin settles, not before');

  const st = arrow.show(137.42);
  ok(arrow.el.style.display === 'inline-flex', 'show() did not reveal the arrow');
  ok(arrow.el.dataset.shown === '1', 'dataset.shown not set');
  ok(arrow.el.dataset.orientation === '137.42', 'dataset.orientation wrong', { v: arrow.el.dataset.orientation });
  ok(arrow.el.dataset.quadrant === 'E', 'dataset.quadrant wrong', { v: arrow.el.dataset.quadrant });
  ok(st.label === '137.42°', 'the label is wrong', { label: st.label });

  // the SVG group must carry a rotate() matching the computed screen angle
  const svg = arrow.el.children.find((c) => c.tagName === 'svg');
  const g = svg.children[0];
  const tf = g.getAttribute('transform');
  const m = /rotate\(([-\d.]+) 50 50\)/.exec(tf || '');
  ok(!!m, 'the arrow group carries no rotate()', { tf });
  ok(m && Math.abs(parseFloat(m[1]) - st.screenAngleDeg) < 1e-3,
    'the drawn rotation is not the computed screen angle', { tf, want: st.screenAngleDeg });
  console.log(`  137.42 deg -> rotate(${m ? m[1] : '?'} 50 50), quadrant ${arrow.el.dataset.quadrant}`);

  // colour: yellow, and the same yellow on the stroke and the label
  const path = g.children[0];
  ok(path.getAttribute('stroke') === ARROW_COLOUR, 'the arrow is not the declared yellow');
  ok(arrow.el.style.color === ARROW_COLOUR, 'the label is not the declared yellow');
  console.log(`  arrow and label both ${ARROW_COLOUR}`);

  // NOTHING may animate via CSS — a hidden pane would freeze it at frame zero
  const styleText = JSON.stringify(arrow.el.style) + JSON.stringify(svg.style) + JSON.stringify(g.style || {});
  ok(!/transition|animation/i.test(styleText), 'the arrow animates via CSS', { styleText });
  console.log('  no CSS transition or animation anywhere on the element');

  arrow.hide();
  ok(arrow.el.style.display === 'none', 'hide() did not hide the arrow');
  ok(arrow.el.dataset.shown === '0', 'hide() left dataset.shown set');
  ok(arrow.el.dataset.orientation === undefined, 'hide() left a stale orientation on the element');
  ok(arrow.state === null, 'hide() left stale state');
  console.log('  hide() clears the element and the state together');

  // re-show must fully replace, never merge with the previous reading
  arrow.show(300.05);
  ok(arrow.el.dataset.orientation === '300.05' && arrow.el.dataset.quadrant === 'W',
    'a second show() did not replace the first', { d: arrow.el.dataset });
  console.log('  a second show() replaces the reading outright');
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
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
