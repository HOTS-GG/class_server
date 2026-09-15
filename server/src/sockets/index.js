import { FOCUS_EVENTS } from '../../../shared/src/constants.js';

export function attachSockets({ io, db, auth, presence, examService }) {
  const teacherNs = io.of('/teacher');
  const studentNs = io.of('/student');

  // ── 학생 네임스페이스 ─────────────────────────────
  studentNs.use((socket, next) => {
    const student = auth.findStudentByToken(socket.handshake.auth?.token);
    if (!student) return next(new Error('unauthorized'));
    socket.data.student = student;
    next();
  });

  studentNs.on('connection', (socket) => {
    const student = socket.data.student;

    // 동일 학생 중복 접속 → 기존 세션 강제 종료
    const prevId = presence.socketIdOf(student.id);
    if (prevId && prevId !== socket.id) {
      const prev = studentNs.sockets.get(prevId);
      if (prev) {
        prev.emit('session:kicked', { reason: '다른 자리에서 접속되었습니다.' });
        prev.disconnect(true);
      }
    }

    presence.setOnline(student.id, socket.id);
    socket.join(`student:${student.id}`);

    const active = examService.activeExamFor(student.id);
    if (active && !active.attempt.submittedAt) {
      recordFocus(student, 'reconnect', { examId: active.exam.id });
    }
    teacherNs.emit('student:online', presence.snapshot(student.id));

    function recordFocus(stu, event, meta = {}) {
      if (!FOCUS_EVENTS.includes(event)) return;
      const ts = Date.now();
      presence.recordFocusEvent(stu.id, event, ts);
      const activeNow = examService.activeExamFor(stu.id);
      const examId = activeNow?.exam.id ?? null;
      const entry = { ts, studentId: stu.id, number: stu.number, name: stu.name, examId, event, meta };
      db.appendEvent(examId ? `focus-${examId}` : 'focus-general', entry);
      teacherNs.emit('focus:event', { ...entry, presence: presence.snapshot(stu.id) });
    }

    socket.on('focus:event', (payload) => {
      recordFocus(student, payload?.event, payload?.meta ?? {});
    });

    socket.on('exam:answer', (payload, cb) => {
      try {
        const exam = examService.findExam(payload?.examId);
        const { savedAt } = examService.saveAnswer(exam, student, payload?.questionId, payload?.answer);
        cb?.({ ok: true, savedAt });
      } catch (err) {
        cb?.({ ok: false, error: err.message });
      }
    });

    socket.on('exam:sync', (payload, cb) => {
      try {
        const exam = examService.findExam(payload?.examId);
        const r = examService.syncAnswers(exam, student, payload?.answers ?? {});
        cb?.({ ok: true, ...r });
      } catch (err) {
        cb?.({ ok: false, error: err.message });
      }
    });

    socket.on('exam:submit', (payload, cb) => {
      try {
        const exam = examService.findExam(payload?.examId);
        const attempt = examService.submit(exam, student, 'manual');
        cb?.({ ok: true, submittedAt: attempt.submittedAt });
      } catch (err) {
        cb?.({ ok: false, error: err.message });
      }
    });

    socket.on('disconnect', () => {
      const cur = presence.socketIdOf(student.id);
      if (cur !== socket.id) return; // 새 세션으로 교체됨
      presence.setOffline(student.id, socket.id);
      const activeNow = examService.activeExamFor(student.id);
      if (activeNow && !activeNow.attempt.submittedAt) {
        recordFocus(student, 'disconnect', { examId: activeNow.exam.id });
      }
      teacherNs.emit('student:offline', presence.snapshot(student.id));
    });
  });

  // ── 교사 네임스페이스 ─────────────────────────────
  teacherNs.use((socket, next) => {
    const addr = socket.handshake.address ?? '';
    if (auth.isLocal(addr)) return next();
    const pin = socket.handshake.auth?.pin;
    if (pin && db.data.settings.teacherPin && pin === db.data.settings.teacherPin) return next();
    next(new Error('unauthorized'));
  });

  teacherNs.on('connection', (socket) => {
    socket.emit('snapshot', {
      presence: presence.list(),
      activeExam: db.data.exams.find((e) => e.status === 'active') ?? null,
      serverNow: Date.now(),
    });
  });
}
