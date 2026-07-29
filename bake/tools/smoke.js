// smoke.js — does Rapier run headless, does the coin have the right mass, and
// does a single launch produce a plausible settled clip?
// Run: node tools/smoke.js

import { initRapier, simulateClip, omegaForHalfFlips, flightTime } from '../sim.js';
import { classify } from '../classify.js';
import { COIN, PHYS, LAUNCH } from '../config.js';
import RAPIER from '@dimforge/rapier3d-compat';

await initRapier();

console.log('=== coin mass properties ===');
console.log(`radius ${COIN.radius} m, halfHeight ${COIN.halfHeight} m`);
console.log(`volume ${COIN.volume.toExponential(4)} m^3, density ${COIN.density.toFixed(1)} kg/m^3`);
{
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  w.createCollider(RAPIER.ColliderDesc.cylinder(COIN.halfHeight, COIN.radius).setDensity(COIN.density), b);
  console.log(`Rapier body mass: ${b.mass().toFixed(8)} kg  (target ${COIN.mass})`);
  const inv = b.invPrincipalInertiaSqrt ? null : null;
  console.log(`analytic I about diameter: ${((1 / 12) * COIN.mass * (3 * COIN.radius ** 2 + (2 * COIN.halfHeight) ** 2)).toExponential(4)} kg m^2`);
  console.log(`analytic I about own axis: ${(0.5 * COIN.mass * COIN.radius ** 2).toExponential(4)} kg m^2`);
  w.free();
}

console.log('\n=== analytic flight times ===');
for (const vy of [LAUNCH.vyMin, 1.5, 2.2, LAUNCH.vyMax]) {
  const t = flightTime(LAUNCH.y0, vy);
  console.log(`vy=${vy.toFixed(2)} -> t_contact=${(t * 1000).toFixed(0)} ms, ` +
    `omega for 8 hf = ${omegaForHalfFlips(8, LAUNCH.y0, vy).toFixed(1)}, ` +
    `for 40 hf = ${omegaForHalfFlips(40, LAUNCH.y0, vy).toFixed(1)} rad/s`);
}

console.log('\n=== single clips across the range ===');
for (const [vy, target] of [[1.0, 8], [1.4, 16], [2.0, 24], [2.6, 32], [3.0, 40]]) {
  const omega = omegaForHalfFlips(target, LAUNCH.y0, vy);
  const t0 = process.hrtime.bigint();
  const sim = simulateClip({ y0: LAUNCH.y0, vy, vh: 0.25, psi: Math.PI / 4, omega, spinY: 2.0 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const c = classify(sim);
  console.log(
    `vy=${vy.toFixed(1)} omega=${omega.toFixed(0)} -> aim ${target} hf | ` +
    `got ${c.meta.halfFlips} hf (air ${sim.airborneCount}) ${c.meta.side} ${c.meta.quadrant} ` +
    `${c.meta.durationMs}ms disp=${c.diag.displacement}m bounces=${sim.bounces} ` +
    `settled=${sim.settled} ${c.ok ? 'OK' : 'REJECT:' + c.reject} | ${ms.toFixed(1)}ms wall, ${sim.frames.length} frames`);
}
