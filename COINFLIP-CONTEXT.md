# COINFLIP — project context

Daily browser coin-flip betting game (Wordle-lineage daily guesser + open-ended
betting + cosmetics-only store). This file is the full handoff. Where earlier
decisions were superseded, only the CURRENT state is stated as fact; superseded
models are listed at the bottom so they aren't accidentally reintroduced.

---

## 0. START HERE

**It is deployed.** github.com/mikeyvalentine/coinflip → GitHub Pages:
- `https://mikeyvalentine.github.io/coinflip/coinflip-3d.html` — the renderer
- `https://mikeyvalentine.github.io/coinflip/coinflip-preview.html` — the 2D game
- `https://mikeyvalentine.github.io/coinflip/minigame/clean-demo.html` — coin cleaning

**Run the suites, not the browser.** `node test.js` plus every `tools/verify-*.mjs` (17 of them), and `cd server && node --test "test/unit/*.test.mjs"`. They are headless because the preview pane on the dev machine does not render, `requestAnimationFrame` never fires, and CSS transitions never advance.

**Nothing visual is proven.** Every renderer claim in this file is geometry, timing and state — asserted headlessly. Whether any of it LOOKS right has only ever been checked by the user's eye on the deployed page. When you finish something visual, say so plainly rather than implying it was verified.

**The three lessons this project keeps re-learning:**
1. **A verifier that hardcodes its own input passes forever while asserting a configuration that no longer exists.** Found three times in one day (`verify-pickup`, `verify-orient-arrow`, `verify-slowmo` all retyped the camera or the lens). Import the constant; never retype it.
2. **A test that cannot fail is worse than no test.** `2*acos(|dot|)` folds into [0,180] by construction and reported "safe" at 30fps where the coin turns 469°.
3. **Measure, do not sample.** A 32-clip sample of a 1024-clip library missed the fastest clip and understated an aliasing failure by 60°.

---

## 1. Files

| Path | What |
|---|---|
| `coinflip-preview.html` | The whole 2D game — self-contained, no build step, no imports. **Source of truth for GAMEPLAY.** That self-containment is deliberate: it is what lets it be published as a standalone artifact. |
| `coinflip-3d.html` + `flip3d/` | The renderer. **Source of truth for the VISUAL/physics side.** Pick up the coin, wind up, throw. |
| `minigame/` | Coin cleaning — the busker's recovery, replacing the Broke Flip. `clean.js` is pure state; `build-demo.mjs` inlines it into a standalone page and verifies the copy cannot drift. |
| `tools/verify-*.mjs` | **The 17 headless suites. Run these, not the browser.** Every one exits non-zero on failure. |
| `bake/` | The Rapier bake. `out/` = 1024 face clips, `out-edge/` = 12 rim clips, `out-min/` = the packed library the renderer actually loads. |
| `sim/` | Population economy simulation. `node sim/population.mjs`. Refuses to print an economic result until 9 self-tests pass. Found the Spread career problem, the settlement rounding bug, and killed the loan idea. |
| `server/` | Cloudflare Worker + D1. 44/44 unit tests, never deployed, **and still on the dead Spread model**. |
| `identity.js`, `daringness.js`, `fingerprint.js`, `collectSignals.client.js` | Identity/entropy. **Do not edit** — `test.js` proves fairness against them. |
| `game.js` | **STALE.** Pre-session spin model. Reference only. |
| `shareCard.js` | Written, **stale**, unwired. See Debts. |
| `test.js` | **Proves fairness**: identity never skews outcomes. Must stay green after any seeding/outcome change. |

## 2. Core design (locked)

- **One flip per player per 24h.** Per-player, NOT a shared daily flip.
- **Flips are baked offline**, never runtime physics — a curated ~1000-clip library makes odds honest (curated uniform), enables anti-cheat, enables bullet-time. Harness now BUILT (`bake/`, §6).
- **Bet axes: Side + Orientation + Spin.** Table position, rings, wobble/settle all cut — betting is about the coin itself, never where it lands.
- **Coin's starting face is shown before the flip**, random heads/tails each day.
- **Economy: wallet vs bank.** Start 0. No stipend. The WALLET is always fully at risk — there is no stake field, your stake IS your wallet. You may BANK winnings to safety but never below a floor of **50**, so the wallet can only reach 0 by losing. Banking is one-way (funds the cosmetic store; not re-bettable) and only allowed while the cooldown timer runs — you commit your stake before the flip goes live. Store is **cosmetics only, never pay-to-win**.
- **Broke Flip:** at 0₿ you get one free heads-or-tails call (YOU pick) returning 50₿. Consumes the daily flip. Onboarding + desperation safety net.
- **Identity is provenance + presentation only, NEVER outcome-biasing.** `test.js` proves it. Do not break this.

### Spin axis

- Internally: **half-flips, integers 8–40, excluding 24** → **N = 32 outcomes**. Excluding the median makes higher/lower a clean 50/50 and balances parity so P(same side as start) = 0.500 exactly.
- **PLAYER-FACING unit is ROTATIONS = half-flips / 2**, shown to one decimal (19 → `spin: 9.5`). Range 4.0–20.0, median 12 unattainable. **NEVER say "half flips" to the player.** The two units meet at exactly one boundary in code (`toRot`/`toHalf`).

---

## 3. Betting model (CURRENT)

**Three independent bets, each resolving on its own.** The wallet splits across whatever bets are placed, weighted by the Spread slider (§4).

### Side — 2× / 2× / 499×
Heads, Tails, or **Edge 🤯** (the coin lands on its rim). Edge is the coin's literal third side and lives in this row. Choosing Edge puts the WHOLE stake on the rim and locks out the other axes.

### Orientation — 4 ÷ quadrants selected
The coin's **settle YAW** — which way the face design points once at rest. NOT where on the table it lands (that axis was cut). Multi-select SVG dial. 1 quad 4×, 2 quads 2×, 3 quads 1.33×, 0 or 4 quads = 1× (a refund, NOT a bet — excluded from pricing/spread). Truth is `orientationDeg` (0–359.99); quadrants are buckets NE=[0,90)… clockwise from North.

### Spin — a typed LINE, priced 32 ÷ outcomes covered
You TYPE a rotation value (4–20 in 0.5 steps, 12 rejected). Alone it's an exact call → **32×**. Add "higher"/"lower" to widen to everything above/below → priced `32/count`. So `9.5`=32×, `9.5 higher`=1.6×, `11.5 higher`=2× (old median bet preserved), `16 higher`=4×, `6 lower`=8×. Lines where a modifier covers nothing (4 lower, 20 higher) are blocked. One rule, every shape fairly priced.

### The Edge — the house-edge mechanism
Rim landing, probability **1/500**, pays **499×** (roulette's N−1-on-N). It SWEEPS: on a rim landing Side/Orientation/Spin all lose. This is the ONLY thing creating a house edge, and because every bet's EV is exactly (1−p) it's a **uniform 0.20% edge on every bet**. Reads PURPLE in the reveal, never green. Tunable via the 1/500 frequency alone.

### SPREAD / RIDE — two presets. The slider is GONE.
The wallet no longer splits by a slider. There are two structurally different bets, and the player picks one:

- **SPREAD** — the wallet splits so **every call that lands pays the same** `K × wallet`, where `K = 1 / Σ(1/mult)`. Back a 32× line with a sliver and a 2× call with the bulk, sized so both come home identical. Many small results.
- **RIDE** — ONE compound call. Every placed call must land, priced on the **TRUE JOINT probability**, not the product of the multipliers. One huge result, rarely.

Each shows **two numbers, live**: its chance of paying NOTHING and its BEST CASE. That pairing is the point — risk and reward on screen together.

| board | SPREAD | RIDE |
|---|---|---|
| sharp (Heads · 1 quadrant · exactly 10.0) | nothing 38%, best 384 ₿ | nothing 99%, best 12,826 ₿ |
| loose (Heads · 3 quadrants · 5.0+) | nothing 1%, best 137 ₿ | nothing 67%, best 285 ₿ |

**RIDE MUST BE PRICED ON THE JOINT ODDS.** `landsHeads = (spins % 2 === 0) ? startHeads : !startHeads` — **side is spin PARITY**, so "Heads" beside an even-rotation line is one call wearing two hats. Multiply the marginals and you post 256× on a bet whose honest price is **128×**, every day, forever. `tools/verify-presets.mjs` §1 pins this.

Half of all side + exact-spin pairings are **contradictory** (Heads + an odd-rotation line can never land). RIDE greys out when unwinnable and `canFlip()` refuses it in LOGIC, not just CSS.

**Why the slider went.** It claimed neutrality and hid a dominant setting near its own default. Per flip EV was provably flat; over a CAREER it was not, because banking ratchets and the Broke Flip floors losses, so variance is an asset. Measured 2.64× between the best and worst positions. It also collapsed three orthogonal questions about the coin onto one "how long are the odds" axis, and duplicated a risk dial the player already has three sharper versions of (quadrant count, spin-line width, Side-vs-Edge).

**The settlement rounding bug died with it.** The old `mult^α` weighting could put 0.38% of the wallet on Side, so winning ONLY Side from 50 ₿ returned 0.383 ₿ and rounded to a bust. Under `w = 1/mult` the worst K over EVERY possible board is 0.4507, so a single winning line always returns ≥22.5 ₿ on a 50 ₿ wallet. It cannot round to zero.

### ⚠️ THE ECONOMY IS FUNDED BY THE BROKE FLIP — measured, and it constrains everything
There is no stipend, so ₿ enters the game at exactly ONE place: the payout when you bust. **Banked ÷ injected ≈ 1.0** (measured 1.07 over 2000 players × 730 days). Every ₿ in every bank is that money passed through the wallet and skimmed by the 0.20% edge.

**This kills the "make the Broke Flip a loan" idea, which was modelled across 10 variants and rejected.** A loan does not tax the exploit, it reclaims the entire money supply: net banked drops ~7,600 → ~980 while the variance advantage barely moves (2.09× → 1.74×). None of the ten variants killed the convexity; all ten left dead days at 42.2–42.4%. 100% debt left 97.8% of players permanently owing. Full report in `sim/loan-report.md`.

**And the "exploit" is partly the SPEC.** The design says epic is *"unreachable by banking — forces riding"*. Measured under the presets: SPREAD reaches epic 0.0%, RIDE 28.1%. Bold play paying more is the design working. What was genuinely broken was a control that claimed neutrality while hiding a best setting — and the presets fixed exactly that.

### SPIN INPUT BUG — FIXED 2026-07-29
`validLine` was `/^\d+(\.5)?$/`, so it **rejected "10.0"** — the exact string the game itself prints. The live counter reads `spin: 10.0` and a lost line reports `10.0`, so a player read a value off the screen, typed it straight back, and got silence: no multiplier, no bet, no reason given. Now accepts any spelling of a half step and normalises via `lineValue()`. `12` stays rejected (unattainable median, by design).

**Why the test suite missed it:** every pricing test fed `bet.spins` in as an object, so nothing ever went through the text input — the one path a real player uses was the one path nothing exercised. `verify-presets.mjs` §5 now asserts the general rule: **anything the game can print must be typeable back in**, checked across all 32 displayable values.

### ⚠️ SETTLEMENT BUG — a winning line can round to a bust
`endBalance = Math.round(startBalance − totalRisk + returned)` in the preview. At high Spread, Side carries 0.38% of the wallet, so winning ONLY Side from a 50 ₿ wallet returns **0.3831 ₿ → rounds to 0**. The staged reveal colours Side green and lands the total on 0 ₿.

It bites hardest at exactly **50 — the `WALLET_FLOOR`** — which is the most common wallet in the game: bank-to-floor players live there, and every Broke Flip recovery returns to it. Side pays nothing at all until the wallet reaches 66 ₿.

**It also doubles the bust rate at max Spread.** Enumerated at t=1: P(bust) 36.5% → **72.7%**, because "won Side only" (36.3%) settles to zero exactly as often as "won nothing" (36.3%). At max Spread **half of all busts are players who won a line.** Reported, not fixed — it sits in the preview's settlement path, which is the gameplay source of truth.

---

## 4. UI (current)

Vertical build-as-you-go form. 3-column grid: **dot | content | amount**. Rows: Side, Orientation, Spin, divider, Spread, Total. Money + bank control top-left; timer top-right.

- **Selection is COLOUR, not disappearance.** Unpicked options stay grey and legible; the pick turns blue (`--sel`). Nothing hidden.
- **Every row's staked ₿ amount** sits in one aligned center column, live off the Spread slider. Total is a static display reading the wallet (no input — the wallet IS the stake).
- **Orientation dial:** drag-to-paint quadrants (press sets fill-or-wipe mode for the whole hold; retracing does NOT undo — tried and rejected). Cardinal letters replaced by **arrows** along each sector's diagonal. Two adjacent quadrants merge into one cardinal arrow; three merge the complete side + leave the odd diagonal. Arrows have a CSS transform transition so they SLIDE/merge (JS to drive it via `style.transform` was IN PROGRESS at session end — currently still uses hide/show + a `#dial-merged` element; functional, not yet animated).
- **Spin entry** sits left, under the label.
- **Bank control:** `banked N ₿` + amount input + `bank` button. Enter/click commits; over-cap clamps to the floor; disabled unless timer running. Debug buttons bottom ("start timer" / "timer 00") drive the gate — preview has no real timer.
- **The coin is the flip control.** Locked until a side is called (and, for the main flip, timer at 00).
- **Nothing resets after a flip** except balance. Debug `reset` clears everything.

### Mobile — DONE (`tools/verify-responsive.mjs`)

Breakpoints **560px** and **400px**, max-width only so they nest rather than fight. 560 is not taste: the desktop layout needs `dot 14 + gap 16 + (--field-x 260 + amount ~90) + gap 16 + mult ~44 + padding 48` ≈ **488px**, so 560 is one breakpoint of headroom before anything is forced. 400 is where a 160px dial stops fitting a column that must also hold the staked amount.

- `--field-x` 260 → 168 → 150; dial 160 → 142 (quadrants are still ~60px wedges, past a 44px target); coin 64 → 80; `.opt` gains 8px vertical padding for a ~35px tap height **without** reading as a button. Padding is static, so it cannot violate "nothing moves when something scales".
- **One markup change:** `#money` and `#timerBar` were each absolutely pinned to a corner; they now sit in a single `#topbar` that is the absolute element. Pixel-identical on desktop, but two independently pinned corners cannot collapse into the flow and one bar can.
- **The reveal was the thing at risk and it survived structurally.** Only VALUES changed — the grid is `dot | content | amount` and `.field-row` is `var(--field-x) auto` at every width, so `revealResults()`'s live `offsetLeft`/`offsetTop` reads follow a narrower column for free. **The obvious mobile move — stacking the amount under the choices — was deliberately refused**: it looks perfect at rest and puts the sliding total in the wrong place the moment it moves.
- The suite asserts `#stepTotal` stays inside `#form`, `#form` stays `position:relative`, and **no ancestor between `#form` and the rows gains a `position`/`transform`/`filter`/`perspective`/`contain`** — any of which silently re-bases the offsets. Mutation-tested independently: stripping `touch-action`, renaming `#amt-orient`, and adding a `transform` to `#grid` each fail it.
- Script block **byte-identical** (767 lines, verified by content). No script changes needed; all 34 ids, 13 classes, 4 data attributes and the 9 concatenation-built selectors (`a-`/`m-`/`amt-` × aspect keys) still resolve.
- **Not verified — no headless browser exists here and the pane does not render:** whether 142px is comfortable to paint with a thumb, whether the wrapped spin entry reads well on two lines, whether the running total is legible at 18px in a 104px column, and whether the dial's `overflow:visible` quadrant scale collides with the amounts at 360px. Those need a real phone.
- Known, left alone (needs a script change): `#spinLanded` reserves `min-width:46px` permanently but is only visible on a loss, costing 46px of the choices column at all times.

### Staged result reveal
Each placed bet resolves step by step down the form. The **running total lives IN the center amount column** — one number sliding row to row through the ₿ values (each row's static amount hides as it passes), carrying the total: starts at the whole stake, a win adds that line's profit, a loss subtracts its portion, ending on the exact true return. **Coloured by POSITION** (not per-line): a saturation gradient from neutral grey at break-even to full green/red at ±1 whole stake (purple for an Edge win). Timing is **drama-scaled** — the whole per-row beat scales with that line's swing (1.03× nudge ~710ms, 32× hit ~2s).

**Hard-won animation constraints — do not regress:**
- **Nothing may move when something scales.** `transform` only, `transform-origin:left center`. Never `font-weight`. Never scale a whole row container.
- `renderDial()` writes inline quadrant transforms that outrank CSS win/loss classes — clear them before the reveal.
- **Every money/gate rule must hold in LOGIC, not just CSS.** `pointer-events:none` stops a mouse click but not keyboard entry — a bank-during-flip bug came from exactly this. `doBank`/`doFlip`/`brokeFlip` guard their rule internally.

---

## 5. WHAT IS ACTUALLY PENDING

**Blocking the merge**
1. ~~The Edge~~ — **DONE.** Wired end to end. `outcome.js` draws the rim at 1/500 off its own hash; measured **0.1850% over 60,000 seeds** (expected 0.2000%, 0.82σ, and independent of the spin draw at χ²=22.5/32). `assertOutcome` accepts `side:'Edge'` with nulled bet axes; `library.js` routes to `bake/out-edge/` automatically. **8,000 seeds: 0 of 7,981 non-Edge outcomes moved** — the rim is an override folded in at the end, not a reordering of the draw.

   **Three traps found while wiring it, all of which would have shipped silently:**
   - `materialise()` lifts every clip so its settled centre sits at half the coin's THICKNESS — a sub-mm correction for solver drift on a FLAT landing. A rim clip's centre legitimately sits at the coin's RADIUS (9.88 mm vs 0.75 mm), so applying it drove the coin **9 mm through the table** on the most dramatic outcome in the game. Now skipped for edges.
   - The tails re-frame would have renamed `'Edge'` → `'Heads'`, so a rim clip would have been verified and reported as a face landing.
   - **Edge clips are deliberately NOT packed.** `encode.js` stores `quadrant` as a UInt8 index (null → -1 → throws) and `orientationDeg` as a float (null → **0**, which decodes as a valid-looking 0.00° in the NE bucket — a rim landing silently becoming a face landing). Teaching the format a null sentinel is a version bump for 12 clips out of 1,036, and only the 9.5 kB index loads up front. They stay raw JSON.

   Note the two builds differ in SHAPE on an Edge, deliberately: the preview leaves `side`/`spins`/`quadrant` populated and lets `edge:true` sweep them at settlement; the renderer nulls them, because they feed `assertOutcome` and then a rim clip that has no side, no rotation count and no settled yaw.

2. **The 2D/3D merge.** The two builds have never talked to each other and there are TWO implementations of the outcome draw. `tools/verify-draw-parity.mjs` is the gate: `startFace`/`spins`/`side` already agree exactly; the quadrant divergence is two independent FAIR draws disagreeing (both uniform, χ² 3.29 and 6.11), so picking either loses nothing.

**Decisions, not tasks**
3. **The core loop** — see §6. Biggest open problem in the project.
4. **Cloudflare** — parked by the user. Do not deploy the old economy.

---

## 6. Status of the bigger pieces

**DONE and verified:**
- **House edge** — via The Edge. Uniform 0.20%, one dial.
- **Rapier bake harness** (`bake/`). 1024 clips, 128 cells × 8 variants, exactly uniform, sides 512/512, quadrants 256 each. Determinism proven (byte-identical across processes, matching merkle roots). 2048-case sweep (metadata re-derived from frames) 0 failures. Real 1-ruble physics (20.5mm, 1.5mm, 3.25g), gravity −9.81, zero damping (measured).

**3D renderer (`flip3d/`) — items 1–4 all DONE and verified.**
- Real clip playback works; side/rotation/settle-yaw verify against metadata twice per flip.
- Coin GLB real-scale (correction quat `(0.5,0.5,0.5,−0.5)`, 12-o'clock = GLB local +Y).
- The previous handoff listed `blur.js`/`charge.js`/`power.js`/`variant.js` as PARTIAL and UNVERIFIED. **They are not** — the Node sweeps were re-run and all pass. That warning was stale; do not act on it again.
  1. **Rest pose North** — DONE. `verify-clips.mjs` asserts "rest pose reads ORIENTATION 0 (North) for both faces".
  2. **Motion blur** — DONE. Shutter planner verified across 42–209 rad/s, every quality tier, and the landing gate.
  3. **Power meter** — DONE as gesture+visuals only; `verify-power.mjs` proves 0 bet-axis violations over 300 seeds at power 0 vs 1, and 0 variant escapes from the drawn cell.
  4. **Slow-mo + zoom apex→settle** — DONE. See below.

**The apex ramp (§6.4) — `tools/verify-slowmo.mjs`, 1024 clips, all green.**
Slow motion and the camera push-in share ONE window: apex → first contact.
- **The ramp is anchored to the APEX, not the whole flight.** Full speed all the way up, decelerating fall. This is the whole design — the rejected 2× version stretched the ascent, and a coin that RISES slowly reads as low gravity no matter how it is tuned. The rise is asserted to run at exactly 1.000×.
- **The settle runs back up to real time.** Slowing the descent is drama; slowing the rattle is a wait. Holding a slow rate to the clip's end (the old shape did) made the longest flip a 3.3 s sit. The impact beat and the recovery are FRACTIONS of each clip's own settle, so every clip is back at 1× by its final frame.
- Measured: descent 343 → 668 ms (×1.95), whole flip 1.23 → 1.90 s median, 2.75 s worst.
- Camera pushes in to 0.60× distance while pulling `travelLead` to 1 and lifting elevation 20°→34°. **Zooming alone is not enough** — the deliberate off-centre drift that reads fine at 0.26 m walks the coin out of frame at 0.16 m, so the push-in must re-centre as it closes.
- Default ON. `?slowmo=0` disables it; `?bullet=1` is the old spelling.

**Bugs found and fixed while building it:**
- **The settle crane fired BEFORE touchdown on 1024/1024 clips** under any warp, by up to 376 ms — the gate compared wall-clock `t` against a CLIP-time landmark, and the two stop agreeing the moment a time warp exists. Fixed by inverting the warp (`warp.wallAt`). At 1× the fix is a no-op.
- `clip.js:183` named `BULLET_TIME`, which is not defined or imported in that file — a ReferenceError for anyone calling `buildProceduralClip` with a bulletTime config object. Unreachable from the game (`playFlip` strips the option first). Now uses `PROCEDURAL_BULLET_TIME`.

**Not built:**
- **Population simulation** to tune the economy — pure logic, no renderer needed. Natural next step.
- **Share card** — `shareCard.js` written, not wired.
- **Leaderboard + persistence** — infra agent (`server/`) started a Cloudflare Worker + D1 (`migrations/0001_init.sql`) + Google sign-in + salt commit/reveal + leaderboard + economy rules + unit tests. **UNVERIFIED**; no `DEPLOYMENT.md` yet. Account creation, secrets, deploy are the user's to do. Dev port 8788.

### THE THROW — DONE AND WIRED. A real throw, not a spring.
Two phases, and the split is `power = 0.25·wind + 0.50·speed + 0.25·throwDist`:

- **Pull back (down)** records distance and fills the meter SLOWLY — 25%.
- **Throw (up)** is measured by the pointer's upward VELOCITY and the distance covered before release — 75%, with speed the single largest term.

- **Velocity comes from a 60 ms WINDOW, endpoint to endpoint** — not per-event deltas. That is what makes a 30 Hz and a 500 Hz pointer read identically (measured spread 0.0000). The window is clipped at the bottom of the pull: unclipped, it straddles the reversal and reports NET displacement, so a snappy down-then-up cancels itself out and the throw phase never opens.
- **Full speed is BAND-RELATIVE** — crossing the whole lift band in 0.175 s — not absolute px/s. An absolute threshold makes full power progressively cheaper as the window grows (753 px band at 1920 vs 209 px on a phone). **The 0.175 s is an assumption** and the most likely thing to need retuning against a real hand.
- Release below 120 px/s upward is a DROP, checked BEFORE the power floor — a big wind-up carries 0.25 and would otherwise sneak past a 0.12 floor and throw a coin you never threw.
- The superseded model was a spring: an anchor tracked the top of the stroke and power was how far you pulled DOWN from it. Do not reintroduce it.

**Picking the coin up OPENS THE SPACE.** `scene.js#HOLD_SHOT` drops the table out of frame. Stroke 196 → **400 px**, world 31 → **150 mm**, table 93 px off the bottom.

**THE MOVING-RULER PROBLEM, and how it is handled.** The camera moves on pick-up, and a gesture measured against a moving camera scores the same motion differently depending on when it happened. So measurement is DEAF for the 180 ms transition (`HOLD_TRANSITION_MS`) while the coin still tracks the pointer — apex and deep re-base to the live position every event, so measuring begins from wherever the hand is when the camera stops.

**The pull is measured in the coin's VISIBLE travel**, against `HOLD_SHOT` rather than the live shot. `coinflip-3d.html` passes `clampY` and a `travelPx` function derived from the band, so one full lift-and-slam is exactly 1.0 on any canvas. `verify-grab.mjs` §10 pins it.

### THE CAMERA — 45° wide, and it FOLLOWS the coin
`scene.js#SCENE_FOV_DEG = 45` (~41 mm equivalent), up from 30° (~65 mm). Measured at the flight apex the coin spans 105 px at 30°, 68 px at 45°, 54 px at 55° — **past ~45° it stops reading as a tumbling disc** at the one moment the spin must be legible. The three shot distances were re-solved by `tan(15)/tan(22.5) = 0.6469` so the coin holds its SIZE and the width is what changed; a wider lens at the same distance is just a smaller coin.

**The settle camera tracks the coin's LIVE position** — it does not crane to `finalPos`. The crane is wall time, the coin's journey to rest is clip time, and slow motion pulled them apart: the camera arrived first, framed empty table, and the coin skittered in afterwards.

### SLOW MOTION — opens BEFORE the apex
`SLOWMO`: `preApexFrac 0.22`, `shape 1.8`, `minRate 0.10`, recovering to 1× over the settle.
- The ramp opens **22% of the climb before the apex** so the zoom and the slow-down are already under way as the coin arrives at the top, rather than reacting to it.
- The curve is `1-(1-t)^1.8`, not smoothstep: rate falls FAST out of the apex instead of easing in gently.
- **The first 78% of the CLIMB is still exactly 1.000×.** That is the anti-floaty guarantee and it is asserted per clip — a coin that RISES slowly reads as low gravity, and no tuning fixes that.
- Descent 343 → 1495 ms (4.36×). Median flip **3.35 s**.

### THE ORIENTATION GUIDE — the dial, painted on the coin
Not a number. Four world-aligned quadrant dividing lines registered to the coin's face, plus a triangle OUTSIDE the rim marking where the design's 12 o'clock landed.
- **Registered by an exact HOMOGRAPHY (CSS `matrix3d`), not an affine approximation.** A plane-to-plane projective map IS a homography, so four corner correspondences reproduce it exactly: rim error **1e-13 px**. An affine Jacobian would miss by **3.86 px** — a visible mis-registration. `verify-orient-arrow.mjs` asserts the affine error stays LARGE, so the homography can never quietly become ceremony.
- **No sector shading** (`SECTOR_ALPHA` is 0/0, kept named so the intent is on the record): the wash covered the coin face the guide exists to help you read.
- **No rim circle**: it re-drew an edge the render already provides, so any registration error showed as a double outline and a correct overlay looked wrong.
- **The triangle sits OUTSIDE the rim**, apex pointing in, so it stops covering the engraving at the exact bearing being read.
- `hide()` is called on RESET as well as at the start of the next flip. It used to survive a reset and sit at stale pixels while the camera moved out from under it.

### The drop — fall, wobble, settle — DONE and wired
`flip3d/drop.js` + `tools/verify-drop.mjs`. **Five** seeded variants, chi-square 8.1 (df=4) over 6000 seeds:

| variant | tilt | total | character |
|---|---|---|---|
| `settle-flat` | 3° | 459 ms | lands nearly flat, quick buzz — the common case |
| `rim-roll` | 22° | 1025 ms | catches an edge, long slow roll |
| `double-bounce` | 12° | 777 ms | hops twice then rocks |
| `chatter` | 8° | 698 ms | many fast rocks, strongest frequency rise |
| `dead-drop` | 5° | 379 ms | hits and stops |

Fall 74.8–79.1 ms; whole drops 128–1025 ms, median 448 — so it IS nearly all wobble, as the physics demanded. Gravity verified by differentiating the sampled track twice: −9.81 m/s² to 1.2e-9.

**Wiring:** `onCancel` calls `playDrop(scene, { fromY: scene.heldY, face, seed })`. Do **NOT** call `scene.endHold()` first and do **NOT** call `ready()` after — `playDrop` eases the held shadow (radius 4.5 → 1) across the fall, because the shadow is the height cue and must arrive WITH the coin rather than snapping ahead of it, and it leaves the coin on the exact rest pose. It deliberately does not touch the camera; the coin never left the ready framing. A `dropping` flag gates `canStart` so the coin is not grabbable mid-drop.

**Two bugs its own tests caught:** a coin released at rest stalled up to 332 ms doing nothing (the game appearing to hang after a fumble) — now zero-duration; and when the geometric tilt cap bound exactly, the fall collapsed to 2e-7 ms and the coin *snapped* to its landing angle in one frame — fixed with `TILT_HEADROOM = 0.85`.

**Not verified:** whether it reads as a dropped coin. Watch `rim-roll` (longest, 22° tilt) and `double-bounce` first — the bounce is additive on height while the rock continues underneath, which is a physical simplification since a coin mid-hop has nothing to rock against.
- **THE COIN MUST NOT FLIP ON THE WAY DOWN.** Not cosmetic: the start face is shown before the flip and is what makes side and spin independent betting axes, so a drop that turned the coin over would silently change the declared start face and corrupt the next bet. `Math.sign(upDot(quat))` is asserted constant across every variant and release height.
- Settles at the exact rest pose, **ORIENTATION 0 = North** — `setRestFace()` parks the design's 12 o'clock there so the coin the player presses sits at the dial's zero, and `verify-clips.mjs` asserts it. The wobble may tilt; it may not yaw.
- The longest fall is only ~3 cm ≈ **80 ms**, so nearly all the perceived length is the wobble. Do not stretch the fall to pad it — that reads as low gravity, which is the exact failure mode already rejected once (see the apex ramp).

### Power meter — the ORIGINAL band design (still not built, still open)
Power slides a **fixed-width band** along the spin range in real time: soft → low spins, hard → high spins; coin lands uniformly inside the band. Width is a FIXED constant — power moves it, never resizes it. **Multipliers are priced to the band width, not the full 32**, so they never move (no live repricing) and there's no edge — narrowing shrinks the payout one-for-one. Even width keeps side 50/50. The outcome request takes an optional band (default full 32); power selects the variant via `selectVariant(..., flickForce=power, ...)` and must NOT bias which cell is drawn. Open sub-choice: band centers on the player's power (aim-then-bet) or on their typed line?

### Orientation helper arrow — DONE and wired

`flip3d/orientArrow.js` + `tools/verify-orient-arrow.mjs`. A small yellow (`#ffc300`) arrow with a `xx.xx°` label, appearing when the coin SETTLES — it answers "did my quadrant land", so showing it earlier would answer before the question is asked.

- **The settle camera is at 66° elevation, NOT top-down**, so the table is foreshortened and an arrow rotated naively by `orientationDeg` is wrong everywhere except the four cardinals. Screen angle is `atan2(sin(θ+a), sin(e)·cos(θ+a))`. **A 45.00° heading renders at 47.59°.** Every heading is pulled toward the nearest horizontal, and the squash strengthens as the camera drops: 0.44° at elev 80, 2.59° at 66, **12.56° at 40**. If `SETTLE_CAM.elevDeg` ever changes, pass the new `elevDeg` — the arrow already accepts it.
- Azimuth simply adds to the heading (rigid rotation); elevation squashes only the north–south component.
- Reads `report.played.landedOrientationDeg` — the same `roundOrientation(orientationFromQuat(...))` the renderer verifies against the clip twice per flip, so arrow and verification cannot disagree. Label and quadrant both derive from the ONE rounded value; deriving them separately is what prints "90.00°" next to quadrant N.
- **No win/loss colouring.** Yellow means "here is the truth"; the staged reveal owns verdict colour.
- `hide()` is called at the START of the next flip, **not in `arm()`** — `arm()` runs immediately after a flip resolves, so hiding there erases the arrow in the same breath as showing it.
- Speaks the renderer's **N/E/S/W**, so the quadrant rename debt below is still open.
- **Not verified:** that a 34px arrow is legible against the settled coin at that framing. Geometry, state and colour are asserted; appearance needs an eye on a real render.

### Orientation granularity — a consequence to weigh
The renderer resolves orientation to one of the **1024 baked angles** (the old continuous-2dp resolver was unsatisfiable). §6.5's two-decimal orientation bet would need ~36,000 clips (~700MB, unbakeable). Either bake more variants (user wants ≥2× if perf allows; 3D is source of truth) or make the fine orientation bet coarser. The 2D preview still generates continuous angles — the builds disagree here.

### Library compression — DONE AND LIVE. 20,486 kB -> 343 kB, 1025 requests -> 3.

`bake/encode.js` + `bake/decode.js` + `bake/out-min/` + `tools/verify-encode.mjs`. `library.js` loads the pack by default and falls back to raw clips if it is absent.

| lever | size | vs raw |
|---|---|---|
| raw JSON (what shipped before) | 20,259 kB | 1.0x |
| int16 every frame, no modelling | 3,230 kB | 6.3x |
| **+ analytic flight** (67.5% of frames) | 1,148 kB | 17.6x |
| + adaptive settle keys | 349 kB | 58.1x |
| + gzip | **309 kB** | **65.6x** |

Over the wire: `clips.cfc` 309 kB + `index.json` 19 kB + `beats.json` 15 kB = **343 kB in 3 requests**. Decode 18 ms at startup, **0.02 ms per clip**, lazy and cached — one flip is one decode.

**THE FLIGHT IS NOT SAMPLED AT ALL.** A free rigid body conserves energy and angular momentum, so |omega| cannot change until something touches it: the whole airborne phase is `q0 + axis + rate` plus a ballistic `p0 + v0` — **14 floats**, exact at any framerate. Measured fidelity vs the source, sampled by TIME: flight worst **0.011 mm / 0.003 deg**; settle worst 0.434 mm / 2.379 deg (a mid-bounce transient — one 256fps frame already turns up to 55 deg); **final frame 0.000016 mm / 0.179 deg** because it is stored VERBATIM, never reconstructed, since it carries the orientation bet.

Bet axes over all 1024 clips: halfFlips, side, quadrant **exact 1024/1024**; orientation worst 1.00e-2 deg against the 0.011 tolerance.

**DECIMATION WAS THE PLAN AND IT WAS BROKEN — do not revisit it.** Two corrections to the earlier note, both measured:
- The library's fastest clip is **245.6 rad/s** (`40E-5-0`), not the 206.8 an earlier 32-clip sample suggested. One 60fps step is **234.6 deg**, past the 180 deg where a quaternion slerp takes the short path and goes the WRONG way. Sampled at 60fps, **281 of 1024 clips report a wrong half-flip count** — a bet axis, on a bet already paid.
- **Beware `2*acos(|dot|)` as an aliasing metric**: it folds every rotation into [0,180] BY CONSTRUCTION, so it reports "safe" at 30fps where the coin turns 469 deg. It is a test that cannot fail. Both an earlier analysis and the encoder agent's first attempt were wrong this way.
- **Precession was a red herring.** A single constant world omega fits flight to 0.0009 deg of axis wander; the 2-8% variation an earlier measurement showed came from windows that included impact frames. No symmetric-top solution needed.

**Beat-tags — DONE AND WIRED.** `bake/out/beats.json` (105.6 kB, 0.52% of the library, zero quantisation error) + `tools/add-beat-tags.mjs` + `tools/verify-beats.mjs`. `createFlipper(scene, { beats })`; `meta.flipTimesMs` wins over the sidecar, so when the encoder bakes beats inline the sidecar retires with no code change. The frame-derived count is **kept as a witness** and reported as `ok.beatsMatchFrames`, so the recording is re-confirmed against the geometry on every flip rather than trusted. Absent or malformed beats fall back to frame counting and never throw mid-flip.

Note: display rate was NEVER the exposure — `playClip` walks the source-frame cursor, not one sample per drawn frame, so it survives 15 Hz. The exposure was always the frame TRACK.

### QUADRANT NAMING — SETTLED. NE/SE/SW/NW everywhere.
`orientationDeg` is measured CLOCKWISE FROM NORTH, so [0,90) runs FROM north TO east — it IS the north-east sector. Calling it 'N' was always wrong and made the bucket look like it meant "pointing north".

```
NE = [0,90)   SE = [90,180)   SW = [180,270)   NW = [270,360)
```

**N/E/S/W are RESERVED for exact 90° multiples** via `contract.js#exactCardinal(deg)`, which returns a cardinal or null and fires on **4 of 36,000** orientations. It is presentation only — nothing buckets, prices or selects from it. `quadrantFromOrientation()` still returns exactly four values always; 90.00 buckets as SE. A fifth return value would break the dial's four sectors, the library's four cells per spin count and the `4/k` pricing simultaneously, on the rarest possible input.

Migration done in `bake/migrate-quadrant-names.mjs` (idempotent): 1024 clips renamed (the quadrant is in the id), `library.json`, the packed library and `beats.json` all regenerated. 256 per bucket survived. `tools/verify-quadrant-naming.mjs` pins it.

**An id is PROVENANCE, not a label.** 71 of 1024 clip ids name a cell the clip did not land in — the baker banks a missed shot in whichever cell it actually hit while keeping the original tag. Never read a bucket out of an id.

### Debts and dead code
- **`server/src/economy/bets.js` still implements the Spread slider** — `spreadWeights`, `SPREAD_A`, `mult^alpha` — with 44 passing tests pinning an economy that no longer exists. Port before any deploy.
- **`game.js` is STALE** (pre-session spin model) and `bake/bake-edge.js` now imports it, so a dead file has a live consumer.
- **`charge.js`**: only `createMeterView` is still used; `createCharge` died with the gesture rework.
- **`shareCard.js` is written but stale AND unwired.** Its output says "9 spins" (the internal half-flip unit that must never reach a player — should be rotations), "E side" (retired naming), and "even" (not a bet axis). Needs a pass, not just wiring.
- **Cosmetics pricing** (vs ~4,525/yr safe banking, not the ~6,000 previously assumed): common 1,500 / rare 6,000 / epic 15,000 / mythic 50,000.

### THE CORE LOOP IS THE BIGGEST OPEN PROBLEM
**0% of players survive 730 days without busting. ~42% of all days are spent broke**, where "broke" means the real game is unavailable. For a Wordle-lineage daily habit product, two days in five being a consolation mode is worse than anything on the betting board.

Cause is upstream: the wallet is always fully at risk against a ~36% chance of losing every line. The Broke Flip is the ambulance, not the accident. The coin-cleaning minigame addresses ~14 points of it (40.3% → 26.4%) by making recovery DETERMINISTIC — the win is removing the second coin flip, not the amount. The rest is a core-loop decision: smaller mandatory exposure, a higher floor, or a bust costing a day rather than the whole wallet.

## 7. Superseded — do not reintroduce

- Spin bet resolved against a fixed median. Now against your typed line.
- Live-repricing multipliers as power pulls; power narrowing an ABSOLUTE range you bet into (both hand the player an edge — the band must be priced to its own fixed width).
- Tiered betting (side must hit for others to count) — breaks independence and the Spread's fairness.
- A stake input field; per-row stake amount inputs. The wallet IS the stake; the Spread sizes each line.
- 4-way stake split with blended-average multipliers; Direction-multiplies-Side and Exact-multiplies-Spin; "whole stake rides on each bet".
- Fading/hiding unpicked options (now colour). Constant-erase dial painting (now locked fill/wipe per hold). Edge as its own row (now the third Side option). Cardinal-letter dial labels (now arrows).
- Paged wizard; separate review screen; 4-dot horizontal stepper; Skip/Flip/Start-over buttons; native checkbox for exact.
- Shared daily flip.
- **The Spread SLIDER** (`mult^α`, `α = 2(2t−1)`). Replaced by the SPREAD/RIDE presets. It claimed neutrality while hiding a dominant setting near its own default.
- **A ladder paying by how many calls you got right.** Rejected on sight: every rung of a SHARP board pays more than every rung of a LOOSE one, so being specific read as a free upgrade — it showed the reward and hid the risk.
- **Making the Broke Flip a loan.** Modelled across 10 variants and rejected: the Broke Flip IS the money supply, so a loan reclaims the economy rather than taxing the exploit.
- **The spring-loaded throw** (anchor at the top of the stroke, power = pull DOWN from it). Replaced by a real two-phase throw measuring the up-stroke.
- **Uniform 60fps decimation of the clip library.** It corrupts the half-flip count — a bet axis — on 281 of 1024 clips. The flight is analytic instead.
- **`2*acos(|dot|)` as an aliasing metric.** It folds every rotation into [0,180] BY CONSTRUCTION, so it reports "safe" at 30fps where the coin turns 469°. A test that cannot fail.
- Quadrant buckets named N/E/S/W. Now NE/SE/SW/NW; cardinals mean exact 90° multiples only.

---

## 8. Working preferences

- Build only what's asked. **No unrequested explanatory copy, captions, or helper text.** Keep UI text minimal.
- Never say "half flips" to the player — always "spin".
- The Browser pane is usually hidden: `screenshot` fails, `requestAnimationFrame` never fires, `setTimeout` is throttled, CSS transitions don't advance (so `getComputedStyle` returns frozen start values — suppress transitions before reading colour/transform). Verify by asserting actual STATE changed, not that a control looks disabled.
- Ports: 8901 (preview, python http.server), 8787 (unrelated wrangler), 8788 (infra dev). Serve over http, never `file://` (renders as a static snapshot, no JS).
- **Verification is headless and non-negotiable.** Before reporting anything about the renderer, run all of: `node test.js`, `node tools/verify-clips.mjs`, `node tools/verify-power.mjs`, `node tools/verify-slowmo.mjs`. Node cannot `fetch` a relative path, so tools load the clip library through a `fetchShim` — copy it from `verify-power.mjs`.
- **Write tests to find bugs, not to pass.** The slow-mo work shipped three real faults caught only by its own suite, one of them a pre-existing bug on every clip in the library. If an assertion fails, decide whether the test or the design is wrong and fix the right one; if a bound is loosened, state the measured number and why the looser bound is honest.
