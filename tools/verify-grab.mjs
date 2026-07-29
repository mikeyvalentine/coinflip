// tools/verify-grab.mjs
// ---------------------------------------------------------------------------
// Headless sweep for the PICK-UP GESTURE (flip3d/grab.js). No DOM, no GPU, no
// real time: the element and the window are stubs, and the clock is a variable
// this file increments by hand.
//
// That last part is the whole reason the module takes an injectable `now` and
// re-arms from tick() instead of a timer. The preview pane is usually hidden,
// where requestAnimationFrame never fires and setTimeout is throttled, so a
// timer-driven re-arm could not be tested anywhere — it would only ever be
// checked by a human noticing it had stopped working.
//
// What this is here to prove, in order of how much it matters:
//   1. The idle re-arm does what the player asked for: hold still, the wind-up
//      resets, AND THE COIN STAYS IN YOUR HAND. A re-arm that dropped the coin
//      would be a cancel wearing a different name.
//   2. The anchor makes the wind-up real: up 100 then down 150 is a 150 pull,
//      not a 50 one. This is the entire difference from the old charge gesture.
//   3. Power is a clamped 0..1 for every input, including malformed ones, and
//      is monotone in the pull.
//   4. Exactly one of onThrow / onCancel fires per gesture. Never both, never
//      neither.
//
// Run: node tools/verify-grab.mjs
// ---------------------------------------------------------------------------

import {
  createGrab, PULL_TRAVEL_PX, IDLE_RESET_MS, IDLE_MOVE_EPS_PX,
} from '../flip3d/grab.js';
import { MIN_POWER } from '../flip3d/power.js';
import { LIFT, worldYToScreenY } from '../flip3d/scene.js';

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

// ===========================================================================
console.log('=== (1) the pull maps to power ===');
{
  const rows = [];
  for (const [pullPx, want] of [[0, 0], [PULL_TRAVEL_PX / 2, 0.5], [PULL_TRAVEL_PX, 1],
    [PULL_TRAVEL_PX * 2, 1], [PULL_TRAVEL_PX * 0.25, 0.25]]) {
    const r = rig();
    r.down(500, 300);
    r.advance(50);
    r.move(500, 300 + pullPx);
    rows.push({ pullPx, power: +r.g.power.toFixed(4), want });
    ok(near(r.g.power, want, 1e-9), 'pull did not map to the expected power', { pullPx, got: r.g.power, want });
  }
  console.table(rows);

  // pulling UP from the grab point is not a pull at all — it raises the anchor
  const up = rig();
  up.down(500, 300);
  up.advance(50);
  up.move(500, 200);
  ok(up.g.power === 0, 'an upward move produced power', { power: up.g.power });
  ok(up.g.anchorY === 200, 'the anchor did not rise with an upward move', { anchorY: up.g.anchorY });
  console.log(`  upward move: power ${up.g.power}, anchor followed to ${up.g.anchorY}`);
}

// ===========================================================================
console.log('\n=== (2) THE WIND-UP: the anchor is the top of the stroke ===');
{
  // up 100, then down 150 => a 150 px pull, not 50
  const r = rig();
  r.down(500, 300);
  r.advance(50); r.move(500, 200);      // lift 100
  r.advance(50); r.move(500, 350);      // pull down 150 from the anchor at 200
  const wantPull = 150;
  ok(near(r.g.power, wantPull / PULL_TRAVEL_PX, 1e-9),
    'the pull was not measured from the raised anchor',
    { power: r.g.power, want: wantPull / PULL_TRAVEL_PX, anchorY: r.g.anchorY });
  ok(r.g.anchorY === 200, 'the anchor moved off the top of the stroke', { anchorY: r.g.anchorY });
  console.log(`  up 100 then down 150: pull ${r.g.state().pullPx} px, power ${r.g.power.toFixed(4)} `
    + `(a press-relative gesture would have read ${(50 / PULL_TRAVEL_PX).toFixed(4)})`);

  // and the anchor must NOT follow the coin back down mid-pull
  const r2 = rig();
  r2.down(500, 300);
  r2.advance(50); r2.move(500, 250);    // lift 50  -> anchor 250
  r2.advance(50); r2.move(500, 400);    // pull 150
  r2.advance(50); r2.move(500, 320);    // ease back up 80 -> pull 70
  ok(r2.g.anchorY === 250, 'the anchor drifted during the pull', { anchorY: r2.g.anchorY });
  ok(near(r2.g.power, 70 / PULL_TRAVEL_PX, 1e-9), 'easing back up did not reduce power',
    { power: r2.g.power, want: 70 / PULL_TRAVEL_PX });
  console.log(`  easing back up reduces power: ${r2.g.power.toFixed(4)} (pull ${r2.g.state().pullPx} px)`);

  // lifting back ABOVE where the coin was picked up must raise the anchor too —
  // the grab point is where the stroke started, not a ceiling on it
  const r3 = rig();
  r3.down(500, 300);
  r3.advance(50); r3.move(500, 500);    // pull 200 -> clamped to full power
  r3.advance(50); r3.move(500, 120);    // lift right past the grab point
  ok(r3.g.anchorY === 120, 'the anchor did not rise above the grab point', { anchorY: r3.g.anchorY });
  ok(r3.g.power === 0, 'power survived a lift above the anchor', { power: r3.g.power });
  r3.advance(50); r3.move(500, 120 + PULL_TRAVEL_PX / 2);
  ok(near(r3.g.power, 0.5), 'the pull after an over-lift was mis-measured', { power: r3.g.power });
  console.log('  lifting past the grab point raises the anchor and re-zeros the pull');

  // monotone in the pull
  const mono = rig();
  mono.down(500, 100);
  let prev = -1, breaks = 0;
  for (let d = 0; d <= 400; d += 5) {
    mono.advance(20);
    mono.move(500, 100 + d);
    if (mono.g.power < prev - 1e-12) breaks++;
    prev = mono.g.power;
  }
  ok(breaks === 0, 'power is not monotone in the pull distance', { breaks });
  console.log(`  power is monotone across a 0..400 px pull (${breaks} inversions)`);
}

// ===========================================================================
console.log('\n=== (3) THE HEADLINE: hold still and the wind-up re-arms ===');
{
  const r = rig();
  r.down(500, 300);
  r.advance(50); r.move(500, 200);        // lift
  r.advance(50); r.move(500, 380);        // pull 180 -> nearly full power
  const charged = r.g.power;
  ok(charged > 0.9, 'the test did not actually charge before going still', { charged });

  // hold still: no events at all, just frames going by
  r.advance(IDLE_RESET_MS - 1);
  ok(r.g.tick() === false, 're-armed before the idle window elapsed');
  ok(r.g.power === charged, 'power moved while merely waiting', { power: r.g.power });

  r.advance(2);
  const fired = r.g.tick();
  ok(fired === true, 'the re-arm did not fire at the idle threshold');
  ok(r.g.power === 0, 'the re-arm did not zero the power', { power: r.g.power });
  // THE point: this is a re-arm, not a cancel
  ok(r.g.held === true, 'THE RE-ARM DROPPED THE COIN — it must stay held');
  ok(r.log.cancel.length === 0, 'the re-arm fired a cancel', { cancels: r.log.cancel.length });
  ok(r.log.throw.length === 0, 'the re-arm fired a throw');
  ok(r.log.rearm.length === 1, 'onRearm did not fire exactly once', { n: r.log.rearm.length });
  console.log(`  charged to ${charged.toFixed(3)}, held still ${IDLE_RESET_MS} ms -> power 0, still held`);

  // it must not keep firing every frame while the hand stays put
  r.advance(IDLE_RESET_MS * 3);
  r.g.tick(); r.g.tick(); r.g.tick();
  ok(r.log.rearm.length === 1, 'the re-arm repeated while still', { n: r.log.rearm.length });
  console.log(`  and does not repeat: onRearm still fired ${r.log.rearm.length}x after 3 more windows`);

  // a fresh wind-up from the new anchor reads correctly
  r.advance(20); r.move(500, 380 + 95);   // pull 95 from the re-armed anchor at 380
  ok(near(r.g.power, 95 / PULL_TRAVEL_PX, 1e-9), 'the wind-up after a re-arm was mis-measured',
    { power: r.g.power, want: 95 / PULL_TRAVEL_PX, anchorY: r.g.anchorY });
  console.log(`  fresh pull of 95 px after the re-arm reads ${r.g.power.toFixed(4)} `
    + `(anchor correctly at ${r.g.anchorY})`);

  // and it can then be thrown normally
  r.advance(20); r.up(500, 380 + 95);
  ok(r.log.throw.length === 1, 'could not throw after a re-arm', { throws: r.log.throw.length });
  console.log('  and the throw after a re-arm lands normally');
}

// ===========================================================================
console.log('\n=== (4) stillness is judged against the last real position ===');
{
  // The epsilon boundary, exercised on both sides rather than somewhere safely
  // inside it. `> eps` is the test, so a wobble of exactly eps must still read
  // as stillness and one a hair over must not.
  const rows = [];
  for (const [wobble, wantRearm] of [
    [IDLE_MOVE_EPS_PX * 0.5, true],
    [IDLE_MOVE_EPS_PX, true],           // exactly on the line: still
    [IDLE_MOVE_EPS_PX + 0.01, false],   // a hair over: real movement
    [IDLE_MOVE_EPS_PX * 4, false],
  ]) {
    const jit = rig();
    jit.down(500, 300);
    jit.advance(50); jit.move(500, 450);          // charge to ~0.79
    const charged = jit.g.power;
    // alternate about the rest position so the offset never accumulates —
    // this is tremor, not travel
    for (let i = 0; i < 40; i++) {
      jit.advance(IDLE_RESET_MS / 20);
      jit.move(500, 450 + (i % 2 ? wobble : 0));
    }
    const rearmed = jit.log.rearm.length > 0;
    rows.push({ wobblePx: wobble, rearmed, want: wantRearm, chargedTo: +charged.toFixed(3) });
    ok(rearmed === wantRearm,
      wantRearm ? 'tremor at/under the epsilon blocked the re-arm — a resting hand never recovers'
        : 'movement over the epsilon was treated as stillness',
      { wobble, eps: IDLE_MOVE_EPS_PX, rearms: jit.log.rearm.length });
  }
  console.table(rows);

  // real movement does NOT re-arm, however slow. This is the case that a
  // naive last-event comparison gets wrong: each step is under the epsilon,
  // but they accumulate, so measuring from the last SIGNIFICANT position is
  // what keeps a slow deliberate drag alive.
  const slow = rig();
  slow.down(500, 300);
  slow.advance(50); slow.move(500, 400);
  const before = slow.g.power;
  for (let i = 0; i < 30; i++) {                  // 2 px per step, well under eps
    slow.advance(IDLE_RESET_MS / 10);
    slow.move(500, 400 + (i + 1) * 2);
  }
  ok(slow.log.rearm.length === 0,
    'a slow deliberate drag was re-armed underneath the player',
    { rearms: slow.log.rearm.length });
  ok(slow.g.power > before, 'the slow drag did not accumulate power', { before, after: slow.g.power });
  console.log(`  a 2 px/step slow drag over ${IDLE_RESET_MS * 3} ms never re-armed `
    + `and grew ${before.toFixed(3)} -> ${slow.g.power.toFixed(3)}`);
}

// ===========================================================================
console.log('\n=== (5) exactly one of throw / cancel, every time ===');
{
  const cases = [];

  // a real throw
  {
    const r = rig();
    r.down(500, 200); r.advance(50); r.move(500, 200 + PULL_TRAVEL_PX); r.advance(20);
    r.up(500, 200 + PULL_TRAVEL_PX);
    cases.push({ case: 'full pull', throws: r.log.throw.length, cancels: r.log.cancel.length, thrownAt: +r.log.throw[0].p.toFixed(3) });
    ok(r.log.throw.length === 1 && r.log.cancel.length === 0, 'a full pull did not throw exactly once');
    ok(near(r.log.throw[0].p, 1), 'a full pull did not throw at power 1', { p: r.log.throw[0].p });
    ok(r.g.held === false, 'the coin was still held after a throw');
  }

  // put it back down: below MIN_POWER
  {
    const r = rig();
    const tiny = (MIN_POWER * PULL_TRAVEL_PX) * 0.5;
    r.down(500, 200); r.advance(50); r.move(500, 200 + tiny); r.advance(20); r.up(500, 200 + tiny);
    cases.push({ case: 'below minimum', throws: r.log.throw.length, cancels: r.log.cancel.length, thrownAt: '—' });
    ok(r.log.throw.length === 0 && r.log.cancel.length === 1, 'a limp release was not a cancel');
    ok(r.log.cancel[0].r === 'below-minimum', 'wrong cancel reason', { r: r.log.cancel[0].r });
  }

  // escape mid-wind-up
  {
    const r = rig();
    r.down(500, 200); r.advance(50); r.move(500, 500);
    r.root.dispatch('keydown', { key: 'Escape' });
    cases.push({ case: 'escape', throws: r.log.throw.length, cancels: r.log.cancel.length, thrownAt: '—' });
    ok(r.log.cancel.length === 1 && r.log.cancel[0].r === 'escape', 'Escape did not cancel');
    ok(r.g.held === false, 'Escape left the coin held');
  }

  // pointercancel and blur
  for (const [type, target, payload, label] of [
    ['pointercancel', 'el', {}, 'pointercancel'],
    ['blur', 'root', {}, 'window blur'],
  ]) {
    const r = rig();
    r.down(500, 200); r.advance(50); r.move(500, 500);
    (target === 'el' ? r.el : r.root).dispatch(type, payload);
    cases.push({ case: label, throws: r.log.throw.length, cancels: r.log.cancel.length, thrownAt: '—' });
    ok(r.log.cancel.length === 1 && r.log.throw.length === 0, `${label} did not cancel cleanly`);
  }

  // release after a re-arm: the wind-up is gone, so this is putting it back down
  {
    const r = rig();
    r.down(500, 200); r.advance(50); r.move(500, 500);
    r.advance(IDLE_RESET_MS + 1); r.g.tick();
    r.advance(10); r.up(500, 500);
    cases.push({ case: 'release after re-arm', throws: r.log.throw.length, cancels: r.log.cancel.length, thrownAt: '—' });
    ok(r.log.throw.length === 0 && r.log.cancel.length === 1,
      'releasing a re-armed gesture threw a stale charge');
  }
  console.table(cases);
}

// ===========================================================================
console.log('\n=== (6) the release position is part of the pull ===');
{
  // "depending on where you RELEASE" — a pointerup at a position no pointermove
  // reported must still count. Browsers do this.
  const r = rig();
  r.down(500, 200);
  r.advance(50); r.move(500, 250);          // a 50 px pull so far
  r.advance(20); r.up(500, 200 + PULL_TRAVEL_PX);   // released much lower
  ok(r.log.throw.length === 1, 'the release did not throw', { log: r.log });
  ok(near(r.log.throw[0].p, 1), 'the release position was ignored', { p: r.log.throw[0].p });
  console.log(`  pointerup ${PULL_TRAVEL_PX} px below the anchor threw at ${r.log.throw[0].p.toFixed(3)}, `
    + 'not the 0.26 the last pointermove had');
}

// ===========================================================================
console.log('\n=== (7) malformed and hostile input ===');
{
  const rows = [];
  const check = (label, fn) => {
    const r = rig();
    fn(r);
    const p = r.g.power;
    const finite = Number.isFinite(p) && p >= 0 && p <= 1;
    rows.push({ case: label, power: finite ? +p.toFixed(4) : String(p), inRange: finite });
    ok(finite, `power escaped 0..1 for: ${label}`, { power: p });
  };

  check('NaN clientY on move', (r) => { r.down(500, 300); r.advance(20); r.move(500, NaN); });
  check('Infinity clientY', (r) => { r.down(500, 300); r.advance(20); r.move(500, Infinity); });
  check('NaN on grab', (r) => { r.down(NaN, NaN); r.advance(20); r.move(500, 400); });
  {
    const n = rig();
    n.down(NaN, 300);
    ok(n.g.held === false, 'a NaN grab picked the coin up anyway');
    ok(n.log.grab.length === 0, 'a NaN grab fired onGrab');
  }
  check('negative coords', (r) => { r.down(-500, -300); r.advance(20); r.move(-500, -100); });
  check('10000 px pull', (r) => { r.down(500, 0); r.advance(20); r.move(500, 10000); });
  check('10000 px lift', (r) => { r.down(500, 5000); r.advance(20); r.move(500, -5000); });
  console.table(rows);

  // a NaN move must be IGNORED, not absorbed: the good state survives it
  const nan = rig();
  nan.down(500, 300); nan.advance(20); nan.move(500, 400);
  const good = nan.g.power;
  nan.advance(20); nan.move(500, NaN);
  ok(nan.g.power === good, 'a NaN move corrupted a valid gesture', { before: good, after: nan.g.power });
  ok(nan.g.anchorY === 300, 'a NaN move corrupted the anchor', { anchorY: nan.g.anchorY });
  console.log('  a NaN move is dropped and leaves the gesture intact');

  // pointerup with no pointerdown
  const orphan = rig();
  orphan.up(500, 400);
  ok(orphan.log.throw.length === 0 && orphan.log.cancel.length === 0,
    'a release with no grab produced callbacks', { log: orphan.log });
  console.log('  a release with no grab is silent');

  // a second pointer must not steer or end the first one's gesture
  const two = rig();
  two.down(500, 200, 1);
  two.advance(20); two.move(500, 300, 1);
  const owned = two.g.power;
  two.advance(20); two.move(500, 900, 2);          // intruder drags hard
  ok(two.g.power === owned, 'a second pointer moved the gesture', { before: owned, after: two.g.power });
  two.up(500, 900, 2);                             // intruder releases
  ok(two.log.throw.length === 0 && two.log.cancel.length === 0, 'a second pointer ended the gesture');
  ok(two.g.held === true, 'a second pointer dropped the coin');
  two.advance(20); two.up(500, 300, 1);            // the real one releases
  ok(two.log.throw.length === 1, 'the owning pointer could not release', { log: two.log });
  console.log('  a second pointer cannot steer, end, or hijack the gesture');

  // a second pointerdown while held must not restart the gesture
  const redown = rig();
  redown.down(500, 200, 1);
  redown.advance(20); redown.move(500, 350, 1);
  const held = redown.g.power;
  redown.down(500, 800, 2);
  ok(redown.g.power === held, 'a second press restarted the wind-up', { before: held, after: redown.g.power });
  ok(redown.g.anchorY === 200, 'a second press moved the anchor', { anchorY: redown.g.anchorY });
  console.log('  a second press while held is ignored');
}

// ===========================================================================
console.log('\n=== (8) canStart gate, worldY passthrough, dispose ===');
{
  const blocked = rig({ canStart: () => false });
  blocked.down(500, 300);
  ok(blocked.g.held === false, 'canStart:false still picked the coin up');
  ok(blocked.log.grab.length === 0, 'canStart:false fired onGrab');
  console.log('  canStart:false refuses the pick-up');

  // canStart receives the event, so the host can raycast the coin
  let sawEvent = null;
  const gated = rig({ canStart: (e) => { sawEvent = e; return true; } });
  gated.down(123, 456);
  ok(sawEvent && sawEvent.clientX === 123 && sawEvent.clientY === 456,
    'canStart did not receive the event', { sawEvent });
  console.log('  canStart receives the event (so the host can hit-test the coin)');

  // toWorldY is passed through untouched
  const w = rig({ toWorldY: (y) => (600 - y) / 1000 });
  w.down(500, 600);
  w.advance(20); w.move(500, 400);
  ok(near(w.g.worldY, 0.2), 'worldY was not projected through the hook', { worldY: w.g.worldY });
  ok(near(w.g.state().worldY, 0.2), 'worldY missing from the state payload');
  const noHook = rig();
  noHook.down(500, 300);
  ok(noHook.g.worldY === null, 'worldY should be null with no projection hook');
  console.log(`  toWorldY passthrough: pointer 400 -> world ${w.g.worldY} m; null when unhooked`);

  // dispose removes everything it added
  const d = rig();
  const elBefore = d.el.count, rootBefore = d.root.count;
  ok(elBefore > 0 && rootBefore > 0, 'the rig attached no listeners to begin with',
    { elBefore, rootBefore });
  d.g.dispose();
  ok(d.el.count === 0, 'dispose left element listeners behind', { left: d.el.listeners.map((l) => l.type) });
  ok(d.root.count === 0, 'dispose left window listeners behind', { left: d.root.listeners.map((l) => l.type) });
  console.log(`  dispose removed ${elBefore} element + ${rootBefore} window listeners, leaving 0`);

  // tick() is safe when nothing is held
  const idle = rig();
  ok(idle.g.tick() === false, 'tick() acted with no gesture in progress');
  idle.advance(IDLE_RESET_MS * 5);
  ok(idle.g.tick() === false, 'tick() acted with no gesture in progress after a long wait');
  ok(idle.log.rearm.length === 0, 'tick() re-armed with nothing held');
  console.log('  tick() is inert when the coin is not held');
}

// ===========================================================================
console.log('\n=== (9) the gesture cannot reach the outcome ===');
{
  // A structural check, not a behavioural one: the fairness guarantee is that
  // power reaches only the lead-in, the camera and selectVariant's flickForce.
  // The cheapest way for that to break is an innocent-looking import.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../flip3d/grab.js', import.meta.url), 'utf8');
  const banned = ['outcome.js', 'SPIN_VALUES', 'resolveFlip', 'library.js', 'contract.js'];
  const hits = banned.filter((b) => src.includes(b));
  ok(hits.length === 0, 'grab.js references the outcome path', { hits });
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  ok(imports.length === 1 && imports[0] === './power.js',
    'grab.js imports something other than power.js', { imports });
  console.log(`  imports exactly ${JSON.stringify(imports)} and names nothing from the draw`);
}


// ===========================================================================
console.log('\n=== (10) THE GESTURE MEANS THE SAME THING AT EVERY CANVAS SIZE ===');
{
  // An INTEGRATION check, and it lives here because neither module can see the
  // fault from the inside. grab.js measures the pull in CSS px; scene.js bounds
  // the coin's lift in METRES; a canvas-size-dependent projection joins them.
  // Against a fixed 190 px travel, one full lift-and-slam is worth 0.56 power on
  // a 480x300 canvas and 2.02 on a 1920x1080 one — the same motion, three
  // different throws, and resizing the window silently re-tunes the control.
  //
  // Wiring clampY and a travelPx FUNCTION to the lift band fixes that and the
  // invisible-wind-up bug below at once, by making the pull literally equal to
  // the coin's visible travel.
  const bandOf = (rect) => {
    const top = worldYToScreenY(LIFT.maxY, rect);
    const rest = worldYToScreenY(LIFT.minY, rect);
    return { top, rest, travel: rest - top };
  };
  const armed = (b, onThrow) => createGrab(stubTarget('el'), {
    now: () => 0,
    root: stubTarget('root'),
    clampY: (y) => Math.min(Math.max(y, b.top), b.rest),
    travelPx: () => b.travel,
    onThrow,
  });

  const rows = [];
  let worstErr = 0;
  for (const [w, h] of [[480, 300], [880, 550], [1400, 875], [1920, 1080]]) {
    const b = bandOf({ left: 0, top: 0, width: w, height: h });
    let thrown = 0;
    const g = armed(b, (p) => { thrown = p; });
    // pick the coin up off the table, lift to the ceiling, slam it back down
    g._begin(ev(100, b.rest));
    g._move(ev(100, b.top));
    g._finish(ev(100, b.rest));
    g.dispose();
    rows.push({ canvas: `${w}x${h}`, bandPx: +b.travel.toFixed(1), power: +thrown.toFixed(4) });
    worstErr = Math.max(worstErr, Math.abs(thrown - 1));
  }
  console.table(rows);
  ok(worstErr < 1e-9, 'a full lift-and-slam is not 1.0 on every canvas', { worstErr });
  console.log(`  lift to the ceiling, slam to the table = 1.0000 on every canvas (worst error ${worstErr.toExponential(2)})`);

  // the ceiling must not be a place to hide wind-up
  const b = bandOf({ left: 0, top: 0, width: 880, height: 550 });
  let over = 0;
  const g = armed(b, (p) => { over = p; });
  g._begin(ev(100, b.rest));
  g._move(ev(100, b.top - 300));        // pointer driven far above the frame
  g._finish(ev(100, b.rest));
  g.dispose();
  ok(Math.abs(over - 1) < 1e-9, 'driving the pointer past the ceiling banked extra power', { over });
  console.log(`  300 px above the ceiling still throws ${over.toFixed(4)} — wind-up the coin never showed is not bankable`);


  // the floor must be overridable, and the override must actually bite
  const floors = [];
  // 190 px spans 0->1 here, so the boundary sits at floor*190 px: 47.5 px for a
  // 0.25 floor. 40 px must be a put-back and 60 px must be a throw.
  for (const [floor, pull, want] of [[MIN_POWER, 20, 'throw'], [0.25, 20, 'cancel'],
                                     [0.25, 40, 'cancel'], [0.25, 60, 'throw'],
                                     [0.25, 100, 'throw']]) {
    let got = 'none';
    const g3 = createGrab(stubTarget('el'), {
      now: () => 0, root: stubTarget('root'), minPower: floor,
      onThrow: () => { got = 'throw'; }, onCancel: () => { got = 'cancel'; },
    });
    g3._begin(ev(100, 100));
    g3._finish(ev(100, 100 + pull));
    g3.dispose();
    floors.push({ floor, pullPx: pull, power: +(pull / 190).toFixed(3), got, want });
    ok(got === want, 'minPower floor did not gate the release', { floor, pull, got, want });
  }
  console.table(floors);
  console.log('  minPower gates the release; a release under it is a put-back, never a limp throw');

  // a broken travel must not poison power
  let nan = null;
  const g2 = createGrab(stubTarget('el'), {
    now: () => 0, root: stubTarget('root'), travelPx: () => 0, onThrow: (p) => { nan = p; },
  });
  g2._begin(ev(100, 100));
  g2._finish(ev(100, 400));
  g2.dispose();
  ok(Number.isFinite(nan) && nan >= 0 && nan <= 1, 'a zero travelPx produced a non-finite power', { nan });
  console.log(`  travelPx()=0 falls back to the constant; power stays finite (${nan.toFixed(4)})`);
}

// ===========================================================================
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
