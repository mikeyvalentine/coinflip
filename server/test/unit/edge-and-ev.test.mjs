// The Edge: it sweeps, it pays 499 on 500, and it is the ONLY source of house
// edge — which is why that edge is exactly 0.20% on every bet in the game.
//
// This file proves the claim two independent ways: analytically over every bet
// shape, and empirically by settling real flips.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSlip, buildPortions, spinCoverage, resolvePortion, spreadWeights } from '../../src/economy/bets.js';
import { settleNormal, settleBroke } from '../../src/economy/settle.js';
import { resolveFlip } from '../../src/economy/outcome.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import {
  EDGE_P,
  MULT_EDGE,
  HOUSE_EDGE,
  SPIN_N,
  QUADRANTS,
  SPIN_ROTATION_VALUES,
} from '../../src/economy/constants.js';

const FAIR_RTP = 1 - HOUSE_EDGE; // 0.998

// Every bet in the game is priced pool/covered, and every non-Edge bet loses on
// a rim landing. So its EV is (1 - 1/500) * (covered/pool) * (pool/covered).
function analyticRtp({ covered, pool }) {
  return (1 - EDGE_P) * (covered / pool) * (pool / covered);
}

test('every bet shape carries exactly the same 0.20% house edge', () => {
  // side: 1 of 2
  assert.ok(Math.abs(analyticRtp({ covered: 1, pool: 2 }) - FAIR_RTP) < 1e-15);
  // orientation: 1..3 of 4 (4 of 4 is a refund, not a bet)
  for (const q of [1, 2, 3]) {
    assert.ok(Math.abs(analyticRtp({ covered: q, pool: 4 }) - FAIR_RTP) < 1e-15, `${q} quadrants`);
  }
  // spin: every coverage the pool can actually produce
  const coverages = new Set();
  for (const line of SPIN_ROTATION_VALUES) {
    for (const mode of ['exact', 'higher', 'lower']) {
      const c = spinCoverage(line, mode);
      if (c > 0) coverages.add(c);
    }
  }
  assert.ok(coverages.size > 10, 'sanity: many distinct spin coverages exist');
  for (const c of coverages) {
    assert.ok(Math.abs(analyticRtp({ covered: c, pool: SPIN_N }) - FAIR_RTP) < 1e-15, `coverage ${c}`);
  }
  // and the Edge itself, priced N-1 on N exactly like roulette prices its zero
  assert.ok(Math.abs(EDGE_P * MULT_EDGE - FAIR_RTP) < 1e-15);
  assert.equal(MULT_EDGE, 499);
  assert.ok(Math.abs(HOUSE_EDGE - 0.002) < 1e-15);
});

test('the risk-spread slider cannot change the edge at any position', () => {
  const mults = [2, 4, 32];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const w = spreadWeights(mults, Math.min(1, t));
    const sum = w.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12, `weights must sum to 1 at t=${t}`);
    // EV = sum_i w_i * p_i * m_i, and p_i * m_i is the same 0.998 for every i
    const ev = w.reduce((acc, wi) => acc + wi * FAIR_RTP, 0);
    assert.ok(Math.abs(ev - FAIR_RTP) < 1e-12, `EV drifted at t=${t}: ${ev}`);
  }
});

test('t = 0.5 is the plain equal split; the ends concentrate on short and long odds', () => {
  const mults = [2, 4, 32];
  const mid = spreadWeights(mults, 0.5);
  for (const w of mid) assert.ok(Math.abs(w - 1 / 3) < 1e-12);

  const low = spreadWeights(mults, 0); // alpha = -2, piles onto the 2x
  assert.ok(low[0] > low[1] && low[1] > low[2]);
  const high = spreadWeights(mults, 1); // alpha = +2, pushes out to the 32x
  assert.ok(high[2] > high[1] && high[1] > high[0]);
});

// --- the sweep --------------------------------------------------------------

const rimFlip = {
  startFace: 'Heads',
  side: 'Heads',
  halfFlips: 20,
  rotations: 10,
  orientationDeg: 12.5,
  quadrant: 'NE',
  edge: true,
};

test('a rim landing sweeps side, orientation AND spin even when each one "won"', () => {
  // deliberately construct a slip that matches the flip on every axis
  const slip = normalizeSlip({ side: 'Heads', orientation: ['NE'], spin: { line: 10, mode: 'exact' } });
  const { portions } = buildPortions(slip);
  assert.equal(portions.length, 3);

  for (const p of portions) {
    assert.equal(resolvePortion(p, rimFlip), false, `${p.key} must be swept`);
    // and each of them WOULD have won had the coin not landed on its rim
    assert.equal(resolvePortion(p, { ...rimFlip, edge: false }), true, `${p.key} sanity`);
  }

  const settlement = settleNormal({ stake: 1000, portions, flip: rimFlip });
  assert.equal(settlement.returned, 0);
  assert.equal(settlement.walletAfter, 0);
  assert.equal(settlement.bust, true);
  assert.equal(settlement.swept, true);
});

test('calling the Edge is the only thing that can win on a rim landing', () => {
  const { portions } = buildPortions(normalizeSlip({ side: 'Edge' }));
  assert.equal(resolvePortion(portions[0], rimFlip), true);
  assert.equal(resolvePortion(portions[0], { ...rimFlip, edge: false }), false);

  const settlement = settleNormal({ stake: 50, portions, flip: rimFlip });
  assert.equal(settlement.returned, 50 * 499);
  assert.equal(settlement.swept, false);
});

test('the Broke Flip is swept by the rim too, and pays exactly 50 otherwise', () => {
  const heads = { ...rimFlip, edge: false, side: 'Heads' };
  assert.equal(settleBroke({ call: 'Heads', flip: heads }).walletAfter, 50);
  assert.equal(settleBroke({ call: 'Tails', flip: heads }).walletAfter, 0);
  // called it right, but the coin landed on its rim
  assert.equal(settleBroke({ call: 'Heads', flip: rimFlip }).walletAfter, 0);
  // and it never costs anything
  assert.equal(settleBroke({ call: 'Heads', flip: heads }).stake, 0);
});

// --- empirical --------------------------------------------------------------

test('settled flips return 0.998 of the stake over a large sample', async () => {
  const N = Number(process.env.EV_SAMPLES ?? 60_000);
  const slip = normalizeSlip({ side: 'Heads', orientation: ['NE', 'SE'], spin: { line: 11.5, mode: 'higher' } });
  const { portions } = buildPortions(slip);
  const stake = 1_000_000; // large, so integer rounding cannot bias the result

  let staked = 0;
  let returned = 0;
  for (let i = 0; i < N; i++) {
    const seed = await sha256Hex(`ev-sample::${i}`);
    const flip = await resolveFlip(seed, i % 2 === 0 ? 'Heads' : 'Tails');
    const s = settleNormal({ stake, portions, flip });
    staked += stake;
    returned += s.returnedExact;
  }
  const rtp = returned / staked;
  // 3 sigma on this mix at N=60k is well under 1.5%
  assert.ok(
    Math.abs(rtp - FAIR_RTP) < 0.02,
    `realised RTP ${rtp.toFixed(5)} should sit at ${FAIR_RTP} (house edge 0.2%)`
  );
  console.log(`      realised RTP over ${N} flips: ${rtp.toFixed(5)} (target ${FAIR_RTP})`);
});

test('the rim comes up about 1 in 500 and its quadrants are uniform', async () => {
  const N = Number(process.env.EDGE_SAMPLES ?? 200_000);
  let edges = 0;
  const quads = Object.fromEntries(QUADRANTS.map((q) => [q, 0]));
  for (let i = 0; i < N; i++) {
    const seed = await sha256Hex(`edge-rate::${i}`);
    const flip = await resolveFlip(seed, 'Heads');
    if (flip.edge) edges++;
    quads[flip.quadrant]++;
  }
  const rate = edges / N;
  const sd = Math.sqrt((EDGE_P * (1 - EDGE_P)) / N);
  assert.ok(
    Math.abs(rate - EDGE_P) < 4 * sd,
    `edge rate ${rate} should be within 4 sigma of ${EDGE_P} (sd ${sd.toFixed(6)})`
  );
  const expected = N / 4;
  const chi = QUADRANTS.reduce((a, q) => a + (quads[q] - expected) ** 2 / expected, 0);
  assert.ok(chi < 16.3, `quadrant chi-square ${chi.toFixed(2)} (df=3) should be small`);
  console.log(`      rim rate over ${N} flips: 1 in ${Math.round(1 / rate)} (target 1 in 500)`);
});
