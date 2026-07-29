// test.js — validates the two things that MUST be true:
//   (A) identity feeds provenance but the outcome stays UNIFORM (the fairness
//       guarantee — the whole ethic of the design)
//   (B) daringness behaves like a slow, earned trait

import { computeDaringness, daringnessLabel } from './daringness.js';
import { buildIdentity, deriveFlipSeed, selectOutcomeCell, selectVariant, visualSignature } from './identity.js';

const SALT = 'server-side-secret-salt';
const CELLS = 24; // 2 sides x 12 rotation counts

// --- helpers to synthesize player histories --------------------------------

function day(date, { start, staked, mult = 2.05, busted = false, edge = 0, bets = 1 }) {
  const end = start - staked + staked * (Math.random() < 0.5 ? 0 : mult);
  return {
    date, startBalance: start, endBalance: end, totalStaked: staked,
    bets: Array.from({ length: bets }, () => ({ stake: staked / bets, payoutMultiple: mult, kind: 'x' })),
    bustedYesterday: busted, edgeBets: edge, totalBets: bets,
  };
}

function makeHistory(n, gen) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(2026, 0, 1 + i).toISOString().slice(0, 10);
    out.push(gen(d, i));
  }
  return out;
}

// A cautious grinder: small stake fraction, even-money bets, never busts.
const grinder = makeHistory(30, (d) => day(d, { start: 1000, staked: 80, mult: 2.05 }));
// A degenerate: huge stake fraction, long-shot bets, edge lottery, volatile.
const degen = makeHistory(30, (d, i) =>
  day(d, { start: 500 + (i % 5) * 400, staked: 480, mult: 18, edge: 2, bets: 4 }));

// ===========================================================================
console.log('=== (B) Daringness is an earned, separating trait ===');
const g = computeDaringness(grinder);
const de = computeDaringness(degen);
console.log(`grinder : ${g.value.toFixed(3)}  (${daringnessLabel(g.value)})`);
console.log(`degen   : ${de.value.toFixed(3)}  (${daringnessLabel(de.value)})`);
console.assert(de.value > g.value + 0.2, 'FAIL: degen should score well above grinder');
console.log('facet breakdown (degen):', Object.fromEntries(
  Object.entries(de.facets).map(([k, v]) => [k, +v.toFixed(2)])));

console.log('\n=== (B) Trait is SLOW: one wild day barely moves a grinder ===');
const grinderPlusOneWildDay = [
  ...grinder.slice(0, 29),
  day('2026-01-30', { start: 1000, staked: 1000, mult: 28, edge: 3, bets: 5 }),
];
const gShift = computeDaringness(grinderPlusOneWildDay, g.value);
console.log(`grinder before: ${g.value.toFixed(3)} -> after one wild day: ${gShift.value.toFixed(3)}`);
console.assert(Math.abs(gShift.value - g.value) < 0.08, 'FAIL: trait moved too much on one day');

console.log('\n=== (B) Cold start sits neutral, not zero ===');
const fresh = computeDaringness([]);
console.log(`new player: ${fresh.value.toFixed(3)} (${daringnessLabel(fresh.value)})`);
console.assert(Math.abs(fresh.value - 0.5) < 0.001, 'FAIL: cold start should be neutral 0.5');

// ===========================================================================
console.log('\n=== (A) THE FAIRNESS GUARANTEE: outcome stays uniform regardless of identity ===');

const signalsA = { userAgent: 'DeviceA', timezone: 'UTC', webglRenderer: 'GPU-A', canvasHash: 'aaa' };
const signalsB = { userAgent: 'DeviceB', timezone: 'PST', webglRenderer: 'GPU-B', canvasHash: 'bbb' };

// Build two very different identities: cautious grinder on device A,
// wild degen on device B.
const idGrinder = buildIdentity({ history: grinder, signals: signalsA, serverSalt: SALT });
const idDegen   = buildIdentity({ history: degen,   signals: signalsB, serverSalt: SALT });

function outcomeDistribution(identity, n) {
  const counts = new Array(CELLS).fill(0);
  let heads = 0;
  for (let i = 0; i < n; i++) {
    // simulate the flick: fresh clock + gesture entropy every flip
    const clockMs = 1_700_000_000_000 + i * 137 + Math.floor(Math.random() * 1000);
    const flickHex = (Math.random().toString(16) + Math.random().toString(16)).slice(2, 18);
    const seed = deriveFlipSeed({ identity, clockMs, flickHex, serverSalt: SALT });
    const cell = selectOutcomeCell(seed, CELLS);
    counts[cell]++;
    if (cell < CELLS / 2) heads++; // first half of cells = heads, by convention
  }
  return { counts, headsRate: heads / n };
}

const N = 200_000;
const distG = outcomeDistribution(idGrinder, N);
const distD = outcomeDistribution(idDegen, N);

// Chi-square against uniform for each — identity must NOT skew the cells.
function chiSquareUniform(counts, n) {
  const expected = n / counts.length;
  return counts.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
}
const chiG = chiSquareUniform(distG.counts, N);
const chiD = chiSquareUniform(distD.counts, N);
// df = 23, critical value ~35.2 at p=0.05, ~41.6 at p=0.01
console.log(`grinder-identity heads rate: ${distG.headsRate.toFixed(4)} (want ~0.5000)`);
console.log(`degen-identity   heads rate: ${distD.headsRate.toFixed(4)} (want ~0.5000)`);
console.log(`grinder-identity chi-square: ${chiG.toFixed(2)} (df=23, expect < ~35)`);
console.log(`degen-identity   chi-square: ${chiD.toFixed(2)} (df=23, expect < ~35)`);
console.assert(Math.abs(distG.headsRate - 0.5) < 0.005, 'FAIL: grinder identity skewed heads');
console.assert(Math.abs(distD.headsRate - 0.5) < 0.005, 'FAIL: degen identity skewed heads');
console.assert(chiG < 50 && chiD < 50, 'FAIL: outcome distribution not uniform');

console.log('\n=== (A) Same person+device -> STABLE visual signature (meaning shows here) ===');
const sigG1 = visualSignature(idGrinder);
const idGrinderAgain = buildIdentity({ history: grinder, signals: signalsA, serverSalt: SALT });
const sigG2 = visualSignature(idGrinderAgain);
console.log('grinder signature:', { hue: sigG1.hue, cam: sigG1.cameraStyle, launch: +sigG1.launchCharacter.toFixed(3) });
console.log('degen   signature:', (() => { const s = visualSignature(idDegen); return { hue: s.hue, cam: s.cameraStyle, launch: +s.launchCharacter.toFixed(3) }; })());
console.assert(JSON.stringify(sigG1) === JSON.stringify(sigG2), 'FAIL: signature not stable for same identity');
console.assert(sigG1.hue !== visualSignature(idDegen).hue || sigG1.cameraStyle !== visualSignature(idDegen).cameraStyle, 'WARN: identities produced same signature');

console.log('\n=== (A) Variant selection: daring player gets more violent variant of SAME outcome ===');
const cellVariants = Array.from({ length: 12 }, (_, i) => ({ id: `clip${i}`, energy: i / 11 }));
const seedX = deriveFlipSeed({ identity: idDegen, clockMs: 1_700_000_000_777, flickHex: 'abc', serverSalt: SALT });
const tame = selectVariant(cellVariants, { daringness: 0.1, flickForce: 0.1, seedHex: seedX });
const wild = selectVariant(cellVariants, { daringness: 0.95, flickForce: 0.9, seedHex: seedX });
console.log(`cautious pick energy: ${tame.energy.toFixed(2)}  |  daring pick energy: ${wild.energy.toFixed(2)}`);
console.assert(wild.energy > tame.energy, 'FAIL: daring should skew to higher-energy variant');

console.log('\nAll assertions passed if no FAIL printed above.');
