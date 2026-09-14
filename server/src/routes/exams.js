import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { toCsv } from '../../../shared/src/csv.js';
import { newId } from '../../../shared/src/id.js';
import { parseExamExcel, buildTemplateExcel, buildResultsExcel } from '../services/excelImport.js';
import { ANSWER_FILE_TYPES, ANSWER_FILE_MAX_BYTES, ANSWER_FILE_EXT_LABEL } from '../services/aiGradingService.js';
import { subjectNameOf, validSubjectId, studentsOf } from './subjects.js';

const FORBIDDEN_CHARS = /[\\/:*?"<>|]/g;
const sanitizeName = (name) => String(name).split('').filter((ch) => ch.charCodeAt(0) >= 32).join('')
  .replace(FORBIDDEN_CHARS, '_').trim().slice(0, 150) || 'file';
// multer는 파일명을 latin1로 넘기므로 UTF-8로 복원
const fixName = (originalname) => sanitizeName(Buffer.from(originalname, 'latin1').toString('utf8'));

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

    if (type === 'essay') {
      // 채점 근거: 모범답안·채점기준 (AI 채점에 사용). 비워도 저장은 되지만 AI 채점 정확도가 떨어진다.
      return {
        ...base,
        modelAnswer: String(q.modelAnswer ?? '').trim(),
        rubric: String(q.rubric ?? '').trim(),
        allowFile: q.allowFile === true || q.allowFile === 'true',
      };
    }

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

const hasGrade = (v) => v !== undefined && v !== null && v !== '';

export function examRouters({ db, io, presence, examService, aiGrader }) {
  const answerFileDir = (examId, attemptId) => path.join(db.dataDir, 'files', 'exam-answers', examId, attemptId);
  const findAttempt = (examId, attemptId) =>
    db.data.attempts.find((a) => a.id === attemptId && a.examId === examId);

  // 결과 행 구성 (CSV/XLSX 공용)
  const buildResultRows = (e) => {
    const typeLabel = { manual: '직접제출', auto: '시간종료', teacher: '교사종료' };
    return studentsOf(db, e.subjectId).map((s) => {
      const att = examService.attemptOf(e.id, s.id);
      const p = presence.snapshot(s.id);
      const d = att?.scoreDetail;
      const essayDetail = {};
      for (const q of e.questions.filter((x) => x.type === 'essay')) {
        if (!att) continue;
        const a = att.answers?.[q.id];
        const ai = att.aiGrades?.[q.id];
        essayDetail[q.id] = {
          answerText: a?.text ?? '',
          fileName: a?.file?.name ?? '',
          aiScore: ai?.status === 'done' ? ai.score : (ai?.status === 'error' ? `오류: ${ai.error}` : ''),
          aiConfidence: ai?.status === 'done' && ai.confidence != null ? Math.round(ai.confidence * 100) / 100 : '',
          aiCriteria: ai?.status === 'done' ? (ai.criteria ?? []).map((c) => `${c.name}: ${c.score}/${c.max} — ${c.reason}`).join('\n') : '',
          aiSummary: ai?.summary ?? '',
          finalScore: d?.perQuestion?.[q.id] ?? '',
          feedback: att.feedback?.[q.id] ?? '',
        };
      }
      return {
        number: s.number, name: s.name,
        status: att?.submittedAt ? '제출' : (att ? '미제출' : '미응시'),
        submittedAt: att?.submittedAt ? new Date(att.submittedAt).toLocaleString('ko-KR') : '',
        submitType: typeLabel[att?.submitType] ?? '',
        awayCount: p.awayCount, awaySec: Math.round(p.awayMs / 1000),
        autoScore: d?.autoScore ?? d?.mcScore ?? '', manualScore: d?.manualScore ?? d?.essayScore ?? '',
        total: d?.total ?? '', maxTotal: d?.maxTotal ?? '',
        perQuestion: d?.perQuestion ?? {},
        essayDetail,
      };
    });
  };
  const questionStatsOf = (e) => {
    const submitted = db.data.attempts.filter((a) => a.examId === e.id && a.submittedAt);
    if (!submitted.length) return null;
    return e.questions.map((q) => {
      if (!q.points) return '';
      const sum = submitted.reduce((s, a) => s + (a.scoreDetail?.perQuestion?.[q.id] ?? 0), 0);
      return Math.round((sum / (submitted.length * q.points)) * 100);
    });
  };
  const attachmentName = (e, ext) => "attachment; filename*=UTF-8''" + encodeURIComponent(`결과_${e.title}.${ext}`);

  // ── 교사용 ─────────────────────────────
  const teacher = Router();

  teacher.get('/', (req, res) => {
    res.json(db.data.exams.map((e) => ({
      id: e.id, title: e.title, status: e.status,
      subjectId: e.subjectId ?? null, subjectName: subjectNameOf(db, e.subjectId),
      questionCount: e.questions.length,
      essayCount: e.questions.filter((q) => q.type === 'essay').length,
      totalPoints: e.questions.reduce((s, q) => s + q.points, 0),
      shuffleQuestions: e.shuffleQuestions, shuffleChoices: e.shuffleChoices,
      durationMin: e.durationMin ?? null,
      durationSec: e.durationSec ?? null, startedAt: e.startedAt ?? null,
      endsAt: e.endsAt ?? null, createdAt: e.createdAt,
      resultsPublished: e.resultsPublished === true,
      instantResults: e.instantResults === true,
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
      const { title, shuffleQuestions, shuffleChoices, questions, durationMin, instantResults, subjectId } = req.body ?? {};
      if (!title?.trim()) return res.status(400).json({ error: '시험 제목이 필요합니다.' });
      const exam = {
        id: newId('ex'),
        title: title.trim(),
        status: 'draft',
        subjectId: validSubjectId(db, subjectId),
        shuffleQuestions: shuffleQuestions !== false,
        shuffleChoices: shuffleChoices !== false,
        instantResults: instantResults === true,
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
      const { title, shuffleQuestions, shuffleChoices, questions, durationMin, instantResults, subjectId } = req.body ?? {};
      if (title?.trim()) e.title = title.trim();
      if (subjectId !== undefined) e.subjectId = validSubjectId(db, subjectId);
      if (shuffleQuestions !== undefined) e.shuffleQuestions = !!shuffleQuestions;
      if (shuffleChoices !== undefined) e.shuffleChoices = !!shuffleChoices;
      if (instantResults !== undefined) e.instantResults = instantResults === true;
      if (durationMin !== undefined) e.durationMin = Number(durationMin) || e.durationMin;
      if (questions) e.questions = normalizeQuestions(questions);
      db.scheduleFlush();
      res.json(e);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 초안·종료 시험 삭제 (응시 기록·첨부 파일도 함께 삭제 — 진행 중 시험은 불가)
  teacher.delete('/:id', (req, res) => {
    const idx = db.data.exams.findIndex((e) => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    if (db.data.exams[idx].status === 'active') return res.status(400).json({ error: '진행 중인 시험은 삭제할 수 없습니다.' });
    const examId = db.data.exams[idx].id;
    db.data.exams.splice(idx, 1);
    db.data.attempts = db.data.attempts.filter((a) => a.examId !== examId);
    fs.rmSync(path.join(db.dataDir, 'files', 'exam-answers', examId), { recursive: true, force: true });
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
      subjectId: e.subjectId,
      shuffleQuestions: e.shuffleQuestions,
      shuffleChoices: e.shuffleChoices,
      instantResults: e.instantResults === true,
      durationMin: e.durationMin,
      questions: structuredClone(e.questions),
      createdAt: Date.now(),
    };
    db.data.exams.push(copy);
    db.scheduleFlush();
    res.json(copy);
  });

  // 성적 공개/비공개 전환 — 공개하면 학생이 자기 점수·정답·피드백을 볼 수 있다
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
    const rows = studentsOf(db, e.subjectId)
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
          ai: aiGrader.summarize(e, att),
        };
      });
    res.json({
      exam: {
        id: e.id, title: e.title, status: e.status, endsAt: e.endsAt ?? null,
        durationSec: e.durationSec ?? null, resultsPublished: e.resultsPublished === true,
        instantResults: e.instantResults === true,
        subjectName: subjectNameOf(db, e.subjectId),
        essayCount: e.questions.filter((q) => q.type === 'essay').length,
        aiConfigured: aiGrader.isConfigured(),
        aiProgress: aiGrader.progressOf(e.id),
      },
      serverNow: Date.now(),
      rows,
    });
  });

  // 서술형 답안 열람 + 수동 채점용
  teacher.get('/:id/attempts/:attemptId', (req, res) => {
    const e = examService.findExam(req.params.id);
    const att = findAttempt(req.params.id, req.params.attemptId);
    if (!e || !att) return res.status(404).json({ error: '응시 기록을 찾을 수 없습니다.' });
    const stu = db.data.students.find((s) => s.id === att.studentId);
    res.json({ exam: e, attempt: att, student: stu ? { number: stu.number, name: stu.name } : null });
  });

  // 학생이 첨부한 답안 파일 열람
  teacher.get('/:id/attempts/:attemptId/files/:questionId', (req, res) => {
    const att = findAttempt(req.params.id, req.params.attemptId);
    const f = att?.answers?.[req.params.questionId]?.file;
    if (!f) return res.status(404).json({ error: '첨부 파일이 없습니다.' });
    const p = path.join(answerFileDir(att.examId, att.id), f.storedName);
    if (!fs.existsSync(p)) return res.status(404).json({ error: '파일이 디스크에 없습니다.' });
    res.download(p, f.name);
  });

  // 수동 채점 저장: manualGrades(점수) + feedback(학생에게 보이는 피드백)
  teacher.post('/:id/attempts/:attemptId/grade', (req, res) => {
    const e = examService.findExam(req.params.id);
    const att = findAttempt(req.params.id, req.params.attemptId);
    if (!e || !att) return res.status(404).json({ error: '응시 기록을 찾을 수 없습니다.' });
    att.manualGrades ??= {};
    att.feedback ??= {};
    const grades = req.body?.manualGrades ?? {};
    for (const [qid, val] of Object.entries(grades)) {
      // 서술형 채점 + 단답형 수동 정정 (객관식은 자동 채점만)
      const q = e.questions.find((x) => x.id === qid && x.type !== 'mc');
      if (!q) continue;
      if (!hasGrade(val)) {
        delete att.manualGrades[qid];
        continue;
      }
      const n = Number(val);
      if (Number.isFinite(n)) att.manualGrades[qid] = n;
    }
    const feedback = req.body?.feedback ?? {};
    for (const [qid, val] of Object.entries(feedback)) {
      if (!e.questions.some((x) => x.id === qid)) continue;
      const text = String(val ?? '').trim().slice(0, 2000);
      if (text) att.feedback[qid] = text;
      else delete att.feedback[qid];
    }
    const detail = examService.regrade(e, att);
    db.scheduleFlush();
    if (e.resultsPublished) {
      io.of('/student').to(`student:${att.studentId}`).emit('exam:results-updated', { examId: e.id, title: e.title });
    }
    res.json({ ok: true, score: att.score, scoreDetail: detail });
  });

  // ── AI 채점 ─────────────────────────────

  // 시험 전체 서술형 AI 채점 시작 (백그라운드, 진행률은 소켓 ai:progress)
  teacher.post('/:id/ai-grade', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    try {
      const { progress } = aiGrader.startExamGrading(e, { onlyUngraded: req.body?.regrade !== true });
      res.json({ ok: true, progress });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 한 학생만 (재)채점 — 완료까지 기다렸다가 결과 반환
  teacher.post('/:id/attempts/:attemptId/ai-grade', async (req, res) => {
    const e = examService.findExam(req.params.id);
    const att = findAttempt(req.params.id, req.params.attemptId);
    if (!e || !att) return res.status(404).json({ error: '응시 기록을 찾을 수 없습니다.' });
    if (!att.submittedAt) return res.status(400).json({ error: '아직 제출하지 않은 답안입니다.' });
    try {
      const questionIds = Array.isArray(req.body?.questionIds) ? req.body.questionIds : null;
      const results = await aiGrader.gradeAttempt(e, att, { questionIds });
      res.json({ ok: true, aiGrades: results });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // AI 점수를 최종 점수로 반영 (한 학생). questionIds 지정 가능, overwrite=true면 교사 점수도 덮어씀
  teacher.post('/:id/attempts/:attemptId/apply-ai', (req, res) => {
    const e = examService.findExam(req.params.id);
    const att = findAttempt(req.params.id, req.params.attemptId);
    if (!e || !att) return res.status(404).json({ error: '응시 기록을 찾을 수 없습니다.' });
    const questionIds = Array.isArray(req.body?.questionIds) ? req.body.questionIds : null;
    const applied = aiGrader.applyAiGrades(e, att, { questionIds, overwrite: req.body?.overwrite === true });
    db.scheduleFlush();
    if (applied && e.resultsPublished) {
      io.of('/student').to(`student:${att.studentId}`).emit('exam:results-updated', { examId: e.id, title: e.title });
    }
    res.json({ ok: true, applied, score: att.score, scoreDetail: att.scoreDetail });
  });

  // AI 점수 전체 반영 (교사가 직접 준 점수는 유지)
  teacher.post('/:id/apply-ai', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    const r = aiGrader.applyAllAiGrades(e, { overwrite: req.body?.overwrite === true });
    res.json({ ok: true, ...r });
  });

  // ── 결과 내보내기 ─────────────────────────────

  teacher.get('/:id/results.csv', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    const qTypeKo = { mc: '객관식', short: '단답형', essay: '서술형' };
    const header = [
      '출석번호', '이름', '응시', '제출시각', '제출유형', '이탈횟수', '이탈시간(초)',
      '자동채점점수', '서술형점수', '총점', '만점',
      ...e.questions.map((q, i) => `Q${i + 1} ${qTypeKo[q.type]}(${q.points}점)`),
    ];
    const rows = [header];
    for (const r of buildResultRows(e)) {
      rows.push([
        r.number, r.name, r.status, r.submittedAt, r.submitType, r.awayCount, r.awaySec,
        r.autoScore, r.manualScore, r.total, r.maxTotal,
        ...e.questions.map((q) => r.perQuestion[q.id] ?? ''),
      ]);
    }
    const stats = questionStatsOf(e);
    if (stats) rows.push(['', '', '', '', '', '', '', '', '', '', '문항별 정답률(%)', ...stats]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', attachmentName(e, 'csv'));
    res.send(toCsv(rows));
  });

  // 엑셀: 점수표 + 서술형 상세(답안·AI 채점·피드백) + 문항 정보
  teacher.get('/:id/results.xlsx', (req, res) => {
    const e = examService.findExam(req.params.id);
    if (!e) return res.status(404).json({ error: '시험을 찾을 수 없습니다.' });
    const buf = buildResultsExcel({ exam: e, rows: buildResultRows(e), questionStats: questionStatsOf(e) });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', attachmentName(e, 'xlsx'));
    res.send(buf);
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
        const essayQs = e.questions.filter((q) => q.type === 'essay');
        const graded = essayQs.filter((q) => att.scoreDetail?.perQuestion?.[q.id] != null).length;
        return {
          examId: e.id,
          title: e.title,
          subjectName: subjectNameOf(db, e.subjectId),
          submittedAt: att.submittedAt,
          total: att.score,
          maxTotal: att.scoreDetail?.maxTotal ?? null,
          essayTotal: essayQs.length,
          essayGraded: graded,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
    res.json(list);
  });

  // 공개된 시험의 내 상세 결과 (문항별 정오·정답·피드백)
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

  // 서술형 답안 파일 첨부 (문항이 허용한 경우만). 같은 문항에 다시 올리면 교체.
  const answerUpload = multer({
    dest: path.join(db.dataDir, 'tmp'),
    limits: { fileSize: ANSWER_FILE_MAX_BYTES, files: 1 },
  }).single('file');

  student.post('/:id/answer-file', (req, res) => {
    answerUpload(req, res, (uploadErr) => {
      if (uploadErr) {
        const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
          ? `파일이 너무 큽니다. ${Math.round(ANSWER_FILE_MAX_BYTES / 1024 / 1024)}MB 이하만 첨부할 수 있습니다.`
          : `업로드 실패: ${uploadErr.message}`;
        return res.status(400).json({ error: msg });
      }
      const cleanup = () => { if (req.file) fs.rmSync(req.file.path, { force: true }); };
      try {
        const e = examService.findExam(req.params.id);
        const questionId = String(req.body?.questionId ?? '');
        if (!req.file) throw new Error('첨부할 파일이 없습니다.');
        const name = fixName(req.file.originalname);
        const ext = path.extname(name).toLowerCase();
        if (!ANSWER_FILE_TYPES[ext]) throw new Error(`첨부할 수 없는 파일 형식입니다. (${ANSWER_FILE_EXT_LABEL} 만 가능)`);

        // 시험/문항 검증은 서비스에서. 메타 저장 전에 디스크로 옮긴다.
        const active = examService.activeExamFor(req.student.id);
        if (!active || active.exam.id !== e?.id) throw new Error('진행 중인 시험이 아닙니다.');
        const dir = answerFileDir(e.id, active.attempt.id);
        fs.mkdirSync(dir, { recursive: true });
        const fileId = newId('f');
        const storedName = `${fileId}_${name}`;
        const fileMeta = { fileId, name, size: req.file.size, storedName, uploadedAt: Date.now() };
        const { previousFile, savedAt } = examService.saveAnswerFile(e, req.student, questionId, fileMeta);
        fs.renameSync(req.file.path, path.join(dir, storedName));
        if (previousFile) fs.rmSync(path.join(dir, previousFile.storedName), { force: true });
        res.json({ ok: true, savedAt, file: { name, size: req.file.size } });
      } catch (err) {
        cleanup();
        res.status(400).json({ error: err.message });
      }
    });
  });

  student.post('/:id/answer-file/remove', (req, res) => {
    try {
      const e = examService.findExam(req.params.id);
      const questionId = String(req.body?.questionId ?? '');
      const active = examService.activeExamFor(req.student.id);
      if (!active || active.exam.id !== e?.id) throw new Error('진행 중인 시험이 아닙니다.');
      const { previousFile, savedAt } = examService.saveAnswerFile(e, req.student, questionId, null);
      if (previousFile) fs.rmSync(path.join(answerFileDir(e.id, active.attempt.id), previousFile.storedName), { force: true });
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
