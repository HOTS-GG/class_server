// E2E 스모크 테스트: 임시 데이터 폴더로 서버를 띄우고 전체 흐름을 검증한다.
// 실행: node tools/smoke.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createClassServer } from '../server/src/app.js';
import { enableUtf8Console } from '../shared/src/winConsole.js';

enableUtf8Console();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-smoke-'));
const port = 3777;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 가짜 OpenRouter: 실제 네트워크 없이 AI 채점 흐름을 검증한다.
const aiCalls = [];
const fakeOpenRouter = async (url, opts) => {
  if (url.endsWith('/api/v1/models')) {
    return { ok: true, status: 200, json: async () => ({ data: [
      { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', created: 200, context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000005' }, architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] },
      { id: 'openai/gpt-5', name: 'GPT-5', created: 300, context_length: 400000, pricing: { prompt: '0.00000125', completion: '0.00001' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'openai/text-embedding-3', name: 'Embedding', created: 100, architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
    ] }) };
  }
  if (url.endsWith('/auth/key')) {
    const ok = opts.headers.Authorization === 'Bearer sk-or-test';
    return { ok, status: ok ? 200 : 401, json: async () => ({ data: { label: '스모크 키', limit: 10, limit_remaining: 9.5 } }) };
  }
  const body = JSON.parse(opts.body);
  aiCalls.push({ headers: opts.headers, body });
  await sleep(150); // 실제 API처럼 약간의 지연 (진행 중 상태 검증용)
  const userText = body.messages[1].content[0].text;
  const hasFile = body.messages[1].content.length > 1;
  const score = /즐거운/.test(userText) ? 8 : hasFile ? 15 : 4;
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({
      model: 'anthropic/claude-haiku-4.5', // 모델 목록에 단가가 있는 모델 → 비용 추정 검증
      choices: [{ message: { content: JSON.stringify({
        score, criteria: [{ name: '근거', score, max: 10, reason: '가짜 채점' }],
        feedback: '가짜 피드백입니다.', summary: hasFile ? '첨부 요약' : '', confidence: 0.85,
      }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }),
  };
};

const server = await createClassServer({ dataDir, httpPort: port, enableDiscovery: false, aiFetch: fakeOpenRouter });
await server.start();

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}`);
  if (!cond) failures++;
};

const get = (p, token) => fetch(base + p, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
}).then((r) => r.json());
const post = (p, body, token) => fetch(base + p, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

// ── 기본/명단 ─────────────────────────────
const health = await get('/api/health');
check('서버 health', health.ok === true);
const sinfo = await get('/api/teacher/server-info');
check('서버 정보에 세이브 파일 경로', sinfo.workspace?.file?.endsWith('db.json') && sinfo.canSwitchWorkspace === false);
check('standalone에서는 세이브 전환 불가 안내', !!(await post('/api/teacher/workspace/switch')).error);

// 세이브 파일 분리 저장(우리반.classdb + 우리반.files/) 확인
{
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-ws-'));
  const dbFile = path.join(wsDir, '우리반.classdb');
  const s2 = await createClassServer({ dataDir: path.join(wsDir, '우리반.files'), dbFile, httpPort: port + 1, enableDiscovery: false });
  await s2.start();
  const r = await fetch(`http://127.0.0.1:${port + 1}/api/teacher/students`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 7, name: '세이브' }) }).then((x) => x.json());
  await s2.stop();
  const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  check('세이브 파일(.classdb)에 저장 + files 폴더 생성', r.number === 7 && saved.students?.[0]?.name === '세이브'
    && fs.existsSync(path.join(wsDir, '우리반.files', 'events')) && s2.workspace.name === '우리반');
  fs.rmSync(wsDir, { recursive: true, force: true });
}

// ── 과목/학급 ─────────────────────────────
const subj = await post('/api/teacher/subjects', { name: '2-3 과학' });
check('과목 생성', !!subj.id && subj.name === '2-3 과학');
check('과목 이름 중복 거부', !!(await post('/api/teacher/subjects', { name: '2-3 과학' })).error);
const subj2 = await post('/api/teacher/subjects', { name: '1-1 사회' });

// ── 학생 명단 (과목별) ─────────────────────────────
const imp = await post('/api/teacher/students/import', { csv: '번호,이름\n1,김민준\n2,이서연\n3,박도윤\n-4,음수번호\n0,영번호', subjectId: subj.id });
check('학생 3명 CSV 등록 (음수·0번은 건너뜀, 과목 소속)', imp.addedCount === 3 && imp.subjectName === '2-3 과학'
  && imp.skipped.some((s) => s.startsWith('-4')) && imp.skipped.some((s) => s.startsWith('0,')));
// 명단 양식(엑셀) 다운로드 → 같은 과목에 업로드 (예시 5명 중 1~3번은 이미 있어 건너뜀)
const stuTmpl = await fetch(`${base}/api/teacher/students/template.xlsx`);
check('명단 양식 엑셀 다운로드', (stuTmpl.headers.get('content-type') ?? '').includes('spreadsheetml'));
{
  const f = new FormData();
  f.append('file', new Blob([await stuTmpl.arrayBuffer()]), '학생명단양식.xlsx');
  f.append('subjectId', subj.id);
  const r = await fetch(`${base}/api/teacher/students/import-excel`, { method: 'POST', body: f }).then((x) => x.json());
  check('엑셀 명단 불러오기 (2명 추가, 3건 번호 중복 건너뜀)', r.addedCount === 2 && r.skipped.length === 3);
  for (const s of (await get(`/api/teacher/students?subjectId=${subj.id}`)).filter((x) => x.number >= 4)) {
    await fetch(`${base}/api/teacher/students/${s.id}`, { method: 'DELETE' });
  }
}
const negStu = await post('/api/teacher/students', { number: -1, name: '음수', subjectId: subj.id });
const dupStu = await post('/api/teacher/students', { number: 1, name: '중복', subjectId: subj.id });
check('출석번호 음수/같은 과목 중복 등록 거부', !!negStu.error && !!dupStu.error);
const other1 = await post('/api/teacher/students', { number: 1, name: '다른반1번', subjectId: subj2.id });
check('다른 과목에는 같은 번호 허용', other1.number === 1 && other1.subjectId === subj2.id);
const listA = await get(`/api/teacher/students?subjectId=${subj.id}`);
const listB = await get(`/api/teacher/students?subjectId=${subj2.id}`);
const listAll = await get('/api/teacher/students');
check('과목별 명단 필터 (3명 / 1명 / 전체 4명)', listA.length === 3 && listB.length === 1 && listAll.length === 4
  && listA.every((s) => s.subjectName === '2-3 과학'));
const codesB = await fetch(`${base}/api/teacher/students/codes.csv?subjectId=${subj2.id}`).then((r) => r.text());
check('접속코드표 과목별', codesB.includes('다른반1번') && !codesB.includes('김민준'));
const moved = await fetch(`${base}/api/teacher/students/${other1.id}/subject`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectId: subj.id }) }).then((r) => r.json());
check('같은 번호가 있는 과목으로 이동 거부', !!moved.error);
const subjCounts = await get('/api/teacher/subjects');
check('과목 목록에 학생 수', subjCounts.find((s) => s.id === subj.id)?.studentCount === 3);
const students = listA;

const auth1 = await post('/api/auth/student', { code: students[0].code });
const auth2 = await post('/api/auth/student', { code: students[1].code });
check('학생 로그인(코드)', !!auth1.token && !!auth2.token);
const bad = await post('/api/auth/student', { code: 'XXXXXX' });
check('잘못된 코드 거부', !!bad.error);

// ── 과제 배부/제출/회수 ─────────────────────────────
const asg = await post('/api/teacher/assignments', { title: '테스트 과제', subjectId: subj.id });
check('과제 생성 (과목 연결)', asg.status === 'draft' && asg.subjectId === subj.id);
const asgList = await get('/api/teacher/assignments');
check('과제 목록에 과목 이름', asgList[0]?.subjectName === '2-3 과학');
await post(`/api/teacher/assignments/${asg.id}/publish`);

const fd = new FormData();
fd.append('files', new Blob(['과제 제출 내용입니다']), '보고서.txt');
const sub = await fetch(`${base}/api/student/assignments/${asg.id}/submit`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${auth1.token}` },
  body: fd,
}).then((r) => r.json());
check('학생 파일 제출', sub.ok === true);

const myAsg = await get('/api/student/assignments', auth1.token);
check('학생 과제 목록에 제출 반영', myAsg[0]?.mySubmission?.files?.[0] === '보고서.txt');

const zipRes = await fetch(`${base}/api/teacher/assignments/${asg.id}/submissions.zip`);
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
check('제출물 zip 회수 (PK 시그니처)', zipBuf[0] === 0x50 && zipBuf[1] === 0x4b);
const asg2 = await post('/api/teacher/assignments', { title: '삭제될 과제' });
const delAsg = await fetch(`${base}/api/teacher/assignments/${asg2.id}`, { method: 'DELETE' }).then((r) => r.json());
check('과제 삭제', delAsg.ok === true && !(await get('/api/teacher/assignments')).some((a) => a.id === asg2.id));
check('학생 과제 목록에 과목 이름', (await get('/api/student/assignments', auth1.token))[0]?.subjectName === '2-3 과학');
{
  const authB = await post('/api/auth/student', { code: other1.code });
  const seen = await get('/api/student/assignments', authB.token);
  check('다른 과목 학생에게는 이 과제가 보이지 않음', Array.isArray(seen) && !seen.some((a) => a.id === asg.id));
}

// ── 시험 ─────────────────────────────
const exam = await post('/api/teacher/exams', {
  title: '수학 쪽지시험',
  subjectId: subj.id,
  durationMin: 1,
  questions: [
    { type: 'mc', text: '1+1=?', points: 5, choices: ['1', '2', '3', '4'], answerIndex: 1 },
    { type: 'mc', text: '2*3=?', points: 5, choices: ['5', '6', '7', '8'], answerIndex: 1 },
    { type: 'mc', text: '3-1=?', points: 5, choices: ['1', '2', '3', '4'], answerIndex: 1 },
    { type: 'mc', text: '8/2=?', points: 5, choices: ['2', '4', '6', '8'], answerIndex: 1 },
    { type: 'mc', text: '5+5=?', points: 5, choices: ['5', '10', '15', '20'], answerIndex: 1 },
    { type: 'short', text: '물의 화학식을 쓰시오.', points: 5, acceptedAnswers: ['H2O', '에이치투오'] },
    { type: 'essay', text: '수학이 즐거운 이유를 쓰시오.', points: 10, modelAnswer: '문제 해결의 성취감', rubric: '이유 제시 (5점)\n구체적 경험 (5점)' },
    { type: 'essay', text: '보고서를 첨부하고 요약하시오.', points: 20, rubric: '자료 제시 (10점)\n요약 (10점)', allowFile: true },
  ],
});
check('시험 생성 (과목 연결)', exam.status === 'draft' && exam.subjectId === subj.id);
check('시험 목록에 과목 이름', (await get('/api/teacher/exams')).find((e) => e.id === exam.id)?.subjectName === '2-3 과학');
check('서술형 채점 근거(모범답안·채점기준·파일첨부) 저장', exam.questions[6]?.rubric?.includes('(5점)')
  && exam.questions[6]?.modelAnswer === '문제 해결의 성취감' && exam.questions[7]?.allowFile === true);
await post(`/api/teacher/exams/${exam.id}/start`, { durationMin: 1 });

const v1 = await get('/api/student/exams/active', auth1.token);
const v2 = await get('/api/student/exams/active', auth2.token);
check('학생 응시 화면 수신', v1.exam?.id === exam.id);
{
  const authB = await post('/api/auth/student', { code: other1.code });
  const vB = await get('/api/student/exams/active', authB.token);
  check('다른 과목 학생은 이 시험 응시 대상 아님', vB.exam === null);
  const monA = await get(`/api/teacher/exams/${exam.id}/monitor`);
  check('감독 화면은 과목 학생 3명만', monA.rows.length === 3 && monA.exam.subjectName === '2-3 과학');
}
check('전체화면 잠금 기본 꺼짐', v1.exam?.lockdown === false);
check('학생별 문항 순서 상이', v1.questions.map((q) => q.text).join() !== v2.questions.map((q) => q.text).join());
check('정답 미노출(객관식+단답형+모범답안+채점기준)',
  !JSON.stringify(v1).includes('answerChoiceId') && !JSON.stringify(v1).includes('acceptedAnswers')
  && !JSON.stringify(v1).includes('modelAnswer') && !JSON.stringify(v1).includes('rubric'));
check('학생 화면에 파일첨부 허용 표시', v1.questions.find((q) => q.text.includes('보고서'))?.allowFile === true);
const v1b = await get('/api/student/exams/active', auth1.token);
check('재접속 시 동일 순서(결정성)', v1.questions.map((q) => q.id).join() === v1b.questions.map((q) => q.id).join());

// ── 소켓 응시: 학생1 전부 정답 + 서술형 ─────────────────────────────
const correctByText = { '1+1=?': '2', '2*3=?': '6', '3-1=?': '2', '8/2=?': '4', '5+5=?': '10' };
const sock = io(`${base}/student`, { auth: { token: auth1.token } });
await new Promise((r) => sock.on('connect', r));

for (const q of v1.questions) {
  const answer = q.type === 'mc'
    ? { choiceId: q.choices.find((c) => c.text === correctByText[q.text]).id }
    : q.type === 'short'
      ? { text: ' h 2 o ' } // 공백·소문자 → 정규화 후 정답 처리되어야 함
      : q.allowFile ? { text: '' } : { text: '문제를 풀 때마다 새로운 걸 알게 돼서요.' };
  const res = await new Promise((r) => sock.emit('exam:answer', { examId: exam.id, questionId: q.id, answer }, r));
  if (!res?.ok) check(`답안 저장 실패: ${res?.error}`, false);
}

// ── 서술형 파일 첨부 ─────────────────────────────
const fileQ = v1.questions.find((q) => q.allowFile);
const textQ = v1.questions.find((q) => q.type === 'essay' && !q.allowFile);
const uploadAnswerFile = async (qid, name, content, tok = auth1.token) => {
  const f = new FormData();
  f.append('questionId', qid);
  f.append('file', new Blob([content]), name);
  return fetch(`${base}/api/student/exams/${exam.id}/answer-file`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: f,
  }).then((r) => r.json());
};
const badExt = await uploadAnswerFile(fileQ.id, '보고서.hwp', 'x');
check('허용되지 않는 확장자(hwp) 거부', !!badExt.error);
const notAllowed = await uploadAnswerFile(textQ.id, '메모.txt', 'x');
check('첨부 비허용 문항에는 업로드 거부', !!notAllowed.error);
const up1 = await uploadAnswerFile(fileQ.id, '보고서 초안.txt', '첫 번째 보고서');
check('첨부 허용 문항에 TXT 업로드', up1.ok === true && up1.file?.name === '보고서 초안.txt');
const up2 = await uploadAnswerFile(fileQ.id, '보고서.pdf', '%PDF-1.4 fake');
check('같은 문항 재업로드 → 교체', up2.ok === true && up2.file?.name === '보고서.pdf');
const v1c = await get('/api/student/exams/active', auth1.token);
check('학생 답안에 첨부 메타(이름/크기만) 포함',
  v1c.answers[fileQ.id]?.file?.name === '보고서.pdf' && !('storedName' in (v1c.answers[fileQ.id]?.file ?? {})));
const ansDir = path.join(dataDir, 'files', 'exam-answers', exam.id);
const storedFiles = fs.readdirSync(ansDir, { recursive: true }).filter((f) => /\.(pdf|txt)$/.test(String(f)));
check('디스크에는 최신 파일 1개만 남음(이전 첨부 삭제)', storedFiles.length === 1 && String(storedFiles[0]).endsWith('보고서.pdf'));
sock.emit('focus:event', { event: 'blur' });
sock.emit('focus:event', { event: 'focus' });

const submitRes = await new Promise((r) => sock.emit('exam:submit', { examId: exam.id }, r));
check('시험 제출(소켓)', submitRes?.ok === true);
await sleep(400);

const mon = await get(`/api/teacher/exams/${exam.id}/monitor`);
const row1 = mon.rows.find((r) => r.studentId === students[0].id);
check('자동 채점 (객관식25+단답형5=30점)', row1?.score === 30);
check('감독 화면 이탈 기록', row1?.presence?.awayCount >= 1);

check('제출 전 AI 채점 요청 거부(진행 중 시험)', !!(await post(`/api/teacher/exams/${exam.id}/ai-grade`)).error);

// HTTP 폴백 저장 (학생2)
const q2first = v2.questions.find((q) => q.type === 'mc');
const fallback = await post(`/api/student/exams/${exam.id}/answer`, {
  questionId: q2first.id,
  answer: { choiceId: q2first.choices[0].id },
}, auth2.token);
check('HTTP 폴백 답안 저장', fallback.ok === true);

// 일괄 동기화: 서버보다 오래된 답은 건너뛰고, 새 답만 반영
{
  const q2second = v2.questions.filter((q) => q.type === 'mc')[1];
  const sync = await post(`/api/student/exams/${exam.id}/sync`, { answers: {
    [q2first.id]: { choiceId: q2first.choices[1].id, savedAt: fallback.savedAt - 5000 },   // 오래된 것 → 무시
    [q2second.id]: { choiceId: q2second.choices[0].id, savedAt: Date.now() },              // 새 것 → 반영
  } }, auth2.token);
  check('답안 일괄 동기화 (오래된 답 무시, 새 답 반영)', sync.ok === true && sync.applied === 1 && sync.skipped === 1
    && sync.answers[q2first.id].choiceId === q2first.choices[0].id);
  const sock2 = io(`${base}/student`, { auth: { token: auth2.token } });
  await new Promise((r) => sock2.on('connect', r));
  const sockSync = await new Promise((r) => sock2.emit('exam:sync', { examId: exam.id, answers: {} }, r));
  check('소켓 동기화 응답', sockSync?.ok === true && sockSync.applied === 0);
  const sockSyncSubmitted = await new Promise((r) => sock.emit('exam:sync', { examId: exam.id, answers: {} }, r));
  check('이미 제출한 학생의 동기화는 거부', sockSyncSubmitted?.ok === false);
  sock2.disconnect();
}

// 교사 종료 → 미제출자 자동 제출
await post(`/api/teacher/exams/${exam.id}/stop`);
await sleep(300);
const mon2 = await get(`/api/teacher/exams/${exam.id}/monitor`);
const row2 = mon2.rows.find((r) => r.studentId === students[1].id);
check('미제출자 자동 마감 처리', row2?.submitted === true && row2?.submitType === 'teacher');

// ── AI 채점 설정 ─────────────────────────────
const noKey = await post(`/api/teacher/exams/${exam.id}/ai-grade`);
check('API 키 없이 AI 채점 → 안내 오류', /API 키/.test(noKey.error ?? ''));
const aiSet0 = await get('/api/teacher/ai-settings');
check('AI 설정 조회(키 없음, 프리셋 제공)', aiSet0.configured === false && aiSet0.presets?.length > 0);
const models = await get('/api/teacher/ai-settings/models?refresh=1');
check('모델 목록 동기화 (텍스트 모델만, 최신순, 임베딩 제외)', models.ok === true && models.models.length === 2
  && models.models[0].id === 'openai/gpt-5' && models.models[1].promptPrice === 1 && models.models[1].supportsFile === true);
check('모델 목록 캐시', (await get('/api/teacher/ai-settings/models')).cached === true);
const badTest = await post('/api/teacher/ai-settings/test', { apiKey: 'sk-or-wrong' });
check('잘못된 키 연결 테스트 실패', !!badTest.error);
const goodTest = await post('/api/teacher/ai-settings/test', { apiKey: 'sk-or-test' });
check('올바른 키 연결 테스트 성공', goodTest.ok === true && goodTest.label === '스모크 키');
const aiSet1 = await fetch(`${base}/api/teacher/ai-settings`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey: 'sk-or-test', model: 'fake/model', pdfEngine: 'pdf-text' }),
}).then((r) => r.json());
check('AI 설정 저장 — 키는 힌트만 노출', aiSet1.configured === true && aiSet1.keyHint.includes('…')
  && !JSON.stringify(aiSet1).includes('sk-or-test'));
await server.db.flushNow();
check('키는 세이브 파일이 아닌 비밀값 파일에 저장', !fs.readFileSync(server.db.file, 'utf8').includes('sk-or-test')
  && fs.readFileSync(server.db.secretsFile, 'utf8').includes('sk-or-test'));

// ── 세이브 백업 ─────────────────────────────
{
  const b0 = await get('/api/teacher/backups');
  check('열 때 일일 백업 + 시험 시작/종료 백업 존재', b0.backups.some((b) => b.reason === 'daily') && b0.backups.some((b) => b.reason === 'exam-start') && b0.backups.some((b) => b.reason === 'exam-end'));
  const b1 = await post('/api/teacher/backups');
  check('수동 백업 생성', b1.ok === true && fs.existsSync(b1.path) && b1.backups[0].reason === 'manual');
}

// ── AI 채점 (서술형만) ─────────────────────────────
const monBefore = await get(`/api/teacher/exams/${exam.id}/monitor`);
check('AI 채점 전 상태 요약', monBefore.rows.find((r) => r.studentId === students[0].id)?.ai?.done === 0
  && monBefore.exam.aiConfigured === true && monBefore.exam.essayCount === 2);
const aiStart = await post(`/api/teacher/exams/${exam.id}/ai-grade`);
check('AI 배치 채점 시작 (응시자 3명 전원 제출 처리됨)', aiStart.ok === true && aiStart.progress?.total === 3);
const dup2 = await post(`/api/teacher/exams/${exam.id}/ai-grade`);
check('진행 중 중복 시작 거부', /진행 중/.test(dup2.error ?? ''));
for (let i = 0; i < 40 && server.aiGrader.progressOf(exam.id); i++) await sleep(100);
check('AI 배치 채점 완료', server.aiGrader.progressOf(exam.id) === null);
check('AI 요청에 학생 이름/번호 미포함', aiCalls.length >= 2
  && aiCalls.every((c) => !JSON.stringify(c.body).includes('김민준') && !JSON.stringify(c.body).includes('이서연')));
check('AI 요청에 채점기준·모범답안 포함', aiCalls.some((c) => c.body.messages[1].content[0].text.includes('이유 제시 (5점)')
  && c.body.messages[1].content[0].text.includes('문제 해결의 성취감')));
check('PDF 첨부는 file 파트 + file-parser 플러그인', aiCalls.some((c) => c.body.plugins?.[0]?.id === 'file-parser'
  && c.body.messages[1].content.some((p) => p.type === 'file')));
check('AI 호출 헤더에 Bearer 키', aiCalls.every((c) => c.headers.Authorization === 'Bearer sk-or-test'));

const att1 = await get(`/api/teacher/exams/${exam.id}/attempts/${row1.attemptId}`);
const essayText = exam.questions.find((q) => q.type === 'essay' && !q.allowFile);
const essayFile = exam.questions.find((q) => q.allowFile);
check('AI 초안 저장 (텍스트 8점 / 첨부 15점)', att1.attempt.aiGrades[essayText.id]?.score === 8
  && att1.attempt.aiGrades[essayFile.id]?.score === 15 && att1.attempt.aiGrades[essayFile.id]?.summary === '첨부 요약');
check('AI 초안은 최종 점수에 미반영 (여전히 30점)', att1.attempt.score === 30);
const mon3 = await get(`/api/teacher/exams/${exam.id}/monitor`);
check('감독 화면 AI 상태(2/2 완료, 미반영)', mon3.rows.find((r) => r.studentId === students[0].id)?.ai?.done === 2
  && mon3.rows.find((r) => r.studentId === students[0].id)?.ai?.applied === 0);
check('AI 비용 추정 (모델 단가 × 토큰) 및 시험별 사용량', typeof att1.attempt.aiGrades[essayText.id]?.costUsd === 'number'
  && att1.attempt.aiGrades[essayText.id].costUsd > 0 && mon3.exam.aiUsage?.calls >= 2 && mon3.exam.aiUsage.costKnown === true);
const cons = await post(`/api/teacher/exams/${exam.id}/ai-consistency`, { sample: 2 });
// 텍스트 답안이 있는 AI 채점은 학생1의 서술형 1개뿐 → 표본 1개
check('일관성 검사 (표본 재채점, 판정 반환)', cons.ok === true && cons.sampled === 1 && cons.verdict === 'ok'
  && cons.items.every((it) => typeof it.regraded === 'number' && it.number === 1));
const att1c = await get(`/api/teacher/exams/${exam.id}/attempts/${row1.attemptId}`);
check('일관성 검사는 원래 채점을 바꾸지 않음', att1c.attempt.aiGrades[essayText.id]?.score === 8);

// 교사가 한 문항은 직접 채점(6점) → 전체 반영 시 교사 점수 유지
await post(`/api/teacher/exams/${exam.id}/attempts/${row1.attemptId}/grade`, {
  manualGrades: { [essayText.id]: 6 }, feedback: { [essayText.id]: '직접 쓴 피드백' },
});
const applyAll = await post(`/api/teacher/exams/${exam.id}/apply-ai`);
check('AI 점수 전체 반영 (교사 점수 유지)', applyAll.ok === true && applyAll.gradesApplied >= 1);
const att1b = await get(`/api/teacher/exams/${exam.id}/attempts/${row1.attemptId}`);
check('최종 점수 = 30 + 교사6 + AI15 = 51', att1b.attempt.score === 51
  && att1b.attempt.feedback[essayText.id] === '직접 쓴 피드백' && att1b.attempt.feedback[essayFile.id] === '가짜 피드백입니다.');
const regr = await post(`/api/teacher/exams/${exam.id}/attempts/${row1.attemptId}/ai-grade`, { questionIds: [essayText.id] });
check('학생 1명 특정 문항 AI 재채점', regr.ok === true && regr.aiGrades[essayText.id]?.status === 'done');
const applyOne = await post(`/api/teacher/exams/${exam.id}/attempts/${row1.attemptId}/apply-ai`, { questionIds: [essayText.id], overwrite: true });
check('개별 반영(overwrite) → 30 + 8 + 15 = 53', applyOne.score === 53);
const teacherFile = await fetch(`${base}/api/teacher/exams/${exam.id}/attempts/${row1.attemptId}/files/${essayFile.id}`);
check('교사가 학생 첨부 파일 다운로드', teacherFile.ok && (await teacherFile.text()).startsWith('%PDF'));

// ── 결과 CSV / 엑셀 ─────────────────────────────
const csvRes = await fetch(`${base}/api/teacher/exams/${exam.id}/results.csv`);
const csvBuf = Buffer.from(await csvRes.arrayBuffer());
check('결과 CSV BOM(EF BB BF)', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf);
const csvText = csvBuf.toString('utf8');
check('결과 CSV에 학생/점수 포함', csvText.includes('김민준') && csvText.includes('53'));
check('결과 CSV에 문항별 정답률 요약', csvText.includes('문항별 정답률(%)'));
const xlsxRes = await fetch(`${base}/api/teacher/exams/${exam.id}/results.xlsx`);
const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
check('결과 엑셀 다운로드 (PK 시그니처)', xlsxBuf[0] === 0x50 && xlsxBuf[1] === 0x4b
  && (xlsxRes.headers.get('content-type') ?? '').includes('spreadsheetml'));
{
  const XLSX = await import('xlsx');
  const wb = XLSX.read(xlsxBuf, { type: 'buffer' });
  const detail = XLSX.utils.sheet_to_json(wb.Sheets['서술형 상세'], { header: 1 });
  check('결과 엑셀 서술형 상세에 AI 점수·피드백', wb.SheetNames.includes('서술형 상세')
    && detail.some((r) => r.includes('가짜 피드백입니다.')));
}

// ── 엑셀 문제 양식/가져오기 ─────────────────────────────
const tmplRes = await fetch(`${base}/api/teacher/exams/template.xlsx`);
check('엑셀 양식 다운로드', (tmplRes.headers.get('content-type') ?? '').includes('spreadsheetml'));
const tmplBuf = await tmplRes.arrayBuffer();
const efd = new FormData();
efd.append('file', new Blob([tmplBuf]), '양식.xlsx');
const excelImp = await fetch(`${base}/api/teacher/exams/import-excel`, { method: 'POST', body: efd })
  .then((r) => r.json());
check('엑셀 문제 가져오기 (5문항, 오류 0)', excelImp.questions?.length === 5 && excelImp.errors?.length === 0);
const excelExam = await post('/api/teacher/exams', { title: '엑셀 시험', questions: excelImp.questions, instantResults: true });
check('엑셀 문항으로 시험 생성 (모범답안·채점기준·파일첨부 유지)', excelExam.questions?.length === 5
  && excelExam.questions[2].acceptedAnswers?.length === 2 && excelExam.questions[3].rubric?.includes('(3점)')
  && excelExam.questions[4].allowFile === true && excelExam.instantResults === true);

// ── 성적 공개 → 학생 결과 확인 ─────────────────────────────
const pub = await post(`/api/teacher/exams/${exam.id}/publish-results`, { published: true });
check('성적 공개', pub.resultsPublished === true);
const myResults = await get('/api/student/exams/results', auth1.token);
check('학생 성적 목록(53점, 서술형 2/2 채점)', myResults.length === 1 && myResults[0].total === 53
  && myResults[0].essayGraded === 2 && myResults[0].essayTotal === 2);
const myDetail = await get(`/api/student/exams/${exam.id}/result`, auth1.token);
check('학생 결과 상세(문항별 정오·정답·피드백·첨부명 포함)',
  myDetail.total === 53 && myDetail.questions.filter((q) => q.correctAnswer != null).length === 6
  && myDetail.questions.some((q) => q.feedback === '가짜 피드백입니다.' && q.myFile === '보고서.pdf'));
check('학생 결과에 모범답안/채점기준/AI 원본 미노출',
  !JSON.stringify(myDetail).includes('modelAnswer') && !JSON.stringify(myDetail).includes('rubric')
  && !JSON.stringify(myDetail).includes('confidence'));

// 즉시 공개 시험: 종료와 동시에 학생이 볼 수 있어야 함
await post(`/api/teacher/exams/${excelExam.id}/start`, { durationMin: 1 });
await post(`/api/teacher/exams/${excelExam.id}/stop`);
await sleep(200);
const instantList = await get('/api/student/exams/results', auth1.token);
check('즉시 공개 시험은 종료 직후 학생 결과 목록에 등장', instantList.some((r) => r.examId === excelExam.id));
await fetch(`${base}/api/teacher/exams/${excelExam.id}`, { method: 'DELETE' });
await post(`/api/teacher/exams/${exam.id}/publish-results`, { published: false });
const hiddenRes = await get(`/api/student/exams/${exam.id}/result`, auth1.token);
check('공개 취소 시 학생 조회 차단', !!hiddenRes.error);

// ── 과목 삭제 → 시험은 "과목 없음"으로 남음 ─────────────────────────────
const delSubj = await fetch(`${base}/api/teacher/subjects/${subj.id}`, { method: 'DELETE' }).then((r) => r.json());
check('과목 삭제 후 시험·학생 보존(과목 없음으로)', delSubj.ok === true
  && (await get('/api/teacher/exams')).some((e) => e.id === exam.id && e.subjectName === null)
  && (await get('/api/teacher/students')).filter((s) => !s.subjectId).length === 3);

const answersLogCount = server.db.readEvents(`answers-${exam.id}`).length;
const focusLogCount = server.db.readEvents(`focus-${exam.id}`).length;

// ── 복제(재시험)와 삭제 ─────────────────────────────
const dup = await post(`/api/teacher/exams/${exam.id}/duplicate`);
check('시험 복제 → 재시험 초안', dup.status === 'draft' && dup.questions.length === exam.questions.length
  && dup.title.includes('재시험'));
const delDup = await fetch(`${base}/api/teacher/exams/${dup.id}`, { method: 'DELETE' }).then((r) => r.json());
check('초안 삭제', delDup.ok === true);
const delEnded = await fetch(`${base}/api/teacher/exams/${exam.id}`, { method: 'DELETE' }).then((r) => r.json());
const attemptsLeft = server.db.data.attempts.filter((a) => a.examId === exam.id).length;
check('종료 시험 삭제(응시 기록·첨부 파일·이벤트 로그 포함)', delEnded.ok === true && attemptsLeft === 0 && !fs.existsSync(ansDir)
  && server.db.readEvents(`answers-${exam.id}`).length === 0 && server.db.readEvents(`focus-${exam.id}`).length === 0);
check('삭제 전 답안·이탈 JSONL은 기록되어 있었음', answersLogCount >= 8 && focusLogCount >= 2);

sock.disconnect();
await server.stop();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failures ? `\n❌ ${failures}개 실패` : '\n✅ 모든 스모크 테스트 통과');
process.exit(failures ? 1 : 0);
