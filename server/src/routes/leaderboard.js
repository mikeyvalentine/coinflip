// leaderboard.js — §6.8. Global rankings AND the population aggregates, because
// the design wants players eventually betting on whether they land near the
// population average or turn out to be an outlier. That bet can only be priced
// off a real distribution, so mean / median / percentiles / histogram are served
// as first-class data, not as decoration under a top-10 list.

import { json, bad } from '../lib/http.js';
import { loadUser, requireUser } from '../auth/middleware.js';
import { leaderboardPage, rankFor } from '../db/users.js';
import { computePopulationStats, readSnapshot, writeSnapshot } from '../db/stats.js';

const METRICS = ['bank', 'net_worth', 'best_multiple', 'flips', 'wins', 'peak_wallet'];
const DEFAULT_LIMIT = 50;

const ttlMs = (env) => Math.max(10, Number(env.STATS_TTL_SECONDS ?? 300)) * 1000;
const cacheHeaders = (env) => ({
  'cache-control': `public, max-age=30, s-maxage=${Math.max(30, Number(env.STATS_TTL_SECONDS ?? 300))}`,
});

// Top-N. The default page (metric=bank, offset 0) is served from the snapshot
// the cron writes, so the common request costs one indexed row read.
export async function top(ctx) {
  const metric = ctx.url.searchParams.get('metric') ?? 'bank';
  if (!METRICS.includes(metric)) throw bad('bad_metric', `metric must be one of ${METRICS.join(', ')}`);
  const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? DEFAULT_LIMIT)));
  const offset = Math.max(0, Number(ctx.url.searchParams.get('offset') ?? 0));

  const cacheable = offset === 0 && limit === DEFAULT_LIMIT;
  const key = `leaderboard:${metric}:${limit}`;

  if (cacheable) {
    const snap = await readSnapshot(ctx.env.DB, key, ttlMs(ctx.env), ctx.now);
    if (snap && !snap.stale) {
      return json({ metric, entries: snap.value, computedAt: snap.computedAt, cached: true }, { headers: cacheHeaders(ctx.env) });
    }
  }

  const { results } = await leaderboardPage(ctx.env.DB, { metric, limit, offset });
  const entries = results.map((row, i) => ({
    rank: offset + i + 1,
    userId: row.id,
    displayName: row.display_name ?? 'anonymous',
    avatarUrl: row.avatar_url,
    score: row.score,
    bank: row.bank,
    netWorth: row.net_worth,
    flips: row.flips,
    wins: row.wins,
    busts: row.busts,
    bestMultiple: row.best_multiple,
    peakWallet: row.peak_wallet,
    daringness: row.daringness,
  }));

  if (cacheable) ctx.waitUntil(writeSnapshot(ctx.env.DB, key, entries, ctx.now));
  return json({ metric, entries, computedAt: ctx.now, cached: false }, { headers: cacheHeaders(ctx.env) });
}

// Where the player sits — rank, percentile, and the distance from the mean and
// median that an "average or outlier" bet would be priced from.
export async function mine(ctx) {
  const user = await requireUser(ctx);
  const metric = ctx.url.searchParams.get('metric') ?? 'bank';
  if (!METRICS.includes(metric)) throw bad('bad_metric', `metric must be one of ${METRICS.join(', ')}`);

  const [rank, stats] = await Promise.all([
    rankFor(ctx.env.DB, { metric, userId: user.id }),
    populationStats(ctx),
  ]);

  const value = metric === 'net_worth' ? user.wallet + user.bank : user[metric] ?? user.bank;
  const ref = metric === 'net_worth' ? stats.netWorth : stats.bank;
  const deviation = ref && ref.stdev > 0 ? (value - ref.mean) / ref.stdev : null;

  return json({
    ...rank,
    value,
    population: {
      players: stats.players,
      mean: ref?.mean ?? null,
      median: ref?.median ?? null,
      stdev: ref?.stdev ?? null,
      percentiles: ref?.percentiles ?? null,
    },
    // the raw material for the "near the average, or an outlier?" bet
    standing: {
      zScore: deviation,
      distanceFromMean: ref ? value - ref.mean : null,
      distanceFromMedian: ref ? value - ref.median : null,
      outlier: deviation != null ? Math.abs(deviation) >= 2 : null,
    },
  });
}

export async function population(ctx) {
  const stats = await populationStats(ctx);
  return json(stats, { headers: cacheHeaders(ctx.env) });
}

// Snapshot-or-recompute. A player request only pays for the full scan when the
// snapshot is missing or stale, and even then the write is deferred.
async function populationStats(ctx) {
  const snap = await readSnapshot(ctx.env.DB, 'population', ttlMs(ctx.env), ctx.now);
  if (snap && !snap.stale) return { ...snap.value, cached: true };
  const fresh = await computePopulationStats(ctx.env.DB, ctx.now);
  ctx.waitUntil(writeSnapshot(ctx.env.DB, 'population', fresh, ctx.now));
  return { ...fresh, cached: false };
}

// Called by the cron trigger so the scan happens off the request path entirely.
export async function refreshAllSnapshots(env, now = Date.now()) {
  const stats = await computePopulationStats(env.DB, now);
  await writeSnapshot(env.DB, 'population', stats, now);
  for (const metric of METRICS) {
    const { results } = await leaderboardPage(env.DB, { metric, limit: DEFAULT_LIMIT, offset: 0 });
    const entries = results.map((row, i) => ({
      rank: i + 1,
      userId: row.id,
      displayName: row.display_name ?? 'anonymous',
      avatarUrl: row.avatar_url,
      score: row.score,
      bank: row.bank,
      netWorth: row.net_worth,
      flips: row.flips,
      wins: row.wins,
      busts: row.busts,
      bestMultiple: row.best_multiple,
      peakWallet: row.peak_wallet,
      daringness: row.daringness,
    }));
    await writeSnapshot(env.DB, `leaderboard:${metric}:${DEFAULT_LIMIT}`, entries, now);
  }
  return { metrics: METRICS.length, players: stats.players };
}
