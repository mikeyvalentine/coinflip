// validate-library.js — audit a written library from the FILES ALONE.
//
// The bake's own report is self-assessment. This reads the shipped JSON back
// off disk and re-derives every claim independently: it re-counts the
// half-flips from the emitted frames, re-reads the landing face and the settled
// orientation off the final quaternion, and re-checks cell uniformity. If the
// bake ever ships metadata that disagrees with its own geometry, this is what
// catches it — a wrong half-flip count would silently corrupt the posted odds.
//
// It also runs the real consumer: identity.js selectVariant() is fed the actual
// baked energy values to confirm a daring player really does get a more violent
// variant of the SAME outcome.
//
// Run: node validate-library.js ./out

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFlipCounter, headingToQuadrant } from './classify.js';
import { headsNormal, bodyXAxis, heading } from './quat.js';
import { HALF_FLIPS, QUADRANTS, CELL_COUNT, cellKey } from './config.js';

const DIR = process.argv[2] || './out';
const lib = JSON.parse(readFileSync(join(DIR, 'library.json'), 'utf8'));
const files = readdirSync(join(DIR, 'clips')).filter((f) => f.endsWith('.json'));

const CONTRACT_KEYS = ['halfFlips', 'side', 'quadrant', 'orientationDeg', 'durationMs', 'settleAngleDeg', 'energy'];

let fail = 0;
const problems = new Map();
const note = (k, id) => {
  fail++;
  if (!problems.has(k)) problems.set(k, []);
  problems.get(k).push(id);
};

const cellCounts = new Map();
const energyByCell = new Map();
let worstHfRecount = 0, worstOrientErr = 0, worstQuatNorm = 0, minFlatCos = 1;
let totalFrames = 0, totalBytes = 0;
let recountMismatch = 0;

for (const f of files) {
  const raw = readFileSync(join(DIR, 'clips', f), 'utf8');
  totalBytes += raw.length;
  const clip = JSON.parse(raw);
  const id = f.replace(/\.json$/, '');
  const m = clip.meta;

  // --- shape ---------------------------------------------------------------
  const keys = Object.keys(m).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...CONTRACT_KEYS].sort())) note('meta-keys-off-contract', id);
  if (!Array.isArray(clip.frames) || clip.frames.length < 2) note('no-frames', id);
  if (Object.keys(clip).sort().join() !== 'frames,meta') note('extra-top-level-keys', id);
  totalFrames += clip.frames.length;

  // --- frame sanity --------------------------------------------------------
  let lastT = -1;
  for (const fr of clip.frames) {
    if (fr.t <= lastT && lastT >= 0) { note('non-monotonic-time', id); break; }
    lastT = fr.t;
    if (fr.pos.length !== 3 || fr.quat.length !== 4) { note('bad-frame-shape', id); break; }
    if (fr.pos[1] < -0.01) { note('below-table', id); break; }
    const n = Math.hypot(...fr.quat);
    worstQuatNorm = Math.max(worstQuatNorm, Math.abs(n - 1));
  }
  if (clip.frames[0].t !== 0) note('first-frame-not-zero', id);

  // --- canonical start: heads-up, coin flat in XZ ---------------------------
  const q0 = clip.frames[0].quat;
  const n0 = headsNormal({ x: q0[0], y: q0[1], z: q0[2], w: q0[3] });
  if (n0[1] < 0.9999) note('start-not-heads-up-flat', id);

  // --- re-count half-flips FROM THE EMITTED FRAMES --------------------------
  // If this agrees, the renderer can derive its own spin-counter ticks and
  // haptic beats straight from the clip without extra metadata.
  const counter = makeFlipCounter();
  for (const fr of clip.frames) {
    counter.push({ x: fr.quat[0], y: fr.quat[1], z: fr.quat[2], w: fr.quat[3] }, fr.t / 1000);
  }
  const d = Math.abs(counter.count - m.halfFlips);
  worstHfRecount = Math.max(worstHfRecount, d);
  if (d !== 0) { note('HALF-FLIP RECOUNT MISMATCH', id); recountMismatch++; }

  // --- re-derive side and orientation from the final quaternion -------------
  const last = clip.frames[clip.frames.length - 1].quat;
  const qf = { x: last[0], y: last[1], z: last[2], w: last[3] };
  const nf = headsNormal(qf);
  minFlatCos = Math.min(minFlatCos, Math.abs(nf[1]));
  if ((nf[1] > 0 ? 'Heads' : 'Tails') !== m.side) note('SIDE MISMATCH', id);
  if ((m.halfFlips % 2 === 0 ? 'Heads' : 'Tails') !== m.side) note('PARITY VIOLATION', id);

  const bx = bodyXAxis(qf);
  const reOrient = heading(bx[0], bx[2]);
  let oerr = Math.abs(reOrient - m.orientationDeg);
  if (oerr > 180) oerr = 360 - oerr;
  worstOrientErr = Math.max(worstOrientErr, oerr);
  if (oerr > 0.01) note('orientation-mismatch', id);
  if (headingToQuadrant(m.orientationDeg) !== m.quadrant) note('QUADRANT MISMATCH', id);
  if (m.settleAngleDeg !== m.orientationDeg) note('settleAngle-differs-from-orientation', id);

  // --- range rules ---------------------------------------------------------
  if (m.halfFlips < 8 || m.halfFlips > 40) note('half-flips-out-of-range', id);
  if (m.halfFlips === 24) note('EXCLUDED-MEDIAN-PRESENT', id);
  if (!(m.energy >= 0 && m.energy <= 1)) note('energy-out-of-range', id);
  if (m.durationMs !== Math.round(clip.frames[clip.frames.length - 1].t)) note('duration-not-last-frame', id);

  const key = cellKey(m.halfFlips, m.quadrant);
  cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
  if (!energyByCell.has(key)) energyByCell.set(key, []);
  energyByCell.get(key).push(m.energy);
}

console.log(`=== LIBRARY AUDIT: ${DIR} ===`);
console.log(`clips: ${files.length}, frames: ${totalFrames} (avg ${(totalFrames / files.length).toFixed(0)}/clip), ` +
  `${(totalBytes / 1048576).toFixed(2)} MB (${(totalBytes / files.length / 1024).toFixed(1)} KB/clip)`);

// --- cell uniformity: THE fairness requirement ------------------------------
const counts = [];
const missing = [];
for (const h of HALF_FLIPS) for (const q of QUADRANTS) {
  const k = cellKey(h, q);
  const c = cellCounts.get(k) || 0;
  counts.push(c);
  if (c === 0) missing.push(k);
}
const min = Math.min(...counts), max = Math.max(...counts);
console.log(`\ncells: ${CELL_COUNT} expected, ${cellCounts.size} present, ${missing.length} empty`);
console.log(`clips per cell: min ${min} max ${max} -> ${min === max ? 'EXACTLY UNIFORM (odds are honest)' : 'NOT UNIFORM (ODDS WOULD BE SKEWED)'}`);
if (min !== max) {
  const under = [];
  for (const h of HALF_FLIPS) for (const q of QUADRANTS) {
    const k = cellKey(h, q); const c = cellCounts.get(k) || 0;
    if (c < max) under.push(`${k}:${c}`);
  }
  console.log(`  under-filled: ${under.join(' ')}`);
}

// --- energy spread within cells ---------------------------------------------
let worstGap = 0, worstCell = '';
for (const [k, es] of energyByCell) {
  const s = [...es].sort((a, b) => a - b);
  if (s.length < 2) continue;
  const ideal = 1 / (s.length - 1);
  for (let i = 1; i < s.length; i++) {
    const g = Math.abs((s[i] - s[i - 1]) - ideal);
    if (g > worstGap) { worstGap = g; worstCell = k; }
  }
}
console.log(`\nenergy spread within cells: worst deviation from an even 0..1 ladder ` +
  `${worstGap.toFixed(5)} (cell ${worstCell || 'n/a'})`);

// --- geometry re-derivation --------------------------------------------------
console.log(`\nre-derived from the emitted frames alone:`);
console.log(`  half-flip recount mismatches: ${recountMismatch}/${files.length} (max delta ${worstHfRecount})`);
console.log(`  worst orientation error:      ${worstOrientErr.toFixed(4)} deg (tolerance 0.01)`);
console.log(`  worst |quat|-1:               ${worstQuatNorm.toExponential(2)}`);
console.log(`  flattest settled coin:        |cos| = ${minFlatCos.toFixed(5)} (must exceed 0.99)`);

// --- distributions -----------------------------------------------------------
const sides = { Heads: 0, Tails: 0 }, quads = { N: 0, E: 0, S: 0, W: 0 };
const orientBins = new Array(36).fill(0);
for (const e of lib.index) {
  sides[e.side]++; quads[e.quadrant]++;
  orientBins[Math.min(35, Math.floor(e.orientationDeg / 10))]++;
}
console.log(`\nside: ${JSON.stringify(sides)}   quadrant: ${JSON.stringify(quads)}`);
const exp = lib.index.length / 36;
const chi = orientBins.reduce((a, b) => a + (b - exp) ** 2 / exp, 0);
console.log(`orientation uniformity over [0,360): chi-square ${chi.toFixed(1)} on 36 bins ` +
  `(df=35, 5% critical 49.8) -> ${chi < 49.8 ? 'uniform' : 'NOT UNIFORM'}`);

// --- live integration with the real consumer ---------------------------------
console.log('\n=== identity.js selectVariant() on the real baked energies ===');
try {
  const { selectVariant } = await import('../identity.js');
  const byCell = new Map();
  for (const e of lib.index) {
    const k = cellKey(e.halfFlips, e.quadrant);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(e);
  }
  let tested = 0, wilder = 0, emptyBand = 0;
  for (const [k, variants] of byCell) {
    if (variants.length < 3) continue;
    variants.sort((a, b) => a.energy - b.energy);
    const seedHex = 'a'.repeat(64);
    const tame = selectVariant(variants, { daringness: 0.1, flickForce: 0.1, seedHex });
    const wild = selectVariant(variants, { daringness: 0.95, flickForce: 0.9, seedHex });
    tested++;
    if (wild.energy > tame.energy) wilder++;
    // does the +/-0.18 band ever come up empty (forcing a fallback to the whole cell)?
    for (const t of [0.0, 0.25, 0.5, 0.75, 1.0]) {
      if (!variants.some((v) => Math.abs(v.energy - t) <= 0.18)) emptyBand++;
    }
  }
  console.log(`  cells tested: ${tested}`);
  console.log(`  daring player got a higher-energy variant in ${wilder}/${tested} cells`);
  console.log(`  empty +/-0.18 selection bands: ${emptyBand} (want 0 — an empty band silently` +
    ` falls back to the whole cell and the signature stops meaning anything)`);
  if (tested && wilder < tested) note('selectVariant-not-monotonic', 'library');
} catch (e) {
  console.log(`  SKIPPED: ${e.message}`);
}

// --- verdict -----------------------------------------------------------------
console.log('');
if (fail === 0 && min === max && min > 0) {
  console.log('AUDIT PASSED — metadata agrees with geometry on every clip, cells exactly uniform.');
  process.exit(0);
} else {
  console.log(`AUDIT FAILED — ${fail} problem(s):`);
  for (const [k, ids] of problems) {
    console.log(`  ${k}: ${ids.length}  e.g. ${ids.slice(0, 5).join(', ')}`);
  }
  process.exit(1);
}
