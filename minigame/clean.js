// minigame/clean.js
// ---------------------------------------------------------------------------
// COIN CLEANING — the busker's recovery. You are broke, so you scrub a coin for
// a stake. Replaces the Broke Flip's heads-or-tails call.
//
// WHY IT EXISTS, and why the payout rule is shaped the way it is.
// The old recovery was a 50/50 for 50 B. Busting cost you the day, and then
// HALF THE TIME the recovery failed and cost you another one — which is most of
// why 40.3% of all days are spent unable to play. Measured: a recovery that
// ALWAYS pays drops that to 26.4%. The win comes from removing the second coin
// flip, NOT from the amount — paying 25 and paying 50 give identical dead-day
// figures. So determinism is the mechanism and the amount is a separate knob
// that sizes the economy.
//
// Hence the one rule nothing may break: THIS CAN NEVER FAIL AND NEVER PAY 0.
// It is the only way back into the game from 0 B. A player who cannot finish
// still has to recover, or they are stranded forever with the real game
// permanently out of reach. Skill moves the payout inside a band; it never
// gates access. The band is 40..60, so the best possible player out-earns the
// worst by exactly 1.5x and no more — this is the game's ONLY money faucet, and
// a faucet that scales with skill is an exploit waiting to be found.
//
// As in flip3d/grab.js, the state machine is deliberately separate from any
// pixels: no DOM, no canvas, no rAF. The clock is injectable so the whole thing
// runs in a verifier with no real milliseconds passing — the preview pane here
// is usually hidden, where rAF never fires and setTimeout is throttled, so
// anything driven by a real timer could not be tested at all.
// ---------------------------------------------------------------------------

/** The payout band, in B. Never below the floor, never above the ceiling. */
export const PAYOUT_MIN = 40;
export const PAYOUT_MAX = 60;

/**
 * Cleaned fraction that counts as finished.
 *
 * Not 1.0. A soft-falloff brush leaves a haze in the corners of the disc that
 * takes as long to chase as the whole rest of the coin, and hunting the last
 * few percent is the least satisfying part of any scrub game. Finishing here
 * pays the full ceiling.
 */
export const CLEAN_ENOUGH = 0.92;

/**
 * Hard stop, ms. Twenty seconds, from the brief: longer and the minigame stops
 * being a way back into the game and starts being the game.
 */
export const HARD_CAP_MS = 20000;

/** Dirt mask resolution. 64x64 over the coin — 3208 cells inside the disc. */
export const DIRT_GRID = 64;

/** Brush radius as a fraction of the coin's radius. */
export const BRUSH_RADIUS = 0.16;

/** How much dirt one brush application lifts at its centre, 0..1. */
export const BRUSH_STRENGTH = 0.55;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// --- seeded value noise ----------------------------------------------------
// Integer hash, so the dirt is identical on every machine and every run. A
// float-based PRNG would drift across engines and the "same seed, same dirt"
// guarantee is what makes the generator testable at all.
function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const fade = (t) => t * t * (3 - 2 * t);

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x); const y0 = Math.floor(y);
  const fx = fade(x - x0); const fy = fade(y - y0);
  const a = hash2(x0, y0, seed); const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed); const d = hash2(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

/** Layered value noise. Four octaves is enough to read as grime, not as a grid. */
function fbm(x, y, seed) {
  let sum = 0; let amp = 0.5; let f = 1;
  for (let o = 0; o < 4; o++) {
    sum += valueNoise(x * f, y * f, seed + o * 7919) * amp;
    amp *= 0.5; f *= 2;
  }
  return sum;
}

/**
 * Build a dirt mask over the coin.
 *
 * @returns {{grid:number, dirt:Float32Array, inDisc:Uint8Array, discCells:number, total:number}}
 *   `dirt` is 0..1 per cell. Only cells inside the disc are ever counted —
 *   grime drawn outside the coin is not scrubbable and must not dilute the
 *   cleaned fraction, or a player could "finish" by never touching the coin.
 */
export function makeDirt(seed = 1, grid = DIRT_GRID) {
  const g = Math.max(4, grid | 0);
  const s = Number.isFinite(seed) ? (seed | 0) : 1;
  const dirt = new Float32Array(g * g);
  const inDisc = new Uint8Array(g * g);
  let discCells = 0; let total = 0;
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const nx = (i + 0.5) / g * 2 - 1;
      const ny = (j + 0.5) / g * 2 - 1;
      const k = j * g + i;
      if (nx * nx + ny * ny > 1) continue;          // outside the coin
      inDisc[k] = 1; discCells++;
      // Bias upward so the coin reads as filthy at the start, but keep the
      // variation — an evenly dirty coin gives the scrub nothing to reveal.
      const v = clamp01(0.35 + fbm((nx + 1) * 3.1, (ny + 1) * 3.1, s) * 1.15);
      dirt[k] = v;
      total += v;
    }
  }
  return { grid: g, dirt, inDisc, discCells, total };
}

/**
 * The payout for a cleaned fraction. Pure, and the single place the band is
 * enforced — everything else routes through here.
 *
 * Normalised to CLEAN_ENOUGH rather than to 1.0, so actually finishing pays the
 * ceiling instead of asymptotically approaching it.
 */
export function payoutFor(cleaned) {
  const c = Number.isFinite(cleaned) ? clamp01(cleaned) : 0;
  const q = c >= CLEAN_ENOUGH ? 1 : c / CLEAN_ENOUGH;
  const v = Math.round(PAYOUT_MIN + (PAYOUT_MAX - PAYOUT_MIN) * q);
  // Belt and braces. The arithmetic above cannot leave the band, but this is
  // the value that puts money in a player's wallet and it is worth being
  // certain rather than clever.
  return Math.min(PAYOUT_MAX, Math.max(PAYOUT_MIN, v));
}

/**
 * The scrub.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed] dirt seed
 * @param {number} [opts.grid] mask resolution
 * @param {()=>number} [opts.now] injectable clock, ms
 * @param {number} [opts.brushRadius] fraction of the coin radius
 * @param {number} [opts.hardCapMs]
 */
export function createClean(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const brushRadius = Number.isFinite(opts.brushRadius) && opts.brushRadius > 0
    ? opts.brushRadius : BRUSH_RADIUS;
  const hardCapMs = Number.isFinite(opts.hardCapMs) && opts.hardCapMs > 0
    ? opts.hardCapMs : HARD_CAP_MS;
  const strength = Number.isFinite(opts.strength) && opts.strength > 0
    ? opts.strength : BRUSH_STRENGTH;
  // Test seam, in the spirit of grab.js's _begin/_move/_finish. Set above 1 to
  // disable completion, which is the only way to watch the cleaned fraction run
  // all the way to 1.0 — in the game it finishes at CLEAN_ENOUGH and stops.
  const cleanEnough = Number.isFinite(opts.cleanEnough) ? opts.cleanEnough : CLEAN_ENOUGH;

  let field = makeDirt(opts.seed ?? 1, opts.grid ?? DIRT_GRID);
  let remaining = field.total;
  let startedAt = null;          // null until the first real scrub
  let finished = false;
  let lockedPayout = null;
  let lastX = null; let lastY = null;
  let strokeLen = 0;             // total path length, in coin radii — telemetry

  /** Fraction of the dirt that was there and is now gone. Exactly 1.0 when clear. */
  function cleaned() {
    if (!(field.total > 0)) return 1;
    return clamp01(1 - remaining / field.total);
  }

  function elapsedMs() {
    return startedAt == null ? 0 : Math.max(0, now() - startedAt);
  }

  function finish() {
    if (finished) return;
    finished = true;
    lockedPayout = payoutFor(cleaned());
  }

  /** One brush stamp centred on (nx, ny), coin-normalised to [-1,1]. */
  function stamp(nx, ny) {
    const g = field.grid;
    const r = brushRadius;
    // cell index range the brush can touch
    const lo = (v) => Math.max(0, Math.floor(((v - r) + 1) / 2 * g));
    const hi = (v) => Math.min(g - 1, Math.ceil(((v + r) + 1) / 2 * g));
    const i0 = lo(nx); const i1 = hi(nx); const j0 = lo(ny); const j1 = hi(ny);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * g + i;
        if (!field.inDisc[k]) continue;
        const cx = (i + 0.5) / g * 2 - 1;
        const cy = (j + 0.5) / g * 2 - 1;
        const d = Math.hypot(cx - nx, cy - ny);
        if (d > r) continue;
        const t = 1 - d / r;
        const removal = strength * t * t;        // soft falloff to the rim
        const cur = field.dirt[k];
        if (cur <= 0) continue;
        const took = cur < removal ? cur : removal;
        field.dirt[k] = cur - took;
        remaining -= took;                       // monotone by construction
      }
    }
  }

  /**
   * Scrub to (nx, ny), coin-normalised to [-1,1].
   *
   * Interpolates from the previous point. A fast drag delivers pointer events
   * tens of px apart, and stamping only at the reported positions leaves a
   * dotted trail — the coin looks scrubbed where the hardware happened to
   * sample, which reads as the brush being broken rather than the hand being
   * fast.
   */
  function scrubTo(nx, ny) {
    if (finished) return false;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;   // broken event
    // THE CLOCK STARTS ON FIRST CONTACT WITH THE COIN, not on the first pointer
    // event. Pressing beside the coin, or dragging onto it from outside, must
    // not quietly burn seconds off a cap the player cannot see — and the cap is
    // the only thing standing between them and a payout.
    if (startedAt == null && nx * nx + ny * ny <= 1) startedAt = now();

    if (lastX == null) {
      stamp(nx, ny);
    } else {
      const dx = nx - lastX; const dy = ny - lastY;
      const dist = Math.hypot(dx, dy);
      strokeLen += dist;
      const step = brushRadius * 0.4;
      const n = Math.min(512, Math.max(1, Math.ceil(dist / step)));
      for (let s = 1; s <= n; s++) stamp(lastX + dx * (s / n), lastY + dy * (s / n));
    }
    lastX = nx; lastY = ny;

    if (cleaned() >= cleanEnough) finish();
    return true;
  }

  /** Lift the brush. The next scrub starts a new stroke rather than joining. */
  function lift() { lastX = null; lastY = null; }

  /**
   * Advance the clock. The ONLY thing that can fire the hard cap, because a
   * player who has stopped scrubbing emits no events.
   */
  function tick() {
    if (finished) return true;
    if (startedAt != null && elapsedMs() >= hardCapMs) finish();
    return finished;
  }

  function reset(seed) {
    field = makeDirt(seed ?? opts.seed ?? 1, opts.grid ?? DIRT_GRID);
    remaining = field.total;
    startedAt = null; finished = false; lockedPayout = null;
    lastX = null; lastY = null; strokeLen = 0;
  }

  return {
    scrubTo, lift, tick, reset, finish,
    get cleaned() { return cleaned(); },
    get done() { return finished; },
    /** Live while scrubbing; frozen the moment it finishes. Always in band. */
    get payout() { return finished ? lockedPayout : payoutFor(cleaned()); },
    get elapsedMs() { return elapsedMs(); },
    get started() { return startedAt != null; },
    /** Path length in coin RADII — how much dragging the clean actually took. */
    get strokeLen() { return strokeLen; },
    get grid() { return field.grid; },
    get discCells() { return field.discCells; },
    /** Dirt at a cell, 0..1, for the view. */
    dirtAt(i, j) {
      const g = field.grid;
      if (i < 0 || j < 0 || i >= g || j >= g) return 0;
      return field.dirt[j * g + i];
    },
    /** The raw mask, for a view that wants to blit it. Read-only by convention. */
    get field() { return field; },
  };
}
