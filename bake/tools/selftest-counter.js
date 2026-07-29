// selftest-counter.js — proves the half-flip counter against analytic cases.
// No physics here: synthetic quaternion tracks with a KNOWN answer.
// Run: node tools/selftest-counter.js
//
// A wrong half-flip count corrupts the posted odds silently, so this must pass
// before any bake output is trusted.

import { makeFlipCounter } from '../classify.js';
import { headsNormal, bodyXAxis, heading } from '../quat.js';
import { headingToQuadrant } from '../classify.js';

let failures = 0;
function check(name, got, want, tol = 0) {
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${typeof got === 'number' ? +got.toFixed(4) : got}, want ${want}`);
  if (!ok) failures++;
}

// quaternion for a rotation of `ang` about unit axis a
function axisAngle(a, ang) {
  const s = Math.sin(ang / 2);
  return { x: a[0] * s, y: a[1] * s, z: a[2] * s, w: Math.cos(ang / 2) };
}
function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

console.log('=== 1. Pure tumble about X: N half-flips must read exactly N ===');
for (const N of [1, 8, 13, 24, 39, 40]) {
  const c = makeFlipCounter();
  const steps = 4000;
  for (let i = 0; i <= steps; i++) c.push(axisAngle([1, 0, 0], (N * Math.PI * i) / steps), i / steps);
  const face = headsNormal(axisAngle([1, 0, 0], N * Math.PI))[1] > 0 ? 'Heads' : 'Tails';
  check(`  ${N} half-flips -> count`, c.count, N);
  check(`  ${N} half-flips -> arc/pi`, c.arcHalfFlips, N, 0.02);
  check(`  ${N} half-flips -> parity face`, face, N % 2 === 0 ? 'Heads' : 'Tails');
}

console.log('\n=== 2. Tumble about Z (other horizontal axis) behaves identically ===');
{
  const c = makeFlipCounter();
  for (let i = 0; i <= 2000; i++) c.push(axisAngle([0, 0, 1], (17 * Math.PI * i) / 2000), i / 2000);
  check('  17 half-flips about Z', c.count, 17);
}

console.log('\n=== 3. Stopped mid-transit (quarter turn past N) still reads N ===');
{
  const c = makeFlipCounter();
  const total = 12 * Math.PI + Math.PI / 2;
  for (let i = 0; i <= 3000; i++) c.push(axisAngle([1, 0, 0], (total * i) / 3000), i / 3000);
  check('  12.25 flips -> count (incomplete flip not counted)', c.count, 12);
}

console.log('\n=== 4. RIM ROLL: coin on its edge precessing must add ZERO half-flips ===');
{
  // theta = 90 deg, normal spun around the equator 20 times.
  const tilt = axisAngle([0, 0, 1], Math.PI / 2);
  const c = makeFlipCounter();
  for (let i = 0; i <= 4000; i++) {
    const spin = axisAngle([0, 1, 0], (20 * 2 * Math.PI * i) / 4000);
    c.push(qmul(spin, tilt), i / 4000);
  }
  check('  20 rim revolutions -> count', c.count, 0);
  console.log(`        (arc/pi would have said ${c.arcHalfFlips.toFixed(1)} — this is exactly the trap)`);
}

console.log('\n=== 5. POLE WOBBLE: 25 deg tilt precessing must add ZERO half-flips ===');
{
  const tilt = axisAngle([0, 0, 1], (25 * Math.PI) / 180);
  const c = makeFlipCounter();
  for (let i = 0; i <= 4000; i++) {
    const spin = axisAngle([0, 1, 0], (30 * 2 * Math.PI * i) / 4000);
    c.push(qmul(spin, tilt), i / 4000);
  }
  check('  30 wobble revolutions -> count', c.count, 0);
  console.log(`        (arc/pi would have said ${c.arcHalfFlips.toFixed(1)})`);
}

console.log('\n=== 6. Dithering just inside the caps must not double count ===');
{
  const c = makeFlipCounter();
  for (let i = 0; i < 500; i++) {
    // sweep between theta=53deg (c=0.6) and theta=114deg (c=-0.4): never confirms
    const ang = (i % 2 === 0 ? 53 : 114) * Math.PI / 180;
    c.push(axisAngle([1, 0, 0], ang), i / 500);
  }
  check('  500 dithers across the equator -> count', c.count, 0);
}

console.log('\n=== 7. ALIASING: worst-case sim sampling (omega 230 rad/s @ dt 1/1000) ===');
{
  // 13.2 deg of rotation per sample — the coarsest the shipped bake ever sees.
  const c = makeFlipCounter();
  const total = 40 * Math.PI;
  const stepAng = 230 / 1000;
  const n = Math.ceil(total / stepAng);
  for (let i = 0; i <= n; i++) c.push(axisAngle([1, 0, 0], Math.min(total, i * stepAng)), i / 1000);
  check('  40 half-flips at 13.2 deg/sample', c.count, 40);
}
{
  // And the point where it WOULD break, to show the margin is real.
  const c = makeFlipCounter();
  const total = 40 * Math.PI;
  const stepAng = (170 * Math.PI) / 180;   // 170 deg per sample
  const n = Math.ceil(total / stepAng);
  for (let i = 0; i <= n; i++) c.push(axisAngle([1, 0, 0], Math.min(total, i * stepAng)), i / 1000);
  console.log(`  (at a deliberately broken 170 deg/sample the counter reads ${c.count} instead of 40 —` +
              ` the shipped rate is 13x finer than that limit)`);
}

console.log('\n=== 8. Orientation + quadrant conventions ===');
// orientationDeg is measured CLOCKWISE from world -Z, in [0,360).
// Quadrant buckets are half-open: N=[0,90) E=[90,180) S=[180,270) W=[270,360).
check('  heading(-Z) deg', heading(0, -1), 0, 1e-9);
check('  heading(+X) deg', heading(1, 0), 90, 1e-9);
check('  heading(+Z) deg', heading(0, 1), 180, 1e-9);
check('  heading(-X) deg', heading(-1, 0), 270, 1e-9);
check('  0 -> N', headingToQuadrant(0), 'N');
check('  89.99 -> N', headingToQuadrant(89.99), 'N');
check('  90 -> E', headingToQuadrant(90), 'E');
check('  179.99 -> E', headingToQuadrant(179.99), 'E');
check('  180 -> S', headingToQuadrant(180), 'S');
check('  269.99 -> S', headingToQuadrant(269.99), 'S');
check('  270 -> W', headingToQuadrant(270), 'W');
check('  359.99 -> W', headingToQuadrant(359.99), 'W');
{
  // Coin yawed 90 deg: body +X points to +Z (South) => settle angle 180.
  const q = axisAngle([0, 1, 0], -Math.PI / 2);
  const bx = bodyXAxis(q);
  check('  yaw -90deg -> settle angle', heading(bx[0], bx[2]), 180, 1e-6);
}

console.log(failures === 0
  ? '\nALL COUNTER SELF-TESTS PASSED'
  : `\n${failures} SELF-TEST FAILURE(S) — do not trust bake output`);
process.exit(failures === 0 ? 0 : 1);
