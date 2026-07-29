// flight-audit.js — measured flight dynamics of a written library, plus a
// direct check of each "floaty" hypothesis. Real numbers only.
// Run: node tools/flight-audit.js ./out

import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initRapier } from '../sim.js';
import { COIN, PHYS, LAUNCH } from '../config.js';

const DIR = process.argv[2] || './out';
await initRapier();

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return {
    min: s[0], p05: s[Math.floor(0.05 * s.length)], med: s[Math.floor(0.5 * s.length)],
    p95: s[Math.floor(0.95 * s.length)], max: s[s.length - 1],
    mean: s.reduce((x, y) => x + y, 0) / s.length,
  };
};
const f = (o, d = 3, m = 1) => `min ${(o.min * m).toFixed(d)}  p05 ${(o.p05 * m).toFixed(d)}  ` +
  `MEAN ${(o.mean * m).toFixed(d)}  median ${(o.med * m).toFixed(d)}  p95 ${(o.p95 * m).toFixed(d)}  max ${(o.max * m).toFixed(d)}`;

// --- 2. SCALE: what is actually handed to Rapier ----------------------------
console.log('=== HYPOTHESIS 2: collider scale and world units ===');
{
  const w = new RAPIER.World({ x: 0, y: PHYS.gravity, z: 0 });
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  const col = w.createCollider(
    RAPIER.ColliderDesc.cylinder(COIN.halfHeight, COIN.radius).setDensity(COIN.density), b);
  const sh = col.shape;
  console.log(`  cylinder halfHeight passed : ${COIN.halfHeight} m  -> read back ${sh.halfHeight} m`);
  console.log(`  cylinder radius passed     : ${COIN.radius} m  -> read back ${sh.radius} m`);
  console.log(`  => diameter ${(sh.radius * 2 * 1000).toFixed(1)} mm, thickness ${(sh.halfHeight * 2 * 1000).toFixed(1)} mm  (target 20.5 / 1.5)`);
  console.log(`  body mass read back        : ${b.mass().toFixed(8)} kg  (target ${COIN.mass})`);
  console.log(`  world gravity              : (${w.gravity.x}, ${w.gravity.y}, ${w.gravity.z}) m/s^2`);
  w.free();
}

// --- 4. GRAVITY as acceleration ---------------------------------------------
console.log('\n=== HYPOTHESIS 4: is gravity integrated as acceleration? ===');
{
  // Free-fall a body with no collider contact and compare against s = 1/2 g t^2.
  const w = new RAPIER.World({ x: 0, y: PHYS.gravity, z: 0 });
  w.timestep = PHYS.dt;
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 100, 0));
  w.createCollider(RAPIER.ColliderDesc.cylinder(COIN.halfHeight, COIN.radius).setDensity(COIN.density), b);
  for (let i = 0; i < 1000; i++) w.step();     // exactly 1.000 s
  const drop = 100 - b.translation().y;
  const analytic = 0.5 * 9.81 * 1;
  console.log(`  free fall for 1.000 s: dropped ${drop.toFixed(4)} m, analytic 1/2*g*t^2 = ${analytic.toFixed(4)} m`);
  console.log(`  vertical velocity after 1 s: ${b.linvel().y.toFixed(4)} m/s, analytic -9.810 m/s`);
  console.log(`  => ${Math.abs(drop - analytic) < 0.02 ? 'PASS - gravity is a proper acceleration' : 'FAIL'}`);
  w.free();
}

// --- 1 & 3. FLIGHT TIME and DAMPING from the actual library -----------------
console.log('\n=== HYPOTHESIS 1: measured flight time of every shipped clip ===');
const files = readdirSync(join(DIR, 'diag')).filter((x) => x.endsWith('.json'));
const airborne = [], apex = [], omega = [], vy = [], vh = [], spinY = [], settle = [], hf = [];
const clipFiles = readdirSync(join(DIR, 'clips')).filter((x) => x.endsWith('.json'));
for (const x of files) {
  const d = JSON.parse(readFileSync(join(DIR, 'diag', x), 'utf8'));
  if (d.contactsMs && d.contactsMs.length) airborne.push(d.contactsMs[0] / 1000);
  apex.push(d.diag.apexY);
  omega.push(d.launch.omega);
  vy.push(d.launch.vy);
  vh.push(d.launch.vh);
  spinY.push(Math.abs(d.launch.spinY));
}
for (const x of clipFiles) {
  const c = JSON.parse(readFileSync(join(DIR, 'clips', x), 'utf8'));
  settle.push(c.meta.durationMs / 1000);
  hf.push(c.meta.halfFlips);
}

console.log(`  AIRBORNE TIME, launch -> first contact (s):`);
console.log(`    ${f(stat(airborne))}`);
console.log(`    target: 0.5-1.0 s, tuned toward ~0.6 s`);
console.log(`  TOTAL CLIP LENGTH, launch -> settled (s):`);
console.log(`    ${f(stat(settle))}`);
console.log(`  APEX HEIGHT above the table (m):`);
console.log(`    ${f(stat(apex))}   (launch height ${LAUNCH.y0} m)`);

console.log('\n=== launch distribution actually used ===');
console.log(`  vy    (m/s)   ${f(stat(vy), 2)}`);
console.log(`  omega (rad/s) ${f(stat(omega), 1)}`);
const revs = omega.map((o) => o / (2 * Math.PI));
console.log(`  omega (rev/s) ${f(stat(revs), 1)}    target ~6.7 to ~33.3 rev/s`);
console.log(`  vh    (m/s)   ${f(stat(vh), 2)}`);
console.log(`  |spinY| (rad/s) ${f(stat(spinY), 1)}`);
console.log(`  half-flips    ${f(stat(hf), 1)}`);

console.log('\n=== HYPOTHESIS 3: how much does damping actually bleed? ===');
{
  const t = stat(airborne).mean;
  console.log(`  linearDamping  = ${PHYS.linearDamping}  -> over a ${t.toFixed(3)} s flight retains ` +
    `${(Math.exp(-PHYS.linearDamping * t) * 100).toFixed(1)}% of velocity`);
  console.log(`  angularDamping = ${PHYS.angularDamping}  -> over the same flight retains ` +
    `${(Math.exp(-PHYS.angularDamping * t) * 100).toFixed(1)}% of spin`);
}

console.log('\n=== PLAYBACK: the clips are NOT 60 fps ===');
{
  const c = JSON.parse(readFileSync(join(DIR, 'clips', clipFiles[0]), 'utf8'));
  const fps = (c.frames.length - 1) / (c.frames[c.frames.length - 1].t / 1000);
  const meanFrames = stat(clipFiles.slice(0, 200).map((x) =>
    JSON.parse(readFileSync(join(DIR, 'clips', x), 'utf8')).frames.length)).mean;
  console.log(`  emitted frame rate: ${fps.toFixed(1)} fps  (frame.t is MILLISECONDS)`);
  console.log(`  mean frames per clip: ${meanFrames.toFixed(0)}`);
  console.log(`  correct playback:   ${meanFrames.toFixed(0)} frames over ${(stat(settle).mean).toFixed(3)} s`);
  console.log(`  if advanced ONE FRAME PER 60 Hz VSYNC instead: ` +
    `${(meanFrames / 60).toFixed(2)} s  = ${((meanFrames / 60) / stat(settle).mean).toFixed(2)}x too slow`);
  console.log(`  apparent gravity would read ${(((meanFrames / 60) / stat(settle).mean) ** 2).toFixed(1)}x too weak ` +
    `(time scales as sqrt of length)`);
}
