// The fairness guarantee, at the server layer.
//
// ../../../test.js proves it for the shared identity module. This file proves
// the SERVER's own derivation does the same job: outcomes are uniform, identity
// enters the seed as provenance and cannot steer a cell, and the server's
// WebCrypto port is byte-identical to the node implementation in identity.js
// and fingerprint.js — so the two can never quietly drift apart.

import test from 'node:test';
import assert from 'node:assert/strict';

// the project's originals (node:crypto) — read only, never modified
import { assembleIdentity as nodeAssemble, deriveFlipSeed as nodeDeriveSeed } from '../../../identity.js';
import { computeFingerprint as nodeFingerprint } from '../../../fingerprint.js';

// the server's WebCrypto port
import {
  assembleIdentity,
  deriveFlipSeed,
  computeFingerprint,
  canonicalizeSignals,
} from '../../src/economy/identity.js';
import { resolveFlip } from '../../src/economy/outcome.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import { SPIN_N, SPIN_ROTATION_VALUES, QUADRANTS } from '../../src/economy/constants.js';

const SALT = 'server-side-secret-salt';

const SIGNALS_A = { userAgent: 'DeviceA', timezone: 'UTC', webglRenderer: 'GPU-A', canvasHash: 'aaa' };
const SIGNALS_B = { userAgent: 'DeviceB', timezone: 'PST', webglRenderer: 'GPU-B', canvasHash: 'bbb', languages: ['en', 'fr'] };

// --- parity with the shared modules ----------------------------------------

test('the server fingerprint is byte-identical to fingerprint.js', async () => {
  for (const signals of [SIGNALS_A, SIGNALS_B, {}, { userAgent: null, deviceMemory: 8 }]) {
    assert.equal(
      await computeFingerprint(signals, SALT),
      nodeFingerprint(signals, SALT),
      `fingerprint mismatch for ${JSON.stringify(signals)}`
    );
  }
  assert.ok(canonicalizeSignals(SIGNALS_B).includes('languages:en,fr'), 'arrays join with commas');
});

test('the server identity hash is byte-identical to identity.js', async () => {
  for (const daringness of [0, 0.1234, 0.5, 0.87, 1]) {
    const fingerprintHex = await computeFingerprint(SIGNALS_A, SALT);
    const mine = await assembleIdentity({ daringness, fingerprintHex });
    const theirs = nodeAssemble({ daringness, fingerprintHex });
    assert.equal(mine.identityHex, theirs.identityHex, `daringness ${daringness}`);
    assert.equal(mine.daringBucket, theirs.daringBucket);
  }
});

test('the server flip seed is byte-identical to deriveFlipSeed in identity.js', async () => {
  const fingerprintHex = await computeFingerprint(SIGNALS_B, SALT);
  const identity = nodeAssemble({ daringness: 0.73, fingerprintHex });
  for (const clockMs of [0, 1_700_000_000_000, 1_785_000_000_123]) {
    for (const flickHex of ['', 'deadbeef', 'a1b2c3d4e5f6']) {
      assert.equal(
        await deriveFlipSeed({ identityHex: identity.identityHex, clockMs, flickHex, serverSalt: SALT }),
        nodeDeriveSeed({ identity, clockMs, flickHex, serverSalt: SALT }),
        `seed mismatch at clock ${clockMs} flick "${flickHex}"`
      );
    }
  }
});

// --- determinism, which is what makes the proof checkable -------------------

test('the same committed inputs always reproduce the same flip', async () => {
  const seed = await deriveFlipSeed({
    identityHex: 'a'.repeat(64),
    clockMs: 1_785_000_000_000,
    flickHex: 'cafe',
    serverSalt: SALT,
  });
  const first = await resolveFlip(seed, 'Heads');
  const again = await resolveFlip(seed, 'Heads');
  assert.deepEqual(first, again);

  // and a different salt gives a different flip: the salt genuinely decides
  const otherSeed = await deriveFlipSeed({
    identityHex: 'a'.repeat(64),
    clockMs: 1_785_000_000_000,
    flickHex: 'cafe',
    serverSalt: SALT + '!',
  });
  const other = await resolveFlip(otherSeed, 'Heads');
  assert.notEqual(otherSeed, seed);
  assert.ok(
    other.halfFlips !== first.halfFlips || other.orientationDeg !== first.orientationDeg,
    'changing the salt must change the outcome'
  );
});

test('the landing side is the start face flipped once per half-flip', async () => {
  for (let i = 0; i < 300; i++) {
    const seed = await sha256Hex(`parity::${i}`);
    for (const startFace of ['Heads', 'Tails']) {
      const flip = await resolveFlip(seed, startFace);
      const expected = flip.halfFlips % 2 === 0 ? startFace : startFace === 'Heads' ? 'Tails' : 'Heads';
      assert.equal(flip.side, expected);
      assert.equal(flip.rotations, flip.halfFlips / 2);
      assert.ok(SPIN_ROTATION_VALUES.includes(flip.rotations));
    }
  }
});

// --- uniformity -------------------------------------------------------------

async function distribution(identityHex, n) {
  const cells = new Array(SPIN_N).fill(0);
  const quads = Object.fromEntries(QUADRANTS.map((q) => [q, 0]));
  let heads = 0;
  for (let i = 0; i < n; i++) {
    // a fresh flick moment and a fresh salt every flip, as in a real round
    const clockMs = 1_785_000_000_000 + i * 137;
    const flickHex = (await sha256Hex(`flick::${identityHex}::${i}`)).slice(0, 16);
    const salt = await sha256Hex(`salt::${i}`);
    const seed = await deriveFlipSeed({ identityHex, clockMs, flickHex, serverSalt: salt });
    const flip = await resolveFlip(seed, i % 2 === 0 ? 'Heads' : 'Tails');
    cells[SPIN_ROTATION_VALUES.indexOf(flip.rotations)]++;
    quads[flip.quadrant]++;
    if (flip.side === 'Heads') heads++;
  }
  return { cells, quads, headsRate: heads / n };
}

function chiSquare(counts, n) {
  const expected = n / counts.length;
  return counts.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
}

test('outcomes stay uniform for wildly different identities', async () => {
  const N = Number(process.env.FAIRNESS_SAMPLES ?? 60_000);

  // a cautious grinder on one device, a degenerate on another
  const grinder = await assembleIdentity({
    daringness: 0.05,
    fingerprintHex: await computeFingerprint(SIGNALS_A, SALT),
  });
  const degen = await assembleIdentity({
    daringness: 0.97,
    fingerprintHex: await computeFingerprint(SIGNALS_B, SALT),
  });
  assert.notEqual(grinder.identityHex, degen.identityHex);

  for (const [name, identity] of [['grinder', grinder], ['degen', degen]]) {
    const d = await distribution(identity.identityHex, N);
    const chi = chiSquare(d.cells, N);
    const quadChi = chiSquare(QUADRANTS.map((q) => d.quads[q]), N);
    console.log(
      `      ${name}: heads ${d.headsRate.toFixed(4)}  spin chi2 ${chi.toFixed(1)} (df=31)  quad chi2 ${quadChi.toFixed(2)} (df=3)`
    );
    // df=31: p=0.001 critical value is ~62, so 70 catches any real skew
    assert.ok(chi < 70, `${name} spin distribution is not uniform (chi2 ${chi})`);
    assert.ok(quadChi < 20, `${name} quadrants are not uniform (chi2 ${quadChi})`);
    assert.ok(Math.abs(d.headsRate - 0.5) < 0.01, `${name} heads rate skewed: ${d.headsRate}`);
  }
});

test('IDENTITY CANNOT STEER A CELL: holding the flip fixed and varying only the player', async () => {
  // Same flick moment, same flick entropy, same salt. The ONLY thing changing
  // is who is flipping — across the whole daringness range and many devices.
  // If identity could bias the outcome, this is where it would show.
  const N = Number(process.env.IDENTITY_SAMPLES ?? 20_000);
  const clockMs = 1_785_000_000_000;
  const flickHex = 'a1b2c3d4';
  const salt = await sha256Hex('fixed-round-salt');

  const cells = new Array(SPIN_N).fill(0);
  let heads = 0;
  let daringSum = 0;
  let daringHeads = 0;

  for (let i = 0; i < N; i++) {
    const daringness = (i % 101) / 100; // sweep 0.00 .. 1.00
    const fingerprintHex = await sha256Hex(`device::${i}`);
    const identity = await assembleIdentity({ daringness, fingerprintHex });
    const seed = await deriveFlipSeed({ identityHex: identity.identityHex, clockMs, flickHex, serverSalt: salt });
    const flip = await resolveFlip(seed, 'Heads');
    cells[SPIN_ROTATION_VALUES.indexOf(flip.rotations)]++;
    if (flip.side === 'Heads') {
      heads++;
      daringHeads += daringness;
    }
    daringSum += daringness;
  }

  const chi = chiSquare(cells, N);
  const headsRate = heads / N;
  // if daring players got heads more often, the mean daringness among heads
  // would drift away from the population mean
  const meanDaring = daringSum / N;
  const meanDaringGivenHeads = daringHeads / heads;
  console.log(
    `      identity sweep: heads ${headsRate.toFixed(4)}  chi2 ${chi.toFixed(1)}  ` +
      `mean daringness ${meanDaring.toFixed(4)} vs among-heads ${meanDaringGivenHeads.toFixed(4)}`
  );

  assert.ok(chi < 70, `varying identity alone skewed the cells (chi2 ${chi})`);
  assert.ok(Math.abs(headsRate - 0.5) < 0.015, `varying identity alone skewed the side: ${headsRate}`);
  assert.ok(
    Math.abs(meanDaringGivenHeads - meanDaring) < 0.02,
    `daringness correlates with the outcome: ${meanDaringGivenHeads} vs ${meanDaring}`
  );
});
