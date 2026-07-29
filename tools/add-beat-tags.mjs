// tools/add-beat-tags.mjs
// ---------------------------------------------------------------------------
// Writes bake/out/beats.json — for every baked clip, the clip-times at which the
// coin's up-axis crosses the horizon. One timestamp per half-flip.
//
// WHY THIS EXISTS. The spin counter is a BET AXIS: the player types a rotation
// line, is paid on it, and watches the counter tick to see it happen. Today the
// count is derived by walking the frame track and testing the up-axis sign, so
// the number the player is paid on is welded to the frame data.
//
// The library is about to be compressed hard — the airborne phase becomes
// analytic and the settle gets decimated. Resampling can silently swallow a
// crossing: the coin spins to 209 rad/s, which at 60 fps is already 173.8 deg
// per step against a 180 deg limit, and below that a quaternion step is
// ambiguous and the crossing is simply gone. A dropped crossing is a wrong spin
// count on a bet that has already paid out.
//
// So the crossings are measured ONCE, here, at full 256 fps precision, and
// recorded. After that the counter reads times instead of frames and no longer
// cares what the frame track looks like.
//
// A SIDECAR, NOT AN EDIT. The clips are left untouched: another pass is
// rewriting them into a compressed format concurrently, and two writers on one
// file is how a library gets corrupted. Once the encoder lands, the same array
// belongs inline as `meta.flipTimesMs` — player.js already prefers that when it
// is present, so the sidecar retires without a second change.
//
// Run: node tools/add-beat-tags.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeClip } from '../flip3d/clip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'bake/out/beats.json');

/**
 * Crossing times are quantised to 0.01 ms before they are written.
 *
 * The source grid is 256 fps, so a crossing lands on a multiple of 3.90625 ms
 * and carries no information below that. Full float64 spelling costs ~17 bytes
 * per beat for digits that are pure noise; two decimals is 400x finer than the
 * grid the numbers came off, and finer than any display frame will ever ask
 * for. Rounding here rather than at read time also keeps the file diffable.
 */
const Q = 100;
const quantise = (ms) => Math.round(ms * Q) / Q;

const lib = JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out/library.json'), 'utf8'));

let bad = 0;
const problems = [];
const flag = (why, extra) => { bad++; if (problems.length < 12) problems.push({ why, ...extra }); };

const beats = {};
let totalBeats = 0;
let worstQuantErr = 0;

for (const entry of lib.index) {
  const clip = JSON.parse(
    await fs.readFile(path.join(ROOT, 'bake/out/clips', entry.id + '.json'), 'utf8'),
  );
  // Reuse analyzeClip's crossing definition rather than re-deriving it. Two
  // definitions of a bet axis is exactly how they drift apart.
  const a = analyzeClip(clip);
  const raw = a.crossingsAtMs;
  const times = raw.map(quantise);

  for (let i = 0; i < raw.length; i++) {
    worstQuantErr = Math.max(worstQuantErr, Math.abs(raw[i] - times[i]));
  }

  // --- assertions, on the way past ---------------------------------------
  if (times.length !== clip.meta.halfFlips) {
    flag('crossing count disagrees with meta.halfFlips', {
      id: entry.id, counted: times.length, meta: clip.meta.halfFlips,
    });
  }
  if (times.length !== entry.halfFlips) {
    flag('crossing count disagrees with the library index', {
      id: entry.id, counted: times.length, index: entry.halfFlips,
    });
  }
  for (let i = 1; i < times.length; i++) {
    if (!(times[i] > times[i - 1])) {
      flag('crossing times are not strictly increasing', {
        id: entry.id, at: i, prev: times[i - 1], cur: times[i],
      });
      break;
    }
  }
  if (times.length && (times[0] < 0 || times[times.length - 1] > clip.meta.durationMs)) {
    flag('a crossing falls outside the clip', {
      id: entry.id, first: times[0], last: times[times.length - 1], durationMs: clip.meta.durationMs,
    });
  }

  beats[entry.id] = times;
  totalBeats += times.length;
}

const doc = {
  format: 'coinflip-beats-1',
  note: 'clip id -> half-flip horizon-crossing times, in clip milliseconds',
  source: lib.format ?? null,
  clips: Object.keys(beats).length,
  beats,
};
await fs.writeFile(OUT, JSON.stringify(doc), 'utf8');

const [beatBytes, libBytes] = await Promise.all([
  fs.stat(OUT).then((s) => s.size),
  fs.stat(path.join(ROOT, 'bake/out/library.json')).then((s) => s.size),
]);
let clipBytes = 0;
for (const f of await fs.readdir(path.join(ROOT, 'bake/out/clips'))) {
  clipBytes += (await fs.stat(path.join(ROOT, 'bake/out/clips', f))).size;
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

console.log(`wrote ${OUT}`);
console.log(`  clips tagged      ${doc.clips}`);
console.log(`  beats recorded    ${totalBeats}  (${(totalBeats / doc.clips).toFixed(1)} per clip)`);
console.log(`  worst quantisation error ${worstQuantErr.toExponential(2)} ms (grid is 3.90625 ms)`);
console.log('');
console.log(`  beats.json        ${kb(beatBytes)}`);
console.log(`  library.json      ${kb(libBytes)}`);
console.log(`  clips/            ${mb(clipBytes)}`);
console.log(`  beats cost        ${(100 * beatBytes / (clipBytes + libBytes)).toFixed(2)}% of the library`);

if (bad) {
  console.log(`\n${bad} PROBLEM(S) — these are findings, not noise:`);
  for (const p of problems) console.log('  ', JSON.stringify(p));
  process.exit(1);
}
console.log('\nevery clip: crossing count matches meta AND the index, times strictly increasing, all inside the clip');
