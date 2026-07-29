// tools/verify-quadrant-naming.mjs
// ---------------------------------------------------------------------------
// ONE quadrant naming convention, everywhere: NE / SE / SW / NW.
//
// A bucket spans BETWEEN two cardinals. ORIENTATION is measured clockwise from
// north, so [0,90) runs FROM north TO east and is the north-east sector. It was
// called 'N' in the renderer and the bake, and 'NE' in coinflip-preview.html —
// the gameplay source of truth — for long enough to become a recorded debt.
//
// N / E / S / W are now RESERVED for exact 90-degree multiples, which carry two
// decimals and so occur on 1 of 9000 values per bucket edge.
//
// WHY THIS FILE EXISTS. The rename itself was mechanical. What is NOT mechanical
// is proving it reached every copy of the data — the name lived in clip
// FILENAMES, in clip ids, in library.json, inside a binary pack, and in a beats
// sidecar KEYED BY CLIP ID. A half-done migration does not throw: the beats
// sidecar simply stops matching, the player shrugs and falls back to counting
// frames, and every other suite stays green while a bet axis quietly loses its
// guarantee. So this checks the copies against each other, not just the code.
//
// Run: node tools/verify-quadrant-naming.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUADRANTS, CARDINALS, QUAD_RANGES, quadrantFromOrientation, exactCardinal,
  roundOrientation,
} from '../flip3d/contract.js';
import { readPack, decodeClip, QUADRANTS as PACK_QUADRANTS } from '../bake/decode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m, x) => { failures++; console.log('  FAIL', m, x ? JSON.stringify(x) : ''); };
const ok = (c, m, x) => { if (!c) fail(m, x); return c; };

const NEW = new Set(QUADRANTS);
const OLD = new Set(CARDINALS);

// ===========================================================================
console.log('=== (1) the contract says what it should ===');
{
  ok(QUADRANTS.length === 4, 'there are not four buckets', { QUADRANTS });
  ok(QUADRANTS.every((q) => q.length === 2), 'a bucket has a single-letter name', { QUADRANTS });
  ok(JSON.stringify(QUADRANTS) === JSON.stringify(['NE', 'SE', 'SW', 'NW']),
    'bucket order changed — the packed library stores quadrant as an INDEX into this array',
    { QUADRANTS });
  ok(JSON.stringify(PACK_QUADRANTS) === JSON.stringify(QUADRANTS),
    'bake/decode.js disagrees with contract.js — the pack would decode wrong names',
    { PACK_QUADRANTS, QUADRANTS });
  for (const q of QUADRANTS) {
    const [lo, hi] = QUAD_RANGES[q];
    ok(hi - lo === 90, `bucket ${q} is not 90 degrees wide`, { q, lo, hi });
  }
  console.log(`  ${JSON.stringify(QUADRANTS)}, each 90 deg, and decode.js agrees`);
}

// ===========================================================================
console.log('\n=== (2) bucketing is total, and never returns a reserved cardinal ===');
{
  let bad = 0; let cardinalLeak = 0;
  for (let i = 0; i < 36000; i++) {
    const q = quadrantFromOrientation(i / 100);
    if (!NEW.has(q)) bad++;
    if (OLD.has(q)) cardinalLeak++;
  }
  ok(bad === 0, 'some orientation buckets to something that is not one of the four', { bad });
  ok(cardinalLeak === 0, 'the bucket function returned a RESERVED cardinal name', { cardinalLeak });
  console.log('  all 36000 possible orientations bucket to one of the four two-letter names');

  // the boundaries specifically: an exact cardinal opens the bucket above it
  const edges = [[0, 'NE'], [90, 'SE'], [180, 'SW'], [270, 'NW'], [359.99, 'NW']];
  for (const [deg, want] of edges) {
    ok(quadrantFromOrientation(deg) === want,
      `exact ${deg} does not bucket as ${want}`, { deg, got: quadrantFromOrientation(deg) });
  }
  console.log('  exact 0/90/180/270 bucket as NE/SE/SW/NW — the sector each one OPENS');
  console.log('  (a bucket function that returned a fifth value on the rarest input would');
  console.log('   break the four-sector dial, the four-cell library and the 4/k price at once)');
}

// ===========================================================================
console.log('\n=== (3) the reserved cardinals have a home, and it is separate ===');
{
  for (const [deg, want] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    ok(exactCardinal(deg) === want, `exactCardinal(${deg}) is wrong`, { got: exactCardinal(deg) });
  }
  let nonNull = 0;
  for (let i = 0; i < 36000; i++) if (exactCardinal(i / 100) !== null) nonNull++;
  ok(nonNull === 4, 'exactCardinal fires on something other than the four exact multiples', { nonNull });
  console.log(`  exactCardinal() returns non-null on exactly ${nonNull} of 36000 orientations`);
  console.log('  so a cardinal name now MEANS something: it cannot be produced by rounding');
}

// ===========================================================================
console.log('\n=== (4) the two builds now agree, with no translation in between ===');
{
  // coinflip-preview.html has always used the two-letter names; the renderer
  // did not. verify-draw-parity.mjs used to normalise between them with a
  // lookup. If that map is still there, this rename did not really land.
  const parity = await fs.readFile(path.join(ROOT, 'tools/verify-draw-parity.mjs'), 'utf8');
  ok(!/NE:\s*'N'|SE:\s*'E'|SW:\s*'S'|NW:\s*'W'/.test(parity),
    'verify-draw-parity.mjs still translates between the two conventions');

  const html = await fs.readFile(path.join(ROOT, 'coinflip-preview.html'), 'utf8');
  const m = /const QUADS\s*=\s*\[([^\]]+)\]/.exec(html);
  ok(!!m, 'could not find the preview QUADS array');
  if (m) {
    const previewQuads = m[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
    // The preview buckets with floor(deg/90), same as the contract, so the
    // arrays must match ELEMENT FOR ELEMENT — not merely as sets.
    ok(JSON.stringify(previewQuads) === JSON.stringify(QUADRANTS),
      'the preview and the contract disagree on bucket names or their order',
      { previewQuads, QUADRANTS });
    console.log(`  coinflip-preview.html: ${JSON.stringify(previewQuads)}`);
    console.log(`  flip3d/contract.js:    ${JSON.stringify(QUADRANTS)}`);
  }
  console.log('  and the normalisation map in verify-draw-parity.mjs is gone');
}

// ===========================================================================
console.log('\n=== (5) no reserved cardinal survives as a quadrant VALUE in the data ===');
{
  // Structural, not textual. 'N' appears in a hundred innocent strings, so this
  // reads the fields that ARE quadrants rather than grepping for a letter.
  const lib = JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out/library.json'), 'utf8'));
  const idxBad = lib.index.filter((e) => !NEW.has(e.quadrant));
  ok(idxBad.length === 0, 'library index carries a non-migrated quadrant',
    { n: idxBad.length, sample: idxBad.slice(0, 3) });

  const cellBad = (lib.cells ?? []).filter((c) => !NEW.has(c.quadrant)
    || c.cell !== `${c.halfFlips}${c.quadrant}`);
  ok(cellBad.length === 0, 'a cell key disagrees with its own halfFlips+quadrant',
    { n: cellBad.length, sample: cellBad.slice(0, 3) });

  // Ids embed a bucket, because bake.js builds them as
  // `${halfFlips}${quadrant}-${slot}-${attempt}` — but it is the bucket the
  // bake AIMED AT, not the one the clip landed in. When a shot misses its
  // target cell yet still produces a valid clip, bake.js banks it in whichever
  // cell it actually hit and keeps the original tag ("banked-elsewhere").
  // Measured: 71 of 1024 ids name a different cell from their own metadata,
  // both before and after this migration, on the same 71 clips.
  //
  // So an id is PROVENANCE, not a label. Nothing may read a bucket out of it —
  // and the only thing this check can honestly assert is that the id's bucket
  // was migrated too, whichever cell it refers to.
  const idQuad = /^\d+([A-Z]+)-/;
  const idBad = lib.index.filter((e) => {
    const m = idQuad.exec(e.id);
    return !m || !NEW.has(m[1]);
  });
  ok(idBad.length === 0, 'a clip id still carries an un-migrated bucket name',
    { n: idBad.length, sample: idBad.slice(0, 3).map((e) => e.id) });
  const aimedElsewhere = lib.index.filter((e) => !new RegExp(`^${e.halfFlips}${e.quadrant}-`).test(e.id));
  console.log(`  ${aimedElsewhere.length}/${lib.index.length} ids name a cell the clip did not land in`);
  console.log('  — that is bake.js banking a missed shot where it actually hit, not a rename bug');
  console.log(`  ${lib.index.length} index entries, ${(lib.cells ?? []).length} cells: names, cell keys and ids all consistent`);
}

// ===========================================================================
console.log('\n=== (6) THE UNIFORMITY THAT MAKES THE ORIENTATION BET FAIR ===');
{
  const lib = JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out/library.json'), 'utf8'));
  const counts = {};
  for (const e of lib.index) counts[e.quadrant] = (counts[e.quadrant] || 0) + 1;
  console.table([counts]);
  const vals = QUADRANTS.map((q) => counts[q] ?? 0);
  ok(vals.every((v) => v === vals[0]), 'the four buckets are no longer equal', { counts });
  ok(vals[0] === 256, 'buckets are equal but not 256 — clips were lost or duplicated', { counts });
  console.log('  256 clips per bucket, exactly. A rename that dropped or merged a bucket');
  console.log('  would skew the orientation bet without breaking anything else.');
}

// ===========================================================================
console.log('\n=== (7) every copy of the data agrees with every other ===');
{
  const lib = JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out/library.json'), 'utf8'));
  const packIdx = JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out-min/index.json'), 'utf8'));
  const beatsDoc = JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out/beats.json'), 'utf8'));
  const beats = beatsDoc.beats;
  const pack = readPack(await fs.readFile(path.join(ROOT, 'bake/out-min/clips.cfc')));

  ok(packIdx.index.length === lib.index.length, 'packed index has a different clip count',
    { packed: packIdx.index.length, raw: lib.index.length });

  let mismatch = 0; let beatsMissing = 0; let derivedBad = 0; let clipMetaBad = 0;
  const sample = [];
  for (const e of lib.index) {
    // the quadrant must be what the ANGLE says it is — the rename must not have
    // moved a clip into a bucket its own orientation does not belong to
    const derived = quadrantFromOrientation(e.orientationDeg);
    if (derived !== e.quadrant) { derivedBad++; if (sample.length < 3) sample.push({ id: e.id, e: e.quadrant, derived }); }

    const p = packIdx.index.find((x) => x.id === e.id);
    if (!p || p.quadrant !== e.quadrant) mismatch++;

    // BEATS ARE KEYED BY ID. A stale key here fails silently in the player.
    if (!Array.isArray(beats[e.id])) beatsMissing++;

    const rec = pack.clips.get(e.id);
    if (!rec || rec.meta.quadrant !== e.quadrant) clipMetaBad++;
  }
  ok(derivedBad === 0, 'a clip sits in a bucket its own orientation contradicts',
    { derivedBad, sample });
  ok(mismatch === 0, 'packed index disagrees with library.json on a quadrant', { mismatch });
  ok(beatsMissing === 0,
    'beats.json is keyed by ids that no longer exist — the spin counter would SILENTLY '
    + 'fall back to counting frames', { beatsMissing });
  ok(clipMetaBad === 0, 'the binary pack decodes a quadrant that disagrees with the index', { clipMetaBad });

  ok(Object.keys(beats).length === lib.index.length,
    'beats has a different number of clips than the library',
    { beats: Object.keys(beats).length, lib: lib.index.length });

  console.log(`  ${lib.index.length} clips: library.json, out-min/index.json, clips.cfc and`);
  console.log('  beats.json all name the same bucket, and every bucket matches its own angle');
}

// ===========================================================================
console.log('\n=== (8) the quadrant survives a round trip through the binary ===');
{
  const pack = readPack(await fs.readFile(path.join(ROOT, 'bake/out-min/clips.cfc')));
  const lib = JSON.parse(await fs.readFile(path.join(ROOT, 'bake/out/library.json'), 'utf8'));
  let bad = 0;
  const rows = [];
  for (const e of lib.index.slice(0, 400)) {
    const clip = decodeClip(pack.clips.get(e.id));
    if (clip.meta.quadrant !== e.quadrant) bad++;
    if (rows.length < 4) rows.push({ id: e.id, quadrant: clip.meta.quadrant, orientationDeg: clip.meta.orientationDeg });
  }
  console.table(rows);
  ok(bad === 0, 'a decoded clip carries the wrong quadrant', { bad });
  console.log('  400 clips decoded from the pack: quadrant intact');
  console.log('  (the pack stores an INDEX, so a rename is free there — but a REORDER');
  console.log('   would silently relabel every clip, which is why section (1) pins the order)');
}

// ===========================================================================
console.log('\n=== (9) the source tree has no bare cardinal used as a quadrant ===');
{
  // Deliberately narrow: match the SHAPES a quadrant literal takes, not the
  // letter. Grepping for 'N' would drown in false positives and teach everyone
  // to ignore this check.
  const files = [];
  async function walk(dir) {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name === '.git' || d.name === '.wrangler') continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (/\.(js|mjs|html)$/.test(d.name)) files.push(p);
    }
  }
  await walk(ROOT);

  const patterns = [
    /quadrant\s*[:=]\s*['"][NESW]['"]/g,           // quadrant: 'N'
    /\[\s*['"]N['"]\s*,\s*['"]E['"]\s*,\s*['"]S['"]\s*,\s*['"]W['"]\s*\]/g,  // ['N','E','S','W']
    /orientation:\s*\[\s*['"][NESW]['"]/g,          // orientation: ['N'
  ];
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    // contract.js legitimately defines CARDINALS; the migration script
    // legitimately maps FROM the old names.
    if (rel === 'flip3d/contract.js' || rel === 'bake/migrate-quadrant-names.mjs') continue;
    if (rel === 'tools/verify-quadrant-naming.mjs') continue;
    if (rel.endsWith('.bak.html')) continue;
    const src = await fs.readFile(f, 'utf8');
    for (const re of patterns) {
      for (const m of src.matchAll(re)) hits.push({ file: rel, text: m[0].slice(0, 50) });
    }
  }
  if (hits.length) console.table(hits.slice(0, 12));
  ok(hits.length === 0, 'a bare cardinal is still being used as a quadrant value',
    { n: hits.length });
  console.log(`  scanned ${files.length} source files for quadrant-SHAPED literals: ${hits.length} found`);
  if (hits.length) {
    console.log('');
    console.log('  These are NOT cosmetic. contract.js#assertOutcome rejects an unknown');
    console.log('  quadrant outright, so each one throws "bad quadrant: N" the moment its');
    console.log('  code path runs. Each needs the two-letter name for its own angle:');
    console.log('    [0,90) -> NE   [90,180) -> SE   [180,270) -> SW   [270,360) -> NW');
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
