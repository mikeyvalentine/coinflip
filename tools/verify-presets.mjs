// tools/verify-presets.mjs
// ---------------------------------------------------------------------------
// Prices the SPREAD / RIDE presets by running THE PAGE'S OWN CODE, not a copy
// of it. The script block is extracted from coinflip-preview.html, evaluated
// against a minimal DOM stub, and its pricing functions are called directly —
// so a formula that drifts in the page cannot pass here.
//
// The thing this exists to catch: RIDE must be priced on the TRUE JOINT
// probability. Side is spin PARITY read against the shown start face, so
// "Heads" beside an even-parity spin line is one call wearing two hats.
// Multiply the marginals and you post 256x on a bet whose honest price is 128x,
// and hand that 2x away every day forever.
//
// Run: node tools/verify-presets.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };
const close = (a, b, t = 1e-9) => Math.abs(a - b) <= t;

// --- the smallest DOM that lets the module finish evaluating ---------------
const mk = () => {
  const e = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    placeholder: '', max: 0, offsetLeft: 0, offsetTop: 0,
    addEventListener() {}, removeEventListener() {}, prepend() {},
    blur() {}, focus() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, remove() {},
    closest() { return e; }, querySelector() { return e; }, querySelectorAll() { return []; },
  };
  return e;
};
const shared = mk();
globalThis.document = {
  querySelector: () => shared, querySelectorAll: () => [],
  createElement: () => mk(), body: shared, addEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// Node 22 already exposes a getter-only globalThis.crypto — nothing to stub.
globalThis.performance = { now: () => 0 };
globalThis.setInterval = () => 0;
globalThis.requestAnimationFrame = () => 0;

const html = await fs.readFile(path.join(ROOT, 'coinflip-preview.html'), 'utf8');
const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
const probe = [
  'globalThis.__T = {',
  '  set bet(v){ bet = v; }, get bet(){ return bet; },',
  '  set mode(v){ betMode = v; }, get mode(){ return betMode; },',
  '  set start(v){ shownStart = v; }, get start(){ return shownStart; },',
  '  placedBets, spreadK, rideProb, rideMult, modeStats, atomsFor, winOf,',
  '  validLine, lineValue, toRot,',
  '  SPIN_VALUES, SPIN_N, EDGE_P, MULT, QUADRANTS,',
  '};',
].join('\n');
const tmp = path.join(ROOT, '_preview_probe.mjs');
await fs.writeFile(tmp, body + '\n' + probe, 'utf8');
await import('file://' + tmp.split(path.sep).join('/'));
await fs.unlink(tmp);
const T = globalThis.__T;
console.log('page script evaluated against the DOM stub\n');

const board = (side, quads, spins) => { T.bet = { side, orientation: quads, spins }; };

// EV over the real atom set, using the page's own winOf
function ev(mode) {
  T.mode = mode;
  const bets = T.placedBets();
  if (!bets.length) return 0;
  let acc = 0;
  if (mode === 'ride') {
    const m = T.rideMult();
    for (const a of T.atomsFor(T.start)) if (bets.every((x) => T.winOf(x, a))) acc += a.p * m;
  } else {
    const K = T.spreadK();
    for (const a of T.atomsFor(T.start)) acc += a.p * K * bets.filter((x) => T.winOf(x, a)).length;
  }
  return acc;
}

console.log('=== (1) RIDE is priced on the JOINT odds, not the product ===');
{
  T.start = 'Heads';
  const rows = [];
  for (const [label, q, sp] of [
    ['Heads + N + exactly 10.0  (20 half-flips, EVEN)', ['NE'], { line: 10, mode: 'exact' }],
    ['Heads + N + exactly 10.5  (21 half-flips, ODD)', ['NE'], { line: 10.5, mode: 'exact' }],
    ['Heads + N', ['NE'], undefined],
    ['Heads alone', undefined, undefined],
  ]) {
    board('Heads', q, sp);
    const bets = T.placedBets();
    const naive = bets.reduce((s, b) => s * b.mult, 1);
    const real = T.rideMult();
    rows.push({
      board: label,
      'multiply the odds': +naive.toFixed(2),
      'RIDE actually pays': +real.toFixed(2),
      'overpay avoided': real > 0 ? +(naive / real).toFixed(2) : 'n/a',
    });
  }
  console.table(rows);

  board('Heads', ['NE'], { line: 10, mode: 'exact' });
  ok(close(T.rideMult(), 128), 'even-parity RIDE is mispriced', { got: T.rideMult(), want: 128 });
  board('Heads', ['NE'], { line: 10.5, mode: 'exact' });
  ok(T.rideProb() === 0, 'a contradictory RIDE should be impossible', { p: T.rideProb() });
  console.log('  Heads + "exactly 10.0" pays 128x, not 256x — calling Heads beside an');
  console.log('  EVEN spin line says nothing new, and the price refuses to pay for it.');
  console.log('  Heads + "exactly 10.5" is a CONTRADICTION (odd flips the face): p = 0.');
}

console.log('\n=== (2) both presets carry the same uniform house edge ===');
{
  const rows = [];
  for (const [label, side, q, sp] of [
    ['sharp   Heads + N + exactly 10.0', 'Heads', ['NE'], { line: 10, mode: 'exact' }],
    ['loose   Heads + NE/SE/SW + 5.0+', 'Heads', ['NE', 'SE', 'SW'], { line: 5, mode: 'gt' }],
    ['side only', 'Heads', undefined, undefined],
  ]) {
    board(side, q, sp);
    const s = ev('spread'); const r = ev('ride');
    rows.push({ board: label, 'SPREAD EV': +s.toFixed(6), 'RIDE EV': +r.toFixed(6) });
    ok(close(s, 1 - T.EDGE_P), 'SPREAD EV is not 1-EDGE_P', { label, s });
    ok(close(r, 1 - T.EDGE_P), 'RIDE EV is not 1-EDGE_P', { label, r });
  }
  console.table(rows);
  console.log(`  every board, both presets: EV = ${(1 - T.EDGE_P).toFixed(3)} — the uniform 0.20% edge holds`);
}

console.log('\n=== (3) the two numbers the player is actually shown ===');
{
  const rows = [];
  for (const [label, side, q, sp] of [
    ['sharp', 'Heads', ['NE'], { line: 10, mode: 'exact' }],
    ['loose', 'Heads', ['NE', 'SE', 'SW'], { line: 5, mode: 'gt' }],
  ]) {
    board(side, q, sp);
    const st = T.modeStats();
    rows.push({
      board: label,
      'SPREAD nothing': (st.spread.nothing * 100).toFixed(1) + '%',
      'SPREAD best': st.spread.best.toFixed(2) + 'x',
      'RIDE nothing': (st.ride.nothing * 100).toFixed(1) + '%',
      'RIDE best': st.ride.best.toFixed(0) + 'x',
    });
    ok(st.ride.nothing >= st.spread.nothing - 1e-12, 'RIDE should never be the safer one', { label });
    ok(st.ride.best >= st.spread.best - 1e-12, 'RIDE should never pay less at the top', { label });
  }
  console.table(rows);
  console.log('  RIDE is always BOTH riskier and better-paying, and both halves of that');
  console.log('  trade are on screen. Showing only the second is what sank the ladder.');
}

console.log('\n=== (4) SPREAD: every call that lands pays the same K ===');
{
  board('Heads', ['NE'], { line: 10, mode: 'exact' });
  T.mode = 'spread';
  const bets = T.placedBets(); const K = T.spreadK();
  const inv = bets.map((b) => 1 / b.mult).reduce((a, c) => a + c, 0);
  ok(close(K, 1 / inv), 'K is not 1/sum(1/mult)', { K, want: 1 / inv });
  const w = bets.map((b) => (1 / b.mult) / inv);
  const pays = bets.map((b, i) => w[i] * b.mult);
  console.table(bets.map((b, i) => ({
    call: b.key, pays: b.mult + 'x',
    'gets staked': (w[i] * 100).toFixed(1) + '%',
    'returns if it lands': pays[i].toFixed(4) + 'x',
  })));
  ok(pays.every((v) => close(v, K)), 'lines do not all return K', { pays, K });
  console.log(`  all three return ${K.toFixed(4)}x — no line can win and leave you poorer`);
}

console.log('\n=== (5) the spin box accepts the format the game PRINTS ===');
{
  // Regression. validLine was /^\d+(\.5)?$/, which rejected "10.0" — the exact
  // string the live counter and the landed-value readout put on screen. So the
  // player read a value off the display, typed it straight back, and got
  // silence: no multiplier, no bet, no reason given. A validator that refuses
  // its own program's output format is never the player's mistake.
  const rows = [];
  for (const [txt, want] of [
    ['10', true], ['10.0', true], ['10.00', true], ['10.5', true], ['9.5', true],
    ['4', true], ['20', true], ['4.0', true], ['20.00', true],
    ['12', false], ['12.0', false], ['3.5', false], ['20.5', false],
    ['10.25', false], ['abc', false], ['', false], ['-5', false], ['1e1', false],
  ]) {
    const got = T.validLine(txt);
    rows.push({ typed: JSON.stringify(txt), accepted: got, expected: want, ok: got === want });
    ok(got === want, 'validLine disagrees', { txt, got, want });
  }
  console.table(rows);

  // and EVERY value the game can display must be typeable back in, exactly
  let bad = 0;
  for (const hf of T.SPIN_VALUES) {
    const shown = T.toRot(hf).toFixed(1);          // exactly what the counter prints
    if (!T.validLine(shown)) { bad++; fail('a displayed spin value is not typeable', { shown }); }
    else if (T.lineValue(shown) !== T.toRot(hf)) { bad++; fail('round-trip changed the line', { shown }); }
  }
  ok(bad === 0, 'some displayed spin values cannot be typed back', { bad });
  console.log(`  all ${T.SPIN_VALUES.length} displayable spin values type back in and round-trip exactly`);
  console.log('  12.0 stays rejected — the median is unattainable by design, not by accident');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
