// daringness.js
// ---------------------------------------------------------------------------
// Grades a player's rolling bet history into a single 0..1 "daringness" trait.
//
// Design principles (from the design conversation):
//   - EARNED   : derived only from what the player actually did in-game.
//   - VISIBLE  : every input is a real, explainable behavior (no black box).
//   - SLOW     : a rolling, recency-weighted window so the trait is a *trait*,
//                not day-to-day noise. It breathes, but it doesn't lurch.
//   - HONEST   : this value NEVER touches outcome selection. It feeds identity
//                (for seed provenance) and presentation (for visible signature).
//
// The trait is a blend of five behavioral facets, each normalized to 0..1:
//   stakeFraction   - how much of bankroll is risked per day
//   oddsAppetite    - how long-shot the chosen bets are
//   volatility      - how violently the bankroll swings
//   recovery        - how aggressively they re-enter after a bust
//   edgeSeeking      - how often they throw money at the ~1/500 lottery
// ---------------------------------------------------------------------------

// --- tunable configuration -------------------------------------------------

export const DARINGNESS_CONFIG = {
  // Rolling window: only the last N days of activity count.
  windowDays: 30,

  // Recency weighting. Each day older than the most recent is multiplied by
  // decay^age. 0.93^30 ~= 0.11, so a day at the window edge carries ~11% the
  // weight of today. This is what makes the trait "slow": one wild day can't
  // spike it, but a sustained shift moves it steadily.
  recencyDecay: 0.93,

  // Facet weights (must be meaningful relative to each other, need not sum to 1;
  // we normalize by the weight total). Stake fraction and odds appetite are the
  // primary daring signals; recovery is the most *revealing* under pressure.
  weights: {
    stakeFraction: 0.28,
    oddsAppetite:  0.24,
    volatility:    0.14,
    recovery:      0.22,
    edgeSeeking:   0.12,
  },

  // Reference points for normalizing raw facet values into 0..1.
  // These are the "what counts as daring" anchors — tune against real player
  // data in the Phase 1 sim before launch.
  norm: {
    // Odds appetite: average payout multiple of placed bets.
    // 2.05x (even money) -> tame; ~28x (Called Shot) -> maxed.
    oddsMultipleTame: 2.05,
    oddsMultipleBold: 20.0,

    // Volatility: stdev of daily balance % change. 0 -> flat, 0.6 -> wild.
    volatilityFlat: 0.0,
    volatilityWild: 0.6,

    // Recovery: fraction of bankroll bet on the FIRST day after a bust.
    // A cautious crawl-back is low; an immediate all-in shove is 1.
    // (stakeFraction already covers this softly; recovery isolates the
    //  under-pressure version, which is the real tell.)
  },

  // Smoothing: the returned trait is an EMA against the previous stored value,
  // so even the composed number can't jump. alpha is how much *new* reading
  // is admitted per update. 0.15 -> very slow, 0.4 -> more responsive.
  emaAlpha: 0.2,

  // A brand-new player with no history sits at this neutral prior until enough
  // days accumulate. Neutral, not zero — we don't assume timidity.
  coldStartValue: 0.5,

  // Below this many active days, blend the reading toward coldStartValue so a
  // single early wild bet doesn't define someone.
  confidenceDays: 7,
};

// --- helpers ---------------------------------------------------------------

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Linear normalize v from [lo,hi] into [0,1], clamped.
function norm(v, lo, hi) {
  if (hi === lo) return 0;
  return clamp01((v - lo) / (hi - lo));
}

// Standard deviation of an array (population).
function stdev(xs) {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

// --- per-day facet extraction ----------------------------------------------
//
// A `day` record is the raw material. Expected shape (all first-party, all
// things you already record for the ledger):
//
//   {
//     date:            'YYYY-MM-DD',
//     startBalance:    Number,   // bankroll at start of day
//     endBalance:      Number,   // bankroll after settlement
//     totalStaked:     Number,   // chips put at risk that day
//     bets: [ { stake: Number, payoutMultiple: Number, kind: String } ],
//     bustedYesterday: Boolean,  // did they hit zero the prior day?
//     edgeBets:        Number,   // count of The Edge bets placed
//     totalBets:       Number,   // count of all bets placed
//   }
//
// Missing fields degrade gracefully to neutral/zero.

function facetsForDay(day) {
  const start = Math.max(1, day.startBalance ?? 1); // avoid /0

  // 1. Stake fraction: portion of available bankroll risked.
  const stakeFraction = clamp01((day.totalStaked ?? 0) / start);

  // 2. Odds appetite: stake-weighted average payout multiple of the day's bets.
  let oddsAppetite = 0;
  const bets = day.bets ?? [];
  if (bets.length) {
    const wSum = bets.reduce((a, b) => a + (b.stake ?? 0), 0) || 1;
    const mult =
      bets.reduce((a, b) => a + (b.payoutMultiple ?? 2.05) * (b.stake ?? 0), 0) /
      wSum;
    oddsAppetite = norm(
      mult,
      DARINGNESS_CONFIG.norm.oddsMultipleTame,
      DARINGNESS_CONFIG.norm.oddsMultipleBold
    );
  }

  // 4. Recovery: only meaningful the day after a bust. Otherwise null so it
  //    doesn't dilute the average with "not applicable" zeros.
  let recovery = null;
  if (day.bustedYesterday) {
    recovery = clamp01((day.totalStaked ?? 0) / start);
  }

  // 5. Edge seeking: share of bets that were the lottery.
  const edgeSeeking = clamp01((day.edgeBets ?? 0) / Math.max(1, day.totalBets ?? 0));

  // Raw daily balance % change — collected across days for volatility.
  const pctChange = ((day.endBalance ?? start) - start) / start;

  return { stakeFraction, oddsAppetite, recovery, edgeSeeking, pctChange };
}

// --- main scorer -----------------------------------------------------------
//
// history:   array of day records, any order (we sort by date desc internally).
// previous:  the player's last stored daringness value (for EMA smoothing),
//            or undefined for a first computation.
//
// Returns { value, facets, activeDays, confidence } where `value` is the
// smoothed 0..1 trait to store, and `facets` is the pre-EMA breakdown (useful
// for the profile page — "your daringness comes mostly from odds appetite").

export function computeDaringness(history = [], previous = undefined) {
  const cfg = DARINGNESS_CONFIG;

  // Sort newest first, keep only the window.
  const sorted = [...history]
    .filter((d) => d && d.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, cfg.windowDays);

  if (sorted.length === 0) {
    return {
      value: previous ?? cfg.coldStartValue,
      facets: null,
      activeDays: 0,
      confidence: 0,
    };
  }

  // Accumulate recency-weighted facet sums.
  const acc = { stakeFraction: 0, oddsAppetite: 0, edgeSeeking: 0 };
  const recoveryVals = [];   // sparse — only bust-recovery days
  const pctChanges = [];     // for volatility across the window
  let wStake = 0, wOdds = 0, wEdge = 0;

  sorted.forEach((day, i) => {
    const w = Math.pow(cfg.recencyDecay, i); // i=0 is most recent
    const f = facetsForDay(day);

    acc.stakeFraction += f.stakeFraction * w; wStake += w;
    acc.oddsAppetite  += f.oddsAppetite  * w; wOdds  += w;
    acc.edgeSeeking   += f.edgeSeeking   * w; wEdge  += w;

    if (f.recovery !== null) recoveryVals.push(f.recovery * w);
    pctChanges.push(f.pctChange);
  });

  const facets = {
    stakeFraction: wStake ? acc.stakeFraction / wStake : 0,
    oddsAppetite:  wOdds  ? acc.oddsAppetite  / wOdds  : 0,
    edgeSeeking:   wEdge  ? acc.edgeSeeking   / wEdge  : 0,
    // 3. Volatility: stdev of daily % changes over the window, normalized.
    volatility: norm(
      stdev(pctChanges),
      cfg.norm.volatilityFlat,
      cfg.norm.volatilityWild
    ),
    // Recovery: mean of the (already weight-scaled) bust-recovery readings.
    // If they've never busted in-window, recovery is neutral (0.5) rather than
    // 0 — never having busted isn't "cautious", it's "untested".
    recovery: recoveryVals.length
      ? clamp01(recoveryVals.reduce((a, b) => a + b, 0) / recoveryVals.length)
      : 0.5,
  };

  // Weighted composite of the five facets.
  const W = cfg.weights;
  const wTotal = W.stakeFraction + W.oddsAppetite + W.volatility + W.recovery + W.edgeSeeking;
  let raw =
    (facets.stakeFraction * W.stakeFraction +
      facets.oddsAppetite * W.oddsAppetite +
      facets.volatility   * W.volatility +
      facets.recovery     * W.recovery +
      facets.edgeSeeking  * W.edgeSeeking) /
    wTotal;

  // Confidence blend: only pull toward the neutral prior while genuinely
  // under-sampled (fewer than confidenceDays of history). Once we have a full
  // window this is a no-op and the real reading stands on its own.
  const activeDays = sorted.length;
  const confidence = clamp01(activeDays / cfg.confidenceDays);
  raw = raw * confidence + cfg.coldStartValue * (1 - confidence);

  // EMA against previous stored value — smooths across UPDATES so the trait
  // can't jump day to day. But on a first computation (no previous) there is
  // nothing to smooth against: use the reading directly rather than diluting it
  // against a neutral prior a second time.
  const value =
    previous == null
      ? clamp01(raw)
      : clamp01(previous * (1 - cfg.emaAlpha) + raw * cfg.emaAlpha);

  return { value, facets, activeDays, confidence };
}

// A human-readable label for the profile/share card. Bands, not a raw number.
export function daringnessLabel(value) {
  if (value < 0.15) return 'Vault-Keeper';
  if (value < 0.35) return 'Grinder';
  if (value < 0.55) return 'Steady Hand';
  if (value < 0.72) return 'Chancer';
  if (value < 0.88) return 'High-Roller';
  return 'Degenerate';
}
