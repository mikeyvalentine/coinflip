// identity.js (server port) — WebCrypto reimplementation of the hashing in the
// project's ../identity.js and ../fingerprint.js, so the Worker needs no node:
// builtins. It is byte-for-byte identical by construction and that is asserted
// in test/unit/identity-parity.test.mjs — if the originals ever change, that
// test fails rather than the two silently drifting apart.
//
// THE CONTRACT (from identity.js, and it is not negotiable):
//   identity feeds seed PROVENANCE and PRESENTATION only. It must never select
//   the outcome cell. The outcome is chosen by the flick entropy + the
//   pre-committed server salt, and stays uniform.

import { sha256Hex } from '../lib/crypto.js';

// The stable signal keys, in fixed order — must match ../fingerprint.js exactly.
export const STABLE_SIGNAL_KEYS = [
  'userAgent',
  'platform',
  'languages',
  'timezone',
  'screenColorDepth',
  'devicePixelRatio',
  'hardwareConcurrency',
  'deviceMemory',
  'webglVendor',
  'webglRenderer',
  'canvasHash',
  'audioHash',
  'fontsHash',
];

export function canonicalizeSignals(signals = {}) {
  return STABLE_SIGNAL_KEYS.map((k) => {
    const v = signals[k];
    if (v == null) return `${k}:`;
    if (Array.isArray(v)) return `${k}:${v.join(',')}`;
    return `${k}:${String(v)}`;
  }).join('|');
}

// Device half of identity. Hashed server-side with a server-held salt so a
// client cannot forge another device's signature.
export async function computeFingerprint(signals, serverSalt) {
  return sha256Hex(`${serverSalt}::${canonicalizeSignals(signals)}`);
}

// daringness (quantised) + device = identity.
export async function assembleIdentity({ daringness, fingerprintHex }) {
  const daringBucket = Math.round((daringness ?? 0.5) * 100);
  const identityHex = await sha256Hex(`id::${daringBucket}::${fingerprintHex}`);
  return { daringness, daringBucket, fingerprintHex, identityHex };
}

// identity + clock + salt = the flip seed.
//   clockMs    : the flick moment, player-authored, dominant entropy
//   flickHex   : extra gesture entropy
//   serverSalt : the PRE-COMMITTED per-round salt. Its sha256 was published
//                before the player placed anything, and it is revealed after
//                settle, so the seed provably was not chosen in response to
//                the bets.
export async function deriveFlipSeed({ identityHex, clockMs, flickHex = '', serverSalt }) {
  return sha256Hex(['flip', identityHex, String(clockMs), flickHex, serverSalt].join('::'));
}

// Purely presentational, stable per identity. Same self + device -> same look.
export function visualSignature(identityHex, daringness = 0.5) {
  const slice = (start, len) => parseInt(identityHex.slice(start, start + len), 16);
  return {
    hue: slice(0, 4) % 360,
    cameraStyle: slice(4, 2) % 4,
    launchCharacter: (slice(6, 4) % 1000) / 1000,
    spinCadence: (slice(10, 4) % 1000) / 1000,
    dramaScalar: daringness,
  };
}
