# COINFLIP — module set

Text-only lite version + the identity/sharing layer. Node ESM, Cloudflare-Worker-portable.

## Files
- **game.js** — lite core loop. Two axes (side + spins), half-step spins (8–40 half-flips,
  derived from real physics ~4–20 full rotations). Random shown start face. Free-bet broke
  mode from 0₿. `PAYOUTS` is the primary tuning table.
- **daringness.js** — rolling bet-history → 0..1 risk trait. Slow, earned, confidence-blended.
- **fingerprint.js** — stable device hash (device half of identity; fraud + provenance).
- **identity.js** — daringness + fingerprint = identity; identity + clock + salt = uniform seed.
  Enforced split: identity feeds seed PROVENANCE + PRESENTATION only, never outcome selection.
- **collectSignals.client.js** — browser-side signal + flick capture.
- **shareCard.js** — plain-text share card. Glyph strip (🎯 exact / ✅ soft / ❌ miss),
  profit multiplier, in→out amounts, nerve meter.
- **test.js** — proves outcome stays uniform regardless of identity (the fairness guarantee).
- **playDemo.js** — scripted broke→real playthrough.

## Run
    node test.js        # fairness + daringness assertions
    node playDemo.js    # scripted playthrough with share cards
    node shareDemo.js   # share card variants

## Locked design
- Spins: half-steps, 8–40 half-flips. Live counter ticks once per half-flip (+ haptics).
- Start face random each day, shown before flip (keeps side & spins independent axes).
- Orientation (NSWE, degree readout xx.xx°, helper arrow) and The Edge: deferred to renderer.
- Outcome uniform by curated bake; identity is seed provenance + visual signature only.
- No stipend; zero out is real; busker mode = one free 50/50 for 50₿.

## Known gaps the lite version exposed
- Free-bet share card misuses the multiplier template — needs its own "FREE FLIP" format.
- Daringness is neutral for ~first week (by design) — decide if nerve meter hides until real.
- PAYOUTS untuned — run a population sim next to check the economy drifts slightly richer.
