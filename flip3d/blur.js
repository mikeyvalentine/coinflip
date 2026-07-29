// flip3d/blur.js
// ---------------------------------------------------------------------------
// MOTION BLUR — sub-step accumulation of the COIN ONLY.
//
// WHY THIS TECHNIQUE AND NOT THE OTHER TWO
// ----------------------------------------
// The coin turns 42..235 rad/s. Measured off the bake's own quaternion tracks
// the peak is 235.5 rad/s (clip 28E-6-1), which is 225 deg in a 60 Hz frame and
// 450 deg in a 30 Hz one. That number rules out most of the options:
//
//   * A VELOCITY-BUFFER POST-PROCESS cannot represent it. A velocity buffer
//     stores one linear screen-space vector per pixel and smears along it. Over
//     225 deg of rotation the true per-pixel path is a long circular arc, the
//     velocity field reverses sign across the disc, and most pixels leave the
//     silhouette entirely inside the shutter. It would also cost a second
//     full-scene geometry pass plus a full-screen pass at canvas resolution,
//     and drag in EffectComposer + MRT — real memory on a GPU that is already
//     hosting several instances of this page and a 7.9 MB table.
//
//   * A SHADER-BASED ANGULAR SMEAR (displacing verts along the rotation) has
//     the same problem from the other end: a vertex can only be pushed to one
//     place, so it can encode a few degrees of trail, not two rotations.
//
//   * ACCUMULATION is the only one of the three that is actually correct at
//     this angular rate, because it evaluates the real pose N times and
//     averages — the definition of a shutter. The usual objection to it is
//     cost, and that objection is about accumulating the WHOLE SCENE. So this
//     accumulates only the coin: one ordinary full-scene render, then N extra
//     draws of a 130-vertex disc covering a few percent of the frame. The
//     table, the HDRI background, the shadow map and the environment all render
//     exactly once per frame, as before.
//
// HOW THE AVERAGE IS TAKEN — no render targets, no extra memory
// -------------------------------------------------------------
// Drawing sample i with alpha 1/(i+1) over the previous result IS the running
// mean:  C_i = (1 - 1/(i+1))*C_{i-1} + (1/(i+1))*S_i.  After N samples the
// framebuffer holds exactly (S_0 + ... + S_{N-1})/N. So an ordinary alpha blend
// against the existing colour buffer gives an exact box-filter shutter with no
// float target, no ping-pong, and no accumulation buffer.
//
// The base pass draws the scene with the coin's colour and depth writes masked
// off (a GL state change, not a shader recompile) so the coin's pixels start as
// background/table — but the coin is STILL IN THE SHADOW MAP, cast from the
// mid-shutter pose, so a blurred coin keeps its shadow.
//
// WHAT DRIVES THE MAGNITUDE — the clip's quaternion track, nothing else
// --------------------------------------------------------------------
// The caller hands in a `sample(clipTimeMs)` function and an `omegaAt` reading
// taken from adjacent CLIP FRAMES. Adjacent baked frames are 4 ms apart, so the
// largest quaternion step between them is 54 deg — unambiguous, unlike the
// endpoints of a whole display frame, whose true swept angle can exceed 180 deg
// and would alias. Shutter length is the real clip time this frame consumed
// (so bullet time is accounted for automatically, because it is measured after
// the warp), and the sample count follows from the actual swept angle. There is
// no timer, no constant, and no per-clip authored value anywhere in here.
//
// IT MUST NOT OBSCURE THE LANDING
// -------------------------------
// Two independent guards, one automatic and one explicit:
//   1. omega collapses as the coin settles, so the sample spread collapses with
//      it and the coin is sharp at rest for free.
//   2. `landingClarity` ramps the shutter to ZERO across first contact — it
//      starts closing 60 ms BEFORE touchdown and is fully shut 40 ms after. The
//      approach, every bounce, the settle and the final authored rest pose are
//      all drawn with no blur at all, so the face and the settle yaw the player
//      bet on are never smeared.
//
// DEGRADING
// ---------
// Quality tiers cap the sample count. When the cap is below what the swept
// angle asks for, the SHUTTER IS SHORTENED to keep sample spacing at
// DEG_PER_SAMPLE rather than letting the samples space out — banding into
// discrete ghosts looks broken, a shorter smear just looks like a faster
// shutter. Cost is measured every frame; a sustained overrun drops a tier on
// its own. Any throw from the draw path disables blur permanently for the
// session and falls back to plain renderer.render() — see `fallback`.
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const RAD2DEG = 180 / Math.PI;

/** Sample spacing. Below ~15 deg apart the samples read as continuous. */
export const DEG_PER_SAMPLE = 14;
/** Shutter as a fraction of the frame interval. 0.5 = a 180 deg shutter angle. */
export const SHUTTER = 0.5;
/** Do not bother below this much swept rotation in a frame. */
export const MIN_SWEEP_DEG = 6;

export const QUALITY = {
  off:    { maxSamples: 1 },
  low:    { maxSamples: 4 },
  medium: { maxSamples: 8 },
  high:   { maxSamples: 16 },
};
export const QUALITY_ORDER = ['off', 'low', 'medium', 'high'];

/** Blur is fully shut from (touchdown + AFTER) ms; it starts closing at (touchdown - BEFORE). */
export const LANDING_GATE = { beforeMs: 60, afterMs: 40 };

/** Sustained cost above this (ms of blur work per frame) drops a tier. */
export const COST_BUDGET_MS = 9;

export function createMotionBlur(sceneApi, opts = {}) {
  const { THREE, renderer, scene, coinRoot, coinModel, tableRoot } = sceneApi;

  let quality = opts.quality ?? 'medium';
  let enabled = opts.enabled ?? true;
  let fallback = null;              // set to a reason string once blur is dead

  // --- material sets ------------------------------------------------------
  // One extra material per coin mesh, compiled once. `transparent` is a shader
  // recompile in three.js, so it is NEVER toggled per frame — the mesh's
  // material reference is swapped instead, and only `.opacity` (a uniform)
  // moves inside the loop.
  const meshes = [];
  coinModel.traverse((o) => {
    if (!o.isMesh) return;
    const orig = Array.isArray(o.material) ? o.material : [o.material];
    const smear = orig.map((m) => {
      const s = m.clone();
      s.transparent = true;
      s.depthWrite = false;
      s.depthTest = true;
      s.opacity = 1;
      return s;
    });
    meshes.push({ mesh: o, orig: Array.isArray(o.material) ? orig : orig[0], smear: Array.isArray(o.material) ? smear : smear[0], smearList: smear });
  });

  const setSmearOpacity = (a) => {
    for (const e of meshes) for (const m of e.smearList) m.opacity = a;
  };
  const useSmearMaterials = (on) => {
    for (const e of meshes) e.mesh.material = on ? e.smear : e.orig;
  };
  const maskCoin = (on) => {
    for (const e of meshes) {
      const list = Array.isArray(e.orig) ? e.orig : [e.orig];
      for (const m of list) { m.colorWrite = !on; m.depthWrite = !on; }
    }
  };

  // --- per-frame plan, filled by the player --------------------------------
  let plan = null;
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const pose = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };

  // --- cost tracking -------------------------------------------------------
  const stats = {
    frames: 0, blurredFrames: 0, samplesDrawn: 0,
    lastSamples: 0, lastSweepDeg: 0, lastShutterMs: 0, lastOmega: 0,
    costEmaMs: 0, lastCostMs: 0, downgrades: 0, quality,
    get fallback() { return fallback; },
  };

  function stepDown() {
    const i = QUALITY_ORDER.indexOf(quality);
    if (i <= 0) return false;
    quality = QUALITY_ORDER[i - 1];
    stats.quality = quality;
    stats.downgrades++;
    console.warn(`[flip3d] motion blur cost ${stats.costEmaMs.toFixed(1)} ms/frame over budget — dropping to "${quality}"`);
    return true;
  }

  /**
   * Tell the blur what the coin is doing this frame. Called by player.js from
   * inside its own onFrame callback, BEFORE the renderer draws.
   *
   * @param {object|null} p
   * @param {(ms:number, out:object)=>object} p.sample  pose at a clip time
   * @param {number} p.clipMs       clip time at this display frame
   * @param {number} p.dClipMs      clip time consumed since the previous frame
   * @param {number} p.omega        rad/s, read off adjacent CLIP frames
   * @param {number} p.touchdownMs  first contact, for the landing gate
   * @param {number} p.durationMs
   */
  function setPlan(p) { plan = p; }
  function clearPlan() { plan = null; }

  /** How many samples and how wide a shutter this frame wants. Pure. */
  function planShutter(p) {
    const cap = QUALITY[quality].maxSamples;
    if (!enabled || fallback || cap <= 1 || !p || !(p.dClipMs > 0)) return null;

    // Close the shutter across first contact so the landing is never smeared.
    const gate = 1 - smoothstep(
      (p.clipMs - (p.touchdownMs - LANDING_GATE.beforeMs)) /
      (LANDING_GATE.beforeMs + LANDING_GATE.afterMs),
    );
    if (gate <= 0.001) return null;

    let shutterMs = p.dClipMs * SHUTTER * gate;
    let sweepDeg = p.omega * (shutterMs / 1000) * RAD2DEG;
    if (sweepDeg < MIN_SWEEP_DEG) return null;

    let n = Math.ceil(sweepDeg / DEG_PER_SAMPLE);
    // One sample is just an ordinary render done the expensive way.
    if (n < 2) return null;
    if (n > cap) {
      // Cap reached: shorten the smear instead of spacing the samples out.
      shutterMs *= cap / n;
      sweepDeg *= cap / n;
      n = cap;
    }
    return { n, shutterMs, sweepDeg };
  }

  /** The draw hook scene.js calls in place of renderer.render(). */
  function draw() {
    stats.frames++;
    const p = plan;
    const s = planShutter(p);
    if (!s) { renderer.render(scene, camera()); return; }

    const t0 = performance.now();
    const cam = camera();
    const prevAutoClear = renderer.autoClear;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevBg = scene.background;
    const prevPos = coinRoot.position.clone();
    const prevQuat = coinRoot.quaternion.clone();

    try {
      // --- base pass: everything but the coin's pixels ---------------------
      // The coin stays in the traversal so the shadow map still gets it from
      // this (mid-shutter) pose; only its colour and depth writes are masked.
      maskCoin(true);
      renderer.render(scene, cam);
      maskCoin(false);

      // --- N coin-only passes, alpha 1/(i+1) = an exact running mean -------
      renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false;
      scene.background = null;
      tableRoot.visible = false;
      useSmearMaterials(true);

      const half = s.shutterMs / 2;
      for (let i = 0; i < s.n; i++) {
        const k = s.n === 1 ? 0.5 : (i + 0.5) / s.n;
        const ct = clamp(p.clipMs - half + s.shutterMs * k, 0, p.durationMs);
        p.sample(ct, pose);
        _p.set(pose.pos[0], pose.pos[1], pose.pos[2]);
        _q.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
        coinRoot.position.copy(_p);
        coinRoot.quaternion.copy(_q);
        coinRoot.updateMatrixWorld(true);
        setSmearOpacity(1 / (i + 1));
        renderer.render(scene, cam);
      }
      stats.samplesDrawn += s.n;
      stats.blurredFrames++;
    } catch (err) {
      fallback = String((err && err.message) || err);
      console.error('[flip3d] motion blur failed, falling back to unblurred render:', fallback);
    } finally {
      useSmearMaterials(false);
      maskCoin(false);
      setSmearOpacity(1);
      tableRoot.visible = true;
      scene.background = prevBg;
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      coinRoot.position.copy(prevPos);
      coinRoot.quaternion.copy(prevQuat);
      coinRoot.updateMatrixWorld(true);
    }

    const cost = performance.now() - t0;
    stats.lastCostMs = cost;
    stats.costEmaMs = stats.costEmaMs === 0 ? cost : stats.costEmaMs * 0.9 + cost * 0.1;
    stats.lastSamples = s.n;
    stats.lastSweepDeg = s.sweepDeg;
    stats.lastShutterMs = s.shutterMs;
    stats.lastOmega = p.omega;
    if (stats.costEmaMs > COST_BUDGET_MS && stats.blurredFrames > 30) {
      if (stepDown()) stats.costEmaMs = 0;
    }
  }

  const camera = () => sceneApi.camera;

  return {
    draw,
    setPlan,
    clearPlan,
    planShutter,
    stats,
    get quality() { return quality; },
    set quality(q) {
      if (!QUALITY[q]) throw new Error(`unknown blur quality "${q}"`);
      quality = q; stats.quality = q;
    },
    get enabled() { return enabled && !fallback; },
    set enabled(v) { enabled = !!v; },
    get fallbackReason() { return fallback; },
    /** Test hook: pretend the draw path exploded. */
    _forceFallback(reason = 'forced') { fallback = reason; },
    dispose() { for (const e of meshes) for (const m of e.smearList) m.dispose(); },
  };
}
