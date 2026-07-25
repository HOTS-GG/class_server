/* global io */
// 교사 대시보드 — 빌드 스텝 없는 vanilla JS

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let students = [];           // [{id, number, name, code, presence}]
let serverOffset = 0;        // serverNow - Date.now()
let activeExam = null;       // {id, title, endsAt, ...} | null
let monitorExamId = null;
let editingExamId = null;
let editQuestions = [];

const FOCUS_LABEL = {
  blur: '화면 이탈(다른 창)', focus: '화면 복귀', minimize: '창 최소화',
  screen_lock: '화면 잠금', disconnect: '연결 끊김', reconnect: '재접속',
  paste_blocked: '붙여넣기 시도 차단', copy_blocked: '복사 시도 차단',
  shortcut_blocked: '단축키 차단', clipboard_changed: '클립보드 변화 감지',
};
const FOCUS_CLASS = {
  blur: 'warn', minimize: 'warn', screen_lock: 'warn', disconnect: 'bad',
  focus: 'good', reconnect: 'good',
  paste_blocked: 'bad', copy_blocked: 'bad', shortcut_blocked: 'warn', clipboard_changed: 'bad',
};

// ── 공통 유틸 ─────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (body instanceof FormData) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

function toast(msg, cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour12: false }) : '';
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── 탭 ─────────────────────────────
$$('#tabs button').forEach((btn) => btn.addEventListener('click', () => {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
  if (btn.dataset.tab === 'students') loadStudents();
  if (btn.dataset.tab === 'assignments') loadAssignments();
  if (btn.dataset.tab === 'exams') loadExams();
  if (btn.dataset.tab === 'tools') loadServerInfo();
}));

// ── 서버 정보 ─────────────────────────────
async function loadServerInfo() {
  try {
    const info = await api('GET', '/api/teacher/server-info');
    const addrText = info.addresses.map((a) => `${a}:${info.httpPort}`).join('  |  ');
    $('#server-info').innerHTML = `학생 접속 주소: <b>${esc(addrText) || '네트워크 없음'}</b>`;
    $('#tools-server-info').textContent =
      `서버 이름   : ${info.name}\n` +
      `버전       : ${info.version}\n` +
      `HTTP 포트  : ${info.httpPort}\n` +
      `자동탐색 포트: ${info.udpPort} (UDP)\n` +
      `접속 주소   :\n${info.addresses.map((a) => `  - ${a}:${info.httpPort}`).join('\n')}`;
  } catch (err) { toast(err.message, 'warn'); }
}

// ── 학생 명단 ─────────────────────────────
async function loadStudents() {
  students = await api('GET', '/api/teacher/students');
  renderStudentsTable();
  renderTiles();
}

function renderStudentsTable() {
  const tbody = $('#students-table tbody');
  tbody.innerHTML = students.map((s) => `
    <tr>
      <td>${s.number}</td>
      <td>${esc(s.name)}</td>
      <td><code>${s.code}</code>
        <button class="small" data-act="recode" data-id="${s.id}">재발급</button></td>
      <td>${s.presence?.online ? '🟢 접속' : '⚪ 미접속'}</td>
      <td><button class="small" data-act="del" data-id="${s.id}">삭제</button></td>
    </tr>`).join('');
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.act === 'recode') {
        await api('POST', `/api/teacher/students/${btn.dataset.id}/code`);
        toast('접속 코드를 재발급했습니다.');
      } else if (btn.dataset.act === 'del') {
        const stu = students.find((s) => s.id === btn.dataset.id);
        if (!confirm(`${stu?.name} 학생을 명단에서 삭제할까요?`)) return;
        await api('DELETE', `/api/teacher/students/${btn.dataset.id}`);
      }
      await loadStudents();
    } catch (err) { toast(err.message, 'warn'); }
  };
}

$('#btn-add-student').addEventListener('click', async () => {
  try {
    await api('POST', '/api/teacher/students', {
      number: $('#stu-number').value, name: $('#stu-name').value,
    });
    $('#stu-number').value = ''; $('#stu-name').value = '';
    await loadStudents();
  } catch (err) { toast(err.message, 'warn'); }
});

$('#btn-import-csv').addEventListener('click', () => $('#csv-file').click());
$('#csv-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('euc-kr').decode(buf); } // 엑셀 CP949 저장 대응
  try {
    const r = await api('POST', '/api/teacher/students/import', { csv: text });
    toast(`${r.addedCount}명 추가${r.skipped.length ? `, ${r.skipped.length}건 건너뜀` : ''}`);
    await loadStudents();
  } catch (err) { toast(err.message, 'warn'); }
  e.target.value = '';
});

// ── 현황판 ─────────────────────────────
function renderTiles() {
  const tiles = $('#student-tiles');
  const online = students.filter((s) => s.presence?.online).length;
  $('#online-count').textContent = `(${online}/${students.length}명 접속)`;
  tiles.innerHTML = students.map((s) => {
    const p = s.presence ?? {};
    const cls = !p.online ? 'offline' : (p.focus === 'away' ? 'away' : 'online');
    const badge = !p.online ? '미접속' : (p.focus === 'away' ? '이탈 중' : '접속 중');
    const stat = p.awayCount ? `이탈 ${p.awayCount}회 · ${fmtDur(p.awayMs)}` : '';
    return `<div class="tile ${cls}" id="tile-${s.id}">
      <div class="num">${s.number}번</div>
      <div class="name">${esc(s.name)}</div>
      <div class="badge">${badge}</div>
      <div class="stat">${stat}</div>
    </div>`;
  }).join('');
}

function updateTile(snapshot) {
  const s = students.find((x) => x.id === snapshot.studentId);
  if (!s) return;
  s.presence = snapshot;
  renderTiles();
}

function addFeed(html, cls = '') {
  const feed = $('#event-feed');
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = `<time>${fmtTime(Date.now())}</time>${html}`;
  feed.prepend(el);
  while (feed.children.length > 200) feed.lastChild.remove();
}

function renderBanner() {
  const banner = $('#active-exam-banner');
  if (!activeExam || activeExam.status !== 'active') {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  const remain = activeExam.endsAt - (Date.now() + serverOffset);
  banner.innerHTML = `📝 <b>${esc(activeExam.title)}</b> 진행 중
    <span class="timer">${fmtDur(remain)}</span>
    <span class="sep"></span>
    <button class="small" onclick="window.__openMonitor('${activeExam.id}')">감독 화면 열기</button>`;
}

setInterval(() => {
  renderBanner();
  if (monitorExamId && !$('#exam-monitor').classList.contains('hidden')) updateMonitorTimer();
}, 1000);

// ── 과제 ─────────────────────────────
async function loadAssignments() {
  const list = await api('GET', '/api/teacher/assignments');
  const label = { draft: '초안', published: '배부됨', closed: '마감' };
  $('#assignment-list').innerHTML = list.length ? list.map((a) => `
    <div class="asg-item">
      <span class="title">${esc(a.title)}</span>
      <span class="muted">${a.files.length}개 파일 · 제출 ${a.submittedCount}명</span>
      <span class="status-pill ${a.status}">${label[a.status]}</span>
      ${a.status === 'draft' ? `<button class="small primary" data-act="publish" data-id="${a.id}">배부</button>` : ''}
      ${a.status === 'published' ? `<button class="small" data-act="close" data-id="${a.id}">마감</button>` : ''}
      <button class="small" data-act="detail" data-id="${a.id}" data-title="${esc(a.title)}">제출 현황</button>
    </div>`).join('') : '<p class="muted">아직 과제가 없습니다.</p>';

  $('#assignment-list').onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.act === 'publish') {
        await api('POST', `/api/teacher/assignments/${btn.dataset.id}/publish`);
        toast('과제를 배부했습니다.');
        await loadAssignments();
      } else if (btn.dataset.act === 'close') {
        await api('POST', `/api/teacher/assignments/${btn.dataset.id}/close`);
        await loadAssignments();
      } else if (btn.dataset.act === 'detail') {
        await openAssignmentDetail(btn.dataset.id, btn.dataset.title);
      }
    } catch (err) { toast(err.message, 'warn'); }
  };
}

async function openAssignmentDetail(id, title) {
  const rows = await api('GET', `/api/teacher/assignments/${id}/submissions`);
  $('#asg-detail-title').textContent = `제출 현황 — ${title}`;
  $('#asg-zip-link').href = `/api/teacher/assignments/${id}/submissions.zip`;
  $('#submissions-table tbody').innerHTML = rows.map((r) => `
    <tr>
      <td>${r.number}</td>
      <td>${esc(r.name)}</td>
      <td>${r.submitted ? `✅ v${r.version}` : '—'}</td>
      <td>${fmtTime(r.submittedAt)}</td>
      <td>${r.files.map((f) =>
        `<a href="/api/teacher/assignments/${id}/submissions/${r.studentId}/files/${f.fileId}" download>${esc(f.name)}</a>`,
      ).join(', ')}</td>
    </tr>`).join('');
  $('#assignment-detail').classList.remove('hidden');
  $('#assignment-detail').dataset.assignmentId = id;
}

$('#btn-asg-back').addEventListener('click', () => $('#assignment-detail').classList.add('hidden'));

$('#btn-create-assignment').addEventListener('click', async () => {
  const fd = new FormData();
  fd.set('title', $('#asg-title').value);
  fd.set('description', $('#asg-desc').value);
  fd.set('allowResubmit', $('#asg-resubmit').checked ? 'true' : 'false');
  for (const f of $('#asg-files').files) fd.append('files', f);
  try {
    await api('POST', '/api/teacher/assignments', fd);
    $('#asg-title').value = ''; $('#asg-desc').value = ''; $('#asg-files').value = '';
    toast('과제를 생성했습니다. "배부" 버튼으로 학생에게 공개하세요.');
    await loadAssignments();
  } catch (err) { toast(err.message, 'warn'); }
});

// ── 시험 목록/편집 ─────────────────────────────
async function loadExams() {
  const list = await api('GET', '/api/teacher/exams');
  const label = { draft: '초안', active: '진행 중', ended: '종료' };
  $('#exam-list').innerHTML = list.length ? list.map((e) => `
    <div class="exam-item">
      <span class="title">${esc(e.title)}</span>
      <span class="muted">${e.questionCount}문항 · ${e.totalPoints}점 · ${e.durationMin ?? Math.round((e.durationSec ?? 1800) / 60)}분</span>
      <span class="status-pill ${e.status}">${label[e.status]}</span>
      ${e.status === 'draft' ? `
        <button class="small" data-act="edit" data-id="${e.id}">수정</button>
        <button class="small primary" data-act="start" data-id="${e.id}">시작</button>
        <button class="small" data-act="del" data-id="${e.id}">삭제</button>` : ''}
      ${e.status !== 'draft' ? `<button class="small" data-act="monitor" data-id="${e.id}">감독/결과</button>` : ''}
    </div>`).join('') : '<p class="muted">아직 시험이 없습니다.</p>';

  $('#exam-list').onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === 'edit') await openExamEditor(id);
      else if (btn.dataset.act === 'del') {
        if (!confirm('시험을 삭제할까요?')) return;
        await api('DELETE', `/api/teacher/exams/${id}`);
        await loadExams();
      } else if (btn.dataset.act === 'start') {
        const exam = await api('GET', `/api/teacher/exams/${id}`);
        const min = prompt('시험 시간(분)을 입력하세요.', exam.durationMin ?? 30);
        if (min == null) return;
        await api('POST', `/api/teacher/exams/${id}/start`, { durationMin: Number(min) });
        toast('시험을 시작했습니다.');
        await openMonitor(id);
      } else if (btn.dataset.act === 'monitor') {
        await openMonitor(id);
      }
    } catch (err) { toast(err.message, 'warn'); }
  };
}

function questionCard(q, idx) {
  const choices = (q.choices ?? []).map((c, ci) => `
    <div class="choice-row">
      <input type="radio" name="ans-${idx}" ${q.answerIndex === ci ? 'checked' : ''} data-q="${idx}" data-c="${ci}" data-role="answer" title="정답">
      <input type="text" value="${esc(c)}" data-q="${idx}" data-c="${ci}" data-role="choice" placeholder="선택지 ${ci + 1}">
      <button class="small" data-role="del-choice" data-q="${idx}" data-c="${ci}">✕</button>
    </div>`).join('');
  return `<div class="q-card">
    <div class="q-head">
      <b>${idx + 1}번</b>
      <span class="status-pill">${q.type === 'mc' ? '객관식' : '서술형'}</span>
      <label>배점 <input type="number" value="${q.points}" style="width:60px" data-q="${idx}" data-role="points"></label>
      <span class="sep"></span>
      <button class="small" data-role="del-q" data-q="${idx}">문항 삭제</button>
    </div>
    <textarea data-q="${idx}" data-role="text" placeholder="문항 내용">${esc(q.text)}</textarea>
    ${q.type === 'mc' ? `${choices}
      <button class="small" data-role="add-choice" data-q="${idx}">+ 선택지</button>
      <div class="muted">왼쪽 라디오 버튼으로 정답을 지정하세요.</div>` : ''}
  </div>`;
}

function renderQuestionEditor() {
  $('#question-editor').innerHTML = editQuestions.map(questionCard).join('') ||
    '<p class="muted">아래 버튼으로 문항을 추가하세요.</p>';
}

// 편집 중 입력값을 state에 반영
$('#question-editor').addEventListener('input', (e) => {
  const t = e.target;
  const q = editQuestions[Number(t.dataset.q)];
  if (!q) return;
  if (t.dataset.role === 'text') q.text = t.value;
  else if (t.dataset.role === 'points') q.points = Number(t.value);
  else if (t.dataset.role === 'choice') q.choices[Number(t.dataset.c)] = t.value;
});
$('#question-editor').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.role === 'answer') {
    editQuestions[Number(t.dataset.q)].answerIndex = Number(t.dataset.c);
  }
});
$('#question-editor').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const qi = Number(t.dataset.q);
  if (t.dataset.role === 'del-q') editQuestions.splice(qi, 1);
  else if (t.dataset.role === 'add-choice') editQuestions[qi].choices.push('');
  else if (t.dataset.role === 'del-choice') {
    const q = editQuestions[qi];
    q.choices.splice(Number(t.dataset.c), 1);
    if (q.answerIndex >= q.choices.length) q.answerIndex = 0;
  } else return;
  renderQuestionEditor();
});

$('#btn-add-mc').addEventListener('click', () => {
  editQuestions.push({ type: 'mc', text: '', points: 5, choices: ['', '', '', ''], answerIndex: 0 });
  renderQuestionEditor();
});
$('#btn-add-essay').addEventListener('click', () => {
  editQuestions.push({ type: 'essay', text: '', points: 10 });
  renderQuestionEditor();
});

$('#btn-new-exam').addEventListener('click', () => {
  editingExamId = null;
  editQuestions = [];
  $('#exam-editor-title').textContent = '새 시험';
  $('#ex-title').value = ''; $('#ex-duration').value = 30;
  $('#ex-shuffle-q').checked = true; $('#ex-shuffle-c').checked = true;
  renderQuestionEditor();
  $('#exam-list-view').classList.add('hidden');
  $('#exam-editor').classList.remove('hidden');
});

async function openExamEditor(id) {
  const exam = await api('GET', `/api/teacher/exams/${id}`);
  editingExamId = id;
  editQuestions = exam.questions.map((q) => ({
    type: q.type, text: q.text, points: q.points,
    choices: q.choices?.map((c) => c.text),
    answerIndex: q.choices?.findIndex((c) => c.id === q.answerChoiceId) ?? 0,
  }));
  $('#exam-editor-title').textContent = `시험 수정 — ${exam.title}`;
  $('#ex-title').value = exam.title;
  $('#ex-duration').value = exam.durationMin ?? 30;
  $('#ex-shuffle-q').checked = exam.shuffleQuestions;
  $('#ex-shuffle-c').checked = exam.shuffleChoices;
  renderQuestionEditor();
  $('#exam-list-view').classList.add('hidden');
  $('#exam-editor').classList.remove('hidden');
}

$('#btn-cancel-exam').addEventListener('click', () => {
  $('#exam-editor').classList.add('hidden');
  $('#exam-list-view').classList.remove('hidden');
});

$('#btn-save-exam').addEventListener('click', async () => {
  const payload = {
    title: $('#ex-title').value,
    durationMin: Number($('#ex-duration').value),
    shuffleQuestions: $('#ex-shuffle-q').checked,
    shuffleChoices: $('#ex-shuffle-c').checked,
    questions: editQuestions,
  };
  try {
    if (editingExamId) await api('PUT', `/api/teacher/exams/${editingExamId}`, payload);
    else await api('POST', '/api/teacher/exams', payload);
    toast('시험을 저장했습니다.');
    $('#exam-editor').classList.add('hidden');
    $('#exam-list-view').classList.remove('hidden');
    await loadExams();
  } catch (err) { toast(err.message, 'warn'); }
});

// ── 시험 감독 ─────────────────────────────
let monitorData = null;

async function openMonitor(examId) {
  monitorExamId = examId;
  $('#exam-list-view').classList.add('hidden');
  $('#exam-editor').classList.add('hidden');
  $('#exam-monitor').classList.remove('hidden');
  $('#results-csv-link').href = `/api/teacher/exams/${examId}/results.csv`;
  // 다른 탭에 있어도 감독 화면으로 이동
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'exams'));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-exams'));
  await refreshMonitor();
}
window.__openMonitor = openMonitor;

$('#btn-monitor-back').addEventListener('click', () => {
  monitorExamId = null;
  $('#exam-monitor').classList.add('hidden');
  $('#exam-list-view').classList.remove('hidden');
  loadExams();
});

$('#btn-stop-exam').addEventListener('click', async () => {
  if (!confirm('시험을 지금 종료할까요? 미제출 학생은 자동 제출됩니다.')) return;
  try {
    await api('POST', `/api/teacher/exams/${monitorExamId}/stop`);
    await refreshMonitor();
  } catch (err) { toast(err.message, 'warn'); }
});

async function refreshMonitor() {
  if (!monitorExamId) return;
  monitorData = await api('GET', `/api/teacher/exams/${monitorExamId}/monitor`);
  serverOffset = monitorData.serverNow - Date.now();
  const { exam, rows } = monitorData;
  $('#monitor-title').textContent = `${exam.title} — ${exam.status === 'active' ? '진행 중' : '종료됨'}`;
  $('#btn-stop-exam').classList.toggle('hidden', exam.status !== 'active');
  updateMonitorTimer();
  const typeLabel = { manual: '직접', auto: '시간종료', teacher: '교사종료' };
  $('#monitor-table tbody').innerHTML = rows.map((r) => {
    const p = r.presence;
    const conn = !p.online ? '⚪' : (p.focus === 'away' ? '🟡 이탈' : '🟢');
    const away = p.awayCount ? `${p.awayCount}회/${fmtDur(p.awayMs)}` : '—';
    const hasEssay = monitorData && r.submitted;
    return `<tr>
      <td>${r.number}</td>
      <td>${esc(r.name)}</td>
      <td>${conn}</td>
      <td>${r.answeredCount}/${r.questionCount}</td>
      <td>${away}</td>
      <td>${r.submitted ? `✅ ${typeLabel[r.submitType] ?? ''} ${fmtTime(r.submittedAt)}` : '—'}</td>
      <td>${r.score != null ? `${r.score}점` : '—'}</td>
      <td>${hasEssay ? `<button class="small" data-attempt="${r.attemptId}">답안/채점</button>` : ''}</td>
    </tr>`;
  }).join('');
  $('#monitor-table tbody').onclick = (e) => {
    const btn = e.target.closest('button');
    if (btn?.dataset.attempt) openGradeModal(btn.dataset.attempt);
  };
}

function updateMonitorTimer() {
  const exam = monitorData?.exam;
  if (!exam) return;
  if (exam.status === 'active' && exam.endsAt) {
    $('#monitor-timer').textContent = `남은 시간 ${fmtDur(exam.endsAt - (Date.now() + serverOffset))}`;
  } else {
    $('#monitor-timer').textContent = '';
  }
}

// ── 서술형 채점 모달 ─────────────────────────────
let gradingAttemptId = null;

async function openGradeModal(attemptId) {
  const { exam, attempt, student } = await api('GET', `/api/teacher/exams/${monitorExamId}/attempts/${attemptId}`);
  gradingAttemptId = attemptId;
  $('#grade-title').textContent = `답안 확인 — ${student?.number}번 ${student?.name}`;
  $('#grade-content').innerHTML = exam.questions.map((q, i) => {
    const a = attempt.answers[q.id];
    if (q.type === 'mc') {
      const chosen = q.choices.find((c) => c.id === a?.choiceId);
      const correct = a?.choiceId === q.answerChoiceId;
      return `<div class="q-card">
        <b>Q${i + 1}. (객관식 ${q.points}점)</b> ${esc(q.text)}<br>
        답: ${esc(chosen?.text ?? '무응답')} ${correct ? '⭕' : '❌'}
      </div>`;
    }
    const cur = attempt.manualGrades?.[q.id] ?? '';
    return `<div class="q-card">
      <b>Q${i + 1}. (서술형 ${q.points}점)</b> ${esc(q.text)}
      <div class="answer-box">${esc(a?.text ?? '(무응답)')}</div>
      <label>점수 <input type="number" min="0" max="${q.points}" value="${cur}"
        data-grade-q="${q.id}" style="width:70px"> / ${q.points}점</label>
    </div>`;
  }).join('');
  $('#grade-modal').classList.remove('hidden');
}

$('#btn-close-grades').addEventListener('click', () => $('#grade-modal').classList.add('hidden'));
$('#btn-save-grades').addEventListener('click', async () => {
  const manualGrades = {};
  $$('#grade-content [data-grade-q]').forEach((inp) => {
    if (inp.value !== '') manualGrades[inp.dataset.gradeQ] = Number(inp.value);
  });
  try {
    await api('POST', `/api/teacher/exams/${monitorExamId}/attempts/${gradingAttemptId}/grade`, { manualGrades });
    toast('채점을 저장했습니다.');
    $('#grade-modal').classList.add('hidden');
    await refreshMonitor();
  } catch (err) { toast(err.message, 'warn'); }
});

// ── 도구 ─────────────────────────────
$('#btn-unlock-code').addEventListener('click', async () => {
  try {
    const { code } = await api('POST', '/api/teacher/unlock-code');
    $('#unlock-code-display').textContent = code;
  } catch (err) { toast(err.message, 'warn'); }
});

$('#btn-unlock-all').addEventListener('click', async () => {
  if (!confirm('모든 학생의 화면 잠금을 해제할까요?')) return;
  try {
    await api('POST', '/api/teacher/unlock-all');
    toast('전체 잠금 해제 신호를 보냈습니다.');
  } catch (err) { toast(err.message, 'warn'); }
});

// ── 실시간 소켓 ─────────────────────────────
const socket = io('/teacher');

socket.on('snapshot', (snap) => {
  serverOffset = snap.serverNow - Date.now();
  activeExam = snap.activeExam;
  for (const p of snap.presence) {
    const s = students.find((x) => x.id === p.studentId);
    if (s) s.presence = p;
  }
  renderTiles();
  renderBanner();
});

socket.on('student:online', (p) => {
  updateTile(p);
  const s = students.find((x) => x.id === p.studentId);
  if (s) addFeed(`<b>${s.number}번 ${esc(s.name)}</b> 접속`, 'good');
});

socket.on('student:offline', (p) => {
  updateTile(p);
  const s = students.find((x) => x.id === p.studentId);
  if (s) addFeed(`<b>${s.number}번 ${esc(s.name)}</b> 접속 종료`);
});

socket.on('focus:event', (ev) => {
  updateTile(ev.presence);
  const label = FOCUS_LABEL[ev.event] ?? ev.event;
  addFeed(`<b>${ev.number}번 ${esc(ev.name)}</b> ${label}`, FOCUS_CLASS[ev.event] ?? '');
  if (['paste_blocked', 'clipboard_changed', 'blur'].includes(ev.event)) {
    toast(`⚠ ${ev.number}번 ${ev.name}: ${label}`, 'warn');
  }
});

socket.on('exam:status', async (ev) => {
  if (ev.status === 'active') {
    activeExam = { id: ev.examId, title: activeExam?.title ?? '시험', status: 'active', endsAt: ev.endsAt };
    try { activeExam = { ...await api('GET', `/api/teacher/exams/${ev.examId}`), status: 'active' }; } catch { /* 무시 */ }
  } else {
    addFeed('시험이 종료되었습니다.', 'bad');
    activeExam = null;
  }
  renderBanner();
  if (monitorExamId === ev.examId) refreshMonitor();
});

// 답안 저장이 몰릴 때 과도한 새로고침 방지 (1.5초 스로틀)
let monitorRefreshPending = false;
socket.on('exam:progress', () => {
  if (!monitorExamId || monitorRefreshPending) return;
  monitorRefreshPending = true;
  setTimeout(() => { monitorRefreshPending = false; refreshMonitor(); }, 1500);
});

socket.on('exam:submitted', (ev) => {
  const s = students.find((x) => x.id === ev.studentId);
  if (s) addFeed(`<b>${s.number}번 ${esc(s.name)}</b> 시험 제출 완료`, 'good');
  if (monitorExamId === ev.examId) refreshMonitor();
});

socket.on('submission:received', (ev) => {
  addFeed(`<b>${ev.number}번 ${esc(ev.name)}</b> 과제 제출 (${ev.fileNames.map(esc).join(', ')})`, 'good');
  toast(`📥 ${ev.number}번 ${ev.name} 과제 제출`);
  const detail = $('#assignment-detail');
  if (!detail.classList.contains('hidden') && detail.dataset.assignmentId === ev.assignmentId) {
    openAssignmentDetail(ev.assignmentId, $('#asg-detail-title').textContent.replace('제출 현황 — ', ''));
  }
});

// ── 초기 로드 ─────────────────────────────
loadServerInfo();
loadStudents();
