// tools/verify-clean.mjs
// ---------------------------------------------------------------------------
// Headless sweep for the COIN CLEANING minigame (minigame/clean.js). No DOM, no
// canvas, no GPU, no real time — the clock is a variable this file increments by
// hand, which is why the module takes an injectable `now` and fires its hard cap
// from tick() rather than a timer.
//
// What this is here to prove, in order of how much it matters:
//
//   1. THE PAYOUT CAN NEVER BE 0 AND CAN NEVER LEAVE THE BAND. This minigame is
//      the only way back into the game from 0 B. A path through it that pays
//      nothing strands the player forever with the real game permanently out of
//      reach — that is not a balance bug, it is a dead account.
//   2. Cleaning is monotone. Scrubbing must never un-clean, or a player could
//      watch progress go backwards under their own hand.
//   3. A skilled player cannot mint materially more than a poor one. This is the
//      game's ONLY money faucet.
//   4. The dirt is deterministic from its seed, and different seeds differ.
//
// Run: node tools/verify-clean.mjs
// ---------------------------------------------------------------------------

import {
  createClean, makeDirt, payoutFor,
  PAYOUT_MIN, PAYOUT_MAX, CLEAN_ENOUGH, HARD_CAP_MS, DIRT_GRID, BRUSH_RADIUS,
} from '../minigame/clean.js';

let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };
const inBand = (v) => Number.isFinite(v) && v >= PAYOUT_MIN && v <= PAYOUT_MAX;

/** A rig with a clock this file drives. */
function rig(opts = {}) {
  let t = 1000;
  const c = createClean({ now: () => t, ...opts });
  return { c, advance(ms) { t += ms; }, get time() { return t; } };
}

/** Drag a straight line across the coin, in coin-normalised [-1,1] space. */
function stroke(c, x0, y0, x1, y1, steps = 24) {
  for (let s = 0; s <= steps; s++) {
    c.scrubTo(x0 + (x1 - x0) * (s / steps), y0 + (y1 - y0) * (s / steps));
  }
  c.lift();
}

/** A full raster scrub of the whole disc. `spacing` is in coin radii. */
function raster(c, spacing = BRUSH_RADIUS * 0.6, passes = 1) {
  for (let p = 0; p < passes; p++) {
    for (let y = -1; y <= 1.0001; y += spacing) {
      stroke(c, -1.05, y, 1.05, y, 40);
      if (c.done) return;
    }
  }
}

// ===========================================================================
console.log('=== (1) THE ONE THAT MATTERS: the payout can never be 0 ===');
{
  const rows = [];
  const cases = [];

  // never touched at all, then timed out
  {
    const r = rig();
    r.c.tick();                              // no scrub yet: the clock has not started
    const beforeStart = r.c.payout;
    r.advance(HARD_CAP_MS * 3);
    r.c.tick();
    cases.push({ case: 'never touched, waited 60 s', payout: r.c.payout, cleaned: r.c.cleaned, done: r.c.done });
    ok(inBand(beforeStart), 'payout out of band before any scrub', { beforeStart });
    ok(inBand(r.c.payout), 'payout out of band after an untouched timeout', { p: r.c.payout });
  }

  // exactly one stamp
  {
    const r = rig();
    r.c.scrubTo(0, 0);
    cases.push({ case: 'one single stamp', payout: r.c.payout, cleaned: r.c.cleaned, done: r.c.done });
    ok(inBand(r.c.payout), 'payout out of band after one stamp', { p: r.c.payout });
  }

  // barely touched, then the hard cap fires
  {
    const r = rig();
    r.c.scrubTo(0.1, 0.1);
    r.advance(HARD_CAP_MS + 1);
    r.c.tick();
    cases.push({ case: 'one stamp then timeout', payout: r.c.payout, cleaned: r.c.cleaned, done: r.c.done });
    ok(r.c.done, 'the hard cap did not fire from tick()');
    ok(inBand(r.c.payout), 'payout out of band on timeout', { p: r.c.payout });
  }

  // a full clean
  {
    const r = rig();
    raster(r.c, BRUSH_RADIUS * 0.6, 3);
    cases.push({ case: 'full clean', payout: r.c.payout, cleaned: r.c.cleaned, done: r.c.done });
    ok(r.c.done, 'a full raster did not finish the coin', { cleaned: r.c.cleaned });
    ok(r.c.payout === PAYOUT_MAX, 'a completed clean did not pay the ceiling', { p: r.c.payout });
  }

  // genuinely malformed input — not merely absurd. These are broken events.
  {
    const r = rig();
    for (const [x, y] of [[NaN, 0], [0, NaN], [Infinity, 0], [0, -Infinity],
      [undefined, undefined], [null, null]]) {
      r.c.scrubTo(x, y);
    }
    cases.push({ case: 'only malformed input', payout: r.c.payout, cleaned: r.c.cleaned, done: r.c.done });
    ok(inBand(r.c.payout), 'malformed input broke the payout', { p: r.c.payout });
    ok(r.c.cleaned === 0, 'malformed input cleaned the coin', { cleaned: r.c.cleaned });
    ok(!r.c.started, 'a malformed event started the clock', { started: r.c.started });
  }

  // finite but absurd — a real number, nowhere near the coin
  {
    const r = rig();
    for (const [x, y] of [[1e9, 1e9], [-1e9, 0], [0, 1e12]]) r.c.scrubTo(x, y);
    cases.push({ case: 'finite but absurd coords', payout: r.c.payout, cleaned: r.c.cleaned, done: r.c.done });
    ok(inBand(r.c.payout), 'absurd coords broke the payout', { p: r.c.payout });
    ok(r.c.cleaned === 0, 'absurd coords cleaned the coin', { cleaned: r.c.cleaned });
    ok(!r.c.started, 'a scrub a billion units from the coin started the clock', { started: r.c.started });
  }

  // scrubbing entirely off the coin, but plausibly close
  {
    const r = rig();
    stroke(r.c, -3, -3, 3, -3, 50);
    cases.push({ case: 'scrubbed only outside the coin', payout: r.c.payout, cleaned: r.c.cleaned, done: r.c.done });
    ok(r.c.cleaned === 0, 'scrubbing off the coin cleaned it', { cleaned: r.c.cleaned });
    ok(inBand(r.c.payout), 'off-coin scrub broke the payout', { p: r.c.payout });
    ok(!r.c.started, 'scrubbing beside the coin started the clock', { started: r.c.started });
  }

  // ...and touching the coin DOES start it
  {
    const r = rig();
    ok(!r.c.started, 'the clock was running before anything happened');
    r.c.scrubTo(0, 0);
    ok(r.c.started, 'touching the coin did not start the clock');
    console.log('  the clock starts on first CONTACT WITH THE COIN, not on the first');
    console.log('  pointer event — pressing beside it cannot burn the cap silently');
  }

  console.table(cases.map((c) => ({ ...c, cleaned: +c.cleaned.toFixed(4), inBand: inBand(c.payout) })));
  ok(cases.every((c) => inBand(c.payout)), 'some reachable state left the payout band');
  ok(cases.every((c) => c.payout > 0), 'some reachable state paid ZERO — the player would be stranded');
  console.log(`  every reachable state pays inside [${PAYOUT_MIN}, ${PAYOUT_MAX}]. Nothing pays 0.`);
  rows.length = 0;
}

// ===========================================================================
console.log('\n=== (2) payoutFor is total: every double, however broken ===');
{
  const bad = [];
  const probe = [NaN, Infinity, -Infinity, undefined, null, -1, -0.0001, 0, 1e-12,
    0.5, CLEAN_ENOUGH - 1e-9, CLEAN_ENOUGH, 0.99, 1, 1.0001, 1e9, '0.5'];
  const rows = probe.map((v) => {
    const p = payoutFor(v);
    if (!inBand(p)) bad.push({ v: String(v), p });
    return { input: String(v), payout: p, inBand: inBand(p) };
  });
  console.table(rows);
  ok(bad.length === 0, 'payoutFor left the band', { bad });
  ok(payoutFor(0) === PAYOUT_MIN, 'a completely dirty coin does not pay the floor');
  ok(payoutFor(1) === PAYOUT_MAX, 'a perfectly clean coin does not pay the ceiling');
  ok(payoutFor(CLEAN_ENOUGH) === PAYOUT_MAX, 'hitting the threshold does not pay the ceiling');

  // monotone in cleaned
  let mono = true; let prev = -1;
  for (let i = 0; i <= 1000; i++) {
    const p = payoutFor(i / 1000);
    if (p < prev) mono = false;
    prev = p;
  }
  ok(mono, 'payout is not monotone in the cleaned fraction');
  console.log('  payout is monotone in cleaned, and total over every input tried');
}

// ===========================================================================
console.log('\n=== (3) cleaning is monotone, and reaches 1.0 ===');
{
  // cleanEnough above 1 disables completion, which is the only way to watch the
  // fraction run past the threshold all the way to a clear coin.
  const r = rig({ cleanEnough: 2 });
  let prev = 0; let regressions = 0; const track = [];
  for (let pass = 0; pass < 8; pass++) {
    for (let y = -1; y <= 1.0001; y += BRUSH_RADIUS * 0.6) {
      stroke(r.c, -1.05, y, 1.05, y, 40);
      const c = r.c.cleaned;
      if (c < prev - 1e-12) regressions++;
      prev = c;
    }
    track.push({ pass: pass + 1, cleaned: +r.c.cleaned.toFixed(6), payout: r.c.payout });
  }
  console.table(track);
  ok(regressions === 0, 'the cleaned fraction went BACKWARDS under scrubbing', { regressions });
  ok(r.c.cleaned > 0.9999, 'a full scrub never reached a clear coin', { cleaned: r.c.cleaned });
  console.log(`  ${8} raster passes -> cleaned ${r.c.cleaned.toFixed(6)}, zero regressions`);

  // random scribbling must also never un-clean
  const r2 = rig({ cleanEnough: 2 });
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let prev2 = 0; let reg2 = 0;
  for (let i = 0; i < 2000; i++) {
    r2.c.scrubTo(rnd() * 2.4 - 1.2, rnd() * 2.4 - 1.2);
    if (i % 37 === 0) r2.c.lift();
    const c = r2.c.cleaned;
    if (c < prev2 - 1e-12) reg2++;
    prev2 = c;
  }
  ok(reg2 === 0, 'random scribbling un-cleaned the coin', { reg2 });
  console.log(`  2000 random scribbles incl. off-coin: 0 regressions, cleaned ${r2.c.cleaned.toFixed(4)}`);
}

// ===========================================================================
console.log('\n=== (4) the dirt is deterministic, and seeds differ ===');
{
  const a1 = makeDirt(42); const a2 = makeDirt(42); const b = makeDirt(43);
  let same = true; let diffCells = 0; let maxDelta = 0;
  for (let k = 0; k < a1.dirt.length; k++) {
    if (a1.dirt[k] !== a2.dirt[k]) same = false;
    const d = Math.abs(a1.dirt[k] - b.dirt[k]);
    if (d > 1e-6) diffCells++;
    if (d > maxDelta) maxDelta = d;
  }
  ok(same, 'the same seed produced different dirt');
  ok(a1.total === a2.total, 'the same seed produced a different dirt total');
  const share = diffCells / a1.discCells;
  ok(share > 0.5, 'two seeds produced near-identical dirt', { share });
  console.log(`  seed 42 twice: byte-identical (total ${a1.total.toFixed(3)})`);
  console.log(`  seed 42 vs 43: ${(share * 100).toFixed(1)}% of disc cells differ, worst delta ${maxDelta.toFixed(3)}`);
  console.log(`  disc cells ${a1.discCells} of ${DIRT_GRID * DIRT_GRID} (${(100 * a1.discCells / (DIRT_GRID ** 2)).toFixed(1)}% — the coin is a circle)`);

  // dirt must stay inside 0..1, and be absent outside the disc
  let range = true; let leak = 0;
  for (let k = 0; k < a1.dirt.length; k++) {
    if (!(a1.dirt[k] >= 0 && a1.dirt[k] <= 1)) range = false;
    if (!a1.inDisc[k] && a1.dirt[k] !== 0) leak++;
  }
  ok(range, 'dirt escaped 0..1');
  ok(leak === 0, 'dirt was generated outside the coin', { leak });
  ok(makeDirt(NaN).total > 0, 'a NaN seed produced no dirt');
}

// ===========================================================================
console.log('\n=== (5) skill scales the payout, but only just ===');
{
  // A poor player: a few aimless strokes, then the clock runs out.
  const poor = rig();
  stroke(poor.c, -0.5, -0.2, 0.4, 0.3, 20);
  stroke(poor.c, -0.2, 0.5, 0.3, -0.4, 20);
  poor.advance(HARD_CAP_MS + 1);
  poor.c.tick();

  // A middling player: covers most of it.
  const mid = rig();
  raster(mid.c, BRUSH_RADIUS * 1.5, 1);
  mid.advance(HARD_CAP_MS + 1);
  mid.c.tick();

  // A good player: a clean raster.
  const good = rig();
  raster(good.c, BRUSH_RADIUS * 0.6, 3);

  const rows = [
    { player: 'poor (2 aimless strokes, timed out)', cleaned: +poor.c.cleaned.toFixed(3), payout: poor.c.payout },
    { player: 'middling (loose raster)', cleaned: +mid.c.cleaned.toFixed(3), payout: mid.c.payout },
    { player: 'good (tight raster)', cleaned: +good.c.cleaned.toFixed(3), payout: good.c.payout },
  ];
  console.table(rows);
  const ratio = good.c.payout / poor.c.payout;
  ok(ratio <= 1.5 + 1e-9, 'a good player out-earns a poor one by more than the band allows', { ratio });
  ok(poor.c.payout >= PAYOUT_MIN, 'the poor player fell below the floor');
  console.log(`  best-vs-worst payout ratio: ${ratio.toFixed(3)}x  (hard ceiling ${(PAYOUT_MAX / PAYOUT_MIN).toFixed(2)}x by band construction)`);
  console.log('  the band IS the guarantee: no scrub, however good, can mint more than');
  console.log(`  ${PAYOUT_MAX} B, and none, however bad, mints less than ${PAYOUT_MIN}.`);
}

// ===========================================================================
console.log('\n=== (6) how much dragging a clean actually costs ===');
{
  const rows = [];
  for (const seed of [1, 2, 3, 7, 99]) {
    const r = rig({ seed });
    raster(r.c, BRUSH_RADIUS * 0.6, 4);
    rows.push({
      seed,
      finished: r.c.done,
      cleaned: +r.c.cleaned.toFixed(4),
      'drag length (coin radii)': +r.c.strokeLen.toFixed(1),
      payout: r.c.payout,
    });
  }
  console.table(rows);
  const mean = rows.reduce((a, c) => a + c['drag length (coin radii)'], 0) / rows.length;
  ok(rows.every((r) => r.finished), 'some seed could not be finished by a full raster');
  console.log(`  mean drag to finish: ${mean.toFixed(1)} coin radii = ${(mean / 2).toFixed(1)} coin diameters.`);
  console.log('  ASSUMPTION, and it is an assumption: a hand drags roughly 1.5 coin');
  console.log(`  diameters per second on a phone-sized coin, so ~${(mean / 2 / 1.5).toFixed(0)} s to finish.`);
  console.log(`  The ${HARD_CAP_MS / 1000} s hard cap sits above that, which is the point — the cap is`);
  console.log('  a floor under the WORST case, not a target for the average one.');
}

// ===========================================================================
console.log('\n=== (7) state machine housekeeping ===');
{
  const r = rig();
  raster(r.c, BRUSH_RADIUS * 0.6, 3);
  const at = r.c.payout;
  const cleanedAt = r.c.cleaned;
  // scrubbing after the end must change nothing
  for (let i = 0; i < 200; i++) r.c.scrubTo(Math.sin(i) * 0.5, Math.cos(i) * 0.5);
  ok(r.c.payout === at, 'the payout moved after the game ended', { at, now: r.c.payout });
  ok(r.c.cleaned === cleanedAt, 'the coin kept cleaning after the game ended');
  ok(r.c.scrubTo(0, 0) === false, 'scrubTo reported success after the game ended');
  console.log('  post-completion scrubbing is inert; the payout is frozen at completion');

  // reset returns it to the start
  r.c.reset(5);
  ok(r.c.cleaned === 0 && !r.c.done && !r.c.started, 'reset did not clear the state');
  ok(inBand(r.c.payout), 'reset left the payout out of band');
  console.log('  reset() clears cleaned, done, the clock and the stroke');

  // tick before any scrub must not start or finish anything
  const r2 = rig();
  for (let i = 0; i < 10; i++) { r2.advance(HARD_CAP_MS); r2.c.tick(); }
  ok(!r2.c.done, 'the hard cap fired before the player ever touched the coin');
  console.log('  the clock starts on the first scrub, so an idle coin never times out');
}

// ===========================================================================
// Everything above tests the MODULE. Everything below tests the module as it is
// actually wired into the game — a different thing, and the only one a player
// ever touches.
// ===========================================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load coinflip-preview.html's module against a DOM stub and hand back its guts. */
async function loadPreview() {
  const mk = () => {
    const cls = new Set();
    const e = {
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)),
        remove: (...c) => c.forEach((x) => cls.delete(x)),
        toggle: (c, f) => (f === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : (f ? cls.add(c) : cls.delete(c))),
        contains: (c) => cls.has(c),
      },
      style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
      placeholder: '', max: 0, offsetLeft: 0, offsetTop: 0, width: 0, height: 0,
      addEventListener() {}, removeEventListener() {}, prepend() {}, blur() {}, focus() {},
      setAttribute() {}, getAttribute: () => null, appendChild() {}, remove() {},
      setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 260, height: 260 }),
      closest() { return e; }, querySelector() { return e; }, querySelectorAll: () => [],
    };
    return e;
  };
  const sh = mk();
  globalThis.document = {
    querySelector: () => sh, querySelectorAll: () => [], createElement: mk,
    body: sh, addEventListener() {},
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.performance = { now: () => 0 };
  globalThis.setInterval = () => 0;
  globalThis.requestAnimationFrame = () => 0;

  const html = await fs.readFile(path.join(ROOT, 'coinflip-preview.html'), 'utf8');
  const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const probe = [
    'globalThis.__G = {',
    '  get player(){ return player; }, set player(v){ player = v; },',
    '  get clean(){ return clean; }, set clean(v){ clean = v; },',
    '  get day(){ return day; }, set day(v){ day = v; },',
    '  set timerEnd(v){ timerEnd = v; },',
    '  startClean, canClean, cleanPayout, refresh, timerRunning,',
    '  createClean, payoutFor, makeDirt, CLEAN_ENOUGH, PAYOUT_MIN, PAYOUT_MAX, HARD_CAP_MS,',
    '};',
  ].join('\n');
  const tmp = path.join(ROOT, '_clean_probe.mjs');
  await fs.writeFile(tmp, body + '\n' + probe, 'utf8');
  await import('file://' + tmp.split(path.sep).join('/'));
  await fs.unlink(tmp);
  return globalThis.__G;
}

const G = await loadPreview();

console.log('\n=== (8) THE INLINED COPY CANNOT DRIFT FROM THE MODULE ===');
{
  // The page is self-contained by requirement, so clean.js is copied into it.
  // A copy that drifts on the game's ONLY money faucet pays the wrong amount
  // forever and nothing goes red. This compares the two implementations
  // directly rather than trusting the build step that made them.
  let worstPay = 0;
  for (let i = 0; i <= 2000; i++) {
    const c = i / 2000;
    const a = payoutFor(c); const b = G.payoutFor(c);
    worstPay = Math.max(worstPay, Math.abs(a - b));
  }
  ok(worstPay === 0, 'the inlined payoutFor disagrees with the module', { worstPay });

  ok(G.PAYOUT_MIN === PAYOUT_MIN && G.PAYOUT_MAX === PAYOUT_MAX
     && G.CLEAN_ENOUGH === CLEAN_ENOUGH && G.HARD_CAP_MS === HARD_CAP_MS,
  'an inlined constant drifted from the module',
  { inlined: [G.PAYOUT_MIN, G.PAYOUT_MAX, G.CLEAN_ENOUGH, G.HARD_CAP_MS],
    module: [PAYOUT_MIN, PAYOUT_MAX, CLEAN_ENOUGH, HARD_CAP_MS] });

  // same seed must give byte-identical dirt, or the two are different games
  let cells = 0; let bad = 0;
  for (const seed of [1, 7, 99, 12345, -3]) {
    const a = makeDirt(seed); const b = G.makeDirt(seed);
    if (a.grid !== b.grid || a.discCells !== b.discCells) { bad++; continue; }
    for (let k = 0; k < a.dirt.length; k++) { cells++; if (a.dirt[k] !== b.dirt[k]) bad++; }
  }
  ok(bad === 0, 'the inlined dirt generator diverges from the module', { bad, cells });
  console.log(`  2001 payout inputs, 0 mismatches; ${cells} dirt cells over 5 seeds, ${bad} mismatches`);
}

console.log('\n=== (9) bust -> scrub -> back in the game ===');
{
  const raster2 = (c) => {
    for (let y = -1; y <= 1.0001; y += BRUSH_RADIUS * 0.6) {
      for (let s = 0; s <= 40; s++) c.scrubTo(-1.05 + 2.1 * (s / 40), y);
      c.lift();
      if (c.done) return;
    }
  };
  G.player = { balance: 0, bank: 0, history: [] };
  G.day = 0;
  G.timerEnd = 0;                                  // cooldown not running
  G.startClean();
  ok(G.clean != null, 'no scrub was started on the broke screen');
  ok(G.canClean(), 'cleaning is refused at 0 B with the timer at 00');

  raster2(G.clean);
  ok(G.clean.done, 'a full raster did not finish the clean');
  const paid = G.clean.payout;
  await G.cleanPayout();

  ok(G.player.balance >= PAYOUT_MIN && G.player.balance <= PAYOUT_MAX,
    'the payout landed outside the band', { balance: G.player.balance });
  ok(G.player.balance === paid, 'the wallet did not receive the locked payout',
    { balance: G.player.balance, paid });
  ok(G.player.bank === 0, 'the payout went to the BANK — it must be riskable');
  ok(G.player.history.length === 1, 'the clean did not consume a day',
    { days: G.player.history.length });
  ok(G.player.history[0].kind !== 'broke', 'the old broke-flip record shape survived');
  ok(!G.canClean(), 'still cleanable after being paid — the faucet is open');
  console.log(`  0 B -> full clean -> ${G.player.balance} B in the WALLET, 1 day spent, board restored`);
}

console.log('\n=== (10) nobody is ever stranded ===');
{
  // The failure this exists to prevent: a player who cannot or does not finish
  // is left at 0 B with the real game permanently out of reach. Walking away
  // mid-scrub must still pay, and the hard cap is what makes that true.
  let t = 1000;
  G.player = { balance: 0, bank: 0, history: [] };
  G.day = 0; G.timerEnd = 0;
  G.clean = G.createClean({ seed: 42, now: () => t });

  G.clean.scrubTo(0, 0);                           // one touch, then walk away
  t += HARD_CAP_MS + 1;
  ok(G.clean.tick(), 'the hard cap never fired on an abandoned scrub');
  await G.cleanPayout();
  ok(G.player.balance >= PAYOUT_MIN,
    'an abandoned scrub stranded the player at 0 B', { balance: G.player.balance });
  console.log(`  one touch then abandoned -> ${G.player.balance} B, never stranded`);

  // and the extreme: the coin is never touched at all
  t = 1000;
  G.player = { balance: 0, bank: 0, history: [] };
  G.day = 0; G.timerEnd = 0;
  G.clean = G.createClean({ seed: 7, now: () => t });
  t += HARD_CAP_MS * 5;
  G.clean.tick();
  // untouched, the clock never started, so the cap cannot fire — the player is
  // still ON the broke screen with the coin in front of them, which is correct.
  // What must NOT happen is a payout of 0 if they then finish.
  G.clean.finish();
  await G.cleanPayout();
  ok(G.player.balance >= PAYOUT_MIN,
    'finishing an untouched coin paid nothing', { balance: G.player.balance });
  console.log(`  never touched, then finished -> ${G.player.balance} B (floor is ${PAYOUT_MIN})`);
}

console.log('\n=== (11) the daily-flip gate holds in LOGIC ===');
{
  // Cleaning IS the daily flip. The rule implemented: you cannot clean while
  // the cooldown timer runs, which is the same gate doFlip() uses. Enforced in
  // canClean() rather than by CSS, because pointer-events:none stops a mouse
  // and not a synthetic event — a real bank-during-flip bug came from exactly
  // that mistake.
  G.player = { balance: 0, bank: 0, history: [] };
  G.day = 0;
  G.timerEnd = Date.now() + 60000;                 // cooldown running
  ok(!G.canClean(), 'cleaning is allowed while the cooldown runs');

  G.startClean();
  for (let s = 0; s <= 40; s++) G.clean.scrubTo(-1 + 2 * (s / 40), 0);
  G.clean.finish();
  await G.cleanPayout();
  ok(G.player.balance === 0, 'a clean paid out while the cooldown was running',
    { balance: G.player.balance });
  ok(G.player.history.length === 0, 'a gated clean still spent a day');
  console.log('  cooldown running: the scrub cannot pay, and cannot spend the day');

  // with money in the wallet, cleaning is not available at all
  G.player = { balance: 100, bank: 0, history: [] };
  G.timerEnd = 0;
  ok(!G.canClean(), 'cleaning is available to a player who is not broke');
  console.log('  wallet above 0: busker mode is unreachable, so it cannot be farmed');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
