// assets/icons/teacher.svg, student.svg (벡터) → teacher.ico / student.ico (16~256px) + *-256.png
//   npm run make-icons   (= electron tools/make-icons.js)
// Electron(Chromium)으로 SVG를 각 크기로 직접 렌더링하므로 모서리 바깥이 투명하게 유지된다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'assets', 'icons');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

let win = null;
async function render(svgText, size) {
  if (!win) {
    win = new BrowserWindow({
      width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true },
    });
    await win.loadURL('about:blank');
  }
  const html = `<body style="margin:0;background:transparent;overflow:hidden"><img id="i" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}"></body>`;
  await win.webContents.executeJavaScript(`
    document.open(); document.write(${JSON.stringify(html)}); document.close();
    new Promise((r) => { const i = document.getElementById('i'); i.style.width = i.style.height = '${size}px'; i.complete ? r() : (i.onload = r); })`);
  await new Promise((r) => setTimeout(r, 120)); // 페인트 대기
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const { width, height } = img.getSize();
  if (width !== size || height !== size) img = img.resize({ width: size, height: size, quality: 'best' }); // DPI 배율 보정
  return img;
}

// ICO BMP 엔트리: 32bpp BGRA(straight alpha), bottom-up + AND 마스크
function bmpEntry(size, premultipliedBgra) {
  const rowMask = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4 + rowMask * size, 20);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = ((size - 1 - y) * size + x) * 4, di = (y * size + x) * 4;
      const a = premultipliedBgra[si + 3];
      const un = (v) => (a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a)));
      xor[di] = un(premultipliedBgra[si]); xor[di + 1] = un(premultipliedBgra[si + 1]); xor[di + 2] = un(premultipliedBgra[si + 2]); xor[di + 3] = a;
    }
  }
  return Buffer.concat([header, xor, Buffer.alloc(rowMask * size)]);
}

function buildIco(images) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  const entries = []; let offset = 6 + 16 * images.length;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(img.data.length, 8); e.writeUInt32LE(offset, 12);
    offset += img.data.length; entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
}

app.whenReady().then(async () => {
  try {
    for (const name of ['teacher', 'student']) {
      const svg = fs.readFileSync(path.join(dir, `${name}.svg`), 'utf8');
      const images = [];
      for (const size of SIZES) {
        const img = await render(svg, size);
        if (size === 256) {
          fs.writeFileSync(path.join(dir, `${name}-256.png`), img.toPNG());
          images.push({ size, data: img.toPNG() });
        } else {
          images.push({ size, data: bmpEntry(size, img.toBitmap()) });
        }
      }
      const ico = buildIco(images);
      fs.writeFileSync(path.join(dir, `${name}.ico`), ico);
      console.log(`${name}.ico ${ico.length} bytes (${SIZES.join('/')}px)`);
    }
    app.exit(0);
  } catch (err) { console.error(err); app.exit(1); }
});
