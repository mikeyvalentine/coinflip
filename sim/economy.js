// sim/economy.js
// ---------------------------------------------------------------------------
// The economy, ported from coinflip-preview.html's <script> block. The preview
// is the source of truth for gameplay; this file exists only so the same rules
// can be run tens of millions of times without a browser.
//
// NAMES ARE KEPT FROM THE PREVIEW ON PURPOSE — SPIN_VALUES, MULT, EDGE_P,
// spreadWeights, portions, winOf, resolveSide, resolveSpins, bankMax — so the
// two files can be diffed by eye. Change one, change the other.
//
// THE ONE DELIBERATE SUBSTITUTION. The preview draws every outcome by hashing a
// seed (sha256 -> BigInt -> modulo). That is right for a game: it is verifiable
// and commit/reveal-able. It is wrong for a simulation that needs ~10^8 flips,
// because each draw is four SHA-256s and a BigInt parse. Every one of those
// draws is uniform by construction over a known range, so this file draws THE
// SAME DISTRIBUTIONS from a seeded PRNG instead:
//
//   preview                                    here
//   sha('start::')  % 2                        rng.f() < 0.5
//   sha('spins::')  % 32                       rng.int(0, 31)
//   sha('orient::') % 36000 / 100              rng.int(0, 35999) / 100
//   sha('edge::')   % 100000 / 100000 < 1/500  rng.int(0, 99999) / 100000 < 1/500
//
// Distributionally identical, and it is the only place this file knowingly
// departs from the preview. Note the edge draw in particular: k/100000 < 0.002
// is true for k in 0..199, i.e. exactly 200/100000 = 1/500, so the modulo does
// NOT introduce a bias that would have to be modelled.
// ---------------------------------------------------------------------------

// ---- axis + integer multipliers (derived from true odds) -----------------
// Outcome library EXCLUDES the median value (24), giving N=32 clean outcomes.
export const SPIN_MIN = 8, SPIN_MAX = 40, MEDIAN = 24;
export const SPIN_VALUES = [];
for (let s = SPIN_MIN; s <= SPIN_MAX; s++) { if (s !== MEDIAN) SPIN_VALUES.push(s); }
export const SPIN_N = SPIN_VALUES.length;   // 32

export const ROT_MIN = SPIN_MIN / 2, ROT_MAX = SPIN_MAX / 2, ROT_MEDIAN = MEDIAN / 2;
export const toRot = (hf) => hf / 2;
export const toHalf = (rot) => Math.round(rot * 2);
export const FREE_BET_RETURN = 50;

export const MULT = { side: 2, orientation: 4, edge: 499 };
export const EDGE_P = 1 / 500;

export const WALLET_FLOOR = 50;
export const QUADS = ['NE', 'SE', 'SW', 'NW'];

// ---- risk spread ---------------------------------------------------------
export const SPREAD_A = 2;
export function spreadWeights(mults, t) {
  const a = SPREAD_A * (2 * t - 1);
  const raw = mults.map((m) => Math.pow(m, a));
  const s = raw.reduce((x, y) => x + y, 0);
  return raw.map((r) => r / s);
}

// ---- spin line pricing ---------------------------------------------------
export function spinPool() { return SPIN_VALUES.map(toRot); }
export function countFor(line, mode, pool) {
  return mode === 'gt' ? pool.filter((x) => x > line).length
    : mode === 'lt' ? pool.filter((x) => x < line).length
      : pool.filter((x) => x === line).length;
}
export function spinMultFor(line, mode, pool = spinPool()) {
  const c = countFor(line, mode, pool);
  return c ? pool.length / c : 0;
}
export function validLine(v) {
  return Number.isFinite(v) && v >= ROT_MIN && v <= ROT_MAX && v !== ROT_MEDIAN
    && Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;
}

// ---- the bet -------------------------------------------------------------
// { side:'Heads'|'Tails'|'Edge'|null, orient:string[], spins:{line,mode}|null }
export const sideMult = (bet) => (bet.side === 'Edge' ? MULT.edge : MULT.side);
export function orientMult(bet) {
  const k = (bet.orient || []).length;
  return (k === 0 || k === 4) ? 1 : 4 / k;
}
export const spinsMult = (bet) => (!bet.spins ? 0 : spinMultFor(bet.spins.line, bet.spins.mode));

/** Faithful port of the preview's portions(). `t` replaces riskT(). */
export function portions(bet, t) {
  const list = [];
  if (bet.side) list.push({ key: 'side', mult: sideMult(bet) });
  if ((bet.orient || []).length) list.push({ key: 'orient', mult: orientMult(bet) });
  if (bet.spins) list.push({ key: 'spins', mult: spinsMult(bet) });
  // Calling Edge puts the WHOLE stake on the rim; the other axes are locked out.
  if (bet.side === 'Edge') return [{ key: 'side', mult: MULT.edge, w: 1 }];
  // A 1x "bet" hands the stake straight back — covering all four quadrants is a
  // refund, not a wager, and is excluded from the spread entirely.
  const live = list.filter((x) => x.mult > 1);
  if (!live.length) return live;
  const w = spreadWeights(live.map((x) => x.mult), t);
  live.forEach((x, i) => { x.w = w[i]; });
  return live;
}

// ---- the flip ------------------------------------------------------------
/** @param {{f:()=>number,int:(a:number,b:number)=>number}} rng */
export function resolveFlip(rng, edgeP = EDGE_P) {
  const startHeads = rng.f() < 0.5;
  const spins = SPIN_VALUES[rng.int(0, SPIN_N - 1)];
  const landsHeads = (spins % 2 === 0) ? startHeads : !startHeads;
  const orientationDeg = rng.int(0, 35999) / 100;
  const quadrant = QUADS[Math.floor(orientationDeg / 90)];
  const edge = (rng.int(0, 99999) / 100000) < edgeP;
  return {
    startFace: startHeads ? 'Heads' : 'Tails',
    side: landsHeads ? 'Heads' : 'Tails',
    spins, orientationDeg, quadrant, edge,
  };
}

export function resolveSide(bet, flip) {
  return bet.side === 'Edge' ? !!flip.edge : (!flip.edge && bet.side === flip.side);
}
export const resolveOrient = (bet, flip) => (bet.orient || []).includes(flip.quadrant);
export function resolveSpins(bet, flip) {
  const landed = toRot(flip.spins);
  const { line, mode } = bet.spins;
  return mode === 'gt' ? landed > line : mode === 'lt' ? landed < line : landed === line;
}
/** a rim landing sweeps the table — the only thing that can win is calling Edge */
export function winOf(x, bet, flip) {
  if (x.key === 'side') return resolveSide(bet, flip);
  if (flip.edge) return false;
  return x.key === 'orient' ? resolveOrient(bet, flip) : resolveSpins(bet, flip);
}

/**
 * What comes back, in ₿, for a stake of `stake`.
 *
 * Deliberately the preview's INCREMENTAL form (revealResults' running total)
 * rather than the algebraically equal `sum(w*mult*won)`. The two differ in the
 * last bits of floating point, and since the result is then Math.round()ed into
 * an integer balance, a stake sitting exactly on a .5 boundary could round the
 * other way. Matching the arithmetic, not just the algebra, keeps the sim on the
 * same side of every such boundary as the game.
 */
export function returnedFor(port, bet, flip, stake) {
  let running = stake;
  for (const x of port) {
    running += winOf(x, bet, flip) ? x.w * stake * (x.mult - 1) : -(x.w * stake);
  }
  return Math.max(0, running);
}

/** The preview's doFlip() balance update: endBalance = round(start - risk + returned). */
export function settleFlip(port, bet, flip, startBalance) {
  const returned = returnedFor(port, bet, flip, startBalance);
  return Math.round(startBalance - startBalance + returned);
}

// ---- banking -------------------------------------------------------------
export const bankMax = (balance) => Math.max(0, Math.round(balance) - WALLET_FLOOR);

// ---- analytic truth, for the self-tests ----------------------------------
/**
 * P(this portion wins), in closed form. Used ONLY to check the simulation
 * against arithmetic that does not share its code path — a sim validated
 * against itself proves nothing.
 */
export function winProbOf(x, bet, edgeP = EDGE_P) {
  if (x.key === 'side') return bet.side === 'Edge' ? edgeP : (1 - edgeP) * 0.5;
  if (x.key === 'orient') return (1 - edgeP) * ((bet.orient || []).length / 4);
  const c = countFor(bet.spins.line, bet.spins.mode, spinPool());
  return (1 - edgeP) * (c / SPIN_N);
}
/** EV of the whole bet as a multiple of stake. Should be exactly 1 - edgeP. */
export function evOf(port, bet, edgeP = EDGE_P) {
  return port.reduce((s, x) => s + x.w * x.mult * winProbOf(x, bet, edgeP), 0);
}
