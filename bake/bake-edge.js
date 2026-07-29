// bake-edge.js — THE EDGE. Clips where the coin comes down on its rim.
// ---------------------------------------------------------------------------
// THE FINDING THIS IS BUILT ON (bake/edge-probe.js, 1500 unbiased trials):
//
//   rim contacts   4.67%   the coin touches down on its rim often
//   rim RESTS      0.00%   it never once stayed there
//   longest dwell  568 ms  balanced, then toppled flat like all the others
//
// So the Edge is CASE 2. A cylinder on its rim on a flat plane is an unstable
// equilibrium — the contact is a line, any tilt makes a gravity torque that
// grows, and a rigid-body sim has no surface roughness or milled rim to catch
// on. It cannot rest there and it never did. What it CAN do, and does at a
// useful rate, is land on its rim and balance for tens to hundreds of
// milliseconds while it decides which way to fall.
//
// THESE LAUNCHES ARE NOT CONSTRUCTED. Every clip here comes from the game's own
// launch distribution, sampled exactly as bake.js samples it — same vy, vh,
// psi, spinY, omega and yaw0 ranges, same physics, same solver. Nothing is
// aimed at the rim and nothing is nudged. The search simply runs the ordinary
// distribution and keeps the runs that happened to come down on the edge, which
// is what "1 in 500" is supposed to mean in the first place.
//
// THE CLIP IS TRIMMED, AND THAT IS THE ONE LIBERTY TAKEN.
// The sim is played forward honestly and then CUT while the coin is still on
// its rim, rather than running on through the topple. Two reasons, and the
// second is the important one:
//   1. the Edge has already resolved the moment the rim comes down;
//   2. if the clip ran to rest the coin would land on a FACE, and a player who
//      called Heads would watch it finish heads-up and still lose — because the
//      Edge sweeps the table. Showing a face after an Edge is a lie about what
//      was paid.
// Trimming is not faking: no keyframes, no frozen solver, no constraint holding
// the coin up. Every frame emitted is a frame the physics produced. The clip
// just stops before the part that would misinform the player.
//
//   node bake/bake-edge.js --trials 4000 --keep 12
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { initRapier, simulateClip, omegaForHalfFlips } from './sim.js';
import { makeRng } from './prng.js';
import { headsNormal } from './quat.js';
import { LAUNCH, PHYS, COIN, CLASSIFY, OUTPUT, HALF_FLIPS } from './config.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};
const TRIALS = Number(arg('trials', 4000));
const KEEP = Number(arg('keep', 12));
const SEED = arg('seed', 'coinflip-edge-v1');
const OUT = arg('out', './out-edge');
const MIN_DWELL_MS = Number(arg('min-dwell', 40));
const QUIET = process.argv.includes('--quiet');

// On its rim the heads-normal lies in the table plane: |n.y| ~ 0.
// 0.087 is within 5 deg of perfectly upright.
export const RIM_COS = 0.087;
// Standing on the rim puts the centre at the coin's RADIUS (10.25 mm), not its
// half-thickness (0.75 mm). Height alone separates a rim pose from a flat one.
export const RIM_MIN_Y = COIN.radius * 0.85;
const FRAME_MS = 1000 / OUTPUT.fps;

/** Tilt away from lying flat, in degrees. 90 = perfectly on the rim. */
export function tiltDeg(quat) {
  const n = headsNormal({ x: quat[0], y: quat[1], z: quat[2], w: quat[3] });
  return Math.acos(Math.min(1, Math.abs(n[1]))) * 180 / Math.PI;
}

/**
 * The longest contiguous stretch of frames where the coin is standing on its
 * rim: near-vertical AND riding at rim height. Height matters — without it a
 * coin passing through vertical mid-air would score.
 */
export function findRimWindow(frames) {
  let bestStart = -1, bestLen = 0, start = -1;
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    const n = headsNormal({ x: f.quat[0], y: f.quat[1], z: f.quat[2], w: f.quat[3] });
    const onRim = Math.abs(n[1]) < RIM_COS && f.pos[1] > RIM_MIN_Y && f.pos[1] < CLASSIFY.contactHeight;
    if (onRim) {
      if (start < 0) start = k;
      if (k - start + 1 > bestLen) { bestLen = k - start + 1; bestStart = start; }
    } else start = -1;
  }
  if (bestStart < 0) return null;
  const end = bestStart + bestLen - 1;
  let peak = bestStart;
  for (let k = bestStart; k <= end; k++) if (tiltDeg(frames[k].quat) > tiltDeg(frames[peak].quat)) peak = k;

  // BALANCING vs ROLLING — the distinction the first bake missed, and it is the
  // whole feature. Both keep the coin near-vertical at rim height, so tilt and
  // height cannot tell them apart. Travel can:
  //
  //   balance  the coin stands where it landed, teeters, topples. THE EDGE.
  //   roll     the coin runs off like a wheel. A rolling disc is gyroscopically
  //            stable, so it can hold vertical for SECONDS — the first search's
  //            best "find" rolled 151 mm over 3.2 s and was still going when
  //            the sim hit its 4 s cap. That is not a landing, it never
  //            resolves, it leaves the camera framing, and it is four times the
  //            length of every other clip in the library.
  //
  // Gate at one coin RADIUS (10.25 mm) of travel across the whole dwell. Two
  // diameters let a slow drifter through at 19.4 mm over 884 ms, which played
  // as a 1.75 s clip against a library median of 897 ms.
  const a = frames[bestStart].pos, b = frames[end].pos;
  const travelM = Math.hypot(b[0] - a[0], b[2] - a[2]);
  return {
    start: bestStart, end, peak,
    dwellMs: bestLen * FRAME_MS,
    travelMm: travelM * 1000,
    rolling: travelM > COIN.radius,   // half a diameter; drifters read as rolls too
  };
}

async function main() {
  await initRapier();
  const rng = makeRng(SEED, 'edge-search');
  const found = [];
  let rolled = 0;
  const t0 = process.hrtime.bigint();

  for (let i = 0; i < TRIALS; i++) {
    // THE GAME'S OWN LAUNCH DISTRIBUTION, sampled exactly as bake.js does it.
    const vy = rng.range(LAUNCH.vyMin, LAUNCH.vyMax);
    const targetH = HALF_FLIPS[Math.floor(rng.f() * HALF_FLIPS.length)];
    const params = {
      y0: LAUNCH.y0,
      vy,
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
      omega: omegaForHalfFlips(targetH, LAUNCH.y0, vy),
      yaw0: rng.range(0, 2 * Math.PI),
    };
    const sim = simulateClip(params);
    if (sim.leftTable) continue;

    const win = findRimWindow(sim.frames);
    if (!win || win.dwellMs < MIN_DWELL_MS) continue;
    if (win.rolling) { rolled++; continue; }   // ran off on its rim — see findRimWindow

    // Trim AT THE PEAK of the teeter, not at the end of the rim window.
    //
    // Ending at the window edge sounds right — it shows every millisecond the
    // coin held — but the window edge is defined as the moment the coin leaves
    // vertical, so every clip finished at exactly 85.1 deg: frozen 5 deg over,
    // visibly already falling. The renderer holds on the last frame, so that
    // reads as "it's going to fall" rather than "it's standing on its edge".
    // Cutting at the most-upright frame ends the clip at 88-90 deg with the
    // whole approach and teeter still shown.
    const frames = sim.frames.slice(0, win.peak + 1);
    found.push({ trial: i, params, win, frames, sim });

    if (!QUIET) process.stdout.write(`\r  ${i + 1}/${TRIALS} trials, ${found.length} rim landings   `);
  }
  if (!QUIET) process.stdout.write('\n');

  // Spread the keepers across the dwell range rather than taking the top N:
  // twelve near-identical half-second balances is one clip twelve times.
  found.sort((a, b) => b.win.dwellMs - a.win.dwellMs);
  const keep = [];
  if (found.length <= KEEP) keep.push(...found);
  else for (let k = 0; k < KEEP; k++) keep.push(found[Math.round((k * (found.length - 1)) / (KEEP - 1))]);

  const library = [];
  for (const [n, c] of keep.entries()) {
    const last = c.frames[c.frames.length - 1];
    const peakTilt = tiltDeg(c.frames[c.win.peak].quat);
    library.push({
      id: `EDGE-${String(n).padStart(2, '0')}`,
      meta: {
        // `side: 'Edge'` is the marker the renderer keys on. It is deliberately
        // NOT 'Heads' or 'Tails' so nothing downstream can mistake a rim clip
        // for a face landing.
        side: 'Edge',
        edge: true,
        halfFlips: c.sim.counter.count,
        // A coin on its rim has no settled yaw. orientationDeg is the direction
        // the FACE points once flat, and this coin never lies flat, so the
        // honest value is null rather than a number derived from a pose the
        // quantity was never defined for. The Edge sweeps every axis anyway —
        // no bet resolves against these.
        orientationDeg: null,
        quadrant: null,
        settleAngleDeg: null,
        durationMs: Math.round(last.t),
        // dwell the physics produced, vs the part actually shown before the cut
        rimDwellMs: Math.round(c.win.dwellMs),
        shownDwellMs: Math.round((c.win.peak - c.win.start) * FRAME_MS),
        rimTravelMm: +c.win.travelMm.toFixed(2),
        peakTiltDeg: +peakTilt.toFixed(2),
        restsOnRim: false,          // it never does; see the header
        trimmed: true,              // the clip is CUT mid-teeter, on purpose
      },
      frames: c.frames,
      diag: {
        trial: c.trial,
        launch: c.params,
        bounces: c.sim.bounces,
        fullDurationMs: Math.round(c.sim.frames[c.sim.frames.length - 1].t),
        finalTiltIfPlayedOut: +tiltDeg(c.sim.frames[c.sim.frames.length - 1].quat).toFixed(2),
        rimStartMs: Math.round(c.frames[c.win.start].t),
        rimEndMs: Math.round(last.t),
        endY: +(last.pos[1] * 1000).toFixed(2),
        endTiltDeg: +tiltDeg(last.quat).toFixed(2),
      },
    });
  }

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'clips'), { recursive: true });
  for (const c of library) {
    writeFileSync(join(OUT, 'clips', `${c.id}.json`), JSON.stringify({ meta: c.meta, frames: c.frames }));
  }
  writeFileSync(join(OUT, 'edge-library.json'), JSON.stringify({
    format: {
      version: 1,
      kind: 'edge',
      note: 'Rim landings. Real physics from the game launch distribution, TRIMMED while the coin is still on its rim.',
      restsOnRim: 'never — a cylinder on a flat plane cannot rest on its rim; every clip is cut mid-teeter',
      orientationDeg: 'null: a coin on its rim has no settled yaw, and the Edge sweeps every axis',
    },
    seed: SEED, trials: TRIALS, minDwellMs: MIN_DWELL_MS,
    found: found.length, clips: library.length, rolledAwayRejected: rolled,
    naturalRate: +(found.length / TRIALS).toFixed(5),
    physics: {
      coin: { radius: COIN.radius, halfHeight: COIN.halfHeight, mass: COIN.mass },
      dt: PHYS.dt, restitution: PHYS.restitution, friction: PHYS.friction,
      linearDamping: PHYS.linearDamping, angularDamping: PHYS.angularDamping,
      gravity: PHYS.gravity, solverIterations: PHYS.solverIterations,
    },
    index: library.map((c) => ({ id: c.id, ...c.meta })),
    diag: library.map((c) => ({ id: c.id, ...c.diag })),
    searchMs: Math.round(ms),
  }, null, 1));

  console.log(`\nedge bake: ${TRIALS} trials -> ${found.length} BALANCES >= ${MIN_DWELL_MS} ms ` +
    `(${(100 * found.length / TRIALS).toFixed(2)}%), ${rolled} more rejected as ROLLS, kept ${library.length}`);
  console.table(library.map((c) => ({
    id: c.id, dwellMs: c.meta.rimDwellMs, shownMs: c.meta.shownDwellMs, travelMm: c.meta.rimTravelMm,
    peakTilt: c.meta.peakTiltDeg, clipMs: c.meta.durationMs,
    halfFlips: c.meta.halfFlips, endY_mm: c.diag.endY,
  })));
  console.log(`  written to ${OUT}  (${Math.round(ms / 1000)}s)`);
}

main();
