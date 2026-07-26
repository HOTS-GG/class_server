import { execSync } from 'node:child_process';

// Windows 콘솔(cmd/PowerShell)은 기본 코드페이지가 CP949(한국어 시스템)라서
// Node/Electron이 내보내는 UTF-8 한글 로그가 "?ы듃..." 처럼 깨져 보인다.
// 실행 중인 콘솔의 코드페이지를 UTF-8(65001)로 전환해 해결한다.
// 콘솔이 없는 환경(패키징된 GUI 앱, 서비스)에서는 조용히 무시된다.
export function enableUtf8Console() {
  if (process.platform !== 'win32') return;
  try {
    // 주의: windowsHide/stdio:'ignore'를 쓰면 숨겨진 별도 콘솔이 생겨
    // 그쪽 코드페이지만 바뀌므로, 현재 콘솔을 상속하도록 pipe로 실행한다.
    execSync('chcp 65001', { stdio: 'pipe' });
  } catch { /* 콘솔 없음 — 무시 */ }
}
