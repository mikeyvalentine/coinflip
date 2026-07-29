// fingerprint.js
// ---------------------------------------------------------------------------
// Turns a bag of client-collected device/environment signals into a stable
// numeric hash. This is the DEVICE half of identity ("same machine").
//
// IMPORTANT boundaries (from the design conversation):
//   - This identifies a *device/browser environment*, never a person, never a
//     personality. It carries no meaning about who the user is.
//   - It is used for: (a) the identity fusion below, as seed provenance, and
//     (b) a separate fraud/trust signal (multi-account clustering) handled
//     elsewhere. It must be disclosed in the privacy policy.
//   - It never selects or biases a flip outcome.
//
// The client gathers `signals` (see collectSignals.client.js) and POSTs them.
// We hash server-side so the mapping is stable and not client-forgeable in a
// way that matters (the salt lives server-side).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

// The signal keys we fold in, in fixed order. Order matters: the hash must be
// deterministic across visits for the SAME device. We deliberately EXCLUDE
// highly volatile signals (e.g. window size, battery) so the fingerprint is
// stable day to day rather than changing when they resize a window.
const STABLE_SIGNAL_KEYS = [
  'userAgent',
  'platform',
  'languages',        // joined
  'timezone',
  'screenColorDepth',
  'devicePixelRatio',
  'hardwareConcurrency',
  'deviceMemory',
  'webglVendor',
  'webglRenderer',
  'canvasHash',       // hash of a rendered canvas (GPU/driver signature)
  'audioHash',        // hash of an offline-audio render (audio stack signature)
  'fontsHash',        // hash of detected font availability
];

// Produce a normalized string from the raw signals, using only stable keys and
// tolerating missing ones (missing -> empty, so absence is itself consistent).
function canonicalize(signals = {}) {
  return STABLE_SIGNAL_KEYS.map((k) => {
    const v = signals[k];
    if (v == null) return `${k}:`;
    if (Array.isArray(v)) return `${k}:${v.join(',')}`;
    return `${k}:${String(v)}`;
  }).join('|');
}

// Stable per-device fingerprint hash (hex). Same device -> same value, every
// visit. `serverSalt` keeps the value from being trivially reproduced/forged
// by a client that wants to impersonate another device's signature.
export function computeFingerprint(signals, serverSalt) {
  const canon = canonicalize(signals);
  return createHash('sha256').update(`${serverSalt}::${canon}`).digest('hex');
}

// A numeric (BigInt) view of the fingerprint, for folding into identity math.
export function fingerprintToBigInt(fpHex) {
  return BigInt('0x' + fpHex.slice(0, 16)); // first 64 bits is plenty
}

// A soft *similarity* helper for the fraud/trust layer (NOT for identity or
// outcomes): how many stable signals two signal-bags share. Real devices drift
// a little (browser updates change userAgent), so multi-account clustering
// wants "mostly the same" rather than "hash identical".
export function signalOverlap(a = {}, b = {}) {
  let same = 0, total = 0;
  for (const k of STABLE_SIGNAL_KEYS) {
    total++;
    const av = Array.isArray(a[k]) ? a[k].join(',') : String(a[k] ?? '');
    const bv = Array.isArray(b[k]) ? b[k].join(',') : String(b[k] ?? '');
    if (av !== '' && av === bv) same++;
  }
  return total ? same / total : 0;
}
