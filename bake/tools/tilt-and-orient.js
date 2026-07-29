// tilt-and-orient.js — two diagnostics on a written library.
//  1. How flat is a "settled" coin really? A rigid cylinder on a flat plane
//     cannot rest tilted, so any residual tilt is solver slop and the gate
//     should be tight enough to exclude anything a player would notice.
//  2. Where does the settled orientation actually fall inside its quadrant?
//     Farthest-point sampling prefers extremes, so putting orientation in the
//     diversity vector can push clips to the quadrant edges.
// Run: node tools/tilt-and-orient.js ./out

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { headsNormal } from '../quat.js';
import { quadrantRange } from '../classify.js';

const DIR = process.argv[2] || './out';
const files = readdirSync(join(DIR, 'clips')).filter((f) => f.endsWith('.json'));

const tilts = [];
const inQuad = [];
for (const f of files) {
  const clip = JSON.parse(readFileSync(join(DIR, 'clips', f), 'utf8'));
  const q = clip.frames[clip.frames.length - 1].quat;
  const n = headsNormal({ x: q[0], y: q[1], z: q[2], w: q[3] });
  tilts.push((Math.acos(Math.min(1, Math.abs(n[1]))) * 180) / Math.PI);
  const [lo] = quadrantRange(clip.meta.quadrant);
  inQuad.push((clip.meta.orientationDeg - lo) / 90);
}

tilts.sort((a, b) => a - b);
const p = (x) => tilts[Math.floor(x * (tilts.length - 1))].toFixed(4);
console.log(`=== settled tilt from flat, degrees (n=${tilts.length}) ===`);
console.log(`  p50 ${p(0.5)}  p90 ${p(0.9)}  p99 ${p(0.99)}  max ${p(1)}`);
for (const thr of [0.5, 1, 2, 3, 5]) {
  console.log(`  clips tilted more than ${thr} deg: ${tilts.filter((t) => t > thr).length}/${tilts.length}`);
}

console.log(`\n=== position within quadrant (0 = quadrant start, 1 = quadrant end) ===`);
const bins = new Array(10).fill(0);
for (const v of inQuad) bins[Math.min(9, Math.floor(v * 10))]++;
console.log(`  deciles: ${bins.join(' ')}   (expected ${(inQuad.length / 10).toFixed(0)} each)`);
const exp = inQuad.length / 10;
console.log(`  chi-square ${bins.reduce((a, b) => a + (b - exp) ** 2 / exp, 0).toFixed(1)} (df=9, 5% critical 16.9)`);
