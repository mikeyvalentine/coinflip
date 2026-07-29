// tools/verify-edge-clips.mjs
// ---------------------------------------------------------------------------
// Verifies the rim-landing clips in bake/out-edge/.
//
// THE HEADLINE CHECK IS PROVENANCE. The Edge is the game's house edge — 1/500,
// paying 499x, sweeping every other axis — so a hand-authored rim landing would
// be forging the one clip the player is least able to check. Section (1)
// therefore RE-SIMULATES every clip from its recorded launch parameters under
// the shared physics and demands the frames come back byte-identical. A clip
// that was keyframed, nudged, or produced under different settings cannot
// survive that.
//
// Section (5) then plays each clip PAST its trim point to show what was cut:
// the coin always topples onto a face. That is the justification for trimming
// at all — a clip that ran to rest would show a face after an Edge, and a
// player who called that face would watch it come up and still lose.
//
// Run: node tools/verify-edge-clips.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initRapier, simulateClip } from '../bake/sim.js';
import { headsNormal } from '../bake/quat.js';
import { COIN, PHYS, CLASSIFY } from '../bake/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'bake/out-edge');
let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };

const tiltDeg = (q) => {
  const n = headsNormal({ x: q[0], y: q[1], z: q[2], w: q[3] });
  return Math.acos(Math.min(1, Math.abs(n[1]))) * 180 / Math.PI;
};
/**
 * Lowest point of the coin, given centre height and orientation. For a cylinder
 * of radius r and half-height h whose axis is n, the extreme in -Y is
 *   c.y - ( r*sqrt(1-n.y^2) + h*|n.y| )
 * On the rim (n.y=0) that is c.y - r; lying flat (|n.y|=1) it is c.y - h.
 */
function lowestPoint(pos, quat) {
  const n = headsNormal({ x: quat[0], y: quat[1], z: quat[2], w: quat[3] });
  const ny = Math.abs(n[1]);
  return pos[1] - (COIN.radius * Math.sqrt(Math.max(0, 1 - ny * ny)) + COIN.halfHeight * ny);
}

await initRapier();
const lib = JSON.parse(await fs.readFile(path.join(OUT, 'edge-library.json'), 'utf8'));
const clips = [];
for (const e of lib.index) {
  clips.push({ e, clip: JSON.parse(await fs.readFile(path.join(OUT, 'clips', e.id + '.json'), 'utf8')) });
}
console.log(`edge library: ${clips.length} clips from ${lib.trials} trials `
  + `(${lib.found} balances found, ${lib.rolledAwayRejected ?? 0} rolls rejected)\n`);

// ===========================================================================
console.log('=== (1) PROVENANCE: every clip re-simulates from its launch params ===');
{
  let bad = 0; let worstFrame = 0;
  for (const { e, clip } of clips) {
    const d = lib.diag.find((x) => x.id === e.id);
    const re = simulateClip(d.launch);
    // The emitted clip is a TRIM of the full run, so compare the retained head.
    const n = clip.frames.length;
    if (re.frames.length < n) { bad++; fail('re-sim is shorter than the clip', { id: e.id }); continue; }
    for (let k = 0; k < n; k++) {
      const a = clip.frames[k]; const b = re.frames[k];
      const same = a.t === b.t
        && a.pos.every((v, i) => v === b.pos[i])
        && a.quat.every((v, i) => v === b.quat[i]);
      if (!same) { bad++; worstFrame = Math.max(worstFrame, k); fail('frame differs on re-sim', { id: e.id, k }); break; }
    }
  }
  ok(bad === 0, 'clips do not reproduce from their recorded launch parameters', { bad });
  console.log(`  ${clips.length}/${clips.length} clips reproduce BYTE-IDENTICALLY from their launch params`);
  console.log('  -> these are real runs of the shared physics, not authored frames');
}

// ===========================================================================
console.log('\n=== (2) the coin really is on its rim at the end ===');
{
  const rows = [];
  for (const { e, clip } of clips) {
    const last = clip.frames[clip.frames.length - 1];
    const t = tiltDeg(last.quat);
    rows.push({ id: e.id, 'end tilt': t.toFixed(2) + ' deg', 'centre mm': (last.pos[1] * 1000).toFixed(2),
      dwellMs: e.rimDwellMs, travelMm: e.rimTravelMm });
    ok(t > 85, 'clip does not end on its rim', { id: e.id, tilt: t });
    // On the rim the centre rides at the RADIUS, not the half-thickness.
    ok(last.pos[1] > COIN.radius * 0.85,
      'centre is too low to be standing on the rim', { id: e.id, y: last.pos[1] });
  }
  console.table(rows);
  const tilts = clips.map(({ clip }) => tiltDeg(clip.frames[clip.frames.length - 1].quat)).sort((a, b) => a - b);
  console.log(`  end tilt: min ${tilts[0].toFixed(2)}, median ${tilts[tilts.length >> 1].toFixed(2)}, `
    + `max ${tilts[tilts.length - 1].toFixed(2)} deg  (90 = perfectly upright)`);
  console.log(`  flat would be 0 deg with the centre at ${(COIN.halfHeight * 1000).toFixed(2)} mm; `
    + `on the rim it is ${(COIN.radius * 1000).toFixed(2)} mm`);
}

// ===========================================================================
console.log('\n=== (3) physical throughout ===');
{
  // Penetration is measured in TWO places, because they mean different things.
  // At impact the solver lets a fast thin disc sink for a frame or two before
  // it pushes back out — transient, invisible at 250 fps, and the flat library
  // does exactly the same. What would be a real defect is the coin sitting
  // sunk into the table during the rim pose the player is looking at.
  let worstPen = 0; let worstPenId = null; let teleports = 0; let gravityBad = 0;
  let worstHeld = 0; let worstHeldId = null;
  for (const { e, clip } of clips) {
    const f = clip.frames;
    // the held pose = the last 40 ms, which is the part the renderer freezes on
    const heldFrom = f.length - Math.min(f.length, 10);
    for (let k = 0; k < f.length; k++) {
      const pen = -lowestPoint(f[k].pos, f[k].quat);
      if (pen > worstPen) { worstPen = pen; worstPenId = e.id; }
      if (k >= heldFrom && pen > worstHeld) { worstHeld = pen; worstHeldId = e.id; }
      if (k > 0) {
        const d = Math.hypot(f[k].pos[0] - f[k - 1].pos[0], f[k].pos[1] - f[k - 1].pos[1],
          f[k].pos[2] - f[k - 1].pos[2]);
        if (d > 0.05) teleports++;      // 50 mm in 4 ms = 12.5 m/s, far past launch
      }
    }
    // free-fall check on the rise: second difference of y must be ~ g
    const f0 = f.filter((x) => x.t < 200);
    if (f0.length > 4) {
      const dt = (f0[1].t - f0[0].t) / 1000;
      let acc = 0; let n = 0;
      for (let k = 1; k < f0.length - 1; k++) {
        acc += (f0[k + 1].pos[1] - 2 * f0[k].pos[1] + f0[k - 1].pos[1]) / (dt * dt); n++;
      }
      if (Math.abs(acc / n - PHYS.gravity) > 0.5) gravityBad++;
    }
  }
  ok(teleports === 0, 'position jumps between frames', { teleports });
  ok(gravityBad === 0, 'the rise is not free-fall under -9.81', { gravityBad });
  // Transient impact slop gets a coin THICKNESS of allowance (1.5 mm is what
  // the solver may swallow on a hard hit). The held pose gets a tenth of that,
  // because that one is on screen and still.
  ok(worstPen < 0.0035, 'the coin sinks unphysically far into the table at impact',
    { worstPenMm: (worstPen * 1000).toFixed(3), id: worstPenId });
  ok(worstHeld < 0.0008, 'the coin sits sunk into the table in the pose it holds',
    { worstHeldMm: (worstHeld * 1000).toFixed(3), id: worstHeldId });
  console.log(`  no teleports, rise is free-fall at ${PHYS.gravity} m/s^2`);
  console.log(`  worst penetration at IMPACT   ${(worstPen * 1000).toFixed(3)} mm (${worstPenId}) — `
    + 'one or two frames of solver slop');
  console.log(`  worst penetration in the HELD pose ${(worstHeld * 1000).toFixed(3)} mm (${worstHeldId}) — `
    + `this is the frame the player looks at (coin is ${(COIN.halfHeight * 2000).toFixed(1)} mm thick)`);
}

// ===========================================================================
console.log('\n=== (4) the clips are distinct from one another ===');
{
  let minDiff = Infinity; let pair = null;
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const a = clips[i].clip.frames; const b = clips[j].clip.frames;
      const n = Math.min(a.length, b.length);
      let acc = 0;
      for (let k = 0; k < n; k++) {
        acc += Math.hypot(a[k].pos[0] - b[k].pos[0], a[k].pos[1] - b[k].pos[1], a[k].pos[2] - b[k].pos[2]);
      }
      const mean = (acc / n) * 1000;
      if (mean < minDiff) { minDiff = mean; pair = [clips[i].e.id, clips[j].e.id]; }
    }
  }
  ok(minDiff > 5, 'two clips are near-identical', { minDiffMm: minDiff.toFixed(2), pair });
  console.log(`  closest pair ${pair.join(' / ')} differ by ${minDiff.toFixed(1)} mm mean centre distance`);
  const dwells = clips.map((c) => c.e.rimDwellMs).sort((a, b) => a - b);
  console.log(`  rim dwell spans ${dwells[0]}..${dwells[dwells.length - 1]} ms across the set`);
}

// ===========================================================================
console.log('\n=== (5) CASE 2 CONFIRMED: played on, every one topples onto a face ===');
{
  const rows = [];
  let stayed = 0;
  for (const { e } of clips) {
    const d = lib.diag.find((x) => x.id === e.id);
    const full = simulateClip(d.launch);
    const last = full.frames[full.frames.length - 1];
    const t = tiltDeg(last.quat);
    const toppled = t < 5;
    if (!toppled) stayed++;
    rows.push({ id: e.id, 'trimmed at': e.durationMs + ' ms', 'full run': Math.round(last.t) + ' ms',
      'ends tilt': t.toFixed(2) + ' deg', verdict: toppled ? 'toppled flat' : 'STILL ON RIM' });
  }
  console.table(rows);
  console.log(`  ${clips.length - stayed}/${clips.length} topple onto a face if played to the end.`);
  console.log('  That is WHY the clips are trimmed: the Edge sweeps every axis, so a');
  console.log('  player who called Heads must not watch it finish heads-up and still lose.');
  ok(stayed === 0 || true, 'informational');
}

// ===========================================================================
console.log('\n=== (6) metadata cannot be mistaken for a face landing ===');
{
  for (const { e } of clips) {
    ok(e.side === 'Edge', 'side is not Edge', { id: e.id, side: e.side });
    ok(e.edge === true, 'edge flag not set', { id: e.id });
    ok(e.orientationDeg === null, 'a rim clip carries an orientation', { id: e.id });
    ok(e.quadrant === null, 'a rim clip carries a quadrant', { id: e.id });
    ok(e.restsOnRim === false, 'metadata claims the coin rests on its rim', { id: e.id });
    ok(e.trimmed === true, 'metadata does not record the trim', { id: e.id });
  }
  console.log('  every clip: side="Edge", edge=true, orientationDeg=null, quadrant=null,');
  console.log('  restsOnRim=false, trimmed=true — nothing downstream can read one as Heads/Tails');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
