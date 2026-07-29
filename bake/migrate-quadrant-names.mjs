// bake/migrate-quadrant-names.mjs
// ---------------------------------------------------------------------------
// ONE-SHOT DATA MIGRATION: N/E/S/W -> NE/SE/SW/NW across the baked library.
//
// The bake builds a clip id as `${halfFlips}${quadrant}-${slot}-${attempt}`
// (bake.js#attempt), so renaming the buckets renames the ids too. This is not a
// cosmetic transformation of the data — it makes the existing library identical
// to what a fresh bake now emits, which is the only state worth being in.
//
// WHAT MUST MOVE TOGETHER, and why this is a script rather than a sed:
//   clips/*.json      filename AND meta.quadrant
//   diag/*.json       filename AND the id inside
//   library.json      index[].id, index[].quadrant, cells[].cell, cells[].quadrant
//   beats.json        KEYED BY CLIP ID  <- regenerated, see below
//   out-min/          ids live inside the binary  <- regenerated, see below
//
// beats.json and out-min are deliberately NOT patched here. They are derived,
// and a beats sidecar keyed by stale ids fails SILENTLY — the player shrugs and
// falls back to counting frames, which is correct on full-rate clips, so every
// test stays green while the feature quietly stops existing. Regenerating them
// from their own generators is the only way to be sure they agree.
//
// Idempotent: a clip already carrying a two-letter quadrant is left alone, so
// re-running cannot produce `8NENE-10-0`.
// ---------------------------------------------------------------------------
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'bake/out');

/** The rename. Order matters nowhere here — these are pure label swaps. */
const MAP = { N: 'NE', E: 'SE', S: 'SW', W: 'NW' };
const NEW = new Set(Object.values(MAP));

/** `8N-10-0` -> `8NE-10-0`. Returns the id unchanged if already migrated. */
function migrateId(id) {
  const m = /^(\d+)([A-Z]+)-(.*)$/.exec(id);
  if (!m) return id;                       // EDGE-00 and friends: not cell ids
  const [, hf, q, rest] = m;
  if (NEW.has(q)) return id;               // already two-letter
  const nq = MAP[q];
  if (!nq) return id;
  return `${hf}${nq}-${rest}`;
}
const migrateQuad = (q) => (q == null ? q : (NEW.has(q) ? q : (MAP[q] ?? q)));

let renamedFiles = 0; let rewrittenMeta = 0; let untouched = 0;

async function migrateClipDir(dir, metaKey) {
  const files = await fs.readdir(dir);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const oldId = f.slice(0, -5);
    const newId = migrateId(oldId);
    const p = path.join(dir, f);
    const doc = JSON.parse(await fs.readFile(p, 'utf8'));

    let changed = false;
    if (metaKey && doc[metaKey] && doc[metaKey].quadrant !== undefined) {
      const nq = migrateQuad(doc[metaKey].quadrant);
      if (nq !== doc[metaKey].quadrant) { doc[metaKey].quadrant = nq; changed = true; }
    }
    if (doc.id !== undefined) {
      const ni = migrateId(doc.id);
      if (ni !== doc.id) { doc.id = ni; changed = true; }
    }
    if (changed) rewrittenMeta++;

    if (newId !== oldId) {
      await fs.writeFile(path.join(dir, `${newId}.json`), JSON.stringify(doc));
      await fs.unlink(p);
      renamedFiles++;
    } else if (changed) {
      await fs.writeFile(p, JSON.stringify(doc));
    } else {
      untouched++;
    }
  }
}

console.log('migrating clips/ ...');
await migrateClipDir(path.join(OUT, 'clips'), 'meta');
console.log('migrating diag/ ...');
await migrateClipDir(path.join(OUT, 'diag'), null);

console.log('migrating library.json ...');
{
  const p = path.join(OUT, 'library.json');
  const lib = JSON.parse(await fs.readFile(p, 'utf8'));
  for (const e of lib.index) { e.id = migrateId(e.id); e.quadrant = migrateQuad(e.quadrant); }
  for (const c of lib.cells ?? []) {
    c.quadrant = migrateQuad(c.quadrant);
    // cellKey(halfFlips, quadrant) — rebuild rather than string-patch, so it
    // cannot drift from the function that generates it.
    c.cell = `${c.halfFlips}${c.quadrant}`;
  }
  await fs.writeFile(p, JSON.stringify(lib, null, 2));
}

console.log('');
console.log(`  files renamed      ${renamedFiles}`);
console.log(`  documents rewritten ${rewrittenMeta}`);
console.log(`  already migrated   ${untouched}`);
console.log('');
console.log('NOT done here, regenerate them next or they will disagree:');
console.log('  node bake/encode.js          -> bake/out-min/ (ids are inside the binary)');
console.log('  node tools/add-beat-tags.mjs -> bake/out/beats.json (keyed by clip id)');
