// controls.js — negative controls + parameter sensitivity.
// Every tuning choice in config.js should be defensible. This proves each one
// is load-bearing by breaking it on purpose and showing the failure appear.
// Run: node tools/controls.js [nPerCase]

import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier, simulateClip } from '../sim.js';
import { classify } from '../classify.js';
import { makeRng } from '../prng.js';
import { LAUNCH, PHYS, COIN, CLASSIFY } from '../config.js';

await initRapier();
const N = Number(process.argv[2] || 120);

function batch(label, { phys = {}, spinYMax = LAUNCH.spinYMax } = {}) {
  const rng = makeRng('controls-v1', label);
  const rejects = new Map();
  let okN = 0, durSum = 0, bounceSum = 0, hfSum = 0;
  const durs = [];
  for (let i = 0; i < N; i++) {
    const sim = simulateClip({
      y0: LAUNCH.y0,
      vy: rng.range(LAUNCH.vyMin, LAUNCH.vyMax),
      omega: rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax),
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-spinYMax, spinYMax),
    }, { phys });
    const c = classify(sim);
    if (c.ok) { okN++; durs.push(c.meta.durationMs); durSum += c.meta.durationMs; bounceSum += sim.bounces; hfSum += c.meta.halfFlips; }
    else rejects.set(c.reject, (rejects.get(c.reject) || 0) + 1);
  }
  durs.sort((a, b) => a - b);
  return {
    label,
    yield: (100 * okN) / N,
    medDur: durs.length ? durs[Math.floor(durs.length / 2)] : NaN,
    maxDur: durs.length ? durs[durs.length - 1] : NaN,
    bounces: okN ? bounceSum / okN : NaN,
    meanHf: okN ? hfSum / okN : NaN,
    rejects: Object.fromEntries([...rejects].sort((a, b) => b[1] - a[1])),
  };
}

function show(r) {
  console.log(`  ${r.label.padEnd(30)} yield ${r.yield.toFixed(1).padStart(5)}%  ` +
    `medDur ${String(Math.round(r.medDur)).padStart(4)}ms  maxDur ${String(Math.round(r.maxDur)).padStart(4)}ms  ` +
    `bounces ${r.bounces.toFixed(1)}  ` + JSON.stringify(r.rejects));
}

console.log('=== CONTROL 1: is angular damping actually needed? ===');
console.log('(a thin disc rim-rolls forever without it — expect no-settle to appear at 0)');
for (const d of [0, 0.05, 0.15, 0.28, 0.5, 1.0]) {
  show(batch(`angularDamping=${d}`, { phys: { angularDamping: d } }));
}

console.log('\n=== CONTROL 2: is CCD actually needed? ===');
console.log('(1.5 mm disc at up to 3 m/s vs the table; test against a THIN floor)');
{
  // Reproduce the tunnelling failure directly: thin floor, CCD on vs off.
  for (const ccd of [true, false]) {
    let through = 0;
    const rng = makeRng('controls-v1', `ccd${ccd}`);
    for (let i = 0; i < N; i++) {
      const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      w.timestep = 1 / 60;   // the naive timestep a renderer would use
      const g = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.0005, 0));
      w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.0005, 0.5), g);  // 1 mm thin floor
      const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 0.25, 0).setLinvel(0, -rng.range(3, 6), 0).setCcdEnabled(ccd));
      w.createCollider(RAPIER.ColliderDesc.cylinder(COIN.halfHeight, COIN.radius).setDensity(COIN.density), b);
      for (let s = 0; s < 120; s++) w.step();
      if (b.translation().y < -0.05) through++;
      w.free();
    }
    console.log(`  ccd=${String(ccd).padEnd(5)} tunnelled through the floor: ${through}/${N}`);
  }
}

console.log('\n=== CONTROL 3: does the ambiguous-spin gate fire when spin really is ambiguous? ===');
console.log('(own-axis spin gyroscopically stabilises the coin; the half-flip count stops meaning anything)');
for (const s of [0, 6, 20, 60, 150]) {
  show(batch(`spinYMax=${s}`, { spinYMax: s }));
}

console.log('\n=== SENSITIVITY: restitution ===');
for (const r of [0.1, 0.2, 0.3, 0.45, 0.6]) show(batch(`restitution=${r}`, { phys: { restitution: r } }));

console.log('\n=== SENSITIVITY: friction ===');
for (const f of [0.2, 0.4, 0.6, 0.9]) show(batch(`friction=${f}`, { phys: { friction: f } }));

console.log('\n=== SENSITIVITY: timestep (counter aliasing + physics fidelity) ===');
for (const dt of [1 / 240, 1 / 500, 1 / 1000, 1 / 2000]) {
  show(batch(`dt=1/${Math.round(1 / dt)}`, { phys: { dt } }));
}

console.log('\n=== SENSITIVITY: solver iterations ===');
for (const it of [4, 8, 16]) show(batch(`solverIterations=${it}`, { phys: { solverIterations: it } }));
