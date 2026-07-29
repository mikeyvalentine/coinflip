// sim/selftest.mjs
// ---------------------------------------------------------------------------
// The simulation has to earn the right to be believed before it is allowed to
// say anything about the economy. A wrong simulation is worse than none,
// because it looks authoritative — so this file checks the ported rules against
// arithmetic that does NOT share their code path, and population.mjs refuses to
// print an economic finding until it passes.
//
// The important discipline here: every check compares the sim to CLOSED FORM or
// to a combinatorial count, never to another part of the sim. A model validated
// against itself proves only that it is self-consistent.
//
// Run: node sim/selftest.mjs
// ---------------------------------------------------------------------------

import { makeRng } from '../bake/prng.js';
import {
  SPIN_VALUES, SPIN_N, EDGE_P, MULT, QUADS, WALLET_FLOOR,
  spreadWeights, portions, resolveFlip, winOf, returnedFor, settleFlip,
  spinPool, countFor, spinMultFor, evOf, winProbOf, bankMax, toRot,
} from './economy.js';

let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };
const f4 = (n) => +n.toFixed(4);

// A 3-sigma band on a Monte-Carlo mean. Stated explicitly rather than eyeballed,
// so a "close enough" that is actually a bug cannot slide through.
const se = (sd, n) => sd / Math.sqrt(n);

export const BETS = {
  sideOnly:   { side: 'Heads', orient: [], spins: null },
  edgeOnly:   { side: 'Edge', orient: [], spins: null },
  oneQuad:    { side: 'Heads', orient: ['NE'], spins: null },
  twoQuad:    { side: 'Tails', orient: ['NE', 'SE'], spins: null },
  threeQuad:  { side: 'Heads', orient: ['NE', 'SE', 'SW'], spins: null },
  allQuad:    { side: 'Heads', orient: ['NE', 'SE', 'SW', 'NW'], spins: null },
  exactSpin:  { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } },
  higherSpin: { side: 'Heads', orient: ['SE'], spins: { line: 11.5, mode: 'gt' } },
  lowerSpin:  { side: 'Tails', orient: ['SW'], spins: { line: 6, mode: 'lt' } },
  wide:       { side: 'Tails', orient: ['NE', 'SE'], spins: { line: 4.5, mode: 'gt' } },
};

// ===========================================================================
console.log('=== (1) the spin ladder is what the design says it is ===');
{
  ok(SPIN_N === 32, 'SPIN_N is not 32', { SPIN_N });
  ok(!SPIN_VALUES.includes(24), 'the median 24 is still in the ladder');
  const even = SPIN_VALUES.filter((s) => s % 2 === 0).length;
  const odd = SPIN_N - even;
  // This is the load-bearing claim behind "P(same side as start) = 0.500
  // exactly". Parity of the half-flip count decides whether the coin lands on
  // the face it started on, so an unbalanced ladder would tilt the side bet.
  ok(even === 16 && odd === 16, 'the ladder parity is unbalanced', { even, odd });
  console.log(`  32 values, 8..40 excluding 24, ${even} even / ${odd} odd -> P(same side as start) = 0.5 exactly`);

  // spin pricing is a pure count: 32 / (values covered)
  const pool = spinPool();
  ok(pool.length === 32, 'pool is not 32 long');
  ok(spinMultFor(9.5, 'exact', pool) === 32, 'an exact line is not 32x');
  ok(spinMultFor(11.5, 'gt', pool) === 2, '11.5 higher is not 2x', { m: spinMultFor(11.5, 'gt', pool) });
  ok(spinMultFor(16, 'gt', pool) === 4, '16 higher is not 4x', { m: spinMultFor(16, 'gt', pool) });
  ok(spinMultFor(6, 'lt', pool) === 8, '6 lower is not 8x', { m: spinMultFor(6, 'lt', pool) });
  ok(spinMultFor(20, 'gt', pool) === 0, '20 higher covers something');
  ok(spinMultFor(4, 'lt', pool) === 0, '4 lower covers something');
  console.log('  pricing spot-checks match the design doc: 9.5=32x, 11.5 higher=2x, 16 higher=4x, 6 lower=8x');
}

// ===========================================================================
console.log('\n=== (2) spread weights are a probability vector at every t ===');
{
  let worst = 0, negative = 0;
  const setsTried = [];
  for (const bet of Object.values(BETS)) {
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const port = portions(bet, t);
      if (!port.length) continue;
      const sum = port.reduce((s, x) => s + x.w, 0);
      worst = Math.max(worst, Math.abs(sum - 1));
      if (port.some((x) => x.w < 0)) negative++;
      setsTried.push(port.length);
    }
  }
  ok(worst < 1e-12, 'spread weights do not sum to 1', { worst });
  ok(negative === 0, 'a spread weight went negative', { negative });
  console.log(`  ${setsTried.length} (bet, t) combinations: worst |sum(w) - 1| = ${worst.toExponential(2)}`);

  // and the midpoint really is the equal split the comment claims
  const eq = spreadWeights([2, 4, 32], 0.5);
  ok(eq.every((w) => Math.abs(w - 1 / 3) < 1e-12), 't=0.5 is not the equal split', { eq });
  console.log('  t=0.5 gives exactly the equal split (1/3 each on a 3-bet board)');
}

// ===========================================================================
console.log('\n=== (3) ANALYTIC EV IS EXACTLY 1 - EDGE_P, for every bet shape and every t ===');
{
  // The design's central claim, in closed form. Each portion's EV is
  // w * mult * P(win); every axis is priced so mult * P(win) = (1 - EDGE_P);
  // weights sum to 1; so the total is (1 - EDGE_P) no matter how it is split.
  let worst = 0, worstAt = null;
  const rows = [];
  for (const [name, bet] of Object.entries(BETS)) {
    let worstForBet = 0;
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const port = portions(bet, t);
      if (!port.length) continue;            // allQuad with no live bet
      const ev = evOf(port, bet);
      const err = Math.abs(ev - (1 - EDGE_P));
      if (err > worst) { worst = err; worstAt = { name, t }; }
      worstForBet = Math.max(worstForBet, err);
    }
    const port = portions(bet, 0.5);
    rows.push({
      bet: name,
      portions: port.length,
      mults: port.map((x) => +x.mult.toFixed(2)).join(' '),
      'EV(t=0.5)': port.length ? f4(evOf(port, bet)) : '—',
      'worst err over t': worstForBet.toExponential(1),
    });
  }
  console.table(rows);
  ok(worst < 1e-12, 'analytic EV is not 1 - EDGE_P', { worst, worstAt });
  console.log(`  worst deviation from ${1 - EDGE_P} across all shapes and all t: ${worst.toExponential(2)}`);
}

// ===========================================================================
console.log('\n=== (4) ZERO-EDGE CONTROL: with EDGE_P = 0 the game is exactly fair ===');
{
  // If the sim has an accounting bug, it will almost certainly NOT land on
  // exactly 1.0 here. This is the strongest single check in the file.
  const N = 2_000_000;
  const rng = makeRng('selftest', 'zero-edge');
  const bet = BETS.exactSpin;
  const port = portions(bet, 0.5);
  ok(Math.abs(evOf(port, bet, 0) - 1) < 1e-12, 'analytic zero-edge EV is not 1');

  let sum = 0, sumSq = 0;
  for (let i = 0; i < N; i++) {
    const flip = resolveFlip(rng, 0);            // edgeP = 0
    const r = returnedFor(port, bet, flip, 1);
    sum += r; sumSq += r * r;
  }
  const mean = sum / N;
  const sd = Math.sqrt(sumSq / N - mean * mean);
  const err = se(sd, N);
  ok(Math.abs(mean - 1) < 3 * err, 'zero-edge empirical EV is not 1', { mean, err3: 3 * err });
  console.log(`  ${N.toLocaleString()} flips, EDGE_P=0: EV = ${mean.toFixed(5)} +/- ${(3 * err).toFixed(5)} (3 sigma), want 1.00000`);
}

// ===========================================================================
console.log('\n=== (5) empirical EV matches closed form at the real EDGE_P ===');
{
  const N = 1_000_000;
  const rows = [];
  let bad = 0;
  for (const [name, bet] of Object.entries(BETS)) {
    const port = portions(bet, 0.5);
    if (!port.length) continue;
    const rng = makeRng('selftest', 'ev::' + name);
    let sum = 0, sumSq = 0;
    for (let i = 0; i < N; i++) {
      const flip = resolveFlip(rng);
      const r = returnedFor(port, bet, flip, 1);
      sum += r; sumSq += r * r;
    }
    const mean = sum / N;
    const sd = Math.sqrt(Math.max(sumSq / N - mean * mean, 0));
    const err3 = 3 * se(sd, N);
    const want = evOf(port, bet);
    const within = Math.abs(mean - want) <= err3;
    if (!within) { bad++; fail('empirical EV outside 3 sigma of closed form', { name, mean, want, err3 }); }
    rows.push({ bet: name, empirical: f4(mean), analytic: f4(want), '3sigma': +err3.toFixed(4), ok: within });
  }
  console.table(rows);
  console.log(`  ${Object.keys(BETS).length - 1} shapes x ${N.toLocaleString()} flips: ${bad} outside 3 sigma`);
}

// ===========================================================================
console.log('\n=== (6) the draw is uniform where the design says it is ===');
{
  const N = 4_000_000;
  const rng = makeRng('selftest', 'uniform');
  const quad = Object.fromEntries(QUADS.map((q) => [q, 0]));
  const spinCount = new Map(SPIN_VALUES.map((s) => [s, 0]));
  let heads = 0, sameAsStart = 0, edges = 0;
  for (let i = 0; i < N; i++) {
    const f = resolveFlip(rng);
    quad[f.quadrant]++;
    spinCount.set(f.spins, spinCount.get(f.spins) + 1);
    if (f.side === 'Heads') heads++;
    if (f.side === f.startFace) sameAsStart++;
    if (f.edge) edges++;
  }
  const pHeads = heads / N, pSame = sameAsStart / N, pEdge = edges / N;
  const err3 = 3 * se(0.5, N);
  ok(Math.abs(pHeads - 0.5) < err3, 'P(Heads) is not 0.5', { pHeads });
  ok(Math.abs(pSame - 0.5) < err3, 'P(same side as start) is not 0.5', { pSame });
  ok(Math.abs(pEdge - EDGE_P) < 3 * se(Math.sqrt(EDGE_P * (1 - EDGE_P)), N), 'P(edge) is not 1/500', { pEdge });
  // chi-square over the 32 spin values and the 4 quadrants
  const chi = (counts, k) => counts.reduce((s, c) => s + (c - N / k) ** 2 / (N / k), 0);
  const chiSpin = chi([...spinCount.values()], 32);
  const chiQuad = chi(QUADS.map((q) => quad[q]), 4);
  ok(chiSpin < 61.7, 'spin ladder is not uniform (chi2 df=31, 1% = 52.2, using 0.1% = 61.7)', { chiSpin });
  ok(chiQuad < 16.3, 'quadrants are not uniform (chi2 df=3, 0.1% = 16.3)', { chiQuad });
  console.log(`  ${N.toLocaleString()} flips: P(Heads) ${pHeads.toFixed(5)}, P(same as start) ${pSame.toFixed(5)}, P(edge) ${pEdge.toFixed(5)} (want ${EDGE_P})`);
  console.log(`  chi2 spin ${chiSpin.toFixed(1)} (df=31), chi2 quadrant ${chiQuad.toFixed(1)} (df=3)`);
}

// ===========================================================================
console.log('\n=== (7) the incremental settlement matches the closed form ===');
{
  // returnedFor() deliberately uses the preview's running-total arithmetic. It
  // must still agree with sum(w * mult * won) to floating-point noise, or one of
  // the two is wrong.
  const rng = makeRng('selftest', 'settle');
  let worst = 0;
  for (const bet of Object.values(BETS)) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const port = portions(bet, t);
      if (!port.length) continue;
      for (let i = 0; i < 20000; i++) {
        const flip = resolveFlip(rng);
        const inc = returnedFor(port, bet, flip, 1000);
        const closed = port.reduce((s, x) => s + (winOf(x, bet, flip) ? x.w * 1000 * x.mult : 0), 0);
        worst = Math.max(worst, Math.abs(inc - closed));
      }
    }
  }
  ok(worst < 1e-9, 'incremental and closed-form settlement disagree', { worst });
  console.log(`  worst |incremental - closed form| on a 1000 stake: ${worst.toExponential(2)}`);
}

// ===========================================================================
console.log('\n=== (8) the Edge sweeps, and only Edge survives it ===');
{
  const bet = BETS.wide;
  const port = portions(bet, 0.5);
  const edgeFlip = { startFace: 'Heads', side: 'Heads', spins: 9, orientationDeg: 10, quadrant: 'NE', edge: true };
  // Asserted on the SETTLED BALANCE, not on the raw return. `sum(w) - 1` is
  // exactly 0 here, but the preview's incremental running total subtracts three
  // portions one at a time and the accumulation order leaves ~1.1e-13 on a 1000
  // stake. Bar was `=== 0` first and failed on exactly that. The residue is not
  // a defect and cannot become one: it scales linearly with the stake, so it
  // would need a stake around 5e15 to reach the 0.5 that changes a rounded
  // balance, and doubles lose integer precision long before then. What the
  // player experiences is the rounded balance, so that is what is checked.
  const sweptResidue = returnedFor(port, bet, edgeFlip, 1000);
  ok(settleFlip(port, bet, edgeFlip, 1000) === 0, 'a rim landing did not sweep the board');
  ok(sweptResidue < 1e-9, 'the sweep residue is larger than float noise', { sweptResidue });
  const edgeBet = BETS.edgeOnly;
  const edgePort = portions(edgeBet, 0.5);
  ok(edgePort.length === 1 && edgePort[0].w === 1, 'Edge does not take the whole stake', { edgePort });
  ok(returnedFor(edgePort, edgeBet, edgeFlip, 1000) === 499000, 'Edge did not pay 499x on a rim landing');
  ok(returnedFor(edgePort, edgeBet, { ...edgeFlip, edge: false }, 1000) === 0, 'Edge paid on a non-rim landing');
  console.log(`  rim landing settles a 3-axis board to 0 (raw residue ${sweptResidue.toExponential(1)} on a 1000 stake); Edge alone pays 499x, only on the rim`);

  // covering all four quadrants is a refund, not a bet — it must not appear
  const allPort = portions(BETS.allQuad, 0.5);
  ok(allPort.every((x) => x.key !== 'orient'), 'a 4-quadrant refund was priced as a bet', { allPort });
  console.log('  4 selected quadrants (1x) is excluded from the spread, as designed');
}

// ===========================================================================
console.log('\n=== (9) banking can never breach the floor ===');
{
  let bad = 0;
  for (let b = 0; b <= 5000; b += 7) {
    const max = bankMax(b);
    if (b - max < WALLET_FLOOR && max > 0) bad++;
    if (max < 0) bad++;
  }
  ok(bad === 0, 'bankMax allows the wallet below the floor', { bad });
  ok(bankMax(50) === 0 && bankMax(49) === 0 && bankMax(0) === 0, 'bankMax is non-zero at or under the floor');
  ok(bankMax(1000) === 950, 'bankMax is wrong above the floor', { v: bankMax(1000) });
  console.log(`  wallet never drops below ${WALLET_FLOOR} by banking, at any balance 0..5000`);
}

// ===========================================================================
console.log(failures === 0 ? '\nSELF-TESTS PASSED' : `\n${failures} SELF-TEST(S) FAILED`);
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  process.exit(failures === 0 ? 0 : 1);
}
export const selfTestFailures = failures;
