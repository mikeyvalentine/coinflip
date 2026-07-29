// config.js — COINFLIP bake harness: every physical constant and tunable.
// ---------------------------------------------------------------------------
// SHARED CONTRACT (do not drift from this without telling the renderer agent):
//   units      metres, seconds (frame `t` is MILLISECONDS), radians internally
//   axes       Y-up, gravity -9.81 m/s^2
//   canonical  heads-face normal is +Y when heads-up; coin lies in the XZ plane
//   quadrants  N = -Z, E = +X, S = +Z, W = -X   (compass heading = atan2(x, -z))
//   spin unit  integer HALF-FLIPS, 8..40 excluding 24 => 32 legal outcomes
//   start face ALWAYS heads-up. Landing side = parity of half-flips. The
//              renderer pre-rotates 180 deg for a tails-up start.
// ---------------------------------------------------------------------------

// --- the coin: real 1-ruble coin -------------------------------------------
// 20.5 mm diameter, 1.5 mm thick, 3.25 g, nickel-plated steel.
export const COIN = {
  radius: 0.01025,      // m
  halfHeight: 0.00075,  // m  (1.5 mm thick)
  mass: 0.00325,        // kg
};
// Uniform-density equivalent so Rapier derives the correct inertia tensor.
// V = pi r^2 h = 4.95093e-7 m^3  ->  rho = 6564.4 kg/m^3
// (below solid steel's 7850 because the real coin has a milled rim / relief)
COIN.volume = Math.PI * COIN.radius * COIN.radius * (2 * COIN.halfHeight);
COIN.density = COIN.mass / COIN.volume;

// --- world / materials ------------------------------------------------------
export const PHYS = {
  gravity: -9.81,

  dt: 1 / 1000,          // sim timestep (s). Fine enough that a 200 rad/s
                         // tumble advances only ~11.5 deg per step, so the
                         // half-flip counter cannot alias.
  solverIterations: 8,   // default is 4; a thin disc needs more contact care

  restitution: 0.30,     // steel coin on a hard table. 0.6 drops yield to 73%
                         // (coins skate off the table); 0.1 kills the bounce.
  friction: 0.60,        // measured to be almost inert between 0.2 and 0.9
  // Air drag on a 20 mm coin over a 0.6 s flight is negligible, and any
  // non-zero value here bleeds launch velocity and reads as syrup. Measured at
  // 0.05 it retained 97.6% of velocity, so it was never the cause of anything
  // — but it is a free variable to remove, so it is removed.
  linearDamping: 0.0,
  // Angular damping was EXPECTED to be the thing that stops a thin disc
  // rim-rolling forever. Measured (tools/damping.js, n=600 per setting): it is
  // not. Zero damping produces zero no-settle rejects and the same ~730 ms
  // median settle as 0.28. What angular damping DOES do is bleed spin during
  // flight (Rapier damping is exponential, so 0.28 costs ~18% of omega over a
  // 0.7 s flight) which is not aerodynamics, it is syrup, and it biased the
  // half-flip targeting by -4.9%. Set to zero: the coin keeps the spin it was
  // launched with, and the targeting predictor becomes near-exact.
  angularDamping: 0.0,
  contactSkin: 0.0,      // Rapier 0.19 thin-shape helper; 0 = off

  // Table: a 1 m square slab, top face at y = 0.
  tableHalfExtent: 0.5,
  tableThickness: 0.02,
};

// --- launch distribution ----------------------------------------------------
// Solved backwards from the target half-flip range; see tools/sweep.js for the
// measured mapping. Flight time to first contact is
//   t_c = (vy + sqrt(vy^2 + 2 g (y0 - h_c))) / g
// and airborne half-flips ~= omega * t_c / pi, so the omega range below is what
// spans 8..40 half-flips across the vy range.
// FLIGHT TIME IS A HARD CONSTRAINT, not a free variable. Half-flip count alone
// leaves the system underdetermined: 20 rotations can be hit with a fast spin
// on a short flight (right) or a lazy spin on a long hang time (floaty). So vy
// is chosen to put the airborne time in 0.50-0.80 s, centred near 0.6 s, and
// omega is then whatever is needed to fit the rotations into THAT flight.
//   t_c(vy) = (vy + sqrt(vy^2 + 2 g (y0 - h_c))) / g
//   vy 2.05 -> 0.502 s      vy 2.60 -> 0.601 s      vy 3.30 -> 0.727 s
export const LAUNCH = {
  y0: 0.22,              // launch height above the table (m) — hand height

  vyMin: 2.05,           // upward velocity range (m/s) => flight 0.50 s
  vyMax: 3.30,           //                             => flight 0.73 s

  vhMin: 0.05,           // horizontal (travel) speed range (m/s)
  vhMax: 0.35,           // trimmed from 0.45: the harder landings that come
                         // with the faster launch throw the coin further

  // Spin about the coin's OWN axis (Y, the "frisbee" component). Small on
  // purpose: a large value gyroscopically stabilises the coin, the heads-normal
  // stops sweeping a full great circle, and the half-flip count becomes
  // ill-defined. Kept as a wobble/character knob only.
  spinYMax: 6.0,         // rad/s

  // Tumble rate bounds used for targeting clamps and for energy normalisation.
  // These FOLLOW from the flight-time window above: omega = H*pi/t_c, so
  //   8 half-flips over the longest flight  (0.727 s) -> 34.6 rad/s
  //   40 half-flips over the shortest flight (0.502 s) -> 250.3 rad/s
  // i.e. 5.5 to 40 rev/s. A real flipped coin is a blur; this is that.
  omegaMin: 32.0,        // rad/s
  omegaMax: 255.0,       // rad/s
};

// --- classification ---------------------------------------------------------
export const CLASSIFY = {
  // Half-flip counter hysteresis on cos(theta) = (heads normal) . +Y.
  // A half-flip is only counted on a confirmed +0.5 -> -0.5 transition, i.e.
  // the normal must actually pass from <60 deg of up to >120 deg. Rim-rolling
  // (theta ~ 90 deg) and pole wobble can never fake a count.
  flipBand: 0.5,         // cos(60 deg)

  // Airborne cross-check for precession. During a CLEAN tumble the swept arc
  // (in half-flips) leads the confirmed count by a bounded amount: the count
  // confirms 2/3 of the way through each half-flip, so at any instant
  //     arc/pi - count  lies in [-1/3, +2/3].
  // A big own-axis spin makes the normal trace a cone instead of a great
  // circle: the count stalls while the arc keeps growing, so this excess runs
  // away. That is the signature we reject on — the flip count would be
  // ill-defined and the odds would be a guess.
  arcExcessMin: -0.40,
  arcExcessMax: 1.00,

  // Settle: sustained stillness AND flat.
  settleLinVel: 0.010,   // m/s
  settleAngVel: 0.150,   // rad/s
  // |cos(theta)| for "lying flat". A rigid cylinder on a flat plane cannot
  // rest tilted, so any residual tilt is solver slop. Measured over 1024 baked
  // clips: median 0.16 deg, p99 0.57 deg. 0.9996 = 1.6 deg, which is clear of
  // the honest population but rejects the rare clip that freezes visibly
  // canted — that would look broken and would make orientationDeg a lie.
  settleFlatCos: 0.9996,
  settleHoldMs: 150,     // must hold for this long before we call it settled

  // Quality gates.
  maxDurationMs: 4000,   // budget; longer => reject "no-settle"
  maxDisplacement: 0.400,// m — beyond this it is heading off the table
                         // (displacement is a quality gate ONLY; it has no
                         //  bearing on the outcome — see classify.js)
  tableMargin: 0.030,    // m — must settle this far inside the table edge

  // Contact / bounce detection (used for the energy scalar and beat tags).
  contactHeight: 0.012,  // m — center height under which the coin can touch
};

// --- output -----------------------------------------------------------------
export const OUTPUT = {
  fps: 250,              // emitted frame rate (sim runs at PHYS.dt regardless).
                         // 250 divides 1000 exactly, so frames land on exact
                         // sim steps rather than being resampled.
  posDecimals: 5,        // metres -> 10 micrometre precision
  // Kept at 6: the renderer may re-derive the settled orientation from the
  // final frame, and orientationDeg is reported to 2 dp because design doc 6.5
  // treats the hundredths digit as literal truth. 6 dp on the quaternion keeps
  // any re-derivation accurate to ~6e-5 deg, far inside that.
  quatDecimals: 6,
};

// --- the spin axis (locked design) -----------------------------------------
export const HALF_FLIP_MIN = 8;
export const HALF_FLIP_MAX = 40;
export const HALF_FLIP_EXCLUDED = 24;   // the median, unattainable by design
export const HALF_FLIPS = [];
for (let h = HALF_FLIP_MIN; h <= HALF_FLIP_MAX; h++) {
  if (h !== HALF_FLIP_EXCLUDED) HALF_FLIPS.push(h);
}
export const QUADRANTS = ['N', 'E', 'S', 'W'];
export const CELL_COUNT = HALF_FLIPS.length * QUADRANTS.length;  // 32 * 4 = 128

export function cellKey(halfFlips, quadrant) {
  return `${halfFlips}${quadrant}`;
}
