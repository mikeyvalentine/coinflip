// tools/coin-design-up.mjs
// Fit the local-space -> UV map for each coin face and report which local
// direction points at the TOP of the texture (the design's 12 o'clock).
// glTF UV convention: v increases DOWNWARD, so image-up is -v.
import fs from 'node:fs';

const buf = fs.readFileSync(process.argv[2] ?? 'assets/coin_1_ruble.glb');
let off = 12, json = null, bin = null;
const total = buf.readUInt32LE(8);
while (off < total) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  if (type === 0x004e4942) bin = data;
  off += 8 + len;
}
const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function acc(i) {
  const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
  const TA = COMP[a.componentType], n = NUM[a.type];
  const arr = new TA(bin.buffer, bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0), a.count * n);
  const o = [];
  for (let k = 0; k < a.count; k++) o.push(Array.from(arr.subarray(k * n, k * n + n)));
  return o;
}
const p = json.meshes[0].primitives[0];
const pos = acc(p.attributes.POSITION), nrm = acc(p.attributes.NORMAL), uv = acc(p.attributes.TEXCOORD_0);

// Least-squares fit  [u v] = M [x y] + c   over one face's vertices.
function fitFace(sign) {
  const ids = [];
  nrm.forEach((n, i) => { if (Math.sign(n[2]) === sign && Math.abs(n[2]) > 0.95) ids.push(i); });
  const n = ids.length;
  const mean = (f) => ids.reduce((a, i) => a + f(i), 0) / n;
  const mx = mean((i) => pos[i][0]), my = mean((i) => pos[i][1]);
  const mu = mean((i) => uv[i][0]), mv = mean((i) => uv[i][1]);
  let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
  for (const i of ids) {
    const dx = pos[i][0] - mx, dy = pos[i][1] - my;
    const du = uv[i][0] - mu, dv = uv[i][1] - mv;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    sxu += dx * du; syu += dy * du; sxv += dx * dv; syv += dy * dv;
  }
  const det = sxx * syy - sxy * sxy;
  // M rows: [a b] for u, [c d] for v
  const a = (syy * sxu - sxy * syu) / det, b = (sxx * syu - sxy * sxu) / det;
  const c = (syy * sxv - sxy * syv) / det, d = (sxx * syv - sxy * sxv) / det;
  // residual
  let res = 0;
  for (const i of ids) {
    const dx = pos[i][0] - mx, dy = pos[i][1] - my;
    res = Math.max(res, Math.hypot(a * dx + b * dy - (uv[i][0] - mu), c * dx + d * dy - (uv[i][1] - mv)));
  }
  // local direction whose UV image is (0,-1)  == toward the TOP of the image
  const D = a * d - b * c;
  const upX = (-b * -1) / D * -1, upY = 0; // placeholder, computed properly below
  // inverse of [[a,b],[c,d]] applied to (0,-1):
  const ix = (b * 1) / D * 1;             //  ( d*0 - b*(-1) ) / D  =  b/D
  const iy = (-a * -1) / D;               //  (-c*0 + a*(-1) ) / D  = -a/D
  const L = Math.hypot(ix, iy);
  return { n, M: [a, b, c, d], det: D, maxResidualUV: res, designUp: [ix / L, iy / L, 0], mirrored: D > 0 };
}

for (const [name, sign] of [['+Z face (eagle / HEADS)', 1], ['-Z face (1 rouble / TAILS)', -1]]) {
  const f = fitFace(sign);
  const deg = (Math.atan2(f.designUp[1], f.designUp[0]) * 180 / Math.PI + 360) % 360;
  console.log(name);
  console.log('  verts', f.n, ' uv-fit max residual', f.maxResidualUV.toExponential(2), ' det', f.det.toExponential(3));
  console.log('  local direction that points at the TOP of the texture:',
    f.designUp.map((v) => +v.toFixed(6)), `(${deg.toFixed(2)} deg from local +X, CCW in the local XY plane)`);
}
