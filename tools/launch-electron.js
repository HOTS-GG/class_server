// 개발 실행용 Electron 런처.
// Windows cmd/PowerShell은 기본 코드페이지가 CP949라서 Electron이 내보내는 UTF-8 한글 로그가 깨진다.
// Electron 프로세스는 GUI 앱이라 자기 안에서 chcp를 실행해도 현재 콘솔에 적용되지 않으므로,
// 콘솔을 가진 이 Node 런처가 먼저 콘솔 코드페이지를 65001로 바꾼 뒤 Electron을 띄운다.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBin = require('electron'); // 실행 파일 경로를 돌려준다

if (process.platform === 'win32') {
  spawnSync('chcp 65001', { shell: true, stdio: 'ignore' });
}

const child = spawn(electronBin, process.argv.slice(2), { stdio: 'inherit', windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => { console.error('Electron 실행 실패:', err.message); process.exit(1); });
