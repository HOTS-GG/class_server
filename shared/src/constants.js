export const DEFAULT_HTTP_PORT = 3690;
export const DEFAULT_UDP_PORT = 3691;
export const DISCOVERY_MAGIC = 'CLASSSERVER_DISCOVER_V1';
export const DISCOVERY_REPLY = 'CLASSSERVER_HERE_V1';
export const APP_VERSION = '0.2.0';
export const MIN_CLIENT_VERSION = '0.1.0';

// 시험 종료 후 늦게 도착하는 답안을 받아주는 유예 시간
export const EXAM_GRACE_MS = 5000;

export const FOCUS_EVENTS = [
  'blur', 'focus', 'minimize', 'screen_lock',
  'disconnect', 'reconnect',
  'paste_blocked', 'copy_blocked', 'shortcut_blocked', 'clipboard_changed',
];
