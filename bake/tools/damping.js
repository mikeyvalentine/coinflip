// damping.js — decide angular damping on evidence, at a sample size that can
// actually see a 2% effect. Angular damping was expected to be the thing that
// stops a thin disc rim-rolling forever; this measures whether it is.
//
// It also matters for TARGETING: Rapier damping is exponential,
// omega(t) = omega0 * exp(-d*t), so d=0.28 over a 0.7 s flight bleeds ~18% of
// the spin. That is not physical air drag, and it biases the analytic
// predictor the bake uses to hit a requested half-flip count.
// Run: node tools/damping.js [n]

import { initRapier, simulateClip, predictHalfFlips } from '../sim.js';
import { classify } from '../classify.js';
import { makeRng } from '../prng.js';
import { LAUNCH } from '../config.js';

await initRapier();
const N = Number(process.argv[2] || 600);

console.log(`n=${N} identical launches per row\n`);
console.log('angDamp  yield%  noSettle  offSurf  edgeLand  medDur  maxDur  predBias%  meanBounce');

for (const d of [0, 0.02, 0.05, 0.10, 0.28, 0.6]) {
  const rng = makeRng('damping-v2', 'launch');   // identical launches every row
  const rejects = new Map();
  let okN = 0, biasSum = 0, biasN = 0, bounceSum = 0;
  const durs = [];
  for (let i = 0; i < N; i++) {
    const p = {
      y0: LAUNCH.y0,
      vy: rng.range(LAUNCH.vyMin, LAUNCH.vyMax),
      omega: rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax),
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
    };
    const sim = simulateClip(p, { phys: { angularDamping: d } });
    const c = classify(sim);
    if (c.ok) {
      okN++; durs.push(c.meta.durationMs); bounceSum += sim.bounces;
      const pred = predictHalfFlips(p.omega, p.y0, p.vy);
      biasSum += (c.meta.halfFlips - pred) / pred; biasN++;
    } else rejects.set(c.reject, (rejects.get(c.reject) || 0) + 1);
  }
  durs.sort((a, b) => a - b);
  const g = (k) => rejects.get(k) || 0;
  console.log(
    `${String(d).padEnd(8)} ${((100 * okN) / N).toFixed(1).padStart(5)}  ` +
    `${String(g('no-settle')).padStart(8)}  ${String(g('off-surface')).padStart(7)}  ` +
    `${String(g('edge-landing')).padStart(8)}  ` +
    `${String(durs[Math.floor(0.5 * durs.length)]).padStart(6)}  ${String(durs[durs.length - 1]).padStart(6)}  ` +
    `${((biasSum / biasN) * 100).toFixed(1).padStart(9)}  ${(bounceSum / okN).toFixed(2).padStart(10)}`);
}

console.log('\nfull reject taxonomy at each setting:');
for (const d of [0, 0.05, 0.28]) {
  const rng = makeRng('damping-v2', 'launch');
  const rejects = new Map();
  for (let i = 0; i < N; i++) {
    const sim = simulateClip({
      y0: LAUNCH.y0,
      vy: rng.range(LAUNCH.vyMin, LAUNCH.vyMax),
      omega: rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax),
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
    }, { phys: { angularDamping: d } });
    const c = classify(sim);
    if (!c.ok) rejects.set(c.reject, (rejects.get(c.reject) || 0) + 1);
  }
  console.log(`  d=${d}:`, Object.fromEntries([...rejects].sort((a, b) => b[1] - a[1])));
}
