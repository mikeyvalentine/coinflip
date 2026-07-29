// flip3d/orientArrow.js
// ---------------------------------------------------------------------------
// THE ORIENTATION HELPER — a small yellow arrow that appears when the coin has
// settled, pointing the way the design's 12 o'clock is pointing, with the
// angle to two decimals. It is the visual answer to "did my orientation bet
// land?", and nothing more than that.
//
// IT IS A READOUT. It reads a landed orientation and draws it. It imports
// nothing from the draw (no outcome.js, no library.js), touches no transform,
// and cannot change what landed. The angle it shows is the SAME quantity
// player.js reports as report.played.landedOrientationDeg — both go through
// contract.js#roundOrientation, so the two cannot disagree.
//
// COLOUR IS NOT A RESULT. Yellow means "here is the truth", not "you won". The
// staged reveal owns win/loss colour (green/red, purple for an Edge), and a
// helper that also coloured itself would be a second, competing verdict on
// screen at the same moment. So the arrow is yellow whatever happened.
//
// ===========================================================================
// THE FORESHORTENING, which is the whole reason this file is not two lines
// ===========================================================================
// The settle camera is elevDeg 66, NOT top-down, so the table plane is seen at
// a slant and a screen-space arrow rotated naively by `orientationDeg` is wrong
// everywhere except the four cardinals.
//
// Derivation, for camera azimuth `a` and elevation `e` (scene.js#cameraBasis
// builds exactly this basis, and the sweep in tools/verify-orient-arrow.mjs
// asserts the closed form below agrees with it):
//
//   a world heading th, clockwise from North, is the direction
//       d = (sin th, 0, -cos th)                     [contract.js#compassToDir]
//   the camera's right and up axes work out to
//       xAxis = ( cos a,     0,     -sin a )
//       yAxis = (-sin a sin e, cos e, -cos a sin e )
//   so the arrow's screen components are
//       right = d . xAxis = sin(th + a)
//       up    = d . yAxis = sin(e) * cos(th + a)
//
// Two things fall out of that, and both are worth stating because both are
// easy to get subtly wrong:
//
//   * AZIMUTH JUST ADDS TO THE HEADING. It rotates the whole compass rigidly.
//   * ELEVATION SQUASHES THE NORTH-SOUTH COMPONENT BY sin(e), and only that
//     component. At e = 90 (top-down) sin(e) = 1 and the map is the identity;
//     at e = 0 the table is edge-on, sin(e) = 0, and every heading collapses
//     onto the horizontal — which is geometrically right, not a bug.
//
// So the screen angle, measured CLOCKWISE FROM SCREEN-UP exactly as the world
// angle is measured clockwise from North, is
//       atan2( sin(th + a), sin(e) * cos(th + a) )
//
// WHY THE CLOSED FORM AND NOT cameraBasis() DIRECTLY. cameraBasis is the shared
// source of truth for the camera and calling it is the obvious move. It also
// works: tools/verify-orient-arrow.mjs section (6) puts the two side by side at
// every elevation from 1 to 90 and four azimuths, and they agree to 1e-12.
//
// The reason to keep the closed form anyway is narrower than it first looks,
// and worth stating accurately because the first version of this comment
// claimed something false. cameraBasis does NOT go singular at elevDeg 90 —
// it survives, but only because Math.cos(Math.PI/2) evaluates to 6.1e-17
// rather than to 0, so the cross product that builds xAxis has a length of
// 6.1e-17 and normalising it recovers exactly [1,0,0]. That is floating-point
// luck standing in for a guarantee: the function guards a zero-length basis
// with `|| 1`, and any input that made cos(e) round to a true zero would hand
// back a zero basis and turn every heading into 0 deg silently.
//
// Top-down is precisely where this function's right answer is most obvious —
// the identity — so it is the worst possible place to depend on luck. The
// closed form is exact there by construction, needs no basis at all, and puts
// the sin(e) squash (the entire physical content of this file) in plain sight
// in one line. The section (6) sweep is what stops it drifting from the camera
// the renderer actually uses.
// ===========================================================================

import {
  normDeg, roundOrientation, quadrantFromOrientation,
} from './contract.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** The settle framing this helper is drawn under. Mirrors player.js#SETTLE_CAM. */
export const SETTLE_ELEV_DEG = 66;

/**
 * Yellow. A saturated amber-yellow rather than a pale one: the coin settles on
 * a lit wooden table under a saloon HDRI, and a pale yellow washes out against
 * it. This still reads as yellow and not as the meter's "hard" amber.
 */
export const ARROW_COLOUR = '#ffc300';

/**
 * A world heading -> its on-screen rotation, in degrees clockwise from
 * screen-up. PURE. See the derivation in the header.
 *
 * @param {number} orientationDeg clockwise from North, any real number
 * @param {number} [elevDeg] camera elevation; defaults to the settle framing
 * @param {number} [azimuthDeg] camera azimuth; 0 for every shot in the game
 * @returns {number} degrees in [0, 360). Never NaN.
 */
export function orientationToScreenAngle(orientationDeg, elevDeg = SETTLE_ELEV_DEG, azimuthDeg = 0) {
  // Non-finite input is a broken caller, not a heading. Falling back to North
  // keeps this total: it feeds an SVG transform, and one NaN there silently
  // blanks the whole element rather than failing loudly.
  const th = Number.isFinite(orientationDeg) ? normDeg(orientationDeg) : 0;
  const e = Number.isFinite(elevDeg) ? elevDeg : SETTLE_ELEV_DEG;
  const a = Number.isFinite(azimuthDeg) ? azimuthDeg : 0;
  const r = (th + a) * DEG;
  return normDeg(Math.atan2(Math.sin(r), Math.sin(e * DEG) * Math.cos(r)) * RAD);
}

/**
 * The inverse: an on-screen rotation back to the world heading it represents.
 *
 * Exists for the round-trip assertion. A projection only ever exercised in one
 * direction is one whose errors cancel invisibly — the same reason
 * scene.js#worldYToScreenY exists next to screenYToWorldY.
 *
 * Undefined at elevDeg 0, where the projection is genuinely many-to-one (the
 * table is edge-on and every heading lands on the same horizontal line), so
 * that case returns NaN rather than inventing an answer.
 */
export function screenAngleToOrientation(screenDeg, elevDeg = SETTLE_ELEV_DEG, azimuthDeg = 0) {
  const s = Math.sin((Number.isFinite(elevDeg) ? elevDeg : SETTLE_ELEV_DEG) * DEG);
  if (!Number.isFinite(screenDeg) || Math.abs(s) < 1e-12) return NaN;
  const a = Number.isFinite(azimuthDeg) ? azimuthDeg : 0;
  const p = normDeg(screenDeg) * DEG;
  return normDeg(Math.atan2(Math.sin(p), Math.cos(p) / s) * RAD - a);
}

/**
 * Everything the view needs, as plain data. PURE, and separate from the DOM on
 * purpose: the preview pane is usually hidden, where nothing renders and
 * getComputedStyle reports frozen values, so the only assertable thing is the
 * state — and this is it.
 *
 * @returns {{orientationDeg:number, label:string, screenAngleDeg:number, quadrant:string}}
 */
export function arrowState(orientationDeg, elevDeg = SETTLE_ELEV_DEG, azimuthDeg = 0) {
  // ROUND FIRST, then derive everything from the rounded value. The two
  // decimals ARE the truth (design doc 6.5), and a raw 89.999999998 is the
  // outcome's 90.00 in quadrant E — deriving the label from the raw value and
  // the quadrant from the rounded one would print "90.00" next to quadrant N.
  const deg = roundOrientation(Number.isFinite(orientationDeg) ? orientationDeg : 0);
  return {
    orientationDeg: deg,
    label: deg.toFixed(2) + '°',
    screenAngleDeg: orientationToScreenAngle(deg, elevDeg, azimuthDeg),
    quadrant: quadrantFromOrientation(deg),
  };
}

/**
 * The pixels. One thin arrow and one number, small and yellow.
 *
 * NOTHING HERE ANIMATES VIA CSS. Every visual is written straight to `style` on
 * each call, because a hidden pane never advances a transition and would leave
 * the arrow frozen at its start value forever. State is mirrored onto dataset
 * attributes so what the DOM says is what is on screen.
 *
 * @param {HTMLElement} hostEl element to build inside
 * @param {object} [opts] {size, colour} — size is the SVG's px box
 */
export function createOrientArrow(hostEl, opts = {}) {
  const size = opts.size ?? 34;
  const colour = opts.colour ?? ARROW_COLOUR;
  const NS = 'http://www.w3.org/2000/svg';

  const el = hostEl.ownerDocument.createElement('div');
  el.className = 'orient-arrow';
  el.style.display = 'none';
  el.style.alignItems = 'center';
  el.style.gap = '6px';
  el.style.color = colour;
  el.style.font = 'inherit';
  el.style.fontVariantNumeric = 'tabular-nums';
  el.style.pointerEvents = 'none';

  const svg = hostEl.ownerDocument.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.style.overflow = 'visible';

  // One thin arrow, drawn pointing UP (screen-up = North at azimuth 0) and
  // rotated about the centre. Same shape language as the 2D preview's dial
  // arrows: a shaft and two head strokes, no fill, round caps.
  const g = hostEl.ownerDocument.createElementNS(NS, 'g');
  const path = hostEl.ownerDocument.createElementNS(NS, 'path');
  path.setAttribute('d', 'M50,82 L50,20 M34,36 L50,20 L66,36');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', colour);
  path.setAttribute('stroke-width', '9');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  g.appendChild(path);
  svg.appendChild(g);

  const label = hostEl.ownerDocument.createElement('span');
  label.style.color = colour;
  label.style.fontWeight = '700';

  el.appendChild(svg);
  el.appendChild(label);
  hostEl.appendChild(el);

  let state = null;

  return {
    el,
    get state() { return state; },
    /**
     * Show the arrow for a landed orientation.
     * @param {number} orientationDeg the settled angle, clockwise from North
     * @param {object} [o] {elevDeg, azimuthDeg} the framing it is drawn under
     */
    show(orientationDeg, o = {}) {
      state = arrowState(orientationDeg, o.elevDeg ?? SETTLE_ELEV_DEG, o.azimuthDeg ?? 0);
      // rotate() in SVG is clockwise for positive angles, which is the same
      // sense the compass uses, so the screen angle goes in unmodified.
      g.setAttribute('transform', `rotate(${state.screenAngleDeg.toFixed(4)} 50 50)`);
      label.textContent = state.label;
      el.style.display = 'inline-flex';
      el.dataset.orientation = state.orientationDeg.toFixed(2);
      el.dataset.screenAngle = state.screenAngleDeg.toFixed(4);
      el.dataset.quadrant = state.quadrant;
      el.dataset.shown = '1';
      return state;
    },
    hide() {
      state = null;
      el.style.display = 'none';
      el.dataset.shown = '0';
      delete el.dataset.orientation;
      delete el.dataset.screenAngle;
      delete el.dataset.quadrant;
    },
  };
}
