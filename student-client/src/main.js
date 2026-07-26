import path from 'node:path';
import fs from 'node:fs';
import dgram from 'node:dgram';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, clipboard, powerMonitor, Menu, dialog } from 'electron';
import { DISCOVERY_MAGIC, DISCOVERY_REPLY, DEFAULT_UDP_PORT } from '../../shared/src/constants.js';
import { enableUtf8Console } from '../../shared/src/winConsole.js';

enableUtf8Console();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.argv.includes('--dev');
const userDataArg = process.argv.find((a) => a.startsWith('--user-data='));
if (userDataArg) {
  const suffix = userDataArg.split('=')[1];
  app.setPath('userData', path.join(app.getPath('appData'), `class-student-${suffix}`));
}

if (!isDev && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let locked = false;        // 시험 중 잠금 상태
let allowQuit = false;
let clipboardTimer = null;
let lastClipboard = '';

const sendToRenderer = (type, payload = {}) => {
  win?.webContents.send('main-event', { type, ...payload });
};

// ── 잠금(kiosk) 전환 ─────────────────────────────
function enterLockdown() {
  if (!win || locked) return;
  locked = true;
  if (!isDev) {
    win.setKiosk(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setMinimizable(false);
    win.setClosable(false);
  }
  clipboard.clear();
  lastClipboard = '';
  // 시험 중 클립보드 변화 감시(외부 프로그램에서 복사해오는 우회 탐지)
  clipboardTimer = setInterval(() => {
    try {
      const text = clipboard.readText();
      if (text && text !== lastClipboard) {
        lastClipboard = text;
        sendToRenderer('focus-event', { event: 'clipboard_changed' });
        clipboard.clear();
        lastClipboard = '';
      }
    } catch { /* 클립보드 접근 실패 무시 */ }
  }, 2000);
}

function exitLockdown() {
  locked = false;
  clearInterval(clipboardTimer);
  clipboardTimer = null;
  if (!win) return;
  win.setKiosk(false);
  win.setAlwaysOnTop(false);
  win.setMinimizable(true);
  win.setClosable(true);
}

// ── UDP 서버 자동 탐색 ─────────────────────────────
function discoverServer(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => { try { sock.close(); } catch { /* noop */ } resolve(null); }, timeoutMs);
    sock.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.magic === DISCOVERY_REPLY) {
          clearTimeout(timer);
          try { sock.close(); } catch { /* noop */ }
          resolve({ address: rinfo.address, port: data.port, name: data.name });
        }
      } catch { /* 잘못된 응답 무시 */ }
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      const buf = Buffer.from(DISCOVERY_MAGIC);
      sock.send(buf, DEFAULT_UDP_PORT, '255.255.255.255');
    });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// ── 과제 파일 다운로드 (바탕화면/받은과제/) ─────────────────────────────
async function downloadFile({ url, token, folder, filename }) {
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
  const dir = path.join(app.getPath('desktop'), '받은과제', safe(folder));
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  const dest = path.join(dir, safe(filename));
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return dest;
}

// ── 창 생성 ─────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    title: '수업 클라이언트',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // 키보드 차단: 복사/붙여넣기/새창/새로고침/개발자도구 등
  win.webContents.on('before-input-event', (event, input) => {
    if (isDev) return;
    const key = (input.key ?? '').toLowerCase();
    const ctrlOrMeta = input.control || input.meta;
    const blockedCombo = ctrlOrMeta && ['v', 'c', 'x', 'p', 'n', 'w', 'r', 'j', 'u', 's'].includes(key);
    const blockedKey = ['f11', 'f12'].includes(key) || (locked && key === 'escape');
    if (blockedCombo || blockedKey) {
      event.preventDefault();
      const evName = key === 'v' ? 'paste_blocked' : key === 'c' || key === 'x' ? 'copy_blocked' : 'shortcut_blocked';
      sendToRenderer('focus-event', { event: evName, meta: { key: (ctrlOrMeta ? 'Ctrl+' : '') + key.toUpperCase() } });
    }
  });

  // 이탈 감지
  win.on('blur', () => sendToRenderer('focus-event', { event: 'blur' }));
  win.on('focus', () => sendToRenderer('focus-event', { event: 'focus' }));
  win.on('minimize', () => sendToRenderer('focus-event', { event: 'minimize' }));

  // 잠금 중 닫기 시도 → 해제 코드 요구
  win.on('close', (e) => {
    if (locked && !allowQuit && !isDev) {
      e.preventDefault();
      sendToRenderer('close-attempt');
    }
  });

  win.on('closed', () => { win = null; });
}

// ── IPC ─────────────────────────────
ipcMain.handle('lock', () => { enterLockdown(); return true; });
ipcMain.handle('unlock', () => { exitLockdown(); return true; });
ipcMain.handle('quit-app', () => { allowQuit = true; exitLockdown(); app.quit(); });
ipcMain.handle('discover-server', () => discoverServer());
ipcMain.handle('download-file', async (e, opts) => {
  try {
    const dest = await downloadFile(opts);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('is-dev', () => isDev);

app.whenReady().then(() => {
  createWindow();
  powerMonitor.on('lock-screen', () => sendToRenderer('focus-event', { event: 'screen_lock' }));

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
});

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (err) => {
  console.error(err);
  if (!isDev) dialog.showErrorBox('오류', err.message);
});
