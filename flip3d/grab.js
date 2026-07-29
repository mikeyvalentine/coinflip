// flip3d/grab.js
// ---------------------------------------------------------------------------
// THE PICK-UP GESTURE — press the coin to PICK IT UP, wind up, and release to
// throw. Replaces charge.js's press-and-drag-down charge, which measured power
// from the press point and so had no notion of a wind-up at all.
//
// The stroke has two halves and the ANCHOR is what separates them:
//
//   * moving UP raises the anchor. The anchor is the highest point the coin has
//     reached this stroke, so lifting is not itself power — it is buying room
//     to pull through. A big lift makes a big throw POSSIBLE, nothing more.
//   * moving DOWN from the anchor is the pull, and the pull IS the power:
//     (pointerY - anchorY) / PULL_TRAVEL_PX, clamped.
//
// Screen Y grows downward, so the anchor is a running MINIMUM of pointerY.
//
// WHY RELATIVE AND NOT ABSOLUTE HEIGHT. Mapping power to how high the coin sits
// would mean the gesture starts wrong: the coin is on the table, so power would
// begin at 0 and the only way to charge would be to lift, leaving nothing to
// pull against. Measuring the pull instead means the wind-up and the throw are
// the same motion, and it is the one the player already makes.
//
// THE IDLE RE-ARM is the recovery affordance: hold still for IDLE_RESET_MS and
// the anchor snaps to where the coin is now, dropping power to 0. A botched
// wind-up is undone by doing nothing, which is what a hand does when it has
// lost its place. It is a RE-ARM, NOT a cancel — the coin stays in your hand.
//
// It is driven by tick(), not by a timer. Nothing fires a pointermove while the
// pointer is still, so a move-driven re-arm would only ever fire on the twitch
// that ENDED the stillness — exactly backwards. And the preview pane is usually
// hidden, where requestAnimationFrame never fires and setTimeout is throttled,
// so a setTimeout-driven one could not be tested at all. The host calls tick()
// from its render loop; the clock is injectable; the verifier advances time by
// hand and no real milliseconds pass.
//
// As in charge.js, the state machine is deliberately separate from any pixels:
// this file has no DOM writes and no scene knowledge. The coin's position in
// the world comes from an injected toWorldY(); with none it works purely in CSS
// px, which is how the whole thing is testable with no browser present.
// ---------------------------------------------------------------------------

import { MIN_POWER, clamp01 } from './power.js';

/**
 * Downward travel, in CSS px, that spans a 0 -> 1 pull.
 *
 * Deliberately the same 190 px as the charge gesture it replaces: the pull is
 * the same physical motion the player was already making, so the tuned
 * sensitivity carries over unchanged. What differs is where the measurement
 * starts from — the anchor rather than the press.
 */
export const PULL_TRAVEL_PX = 190;

/**
 * Stillness, in ms, that re-arms the wind-up.
 *
 * A deliberate pause mid-gesture is a few hundred ms — reversing direction, or
 * simply aiming — and eating those would make the coin feel like it was
 * fighting the player. A lost-my-place pause is around a second. 900 ms sits
 * past the first and inside the second.
 */
export const IDLE_RESET_MS = 900;

/**
 * Movement under this, in CSS px, still counts as holding still.
 *
 * Hand tremor and trackpad noise run 1-2 px. Measured against the last
 * SIGNIFICANT position rather than the last event, which is the part that
 * matters: a slow deliberate drag emits many sub-threshold moves, and against
 * the previous event each one would read as stillness and the wind-up would
 * re-arm underneath a player who was still moving. Against the last
 * significant position the movement accumulates and correctly crosses.
 */
export const IDLE_MOVE_EPS_PX = 3;

/**
 * Pick up, wind up, release.
 *
 * @param {HTMLElement} el the control (the canvas)
 * @param {object} hooks
 * @param {(ev:object)=>boolean} [hooks.canStart] gate: false ignores a press.
 *        Receives the event, so the host can raycast the coin before allowing
 *        a pick-up — this module does no hit testing of its own.
 * @param {(info:object)=>void} [hooks.onGrab] the coin has been picked up
 * @param {(power:number, info:object)=>void} [hooks.onChange] power OR position
 *        moved. Unlike charge.js this fires on position too, because the coin
 *        has to follow the pointer even across moves that do not change power
 *        (any move at or above the anchor).
 * @param {(info:object)=>void} [hooks.onRearm] the wind-up reset under a still hand
 * @param {(power:number, info:object)=>void} [hooks.onThrow]
 * @param {(reason:string, info:object)=>void} [hooks.onCancel]
 * @param {()=>number} [hooks.now] injectable clock, ms
 * @param {number} [hooks.minPower] floor below which a release is "put it back
 *        down" rather than a throw. Defaults to power.js#MIN_POWER.
 * @param {(y:number)=>number} [hooks.clampY] restrict the pointer to the band
 *        the coin can actually occupy, so power tracks its VISIBLE travel
 * @param {number|(()=>number)} [hooks.travelPx] px spanning a 0->1 pull. A
 *        function is re-read every frame, so it survives a canvas resize.
 * @param {(clientY:number)=>number} [hooks.toWorldY] CSS px -> world metres.
 *        Owned by scene.js; absent, `worldY` is reported as null and everything
 *        else is unaffected.
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
  // BOTH OF THESE MAY BE FUNCTIONS, and for the real game both are.
  //
  // The coin's lift is bounded by the frame (scene.js#LIFT), and that bound is
  // in METRES while this file measures in PIXELS. The two are related by a
  // projection that depends on the canvas size, so a fixed pixel travel means
  // the gesture measures something different at every window size: on an
  // 880x550 canvas the whole lift band is 196 px, but it is 107 px at 480x300
  // and 384 px at 1920x1080. Against a fixed 190 px that is a full-lift-and-
  // slam worth 0.56 power on the small canvas and 2.02 on the large one — the
  // same motion, three different throws.
  //
  // And the coin CLAMPS at the ceiling while the pointer does not, so a pointer
  // driven far above the frame banks wind-up the coin never visibly made: 300 px
  // above the ceiling is 300 px of pull that shows on the meter and nowhere else.
  //
  // Passing `clampY` (the lift band, in px) and a `travelPx` function (the height
  // of that same band) makes the pull exactly the coin's VISIBLE travel: lift to
  // the ceiling, slam to the table, and that is 1.0 on any canvas, because it is
  // the same gesture measured in its own units.
  // ---------------------------------------------------------------------
  const travelPxOpt = hooks.travelPx ?? PULL_TRAVEL_PX;
  const travelOf = () => {
    const v = typeof travelPxOpt === 'function' ? travelPxOpt() : travelPxOpt;
    // A zero or broken travel would divide power to Infinity/NaN. Fall back to
    // the constant rather than poisoning every reading downstream.
    return Number.isFinite(v) && v > 0 ? v : PULL_TRAVEL_PX;
  };
  // MIN_POWER was tuned for charge.js, where charging required a deliberate
  // downward drag and an accidental one was hard to make. Here the coin follows
  // the pointer for the WHOLE gesture, so a twitch on release is a live throw —
  // and a throw spends the player's one flip for the day. Overridable for that
  // reason; the default stays put so nothing else changes.
  const minPower = Number.isFinite(hooks.minPower) ? hooks.minPower : MIN_POWER;
  const clampYOpt = hooks.clampY ?? null;
  const clampY = (y) => {
    if (!clampYOpt) return y;
    const v = clampYOpt(y);
    return Number.isFinite(v) ? v : y;
  };
  const idleResetMs = hooks.idleResetMs ?? IDLE_RESET_MS;
  const idleEpsPx = hooks.idleEpsPx ?? IDLE_MOVE_EPS_PX;
  const root = hooks.root ?? (typeof globalThis !== 'undefined' ? globalThis : null);

  let held = false;
  let pointerId = null;
  let anchorY = 0;          // top of the stroke: a running MINIMUM of pointerY
  let pointerX = 0, pointerY = 0;
  let grabX = 0, grabY = 0; // where the coin was picked up
  let restX = 0, restY = 0; // last position that counted as real movement
  let restT = 0;            // when the pointer arrived there
  let grabT = 0;
  let power = 0;
  let peak = 0;
  let rearmed = false;      // suppresses a second re-arm inside one still spell

  if (el && el.style) el.style.touchAction = 'none';

  function info() {
    return {
      power,
      peak,
      pullPx: pointerY - anchorY,
      anchorY,
      pointerY,
      pointerX,
      worldY: toWorldY ? toWorldY(pointerY) : null,
      held,
      rearmed,
      heldMs: held ? now() - grabT : 0,
    };
  }

  /**
   * Power follows from the anchor; it is never set directly from an event.
   *
   * Emits unconditionally, where charge.js suppressed unchanged values: the
   * coin has to track the pointer across moves that do not change power at all
   * (anything at or above the anchor), so a power-only dedupe would freeze it.
   */
  function recompute() {
    power = clamp01((pointerY - anchorY) / travelOf());
    if (power > peak) peak = power;
    onChange(power, info());
  }

  function rearm() {
    if (!held) return false;
    const had = power > 0;
    anchorY = pointerY;
    restX = pointerX; restY = pointerY;
    restT = now();
    rearmed = true;
    power = 0;
    // A re-arm with nothing wound up changes nothing on screen, and announcing
    // it would flash a "reset" at a player who had simply not moved yet.
    if (had) { onRearm(info()); onChange(power, info()); }
    return had;
  }

  function begin(ev) {
    if (held || !canStart(ev)) return;
    const x = ev.clientX, rawY = ev.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(rawY)) return;
    const y = clampY(rawY);
    held = true;
    pointerId = ev.pointerId;
    pointerX = x; pointerY = y;
    grabX = x; grabY = y;
    anchorY = y;
    restX = x; restY = y;
    restT = now();
    grabT = restT;
    power = 0; peak = 0; rearmed = false;
    try { el.setPointerCapture(ev.pointerId); } catch { /* synthetic events in tests */ }
    onGrab(info());
    onChange(0, info());
    if (ev.preventDefault) ev.preventDefault();
  }

  function move(ev) {
    if (!held || ev.pointerId !== pointerId) return;
    const x = ev.clientX, y = ev.clientY;
    // A non-finite coordinate is a broken event, not a gesture. Letting one
    // through would poison the anchor and every power reading after it, and
    // NaN survives clamping.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    applyPosition(x, y);
    if (ev.preventDefault) ev.preventDefault();
  }

  /**
   * Take the pointer to (x, y), running the idle clock and the anchor rule.
   * Shared by move and release: "depending on where you RELEASE" means the
   * pointerup's own coordinates are part of the gesture, not just the last
   * pointermove before it. Browsers do deliver a release at a position no move
   * reported, and dropping it would quietly discard the final few px of pull.
   */
  function applyPosition(x, rawY) {
    // Clamp FIRST, so every downstream quantity — the idle test, the anchor,
    // the pull — is measured on the position the coin actually took. Clamping
    // later would let the un-clamped travel leak into one of them.
    const y = clampY(rawY);
    const moved = Math.hypot(x - restX, y - restY) > idleEpsPx;
    pointerX = x; pointerY = y;

    if (moved) {
      restX = x; restY = y; restT = now();
      rearmed = false;
    } else if (!rearmed && now() - restT >= idleResetMs) {
      rearm();       // still, and has been for long enough — the wind-up is stale
      return;
    }

    // The anchor only ever rises. Pulling down cannot lower it, or the pull
    // would be measured from wherever the hand happened to be and every throw
    // would read as maximum.
    if (pointerY < anchorY) anchorY = pointerY;
    recompute();
  }

  /**
   * Advance the idle clock. Safe to call every frame, held or not.
   * This is the ONLY thing that can re-arm a genuinely motionless pointer,
   * because a motionless pointer emits no events.
   */
  function tick() {
    if (!held || rearmed) return false;
    if (now() - restT < idleResetMs) return false;
    return rearm();
  }

  function finish(ev) {
    if (!held || ev.pointerId !== pointerId) return;
    // The release position is part of the pull — see applyPosition.
    if (Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) {
      applyPosition(ev.clientX, ev.clientY);
    }
    const p = power;
    const snapshot = info();
    end();
    // Below the minimum this was not a throw — the coin was picked up and put
    // back down. Releasing a limp gesture as a limp throw is never what was
    // meant, and the player has already told us so by not pulling.
    if (p < minPower) { onCancel('below-minimum', snapshot); return; }
    onThrow(p, {
      ...snapshot,
      heldMs: now() - grabT,
      // The whole stroke, grab to release. dy is NOT the pull: a wind-up that
      // went up 100 and back down 150 ends 50 px below where it started while
      // having pulled 150. `pullPx` is the pull; these two are telemetry.
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
    held = false; pointerId = null; power = 0; rearmed = false;
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
    /** charge.js-compatible alias; the host page reads `.active` today. */
    get active() { return held; },
    get minPower() { return minPower; },
    get anchorY() { return anchorY; },
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
