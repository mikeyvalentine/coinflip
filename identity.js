// identity.js
// ---------------------------------------------------------------------------
// The fusion layer:  daringness + fingerprint = identity
//                    identity  + clock + salt = rng seed
//
// The philosophy (stated by the designer):
//   "It doesn't change the randomness of the coin flip, but it has inherent
//    meaning in the code, whether anyone knows it or not."
//
// So identity plays TWO roles, and keeping them separate is the whole ethic:
//
//   1. PROVENANCE (invisible, uniform-safe): identity is folded into the flip
//      seed. Because the clock churns every flip and SHA-256 avalanches every
//      input bit, identity is NOT detectable in the outcome and does NOT bias
//      it. The coin stays perfectly uniform. What identity buys here is meaning:
//      the seed is authored by a real self (this person, this device) rather
//      than a bare timestamp. Provenance, not behavior.
//
//   2. SIGNATURE (visible, honest): the SAME identity value deterministically
//      seeds the player's *presentation* — coin character, camera personality,
//      palette — so the same self on the same device gets a recognizable flip
//      every day. This is where the meaning is allowed to SHOW, because a
//      constant producing a stable look is a feature, not a rig.
//
// Hard line: identity feeds seed PROVENANCE and PRESENTATION only. It must
// never select the outcome cell. The outcome cell is chosen by the flick
// (gesture entropy) + server salt, and stays uniform across the curated
// library. See selectOutcomeCell / selectVariant below for the enforced split.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { computeDaringness } from './daringness.js';
import { computeFingerprint, fingerprintToBigInt } from './fingerprint.js';

function sha256hex(str) {
  return createHash('sha256').update(str).digest('hex');
}
function hexToBig(hex, bits = 64) {
  return BigInt('0x' + hex.slice(0, bits / 4));
}

// --- identity assembly -----------------------------------------------------
//
// Returns a stable identity descriptor for a player. `daringness` is a 0..1
// float (slow-moving trait); `fingerprintHex` is the device hash. We keep both
// the raw parts and a fused hash so downstream code can use whichever it needs.

export function assembleIdentity({ daringness, fingerprintHex }) {
  // Quantize daringness into a stable bucket so tiny float drift doesn't churn
  // the visual signature every single day. 100 buckets = smooth but stable.
  const daringBucket = Math.round((daringness ?? 0.5) * 100);

  // Fuse: the visual/provenance identity hash. Deterministic for the same
  // (daringness-bucket, device) pair.
  const identityHex = sha256hex(`id::${daringBucket}::${fingerprintHex}`);

  return {
    daringness,            // raw 0..1 (for presentation intensity)
    daringBucket,          // stable bucket (for visual signature seeding)
    fingerprintHex,        // device hash
    identityHex,           // fused identity hash
    identityBig: hexToBig(identityHex), // numeric view for downstream math
  };
}

// Convenience: build identity straight from raw history + device signals.
export function buildIdentity({ history, previousDaringness, signals, serverSalt }) {
  const d = computeDaringness(history, previousDaringness);
  const fingerprintHex = computeFingerprint(signals, serverSalt);
  const identity = assembleIdentity({ daringness: d.value, fingerprintHex });
  return { ...identity, daringnessDetail: d };
}

// --- the RNG seed:  identity + clock + salt --------------------------------
//
// clockMs:   high-resolution timestamp captured at the flick (the entropy the
//            player physically authors). This DOMINATES the seed — it's what
//            keeps outcomes uniform — and identity rides alongside as provenance.
// flickHex:  optional extra gesture entropy (swipe velocity/position hash).
// serverSalt: pre-committed per-round salt (publish its hash at bet-lock,
//             reveal after settle) so the seed can be proven not to have been
//             chosen in response to the player's bets.

export function deriveFlipSeed({ identity, clockMs, flickHex = '', serverSalt }) {
  const material = [
    'flip',
    identity.identityHex,     // provenance: authored by this self+device
    String(clockMs),          // dominant entropy: the flick moment
    flickHex,                 // extra gesture entropy
    serverSalt,               // pre-committed fairness salt
  ].join('::');
  return sha256hex(material);
}

// --- OUTCOME selection (uniform, identity-free by contract) ----------------
//
// The seed picks an outcome CELL uniformly across the curated library's cells.
// `cellCount` is the number of (side x rotation) cells (e.g. 24). Because the
// library is curated uniform and this is a straight modulo of an avalanched
// hash, every cell is equally likely — the felt's posted odds hold exactly.
//
// NOTE: identity influenced the seed only as provenance; it cannot skew this
// modulo in any detectable direction. That's the fairness guarantee.

export function selectOutcomeCell(flipSeedHex, cellCount) {
  const n = hexToBig(flipSeedHex, 64);
  return Number(n % BigInt(cellCount));
}

// --- VARIANT selection (where signature is allowed to show) ----------------
//
// Within the winning cell there are ~N curated visual variants spanning
// gentle->violent (guaranteed by the farthest-point curation in the bake).
// Here identity and flick force MAY steer *which variant plays* — because this
// is style only and never changes the outcome (side + rotations are fixed by
// the cell). A daring player on a hard flick gets a more violent variant of
// the SAME result.
//
//   variants:    array of clip descriptors for the winning cell, pre-sorted by
//                an "energy" field 0..1 (gentle -> violent).
//   daringness:  0..1 trait — biases toward the violent end.
//   flickForce:  0..1 normalized gesture strength this flip — biases too.
//   seedHex:     the flip seed, for a deterministic tie-break within the band.

export function selectVariant(variants, { daringness = 0.5, flickForce = 0.5, seedHex }) {
  if (!variants || variants.length === 0) return null;
  if (variants.length === 1) return variants[0];

  // Target energy = blend of trait (slow) and this-flip force (immediate).
  // Trait sets the player's baseline drama; the flick nudges around it.
  const target = Math.max(0, Math.min(1, 0.6 * daringness + 0.4 * flickForce));

  // Pick from a small band around the target energy, with a seeded choice
  // inside the band so it's deterministic and still varied.
  const energies = variants.map((v) => v.energy ?? 0.5);
  const band = 0.18;
  const candidates = variants.filter(
    (v, i) => Math.abs((energies[i]) - target) <= band
  );
  const pool = candidates.length ? candidates : variants;

  const pick = Number(hexToBig(sha256hex('variant::' + seedHex), 32) % BigInt(pool.length));
  return pool[pick];
}

// --- VISUAL signature (stable per identity, purely presentational) ---------
//
// Deterministic style parameters derived from the fused identity. Same self +
// device -> same signature every day. Touches only the render.

export function visualSignature(identity) {
  const h = identity.identityHex;
  const slice = (start, len) => parseInt(h.slice(start, start + len), 16);

  return {
    // hue for ambient palette / trail (0..359)
    hue: slice(0, 4) % 360,
    // camera personality index (0..3): static / orbit / dolly / topdown feel
    cameraStyle: slice(4, 2) % 4,
    // launch arc character (0..1): lazy tumble vs snappy whip — how THEY flip
    launchCharacter: (slice(6, 4) % 1000) / 1000,
    // spin cadence seed
    spinCadence: (slice(10, 4) % 1000) / 1000,
    // intensity scalar pulled from daringness (the visible trait link)
    dramaScalar: identity.daringness ?? 0.5,
  };
}
