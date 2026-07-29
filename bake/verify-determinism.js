// verify-determinism.js — same seed must give byte-identical results.
//
// Runs the bake TWICE, in two SEPARATE Node processes (so no in-process state,
// module cache or warm WASM instance can paper over a non-determinism), then
// hashes every emitted file and diffs.
//
// Also checks the weaker-but-important property that a single clip re-simulated
// from identical launch parameters reproduces bit-for-bit within one process.
//
// Run: node verify-determinism.js [--per-cell 1]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { initRapier, simulateClip, omegaForHalfFlips } from './sim.js';
import { classify } from './classify.js';
import { makeRng } from './prng.js';
import { LAUNCH } from './config.js';

const perCell = process.argv.includes('--per-cell')
  ? process.argv[process.argv.indexOf('--per-cell') + 1] : '1';

function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

function hashTree(dir) {
  const out = new Map();
  for (const sub of ['clips', 'diag']) {
    const p = join(dir, sub);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p).sort()) out.set(`${sub}/${f}`, sha(readFileSync(join(p, f))));
  }
  out.set('library.json', sha(readFileSync(join(dir, 'library.json'))));
  return out;
}

console.log('=== 1. In-process: identical launch parameters reproduce exactly ===');
await initRapier();
{
  const rng = makeRng('determinism-check', 'params');
  let mismatches = 0;
  for (let i = 0; i < 40; i++) {
    const p = {
      y0: LAUNCH.y0,
      vy: rng.range(LAUNCH.vyMin, LAUNCH.vyMax),
      omega: rng.range(LAUNCH.omegaMin, LAUNCH.omegaMax),
      vh: rng.range(LAUNCH.vhMin, LAUNCH.vhMax),
      psi: rng.range(0, 2 * Math.PI),
      spinY: rng.range(-LAUNCH.spinYMax, LAUNCH.spinYMax),
      yaw0: rng.range(0, 2 * Math.PI),
    };
    const a = simulateClip(p), b = simulateClip(p);
    const ha = sha(JSON.stringify({ m: classify(a).meta, f: a.frames }));
    const hb = sha(JSON.stringify({ m: classify(b).meta, f: b.frames }));
    if (ha !== hb) { mismatches++; console.log(`  MISMATCH on clip ${i}`); }
  }
  console.log(mismatches === 0
    ? '  PASS: 40/40 re-simulations byte-identical (meta + full frame track)'
    : `  FAIL: ${mismatches}/40 differed`);
  if (mismatches) process.exit(1);
}

console.log('\n=== 2. PRNG stream independence and reproducibility ===');
{
  const a = makeRng('S', 'label-x'), b = makeRng('S', 'label-x'), c = makeRng('S', 'label-y');
  const va = Array.from({ length: 6 }, () => a.f());
  const vb = Array.from({ length: 6 }, () => b.f());
  const vc = Array.from({ length: 6 }, () => c.f());
  console.log(`  same (seed,label) reproduces: ${JSON.stringify(va) === JSON.stringify(vb)}`);
  console.log(`  different label diverges:     ${JSON.stringify(va) !== JSON.stringify(vc)}`);
  // Named streams mean clip N's parameters do not depend on how many clips ran
  // before it, so the bake is order-independent and resumable.
  const d = makeRng('S', 'cell:17N:slot:3');
  const e = makeRng('S', 'cell:17N:slot:3');
  console.log(`  per-cell stream stable:      ${d.f() === e.f()}`);
}

console.log(`\n=== 3. Cross-process: two full bakes at --per-cell ${perCell} ===`);
const dirs = ['./.det-a', './.det-b'];
for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });

const times = [];
for (const d of dirs) {
  const t = Date.now();
  execFileSync(process.execPath,
    ['bake.js', '--per-cell', perCell, '--oversample', '2', '--out', d, '--quiet'],
    { stdio: 'pipe' });
  times.push(Date.now() - t);
}
console.log(`  two bakes completed (${times.map((t) => (t / 1000).toFixed(1) + 's').join(', ')})`);

const A = hashTree(dirs[0]), B = hashTree(dirs[1]);
const keysA = [...A.keys()].sort(), keysB = [...B.keys()].sort();

let ok = true;
if (JSON.stringify(keysA) !== JSON.stringify(keysB)) {
  ok = false;
  console.log(`  FAIL: file lists differ (${keysA.length} vs ${keysB.length})`);
}
let diffs = 0;
for (const k of keysA) if (A.get(k) !== B.get(k)) { diffs++; if (diffs <= 5) console.log(`  DIFFERS: ${k}`); }
if (diffs) ok = false;

console.log(`  files compared: ${keysA.length}`);
console.log(`  differing files: ${diffs}`);
const rootA = sha([...keysA].map((k) => `${k}:${A.get(k)}`).join('\n'));
const rootB = sha([...keysB].map((k) => `${k}:${B.get(k)}`).join('\n'));
console.log(`  merkle root A: ${rootA}`);
console.log(`  merkle root B: ${rootB}`);
console.log(ok && rootA === rootB
  ? '  PASS: two independent processes produced a byte-identical library'
  : '  FAIL: bake is NOT deterministic');

for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(ok && rootA === rootB ? 0 : 1);
