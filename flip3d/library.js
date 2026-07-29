// flip3d/library.js
// ---------------------------------------------------------------------------
// THE BAKED CLIP LIBRARY.  bake/out/ is the Rapier harness's output and is
// read-only here — this module only fetches, indexes and re-frames it.
//
// 1024 clips = 128 cells x 8 variants.  A CELL is (halfFlips, quadrant); the
// 8 variants inside a cell are the same bet outcome played differently, ranked
// 0..1 by `energy` (gentle -> violent).  That is exactly the axis
// identity.js#selectVariant() is allowed to touch: it picks the FEEL of an
// outcome that has already been decided, never the outcome.
//
// THE MATCH IS EXACT.  select() looks up (halfFlips, quadrant) and then the
// clip whose orientationDeg IS the outcome's, to the hundredth that §6.5 calls
// the truth.  If no clip carries that angle the substitution is reported, never
// swallowed — see `exact` on the result.
//
// TWO RE-FRAMINGS ARE APPLIED, AND ONLY THESE TWO:
//   1. start face — every baked clip starts heads-up, so a tails-up start is
//      served by composing TAILS_START_QUAT on the body side. It inverts the
//      face at every instant and leaves position and orientation untouched.
//   2. rest height — the solver settles the centre at -0.24..+0.62 mm instead
//      of COIN_HALF_THICKNESS_M, so a constant (<= 1 mm) offset lifts the clip
//      to put the coin exactly on the table instead of half sunk into it.
// Neither can change the side, the rotation count or the settle yaw.
// ---------------------------------------------------------------------------

import {
  COIN_HALF_THICKNESS_M, SPIN_VALUES, QUADRANTS,
  assertOutcome, normDeg, expectedSide, flipStartFaceQuat,
} from './contract.js';

export const DEFAULT_LIBRARY_BASE = './bake/out/';
const degDelta = (a, b) => { const d = normDeg(a - b); return d > 180 ? d - 360 : d; };
export const cellKey = (halfFlips, quadrant) => `${halfFlips}${quadrant}`;

/** Orientation match tolerance: the hundredth IS the truth, so half of one. */
const ORIENT_EPS = 0.005;

/**
 * Fetch and unpack the encoded library: `index.json` (same `index` array the
 * raw manifest carries, so pool/select/materialise are untouched) plus one
 * `clips.cfc` binary.
 *
 * `bake/decode.js` is deliberately import-free and browser-safe, and the
 * encoder imports the format FROM it, so writer and reader cannot drift.
 */
async function loadPack(base, doFetch, opts) {
  const packBase = opts.packBase ?? base + '../out-min/';
  const [ires, cres] = await Promise.all([
    doFetch(packBase + 'index.json'),
    doFetch(packBase + 'clips.cfc'),
  ]);
  if (!ires.ok) throw new Error(`packed index missing (${ires.status})`);
  if (!cres.ok) throw new Error(`clips.cfc missing (${cres.status})`);
  const manifest = await ires.json();
  // arrayBuffer() in the browser; the Node verifiers hand back a Buffer.
  const buf = cres.arrayBuffer ? await cres.arrayBuffer() : await cres.buffer();
  const { readPack, decodeClip } = await import('../bake/decode.js');
  const pack = readPack(buf);
  if (!pack || !pack.clips || !pack.clips.size) throw new Error('packed library decoded empty');
  return { manifest, pack, decodeClip };
}

export async function loadClipLibrary(opts = {}) {
  const base = opts.base ?? DEFAULT_LIBRARY_BASE;
  const doFetch = opts.fetch ?? ((u) => fetch(u));

  // ---------------------------------------------------------------------
  // THE PACKED LIBRARY IS THE DEFAULT. 20,259 kB of raw JSON across 1024
  // requests becomes 309 kB gzipped in ONE, because the airborne phase — 67.5%
  // of every frame in the library — is not sampled at all. A free rigid body
  // conserves energy and angular momentum, so |omega| cannot change until
  // something touches it: the whole flight is q0 + axis + rate + a parabola,
  // 14 floats, exact at any framerate. Only the settle is sampled, as adaptive
  // keys, because that is the part with impulses in it.
  //
  // DECIMATION WAS THE PLAN AND IT WAS BROKEN. The library's fastest clip turns
  // 245.6 rad/s; one 60fps step is 234.6 deg, past the 180 deg where a
  // quaternion slerp takes the short path and goes the WRONG WAY. Sampled at
  // 60fps, 281 of 1024 clips report a wrong half-flip count — a bet axis, on a
  // bet already paid. The analytic flight has no such cliff at all.
  //
  // Falls back to the raw per-clip JSON when the pack is absent, so a bake that
  // has not been encoded yet still runs.
  let packed = null;
  if (opts.packed !== false) {
    try {
      packed = await loadPack(base, doFetch, opts);
    } catch (err) {
      console.warn('[flip3d] packed library unavailable, falling back to raw clips:', err.message);
    }
  }

  const res = packed ? null : await doFetch(base + 'library.json');
  if (res && !res.ok) throw new Error(`clip library not found at ${base}library.json (${res.status})`);
  const manifest = packed ? packed.manifest : await res.json();
  const index = manifest.index;
  if (!Array.isArray(index) || !index.length) throw new Error('clip library manifest has no index');

  // --- index it ------------------------------------------------------------
  const byId = new Map();
  const cells = new Map();
  for (const e of index) {
    byId.set(e.id, e);
    const k = cellKey(e.halfFlips, e.quadrant);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(e);
  }
  for (const pool of cells.values()) pool.sort((a, b) => a.energy - b.energy);

  // --- integrity, checked against the shared contract not against itself ---
  const missing = [];
  for (const s of SPIN_VALUES) for (const q of QUADRANTS) {
    if (!cells.has(cellKey(s, q))) missing.push(cellKey(s, q));
  }
  const sizes = [...cells.values()].map((p) => p.length);
  const parityBad = index.filter((e) => expectedSide('Heads', e.halfFlips) !== e.side).length;
  const source = packed ? 'packed' : 'raw';
  const stats = {
    source,
    clips: index.length,
    cells: cells.size,
    cellsExpected: SPIN_VALUES.length * QUADRANTS.length,
    missingCells: missing,
    perCellMin: Math.min(...sizes),
    perCellMax: Math.max(...sizes),
    parityViolations: parityBad,
    durationMs: (() => {
      const d = index.map((e) => e.durationMs).sort((a, b) => a - b);
      return { min: d[0], median: d[d.length >> 1], max: d[d.length - 1] };
    })(),
    ok: missing.length === 0 && parityBad === 0 && Math.min(...sizes) > 0,
  };
  if (!stats.ok) console.warn('[flip3d] clip library is incomplete', stats);

  // --- fetch + cache -------------------------------------------------------
  const cache = new Map();
  const inflight = new Map();
  function raw(id) {
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    // The pack is resident, so this is a decode rather than a fetch — there is
    // nothing to be in flight and nothing to prefetch.
    if (packed) {
      const rec = packed.pack.clips.get(id);
      if (!rec) return Promise.reject(new Error(`clip ${id} not in the packed library`));
      const c = packed.decodeClip(rec);
      cache.set(id, c);
      return Promise.resolve(c);
    }
    if (inflight.has(id)) return inflight.get(id);
    const p = doFetch(`${base}clips/${id}.json`)
      .then((r) => { if (!r.ok) throw new Error(`clip ${id} missing (${r.status})`); return r.json(); })
      .then((c) => { cache.set(id, c); inflight.delete(id); return c; });
    inflight.set(id, p);
    return p;
  }

  /**
   * Every clip that can serve this outcome's (spin, quadrant) cell.
   * Side needs no filtering: parity already forces it, and assertOutcome has
   * rejected any outcome where side disagrees with startFace + spins.
   */
  function pool(outcome) {
    const p = cells.get(cellKey(outcome.spins, outcome.quadrant));
    if (!p) throw new Error(`no baked clips for ${outcome.spins} half-flips in quadrant ${outcome.quadrant}`);
    return p;
  }

  /**
   * Choose the clip for an already-decided outcome. Never decides anything the
   * outcome already fixes; the only free choice is WHICH variant, and only when
   * the outcome carries no orientation of its own.
   */
  function select(outcome, sel = {}) {
    assertOutcome(outcome);
    if (outcome.edge) {
      throw new Error('outcome asks for an edge landing; the bake contains no edge clips (design doc §6.6, not built)');
    }
    const p = pool(outcome);

    // --- POWER SEAM ------------------------------------------------------
    // A caller (player.js, holding the throw's power) may re-pick WHICH VARIANT
    // of this cell plays. It is checked into the cell, never trusted: the
    // override has to be a clip that was already in this outcome's own pool, so
    // the strongest possible pull cannot reach a different halfFlips or a
    // different quadrant. It takes priority over outcome.clipId, which is only
    // ever the uniform placeholder outcome.js picked at arm time before the
    // player had touched the coin.
    if (sel.variant) {
      const wantId = typeof sel.variant === 'string' ? sel.variant : sel.variant.id;
      const entry = byId.get(wantId);
      if (!entry) throw new Error(`variant override ${wantId} is not in the library`);
      if (entry.halfFlips !== outcome.spins || entry.quadrant !== outcome.quadrant) {
        throw new Error(
          `variant override ${wantId} is cell ${entry.halfFlips}${entry.quadrant}, ` +
          `outcome is ${outcome.spins}${outcome.quadrant} — power may not leave the drawn cell`,
        );
      }
      return { entry, exact: true, orientationErrorDeg: 0, pool: p, variantOverride: true };
    }

    if (outcome.clipId && byId.has(outcome.clipId)) {
      const entry = byId.get(outcome.clipId);
      if (entry.halfFlips !== outcome.spins || entry.quadrant !== outcome.quadrant) {
        throw new Error(`clipId ${outcome.clipId} does not match outcome ${outcome.spins}/${outcome.quadrant}`);
      }
      return { entry, exact: true, orientationErrorDeg: 0, pool: p };
    }

    if (outcome.orientationDeg != null) {
      let best = p[0], bestErr = Infinity;
      for (const e of p) {
        const err = Math.abs(degDelta(e.orientationDeg, outcome.orientationDeg));
        if (err < bestErr) { best = e; bestErr = err; }
      }
      return { entry: best, exact: bestErr <= ORIENT_EPS, orientationErrorDeg: +bestErr.toFixed(4), pool: p };
    }

    // No angle asked for: the variant is free. `energy` is the identity hook.
    const idx = sel.energy != null
      ? Math.min(p.length - 1, Math.max(0, Math.round(sel.energy * (p.length - 1))))
      : Math.floor((sel.rand ? sel.rand() : Math.random()) * p.length) % p.length;
    return { entry: p[idx], exact: true, orientationErrorDeg: 0, pool: p };
  }

  /**
   * Re-frame a raw baked clip for one outcome. Pure data in, pure data out —
   * no scene, no time. See the header for the only two things it may change.
   */
  function materialise(rawClip, entry, outcome) {
    const tails = outcome.startFace === 'Tails';
    const src = rawClip.frames;
    const last = src[src.length - 1];
    const yOffset = COIN_HALF_THICKNESS_M - last.pos[1];

    const frames = new Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const f = src[i];
      frames[i] = {
        t: f.t,
        pos: [f.pos[0], f.pos[1] + yOffset, f.pos[2]],
        quat: tails ? flipStartFaceQuat(f.quat) : f.quat.slice(),
      };
    }

    const side = tails ? (entry.side === 'Heads' ? 'Tails' : 'Heads') : entry.side;
    if (side !== outcome.side) {
      throw new Error(`clip ${entry.id} lands ${side} from a ${outcome.startFace} start, outcome says ${outcome.side}`);
    }
    return {
      meta: {
        halfFlips: entry.halfFlips,
        side,
        orientationDeg: entry.orientationDeg,
        quadrant: entry.quadrant,
        durationMs: entry.durationMs,
        settleAngleDeg: entry.orientationDeg,
        energy: entry.energy,
        startFace: outcome.startFace,
        id: entry.id,
        source: 'baked',
        yOffsetM: +yOffset.toFixed(6),
      },
      frames,
    };
  }

  /** outcome -> a clip the player can run, straight from the bake. */
  async function clipFor(outcome, sel = {}) {
    const chosen = select(outcome, sel);
    const clip = materialise(await raw(chosen.entry.id), chosen.entry, outcome);
    clip.meta.exactOrientation = chosen.exact;
    clip.meta.orientationErrorDeg = chosen.orientationErrorDeg;
    return clip;
  }

  /**
   * Warm the cache for an armed-but-unplayed flip so the release is instant.
   *
   * Power is not known until the player lets go, and it decides which of the
   * cell's variants plays, so ONE clip is the wrong thing to prefetch — pull
   * the whole cell. Eight clips at ~17 kB each is ~140 kB, well under the cost
   * of a stall at the moment of release.
   */
  function prefetch(outcome, sel = {}) {
    try {
      const chosen = select(outcome, sel);
      const ids = sel.wholeCell === false ? [chosen.entry.id] : chosen.pool.map((e) => e.id);
      return Promise.all(ids.map((id) => raw(id).then(() => true, () => false)))
        .then((r) => r.every(Boolean));
    } catch { return Promise.resolve(false); }
  }

  return {
    manifest, index, byId, cells, stats, base,
    pool, select, materialise, clipFor, prefetch, raw,
    get cached() { return cache.size; },
  };
}
