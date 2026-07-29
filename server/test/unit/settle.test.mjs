// Settlement arithmetic: the wallet IS the stake, so what comes back IS the
// new wallet. Nothing is left over to carry.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSlip, buildPortions } from '../../src/economy/bets.js';
import { settleNormal, settleBroke, toDayRecord } from '../../src/economy/settle.js';

const flip = {
  startFace: 'Tails',
  side: 'Heads',
  halfFlips: 19,
  rotations: 9.5,
  orientationDeg: 187.42,
  quadrant: 'SW',
  edge: false,
};

test('the whole wallet rides and the new wallet is exactly what came back', () => {
  const slip = normalizeSlip({ side: 'Heads' });
  const { portions } = buildPortions(slip);
  const s = settleNormal({ stake: 137, portions, flip });
  assert.equal(s.lines[0].won, true);
  assert.equal(s.lines[0].risked, 137, 'the entire wallet is at risk');
  assert.equal(s.returned, 274);
  assert.equal(s.walletAfter, 274);
  assert.equal(s.profit, 137);
});

test('a losing wallet goes to 0 — that is the only way it can', () => {
  const slip = normalizeSlip({ side: 'Tails' });
  const { portions } = buildPortions(slip);
  const s = settleNormal({ stake: 5000, portions, flip });
  assert.equal(s.returned, 0);
  assert.equal(s.walletAfter, 0);
  assert.equal(s.profit, -5000);
  assert.equal(s.bust, true);
});

test('the stake splits by the spread weights and the payouts add up exactly', () => {
  const slip = normalizeSlip({
    side: 'Heads',                       // 2x   WIN
    orientation: ['SW', 'NW'],           // 2x   WIN (landed SW)
    spin: { line: 9.5, mode: 'exact' },  // 32x  WIN
    spread: 0.5,
  });
  const { portions } = buildPortions(slip);
  const stake = 900;
  const s = settleNormal({ stake, portions, flip });

  // equal split at t=0.5
  for (const l of s.lines) assert.ok(Math.abs(l.risked - 300) < 1e-9);
  assert.deepEqual(s.lines.map((l) => l.won), [true, true, true]);
  const expected = 300 * 2 + 300 * 2 + 300 * 32;
  assert.equal(s.returned, expected);
  assert.ok(Math.abs(s.multiple - expected / stake) < 1e-12);
  // sum of the parts is the whole
  assert.ok(Math.abs(s.lines.reduce((a, l) => a + l.risked, 0) - stake) < 1e-9);
});

test('a mixed result pays only the lines that won', () => {
  const slip = normalizeSlip({
    side: 'Tails',                        // 2x  LOSS
    orientation: ['SW'],                  // 4x  WIN
    spin: { line: 9.5, mode: 'higher' },  // 2x  LOSS (landed exactly 9.5)
  });
  const { portions } = buildPortions(slip);
  const s = settleNormal({ stake: 300, portions, flip });
  assert.deepEqual(s.lines.map((l) => l.won), [false, true, false]);
  assert.equal(s.returned, 400); // 100 on the 4x
  assert.equal(s.profit, 100);
});

test('the spread moves volatility, never the money on the table', () => {
  const stake = 1000;
  for (const spread of [0, 0.25, 0.5, 0.75, 1]) {
    const slip = normalizeSlip({
      side: 'Heads',
      orientation: ['SW'],
      spin: { line: 9.5, mode: 'exact' },
      spread,
    });
    const { portions } = buildPortions(slip);
    const total = portions.reduce((a, p) => a + p.weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `weights must sum to 1 at spread ${spread}`);
    const s = settleNormal({ stake, portions, flip });
    assert.ok(
      Math.abs(s.lines.reduce((a, l) => a + l.risked, 0) - stake) < 1e-9,
      `the whole stake, and only the stake, is at risk at spread ${spread}`
    );
  }
});

test('money is whole ₿: the settled wallet is always an integer', () => {
  const slip = normalizeSlip({ side: 'Heads', orientation: ['NE', 'SE', 'SW'] }); // 4/3x
  const { portions } = buildPortions(slip);
  for (const stake of [1, 7, 13, 51, 137, 999, 100001]) {
    const s = settleNormal({ stake, portions, flip });
    assert.ok(Number.isInteger(s.walletAfter), `stake ${stake} -> ${s.walletAfter}`);
    assert.ok(s.walletAfter >= 0);
  }
});

test('the day record handed to daringness.js has the shape it documents', () => {
  const slip = normalizeSlip({ side: 'Heads', spin: { line: 9.5, mode: 'exact' } });
  const { portions } = buildPortions(slip);
  const s = settleNormal({ stake: 200, portions, flip });
  const day = toDayRecord({ settlement: s, dateISO: '2026-07-29', bustedYesterday: false });
  assert.equal(day.date, '2026-07-29');
  assert.equal(day.startBalance, 200);
  assert.equal(day.totalStaked, 200);
  assert.equal(day.totalBets, 2);
  for (const b of day.bets) {
    assert.ok(typeof b.stake === 'number' && typeof b.payoutMultiple === 'number' && b.kind);
  }
});

test('the Broke Flip is free, pays 50, and consumes nothing', () => {
  const heads = { ...flip, side: 'Heads' };
  const win = settleBroke({ call: 'Heads', flip: heads });
  assert.equal(win.stake, 0);
  assert.equal(win.walletAfter, 50);
  assert.equal(win.lines[0].free, true);

  const loss = settleBroke({ call: 'Tails', flip: heads });
  assert.equal(loss.walletAfter, 0);
  assert.equal(loss.bust, true);

  assert.throws(() => settleBroke({ call: 'Edge', flip: heads }), /Heads or Tails/);
});
