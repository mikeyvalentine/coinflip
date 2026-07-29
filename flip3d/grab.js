// flip3d/grab.js
// ---------------------------------------------------------------------------
// THE THROW — press the coin, wind up, and throw it. Two phases, measured the
// way a real throw is: the pull-back records DISTANCE, the up-stroke records
// SPEED, and the up-stroke is what actually throws the coin.
//
// WHAT THIS REPLACED AND WHY. The previous model was a spring: an anchor
// tracked the highest point of the stroke and power was how far you pulled DOWN
// from it, so releasing at the bottom of the pull threw hardest. It measured
// correctly and it was backwards — nobody throws by letting go at the bottom of
// a downswing. Played on a real screen it read as winding a catapult, not as
// throwing a coin.
//
// THE TWO PHASES
//
//   apexY   the top the pull-back is measured from.
//   deepY   the bottom of the pull-back — the deepest the hand has gone.
//
//   wind    = deepY - apexY      how far back you pulled.      MINOR term.
//   throw   = deepY - pointerY   how far back up you have come. MAJOR term,
//                                together with the SPEED you are doing it at.
//
// So during the pull-back the meter fills slowly, and during the up-stroke it
// fills the rest — which is the behaviour that was asked for, and it falls out
// of the geometry rather than being special-cased.
//
// TELLING A SETUP LIFT FROM A THROW IS THE HARD PART, and position alone cannot
// do it — both move the pointer upward. The first version of this reset the
// wind-up on any new high, which quietly destroyed every throw that carried
// above the grab point: the stroke it was measuring vanished at the moment it
// mattered, and power collapsed to the velocity term alone. See stepPhase().
//
// THE SPLIT IS 25 / 75. "Majority" was the instruction. 75% on the throw makes
// the up-stroke unambiguously the thing that matters, while 25% is still a
// visible quarter of the meter — enough that a big wind-up reads as worth
// making. Pushing it to 90/10 was tried on paper and rejected: it makes the
// pull-back decorative, and the instruction was that it fills the meter, just
// slowly. Inside the throw's 75, speed carries 50 and distance 25, so velocity
// is the single largest term of the three.
//
// WHY VELOCITY IS MEASURED OVER A TIME WINDOW, NOT BETWEEN TWO EVENTS.
// A last-two-events delta is a sample of noise: at 240 Hz two adjacent moves are
// 4 ms apart and a single 1 px jitter reads as 250 px/s. Worse, the SAME throw
// would measure differently on a 60 Hz mouse and a 240 Hz one, because the delta
// covers a different slice of time. Taking the endpoints of a fixed 60 ms window
// makes the estimate rate-independent by construction: both mice are asked the
// same question — where was the pointer 60 ms ago — and both answer it the same.
// 60 ms because a flick lasts 80-150 ms, so the window sits inside the fast part
// without averaging in the stationary approach to it.
//
// RELEASING WHILE STILL MOVING DOWN IS A DROP, NOT A WEAK THROW. Letting go
// mid-downswing is not a throw in any physical sense — the coin has downward
// momentum and should fall. It is reported as a cancel, which the host already
// answers with the drop animation, so the coin behaves exactly as a real one
// would. This is checked BEFORE the power floor, so a big wind-up released on
// the way down still drops rather than sneaking past on its wind-up alone.
//
// THE IDLE RE-ARM survives, with "botched" redefined for the new model: a hand
// that wound up and then stopped, without throwing. Hold still for
// IDLE_RESET_MS and the wind-up goes stale — apex and deep collapse to where you
// are and the meter empties. It is a RE-ARM, NOT a cancel; the coin stays held.
// It is driven by tick() rather than a timer, because a motionless pointer emits
// no events and the preview pane never fires requestAnimationFrame anyway.
//
// THE SETTLE WINDOW. Picking the coin up moves the camera (scene.js#HOLD_SHOT
// drops the table out of the way to make room to throw in), and while that
// transition runs the pixels-to-metres mapping is changing underneath the hand.
// Measuring a stroke against a moving ruler would make the same gesture worth
// different amounts depending on how fast the player started. So for settleMs
// after the grab the coin still follows the pointer — it must, or the pick-up
// feels dead — but apex and deep are re-based to the live position every event,
// so measurement effectively begins from wherever the hand is when the camera
// stops. Default 0, so nothing that does not opt in is affected.
//
// As before, the state machine is deliberately separate from any pixels: no DOM
// writes and no scene knowledge. The coin's world height comes from an injected
// toWorldY(); with none it works purely in CSS px, which is what makes the whole
// thing testable with no browser present.
// ---------------------------------------------------------------------------

import { MIN_POWER, clamp01 } from './power.js';

/**
 * Fallback travel, in CSS px, spanning a 0 -> 1 pull-back or up-stroke.
 *
 * Only used when the host does not pass a `travelPx`. The real game always does
 * — it derives it from the coin's visible lift band, so the gesture measures the
 * same thing at every canvas size. See the note on travelPx below.
 */
export const PULL_TRAVEL_PX = 190;

/** Stillness, in ms, that re-arms a stale wind-up. */
export const IDLE_RESET_MS = 900;

/**
 * Movement under this, in CSS px, still counts as holding still.
 *
 * Measured against the last SIGNIFICANT position rather than the last event: a
 * slow deliberate drag emits many sub-threshold moves, and against the previous
 * event every one of them reads as stillness, so the wind-up would re-arm
 * underneath a player who was still moving. Against the last significant
 * position the movement accumulates and correctly crosses.
 */
export const IDLE_MOVE_EPS_PX = 3;

// --- the power split -------------------------------------------------------
/** Pull-back distance. The minor term — see the header. */
export const WIND_WEIGHT = 0.25;
/** Up-stroke SPEED. The single largest term. */
export const VEL_WEIGHT = 0.50;
/** Up-stroke DISTANCE. */
export const THROW_DIST_WEIGHT = 0.25;

/**
 * Full-power throw speed, expressed as SECONDS TO CROSS THE WHOLE LIFT BAND.
 *
 * Band-relative, not absolute px/s, and that is the whole point. The distance
 * terms are already measured against the band so they mean the same thing at
 * every canvas size; an absolute velocity threshold would not, and full power
 * would get progressively cheaper as the window grew — a 1920-wide canvas has a
 * 753 px band against 209 px on a phone, so the same hand movement covers 3.6x
 * the pixels. That is the identical bug the fixed 190 px travel used to have.
 *
 * THE VALUE IS AN ASSUMPTION and is the one most likely to need retuning against
 * a real hand. 0.175 s to cross the band works out to ~2200 px/s on the default
 * 880x550 canvas. Ordinary mouse flicks measure 2000-4000 px/s and touch swipes
 * 1500-3000, so that sits at the bottom of both ranges: reachable without a
 * violent gesture on either device, and comfortably exceeded by a hard one,
 * which is what the clamp is for. Setting it at the TOP of those ranges would
 * make full power a wrist injury on a trackpad.
 */
export const VEL_FULL_BAND_SEC = 0.175;

/**
 * The absolute equivalent on the default canvas, kept for reference and for the
 * fallback when no travel is supplied. Derived, not chosen.
 */
export const VEL_FULL_PX_S = Math.round(PULL_TRAVEL_PX / VEL_FULL_BAND_SEC);

/** Window, in ms, the velocity estimate spans. See the header for why. */
export const VEL_WINDOW_MS = 60;

/**
 * Largest pointer jump, in CSS px, that can be part of a throw.
 *
 * A HAND cannot teleport; a pointer can. Flick up and off the top of the window
 * and the pointer leaves in one event — and because clampY pins it to the top of
 * the lift band, that single event manufactures a FULL-BAND displacement. On a
 * default canvas that reads as ~25,000 px/s against a full-power threshold of
 * ~2,300, so throwing the mouse off the screen was the strongest possible throw.
 * It was also the easiest, which made it the correct strategy.
 *
 * 160 px is generous for one event: a fast 4,000 px/s hand covers ~67 px between
 * frames at 60 Hz, and far less at higher polling rates. Anything past this is a
 * discontinuity, not a gesture, so the stroke ENDS at the last good position
 * rather than banking the jump.
 */
export const MAX_JUMP_PX = 160;

/**
 * Upward speed, px/s, below which a release is a DROP rather than a throw.
 *
 * Above hand tremor and trackpad noise (which run tens of px/s at most), well
 * below any deliberate lift. A release slower than this had no throw in it.
 */
export const MIN_THROW_VEL_PX_S = 120;

/**
 * Direction changes smaller than this, in CSS px, are noise rather than a
 * reversal. Sits just above IDLE_MOVE_EPS_PX so a hand that is "still" by the
 * idle test cannot also be flipping the wind/throw phase back and forth.
 */
export const REVERSE_EPS_PX = 4;

/**
 * Press, wind up, throw.
 *
 * @param {HTMLElement} el the control (the canvas)
 * @param {object} hooks
 * @param {(ev:object)=>boolean} [hooks.canStart] gate: false ignores a press.
 *        Receives the event, so the host can raycast the coin — this module does
 *        no hit testing of its own.
 * @param {(info:object)=>void} [hooks.onGrab] the coin has been picked up
 * @param {(power:number, info:object)=>void} [hooks.onChange] power OR position
 *        moved. Fires on position too, because the coin has to track the pointer
 *        across moves that do not change power at all.
 * @param {(info:object)=>void} [hooks.onRearm] the wind-up went stale
 * @param {(power:number, info:object)=>void} [hooks.onThrow]
 * @param {(reason:string, info:object)=>void} [hooks.onCancel] 'dropped',
 *        'below-minimum', 'escape', 'pointercancel', 'pointer-left'
 * @param {()=>number} [hooks.now] injectable clock, ms
 * @param {number} [hooks.settleMs] ignore measurement for this long after the
 *        grab, while the camera framing transitions. Default 0.
 * @param {number} [hooks.minPower] floor below which a release is a put-back
 * @param {(y:number)=>number} [hooks.clampY] restrict the pointer to the band the
 *        coin can actually occupy, so power tracks its VISIBLE travel
 * @param {number|(()=>number)} [hooks.travelPx] px spanning a full stroke. A
 *        function is re-read every event, so it survives a canvas resize.
 * @param {(clientY:number)=>number} [hooks.toWorldY] CSS px -> world metres
 * @param {object} [hooks.root] where window-level listeners go (default globalThis)
 */
export function createGrab(el, hooks = {}) {
  const canStart = hooks.canStart ?? (() => true);
  const onGrab = hooks.onGrab ?? (() => {});
  const onChange = hooks.onChange ?? (() => {});
  const onRearm = hooks.onRearm ?? (() => {});
  const onThrow = hooks.onThrow ?? (() => {});
  const onCancel = hooks.onCancel ?? (() => {});
  const now = hooks.now ?? (() => performance.now());
  const toWorldY = hooks.toWorldY ?? null;

  // ---------------------------------------------------------------------
  // travelPx MAY BE A FUNCTION, and in the real game it is.
  //
  // The coin's lift is bounded in METRES by the frame (scene.js#LIFT) while
  // this file measures in PIXELS, and the projection between them depends on
  // canvas size. A fixed pixel travel therefore measures something different at
  // every window size — the same stroke would be worth 0.56 power on a small
  // canvas and 2.02 on a large one. Passing the live band height keeps one full
  // stroke worth exactly 1.0 everywhere, because it is the same gesture measured
  // in its own units.
  // ---------------------------------------------------------------------
  const travelPxOpt = hooks.travelPx ?? PULL_TRAVEL_PX;
  const travelOf = () => {
    const v = typeof travelPxOpt === 'function' ? travelPxOpt() : travelPxOpt;
    // A zero or broken travel would divide power to Infinity/NaN. Fall back to
    // the constant rather than poisoning every reading downstream.
    return Number.isFinite(v) && v > 0 ? v : PULL_TRAVEL_PX;
  };

  // The coin follows the pointer for the whole gesture, so a twitch on release
  // would be a live throw — and a throw spends the player's one flip for the
  // day. Overridable for that reason; the default stays put.
  const minPower = Number.isFinite(hooks.minPower) ? hooks.minPower : MIN_POWER;
  const clampYOpt = hooks.clampY ?? null;
  const clampY = (y) => {
    if (!clampYOpt) return y;
    const v = clampYOpt(y);
    return Number.isFinite(v) ? v : y;
  };
  const idleResetMs = hooks.idleResetMs ?? IDLE_RESET_MS;
  const idleEpsPx = hooks.idleEpsPx ?? IDLE_MOVE_EPS_PX;
  const settleMs = Number.isFinite(hooks.settleMs) && hooks.settleMs > 0 ? hooks.settleMs : 0;
  const velWindowMs = Number.isFinite(hooks.velWindowMs) && hooks.velWindowMs > 0
    ? hooks.velWindowMs : VEL_WINDOW_MS;
  // Re-read every time, because travelOf() can change with the canvas.
  const velFullOf = () => (Number.isFinite(hooks.velFullPxS) && hooks.velFullPxS > 0
    ? hooks.velFullPxS
    : travelOf() / VEL_FULL_BAND_SEC);
  const minThrowVel = Number.isFinite(hooks.minThrowVelPxS) && hooks.minThrowVelPxS >= 0
    ? hooks.minThrowVelPxS : MIN_THROW_VEL_PX_S;
  const root = hooks.root ?? (typeof globalThis !== 'undefined' ? globalThis : null);

  let held = false;
  let pointerId = null;
  let apexY = 0;            // running MIN of pointerY — the highest the hand has been
  let deepY = 0;            // running MAX since the apex last moved — bottom of the pull
  let pointerX = 0, pointerY = 0;
  let grabX = 0, grabY = 0;
  let restX = 0, restY = 0; // last position that counted as real movement
  let restT = 0;
  let grabT = 0;
  let power = 0;
  let peak = 0;
  let rearmed = false;
  let samples = [];         // {t, y} for the velocity window
  let lastRawY = null;      // pre-clamp, so a teleport can be spotted at all
  let jumped = false;       // the pointer discontinued; the stroke is frozen
  let phase = 'wind';       // 'wind' (pulling back) | 'throw' (up-stroke)
  let prevY = 0;            // previous pointerY, for direction inside a throw
  let deepT = 0;            // when the pointer was last at deepY — see upVelocity

  if (el && el.style) el.style.touchAction = 'none';

  /** Still inside the camera transition, so nothing is measured yet. */
  const settling = () => settleMs > 0 && held && (now() - grabT) < settleMs;

  const windPx = () => Math.max(0, deepY - apexY);
  // Only the throw phase has a throw distance. In the wind phase the pointer is
  // at or below the deepest point by construction, so this would otherwise
  // report a slow reposition upward as throw distance.
  const throwPx = () => (phase === 'throw' ? Math.max(0, deepY - pointerY) : 0);

  /**
   * The wind / throw phase machine.
   *
   * The hard part is telling a SETUP LIFT from a THROW. Both move the pointer
   * upward, and position alone cannot separate them — which is exactly the bug
   * the first version had: a throw that carried above the grab point looked like
   * a new lift, reset the wind-up, and threw away the stroke it was measuring.
   *
   * The honest discriminator is SPEED. Repositioning is slow; a throw is not.
   * So an upward move only becomes a throw once it is moving faster than
   * MIN_THROW_VEL_PX_S — the same floor that decides a release was a throw at
   * all, reused rather than a second tunable that could drift away from it.
   *
   * Reversing downward inside a throw hands control back to the wind phase, so
   * "lift, pull, half-throw, change your mind, pull deeper, throw" all works
   * without any of it being special-cased.
   */
  function stepPhase(y) {
    if (phase === 'wind') {
      if (y > deepY) { deepY = y; deepT = now(); return; }  // pulling down
      if (y < deepY - REVERSE_EPS_PX && upVelocity() >= minThrowVel) {
        phase = 'throw';                                    // a real up-stroke
        return;
      }
      // A slow move upward is repositioning: it raises the top the pull will be
      // measured from, and spends whatever was wound before.
      if (y < apexY) { apexY = y; deepY = y; deepT = now(); }
      return;
    }
    // phase === 'throw'
    if (y > prevY + REVERSE_EPS_PX) {
      phase = 'wind';                                       // changed their mind
      apexY = Math.min(apexY, prevY);
      deepY = y; deepT = now();
    }
  }

  /**
   * Upward pointer speed in px/s, from the endpoints of the velocity window.
   * Positive is upward (screen Y grows downward, so the sign flips here).
   *
   * Endpoints rather than an average of per-event deltas: that is what makes
   * the number the same on a 60 Hz mouse and a 240 Hz one.
   */
  function upVelocity() {
    if (samples.length < 2) return 0;
    const newest = samples[samples.length - 1];
    // The oldest sample still inside the window AND no older than the bottom of
    // the pull.
    //
    // That second bound is not a nicety. Without it the window can straddle the
    // reversal at the bottom of a wind-up, and since the estimate is a net
    // displacement, a fast down-then-up cancels itself out and a hard flick
    // reads as motionless — worst exactly where the throw is hardest. Clipping
    // at deepT means the up-stroke's speed is measured over the up-stroke.
    const floorT = Math.max(newest.t - velWindowMs, deepT);
    let oldest = samples[samples.length - 1];
    for (const s of samples) {
      if (s.t >= floorT) { oldest = s; break; }
    }
    // If everything in the buffer is older than the window (a long pause then a
    // single move), fall back to the last two so a genuine flick is not lost.
    if (newest.t - oldest.t > velWindowMs && samples.length >= 2) {
      oldest = samples[samples.length - 2];
    }
    const dt = newest.t - oldest.t;
    if (!(dt > 0)) return 0;
    return (oldest.y - newest.y) / dt * 1000;
  }

  function pushSample(y) {
    const t = now();
    samples.push({ t, y });
    // Keep one sample beyond the window so a full window is always spannable.
    let cut = 0;
    while (cut < samples.length - 2 && t - samples[cut + 1].t > velWindowMs) cut++;
    if (cut > 0) samples = samples.slice(cut);
  }

  function info() {
    const tv = travelOf();
    const v = upVelocity();
    return {
      power,
      peak,
      windPx: windPx(),
      throwPx: throwPx(),
      upVelPxS: v,
      windNorm: clamp01(windPx() / tv),
      throwNorm: clamp01(throwPx() / tv),
      velNorm: clamp01(v / velFullOf()),
      apexY,
      deepY,
      pointerY,
      pointerX,
      worldY: toWorldY ? toWorldY(pointerY) : null,
      held,
      rearmed,
      phase,
      settling: settling(),
      heldMs: held ? now() - grabT : 0,
    };
  }

  /**
   * Power is DERIVED, never assigned from an event.
   *
   * Emits unconditionally rather than deduping on an unchanged value: the coin
   * has to track the pointer across moves that do not change power at all (any
   * move while the meter is already clamped), and a power-only dedupe would
   * freeze it mid-gesture.
   */
  function recompute() {
    const tv = travelOf();
    const wind = clamp01(windPx() / tv);
    const dist = clamp01(throwPx() / tv);
    const vel = clamp01(upVelocity() / velFullOf());
    power = clamp01(WIND_WEIGHT * wind + VEL_WEIGHT * vel + THROW_DIST_WEIGHT * dist);
    if (power > peak) peak = power;
    onChange(power, info());
  }

  function rearm() {
    if (!held) return false;
    const had = power > 0;
    apexY = pointerY; deepY = pointerY; deepT = now();
    phase = 'wind'; prevY = pointerY;
    samples = [];
    lastRawY = null; jumped = false;
    restX = pointerX; restY = pointerY;
    restT = now();
    rearmed = true;
    power = 0;
    // A re-arm with nothing wound up changes nothing on screen, and announcing
    // it would flash a reset at a player who had simply not moved yet.
    if (had) { onRearm(info()); onChange(power, info()); }
    return had;
  }

  function begin(ev) {
    if (held || !canStart(ev)) return;
    const x = ev.clientX, rawY = ev.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(rawY)) return;
    const y = clampY(rawY);
    const restT0 = now();
    restT = restT0;
    held = true;
    pointerId = ev.pointerId;
    pointerX = x; pointerY = y;
    grabX = x; grabY = y;
    apexY = y; deepY = y; deepT = restT0;
    phase = 'wind'; prevY = y;
    restX = x; restY = y;
    grabT = restT0;
    power = 0; peak = 0; rearmed = false;
    samples = [{ t: grabT, y }];
    lastRawY = rawY; jumped = false;
    try { el.setPointerCapture(ev.pointerId); } catch { /* synthetic events in tests */ }
    onGrab(info());
    onChange(0, info());
    if (ev.preventDefault) ev.preventDefault();
  }

  function move(ev) {
    if (!held || ev.pointerId !== pointerId) return;
    const x = ev.clientX, y = ev.clientY;
    // A non-finite coordinate is a broken event, not a gesture. Letting one
    // through would poison the apex and every reading after it, and NaN survives
    // clamping.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    applyPosition(x, y);
    if (ev.preventDefault) ev.preventDefault();
  }

  /**
   * Take the pointer to (x, y), running the idle clock and the apex/deep rule.
   *
   * Shared by move and release: the pointerup's own coordinates are part of the
   * gesture, and browsers do deliver a release at a position no move reported.
   * Dropping it would discard the last few px — and the fastest part — of a
   * flick, which is precisely the part the throw is measured on.
   */
  function applyPosition(x, rawY) {
    // A DISCONTINUITY IS NOT A GESTURE. Measured on the RAW position, before
    // clamping — clamping is exactly what disguises the jump, by folding an
    // off-screen fling into a legal-looking full-band sweep. Past the threshold
    // the pointer is treated as gone: the stroke freezes at the last good
    // position and nothing about the jump reaches the velocity estimate.
    if (jumped) { lastRawY = rawY; return; }   // stroke is over; nothing re-opens it
    if (lastRawY != null && Math.abs(rawY - lastRawY) > MAX_JUMP_PX) {
      lastRawY = rawY;
      jumped = true;
      return;
    }
    lastRawY = rawY;
    // Clamp, so the idle test, the apex, the pull and the velocity are all
    // measured on the position the coin actually took.
    const y = clampY(rawY);
    const moved = Math.hypot(x - restX, y - restY) > idleEpsPx;
    pointerX = x; pointerY = y;
    pushSample(y);

    if (moved) {
      restX = x; restY = y; restT = now();
      rearmed = false;
    } else if (!rearmed && now() - restT >= idleResetMs) {
      rearm();     // still, and has been for long enough — the wind-up is stale
      return;
    }

    if (settling()) {
      // The camera is still moving, so the ruler is moving. Track the pointer,
      // measure nothing: re-base to here and start the stroke from wherever the
      // hand is when the transition finishes.
      apexY = y; deepY = y; deepT = now();
      phase = 'wind'; prevY = y;
      samples = [{ t: now(), y }];
      power = 0;
      onChange(power, info());
      return;
    }

    stepPhase(y);
    prevY = y;
    recompute();
  }

  /**
   * Advance the idle clock. Safe to call every frame, held or not. The ONLY
   * thing that can re-arm a genuinely motionless pointer, because a motionless
   * pointer emits no events.
   */
  function tick() {
    if (!held || rearmed) return false;
    if (now() - restT < idleResetMs) return false;
    return rearm();
  }

  function finish(ev) {
    if (!held || ev.pointerId !== pointerId) return;
    // THE POINTER LEFT, so whatever comes back is not the end of a throw. Freezing
    // the stroke was not enough on its own: the release arrives at the SAME
    // out-of-range coordinate the jump did, so the jump test sees no movement,
    // waves it through, and clampY folds it back into a full-band sweep — the
    // exploit, restored by the very event that ends the gesture.
    if (jumped) {
      const snapshot = info();
      end();
      onCancel('pointer-left', snapshot);
      return;
    }
    // The release position is part of the throw — see applyPosition.
    if (Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) {
      applyPosition(ev.clientX, ev.clientY);
    }
    const v = upVelocity();
    const p = power;
    const snapshot = info();
    end();

    // ORDER MATTERS. The drop test comes FIRST, before the power floor: a big
    // wind-up released on the way down carries enough wind term to clear the
    // floor, and letting that through would throw a coin the player never threw.
    if (!(v >= minThrowVel)) { onCancel('dropped', snapshot); return; }
    // Below the floor it was a fumble, not a throw.
    if (p < minPower) { onCancel('below-minimum', snapshot); return; }

    onThrow(p, {
      ...snapshot,
      heldMs: now() - grabT,
      // The whole stroke, grab to release. dy is NOT the throw: a wind-up that
      // went down 150 and back up 100 ends 50 px below where it started while
      // having thrown 100. `windPx`/`throwPx` are the gesture; these are telemetry.
      dx: pointerX - grabX,
      dy: pointerY - grabY,
    });
  }

  function abort(reason) {
    if (!held) return;
    const snapshot = info();
    end();
    onCancel(reason, snapshot);
  }

  function end() {
    if (pointerId != null && el) {
      try { el.releasePointerCapture(pointerId); } catch { /* ignore */ }
    }
    held = false; pointerId = null; power = 0; rearmed = false; samples = [];
    onChange(0, info());
  }

  const onDown = (ev) => begin(ev);
  const onMove = (ev) => move(ev);
  const onUp = (ev) => finish(ev);
  const onPointerCancel = () => abort('pointercancel');
  const onKey = (ev) => { if (ev.key === 'Escape') abort('escape'); };

  const elListeners = [
    ['pointerdown', onDown], ['pointermove', onMove],
    ['pointerup', onUp], ['pointercancel', onPointerCancel],
  ];
  // Escape and a lost window are both "the gesture is over and it was not a
  // throw", and neither is delivered to the canvas.
  const rootListeners = [['keydown', onKey], ['blur', onPointerCancel]];

  if (el && el.addEventListener) for (const [t, fn] of elListeners) el.addEventListener(t, fn);
  if (root && root.addEventListener) for (const [t, fn] of rootListeners) root.addEventListener(t, fn);

  return {
    state: () => info(),
    get power() { return power; },
    get peak() { return peak; },
    get held() { return held; },
    /** charge.js-compatible alias; the host page reads `.active`. */
    get active() { return held; },
    get minPower() { return minPower; },
    get windPx() { return windPx(); },
    get throwPx() { return throwPx(); },
    get upVelPxS() { return upVelocity(); },
    get phase() { return phase; },
    get settling() { return settling(); },
    get pointerY() { return pointerY; },
    get worldY() { return toWorldY ? toWorldY(pointerY) : null; },
    tick,
    rearm: () => rearm(),
    cancel: abort,
    /** Test seam: drive the machine without a real pointing device. */
    _begin: begin, _move: move, _finish: finish,
    dispose() {
      if (el && el.removeEventListener) for (const [t, fn] of elListeners) el.removeEventListener(t, fn);
      if (root && root.removeEventListener) for (const [t, fn] of rootListeners) root.removeEventListener(t, fn);
    },
  };
}
