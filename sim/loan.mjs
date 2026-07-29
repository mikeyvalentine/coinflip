// sim/loan.mjs
// ---------------------------------------------------------------------------
// Does turning the Broke Flip into a LOAN kill the convexity that makes the
// betting board decoration?
//
// THE CONVEXITY, restated so the fix can be aimed at it: banking is a RATCHET
// (banked never comes back) and the Broke Flip is a FLOOR (bust and you are
// handed 50 free). Gains keep, losses refund. Under that asymmetry variance is
// worth money, so maximising volatility is correct play every single day.
//
// This file reuses sim/economy.js for the flip, the win test and the settlement
// — everything that defines the ODDS. What it adds is a debt ledger and the two
// NEW presets, because coinflip-preview.html has since replaced the Spread
// slider and economy.js has not caught up:
//
//   SPREAD  w proportional to 1/mult, so every call that lands returns the same
//           K x wallet, K = 1 / sum(1/mult).
//   RIDE    one compound call, priced on the TRUE JOINT probability.
//
// Those are a pricing layer over the same draw, not a second economy. The flip,
// the parity coupling and the rim sweep all still come from economy.js.
//
// Run: node sim/loan.mjs [--players N] [--days N] [--seed S]
// ---------------------------------------------------------------------------

import { makeRng } from '../bake/prng.js';
import {
  SPIN_VALUES, SPIN_N, QUADS, EDGE_P, MULT, WALLET_FLOOR, FREE_BET_RETURN,
  portions, resolveFlip, settleFlip, winOf, bankMax, toRot,
  sideMult, orientMult, spinsMult, countFor, spinPool,
} from './economy.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const PLAYERS = +arg('players', 4000);
const DAYS = +arg('days', 730);
const SEED = arg('seed', 'coinflip-loan-1');
const TIERS = { common: 1500, rare: 6000, epic: 15000, mythic: 50000 };

// ---- stats ----------------------------------------------------------------
const sortNum = (a) => [...a].sort((x, y) => x - y);
function q(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const pct = (n) => (100 * n).toFixed(1) + '%';

// ===========================================================================
// THE TWO NEW PRESETS
// ===========================================================================

/** The calls actually on the board, before any weighting. Mirrors the preview. */
function placedBets(bet) {
  if (bet.side === 'Edge') return [{ key: 'side', mult: MULT.edge }];
  const list = [];
  if (bet.side) list.push({ key: 'side', mult: sideMult(bet) });
  if ((bet.orient || []).length) list.push({ key: 'orient', mult: orientMult(bet) });
  if (bet.spins) list.push({ key: 'spins', mult: spinsMult(bet) });
  return list.filter((x) => x.mult > 1);
}

/**
 * SPREAD. w proportional to 1/mult is the ONLY split where every call that
 * lands pays the same, so no line can win and leave the player poorer.
 */
function spreadPort(bet) {
  const b = placedBets(bet);
  if (!b.length) return [];
  const inv = b.map((x) => 1 / x.mult);
  const s = inv.reduce((a, c) => a + c, 0);
  b.forEach((x, i) => { x.w = inv[i] / s; });
  return b;
}
const spreadK = (bet) => {
  const b = placedBets(bet);
  return b.length ? 1 / b.map((x) => 1 / x.mult).reduce((a, c) => a + c, 0) : 0;
};

/**
 * RIDE, priced on the true joint probability by enumerating the 32 x 4 outcome
 * space. It CANNOT be the product of the marginals: side is spin PARITY read
 * against the shown start face, so "Heads" beside an even-parity line is one
 * call wearing two hats. Multiplying would post 256x on a 128x event.
 *
 * A consequence the preview handles by greying RIDE out: half of all
 * side + exact-spin pairings are CONTRADICTORY given the day's start face. A
 * rational player flips their side call rather than betting the impossible, so
 * that is what is modelled — `rideSideFor` picks the compatible side.
 */
function rideSideFor(bet, startHeads) {
  if (bet.side === 'Edge' || !bet.spins) return bet.side;
  // an exact line pins the parity; a ranged line does not, so leave it alone
  if (bet.spins.mode !== 'exact') return bet.side;
  const hf = Math.round(bet.spins.line * 2);
  const landsHeads = (hf % 2 === 0) ? startHeads : !startHeads;
  return landsHeads ? 'Heads' : 'Tails';
}
function rideProb(bet, startHeads) {
  const b = placedBets(bet);
  if (!b.length) return 0;
  if (bet.side === 'Edge') return EDGE_P;
  let n = 0;
  for (const sp of SPIN_VALUES) {
    for (const qd of QUADS) {
      const side = ((sp % 2 === 0) === startHeads) ? 'Heads' : 'Tails';
      const atom = { spins: sp, quadrant: qd, side, edge: false };
      if (b.every((x) => winOf(x, bet, atom))) n++;
    }
  }
  return n / (SPIN_N * QUADS.length);
}

/**
 * What a stake returns under each preset. SPREAD pays K per winning call;
 * RIDE pays its multiplier if every call landed and nothing otherwise. A rim
 * landing sweeps both, which is where the uniform 0.20% edge comes from.
 */
function settlePreset(preset, bet, flip, stake, startHeads) {
  if (preset === 'ride') {
    const live = { ...bet, side: rideSideFor(bet, startHeads) };
    const b = placedBets(live);
    if (!b.length) return 0;
    const p = rideProb(live, startHeads);
    if (p <= 0) return Math.round(stake);          // unplaceable: no bet, stake untouched
    const won = b.every((x) => winOf(x, live, flip));
    return Math.round(won ? stake * (1 / p) : 0);
  }
  const port = spreadPort(bet);
  if (!port.length) return Math.round(stake);
  const K = spreadK(bet);
  const wins = port.filter((x) => winOf(x, bet, flip)).length;
  return Math.round(K * stake * wins);
}

// ===========================================================================
// THE LOAN VARIANTS
// ===========================================================================
// Every variant answers the same three questions differently:
//   how much do you receive on a bust, does it create debt, and how fast does
//   banking repay it.
//
// `grace` exists because a literal "loan against your bank" CANNOT work at
// onboarding: a new player has 0 wallet and 0 bank, and the Broke Flip is the
// documented entry path. Something has to be given before anything can be lent.
const VARIANTS = {
  baseline: {
    label: 'baseline (free 50, no debt)',
    amount: () => FREE_BET_RETURN, debtRate: 0, grace: Infinity, cap: Infinity,
  },
  debt100: {
    label: 'debt, banking repays 100%',
    amount: () => FREE_BET_RETURN, debtRate: 1, grace: 0, cap: Infinity,
  },
  debt50: {
    label: 'debt, banking repays 50%',
    amount: () => FREE_BET_RETURN, debtRate: 0.5, grace: 0, cap: Infinity,
  },
  debt25: {
    label: 'debt, banking repays 25%',
    amount: () => FREE_BET_RETURN, debtRate: 0.25, grace: 0, cap: Infinity,
  },
  grace5: {
    label: 'first 5 busts free, then 100% debt',
    amount: () => FREE_BET_RETURN, debtRate: 1, grace: 5, cap: Infinity,
  },
  cap500: {
    label: '100% debt, capped at 500',
    amount: () => FREE_BET_RETURN, debtRate: 1, grace: 0, cap: 500,
  },
  shrink: {
    // The free amount decays with each bust instead of creating debt. No ledger,
    // no UI for owing money — the safety net just gets thinner the more you
    // lean on it, and recovers nothing.
    label: 'no debt; free amount shrinks 50 -> 10 with busts',
    amount: (busts) => Math.max(10, Math.round(FREE_BET_RETURN * Math.pow(0.85, busts))),
    debtRate: 0, grace: Infinity, cap: Infinity,
  },

  // -----------------------------------------------------------------------
  // THE DAILY BANKING CAP — aimed at the ratchet instead of the floor.
  //
  // Added after the loan variants above all failed. The convexity is Jensen's
  // inequality on a RATCHET: what accumulates is E[max(balance - floor, 0)],
  // which is convex in the return, so at fixed EV more variance is strictly
  // more money. Debt does not touch that shape at all — it just subtracts a
  // constant. Capping how much can leave the table PER DAY does touch it: a
  // 12,800 jackpot can no longer be banked in one motion, so the surplus has to
  // sit in the wallet being risked, and the ratchet stops paying for spikes.
  // -----------------------------------------------------------------------
  cap100: { label: 'no debt; bank at most 100/day', amount: () => FREE_BET_RETURN, debtRate: 0, grace: Infinity, cap: Infinity, bankCap: 100 },
  cap250: { label: 'no debt; bank at most 250/day', amount: () => FREE_BET_RETURN, debtRate: 0, grace: Infinity, cap: Infinity, bankCap: 250 },
  cap100debt: { label: 'bank at most 100/day + 100% debt', amount: () => FREE_BET_RETURN, debtRate: 1, grace: 0, cap: Infinity, bankCap: 100 },
};

// ---- banking policies -----------------------------------------------------
const never = () => 0;
const toFloor = (w) => bankMax(w);
const half = (w) => Math.floor(bankMax(w) / 2);

// ---- one player -----------------------------------------------------------
/**
 * @param {object} v      loan variant
 * @param {string} preset 'spread' | 'ride' | 'legacy'
 */
function simulatePlayer(arch, rng, days, v, preset) {
  let wallet = 0, banked = 0, debt = 0;
  let busts = 0, brokeDays = 0, brokeWins = 0, lent = 0, repaid = 0;
  let daysInDebt = 0, firstBust = null, everCleared = null;
  const tierDay = {};
  const debtAt = {};                 // debt on selected days, for the onboarding view

  for (let d = 1; d <= days; d++) {
    if (d <= 30) debtAt[d] = debt;

    if (wallet <= 0) {
      // THE BROKE FLIP. Heads or tails, no upgrades, and a rim landing sweeps
      // it too, so it wins 0.499 of the time rather than 0.5. It consumes the
      // daily flip whether it lands or not.
      const flip = resolveFlip(rng);
      const won = !flip.edge && flip.side === 'Heads';
      brokeDays++;
      if (won) {
        brokeWins++;
        const amt = v.amount(busts);
        wallet = amt;
        // Debt is only created by money actually RECEIVED. Losing the broke
        // flip hands over nothing, so it cannot put the player in the red.
        if (v.debtRate > 0 && brokeWins > v.grace) {
          debt = Math.min(v.cap, debt + amt);
          lent += amt;
        }
      }
      if (debt > 0) daysInDebt++;
      continue;
    }

    // Banking happens during the cooldown, BEFORE the flip goes live. Debt is
    // settled out of it first: the player is repaying with money they were
    // taking off the table anyway, so the loan costs them TIME rather than
    // wallet, and never pushes them below the floor.
    let amt = arch.bank(wallet);
    // The cap limits how much can leave the table in one day. What it does NOT
    // do is protect the surplus: the remainder stays in the wallet and rides,
    // which is the entire point — a jackpot can no longer be locked away in one
    // motion, so it has to survive more flips to be kept.
    if (v.bankCap !== undefined) amt = Math.min(amt, v.bankCap);
    if (amt > 0) {
      wallet -= amt;
      let toBank = amt;
      if (debt > 0) {
        const pay = Math.min(debt, Math.floor(amt * v.debtRate));
        debt -= pay; repaid += pay; toBank -= pay;
        if (debt === 0 && everCleared === null) everCleared = d;
      }
      banked += toBank;
      for (const [tier, cost] of Object.entries(TIERS)) {
        if (tierDay[tier] === undefined && banked >= cost) tierDay[tier] = d;
      }
    }
    if (debt > 0) daysInDebt++;

    const flip = resolveFlip(rng);
    const startHeads = flip.startFace === 'Heads';
    const end = preset === 'legacy'
      ? settleFlip(arch.port, arch.bet, flip, wallet)
      : settlePreset(preset, arch.bet, flip, wallet, startHeads);
    if (end <= 0) { busts++; if (firstBust === null) firstBust = d; }
    wallet = end;
  }
  return {
    banked, wallet, debt, busts, brokeDays, brokeWins, lent, repaid,
    daysInDebt, firstBust, everCleared, tierDay, debtAt,
  };
}

function runCohort(arch, v, preset, players, days, tag) {
  const rows = [];
  for (let p = 0; p < players; p++) {
    rows.push(simulatePlayer(arch, makeRng(SEED, `${tag}::${p}`), days, v, preset));
  }
  return rows;
}

// ===========================================================================
// SELF-TEST: reproduce the baseline before believing anything
// ===========================================================================
console.log('=== (0) SELF-TEST: does this harness reproduce sim/population.mjs? ===');
{
  // population.mjs's grind-3ax-even: THREE_AXIS board at t=0.5, bank to floor.
  // Its published numbers are banked median 7,502 and 42.3% of days broke. If
  // this file cannot land on those with the same seed labels, its loan numbers
  // are worthless and nothing below should be read.
  const bet = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };
  const arch = { name: 'grind-3ax-even', bet, port: portions(bet, 0.5), bank: toFloor };
  const rows = [];
  for (let p = 0; p < 5000; p++) {
    rows.push(simulatePlayer(arch, makeRng('coinflip-pop-1', `grind-3ax-even::${p}`),
      730, VARIANTS.baseline, 'legacy'));
  }
  const med = q(sortNum(rows.map((x) => x.banked)), 0.5);
  const brokePct = 100 * mean(rows.map((x) => x.brokeDays)) / 730;
  const neverBust = rows.filter((x) => x.firstBust === null).length;
  console.log(`  banked median   ${fmt(med)}   (population.mjs published 7,502)`);
  console.log(`  % of days broke ${brokePct.toFixed(1)}%  (published 42.3%)`);
  console.log(`  never busted    ${(100 * neverBust / rows.length).toFixed(1)}%  (published 0.0%)`);
  const okMed = Math.abs(med - 7502) < 1;
  const okBroke = Math.abs(brokePct - 42.3) < 0.15;
  if (!okMed || !okBroke) {
    console.log('\n  *** HARNESS DOES NOT REPRODUCE THE BASELINE. Everything below is void. ***');
    process.exit(1);
  }
  console.log('  reproduced exactly — the debt ledger is additive, it did not disturb the base rules.\n');
}

// ===========================================================================
console.log('=== (1) WHERE THE MONEY ACTUALLY COMES FROM ===');
console.log('Before judging the loan, ask what it is lending. Over a career, how much');
console.log('₿ enters the economy through the Broke Flip versus how much a player banks?\n');
{
  const bet = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };
  const rows = [];
  for (const [name, b] of [
    ['grind-side', { side: 'Heads', orient: [], spins: null }],
    ['grind-3ax-even', bet],
    ['edge-chaser', { side: 'Edge', orient: [], spins: null }],
  ]) {
    const arch = { name, bet: b, port: portions(b, 0.5), bank: toFloor };
    const r = runCohort(arch, VARIANTS.baseline, 'legacy', 2000, DAYS, `src::${name}`);
    const injected = r.map((x) => x.brokeWins * FREE_BET_RETURN);
    const banked = r.map((x) => x.banked);
    rows.push({
      archetype: name,
      'free ₿ injected (median)': fmt(q(sortNum(injected), 0.5)),
      'banked (median)': fmt(q(sortNum(banked), 0.5)),
      'banked / injected': (q(sortNum(banked), 0.5) / q(sortNum(injected), 0.5)).toFixed(2),
    });
  }
  console.table(rows);
  console.log('  *** THE ECONOMY IS FUNDED BY THE BROKE FLIP. *** Banked lifetime earnings are');
  console.log('  roughly equal to the free ₿ handed out — the player is not beating the game,');
  console.log('  they are passing the safety net through the wallet and banking what survives.');
  console.log('  That is why a 100% loan is not a tweak: it reclaims the ENTIRE money supply.');
}

// ===========================================================================
console.log('\n=== (2) DOES THE CONVEXITY DIE? high-variance vs low-variance, per variant ===');
console.log('The test that matters. Under the baseline, cranking variance is strictly');
console.log('better. A fix works if that stops being true — and OVER-corrects if it');
console.log('reverses, making the wild board strictly worse instead of merely wilder.\n');
{
  const SAFE = { side: 'Heads', orient: ['NE', 'SE'], spins: { line: 11.5, mode: 'gt' } }; // 2/2/2
  const WILD = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };     // 2/4/32
  const rows = [];
  for (const [key, v] of Object.entries(VARIANTS)) {
    const out = {};
    for (const [label, b] of [['safe', SAFE], ['wild', WILD]]) {
      const arch = { name: label, bet: b, port: portions(b, 0.5), bank: toFloor };
      const r = runCohort(arch, v, 'spread', PLAYERS, DAYS, `conv::${key}::${label}`);
      out[label] = q(sortNum(r.map((x) => x.banked)), 0.5);
    }
    const ratio = out.safe > 0 ? out.wild / out.safe : (out.wild > 0 ? Infinity : 1);
    rows.push({
      variant: v.label,
      'safe board banked': fmt(out.safe),
      'wild board banked': fmt(out.wild),
      'wild / safe': Number.isFinite(ratio) ? ratio.toFixed(2) : '∞',
      verdict: !Number.isFinite(ratio) ? 'BOTH DEAD'
        : ratio > 1.25 ? 'variance still pays'
          : ratio < 0.8 ? 'OVER-CORRECTED' : 'neutral',
    });
  }
  console.table(rows);
}

// ===========================================================================
console.log('\n=== (3) SPREAD vs RIDE under each variant ===');
console.log('The presets that shipped. RIDE is the maximum-variance expression of a board;');
console.log('if it still banks more, the fix has not reached the thing it was aimed at.\n');
{
  const BOARD = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };
  const arch = { name: 'board', bet: BOARD, port: portions(BOARD, 0.5), bank: toFloor };
  const rows = [];
  for (const [key, v] of Object.entries(VARIANTS)) {
    const s = runCohort(arch, v, 'spread', PLAYERS, DAYS, `pre::${key}::spread`);
    const r = runCohort(arch, v, 'ride', PLAYERS, DAYS, `pre::${key}::ride`);
    const sm = q(sortNum(s.map((x) => x.banked)), 0.5);
    const rm = q(sortNum(r.map((x) => x.banked)), 0.5);
    const sEpic = s.filter((x) => x.banked >= TIERS.epic).length / s.length;
    const rEpic = r.filter((x) => x.banked >= TIERS.epic).length / r.length;
    rows.push({
      variant: v.label,
      'SPREAD banked': fmt(sm), 'RIDE banked': fmt(rm),
      'RIDE / SPREAD': sm > 0 ? (rm / sm).toFixed(2) : '∞',
      'SPREAD epic': pct(sEpic), 'RIDE epic': pct(rEpic),
    });
  }
  console.table(rows);
}

// ===========================================================================
console.log('\n=== (4) DOES THE LOOP GET BETTER OR WORSE? ===');
console.log('A fix that kills the exploit and makes the game more miserable has failed.');
console.log('Baseline: ~42% of days broke, 0% survive two years without busting.\n');
{
  const BOARD = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };
  const arch = { name: 'board', bet: BOARD, port: portions(BOARD, 0.5), bank: toFloor };
  const rows = [];
  for (const [key, v] of Object.entries(VARIANTS)) {
    const r = runCohort(arch, v, 'spread', PLAYERS, DAYS, `loop::${key}`);
    rows.push({
      variant: v.label,
      '% days broke': (100 * mean(r.map((x) => x.brokeDays)) / DAYS).toFixed(1) + '%',
      '% days in debt': (100 * mean(r.map((x) => x.daysInDebt)) / DAYS).toFixed(1) + '%',
      'busts (median)': q(sortNum(r.map((x) => x.busts)), 0.5),
      'ended owing (median)': fmt(q(sortNum(r.map((x) => x.debt)), 0.5)),
      'never cleared debt': pct(r.filter((x) => x.lent > 0 && x.debt > 0).length / r.length),
    });
  }
  console.table(rows);
}

// ===========================================================================
console.log('\n=== (5) THE NEW PLAYER: first 30 days ===');
console.log('A beginner starts at 0 wallet and 0 bank. Do they escape, or open the app on');
console.log('day 20 owing money and having banked nothing? Distribution, not the mean.\n');
{
  const BOARD = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };
  const arch = { name: 'board', bet: BOARD, port: portions(BOARD, 0.5), bank: toFloor };
  const rows = [];
  for (const [key, v] of Object.entries(VARIANTS)) {
    const r = runCohort(arch, v, 'spread', PLAYERS, 30, `new::${key}`);
    const d30 = sortNum(r.map((x) => x.debt));
    const b30 = sortNum(r.map((x) => x.banked));
    rows.push({
      variant: v.label,
      'owing @30 p50': fmt(q(d30, 0.5)),
      'owing @30 p90': fmt(q(d30, 0.9)),
      'banked @30 p50': fmt(q(b30, 0.5)),
      'banked @30 p90': fmt(q(b30, 0.9)),
      'banked nothing': pct(r.filter((x) => x.banked === 0).length / r.length),
    });
  }
  console.table(rows);
}

// ===========================================================================
console.log('\n=== (6) TIME TO EACH COSMETIC TIER ===');
console.log('Epic is DESIGNED to be out of reach for safe grinding, forcing players to ride.');
console.log('A fix that puts it out of reach of every route breaks the store instead.\n');
{
  const BOARD = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };
  const arch = { name: 'board', bet: BOARD, port: portions(BOARD, 0.5), bank: toFloor };
  const rows = [];
  for (const [key, v] of Object.entries(VARIANTS)) {
    const row = { variant: v.label };
    for (const preset of ['spread', 'ride']) {
      const r = runCohort(arch, v, preset, PLAYERS, DAYS, `tier::${key}::${preset}`);
      for (const [tier, cost] of Object.entries(TIERS)) {
        if (tier === 'common' || tier === 'epic') {
          row[`${preset} ${tier}`] = pct(r.filter((x) => x.banked >= cost).length / r.length);
        }
      }
    }
    rows.push(row);
  }
  console.table(rows);
}

// ===========================================================================
console.log('\n=== (7) DOES THE LOAN BECOME A SECOND HOUSE EDGE? ===');
{
  // The loan must not quietly change the per-flip odds. It touches the WALLET
  // between flips, never the settlement, so per-flip EV cannot move — but that
  // is a claim worth checking rather than asserting.
  const BOARD = { side: 'Heads', orient: ['NE'], spins: { line: 9.5, mode: 'exact' } };
  const N = 2_000_000;
  const rows = [];
  for (const preset of ['spread', 'ride']) {
    const rng = makeRng(SEED, 'edge::' + preset);
    let staked = 0, returned = 0, sumSq = 0;
    for (let i = 0; i < N; i++) {
      const flip = resolveFlip(rng);
      const startHeads = flip.startFace === 'Heads';
      const r = settlePreset(preset, BOARD, flip, 1000, startHeads) / 1000;
      staked += 1; returned += r; sumSq += r * r;
    }
    const m = returned / staked;
    const sd = Math.sqrt(Math.max(sumSq / N - m * m, 0));
    const se3 = 3 * sd / Math.sqrt(N);
    const edge = 1 - m;
    // ERROR BARS ARE NOT OPTIONAL, and my first pass proved it: RIDE pays 128x
    // on a 1-in-128 shot, so its per-flip sd is ~11 and 2M flips resolve the
    // mean only to +/-2.4%. A 0.2% edge is far inside that. Flagging "CHECK" on
    // a raw difference reported a fabricated finding — the bar was wrong, not
    // the code.
    rows.push({
      preset,
      'measured edge': (100 * edge).toFixed(3) + '%',
      '+/- 3 sigma': (100 * se3).toFixed(3) + '%',
      'design 0.200%': Math.abs(edge - EDGE_P) <= se3 ? 'consistent' : 'INCONSISTENT',
    });
  }
  console.table(rows);
  console.log(`  ${N.toLocaleString()} flips each. The loan moves money between flips and never`);
  console.log('  touches the settlement, so it cannot change the per-flip edge. RIDE cannot be');
  console.log('  resolved to 0.2% at this N — its error bar says so rather than pretending.');
}

console.log(`\n########## seed "${SEED}" · ${PLAYERS} players · ${DAYS} days ##########`);
