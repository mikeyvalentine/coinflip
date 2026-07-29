// edge-probe.js — is a rim landing reachable at all?
// ---------------------------------------------------------------------------
// THIS FILE PRODUCES A FINDING, NOT A CLIP. Before spending a bake on The Edge
// we need to know which of three worlds we are in:
//
//   1. natural rim RESTS happen, just rarely -> bake them like anything else
//   2. rim CONTACTS happen but never rest -> the coin teeters and topples
//   3. neither is reachable from the game's launch distribution -> any rim
//      landing has to be constructed, and that must be SAID rather than blurred
//
// A cylinder standing on its rim on a flat plane is an unstable equilibrium:
// the contact is a line, and any tilt off vertical produces a gravity torque
// that grows. Rigid-body sims have no surface roughness and no milled rim to
// catch on, so the analytic expectation is that a true rest is measure-zero.
// The probe is here to measure that rather than assume it.
//
// WHY NOT JUST READ THE MAIN BAKE'S REJECT COUNTS: classify.js has an
// 'edge-landing' reject, but it is UNREACHABLE. The settle detector requires
// |cos(theta)| > 0.9996 before it will call a clip settled, so a rim-resting
// coin fails `!sim.settled` first and is recorded as 'no-settle'. The main
// bake's stats therefore cannot tell us what we need; hence this.
//
//   node bake/edge-probe.js --trials 4000
// ---------------------------------------------------------------------------

import { initRapier, simulateClip, omegaForHalfFlips } from './sim.js';
import { makeRng } from './prng.js';
import { headsNormal } from './quat.js';
import { LAUNCH, COIN, CLASSIFY, HALF_FLIPS } from './config.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};
const TRIALS = Number(arg('trials', 4000));
const SEED = arg('seed', 'edge-probe-v1');

// A coin is ON ITS RIM when its heads-normal lies in the table plane, i.e.
// n.y ~ 0. |n.y| < 0.087 is within 5 deg of perfectly upright.
const RIM_COS = 0.087;
// Standing on the rim puts the centre at the coin's RADIUS, not its half
// thickness — 10.25 mm versus 0.75 mm. That height alone separates the two.
const RIM_Y = COIN.radius;
const FLAT_Y = COIN.halfHeight;

/** Tilt of the coin away from lying flat, in degrees. 90 = perfectly on rim. */
function tiltDeg(q) {
  const n = headsNormal({ x: q[0], y: q[1], z: q[2], w: q[3] });
  return Math.acos(Math.min(1, Math.abs(n[1]))) * 180 / Math.PI;
}

async function main() {
  await initRapier();
  const rng = makeRng(SEED, 'probe');

  let rimContacts = 0;          // ever passed through a rim pose while low
  let rimRests = 0;             // ENDED on the rim
  let longestRimMs = 0;
  let longestRimTrial = null;
  const rimDurations = [];
  const finalTilts = [];
  let leftTable = 0, noSettle = 0;

  for (let i = 0; i < TRIALS; i++) {
    // The game's own launch distribution, sampled exactly as bake.js does.
    const vy = rng.range(LAUNCH.vyMin, LAUNCH.vyMax);
    const targetH = HALF_FLIPS[Math.floor(rng.f() * HALF_FLIPS.length)];
    const sim = simulateClip({
      y0: LAUNCH.y0,
      vy,
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
      omega: omegaForHalfFlips(targetH, LAUNCH.y0, vy),
      yaw0: rng.range(0, 2 * Math.PI),
    });

    if (sim.leftTable) { leftTable++; continue; }
    if (!sim.settled) noSettle++;

    const last = sim.frames[sim.frames.length - 1];
    const ft = tiltDeg(last.quat);
    finalTilts.push(ft);
    // Rest on the rim: near-vertical AND the centre sitting up at radius height.
    if (ft > 85 && last.pos[1] > (RIM_Y + FLAT_Y) / 2) rimRests++;

    // A rim CONTACT: any run of frames where the coin is near-upright while
    // low enough to be touching. Being upright mid-flight means nothing.
    let run = 0, best = 0;
    for (const f of sim.frames) {
      const n = headsNormal({ x: f.quat[0], y: f.quat[1], z: f.quat[2], w: f.quat[3] });
      const upright = Math.abs(n[1]) < RIM_COS;
      const low = f.pos[1] < CLASSIFY.contactHeight;
      if (upright && low) { run += 4; if (run > best) best = run; }   // 250 fps => 4 ms
      else run = 0;
    }
    if (best > 0) {
      rimContacts++;
      rimDurations.push(best);
      if (best > longestRimMs) { longestRimMs = best; longestRimTrial = i; }
    }
  }

  const pct = (n) => ((100 * n) / TRIALS).toFixed(3) + '%';
  console.log(`\n=== unbiased probe: ${TRIALS} trials, the game's own launch distribution ===`);
  console.log(`  left the table          : ${leftTable} (${pct(leftTable)})`);
  console.log(`  never settled flat      : ${noSettle} (${pct(noSettle)})`);
  console.log(`  RIM CONTACTS (transient): ${rimContacts} (${pct(rimContacts)})`);
  console.log(`  RIM RESTS   (ended up)  : ${rimRests} (${pct(rimRests)})`);
  if (rimDurations.length) {
    rimDurations.sort((a, b) => a - b);
    const med = rimDurations[Math.floor(rimDurations.length / 2)];
    console.log(`  rim-contact dwell: median ${med} ms, max ${longestRimMs} ms (trial ${longestRimTrial})`);
  }
  finalTilts.sort((a, b) => a - b);
  if (finalTilts.length) {
    const q = (p) => finalTilts[Math.floor(p * (finalTilts.length - 1))].toFixed(3);
    console.log(`  final tilt from flat: p50 ${q(0.5)} deg, p99 ${q(0.99)} deg, max ${q(1)} deg`);
  }
  console.log('');
  console.log(rimRests > 0
    ? '  -> CASE 1: natural rim rests exist.'
    : rimContacts > 0
      ? '  -> CASE 2 at best: the coin touches down on its rim but never stays.'
      : '  -> CASE 3: the launch distribution never even brings the rim down first.');
}

main();
