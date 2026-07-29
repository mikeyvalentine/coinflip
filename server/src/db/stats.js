// stats.js — leaderboard + population aggregates.
//
// QUERY COST. Percentiles and histograms are full scans of the active player
// set, so they are never computed on a player's request path if it can be
// helped: the cron trigger recomputes them every 5 minutes into
// stats_snapshots, requests read that single row, and a request only pays for a
// recompute if the snapshot is missing or older than STATS_TTL_SECONDS.
// Responses also carry Cache-Control so Cloudflare's edge absorbs the repeats.
//
// The aggregates are not decoration: §6.8 wants players betting on whether they
// will land near the population average or be an outlier, so mean, median, the
// spread and the shape of the distribution all have to be first-class and
// priceable — not just a top-10 list.

const ACTIVE = 'flips > 0';

// Percentiles for an arbitrary expression, in one pass.
function percentileQuery(db, expr) {
  return db.prepare(
    `WITH idx AS (
       SELECT ${expr} AS v,
              ROW_NUMBER() OVER (ORDER BY ${expr}) - 1 AS rn,
              COUNT(*) OVER () AS n
       FROM users WHERE ${ACTIVE}
     )
     SELECT
       MAX(n) AS n,
       MAX(CASE WHEN rn = CAST((n - 1) * 0.10 AS INTEGER) THEN v END) AS p10,
       MAX(CASE WHEN rn = CAST((n - 1) * 0.25 AS INTEGER) THEN v END) AS p25,
       MAX(CASE WHEN rn = CAST((n - 1) * 0.50 AS INTEGER) THEN v END) AS p50,
       MAX(CASE WHEN rn = CAST((n - 1) * 0.75 AS INTEGER) THEN v END) AS p75,
       MAX(CASE WHEN rn = CAST((n - 1) * 0.90 AS INTEGER) THEN v END) AS p90,
       MAX(CASE WHEN rn = CAST((n - 1) * 0.99 AS INTEGER) THEN v END) AS p99
     FROM idx`
  );
}

const HISTOGRAM_BUCKETS = [0, 1, 50, 100, 250, 500, 1000, 5000, 20000, 100000];

function histogramQuery(db, expr) {
  const cases = HISTOGRAM_BUCKETS.map(
    (lo, i) => `WHEN ${expr} >= ${lo}${i + 1 < HISTOGRAM_BUCKETS.length ? ` AND ${expr} < ${HISTOGRAM_BUCKETS[i + 1]}` : ''} THEN ${i}`
  ).join(' ');
  return db.prepare(
    `SELECT CASE ${cases} ELSE ${HISTOGRAM_BUCKETS.length - 1} END AS bucket, COUNT(*) AS c
     FROM users WHERE ${ACTIVE} GROUP BY bucket ORDER BY bucket`
  );
}

export async function computePopulationStats(db, now = Date.now()) {
  const [totals, bankPct, netPct, bankHist, daring] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS players,
              SUM(flips) AS flips,
              SUM(wins) AS wins,
              SUM(busts) AS busts,
              SUM(edge_hits) AS edge_hits,
              SUM(total_staked) AS staked,
              SUM(total_returned) AS returned,
              AVG(bank) AS bank_mean,
              AVG(bank * 1.0 * bank) AS bank_sq_mean,
              AVG(bank + wallet) AS net_mean,
              AVG((bank + wallet) * 1.0 * (bank + wallet)) AS net_sq_mean,
              MAX(bank) AS bank_max,
              MAX(bank + wallet) AS net_max,
              AVG(daringness) AS daringness_mean
       FROM users WHERE ${ACTIVE}`
    ),
    percentileQuery(db, 'bank'),
    percentileQuery(db, '(bank + wallet)'),
    histogramQuery(db, '(bank + wallet)'),
    db.prepare(
      `SELECT CASE
         WHEN daringness < 0.15 THEN 'Vault-Keeper'
         WHEN daringness < 0.35 THEN 'Grinder'
         WHEN daringness < 0.55 THEN 'Steady Hand'
         WHEN daringness < 0.72 THEN 'Chancer'
         WHEN daringness < 0.88 THEN 'High-Roller'
         ELSE 'Degenerate' END AS band, COUNT(*) AS c
       FROM users WHERE ${ACTIVE} GROUP BY band`
    ),
  ]);

  const t = totals.results[0] ?? {};
  const players = t.players ?? 0;
  const sd = (mean, sqMean) => {
    const v = (sqMean ?? 0) - (mean ?? 0) ** 2;
    return v > 0 ? Math.sqrt(v) : 0;
  };

  return {
    computedAt: now,
    players,
    flips: t.flips ?? 0,
    wins: t.wins ?? 0,
    busts: t.busts ?? 0,
    edgeHits: t.edge_hits ?? 0,
    // The house edge as actually realised. Should sit at 0.998 (a 0.20% edge).
    realisedReturnToPlayer: t.staked > 0 ? (t.returned ?? 0) / t.staked : null,
    bustRate: t.flips > 0 ? (t.busts ?? 0) / t.flips : null,
    edgeRate: t.flips > 0 ? (t.edge_hits ?? 0) / t.flips : null,
    bank: {
      mean: t.bank_mean ?? 0,
      stdev: sd(t.bank_mean, t.bank_sq_mean),
      max: t.bank_max ?? 0,
      median: bankPct.results[0]?.p50 ?? 0,
      percentiles: pick(bankPct.results[0]),
    },
    netWorth: {
      mean: t.net_mean ?? 0,
      stdev: sd(t.net_mean, t.net_sq_mean),
      max: t.net_max ?? 0,
      median: netPct.results[0]?.p50 ?? 0,
      percentiles: pick(netPct.results[0]),
      histogram: HISTOGRAM_BUCKETS.map((lo, i) => ({
        from: lo,
        to: HISTOGRAM_BUCKETS[i + 1] ?? null,
        count: bankHist.results.find((r) => r.bucket === i)?.c ?? 0,
      })),
    },
    daringness: {
      mean: t.daringness_mean ?? 0.5,
      bands: Object.fromEntries((daring.results ?? []).map((r) => [r.band, r.c])),
    },
  };
}

function pick(row) {
  if (!row) return {};
  return { p10: row.p10, p25: row.p25, p50: row.p50, p75: row.p75, p90: row.p90, p99: row.p99 };
}

// --- snapshot cache ---------------------------------------------------------

export async function readSnapshot(db, key, ttlMs, now = Date.now()) {
  const row = await db
    .prepare('SELECT json, computed_at FROM stats_snapshots WHERE key = ?')
    .bind(key)
    .first();
  if (!row) return null;
  const stale = now - row.computed_at > ttlMs;
  try {
    return { value: JSON.parse(row.json), computedAt: row.computed_at, stale };
  } catch {
    return null;
  }
}

export function writeSnapshot(db, key, value, now = Date.now()) {
  return db
    .prepare(
      `INSERT INTO stats_snapshots (key, json, computed_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at`
    )
    .bind(key, JSON.stringify(value), now)
    .run();
}
