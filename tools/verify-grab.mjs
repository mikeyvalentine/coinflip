// tools/verify-grab.mjs
// ---------------------------------------------------------------------------
// Headless sweep for THE THROW (flip3d/grab.js). No DOM, no GPU, no real time:
// the element and the window are stubs, and the clock is a variable this file
// increments by hand.
//
// That last part is the whole reason the module takes an injectable `now`, and
// it matters more under the new model than the old one: power now depends on
// pointer VELOCITY, so a test that could not control the clock could not
// measure the thing the throw is made of. The preview pane is usually hidden,
// where requestAnimationFrame never fires and setTimeout is throttled.
//
// What this is here to prove, in order of how much it matters:
//   1. THE VELOCITY ESTIMATE IS FRAME-RATE INDEPENDENT. The same physical throw
//      sampled at 60 Hz and at 240 Hz must read the same power. This is the
//      single most likely thing to be wrong, because the obvious
//      implementation — the delta between the last two events — is wrong by
//      construction and looks fine until someone plays on different hardware.
//   2. The two phases are what was asked for: the pull-back fills the meter
//      slowly and is the minor term; the up-stroke fills the majority.
//   3. Releasing on the way down is a DROP, not a throw, even when a big
//      wind-up would otherwise have carried it past the power floor.
//   4. Power is a clamped 0..1 for every input including malformed ones, and is
//      monotone in both up-velocity and up-distance.
//   5. The idle re-arm still holds the coin in your hand rather than dropping it.
//   6. Exactly one of onThrow / onCancel fires per gesture. Never both, never
//      neither.
//
// Run: node tools/verify-grab.mjs
// ---------------------------------------------------------------------------

import {
  createGrab, PULL_TRAVEL_PX, IDLE_RESET_MS, IDLE_MOVE_EPS_PX,
  WIND_WEIGHT, VEL_WEIGHT, THROW_DIST_WEIGHT,
  VEL_FULL_PX_S, VEL_FULL_BAND_SEC, VEL_WINDOW_MS, MIN_THROW_VEL_PX_S,
} from '../flip3d/grab.js';
import { MIN_POWER } from '../flip3d/power.js';
import { LIFT, HOLD_SHOT, worldYToScreenY } from '../flip3d/scene.js';

let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// --- stubs -----------------------------------------------------------------
/** An element / window that records its listeners so dispose() is checkable. */
function stubTarget(name) {
  const listeners = [];
  return {
    name,
    style: {},
    listeners,
    get count() { return listeners.length; },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    setPointerCapture() {}, releasePointerCapture() {},
    dispatch(type, ev) { listeners.filter((l) => l.type === type).forEach((l) => l.fn(ev)); },
  };
}

const ev = (x, y, id = 1, extra = {}) => ({
  clientX: x, clientY: y, pointerId: id, preventDefault() {}, ...extra,
});

/** A rig: stub el + stub window + a clock this file drives. */
function rig(hooks = {}) {
  const el = stubTarget('el');
  const root = stubTarget('root');
  let t = 1000;
  const log = { grab: [], change: [], rearm: [], throw: [], cancel: [] };
  const g = createGrab(el, {
    now: () => t,
    root,
    onGrab: (i) => log.grab.push(i),
    onChange: (p, i) => log.change.push({ p, i }),
    onRearm: (i) => log.rearm.push(i),
    onThrow: (p, i) => log.throw.push({ p, i }),
    onCancel: (r, i) => log.cancel.push({ r, i }),
    ...hooks,
  });
  return {
    g, el, root, log,
    advance(ms) { t += ms; },
    get time() { return t; },
    down: (x, y, id) => g._begin(ev(x, y, id)),
    move: (x, y, id) => g._move(ev(x, y, id)),
    up: (x, y, id) => g._finish(ev(x, y, id)),
  };
}

/**
 * Play a throw: pull down `windPx`, then travel back up `upPx` over `upMs`,
 * sampled at `hz`, and release at the top.
 *
 * The up-stroke is what the velocity estimate reads, so the sampling rate is a
 * parameter — that is how section (1) asks a 60 Hz mouse and a 240 Hz one the
 * same physical question.
 */
function throwStroke(r, { startY = 400, windPx = 200, upPx = 200, upMs = 100, hz = 60, release = true }) {
  r.down(500, startY);
  // wind up in a few steps, slowly, so it is unmistakably a pull and not a flick
  const windSteps = 6;
  for (let i = 1; i <= windSteps; i++) {
    r.advance(30);
    r.move(500, startY + windPx * (i / windSteps));
  }
  const deep = startY + windPx;
  // then the throw
  const stepMs = 1000 / hz;
  const n = Math.max(1, Math.round(upMs / stepMs));
  for (let i = 1; i <= n; i++) {
    r.advance(stepMs);
    r.move(500, deep - upPx * (i / n));
  }
  const endY = deep - upPx;
  if (release) r.up(500, endY);
  return { deep, endY };
}

// ===========================================================================
console.log('=== (1) THE ONE MOST LIKELY TO BE WRONG: velocity is rate-independent ===');
{
  // The same physical throw — same distance, same duration — sampled at wildly
  // different event rates. A last-two-events delta would read ~4x apart between
  // 60 Hz and 240 Hz; an endpoint-over-a-fixed-window estimate must not.
  const rows = [];
  const powers = [];
  for (const hz of [30, 60, 120, 144, 240, 500]) {
    const r = rig();
    throwStroke(r, { windPx: 200, upPx: 300, upMs: 120, hz });
    const p = r.log.throw[0]?.p ?? 0;
    const v = r.log.throw[0]?.i.upVelPxS ?? 0;
    powers.push(p);
    rows.push({ hz, 'up velocity px/s': +v.toFixed(0), power: +p.toFixed(4) });
    r.g.dispose();
  }
  console.table(rows);
  const spread = Math.max(...powers) - Math.min(...powers);
  ok(spread < 0.05, 'the same throw reads differently at different event rates', {
    spread: +spread.toFixed(4), powers: powers.map((p) => +p.toFixed(4)),
  });
  console.log(`  power spread across 30..500 Hz: ${spread.toFixed(4)} (tolerance 0.05)`);
  console.log('  a last-two-events delta would spread this by ~4x; the fixed');
  console.log(`  ${VEL_WINDOW_MS} ms window asks every device the same question instead.`);

  // and the estimate must survive jitter riding on top of a real stroke
  const clean = rig(); throwStroke(clean, { windPx: 200, upPx: 300, upMs: 120, hz: 120 });
  const jit = rig();
  {
    const startY = 400, windPx = 200, upPx = 300, upMs = 120, hz = 120;
    jit.down(500, startY);
    for (let i = 1; i <= 6; i++) { jit.advance(30); jit.move(500, startY + windPx * (i / 6)); }
    const deep = startY + windPx;
    const n = Math.round(upMs / (1000 / hz));
    // +/- 2 px of tremor, alternating — inside IDLE_MOVE_EPS_PX territory
    for (let i = 1; i <= n; i++) {
      jit.advance(1000 / hz);
      jit.move(500, deep - upPx * (i / n) + (i % 2 ? 2 : -2));
    }
    jit.up(500, deep - upPx);
  }
  const dp = Math.abs((clean.log.throw[0]?.p ?? 0) - (jit.log.throw[0]?.p ?? 0));
  ok(dp < 0.05, 'jitter moved the power materially', { dp: +dp.toFixed(4) });
  console.log(`  +/-2 px of tremor on the up-stroke moved power by ${dp.toFixed(4)}`);
  clean.g.dispose(); jit.g.dispose();
}

// ===========================================================================
console.log('\n=== (2) the two phases: wind-up is minor, the throw is the majority ===');
{
  // A pure pull-back, held still at the bottom and released downward-ish.
  // It can only ever reach WIND_WEIGHT.
  const r = rig();
  r.down(500, 300);
  for (let i = 1; i <= 6; i++) { r.advance(30); r.move(500, 300 + PULL_TRAVEL_PX * (i / 6)); }
  const windOnly = r.g.power;
  ok(near(windOnly, WIND_WEIGHT, 1e-6), 'a full pull-back is not worth exactly the wind weight',
    { windOnly, want: WIND_WEIGHT });
  console.log(`  full pull-back, no throw: power ${windOnly.toFixed(4)} = WIND_WEIGHT ${WIND_WEIGHT}`);
  r.g.dispose();

  // A pure throw with NO wind-up: grab and flick straight up. Reaches at most
  // VEL_WEIGHT + THROW_DIST_WEIGHT, and cannot reach 1.0.
  const r2 = rig();
  r2.down(500, 400);
  // travel up a full band in 80 ms => 190/0.08 = 2375 px/s, above VEL_FULL
  for (let i = 1; i <= 8; i++) { r2.advance(10); r2.move(500, 400 - PULL_TRAVEL_PX * (i / 8)); }
  const throwOnly = r2.g.power;
  ok(throwOnly > 0.6, 'a pure throw is too weak', { throwOnly });
  ok(throwOnly <= VEL_WEIGHT + THROW_DIST_WEIGHT + 1e-9,
    'a pure throw exceeded the throw weights', { throwOnly });
  console.log(`  pure throw, no wind-up:   power ${throwOnly.toFixed(4)} (ceiling ${VEL_WEIGHT + THROW_DIST_WEIGHT})`);
  r2.g.dispose();

  // and the split itself, measured rather than asserted from the constants
  const full = rig();
  throwStroke(full, { windPx: PULL_TRAVEL_PX, upPx: PULL_TRAVEL_PX, upMs: 70, hz: 120 });
  const p = full.log.throw[0];
  const windShare = WIND_WEIGHT * p.i.windNorm;
  const throwShare = VEL_WEIGHT * p.i.velNorm + THROW_DIST_WEIGHT * p.i.throwNorm;
  console.table([{
    'wind contribution': +windShare.toFixed(4),
    'throw contribution': +throwShare.toFixed(4),
    'throw share of total': (100 * throwShare / (windShare + throwShare)).toFixed(1) + '%',
  }]);
  ok(throwShare > windShare, 'the throw is not the majority of the meter',
    { windShare, throwShare });
  full.g.dispose();
}

// ===========================================================================
console.log('\n=== (3) releasing on the way down is a DROP, not a throw ===');
{
  // A big wind-up carries WIND_WEIGHT = 0.25 of power, comfortably past a 0.12
  // floor. If the drop test ran after the floor test, this would throw a coin
  // the player never threw.
  const r = rig({ minPower: 0.12 });
  r.down(500, 300);
  for (let i = 1; i <= 6; i++) { r.advance(30); r.move(500, 300 + 300 * (i / 6)); }
  r.advance(20);
  r.up(500, 620);                       // still heading down at the release
  ok(r.log.throw.length === 0, 'a downward release threw', { throws: r.log.throw.length });
  ok(r.log.cancel[0]?.r === 'dropped', 'a downward release was not reported as a drop',
    { got: r.log.cancel[0]?.r });
  console.log(`  wind-up 320 px then released downward -> ${r.log.cancel[0]?.r} (power would have been ${r.log.cancel[0]?.i.power.toFixed(3)})`);
  r.g.dispose();

  // a slow lift below MIN_THROW_VEL is also a drop
  const slow = rig({ minPower: 0.12 });
  slow.down(500, 500);
  for (let i = 1; i <= 6; i++) { slow.advance(30); slow.move(500, 500 + 200 * (i / 6)); }
  // creep back up at ~60 px/s, under the 120 px/s floor
  for (let i = 1; i <= 5; i++) { slow.advance(100); slow.move(500, 700 - 6 * i); }
  slow.up(500, 670);
  ok(slow.log.cancel[0]?.r === 'dropped', 'a sub-threshold lift was not a drop',
    { got: slow.log.cancel[0]?.r, v: slow.log.cancel[0]?.i.upVelPxS });
  console.log(`  creeping up at ${slow.log.cancel[0]?.i.upVelPxS.toFixed(0)} px/s -> dropped (floor ${MIN_THROW_VEL_PX_S})`);
  slow.g.dispose();

  // but a genuine flick throws
  const fast = rig({ minPower: 0.12 });
  throwStroke(fast, { windPx: 200, upPx: 250, upMs: 90, hz: 120 });
  ok(fast.log.throw.length === 1, 'a real flick did not throw', { cancels: fast.log.cancel.map((c) => c.r) });
  console.log(`  a real flick at ${fast.log.throw[0]?.i.upVelPxS.toFixed(0)} px/s -> throw, power ${fast.log.throw[0]?.p.toFixed(3)}`);
  fast.g.dispose();
}

// ===========================================================================
console.log('\n=== (4) monotone in both throw terms, and always inside 0..1 ===');
{
  // rising up-velocity, everything else fixed
  const rows = [];
  let prev = -1; let bad = 0;
  for (const upMs of [400, 260, 180, 130, 100, 80, 60, 45]) {
    const r = rig();
    throwStroke(r, { windPx: 150, upPx: 250, upMs, hz: 200 });
    const p = r.log.throw[0]?.p ?? r.g.power;
    if (p < prev - 1e-9) bad++;
    prev = p;
    rows.push({ 'up-stroke ms': upMs, 'px/s': +(r.log.throw[0]?.i.upVelPxS ?? 0).toFixed(0), power: +p.toFixed(4) });
    r.g.dispose();
  }
  console.table(rows);
  ok(bad === 0, 'power is not monotone in up-velocity', { bad });

  // rising up-distance at a fixed speed
  let prevD = -1; let badD = 0;
  const dRows = [];
  for (const upPx of [40, 80, 140, 200, 280, 380]) {
    const r = rig();
    // hold the SPEED constant by scaling the duration with the distance
    throwStroke(r, { windPx: 150, upPx, upMs: upPx / 2.5, hz: 240 });
    const p = r.log.throw[0]?.p ?? r.g.power;
    if (p < prevD - 1e-9) badD++;
    prevD = p;
    dRows.push({ 'up px': upPx, 'px/s': +(r.log.throw[0]?.i.upVelPxS ?? 0).toFixed(0), power: +p.toFixed(4) });
    r.g.dispose();
  }
  console.table(dRows);
  ok(badD === 0, 'power is not monotone in up-distance at fixed speed', { badD });

  // and nothing can leave the band
  const hostile = [
    ['NaN on move', (r) => { r.down(500, 400); r.advance(16); r.move(500, NaN); }],
    ['Infinity', (r) => { r.down(500, 400); r.advance(16); r.move(500, Infinity); }],
    ['NaN on grab', (r) => { r.down(500, NaN); }],
    ['negative coords', (r) => { r.down(-900, -900); r.advance(16); r.move(-900, -1600); }],
    ['10000 px flick', (r) => { r.down(500, 400); r.advance(16); r.move(500, 10400); r.advance(16); r.move(500, -9600); }],
    ['zero-duration flick', (r) => { r.down(500, 400); r.move(500, 100); }],
    ['1e12 px/s', (r) => { r.down(500, 400); r.advance(1); r.move(500, -1e9); }],
  ];
  const hRows = [];
  for (const [name, play] of hostile) {
    const r = rig();
    play(r);
    const p = r.g.power;
    const inRange = Number.isFinite(p) && p >= 0 && p <= 1;
    hRows.push({ case: name, power: Number.isFinite(p) ? +p.toFixed(4) : String(p), inRange });
    ok(inRange, 'power left 0..1 or went non-finite', { name, p });
    r.g.dispose();
  }
  console.table(hRows);
}

// ===========================================================================
console.log('\n=== (5) the idle re-arm still holds the coin ===');
{
  const r = rig();
  r.down(500, 300);
  for (let i = 1; i <= 6; i++) { r.advance(30); r.move(500, 300 + 200 * (i / 6)); }
  const before = r.g.power;
  ok(before > 0, 'the wind-up registered nothing to re-arm', { before });
  r.advance(IDLE_RESET_MS + 10);
  const fired = r.g.tick();
  ok(fired, 'the idle re-arm did not fire');
  ok(r.g.power === 0, 'the re-arm left power behind', { power: r.g.power });
  ok(r.g.held, 'THE RE-ARM DROPPED THE COIN — that is a cancel, not a re-arm');
  ok(r.log.cancel.length === 0, 'the re-arm fired a cancel', { cancels: r.log.cancel.map((c) => c.r) });
  console.log(`  wound to ${before.toFixed(3)}, held still ${IDLE_RESET_MS} ms -> power 0, still held`);

  // and a fresh wind-up after the re-arm measures from the new position
  for (let i = 1; i <= 6; i++) { r.advance(30); r.move(500, 500 + 190 * (i / 6)); }
  ok(near(r.g.power, WIND_WEIGHT, 1e-6), 'the post-re-arm wind-up did not measure from the new base',
    { power: r.g.power });
  console.log(`  a fresh full pull-back after the re-arm reads ${r.g.power.toFixed(4)} again`);
  r.g.dispose();

  // sub-epsilon jitter still counts as still
  const j = rig();
  j.down(500, 300);
  for (let i = 1; i <= 6; i++) { j.advance(30); j.move(500, 300 + 200 * (i / 6)); }
  for (let k = 0; k < 8; k++) { j.advance(150); j.move(500 + (k % 2 ? 1 : -1), 500 + (k % 2 ? 1 : -1)); }
  // NOT exactly zero, and demanding that was wrong. The re-arm empties the
  // meter, but the tremor after it is still 2 px of real movement and the
  // machine is right to measure it. What matters is that it is negligible —
  // a fraction of a percent of the meter, against the 0.25 it replaced.
  ok(j.g.power < 0.02, 'tremor prevented the re-arm', { power: j.g.power, eps: IDLE_MOVE_EPS_PX });
  console.log(`  +/-1 px tremor for ${8 * 150} ms still re-armed: 0.250 -> ${j.g.power.toFixed(4)} (eps ${IDLE_MOVE_EPS_PX} px)`);
  j.g.dispose();
}

// ===========================================================================
console.log('\n=== (6) exactly one of throw / cancel, every time ===');
{
  const cases = [
    ['a real throw', (r) => { throwStroke(r, { windPx: 200, upPx: 250, upMs: 90, hz: 120 }); }],
    ['released downward', (r) => { r.down(500, 300); r.advance(40); r.move(500, 500); r.advance(20); r.up(500, 560); }],
    ['escape mid-wind', (r) => { r.down(500, 300); r.advance(40); r.move(500, 500); r.g.cancel('escape'); }],
    ['pointercancel', (r) => { r.down(500, 300); r.advance(40); r.move(500, 500); r.g.cancel('pointercancel'); }],
    ['press and release, no motion', (r) => { r.down(500, 400); r.advance(20); r.up(500, 400); }],
    ['re-arm then release', (r) => {
      r.down(500, 300); r.advance(40); r.move(500, 500);
      r.advance(IDLE_RESET_MS + 10); r.g.tick(); r.advance(20); r.up(500, 500);
    }],
  ];
  const rows = [];
  for (const [name, play] of cases) {
    const r = rig({ minPower: 0.12 });
    play(r);
    const n = r.log.throw.length + r.log.cancel.length;
    rows.push({
      case: name, throws: r.log.throw.length, cancels: r.log.cancel.length,
      reason: r.log.cancel[0]?.r ?? '-', exactlyOne: n === 1,
    });
    ok(n === 1, 'not exactly one terminal callback', { name, throws: r.log.throw.length, cancels: r.log.cancel.length });
    r.g.dispose();
  }
  console.table(rows);
}

// ===========================================================================
console.log('\n=== (7) the settle window: no measuring against a moving ruler ===');
{
  // While the camera transitions, a stroke must not bank power. The coin still
  // tracks — onChange keeps firing — but apex and deep re-base every event.
  const SETTLE = 180;
  const r = rig({ settleMs: SETTLE });
  r.down(500, 300);
  // a full pull-back INSIDE the settle window
  for (let i = 1; i <= 6; i++) { r.advance(20); r.move(500, 300 + 300 * (i / 6)); }
  ok(r.g.power === 0, 'a stroke inside the settle window banked power', { power: r.g.power });
  ok(r.g.settling, 'the machine left the settle window early');
  const changes = r.log.change.length;
  ok(changes > 6, 'the coin stopped tracking during the settle', { changes });
  console.log(`  ${changes} position updates during the settle, power still ${r.g.power.toFixed(3)}`);

  // once settled, the same gesture measures normally, from wherever the hand is
  r.advance(SETTLE);
  ok(!r.g.settling, 'the settle window never ended');
  for (let i = 1; i <= 6; i++) { r.advance(30); r.move(500, 600 + PULL_TRAVEL_PX * (i / 6)); }
  ok(near(r.g.power, WIND_WEIGHT, 1e-6), 'post-settle measurement did not start clean',
    { power: r.g.power });
  console.log(`  after ${SETTLE} ms, a full pull-back reads ${r.g.power.toFixed(4)} — measured from where the hand was`);
  r.g.dispose();

  // default is off, so nothing that does not opt in changes
  const off = rig();
  off.down(500, 300);
  off.advance(30); off.move(500, 400);
  ok(!off.g.settling, 'settling is on by default');
  ok(off.g.power > 0, 'the default path stopped measuring');
  console.log('  with no settleMs the machine measures immediately, as before');
  off.g.dispose();
}

// ===========================================================================
console.log('\n=== (8) hostile pointers and housekeeping ===');
{
  const r = rig();
  r.down(500, 400, 1);
  r.advance(16);
  r.move(500, 300, 2);              // a second pointer must not steer
  ok(r.g.power === 0, 'a foreign pointer moved the gesture', { power: r.g.power });
  r.up(500, 300, 2);                // nor end it
  ok(r.g.held, 'a foreign pointer ended the gesture');
  r.down(500, 200, 3);              // nor start a second one
  ok(r.log.grab.length === 1, 'a second press started another gesture', { grabs: r.log.grab.length });
  r.g.dispose();
  console.log('  a second pointer cannot steer, end or hijack the gesture');

  const d = rig();
  const elBefore = d.el.count, rootBefore = d.root.count;
  d.g.dispose();
  ok(d.el.count === 0 && d.root.count === 0, 'dispose left listeners behind',
    { el: d.el.count, root: d.root.count });
  console.log(`  dispose removed ${elBefore} element + ${rootBefore} window listeners, leaving 0`);

  const t = rig();
  ok(t.g.tick() === false, 'tick did something with no coin held');
  console.log('  tick() is inert when the coin is not held');

  const u = rig();
  u.up(500, 400);
  ok(u.log.throw.length === 0 && u.log.cancel.length === 0, 'a release with no grab fired something');
  console.log('  a release with no grab is silent');
  u.g.dispose();
}

// ===========================================================================
console.log('\n=== (9) the gesture cannot reach the outcome ===');
{
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../flip3d/grab.js', import.meta.url), 'utf8');
  // strip comments first: a guard that fails on a file naming a module in its
  // documentation is a guard people route around by deleting the documentation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const banned = ['outcome.js', 'SPIN_VALUES', 'resolveFlip', 'library.js', 'contract.js'];
  const hits = banned.filter((b) => code.includes(b));
  ok(hits.length === 0, 'grab.js references the outcome path', { hits });
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  ok(imports.length === 1 && imports[0] === './power.js',
    'grab.js imports something other than power.js', { imports });
  console.log(`  imports exactly ${JSON.stringify(imports)} and names nothing from the draw`);
}

// ===========================================================================
console.log('\n=== (10) THE GESTURE MEANS THE SAME THING AT EVERY CANVAS SIZE ===');
{
  // An INTEGRATION check, and it lives here because neither module can see the
  // fault from the inside. grab.js measures in CSS px; scene.js bounds the
  // coin's lift in METRES; a canvas-size-dependent projection joins them. A
  // fixed pixel travel would make the same stroke worth wildly different power
  // at different window sizes, and resizing the window would silently re-tune
  // the control.
  //
  // Under the throw model the canonical gesture is: pull back the whole band,
  // then throw the whole band at full speed. That must be 1.0 everywhere.
  const bandOf = (rect) => {
    const top = worldYToScreenY(LIFT.maxY, rect, HOLD_SHOT, 30);
    const rest = worldYToScreenY(LIFT.minY, rect, HOLD_SHOT, 30);
    return { top, rest, travel: rest - top };
  };
  const rows = [];
  let worstErr = 0;
  for (const [w, h] of [[480, 300], [880, 550], [1400, 875], [1920, 1080]]) {
    const b = bandOf({ top: 0, height: h });
    const r = rig({
      clampY: (y) => Math.min(Math.max(y, b.top), b.rest),
      travelPx: () => b.travel,
    });
    // start at the ceiling, pull all the way down to the table, flick all the
    // way back up fast enough to saturate the velocity term
    r.down(500, b.top);
    for (let i = 1; i <= 6; i++) { r.advance(30); r.move(500, b.top + b.travel * (i / 6)); }
    // Full speed is now BAND-RELATIVE: crossing the whole band in
    // VEL_FULL_BAND_SEC is 1.0. Cross it faster than that and the velocity
    // term saturates on every canvas, which is the property being checked.
    const upMs = VEL_FULL_BAND_SEC * 1000 / 1.4;
    const n = 8;
    for (let i = 1; i <= n; i++) { r.advance(upMs / n); r.move(500, b.rest - b.travel * (i / n)); }
    r.up(500, b.top);
    const p = r.log.throw[0]?.p ?? 0;
    rows.push({ canvas: `${w}x${h}`, bandPx: +b.travel.toFixed(1), power: +p.toFixed(4) });
    worstErr = Math.max(worstErr, Math.abs(p - 1));
    r.g.dispose();
  }
  console.table(rows);
  ok(worstErr < 1e-6, 'a full wind-and-throw is not 1.0 on every canvas', { worstErr });
  console.log(`  pull the whole band, throw it back at full speed = 1.0000 everywhere (worst error ${worstErr.toExponential(2)})`);

  // the ceiling must not be a place to hide wind-up
  const b = bandOf({ top: 0, height: 550 });
  const over = rig({
    clampY: (y) => Math.min(Math.max(y, b.top), b.rest),
    travelPx: () => b.travel,
  });
  // Grab at the CEILING and pull far past the table: the wind-up must cap at the
  // visible band, not at how far the pointer actually travelled. Grabbing at the
  // bottom instead would clamp to a zero-length pull and the assertion would
  // pass without ever exercising the cap.
  over.down(500, b.top);
  over.advance(30); over.move(500, b.rest + 600);     // 600 px below the table
  ok(near(over.g.windPx, b.travel, 1e-6), 'the wind-up did not cap at the visible band',
    { windPx: over.g.windPx, band: b.travel });
  over.advance(30); over.move(500, b.top - 600);      // 600 px above the ceiling
  ok(over.g.power <= 1 && over.g.power >= 0, 'clamped pointer left the band', { power: over.g.power });
  ok(over.g.throwPx <= b.travel + 1e-6, 'throw distance beyond the visible band was banked',
    { throwPx: over.g.throwPx, band: b.travel });
  console.log(`  600 px past both ends: wind ${over.g.windPx.toFixed(1)} px, throw ${over.g.throwPx.toFixed(1)} px — both capped at the ${b.travel.toFixed(1)} px band`);
  over.g.dispose();

  // a broken travel must not poison power
  let nan = null;
  const g2 = rig({ travelPx: () => 0 });
  g2.down(500, 400);
  g2.advance(30); g2.move(500, 600);
  g2.advance(30); g2.move(500, 300);
  nan = g2.g.power;
  ok(Number.isFinite(nan) && nan >= 0 && nan <= 1, 'a zero travelPx produced a non-finite power', { nan });
  console.log(`  travelPx()=0 falls back to the constant; power stays finite (${nan.toFixed(4)})`);
  g2.g.dispose();
}

// ===========================================================================
console.log('\n=== (12) a SNAPPY reversal is not under-read ===');
{
  // Regression. The velocity estimate is a net displacement over a window, so
  // if the window is allowed to straddle the bottom of the wind-up, a fast
  // down-then-up cancels itself out and the hardest flicks read as motionless —
  // wrong exactly where it matters most. The window is therefore clipped at the
  // moment the pointer was last at its deepest.
  //
  // Two throws, same up-stroke, different reversal sharpness. The snappy one
  // must not measure lower than the leisurely one.
  const play = (windMs) => {
    const r = rig();
    r.down(500, 300);
    // pull down over windMs, then flick up 250 px over 70 ms
    const n = 5;
    for (let i = 1; i <= n; i++) { r.advance(windMs / n); r.move(500, 300 + 250 * (i / n)); }
    for (let i = 1; i <= 7; i++) { r.advance(10); r.move(500, 550 - 250 * (i / 7)); }
    r.up(500, 300);
    const out = { p: r.log.throw[0]?.p ?? 0, v: r.log.throw[0]?.i.upVelPxS ?? 0 };
    r.g.dispose();
    return out;
  };
  const rows = [];
  let worst = Infinity;
  for (const windMs of [300, 150, 80, 40, 20]) {
    const o = play(windMs);
    rows.push({ 'wind-up ms': windMs, 'reversal': windMs <= 60 ? 'snappy' : 'leisurely',
      'up px/s': +o.v.toFixed(0), power: +o.p.toFixed(4) });
    worst = Math.min(worst, o.p);
  }
  console.table(rows);
  const spread = Math.max(...rows.map((r) => r.power)) - Math.min(...rows.map((r) => r.power));
  ok(spread < 0.05, 'reversal sharpness changed the measured throw', { spread: +spread.toFixed(4) });
  ok(worst > 0.5, 'a snappy reversal under-read the flick', { worst: +worst.toFixed(4) });
  console.log(`  the same flick after a 300 ms and a 20 ms wind-up reads within ${spread.toFixed(4)}`);
  console.log('  without the deepT clip an unclipped window spanning the reversal reports the');
  console.log('  NET displacement, which early in a snappy up-stroke is still downward — so the');
  console.log('  throw phase never opens and the whole throw-distance term is lost.');
}

// ===========================================================================
console.log('\n=== (11) minPower gates a fumble, but only after the drop test ===');
{
  const floors = [];
  // A gentle upward flick that clears MIN_THROW_VEL but is still feeble.
  for (const [floor, upMs, want] of [[MIN_POWER, 300, 'throw'], [0.35, 300, 'cancel'], [0.35, 60, 'throw']]) {
    const r = rig({ minPower: floor });
    throwStroke(r, { windPx: 60, upPx: 90, upMs, hz: 120 });
    const got = r.log.throw.length ? 'throw' : 'cancel';
    floors.push({
      floor, 'up-stroke ms': upMs,
      power: +(r.log.throw[0]?.p ?? r.log.cancel[0]?.i.power ?? 0).toFixed(4),
      got, want, reason: r.log.cancel[0]?.r ?? '-',
    });
    ok(got === want, 'minPower did not gate the release as expected', { floor, upMs, got, want });
    r.g.dispose();
  }
  console.table(floors);
  console.log('  below the floor a release is a fumble, never a limp throw');
}

// ===========================================================================
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
