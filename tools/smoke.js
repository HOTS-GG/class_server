// E2E 스모크 테스트: 임시 데이터 폴더로 서버를 띄우고 전체 흐름을 검증한다.
// 실행: node tools/smoke.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createClassServer } from '../server/src/app.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-smoke-'));
const port = 3777;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createClassServer({ dataDir, httpPort: port, enableDiscovery: false });
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

const imp = await post('/api/teacher/students/import', { csv: '번호,이름\n1,김민준\n2,이서연\n3,박도윤' });
check('학생 3명 CSV 등록', imp.addedCount === 3);
const students = await get('/api/teacher/students');

const auth1 = await post('/api/auth/student', { code: students[0].code });
const auth2 = await post('/api/auth/student', { code: students[1].code });
check('학생 로그인(코드)', !!auth1.token && !!auth2.token);
const bad = await post('/api/auth/student', { code: 'XXXXXX' });
check('잘못된 코드 거부', !!bad.error);

// ── 과제 배부/제출/회수 ─────────────────────────────
const asg = await post('/api/teacher/assignments', { title: '테스트 과제' });
check('과제 생성', asg.status === 'draft');
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

// ── 시험 ─────────────────────────────
const exam = await post('/api/teacher/exams', {
  title: '수학 쪽지시험',
  durationMin: 1,
  questions: [
    { type: 'mc', text: '1+1=?', points: 5, choices: ['1', '2', '3', '4'], answerIndex: 1 },
    { type: 'mc', text: '2*3=?', points: 5, choices: ['5', '6', '7', '8'], answerIndex: 1 },
    { type: 'mc', text: '3-1=?', points: 5, choices: ['1', '2', '3', '4'], answerIndex: 1 },
    { type: 'mc', text: '8/2=?', points: 5, choices: ['2', '4', '6', '8'], answerIndex: 1 },
    { type: 'mc', text: '5+5=?', points: 5, choices: ['5', '10', '15', '20'], answerIndex: 1 },
    { type: 'short', text: '물의 화학식을 쓰시오.', points: 5, acceptedAnswers: ['H2O', '에이치투오'] },
    { type: 'essay', text: '수학이 즐거운 이유를 쓰시오.', points: 10 },
  ],
});
check('시험 생성', exam.status === 'draft');
await post(`/api/teacher/exams/${exam.id}/start`, { durationMin: 1 });

const v1 = await get('/api/student/exams/active', auth1.token);
const v2 = await get('/api/student/exams/active', auth2.token);
check('학생 응시 화면 수신', v1.exam?.id === exam.id);
check('학생별 문항 순서 상이', v1.questions.map((q) => q.text).join() !== v2.questions.map((q) => q.text).join());
check('정답 미노출(객관식+단답형)',
  !JSON.stringify(v1).includes('answerChoiceId') && !JSON.stringify(v1).includes('acceptedAnswers'));
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
      : { text: '문제를 풀 때마다 새로운 걸 알게 돼서요.' };
  const res = await new Promise((r) => sock.emit('exam:answer', { examId: exam.id, questionId: q.id, answer }, r));
  if (!res?.ok) check(`답안 저장 실패: ${res?.error}`, false);
}
sock.emit('focus:event', { event: 'blur' });
sock.emit('focus:event', { event: 'focus' });

const submitRes = await new Promise((r) => sock.emit('exam:submit', { examId: exam.id }, r));
check('시험 제출(소켓)', submitRes?.ok === true);
await sleep(400);

const mon = await get(`/api/teacher/exams/${exam.id}/monitor`);
const row1 = mon.rows.find((r) => r.studentId === students[0].id);
check('자동 채점 (객관식25+단답형5=30점)', row1?.score === 30);
check('감독 화면 이탈 기록', row1?.presence?.awayCount >= 1);

const essayQ = exam.questions.find((q) => q.type === 'essay');
const graded = await post(`/api/teacher/exams/${exam.id}/attempts/${row1.attemptId}/grade`, {
  manualGrades: { [essayQ.id]: 8 },
});
check('서술형 수동 채점 반영 (총 38점)', graded.score === 38);

// HTTP 폴백 저장 (학생2)
const q2first = v2.questions.find((q) => q.type === 'mc');
const fallback = await post(`/api/student/exams/${exam.id}/answer`, {
  questionId: q2first.id,
  answer: { choiceId: q2first.choices[0].id },
}, auth2.token);
check('HTTP 폴백 답안 저장', fallback.ok === true);

// 교사 종료 → 미제출자 자동 제출
await post(`/api/teacher/exams/${exam.id}/stop`);
await sleep(300);
const mon2 = await get(`/api/teacher/exams/${exam.id}/monitor`);
const row2 = mon2.rows.find((r) => r.studentId === students[1].id);
check('미제출자 자동 마감 처리', row2?.submitted === true && row2?.submitType === 'teacher');

// ── 결과 CSV ─────────────────────────────
const csvRes = await fetch(`${base}/api/teacher/exams/${exam.id}/results.csv`);
const csvBuf = Buffer.from(await csvRes.arrayBuffer());
check('결과 CSV BOM(EF BB BF)', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf);
const csvText = csvBuf.toString('utf8');
check('결과 CSV에 학생/점수 포함', csvText.includes('김민준') && csvText.includes('38'));
check('결과 CSV에 문항별 정답률 요약', csvText.includes('문항별 정답률(%)'));

// ── 엑셀 문제 양식/가져오기 ─────────────────────────────
const tmplRes = await fetch(`${base}/api/teacher/exams/template.xlsx`);
check('엑셀 양식 다운로드', (tmplRes.headers.get('content-type') ?? '').includes('spreadsheetml'));
const tmplBuf = await tmplRes.arrayBuffer();
const efd = new FormData();
efd.append('file', new Blob([tmplBuf]), '양식.xlsx');
const excelImp = await fetch(`${base}/api/teacher/exams/import-excel`, { method: 'POST', body: efd })
  .then((r) => r.json());
check('엑셀 문제 가져오기 (4문항, 오류 0)', excelImp.questions?.length === 4 && excelImp.errors?.length === 0);
const excelExam = await post('/api/teacher/exams', { title: '엑셀 시험', questions: excelImp.questions });
check('엑셀 문항으로 시험 생성', excelExam.questions?.length === 4 && excelExam.questions[2].acceptedAnswers?.length === 2);

// ── 이벤트 로그(JSONL) ─────────────────────────────
check('답안 JSONL 기록', server.db.readEvents(`answers-${exam.id}`).length >= 7);
check('이탈 JSONL 기록', server.db.readEvents(`focus-${exam.id}`).length >= 2);

sock.disconnect();
await server.stop();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failures ? `\n❌ ${failures}개 실패` : '\n✅ 모든 스모크 테스트 통과');
process.exit(failures ? 1 : 0);
