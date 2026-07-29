// sleepcheck.js — is Rapier's auto-sleep ending our clips for us?
// Rapier's default sleep thresholds are far coarser than a settling coin's
// motion. If the engine sleeps the body, its velocities are zeroed, our settle
// detector instantly agrees, and the clip ends in a pose the coin never
// actually reached. That would be a fake ending AND it would hide the
// rim-rolling problem that angular damping is supposed to solve.
// Run: node tools/sleepcheck.js [n]

import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier } from '../sim.js';
import { makeRng } from '../prng.js';
import { LAUNCH, PHYS, COIN, CLASSIFY } from '../config.js';
import { makeFlipCounter, makeSettleDetector } from '../classify.js';
import { headingToDir } from '../quat.js';

await initRapier();
const N = Number(process.argv[2] || 150);

function run({ canSleep, angularDamping, label }) {
  const rng = makeRng('sleepcheck-v1', 'launch');   // SAME launches every case
  let sleptFirst = 0, settled = 0, timedOut = 0, flatAtEnd = 0;
  let sleepTimes = [], settleTimes = [];
  for (let i = 0; i < N; i++) {
    const p = {
      vy: rng.range(LAUNCH.vyMin, LAUNCH.vyMax),
      omega: rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax),
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
    };
    const w = new RAPIER.World({ x: 0, y: PHYS.gravity, z: 0 });
    w.timestep = PHYS.dt;
    w.numSolverIterations = PHYS.solverIterations;
    const g = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -PHYS.tableThickness, 0));
    w.createCollider(RAPIER.ColliderDesc.cuboid(PHYS.tableHalfExtent, PHYS.tableThickness, PHYS.tableHalfExtent)
      .setRestitution(PHYS.restitution).setFriction(PHYS.friction), g);
    const dir = headingToDir(p.psi);
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, LAUNCH.y0, 0)
      .setLinvel(dir[0] * p.vh, p.vy, dir[2] * p.vh)
      .setAngvel({ x: -Math.cos(p.psi) * p.omega, y: p.spinY, z: -Math.sin(p.psi) * p.omega })
      .setLinearDamping(PHYS.linearDamping).setAngularDamping(angularDamping)
      .setCanSleep(canSleep).setCcdEnabled(true));
    w.createCollider(RAPIER.ColliderDesc.cylinder(COIN.halfHeight, COIN.radius)
      .setDensity(COIN.density).setRestitution(PHYS.restitution).setFriction(PHYS.friction), b);

    const counter = makeFlipCounter();
    const settle = makeSettleDetector();
    let sleptAt = null, settledAt = null;
    const maxSteps = Math.ceil(6.0 / PHYS.dt);    // generous 6 s budget here
    for (let s = 1; s <= maxSteps; s++) {
      w.step();
      const tMs = s * PHYS.dt * 1000;
      const c = counter.push(b.rotation(), s * PHYS.dt);
      if (sleptAt === null && b.isSleeping()) sleptAt = tMs;
      if (settledAt === null && settle.push({ linvel: b.linvel(), angvel: b.angvel(), cosTheta: c, tMs, dtMs: PHYS.dt * 1000 })) {
        settledAt = settle.settledAtMs;
      }
      if (settledAt !== null && sleptAt !== null) break;
      if (settledAt !== null && s * PHYS.dt * 1000 > settledAt + 400) break;
    }
    const n = counter.push(b.rotation(), 0);
    if (Math.abs(n) > CLASSIFY.settleFlatCos) flatAtEnd++;
    if (settledAt !== null) { settled++; settleTimes.push(settledAt); } else timedOut++;
    if (sleptAt !== null) { sleepTimes.push(sleptAt); if (settledAt === null || sleptAt <= settledAt) sleptFirst++; }
    w.free();
  }
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
  console.log(`  ${label.padEnd(34)} settled ${String(settled).padStart(3)}/${N}  timedOut ${String(timedOut).padStart(3)}  ` +
    `slept-before-settle ${String(sleptFirst).padStart(3)}  medSettle ${String(Math.round(med(settleTimes))).padStart(5)}ms  ` +
    `medSleep ${String(Math.round(med(sleepTimes))).padStart(5)}ms  flatAtEnd ${flatAtEnd}/${N}`);
}

console.log('=== Does auto-sleep pre-empt our settle detector? (6 s budget) ===');
for (const canSleep of [true, false]) {
  for (const d of [0, 0.05, 0.28]) {
    run({ canSleep, angularDamping: d, label: `canSleep=${canSleep} angDamp=${d}` });
  }
}

console.log('\n=== Tunnelling at the SHIPPED config (dt=1/1000, 20 mm slab) ===');
for (const ccd of [true, false]) {
  const rng = makeRng('sleepcheck-v1', 'tunnel');
  let through = 0, minY = Infinity;
  for (let i = 0; i < N; i++) {
    const w = new RAPIER.World({ x: 0, y: PHYS.gravity, z: 0 });
    w.timestep = PHYS.dt;
    const g = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -PHYS.tableThickness, 0));
    w.createCollider(RAPIER.ColliderDesc.cuboid(PHYS.tableHalfExtent, PHYS.tableThickness, PHYS.tableHalfExtent), g);
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, LAUNCH.y0, 0)
      .setLinvel(0, -rng.range(2, 6), 0)
      .setAngvel({ x: rng.range(50, 230), y: 0, z: 0 })
      .setCcdEnabled(ccd));
    w.createCollider(RAPIER.ColliderDesc.cylinder(COIN.halfHeight, COIN.radius).setDensity(COIN.density), b);
    for (let s = 0; s < 2000; s++) w.step();
    const y = b.translation().y;
    if (y < -0.05) through++;
    minY = Math.min(minY, y);
    w.free();
  }
  console.log(`  ccd=${String(ccd).padEnd(5)} tunnelled ${through}/${N}  lowest y seen ${minY.toFixed(5)} m`);
}
