# sim/ — the population simulation

Pure logic, no renderer, no DOM. Answers whether the economy works with numbers
instead of intuition.

```
node sim/selftest.mjs                          # must pass before anything else
node sim/population.mjs                        # 5,000 players x 730 days x 12 archetypes
node sim/population.mjs --players N --days N --seed S
```

Seeded and reproducible: same `--seed`, same output, byte for byte. Nothing calls
`Math.random()` or reads the clock. Default run: seed `coinflip-pop-1`,
5,000 players, 730 days, 12 archetypes = 43.8M simulated player-days, **7.1 s**.

| file | what |
|---|---|
| `economy.js` | the rules, ported from `coinflip-preview.html`. Preview names kept so the two diff by eye. |
| `selftest.mjs` | 9 sections. `population.mjs` refuses to print an economic finding until these pass. |
| `population.mjs` | archetypes, the tier/bust tables, and the four focused experiments. |

**The one deliberate departure from the preview:** it draws outcomes by hashing a
seed (4x SHA-256 + BigInt per flip), which is right for a verifiable game and far
too slow for 10^8 flips. This draws the *same distributions* from a seeded PRNG.
Checked in selftest §6 — including that `k/100000 < 1/500` is true for exactly
k ∈ 0..199, so the modulo introduces no bias that would have to be modelled.

---

## Two findings that threaten the design

### 1. The Spread is EV-neutral per flip but NOT neutral over a career

The design doc says the Spread "moves volatility only, never the edge — provably
can't be gamed". **Per flip that is exactly true.** Section (4) confirms it over
3M common-random-number flips per slider position: every paired difference
against t=0.5 sits inside 3σ of zero, while volatility swings 6.3× (sd 0.86 → 5.46).
The closed form in selftest §3 is stronger still — EV is `1 − EDGE_P` to 2.2e-16
at *every* t, for every bet shape.

**Over a career it is false.** Same board, same banking policy, 8,000 paired
players, 730 days:

| t | banked median | 95% CI on median | reached EPIC (15,000) |
|---|---|---|---|
| 0 | 7,685 | 7,668 – 7,704 | 0.0% |
| 0.5 | **7,520** | 7,472 – 7,564 | **0.0%** |
| 0.8 | 8,844 | 8,811 – 8,895 | 5.6% |
| 1 | **10,727** | 10,690 – 10,730 | **18.8%** |

The confidence intervals on t=0.5 and t=1 do not overlap. Cranking the Spread to
maximum banks **43% more** and is the difference between epic being unreachable
and 1-in-5 reaching it.

**Why.** A career is not one flip. Banking is a *ratchet* — banked ₿ can never be
lost — and the Broke Flip puts a *floor* under losing: bust and you are handed 50 ₿
back for free. Gains are kept permanently; losses stop at zero and are refunded.
Under that asymmetry variance is not free, it is an asset. Note also the slider is
**U-shaped**: the midpoint is the *worst* setting for both median banked and
rare-tier reachability, and the midpoint is the default.

This does not break fairness — the house edge is untouched. It breaks the claim
that the slider is a pure preference dial with no correct answer.

### 2. At high Spread a WINNING line can round to a bust

At t=1 the weights are `0.00383 / 0.01533 / 0.98084`, so the Side line carries
0.38% of the wallet. Win **only** Side from a 50 ₿ wallet:

```
return = 0.383 ₿  ->  Math.round()  ->  0 ₿   // a bust, on a flip the player won
```

The Side line does not start paying anything until the wallet reaches **66 ₿**.
This bites hardest at exactly 50 — the `WALLET_FLOOR`, which is the most common
wallet in the game, since bank-to-floor players live there and every Broke Flip
recovery returns to it.

The staged reveal will colour the Side row green and then land the running total
on 0 ₿. It reads as a bug to the player because it is one. Found by section (7)
contradicting a claim written directly above it (that P(bust) cannot depend on
wallet size — true for every other board, false for this one).

---

## The other questions

**Is epic unreachable by safe banking?** Yes — the design's claim holds. Every
grinding archetype reaches 0% epic in two years. `grind-side` banks the most of
any safe strategy at 4,525/yr (the doc's "~6,000/yr" is optimistic by ~25%),
putting epic at ~3.3 years and mythic at ~11 years of pure grinding. Epic is only
reached by taking real variance: `grind-3ax-wild` 18%, `edge-chaser` 39%.

**Mythic (50,000)?** Essentially unreachable — 0% for every archetype except
`ride-to-20000` (5%) and `edge-chaser` (1%).

**Never-banking is strictly dominated.** `ride-side` and `ride-3ax-even` bank 0,
so they can buy *nothing, ever* — and they bust just as often as the grinders
(182 vs 182 median busts). Riding buys no wallet growth because of the next point.

**Bust frequency, and the treadmill.** Nobody escapes: 0.0% of players in every
archetype went 730 days without busting. Median busts: 182 (side-only), 154
(3-axis), 242 (edge). **50.2% of all days are spent broke** for a side-only
player, 42.3% for a 3-axis one. First bust arrives on day 3–4. The Broke Flip
itself only wins 0.499 — a rim landing sweeps it too — so recovery averages 2
days. This is a treadmill, not a safety net: half the calendar is the broke screen.

**Why nobody gets rich.** The whole wallet rides daily, so a bust is just "every
line lost" — an event whose probability does not depend on how much is on the
table. P(bust) is *identical* from a 50 ₿ wallet and a 50,000 ₿ wallet (36.34% on
a 3-axis board). The wallet is a multiplicative walk against an absorbing barrier
it meets at a constant rate, so it has a hard practical ceiling and the expensive
tiers are reachable only by banking.

**Is the edge 0.20%?** Consistent with it on every axis, and it is 0.20% by
construction — one source, the rim sweep, and `mult × P(win) = 1 − EDGE_P`
identically on all three axes. Worth noting what measurement *can't* do here:
resolving 0.2% on the 32× spin axis needs ~10⁸ flips (3σ is ±0.83% at 4M), so
that row is reported with its error bar rather than as a finding.

---

## Preview vs context doc

No contradictions found — the doc's §2/§3 match `coinflip-preview.html` on every
rule modelled. Two places where the doc is *incomplete* rather than wrong:

- "~6,000/yr safe banking" — measured 4,525/yr for the safest archetype.
- "EV is identical at every position … provably can't be gamed" — true per flip,
  and the per-career case is not addressed. See finding 1.
