// 샌드박스 preload (CJS 필수). 렌더러에 안전한 API만 노출하고
// 마우스/드래그 경로의 붙여넣기·복사를 capture 단계에서 차단한다.
const { contextBridge, ipcRenderer } = require('electron');

let mainEventCb = null;
let blockedCb = null;

ipcRenderer.on('main-event', (e, payload) => {
  mainEventCb?.(payload);
});

contextBridge.exposeInMainWorld('classClient', {
  lock: () => ipcRenderer.invoke('lock'),
  unlock: () => ipcRenderer.invoke('unlock'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  discoverServer: () => ipcRenderer.invoke('discover-server'),
  downloadFile: (opts) => ipcRenderer.invoke('download-file', opts),
  isDev: () => ipcRenderer.invoke('is-dev'),
  onMainEvent: (cb) => { mainEventCb = cb; },
  onBlocked: (cb) => { blockedCb = cb; },
});

// 우클릭 메뉴/드래그 주입/클립보드 이벤트 이중 방어
window.addEventListener('DOMContentLoaded', () => {
  const block = (type, evName) => {
    document.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (evName) blockedCb?.({ event: evName, meta: { via: type } });
    }, { capture: true });
  };
  block('paste', 'paste_blocked');
  block('drop', 'paste_blocked');
  block('dragover', null);
  block('copy', 'copy_blocked');
  block('cut', 'copy_blocked');
  block('contextmenu', null);
});
