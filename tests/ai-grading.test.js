import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildUserMessage, parseGradeResponse, requestGrade, createAiGrader, OPENROUTER_URL,
  pickTeacherExamples, estimateCost,
} from '../server/src/services/aiGradingService.js';

const Q = {
  id: 'q1', type: 'essay', points: 10, text: '광합성 과정을 설명하시오.',
  modelAnswer: '빛에너지로 물과 이산화탄소에서 포도당과 산소를 만든다.',
  rubric: '재료 언급 (5점)\n생성물 언급 (5점)',
};

// ── 프롬프트 ─────────────────────────────
test('프롬프트에 문항·채점기준·모범답안·답안만 들어가고 개인정보는 없다', () => {
  const msg = buildUserMessage(Q, { text: '빛과 물로 포도당을 만든다.' });
  assert.ok(msg.includes('광합성'));
  assert.ok(msg.includes('재료 언급 (5점)'));
  assert.ok(msg.includes('포도당과 산소'));
  assert.ok(msg.includes('<<<답안 시작>>>'));
  assert.ok(!msg.includes('김민준'));
  assert.ok(!msg.includes('출석번호'));
});

test('채점기준이 없으면 안내 문구로 대체된다', () => {
  const msg = buildUserMessage({ ...Q, rubric: '', modelAnswer: '' }, { text: 'x' });
  assert.ok(msg.includes('채점기준 없음'));
  assert.ok(msg.includes('모범답안 없음'));
});

test('교사 채점 예시(few-shot)가 있으면 프롬프트에 점수와 함께 들어간다', () => {
  const msg = buildUserMessage(Q, { text: '답' }, [{ text: '예시 답안 A', score: 7, feedback: '좋아요' }, { text: '예시 답안 B', score: 2, feedback: '' }]);
  assert.ok(msg.includes('[교사 채점 예시]'));
  assert.ok(msg.includes('교사 점수 7/10점'));
  assert.ok(msg.includes('교사 피드백: 좋아요'));
  assert.ok(msg.includes('예시 답안 B'));
  assert.ok(!buildUserMessage(Q, { text: '답' }).includes('[교사 채점 예시]'));
});

test('pickTeacherExamples: 같은 문항·텍스트 답안·교사 점수 있는 것만, 본인 제외, 최고·최저·중간 3개', () => {
  const exam = { id: 'ex', questions: [Q] };
  const mk = (id, score, text = '답', extra = {}) => ({ id, examId: 'ex', submittedAt: 1, answers: { q1: { text, ...extra } }, manualGrades: score == null ? {} : { q1: score }, feedback: {} });
  const db = { data: { attempts: [
    mk('a1', 10), mk('a2', 2), mk('a3', 5), mk('a4', 8), mk('a5', null),
    mk('a6', 9, '', { file: { name: 'x.pdf' } }), mk('a7', 1, ''), { ...mk('a8', 3), examId: 'other' },
  ] } };
  const ex = pickTeacherExamples(db, exam, Q, { id: 'a1' });
  assert.equal(ex.length, 3);
  assert.deepEqual(ex.map((e) => e.score).sort((a, b) => a - b), [2, 5, 8]);
  assert.equal(pickTeacherExamples(db, exam, Q, { id: 'a3' }).length, 3);
  assert.equal(pickTeacherExamples({ data: { attempts: [] } }, exam, Q, { id: 'x' }).length, 0);
});

test('estimateCost: 토큰 × $/1M', () => {
  assert.equal(estimateCost(1000, 500, { prompt: 1, completion: 5 }), 0.0035);
  assert.equal(estimateCost(1000, 500, null), null);
});

test('빈 답안은 명시적으로 표시된다', () => {
  const msg = buildUserMessage(Q, { text: '   ' });
  assert.ok(msg.includes('(작성한 내용 없음)'));
});

// ── 응답 파싱 ─────────────────────────────
test('정상 JSON 응답 파싱 + 배점 초과 점수는 배점으로 클램프', () => {
  const r = parseGradeResponse(JSON.stringify({
    score: 14, criteria: [{ name: '재료', score: 5, max: 5, reason: '좋음' }],
    feedback: '잘했어요', summary: '', confidence: 0.9,
  }), Q);
  assert.equal(r.score, 10);
  assert.equal(r.maxScore, 10);
  assert.equal(r.criteria[0].name, '재료');
  assert.equal(r.confidence, 0.9);
});

test('코드펜스로 감싼 JSON도 파싱된다', () => {
  const r = parseGradeResponse('```json\n{"score": 7, "criteria": [], "feedback": "f", "summary": "", "confidence": 0.5}\n```', Q);
  assert.equal(r.score, 7);
});

test('앞뒤에 잡담이 붙은 JSON도 파싱된다', () => {
  const r = parseGradeResponse('채점 결과입니다: {"score": 3, "criteria": [], "feedback": "", "summary": "", "confidence": 0.4} 끝', Q);
  assert.equal(r.score, 3);
});

test('점수가 숫자가 아니면 예외', () => {
  assert.throws(() => parseGradeResponse('{"score": "많이", "criteria": []}', Q), /숫자/);
});

test('JSON이 아니면 예외', () => {
  assert.throws(() => parseGradeResponse('그냥 텍스트', Q), /JSON/);
});

// ── OpenRouter 호출 (가짜 fetch) ─────────────────────────────
const okResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});
const completion = (obj, extra = {}) => ({
  model: 'test/model',
  choices: [{ message: { content: JSON.stringify(obj) } }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
  ...extra,
});

test('requestGrade: 헤더·본문 구성 및 결과 매핑', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts, body: JSON.parse(opts.body) };
    return okResponse(completion({ score: 8, criteria: [], feedback: '좋아요', summary: '', confidence: 0.8 }));
  };
  const r = await requestGrade({ apiKey: 'sk-test', model: 'test/model', question: Q, answer: { text: '답' }, fetchImpl });
  assert.equal(captured.url, OPENROUTER_URL);
  assert.equal(captured.opts.headers.Authorization, 'Bearer sk-test');
  assert.equal(captured.body.model, 'test/model');
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.equal(captured.body.messages[0].role, 'system');
  assert.equal(r.score, 8);
  assert.equal(r.promptTokens, 100);
  assert.equal(r.completionTokens, 50);
  assert.equal(r.model, 'test/model');
});

test('requestGrade: 429는 재시도 후 성공', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return okResponse({ error: 'rate' }, 429);
    return okResponse(completion({ score: 5, criteria: [], feedback: '', summary: '', confidence: 0.7 }));
  };
  const r = await requestGrade({ apiKey: 'k', model: 'm', question: Q, answer: { text: '답' }, fetchImpl });
  assert.equal(calls, 2);
  assert.equal(r.score, 5);
});

test('requestGrade: 구조화 출력 미지원(400) 모델은 스키마 없이 재시도', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (body.response_format) return { ok: false, status: 400, text: async () => 'response_format is not supported' };
    return okResponse(completion({ score: 6, criteria: [], feedback: '', summary: '', confidence: 0.6 }));
  };
  const r = await requestGrade({ apiKey: 'k', model: 'm', question: Q, answer: { text: '답' }, fetchImpl });
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].response_format);
  assert.ok(!bodies[1].response_format);
  assert.equal(r.score, 6);
});

test('requestGrade: 401 등 복구 불가 오류는 즉시 예외', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(
    requestGrade({ apiKey: 'bad', model: 'm', question: Q, answer: { text: '답' }, fetchImpl }),
    /401/,
  );
});

test('requestGrade: PDF 첨부는 file 타입 + file-parser 플러그인으로 보낸다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-test-'));
  const pdfPath = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake'));
  let body = null;
  const fetchImpl = async (url, opts) => {
    body = JSON.parse(opts.body);
    return okResponse(completion({ score: 9, criteria: [], feedback: '', summary: '보고서 요약', confidence: 0.9 }));
  };
  const r = await requestGrade({
    apiKey: 'k', model: 'm', question: Q, answer: { text: '', file: { name: 'a.pdf' } },
    filePath: pdfPath, pdfEngine: 'pdf-text', fetchImpl,
  });
  const parts = body.messages[1].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'file');
  assert.equal(parts[1].file.filename, 'a.pdf');
  assert.ok(parts[1].file.file_data.startsWith('data:application/pdf;base64,'));
  assert.equal(body.plugins[0].id, 'file-parser');
  assert.equal(body.plugins[0].pdf.engine, 'pdf-text');
  assert.equal(r.summary, '보고서 요약');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('requestGrade: 이미지 첨부는 image_url(data URL)로 보낸다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-test-'));
  const imgPath = path.join(dir, 'a.png');
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let body = null;
  const fetchImpl = async (url, opts) => {
    body = JSON.parse(opts.body);
    return okResponse(completion({ score: 1, criteria: [], feedback: '', summary: '', confidence: 0.3 }));
  };
  await requestGrade({
    apiKey: 'k', model: 'm', question: Q, answer: { text: 'x', file: { name: 'a.png' } }, filePath: imgPath, fetchImpl,
  });
  const parts = body.messages[1].content;
  assert.equal(parts[1].type, 'image_url');
  assert.ok(parts[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.ok(!body.plugins);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 서비스: 초안 저장 / 반영 규칙 ─────────────────────────────
function fakeEnv({ fetchImpl, apiKey = 'k' }) {
  const exam = {
    id: 'ex1', status: 'ended', title: 'T',
    questions: [
      { id: 'm1', type: 'mc', points: 5, choices: [{ id: 'c1' }, { id: 'c2' }], answerChoiceId: 'c1' },
      { ...Q },
      { id: 'q2', type: 'essay', points: 10, text: 'B', rubric: '', modelAnswer: '' },
    ],
  };
  const attempts = [
    { id: 'a1', examId: 'ex1', studentId: 's1', submittedAt: 1, answers: { m1: { choiceId: 'c1' }, q1: { text: '답1' }, q2: { text: '' } }, manualGrades: {}, aiGrades: {}, feedback: {} },
    { id: 'a2', examId: 'ex1', studentId: 's2', submittedAt: 1, answers: { q1: { text: '답2' }, q2: { text: '답2b' } }, manualGrades: { q1: 3 }, aiGrades: {}, feedback: {} },
    { id: 'a3', examId: 'ex1', studentId: 's3', submittedAt: null, answers: {}, manualGrades: {}, aiGrades: {}, feedback: {} },
  ];
  const db = {
    dataDir: os.tmpdir(),
    data: { settings: { ai: { apiKey, model: 'm' } }, exams: [exam], attempts },
    scheduleFlush() {}, async flushNow() {},
  };
  const emitted = [];
  const io = { of: () => ({ emit: (ev, p) => emitted.push({ ev, p }), to: () => ({ emit: (ev, p) => emitted.push({ ev, p }) }) }) };
  const examService = {
    regrade(e, att) {
      let total = 0;
      for (const q of e.questions) {
        if (q.type === 'mc') total += att.answers[q.id]?.choiceId === q.answerChoiceId ? q.points : 0;
        else if (att.manualGrades[q.id] != null) total += Number(att.manualGrades[q.id]);
      }
      att.score = total;
      return { total };
    },
  };
  const grader = createAiGrader({ db, io, examService, fetchImpl });
  return { exam, attempts, db, grader, emitted };
}

test('gradeAttempt: 서술형만 채점, 빈 답안은 API 호출 없이 0점', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return okResponse(completion({ score: 7, criteria: [], feedback: 'fb', summary: '', confidence: 0.8 })); };
  const { exam, attempts, grader } = fakeEnv({ fetchImpl });
  const r = await grader.gradeAttempt(exam, attempts[0]);
  assert.equal(calls, 1); // q1만 호출, q2는 빈 답안
  assert.equal(r.q1.status, 'done');
  assert.equal(r.q1.score, 7);
  assert.equal(r.q2.status, 'done');
  assert.equal(r.q2.score, 0);
  assert.equal(r.q2.skippedReason, 'empty');
  assert.ok(!('m1' in r));
  // 초안일 뿐 최종 점수에는 반영되지 않음
  assert.deepEqual(attempts[0].manualGrades, {});
});

test('gradeAttempt: API 오류는 error 상태로 기록되고 다른 문항은 계속', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 400, text: async () => 'bad request' };
    return okResponse(completion({ score: 4, criteria: [], feedback: '', summary: '', confidence: 0.5 }));
  };
  const { exam, attempts, grader } = fakeEnv({ fetchImpl });
  const r = await grader.gradeAttempt(exam, attempts[1]);
  assert.equal(r.q1.status, 'error');
  assert.ok(r.q1.error.includes('400'));
  assert.equal(r.q2.status, 'done');
});

test('API 키가 없으면 명시적 오류', async () => {
  const { exam, attempts, grader } = fakeEnv({ fetchImpl: async () => okResponse({}), apiKey: '' });
  await assert.rejects(grader.gradeAttempt(exam, attempts[0]), /API 키/);
  assert.throws(() => grader.startExamGrading(exam), /API 키/);
});

test('startExamGrading: 제출자만, 진행률 이벤트, 완료 후 배치 결과', async () => {
  const fetchImpl = async () => okResponse(completion({ score: 6, criteria: [], feedback: 'fb', summary: '', confidence: 0.9 }));
  const { exam, attempts, grader, emitted } = fakeEnv({ fetchImpl });
  const { progress, promise } = grader.startExamGrading(exam);
  assert.equal(progress.total, 2); // a3는 미제출
  const done = await promise;
  assert.equal(done.done, 2);
  assert.equal(done.finished, true);
  assert.equal(attempts[0].aiGrades.q1.score, 6);
  assert.ok(emitted.some((e) => e.ev === 'ai:progress' && e.p.finished));
  // 두 번째 실행은 이미 채점된 것을 건너뜀
  const again = grader.startExamGrading(exam);
  assert.equal(again.progress.total, 0);
});

test('startExamGrading: 종료되지 않은 시험·서술형 없는 시험은 거부', () => {
  const { exam, grader } = fakeEnv({ fetchImpl: async () => okResponse({}) });
  assert.throws(() => grader.startExamGrading({ ...exam, status: 'active' }), /종료된 시험/);
  assert.throws(() => grader.startExamGrading({ ...exam, questions: [exam.questions[0]] }), /서술형 문항이 없습니다/);
});

test('applyAiGrades: 교사 점수는 유지(overwrite=false), 피드백 복사, regrade 호출', async () => {
  const fetchImpl = async () => okResponse(completion({ score: 8, criteria: [], feedback: '피드백', summary: '', confidence: 0.9 }));
  const { exam, attempts, grader } = fakeEnv({ fetchImpl });
  await grader.gradeAttempt(exam, attempts[1]); // manualGrades.q1 = 3 이미 있음
  const n = grader.applyAiGrades(exam, attempts[1]);
  assert.equal(n, 1); // q2만 반영
  assert.equal(attempts[1].manualGrades.q1, 3);
  assert.equal(attempts[1].manualGrades.q2, 8);
  assert.equal(attempts[1].feedback.q2, '피드백');
  assert.equal(attempts[1].score, 11);
  const n2 = grader.applyAiGrades(exam, attempts[1], { overwrite: true });
  assert.equal(n2, 2);
  assert.equal(attempts[1].manualGrades.q1, 8);
});

test('gradeAttempt: 교사 채점 예시가 프롬프트에 붙고 비용이 계산된다', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return okResponse(completion({ score: 6, criteria: [], feedback: '', summary: '', confidence: 0.8 })); };
  const env = fakeEnv({ fetchImpl });
  env.attempts[1].manualGrades = { q1: 3 }; // a2는 교사가 q1을 직접 채점함 → a1 채점 시 예시로 쓰임
  const priced = createAiGrader({ db: env.db, io: { of: () => ({ emit() {}, to: () => ({ emit() {} }) }) }, examService: { regrade() { return {}; } }, fetchImpl, priceLookup: async () => ({ prompt: 1, completion: 5 }) });
  const r = await priced.gradeAttempt(env.exam, env.attempts[0], { questionIds: ['q1'] });
  assert.equal(r.q1.exampleCount, 1);
  assert.ok(bodies[0].messages[1].content[0].text.includes('교사 점수 3/10점'));
  assert.equal(r.q1.costUsd, estimateCost(100, 50, { prompt: 1, completion: 5 }));
  const u = priced.usageOf(env.exam);
  assert.equal(u.calls, 1);
  assert.equal(u.promptTokens, 100);
  assert.ok(u.costKnown && u.costUsd > 0);
});

test('checkConsistency: 표본을 재채점해 편차를 보고한다 (저장하지 않음)', async () => {
  let call = 0;
  const fetchImpl = async () => { call += 1; return okResponse(completion({ score: call <= 2 ? 6 : 1, criteria: [], feedback: '', summary: '', confidence: 0.8 })); };
  const { exam, attempts, grader } = fakeEnv({ fetchImpl });
  // a1.q1, a2.q1, a2.q2 는 텍스트 답안 → 첫 배치(3회 중 텍스트 2회 + a1.q2는 빈 답안 스킵) …
  await grader.gradeAttempt(exam, attempts[0]); // q1 → 6, q2 빈 답안
  await grader.gradeAttempt(exam, attempts[1]); // q1 → 6, q2 → 1
  const before = JSON.stringify(attempts.map((a) => a.aiGrades));
  const r = await grader.checkConsistency(exam, { sample: 3 });
  assert.equal(r.sampled, 3);
  assert.ok(['ok', 'warn'].includes(r.verdict));
  assert.ok(r.items.every((it) => typeof it.original === 'number' && (it.error || typeof it.regraded === 'number')));
  assert.equal(JSON.stringify(attempts.map((a) => a.aiGrades)), before, '원래 채점은 바뀌지 않아야 함');
  await assert.rejects(grader.checkConsistency({ ...exam, id: 'nothing' }), /먼저 AI 채점/);
});

test('applyAllAiGrades + summarize', async () => {
  const fetchImpl = async () => okResponse(completion({ score: 5, criteria: [], feedback: 'f', summary: '', confidence: 0.4 }));
  const { exam, attempts, grader } = fakeEnv({ fetchImpl });
  await grader.startExamGrading(exam).promise;
  const s0 = grader.summarize(exam, attempts[0]);
  assert.deepEqual(s0, { essayCount: 2, done: 2, error: 0, applied: 0, lowConf: 1 }); // q2는 빈 답안(confidence 1)
  const r = grader.applyAllAiGrades(exam);
  assert.equal(r.attemptsTouched, 2);
  assert.equal(r.gradesApplied, 3); // a1: q1,q2 / a2: q2 (q1은 교사 점수 유지)
  assert.equal(grader.summarize(exam, attempts[0]).applied, 2);
  assert.equal(grader.summarize(exam, attempts[2]).applied, 0);
});
