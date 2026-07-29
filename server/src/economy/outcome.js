// outcome.js — the flip itself.
//
// Every axis is "domain-separated sha256 of the seed, reduced mod N". Nothing
// else. That is what makes the posted odds hold exactly, makes the result
// reproducible by anyone holding the revealed salt, and makes it impossible for
// player identity to steer a cell (identity only ever enters the seed material,
// where SHA-256 avalanches it away — see identity.js and ../../test.js).
//
// startFace is NOT derived from the seed. It is drawn at round open, published
// immediately (the player must see the coin's starting face before betting) and
// pinned in the round row. Landing side = startFace flipped once per half-flip,
// i.e. parity. Keeping it out of the seed is what keeps side and spin honest:
// the player learns the face before choosing, and parity is still 16/16.

import { sha256Hex, hexMod } from '../lib/crypto.js';
import {
  SPIN_HALF_VALUES,
  SPIN_N,
  QUADRANTS,
  ORIENTATION_PRECISION,
  EDGE_DENOM,
  toRotations,
} from './constants.js';

export const SEED_ALGORITHM =
  "seed = sha256('flip::' + identityHex + '::' + clockMs + '::' + flickHex + '::' + salt)";

export const OUTCOME_ALGORITHM = {
  spin: "SPIN_HALF_VALUES[ sha256('spins::'+seed)[0..16) mod 32 ]  (half-flips 8..40 except 24)",
  side: 'startFace flipped once per half-flip (parity of the half-flip count)',
  orientation: "sha256('orient::'+seed)[0..16) mod 36000 / 100  (degrees, 2dp)",
  quadrant: 'N/E/S/W = floor(orientationDeg / 90)',
  edge: "sha256('edge::'+seed)[0..16) mod 500 === 0   (1 in 500, sweeps everything)",
};

// Resolve a flip from a seed and the round's published start face.
export async function resolveFlip(seedHex, startFace) {
  const spinHash = await sha256Hex(`spins::${seedHex}`);
  const orientHash = await sha256Hex(`orient::${seedHex}`);
  const edgeHash = await sha256Hex(`edge::${seedHex}`);

  const halfFlips = SPIN_HALF_VALUES[hexMod(spinHash, SPIN_N)];
  const startHeads = startFace === 'Heads';
  // one face swap per half-flip: even -> same as start, odd -> opposite
  const landsHeads = halfFlips % 2 === 0 ? startHeads : !startHeads;

  const orientationDeg = hexMod(orientHash, 360 * ORIENTATION_PRECISION) / ORIENTATION_PRECISION;
  const quadrant = QUADRANTS[Math.floor(orientationDeg / 90)];

  const edge = hexMod(edgeHash, EDGE_DENOM) === 0;

  return {
    startFace,
    side: landsHeads ? 'Heads' : 'Tails',
    halfFlips,
    rotations: toRotations(halfFlips),
    orientationDeg,
    quadrant,
    edge,
  };
}
