// bake.js — the harness. Produces the curated clip library.
//
//   node bake.js --per-cell 8 --seed coinflip-v1 --out ./out
//   node bake.js --per-cell 1 --out ./out-small        (fast end-to-end proof)
//
// STRUCTURE
//   Every clip is aimed at a cell = (halfFlips, quadrant), 32 x 4 = 128 cells.
//
//   The half-flip axis is solved BACKWARDS. Free flight to first contact is
//   t_c = (vy + sqrt(vy^2 + 2 g (y0-h_c)))/g and the heads-normal sweeps pi
//   radians per half-flip, so omega = H*pi/t_c gets us close on the first try;
//   dH/domega = t_c/pi exactly, which makes the correction a true Newton step.
//   A running bias estimate absorbs the parts the closed form does not model
//   (air damping, and the extra flips the coin performs after first contact).
//
//   The orientation axis is placed EXACTLY, using initial yaw. The collider is
//   a cylinder, symmetric about Y, so yawing the coin at launch is close to a
//   pure relabelling of the body frame (tools/yaw-detail.js: it perturbs the
//   half-flip count in 0.5% of cases and nothing else). Without this, even
//   half-flip counts pile up at one orientation and two whole quadrants become
//   unreachable — measured in tools/yaw-invariance.js.
//
//   Because yaw is not bit-exact, every emitted clip is classified from the run
//   that is actually emitted and filed under the cell it ACTUALLY landed in.
//   Targeting can miss; metadata cannot lie.

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { initRapier, simulateClip, flightTime, omegaForHalfFlips } from './sim.js';
import { classify, assertParity, quadrantRange, headingToQuadrant } from './classify.js';
import { curateCell, poolSpread } from './curate.js';
import { makeRng } from './prng.js';
import { bodyXAxis, heading } from './quat.js';
import {
  LAUNCH, PHYS, COIN, CLASSIFY, OUTPUT,
  HALF_FLIPS, QUADRANTS, CELL_COUNT, cellKey,
} from './config.js';

const DEG = 180 / Math.PI;

// --- args -------------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const PER_CELL = Number(arg('per-cell', 8));
const SEED = arg('seed', 'coinflip-bake-v1');
const OUT = arg('out', './out');
const OVERSAMPLE = Number(arg('oversample', 2.5));
const MAX_ATTEMPTS = Number(arg('max-attempts', 8));
const FPS = Number(arg('fps', OUTPUT.fps));
const QUIET = process.argv.includes('--quiet');
const NO_WRITE = process.argv.includes('--no-write');

const POOL_PER_CELL = Math.max(PER_CELL, Math.ceil(PER_CELL * OVERSAMPLE));

// ---------------------------------------------------------------------------

/**
 * Given the settled quaternion of a probe run, what initial yaw would have put
 * the coin's settled orientation at `targetDeg`?
 *
 * Pre-yawing by y sends local +X to (cos y, 0, -sin y), so the settled world
 * vector is cos(y)*a - sin(y)*c where a and c are the probe's settled world
 * images of local +X and +Z. That is exact and needs no case analysis for the
 * heads/tails sign flip — we read the sign off the derivative instead.
 */
export function solveYawForOrientation(qFinal, targetDeg) {
  const a = bodyXAxis(qFinal);
  const c = [                                    // local +Z to world (3rd column)
    2 * (qFinal.x * qFinal.z + qFinal.y * qFinal.w),
    2 * (qFinal.y * qFinal.z - qFinal.x * qFinal.w),
    1 - 2 * (qFinal.x * qFinal.x + qFinal.y * qFinal.y),
  ];
  const orientAt = (y) => heading(
    Math.cos(y) * a[0] - Math.sin(y) * c[0],
    Math.cos(y) * a[2] - Math.sin(y) * c[2]);

  const o0 = orientAt(0);
  const eps = 0.01;                              // rad
  let d = orientAt(eps) - o0;
  if (d > 180) d -= 360; if (d < -180) d += 360;
  const s = d >= 0 ? 1 : -1;                     // sign of d(orientation)/d(yaw)

  let need = (targetDeg - o0) * s;
  need = ((need % 360) + 360) % 360;
  return need / DEG;
}

// --- cell bookkeeping -------------------------------------------------------
const cells = new Map();
for (const h of HALF_FLIPS) for (const q of QUADRANTS) cells.set(cellKey(h, q), []);

const stats = {
  sims: 0, probeSims: 0, finalSims: 0,
  // gatePassed counts every sim run whose metadata survived the quality gate,
  // which is the real "yield". `banked` counts the ones that also found a home;
  // a run can be perfectly good and still be discarded because its cell was
  // already full, and conflating those two makes the physics look worse than
  // it is.
  gatePassed: 0, gateFailed: 0, banked: 0, overflow: 0,
  outOfBand: 0,
  rejects: new Map(),
  targetHit: 0, targetMissHf: 0, targetMissQuad: 0,
};
const noteReject = (r) => {
  stats.gateFailed++;
  stats.rejects.set(r, (stats.rejects.get(r) || 0) + 1);
};
/** Record the verdict of one run. Returns cls.ok. */
function score(cls) {
  // out-of-range / excluded-median are not physics failures — the sim produced
  // a fine clip, it just landed on a half-flip count the game does not use.
  if (cls.ok) { stats.gatePassed++; return true; }
  if (cls.reject === 'out-of-range' || cls.reject === 'excluded-median') {
    stats.outOfBand++;
    stats.rejects.set(cls.reject, (stats.rejects.get(cls.reject) || 0) + 1);
    return false;
  }
  noteReject(cls.reject);
  return false;
}

// Running correction for everything the closed form does not model.
let biasEma = 1.0;
const BIAS_ALPHA = 0.08;

function bank(cand) {
  const key = cellKey(cand.meta.halfFlips, cand.meta.quadrant);
  const pool = cells.get(key);
  if (!pool) return false;
  if (pool.length >= POOL_PER_CELL) { stats.overflow++; return false; }
  pool.push(cand);
  stats.banked++;
  return true;
}

function makeCandidate(sim, cls, id) {
  return { id, params: sim.params, meta: { ...cls.meta }, diag: cls.diag,
           frames: sim.frames, emittedFps: sim.emittedFps };
}

/**
 * One attempt at (targetH, targetQuad, targetOrientation).
 * Returns 'filled' | 'banked-elsewhere' | 'reject' | 'miss'.
 */
function attempt(targetH, targetQuad, targetOrient, rng, tag) {
  // vy is the free parameter; omega follows from the backwards solve.
  const vy = rng.range(LAUNCH.vyMin, LAUNCH.vyMax);
  const base = {
    y0: LAUNCH.y0, vy,
    vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
    psi: rng.range(0, 2 * Math.PI),
    spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
  };

  let omega = omegaForHalfFlips(targetH, base.y0, vy) / biasEma;
  let probe = null, probeCls = null;

  for (let it = 0; it < 4; it++) {
    omega = Math.max(LAUNCH.omegaMin * 0.6, Math.min(LAUNCH.omegaMax * 1.6, omega));
    probe = simulateClip({ ...base, omega, yaw0: rng.range(0, 2 * Math.PI) }, { fps: FPS });
    stats.sims++; stats.probeSims++;
    probeCls = classify(probe);
    score(probeCls);

    if (!probeCls.ok && probeCls.reject !== 'out-of-range' && probeCls.reject !== 'excluded-median') {
      return 'reject';
    }

    const got = probeCls.meta.halfFlips;
    // Learn the systematic part of the error.
    const predicted = (omega * flightTime(base.y0, vy)) / Math.PI;
    if (predicted > 1) biasEma += BIAS_ALPHA * (got / predicted - biasEma);

    if (got === targetH) break;
    // True Newton step: dH/domega = t_c / pi.
    omega += ((targetH - got) * Math.PI) / flightTime(base.y0, vy);
    if (it === 3) {
      // Out of iterations. The run is still a perfectly good clip — file it
      // where it landed rather than throwing the work away.
      if (probeCls.ok) { stats.targetMissHf++; return bank(makeCandidate(probe, probeCls, tag)) ? 'banked-elsewhere' : 'miss'; }
      return 'reject';
    }
  }

  // Half-flip count is on target. Now place the orientation exactly.
  const yaw0 = solveYawForOrientation(probe.finalRot, targetOrient) + (probe.params.yaw0 || 0);
  const final = simulateClip({ ...base, omega, yaw0 }, { fps: FPS });
  stats.sims++; stats.finalSims++;
  const cls = classify(final);
  score(cls);

  if (!cls.ok) {
    // The yaw perturbation pushed it out of spec (rare). Fall back to the probe.
    if (probeCls.ok) return bank(makeCandidate(probe, probeCls, tag)) ? 'banked-elsewhere' : 'miss';
    return 'reject';
  }

  const cand = makeCandidate(final, cls, tag);
  if (cls.meta.halfFlips === targetH && cls.meta.quadrant === targetQuad) stats.targetHit++;
  else if (cls.meta.halfFlips !== targetH) stats.targetMissHf++;
  else stats.targetMissQuad++;

  return bank(cand) ? 'filled' : 'miss';
}

// --- main -------------------------------------------------------------------
async function main() {
  await initRapier();
  const t0 = process.hrtime.bigint();

  const log = (...a) => { if (!QUIET) console.log(...a); };
  log(`bake: per-cell ${PER_CELL}, pool/cell ${POOL_PER_CELL}, ${CELL_COUNT} cells, seed "${SEED}"`);
  log(`coin: r=${COIN.radius} m, halfH=${COIN.halfHeight} m, m=${COIN.mass} kg, rho=${COIN.density.toFixed(1)} kg/m3`);
  log(`phys: dt=1/${Math.round(1 / PHYS.dt)}, restitution=${PHYS.restitution}, friction=${PHYS.friction}, ` +
      `linDamp=${PHYS.linearDamping}, angDamp=${PHYS.angularDamping}, CCD on, ${PHYS.solverIterations} solver iters`);

  // Work list: every (cell, slot) pair, shuffled so no cell is systematically
  // baked with a "warmer" bias estimate than another.
  const work = [];
  for (const h of HALF_FLIPS) {
    for (const q of QUADRANTS) {
      const [lo, hi] = quadrantRange(q);
      for (let s = 0; s < POOL_PER_CELL; s++) {
        // Spread target orientations through the quadrant so the fine-grained
        // orientation axis (design doc 6.5) is uniform too. Stratified with a
        // seeded jitter inside each stratum, NOT stratum centres: centres put
        // every settled yaw on a regular lattice, which is uniform at quadrant
        // resolution but predictable at the hundredth-of-a-degree resolution
        // the design says is the literal truth.
        const j = makeRng(SEED, `orient:${cellKey(h, q)}:${s}`).f();
        const frac = (s + j) / POOL_PER_CELL;
        work.push({ h, q, orient: lo + frac * (hi - lo), slot: s });
      }
    }
  }
  makeRng(SEED, 'worklist').shuffle(work);

  let done = 0;
  for (const w of work) {
    const key = cellKey(w.h, w.q);
    if (cells.get(key).length >= POOL_PER_CELL) { done++; continue; }
    const rng = makeRng(SEED, `cell:${key}:slot:${w.slot}`);
    for (let a = 0; a < MAX_ATTEMPTS; a++) {
      const r = attempt(w.h, w.q, w.orient, rng, `${key}-${w.slot}-${a}`);
      if (r === 'filled') break;
      if (r === 'banked-elsewhere' && cells.get(key).length >= POOL_PER_CELL) break;
    }
    done++;
    if (!QUIET && done % 200 === 0) {
      const filled = [...cells.values()].filter((p) => p.length >= PER_CELL).length;
      process.stdout.write(`\r  ${done}/${work.length} slots, ${stats.sims} sims, ` +
        `${filled}/${CELL_COUNT} cells at quota   `);
    }
  }
  if (!QUIET) process.stdout.write('\n');

  const bakeMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // --- curate ---------------------------------------------------------------
  const tC = process.hrtime.bigint();
  const library = [];
  const cellReport = [];
  let underfilled = 0;
  for (const h of HALF_FLIPS) {
    for (const q of QUADRANTS) {
      const key = cellKey(h, q);
      const pool = cells.get(key);
      const chosen = curateCell(pool, PER_CELL);
      if (chosen.length < PER_CELL) underfilled++;
      cellReport.push({ cell: key, halfFlips: h, quadrant: q, pool: pool.length,
        kept: chosen.length, spread: +poolSpread(chosen).toFixed(4) });
      for (const c of chosen) library.push(c);
    }
  }
  const curateMs = Number(process.hrtime.bigint() - tC) / 1e6;

  // --- integrity audit ------------------------------------------------------
  // Re-derive the parity invariant from the EXPORTED frames of every clip. If
  // meta and geometry ever disagree the bake stops rather than shipping odds
  // that are quietly wrong.
  for (const c of library) assertParity(c);

  // --- write ----------------------------------------------------------------
  let bytes = 0;
  if (!NO_WRITE) {
    if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
    mkdirSync(join(OUT, 'clips'), { recursive: true });
    mkdirSync(join(OUT, 'diag'), { recursive: true });

    for (const c of library) {
      // EXACTLY the shared contract shape, nothing else.
      const clip = { meta: c.meta, frames: c.frames };
      const s = JSON.stringify(clip);
      bytes += s.length;
      writeFileSync(join(OUT, 'clips', `${c.id}.json`), s);
      // Everything else lives in a sidecar so the clip stays contract-clean.
      writeFileSync(join(OUT, 'diag', `${c.id}.json`), JSON.stringify({
        id: c.id, launch: c.params, energyRaw: c.energyRaw, diag: c.diag,
        halfFlipTicksMs: c.diag.ticks, contactsMs: c.diag.contactsMs,
      }));
    }

    writeFileSync(join(OUT, 'library.json'), JSON.stringify({
      format: {
        version: 1,
        units: 'metres, Y-up, gravity -9.81 m/s^2',
        frameTime: 'milliseconds',
        framesPerSecond: library[0]?.emittedFps ?? FPS,
        quat: '[x,y,z,w]',
        pos: 'coin centre of mass, metres',
        canonical: 'heads-face normal is +Y when heads-up; coin lies in the XZ plane',
        startFace: 'ALL clips start HEADS-UP. Landing side follows from half-flip parity; ' +
                   'the renderer pre-rotates 180 deg for a tails-up start and the landing face follows.',
        orientationDeg: 'settled yaw of the coin: local +X taken to world, projected to XZ, ' +
                        'measured clockwise from -Z, in [0,360). NOT table position.',
        quadrant: 'N=[0,90) E=[90,180) S=[180,270) W=[270,360) of orientationDeg',
        settleAngleDeg: 'identical to orientationDeg; retained for the original contract key',
        energy: '0..1 gentle->violent, rank-normalised within each cell for selectVariant()',
        halfFlips: 'integers 8..40 excluding 24; player-facing spin = halfFlips/2',
      },
      seed: SEED, perCell: PER_CELL, cellCount: CELL_COUNT, clips: library.length,
      physics: {
        coin: { radius: COIN.radius, halfHeight: COIN.halfHeight, mass: COIN.mass, density: COIN.density },
        dt: PHYS.dt, restitution: PHYS.restitution, friction: PHYS.friction,
        linearDamping: PHYS.linearDamping, angularDamping: PHYS.angularDamping,
        solverIterations: PHYS.solverIterations, ccd: true,
        gravity: PHYS.gravity, table: `${PHYS.tableHalfExtent * 2} m square`,
      },
      launch: LAUNCH,
      cells: cellReport,
      index: library.map((c) => ({ id: c.id, ...c.meta, energyRaw: c.energyRaw })),
    }, null, 1));
  }

  // --- report ---------------------------------------------------------------
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const counts = cellReport.map((c) => c.kept);
  const min = Math.min(...counts), max = Math.max(...counts);
  const poolCounts = cellReport.map((c) => c.pool);

  console.log('\n=== BAKE REPORT ===');
  console.log(`clips written        ${library.length} (target ${PER_CELL * CELL_COUNT})`);
  console.log(`cells                ${CELL_COUNT}  (32 half-flips x 4 quadrants)`);
  console.log(`clips per cell       min ${min}, max ${max}  ${min === max ? '(EXACTLY UNIFORM)' : '(NOT UNIFORM)'}`);
  console.log(`under-filled cells   ${underfilled}`);
  console.log(`candidate pool/cell  min ${Math.min(...poolCounts)}, max ${Math.max(...poolCounts)}, target ${POOL_PER_CELL}`);
  console.log(`sim runs             ${stats.sims} (${stats.probeSims} probe + ${stats.finalSims} placement)`);
  console.log(`QUALITY-GATE YIELD   ${stats.gatePassed}/${stats.sims} = ` +
    `${((100 * stats.gatePassed) / stats.sims).toFixed(1)}% of runs produced a usable clip`);
  console.log(`  physics failures   ${stats.gateFailed} (${((100 * stats.gateFailed) / stats.sims).toFixed(1)}%) ` +
    `— no-settle / edge-landing / off-surface / too-far / ambiguous-spin`);
  console.log(`  out-of-band        ${stats.outOfBand} (${((100 * stats.outOfBand) / stats.sims).toFixed(1)}%) ` +
    `— clean clips whose half-flip count is outside 8..40\\{24}`);
  console.log(`banked / overflow    ${stats.banked} kept / ${stats.overflow} good clips discarded (cell already full)`);
  console.log(`sims per kept clip   ${(stats.sims / Math.max(1, library.length)).toFixed(2)}`);
  console.log(`targeting            ${stats.targetHit} on target, ${stats.targetMissHf} missed half-flips, ` +
    `${stats.targetMissQuad} missed quadrant`);
  console.log(`reject reasons       ${JSON.stringify(Object.fromEntries([...stats.rejects].sort((a, b) => b[1] - a[1])))}`);
  console.log(`learned bias factor  ${biasEma.toFixed(4)} (measured half-flips / closed-form prediction)`);
  console.log(`timing               bake ${(bakeMs / 1000).toFixed(1)}s, curate ${curateMs.toFixed(0)}ms, ` +
    `total ${(totalMs / 1000).toFixed(1)}s  (${(bakeMs / Math.max(1, stats.sims)).toFixed(2)} ms/sim)`);
  if (!NO_WRITE) {
    console.log(`output               ${OUT}  ${(bytes / 1048576).toFixed(2)} MB of clip JSON, ` +
      `${(bytes / Math.max(1, library.length) / 1024).toFixed(1)} KB/clip`);
  }

  const under = cellReport.filter((c) => c.kept < PER_CELL);
  if (under.length) {
    console.log(`\nUNDER-FILLED CELLS (${under.length}):`);
    for (const c of under.slice(0, 40)) console.log(`  ${c.cell}: ${c.kept}/${PER_CELL} (pool ${c.pool})`);
    if (under.length > 40) console.log(`  ... and ${under.length - 40} more`);
  }

  // distribution checks
  const sideCount = { Heads: 0, Tails: 0 };
  const quadCount = { N: 0, E: 0, S: 0, W: 0 };
  const hfCount = new Map();
  const orientBins = new Array(12).fill(0);
  for (const c of library) {
    sideCount[c.meta.side]++;
    quadCount[c.meta.quadrant]++;
    hfCount.set(c.meta.halfFlips, (hfCount.get(c.meta.halfFlips) || 0) + 1);
    orientBins[Math.min(11, Math.floor(c.meta.orientationDeg / 30))]++;
  }
  console.log(`\nside split (heads-up starts): ${JSON.stringify(sideCount)} ` +
    `— must be exactly parity-determined, 16 even + 16 odd half-flip values`);
  console.log(`quadrant split: ${JSON.stringify(quadCount)}`);
  console.log(`half-flip values present: ${hfCount.size}/32`);
  console.log(`orientation, 30-deg bins: ${orientBins.join(' ')}`);

  if (!NO_WRITE) {
    writeFileSync(join(OUT, 'bake-stats.json'), JSON.stringify({
      seed: SEED, perCell: PER_CELL, clips: library.length,
      sims: stats.sims, gatePassed: stats.gatePassed, gateFailed: stats.gateFailed,
      outOfBand: stats.outOfBand, overflow: stats.overflow,
      rejects: Object.fromEntries(stats.rejects), biasEma,
      minPerCell: min, maxPerCell: max, underfilled,
      bakeMs: +bakeMs.toFixed(0), totalMs: +totalMs.toFixed(0),
      sideCount, quadCount, orientBins,
    }, null, 1));
  }

  return { library, cellReport, stats, min, max, underfilled };
}

main().catch((e) => { console.error(e); process.exit(1); });
