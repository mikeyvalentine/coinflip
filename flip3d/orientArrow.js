// flip3d/orientArrow.js
// ---------------------------------------------------------------------------
// THE ORIENTATION HELPER — a small yellow marker that appears when the coin has
// settled, sitting ON THE COIN at the bearing its design's 12 o'clock ended up
// pointing, with the angle to two decimals beside it. It is the visual answer
// to "did my orientation bet land?", and nothing more than that.
//
// IT LIVES IN THE SCENE, NOT IN A READOUT BAR. The first version put the arrow
// in the status row under the canvas, which made the player do the work: read a
// number, picture a compass, map it onto a coin lying at an angle. Now the
// marker is projected onto the coin's own rim at the settled bearing, so the
// answer is where the question is.
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

// ===========================================================================
// THE PLACEMENT, which is the other half of the maths
// ===========================================================================
// The marker sits on the table plane at the coin's settled bearing, pushed a
// little past the rim, and is then projected into screen space like any other
// world point:
//
//   world point  P = centre + compassToDir(orientation) * (COIN_RADIUS + OFFSET)
//   camera-space  x = (P - pos).xAxis,  y = (P - pos).yAxis,  z = (P - pos).zAxis
//   depth = -z            (zAxis points BACKWARDS in THREE's convention)
//   ndcY  = (y / depth) / tan(fov/2)
//   ndcX  = (x / depth) / (tan(fov/2) * aspect)
//
// That is the exact inverse of scene.js#screenYToWorldY, which unprojects with
// `ray = yAxis*s - zAxis` where `s = ndcY * tan(fov/2)` — so the two agree by
// construction rather than by coincidence, and section (11) of the verifier
// checks the round trip rather than trusting this comment.
//
// WHY A DOM OVERLAY AND NOT A three.js OBJECT. A sprite or textured mesh would
// live in the render loop for free and would get real occlusion from the coin.
// Rejected on three counts, in order of weight:
//   * the label is a two-decimal number at ~13 px, and canvas-texture text at
//     that size is mush unless you carry a high-resolution atlas around;
//   * the marker is a UI affordance, not an object — it must hold a constant
//     screen size as the camera moves, which in-scene means fighting the
//     perspective divide every frame to undo it;
//   * occlusion is a MISFEATURE here. The one thing this element must always be
//     is readable, and a scene object would let the coin hide it.
// Keeping it in the DOM also keeps this file importing nothing but contract.js,
// so it stays a readout that structurally cannot touch a transform.
// ===========================================================================

import {
  normDeg, roundOrientation, quadrantFromOrientation,
  COIN_RADIUS_M, COIN_HALF_THICKNESS_M, compassToDir,
} from './contract.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** The settle framing this helper is drawn under. Mirrors player.js#SETTLE_CAM. */
export const SETTLE_ELEV_DEG = 66;

/** The scene's vertical field of view. Mirrors scene.js's PerspectiveCamera. */
export const FOV_DEG = 30;

/**
 * How far past the rim the marker sits, in metres.
 *
 * 3 mm on a coin of radius 10.25 mm — 29% of the radius. Chosen in SCREEN terms,
 * because that is where it either works or does not: the settle camera is 105 mm
 * away with a 30 deg vertical FOV, which on an 880x550 canvas is ~9.8 px/mm. So
 * the coin is ~200 px across and the marker clears its rim by ~29 px — wide
 * enough that the rim highlight and the antialiasing cannot touch it, tight
 * enough that it still reads as attached to the coin rather than floating in the
 * scene beside it. It is a metre offset and not a pixel one on purpose: it has
 * to stay glued to the rim when the canvas resizes.
 */
export const MARKER_OFFSET_M = 0.003;

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
 * The camera's world basis for a shot.
 *
 * A local copy of scene.js#cameraBasis, deliberately. scene.js pulls in three,
 * the GLTF and HDR loaders and the whole renderer; importing it here would drag
 * all of that into a file whose entire job is to draw a triangle, and would
 * break this module's one structural guarantee — that it imports nothing but
 * contract.js and so cannot reach a transform. Section (6) of the verifier
 * pins the two implementations together at every elevation and azimuth, which
 * is what stops the copy drifting.
 *
 * THREE's convention: `zAxis` points BACKWARDS, from target toward camera.
 */
export function shotBasis(shot) {
  const e = shot.elevDeg * DEG;
  const a = shot.azimuthDeg * DEG;
  const t = shot.target;
  const pos = [
    t[0] + Math.sin(a) * Math.cos(e) * shot.distance,
    t[1] + Math.sin(e) * shot.distance,
    t[2] + Math.cos(a) * Math.cos(e) * shot.distance,
  ];
  const bx = pos[0] - t[0], by = pos[1] - t[1], bz = pos[2] - t[2];
  const bl = Math.hypot(bx, by, bz) || 1;
  const zAxis = [bx / bl, by / bl, bz / bl];
  const cx = zAxis[2], cy = 0, cz = -zAxis[0];      // cross(worldUp, zAxis)
  const cl = Math.hypot(cx, cy, cz) || 1;
  const xAxis = [cx / cl, cy / cl, cz / cl];
  const yAxis = [
    zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1],
    zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2],
    zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0],
  ];
  return { pos, xAxis, yAxis, zAxis };
}

/**
 * A world point -> where it lands on the canvas, in CSS px.
 *
 * @param {number[]} p world point
 * @param {object} shot {target, distance, elevDeg, azimuthDeg}
 * @param {{left?:number,top?:number,width:number,height:number}} rect canvas box
 * @param {number} [fovDeg] vertical field of view
 * @returns {{x:number,y:number,ndcX:number,ndcY:number,depth:number,
 *            inFront:boolean,inViewport:boolean}}
 *   Always finite. A point behind the camera reports inFront:false rather than
 *   a mirrored position — projecting it anyway is how markers appear on the
 *   wrong side of the screen and nobody can work out why.
 */
export function projectPoint(p, shot, rect, fovDeg = FOV_DEG) {
  const bad = { x: NaN, y: NaN, ndcX: NaN, ndcY: NaN, depth: 0, inFront: false, inViewport: false };
  if (!p || !shot || !rect || !(rect.width > 0) || !(rect.height > 0)) return bad;
  if (!p.every || !p.every(Number.isFinite)) return bad;
  const f = Number.isFinite(fovDeg) && fovDeg > 0 && fovDeg < 180 ? fovDeg : FOV_DEG;
  const { pos, xAxis, yAxis, zAxis } = shotBasis(shot);
  const v = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
  const dot = (a) => v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
  const depth = -dot(zAxis);                        // +ve in front of the camera
  if (!(depth > 1e-9)) return { ...bad, depth };
  const tanHalfV = Math.tan(f * DEG / 2);
  const aspect = rect.width / rect.height;
  const ndcY = (dot(yAxis) / depth) / tanHalfV;
  const ndcX = (dot(xAxis) / depth) / (tanHalfV * aspect);
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return { ...bad, depth };
  return {
    x: (rect.left ?? 0) + (ndcX + 1) / 2 * rect.width,
    y: (rect.top ?? 0) + (1 - ndcY) / 2 * rect.height,
    ndcX, ndcY, depth,
    inFront: true,
    inViewport: ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1,
  };
}

/**
 * Where the marker sits in the world: on the table plane, at the settled
 * bearing, pushed `offsetM` past the rim.
 *
 * The height is the coin's own centre height rather than the table surface, so
 * the marker sits level with the rim it is pointing at instead of sinking into
 * the wood — 0.75 mm, which is invisible at this framing but costs nothing to
 * be right about.
 */
export function markerWorldPos(orientationDeg, centre = [0, COIN_HALF_THICKNESS_M, 0],
  offsetM = MARKER_OFFSET_M) {
  const th = Number.isFinite(orientationDeg) ? normDeg(orientationDeg) : 0;
  const off = Number.isFinite(offsetM) ? offsetM : MARKER_OFFSET_M;
  const c = centre && centre.every && centre.every(Number.isFinite)
    ? centre : [0, COIN_HALF_THICKNESS_M, 0];
  const d = compassToDir(th * DEG);                 // [sin th, 0, -cos th]
  const r = COIN_RADIUS_M + off;
  return [c[0] + d[0] * r, c[1], c[2] + d[2] * r];
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
 * The full placed state: the reading, plus where on the canvas the marker goes.
 *
 * The coin centre defaults to the shot's target, because the settle shot is
 * built as `{ target: [finalPos[0], COIN_HALF_THICKNESS_M, finalPos[2]] }` —
 * the camera is already looking straight at the coin, so the target IS the
 * centre. Passing it explicitly is there for any framing where that stops
 * being true.
 *
 * @param {number} orientationDeg
 * @param {object} o {shot, rect, fovDeg, centre, offsetM}
 */
export function markerState(orientationDeg, o = {}) {
  const shot = o.shot;
  const base = arrowState(orientationDeg, shot ? shot.elevDeg : SETTLE_ELEV_DEG,
    shot ? shot.azimuthDeg : 0);
  if (!shot || !o.rect) return { ...base, world: null, screen: null };
  const centre = o.centre ?? shot.target;
  const world = markerWorldPos(base.orientationDeg, centre, o.offsetM ?? MARKER_OFFSET_M);
  const screen = projectPoint(world, shot, o.rect, o.fovDeg ?? FOV_DEG);
  // The coin centre too, so the view (and the verifier) can ask which way the
  // marker sits FROM the coin — the independent cross-check on the projection.
  const centreScreen = projectPoint(centre, shot, o.rect, o.fovDeg ?? FOV_DEG);
  return { ...base, world, screen, centreScreen };
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
  const size = opts.size ?? 14;               // "a little upside down triangle"
  const colour = opts.colour ?? ARROW_COLOUR;
  const NS = 'http://www.w3.org/2000/svg';

  const el = hostEl.ownerDocument.createElement('div');
  el.className = 'orient-arrow';
  el.style.display = 'none';
  el.style.position = 'absolute';             // placed over the canvas by show()
  el.style.alignItems = 'center';
  el.style.gap = '4px';
  el.style.color = colour;
  el.style.font = 'inherit';
  el.style.fontSize = '13px';
  el.style.lineHeight = '1';
  el.style.whiteSpace = 'nowrap';
  el.style.fontVariantNumeric = 'tabular-nums';
  el.style.pointerEvents = 'none';

  const svg = hostEl.ownerDocument.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.style.overflow = 'visible';
  svg.style.flex = '0 0 auto';

  // An upside-down triangle, apex DOWN, filled. It does not rotate: the marker's
  // POSITION carries the bearing now, so a rotating glyph would be saying the
  // same thing twice and saying it worse — at 14 px a rotated triangle mostly
  // reads as a wobble. Filled rather than stroked because a 14 px outline is
  // more antialiasing than shape.
  const tri = hostEl.ownerDocument.createElementNS(NS, 'path');
  tri.setAttribute('d', 'M14,22 L86,22 L50,86 Z');
  tri.setAttribute('fill', colour);
  svg.appendChild(tri);

  const label = hostEl.ownerDocument.createElement('span');
  label.style.color = colour;
  label.style.fontWeight = '700';

  el.appendChild(svg);
  el.appendChild(label);
  hostEl.appendChild(el);

  let state = null;
  let last = null;                            // remembered for reposition()

  function place(st) {
    if (!st.screen || !st.screen.inFront) {
      // Nothing sane to draw. Hiding beats parking it at 0,0, which looks like
      // a real reading in the corner of the canvas.
      el.style.display = 'none';
      el.dataset.placed = '0';
      return;
    }
    // The TRIANGLE centres on the projected point and the label runs to its
    // right, so the thing sitting on the coin's rim is the marker itself rather
    // than the midpoint of marker-plus-text — which would drift with the width
    // of the number.
    el.style.left = (st.screen.x - size / 2) + 'px';
    el.style.top = (st.screen.y - size / 2) + 'px';
    el.style.display = 'inline-flex';
    el.dataset.placed = '1';
    el.dataset.screenX = st.screen.x.toFixed(2);
    el.dataset.screenY = st.screen.y.toFixed(2);
  }

  return {
    el,
    size,
    get state() { return state; },
    /**
     * Show the marker for a landed orientation, placed on the coin.
     *
     * @param {number} orientationDeg the settled angle, clockwise from North
     * @param {object} [o] {shot, rect, fovDeg, centre, offsetM}
     *        With no `shot`/`rect` it still shows and still carries the reading,
     *        just unplaced — the host page can then position it however it likes.
     */
    show(orientationDeg, o = {}) {
      last = { orientationDeg, o };
      state = markerState(orientationDeg, o);
      label.textContent = state.label;
      el.style.display = 'inline-flex';
      el.dataset.orientation = state.orientationDeg.toFixed(2);
      el.dataset.screenAngle = state.screenAngleDeg.toFixed(4);
      el.dataset.quadrant = state.quadrant;
      el.dataset.shown = '1';
      if (state.screen) place(state);
      else el.dataset.placed = '0';
      return state;
    },
    /**
     * Re-place the marker without changing the reading.
     *
     * The coin no longer re-arms itself after a flip — it sits where it landed
     * until the player asks for the next one — so the marker can easily outlive
     * a window resize. Without this it would stay pinned to pixels that no
     * longer describe the same point in the scene.
     */
    reposition(o = {}) {
      if (!last) return null;
      last.o = { ...last.o, ...o };
      state = markerState(last.orientationDeg, last.o);
      if (state.screen) place(state);
      return state;
    },
    hide() {
      state = null;
      last = null;
      el.style.display = 'none';
      el.dataset.shown = '0';
      el.dataset.placed = '0';
      delete el.dataset.orientation;
      delete el.dataset.screenAngle;
      delete el.dataset.quadrant;
      delete el.dataset.screenX;
      delete el.dataset.screenY;
    },
  };
}
