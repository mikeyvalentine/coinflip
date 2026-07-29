// flip3d/variant.js
// ---------------------------------------------------------------------------
// A LINE-FOR-LINE MIRROR of identity.js#selectVariant(), for the browser.
//
// identity.js is the authority and is NOT modified. It cannot be imported here
// because it does `import { createHash } from 'node:crypto'`, which no browser
// resolves. So the function is reproduced verbatim over the synchronous SHA-256
// in ./sha256.js, and tools/verify-power.mjs asserts the two agree on every one
// of the library's 128 cells across a power sweep — any drift fails the sweep.
//
// WHAT THIS IS ALLOWED TO DO, restated because it is the whole boundary:
// a CELL is (halfFlips, quadrant) and IS the outcome — side follows from
// halfFlips by parity, and quadrant is the orientation bet's bucket. The 8
// variants inside a cell are eight tellings of that same result. Picking among
// them changes how violent the flip looks and which measured settle yaw inside
// the already-won quadrant comes up. It cannot change side, rotation count or
// quadrant, and library.js#select() asserts that on every single throw rather
// than trusting this file.
//
// flickForce IS the power meter's 0..1 — that wiring is the point of the hook.
// ---------------------------------------------------------------------------

import { sha256hex } from './sha256.js';

const hexToBig = (hex, bits = 64) => BigInt('0x' + hex.slice(0, bits / 4));

/**
 * @param {Array<{energy?:number}>} variants pre-sorted by energy, gentle->violent
 * @param {{daringness?:number, flickForce?:number, seedHex:string}} opts
 * @returns {object|null} the chosen variant (an element of `variants`)
 */
export function selectVariant(variants, { daringness = 0.5, flickForce = 0.5, seedHex }) {
  if (!variants || variants.length === 0) return null;
  if (variants.length === 1) return variants[0];

  const target = Math.max(0, Math.min(1, 0.6 * daringness + 0.4 * flickForce));

  const energies = variants.map((v) => v.energy ?? 0.5);
  const band = 0.18;
  const candidates = variants.filter(
    (v, i) => Math.abs((energies[i]) - target) <= band,
  );
  const pool = candidates.length ? candidates : variants;

  const pick = Number(hexToBig(sha256hex('variant::' + seedHex), 32) % BigInt(pool.length));
  return pool[pick];
}

/**
 * The energy `selectVariant` is aiming at, exposed on its own so the UI can show
 * what a pull is asking for without re-running the pick. Pure restatement of the
 * first line of the function above.
 */
export function targetEnergy(daringness = 0.5, flickForce = 0.5) {
  return Math.max(0, Math.min(1, 0.6 * daringness + 0.4 * flickForce));
}
