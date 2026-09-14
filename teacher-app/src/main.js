import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, ipcMain } from 'electron';
import { createClassServer } from '../../server/src/app.js';
import { DEFAULT_HTTP_PORT } from '../../shared/src/constants.js';
import { enableUtf8Console } from '../../shared/src/winConsole.js';

enableUtf8Console();
app.setName('교실 평가 시스템'); // 대화창·오류창 제목에 실행 파일 이름 대신 표시

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAVE_EXT = 'classdb';

let server = null;
let win = null;        // 대시보드 창
let startWin = null;   // 세이브 선택 창
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ── 세이브 파일 ↔ 데이터 폴더 ─────────────────────────────
// "우리반.classdb" → 첨부 파일 폴더 "우리반.files" (같은 위치)
const dataDirFor = (file) => {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  return path.join(path.dirname(file), `${base}.files`);
};
const nameOf = (file) => path.basename(file).replace(/\.[^.]+$/, '');

// 이전 버전(세이브 파일 개념이 없던 0.1.x)의 데이터 위치
const legacyDir = () => path.join(app.getPath('userData'), 'classdata');
const legacyFile = () => path.join(legacyDir(), 'db.json');

// ── 최근 목록 ─────────────────────────────
const recentPath = () => path.join(app.getPath('userData'), 'recent-workspaces.json');
function readRecent() {
  try { return JSON.parse(fs.readFileSync(recentPath(), 'utf8')); } catch { return []; }
}
function writeRecent(list) {
  try { fs.writeFileSync(recentPath(), JSON.stringify(list, null, 2)); } catch { /* noop */ }
}
function touchRecent(file) {
  const list = readRecent().filter((r) => r.file !== file);
  list.unshift({ file, lastOpened: Date.now() });
  writeRecent(list.slice(0, 12));
}
// 목록에서 제거. 이전 버전 데이터는 자동으로 다시 나타나지 않도록 hidden 표시로 남긴다.
function forgetRecent(file) {
  const list = readRecent().filter((r) => r.file !== file);
  if (file === legacyFile()) list.push({ file, hidden: true });
  writeRecent(list);
}
function recentForUi() {
  const stored = readRecent();
  const list = stored.filter((r) => !r.hidden).map((r) => ({
    ...r, name: r.file === legacyFile() ? '이전 버전 데이터' : nameOf(r.file),
    exists: fs.existsSync(r.file), legacy: r.file === legacyFile(),
  }));
  if (fs.existsSync(legacyFile()) && !stored.some((r) => r.file === legacyFile())) {
    list.push({ file: legacyFile(), name: '이전 버전 데이터', exists: true, legacy: true, lastOpened: null });
  }
  return list;
}

// ── 창 ─────────────────────────────
function showStartWindow() {
  if (startWin) { startWin.focus(); return; }
  startWin = new BrowserWindow({
    width: 720, height: 720, useContentSize: true, title: '교실 평가 시스템 — 세이브 파일 선택',
    autoHideMenuBar: true, resizable: false, maximizable: false, fullscreenable: false, center: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'start-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  startWin.loadFile(path.join(__dirname, 'start.html'));
  // 렌더링이 끝난 뒤 보여 주고 앞으로 가져온다 (뒤로 깔리거나 내려간 채 뜨지 않도록)
  startWin.once('ready-to-show', () => { startWin?.show(); startWin?.focus(); });
  startWin.on('closed', () => {
    startWin = null;
    if (!win && !quitting) app.quit(); // 세이브를 고르지 않고 닫으면 종료
  });
}

function showDashboard(httpPort) {
  win = new BrowserWindow({
    width: 1280, height: 860, title: '교실 평가 시스템 — 교사', autoHideMenuBar: true,
  });
  win.loadURL(`http://127.0.0.1:${httpPort}/teacher/`);
  win.on('closed', async () => {
    win = null;
    if (quitting) return;
    // 대시보드를 닫으면 서버도 내리고 종료 (세이브 전환 중이면 startWin이 이미 떠 있다)
    if (!startWin) { await stopServer(); app.quit(); }
  });
}

async function stopServer() {
  const s = server;
  server = null;
  if (!s) return;
  try { await s.stop(); } catch { /* 종료 중 오류 무시 */ }
}

// ── 세이브 열기 → 서버 시작 → 대시보드 ─────────────────────────────
async function openWorkspace(file) {
  const status = (message, ok) => startWin?.webContents.send('ws:status', { message, ok });
  const httpPort = Number(process.env.CLASS_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  const legacy = file === legacyFile();
  const dataDir = legacy ? legacyDir() : dataDirFor(file);
  try {
    if (server) await stopServer();
    server = await createClassServer({ dataDir, dbFile: file, httpPort });
    server.events.on('workspace:switch', () => switchWorkspace());
    await server.start();
  } catch (err) {
    await stopServer();
    const msg = err.code === 'EADDRINUSE'
      ? `포트 ${httpPort}가 이미 사용 중입니다.\n교사용 프로그램이 이미 실행 중인지 확인하세요.`
      : `세이브를 열지 못했습니다: ${err.message}`;
    status(msg, false);
    return { ok: false, error: msg };
  }
  touchRecent(file);
  showDashboard(httpPort);
  if (startWin) { const s = startWin; startWin = null; s.close(); }
  return { ok: true };
}

// 대시보드의 [다른 세이브 열기] → 서버 내리고 시작 화면으로
async function switchWorkspace() {
  showStartWindow();
  if (win) { const w = win; win = null; w.close(); }
  await stopServer();
}

// ── IPC (시작 화면) ─────────────────────────────
ipcMain.handle('ws:recent', () => recentForUi());
ipcMain.handle('ws:forget', (e, file) => { forgetRecent(file); return true; });
ipcMain.handle('ws:version', () => app.getVersion());
ipcMain.handle('ws:choose-new', async () => {
  const r = await dialog.showSaveDialog(startWin, {
    title: '새 세이브 파일 만들기',
    defaultPath: path.join(app.getPath('documents'), `우리반.${SAVE_EXT}`),
    filters: [{ name: '교실 평가 세이브', extensions: [SAVE_EXT] }],
  });
  if (r.canceled || !r.filePath) return null;
  const file = r.filePath.toLowerCase().endsWith(`.${SAVE_EXT}`) ? r.filePath : `${r.filePath}.${SAVE_EXT}`;
  if (fs.existsSync(file)) {
    const ans = await dialog.showMessageBox(startWin, {
      type: 'question', buttons: ['기존 파일 열기', '취소'], defaultId: 0, cancelId: 1,
      message: '같은 이름의 세이브가 이미 있습니다.', detail: '기존 파일을 그대로 열까요? (덮어쓰지 않습니다)',
    });
    if (ans.response !== 0) return null;
  }
  return file;
});
ipcMain.handle('ws:choose-open', async () => {
  const r = await dialog.showOpenDialog(startWin, {
    title: '세이브 파일 열기', properties: ['openFile'],
    filters: [{ name: '교실 평가 세이브', extensions: [SAVE_EXT, 'json'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('ws:open', (e, file) => openWorkspace(file));

// ── 앱 수명주기 ─────────────────────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // 명령줄로 세이브 파일을 넘기면 바로 연다 (탐색기에서 .classdb 더블클릭 대비, 없는 파일이면 새로 만든다)
  const arg = process.argv.slice(1).find((a) => a.toLowerCase().endsWith(`.${SAVE_EXT}`));
  if (arg) {
    showStartWindow();
    openWorkspace(path.resolve(arg));
  } else showStartWindow();
});

app.on('second-instance', () => {
  const w = win ?? startWin;
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', async () => {
  quitting = true;
  await stopServer();
  app.quit();
});
