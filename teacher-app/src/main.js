import path from 'node:path';
import { app, BrowserWindow, dialog, Menu } from 'electron';
import { createClassServer } from '../../server/src/app.js';
import { DEFAULT_HTTP_PORT } from '../../shared/src/constants.js';
import { enableUtf8Console } from '../../shared/src/winConsole.js';

enableUtf8Console();
app.setName('교실 평가 시스템'); // 대화창·오류창 제목에 실행 파일 이름 대신 표시

let server = null;
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

async function boot() {
  const dataDir = path.join(app.getPath('userData'), 'classdata');
  const httpPort = Number(process.env.CLASS_HTTP_PORT ?? DEFAULT_HTTP_PORT);

  try {
    server = await createClassServer({ dataDir, httpPort });
    await server.start();
  } catch (err) {
    dialog.showErrorBox(
      '서버 시작 실패',
      err.code === 'EADDRINUSE'
        ? `포트 ${httpPort}가 이미 사용 중입니다.\n교사용 프로그램이 이미 실행 중인지 확인하세요.`
        : err.message,
    );
    app.quit();
    return;
  }

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: '교실 평가 시스템 — 교사',
    autoHideMenuBar: true,
  });
  win.loadURL(`http://127.0.0.1:${httpPort}/teacher/`);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(boot);

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', async () => {
  try { await server?.stop(); } catch { /* 종료 중 오류 무시 */ }
  app.quit();
});
