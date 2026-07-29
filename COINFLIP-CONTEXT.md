# COINFLIP — project context

Daily browser coin-flip betting game (Wordle-lineage daily guesser + open-ended
betting + cosmetics-only store). This file is the full handoff. Where earlier
decisions were superseded, only the CURRENT state is stated as fact; superseded
models are listed at the bottom so they aren't accidentally reintroduced.

---

## 1. Files

| Path | What |
|---|---|
| `coinflip-preview.html` | The whole 2D lite game — single self-contained file, no build step. The live prototype and source of truth for GAMEPLAY. |
| `coinflip-3d.html` + `flip3d/` | The 3D renderer. Plays baked clips. Source of truth for the VISUAL/physics side. |
| `tools/verify-*.mjs` | **The headless suites — run these, not the browser.** All ten green: `verify-clips`, `verify-power`, `verify-slowmo`, `verify-grab`, `verify-leadin`, `verify-pickup`, `verify-orient-arrow`, `verify-drop`, `verify-responsive`, plus `test.js`. No GPU, no DOM, because the preview pane is usually hidden and cannot be trusted to render or fire rAF. Every one exits non-zero on failure. |
| `bake/` | The Rapier physics bake harness (Phase 0). **DONE** — produces the curated clip library. |
| `bake/out/clips/` + `bake/out/library.json` | 1024 baked clips, verified. |
| `sim/` | **Population economy simulation.** `node sim/population.mjs` (seed `coinflip-pop-1`, 43.8M player-days, ~7s). Refuses to print an economic result until 9 self-tests pass, including a zero-edge control. Found the Spread career-EV problem and the settlement rounding bug in §3. |
| `server/` | Cloudflare Worker backend (auth, economy, leaderboard, persistence). Started, unverified (see §6). |
| `identity.js`, `daringness.js`, `fingerprint.js`, `collectSignals.client.js` | Identity/entropy modules. **Do not edit** — `test.js` proves fairness against them. |
| `game.js` | Older text-only core loop. **STALE** — still on the pre-session spin model (SPIN_N=33, includes 24). Superseded by the preview; reference only. |
| `shareCard.js` | Share-card generator. Written, working, still not wired into either build. |
| `test.js` | **Proves fairness**: 200k flips, chi-square under threshold, heads 0.500 across wildly different identities → identity never skews outcomes. `node test.js`. Must stay green after any seeding/outcome change. |

Note: the delivered zip flattened the tree — `identity/`-module files sit next to
the HTML rather than in a subdir.

---

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

### Spread slider — ⚠️ THE "CAN'T BE GAMED" CLAIM IS FALSE AT CAREER SCALE
One slider 0 (safe) → 1 (wild). Weights each placed bet by `mult^α`, `α = 2·(2t−1)`. t=0.5 is the equal split. Low t piles the wallet on heads/tails; high t pushes to long shots.

**PER FLIP the claim holds exactly.** EV = `1−EDGE_P` = 0.998 at every slider position and every bet shape — closed form to 2.2e-16, and 3M common-random-number paired flips agree.

**OVER A CAREER IT DOES NOT.** What accumulates is not EV, it is `E[max(balance − WALLET_FLOOR, 0)]` per flip — because **banking is a ratchet** (banked ₿ can never be lost) and the **Broke Flip floors losses** (bust → free 50 ₿). Gains keep, losses refund. Under that asymmetry variance is an ASSET rather than a preference, and the slider becomes a straightforward optimisation. Exact enumeration of all 8 win/lose combinations at the floor, independently reproduced:

| t | 0 | 0.3 | 0.5 | 0.75 | 1 |
|---|---|---|---|---|---|
| EV | 0.998 | 0.998 | 0.998 | 0.998 | 0.998 |
| **bankable ₿/flip** | 20.04 | **17.99** (min) | 24.21 | 40.71 | **47.41** (max) |

**2.64× between the best and worst settings.** The sim's 730-day paired run puts it at 7,520 banked at t=0.5 vs 10,727 at t=1 (disjoint 95% CIs) and — the load-bearing consequence — **epic goes from 0.0% reachable to 18.8%**. Epic is the tier that is *supposed* to be unreachable by grinding, so the slider currently decides the game.

**Two corrections to the sim's own write-up, from re-deriving it directly:**
- The minimum is at **t ≈ 0.3**, not at the midpoint.
- The preview's default is **t = 0**, not t = 0.5 (`<input id="risk" value="0">`, and `resetForm()` sets 0). Near-worst, but not the worst.

Fixing it means breaking one of three legs — the ratchet, the floor, or the reweighting — and each is load-bearing elsewhere. **Not fixed. Do not re-assert "provably can't be gamed" until it is.** Feeds `daringness.js`.

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

## 5. Open bugs — all resolved this session

1. **SPIN UNIT COLLISION — FIXED.** Rotations player-facing, half-flips internal, single conversion boundary. Verified: counter value always wins, previously-dead `.5` guesses all win, 32× stays fair.
2. **Decimal multipliers — RESOLVED.** Spin is a typed line priced `32/covered`; integer ladder is discoverable, not universal.
3. **Unbet rows during reveal — RESOLVED.** Arrows always shown; spin shows where it landed on a loss; amounts per row.

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

### THE PICK-UP GESTURE — IN FLIGHT (2026-07-29)

Replaces the press-and-drag-down charge in `charge.js`. The user's spec, verbatim:
> "I want the coin to have some sort of pick up state and you can move it up and down and depending on where you release, that is how power is calculated"
> "It should be how far you pull back and release, which starts calc as soon as you are holding the coin, if you keep fairly still for some time without releasing it, the meter will reset, in case you messed up your wind up"

**The model.** Press the coin → it leaves the table and follows the pointer. Power calc starts on grab. The **anchor** is the top of the current stroke: moving UP raises it (winding up bigger), moving DOWN builds power = `(anchor − current) / PULL_TRAVEL`. Hold still for `IDLE_RESET_MS` and the anchor snaps to the coin and power falls to 0 — a **re-arm, not a cancel**, so a botched wind-up costs nothing. Release throws; releasing below `MIN_POWER` is "you set it back down" and fires cancel. Escape also cancels.

**Coupling: GESTURE ONLY** (decided, not a placeholder). Stroke → power 0..1 → lead-in length, camera, `selectVariant` flickForce. The clip still launches from its baked 0.22 m release point and the lead-in bridges from wherever the coin was let go. The 1024 clips are untouched and `power.js#THE SEAM` stays inert. The alternative — release height IS the launch point — was rejected because every baked clip starts at 0.22 m, so a release above it has no clip to hand off to.

**The numbers that make the three pieces fit — check these before changing any of them:**
- **The lift ceiling is set by the FRAME, not by taste.** `scene.js#LIFT.maxY = 0.032 m`: the top edge of view crosses the lift line at 0.0451 m, minus a coin radius and margin. Raising it pushes the coin out of shot.
- **The pull is measured in the coin's VISIBLE travel**, never in raw pixels. The lift band is 107 px on a 480×300 canvas and 384 px at 1920×1080; against a fixed 190 px travel the same lift-and-slam is worth 0.56 power on one and 2.02 on the other. `grab.js` therefore takes `clampY` (the band) and `travelPx` as a FUNCTION (the band's height). Lift to the ceiling, slam to the table = exactly 1.0 on every canvas. `verify-grab.mjs` §10 locks this; it is an integration fault neither module can see alone.
- **The bridge has 10.2× the margin it needs.** Baked clips open at 0.220 m; the lift ceiling is 0.032 m, so the lead-in always has 0.188 m to accelerate through, against the `player.js#minBridgeMetres()` minimum of 0.0184 m. So the "released above the clip's opening" degenerate branch is **unreachable in play**. If the lift ceiling is ever raised above ~0.202 m that stops being true and the coin gets visibly snatched by the clip.

**Known issue, deliberately NOT fixed — `power.js#throwProfile`:**
`leadInMs = 2h/v` assumes a pure s² lift, but `player.js` spends `leadInAnticipation` of that duration winding up, so the moving span is only `(1−antic)` of it and the actual exit speed is `v/(1−antic)` — up to **1.35× the intended speed at power 1**, measured across the library. It predates this work. The `fromPose` path already accounts for it, so once every throw carries a `fromPose` the corrected path is the only live one. The one-line fix, if the legacy path is ever kept:
```js
leadInMs = clamp((2*h/exitSpeed)*1000 / (1 - LEADIN.anticipationMax*p*p), LEADIN.msMin, LEADIN.msMax);
```
`LEADIN.msMin = 70` is likewise now only consulted on the legacy path — the bridge derives its own floor.

**Split (agents, no shared files):**
| Owns | Job |
|---|---|
| `flip3d/grab.js`, `tools/verify-grab.mjs` | the state machine, injectable clock so the idle re-arm is testable with no real time elapsing |
| `flip3d/player.js`, `tools/verify-leadin.mjs` | `opts.fromPose` — the lead-in bridges from the released pose, exit-speed match preserved at every height |
| `flip3d/scene.js`, `tools/verify-pickup.mjs` | pointer→world-height projection (derived from the camera, NOT a tuned px/m constant), held-coin pose, shadow as the height cue |

**WIRED into `coinflip-3d.html` and all seven suites green.** `createCharge` is retired (only `createMeterView` is still imported from `charge.js`); the browser `selfTestCharge` became `selfTestGrab` and now checks the one thing the Node suite structurally cannot — that the lift band derived from the LIVE canvas rect turns one full lift-and-slam into exactly 1.0.

**RESOLVED — nobody sets the coin down, they LET GO.** (User, 2026-07-29: *"I imagine no one is going to gently put the coin down they are just going to let go."*) So the release-velocity discriminator is not needed and was not built. What falls out of the model is already correct and physical:
- Let go at the top of a lift → no downward pull → power 0 → **the coin falls.** Not a throw, no flip spent.
- Let go mid-downstroke → that IS a throw, at whatever the pull measured.
- Hold still first and the wind-up goes stale (`IDLE_RESET_MS`), so a botched wind-up costs nothing.
- `minPower` is **0.12** on the grab path (vs `power.js#MIN_POWER` 0.06). Under `charge.js` the coin only moved on a deliberate drag; now it follows the pointer the whole time, so a twitch on release would be a live throw — and a throw spends the day's only flip.

**Do NOT snap the coin home on release.** The cancel path used to call `flipper.ready()`, which animates it back to the table — wrong, because the coin is being held in the air and dropped. It now plays a real drop (below).

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

### Debts
- **Quadrant rename:** preview uses NE/SE/SW/NW; bake + renderer still use N/E/S/W in metadata/filenames. One coordinated rename owed.
- **Cosmetics pricing** (vs ~6000/yr safe banking): common 1,500 / rare 6,000 / epic 15,000 (unreachable by banking — forces riding) / mythic 50,000. Epic is the load-bearing tier that stops the Spread being a trap.

---

## 7. Superseded — do not reintroduce

- Spin bet resolved against a fixed median. Now against your typed line.
- Live-repricing multipliers as power pulls; power narrowing an ABSOLUTE range you bet into (both hand the player an edge — the band must be priced to its own fixed width).
- Tiered betting (side must hit for others to count) — breaks independence and the Spread's fairness.
- A stake input field; per-row stake amount inputs. The wallet IS the stake; the Spread sizes each line.
- 4-way stake split with blended-average multipliers; Direction-multiplies-Side and Exact-multiplies-Spin; "whole stake rides on each bet".
- Fading/hiding unpicked options (now colour). Constant-erase dial painting (now locked fill/wipe per hold). Edge as its own row (now the third Side option). Cardinal-letter dial labels (now arrows).
- Paged wizard; separate review screen; 4-dot horizontal stepper; Skip/Flip/Start-over buttons; native checkbox for exact.
- Shared daily flip.

---

## 8. Working preferences

- Build only what's asked. **No unrequested explanatory copy, captions, or helper text.** Keep UI text minimal.
- Never say "half flips" to the player — always "spin".
- The Browser pane is usually hidden: `screenshot` fails, `requestAnimationFrame` never fires, `setTimeout` is throttled, CSS transitions don't advance (so `getComputedStyle` returns frozen start values — suppress transitions before reading colour/transform). Verify by asserting actual STATE changed, not that a control looks disabled.
- Ports: 8901 (preview, python http.server), 8787 (unrelated wrangler), 8788 (infra dev). Serve over http, never `file://` (renders as a static snapshot, no JS).
- **Verification is headless and non-negotiable.** Before reporting anything about the renderer, run all of: `node test.js`, `node tools/verify-clips.mjs`, `node tools/verify-power.mjs`, `node tools/verify-slowmo.mjs`. Node cannot `fetch` a relative path, so tools load the clip library through a `fetchShim` — copy it from `verify-power.mjs`.
- **Write tests to find bugs, not to pass.** The slow-mo work shipped three real faults caught only by its own suite, one of them a pre-existing bug on every clip in the library. If an assertion fails, decide whether the test or the design is wrong and fix the right one; if a bound is loosened, state the measured number and why the looser bound is honest.
