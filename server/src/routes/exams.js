import { Router } from 'express';
import multer from 'multer';
import { toCsv } from '../../../shared/src/csv.js';
import { newId } from '../../../shared/src/id.js';
import { parseExamExcel, buildTemplateExcel } from '../services/excelImport.js';

// 대시보드 입력을 내부 모델로 정규화. 문항/선택지에 안정적 id 부여.
function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('문항이 최소 1개 필요합니다.');
  }
  return questions.map((q, qi) => {
    const type = q.type === 'essay' ? 'essay' : q.type === 'short' ? 'short' : 'mc';
    const text = String(q.text ?? '').trim();
    if (!text) throw new Error(`${qi + 1}번 문항의 내용이 비어 있습니다.`);
    const points = Number(q.points);
    if (!Number.isFinite(points) || points < 0) throw new Error(`${qi + 1}번 문항의 배점이 잘못되었습니다.`);
    const base = { id: q.id ?? newId('q'), type, text, points };
    if (type === 'essay') return base;

    if (type === 'short') {
      const raw = Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : String(q.acceptedAnswers ?? '').split(';');
      const acceptedAnswers = raw.map((s) => String(s).trim()).filter(Boolean);
      if (!acceptedAnswers.length) throw new Error(`${qi + 1}번 문항(단답형)의 인정 답안이 필요합니다.`);
      return { ...base, acceptedAnswers };
    }

    const choiceTexts = (q.choices ?? []).map((c) => String(typeof c === 'object' ? c.text : c).trim());
    if (choiceTexts.filter(Boolean).length < 2) throw new Error(`${qi + 1}번 문항의 선택지가 2개 이상 필요합니다.`);
    const choices = choiceTexts.map((t, ci) => ({ id: `c${ci + 1}`, text: t }));
    const answerIndex = Number(q.answerIndex);
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= choices.length) {
      throw new Error(`${qi + 1}번 문항의 정답이 지정되지 않았습니다.`);
    }
    return { ...base, choices, answerChoiceId: choices[answerIndex].id };
  });
}

export function examRouters({ db, presence, examService }) {
  // ── 교사용 ─────────────────────────────
  const teacher = Router();

  teacher.get('/', (req, res) => {
    res.json(db.data.exams.map((e) => ({
      id: e.id, title: e.title, status: e.status,
      questionCount: e.questions.length,
      totalPoints: e.questions.reduce((s, q) => s + q.points, 0),
      shuffleQuestions: e.shuffleQuestions, shuffleChoices: e.shuffleChoices,
      durationMin: e.durationMin ?? null,
      durationSec: e.durationSec ?? null, startedAt: e.startedAt ?? null,
      endsAt: e.endsAt ?? null, createdAt: e.createdAt,
      resultsPublished: e.resultsPublished === true,
      lockdown: e.lockdown === true,
    })));
  });

  // 엑셀 문제 양식 다운로드 (주의: '/:id'보다 먼저 등록해야 함)
  teacher.get('/template.xlsx', (req, res) => {
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('문제양식.xlsx'));
    res.send(buildTemplateExcel());
  });

  // 엑셀 문제 파일 업로드 → 파싱된 문항 반환 (편집기에서 검토 후 저장)
  const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  teacher.post('/import-excel', excelUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '엑셀 파일이 필요합니다.' });
    try {
      const { questions, errors } = parseExamExcel(req.file.buffer);
      res.json({ questions, errors });
    } catch (err) {
      res.status(400).json({ error: `엑셀 파싱 실패: ${err.message}` });
    }
  });

  teacher.get('/:id', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    res.json(e);
  });

  teacher.post('/', (req, res) => {
    try {
      const { title, shuffleQuestions, shuffleChoices, questions, durationMin } = req.body ?? {};
      if (!title?.trim()) return res.status(400).json({ error: '시험 제목이 필요합니다.' });
      const exam = {
        id: newId('ex'),
        title: title.trim(),
        status: 'draft',
        shuffleQuestions: shuffleQuestions !== false,
        shuffleChoices: shuffleChoices !== false,
        durationMin: Number(durationMin) || 30,
        questions: normalizeQuestions(questions),
        createdAt: Date.now(),
      };
      db.data.exams.push(exam);
      db.scheduleFlush();
      res.json(exam);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  teacher.put('/:id', (req, res) => {
    try {
      const e = examService.findExam(req.params.id);
      if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
      if (e.status !== 'draft') return res.status(400).json({ error: '시작 전(초안) 시험만 수정할 수 있습니다.' });
      const { title, shuffleQuestions, shuffleChoices, questions, durationMin } = req.body ?? {};
      if (title?.trim()) e.title = title.trim();
      if (shuffleQuestions !== undefined) e.shuffleQuestions = !!shuffleQuestions;
      if (shuffleChoices !== undefined) e.shuffleChoices = !!shuffleChoices;
      if (durationMin !== undefined) e.durationMin = Number(durationMin) || e.durationMin;
      if (questions) e.questions = normalizeQuestions(questions);
      db.scheduleFlush();
      res.json(e);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 초안·종료 시험 삭제 (응시 기록도 함께 삭제 — 진행 중 시험은 불가)
  teacher.delete('/:id', (req, res) => {
    const idx = db.data.exams.findIndex((e) => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    if (db.data.exams[idx].status === 'active') return res.status(400).json({ error: '진행 중인 시험은 삭제할 수 없습니다.' });
    const examId = db.data.exams[idx].id;
    db.data.exams.splice(idx, 1);
    db.data.attempts = db.data.attempts.filter((a) => a.examId !== examId);
    db.scheduleFlush();
    res.json({ ok: true });
  });

  // 시험 복제 → 새 초안 생성 (재시험용 — 기존 시험과 결과는 그대로 보존)
  teacher.post('/:id/duplicate', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    const copy = {
      id: newId('ex'),
      title: `${e.title} (재시험)`,
      status: 'draft',
      shuffleQuestions: e.shuffleQuestions,
      shuffleChoices: e.shuffleChoices,
      durationMin: e.durationMin,
      questions: structuredClone(e.questions),
      createdAt: Date.now(),
    };
    db.data.exams.push(copy);
    db.scheduleFlush();
    res.json(copy);
  });

  // 성적 공개/비공개 전환 — 공개하면 학생이 자기 점수·정답을 볼 수 있다
  teacher.post('/:id/publish-results', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    if (e.status !== 'ended') return res.status(400).json({ error: '종료된 시험만 성적을 공개할 수 있습니다.' });
    examService.setResultsPublished(e, req.body?.published !== false);
    res.json({ ok: true, resultsPublished: e.resultsPublished });
  });

  teacher.post('/:id/start', (req, res) => {
    try {
      const e = examService.findExam(req.params.id);
      if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
      if (e.status === 'ended') return res.status(400).json({ error: '이미 종료된 시험입니다.' });
      const durationMin = Number(req.body?.durationMin) || e.durationMin || 30;
      examService.startExam(e, Math.round(durationMin * 60), { lockdown: req.body?.lockdown === true });
      presence.resetFocusStats();
      db.scheduleFlush();
      res.json({ ok: true, endsAt: e.endsAt });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  teacher.post('/:id/stop', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    examService.endExam(e, 'teacher');
    res.json({ ok: true });
  });

  teacher.get('/:id/monitor', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    const rows = db.data.students
      .filter((s) => s.active)
      .sort((a, b) => a.number - b.number)
      .map((s) => {
        const att = examService.attemptOf(e.id, s.id);
        return {
          studentId: s.id,
          attemptId: att?.id ?? null,
          number: s.number,
          name: s.name,
          presence: presence.snapshot(s.id),
          answeredCount: att ? examService.countAnswered(e, att) : 0,
          questionCount: e.questions.length,
          submitted: !!att?.submittedAt,
          submitType: att?.submitType ?? null,
          submittedAt: att?.submittedAt ?? null,
          score: att?.score ?? null,
          scoreDetail: att?.scoreDetail ?? null,
        };
      });
    res.json({
      exam: {
        id: e.id, title: e.title, status: e.status, endsAt: e.endsAt ?? null,
        durationSec: e.durationSec ?? null, resultsPublished: e.resultsPublished === true,
      },
      serverNow: Date.now(),
      rows,
    });
  });

  // 서술형 답안 열람 + 수동 채점용
  teacher.get('/:id/attempts/:attemptId', (req, res) => {
    const e = examService.findExam(req.params.id);
    const att = db.data.attempts.find((a) => a.id === req.params.attemptId && a.examId === req.params.id);
    if (!e || !att) return res.status(404).json({ error: '응시 기록을 찾을 수 없습니다.' });
    const stu = db.data.students.find((s) => s.id === att.studentId);
    res.json({ exam: e, attempt: att, student: stu ? { number: stu.number, name: stu.name } : null });
  });

  teacher.post('/:id/attempts/:attemptId/grade', (req, res) => {
    const e = examService.findExam(req.params.id);
    const att = db.data.attempts.find((a) => a.id === req.params.attemptId && a.examId === req.params.id);
    if (!e || !att) return res.status(404).json({ error: '응시 기록을 찾을 수 없습니다.' });
    const grades = req.body?.manualGrades ?? {};
    for (const [qid, val] of Object.entries(grades)) {
      // 서술형 채점 + 단답형 수동 정정 (객관식은 자동 채점만)
      const q = e.questions.find((x) => x.id === qid && x.type !== 'mc');
      if (!q) continue;
      if (val === '' || val === null || val === undefined) {
        delete att.manualGrades[qid];
        continue;
      }
      const n = Number(val);
      if (Number.isFinite(n)) att.manualGrades[qid] = n;
    }
    const detail = examService.regrade(e, att);
    db.scheduleFlush();
    res.json({ ok: true, score: att.score, scoreDetail: detail });
  });

  teacher.get('/:id/results.csv', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    const qTypeKo = { mc: '객관식', short: '단답형', essay: '서술형' };
    const header = [
      '출석번호', '이름', '응시', '제출시각', '제출유형', '이탈횟수', '이탈시간(초)',
      '자동채점점수', '수동채점점수', '총점', '만점',
      ...e.questions.map((q, i) => `Q${i + 1} ${qTypeKo[q.type]}(${q.points}점)`),
    ];
    const typeLabel = { manual: '직접제출', auto: '시간종료', teacher: '교사종료' };
    const rows = [header];
    for (const s of db.data.students.filter((x) => x.active).sort((a, b) => a.number - b.number)) {
      const att = examService.attemptOf(e.id, s.id);
      const p = presence.snapshot(s.id);
      const d = att?.scoreDetail;
      rows.push([
        s.number, s.name,
        att?.submittedAt ? '제출' : (att ? '미제출' : '미응시'),
        att?.submittedAt ? new Date(att.submittedAt).toLocaleString('ko-KR') : '',
        typeLabel[att?.submitType] ?? '',
        p.awayCount, Math.round(p.awayMs / 1000),
        d?.mcScore ?? '', d?.essayScore ?? '', d?.total ?? '', d?.maxTotal ?? '',
        ...e.questions.map((q) => d?.perQuestion?.[q.id] ?? ''),
      ]);
    }
    // 문항별 정답률(평균 득점률 %) 요약 행
    const submittedAttempts = db.data.attempts.filter((a) => a.examId === e.id && a.submittedAt);
    if (submittedAttempts.length) {
      const rates = e.questions.map((q) => {
        if (!q.points) return '';
        const sum = submittedAttempts.reduce((s, a) => s + (a.scoreDetail?.perQuestion?.[q.id] ?? 0), 0);
        return Math.round((sum / (submittedAttempts.length * q.points)) * 100);
      });
      rows.push(['', '', '', '', '', '', '', '', '', '', '문항별 정답률(%)', ...rates]);
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(`결과_${e.title}.csv`));
    res.send(toCsv(rows));
  });

  // ── 학생용 ─────────────────────────────
  const student = Router();

  student.get('/active', (req, res) => {
    const active = examService.activeExamFor(req.student.id);
    if (!active) return res.json({ exam: null });
    res.json(examService.buildStudentPayload(active.exam, active.attempt));
  });

  // 성적이 공개된 시험 목록 (내 점수 요약)
  student.get('/results', (req, res) => {
    const list = db.data.exams
      .filter((e) => e.status === 'ended' && e.resultsPublished === true)
      .map((e) => {
        const att = examService.attemptOf(e.id, req.student.id);
        if (!att) return null;
        return {
          examId: e.id,
          title: e.title,
          submittedAt: att.submittedAt,
          total: att.score,
          maxTotal: att.scoreDetail?.maxTotal ?? null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
    res.json(list);
  });

  // 공개된 시험의 내 상세 결과 (문항별 정오·정답)
  student.get('/:id/result', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e || e.status !== 'ended' || e.resultsPublished !== true) {
      return res.status(404).json({ error: '성적이 공개되지 않은 시험입니다.' });
    }
    const att = examService.attemptOf(e.id, req.student.id);
    if (!att) return res.status(404).json({ error: '응시 기록이 없습니다.' });
    res.json(examService.buildResultPayload(e, att));
  });

  // 소켓이 끊겼을 때의 HTTP 폴백
  student.post('/:id/answer', (req, res) => {
    try {
      const e = examService.findExam(req.params.id);
      const { questionId, answer } = req.body ?? {};
      const { savedAt } = examService.saveAnswer(e, req.student, questionId, answer);
      res.json({ ok: true, savedAt });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  student.post('/:id/submit', (req, res) => {
    try {
      const e = examService.findExam(req.params.id);
      const att = examService.submit(e, req.student, 'manual');
      res.json({ ok: true, submittedAt: att.submittedAt });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return { teacher, student };
}
