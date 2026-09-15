// assets/icons/<name>-<size>.raw (BGRA top-down) + <name>-256.png → assets/icons/<name>.ico
// 16~128은 BMP 엔트리, 256은 PNG 엔트리 (Windows Vista+ 규칙)
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('assets/icons');
const SIZES = [16, 24, 32, 48, 64, 128];

function bmpEntry(size, bgra) {
  const rowMask = Math.ceil(size / 32) * 4; // AND 마스크 행은 4바이트 정렬
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 높이
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4 + rowMask * size, 20);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) { // bottom-up
    bgra.copy(xor, y * size * 4, (size - 1 - y) * size * 4, (size - y) * size * 4);
  }
  const and = Buffer.alloc(rowMask * size); // 알파가 있으므로 마스크는 0
  return Buffer.concat([header, xor, and]);
}

for (const name of ['teacher', 'student']) {
  const images = SIZES.map((s) => ({ size: s, data: bmpEntry(s, fs.readFileSync(path.join(dir, `${name}-${s}.raw`))) }));
  images.push({ size: 256, data: fs.readFileSync(path.join(dir, `${name}-256.png`)) });
  const count = images.length;
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + 16 * count;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size === 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size === 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  const out = Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
  fs.writeFileSync(path.join(dir, `${name}.ico`), out);
  console.log(`${name}.ico`, out.length, 'bytes,', count, 'images');
}
