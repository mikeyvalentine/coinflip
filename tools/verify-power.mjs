// tools/verify-power.mjs
// ---------------------------------------------------------------------------
// Headless sweep for the power meter, the motion-blur planner and the rest
// pose. Everything here runs in Node with no GPU and no DOM, because the
// preview pane is usually hidden and cannot be trusted to render or to fire
// requestAnimationFrame.
//
// Run: node tools/verify-power.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as THREE from 'three';

import { sha256hex } from '../flip3d/sha256.js';
import { selectVariant as browserSelectVariant, targetEnergy } from '../flip3d/variant.js';
import { selectVariant as nodeSelectVariant } from '../identity.js';
import { throwProfile, clipLaunchSpeed, outcomeBand, POWER_NARROWS_BAND, MIN_POWER, LEADIN } from '../flip3d/power.js';
import { createMotionBlur, QUALITY, DEG_PER_SAMPLE } from '../flip3d/blur.js';
import { loadClipLibrary } from '../flip3d/library.js';
import { resolveFlip } from '../flip3d/outcome.js';
import { verifyClip, analyzeClip, buildProceduralClip } from '../flip3d/clip.js';
import {
  SPIN_VALUES, QUADRANTS, expectedSide, quadrantFromOrientation,
  orientationFromQuat, restQuatForFace, REST_ORIENTATION_DEG, upDot, ORIENT_TOL_DEG,
} from '../flip3d/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (msg, extra) => { failures++; console.log('  FAIL', msg, extra ? JSON.stringify(extra) : ''); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); return cond; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ===========================================================================
console.log('=== (1) sha256.js reproduces node:crypto exactly ===');
{
  let n = 0, bad = 0;
  const samples = ['', 'a', 'variant::deadbeef', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(119)];
  for (let i = 0; i < 3000; i++) samples.push('variant::' + createHash('sha256').update(String(i)).digest('hex'));
  for (const s of samples) {
    n++;
    if (sha256hex(s) !== createHash('sha256').update(s).digest('hex')) { bad++; if (bad < 3) fail('sha256 mismatch', { s: s.slice(0, 40) }); }
  }
  console.log(`  ${n} strings, ${bad} mismatches (incl. every padding boundary 55/56/63/64/119)`);
  failures += bad ? 0 : 0;
}

// ===========================================================================
console.log('\n=== (2) flip3d/variant.js is a faithful mirror of identity.js#selectVariant ===');
{
  let n = 0, bad = 0;
  for (let poolSize of [1, 2, 3, 5, 8, 12]) {
    const variants = Array.from({ length: poolSize }, (_, i) => ({ id: `c${i}`, energy: poolSize === 1 ? 0.5 : +(i / (poolSize - 1)).toFixed(4) }));
    for (let s = 0; s < 120; s++) {
      const seedHex = createHash('sha256').update('seed' + s).digest('hex');
      for (const daringness of [0, 0.25, 0.5, 0.75, 1]) {
        for (const flickForce of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) {
          n++;
          const a = browserSelectVariant(variants, { daringness, flickForce, seedHex });
          const b = nodeSelectVariant(variants, { daringness, flickForce, seedHex });
          if ((a && a.id) !== (b && b.id)) { bad++; if (bad < 3) fail('variant mirror diverged', { poolSize, daringness, flickForce, a: a && a.id, b: b && b.id }); }
        }
      }
    }
  }
  console.log(`  ${n} (pool x seed x daringness x power) cases, ${bad} divergences`);
}

// ===========================================================================
console.log('\n=== (3) REST POSE: the coin sits at ORIENTATION 0 = NORTH before a throw ===');
{
  for (const face of ['Heads', 'Tails']) {
    const q = restQuatForFace(face);
    const deg = orientationFromQuat(q);
    const up = upDot(q) >= 0 ? 'Heads' : 'Tails';
    // where the design's 12 o'clock (body +X) actually points in world space
    const v = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(q));
    console.log(`  ${face}: orientation ${deg.toFixed(6)} deg, face up ${up}, body +X -> [${v.toArray().map((x) => +x.toFixed(6))}]`);
    ok(Math.abs(deg - REST_ORIENTATION_DEG) < 1e-9, `${face} rest orientation is not ${REST_ORIENTATION_DEG}`, { deg });
    ok(up === face, `${face} rest pose shows the wrong face`);
    ok(Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9 && Math.abs(v.z + 1) < 1e-9, `${face} 12 o'clock is not world -Z (North)`, v.toArray());
  }
  // The rest pose must be a POSE, not a redefinition: parking the coin cannot
  // move what orientationFromQuat() reports for any other rotation.
  let drift = 0;
  for (let i = 0; i < 2000; i++) {
    const q = new THREE.Quaternion().random().toArray();
    const before = orientationFromQuat(q);
    restQuatForFace(i % 2 ? 'Heads' : 'Tails');
    if (orientationFromQuat(q) !== before) drift++;
  }
  ok(drift === 0, 'rest pose changed the meaning of orientationFromQuat', { drift });
  // A rest pose asked for a specific angle must land on it (the generalisation
  // the settle reading relies on).
  let angBad = 0;
  for (const want of [0, 0.01, 45, 89.99, 90, 137.42, 180, 269.99, 270, 359.99]) {
    for (const face of ['Heads', 'Tails']) {
      const got = orientationFromQuat(restQuatForFace(face, want));
      if (Math.abs(((got - want + 540) % 360) - 180) > 1e-9) { angBad++; fail('rest yaw missed its target', { face, want, got }); }
    }
  }
  console.log(`  arbitrary rest angles: ${angBad} misses; orientationFromQuat drift across 2000 random rotations: ${drift}`);
}

// ===========================================================================
console.log('\n=== (4) THE BOUNDARY: the spin band defaults to all 32 and power cannot move an outcome ===');
{
  ok(POWER_NARROWS_BAND === false, 'POWER_NARROWS_BAND is on — power is changing the odds');
  ok(outcomeBand(SPIN_VALUES, 0) === SPIN_VALUES, 'outcomeBand(0) did not return the full ladder');
  ok(outcomeBand(SPIN_VALUES, 1) === SPIN_VALUES, 'outcomeBand(1) did not return the full ladder');
  ok(outcomeBand(SPIN_VALUES, 0.5).length === 32, 'band is not 32 values');

  // Old call === new call === explicit full band, for every seed.
  const N = 20000;
  let bad = 0;
  const hist = Object.fromEntries(SPIN_VALUES.map((s) => [s, 0]));
  const sideHist = { Heads: 0, Tails: 0 };
  for (let i = 0; i < N; i++) {
    const seed = 'band::' + i;
    const a = await resolveFlip(seed);                                  // pre-power call shape
    const b = await resolveFlip(seed, null, {});                        // new arg, omitted band
    const c = await resolveFlip(seed, null, { band: SPIN_VALUES });     // explicit full band
    const d = await resolveFlip(seed, null, { band: outcomeBand(SPIN_VALUES, Math.random()) });
    hist[a.spins]++; sideHist[a.side]++;
    for (const other of [b, c, d]) {
      if (other.spins !== a.spins || other.side !== a.side || other.startFace !== a.startFace
        || other.quadrant !== a.quadrant || other.orientationDeg !== a.orientationDeg) {
        bad++; if (bad < 3) fail('band parameter changed an outcome', { seed, a, other });
      }
    }
  }
  const counts = Object.values(hist);
  const exp = N / 32;
  const chi = counts.reduce((s, c2) => s + (c2 - exp) ** 2 / exp, 0);
  console.log(`  ${N} seeds x 4 call shapes: ${bad} divergences`);
  console.log(`  spin uniformity chi-square ${chi.toFixed(1)} (df=31, expect < ~55); heads rate ${(sideHist.Heads / N).toFixed(4)}`);
  ok(chi < 60, 'spin draw is not uniform', { chi });
  ok(Math.abs(sideHist.Heads / N - 0.5) < 0.02, 'side draw is not 50/50');

  // The seam must stay stubbed, loudly.
  let threw = false;
  try { const { bandForPower } = await import('../flip3d/power.js'); bandForPower(SPIN_VALUES, 1); } catch { threw = true; }
  ok(threw, 'bandForPower() is implemented but POWER_NARROWS_BAND is false — that is a trap');
}

// ===========================================================================
console.log('\n=== (5) power -> the visible character of the throw ===');
{
  const rows = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const t = throwProfile(p, { launchSpeed: 2.6, launchHeight: 0.2193, daringness: 0.5 });
    return {
      power: p,
      leadInMs: +t.leadInMs.toFixed(1),
      antic: +t.leadInAnticipation.toFixed(3),
      exitSpeed: +t.leadInExitSpeed.toFixed(2),
      airborneSec: +t.airborneSec.toFixed(3),
      apexM: +t.proceduralApexM.toFixed(3),
      camPulloutMs: +t.camPulloutMs.toFixed(0),
      flickForce: t.flickForce,
    };
  });
  console.table(rows);
  for (let i = 1; i < rows.length; i++) {
    ok(rows[i].leadInMs < rows[i - 1].leadInMs, 'lead-in did not shorten with power', rows[i]);
    ok(rows[i].exitSpeed > rows[i - 1].exitSpeed, 'lead-in exit speed did not rise with power', rows[i]);
    ok(rows[i].airborneSec > rows[i - 1].airborneSec, 'airborne time did not rise with power', rows[i]);
    ok(rows[i].apexM > rows[i - 1].apexM, 'procedural apex did not rise with power', rows[i]);
    ok(rows[i].camPulloutMs < rows[i - 1].camPulloutMs, 'camera pullout did not quicken', rows[i]);
    ok(rows[i].flickForce === rows[i].power, 'flickForce is not the power');
  }
  // The exit speed must bracket the bake's real launch range, or the handoff
  // from the lead-in into the clip would visibly jerk.
  const lo = throwProfile(0, { launchSpeed: 2.05, launchHeight: 0.2193 });
  const hi = throwProfile(1, { launchSpeed: 3.30, launchHeight: 0.2193 });
  console.log(`  lead-in span across the bake's launch range: ${hi.leadInMs.toFixed(0)}..${lo.leadInMs.toFixed(0)} ms`);
  ok(lo.leadInMs > hi.leadInMs, 'lead-in span inverted');

  // PROCEDURAL PATH: power really does set apex, through real ballistics.
  const apex = [];
  for (const p of [0, 0.5, 1]) {
    const t = throwProfile(p);
    const clip = buildProceduralClip(
      { startFace: 'Heads', side: 'Heads', spins: 12, orientationDeg: 40, quadrant: 'N' },
      { seed: 'apex', airborneSec: t.airborneSec },
    );
    const a = analyzeClip(clip);
    apex.push({ power: p, apexY: +a.apexY.toFixed(4), durationMs: clip.meta.durationMs, airborneMs: +a.touchdownMs.toFixed(0) });
    ok(verifyClip(clip).pass, 'power-scaled procedural clip failed verification', { p });
  }
  console.log('  procedural (renderer owns the flight):', JSON.stringify(apex));
  ok(apex[2].apexY > apex[0].apexY * 2, 'procedural apex barely moved with power', apex);
  ok(apex[2].airborneMs > apex[0].airborneMs, 'procedural flight time did not grow with power', apex);
}

// ===========================================================================
console.log('\n=== (6) motion blur planner (pure; no GPU) ===');
const fakeScene = () => {
  const mat = () => ({ clone() { return mat(); }, transparent: false, depthWrite: true, depthTest: true, opacity: 1, colorWrite: true, dispose() {} });
  const mesh = { isMesh: true, material: mat() };
  return {
    THREE, renderer: { render() {}, shadowMap: { autoUpdate: true }, autoClear: true },
    scene: { background: null }, camera: {},
    coinRoot: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), updateMatrixWorld() {} },
    coinModel: { traverse(cb) { cb(mesh); } },
    tableRoot: { visible: true },
  };
};
{
  const blur = createMotionBlur(fakeScene(), { quality: 'medium' });
  const base = { clipMs: 300, dClipMs: 1000 / 60, touchdownMs: 600, durationMs: 900, sample: () => {} };
  const rows = [];
  for (const q of ['off', 'low', 'medium', 'high']) {
    blur.quality = q;
    const r = { quality: q };
    for (const omega of [20, 42, 100, 209, 235.5]) {
      const p = blur.planShutter({ ...base, omega });
      r['w' + omega] = p ? `${p.n}x${p.sweepDeg.toFixed(0)}deg` : '-';
      ok(!(q === 'off' && p), 'planned blur while off');
      if (p) {
        ok(p.n <= QUALITY[q].maxSamples, 'over the sample cap', { q, omega, n: p.n });
        ok(p.sweepDeg / p.n <= DEG_PER_SAMPLE + 1e-6, 'sample spacing exceeded — this would band', { q, omega, spacing: p.sweepDeg / p.n });
      }
    }
    rows.push(r);
  }
  console.table(rows);

  // magnitude tracks omega
  blur.quality = 'high';
  let prev = 0;
  for (const omega of [10, 20, 42, 100, 209]) {
    const p = blur.planShutter({ ...base, omega });
    const n = p ? p.n : 0;
    ok(n >= prev, 'sample count fell as omega rose', { omega, n, prev });
    prev = n;
  }
  ok(!blur.planShutter({ ...base, omega: 0 }), 'blurred a stationary coin');
  ok(!blur.planShutter({ ...base, omega: 209, dClipMs: 0 }), 'blurred with no time elapsed');

  // the landing gate
  const gate = [];
  for (const clipMs of [300, 520, 545, 570, 600, 630, 641, 700, 900]) {
    const p = blur.planShutter({ ...base, clipMs, omega: 235 });
    gate.push({ clipMs, n: p ? p.n : 0 });
  }
  console.log('  landing gate (touchdown = 600 ms):', gate.map((g) => `${g.clipMs}:${g.n}`).join(' '));
  ok(gate.find((g) => g.clipMs === 300).n > 1, 'not blurring mid-flight');
  for (const g of gate) ok(!(g.clipMs >= 640 && g.n > 0), 'still blurring after the landing gate shut', g);

  // the documented fallback
  blur._forceFallback('test');
  ok(!blur.planShutter({ ...base, omega: 209 }), 'still planning blur after a fallback');
  ok(blur.enabled === false, 'blur reports enabled after a fallback');
  console.log('  fallback: planner goes inert and blur.enabled -> false');
}

// ===========================================================================
console.log('\n=== (7) THE 2048-CASE CLIP SWEEP — every baked clip, both start faces ===');
let library = null;
{
  const fetchShim = async (url) => {
    const rel = url.replace(/^\.\//, '');
    try {
      const buf = await fs.readFile(path.join(ROOT, rel), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(buf) };
    } catch (e) { return { ok: false, status: 404, json: async () => { throw e; } }; }
  };
  library = await loadClipLibrary({ base: './bake/out/', fetch: fetchShim });
  console.log(`  library: ${library.stats.clips} clips, ${library.stats.cells} cells, per-cell ${library.stats.perCellMin}..${library.stats.perCellMax}, ok=${library.stats.ok}`);

  let n = 0, bad = 0;
  const durations = [];
  const worst = { orient: 0, tilt: 0 };
  for (const e of library.index) {
    for (const startFace of ['Heads', 'Tails']) {
      const side = expectedSide(startFace, e.halfFlips);
      const outcome = {
        startFace, side, spins: e.halfFlips,
        orientationDeg: e.orientationDeg, quadrant: e.quadrant, edge: false, clipId: e.id,
      };
      const clip = await library.clipFor(outcome);
      const v = verifyClip(clip);
      n++;
      durations.push(clip.meta.durationMs);
      worst.orient = Math.max(worst.orient, Math.abs(v.orientationErrorDeg ?? 0));
      worst.tilt = Math.max(worst.tilt, v.finalTiltDeg);
      const matches = v.finalSide === side && v.finalQuadrant === e.quadrant
        && v.halfFlipsSeen === e.halfFlips
        && Math.abs(v.finalOrientationDeg - e.orientationDeg) < 0.011;
      if (!v.pass || !matches) {
        bad++;
        if (bad <= 5) fail('clip sweep', { id: e.id, startFace, ok: v.ok, seen: { side: v.finalSide, q: v.finalQuadrant, hf: v.halfFlipsSeen, deg: v.finalOrientationDeg }, want: { side, q: e.quadrant, hf: e.halfFlips, deg: e.orientationDeg } });
      }
    }
  }
  durations.sort((a, b) => a - b);
  console.log(`  ${n} cases, ${bad} failures`);
  console.log(`  worst settle-yaw re-derivation error ${worst.orient.toFixed(6)} deg (tolerance ${ORIENT_TOL_DEG}); worst final tilt ${worst.tilt.toFixed(3)} deg`);
  console.log(`  duration min/median/max ${durations[0]}/${durations[durations.length >> 1]}/${durations[durations.length - 1]} ms`);
  failures += bad;

  // THE SETTLE CLAIM, stated as an assertion rather than a hope: a clip that
  // declares orientationDeg X really does come to rest with its 12 o'clock X
  // degrees clockwise from North, measured off the final frame's quaternion.
  let settleBad = 0;
  const samples = [];
  for (const e of library.index) {
    const clip = await library.clipFor({
      startFace: 'Heads', side: expectedSide('Heads', e.halfFlips), spins: e.halfFlips,
      orientationDeg: e.orientationDeg, quadrant: e.quadrant, edge: false, clipId: e.id,
    });
    const last = clip.frames[clip.frames.length - 1];
    const q = new THREE.Quaternion().fromArray(last.quat);
    const v = new THREE.Vector3(1, 0, 0).applyQuaternion(q);      // the design's 12 o'clock
    const compass = ((Math.atan2(v.x, -v.z) * 180 / Math.PI) % 360 + 360) % 360;
    const err = Math.abs(((compass - e.orientationDeg + 540) % 360) - 180);
    if (err > ORIENT_TOL_DEG) { settleBad++; if (settleBad <= 3) fail('settle yaw is not the declared angle', { id: e.id, want: e.orientationDeg, got: +compass.toFixed(4) }); }
    if (samples.length < 3) samples.push({ id: e.id, declared: e.orientationDeg, measured: +compass.toFixed(4) });
  }
  console.log(`  settle-yaw-is-North-relative check over all ${library.index.length} clips: ${settleBad} failures`);
  console.log('   ', JSON.stringify(samples));
  failures += settleBad;
}

// ===========================================================================
console.log('\n=== (8) power -> variant, measured through the real library ===');
{
  const cache = new Map();
  const clipFile = async (id) => {
    if (!cache.has(id)) cache.set(id, JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out/clips', id + '.json'), 'utf8')));
    return cache.get(id);
  };
  // What a variant actually differs by, measured off its frames rather than
  // assumed from the word "energy".
  const R = 0.01025;
  function metrics(c) {
    const f = c.frames;
    let apexI = 0;
    for (let i = 1; i < f.length; i++) if (f[i].pos[1] > f[apexI].pos[1]) apexI = i;
    let tdI = f.length - 1;
    for (let i = apexI; i < f.length; i++) if (f[i].pos[1] <= R * 1.18) { tdI = i; break; }
    let ang = 0;
    for (let i = 1; i <= tdI; i++) {
      const a = f[i - 1].quat, b = f[i].quat;
      let d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
      if (d > 1) d = 1;
      ang += 2 * Math.acos(d);
    }
    const dt = (f[tdI].t - f[tdI - 1].t) / 1000;
    return {
      flightOmega: ang / ((f[tdI].t - f[0].t) / 1000),
      apex: f[apexI].pos[1],
      flightMs: f[tdI].t,
      settleMs: c.meta.durationMs - f[tdI].t,
      impact: Math.hypot(f[tdI].pos[0] - f[tdI - 1].pos[0], f[tdI].pos[1] - f[tdI - 1].pos[1], f[tdI].pos[2] - f[tdI - 1].pos[2]) / dt,
      travelCm: Math.hypot(f[f.length - 1].pos[0], f[f.length - 1].pos[2]) * 100,
    };
  }

  const rows = [];
  let cellEscapes = 0;
  for (const power of [0, 0.25, 0.5, 0.75, 1]) {
    const E = [], A = [], D = [], W = [], L = [], T = [], I = [], F = [];
    for (const [key, pool] of library.cells) {
      const v = browserSelectVariant(pool, { daringness: 0.5, flickForce: power, seedHex: 'a1b2c3d4' + key });
      if (!pool.includes(v)) cellEscapes++;
      if (v.halfFlips !== pool[0].halfFlips || v.quadrant !== pool[0].quadrant) cellEscapes++;
      const c = await clipFile(v.id);
      const mm = metrics(c);
      E.push(v.energy); A.push(mm.apex); D.push(v.durationMs); W.push(mm.flightOmega);
      T.push(mm.travelCm); I.push(mm.impact); F.push(mm.flightMs);
      L.push(throwProfile(power, { launchSpeed: clipLaunchSpeed(c), launchHeight: 0.2193 }).leadInMs);
    }
    rows.push({
      power,
      targetEnergy: +targetEnergy(0.5, power).toFixed(3),
      meanEnergy: +mean(E).toFixed(3),
      travelCm: +mean(T).toFixed(2),
      impactMs: +mean(I).toFixed(3),
      flightOmega: +mean(W).toFixed(1),
      apexM: +mean(A).toFixed(4),
      flightMs: +mean(F).toFixed(0),
      clipMs: +mean(D).toFixed(0),
      leadInMs: +mean(L).toFixed(0),
    });
  }
  console.table(rows);
  ok(cellEscapes === 0, 'a variant left its cell', { cellEscapes });
  for (let i = 1; i < rows.length; i++) {
    ok(rows[i].meanEnergy >= rows[i - 1].meanEnergy, 'mean variant energy fell as power rose', rows[i]);
    ok(rows[i].leadInMs < rows[i - 1].leadInMs, 'mean lead-in did not shorten as power rose', rows[i]);
    // The one physical quantity `energy` actually orders WITHIN a cell. See the
    // note below: it is also, by design doc §2, the one that carries no bet.
    ok(rows[i].travelCm > rows[i - 1].travelCm, 'table travel did not grow with power', rows[i]);
  }
  console.log(`  variant escapes from the drawn cell: ${cellEscapes} (must be 0)`);
  console.log('  NOTE: within a cell the bake fixes halfFlips, so tumble rate, apex and flight');
  console.log('        time are nearly constant across the 8 variants and do NOT track energy.');
  console.log('        What energy orders is horizontal launch velocity -> how far the coin');
  console.log('        skitters. That is the design-doc §2 quantity that means nothing to a');
  console.log('        bet, so it is the safest possible carrier for visible violence.');
  console.log(`        travel ${rows[0].travelCm} -> ${rows[4].travelCm} cm (+${(100 * (rows[4].travelCm / rows[0].travelCm - 1)).toFixed(0)}%)`);

  // Full end-to-end: draw an outcome, play it at power 0 and power 1, and check
  // the bet axes are byte-identical while the telling is not.
  let axesBad = 0, sameClip = 0, tested = 0;
  for (let i = 0; i < 300; i++) {
    const seed = 'e2e::' + i;
    const o = await resolveFlip(seed, library, { band: outcomeBand(SPIN_VALUES, null) });
    const seedHex = sha256hex(seed);
    const pool = library.pool(o);
    const lo = browserSelectVariant(pool, { daringness: 0.5, flickForce: 0, seedHex });
    const hi = browserSelectVariant(pool, { daringness: 0.5, flickForce: 1, seedHex });
    tested++;
    for (const v of [lo, hi]) {
      const clip = await library.clipFor(o, { variant: v });
      if (clip.meta.halfFlips !== o.spins || clip.meta.quadrant !== o.quadrant
        || clip.meta.side !== o.side || clip.meta.startFace !== o.startFace) {
        axesBad++; if (axesBad <= 3) fail('power moved a bet axis end-to-end', { seed, o, meta: clip.meta });
      }
      if (!verifyClip(clip).pass) { axesBad++; fail('power-selected clip failed verification', { id: v.id }); }
    }
    if (lo.id === hi.id) sameClip++;
  }
  console.log(`  ${tested} seeds played at power 0 and power 1: ${axesBad} bet-axis violations`);
  console.log(`  a feather and a brutal pull chose the SAME clip in ${sameClip}/${tested} cells (${(100 * sameClip / tested).toFixed(0)}%)`);

  // The library must reject an out-of-cell override rather than trust it.
  let rejected = false;
  const o = await resolveFlip('reject-me', library);
  const foreign = library.index.find((e) => e.halfFlips !== o.spins || e.quadrant !== o.quadrant);
  try { await library.clipFor(o, { variant: foreign }); } catch { rejected = true; }
  ok(rejected, 'library accepted a variant from a DIFFERENT cell — the boundary is not enforced');
  console.log(`  out-of-cell variant override rejected: ${rejected}`);
}

// ===========================================================================
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
