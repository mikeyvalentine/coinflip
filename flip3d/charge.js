// flip3d/charge.js
// ---------------------------------------------------------------------------
// THE POWER METER — press and hold the coin, drag DOWN to charge, release to
// throw. Harder pull = a more violent toss. Pointer events throughout, so mouse,
// pen and touch are one code path; the control carries touch-action:none so a
// downward drag charges instead of scrolling the page.
//
// CANCEL SEMANTICS (a limp throw is never the answer to a mistake):
//   * drag back up past MIN_POWER and release  -> cancel
//   * release with the pointer outside the control -> cancel
//   * pointercancel (the browser stealing the gesture, e.g. a system scroll) -> cancel
//   * Escape while charging -> cancel
// A cancel fires onCancel and never onThrow. The coin does not move.
//
// The gesture state machine is deliberately separated from the meter's pixels:
// `createCharge()` is pure state + callbacks and can be driven by synthetic
// events in a test, and `createMeterView()` only ever reads power out of it.
// That split is what makes the meter assertable in a hidden pane, where CSS
// transitions never advance and getComputedStyle would report frozen start
// values. NOTHING here animates via CSS — every visual is written directly to
// style on each pointermove, so what the DOM says is what is on screen.
// ---------------------------------------------------------------------------

import { MIN_POWER, CHARGE_TRAVEL_PX, clamp01 } from './power.js';

/** Forgiveness on the cancel boundary, in CSS px. */
const EDGE_SLOP = 8;

/**
 * Press-hold-drag-release over `el`.
 *
 * @param {HTMLElement} el the control (the canvas)
 * @param {object} hooks
 * @param {()=>boolean} [hooks.canStart] gate: return false to ignore a press
 * @param {(power:number)=>void} [hooks.onChange]
 * @param {(power:number, info:object)=>void} [hooks.onThrow]
 * @param {(reason:string)=>void} [hooks.onCancel]
 */
export function createCharge(el, hooks = {}) {
  const canStart = hooks.canStart ?? (() => true);
  const onChange = hooks.onChange ?? (() => {});
  const onThrow = hooks.onThrow ?? (() => {});
  const onCancel = hooks.onCancel ?? (() => {});
  const travelPx = hooks.travelPx ?? CHARGE_TRAVEL_PX;

  let active = false;
  let pointerId = null;
  let startY = 0, startX = 0, startT = 0;
  let power = 0;
  let peak = 0;

  el.style.touchAction = 'none';

  const state = () => ({ active, power, peak, pointerId });

  function set(p) {
    const next = clamp01(p);
    if (next === power) return;
    power = next;
    if (power > peak) peak = power;
    onChange(power);
  }

  function begin(ev) {
    if (active || !canStart()) return;
    active = true;
    pointerId = ev.pointerId;
    startX = ev.clientX; startY = ev.clientY;
    startT = ev.timeStamp || performance.now();
    power = 0; peak = 0;
    try { el.setPointerCapture(ev.pointerId); } catch { /* synthetic events in tests */ }
    onChange(0);
    ev.preventDefault();
  }

  function move(ev) {
    if (!active || ev.pointerId !== pointerId) return;
    // DOWNWARD drag charges. Up-drag is negative and clamps to 0, which is what
    // makes "drag back to the top" a cancel rather than a small throw.
    set((ev.clientY - startY) / travelPx);
    ev.preventDefault();
  }

  /**
   * Is the release still "on" the control?
   *
   * NOT a plain bounding-box test, and the asymmetry is deliberate. The gesture
   * is a DOWNWARD drag, and the control is a ~550 px canvas, so a press that
   * starts low and pulls a full CHARGE_TRAVEL_PX leaves the bottom edge — a
   * strict box test would make maximum power literally unthrowable, and would
   * report the hardest pulls as cancels.
   *
   * So: leaving sideways or upwards is a cancel (the "slide off the button"
   * idiom, and dragging back up is already power 0 anyway), while continuing
   * DOWN past the bottom edge is just a hard pull — the meter has been clamped
   * at 1 since the moment it got there.
   */
  function insideControl(ev) {
    const r = el.getBoundingClientRect();
    return ev.clientX >= r.left - EDGE_SLOP && ev.clientX <= r.right + EDGE_SLOP
      && ev.clientY >= r.top - EDGE_SLOP;
  }

  function finish(ev) {
    if (!active || ev.pointerId !== pointerId) return;
    const p = power;
    const outside = !insideControl(ev);
    end();
    if (outside) { onCancel('released-outside'); return; }
    if (p < MIN_POWER) { onCancel('below-minimum'); return; }
    onThrow(p, {
      peak,
      heldMs: (ev.timeStamp || performance.now()) - startT,
      dx: ev.clientX - startX,
      dy: ev.clientY - startY,
    });
  }

  function abort(reason) {
    if (!active) return;
    end();
    onCancel(reason);
  }

  function end() {
    if (pointerId != null) { try { el.releasePointerCapture(pointerId); } catch { /* ignore */ } }
    active = false; pointerId = null; power = 0;
    onChange(0);
  }

  const onDown = (ev) => begin(ev);
  const onMove = (ev) => move(ev);
  const onUp = (ev) => finish(ev);
  const onPointerCancel = () => abort('pointercancel');
  const onKey = (ev) => { if (ev.key === 'Escape') abort('escape'); };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKey);
  // A drag that leaves the window entirely: treat the lost pointer as a cancel.
  window.addEventListener('blur', onPointerCancel);

  return {
    state,
    get power() { return power; },
    get active() { return active; },
    cancel: abort,
    /** Test seam: drive the machine without a real pointing device. */
    _begin: begin, _move: move, _finish: finish,
    dispose() {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onPointerCancel);
    },
  };
}

/**
 * The meter's pixels. No CSS transitions anywhere — see the header.
 * @param {HTMLElement} host element to build inside
 */
export function createMeterView(host) {
  host.innerHTML = `
    <div class="pm-track"><div class="pm-fill"></div><div class="pm-min"></div></div>
    <div class="pm-label">hold &amp; drag down</div>`;
  const fill = host.querySelector('.pm-fill');
  const label = host.querySelector('.pm-label');
  const min = host.querySelector('.pm-min');
  min.style.bottom = (MIN_POWER * 100) + '%';

  let shown = 0;
  const TIERS = [
    // The zero-power label names the gesture, and the gesture changed: the coin
    // is picked up and pulled through, not dragged down from where it sits.
    // Leaving the old wording would have been the only instruction on screen,
    // and wrong. See flip3d/grab.js.
    [0.00, 'lift &amp; pull', '#6b7280'],
    [0.06, 'feather', '#3b82f6'],
    [0.30, 'firm', '#10b981'],
    [0.55, 'hard', '#f59e0b'],
    [0.80, 'brutal', '#ef4444'],
  ];

  function tierFor(p) {
    let t = TIERS[0];
    for (const c of TIERS) if (p >= c[0]) t = c;
    return t;
  }

  return {
    get power() { return shown; },
    get tier() { return tierFor(shown)[1]; },
    set(p) {
      shown = clamp01(p);
      const t = tierFor(shown);
      fill.style.height = (shown * 100).toFixed(2) + '%';
      fill.style.background = t[2];
      label.innerHTML = shown > 0 ? `${t[1]} · ${(shown * 100).toFixed(0)}%` : t[1];
      label.style.color = t[2];
      host.dataset.power = shown.toFixed(4);
      host.dataset.tier = t[1];
      host.dataset.armed = shown >= MIN_POWER ? '1' : '0';
    },
    flash(text, colour = '#6b7280') {
      label.innerHTML = text;
      label.style.color = colour;
      host.dataset.tier = text;
    },
    reset() { this.set(0); },
  };
}
