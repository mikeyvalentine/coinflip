// tools/analyze-glb.mjs — decode accessors, resolve world transforms, analyze geometry.
// Usage: node tools/analyze-glb.mjs assets/coin_1_ruble.glb [--dump-images outdir]
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const dumpIdx = process.argv.indexOf('--dump-images');
const dumpDir = dumpIdx > 0 ? process.argv[dumpIdx + 1] : null;

const buf = fs.readFileSync(file);
let off = 12, json = null, bin = null;
const total = buf.readUInt32LE(8);
while (off < total) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  if (type === 0x004e4942) bin = data;
  off += 8 + len;
}

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const TA = COMP[a.componentType];
  const n = NUM[a.type];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const out = [];
  if (!stride || stride === n * TA.BYTES_PER_ELEMENT) {
    const arr = new TA(bin.buffer, bin.byteOffset + base, a.count * n);
    for (let k = 0; k < a.count; k++) out.push(Array.from(arr.subarray(k * n, k * n + n)));
  } else {
    for (let k = 0; k < a.count; k++) {
      const arr = new TA(bin.buffer, bin.byteOffset + base + k * stride, n);
      out.push(Array.from(arr));
    }
  }
  return out;
}

// --- transforms -------------------------------------------------------------
function matFromNode(n) {
  if (n.matrix) return n.matrix.slice();
  const m = identity();
  const t = n.translation || [0, 0, 0];
  const q = n.rotation || [0, 0, 0, 1];
  const s = n.scale || [1, 1, 1];
  return compose(t, q, s);
}
function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function compose(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul(a, b) { // column-major a*b
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function xformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
function xformDir(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2],
  ];
}

const meshWorld = [];
function walk(idx, parent) {
  const n = json.nodes[idx];
  const world = mul(parent, matFromNode(n));
  if (n.mesh != null) meshWorld.push({ node: idx, name: n.name, mesh: n.mesh, world });
  (n.children || []).forEach((c) => walk(c, world));
}
(json.scenes[json.scene || 0].nodes).forEach((r) => walk(r, identity()));

console.log('=== ' + path.basename(file) + ' ===');
for (const mw of meshWorld) {
  console.log('mesh node', mw.name, 'world matrix (col-major):');
  console.log('  ', mw.world.map((v) => (Math.abs(v) < 1e-12 ? 0 : +v.toPrecision(8))).join(', '));
  console.log('  local axis -> world:',
    'X', xformDir(mw.world, [1, 0, 0]).map((v) => +v.toPrecision(5)),
    'Y', xformDir(mw.world, [0, 1, 0]).map((v) => +v.toPrecision(5)),
    'Z', xformDir(mw.world, [0, 0, 1]).map((v) => +v.toPrecision(5)));

  const prim = json.meshes[mw.mesh].primitives[0];
  const pos = readAccessor(prim.attributes.POSITION);
  const nrm = prim.attributes.NORMAL != null ? readAccessor(prim.attributes.NORMAL) : null;
  const uvSets = Object.keys(prim.attributes).filter((k) => k.startsWith('TEXCOORD'))
    .map((k) => ({ key: k, uv: readAccessor(prim.attributes[k]) }));

  const wp = pos.map((p) => xformPoint(mw.world, p));
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  wp.forEach((p) => p.forEach((v, i) => { bb.min[i] = Math.min(bb.min[i], v); bb.max[i] = Math.max(bb.max[i], v); }));
  console.log('  WORLD bbox min', bb.min.map((v) => +v.toPrecision(6)), 'max', bb.max.map((v) => +v.toPrecision(6)));
  console.log('  WORLD size    ', bb.max.map((v, i) => +(v - bb.min[i]).toPrecision(6)));

  if (nrm) {
    const wn = nrm.map((n) => {
      const d = xformDir(mw.world, n);
      const L = Math.hypot(...d) || 1;
      return d.map((v) => v / L);
    });
    // group vertices by dominant world normal axis
    const groups = {};
    wn.forEach((n, i) => {
      const ax = ['X', 'Y', 'Z'][n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)))];
      const sign = n[['X', 'Y', 'Z'].indexOf(ax)] > 0 ? '+' : '-';
      const key = sign + ax;
      (groups[key] ||= []).push(i);
    });
    console.log('  vertex groups by world normal:');
    for (const [k, ids] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
      const flat = ids.every((i) => Math.abs(Math.abs(wn[i][['X', 'Y', 'Z'].indexOf(k[1])]) - 1) < 0.02);
      const axIdx = ['X', 'Y', 'Z'].indexOf(k[1]);
      const vals = ids.map((i) => wp[i][axIdx]);
      let line = `    ${k}: ${ids.length} verts, axis coord ${Math.min(...vals).toPrecision(4)}..${Math.max(...vals).toPrecision(4)}, planar=${flat}`;
      for (const s of uvSets) {
        const us = ids.map((i) => s.uv[i][0]), vs = ids.map((i) => s.uv[i][1]);
        line += `\n       ${s.key} u ${Math.min(...us).toFixed(3)}..${Math.max(...us).toFixed(3)}  v ${Math.min(...vs).toFixed(3)}..${Math.max(...vs).toFixed(3)}`;
      }
      console.log(line);
    }
  }
}

if (dumpDir) {
  fs.mkdirSync(dumpDir, { recursive: true });
  (json.images || []).forEach((im, i) => {
    const bv = json.bufferViews[im.bufferView];
    const data = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const ext = im.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const out = path.join(dumpDir, `img${i}.${ext}`);
    fs.writeFileSync(out, data);
    console.log('wrote', out, data.length, 'bytes');
  });
  // which texture index maps to which image
  (json.textures || []).forEach((t, i) => console.log('texture[' + i + '] -> image', t.source));
}
