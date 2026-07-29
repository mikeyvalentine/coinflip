// curate.js — cut an oversampled candidate pool down to a diverse library.
// ---------------------------------------------------------------------------
// UNIFORMITY ACROSS CELLS IS THE FAIRNESS REQUIREMENT. The posted odds are only
// honest if every one of the 128 (halfFlips x quadrant) cells is equally
// represented, so curation always takes the SAME number of variants from every
// cell. Within a cell we want maximum visual variety, which is what the
// farthest-point sampling below buys.
// ---------------------------------------------------------------------------

import { LAUNCH, CLASSIFY } from './config.js';
import { quadrantRange } from './classify.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

/**
 * Physically-motivated "gentle -> violent" scalar, 0..1, from absolute ranges
 * (not from the observed sample) so it means the same thing in every bake.
 *
 * Within a single cell the half-flip count is fixed, so vy and omega trade off
 * against each other: a violent flip is a fast tumble on a low flat arc that
 * lands hard and clatters; a gentle one is a slow tumble on a high lazy arc
 * that lands soft. Tumble rate is therefore the dominant term.
 */
export function energyRaw(cand) {
  const p = cand.params;
  const nOmega = norm(p.omega, LAUNCH.omegaMin, LAUNCH.omegaMax);
  const nImpact = norm(cand.diag.peakImpactSpeed, 1.0, 4.0);
  const nVh = norm(p.vh, LAUNCH.vhMin, LAUNCH.vhMax);
  const nBounce = norm(cand.diag.bounces, 0, 4);
  return clamp01(0.45 * nOmega + 0.25 * nImpact + 0.15 * nVh + 0.15 * nBounce);
}

/**
 * Feature vector for diversity. Weighted so the axes a player would actually
 * SEE (how fast it tumbles, how hard it lands) dominate the ones they would not.
 */
export function featureVector(cand) {
  const p = cand.params;
  const d = cand.diag;
  // Settled orientation is deliberately NOT in this vector. Farthest-point
  // sampling maximises spread by preferring extremes, so including orientation
  // pushed the selection to the two edges of each quadrant (measured: deciles
  // 153/99/83/91/88/97/73/87/97/156 against an expected 102). Orientation
  // uniformity is handled structurally instead, by stratifying the selection
  // in curateCell below.
  return [
    1.5 * norm(p.omega, LAUNCH.omegaMin, LAUNCH.omegaMax),
    1.5 * cand.energy0,
    1.0 * norm(p.vy, LAUNCH.vyMin, LAUNCH.vyMax),
    0.8 * norm(p.vh, LAUNCH.vhMin, LAUNCH.vhMax),
    0.6 * norm(Math.abs(p.spinY), 0, LAUNCH.spinYMax),
    0.8 * norm(d.bounces, 0, 4),
    0.8 * norm(cand.meta.durationMs, 400, 1600),
    0.6 * norm(d.displacement, 0, CLASSIFY.maxDisplacement),
  ];
}

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
}

function centroidDist2(vectors, i) {
  const dim = vectors[0].length;
  const c = new Array(dim).fill(0);
  for (const v of vectors) for (let d = 0; d < dim; d++) c[d] += v[d] / vectors.length;
  return dist2(vectors[i], c);
}

/**
 * Farthest-point sampling: pick `k` of `items` that are maximally spread in
 * feature space. Deterministic — the seed point is the item nearest the pool
 * centroid, and ties break on index, so the same pool always yields the same
 * selection regardless of machine or ordering of equal-distance candidates.
 */
export function farthestPointSample(items, k, vectors) {
  if (items.length <= k) return items.map((_, i) => i);

  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) centroid[i] += v[i] / vectors.length;

  let seed = 0, best = Infinity;
  for (let i = 0; i < vectors.length; i++) {
    const d = dist2(vectors[i], centroid);
    if (d < best - 1e-12) { best = d; seed = i; }
  }

  const chosen = [seed];
  const minD = vectors.map((v) => dist2(v, vectors[seed]));

  while (chosen.length < k) {
    let pick = -1, bestD = -1;
    for (let i = 0; i < vectors.length; i++) {
      if (minD[i] > bestD + 1e-12) { bestD = minD[i]; pick = i; }
    }
    if (pick < 0) break;
    chosen.push(pick);
    for (let i = 0; i < vectors.length; i++) {
      const d = dist2(vectors[i], vectors[pick]);
      if (d < minD[i]) minD[i] = d;
    }
    minD[pick] = -1;   // never re-pick
  }
  return chosen;
}

/**
 * Curate one cell's candidate pool down to `k` clips.
 * Returns the chosen candidates with `meta.energy` rank-normalised to a uniform
 * 0..1 spread — identity.js selectVariant() filters candidates to a +/-0.18
 * band around a target energy, so an even spread guarantees that band is never
 * empty and that a daring player reliably gets a more violent variant.
 */
export function curateCell(pool, k) {
  for (const c of pool) c.energy0 = energyRaw(c);
  const vectors = pool.map(featureVector);

  let chosen;
  if (pool.length <= k) {
    chosen = pool.slice();
  } else {
    // Split the quadrant into k orientation strata and take one clip from each,
    // picking the most feature-diverse candidate available in that stratum.
    // Uniformity by construction, diversity within it — the same principle the
    // 128 cells themselves use.
    const strata = Array.from({ length: k }, () => []);
    for (let i = 0; i < pool.length; i++) {
      const [lo] = quadrantRange(pool[i].meta.quadrant);
      const t = clamp01((pool[i].meta.orientationDeg - lo) / 90);
      strata[Math.min(k - 1, Math.floor(t * k))].push(i);
    }

    const takenIdx = [];
    const used = new Set();
    // Seed from the fullest stratum's most central member, so the greedy walk
    // starts somewhere stable rather than at an outlier.
    const order = strata.map((s, i) => i).sort((a, b) => strata[b].length - strata[a].length || a - b);
    for (const s of order) {
      const avail = strata[s].filter((i) => !used.has(i));
      if (!avail.length) continue;
      let pick = avail[0], best = -1;
      for (const i of avail) {
        // farthest from everything already taken (or, for the first, nearest
        // the pool centroid — handled by best starting at -1 with dMin=0)
        let dMin = Infinity;
        for (const j of takenIdx) dMin = Math.min(dMin, dist2(vectors[i], vectors[j]));
        const scoreI = takenIdx.length ? dMin : -centroidDist2(vectors, i);
        if (scoreI > best + 1e-12) { best = scoreI; pick = i; }
      }
      takenIdx.push(pick); used.add(pick);
    }
    // Any strata that were empty leave slots; fill them by plain farthest-point
    // over whatever is left so the cell still reaches quota.
    while (takenIdx.length < k) {
      let pick = -1, best = -1;
      for (let i = 0; i < pool.length; i++) {
        if (used.has(i)) continue;
        let dMin = Infinity;
        for (const j of takenIdx) dMin = Math.min(dMin, dist2(vectors[i], vectors[j]));
        if (dMin > best + 1e-12) { best = dMin; pick = i; }
      }
      if (pick < 0) break;
      takenIdx.push(pick); used.add(pick);
    }
    chosen = takenIdx.map((i) => pool[i]);
  }

  // RANK BY APEX, not by energyRaw.
  //
  // `energy` is the axis identity.js#selectVariant picks along, so it decides
  // which telling of an already-decided outcome the player's throw buys. It used
  // to rank by energyRaw — a "violence" scalar dominated by tumble rate — and
  // the result was that power moved the coin's horizontal skitter from ~11 cm to
  // ~17 cm. Nearly invisible. Meanwhile a ~278 mm spread in APEX sat unused
  // inside every cell (median, against a 340 mm library-wide range), and a light
  // toss flew exactly as high as a brutal one. That is what made the gesture
  // feel disconnected from the flight.
  //
  // The two are not related: measured across all 128 cells, the old energy rank
  // was 50.9% inverted against apex — statistically independent. So this is a
  // real re-ordering, not a relabelling.
  //
  // WHAT IT COSTS, and it is worth knowing. Within a cell the half-flip count is
  // FIXED, so a higher arc means a longer flight and therefore a SLOWER tumble —
  // measured, omega ranks 91.6% inverted against apex. So a brutal pull now buys
  // a high, lazy, long flip and a feather buys a low, fast, snappy one. That is
  // genuinely what the physics says for a fixed flip count, but it does invert
  // what "violent" meant: violence is no longer the thing power selects.
  //
  // energyRaw is DELIBERATELY LEFT ALONE. It still feeds featureVector, which
  // drives the farthest-point diversity sampling, so which clips a bake chooses
  // is unchanged — only the order they are ranked in afterwards. Changing both
  // would have re-selected the library, which is a re-bake, not a re-rank.
  //
  // Ties break on id, as before: apex is a float off a physics sim and two
  // clips in a cell can be micrometres apart, so the order has to stay
  // deterministic or the same seed would pick different tellings across bakes.
  chosen.sort((a, b) => a.diag.apexY - b.diag.apexY || a.id.localeCompare(b.id));
  const n = chosen.length;
  chosen.forEach((c, i) => {
    c.meta.energy = n === 1 ? 0.5 : +(i / (n - 1)).toFixed(4);
    c.energyRaw = +c.energy0.toFixed(4);
  });
  return chosen;
}

/** Mean nearest-neighbour distance in feature space — a diversity readout. */
export function poolSpread(items) {
  if (items.length < 2) return 0;
  const vs = items.map(featureVector);
  let sum = 0;
  for (let i = 0; i < vs.length; i++) {
    let m = Infinity;
    for (let j = 0; j < vs.length; j++) if (i !== j) m = Math.min(m, dist2(vs[i], vs[j]));
    sum += Math.sqrt(m);
  }
  return sum / vs.length;
}
