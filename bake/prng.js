// prng.js — deterministic seeded randomness for the bake.
// ---------------------------------------------------------------------------
// NOTHING in the sim path may call Math.random() or read the wall clock. Every
// launch parameter comes from here, and every stream is derived from a string
// label so that a clip's parameters depend ONLY on (masterSeed, label) and not
// on how many clips ran before it. That makes the bake order-independent,
// resumable and parallelisable without changing a single byte of output.
// ---------------------------------------------------------------------------

// xmur3 — string -> 32-bit seed generator.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// sfc32 — small, fast, high quality counter-based PRNG. Integer ops only, so
// it is bit-identical on every platform (no float accumulation drift).
function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** A named, independent random stream. Same (masterSeed, label) => same numbers. */
export function makeRng(masterSeed, label = '') {
  const seeder = xmur3(`${masterSeed}::${label}`);
  const next = sfc32(seeder(), seeder(), seeder(), seeder());
  // Discard the first few outputs so short labels do not correlate.
  for (let i = 0; i < 12; i++) next();

  return {
    /** uniform [0,1) */
    f: next,
    /** uniform [lo,hi) */
    range: (lo, hi) => lo + (hi - lo) * next(),
    /** integer [lo,hi] inclusive */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** pick one element */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** in-place deterministic Fisher-Yates */
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}
