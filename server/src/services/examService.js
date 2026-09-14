import { buildAttemptOrders } from '../../../shared/src/shuffle.js';
import { computeTotalScore } from '../../../shared/src/grading.js';
import { newId } from '../../../shared/src/id.js';
import { EXAM_GRACE_MS } from '../../../shared/src/constants.js';

const MAX_ESSAY_LENGTH = 20000;

export function createExamService(db, io) {
  const endTimers = new Map(); // examId -> timeout

  const findExam = (examId) => db.data.exams.find((e) => e.id === examId);
  const attemptOf = (examId, studentId) =>
    db.data.attempts.find((a) => a.examId === examId && a.studentId === studentId);

  const answersLog = (examId) => `answers-${examId}`;

  const teacherNs = () => io.of('/teacher');
  const studentNs = () => io.of('/student');

  function startExam(exam, durationSec, options = {}) {
    if (exam.status === 'active') throw new Error('이미 진행 중인 시험입니다.');
    const otherActive = db.data.exams.find((e) => e.status === 'active');
    if (otherActive) throw new Error(`다른 시험(${otherActive.title})이 진행 중입니다. 먼저 종료하세요.`);
    if (!exam.questions?.length) throw new Error('문항이 없는 시험은 시작할 수 없습니다.');

    exam.status = 'active';
    exam.durationSec = durationSec;
    exam.lockdown = options.lockdown === true; // 전체화면 잠금은 선택 사항 (기본 꺼짐)
    exam.startedAt = Date.now();
    exam.endsAt = exam.startedAt + durationSec * 1000;

    // 응시 대상: 시험의 과목(학급) 학생. 과목이 없는 시험은 전체 학생.
    const eligible = db.data.students.filter((s) => s.active && (!exam.subjectId || s.subjectId === exam.subjectId));
    if (!eligible.length) throw new Error('이 시험의 과목(학급)에 등록된 학생이 없습니다. 학생 명단에서 해당 과목에 학생을 추가하세요.');
    for (const stu of eligible) {
      if (attemptOf(exam.id, stu.id)) continue;
      const { questionOrder, choiceOrder } = buildAttemptOrders(exam, stu.id);
      db.data.attempts.push({
        id: newId('att'),
        examId: exam.id,
        studentId: stu.id,
        questionOrder,
        choiceOrder,
        startedAt: exam.startedAt,
        submittedAt: null,
        submitType: null,
        answers: {},
        manualGrades: {},
        aiGrades: {},
        feedback: {},
        score: null,
        scoreDetail: null,
      });
    }
    db.scheduleFlush();
    scheduleEnd(exam);
    studentNs().emit('exam:started', { examId: exam.id, title: exam.title, endsAt: exam.endsAt, serverNow: Date.now() });
    teacherNs().emit('exam:status', { examId: exam.id, status: 'active', endsAt: exam.endsAt });
  }

  function scheduleEnd(exam) {
    clearTimeout(endTimers.get(exam.id));
    const delay = Math.max(0, exam.endsAt + EXAM_GRACE_MS - Date.now());
    endTimers.set(exam.id, setTimeout(() => endExam(exam, 'auto'), delay));
  }

  function endExam(exam, reason) {
    if (exam.status !== 'active') return;
    clearTimeout(endTimers.get(exam.id));
    endTimers.delete(exam.id);
    for (const att of db.data.attempts.filter((a) => a.examId === exam.id && !a.submittedAt)) {
      finalizeAttempt(exam, att, reason === 'teacher' ? 'teacher' : 'auto');
    }
    exam.status = 'ended';
    exam.endedAt = Date.now();
    db.scheduleFlush();
    studentNs().emit('exam:ended', { examId: exam.id, reason });
    teacherNs().emit('exam:status', { examId: exam.id, status: 'ended', reason });
    // "즉시 공개" 시험: 종료와 동시에 자동 채점분(객관식·단답형)을 학생에게 공개.
    // 서술형은 교사가 AI 채점 반영/직접 채점을 하면 그때 갱신되어 보인다.
    if (exam.instantResults === true) setResultsPublished(exam, true);
  }

  function assertAcceptingAnswers(exam) {
    if (!exam || exam.status !== 'active') throw new Error('진행 중인 시험이 아닙니다.');
    if (Date.now() > exam.endsAt + EXAM_GRACE_MS) throw new Error('시험 시간이 종료되었습니다.');
  }

  function saveAnswer(exam, student, questionId, answer) {
    assertAcceptingAnswers(exam);
    const attempt = attemptOf(exam.id, student.id);
    if (!attempt) throw new Error('이 시험의 응시 대상이 아닙니다.');
    if (attempt.submittedAt) throw new Error('이미 제출한 시험입니다.');
    const q = exam.questions.find((x) => x.id === questionId);
    if (!q) throw new Error('존재하지 않는 문항입니다.');

    let saved;
    const savedAt = Date.now();
    if (q.type === 'mc') {
      const valid = q.choices.some((c) => c.id === answer?.choiceId);
      if (!valid && answer?.choiceId != null) throw new Error('잘못된 선택지입니다.');
      saved = { choiceId: answer?.choiceId ?? null, savedAt };
    } else {
      const text = String(answer?.text ?? '').slice(0, MAX_ESSAY_LENGTH);
      saved = { text, savedAt };
      // 첨부 파일은 별도 경로(saveAnswerFile)로만 바뀐다. 텍스트 저장 시 기존 첨부는 유지.
      const prevFile = attempt.answers[questionId]?.file;
      if (prevFile) saved.file = prevFile;
    }
    attempt.answers[questionId] = saved;
    db.appendEvent(answersLog(exam.id), {
      ts: savedAt, attemptId: attempt.id, studentId: student.id, questionId, answer: saved,
    });
    db.scheduleFlush();
    teacherNs().emit('exam:progress', {
      examId: exam.id,
      studentId: student.id,
      answeredCount: countAnswered(exam, attempt),
      questionCount: exam.questions.length,
    });
    return { savedAt };
  }

  // 서술형 첨부 파일 저장/삭제 (파일 자체는 라우트가 디스크에 놓고, 여기서는 답안 메타만 관리)
  function saveAnswerFile(exam, student, questionId, fileMeta) {
    assertAcceptingAnswers(exam);
    const attempt = attemptOf(exam.id, student.id);
    if (!attempt) throw new Error('이 시험의 응시 대상이 아닙니다.');
    if (attempt.submittedAt) throw new Error('이미 제출한 시험입니다.');
    const q = exam.questions.find((x) => x.id === questionId);
    if (!q) throw new Error('존재하지 않는 문항입니다.');
    if (q.type !== 'essay' || q.allowFile !== true) throw new Error('이 문항은 파일 첨부를 허용하지 않습니다.');
    const prev = attempt.answers[questionId] ?? { text: '' };
    const savedAt = Date.now();
    const saved = { text: prev.text ?? '', savedAt, file: fileMeta ?? undefined };
    if (!fileMeta) delete saved.file;
    attempt.answers[questionId] = saved;
    db.appendEvent(answersLog(exam.id), {
      ts: savedAt, attemptId: attempt.id, studentId: student.id, questionId, answer: saved,
    });
    db.scheduleFlush();
    teacherNs().emit('exam:progress', {
      examId: exam.id, studentId: student.id,
      answeredCount: countAnswered(exam, attempt), questionCount: exam.questions.length,
    });
    return { attempt, previousFile: prev.file ?? null, savedAt };
  }

  const hasAnswer = (q, a) => {
    if (!a) return false;
    if (q.type === 'mc') return a.choiceId != null;
    return (a.text ?? '').trim() !== '' || !!a.file;
  };

  function countAnswered(exam, attempt) {
    let n = 0;
    for (const q of exam.questions) {
      if (hasAnswer(q, attempt.answers[q.id])) n++;
    }
    return n;
  }

  function submit(exam, student, type = 'manual') {
    assertAcceptingAnswers(exam);
    const attempt = attemptOf(exam.id, student.id);
    if (!attempt) throw new Error('이 시험의 응시 대상이 아닙니다.');
    if (attempt.submittedAt) return attempt; // 중복 제출 무해 처리
    finalizeAttempt(exam, attempt, type);
    db.scheduleFlush();
    return attempt;
  }

  function finalizeAttempt(exam, attempt, submitType) {
    attempt.submittedAt = Date.now();
    attempt.submitType = submitType;
    regrade(exam, attempt);
    teacherNs().emit('exam:submitted', {
      examId: exam.id,
      studentId: attempt.studentId,
      submitType,
      submittedAt: attempt.submittedAt,
      score: attempt.score,
    });
  }

  function regrade(exam, attempt) {
    const detail = computeTotalScore(exam, attempt.answers, attempt.manualGrades);
    attempt.scoreDetail = detail;
    attempt.score = detail.total;
    return detail;
  }

  // 학생 응시 화면용: 정답을 제거하고 학생별 순서를 적용한 뷰
  function buildStudentPayload(exam, attempt) {
    const byId = Object.fromEntries(exam.questions.map((q) => [q.id, q]));
    return {
      exam: {
        id: exam.id,
        title: exam.title,
        subjectName: db.data.subjects?.find((s) => s.id === exam.subjectId)?.name ?? null,
        durationSec: exam.durationSec,
        startedAt: exam.startedAt,
        endsAt: exam.endsAt,
        status: exam.status,
        lockdown: exam.lockdown === true,
        instantResults: exam.instantResults === true,
      },
      serverNow: Date.now(),
      submitted: !!attempt.submittedAt,
      // 첨부 파일은 이름/크기만 (저장 경로는 노출하지 않음)
      answers: Object.fromEntries(Object.entries(attempt.answers).map(([qid, a]) => [qid, {
        ...a,
        ...(a.file ? { file: { name: a.file.name, size: a.file.size } } : {}),
      }])),
      questions: attempt.questionOrder.map((qid, idx) => {
        const q = byId[qid];
        const choiceById = q.choices ? Object.fromEntries(q.choices.map((c) => [c.id, c])) : {};
        return {
          id: q.id,
          no: idx + 1,
          type: q.type,
          text: q.text,
          points: q.points,
          allowFile: q.type === 'essay' && q.allowFile === true,
          choices: (attempt.choiceOrder[qid] ?? []).map((cid) => ({ id: cid, text: choiceById[cid].text })),
        };
      }),
    };
  }

  // 성적 공개/비공개 전환 + 학생 알림
  function setResultsPublished(exam, published) {
    exam.resultsPublished = published === true;
    db.scheduleFlush();
    if (exam.resultsPublished) {
      studentNs().emit('exam:results-published', { examId: exam.id, title: exam.title });
    }
    teacherNs().emit('exam:status', { examId: exam.id, status: exam.status, resultsPublished: exam.resultsPublished });
  }

  // 성적 공개 후 학생이 보는 본인 결과: 문항별 내 답/정답/득점
  function buildResultPayload(exam, attempt) {
    const detail = attempt.scoreDetail ?? { perQuestion: {}, total: null, maxTotal: null };
    const byId = Object.fromEntries(exam.questions.map((q) => [q.id, q]));
    const essayTotal = exam.questions.filter((q) => q.type === 'essay').length;
    const essayGraded = exam.questions.filter((q) => q.type === 'essay' && detail.perQuestion?.[q.id] != null).length;
    return {
      exam: { id: exam.id, title: exam.title, subjectName: db.data.subjects?.find((s) => s.id === exam.subjectId)?.name ?? null },
      submittedAt: attempt.submittedAt,
      total: attempt.score,
      maxTotal: detail.maxTotal,
      autoScore: detail.autoScore ?? detail.mcScore,
      manualScore: detail.manualScore ?? detail.essayScore,
      essayTotal,
      essayGraded,
      questions: attempt.questionOrder.map((qid, idx) => {
        const q = byId[qid];
        const a = attempt.answers[qid];
        const choiceText = (cid) => q.choices?.find((c) => c.id === cid)?.text ?? null;
        return {
          no: idx + 1,
          type: q.type,
          text: q.text,
          points: q.points,
          earned: detail.perQuestion?.[qid] ?? null,
          myAnswer: q.type === 'mc' ? choiceText(a?.choiceId) : (a?.text ?? null),
          myFile: a?.file?.name ?? null,
          correctAnswer: q.type === 'mc' ? choiceText(q.answerChoiceId)
            : q.type === 'short' ? (q.acceptedAnswers ?? []).join(', ')
              : null,
          feedback: attempt.feedback?.[qid] ?? null,
        };
      }),
    };
  }

  function activeExamFor(studentId) {
    const exam = db.data.exams.find((e) => e.status === 'active');
    if (!exam) return null;
    const attempt = attemptOf(exam.id, studentId);
    if (!attempt) return null;
    return { exam, attempt };
  }

  // 서버 재시작 복구: JSONL 리플레이 후 타이머 재설정
  function restore() {
    for (const exam of db.data.exams.filter((e) => e.status === 'active')) {
      const events = db.readEvents(answersLog(exam.id));
      for (const ev of events) {
        const attempt = db.data.attempts.find((a) => a.id === ev.attemptId);
        if (!attempt || attempt.submittedAt) continue;
        const existing = attempt.answers[ev.questionId];
        if (!existing || (ev.answer?.savedAt ?? 0) >= (existing.savedAt ?? 0)) {
          attempt.answers[ev.questionId] = ev.answer;
        }
      }
      if (Date.now() > exam.endsAt + EXAM_GRACE_MS) {
        endExam(exam, 'auto');
        console.log(`[exam] 재시작 복구: "${exam.title}" 시간 초과로 자동 종료 처리`);
      } else {
        scheduleEnd(exam);
        console.log(`[exam] 재시작 복구: "${exam.title}" 진행 재개 (종료 ${new Date(exam.endsAt).toLocaleTimeString()})`);
      }
    }
    db.scheduleFlush();
  }

  function stopAllTimers() {
    for (const t of endTimers.values()) clearTimeout(t);
    endTimers.clear();
  }

  return {
    findExam, attemptOf, startExam, endExam, saveAnswer, saveAnswerFile, submit, regrade,
    buildStudentPayload, activeExamFor, countAnswered, hasAnswer, restore, stopAllTimers,
    setResultsPublished, buildResultPayload,
  };
}
