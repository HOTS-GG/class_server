// 접속/이탈 상태는 메모리 전용 (서버 재시작 시 자연 재구성)
export function createPresence() {
  const map = new Map();

  const entry = (studentId) => {
    let e = map.get(studentId);
    if (!e) {
      e = {
        studentId,
        online: false,
        socketId: null,
        lastSeen: null,
        focus: 'unknown',   // 'focused' | 'away' | 'unknown'
        awayCount: 0,       // 이탈(blur/최소화/잠금/연결끊김) 횟수
        awayMs: 0,          // 누적 이탈 시간
        awaySince: null,
      };
      map.set(studentId, e);
    }
    return e;
  };

  const setOnline = (studentId, socketId) => {
    const e = entry(studentId);
    e.online = true;
    e.socketId = socketId;
    e.lastSeen = Date.now();
    return e;
  };

  const setOffline = (studentId, socketId) => {
    const e = entry(studentId);
    if (socketId && e.socketId !== socketId) return e; // 새 세션으로 교체된 경우
    e.online = false;
    e.socketId = null;
    e.lastSeen = Date.now();
    return e;
  };

  const AWAY_EVENTS = new Set(['blur', 'minimize', 'screen_lock', 'disconnect']);
  const BACK_EVENTS = new Set(['focus', 'reconnect']);

  const recordFocusEvent = (studentId, event, ts = Date.now()) => {
    const e = entry(studentId);
    if (AWAY_EVENTS.has(event)) {
      if (e.focus !== 'away') {
        e.awayCount += 1;
        e.awaySince = ts;
      }
      e.focus = 'away';
    } else if (BACK_EVENTS.has(event)) {
      if (e.focus === 'away' && e.awaySince) e.awayMs += ts - e.awaySince;
      e.awaySince = null;
      e.focus = 'focused';
    }
    return e;
  };

  const resetFocusStats = () => {
    for (const e of map.values()) {
      e.awayCount = 0;
      e.awayMs = 0;
      e.awaySince = null;
    }
  };

  const snapshot = (studentId) => {
    const e = entry(studentId);
    const extraAway = e.focus === 'away' && e.awaySince ? Date.now() - e.awaySince : 0;
    return {
      studentId: e.studentId,
      online: e.online,
      focus: e.focus,
      awayCount: e.awayCount,
      awayMs: e.awayMs + extraAway,
      lastSeen: e.lastSeen,
    };
  };

  const list = () => [...map.keys()].map(snapshot);

  const socketIdOf = (studentId) => map.get(studentId)?.socketId ?? null;

  return { setOnline, setOffline, recordFocusEvent, resetFocusStats, snapshot, list, socketIdOf };
}
