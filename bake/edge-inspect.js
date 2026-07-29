// edge-inspect.js — what IS the coin doing during a long rim dwell?
// ---------------------------------------------------------------------------
// The probe found rim contacts at 4.7% and one that lasted 568 ms. Half a
// second on the rim is a long time for an unstable equilibrium, which suggests
// it is not balancing at all — it is ROLLING, and a rolling disc is
// gyroscopically stable. That distinction decides the whole feature:
//
//   balancing -> the coin stands still on its edge. Rare, fragile, and the
//                clip has to be trimmed before it topples.
//   rolling   -> the coin runs along its rim like a wheel. Stable while it has
//                speed, decays into a spiralling Euler's-disk rattle, and is
//                far more dramatic to watch.
//
// This replays the specific trials the probe flagged and prints what the coin
// is doing frame by frame during the dwell.
// ---------------------------------------------------------------------------

import { initRapier, simulateClip, omegaForHalfFlips } from './sim.js';
import { makeRng } from './prng.js';
import { headsNormal } from './quat.js';
import { LAUNCH, COIN, CLASSIFY, HALF_FLIPS } from './config.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};
const TRIALS = Number(arg('trials', 1500));
const SEED = arg('seed', 'edge-probe-v1');
const TOP = Number(arg('top', 8));
const RIM_COS = 0.087;

const tilt = (q) => {
  const n = headsNormal({ x: q[0], y: q[1], z: q[2], w: q[3] });
  return Math.acos(Math.min(1, Math.abs(n[1]))) * 180 / Math.PI;
};

async function main() {
  await initRapier();
  const rng = makeRng(SEED, 'probe');       // SAME stream as edge-probe.js
  const found = [];

  for (let i = 0; i < TRIALS; i++) {
    const vy = rng.range(LAUNCH.vyMin, LAUNCH.vyMax);
    const targetH = HALF_FLIPS[Math.floor(rng.f() * HALF_FLIPS.length)];
    const params = {
      y0: LAUNCH.y0, vy,
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
      omega: omegaForHalfFlips(targetH, LAUNCH.y0, vy),
      yaw0: rng.range(0, 2 * Math.PI),
    };
    const sim = simulateClip(params);
    if (sim.leftTable) continue;

    let run = 0, best = 0, bestEnd = 0;
    sim.frames.forEach((f, k) => {
      const n = headsNormal({ x: f.quat[0], y: f.quat[1], z: f.quat[2], w: f.quat[3] });
      if (Math.abs(n[1]) < RIM_COS && f.pos[1] < CLASSIFY.contactHeight) {
        run += 4;
        if (run > best) { best = run; bestEnd = k; }
      } else run = 0;
    });
    if (best >= 40) found.push({ i, best, bestEnd, params, sim });
  }

  found.sort((a, b) => b.best - a.best);
  console.log(`\ntrials ${TRIALS}: ${found.length} with a rim dwell >= 40 ms\n`);

  for (const c of found.slice(0, TOP)) {
    const f = c.sim.frames;
    const startK = Math.max(0, c.bestEnd - Math.round(c.best / 4));
    console.log(`--- trial ${c.i}: dwell ${c.best} ms, clip ${f[f.length - 1].t.toFixed(0)} ms, ` +
      `${c.sim.bounces} bounces, settled=${c.sim.settled} ---`);
    // sample the dwell: is the centre riding at rim height, and is it moving?
    const step = Math.max(1, Math.round((c.bestEnd - startK) / 5));
    for (let k = startK; k <= c.bestEnd; k += step) {
      const fr = f[k];
      const dx = k > 0 ? Math.hypot(fr.pos[0] - f[k - 1].pos[0], fr.pos[2] - f[k - 1].pos[2]) : 0;
      console.log(`    t=${String(fr.t.toFixed(0)).padStart(4)}ms  y=${(fr.pos[1] * 1000).toFixed(2)}mm  ` +
        `tilt=${tilt(fr.quat).toFixed(1)}deg  travel/frame=${(dx * 1000).toFixed(2)}mm`);
    }
    const last = f[f.length - 1];
    console.log(`    ENDS: y=${(last.pos[1] * 1000).toFixed(2)}mm tilt=${tilt(last.quat).toFixed(1)}deg`);
  }
  console.log(`\n  rim height would be ${(COIN.radius * 1000).toFixed(2)} mm; flat is ${(COIN.halfHeight * 1000).toFixed(2)} mm.`);
}

main();
