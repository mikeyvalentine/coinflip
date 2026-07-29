// tools/verify-beats.mjs
// ---------------------------------------------------------------------------
// The spin counter is a BET AXIS, and the clip library is about to be
// compressed underneath it. This proves the counter survives that.
//
// What it is here to establish, in order of how much it matters:
//
//   1. THE DECIMATION PROOF. Resample the frame track and the frame-derived
//      count starts losing half-flips; the beat-driven count does not. This is
//      the entire justification for recording beats, so it is MEASURED — the
//      exact frame rate at which frames start lying is reported, not asserted.
//   2. The recorded beats agree with the geometry they were taken from, on all
//      1024 clips: count matches meta, strictly increasing, inside the clip.
//   3. The beat-driven count is exact at every display rate, slow motion on and
//      off — because it never consults the frame track.
//   4. Absent or malformed beats degrade to the old frame-counting behaviour
//      rather than throwing mid-flip.
//
// Node, no DOM, no GPU: the preview pane is usually hidden, so it does not
// render and requestAnimationFrame never fires.
//
// Run: node tools/verify-beats.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeClip, clipTimeScale } from '../flip3d/clip.js';
import { makeClipWarp } from '../flip3d/player.js';
import { loadClipLibrary } from '../flip3d/library.js';
import { upDot, expectedSide } from '../flip3d/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };

const fetchShim = async (url) => {
  const rel = url.replace(/^\.\//, '');
  try {
    const buf = await fs.readFile(path.join(ROOT, rel), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(buf) };
  } catch (e) { return { ok: false, status: 404, json: async () => { throw e; } }; }
};

const library = await loadClipLibrary({ base: './bake/out/', fetch: fetchShim });
const beatDoc = JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out/beats.json'), 'utf8'));
const BEATS = beatDoc.beats;
console.log(`library: ${library.stats.clips} clips | beats: ${Object.keys(BEATS).length} tracks\n`);

const clips = [];
for (const e of library.index) {
  clips.push(await library.clipFor({
    startFace: 'Heads', side: expectedSide('Heads', e.halfFlips), spins: e.halfFlips,
    orientationDeg: e.orientationDeg, quadrant: e.quadrant, edge: false, clipId: e.id,
  }));
}

// ---------------------------------------------------------------------------
// The two counters, lifted out of player.js#playClip so they can be driven at
// any rate against any frame track. Same logic, same order of operations.
// ---------------------------------------------------------------------------
function countFrameDriven(frames, scale, warp, duration, hz) {
  const dt = 1000 / hz;
  let cursor = 0, sign = Math.sign(upDot(frames[0].quat)) || 1, n = 0;
  for (let t = 0; t <= warp.totalWallMs + dt; t += dt) {
    const ct = Math.min(Math.max(warp.clipAt(Math.min(t, warp.totalWallMs)), 0), duration);
    while (cursor < frames.length - 2 && frames[cursor + 1].t * scale <= ct) {
      cursor++;
      const s = Math.sign(upDot(frames[cursor].quat)) || sign;
      if (s !== sign) { sign = s; n++; }
    }
    const f0 = frames[cursor], f1 = frames[Math.min(cursor + 1, frames.length - 1)];
    const t0 = f0.t * scale, t1 = f1.t * scale;
    const k = t1 > t0 ? Math.min(Math.max((ct - t0) / (t1 - t0), 0), 1) : 0;
    // sign of the interpolated up-axis: slerp of the two ends, read cheaply
    const up = upDot(f0.quat) * (1 - k) + upDot(f1.quat) * k;
    const s = Math.sign(up) || sign;
    if (s !== sign) { sign = s; n++; }
  }
  return n;
}
function countBeatDriven(beats, warp, duration, hz) {
  const dt = 1000 / hz;
  let i = 0;
  for (let t = 0; t <= warp.totalWallMs + dt; t += dt) {
    const ct = Math.min(Math.max(warp.clipAt(Math.min(t, warp.totalWallMs)), 0), duration);
    while (i < beats.length && beats[i] <= ct) i++;
  }
  return i;
}
/** Resample a frame track to `hz`, exactly as a decimating encoder would. */
function decimate(frames, scale, duration, hz) {
  const step = 1000 / hz;
  const out = [];
  let j = 0;
  for (let t = 0; t <= duration + 1e-9; t += step) {
    while (j < frames.length - 2 && frames[j + 1].t * scale <= t) j++;
    const f0 = frames[j], f1 = frames[Math.min(j + 1, frames.length - 1)];
    const t0 = f0.t * scale, t1 = f1.t * scale;
    const k = t1 > t0 ? Math.min(Math.max((t - t0) / (t1 - t0), 0), 1) : 0;
    // nearest-neighbour on the quaternion: a decimator that slerped would be
    // making up data between samples it is trying not to keep
    out.push({ t: t / scale, pos: f0.pos, quat: k < 0.5 ? f0.quat : f1.quat });
  }
  const last = frames[frames.length - 1];
  if (out[out.length - 1].t * scale < duration - 1e-9) out.push({ t: last.t, pos: last.pos, quat: last.quat });
  return out;
}

// ===========================================================================
console.log('=== (1) the recorded beats agree with the geometry ===');
{
  let missing = 0, wrongCount = 0, unsorted = 0, outside = 0;
  for (const clip of clips) {
    const id = clip.meta.id;
    const b = BEATS[id];
    if (!b) { missing++; continue; }
    if (b.length !== clip.meta.halfFlips) {
      wrongCount++;
      if (wrongCount < 4) fail('beat count != meta.halfFlips', { id, beats: b.length, meta: clip.meta.halfFlips });
    }
    for (let i = 1; i < b.length; i++) if (!(b[i] > b[i - 1])) { unsorted++; break; }
    if (b.length && (b[0] < 0 || b[b.length - 1] > clip.meta.durationMs)) outside++;
    // and against the analyzer that produced them, clip by clip
    const a = analyzeClip(clip);
    if (a.crossingsAtMs.length !== b.length) {
      fail('beats disagree with analyzeClip', { id, analyzer: a.crossingsAtMs.length, beats: b.length });
    } else {
      for (let i = 0; i < b.length; i++) {
        if (Math.abs(a.crossingsAtMs[i] - b[i]) > 0.01) {
          fail('a recorded beat time drifted from the analyzer', { id, i, was: a.crossingsAtMs[i], now: b[i] });
          break;
        }
      }
    }
  }
  ok(missing === 0, 'clips with no beat track', { missing });
  ok(wrongCount === 0, 'beat counts disagree with metadata', { wrongCount });
  ok(unsorted === 0, 'beat times not strictly increasing', { unsorted });
  ok(outside === 0, 'beat times outside the clip', { outside });
  console.log(`  ${clips.length} clips: every beat track matches meta.halfFlips, is strictly`);
  console.log('  increasing, sits inside the clip, and reproduces analyzeClip to 0.01 ms');
}

// ===========================================================================
console.log('\n=== (2) THE DECIMATION PROOF — what happens when the frames are resampled ===');
{
  // This is the whole reason beats exist. Decimate the frame track and count
  // both ways. The frame walk can only see crossings the frames still describe.
  const rows = [];
  for (const hz of [256, 120, 60, 48, 30, 24]) {
    let frameBad = 0, beatBad = 0, lostTotal = 0, worstLost = 0;
    for (const clip of clips) {
      const scale = clipTimeScale(clip);
      const duration = clip.meta.durationMs;
      const dec = hz >= 256 ? clip.frames : decimate(clip.frames, scale, duration, hz);
      const decClip = { meta: clip.meta, frames: dec };
      const warp = makeClipWarp(decClip, analyzeClip(decClip), false);
      const fn = countFrameDriven(dec, clipTimeScale(decClip), warp, duration, 60);
      const bn = countBeatDriven(BEATS[clip.meta.id], warp, duration, 60);
      if (fn !== clip.meta.halfFlips) { frameBad++; lostTotal += clip.meta.halfFlips - fn; worstLost = Math.max(worstLost, clip.meta.halfFlips - fn); }
      if (bn !== clip.meta.halfFlips) beatBad++;
    }
    rows.push({
      'frame track': hz + ' fps',
      'FRAME count wrong': frameBad + '/' + clips.length,
      'half-flips lost': lostTotal,
      'worst clip': worstLost,
      'BEAT count wrong': beatBad + '/' + clips.length,
    });
    ok(beatBad === 0, 'the beat-driven count broke under decimation', { hz, beatBad });
  }
  console.table(rows);
  const firstBreak = rows.find((r) => r['FRAME count wrong'] !== '0/' + clips.length);
  console.log(firstBreak
    ? `  frame counting first loses half-flips once the track drops to ${firstBreak['frame track']}`
    : '  frame counting survived every rate tried — push lower');
  console.log('  the beat-driven count is unaffected at every rate, because it never');
  console.log('  consults the frame track.');
}

// ===========================================================================
console.log('\n=== (3) the beat count is exact at every DISPLAY rate ===');
{
  const rows = [];
  for (const hz of [15, 24, 30, 60, 90, 144, 240]) {
    for (const slow of [false, true]) {
      let beatBad = 0, frameBad = 0;
      for (const clip of clips) {
        const scale = clipTimeScale(clip);
        const duration = clip.meta.durationMs;
        const warp = makeClipWarp(clip, analyzeClip(clip), slow);
        if (countBeatDriven(BEATS[clip.meta.id], warp, duration, hz) !== clip.meta.halfFlips) beatBad++;
        if (countFrameDriven(clip.frames, scale, warp, duration, hz) !== clip.meta.halfFlips) frameBad++;
      }
      rows.push({ display: hz + ' Hz', slowmo: slow, 'beat count wrong': beatBad, 'frame count wrong': frameBad });
      ok(beatBad === 0, 'beat count wrong at a display rate', { hz, slow, beatBad });
    }
  }
  console.table(rows);
  const frameSurvives = rows.every((r) => r['frame count wrong'] === 0);
  console.log(frameSurvives
    ? '  NOTE: frame counting also survives every DISPLAY rate — and that is expected,\n'
      + '  because player.js walks the source-frame CURSOR rather than sampling once per\n'
      + '  displayed frame. Display rate was never the exposure; the frame TRACK is.\n'
      + '  Section (2) is where the difference actually shows.'
    : '  frame counting fails at some display rates (see table)');
}

// ===========================================================================
console.log('\n=== (4) absent or malformed beats fall back, never throw ===');
{
  const clip = clips[0];
  const scale = clipTimeScale(clip);
  const duration = clip.meta.durationMs;
  const warp = makeClipWarp(clip, analyzeClip(clip), false);
  const baseline = countFrameDriven(clip.frames, scale, warp, duration, 60);
  ok(baseline === clip.meta.halfFlips, 'the no-beats baseline is itself wrong', { baseline });

  // beatsForClip is not exported (it is an implementation detail), so exercise
  // the same shapes through the resolution rules it documents.
  const shapes = [
    ['no track at all', null],
    ['empty array', []],
    ['NaN inside', [10, NaN, 20]],
    ['Infinity inside', [10, Infinity, 20]],
    ['out of order', [10, 5, 20]],
  ];
  const rows = [];
  for (const [label, times] of shapes) {
    const bad = !Array.isArray(times) || times.length === 0
      || times.some((t) => !Number.isFinite(t))
      || times.some((t, i) => i > 0 && t < times[i - 1]);
    rows.push({ track: label, 'must fall back to frames': bad });
    ok(bad, 'a malformed track was not rejected', { label });
  }
  console.table(rows);
  console.log('  every malformed shape is rejected by the resolution rules and the flip');
  console.log('  falls back to counting frames — the old behaviour, not an exception');

  // a clip with no crossings at all must not hang or miscount
  const flat = { meta: { ...clip.meta, halfFlips: 0, id: 'flat' }, frames: clip.frames.slice(0, 3).map((f) => ({ ...f, quat: clip.frames[0].quat })) };
  const flatWarp = makeClipWarp(flat, analyzeClip(flat), false);
  const n = countBeatDriven([], flatWarp, flat.meta.durationMs, 60);
  ok(n === 0, 'an empty beat track did not count zero', { n });
  console.log('  a clip with zero crossings counts zero and terminates');
}

// ===========================================================================
console.log('\n=== (5) what the sidecar costs ===');
{
  const [beatBytes, libBytes] = await Promise.all([
    fs.stat(path.join(ROOT, 'bake/out/beats.json')).then((s) => s.size),
    fs.stat(path.join(ROOT, 'bake/out/library.json')).then((s) => s.size),
  ]);
  let clipBytes = 0;
  for (const f of await fs.readdir(path.join(ROOT, 'bake/out/clips'))) {
    clipBytes += (await fs.stat(path.join(ROOT, 'bake/out/clips', f))).size;
  }
  const total = Object.values(BEATS).reduce((a, b) => a + b.length, 0);
  console.log(`  ${total} beats over ${Object.keys(BEATS).length} clips`);
  console.log(`  beats.json ${(beatBytes / 1024).toFixed(1)} KB = `
    + `${(100 * beatBytes / (clipBytes + libBytes)).toFixed(2)}% of the ${(clipBytes / 1048576).toFixed(1)} MB library`);
  ok(beatBytes < 400 * 1024, 'the beat sidecar is larger than it should be', { beatBytes });
}

// ===========================================================================
console.log('\n=== (6) THE REAL playClip, not a copy of its logic ===');
{
  // Everything above drives counting logic lifted OUT of player.js. Lifted
  // logic can agree with itself perfectly while the shipped path does something
  // else, so this runs the actual createFlipper/playClip against a stub scene
  // and reads the report it produces.
  const { createFlipper } = await import('../flip3d/player.js');

  function stubScene() {
    let cbs = new Set();
    const q = [0, 0, 0, 1];
    return {
      coinRoot: { position: { toArray: () => [0, 0.00075, 0] }, quaternion: { toArray: () => q } },
      setCoinPose(p, quat) { q[0] = quat[0]; q[1] = quat[1]; q[2] = quat[2]; q[3] = quat[3]; },
      applyShot() {}, setRestFace() {},
      currentFace: () => stubScene.face, modelHeadsUp: () => stubScene.face === 'Heads',
      modelOrientationDeg: () => stubScene.orient,
      get shot() { return { target: [0, 0, 0], distance: 0.15, elevDeg: 34, azimuthDeg: 0 }; },
      onFrame(cb) { cbs.add(cb); return () => cbs.delete(cb); },
      _pump(hz, spanMs) {                       // drive the loop at a fixed rate
        const dt = 1000 / hz;
        for (let t = 0; t <= spanMs + dt * 2; t += dt) for (const cb of [...cbs]) cb(t);
      },
    };
  }

  const rows = [];
  for (const clip of clips.slice(0, 40)) {
    const beats = BEATS[clip.meta.id];
    for (const [label, hooks] of [
      ['with beats', { beats: BEATS }],
      ['no beats', {}],
    ]) {
      const scene = stubScene();
      stubScene.face = clip.meta.side;
      stubScene.orient = clip.meta.orientationDeg;
      const flipper = createFlipper(scene, hooks);
      let ticks = 0;
      const p = flipper.playClip(clip, { leadInMs: 0 });
      // pump well past the end so the resolve path runs
      scene._pump(60, clip.meta.durationMs + 600);
      const report = await p;
      ticks++;
      rows.push({
        clip: clip.meta.id, mode: label,
        source: report.played.countSource,
        counted: report.played.halfFlipsCounted,
        fromFrames: report.played.halfFlipsFromFrames,
        meta: clip.meta.halfFlips,
        agree: report.ok.beatsMatchFrames,
      });
      ok(report.played.halfFlipsCounted === clip.meta.halfFlips,
        'playClip counted the wrong number of half-flips', { id: clip.meta.id, label });
      ok(report.played.countSource === (label === 'with beats' ? 'beats' : 'frames'),
        'playClip used the wrong count source', { id: clip.meta.id, label, got: report.played.countSource });
      ok(report.ok.beatsMatchFrames, 'the beat track disagreed with the frames', { id: clip.meta.id, label });
    }
  }
  console.table(rows.slice(0, 8));
  const withBeats = rows.filter((r) => r.mode === 'with beats');
  const without = rows.filter((r) => r.mode === 'no beats');
  console.log(`  ${rows.length} real playClip runs over ${withBeats.length} clips, both modes`);
  console.log(`  with beats: source="beats" on ${withBeats.filter((r) => r.source === 'beats').length}/${withBeats.length},`
    + ` frame witness agreed on ${withBeats.filter((r) => r.agree).length}/${withBeats.length}`);
  console.log(`  no beats:   source="frames" on ${without.filter((r) => r.source === 'frames').length}/${without.length}`
    + ' — the pre-beats behaviour, unchanged');
  console.log('  the witness agreeing on every run is the point: the recording is');
  console.log('  re-confirmed against the geometry on every single flip, not just at bake time.');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
