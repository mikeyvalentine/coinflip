// bake/encode.js
// ---------------------------------------------------------------------------
// Writer half of the compressed clip format. Node-only: it reads bake/out and
// writes bake/out-min. The format spec, the constants and the decoder live in
// ./decode.js, which is browser-safe and has no imports — writer and reader
// share one definition so they cannot drift.
//
// Run:  node bake/encode.js
//
// FINDING THE FLIGHT/SETTLE BOUNDARY
//
// Not from contact geometry — two attempts at that both failed. clip.js's
// CONTACT_H (centre height <= 12.1 mm) is a CAMERA cue and fires early; the true
// rim-drop test (r*sin(tilt) + h*cos(tilt)) fires LATE on clips that skip,
// because by then the coin has already bounced once. Either way the window
// swallowed impact frames and the "analytic" fit blew up to 300 mm.
//
// The residual knows where the boundary is, so ask it. During free flight the
// per-step rotation increment is CONSTANT — measured axis wander 0.0009 deg and
// rate sd 0.0005% — and at first contact it jumps by degrees and percent. So
// the flight is the maximal prefix over which that increment holds steady. No
// physics guess, no threshold tuned per clip.
//
// Fitting the rate from the first two frames is not good enough either: the
// source quats are stored to 6 dp, which pins one step's angle to ~6e-4 deg, and
// integrating that over a 600 ms flight lands ~0.1 deg out. The axis and rate
// are therefore averaged over every step in the accepted window.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MAGIC, VERSION, GRAVITY, QUADRANTS, I16, flightPose } from './decode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'bake/out');
const DST = path.join(ROOT, 'bake/out-min');
const DEG = 180 / Math.PI;

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

/** axis + angle of a quaternion, canonicalised to the +w hemisphere */
function axisAngle(q) {
  let [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-15) return { axis: [0, 1, 0], ang: 0 };
  return { axis: [x / s, y / s, z / s], ang: 2 * Math.atan2(s, w) };
}

// The per-step increment is constant to ~0.001 deg / 0.001% in flight and jumps
// by degrees at impact, so these gates sit two orders of magnitude above the
// noise and three below the signal. They are separation thresholds, not tuning.
const STEP_AXIS_TOL_DEG = 0.25;
const STEP_RATE_TOL = 0.02;          // fractional

// ROTATION ALONE IS NOT ENOUGH, and this cost me an 8 mm error on the last
// flight frame of 12S-8-0. A contact impulse bends the TRAJECTORY a frame
// before it visibly bends the spin, so a rotation-only boundary hands the
// ballistic fit one frame that is already being pushed on.
//
// The second difference of a parabola is exactly the acceleration, so it is a
// local, per-frame test for "is anything touching this coin". Frame positions
// are stored to 5 dp and the second difference divides by dt^2 = 1.6e-5, which
// amplifies that quantisation to ~1-2 m/s^2 of noise; a contact impulse shows
// up as hundreds. 20 m/s^2 sits an order of magnitude clear of both.
const ACCEL_TOL = 20;                // m/s^2 away from free fall

/** Maximal prefix over which BOTH the spin and the trajectory are unforced. */
export function findFlightEnd(frames) {
  if (frames.length < 4) return 1;
  const dt = (frames[1].t - frames[0].t) / 1000;
  const steps = [];
  for (let i = 0; i < frames.length - 1; i++) {
    steps.push(axisAngle(qmul(frames[i + 1].quat, qconj(frames[i].quat))));
  }
  const ref = steps[0];
  /** free-fall check on frame i (needs i-1 and i+1) */
  const unforced = (i) => {
    if (i < 1 || i + 1 >= frames.length) return true;
    const p0 = frames[i - 1].pos, p1 = frames[i].pos, p2 = frames[i + 1].pos;
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const a = (p2[k] - 2 * p1[k] + p0[k]) / (dt * dt);
      worst = Math.max(worst, Math.abs(a - (k === 1 ? -GRAVITY : 0)));
    }
    return worst <= ACCEL_TOL;
  };
  let end = 1;
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    const dot = Math.abs(s.axis[0] * ref.axis[0] + s.axis[1] * ref.axis[1] + s.axis[2] * ref.axis[2]);
    const axisDev = Math.acos(Math.max(-1, Math.min(1, dot))) * DEG;
    const rateDev = Math.abs(s.ang - ref.ang) / ref.ang;
    if (axisDev > STEP_AXIS_TOL_DEG || rateDev > STEP_RATE_TOL) break;
    if (!unforced(i) || !unforced(i + 1)) break;
    end = i + 1;
  }
  return end;
}

/** Average axis + rate over the whole accepted window — see the header. */
function fitSpin(frames, end, dtSec) {
  const axes = [], angs = [];
  for (let i = 0; i < end; i++) {
    const { axis, ang } = axisAngle(qmul(frames[i + 1].quat, qconj(frames[i].quat)));
    axes.push(axis); angs.push(ang);
  }
  const m = [0, 1, 2].map((k) => axes.reduce((a, c) => a + c[k], 0) / axes.length);
  const n = Math.hypot(...m) || 1;
  const meanAng = angs.reduce((a, c) => a + c, 0) / angs.length;
  return { axis: m.map((v) => v / n), rate: meanAng / dtSec };
}

/** Least squares p0, v0 with g pinned. */
function fitBallistic(frames, end) {
  const p0 = [0, 0, 0], v0 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let n = 0, st = 0, stt = 0, sy = 0, sty = 0;
    for (let i = 0; i <= end; i++) {
      const t = frames[i].t / 1000;
      const y = frames[i].pos[k] + (k === 1 ? 0.5 * GRAVITY * t * t : 0);
      n++; st += t; stt += t * t; sy += y; sty += t * y;
    }
    v0[k] = (n * sty - st * sy) / (n * stt - st * st);
    p0[k] = (sy - v0[k] * st) / n;
  }
  return { p0, v0 };
}

/**
 * How far the settle can be thinned before it visibly loses the motion.
 *
 * ADAPTIVE, not a fixed stride. A settle is a bounce (fast), a ring-down
 * (slowing), then a coin sitting still. One global stride has to be tight
 * enough for the bounce and then spends most of its budget re-storing a
 * stationary coin — measured, a uniform stride only managed 1.10x.
 *
 * So: greedy forward fit. Keep a key, extend as far as every dropped frame
 * still lands within tolerance of the lerp/slerp between the bracketing keys,
 * then keep the last frame that held and start again. Samples end up where the
 * motion is.
 */
const SETTLE_POS_TOL = 3e-4;         // 0.3 mm
const SETTLE_ROT_TOL = 1.5;          // deg
const MAX_KEY_GAP = 40;              // frames; bounds interpolation over a lull

function slerpErrDeg(a, b, u, target) {
  let d = qdot(a, b); const sign = d < 0 ? -1 : 1; d = Math.abs(d);
  let q;
  if (d > 0.9995) q = a.map((v, j) => v + (sign * b[j] - v) * u);
  else {
    const th = Math.acos(Math.min(1, d)), s = Math.sin(th);
    const w0 = Math.sin((1 - u) * th) / s, w1 = Math.sin(u * th) / s;
    q = a.map((v, j) => v * w0 + sign * b[j] * w1);
  }
  const nn = Math.hypot(...q) || 1;
  return 2 * Math.acos(Math.min(1, Math.abs(qdot(q.map((v) => v / nn), target)))) * DEG;
}

/** true if every frame strictly between k0 and k1 is inside tolerance */
function spanFits(frames, k0, k1) {
  for (let i = k0 + 1; i < k1; i++) {
    const u = (i - k0) / (k1 - k0);
    for (let k = 0; k < 3; k++) {
      const lerp = frames[k0].pos[k] + (frames[k1].pos[k] - frames[k0].pos[k]) * u;
      if (Math.abs(lerp - frames[i].pos[k]) > SETTLE_POS_TOL) return false;
    }
    if (slerpErrDeg(frames[k0].quat, frames[k1].quat, u, frames[i].quat) > SETTLE_ROT_TOL) return false;
  }
  return true;
}

/** Indices to keep from [start, last). The final frame is stored separately. */
function chooseKeys(frames, start) {
  const last = frames.length - 1;
  const keys = [];
  let k0 = start;
  if (k0 >= last) return keys;
  keys.push(k0);
  while (k0 < last - 1) {
    let hi = Math.min(k0 + MAX_KEY_GAP, last);
    // grow while it fits, then binary-search the boundary
    let lo = k0 + 1, best = k0 + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (spanFits(frames, k0, mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best >= last) break;
    keys.push(best);
    k0 = best;
  }
  return keys;
}

/** Build the in-memory record for one source clip. */
export function encodeClip(id, clip) {
  const f = clip.frames;
  const dtMs = f[1].t - f[0].t;
  const end = findFlightEnd(f);
  const { axis, rate } = fitSpin(f, end, dtMs / 1000);
  const { p0, v0 } = fitBallistic(f, end);
  const flight = { p0, v0, q0: f[0].quat.slice(), axis, rate };

  const settleStart = end + 1;
  const keyIdx = chooseKeys(f, settleStart);
  const settle = keyIdx.map((i) => ({ idx: i, pos: f[i].pos, quat: f[i].quat }));

  // quantisation box for the settle positions, per clip
  const posMin = [Infinity, Infinity, Infinity], posMax = [-Infinity, -Infinity, -Infinity];
  for (const fr of settle) for (let k = 0; k < 3; k++) {
    posMin[k] = Math.min(posMin[k], fr.pos[k]); posMax[k] = Math.max(posMax[k], fr.pos[k]);
  }
  for (let k = 0; k < 3; k++) {
    if (!Number.isFinite(posMin[k])) { posMin[k] = 0; posMax[k] = 1; }
    if (posMax[k] - posMin[k] < 1e-9) posMax[k] = posMin[k] + 1e-9;
  }
  const posScale = [0, 1, 2].map((k) => posMax[k] - posMin[k]);

  return {
    id, meta: clip.meta, dtMs,
    totalFrames: f.length, flightFrames: end + 1,
    flight, settle, posMin, posScale,
    finalPos: f[f.length - 1].pos.slice(), finalQuat: f[f.length - 1].quat.slice(),
  };
}

/** Serialise every record into one packed buffer. */
export function packRecords(recs, sourceFps) {
  const bodies = recs.map((r) => {
    const idBytes = Buffer.from(r.id, 'ascii');
    const size = 1 + idBytes.length + 4 + 12 + 8 + 4 + 56 + 24 + r.settle.length * 16 + 28;
    const b = Buffer.alloc(size);
    let o = 0;
    b.writeUInt8(idBytes.length, o); o += 1;
    idBytes.copy(b, o); o += idBytes.length;
    b.writeUInt8(r.meta.halfFlips, o); o += 1;
    b.writeUInt8(r.meta.side === 'Heads' ? 1 : 0, o); o += 1;
    b.writeUInt8(QUADRANTS.indexOf(r.meta.quadrant), o); o += 1;
    b.writeUInt8(0, o); o += 1;                 // reserved (was a fixed stride)
    b.writeFloatLE(r.meta.orientationDeg, o); o += 4;
    b.writeFloatLE(r.meta.durationMs, o); o += 4;
    b.writeFloatLE(r.meta.energy ?? 0, o); o += 4;
    b.writeUInt16LE(r.totalFrames, o); o += 2;
    b.writeUInt16LE(r.flightFrames, o); o += 2;
    b.writeUInt16LE(r.settle.length, o); o += 2;
    b.writeUInt16LE(0, o); o += 2;
    b.writeFloatLE(r.dtMs, o); o += 4;
    const wf = (arr) => { for (const v of arr) { b.writeFloatLE(v, o); o += 4; } };
    wf(r.flight.p0); wf(r.flight.v0); wf(r.flight.q0); wf(r.flight.axis);
    b.writeFloatLE(r.flight.rate, o); o += 4;
    wf(r.posMin); wf(r.posScale);
    for (const fr of r.settle) {
      b.writeUInt16LE(fr.idx, o); o += 2;
      for (let k = 0; k < 3; k++) {
        const u = (fr.pos[k] - r.posMin[k]) / r.posScale[k];       // 0..1
        b.writeInt16LE(Math.max(-I16, Math.min(I16, Math.round((u * 2 - 1) * I16))), o); o += 2;
      }
      for (let k = 0; k < 4; k++) {
        b.writeInt16LE(Math.max(-I16, Math.min(I16, Math.round(fr.quat[k] * I16))), o); o += 2;
      }
    }
    wf(r.finalPos); wf(r.finalQuat);
    return b;
  });

  const headerSize = 12 + recs.length * 4;
  const head = Buffer.alloc(headerSize);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt16LE(VERSION, 4);
  head.writeUInt16LE(recs.length, 6);
  head.writeFloatLE(sourceFps, 8);
  let off = headerSize;
  bodies.forEach((b, i) => { head.writeUInt32LE(off, 12 + i * 4); off += b.length; });
  return Buffer.concat([head, ...bodies]);
}

// --- CLI -------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const lib = JSON.parse(await fs.readFile(path.join(SRC, 'library.json'), 'utf8'));
  const recs = [];
  let rawBytes = 0, flightFrames = 0, settleFramesKept = 0, settleFramesSrc = 0, totalFrames = 0;
  for (const e of lib.index) {
    const file = path.join(SRC, 'clips', e.id + '.json');
    const buf = await fs.readFile(file);
    rawBytes += buf.length;
    const clip = JSON.parse(buf.toString('utf8'));
    const rec = encodeClip(e.id, clip);
    recs.push(rec);
    flightFrames += rec.flightFrames;
    settleFramesSrc += rec.totalFrames - rec.flightFrames;
    settleFramesKept += rec.settle.length;
    totalFrames += rec.totalFrames;
  }
  const packed = packRecords(recs, lib.format.framesPerSecond ?? 250);
  const gz = zlib.gzipSync(packed, { level: 9 });
  await fs.mkdir(DST, { recursive: true });
  await fs.writeFile(path.join(DST, 'clips.cfc'), packed);
  await fs.writeFile(path.join(DST, 'clips.cfc.gz'), gz);
  // the index the renderer needs for selection, without any frame data
  await fs.writeFile(path.join(DST, 'index.json'), JSON.stringify({
    format: { version: VERSION, pack: 'clips.cfc', sourceFps: lib.format.framesPerSecond ?? 250 },
    seed: lib.seed, perCell: lib.perCell, cellCount: lib.cellCount, clips: lib.clips,
    physics: lib.physics, launch: lib.launch, index: lib.index,
  }));
  const idxBytes = (await fs.stat(path.join(DST, 'index.json'))).size;

  const kb = (n) => (n / 1024).toFixed(1) + ' kB';
  console.log(`clips              ${recs.length}`);
  console.log(`frames total       ${totalFrames}  (flight ${(100 * flightFrames / totalFrames).toFixed(1)}%)`);
  console.log(`settle frames      ${settleFramesSrc} -> ${settleFramesKept} kept `
    + `(${(settleFramesSrc / Math.max(1, settleFramesKept)).toFixed(2)}x decimation)`);
  console.log('');
  console.log(`raw JSON clips     ${kb(rawBytes)}`);
  console.log(`packed .cfc        ${kb(packed.length)}   (${(rawBytes / packed.length).toFixed(1)}x)`);
  console.log(`packed + gzip      ${kb(gz.length)}   (${(rawBytes / gz.length).toFixed(1)}x)`);
  console.log(`index.json         ${kb(idxBytes)}`);
  console.log(`TOTAL on the wire  ${kb(gz.length + idxBytes)}   (index gzips further when served)`);
}
