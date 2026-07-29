// sim/population.mjs
// ---------------------------------------------------------------------------
// Does the economy work? Answered with numbers rather than intuition.
//
// Everything here is seeded and reproducible: same --seed, same output, byte
// for byte. Nothing calls Math.random() or reads the clock.
//
// WHY MEDIANS AND PERCENTILES, NOT MEANS. A 499x tail makes the mean bankroll
// almost meaningless — one player in five hundred drags the average somewhere
// no real player lives. Every distribution below is reported by quantile, and
// where a mean appears it is because the quantity is genuinely additive (total
// staked, total returned) and the mean is the thing being asked about.
//
// Run: node sim/population.mjs [--players N] [--days N] [--seed S]
// ---------------------------------------------------------------------------

import { makeRng } from '../bake/prng.js';
import {
  portions, resolveFlip, settleFlip, winOf, bankMax, evOf, winProbOf, returnedFor,
  FREE_BET_RETURN, WALLET_FLOOR, EDGE_P,
} from './economy.js';
import { selfTestFailures } from './selftest.mjs';

// A simulation that has not proved itself may not report an economic finding.
if (selfTestFailures > 0) {
  console.error(`\nREFUSING TO RUN: ${selfTestFailures} self-test failure(s). Fix the sim first.`);
  process.exit(1);
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const PLAYERS = +arg('players', 5000);
const DAYS = +arg('days', 730);            // two years of daily flips
const SEED = arg('seed', 'coinflip-pop-1');

const TIERS = { common: 1500, rare: 6000, epic: 15000, mythic: 50000 };

// ---- bet shapes -----------------------------------------------------------
const SIDE_ONLY = { side: 'Heads', orient: [], spins: null };
const THREE_AXIS = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };   // 2 / 4 / 32
const MODERATE = { side: 'Heads', orient: ['NE', 'SE'], spins: { line: 11.5, mode: 'gt' } }; // 2 / 2 / 2
const EDGE_BET = { side: 'Edge', orient: [], spins: null };

// ---- banking policies -----------------------------------------------------
// Each returns the ₿ to move from wallet to bank, and each is subject to
// bankMax() so none of them can breach the floor even if the arithmetic tried.
const never = () => 0;
const toFloor = (w) => bankMax(w);
const half = (w) => Math.floor(bankMax(w) / 2);
const toTarget = (T) => (w) => Math.min(bankMax(w), Math.max(0, Math.round(w) - T));
/** Ride the wallet up untouched, then cash out to the floor once it clears `at`. */
const rideTo = (at) => (w) => (w >= at ? bankMax(w) : 0);

// ---- the archetypes -------------------------------------------------------
// Chosen to span the two axes the design actually cares about: HOW MUCH RISK a
// player takes per flip (bet shape + spread), and WHEN they take money off the
// table (banking policy). The pairs are deliberate — grind-side vs ride-side
// isolates banking; the three grind-3axis rows isolate the Spread with
// everything else held fixed; ride-to-N tests the design's implied "ride up,
// then cash out" path to the expensive tiers.
const ARCHETYPES = [
  { name: 'grind-side',       bet: SIDE_ONLY,  t: 0.5, bank: toFloor,     note: 'safest possible: heads/tails, bank everything above the floor' },
  { name: 'ride-side',        bet: SIDE_ONLY,  t: 0.5, bank: never,       note: 'heads/tails, never banks' },
  { name: 'grind-3ax-safe',   bet: THREE_AXIS, t: 0,   bank: toFloor,     note: '2/4/32 board, Spread hard left' },
  { name: 'grind-3ax-even',   bet: THREE_AXIS, t: 0.5, bank: toFloor,     note: '2/4/32 board, equal split' },
  { name: 'grind-3ax-wild',   bet: THREE_AXIS, t: 1,   bank: toFloor,     note: '2/4/32 board, Spread hard right' },
  { name: 'ride-3ax-even',    bet: THREE_AXIS, t: 0.5, bank: never,       note: '2/4/32 board, never banks' },
  { name: 'half-banker',      bet: THREE_AXIS, t: 0.5, bank: half,        note: 'banks half the surplus each day' },
  { name: 'target-500',       bet: THREE_AXIS, t: 0.5, bank: toTarget(500), note: 'keeps a 500 wallet working, banks the rest' },
  { name: 'ride-to-2000',     bet: THREE_AXIS, t: 0.5, bank: rideTo(2000), note: 'rides to 2,000 then cashes out to the floor' },
  { name: 'ride-to-20000',    bet: THREE_AXIS, t: 0.5, bank: rideTo(20000), note: 'rides to 20,000 then cashes out' },
  { name: 'moderate-grind',   bet: MODERATE,   t: 0.5, bank: toFloor,     note: '2/2/2 board, bank to floor' },
  { name: 'edge-chaser',      bet: EDGE_BET,   t: 0.5, bank: toFloor,     note: 'whole wallet on the rim, 499x' },
];

// ---- stats helpers --------------------------------------------------------
const sortNum = (a) => [...a].sort((x, y) => x - y);
function q(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[i];
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
/**
 * The day by which `p` of the population reached a threshold. Players who never
 * reached it are counted as "later than the horizon" rather than dropped — drop
 * them and the median time-to-epic is computed over only the lucky, which is
 * exactly the way this kind of number usually lies.
 */
function quantileDay(days, n, p, horizon) {
  const s = sortNum(days);
  const need = Math.floor(p * n);
  return need < s.length ? s[need] : `>${horizon}`;
}

// ---- one player -----------------------------------------------------------
function simulatePlayer(arch, port, rng, days) {
  let wallet = 0, banked = 0;
  let busts = 0, brokeDays = 0, firstBust = null, maxWallet = 0, flips = 0;
  const tierDay = {};

  for (let d = 1; d <= days; d++) {
    if (wallet <= 0) {
      // THE BROKE FLIP. Heads or tails, no upgrades, and a rim landing still
      // sweeps — so it is 0.499 to win, not 0.5. It consumes the daily flip.
      const flip = resolveFlip(rng);
      const won = !flip.edge && flip.side === 'Heads';
      wallet = won ? FREE_BET_RETURN : 0;
      brokeDays++;
      continue;
    }
    // Banking happens during the cooldown, BEFORE the flip goes live, so the
    // stake is whatever is left after it. One-way: banked funds never come back.
    const amt = arch.bank(wallet);
    if (amt > 0) {
      banked += amt; wallet -= amt;
      for (const [tier, cost] of Object.entries(TIERS)) {
        if (tierDay[tier] === undefined && banked >= cost) tierDay[tier] = d;
      }
    }
    const flip = resolveFlip(rng);
    const end = settleFlip(port, arch.bet, flip, wallet);
    flips++;
    if (end > maxWallet) maxWallet = end;
    if (end <= 0) { busts++; if (firstBust === null) firstBust = d; }
    wallet = end;
  }
  return { banked, wallet, busts, brokeDays, firstBust, maxWallet, flips, tierDay };
}

// ===========================================================================
console.log(`\n\n########## POPULATION SIMULATION ##########`);
console.log(`seed "${SEED}" · ${PLAYERS.toLocaleString()} players · ${DAYS} days each `
  + `· ${(PLAYERS * DAYS).toLocaleString()} player-days per archetype`);

const t0 = Date.now();
const results = new Map();
for (const arch of ARCHETYPES) {
  const port = portions(arch.bet, arch.t);
  const rows = [];
  for (let p = 0; p < PLAYERS; p++) {
    rows.push(simulatePlayer(arch, port, makeRng(SEED, `${arch.name}::${p}`), DAYS));
  }
  results.set(arch.name, { arch, port, rows });
}
const elapsed = (Date.now() - t0) / 1000;

// ===========================================================================
console.log('\n=== (1) WHAT EACH ARCHETYPE BANKS — the only money that buys anything ===');
console.log('Banked is one-way and is the ONLY currency the store accepts, so a player');
console.log('who never banks can never buy a cosmetic no matter how rich their wallet gets.\n');
{
  const rows = [];
  for (const [name, { arch, port, rows: r }] of results) {
    const banked = sortNum(r.map((x) => x.banked));
    rows.push({
      archetype: name,
      board: port.map((x) => +x.mult.toFixed(2)).join('/'),
      t: arch.t,
      'banked p10': fmt(q(banked, 0.10)),
      'banked MEDIAN': fmt(q(banked, 0.50)),
      'banked p90': fmt(q(banked, 0.90)),
      'banked p99': fmt(q(banked, 0.99)),
      'per year (median)': fmt(q(banked, 0.50) / (DAYS / 365)),
    });
  }
  console.table(rows);
}

// ===========================================================================
console.log('\n=== (2) TIME TO AFFORD EACH COSMETIC TIER ===');
console.log('The day by which the MEDIAN player has banked enough. ">N" means fewer');
console.log(`than half the population got there inside the ${DAYS}-day horizon.\n`);
{
  const share = [];
  const when = [];
  for (const [name, { rows: r }] of results) {
    const sRow = { archetype: name };
    const wRow = { archetype: name };
    for (const [tier, cost] of Object.entries(TIERS)) {
      const days = r.map((x) => x.tierDay[tier]).filter((d) => d !== undefined);
      const label = `${tier} ${cost.toLocaleString()}`;
      sRow[label] = `${(100 * days.length / r.length).toFixed(0)}%`;
      wRow[label] = quantileDay(days, r.length, 0.5, DAYS);
    }
    share.push(sRow); when.push(wRow);
  }
  console.log('  share of players who could afford each tier inside the horizon:');
  console.table(share);
  console.log('  day the MEDIAN player could first afford it:');
  console.table(when);
}

// ===========================================================================
console.log('\n=== (3) BUSTING AND THE BROKE-FLIP TREADMILL ===');
{
  const rows = [];
  for (const [name, { rows: r }] of results) {
    const busts = sortNum(r.map((x) => x.busts));
    const broke = sortNum(r.map((x) => x.brokeDays));
    const firstBust = sortNum(r.map((x) => x.firstBust).filter((d) => d !== null));
    const neverBust = r.filter((x) => x.firstBust === null).length;
    rows.push({
      archetype: name,
      'busts (median)': q(busts, 0.5),
      'busts p90': q(busts, 0.9),
      'days broke (median)': q(broke, 0.5),
      '% of days broke': ((100 * mean(r.map((x) => x.brokeDays)) / DAYS)).toFixed(1) + '%',
      'first bust (median day)': firstBust.length > r.length / 2 ? q(firstBust, 0.5) : `>${DAYS}`,
      'never busted': ((100 * neverBust) / r.length).toFixed(1) + '%',
    });
  }
  console.table(rows);
  console.log('  A bust costs at least one day (the Broke Flip is the daily flip) and the');
  console.log(`  Broke Flip itself only wins ${((1 - EDGE_P) * 0.5).toFixed(3)} of the time — a rim landing sweeps it too.`);
}

// ===========================================================================
console.log('\n=== (4) DOES THE SPREAD MOVE EXPECTED VALUE? (it must not) ===');
console.log('Common random numbers: every t is handed the IDENTICAL flip sequence, so');
console.log('the difference between two rows is caused only by the weights.\n');
{
  const N = 3_000_000;
  const bet = THREE_AXIS;
  const base = portions(bet, 0.5);
  const rows = [];
  const perT = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const port = portions(bet, t);
    const rng = makeRng(SEED, 'spread-crn');     // re-seeded => identical flips
    const baseRng = makeRng(SEED, 'spread-crn');
    let sum = 0, sumSq = 0, dSum = 0, dSumSq = 0, wipeouts = 0, nearWipe = 0;
    for (let k = 0; k < N; k++) {
      const flip = resolveFlip(rng);
      resolveFlip(baseRng);                       // keep the streams in lockstep
      const r = 1 + port.reduce((s, x) => s + (winOf(x, bet, flip) ? x.w * (x.mult - 1) : -x.w), 0);
      const b = 1 + base.reduce((s, x) => s + (winOf(x, bet, flip) ? x.w * (x.mult - 1) : -x.w), 0);
      const d = r - b;
      sum += r; sumSq += r * r; dSum += d; dSumSq += d * d;
      if (r < 1e-9) wipeouts++;
      if (r < 0.25) nearWipe++;
    }
    const m = sum / N;
    const sd = Math.sqrt(Math.max(sumSq / N - m * m, 0));
    const dm = dSum / N;
    const dsd = Math.sqrt(Math.max(dSumSq / N - dm * dm, 0));
    perT.push({ t, m, sd, dm, dse: dsd / Math.sqrt(N) });
    rows.push({
      t,
      weights: port.map((x) => x.w.toFixed(3)).join(' '),
      'mean return': m.toFixed(5),
      'sd (volatility)': sd.toFixed(3),
      'P(all 3 lose)': (100 * wipeouts / N).toFixed(2) + '%',
      'P(keep <25%)': (100 * nearWipe / N).toFixed(2) + '%',
      'paired diff vs t=0.5': dm.toExponential(2),
      '3 sigma on diff': (3 * dsd / Math.sqrt(N)).toExponential(2),
    });
  }
  console.table(rows);
  const violations = perT.filter((x) => Math.abs(x.dm) > 3 * x.dse && x.t !== 0.5);
  const analytic = evOf(base, bet);
  if (violations.length) {
    console.log(`  *** MAJOR FINDING: EV MOVES WITH THE SPREAD at t = ${violations.map((v) => v.t).join(', ')} ***`);
  } else {
    console.log(`  EV is flat across the whole slider. Every paired difference sits inside`);
    console.log(`  3 sigma of zero, over ${N.toLocaleString()} common-random-number flips per t.`);
  }
  console.log('  P(all 3 lose) is IDENTICAL at every t, and that is correct, not a bug: losing');
  console.log('  every line returns 0 whatever the weights were. The Spread moves how much a');
  console.log('  PARTIAL result gives back — which is why P(keep <25%) does move with t.');
  console.log(`  analytic EV at every t: ${analytic} · volatility ranges `
    + `${Math.min(...perT.map((x) => x.sd)).toFixed(2)} -> ${Math.max(...perT.map((x) => x.sd)).toFixed(2)} `
    + `(a ${(Math.max(...perT.map((x) => x.sd)) / Math.min(...perT.map((x) => x.sd))).toFixed(1)}x swing in risk at identical EV)`);
}

// ===========================================================================
console.log('\n=== (5) IS THE HOUSE EDGE THE STATED 0.20%, PER AXIS? ===');
{
  const N = 4_000_000;
  const bet = THREE_AXIS;
  const port = portions(bet, 0.5);
  const rng = makeRng(SEED, 'axis-edge');
  const staked = {}, returned = {};
  for (const x of port) { staked[x.key] = 0; returned[x.key] = 0; }
  let allStaked = 0, allReturned = 0;
  for (let i = 0; i < N; i++) {
    const flip = resolveFlip(rng);
    for (const x of port) {
      staked[x.key] += x.w;
      const back = winOf(x, bet, flip) ? x.w * x.mult : 0;
      returned[x.key] += back;
      allStaked += x.w; allReturned += back;
    }
  }
  // ERROR BARS ARE NOT OPTIONAL HERE. A 0.2% edge measured on a 32x bet is a
  // tiny signal under enormous variance: SE(edge) = mult * sqrt(p(1-p)/N), which
  // for the 32x spin axis is ~0.28% at 4M flips — wider than the effect. Without
  // this column the spin row reads as "the edge is missing on this axis", which
  // would be a fabricated finding. Resolving 0.2% on a 32x bet to 3 sigma needs
  // roughly 10^8 flips; the point of the table is that every axis is CONSISTENT
  // with 0.2%, not that it has been resolved to it.
  const rows = port.map((x) => {
    const p = winProbOf(x, bet);
    const se3 = 3 * x.mult * Math.sqrt(p * (1 - p) / N);
    const est = 1 - returned[x.key] / staked[x.key];
    return {
      axis: x.key,
      mult: +x.mult.toFixed(2),
      'measured edge': (100 * est).toFixed(3) + '%',
      '+/- 3 sigma': (100 * se3).toFixed(3) + '%',
      'design 0.200%': Math.abs(est - EDGE_P) <= se3 ? 'consistent' : 'INCONSISTENT',
    };
  });
  rows.push({
    axis: 'ALL',
    mult: '—',
    'measured edge': (100 * (1 - allReturned / allStaked)).toFixed(3) + '%',
    '+/- 3 sigma': '—',
    'design 0.200%': '—',
  });
  console.table(rows);
  console.log(`  ${N.toLocaleString()} flips. The edge comes from ONE source — the rim sweep —`);
  console.log('  so it is the same on every axis BY CONSTRUCTION, not by tuning. What this');
  console.log('  table can show is that nothing contradicts that; the 32x axis is far too');
  console.log('  noisy at this N to resolve 0.2% on its own, and its error bar says so.');
}

// ===========================================================================
console.log('\n=== (6) THE SPREAD IS EV-NEUTRAL PER FLIP. IS IT NEUTRAL OVER A CAREER? ===');
console.log('Section (4) proved per-flip EV is flat. That is NOT the same claim as "the');
console.log('Spread cannot be gamed", because a career is not one flip: banking is a');
console.log('RATCHET (banked money can never be lost) and the Broke Flip puts a FLOOR under');
console.log('losing (bust and you are handed 50 back, free). Gains are kept, losses stop at');
console.log('zero. Under that asymmetry, variance is not free.\n');
{
  const N = 8000;
  const rows = [];
  const medians = [];
  for (const t of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) {
    const arch = { name: 'sweep', bet: THREE_AXIS, t, bank: toFloor };
    const port = portions(arch.bet, t);
    const banked = [];
    let epic = 0, rare = 0;
    for (let pi = 0; pi < N; pi++) {
      // The SAME per-player seed labels at every t, so the populations are paired.
      const r = simulatePlayer(arch, port, makeRng(SEED, `careersweep::${pi}`), DAYS);
      banked.push(r.banked);
      if (r.banked >= TIERS.epic) epic++;
      if (r.banked >= TIERS.rare) rare++;
    }
    const sorted = sortNum(banked);
    // Bootstrap CI on the MEDIAN. A median has no clean closed-form standard
    // error, and without an interval "10,725 vs 7,502" is just two numbers that
    // happen to differ — which is exactly the kind of claim this file exists to
    // avoid making.
    const boot = [];
    const brng = makeRng(SEED, `boot::${t}`);
    for (let b = 0; b < 300; b++) {
      const samp = new Array(N);
      for (let k = 0; k < N; k++) samp[k] = banked[brng.int(0, N - 1)];
      boot.push(q(sortNum(samp), 0.5));
    }
    const bs = sortNum(boot);
    medians.push({ t, med: q(sorted, 0.5), lo: q(bs, 0.025), hi: q(bs, 0.975) });
    rows.push({
      t,
      'banked MEDIAN': fmt(q(sorted, 0.5)),
      '95% CI on median': `${fmt(q(bs, 0.025))} - ${fmt(q(bs, 0.975))}`,
      'banked p90': fmt(q(sorted, 0.9)),
      'reached rare': (100 * rare / N).toFixed(1) + '%',
      'reached EPIC': (100 * epic / N).toFixed(1) + '%',
    });
  }
  console.table(rows);
  const lo = medians.find((m) => m.t === 0.5);
  const hi = medians.find((m) => m.t === 1);
  if (hi.lo > lo.hi || lo.lo > hi.hi) {
    console.log('  *** MAJOR FINDING: THE SPREAD IS NOT CAREER-NEUTRAL. ***');
    console.log(`  t=1 banks a median ${fmt(hi.med)} against t=0.5's ${fmt(lo.med)} over ${DAYS} days,`);
    console.log('  and the 95% confidence intervals on those medians do not overlap.');
    console.log('  Per-flip EV is identical (section 4). The CAREER differs, because the');
    console.log('  ratchet keeps the upside while the Broke Flip refunds the downside — so');
    console.log('  cranking the Spread to maximum is strictly better, not merely wilder.');
    console.log('  "Provably cannot be gamed" holds PER FLIP and fails PER CAREER.');
  } else {
    console.log('  Medians overlap within their confidence intervals — no career effect found.');
  }
}

// ===========================================================================
console.log('\n=== (7) WHY NOBODY GETS RICH: bust chance ignores the size of the wallet ===');
{
  // The whole wallet rides every day, so a bust is just "every line lost" — an
  // event whose probability has nothing to do with how much was on the table.
  // The wallet is therefore a multiplicative walk against an absorbing barrier
  // it meets at a CONSTANT rate, and a 50 wallet and a 50,000 wallet are equally
  // likely to be gone tomorrow.
  const rows = [];
  for (const [label, bet, t] of [
    ['side only (2x)', SIDE_ONLY, 0.5],
    ['2/4/32 @ t=0.5', THREE_AXIS, 0.5],
    ['2/4/32 @ t=1', THREE_AXIS, 1],
    ['2/2/2 moderate', MODERATE, 0.5],
    ['Edge only (499x)', EDGE_BET, 0.5],
  ]) {
    const port = portions(bet, t);
    const rng = makeRng(SEED, 'bustrate::' + label);
    const N = 400_000;
    let small = 0, large = 0;
    for (let i2 = 0; i2 < N; i2++) {
      const flip = resolveFlip(rng);
      if (settleFlip(port, bet, flip, 50) <= 0) small++;
      if (settleFlip(port, bet, flip, 50000) <= 0) large++;
    }
    rows.push({
      board: label,
      'P(bust) from 50': (100 * small / N).toFixed(2) + '%',
      'P(bust) from 50,000': (100 * large / N).toFixed(2) + '%',
      'same?': Math.abs(small - large) / N < 0.005 ? 'yes' : 'NO — see below',
      'mean days to bust': (1 / (small / N)).toFixed(1),
    });
  }
  console.table(rows);
  console.log('  For most boards the two columns agree, because busting is just "every line');
  console.log('  lost" — an event that does not care how much was on the table. A player');
  console.log('  cannot out-grow the bust rate, so the expensive tiers are reachable only by');
  console.log('  BANKING, never by getting rich.');

  // The t=1 row does NOT agree, and the reason is a genuine defect rather than
  // noise. It was found by this check contradicting the sentence above it.
  const bet = THREE_AXIS;
  const port = portions(bet, 1);
  const onlySide = { startFace: 'Tails', side: 'Heads', spins: 9, orientationDeg: 200, quadrant: 'SW', edge: false };
  let liveAt = null;
  for (let w = 1; w <= 400; w++) if (liveAt === null && settleFlip(port, bet, onlySide, w) > 0) liveAt = w;
  console.log('');
  console.log('  *** FINDING: AT HIGH SPREAD, A WINNING LINE CAN STILL ROUND TO A BUST. ***');
  console.log(`  At t=1 the weights are ${port.map((x) => x.w.toFixed(5)).join(' / ')}, so the Side line`);
  console.log(`  carries 0.38% of the wallet. Win ONLY Side from a ${WALLET_FLOOR} wallet and the return is`);
  console.log(`  ${returnedFor(port, bet, onlySide, WALLET_FLOOR).toFixed(3)} ₿, which Math.round()s to 0 — a bust, on a flip the player WON.`);
  console.log(`  The Side line only starts paying anything at a wallet of ${liveAt} ₿.`);
  console.log(`  This bites hardest at exactly ${WALLET_FLOOR}, the wallet FLOOR — which is the most common`);
  console.log('  wallet in the game, since bank-to-floor players live there and every Broke');
  console.log('  Flip recovery returns to it. The staged reveal will colour the Side row green');
  console.log('  and then land the total on 0 ₿, which reads as a bug to the player because it is one.');
}

console.log(`\n########## done in ${elapsed.toFixed(1)}s of simulation `
  + `(+ the focused experiments above) ##########`);
