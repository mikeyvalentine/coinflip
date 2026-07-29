// bake/migrate-energy-apex.mjs
// ---------------------------------------------------------------------------
// Re-rank `energy` by APEX across the existing library, without re-baking.
//
// `energy` is the axis identity.js#selectVariant picks along, so it decides
// which telling of an already-decided outcome a throw buys. It used to rank by
// curate.js#energyRaw — a violence scalar dominated by tumble rate — which meant
// power moved the coin's horizontal skitter from ~11 cm to ~17 cm and nothing
// else. A light toss flew exactly as high as a brutal one, which is what made
// the gesture feel disconnected from the flight.
//
// Meanwhile a median 278 mm spread in apex already sat inside every cell,
// against a 340 mm library-wide range — 82% of the whole range, available with
// no re-simulation at all. The old rank was 50.9% inverted against apex, i.e.
// statistically independent of it, so this is a genuine re-ordering.
//
// THE CLIPS ARE NOT TOUCHED. Only the `energy` field moves, in the four places
// that carry it. Re-running this is idempotent: apex is read from the frames,
// so the same clips always produce the same ranking.
//
// Run: node bake/migrate-energy-apex.mjs [--check]
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const libPath = path.join(ROOT, 'bake/out/library.json');
const clipsDir = path.join(ROOT, 'bake/out/clips');

const lib = JSON.parse(await fs.readFile(libPath, 'utf8'));

/**
 * Apex read from the FRAMES, not from the diag sidecar.
 *
 * The frames are what the renderer plays, so they are the only authority on how
 * high the coin actually goes. A diag file could drift from them; the thing on
 * screen cannot.
 */
async function apexOf(id) {
  const c = JSON.parse(await fs.readFile(path.join(clipsDir, id + '.json'), 'utf8'));
  let a = c.frames[0].pos[1];
  for (const f of c.frames) if (f.pos[1] > a) a = f.pos[1];
  return a;
}

// --- group into cells, rank by apex ----------------------------------------
const cells = new Map();
const apex = new Map();
for (const e of lib.index) {
  apex.set(e.id, await apexOf(e.id));
  const k = `${e.halfFlips}${e.quadrant}`;
  if (!cells.has(k)) cells.set(k, []);
  cells.get(k).push(e);
}

const newEnergy = new Map();
for (const [, entries] of cells) {
  // Same tie-break as curate.js: apex is a float off a physics sim and two
  // clips can be micrometres apart, so id keeps the order deterministic.
  const sorted = [...entries].sort(
    (a, b) => apex.get(a.id) - apex.get(b.id) || a.id.localeCompare(b.id),
  );
  const n = sorted.length;
  sorted.forEach((e, i) => {
    newEnergy.set(e.id, n === 1 ? 0.5 : +(i / (n - 1)).toFixed(4));
  });
}

// --- report what moves ------------------------------------------------------
let changed = 0;
for (const e of lib.index) if (e.energy !== newEnergy.get(e.id)) changed++;
console.log(`${lib.index.length} clips in ${cells.size} cells`);
console.log(`  energy changes on ${changed} of them`);

const spreads = [...cells.values()].map((es) => {
  const a = es.map((e) => apex.get(e.id));
  return (Math.max(...a) - Math.min(...a)) * 1000;
}).sort((x, y) => x - y);
console.log(`  within-cell apex spread: min ${spreads[0].toFixed(0)} mm, `
  + `median ${spreads[spreads.length >> 1].toFixed(0)} mm, max ${spreads[spreads.length - 1].toFixed(0)} mm`);

if (CHECK) {
  console.log(changed === 0 ? '\nalready ranked by apex' : `\n${changed} clips would change; run without --check`);
  process.exit(0);
}

// --- write library.json -----------------------------------------------------
for (const e of lib.index) e.energy = newEnergy.get(e.id);
await fs.writeFile(libPath, JSON.stringify(lib, null, 2) + '\n', 'utf8');
console.log('  wrote bake/out/library.json');

// --- write each clip's meta.energy -----------------------------------------
let clipsWritten = 0;
for (const e of lib.index) {
  const p = path.join(clipsDir, e.id + '.json');
  const c = JSON.parse(await fs.readFile(p, 'utf8'));
  if (c.meta.energy === newEnergy.get(e.id)) continue;
  c.meta.energy = newEnergy.get(e.id);
  await fs.writeFile(p, JSON.stringify(c), 'utf8');
  clipsWritten++;
}
console.log(`  wrote ${clipsWritten} clip files`);

console.log('\nNOW RE-PACK: node bake/encode.js');
console.log('  the renderer loads bake/out-min/, so a stale pack would keep the old');
console.log('  ranking and nothing would go red — the metadata and the thing on');
console.log('  screen would simply disagree.');
