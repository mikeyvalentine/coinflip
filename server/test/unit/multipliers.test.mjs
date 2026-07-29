// Multiplier maths, proved by exhaustion rather than by example.
// Every valid line, every mode, every quadrant count — no sampling.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spinCoverage,
  spinMultiplier,
  orientationMultiplier,
  sideMultiplier,
  isValidLine,
  buildPortions,
  normalizeSlip,
  totalMultiple,
} from '../../src/economy/bets.js';
import {
  SPIN_ROTATION_VALUES,
  SPIN_N,
  ROT_MIN,
  ROT_MAX,
  ROT_MEDIAN,
  MULT_EDGE,
  EDGE_P,
  QUADRANTS,
} from '../../src/economy/constants.js';

// every 0.5 step in 4..20, including the unattainable 12
const ALL_STEPS = [];
for (let v = ROT_MIN; v <= ROT_MAX; v += 0.5) ALL_STEPS.push(v);

test('the spin pool is exactly 32 rotations, 4..20 in 0.5 steps, 12 unattainable', () => {
  assert.equal(SPIN_N, 32);
  assert.equal(SPIN_ROTATION_VALUES.length, 32);
  assert.equal(SPIN_ROTATION_VALUES[0], 4);
  assert.equal(SPIN_ROTATION_VALUES.at(-1), 20);
  assert.ok(!SPIN_ROTATION_VALUES.includes(ROT_MEDIAN), '12 must not be attainable');
  assert.equal(ALL_STEPS.length, 33, '33 steps exist, one of which (12) is removed');
  // parity: 16 even half-flips, 16 odd -> P(same side as start) is exactly 0.5
  const even = SPIN_ROTATION_VALUES.filter((r) => (r * 2) % 2 === 0).length;
  assert.equal(even, 16);
  // and 16 outcomes sit either side of the median, so higher/lower is a clean 50/50
  assert.equal(SPIN_ROTATION_VALUES.filter((v) => v < ROT_MEDIAN).length, 16);
  assert.equal(SPIN_ROTATION_VALUES.filter((v) => v > ROT_MEDIAN).length, 16);
});

test('line validation accepts every 0.5 step in range except 12, and nothing else', () => {
  for (const v of ALL_STEPS) {
    assert.equal(isValidLine(v), v !== ROT_MEDIAN, `line ${v}`);
  }
  for (const v of [3.5, 20.5, 4.25, 9.1, -1, NaN, Infinity, '9.5', null]) {
    assert.equal(isValidLine(v), false, `line ${v} must be rejected`);
  }
});

test('spin multiplier is pool/covered for EVERY line and mode', () => {
  for (const line of ALL_STEPS) {
    if (line === ROT_MEDIAN) continue;
    for (const mode of ['exact', 'higher', 'lower']) {
      const bruteForce = SPIN_ROTATION_VALUES.filter((v) =>
        mode === 'higher' ? v > line : mode === 'lower' ? v < line : v === line
      ).length;
      assert.equal(spinCoverage(line, mode), bruteForce, `${mode} ${line} coverage`);
      const expected = bruteForce ? SPIN_N / bruteForce : 0;
      assert.equal(spinMultiplier(line, mode), expected, `${mode} ${line} multiplier`);
    }
  }
});

test('an exact call always covers exactly one outcome, so it always pays 32x', () => {
  for (const line of SPIN_ROTATION_VALUES) {
    assert.equal(spinCoverage(line, 'exact'), 1);
    assert.equal(spinMultiplier(line, 'exact'), 32);
  }
});

test('a line on the median-adjacent steps splits 16/16 -> exactly 2x each way', () => {
  assert.equal(spinMultiplier(11.5, 'higher'), 2);
  assert.equal(spinMultiplier(12.5, 'lower'), 2);
});

test('orientation is 4 / quadrants selected', () => {
  assert.equal(orientationMultiplier(['N']), 4);
  assert.equal(orientationMultiplier(['N', 'E']), 2);
  assert.equal(orientationMultiplier(['N', 'E', 'S']), 4 / 3);
  assert.equal(orientationMultiplier(QUADRANTS), 1);
});

test('side is 2x and the Edge is 499x', () => {
  assert.equal(sideMultiplier('Heads'), 2);
  assert.equal(sideMultiplier('Tails'), 2);
  assert.equal(sideMultiplier('Edge'), MULT_EDGE);
  assert.equal(MULT_EDGE, 499);
  assert.equal(EDGE_P, 1 / 500);
});

test('selecting all four quadrants is a refund and is NOT treated as a bet', () => {
  const slip = normalizeSlip({ side: 'Heads', orientation: ['N', 'E', 'S', 'W'] });
  const { portions, ignored } = buildPortions(slip);
  assert.deepEqual(portions.map((p) => p.key), ['side']);
  assert.deepEqual(ignored, [{ key: 'orientation', reason: 'refund_not_a_bet' }]);
  // and with nothing else placed, there is nothing at risk at all
  const only = buildPortions(normalizeSlip({ orientation: QUADRANTS }));
  assert.equal(only.portions.length, 0);
});

test('calling the Edge stakes the whole wallet on the rim, alone', () => {
  const { portions } = buildPortions(normalizeSlip({ side: 'Edge' }));
  assert.equal(portions.length, 1);
  assert.equal(portions[0].mult, 499);
  assert.equal(portions[0].weight, 1);
  assert.throws(
    () => normalizeSlip({ side: 'Edge', orientation: ['N'] }),
    /edge_is_exclusive|whole wallet/i
  );
});

test('a bet covering nothing is refused, not silently swallowed', () => {
  assert.throws(() => normalizeSlip({ spin: { line: 4, mode: 'lower' } }), /covers no outcome/i);
  assert.throws(() => normalizeSlip({ spin: { line: 20, mode: 'higher' } }), /covers no outcome/i);
  assert.throws(() => normalizeSlip({ spin: { line: 12, mode: 'exact' } }), /bad_spin_line|0.5 step/i);
});

test('the total multiple is the weighted average of the rows, never the sum', () => {
  const slip = normalizeSlip({ side: 'Heads', orientation: ['N'], spin: { line: 9.5, mode: 'exact' } });
  const { portions } = buildPortions(slip); // 2x, 4x, 32x at the equal split
  const total = totalMultiple(portions);
  assert.ok(Math.abs(total - (2 + 4 + 32) / 3) < 1e-12, `expected the average, got ${total}`);
  assert.ok(total < 2 + 4 + 32);
});
