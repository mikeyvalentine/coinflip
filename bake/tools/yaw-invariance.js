// yaw-invariance.js — the crux experiment for the ORIENTATION axis.
//
// THE HAZARD (this is what the contract correction warned about):
//   The launch imparts a tumble about a fixed horizontal axis a. A rotation of
//   exactly k*pi about a maps the coin's local +X to
//       k even:  +X  (unchanged)      -> settled orientation is 90 deg, ALWAYS
//       k odd :  (cos2psi, 0, sin2psi) -> orientation depends on the heading psi
//   So without intervention, every EVEN half-flip clip piles up on one single
//   orientation value. That is a catastrophic, silent skew of the odds: whole
//   quadrants would be unreachable for half the spin values.
//
// THE FIX:
//   Yaw the coin about Y at launch. The collider is a cylinder, rotationally
//   symmetric about Y, so this cannot change the trajectory — it only relabels
//   the body frame. If that holds, settled orientation is ours to place exactly,
//   and cell coverage on the orientation axis becomes exact rather than lucky.
//
// This file measures both claims instead of assuming them.
// Run: node tools/yaw-invariance.js

import { initRapier, simulateClip, omegaForHalfFlips } from '../sim.js';
import { classify } from '../classify.js';
import { makeRng } from '../prng.js';
import { LAUNCH } from '../config.js';

await initRapier();
const DEG = 180 / Math.PI;

console.log('=== A. THE HAZARD: orientation with yaw0 = 0, over many launches ===');
{
  const rng = makeRng('yaw-v1', 'hazard');
  const evens = [], odds = [];
  for (let i = 0; i < 400; i++) {
    const sim = simulateClip({
      y0: LAUNCH.y0,
      vy: rng.range(LAUNCH.vyMin, LAUNCH.vyMax),
      omega: rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax),
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
      yaw0: 0,
    });
    const c = classify(sim);
    if (!c.ok) continue;
    (c.meta.halfFlips % 2 === 0 ? evens : odds).push(c.meta.orientationDeg);
  }
  const q = (arr) => {
    const h = { N: 0, E: 0, S: 0, W: 0 };
    for (const o of arr) h[o < 90 ? 'N' : o < 180 ? 'E' : o < 270 ? 'S' : 'W']++;
    return h;
  };
  const spread = (arr) => {
    if (arr.length < 2) return NaN;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  };
  console.log(`  EVEN half-flips (n=${evens.length}): quadrants ${JSON.stringify(q(evens))}  sd ${spread(evens).toFixed(1)} deg`);
  console.log(`    sample orientations: ${evens.slice(0, 8).map((v) => v.toFixed(1)).join(', ')}`);
  console.log(`  ODD  half-flips (n=${odds.length}): quadrants ${JSON.stringify(q(odds))}  sd ${spread(odds).toFixed(1)} deg`);
  console.log(`    sample orientations: ${odds.slice(0, 8).map((v) => v.toFixed(1)).join(', ')}`);
}

console.log('\n=== B. IS YAW PHYSICALLY FREE? same launch, 12 different yaw0 ===');
{
  const base = {
    y0: LAUNCH.y0, vy: 2.1, omega: omegaForHalfFlips(21, LAUNCH.y0, 2.1),
    vh: 0.3, psi: 0.7, spinY: 3.0,
  };
  const refSim = simulateClip({ ...base, yaw0: 0 });
  const simRefPos = refSim.finalPos;
  const ref = classify(refSim);
  console.log(`  reference (yaw0=0): ${ref.meta.halfFlips} hf ${ref.meta.side} ` +
    `${ref.meta.durationMs}ms orientation ${ref.meta.orientationDeg}`);
  let maxPosErr = 0, allSame = true;
  const shifts = [];
  for (let k = 1; k < 12; k++) {
    const yaw0 = (k * 2 * Math.PI) / 12;
    const s = simulateClip({ ...base, yaw0 });
    const c = classify(s);
    const same = c.meta.halfFlips === ref.meta.halfFlips && c.meta.side === ref.meta.side &&
      c.meta.durationMs === ref.meta.durationMs;
    if (!same) allSame = false;
    const posErr = Math.hypot(s.finalPos.x - simRefPos.x, s.finalPos.z - simRefPos.z);
    maxPosErr = Math.max(maxPosErr, posErr);
    let d = (ref.meta.orientationDeg - c.meta.orientationDeg + 360) % 360;
    shifts.push({ yaw0Deg: +(yaw0 * DEG).toFixed(1), orient: c.meta.orientationDeg, shift: +d.toFixed(2), same });
  }
  for (const s of shifts) {
    console.log(`   yaw0 ${String(s.yaw0Deg).padStart(5)} deg -> orientation ${String(s.orient).padStart(6)}  ` +
      `(ref - this = ${String(s.shift).padStart(6)})  physics identical: ${s.same}`);
  }
  console.log(`  half-flips/side/duration identical across all yaw0: ${allSame}`);
  console.log(`  max final-position difference: ${maxPosErr.toExponential(2)} m`);
}

console.log('\n=== C. Does a uniform random yaw0 make orientation uniform? ===');
{
  const rng = makeRng('yaw-v1', 'uniform');
  const bins = new Array(12).fill(0);
  const quads = { N: 0, E: 0, S: 0, W: 0 };
  let n = 0;
  const byParity = { even: new Array(4).fill(0), odd: new Array(4).fill(0) };
  for (let i = 0; i < 600; i++) {
    const sim = simulateClip({
      y0: LAUNCH.y0,
      vy: rng.range(LAUNCH.vyMin, LAUNCH.vyMax),
      omega: rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax),
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
      yaw0: rng.range(0, 2 * Math.PI),
    });
    const c = classify(sim);
    if (!c.ok) continue;
    n++;
    bins[Math.floor(c.meta.orientationDeg / 30)]++;
    const qi = Math.floor(c.meta.orientationDeg / 90);
    quads[['N', 'E', 'S', 'W'][qi]]++;
    byParity[c.meta.halfFlips % 2 === 0 ? 'even' : 'odd'][qi]++;
  }
  console.log(`  n=${n}, 30-degree bins: ${bins.join(' ')}`);
  const exp = n / 12;
  const chi = bins.reduce((a, b) => a + (b - exp) ** 2 / exp, 0);
  console.log(`  chi-square vs uniform: ${chi.toFixed(2)} (df=11, 5% critical 19.7)`);
  console.log(`  quadrants: ${JSON.stringify(quads)}`);
  console.log(`  even half-flips by quadrant: ${byParity.even.join(' ')}`);
  console.log(`  odd  half-flips by quadrant: ${byParity.odd.join(' ')}`);
}
