// flip3d/outcome.js
// ---------------------------------------------------------------------------
// The outcome decider — modelled on coinflip-preview.html so the 3D page can
// run standalone.  coinflip-preview.html is NOT touched.
//
// THIS is what decides the flip.  The renderer is a slave to whatever comes out
// of here: it never nudges, re-rolls, or "physics-es" its way to a result.
// Web Crypto only, so the same module runs in the browser and in Node 18+.
//
// WHY THE LIBRARY IS AN INPUT HERE AND NOT IN THE PLAYER
// -----------------------------------------------------
// The bet axes (side, spin, quadrant) are drawn free and uniform.  Orientation
// is different: §6.5 says the displayed hundredths ARE the truth, and the only
// place a true settled yaw can come from is a real simulated landing.  So the
// draw is: cell (spin x quadrant) uniform -> variant uniform within the cell ->
// and the chosen clip's measured settle yaw IS the decided orientationDeg.
// The renderer is then handed a fully-resolved outcome it can match EXACTLY,
// instead of a continuous angle no baked clip could ever hit.
//
// Uniformity is unaffected and is easier to see than before:
//   startFace  1/2 each, independent
//   spins      1/32 each over 8..40 minus 24
//   side       parity(startFace, spins) -> exactly 1/2, independent of spins
//   quadrant   1/4 each, drawn directly rather than bucketed from an angle
// selectVariant() from identity.js plugs in at the VARIANT step and nowhere
// else: it picks a gentle-vs-violent telling of an outcome already decided.
// ---------------------------------------------------------------------------

import { SPIN_VALUES, QUADRANTS, quadrantFromOrientation } from './contract.js';

/** The default spin band: all 32 values. See `opts.band` on resolveFlip. */
export const FULL_SPIN_BAND = SPIN_VALUES;
// Library-free fallback only. Orientation resolves to two decimals (§6.5),
// uniform over [0,360). 36000 cells divide exactly by 4, so each quadrant
// bucket stays exactly 25%.
const ORIENT_CELLS = 36000n;

export async function sha(str) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const big = (hex, bits = 32) => BigInt('0x' + hex.slice(0, bits / 4));

/**
 * seed (any string) -> the decided outcome.
 * { startFace, side, spins (half-flips), orientationDeg, quadrant, edge, clipId }
 * The renderer consumes this and animates to it. It never edits it.
 *
 * @param {string} seed
 * @param {object} [library] loaded clip library; without it the orientation is
 *        a free 2-dp draw and only the procedural fallback can hit it.
 * @param {object} [opts]
 * @param {number[]} [opts.band] THE SPIN BAND. Defaults to the full 32-value
 *        ladder, which is the ONLY value anything passes today.
 *
 *        This parameter exists so that "a limp toss cannot produce 20 rotations"
 *        can be switched on later without reopening this function. It is the
 *        receiving end of flip3d/power.js#outcomeBand(); see THE SEAM there.
 *
 *        PROBABILITIES ARE UNCHANGED BY ITS EXISTENCE. With the default the
 *        modulo is `% 32` over SPIN_VALUES exactly as before — same hash, same
 *        divisor, same index, same outcome for every seed. tools/verify-power
 *        asserts old-call === new-call === explicit-full-band over 20k seeds.
 *
 *        Narrowing it DOES change the posted odds on the spin axis, which is
 *        why nothing narrows it yet.
 */
export async function resolveFlip(seed, library = null, opts = {}) {
  const band = opts.band ?? SPIN_VALUES;
  if (!Array.isArray(band) || band.length === 0) throw new Error('bad spin band');

  const startHeads = (big(await sha('start::' + seed), 8) % 2n) === 0n;
  const idx = Number(big(await sha('spins::' + seed), 32) % BigInt(band.length));
  const spins = band[idx];
  const landsHeads = spins % 2 === 0 ? startHeads : !startHeads;

  const base = {
    startFace: startHeads ? 'Heads' : 'Tails',
    side: landsHeads ? 'Heads' : 'Tails',
    spins,
    // "The Edge" (§6.6) is not baked and must never be faked: no edge clip
    // exists, so the renderer would have to invent the landing.
    edge: false,
  };

  if (library) {
    const quadrant = QUADRANTS[Number(big(await sha('quad::' + seed), 32) % 4n)];
    const pool = library.pool({ ...base, quadrant, orientationDeg: null });
    const v = Number(big(await sha('variant::' + seed), 32) % BigInt(pool.length));
    const entry = pool[v];
    return {
      ...base,
      quadrant,
      orientationDeg: entry.orientationDeg,  // a measured landing, not a guess
      clipId: entry.id,
      energy: entry.energy,
    };
  }

  // settle yaw, not table position: which way the design points at rest
  const cell = big(await sha('orient::' + seed), 32) % ORIENT_CELLS;
  const orientationDeg = Number(cell) / 100;
  return { ...base, orientationDeg, quadrant: quadrantFromOrientation(orientationDeg) };
}

/** The start face shown before the flip, for a given day (matches the preview). */
export async function previewStartFace(day) {
  const h = await sha('start::preview::day' + day);
  return (big(h, 8) % 2n === 0n) ? 'Heads' : 'Tails';
}
