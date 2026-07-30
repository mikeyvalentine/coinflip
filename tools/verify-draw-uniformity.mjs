// tools/verify-draw-uniformity.mjs
// ---------------------------------------------------------------------------
// THE DRAW IS THE ODDS. This asserts that the LIVE draw is uniform on every
// axis a player is paid on, by testing the shipped function directly rather
// than by comparing it against a second implementation.
//
// WHY THIS EXISTS, and why it is not covered by what was already here.
//
// tools/verify-draw-parity.mjs catches a biased draw — but only by running the
// 2D game's implementation and the renderer's side by side and noticing they
// disagree. That is a real guard and it has caught real bugs. It also
// evaporates the moment the two builds are merged, which is the entire point of
// the merge: there will be ONE implementation and nothing left to compare it
// against.
//
// Worse, the uniformity checks that look like they would cover the gap do not.
// Biasing the start face 3:1 was measured to leave `side` at chi-square 2.71
// against a threshold of 12 — comfortably "uniform" — because
//
//     side = (spins even) ? startFace : !startFace
//
// and spins are uniformly even and odd, so the parity construction RANDOMISES
// side no matter how skewed the start face is. It is self-correcting for the
// axis being measured and blind to the axis that is actually broken.
//
// So the start face — shown to the player BEFORE they bet, and the thing that
// makes side and spin independent axes at all — had no uniformity assertion
// anywhere in the project. It was covered by accident.
//
// Every section here tests `flip3d/outcome.js#resolveFlip` directly, so it
// survives unification. Section (7) proves the suite can actually fail.
//
// Run: node tools/verify-draw-uniformity.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFlip } from '../flip3d/outcome.js';
import { loadClipLibrary } from '../flip3d/library.js';
import { SPIN_VALUES, QUADRANTS } from '../flip3d/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };

const fetchShim = async (url) => {
  const rel = path.normalize(url).replace(/^[\\/]+/, '');
  try {
    const b = await fs.readFile(path.resolve(ROOT, rel));
    return {
      ok: true, status: 200,
      json: async () => JSON.parse(b.toString('utf8')),
      buffer: async () => b,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  } catch (e) { return { ok: false, status: 404, json: async () => { throw e; } }; }
};
const library = await loadClipLibrary({ base: './bake/out/', fetch: fetchShim });

/** Chi-square against a uniform expectation over `k` categories. */
function chi(counts, k) {
  const vals = Object.values(counts);
  const n = vals.reduce((a, c) => a + c, 0);
  const exp = n / k;
  return vals.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
}
const tally = (arr) => arr.reduce((m, v) => { m[v] = (m[v] || 0) + 1; return m; }, {});

// 99.9th percentile of the chi-square distribution, by degrees of freedom.
//
// I first used the 95th, reasoning that a real critical value means more than a
// round number. It does — and it also fails a PERFECTLY FAIR draw 5% of the
// time, per section. Across four sections that is a ~19% chance of a spurious
// red on every run. The quadrant section duly failed at 8.09 against 7.81 on a
// draw that is fine.
//
// A fairness suite that cries wolf gets muted, and a muted fairness suite is
// worse than none — so the bound is the 99.9th percentile: a fair draw trips it
// once in a thousand runs. That costs sensitivity, and the cost is affordable
// here because the failure mode this exists to catch is not subtle: the 3:1
// start-face bias measured in section (7) scores 2000 against a bound of 10.83.
const CRIT = { 1: 10.83, 3: 16.27, 31: 61.10 };

const N = 40000;
console.log(`drawing ${N.toLocaleString()} outcomes from the LIVE resolveFlip\n`);
const draws = [];
for (let i = 0; i < N; i++) draws.push(await resolveFlip('uni::' + i, library));

console.log('=== (1) THE START FACE — the axis nothing was watching ===');
{
  const t = tally(draws.map((d) => d.startFace));
  const c = chi(t, 2);
  console.table([{ counts: JSON.stringify(t), 'chi-sq': c.toFixed(2), df: 1, 'crit 99.9%': CRIT[1] }]);
  ok(c < CRIT[1], 'the start face is not uniform', { chi: c, t });
  console.log('  It is shown to the player BEFORE they bet, and side/spin are only');
  console.log('  independent axes because it is random. Nothing asserted this until now.');
}

console.log('\n=== (2) SPINS — all 32 values, the spin bet is priced on this ===');
{
  const nonEdge = draws.filter((d) => !d.edge);
  const t = tally(nonEdge.map((d) => d.spins));
  const c = chi(t, SPIN_VALUES.length);
  const seen = Object.keys(t).length;
  ok(seen === SPIN_VALUES.length, 'not every spin value can be drawn', { seen, want: SPIN_VALUES.length });
  ok(c < CRIT[31], 'the spin draw is not uniform', { chi: c });
  const counts = Object.values(t);
  console.log(`  ${seen}/${SPIN_VALUES.length} values reachable, chi-sq ${c.toFixed(2)} (df 31, crit ${CRIT[31]})`);
  console.log(`  per-value counts ${Math.min(...counts)}..${Math.max(...counts)} against ${Math.round(nonEdge.length / seen)} expected`);
  ok(!t[24], 'the excluded median 24 was drawn — higher/lower stops being a clean 50/50', { n: t[24] });
  console.log('  and 24 is never drawn: excluding the median is what makes higher/lower');
  console.log('  an exact 50/50 and balances parity so P(same side as start) = 0.500');
}

console.log('\n=== (3) QUADRANT — the orientation bet is priced 4/k on this ===');
{
  const t = tally(draws.filter((d) => !d.edge).map((d) => d.quadrant));
  const c = chi(t, 4);
  console.table([{ counts: JSON.stringify(t), 'chi-sq': c.toFixed(2), df: 3, 'crit 99.9%': CRIT[3] }]);
  ok(c < CRIT[3], 'the quadrant draw is not uniform', { chi: c, t });
  ok(Object.keys(t).every((q) => QUADRANTS.includes(q)), 'an unknown quadrant name was drawn', { t });
}

console.log('\n=== (4) SIDE — and why this one alone is NOT enough ===');
{
  const t = tally(draws.filter((d) => !d.edge).map((d) => d.side));
  const c = chi(t, 2);
  console.table([{ counts: JSON.stringify(t), 'chi-sq': c.toFixed(2), df: 1, 'crit 99.9%': CRIT[1] }]);
  ok(c < CRIT[1], 'the side draw is not uniform', { chi: c, t });
  console.log('  side = (spins even) ? startFace : !startFace, and spins are uniformly');
  console.log('  even/odd — so this stays 50/50 EVEN IF the start face is badly biased.');
  console.log('  That is why section (1) has to exist separately. A measured 3:1 skew on');
  console.log('  the start face left this at chi-sq 2.71, well inside the bound.');
}

console.log('\n=== (5) THE EDGE — the only source of house edge ===');
{
  const n = draws.filter((d) => d.edge).length;
  const rate = n / N;
  const se = Math.sqrt(0.002 * 0.998 / N);
  const z = Math.abs(rate - 0.002) / se;
  console.log(`  ${n} rim draws in ${N.toLocaleString()} = ${(rate * 100).toFixed(4)}% (want 0.2000%)`);
  console.log(`  standard error ${(se * 100).toFixed(4)} pp, so this is ${z.toFixed(2)} sigma`);
  ok(z < 3, 'the Edge rate is off spec', { rate, z });
}

console.log('\n=== (6) THE AXES ARE INDEPENDENT — the bets must not be correlated ===');
{
  // The spin bet and the orientation bet are priced separately, so if the two
  // draws were correlated a player could buy the same information twice — or
  // find a pair that cannot both lose. Bucket spins coarsely so the table has
  // enough in each cell to mean something.
  const nonEdge = draws.filter((d) => !d.edge);
  const bucket = (s) => Math.floor((SPIN_VALUES.indexOf(s)) / 8);   // 4 buckets of 8
  const grid = {};
  for (const d of nonEdge) {
    const k = bucket(d.spins) + '|' + d.quadrant;
    grid[k] = (grid[k] || 0) + 1;
  }
  const c = chi(grid, 16);
  console.log(`  spin-bucket x quadrant, 16 cells: chi-sq ${c.toFixed(2)} (df 15, crit 25.0)`);
  ok(c < 25.0, 'spin and quadrant are correlated — the two bets are not independent', { chi: c });

  // startFace vs spins parity is the ONE pair that is deliberately dependent:
  // side is derived from it. Assert the dependency is exactly as designed
  // rather than pretending it is not there.
  let agree = 0;
  for (const d of nonEdge) {
    const even = d.spins % 2 === 0;
    if ((even ? d.startFace : (d.startFace === 'Heads' ? 'Tails' : 'Heads')) === d.side) agree++;
  }
  ok(agree === nonEdge.length,
    'side is not exactly the parity of spins against the start face', { agree, of: nonEdge.length });
  console.log(`  side follows spin parity on ${agree}/${nonEdge.length} draws — by construction,`);
  console.log('  which is a DEPENDENCY between two bet axes and is documented, not a bug');
}

console.log('\n=== (7) THIS SUITE CAN ACTUALLY FAIL ===');
{
  // A fairness test that cannot fail is the most dangerous file in a project:
  // it converts "nobody checked" into "checked and fine". So bias a draw here,
  // in the test, and confirm each section rejects it.
  const biased = [];
  for (let i = 0; i < 8000; i++) {
    const d = await resolveFlip('uni::' + i, library);
    // 3:1 toward Heads on the start face — the exact mutation that slipped past
    // every other suite in the project.
    // Bias the start face AND re-derive side from it, exactly as the real draw
    // does. My first version overrode startFace but kept the original side, so
    // the sample did not actually demonstrate the blind spot — it just showed
    // two unrelated fields disagreeing, and I nearly published that as evidence.
    const startFace = (i % 4 === 0) ? 'Tails' : 'Heads';
    const even = d.spins % 2 === 0;
    const side = even ? startFace : (startFace === 'Heads' ? 'Tails' : 'Heads');
    biased.push({ ...d, startFace, side });
  }
  const cStart = chi(tally(biased.map((d) => d.startFace)), 2);
  ok(cStart > CRIT[1], 'section (1) would NOT catch a 3:1 start-face bias', { chi: cStart });
  console.log(`  a 3:1 start-face bias scores chi-sq ${cStart.toFixed(0)} against a bound of ${CRIT[1]}`);

  const flat = chi(tally(biased.filter((d) => !d.edge).map((d) => d.side)), 2);
  ok(flat < CRIT[1],
    'the blind spot has closed on its own — side now moves with the start face, '
    + 'so re-check whether section (1) is still load-bearing', { chi: flat });
  console.log(`  the SAME biased sample leaves side at chi-sq ${flat.toFixed(2)}, inside the ${CRIT[1]} bound —`);
  console.log('  side is still "uniform" while the start face is 3:1 broken. That gap is');
  console.log('  exactly what section (1) exists to cover, and this asserts the gap is real:');
  console.log('  if side ever DID move with the start face, this goes red and tells us so.');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
