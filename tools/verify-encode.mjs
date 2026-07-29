// tools/verify-encode.mjs
// ---------------------------------------------------------------------------
// The compressed clip library is only allowed to change how a flip LOOKS. It
// may not move a bet axis by any amount. This sweeps all 1024 clips through
// encode -> pack -> read -> decode and checks the round trip against the
// originals.
//
// What it is really guarding:
//   halfFlips   counted off the DECODED frames, the same way the player counts
//               them (up-axis horizon crossings). This is the spin bet.
//   orientation the settled yaw, to contract.js ORIENT_TOL_DEG (0.011 deg) —
//               the displayed hundredths ARE the truth.
//   side        re-derived from the decoded final pose.
//   quadrant    bucketed from the decoded orientation.
//
// Run: node tools/verify-encode.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { encodeClip, packRecords, findFlightEnd } from '../bake/encode.js';
import { readPack, decodeClip, flightPose } from '../bake/decode.js';
import {
  upDot, faceUpFromQuat, orientationFromQuat, roundOrientation,
  quadrantFromOrientation, ORIENT_TOL_DEG, COIN_HALF_THICKNESS_M, normDeg,
} from '../flip3d/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'bake/out');
let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };
const DEG = 180 / Math.PI;
const kb = (n) => (n / 1024).toFixed(1) + ' kB';
const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const degBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(qdot(a, b)))) * DEG;
const degDelta = (a, b) => { const d = normDeg(a - b); return d > 180 ? 360 - d : d; };

/** exactly how player.js counts: sign changes of the coin's up axis */
function countHalfFlips(frames) {
  let n = 0, sign = Math.sign(upDot(frames[0].quat)) || 1;
  for (let i = 1; i < frames.length; i++) {
    const s = Math.sign(upDot(frames[i].quat)) || sign;
    if (s !== sign) { sign = s; n++; }
  }
  return n;
}

const lib = JSON.parse(await fs.readFile(path.join(SRC, 'library.json'), 'utf8'));
console.log(`source library: ${lib.index.length} clips @ ${lib.format.framesPerSecond} fps\n`);

// --- encode everything once ------------------------------------------------
const sources = [];
let rawBytes = 0;
for (const e of lib.index) {
  const buf = await fs.readFile(path.join(SRC, 'clips', e.id + '.json'));
  rawBytes += buf.length;
  sources.push({ entry: e, clip: JSON.parse(buf.toString('utf8')) });
}
const recs = sources.map((s) => encodeClip(s.entry.id, s.clip));
const packed = packRecords(recs, lib.format.framesPerSecond);
const pack = readPack(packed);
console.log(`encoded ${recs.length} clips, pack ${kb(packed.length)}\n`);

// ===========================================================================
console.log('=== (1) THE BET AXES, over all 1024 clips ===');
{
  let hfBad = 0, sideBad = 0, quadBad = 0, worstOrient = 0, orientBad = 0;
  const worst = { orient: null };
  for (const { entry, clip } of sources) {
    const dec = decodeClip(pack.clips.get(entry.id));
    const hf = countHalfFlips(dec.frames);
    if (hf !== clip.meta.halfFlips) { hfBad++; if (hfBad < 4) fail('half-flip count moved', { id: entry.id, hf, want: clip.meta.halfFlips }); }
    const last = dec.frames[dec.frames.length - 1];
    const side = faceUpFromQuat(last.quat);
    if (side !== clip.meta.side) { sideBad++; if (sideBad < 4) fail('side moved', { id: entry.id, side, want: clip.meta.side }); }
    const o = roundOrientation(orientationFromQuat(last.quat));
    const d = degDelta(o, clip.meta.orientationDeg);
    if (d > worstOrient) { worstOrient = d; worst.orient = { id: entry.id, got: o, want: clip.meta.orientationDeg }; }
    if (d > ORIENT_TOL_DEG) { orientBad++; if (orientBad < 4) fail('orientation outside tolerance', { id: entry.id, d }); }
    if (quadrantFromOrientation(o) !== clip.meta.quadrant) { quadBad++; }
  }
  ok(hfBad === 0, 'half-flip counts changed', { hfBad });
  ok(sideBad === 0, 'landing sides changed', { sideBad });
  ok(quadBad === 0, 'quadrants changed', { quadBad });
  ok(orientBad === 0, 'orientations outside ORIENT_TOL_DEG', { orientBad });
  console.log(`  half-flips  ${sources.length - hfBad}/${sources.length} exact`);
  console.log(`  side        ${sources.length - sideBad}/${sources.length} exact`);
  console.log(`  quadrant    ${sources.length - quadBad}/${sources.length} exact`);
  console.log(`  orientation worst error ${worstOrient.toExponential(2)} deg (tolerance ${ORIENT_TOL_DEG})`);
  console.log(`              -> the final frame is stored VERBATIM in float32, which is why`);
  console.log(`                 this is a float32 rounding error and not a modelling one.`);
}

// ===========================================================================
console.log('\n=== (2) how faithfully the motion is reproduced ===');
{
  const posErrs = [], rotErrs = [], flightPos = [], flightRot = [];
  for (const { entry, clip } of sources) {
    const rec = pack.clips.get(entry.id);
    const dec = decodeClip(rec);
    // compare at every ORIGINAL frame time, sampling the decoded track
    const src = clip.frames;
    for (let i = 0; i < src.length; i++) {
      const t = src[i].t;
      // find bracketing decoded frames
      let lo = 0, hi = dec.frames.length - 1;
      while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (dec.frames[m].t <= t) lo = m; else hi = m; }
      const a = dec.frames[lo], b = dec.frames[Math.min(lo + 1, dec.frames.length - 1)];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      const p = [0, 1, 2].map((k) => a.pos[k] + (b.pos[k] - a.pos[k]) * u);
      let d = qdot(a.quat, b.quat); const sg = d < 0 ? -1 : 1; d = Math.abs(d);
      let q;
      if (d > 0.9995) q = a.quat.map((v, j) => v + (sg * b.quat[j] - v) * u);
      else {
        const th = Math.acos(Math.min(1, d)), s = Math.sin(th);
        q = a.quat.map((v, j) => v * Math.sin((1 - u) * th) / s + sg * b.quat[j] * Math.sin(u * th) / s);
      }
      const nn = Math.hypot(...q) || 1;
      const pe = Math.max(...[0, 1, 2].map((k) => Math.abs(p[k] - src[i].pos[k])));
      const re = degBetween(q.map((v) => v / nn), src[i].quat);
      posErrs.push(pe); rotErrs.push(re);
      if (i < rec.flightFrames) { flightPos.push(pe); flightRot.push(re); }
    }
  }
  console.table([
    { phase: 'flight (analytic)', 'median pos': +(pct(flightPos, 0.5) * 1000).toFixed(4) + ' mm',
      'p99 pos': +(pct(flightPos, 0.99) * 1000).toFixed(4) + ' mm',
      'median rot': +pct(flightRot, 0.5).toFixed(4) + ' deg', 'p99 rot': +pct(flightRot, 0.99).toFixed(4) + ' deg' },
    { phase: 'whole clip', 'median pos': +(pct(posErrs, 0.5) * 1000).toFixed(4) + ' mm',
      'p99 pos': +(pct(posErrs, 0.99) * 1000).toFixed(4) + ' mm',
      'median rot': +pct(rotErrs, 0.5).toFixed(4) + ' deg', 'p99 rot': +pct(rotErrs, 0.99).toFixed(4) + ' deg' },
  ]);
  const worstPos = maxOf(posErrs), worstRot = maxOf(rotErrs);
  console.log(`  worst position ${(worstPos * 1000).toFixed(3)} mm | worst orientation ${worstRot.toFixed(3)} deg`);
  console.log(`  (the coin is 20.5 mm across and spins at up to 207 rad/s mid-flight)`);
  ok(worstPos < 2e-3, 'position reconstruction drifts more than 2 mm', { worstPosMm: worstPos * 1000 });
  ok(worstRot < 6, 'orientation reconstruction drifts more than 6 deg', { worstRot });
}

// ===========================================================================
console.log('\n=== (3) ALIASING: no interpolated step may exceed 180 deg ===');
{
  // Past 180 deg a slerp takes the short path, i.e. the wrong way, and horizon
  // crossings vanish. This is the failure mode that killed uniform 60 fps
  // decimation, so the new format has to be checked for it explicitly.
  //
  // MEASURE THE TRUE ROTATION, NOT THE QUATERNION ANGLE. My first version
  // compared consecutive quats with 2*acos(|dot|), which folds every rotation
  // into [0,180] BY CONSTRUCTION — so it cheerfully reported 179.9 deg and
  // "safe" at 30 fps, where the fastest coin actually turns 470 deg. A test
  // that cannot fail is worse than no test. The flight's true step is
  // rate * dt straight from the analytic model; across settle keys it is the
  // accumulated path length over the source frames they span.
  const trueFlightStep = (rec, dtSec) => rec.flight.rate * dtSec * DEG;
  let worstSettle = 0, worstSettleAt = null;
  for (const { entry, clip } of sources) {
    const rec = pack.clips.get(entry.id);
    const keys = rec.settle.map((k) => k.idx).concat([rec.totalFrames - 1]);
    let prev = rec.flightFrames - 1;
    for (const k of keys) {
      let pathDeg = 0;
      for (let i = prev + 1; i <= k && i < clip.frames.length; i++) {
        pathDeg += degBetween(clip.frames[i - 1].quat, clip.frames[i].quat);
      }
      if (pathDeg > worstSettle) { worstSettle = pathDeg; worstSettleAt = entry.id; }
      prev = k;
    }
  }
  ok(worstSettle < 180, 'a settle key span turns more than 180 deg', { worstSettle, worstSettleAt });
  console.log(`  worst TRUE rotation across a settle key span: ${worstSettle.toFixed(1)} deg  [${worstSettleAt}]`);

  const rows = [];
  for (const fps of [250, 144, 120, 90, 60, 50, 30]) {
    let w = 0, at = null;
    for (const { entry } of sources) {
      const rec = pack.clips.get(entry.id);
      const d = trueFlightStep(rec, 1 / fps);
      if (d > w) { w = d; at = entry.id; }
    }
    rows.push({
      'pre-sample fps': fps, 'true flight step deg': +w.toFixed(1),
      verdict: w < 180 ? 'safe' : 'ALIASES', worst: at,
    });
  }
  console.table(rows);
  const floor = rows.filter((r) => r.verdict === 'safe').map((r) => r['pre-sample fps']);
  console.log(`  safe pre-sampling floor: ${Math.min(...floor)} fps`);
  console.log('  Below that the coin turns more than half a revolution between samples and');
  console.log('  the interpolation runs it BACKWARDS. The flight is analytic, so the player');
  console.log('  should evaluate flightPose() at the display time and never pre-sample at all.');
  ok(floor.includes(120), 'the format cannot even be pre-sampled at 120 fps', { floor });
}

// ===========================================================================
console.log('\n=== (4) the coin stays physical ===');
{
  // NOT "is any frame below y=0" — my first version asserted that and failed on
  // 15 frames, all of which are in the SOURCE. contract.js says so explicitly:
  // the solver settles the centre anywhere in [-0.00024, +0.00062] and
  // library.js#materialise lifts each clip onto the table afterwards. The
  // honest question is whether the ENCODER sinks the coin any lower than the
  // bake already did.
  let sank = 0, apexBad = 0, worstApex = 0, worstRest = 0, worstSink = 0;
  for (const { entry, clip } of sources) {
    const dec = decodeClip(pack.clips.get(entry.id));
    const srcApex = maxOf(clip.frames.map((f) => f.pos[1]));
    const decApex = maxOf(dec.frames.map((f) => f.pos[1]));
    worstApex = Math.max(worstApex, Math.abs(srcApex - decApex));
    if (Math.abs(srcApex - decApex) > 1e-3) apexBad++;
    const srcMin = clip.frames.reduce((m, f) => Math.min(m, f.pos[1]), Infinity);
    const decMin = dec.frames.reduce((m, f) => Math.min(m, f.pos[1]), Infinity);
    const sink = srcMin - decMin;                       // >0 means we went lower
    if (sink > 1e-4) { sank++; }
    worstSink = Math.max(worstSink, sink);
    const last = dec.frames[dec.frames.length - 1];
    worstRest = Math.max(worstRest, Math.abs(last.pos[1] - clip.frames[clip.frames.length - 1].pos[1]));
  }
  ok(sank === 0, 'the encoder sank the coin below where the bake put it', { sank, worstSinkMm: worstSink * 1000 });
  ok(apexBad === 0, 'apex height moved more than 1 mm', { apexBad, worstApexMm: worstApex * 1000 });
  ok(worstRest < 1e-6, 'the resting height moved', { worstRestMm: worstRest * 1000 });
  console.log(`  clips sunk below the bake's own minimum: ${sank} (worst ${(worstSink * 1000).toFixed(4)} mm)`);
  console.log(`  worst apex error ${(worstApex * 1000).toFixed(4)} mm`);
  console.log(`  worst resting-height error ${(worstRest * 1000).toExponential(2)} mm (final frame is verbatim)`);
}

// ===========================================================================
console.log('\n=== (5) size, broken down by lever ===');
{
  const srcFrames = sources.reduce((a, s) => a + s.clip.frames.length, 0);
  const flightFrames = recs.reduce((a, r) => a + r.flightFrames, 0);
  const settleSrc = srcFrames - flightFrames;
  const settleKept = recs.reduce((a, r) => a + r.settle.length, 0);
  // what a naive int16 pack of every frame would have cost
  const naive = srcFrames * 14 + recs.length * 64;
  const gz = zlib.gzipSync(packed, { level: 9 }).length;
  console.table([
    { lever: 'raw JSON (as shipped today)', bytes: kb(rawBytes), 'vs raw': '1.0x' },
    { lever: 'int16 every frame, no modelling', bytes: kb(naive), 'vs raw': (rawBytes / naive).toFixed(1) + 'x' },
    { lever: '+ analytic flight (68% of frames)', bytes: kb(naive - flightFrames * 14 + recs.length * 56), 'vs raw': (rawBytes / (naive - flightFrames * 14 + recs.length * 56)).toFixed(1) + 'x' },
    { lever: '+ adaptive settle keys', bytes: kb(packed.length), 'vs raw': (rawBytes / packed.length).toFixed(1) + 'x' },
    { lever: '+ gzip', bytes: kb(gz), 'vs raw': (rawBytes / gz).toFixed(1) + 'x' },
  ]);
  console.log(`  flight frames ${flightFrames} (${(100 * flightFrames / srcFrames).toFixed(1)}%) -> 14 floats each clip`);
  console.log(`  settle frames ${settleSrc} -> ${settleKept} keys (${(settleSrc / settleKept).toFixed(2)}x)`);
  ok(gz < 1024 * 1024, 'the pack is not under 1 MB', { gz });
}

// ===========================================================================
console.log('\n=== (6) degenerate clips ===');
{
  const byFrames = [...sources].sort((a, b) => a.clip.frames.length - b.clip.frames.length);
  const byOmega = [...recs].sort((a, b) => b.flight.rate - a.flight.rate);
  const picks = [
    ['shortest', byFrames[0].entry.id],
    ['longest', byFrames[byFrames.length - 1].entry.id],
    ['fastest spin', byOmega[0].id],
    ['slowest spin', byOmega[byOmega.length - 1].id],
    ['shortest flight', [...recs].sort((a, b) => a.flightFrames - b.flightFrames)[0].id],
  ];
  const rows = [];
  for (const [label, id] of picks) {
    const src = sources.find((s) => s.entry.id === id);
    const rec = pack.clips.get(id);
    const dec = decodeClip(rec);
    const hf = countHalfFlips(dec.frames);
    const o = roundOrientation(orientationFromQuat(dec.frames[dec.frames.length - 1].quat));
    rows.push({
      case: label, id, frames: rec.totalFrames, flight: rec.flightFrames, keys: rec.settle.length,
      'omega rad/s': +rec.flight.rate.toFixed(0),
      halfFlips: hf === src.clip.meta.halfFlips ? 'exact' : `WRONG ${hf}`,
      orientErr: +degDelta(o, src.clip.meta.orientationDeg).toExponential(1),
    });
    ok(hf === src.clip.meta.halfFlips, 'degenerate clip lost half-flips', { label, id });
  }
  console.table(rows);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
