// yaw-detail.js — exactly HOW free is initial yaw?
// tools/yaw-invariance.js showed the orientation shift tracks yaw0 to ~0.2 deg
// but that "physics identical" was false for most yaw values. That distinction
// decides the bake's architecture, so pin down which field moves and by how
// much. Rapier's cylinder-vs-cuboid contact generation is not perfectly
// rotationally symmetric, so some drift is expected; what matters is whether
// the OUTCOME fields (halfFlips, side) can flip.
// Run: node tools/yaw-detail.js

import { initRapier, simulateClip, omegaForHalfFlips } from '../sim.js';
import { classify } from '../classify.js';
import { makeRng } from '../prng.js';
import { LAUNCH } from '../config.js';

await initRapier();
const DEG = 180 / Math.PI;
const rng = makeRng('yaw-detail-v1', 'launches');

let nCases = 0, hfChanged = 0, sideChanged = 0, durMax = 0, posMax = 0;
let orientErrMax = 0;
const hfDeltas = new Map();

for (let c = 0; c < 60; c++) {
  const base = {
    y0: LAUNCH.y0,
    vy: rng.range(LAUNCH.vyMin, LAUNCH.vyMax),
    omega: rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax),
    vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
    psi: rng.range(0, 2 * Math.PI),
    spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
  };
  const refSim = simulateClip({ ...base, yaw0: 0 });
  const ref = classify(refSim);
  if (!ref.ok) continue;

  for (let k = 1; k < 8; k++) {
    const yaw0 = (k * 2 * Math.PI) / 8;
    const s = simulateClip({ ...base, yaw0 });
    const cc = classify(s);
    nCases++;
    const dHf = cc.meta.halfFlips - ref.meta.halfFlips;
    if (dHf !== 0) { hfChanged++; hfDeltas.set(dHf, (hfDeltas.get(dHf) || 0) + 1); }
    if (cc.meta.side !== ref.meta.side) sideChanged++;
    durMax = Math.max(durMax, Math.abs(cc.meta.durationMs - ref.meta.durationMs));
    posMax = Math.max(posMax, Math.hypot(s.finalPos.x - refSim.finalPos.x, s.finalPos.z - refSim.finalPos.z));
    // predicted orientation = ref - yaw0 (mod 360)
    const predicted = ((ref.meta.orientationDeg - yaw0 * DEG) % 360 + 360) % 360;
    let err = Math.abs(cc.meta.orientationDeg - predicted);
    if (err > 180) err = 360 - err;
    orientErrMax = Math.max(orientErrMax, err);
  }
}

console.log(`cases: ${nCases} (60 launches x 7 non-zero yaw0 values)`);
console.log(`half-flip count changed:      ${hfChanged}/${nCases} (${((100 * hfChanged) / nCases).toFixed(1)}%)  deltas: ${JSON.stringify(Object.fromEntries(hfDeltas))}`);
console.log(`landing side changed:         ${sideChanged}/${nCases} (${((100 * sideChanged) / nCases).toFixed(1)}%)`);
console.log(`max settle-duration drift:    ${durMax} ms`);
console.log(`max final-position drift:     ${(posMax * 1000).toFixed(3)} mm`);
console.log(`max orientation error vs (base - yaw0): ${orientErrMax.toFixed(3)} deg`);
console.log('');
console.log('READ: yaw is a near-free knob for placing orientation, but it is NOT');
console.log('bit-exact, so the bake must classify the run it actually emits rather');
console.log('than inheriting metadata from the probe run.');
