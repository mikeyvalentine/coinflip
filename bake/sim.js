// sim.js — headless Rapier, one clip per call.
// ---------------------------------------------------------------------------
// The sim collider is a CYLINDER PRIMITIVE. It is not the visual mesh and there
// is no GLB anywhere in this pipeline — that separation is the whole point of
// baking: the renderer can change the art without re-baking the odds.
//
// Determinism: no wall clock, no Math.random(), fixed timestep, fresh world per
// clip, and every launch parameter arrives pre-computed from prng.js.
// ---------------------------------------------------------------------------

import RAPIER from '@dimforge/rapier3d-compat';
import { COIN, PHYS, LAUNCH, CLASSIFY, OUTPUT } from './config.js';
import { makeFlipCounter, makeSettleDetector } from './classify.js';
import { headingToDir } from './quat.js';

let ready = false;
export async function initRapier() {
  if (!ready) { await RAPIER.init(); ready = true; }
  return RAPIER;
}

/** Emitted frames per second, given the sim timestep and the requested rate. */
export function frameStride(fps = OUTPUT.fps, dt = PHYS.dt) {
  return Math.max(1, Math.round(1 / (fps * dt)));
}

/**
 * Launch parameters. All angles in radians, speeds in m/s and rad/s.
 *   y0       launch height above the table
 *   vy       upward velocity
 *   vh       horizontal travel speed
 *   psi      compass heading of travel (0 = N = -Z, pi/2 = E = +X)
 *   omega    tumble rate about the horizontal axis perpendicular to travel
 *   spinY    spin about the coin's own axis (the "frisbee" component)
 *   yaw0     initial rotation about Y (rad). Still canonical: heads-normal is
 *            +Y and the coin lies in the XZ plane. The collider is a cylinder,
 *            which is rotationally symmetric about Y, so this is a relabelling
 *            of the body frame and NOT a change to the trajectory — see
 *            tools/yaw-invariance.js, which measures exactly that. It is the
 *            knob that makes settled orientation uniform over [0,360).
 */
export function simulateClip(params, opts = {}) {
  const phys = { ...PHYS, ...(opts.phys || {}) };
  const fps = opts.fps ?? OUTPUT.fps;
  const stride = frameStride(fps, phys.dt);
  const maxSteps = Math.ceil((CLASSIFY.maxDurationMs / 1000) / phys.dt);

  const world = new RAPIER.World({ x: 0, y: phys.gravity, z: 0 });
  world.timestep = phys.dt;
  world.numSolverIterations = phys.solverIterations;

  try {
    // --- table: top face at y = 0 -------------------------------------------
    const groundBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -phys.tableThickness, 0));
    const groundDesc = RAPIER.ColliderDesc
      .cuboid(phys.tableHalfExtent, phys.tableThickness, phys.tableHalfExtent)
      .setRestitution(phys.restitution)
      .setFriction(phys.friction)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
    if (phys.contactSkin > 0) groundDesc.setContactSkin(phys.contactSkin);
    world.createCollider(groundDesc, groundBody);

    // --- the coin -----------------------------------------------------------
    // Canonical start: identity rotation => heads-face normal is exactly +Y.
    const dir = headingToDir(params.psi);
    // Tumble axis = up x travelDir, so the coin pitches forward along travel.
    const ax = -Math.cos(params.psi);
    const az = -Math.sin(params.psi);

    const yaw0 = params.yaw0 || 0;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, params.y0, 0)
      .setRotation({ x: 0, y: Math.sin(yaw0 / 2), z: 0, w: Math.cos(yaw0 / 2) })
      .setLinvel(dir[0] * params.vh, params.vy, dir[2] * params.vh)
      .setAngvel({
        x: ax * params.omega,
        y: params.spinY,
        z: az * params.omega,
      })
      .setLinearDamping(phys.linearDamping)
      .setAngularDamping(phys.angularDamping)
      .setCcdEnabled(true);   // a 1.5 mm disc at 3 m/s tunnels without this
    const coin = world.createRigidBody(bodyDesc);

    const coinDesc = RAPIER.ColliderDesc
      .cylinder(COIN.halfHeight, COIN.radius)
      .setDensity(COIN.density)
      .setRestitution(phys.restitution)
      .setFriction(phys.friction)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
    if (phys.contactSkin > 0) coinDesc.setContactSkin(phys.contactSkin);
    world.createCollider(coinDesc, coin);

    // --- run ----------------------------------------------------------------
    const counter = makeFlipCounter();
    const settle = makeSettleDetector();
    const frames = [];
    const contactsMs = [];

    const dtMs = phys.dt * 1000;
    let apexY = params.y0;
    let peakImpactSpeed = 0;
    let firstContactMs = null;
    let airborneCount = 0;
    let airborneArc = 0;
    let inContact = false;
    let leftTable = false;
    let steps = 0;
    let settledMs = null;
    let prevVy = params.vy;

    const pushFrame = (t, p, r) => {
      frames.push({
        t: +(t).toFixed(3),
        pos: [round(p.x, OUTPUT.posDecimals), round(p.y, OUTPUT.posDecimals), round(p.z, OUTPUT.posDecimals)],
        quat: [round(r.x, OUTPUT.quatDecimals), round(r.y, OUTPUT.quatDecimals),
               round(r.z, OUTPUT.quatDecimals), round(r.w, OUTPUT.quatDecimals)],
      });
    };

    // t = 0 frame is the launch pose.
    pushFrame(0, coin.translation(), coin.rotation());
    counter.push(coin.rotation(), 0);

    for (let step = 1; step <= maxSteps; step++) {
      world.step();
      steps = step;
      const tMs = step * dtMs;

      const p = coin.translation();
      const r = coin.rotation();
      const lv = coin.linvel();
      const av = coin.angvel();

      const cosTheta = counter.push(r, step * phys.dt);
      if (p.y > apexY) apexY = p.y;

      // Contact bookkeeping (used for beat tags and the energy scalar).
      const near = p.y < CLASSIFY.contactHeight;
      if (near && !inContact) {
        inContact = true;
        contactsMs.push(tMs);
        if (firstContactMs === null) {
          firstContactMs = tMs;
          airborneCount = counter.count;
          airborneArc = counter.arcHalfFlips;
        }
        const impact = Math.abs(prevVy);
        if (impact > peakImpactSpeed) peakImpactSpeed = impact;
      } else if (!near && inContact) {
        inContact = false;
      }
      prevVy = lv.y;

      if (Math.abs(p.x) > phys.tableHalfExtent || Math.abs(p.z) > phys.tableHalfExtent ||
          p.y < -0.05) {
        leftTable = true;
        break;
      }

      if (step % stride === 0) pushFrame(tMs, p, r);

      if (settle.push({ linvel: lv, angvel: av, cosTheta, tMs, dtMs })) {
        settledMs = settle.settledAtMs;
        if (step % stride !== 0) pushFrame(tMs, p, r);   // make sure the rest pose is the last frame
        break;
      }
    }

    // Never saw first contact (e.g. it left the table mid-flight).
    if (firstContactMs === null) {
      airborneCount = counter.count;
      airborneArc = counter.arcHalfFlips;
    }

    const p = coin.translation();
    const r = coin.rotation();

    return {
      params,
      frames,
      counter,
      steps,
      settled: settledMs !== null,
      durationMs: settledMs ?? steps * dtMs,
      leftTable,
      finalPos: { x: p.x, y: p.y, z: p.z },
      finalRot: { x: r.x, y: r.y, z: r.z, w: r.w },
      launchPos: { x: 0, y: params.y0, z: 0 },
      apexY,
      peakImpactSpeed,
      firstContactMs,
      airborneCount,
      airborneArcHalfFlips: airborneArc,
      bounces: contactsMs.length,
      contactsMs,
      emittedFps: 1 / (phys.dt * stride),
    };
  } finally {
    world.free();
  }
}

function round(v, d) {
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

// --- backwards solution: what omega gives H half-flips? ---------------------
//
// Free flight to first contact:
//   t_c = (vy + sqrt(vy^2 + 2 g (y0 - h_c))) / g
// and the normal sweeps pi radians per half-flip, so
//   H_air = omega * t_c / pi   =>   omega = H_air * pi / t_c
// dH/domega = t_c/pi exactly, which makes the refinement step in bake.js a
// true Newton step rather than a guess.

export function flightTime(y0, vy, g = -PHYS.gravity, hc = CLASSIFY.contactHeight) {
  const drop = Math.max(0, y0 - hc);
  return (vy + Math.sqrt(vy * vy + 2 * g * drop)) / g;
}

export function omegaForHalfFlips(halfFlips, y0, vy) {
  return (halfFlips * Math.PI) / flightTime(y0, vy);
}

export function predictHalfFlips(omega, y0, vy) {
  return (omega * flightTime(y0, vy)) / Math.PI;
}
