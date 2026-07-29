// tools/verify-clips.mjs — exhaustive check that the procedural clip builder
// lands EXACTLY on the already-decided outcome: right side, right number of
// rotations, right settle orientation (and therefore right quadrant).
// Run: node tools/verify-clips.mjs
import {
  SPIN_VALUES, expectedSide, toRotations, quadrantFromOrientation,
  orientationFromQuat, restQuatForFace, REST_ORIENTATION_DEG,
} from '../flip3d/contract.js';
import { buildProceduralClip, verifyClip } from '../flip3d/clip.js';
import { resolveFlip } from '../flip3d/outcome.js';
import { outcomeBand, POWER_NARROWS_BAND } from '../flip3d/power.js';

const EDGE_ANGLES = [0, 0.01, 44.99, 45, 89.99, 90, 90.01, 179.99, 180, 269.99, 270, 359.99, 123.45, 317.28];

let cases = 0, fails = 0;
const worst = { tilt: 0, orient: 0, dur: 0, travel: 0 };
const failures = [];

for (const startFace of ['Heads', 'Tails']) {
  for (const spins of SPIN_VALUES) {
    for (const orientationDeg of EDGE_ANGLES) {
      const side = expectedSide(startFace, spins);
      const outcome = { startFace, side, spins, orientationDeg, quadrant: quadrantFromOrientation(orientationDeg) };
      const clip = buildProceduralClip(outcome, { seed: `${startFace}|${spins}|${orientationDeg}` });
      const v = verifyClip(clip);
      cases++;
      worst.tilt = Math.max(worst.tilt, v.finalTiltDeg);
      worst.orient = Math.max(worst.orient, Math.abs(v.orientationErrorDeg));
      worst.dur = Math.max(worst.dur, v.durationMs);
      worst.travel = Math.max(worst.travel, v.travelDistM);
      if (!v.pass) {
        fails++;
        if (failures.length < 8) {
          failures.push({ outcome, ok: v.ok, seenHf: v.halfFlipsSeen, gotOrient: v.finalOrientationDeg, gotQuad: v.finalQuadrant, side: v.finalSide });
        }
      }
    }
  }
}

console.log(`exhaustive procedural clips: ${cases} cases, ${fails} failures`);
console.log(`  worst final tilt ${worst.tilt.toExponential(2)} deg | worst orientation error ${worst.orient.toExponential(2)} deg`);
console.log(`  max duration ${worst.dur} ms | max travel ${(worst.travel * 100).toFixed(1)} cm`);
failures.forEach((f) => console.log('  FAIL', JSON.stringify(f)));

// --- driven by real seeds through resolveFlip ------------------------------
let seeded = 0, seededFails = 0;
const quadHist = { N: 0, E: 0, S: 0, W: 0 };
const sideHist = { Heads: 0, Tails: 0 };
for (let i = 0; i < 600; i++) {
  const o = await resolveFlip('seed-' + i);
  const clip = buildProceduralClip(o, { seed: 'seed-' + i });
  const v = verifyClip(clip);
  seeded++;
  quadHist[o.quadrant]++; sideHist[o.side]++;
  if (!v.pass) { seededFails++; if (seededFails < 5) console.log('  SEED FAIL', o, v.ok); }
  if (i < 3) {
    console.log(`  sample seed-${i}: ${o.startFace} -> ${o.side}, spin ${toRotations(o.spins).toFixed(1)}, ` +
      `orientation ${o.orientationDeg.toFixed(2)} (${o.quadrant}) | played back: ${v.halfFlipsSeen} half-flips, ` +
      `${v.finalSide}, ${v.finalOrientationDeg.toFixed(2)} deg (${v.finalQuadrant}), ${v.durationMs}ms, ${v.frames} frames`);
  }
}
console.log(`seeded clips: ${seeded} cases, ${seededFails} failures`);
console.log('  quadrant spread', quadHist, 'side spread', sideHist);

// --- legacy outcome with no orientationDeg (quadrant only) -----------------
let legacyFails = 0;
for (const q of ['NE', 'SE', 'SW', 'NW']) {
  const clip = buildProceduralClip({ startFace: 'Heads', side: 'Heads', spins: 12, quadrant: q }, { seed: 'legacy' + q });
  const v = verifyClip(clip);
  if (!v.pass || v.finalQuadrant !== q) legacyFails++;
}
console.log(`legacy quadrant-only outcomes: ${legacyFails} failures`);

// --- the spin band is inert, and the rest pose faces North -----------------
// Both live in tools/verify-power.mjs in full; these are the tripwires that
// would catch a regression here, in the sweep that already existed.
let regressions = 0;
for (let i = 0; i < 500; i++) {
  const seed = 'band-check-' + i;
  const a = await resolveFlip(seed);
  const b = await resolveFlip(seed, null, { band: outcomeBand(SPIN_VALUES, i / 500) });
  if (a.spins !== b.spins || a.side !== b.side || a.startFace !== b.startFace
    || a.quadrant !== b.quadrant || a.orientationDeg !== b.orientationDeg) regressions++;
}
console.log(`spin band inert over 500 seeds: ${regressions} divergences (POWER_NARROWS_BAND=${POWER_NARROWS_BAND})`);
for (const face of ['Heads', 'Tails']) {
  const deg = orientationFromQuat(restQuatForFace(face));
  if (Math.abs(deg - REST_ORIENTATION_DEG) > 1e-9) { regressions++; console.log(`  FAIL rest pose ${face} reads ${deg}, want ${REST_ORIENTATION_DEG}`); }
}
console.log(`rest pose reads ORIENTATION ${REST_ORIENTATION_DEG} (North) for both faces`);

process.exit(fails + seededFails + legacyFails + regressions ? 1 : 0);
