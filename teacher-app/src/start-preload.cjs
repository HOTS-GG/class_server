// 시작 화면(세이브 파일 선택) preload — 렌더러에 세이브 선택 API만 노출
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('startApi', {
  getRecent: () => ipcRenderer.invoke('ws:recent'),
  chooseNew: () => ipcRenderer.invoke('ws:choose-new'),
  chooseOpen: () => ipcRenderer.invoke('ws:choose-open'),
  open: (file) => ipcRenderer.invoke('ws:open', file),
  forget: (file) => ipcRenderer.invoke('ws:forget', file),
  onStatus: (cb) => ipcRenderer.on('ws:status', (e, payload) => cb(payload)),
});
