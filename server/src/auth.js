import { createHmac, timingSafeEqual } from 'node:crypto';

// 학생 토큰은 무상태(HMAC): 서버가 재시작되어도 토큰이 유효해 자동 재접속이 된다.
export function makeAuth(db) {
  const sign = (studentId) =>
    createHmac('sha256', db.data.settings.tokenSecret).update(studentId).digest('hex').slice(0, 32);

  const tokenFor = (studentId) => `${studentId}.${sign(studentId)}`;

  const verifyToken = (token) => {
    if (typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i <= 0) return null;
    const id = token.slice(0, i);
    const mac = token.slice(i + 1);
    const expected = sign(id);
    if (mac.length !== expected.length) return null;
    try {
      if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    } catch { return null; }
    return id;
  };

  const findStudentByToken = (token) => {
    const id = verifyToken(token);
    if (!id) return null;
    return db.data.students.find((st) => st.id === id && st.active) ?? null;
  };

  const isLocal = (addr) =>
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

  // 교사: localhost 자동 신뢰. 원격(향후 모바일)은 PIN 헤더.
  const teacherMiddleware = (req, res, next) => {
    if (isLocal(req.socket.remoteAddress)) return next();
    const pin = req.get('x-teacher-pin');
    if (pin && db.data.settings.teacherPin && pin === db.data.settings.teacherPin) return next();
    res.status(401).json({ error: '교사 인증이 필요합니다.' });
  };

  const studentMiddleware = (req, res, next) => {
    const h = req.get('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const student = findStudentByToken(token);
    if (!student) return res.status(401).json({ error: '학생 인증이 필요합니다. 다시 로그인하세요.' });
    req.student = student;
    next();
  };

  return { tokenFor, verifyToken, findStudentByToken, isLocal, teacherMiddleware, studentMiddleware };
}
