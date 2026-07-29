// flip3d/orientArrow.js
// ---------------------------------------------------------------------------
// THE ORIENTATION DIAL — when the coin settles, a mostly-transparent compass
// dial is painted ONTO its face: four quadrant sectors, the one the coin landed
// in filled brighter, and an arrow on the rim marking where the design's
// 12 o'clock actually ended up pointing.
//
// It is the visual answer to "did my orientation bet land?", and nothing more.
//
// WHAT THIS REPLACED, AND WHY. First it was a yellow arrow in the status row
// under the canvas, which made the player do the work: read a number, picture a
// compass, map it onto a coin lying at an angle. Then it was an arrow projected
// onto the coin's rim with the angle beside it — better, but a flat screen-space
// glyph on a coin the camera is clearly seeing at a slant reads as a sticker on
// the glass. Now the whole dial is drawn IN THE COIN'S OWN PLANE, so it is
// foreshortened exactly as the coin is and registers with its rim.
//
// THE NUMBER IS GONE. `338.90°` was precision nobody bets on: the wager is which
// QUADRANT the 12 o'clock fell in, and a filled sector says that instantly where
// a two-decimal number needed decoding. The reading is still carried in the
// state object and in the dataset for tests and telemetry — it just is not
// something the player has to parse.
//
// ===========================================================================
// THE QUADRANTS ARE FIXED COMPASS BUCKETS. THEY DO NOT ROTATE WITH THE COIN.
// ===========================================================================
// contract.js: `quadrantFromOrientation(deg) = QUADRANTS[floor(deg / 90)]`, with
// orientationDeg measured CLOCKWISE FROM NORTH. So bucket k spans bearings
// [90k, 90k+90) and is nailed to the world, not to the coin. The coin's 12
// o'clock lands somewhere in one of them; that bucket is the bet. Drawing the
// sectors rotated with the coin would be drawing a different game.
//
// The buckets are NE / SE / SW / NW, because [0,90) runs FROM north TO east and
// is therefore the north-east sector — the top-right quarter, not the top. The
// bare cardinals N/E/S/W are reserved for exact 90-degree multiples, which have
// essentially zero probability; if one is ever rendered, something genuinely
// remarkable happened rather than "roughly northish".
//
// THE NAMES ARE NEVER SPELLED OUT HERE. Everything below indexes by
// floor(deg/90) and takes the name from contract.js, so a rename there cannot
// leave this file drawing one thing and labelling another.
// ===========================================================================
//
// IT IS A READOUT. It imports nothing from the draw (no outcome.js, no
// library.js), touches no transform, and cannot change what landed. The angle it
// shows is the SAME quantity player.js reports as
// report.played.landedOrientationDeg — both go through contract.js's
// roundOrientation, so the two cannot disagree.
//
// COLOUR IS NOT A RESULT. Yellow means "here is the truth", not "you won". The
// staged reveal owns win/loss colour (green/red, purple for an Edge), and a
// helper that also coloured itself would be a second, competing verdict on
// screen at the same moment.
//
// ===========================================================================
// REGISTRATION: WHY A HOMOGRAPHY AND NOT A JACOBIAN
// ===========================================================================
// The table plane maps to the screen under a projective transform. That map is
// EXACTLY a homography — a plane-to-plane projective map is what a pinhole
// camera does to a plane, by definition — so it can be reproduced exactly from
// four point correspondences and CSS `matrix3d`, which carries the perspective
// divide in its fourth column.
//
// The obvious cheaper move is the local Jacobian: sample the projection at P,
// P+eps*east, P+eps*north and use the two screen vectors as an affine matrix.
// That is a LINEARISATION about the centre, and it was fine when this file drew
// a 14 px triangle. It is not fine now: the overlay spans the coin's whole
// diameter, so the perspective divide varies measurably across it, and the error
// shows up exactly where it is most visible — the rim failing to sit on the
// coin's rim. tools/verify-orient-arrow.mjs measures both and reports the affine
// error in pixels; the homography's residual is float noise by construction.
//
// The four correspondences are the corners of the dial's own box, pushed through
// projectPoint(). Solving for the 8 unknowns is a small dense linear system, so
// this costs nothing and is exact rather than nearly right.
// ===========================================================================
//
// ===========================================================================
// THE FORESHORTENING, kept because the closed form is still the cheapest
// correct answer for a BEARING (as opposed to a position)
// ===========================================================================
// For camera azimuth `a` and elevation `e` (scene.js#cameraBasis builds exactly
// this basis, and the sweep in the verifier asserts the closed form agrees):
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
//   * AZIMUTH JUST ADDS TO THE HEADING. It rotates the whole compass rigidly.
//   * ELEVATION SQUASHES THE NORTH-SOUTH COMPONENT BY sin(e), and only that
//     component. At e = 90 (top-down) the map is the identity; at e = 0 the
//     table is edge-on and every heading collapses onto the horizontal — which
//     is geometrically right, not a bug.
//
// so the screen angle, clockwise from screen-up, is
//       atan2( sin(th + a), sin(e) * cos(th + a) )
//
// WHY NOT cameraBasis() DIRECTLY. It works — the verifier puts the two side by
// side at every elevation and they agree to 1e-12. The reason to keep the closed
// form is narrower than it looks: cameraBasis does NOT go singular at elevDeg 90
// but only survives because Math.cos(Math.PI/2) evaluates to 6.1e-17 rather than
// 0, so normalising a 6.1e-17-length cross product recovers [1,0,0] by
// floating-point luck. Top-down is where this function's answer is most obvious
// (the identity), so it is the worst place to depend on luck.
// ===========================================================================

import {
  normDeg, roundOrientation, quadrantFromOrientation,
  COIN_RADIUS_M, COIN_HALF_THICKNESS_M, compassToDir,
} from './contract.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** The settle framing this helper is drawn under. Mirrors player.js#SETTLE_CAM. */
export const SETTLE_ELEV_DEG = 66;

/**
 * The scene's vertical field of view. Mirrors scene.js#SCENE_FOV_DEG.
 *
 * Duplicated rather than imported, and that is deliberate: scene.js pulls in
 * three, the GLTF loader and the HDR loader, and importing it here would drag
 * the whole renderer into a file whose job is to draw a dial — and would break
 * this module's one structural guarantee, that it imports nothing but
 * contract.js and so cannot reach a transform. Section (6) of the verifier pins
 * the two together so the copy cannot drift.
 */
export const FOV_DEG = 45;

/**
 * How far past the rim the 12-o'clock arrow's tip sits, in metres.
 *
 * Small on purpose. The arrow is a tick on the rim now, not a floating marker —
 * it says "the design's 12 o'clock points HERE" and the sector fill says which
 * bucket that is. It no longer has to hold itself clear of the coin, because it
 * is meant to be touching it.
 */
export const MARKER_OFFSET_M = 0.0016;

/**
 * Yellow. A saturated amber-yellow rather than a pale one: the coin settles on a
 * lit wooden table under a saloon HDRI, and a pale yellow washes out against it.
 */
export const ARROW_COLOUR = '#ffc300';

/**
 * Sector fills, as alpha.
 *
 * Low enough that the coin's face reads straight through — the ruble's engraving
 * is the thing being pointed at, and an overlay that hides it defeats itself.
 * The landed sector is roughly three times the others, which is the whole signal:
 * "this one" has to be readable at a glance without any legend.
 */
// The sectors are NOT filled any more. Shading three quadrants you did not land
// in put a wash over most of the coin's face, and the face is what the dial is
// supposed to be helping you read — the guide was competing with the thing it
// annotates. The dividing lines carry the buckets on their own, and the rim
// tick already says which one won. Kept as a named constant rather than deleted
// so the intent is on the record: 0 is a decision, an absent property is a bug.
export const SECTOR_ALPHA = { idle: 0, landed: 0 };

/**
 * A world heading -> its on-screen rotation, in degrees clockwise from
 * screen-up. PURE. See the derivation in the header.
 *
 * Not used to draw anything now that the dial lives in plane coordinates — the
 * homography carries the bearing for free. Kept because it is the cheapest
 * correct answer to "which way does this bearing point on screen", it is the
 * one piece of this file that is exact at every elevation including top-down,
 * and the verifier's cardinal and foreshortening sections are written against
 * it.
 */
export function orientationToScreenAngle(orientationDeg, elevDeg = SETTLE_ELEV_DEG, azimuthDeg = 0) {
  // Non-finite input is a broken caller, not a heading. Falling back to North
  // keeps this total: one NaN in an SVG transform silently blanks the element.
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
 * direction is one whose errors cancel invisibly.
 *
 * Undefined at elevDeg 0, where the projection is genuinely many-to-one (the
 * table is edge-on and every heading lands on the same horizontal line), so that
 * case returns NaN rather than inventing an answer.
 */
export function screenAngleToOrientation(screenDeg, elevDeg = SETTLE_ELEV_DEG, azimuthDeg = 0) {
  const s = Math.sin((Number.isFinite(elevDeg) ? elevDeg : SETTLE_ELEV_DEG) * DEG);
  if (!Number.isFinite(screenDeg) || Math.abs(s) < 1e-12) return NaN;
  const a = Number.isFinite(azimuthDeg) ? azimuthDeg : 0;
  const p = normDeg(screenDeg) * DEG;
  return normDeg(Math.atan2(Math.sin(p), Math.cos(p) / s) * RAD - a);
}

/**
 * The camera's world basis for a shot. A local copy of scene.js#cameraBasis —
 * see the FOV_DEG note for why it is copied rather than imported.
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
 * @returns {{x,y,ndcX,ndcY,depth,inFront,inViewport}}
 *   Always finite. A point behind the camera reports inFront:false rather than a
 *   mirrored position — projecting it anyway is how markers appear on the wrong
 *   side of the screen and nobody can work out why.
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
 * Where the 12-o'clock arrow's tip sits in the world: on the table plane, at the
 * settled bearing, a whisker past the rim.
 *
 * The height is the coin's own centre height rather than the table surface, so
 * the dial sits level with the face it is painted on instead of sinking into the
 * wood — 0.75 mm, invisible at this framing but free to be right about.
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

// ===========================================================================
// THE PLANE -> SCREEN HOMOGRAPHY
// ===========================================================================

/** The dial's SVG box, in its own units. Local (0,0) is the top-left corner. */
export const DIAL_BOX = 200;
/** Dial radius in SVG units. Half the box, so the disc exactly fills it. */
export const DIAL_R = 100;

/**
 * Local dial coordinates -> world point on the table plane.
 *
 * Local +x is world EAST, local +y is world SOUTH — because SVG's y axis points
 * down and the projection puts north up, so "down the SVG" has to be "south on
 * the table" for the dial to come out the right way round rather than mirrored.
 *
 * @param {number} lx 0..DIAL_BOX
 * @param {number} ly 0..DIAL_BOX
 * @param {number[]} centre coin centre in world
 */
export function dialLocalToWorld(lx, ly, centre) {
  const k = COIN_RADIUS_M / DIAL_R;                 // metres per SVG unit
  return [centre[0] + (lx - DIAL_R) * k, centre[1], centre[2] + (ly - DIAL_R) * k];
}

/**
 * Solve the 8-parameter homography taking four source points to four
 * destinations. Plain Gaussian elimination with partial pivoting on an 8x8;
 * at this size anything cleverer is just more to get wrong.
 *
 * @returns {number[]|null} [h0..h7] where
 *   X = (h0 x + h1 y + h2) / (h6 x + h7 y + 1)
 *   Y = (h3 x + h4 y + h5) / (h6 x + h7 y + 1)
 */
export function solveHomography(src, dst) {
  if (!src || !dst || src.length !== 4 || dst.length !== 4) return null;
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    if (![x, y, X, Y].every(Number.isFinite)) return null;
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;   // degenerate correspondence
    const t = A[col]; A[col] = A[piv]; A[piv] = t;
    const p = A[col][col];
    for (let c = col; c <= 8; c++) A[col][c] /= p;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c <= 8; c++) A[r][c] -= f * A[col][c];
    }
  }
  const h = A.map((row) => row[8]);
  return h.every(Number.isFinite) ? h : null;
}

/** Apply a homography to a local point. */
export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + 1;
  if (!(Math.abs(w) > 1e-12)) return { x: NaN, y: NaN, w };
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w, w };
}

/**
 * The exact plane->screen map for the dial, as a homography over local SVG
 * coordinates, plus the CSS `matrix3d` that reproduces it.
 *
 * CSS matrix3d is column-major and divides by w, so a 2D homography embeds as
 *   matrix3d(h0, h3, 0, h6,  h1, h4, 0, h7,  0, 0, 1, 0,  h2, h5, 0, 1)
 * which is why this needs no per-element correction: the browser does the
 * perspective divide the projection does.
 *
 * Coordinates are CANVAS-LOCAL (rect.left/top removed), because the element is
 * absolutely positioned inside the stage at 0,0 — feeding it viewport
 * coordinates would offset the whole dial by wherever the canvas happens to sit
 * on the page.
 */
export function dialHomography(centre, shot, rect, fovDeg = FOV_DEG) {
  if (!centre || !shot || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const local = { left: 0, top: 0, width: rect.width, height: rect.height };
  const corners = [[0, 0], [DIAL_BOX, 0], [DIAL_BOX, DIAL_BOX], [0, DIAL_BOX]];
  const dst = [];
  for (const [lx, ly] of corners) {
    const p = projectPoint(dialLocalToWorld(lx, ly, centre), shot, local, fovDeg);
    if (!p.inFront) return null;
    dst.push([p.x, p.y]);
  }
  const h = solveHomography(corners, dst);
  if (!h) return null;
  return {
    h,
    matrix3d: `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`,
    at: (lx, ly) => applyHomography(h, lx, ly),
  };
}

/**
 * Everything the view needs, as plain data. PURE, and separate from the DOM on
 * purpose: the preview pane is usually hidden, where nothing renders and
 * getComputedStyle reports frozen values, so the only assertable thing is state.
 */
export function arrowState(orientationDeg, elevDeg = SETTLE_ELEV_DEG, azimuthDeg = 0) {
  // ROUND FIRST, then derive everything from the rounded value. The two decimals
  // ARE the truth (design doc 6.5), and a raw 89.999999998 is the outcome's
  // 90.00 in quadrant E — deriving the label from the raw value and the quadrant
  // from the rounded one would print "90.00" next to quadrant N.
  const deg = roundOrientation(Number.isFinite(orientationDeg) ? orientationDeg : 0);
  return {
    orientationDeg: deg,
    label: deg.toFixed(2) + '°',      // telemetry only; the player never sees it
    screenAngleDeg: orientationToScreenAngle(deg, elevDeg, azimuthDeg),
    quadrant: quadrantFromOrientation(deg),
    quadrantIndex: Math.floor(normDeg(deg) / 90) % 4,
  };
}

/**
 * The full placed state: the reading, the dial's transform, and where the
 * 12-o'clock arrow sits.
 *
 * The coin centre defaults to the shot's target, because the settle shot is
 * built as `{ target: [finalPos[0], COIN_HALF_THICKNESS_M, finalPos[2]] }` — the
 * camera is already looking straight at the coin, so the target IS the centre.
 */
export function markerState(orientationDeg, o = {}) {
  const shot = o.shot;
  const base = arrowState(orientationDeg, shot ? shot.elevDeg : SETTLE_ELEV_DEG,
    shot ? shot.azimuthDeg : 0);
  if (!shot || !o.rect) return { ...base, world: null, screen: null, dial: null };
  const centre = o.centre ?? shot.target;
  const fov = o.fovDeg ?? FOV_DEG;
  const world = markerWorldPos(base.orientationDeg, centre, o.offsetM ?? MARKER_OFFSET_M);
  const screen = projectPoint(world, shot, o.rect, fov);
  const centreScreen = projectPoint(centre, shot, o.rect, fov);
  const dial = dialHomography(centre, shot, o.rect, fov);
  return { ...base, world, screen, centreScreen, dial, centre };
}

/**
 * A bearing -> the point on the dial's rim, in local SVG coordinates.
 * Bearing is clockwise from north; local +y is south, so north is -y.
 */
export function dialRimPoint(bearingDeg, r = DIAL_R) {
  const t = normDeg(bearingDeg) * DEG;
  return [DIAL_R + Math.sin(t) * r, DIAL_R - Math.cos(t) * r];
}

/** The four sector paths, in local SVG coordinates. Bucket k spans [90k, 90k+90). */
export function sectorPaths() {
  const out = [];
  for (let k = 0; k < 4; k++) {
    const [x0, y0] = dialRimPoint(k * 90);
    const [x1, y1] = dialRimPoint((k + 1) * 90);
    // sweep-flag 1: increasing bearing is clockwise on screen, and in a y-down
    // coordinate system that is the positive-angle direction.
    out.push(`M ${DIAL_R} ${DIAL_R} L ${x0} ${y0} A ${DIAL_R} ${DIAL_R} 0 0 1 ${x1} ${y1} Z`);
  }
  return out;
}

/**
 * The pixels. A transparent dial painted on the coin.
 *
 * NOTHING HERE ANIMATES VIA CSS. Every visual is written straight to `style` on
 * each call, because a hidden pane never advances a transition and would leave
 * the dial frozen at its start value forever. State is mirrored onto dataset
 * attributes so what the DOM says is what is on screen.
 *
 * @param {HTMLElement} hostEl element to build inside (must be a positioned box
 *        that overlays the canvas at its top-left)
 */
export function createOrientArrow(hostEl, opts = {}) {
  const colour = opts.colour ?? ARROW_COLOUR;
  const NS = 'http://www.w3.org/2000/svg';
  const doc = hostEl.ownerDocument;

  const el = doc.createElement('div');
  el.className = 'orient-dial';
  el.style.display = 'none';
  el.style.position = 'absolute';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.width = DIAL_BOX + 'px';
  el.style.height = DIAL_BOX + 'px';
  // The homography maps the dial's own box straight onto the canvas, so the
  // element must not be pre-offset by anything: origin at its own top-left.
  el.style.transformOrigin = '0 0';
  el.style.pointerEvents = 'none';

  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(DIAL_BOX));
  svg.setAttribute('height', String(DIAL_BOX));
  svg.setAttribute('viewBox', `0 0 ${DIAL_BOX} ${DIAL_BOX}`);
  svg.style.overflow = 'visible';
  svg.style.display = 'block';

  // four sectors, world-aligned, indexed by floor(deg/90) and never by name
  const sectors = sectorPaths().map((d) => {
    const p = doc.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', colour);
    p.setAttribute('stroke', 'none');
    svg.appendChild(p);
    return p;
  });

  // the dividing cross and the rim, thin enough to read as drawn ON the face
  const spokes = doc.createElementNS(NS, 'path');
  spokes.setAttribute('d',
    `M ${DIAL_R} 0 L ${DIAL_R} ${DIAL_BOX} M 0 ${DIAL_R} L ${DIAL_BOX} ${DIAL_R}`);
  spokes.setAttribute('stroke', colour);
  spokes.setAttribute('stroke-width', '1.2');
  spokes.setAttribute('fill', 'none');
  spokes.setAttribute('opacity', '0.45');
  svg.appendChild(spokes);

  // NO RIM CIRCLE. It traced the coin's own edge, so it was a second outline
  // drawn on top of an outline the render already provides — and any error in
  // the registration showed up as a visible double edge, making a correct
  // overlay look wrong. The coin draws its own silhouette; the guide only needs
  // to add what the coin cannot say for itself, which is where the buckets
  // divide and where 12 o'clock ended up.
  // the 12 o'clock marker: a triangle sitting on the rim at the settled bearing,
  // drawn in plane coordinates like everything else so it lies on the face too
  const tick = doc.createElementNS(NS, 'path');
  tick.setAttribute('fill', colour);
  svg.appendChild(tick);

  el.appendChild(svg);
  hostEl.appendChild(el);

  let state = null;
  let last = null;

  /** The 12-o'clock triangle, in local dial units, pointing inward at the rim. */
  function tickPath(deg) {
    // OUTSIDE the rim, apex pointing IN at it. It used to sit inside, which put
    // it on the coin's face — covering the engraving at exactly the bearing the
    // player is trying to read, and making it ambiguous whether the triangle
    // marked the rim or some point within the disc. Outside, the coin's face
    // stays clear and the apex does the pointing.
    const half = 9;                        // half-width at the base, dial units
    const reach = 26;                      // how far OUT from the rim the base sits
    const t = normDeg(deg) * DEG;
    const ux = Math.sin(t), uy = -Math.cos(t);          // outward radial
    const px = -uy, py = ux;                            // tangent
    // apex ON the rim, base out beyond it
    const ax = DIAL_R + ux * DIAL_R, ay = DIAL_R + uy * DIAL_R;
    const bx = DIAL_R + ux * (DIAL_R + reach), by = DIAL_R + uy * (DIAL_R + reach);
    return `M ${bx + px * half} ${by + py * half} L ${bx - px * half} ${by - py * half} `
         + `L ${ax} ${ay} Z`;
  }

  function place(st) {
    if (!st.dial) {
      // Nothing sane to draw. Hiding beats leaving a stale dial pinned to the
      // last camera, which looks like a real reading.
      el.style.display = 'none';
      el.dataset.placed = '0';
      return;
    }
    el.style.transform = st.dial.matrix3d;
    el.style.display = 'block';
    el.dataset.placed = '1';
    el.dataset.matrix3d = st.dial.matrix3d;
    const c = st.dial.at(DIAL_R, DIAL_R);
    el.dataset.centreX = c.x.toFixed(2);
    el.dataset.centreY = c.y.toFixed(2);
  }

  return {
    el,
    get state() { return state; },
    /**
     * Show the dial for a landed orientation, painted on the coin.
     *
     * @param {number} orientationDeg the settled angle, clockwise from North
     * @param {object} [o] {shot, rect, fovDeg, centre, offsetM}
     */
    show(orientationDeg, o = {}) {
      last = { orientationDeg, o };
      state = markerState(orientationDeg, o);
      sectors.forEach((p, k) => {
        const on = k === state.quadrantIndex;
        p.setAttribute('fill-opacity', String(on ? SECTOR_ALPHA.landed : SECTOR_ALPHA.idle));
        p.dataset.landed = on ? '1' : '0';
      });
      tick.setAttribute('d', tickPath(state.orientationDeg));
      el.style.display = 'block';
      el.dataset.orientation = state.orientationDeg.toFixed(2);
      el.dataset.screenAngle = state.screenAngleDeg.toFixed(4);
      el.dataset.quadrant = state.quadrant;
      el.dataset.quadrantIndex = String(state.quadrantIndex);
      el.dataset.shown = '1';
      if (state.dial) place(state);
      else el.dataset.placed = '0';
      return state;
    },
    /**
     * Re-place without changing the reading.
     *
     * The coin no longer re-arms itself after a flip — it sits where it landed
     * until the player asks for the next one — so the dial can easily outlive a
     * window resize, and a dial pinned to stale pixels reads as the coin having
     * moved.
     */
    reposition(o = {}) {
      if (!last) return null;
      last.o = { ...last.o, ...o };
      state = markerState(last.orientationDeg, last.o);
      if (state.dial) place(state);
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
      delete el.dataset.quadrantIndex;
      delete el.dataset.matrix3d;
      delete el.dataset.centreX;
      delete el.dataset.centreY;
    },
  };
}
