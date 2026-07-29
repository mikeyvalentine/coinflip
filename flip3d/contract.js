// flip3d/contract.js
// ---------------------------------------------------------------------------
// THE SHARED CANONICAL-SPACE CONTRACT.  Renderer and Rapier bake both build to
// this file.  Nothing in here knows anything about three.js or about the GLB.
//
// UNITS: metres, kilograms, seconds.  Y-up, right-handed (three.js / glTF).
//
// CANONICAL COIN SPACE
//   * The coin body's local +Y is the HEADS face normal.  Heads-up therefore
//     means the body's +Y points at world +Y.
//   * The coin body's local +X is the coin design's 12 o'clock — the reference
//     axis the ORIENTATION bet is measured from.  See the GLB notes below: the
//     in-plane alignment is baked into the correction quaternion, so canonical
//     space needs no knowledge of the artwork.
//   * The coin lies in the XZ plane at rest.
//   * y = 0 is the TABLE SURFACE.  A coin resting flat has its centre at
//     y = COIN_HALF_THICKNESS_M.  Gravity is -Y.
//   * The launch origin is x = 0, z = 0.
//
// ORIENTATION — the third bet axis.  It is the coin's settled YAW: which way
// the face design points once it has come to rest.  It has NOTHING to do with
// where on the table the coin ended up (design doc §2: table position is cut —
// betting is about the coin itself, never where it lands).  Translation is
// free; the coin may travel and bounce wherever, and it must not mean anything.
//   orientationDeg = angle of the body's local +X, projected onto XZ, measured
//   CLOCKWISE from world -Z, in [0, 360), two decimals (§6.5: the displayed
//   hundredths ARE the truth).
//   quadrant = bucket: N=[0,90) E=[90,180) S=[180,270) W=[270,360).
//
// SPIN UNIT
//   Internally: integer HALF-FLIPS, 8..40 excluding 24 (32 outcomes).
//   Player-facing: ROTATIONS = halfFlips / 2, one decimal ("spin: 9.5").
//   Never show the player the words "half flip".
//
// ---------------------------------------------------------------------------
// GLB -> CANONICAL, as measured from assets/coin_1_ruble.glb (Sketchfab
// 16.59.0, node chain Sketchfab_model > *.fbx > RootNode > Cylinder >
// Cylinder_Coin_0).  Recorded here because the physics agent must be able to
// trust these numbers without ever opening the GLB.
//
//   * The two Sketchfab axis-conversion matrices cancel exactly; the composed
//     world matrix of the coin mesh is a PURE UNIFORM SCALE of 0.010250990.
//   * Mesh-local geometry: a disc in the local XY plane, face normal along
//     local +/-Z.  Local bounds +/-1 in X and Y, +/-0.05 in Z.
//   * Loaded (pre-correction) size: 20.502 mm across X and Y, 1.0251 mm along
//     Z.  So the asset is ALREADY at real-world metric scale in diameter
//     (20.5 mm) but is 0.683x too thin (1.025 mm vs the real 1.5 mm).
//   * Which face is heads: the base-colour atlas puts the double-headed eagle
//     / "БАНК РОССИИ" obverse in the top-left quadrant (u .031-.499,
//     v .041-.508) and the "1 РУБЛЬ" / ₽ reverse in the bottom-right
//     (u .485-.952, v .481-.949).  The +Z-normal vertex group carries the
//     top-left UVs, the -Z group the bottom-right.  Therefore:
//         GLB local +Z face = EAGLE  = HEADS
//         GLB local -Z face = RUBLE  = TAILS
//     (Russian convention: орёл/eagle = heads, решка = tails.)
//   * Which way is UP on the artwork: a least-squares fit of local (x,y) ->
//     TEXCOORD_0 over each face's 65 verts is planar to 7e-8, and BOTH faces
//     put the top of the texture along GLB local +Y.  So the eagle's crown and
//     the ₽'s crossbar share one body-fixed 12 o'clock axis — meaning a single
//     reference axis reads correctly whichever face is showing.  (The two fits
//     have opposite determinant, i.e. the reverse's UV is mirrored — expected
//     for back-to-back faces, both render right-reading.)
//   * CORRECTION, two constraints:
//         GLB local +Z (heads normal) -> canonical +Y
//         GLB local +Y (design 12 o'clock) -> canonical +X
//     = R_y(-90 deg) * R_x(-90 deg), quaternion (x,y,z,w) = (-.5,-.5,-.5,+.5),
//     exact. (It also sends GLB local +X -> canonical +Z.)
//   * Applied on the model child node as scale-then-rotate, so the outer coin
//     node's transform stays exactly canonical and can be driven verbatim by a
//     baked clip quaternion.
// ---------------------------------------------------------------------------

// --- physical coin ---------------------------------------------------------
export const COIN_DIAMETER_M = 0.0205;   // 20.5 mm
export const COIN_THICKNESS_M = 0.0015;  // 1.5 mm
export const COIN_RADIUS_M = COIN_DIAMETER_M / 2;
export const COIN_HALF_THICKNESS_M = COIN_THICKNESS_M / 2;
export const COIN_MASS_KG = 0.00325;     // 3.25 g
export const GRAVITY_MS2 = 9.81;

// --- GLB correction (see header) -------------------------------------------
export const GLB_HEADS_AXIS = '+Z';                 // in raw GLB local space
export const GLB_DESIGN_UP_AXIS = '+Y';             // in raw GLB local space
export const GLB_LOADED_DIAMETER_M = 0.020502;      // measured
export const GLB_LOADED_THICKNESS_M = 0.0010251;    // measured
export const GLB_CORRECTION_QUAT = [-0.5, -0.5, -0.5, 0.5]; // x,y,z,w — exact

// --- table -----------------------------------------------------------------
// table.glb is a round pedestal table in arbitrary units (4.5346 across,
// 3.2972 tall, top face planar at local y = 3.212391).  We scale it so the top
// is 1.05 m across and translate so that top face sits exactly on y = 0.
export const TABLE_TOP_DIAMETER_M = 1.05;

// --- orientation + quadrants ----------------------------------------------
export const QUADRANTS = ['N', 'E', 'S', 'W'];
/** Bucket edges, degrees. N=[0,90) E=[90,180) S=[180,270) W=[270,360). */
export const QUAD_RANGES = { N: [0, 90], E: [90, 180], S: [180, 270], W: [270, 360] };

/** Compass angle in radians, clockwise from -Z: 0 = N, +pi/2 = E, pi = S. */
export function dirToCompass(x, z) { return Math.atan2(x, -z); }
export function compassToDir(a) { return [Math.sin(a), 0, -Math.cos(a)]; }
export const normDeg = (d) => ((d % 360) + 360) % 360;

/**
 * ORIENTATION of a settled coin: the compass angle of the body's local +X
 * (the design's 12 o'clock) projected onto the XZ plane. Degrees, [0, 360).
 * Works off the quaternion alone — no scene, no GLB, no position.
 */
export function orientationFromQuat(q) {
  const [x, y, z, w] = q;
  // first column of the rotation matrix = R * (1,0,0)
  const vx = 1 - 2 * (y * y + z * z);
  const vz = 2 * (x * z - w * y);
  return normDeg(Math.atan2(vx, -vz) * 180 / Math.PI);
}

/**
 * Snap to the two decimals that ARE the truth (§6.5). Do this before bucketing
 * or displaying: a measured 89.999999998 is the outcome's 90.00, quadrant E,
 * and 359.999999 wraps to 0.00, quadrant N.
 */
export function roundOrientation(deg) { return normDeg(Math.round(normDeg(deg) * 100) / 100); }

/** Bet bucket for an orientation. Always bucket the rounded value. */
export function quadrantFromOrientation(deg) {
  return QUADRANTS[Math.floor(roundOrientation(deg) / 90) % 4];
}

/** Mid-bucket orientation, used only when a legacy outcome carries no angle. */
export function orientationForQuadrant(q, frac = 0.5) {
  const [lo, hi] = QUAD_RANGES[q];
  return normDeg(lo + (hi - lo) * Math.min(Math.max(frac, 0), 0.999));
}

// --- spin axis (mirrors game.js / coinflip-preview.html) -------------------
export const SPIN_MIN = 8;
export const SPIN_MAX = 40;
export const SPIN_MEDIAN = 24;             // excluded: unattainable by design
export const SPIN_VALUES = [];
for (let s = SPIN_MIN; s <= SPIN_MAX; s++) if (s !== SPIN_MEDIAN) SPIN_VALUES.push(s);

export const toRotations = (halfFlips) => halfFlips / 2;
export const toHalfFlips = (rotations) => Math.round(rotations * 2);
/** Player-facing spin string. Never says "half flip". */
export const spinLabel = (halfFlips) => toRotations(halfFlips).toFixed(1);

// --- baked clip library ----------------------------------------------------
// bake/out/ is produced by the Rapier harness and is READ-ONLY to the renderer.
//   * every clip is emitted at 250 fps with `t` in MILLISECONDS
//   * EVERY clip starts exactly heads-up and flat (measured: max start tilt 0)
//     at y0 = 0.22 m, so a tails-up start is the renderer's job — see
//     TAILS_START_QUAT below
//   * the settled centre height is the solver's, not ours: measured over the
//     1024 clips it lands in [-0.00024, +0.00062] m rather than on
//     COIN_HALF_THICKNESS_M, so the renderer lifts each clip by a constant
//     offset (<= 1 mm) to put the coin exactly on the table
export const CLIP_FPS = 250;
export const CLIP_LAUNCH_HEIGHT_M = 0.22;
/** A settled clip may keep this much solver slop and still be honest. */
export const SETTLE_FLAT_TOL_DEG = 1.62;   // = acos(bake's settleFlatCos 0.9996)

/**
 * How close a RE-DERIVED orientation must be to the one the clip declares.
 *
 * meta.orientationDeg is authoritative: the bake measured it at full solver
 * precision and that is the number the ORIENTATION bet pays out on. The frames
 * store quaternions at 6 decimals, which pins the angle only to +/-0.005 deg —
 * measured across the 1024 baked clips the worst re-derivation error is
 * 0.005013 deg. So when the true angle sits within a whisker of a .xx5
 * boundary, re-rounding to two decimals can land one hundredth away; it does
 * for exactly 4 of the 1024 clips. One hundredth is therefore the tightest
 * claim the stored data can support, and the renderer asserts exactly that:
 * the coin it drew really is resting at the angle the library sold.
 */
export const ORIENT_TOL_DEG = 0.011;

/**
 * Turning the coin over WITHOUT moving the design's 12 o'clock: a 180 deg
 * rotation about the body's own +X, applied on the BODY side (q * r).
 *   body +X -> +X   (orientation is preserved EXACTLY)
 *   body +Y -> -Y   (the face is inverted at every instant, so the half-flip
 *                    count is identical and the landing side simply flips)
 * This is the only legal way to serve a tails-up start from a heads-up clip.
 */
export const TAILS_START_QUAT = [1, 0, 0, 0]; // x,y,z,w
/** q (x,y,z,w) composed with TAILS_START_QUAT on the body side. */
export function flipStartFaceQuat(q) {
  const [x, y, z, w] = q;
  return [w, z, -y, -x];
}

// --- the RESTING coin's orientation ---------------------------------------
//
// THE REST POSE IS A POSE, NOT A REDEFINITION. Everything below changes where
// the coin SITS before a throw. It does not touch orientationFromQuat(), so
// "orientationDeg = 137.42" still means exactly what it always meant: the body's
// +X (the design's 12 o'clock) points 137.42 deg CLOCKWISE FROM NORTH once the
// coin has stopped. A baked clip's settle reading is derived from that clip's
// own last frame and is completely unaffected by any of this.
//
// At the identity quaternion the body's +X points at world +X = EAST, so a coin
// parked at identity sits reading 90.00 deg. That is a legal pose but a
// misleading one: the coin the player stares at before every throw should be at
// the orientation dial's zero. A world-side yaw about +Y fixes the pose alone.
//
// Sign, derived not guessed: for a world-side yaw R_y(psi), the compass angle of
// any body axis becomes (alpha - psi). Rest starts at alpha = 90, so
// psi = +90 deg lands on 0 deg, and it sends body +X to world -Z = North.
export const REST_ORIENTATION_DEG = 0;

/** World-side yaw about canonical +Y, as a quaternion times `base`. */
export function yawQuat(psiRad, base = [0, 0, 0, 1]) {
  const s = Math.sin(psiRad / 2), c = Math.cos(psiRad / 2);
  const [x, y, z, w] = base;
  return [c * x + s * z, c * y + s * w, c * z - s * x, c * w - s * y];
}

/**
 * The pose a coin rests in before a throw: `face` up, design's 12 o'clock at
 * `orientationDeg` (default: North / 0.00).
 *
 * Both faces get the SAME yaw, so a heads-up and a tails-up rest read the same
 * orientation — which is the whole reason TAILS_START_QUAT is a body-side +X
 * flip in the first place.
 */
export function restQuatForFace(face, orientationDeg = REST_ORIENTATION_DEG) {
  const base = face === 'Tails' ? TAILS_START_QUAT : [0, 0, 0, 1];
  return yawQuat((90 - normDeg(orientationDeg)) * Math.PI / 180, base);
}

// --- face helpers ----------------------------------------------------------
// y-component of the coin's local +Y axis after rotation by quat (x,y,z,w).
export function upDot(q) {
  const [x, y, z, w] = q; // eslint-disable-line no-unused-vars
  return 1 - 2 * (x * x + z * z);
}
export function faceUpFromQuat(q) { return upDot(q) >= 0 ? 'Heads' : 'Tails'; }

/**
 * The side a flip MUST land on, given its start face and half-flip count.
 * Parity is the whole rule: even -> same as start, odd -> opposite.
 * Used to reject an inconsistent outcome rather than quietly animating a lie.
 */
export function expectedSide(startFace, halfFlips) {
  const startHeads = startFace === 'Heads';
  const landsHeads = halfFlips % 2 === 0 ? startHeads : !startHeads;
  return landsHeads ? 'Heads' : 'Tails';
}

/** Throws if an outcome is internally inconsistent. The renderer never fixes it. */
export function assertOutcome(o) {
  if (!o || typeof o !== 'object') throw new Error('outcome missing');
  if (o.startFace !== 'Heads' && o.startFace !== 'Tails') throw new Error('bad startFace: ' + o.startFace);
  if (o.side !== 'Heads' && o.side !== 'Tails') throw new Error('bad side: ' + o.side);
  if (!QUADRANTS.includes(o.quadrant)) throw new Error('bad quadrant: ' + o.quadrant);
  if (!Number.isInteger(o.spins) || !SPIN_VALUES.includes(o.spins)) throw new Error('bad spins: ' + o.spins);
  const want = expectedSide(o.startFace, o.spins);
  if (want !== o.side) {
    throw new Error(`outcome inconsistent: ${o.startFace} + ${o.spins} half-flips must land ${want}, got ${o.side}`);
  }
  if (o.orientationDeg != null) {
    if (!Number.isFinite(o.orientationDeg) || o.orientationDeg < 0 || o.orientationDeg >= 360) {
      throw new Error('bad orientationDeg: ' + o.orientationDeg);
    }
    const bucket = quadrantFromOrientation(o.orientationDeg);
    if (bucket !== o.quadrant) {
      throw new Error(`outcome inconsistent: orientation ${o.orientationDeg} is quadrant ${bucket}, not ${o.quadrant}`);
    }
  }
  return o;
}
