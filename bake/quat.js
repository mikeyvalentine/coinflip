// quat.js — the three quaternion facts this harness needs.
// Quaternion order is [x, y, z, w] everywhere (Rapier's order, and three.js's).
// Column-vector convention: v' = R v.

/** Body +Y in world = the HEADS-face normal in canonical space. (2nd column of R) */
export function headsNormal(q) {
  const { x, y, z, w } = q;
  return [
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
  ];
}

/** Body +X in world. (1st column of R) — used for the settle angle. */
export function bodyXAxis(q) {
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
  ];
}

export function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function norm3(a) { return Math.hypot(a[0], a[1], a[2]); }

/** Angle between two unit vectors, numerically safe near 0 and pi. */
export function angleBetween(a, b) {
  const d = Math.max(-1, Math.min(1, dot3(a, b)));
  return Math.acos(d);
}

/**
 * Compass heading of a horizontal direction, in degrees [0,360).
 * 0 = N = -Z, 90 = E = +X, 180 = S = +Z, 270 = W = -X.
 */
export function heading(x, z) {
  let deg = (Math.atan2(x, -z) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/** Unit travel direction for a compass heading given in radians. */
export function headingToDir(psi) {
  return [Math.sin(psi), 0, -Math.cos(psi)];
}
