# The Broke Flip loan — measured, and it does not work

`node sim/loan.mjs [--players N] [--days N] [--seed S]`
Seed `coinflip-loan-1`, 1,200–2,000 players × 730 days × 10 variants.
Section (0) refuses to proceed unless it reproduces `population.mjs`'s published
baseline (banked median 7,502, 42.3% broke days) — it does, exactly.

---

## Recommendation: do not ship the loan

It fails at the thing it was aimed at and wrecks the thing that was working.

| | baseline | 100% debt |
|---|---|---|
| banked, median | 7,616 | **540** (−93%) |
| never clear their debt | — | **97.8%** |
| new players banking nothing by day 30 | 0.0% | **33.9%** |
| variance advantage (wild ÷ safe board) | 2.09× | **1.74×** |
| % of days broke | 42.3% | **42.4%** |

It destroys 93% of the economy to move the exploit from 2.09× to 1.74×, and it
does not touch the broke-day problem at all.

---

## Why it fails: the economy is funded BY the Broke Flip

This is the finding everything else follows from.

| archetype | free ₿ injected (median) | banked (median) | ratio |
|---|---|---|---|
| grind-side | 9,150 | 9,050 | **0.99** |
| grind-3ax-even | 7,700 | 7,586 | **0.99** |

**Players bank almost exactly what they were given.** Nobody is beating the
game — they are passing the safety net through the wallet and banking whatever
survives the trip. Lifetime "earnings" are the Broke Flip's handouts, laundered.

So a 100% loan does not tax the exploit. It reclaims the entire money supply.
The ledger, traced directly:

| board | busts | gross banked | free ₿ lent | debt repaid | net banked |
|---|---|---|---|---|---|
| safe 2/2/2 | 73 | 3,654 | 3,750 | 3,289 | **286** |
| wild 2/4/32 | 153 | 7,583 | 7,700 | 6,507 | **982** |

Lent ≈ gross banked, for both. What survives repayment is only the sliver by
which each strategy beat its own injections — **and that sliver still scales
with variance**. Absolute wealth collapses ~93%; the ratio does not reliably
move. Under the SPREAD preset it compresses 2.09 → 1.74; under the legacy
pricing it *widens* 2.08 → 3.43. Direction depends on the pricing; the damage
does not.

---

## Every variant tested

| variant | wild ÷ safe | banked (median) | % days broke | verdict |
|---|---|---|---|---|
| baseline (free 50) | 2.09× | 7,616 | 42.3% | the exploit |
| debt, repay 100% | 1.74× | 540 | 42.4% | economy destroyed |
| debt, repay 50% | 2.04× | 3,817 | 42.3% | no effect on exploit |
| debt, repay 25% | 2.11× | 5,835 | 42.2% | no effect at all |
| 5 busts free, then debt | 1.45× | 746 | 42.4% | economy destroyed |
| debt capped at 500 | 2.35× | 758 | 42.2% | worst of both |
| free amount shrinks 50→10 | 1.98× | 1,670 | 42.4% | no effect on exploit |
| bank ≤100/day | 2.10× | 7,604 | 42.3% | no effect on boards |
| bank ≤250/day | 2.12× | 7,624 | 42.3% | no effect on boards |
| bank ≤100/day + debt | 1.85× | 538 | 42.4% | economy destroyed |

**No variant kills the convexity.** The advantage survives at 1.45–2.35× in
every single one.

**% of days broke is 42.2–42.4% in all ten.** The loan cannot help the loop
because it does not change the bust rate: median busts is 153–154 everywhere.
The Broke Flip is the symptom, not the cause.

---

## The daily cap: kills RIDE, but by over-correcting

The one lever that does move preset choice — and it moves it off a cliff.

| variant | SPREAD banked | RIDE banked | RIDE ÷ SPREAD | RIDE reaches epic |
|---|---|---|---|---|
| baseline | 7,608 | 12,700 | 1.67× | 28.1% |
| bank ≤100/day | 7,604 | **200** | **0.03×** | **0.0%** |
| bank ≤250/day | 7,624 | 500 | 0.07× | 0.0% |

A RIDE player wins 1-in-128 and takes 12,800 ₿, but can only bank 100/day and
busts within ~3 days, so the jackpot evaporates before it can be banked. RIDE
stops being a choice and becomes a mistake — and epic becomes unreachable by
*any* route, which breaks the store the tiers were built for.

Note it does nothing to board choice (2.10× vs baseline 2.09×): SPREAD
surpluses are small enough that a 100/day cap never binds.

---

## The reframing: the exploit may be the design

The design doc specifies epic at 15,000 as **"unreachable by banking — forces
riding"**. Measured:

| | reaches epic |
|---|---|
| SPREAD (safe) | 0.0% |
| RIDE (bold) | 28.1% |

That is the spec, met. High-variance play reaching the expensive tier while
grinding does not is **the intended economy**, not a bug in it.

The real defect was never that bold play pays more. It was that a **slider
claimed neutrality while hiding a dominant setting**, with the default sitting
near the worst position. Replacing it with two named presets that print
`nothing 99% · best 12,826 ₿` beside `nothing 38% · best 384 ₿` already fixed
that — the trade is now explicit, and a player choosing RIDE knows exactly what
they bought.

**There may be nothing left to fix here.** The honesty problem shipped fixed;
what remains is the design working as written.

---

## What is still genuinely broken, and it isn't this

**42% of days broke, 0% two-year survival.** Untouched by all ten variants
because none of them change the bust rate. The cause is upstream: the wallet is
all-in every day against a 36% chance of losing every line, so the wallet is a
bust machine and the Broke Flip is the ambulance, not the accident.

Fixing that means changing exposure — a smaller mandatory stake, a higher floor,
or a bust that costs a day rather than the whole wallet. It is a core-loop
change, not an economy tweak, and it is the bigger problem.

---

## House edge

| preset | measured | ±3σ | verdict |
|---|---|---|---|
| SPREAD | 0.098% | 0.186% | consistent with 0.200% |
| RIDE | −0.442% | **2.396%** | consistent with 0.200% |

The loan moves money *between* flips and never touches settlement, so it cannot
change the per-flip edge. RIDE pays 128× on a 1-in-128 shot, so 2M flips resolve
its mean only to ±2.4% — far too noisy to see 0.2%. My first pass flagged RIDE
as `CHECK` against a fixed threshold, which was a fabricated finding: the bar
was wrong, not the code. The error bar now says what it can and cannot resolve.

---

## If you ship it anyway — the exact rules

Debt at 100% with a 5-bust grace was the least-bad debt variant (1.45×), but it
still leaves 97.6% of players permanently owing and 42.4% of days broke.

1. On a **won** Broke Flip the player receives 50 ₿. A lost Broke Flip hands
   over nothing and must not create debt.
2. After the 5th won Broke Flip, each 50 ₿ received adds 50 ₿ to `debt`.
3. Banking settles debt first: `pay = min(debt, amount)`, `debt -= pay`, and
   only `amount - pay` reaches the bank. Debt never touches the wallet and can
   never push it below the floor — the loan costs **time**, not stake.
4. **Cosmetics cannot be bought while in debt** — automatic, since banked ₿ only
   accrues after debt clears. No separate rule needed.
5. No cap and no forgiveness: both tested worse (cap 2.35×, the worst result in
   the table).

**Where it would go.** `coinflip-preview.html`: a `player.debt` field beside
`player.bank`; the Broke Flip branch in `brokeFlip()` increments it; `doBank()`
settles against it before crediting `player.bank`; `syncMoney()` shows it. It is
one number and one subtraction — the implementation is small, which is exactly
why it is tempting and why the numbers matter more than the effort.
`server/src/economy/`: the same field in the `users` table and the same
subtraction in `settle.js`, since the client is never trusted with money.
