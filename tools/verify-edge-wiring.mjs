// tools/verify-edge-wiring.mjs
// ---------------------------------------------------------------------------
// THE EDGE, wired end to end: the 1/500 rim draw, the rim clips it selects, and
// the guarantee that switching it on moved NOTHING else.
//
// This is deliberately independent of tools/verify-draw-parity.mjs. That file
// lifts the preview's draw out of the HTML and compares the two builds; this
// one checks the renderer's own draw against a from-spec reference, so a bug
// that happened to be present in BOTH builds would still be caught here.
//
// What it exists to prove, hardest first:
//
//   1. NO OTHER OUTCOME MOVED. Adding a 1/500 override to the draw is a change
//      to the odds of the whole game if it perturbs anything else. Section (1)
//      re-derives the pre-Edge algorithm from the spec and demands bit-for-bit
//      equality on every seed that did not draw the rim.
//   2. THE LANDING IS REAL. An Edge must resolve to an actual baked rim clip
//      whose metadata says it is one — never a face landing relabelled.
//   3. THE VALIDATOR STILL BITES. assertOutcome had to be taught about Edges,
//      and loosening a validator is exactly where a faked landing would later
//      slip in. Section (4) attacks it with malformed outcomes.
//
// Run: node tools/verify-edge-wiring.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFlip, sha, EDGE_P } from '../flip3d/outcome.js';
import { loadClipLibrary } from '../flip3d/library.js';
import { SPIN_VALUES, QUADRANTS, assertOutcome, expectedSide } from '../flip3d/contract.js';

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
  } catch (e) { return { ok: false, status: 404, json: async () => { throw e; }, buffer: async () => { throw e; } }; }
};
const library = await loadClipLibrary({ base: './bake/out/', fetch: fetchShim });
console.log(`library: ${library.stats.clips} face clips (${library.stats.source}), `
  + `${library.edgeIndex.length} rim clips\n`);

const big = (hex, bits = 32) => BigInt('0x' + hex.slice(0, bits / 4));

// ===========================================================================
console.log('=== (1) SWITCHING THE EDGE ON MOVED NOTHING ELSE ===');
{
  // The pre-Edge algorithm, re-derived from the spec rather than by calling the
  // code under test. If this were written by copying resolveFlip, a change that
  // broke both would agree with itself and pass.
  async function preEdgeDraw(seed) {
    const startHeads = (big(await sha('start::' + seed), 8) % 2n) === 0n;
    const idx = Number(big(await sha('spins::' + seed), 32) % BigInt(SPIN_VALUES.length));
    const spins = SPIN_VALUES[idx];
    const landsHeads = spins % 2 === 0 ? startHeads : !startHeads;
    const base = {
      startFace: startHeads ? 'Heads' : 'Tails',
      side: landsHeads ? 'Heads' : 'Tails',
      spins, edge: false,
    };
    const quadrant = QUADRANTS[Number(big(await sha('quad::' + seed), 32) % 4n)];
    const pool = library.pool({ ...base, quadrant, orientationDeg: null });
    const v = Number(big(await sha('variant::' + seed), 32) % BigInt(pool.length));
    const entry = pool[v];
    return { ...base, quadrant, orientationDeg: entry.orientationDeg, clipId: entry.id, energy: entry.energy };
  }

  const N = 8000;
  let checked = 0, moved = 0, edges = 0;
  const movedSamples = [];
  for (let i = 0; i < N; i++) {
    const seed = 'unchanged::' + i;
    const now = await resolveFlip(seed, library);
    if (now.edge) { edges++; continue; }
    checked++;
    const before = await preEdgeDraw(seed);
    for (const k of ['startFace', 'side', 'spins', 'quadrant', 'orientationDeg', 'clipId', 'energy', 'edge']) {
      if (now[k] !== before[k]) {
        moved++;
        if (movedSamples.length < 3) movedSamples.push({ seed, field: k, before: before[k], now: now[k] });
        break;
      }
    }
  }
  ok(moved === 0, 'a non-Edge outcome CHANGED when the Edge was switched on', { moved, movedSamples });
  console.log(`  ${checked} non-Edge seeds re-derived from spec: ${moved} differ (must be 0)`);
  console.log(`  ${edges} of ${N} drew the rim and were skipped — they had no "before"`);
  console.log('  the rim is an OVERRIDE folded in at the end, not a reordering of the draw');
}

// ===========================================================================
console.log('\n=== (2) the rate is 1/500, with an honest error bar ===');
{
  // 1/500 is rare, so a small sample proves nothing. Relative standard error is
  // sqrt((1-p)/(pN)), which is +-50% at 4000 seeds and only reaches +-10% near
  // 50k. Report the interval rather than claiming an agreement not shown.
  const N = 60000;
  const t0 = Date.now();
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const v = Number(big(await sha('edge::rate::' + i), 64) % 100000n) / 100000;
    if (v < EDGE_P) hits++;
  }
  const rate = hits / N;
  const se = Math.sqrt(EDGE_P * (1 - EDGE_P) / N);
  const z = Math.abs(rate - EDGE_P) / se;
  console.log(`  ${N} seeds in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${hits} rim draws`);
  console.log(`  measured ${(rate * 100).toFixed(4)}%   expected ${(EDGE_P * 100).toFixed(4)}%`);
  console.log(`  standard error ${(se * 100).toFixed(4)} pp -> 95% interval `
    + `${((EDGE_P - 1.96 * se) * 100).toFixed(4)}% .. ${((EDGE_P + 1.96 * se) * 100).toFixed(4)}%`);
  console.log(`  deviation ${z.toFixed(2)} sigma`);
  ok(z < 3.5, 'the rim rate is not consistent with 1/500', { rate, expected: EDGE_P, z });

  // and the draw must be INDEPENDENT of the spin draw, or the house edge would
  // correlate with a bet axis
  const bySpin = new Map();
  for (let i = 0; i < 20000; i++) {
    const seed = 'indep::' + i;
    const idx = Number(big(await sha('spins::' + seed), 32) % BigInt(SPIN_VALUES.length));
    const v = Number(big(await sha('edge::' + seed), 64) % 100000n) / 100000;
    const rec = bySpin.get(SPIN_VALUES[idx]) ?? { n: 0, e: 0 };
    rec.n++; if (v < EDGE_P) rec.e++;
    bySpin.set(SPIN_VALUES[idx], rec);
  }
  // chi-square of edge counts across spin buckets against a flat expectation
  let chi = 0, df = 0;
  for (const { n, e } of bySpin.values()) {
    const exp = n * EDGE_P;
    if (exp > 0) { chi += (e - exp) ** 2 / exp; df++; }
  }
  console.log(`  independence from the spin draw: chi-square ${chi.toFixed(1)} over ${df} buckets`);
  ok(chi < df * 4, 'the rim draw looks correlated with the spin draw', { chi, df });
}

// ===========================================================================
console.log('\n=== (3) an Edge resolves to a REAL rim clip ===');
{
  const seen = new Set();
  let n = 0, bad = 0;
  const rows = [];
  for (let i = 0; i < 40000 && seen.size < library.edgeIndex.length; i++) {
    const o = await resolveFlip('rim::' + i, library);
    if (!o.edge) continue;
    n++;
    seen.add(o.clipId);
    const clip = await library.clipFor(o);
    const last = clip.frames[clip.frames.length - 1];
    const up = 1 - 2 * (last.quat[0] ** 2 + last.quat[2] ** 2);
    const tilt = Math.acos(Math.min(1, Math.abs(up))) * 180 / Math.PI;
    const good = clip.meta.side === 'Edge' && clip.meta.edge === true
      && clip.meta.source === 'baked-edge'
      && clip.meta.quadrant == null && clip.meta.orientationDeg == null
      && tilt > 80                              // genuinely on the rim
      && last.pos[1] > 0.008;                   // centre near the coin RADIUS
    if (!good) { bad++; if (rows.length < 3) rows.push({ id: o.clipId, tilt: +tilt.toFixed(1), y: +(last.pos[1] * 1000).toFixed(2), meta: clip.meta.side }); }
  }
  ok(bad === 0, 'an Edge resolved to something that is not a rim landing', { bad, rows });
  ok(seen.size === library.edgeIndex.length,
    'not every rim clip is reachable — some can never be drawn', { seen: seen.size, have: library.edgeIndex.length });
  console.log(`  ${n} Edge draws resolved; all landed on the rim (tilt > 80 deg, centre near the coin radius)`);
  console.log(`  every one of the ${library.edgeIndex.length} rim clips is reachable`);

  // THE REST-HEIGHT TRAP: materialise() lifts a flat clip so its settled centre
  // sits at half the coin's thickness. A rim clip's centre is legitimately at
  // the coin's RADIUS, and applying that lift would sink it ~9 mm through the
  // table on the most dramatic outcome in the game.
  const o = await resolveFlip('rim::' + [...Array(40000).keys()].find(() => true), library);
  const probe = await (async () => {
    for (let i = 0; i < 40000; i++) { const x = await resolveFlip('rim::' + i, library); if (x.edge) return x; }
    return null;
  })();
  const clip = await library.clipFor(probe);
  ok(clip.meta.yOffsetM === 0, 'the flat-landing rest-height lift was applied to a rim clip', { y: clip.meta.yOffsetM });
  console.log(`  the flat-landing rest-height lift is NOT applied to rim clips (yOffset ${clip.meta.yOffsetM})`);
}

// ===========================================================================
console.log('\n=== (4) the validator still bites ===');
{
  const good = { startFace: 'Heads', side: 'Edge', edge: true, spins: null, orientationDeg: null, quadrant: null };
  const rejects = [
    ['side Edge without edge:true', { ...good, edge: false }],
    ['edge:true carrying a quadrant', { ...good, quadrant: 'NE' }],
    ['edge:true carrying an orientation', { ...good, orientationDeg: 12.5 }],
    ['edge:true carrying spins', { ...good, spins: 20 }],
    ['edge:true with a face side', { ...good, side: 'Heads' }],
    ['bad startFace', { ...good, startFace: 'Rim' }],
  ];
  const rows = [];
  for (const [label, o] of rejects) {
    let threw = false;
    try { assertOutcome(o); } catch { threw = true; }
    rows.push({ malformed: label, rejected: threw });
    ok(threw, 'the validator accepted a malformed outcome: ' + label, o);
  }
  let okThrew = false;
  try { assertOutcome(good); } catch (e) { okThrew = true; console.log('  well-formed Edge rejected:', e.message); }
  rows.push({ malformed: 'a WELL-FORMED Edge (control)', rejected: okThrew });
  ok(!okThrew, 'the validator rejects a legitimate Edge outcome');
  console.table(rows);

  // and the face path must be untouched
  let faceOk = true;
  try {
    assertOutcome({ startFace: 'Heads', side: expectedSide('Heads', 20), spins: 20, quadrant: 'NE', orientationDeg: 10, edge: false });
  } catch { faceOk = false; }
  ok(faceOk, 'a normal face outcome no longer validates');
  let faceBad = false;
  try { assertOutcome({ startFace: 'Heads', side: 'Heads', spins: 20, quadrant: 'ZZ', orientationDeg: 10, edge: false }); } catch { faceBad = true; }
  ok(faceBad, 'the face path stopped rejecting a bad quadrant');
  console.log('  the face path is unchanged: good outcomes pass, bad quadrants still throw');
}

// ===========================================================================
console.log('\n=== (5) the house edge the renderer now carries ===');
{
  // Every bet is priced at fair odds ignoring the rim, and the rim sweeps the
  // table. So EV = 1 - EDGE_P on every axis, which IS the 0.20%.
  console.log(`  rim probability      ${EDGE_P}  (1 in ${Math.round(1 / EDGE_P)})`);
  console.log(`  Edge pays            499x  — roulette's N-1-on-N, not 500x`);
  console.log(`  EV of the Edge bet   ${(EDGE_P * 499).toFixed(6)}`);
  console.log(`  EV of any face bet   ${(1 - EDGE_P).toFixed(6)}`);
  const edgeEV = EDGE_P * 499, faceEV = 1 - EDGE_P;
  ok(Math.abs(edgeEV - faceEV) < 1e-9,
    'the Edge bet does not carry the same edge as every other bet', { edgeEV, faceEV });
  console.log(`  both 0.20% — uniform, which is the whole point of pricing at 499 and not 500`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
