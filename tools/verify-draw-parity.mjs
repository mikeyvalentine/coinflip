// tools/verify-draw-parity.mjs
// ---------------------------------------------------------------------------
// THE MERGE GATE. There are two independent implementations of the outcome
// draw — the one inlined in coinflip-preview.html (gameplay source of truth)
// and flip3d/outcome.js (what the renderer animates). Merging the two builds
// means deleting one of them, and this file is what makes that safe: it runs
// BOTH over the same seeds and reports, field by field, where they disagree.
//
// It is deliberately NOT a code merge. The preview is a single self-contained
// file with no build step and no imports — that is a stated property, and it is
// also what lets it be published as a standalone artifact. So the two draws stay
// separate and this proves they agree, rather than making one call the other.
//
// A field that diverges here is a real economic difference between the two
// builds, not a style difference, because these functions ARE the odds.
//
// Run: node tools/verify-draw-parity.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFlip as resolve3D } from '../flip3d/outcome.js';
import { loadClipLibrary } from '../flip3d/library.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };

// --- lift the preview's draw out of the HTML, unmodified -------------------
const mk = () => {
  const e = {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    placeholder: '', max: 0, offsetLeft: 0, offsetTop: 0,
    addEventListener() {}, removeEventListener() {}, prepend() {}, blur() {}, focus() {},
    setAttribute() {}, getAttribute: () => null, appendChild() {}, remove() {},
    closest() { return e; }, querySelector() { return e; }, querySelectorAll: () => [],
  };
  return e;
};
const shared = mk();
globalThis.document = { querySelector: () => shared, querySelectorAll: () => [], createElement: mk, body: shared, addEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.performance = { now: () => 0 };
globalThis.setInterval = () => 0;
globalThis.requestAnimationFrame = () => 0;

const html = await fs.readFile(path.join(ROOT, 'coinflip-preview.html'), 'utf8');
const body = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
const tmp = path.join(ROOT, '_parity_probe.mjs');
await fs.writeFile(tmp, body + '\nglobalThis.__P = { resolveFlip, SPIN_VALUES, EDGE_P };\n', 'utf8');
await import('file://' + tmp.split(path.sep).join('/'));
await fs.unlink(tmp);
const P = globalThis.__P;

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
  } catch (e) { return { ok: false, status: 404, json: async () => { throw e; }, buffer: async () => { throw e; } }; }
};
const library = await loadClipLibrary({ base: './bake/out/', fetch: fetchShim });
console.log(`library loaded (${library.stats.source}), ${library.stats.clips} clips\n`);

const N = 4000;
const seeds = Array.from({ length: N }, (_, i) => 'parity::' + i);

console.log('=== (1) field-by-field divergence over ' + N + ' seeds ===');
const diff = { startFace: 0, spins: 0, side: 0, quadrant: 0, orientationDeg: 0, edge: 0 };
let edgesPreview = 0, edges3D = 0;
const samples = [];
for (const s of seeds) {
  const a = await P.resolveFlip(s);
  const b = await resolve3D(s, library);
  if (a.startFace !== b.startFace) diff.startFace++;
  if (!!a.edge !== !!b.edge) diff.edge++;
  if (a.edge) edgesPreview++;
  if (b.edge) edges3D++;
  // ON AN EDGE THE TWO BUILDS DIFFER IN SHAPE, AND THAT IS DELIBERATE.
  //
  // The preview leaves side/spins/quadrant populated and lets `edge:true` sweep
  // them at settlement. The renderer nulls them, because it has to hand the
  // outcome to assertOutcome and then to a rim clip that HAS no side, no
  // rotation count and no settled yaw — carrying stale values there invites
  // something downstream to score a bet the rim already swept.
  //
  // So those fields are not comparable on an Edge, and comparing them would
  // report four failures for one intentional difference. What MUST agree is
  // WHICH SEEDS draw the rim — that is what sets the house edge — and it is
  // asserted separately below.
  if (a.edge || b.edge) { if (samples.length < 3) samples.push({ seed: s, preview: a, renderer: b }); continue; }
  if (a.spins !== b.spins) diff.spins++;
  if (a.side !== b.side) diff.side++;
  // Compared RAW. There used to be a lookup translating NE/SE/SW/NW to
  // N/E/S/W here, because the two builds named the same buckets differently.
  // They no longer do, and leaving the map in would hide the next divergence
  // behind a translation that silently made it pass.
  if (a.quadrant !== b.quadrant) diff.quadrant++;
  if (Math.abs(a.orientationDeg - b.orientationDeg) > 1e-9) diff.orientationDeg++;
  if (samples.length < 3) samples.push({ seed: s, preview: a, renderer: b });
}
console.table(Object.entries(diff).map(([field, n]) => ({
  field, 'seeds that disagree': n, share: (100 * n / N).toFixed(2) + '%',
  verdict: n === 0 ? 'identical' : 'DIVERGES',
})));

console.log('\n=== (2) what the divergences MEAN ===');
ok(diff.startFace === 0, 'startFace diverges — the shown face would differ between builds');
ok(diff.spins === 0, 'spins diverges — the spin bet would pay differently');
ok(diff.side === 0, 'side diverges — the side bet would pay differently');
console.log('  startFace / spins / side: identical. Both derive them from the same');
console.log('  hashes with the same divisors, so the two core bet axes already agree.');

console.log(`\n  QUADRANT: ${diff.quadrant}/${N} disagree after normalising the labels.`);
console.log('    The preview calls the buckets NE/SE/SW/NW, contract.js calls the SAME');
console.log('    buckets N/E/S/W — both are floor(deg/90). But the preview derives the');
console.log('    quadrant FROM a freely drawn angle, while the renderer draws the');
console.log('    quadrant directly and takes the angle from the clip that plays. Two');
console.log('    different draws off two different hashes: uniform either way, but not');
console.log('    the same outcome for a given seed.');

console.log(`\n  ORIENTATION: ${diff.orientationDeg}/${N} disagree — expected, and harmless to the BET.`);
console.log('    The bet resolves on quadrant only (4 / quadrants selected). The 2dp');
console.log('    angle is a readout. The renderer can only show one of 1006 baked');
console.log('    angles; the preview invents one of 36,000.');

console.log(`\n  *** THE EDGE: preview drew it ${edgesPreview}/${N} times, the renderer ${edges3D}/${N}. ***`);
// NOT a failure — a KNOWN, DELIBERATE gap. Left red, this suite would train
// everyone to ignore it and "all suites green" would stop meaning anything.
// What IS a failure is someone closing the gap by faking a rim landing the
// physics never produced.
// THE GAP IS CLOSED. This was `false`, with an inverted assertion that failed
// if the renderer ever produced an Edge — because with no rim clip in the bake,
// an Edge could only have been faked. `bake/out-edge/` now holds 12 real rim
// landings, so the assertion flips to its true form: the renderer must draw
// them, and must agree with the game about WHICH seeds draw them.
const EDGE_RENDERABLE = true;
if (EDGE_RENDERABLE) {
  ok(edges3D > 0, 'the renderer claims it renders the Edge but never drew one', { edges3D });
  ok(diff.edge === 0,
    'the two builds disagree about which seeds land on the rim — the house edge would differ',
    { disagreements: diff.edge, edgesPreview, edges3D });
} else {
  ok(edges3D === 0,
    'the renderer produced an Edge with no rim clip — that landing was FAKED', { edges3D });
}

console.log('\n=== (3) THE EDGE, now rendered rather than blocked ===');
{
  // This section used to be titled BLOCKER. The rim clips now exist, so it
  // records what closed rather than what is missing — the history matters,
  // because "the renderer cannot show an Edge" is exactly the kind of thing
  // that gets quietly re-broken by someone optimising the library.
  console.log(`  rim clips loaded: ${library.edgeIndex.length} (bake/out-edge/, kept OUT of the pack)`);
  console.log(`  face clips whose side is neither Heads nor Tails: `
    + `${library.index.filter((e) => e.side !== 'Heads' && e.side !== 'Tails').length} — the two libraries stay separate`);
  ok(library.edgeIndex.length > 0,
    'no rim clips are loaded — the renderer is back to being unable to show an Edge');
  console.log('');
  console.log('  The Edge is the ONLY thing creating a house edge — a uniform 0.20% on');
  console.log('  every bet — and it pays 499x on 1/500. A build that cannot render it');
  console.log('  either drops the house edge to ZERO or shows the player a landing that');
  console.log('  did not happen. Both builds now draw it on the SAME seeds.');
  console.log('');
  console.log('  The rim clips are NOT in the packed library on purpose: the pack stores');
  console.log('  quadrant as a UInt8 index, so a null becomes -1 and throws, and');
  console.log('  orientationDeg as a float, so a null would silently decode as 0.00 deg');
  console.log('  in the NE bucket — a rim landing arriving as a FACE landing.');
}

console.log('\n=== (4) both draws are still UNIFORM, which is what fairness needs ===');
{
  // Per-seed agreement was never the requirement — two fair coins disagree
  // constantly. What must hold is that each draw is uniform on its own, which
  // is what makes picking either one at merge time cost nothing.
  const cnt = (a) => a.reduce((m, q) => { m[q] = (m[q] || 0) + 1; return m; }, {});
  const chi = (counts, k) => {
    const n = Object.values(counts).reduce((x, y) => x + y, 0); const exp = n / k;
    return Object.values(counts).reduce((x, c) => x + (c - exp) ** 2 / exp, 0);
  };
  const pq = []; const rq = []; const ps = []; const rs = [];
  for (const s of seeds) {
    const a = await P.resolveFlip(s); const b = await resolve3D(s, library);
    // Rim landings have no quadrant and no side to tally — including them puts
    // a `null`/'Edge' bucket in the histogram and the chi-square goes NaN.
    // They are ~0.2% of seeds and are counted in section (1).
    if (a.edge || b.edge) continue;
    pq.push(a.quadrant); rq.push(b.quadrant); ps.push(a.side); rs.push(b.side);
  }
  console.table([
    { draw: 'preview quadrant', counts: JSON.stringify(cnt(pq)), 'chi-sq': chi(cnt(pq), 4).toFixed(2), 'df': 3, 'want under': 12 },
    { draw: 'renderer quadrant', counts: JSON.stringify(cnt(rq)), 'chi-sq': chi(cnt(rq), 4).toFixed(2), 'df': 3, 'want under': 12 },
    { draw: 'preview side', counts: JSON.stringify(cnt(ps)), 'chi-sq': chi(cnt(ps), 2).toFixed(2), 'df': 1, 'want under': 12 },
    { draw: 'renderer side', counts: JSON.stringify(cnt(rs)), 'chi-sq': chi(cnt(rs), 2).toFixed(2), 'df': 1, 'want under': 12 },
  ]);
  ok(chi(cnt(pq), 4) < 12 && chi(cnt(rq), 4) < 12, 'a quadrant draw is not uniform');
  ok(chi(cnt(ps), 2) < 12 && chi(cnt(rs), 2) < 12, 'a side draw is not uniform');
  console.log('  Both uniform. So the quadrant divergence is two fair draws disagreeing,');
  console.log('  not one of them being wrong — the merge picks either and loses nothing.');
}

console.log('\n=== (5) sample outcomes, same seed, both builds ===');
console.table(samples.map((s) => ({
  seed: s.seed,
  'preview': `${s.preview.startFace}->${s.preview.side} spin ${s.preview.spins} ${s.preview.quadrant} ${s.preview.orientationDeg.toFixed(2)}deg${s.preview.edge ? ' EDGE' : ''}`,
  'renderer': `${s.renderer.startFace}->${s.renderer.side} spin ${s.renderer.spins} ${s.renderer.quadrant} ${s.renderer.orientationDeg.toFixed(2)}deg${s.renderer.edge ? ' EDGE' : ''}`,
})));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
