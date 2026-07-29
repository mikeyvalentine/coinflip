// bake/decode.js
// ---------------------------------------------------------------------------
// THE COMPRESSED CLIP FORMAT — reader half, and the format spec itself.
//
// Browser-safe on purpose: no node:fs, no imports at all. The renderer ships
// this file; `encode.js` (node-only, reads and writes the disk) imports the
// constants from here so writer and reader cannot drift apart.
//
// WHY THIS FORMAT
//
// A baked clip is ~22 kB of JSON, and 1024 of them is 22 MB. The obvious lever
// — decimate 250 fps to 60 — was measured and rejected: the coin reaches 207
// rad/s, so a 60 fps step is up to 174 deg, against a hard 180 deg limit past
// which a quaternion slerp takes the SHORT path (the wrong way round) and the
// horizon crossings that ARE the spin count silently vanish. Six degrees is not
// a margin. At 50 fps the fast clips hit 231 deg and it breaks outright.
//
// The far better lever is that FREE FLIGHT IS ANALYTIC. Between the launch and
// the first bounce nothing touches the coin, so:
//   * position is a parabola under g = -9.81 (measured residual: 0.008 mm)
//   * the angular velocity is a constant world vector (measured per-step axis
//     wander 0.0009 deg, rate sd 0.0005%)
// That is not an approximation of the bake, it is what the bake computed. So the
// airborne phase compresses to 14 floats and reconstructs EXACTLY, at any frame
// rate, with no aliasing cliff to stay clear of.
//
// The bounce-and-settle after it is genuinely chaotic and has to be sampled —
// but it is also slow, so it quantises hard without visible loss.
//
// WHAT IS EXACT AND WHAT IS NOT
//   * flight        analytic, reconstructed to ~1e-3 deg of the source
//   * settle        int16-quantised, decimated
//   * FINAL FRAME   stored verbatim in float32 and never reconstructed. It
//                   carries the ORIENTATION bet, whose displayed hundredths ARE
//                   the truth (contract.js ORIENT_TOL_DEG = 0.011), so it is the
//                   one frame that may not be approximated at all.
//   * meta          copied verbatim; it is authoritative for every bet axis and
//                   the renderer already verifies the drawn pose against it.
//
// LAYOUT, little-endian throughout
//   header   magic "CFC1" | u16 version | u16 clipCount | f32 sourceFps
//   index    clipCount x u32 byte offset of each record
//   record   u8 idLen | id bytes (ascii)
//            u8 halfFlips | u8 sideIsHeads | u8 quadrant | u8 settleStride
//            f32 orientationDeg | f32 durationMs | f32 energy
//            u16 totalFrames | u16 flightFrames | u16 settleCount | u16 pad
//            f32 dtMs
//            f32[3] p0 | f32[3] v0 | f32[4] q0 | f32[3] axis | f32 rate
//            f32[3] posMin | f32[3] posScale          (settle quantisation box)
//            settleCount x ( u16 frameIndex | i16[3] pos | i16[4] quat )
//            f32[3] finalPos | f32[4] finalQuat
//
// The settle keys carry their own frame index rather than sitting on a fixed
// stride. A settle is a bounce (fast) followed by a ring-down (slow) followed by
// a coin sitting still, and one global stride has to be tight enough for the
// bounce, which then spends most of its budget storing a stationary coin.
// Adaptive keys put samples where the motion is.
// ---------------------------------------------------------------------------

export const MAGIC = 0x31434643;        // "CFC1" little-endian
export const VERSION = 1;
export const GRAVITY = 9.81;
export const QUADRANTS = ['N', 'E', 'S', 'W'];

/** i16 <-> unit range. 32767 steps over [-1,1] is 3.05e-5, i.e. 0.0035 deg. */
export const I16 = 32767;

/** q = spin(axis, ang) * q0 — a world-side rotation, matching how omega acts. */
export function spinApply(axis, ang, q0) {
  const s = Math.sin(ang / 2), c = Math.cos(ang / 2);
  const a = [axis[0] * s, axis[1] * s, axis[2] * s, c];
  return [
    a[3] * q0[0] + a[0] * q0[3] + a[1] * q0[2] - a[2] * q0[1],
    a[3] * q0[1] - a[0] * q0[2] + a[1] * q0[3] + a[2] * q0[0],
    a[3] * q0[2] + a[0] * q0[1] - a[1] * q0[0] + a[2] * q0[3],
    a[3] * q0[3] - a[0] * q0[0] - a[1] * q0[1] - a[2] * q0[2],
  ];
}

/** The analytic airborne pose at `tSec` after launch. Exact, any t. */
export function flightPose(fl, tSec) {
  return {
    pos: [
      fl.p0[0] + fl.v0[0] * tSec,
      fl.p0[1] + fl.v0[1] * tSec - 0.5 * GRAVITY * tSec * tSec,
      fl.p0[2] + fl.v0[2] * tSec,
    ],
    quat: spinApply(fl.axis, fl.rate * tSec, fl.q0),
  };
}

function normQ(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * Read the packed library.
 * @returns {{ fps:number, clips:Map<string,object> }} records, not yet frames
 */
export function readPack(buffer) {
  const dv = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a CFC pack');
  const version = dv.getUint16(4, true);
  if (version !== VERSION) throw new Error(`pack version ${version}, expected ${VERSION}`);
  const count = dv.getUint16(6, true);
  const fps = dv.getFloat32(8, true);
  const clips = new Map();
  for (let i = 0; i < count; i++) {
    const off = dv.getUint32(12 + i * 4, true);
    const rec = readRecord(dv, off);
    clips.set(rec.id, rec);
  }
  return { fps, clips };
}

function readRecord(dv, o) {
  const idLen = dv.getUint8(o); o += 1;
  let id = '';
  for (let i = 0; i < idLen; i++) id += String.fromCharCode(dv.getUint8(o + i));
  o += idLen;
  const halfFlips = dv.getUint8(o); o += 1;
  const sideIsHeads = dv.getUint8(o); o += 1;
  const quadrant = QUADRANTS[dv.getUint8(o)]; o += 1;
  const settleStride = dv.getUint8(o); o += 1;
  const orientationDeg = dv.getFloat32(o, true); o += 4;
  const durationMs = dv.getFloat32(o, true); o += 4;
  const energy = dv.getFloat32(o, true); o += 4;
  const totalFrames = dv.getUint16(o, true); o += 2;
  const flightFrames = dv.getUint16(o, true); o += 2;
  const settleCount = dv.getUint16(o, true); o += 2;
  o += 2;                                          // pad
  const dtMs = dv.getFloat32(o, true); o += 4;
  const f3 = () => { const v = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]; o += 12; return v; };
  const f4 = () => { const v = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)]; o += 16; return v; };
  const p0 = f3(), v0 = f3(), q0 = f4(), axis = f3();
  const rate = dv.getFloat32(o, true); o += 4;
  const posMin = f3(), posScale = f3();
  const settle = [];
  for (let i = 0; i < settleCount; i++) {
    const idx = dv.getUint16(o, true);
    const px = dv.getInt16(o + 2, true), py = dv.getInt16(o + 4, true), pz = dv.getInt16(o + 6, true);
    const qx = dv.getInt16(o + 8, true), qy = dv.getInt16(o + 10, true),
      qz = dv.getInt16(o + 12, true), qw = dv.getInt16(o + 14, true);
    o += 16;
    settle.push({
      idx,
      pos: [
        posMin[0] + (px / I16 + 1) * 0.5 * posScale[0],
        posMin[1] + (py / I16 + 1) * 0.5 * posScale[1],
        posMin[2] + (pz / I16 + 1) * 0.5 * posScale[2],
      ],
      quat: normQ([qx / I16, qy / I16, qz / I16, qw / I16]),
    });
  }
  const finalPos = f3(), finalQuat = f4();
  return {
    id, meta: { halfFlips, side: sideIsHeads ? 'Heads' : 'Tails', orientationDeg, quadrant,
      durationMs, settleAngleDeg: orientationDeg, energy },
    totalFrames, flightFrames, settleCount, settleStride, dtMs,
    flight: { p0, v0, q0, axis, rate }, settle, finalPos, finalQuat,
  };
}

/**
 * Rebuild a playable clip: `{ meta, frames:[{t,pos,quat}] }`, the exact shape the
 * player already consumes, so nothing downstream learns that compression exists.
 *
 * `fps` defaults to the source rate, which reproduces the original frame grid.
 * The flight is analytic so ANY rate is legal there; the settle is resampled
 * from its stored keys. Asking for a rate the settle cannot support is the one
 * way to lose information, so the settle keys are the floor — see encode.js.
 */
export function decodeClip(rec, { fps = null } = {}) {
  const dt = fps ? 1000 / fps : rec.dtMs;
  const frames = [];
  const flightEndMs = (rec.flightFrames - 1) * rec.dtMs;
  for (let t = 0; t <= flightEndMs + 1e-9; t += dt) {
    const p = flightPose(rec.flight, t / 1000);
    frames.push({ t, pos: p.pos, quat: p.quat });
  }
  // the settle keys carry their own frame index on the source grid
  for (let i = 0; i < rec.settleCount; i++) {
    const k = rec.settle[i];
    if (k.idx >= rec.totalFrames - 1) break;
    frames.push({ t: k.idx * rec.dtMs, pos: k.pos, quat: k.quat });
  }
  // THE FINAL FRAME IS VERBATIM. It carries the orientation bet.
  frames.push({ t: (rec.totalFrames - 1) * rec.dtMs, pos: rec.finalPos.slice(), quat: rec.finalQuat.slice() });
  return { meta: { ...rec.meta, id: rec.id }, frames };
}
