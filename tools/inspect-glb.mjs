// tools/inspect-glb.mjs — dump GLB structure: nodes, transforms, mesh bounds.
// Usage: node tools/inspect-glb.mjs assets/coin_1_ruble.glb
import fs from 'node:fs';

const path = process.argv[2];
const buf = fs.readFileSync(path);
const magic = buf.readUInt32LE(0);
if (magic !== 0x46546c67) throw new Error('not a glb');
const version = buf.readUInt32LE(4);
const total = buf.readUInt32LE(8);

let off = 12;
let json = null;
let bin = null;
while (off < total) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  if (type === 0x004e4942) bin = data;
  off += 8 + len + ((4 - (len % 4)) % 4) * 0; // chunks are already 4-byte padded in len
  off = off; // glb chunk lengths include padding
}

console.log('=== ' + path + ' (glb v' + version + ', ' + total + ' bytes) ===');
console.log('generator:', json.asset && json.asset.generator);
console.log('scenes:', JSON.stringify(json.scenes));
console.log('nodes:');
(json.nodes || []).forEach((n, i) => {
  console.log('  [' + i + ']', JSON.stringify({
    name: n.name, mesh: n.mesh, children: n.children,
    translation: n.translation, rotation: n.rotation, scale: n.scale, matrix: n.matrix,
  }));
});
console.log('meshes:');
(json.meshes || []).forEach((m, i) => {
  console.log('  [' + i + ']', m.name, 'primitives:', m.primitives.length);
  m.primitives.forEach((p, pi) => {
    const acc = json.accessors[p.attributes.POSITION];
    console.log('    prim' + pi, 'mode', p.mode, 'material', p.material,
      'count', acc.count, 'min', JSON.stringify(acc.min), 'max', JSON.stringify(acc.max),
      'attrs', Object.keys(p.attributes).join(','));
    const idx = p.indices != null ? json.accessors[p.indices] : null;
    if (idx) console.log('      indices count', idx.count, '-> tris', idx.count / 3);
  });
});
console.log('materials:');
(json.materials || []).forEach((m, i) => {
  console.log('  [' + i + ']', JSON.stringify(m));
});
console.log('textures:', (json.textures || []).length, 'images:', (json.images || []).length);
(json.images || []).forEach((im, i) => console.log('  img[' + i + ']', im.name, im.mimeType, 'bufferView', im.bufferView));
