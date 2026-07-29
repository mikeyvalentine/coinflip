// flip3d/scene.js
// ---------------------------------------------------------------------------
// Table + coin + HDRI environment, and a camera rig that frames a coin flip.
//
// Scene graph (the split matters):
//
//   scene
//    ├ tableRoot   — table.glb, scaled + dropped so its top face IS y = 0
//    └ coinRoot    — CANONICAL. Driven verbatim by a clip's pos/quat.
//        └ coinModel — coin_1_ruble.glb + the fixed GLB->canonical correction
//                      and the real-world normalisation scale.
//
// Nothing outside this file ever touches coinModel: the correction is baked in
// once, so a baked Rapier clip can drive coinRoot with no knowledge of the GLB.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// r185 renamed RGBELoader -> HDRLoader; RGBELoader is now a deprecated alias
// for exactly this class. Same loader, no warning.
import { HDRLoader as RGBELoader } from 'three/addons/loaders/HDRLoader.js';
import {
  COIN_DIAMETER_M, COIN_THICKNESS_M, COIN_HALF_THICKNESS_M, COIN_RADIUS_M,
  TABLE_TOP_DIAMETER_M, GLB_CORRECTION_QUAT, GLB_HEADS_AXIS, GLB_DESIGN_UP_AXIS,
  normDeg, restQuatForFace, REST_ORIENTATION_DEG,
} from './contract.js';

/** '+Y' / '-Z' -> unit Vector3 */
function parseAxis(spec) {
  const sign = spec[0] === '-' ? -1 : 1;
  const idx = 'XYZ'.indexOf(spec[spec.length - 1].toUpperCase());
  return new THREE.Vector3().setComponent(idx, sign);
}

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

// --- camera shots ----------------------------------------------------------
// Azimuth 0 keeps the camera due SOUTH of the coin, so screen-up is exactly
// -Z = NORTH and screen-right is +X = EAST. The ORIENTATION bet is only
// readable because that mapping is fixed — see the note in coinflip-3d.html.
export const READY_SHOT = { target: [0, 0.004, 0], distance: 0.15, elevDeg: 34, azimuthDeg: 0 };

export function lerpShot(a, b, k) {
  const t = clamp(k, 0, 1);
  return {
    target: [
      a.target[0] + (b.target[0] - a.target[0]) * t,
      a.target[1] + (b.target[1] - a.target[1]) * t,
      a.target[2] + (b.target[2] - a.target[2]) * t,
    ],
    distance: a.distance + (b.distance - a.distance) * t,
    elevDeg: a.elevDeg + (b.elevDeg - a.elevDeg) * t,
    azimuthDeg: a.azimuthDeg + (b.azimuthDeg - a.azimuthDeg) * t,
  };
}

// ===========================================================================
// THE PICK-UP
// ===========================================================================
// Press on the coin and it leaves the table and follows the pointer. The coin
// is pinned to the LIFT LINE — the vertical line x = 0, z = 0 through the
// launch origin — so the only thing a pointer can change is height.
//
// THE PLANE. The pointer ray is intersected with the vertical plane z = 0.
// That plane CONTAINS the lift line, so the intersection's y is the answer
// directly, with nothing to project a second time.
//
// Rejected alternatives, because both are the obvious wrong turn here:
//   * a camera-facing plane through the coin (normal = the camera's forward).
//     It is tilted 34 deg out of vertical, so a pointer move implies motion in
//     z as well as y, and the z has to be thrown away — which silently changes
//     the metres-per-pixel. The z = 0 plane needs no such discard.
//   * a metres-per-pixel constant. The canvas resizes (see resize(): it tracks
//     the parent's width up to 880 px), so a constant fitted at one size is
//     wrong at every other, and wrong QUIETLY — the coin simply stops landing
//     under the finger. Everything below is derived from the camera each call.
//
// The horizontal pointer position is deliberately ignored. At azimuth 0 the
// camera's right axis is exactly world +X, whose z-component is zero, so the
// ray's z and y components do not depend on ndcX at all: the vertical answer is
// the same whether the finger is at the left edge or the right. Feeding ndcX in
// would be arithmetic that provably cannot change the result.

/** How high the coin can be lifted, in metres above the table. */
export const LIFT = {
  /** Resting on the table — the coin's centre sits half a thickness up. */
  minY: COIN_HALF_THICKNESS_M,
  // The ceiling is set by the FRAME, not by taste. With READY_SHOT fixed, the
  // top edge of the view crosses the plane z = 0 at y = 0.0451 m (asserted in
  // tools/verify-pickup.mjs, which recomputes it rather than trusting this
  // comment). Back off by a coin radius so the whole disc stays inside, plus a
  // little margin, and the ceiling lands at 0.032 m.
  //
  // Worth knowing, because it is the reason this number is not arbitrary: that
  // ceiling puts the on-screen stroke from rest to full lift at ~195 px on the
  // default 880x550 canvas, against power.js#CHARGE_TRAVEL_PX = 190. The lift
  // the frame can afford and the stroke the power meter already expected are
  // the same gesture. Neither was tuned to the other.
  maxY: 0.032,
};

/** 0 at rest, 1 at full lift. */
export const liftFraction = (worldY) =>
  clamp((worldY - LIFT.minY) / (LIFT.maxY - LIFT.minY), 0, 1);

/**
 * The camera's world basis for a shot, built exactly the way applyShot() +
 * THREE's lookAt() build it, but as plain numbers so it can run with no
 * renderer, no GL context and no DOM.
 *
 * Returns THREE's convention: `zAxis` points BACKWARDS (from target to camera),
 * so the viewing direction is -zAxis.
 */
export function cameraBasis(shot) {
  const e = shot.elevDeg * Math.PI / 180;
  const a = shot.azimuthDeg * Math.PI / 180;
  const pos = [
    shot.target[0] + Math.sin(a) * Math.cos(e) * shot.distance,
    shot.target[1] + Math.sin(e) * shot.distance,
    shot.target[2] + Math.cos(a) * Math.cos(e) * shot.distance,
  ];
  // zAxis = normalize(pos - target)
  const bx = pos[0] - shot.target[0], by = pos[1] - shot.target[1], bz = pos[2] - shot.target[2];
  const bl = Math.hypot(bx, by, bz) || 1;
  const zAxis = [bx / bl, by / bl, bz / bl];
  // xAxis = normalize(cross(up, zAxis)), up = world +Y
  const cx = 1 * zAxis[2] - 0 * zAxis[1];
  const cy = 0 * zAxis[0] - 0 * zAxis[2];
  const cz = 0 * zAxis[1] - 1 * zAxis[0];
  const cl = Math.hypot(cx, cy, cz) || 1;
  const xAxis = [cx / cl, cy / cl, cz / cl];
  // yAxis = cross(zAxis, xAxis)
  const yAxis = [
    zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1],
    zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2],
    zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0],
  ];
  return { pos, xAxis, yAxis, zAxis };
}

/**
 * Pointer row -> height on the lift line, in metres. PURE.
 *
 * @param {number} clientY  pointer y in CSS px (a PointerEvent's clientY)
 * @param {{top:number, height:number}} rect  the canvas's bounding rect
 * @param {object} [shot]   camera shot; defaults to READY_SHOT
 * @param {number} [fovDeg] vertical field of view; defaults to the scene's 30
 * @returns {number} metres, always finite, always within [LIFT.minY, LIFT.maxY]
 *
 * TOTAL BY CONSTRUCTION. A pointer dragged far below the canvas eventually
 * produces a ray that runs parallel to z = 0 and then away from it, and the
 * intersection genuinely does not exist. That is not an error case to report,
 * it is a finger below the table: it clamps to resting, like every other
 * too-low pointer position. Nothing here may hand back NaN — this feeds the
 * coin's transform, and one NaN would take coinRoot with it.
 */
export function screenYToWorldY(clientY, rect, shot = READY_SHOT, fovDeg = 30) {
  if (!rect || !(rect.height > 0) || !Number.isFinite(clientY)) return LIFT.minY;
  const { pos, yAxis, zAxis } = cameraBasis(shot);
  // NDC y: +1 at the TOP of the canvas, -1 at the bottom.
  const ndcY = 1 - 2 * (clientY - rect.top) / rect.height;
  const tanHalfV = Math.tan(fovDeg * Math.PI / 180 / 2);
  const s = ndcY * tanHalfV;
  // ray direction = yAxis*s - zAxis  (camera space looks down its own -Z)
  const dy = yAxis[1] * s - zAxis[1];
  const dz = yAxis[2] * s - zAxis[2];
  if (!(Math.abs(dz) > 1e-9)) return LIFT.minY;      // parallel to the plane
  const t = -pos[2] / dz;                             // intersect z = 0
  if (!(t > 0) || !Number.isFinite(t)) return LIFT.minY;
  const y = pos[1] + t * dy;
  if (!Number.isFinite(y)) return LIFT.minY;
  return clamp(y, LIFT.minY, LIFT.maxY);
}

/**
 * The inverse: height on the lift line -> pointer row, in CSS px. PURE.
 *
 * Exists for the round-trip assertion in tools/verify-pickup.mjs. A projection
 * that is only ever exercised in one direction is a projection whose errors
 * cancel invisibly; going both ways is what catches a wrong axis or a dropped
 * perspective divide.
 *
 * @returns {number} clientY, or NaN if the point is behind the camera
 */
export function worldYToScreenY(worldY, rect, shot = READY_SHOT, fovDeg = 30) {
  if (!rect || !(rect.height > 0)) return NaN;
  const { pos, yAxis, zAxis } = cameraBasis(shot);
  const vx = 0 - pos[0], vy = worldY - pos[1], vz = 0 - pos[2];
  const yc = vx * yAxis[0] + vy * yAxis[1] + vz * yAxis[2];
  const zc = vx * zAxis[0] + vy * zAxis[1] + vz * zAxis[2];
  if (!(zc < 0)) return NaN;                          // at or behind the eye
  const tanHalfV = Math.tan(fovDeg * Math.PI / 180 / 2);
  const ndcY = (yc / -zc) / tanHalfV;
  return rect.top + (1 - ndcY) / 2 * rect.height;
}

/**
 * Key light position. Module scope so the shadow geometry is testable, and so
 * createScene() below and shadowOffsetFor() cannot drift apart — they read the
 * same array.
 */
export const KEY_LIGHT_POS = [0.42, 0.85, 0.30];

/**
 * Where the key light throws the coin's shadow when the coin is at `worldY`.
 * PURE. Returns [x, z] metres on the table.
 *
 * This is the depth cue, and it costs nothing: the key light is DIRECTIONAL, so
 * lifting the coin does not change the shadow's size, it slides the shadow out
 * from underneath along the light direction. At full lift the gap is a bit over
 * one coin diameter, which is unmistakable and is real geometry rather than an
 * effect — the renderer draws it whether or not anyone reasons about it. The
 * function exists so the separation can be ASSERTED headlessly instead of
 * eyeballed in a pane that does not render.
 */
export function shadowOffsetFor(worldY, lightPos = KEY_LIGHT_POS) {
  const h = Math.max(worldY, 0);
  if (!(lightPos[1] > 0)) return [0, 0];
  const k = h / lightPos[1];
  return [k * lightPos[0], k * lightPos[2]];
}

// Softening the shadow with height is the one part of the cue that is NOT free.
// A directional light's shadow is the same size at every height, so on its own
// the coin reads as sliding sideways rather than rising. PCFShadowMap honours
// LightShadow.radius (PCFSoftShadowMap ignores it — that is why the renderer
// stays on plain PCF), so widening the PCF kernel with height gives the blur
// that separation alone does not.
export const SHADOW_RADIUS = { rest: 1, lifted: 4.5 };

export async function createScene(opts = {}) {
  const canvas = opts.canvas;
  const assetBase = opts.assetBase ?? './assets/';
  const onProgress = opts.onProgress ?? (() => {});

  // --- renderer ------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft is deprecated in r185
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  // Camera looks from the SOUTH (+Z) by default, so screen-right is +X = EAST
  // and away-from-camera is -Z = NORTH — the same compass the dial uses.
  const camera = new THREE.PerspectiveCamera(30, 1.6, 0.01, 20);

  // --- environment (the single highest-impact piece for a metal coin) ------
  onProgress('hdr');
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const hdr = await new RGBELoader().loadAsync(assetBase + 'cowboy_town_saloon_1k.hdr');
  const envMap = pmrem.fromEquirectangular(hdr).texture;
  hdr.dispose();
  pmrem.dispose();
  scene.environment = envMap;
  scene.background = envMap;
  scene.backgroundBlurriness = 0.42;
  scene.backgroundIntensity = 0.75;
  scene.environmentIntensity = 1.0;

  // --- lights --------------------------------------------------------------
  const key = new THREE.DirectionalLight(0xfff4e2, 2.4);
  key.position.set(KEY_LIGHT_POS[0], KEY_LIGHT_POS[1], KEY_LIGHT_POS[2]);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = SHADOW_RADIUS.rest;
  const S = 0.22;
  key.shadow.camera.left = -S; key.shadow.camera.right = S;
  key.shadow.camera.top = S; key.shadow.camera.bottom = -S;
  key.shadow.camera.near = 0.2; key.shadow.camera.far = 2.4;
  key.shadow.bias = -0.00002;
  key.shadow.normalBias = 0.0006;
  scene.add(key, key.target);

  const rim = new THREE.DirectionalLight(0xbfd6ff, 0.5);
  rim.position.set(-0.5, 0.35, -0.45);
  scene.add(rim);

  // --- assets --------------------------------------------------------------
  const gltf = new GLTFLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const tuneTextures = (root) => root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
        if (m[k]) { m[k].anisotropy = maxAniso; m[k].needsUpdate = true; }
      }
      m.envMapIntensity = 1.0;
    });
  });

  onProgress('table');
  const tableGltf = await gltf.loadAsync(assetBase + 'table.glb');
  const tableRoot = new THREE.Group();
  tableRoot.name = 'tableRoot';
  const tableModel = tableGltf.scene;
  {
    const box = new THREE.Box3().setFromObject(tableModel);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = TABLE_TOP_DIAMETER_M / Math.max(size.x, size.z);
    tableModel.scale.setScalar(s);
    // top face -> exactly y = 0, and centred on the launch origin
    tableModel.position.set(-center.x * s, -box.max.y * s, -center.z * s);
    tableModel.traverse((o) => { if (o.isMesh) { o.receiveShadow = true; o.castShadow = false; } });
    tuneTextures(tableModel);
    tableRoot.userData.measured = {
      rawSize: size.toArray(), rawTopY: box.max.y, scale: s,
      finalDiameter: Math.max(size.x, size.z) * s, finalHeight: size.y * s,
    };
  }
  tableRoot.add(tableModel);
  scene.add(tableRoot);

  onProgress('coin');
  const coinGltf = await gltf.loadAsync(assetBase + 'coin_1_ruble.glb');
  const coinRoot = new THREE.Group();          // CANONICAL node — clips drive this
  coinRoot.name = 'coinRoot';
  const coinModel = coinGltf.scene;
  const coinInfo = {};
  const headsAxisLocal = new THREE.Vector3(0, 0, 1);   // in raw GLB space
  const designUpLocal = new THREE.Vector3(0, 1, 0);    // in raw GLB space
  {
    const box = new THREE.Box3().setFromObject(coinModel);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const dims = [size.x, size.y, size.z];
    const thinIdx = dims.indexOf(Math.min(...dims));
    const wideIdx = [0, 1, 2].filter((i) => i !== thinIdx);
    const measuredDiameter = (dims[wideIdx[0]] + dims[wideIdx[1]]) / 2;
    const measuredThickness = dims[thinIdx];

    // Documented asset facts (see contract.js): the GLB's local +Z face carries
    // the eagle/obverse UVs, so +Z is HEADS; and a UV fit puts the top of both
    // face designs along local +Y, so +Y is the 12 o'clock the ORIENTATION bet
    // is measured from. Everything else here is derived from the geometry.
    const headsAxis = parseAxis(GLB_HEADS_AXIS);
    const designUp = parseAxis(GLB_DESIGN_UP_AXIS);
    if ('XYZ'.indexOf(GLB_HEADS_AXIS[GLB_HEADS_AXIS.length - 1]) !== thinIdx) {
      console.warn(`[flip3d] coin GLB changed: thin axis is ${'XYZ'[thinIdx]}, contract says heads normal is ${GLB_HEADS_AXIS}`);
    }
    // Two constraints: heads normal -> +Y, design 12 o'clock -> +X.
    const u1 = designUp.clone().normalize();
    const u3 = headsAxis.clone().normalize();
    const u2 = new THREE.Vector3().crossVectors(u3, u1).normalize();
    const src = new THREE.Matrix4().makeBasis(u1, u2, u3);
    const dst = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(1, 0, 0),   // design up  -> +X
      new THREE.Vector3(0, 0, -1),  // (right-handed completion)
      new THREE.Vector3(0, 1, 0),   // heads normal -> +Y
    );
    const correction = new THREE.Quaternion().setFromRotationMatrix(dst.multiply(src.transpose()));

    const sd = COIN_DIAMETER_M / measuredDiameter;                 // uniform, from diameter
    const st = COIN_THICKNESS_M / (measuredThickness * sd);        // extra, along the normal
    const scaleVec = new THREE.Vector3(sd, sd, sd);
    scaleVec.setComponent(thinIdx, sd * st);

    coinModel.scale.copy(scaleVec);
    coinModel.quaternion.copy(correction);
    coinModel.position.copy(center).multiply(scaleVec).applyQuaternion(correction).negate();
    coinModel.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    tuneTextures(coinModel);

    headsAxisLocal.copy(headsAxis);
    designUpLocal.copy(designUp);
    coinInfo.thinAxis = ['X', 'Y', 'Z'][thinIdx];
    coinInfo.headsAxisGLB = GLB_HEADS_AXIS;
    coinInfo.designUpAxisGLB = GLB_DESIGN_UP_AXIS;
    coinInfo.loadedSize = dims.map((v) => +v.toFixed(7));
    coinInfo.loadedDiameterMm = +(measuredDiameter * 1000).toFixed(4);
    coinInfo.loadedThicknessMm = +(measuredThickness * 1000).toFixed(4);
    coinInfo.diameterScale = +sd.toFixed(6);
    coinInfo.thicknessExtraScale = +st.toFixed(6);
    coinInfo.correctionQuat = correction.toArray().map((v) => +v.toFixed(9));
    // q and -q are the same rotation — compare by |dot|, not componentwise.
    const dot = correction.toArray().reduce((a, v, i) => a + v * GLB_CORRECTION_QUAT[i], 0);
    coinInfo.correctionMatchesContract = Math.abs(Math.abs(dot) - 1) < 1e-6;
    if (!coinInfo.correctionMatchesContract) {
      console.warn('[flip3d] derived correction disagrees with contract.js', coinInfo.correctionQuat, GLB_CORRECTION_QUAT);
    }
    coinInfo.finalDiameterMm = +(measuredDiameter * sd * 1000).toFixed(4);
    coinInfo.finalThicknessMm = +(measuredThickness * sd * st * 1000).toFixed(4);
  }
  coinRoot.add(coinModel);
  coinRoot.position.set(0, COIN_HALF_THICKNESS_M, 0);
  scene.add(coinRoot);

  // --- camera rig ----------------------------------------------------------
  let shot = { ...READY_SHOT, target: READY_SHOT.target.slice() };
  const _t = new THREE.Vector3();
  const _wq = new THREE.Quaternion();
  const _wv = new THREE.Vector3();
  function applyShot(s) {
    shot = s;
    const e = THREE.MathUtils.degToRad(s.elevDeg);
    const a = THREE.MathUtils.degToRad(s.azimuthDeg);
    _t.set(s.target[0], s.target[1], s.target[2]);
    camera.position.set(
      _t.x + Math.sin(a) * Math.cos(e) * s.distance,
      _t.y + Math.sin(e) * s.distance,
      _t.z + Math.cos(a) * Math.cos(e) * s.distance,
    );
    camera.lookAt(_t);
  }
  applyShot(shot);

  /** Frame an axis-aligned action box so it fills the view with a margin. */
  function shotForBox(min, max, { elevDeg = 22, azimuthDeg = 10, margin = 1.12, minDistance = 0.09 } = {}) {
    const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
    const h = Math.max(max[1] - min[1], 1e-3);
    const w = Math.max(max[0] - min[0], max[2] - min[2], 1e-3);
    const vHalf = THREE.MathUtils.degToRad(camera.fov) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const d = Math.max((h / 2) / Math.tan(vHalf), (w / 2) / Math.tan(hHalf)) * margin;
    return { target: [cx, cy, cz], distance: Math.max(d, minDistance), elevDeg, azimuthDeg };
  }

  // --- resize --------------------------------------------------------------
  function resize() {
    const parent = canvas.parentElement;
    const w = Math.min(parent ? parent.clientWidth : 880, 880);
    const h = Math.round(w / 1.6);
    if (w <= 0) return;
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro && canvas.parentElement) ro.observe(canvas.parentElement);
  window.addEventListener('resize', resize);

  // --- loop ----------------------------------------------------------------
  const frameCbs = new Set();
  let rafId = 0;
  let framesRendered = 0;
  let drawHook = null;
  let heldY = null;                  // null = not held; otherwise metres
  const api = {
    THREE, renderer, scene, camera, coinRoot, coinModel, tableRoot, key,
    coinInfo, tableInfo: tableRoot.userData.measured,
    applyShot, shotForBox, get shot() { return shot; },
    /** Render even when the tab/pane reports hidden (screenshot escape hatch). */
    renderWhenHidden: false,
    onFrame(cb) { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    get framesRendered() { return framesRendered; },
    /**
     * Replace the draw with something else — motion blur installs itself here.
     * Pass null to go back to a plain renderer.render(). Kept as a single
     * indirection so the loop, the hidden-pane guard and the frame counter stay
     * in one place and blur.js never touches the rAF loop.
     */
    setDrawHook(fn) { drawHook = fn || null; },
    get drawHook() { return drawHook; },
    /** Draw one frame right now, bypassing the loop. Used by the benchmarks. */
    drawOnce() { drawHook ? drawHook() : renderer.render(scene, camera); framesRendered++; },
    setCoinPose(pos, quat) {
      coinRoot.position.set(pos[0], pos[1], pos[2]);
      coinRoot.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    },

    // --- the pick-up -------------------------------------------------------
    /**
     * Pointer row -> height, using the camera as it is RIGHT NOW.
     *
     * The live shot is passed in rather than READY_SHOT, so the mapping is
     * still correct if the camera has been moved. In practice it has not: the
     * camera is deliberately FROZEN for the whole hold. A camera that pulled
     * back as the coin rose would keep more headroom, but it would also move
     * the mapping under the player's finger mid-gesture — the coin would stop
     * tracking the point it was grabbed by, and "where you release" would mean
     * something slightly different at the start of the stroke than at the end.
     * On a gesture whose entire job is to measure a release position, that is
     * not a trade worth making. The frame's headroom sets LIFT.maxY instead.
     */
    screenYToWorldY(clientY, rect) {
      return screenYToWorldY(clientY, rect ?? canvas.getBoundingClientRect(), shot, camera.fov);
    },
    /** The inverse, against the live camera. For tests and for debug readouts. */
    worldYToScreenY(worldY, rect) {
      return worldYToScreenY(worldY, rect ?? canvas.getBoundingClientRect(), shot, camera.fov);
    },
    /**
     * Hold the coin at `worldY` on the lift line, at the current rest
     * orientation. Clamped to LIFT — a caller cannot push the coin through the
     * table or out of frame.
     *
     * The pose written here is an ORDINARY canonical pose, the same shape
     * setRestFace() writes: position on coinRoot, rest quaternion on coinRoot,
     * coinModel untouched. That is what lets player.js take over from wherever
     * the coin was released and slerp into the clip's opening quaternion across
     * the lead-in, with nothing to undo first.
     */
    setHeldPose(worldY) {
      const y = clamp(worldY, LIFT.minY, LIFT.maxY);
      heldY = y;
      coinRoot.position.set(0, y, 0);
      // Orientation is NOT changed by lifting. The coin the player picks up is
      // the coin they were shown, still reading ORIENTATION 0 = North.
      const f = liftFraction(y);
      key.shadow.radius = SHADOW_RADIUS.rest + (SHADOW_RADIUS.lifted - SHADOW_RADIUS.rest) * f;
      return y;
    },
    /**
     * Put the hold down. Restores the crisp contact shadow; leaves the coin
     * exactly where it is, because on a THROW the coin carries straight on from
     * the release height and must not jump back to the table first.
     */
    endHold() {
      heldY = null;
      key.shadow.radius = SHADOW_RADIUS.rest;
    },
    /** Height the coin is being held at, or null when it is not held. */
    get heldY() { return heldY; },
    /** 0 at rest, 1 at full lift — the same number the shadow softness rides. */
    get liftFraction() { return liftFraction(heldY ?? LIFT.minY); },
    /**
     * Park the coin at the launch origin showing `face`.
     * A tails-up rest pose uses the SAME body-fixed 180 deg about local +X that
     * library.js uses to serve a tails start from a heads-up baked clip, so the
     * design's 12 o'clock (and therefore the orientation reading) is identical
     * for both faces.
     *
     * The pose also carries the rest yaw (contract.js#restQuatForFace), so the
     * coin the player looks at before a throw reads ORIENTATION 0.00 = NORTH,
     * not the 90.00 = EAST that the bare identity quaternion happens to give.
     * This is a POSE ONLY — see the note in contract.js. It cannot move a clip's
     * settle reading, because a clip drives coinRoot verbatim from its own
     * frames and never composes with this.
     *
     * The coin does NOT snap when a clip takes over: player.js slerps from
     * whatever pose this left behind into the clip's opening quaternion across
     * the lead-in.
     */
    setRestFace(face, orientationDeg = REST_ORIENTATION_DEG) {
      coinRoot.position.set(0, COIN_HALF_THICKNESS_M, 0);
      coinRoot.quaternion.fromArray(restQuatForFace(face, orientationDeg));
      // Parking the coin ends any hold: this call physically puts it back on the
      // table, so leaving heldY set would leave the shadow soft under a coin
      // that is demonstrably touching it.
      heldY = null;
      key.shadow.radius = SHADOW_RADIUS.rest;
    },
    /** Which face is currently up, read back off the live canonical transform. */
    currentFace() {
      const v = AXIS_Y.clone().applyQuaternion(coinRoot.quaternion);
      return v.y >= 0 ? 'Heads' : 'Tails';
    },
    /**
     * Read the face and the design's 12 o'clock straight off the RENDERED mesh's
     * world transform — i.e. through the correction quaternion. This is what the
     * player actually sees, and it is the end-to-end check that the GLB
     * correction agrees with canonical space.
     */
    modelHeadsUp() {
      const q = coinModel.getWorldQuaternion(_wq);
      return _wv.copy(headsAxisLocal).applyQuaternion(q).y >= 0;
    },
    modelOrientationDeg() {
      const q = coinModel.getWorldQuaternion(_wq);
      _wv.copy(designUpLocal).applyQuaternion(q);
      return normDeg(Math.atan2(_wv.x, -_wv.z) * 180 / Math.PI);
    },
    dispose() {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };

  let ticks = 0;
  function tick(now) {
    rafId = requestAnimationFrame(tick);
    for (const cb of frameCbs) cb(now);
    ticks++;
    // GPU guard: this preview runs several page instances at once and the pane
    // is usually hidden, so a hidden page must not draw every frame. It still
    // draws occasionally, otherwise a screenshot of a backgrounded pane
    // captures a stale canvas.
    if (document.hidden && !api.renderWhenHidden && ticks % 15 !== 0) return;
    if (drawHook) drawHook(); else renderer.render(scene, camera);
    framesRendered++;
  }
  rafId = requestAnimationFrame(tick);

  api.setRestFace('Heads');
  onProgress('ready');
  return api;
}

export { COIN_DIAMETER_M, COIN_THICKNESS_M, COIN_HALF_THICKNESS_M, smoothstep };
