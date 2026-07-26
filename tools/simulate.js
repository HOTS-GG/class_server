// 가상 학생 시뮬레이터: 서버에 등록된 학생 코드로 접속해 시험 응시를 흉내낸다.
// 사용법: node tools/simulate.js [서버주소] [학생수]
//   예:   node tools/simulate.js http://127.0.0.1:3690 40
// 사전 조건: 서버 실행 중(npm run server 또는 교사 앱) + 학생 명단 등록됨 + (시험 테스트 시) 시험 시작됨
import { io } from 'socket.io-client';
import { enableUtf8Console } from '../shared/src/winConsole.js';

enableUtf8Console();

// localhost는 Node 18에서 ::1(IPv6)로 먼저 해석될 수 있어 127.0.0.1을 기본으로 쓴다
const base = (process.argv[2] ?? 'http://127.0.0.1:3690').replace('//localhost', '//127.0.0.1');
const count = Number(process.argv[3] ?? 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Math.floor(Math.random() * n);

// 교사 API(localhost 신뢰)로 학생 명단·코드를 가져온다
let students;
try {
  students = await fetch(`${base}/api/teacher/students`).then((r) => r.json());
} catch {
  console.error(`서버(${base})에 연결할 수 없습니다.`);
  console.error('먼저 서버를 실행하세요: npm run server (또는 교사용 프로그램 실행)');
  process.exit(1);
}
if (!Array.isArray(students) || students.length === 0) {
  console.error('등록된 학생이 없습니다. 대시보드에서 명단을 먼저 등록하세요.');
  process.exit(1);
}
const targets = students.slice(0, count);
console.log(`${targets.length}명 가상 접속 시작 → ${base}`);

let submitted = 0;

async function runStudent(stu, idx) {
  await sleep(idx * 100); // 접속 분산
  const auth = await fetch(`${base}/api/auth/student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: stu.code }),
  }).then((r) => r.json());
  if (!auth.token) { console.error(`${stu.name}: 로그인 실패`); return; }

  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const socket = io(`${base}/student`, { auth: { token: auth.token } });

  socket.on('connect', async () => {
    const active = await fetch(`${base}/api/student/exams/active`, { headers }).then((r) => r.json());
    if (!active.exam) return; // 시험 없으면 접속만 유지

    for (const q of active.questions) {
      await sleep(300 + rand(700));
      const answer = q.type === 'mc'
        ? { choiceId: q.choices[rand(q.choices.length)].id }
        : { text: `${stu.name}의 서술형 답안입니다. (자동 생성)` };
      socket.emit('exam:answer', { examId: active.exam.id, questionId: q.id, answer }, (res) => {
        if (!res?.ok) console.error(`${stu.name} 저장 실패: ${res?.error}`);
      });
      if (Math.random() < 0.1) socket.emit('focus:event', { event: 'blur' });
      if (Math.random() < 0.1) socket.emit('focus:event', { event: 'focus' });
    }
    await sleep(500);
    socket.emit('exam:submit', { examId: active.exam.id }, (res) => {
      if (res?.ok) {
        submitted++;
        console.log(`  ${stu.number}번 ${stu.name} 제출 완료 (${submitted}/${targets.length})`);
      }
    });
  });
}

await Promise.all(targets.map(runStudent));
console.log('접속 유지 중... (Ctrl+C로 종료)');
