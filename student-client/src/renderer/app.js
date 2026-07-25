/* global io */
// 학생 클라이언트 렌더러

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let serverUrl = localStorage.getItem('cs_server') ?? '';
let token = localStorage.getItem('cs_token') ?? '';
let student = JSON.parse(localStorage.getItem('cs_student') ?? 'null');
let socket = null;
let examData = null;       // /api/student/exams/active 응답
let serverOffset = 0;
let timerHandle = null;
let examLocked = false;

// ── 공통 ─────────────────────────────
function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(method, path, body, isForm = false) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(serverUrl + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ── 접속 ─────────────────────────────
$('#btn-discover').addEventListener('click', async () => {
  $('#connect-msg').textContent = '선생님 컴퓨터를 찾는 중...';
  const found = await window.classClient.discoverServer();
  if (found) {
    $('#in-server').value = `${found.address}:${found.port}`;
    $('#connect-msg').textContent = `찾음: ${found.name ?? '수업 서버'}`;
  } else {
    $('#connect-msg').textContent = '자동으로 찾지 못했습니다. 칠판의 주소를 직접 입력하세요.';
  }
});

$('#btn-join').addEventListener('click', join);
$('#in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

async function join() {
  const raw = $('#in-server').value.trim();
  if (!raw) { $('#connect-msg').textContent = '서버 주소를 입력하세요.'; return; }
  const [host, port] = raw.replace(/^https?:\/\//, '').split(':');
  serverUrl = `http://${host}:${port ?? 3690}`;
  const code = $('#in-code').value.trim().toUpperCase();
  $('#connect-msg').textContent = '접속 중...';
  try {
    const health = await fetch(`${serverUrl}/api/health`).then((r) => r.json());
    serverOffset = health.serverNow - Date.now();
    const res = await fetch(`${serverUrl}/api/auth/student`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? '접속 실패');
    token = data.token;
    student = data.student;
    localStorage.setItem('cs_server', serverUrl);
    localStorage.setItem('cs_token', token);
    localStorage.setItem('cs_student', JSON.stringify(student));
    await afterLogin();
  } catch (err) {
    $('#connect-msg').textContent = err.message === 'Failed to fetch'
      ? '서버에 연결할 수 없습니다. 주소를 확인하세요.' : err.message;
  }
}

async function afterLogin() {
  $('#home-student').textContent = `${student.number}번 ${student.name}`;
  await loadSocketIo();
  connectSocket();
  const hasExam = await checkActiveExam();
  if (!hasExam) {
    showScreen('screen-home');
    loadAssignments();
  }
}

// socket.io 클라이언트는 서버에서 로드 (별도 번들 불필요)
function loadSocketIo() {
  if (window.io) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${serverUrl}/socket.io/socket.io.js`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('socket.io 로드 실패'));
    document.head.appendChild(s);
  });
}

function connectSocket() {
  socket?.disconnect();
  socket = io(`${serverUrl}/student`, { auth: { token }, reconnectionDelayMax: 3000 });

  socket.on('connect', async () => {
    $('#conn-status').textContent = '연결됨';
    $('#conn-status').classList.remove('off');
    // 재접속 시 진행 중 시험 복구
    if (!examLocked) await checkActiveExam();
  });

  socket.on('disconnect', () => {
    $('#conn-status').textContent = '연결 끊김';
    $('#conn-status').classList.add('off');
    if (examLocked) $('#save-status').textContent = '⚠ 서버 연결 끊김 — 자동 재연결 중';
  });

  socket.on('exam:started', () => checkActiveExam());

  socket.on('exam:ended', () => {
    if (examLocked) endExamScreen('시험이 종료되었습니다', '답안이 제출되었습니다. 수고했어요!');
  });

  socket.on('assignment:published', (ev) => {
    toast(`새 과제: ${ev.title}`);
    if ($('#screen-home').classList.contains('active')) loadAssignments();
  });

  socket.on('assignment:closed', () => {
    if ($('#screen-home').classList.contains('active')) loadAssignments();
  });

  socket.on('session:kicked', (ev) => {
    alert(ev.reason ?? '다른 자리에서 접속되었습니다.');
    localStorage.removeItem('cs_token');
    location.reload();
  });

  socket.on('session:unlock', async () => {
    await window.classClient.unlock();
    examLocked = false;
    toast('선생님이 잠금을 해제했습니다. 이제 프로그램을 종료할 수 있습니다.');
  });
}

// ── 이탈/차단 이벤트 → 서버 보고 ─────────────────────────────
function reportFocus(event, meta = {}) {
  socket?.connected && socket.emit('focus:event', { event, meta });
}
window.classClient.onMainEvent((payload) => {
  if (payload.type === 'focus-event') reportFocus(payload.event, payload.meta ?? {});
  if (payload.type === 'close-attempt') openUnlockModal();
});
window.classClient.onBlocked(({ event, meta }) => reportFocus(event, meta));

// ── 과제 ─────────────────────────────
async function loadAssignments() {
  try {
    const list = await api('GET', '/api/student/assignments');
    $('#assignment-list').innerHTML = list.length ? list.map((a) => `
      <div class="asg-card" data-id="${a.id}">
        <div class="title">${esc(a.title)}
          ${a.status === 'closed' ? '<span class="muted">(마감)</span>' : ''}</div>
        ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}
        <div class="files">${a.files.map((f) =>
          `<button class="small" data-dl="${f.fileId}" data-name="${esc(f.name)}">⬇ ${esc(f.name)}</button>`).join('')}</div>
        ${a.mySubmission ? `<div class="badge-done">✅ 제출 완료 (${a.mySubmission.files.map(esc).join(', ')})</div>` : ''}
        ${a.status === 'published' && (!a.mySubmission || a.allowResubmit) ? `
          <div class="submit-row">
            <input type="file" multiple data-submit-input="${a.id}">
            <button class="primary" data-submit="${a.id}">${a.mySubmission ? '다시 제출' : '제출하기'}</button>
          </div>` : ''}
      </div>`).join('') : '<p class="muted">아직 받은 과제가 없습니다.</p>';
  } catch (err) {
    $('#assignment-list').innerHTML = `<p class="msg">${esc(err.message)}</p>`;
  }
}

$('#assignment-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const card = btn.closest('.asg-card');
  const aid = card?.dataset.id;

  if (btn.dataset.dl) {
    btn.disabled = true;
    const title = card.querySelector('.title').textContent.trim();
    const r = await window.classClient.downloadFile({
      url: `${serverUrl}/api/student/assignments/${aid}/files/${btn.dataset.dl}`,
      token,
      folder: title,
      filename: btn.dataset.name,
    });
    btn.disabled = false;
    if (r.ok) toast(`바탕화면 [받은과제] 폴더에 저장했습니다:\n${btn.dataset.name}`);
    else toast(`다운로드 실패: ${r.error}`);
  }

  if (btn.dataset.submit) {
    const input = card.querySelector(`[data-submit-input="${aid}"]`);
    if (!input.files.length) { toast('제출할 파일을 먼저 선택하세요.'); return; }
    const fd = new FormData();
    for (const f of input.files) fd.append('files', f);
    btn.disabled = true;
    try {
      await api('POST', `/api/student/assignments/${aid}/submit`, fd, true);
      toast('제출 완료!');
      await loadAssignments();
    } catch (err) { toast(`제출 실패: ${err.message}`); }
    btn.disabled = false;
  }
});

// ── 시험 ─────────────────────────────
async function checkActiveExam() {
  try {
    const data = await api('GET', '/api/student/exams/active');
    if (!data.exam || data.submitted) {
      if (examLocked) {
        // 시험이 이미 끝났는데 잠금 상태로 남아있으면 해제
        await window.classClient.unlock();
        examLocked = false;
      }
      return false;
    }
    examData = data;
    serverOffset = data.serverNow - Date.now();
    await enterExam();
    return true;
  } catch {
    return false;
  }
}

async function enterExam() {
  examLocked = true;
  await window.classClient.lock();
  $('#exam-title').textContent = examData.exam.title;
  renderExamQuestions();
  showScreen('screen-exam');
  startTimer();
  reportFocus('focus', { note: 'exam_enter' });
}

function renderExamQuestions() {
  $('#exam-questions').innerHTML = examData.questions.map((q) => {
    const saved = examData.answers[q.id];
    if (q.type === 'mc') {
      return `<div class="question" id="qbox-${q.id}">
        <div class="q-text">${q.no}. ${esc(q.text)}<span class="q-points">[${q.points}점]</span></div>
        ${q.choices.map((c, ci) => `
          <label class="choice ${saved?.choiceId === c.id ? 'selected' : ''}">
            <input type="radio" name="q-${q.id}" value="${c.id}" ${saved?.choiceId === c.id ? 'checked' : ''}>
            <span>${'①②③④⑤⑥⑦⑧⑨⑩'[ci] ?? ci + 1} ${esc(c.text)}</span>
          </label>`).join('')}
      </div>`;
    }
    return `<div class="question" id="qbox-${q.id}">
      <div class="q-text">${q.no}. ${esc(q.text)}<span class="q-points">[${q.points}점] 서술형</span></div>
      <textarea data-essay="${q.id}" placeholder="답안을 직접 입력하세요. (붙여넣기 사용 불가)">${esc(saved?.text ?? '')}</textarea>
    </div>`;
  }).join('');
  renderProgressNav();

  // 객관식 선택
  $('#exam-questions').querySelectorAll('input[type=radio]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const qid = radio.name.slice(2);
      const box = $(`#qbox-${qid}`);
      box.querySelectorAll('.choice').forEach((c) => c.classList.toggle('selected', c.querySelector('input').checked));
      saveAnswer(qid, { choiceId: radio.value });
    });
  });

  // 서술형 입력 (1초 디바운스 자동 저장)
  const debounces = {};
  $('#exam-questions').querySelectorAll('textarea[data-essay]').forEach((ta) => {
    ta.addEventListener('input', () => {
      const qid = ta.dataset.essay;
      clearTimeout(debounces[qid]);
      $('#save-status').textContent = '입력 중...';
      debounces[qid] = setTimeout(() => saveAnswer(qid, { text: ta.value }), 1000);
    });
  });
}

function renderProgressNav() {
  $('#exam-progress').innerHTML = examData.questions.map((q) => {
    const a = examData.answers[q.id];
    const answered = a && (q.type === 'mc' ? a.choiceId != null : (a.text ?? '').trim() !== '');
    return `<button class="${answered ? 'answered' : ''}" data-goto="${q.id}">${q.no}</button>`;
  }).join('');
}
$('#exam-progress').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn?.dataset.goto) $(`#qbox-${btn.dataset.goto}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function saveAnswer(questionId, answer) {
  examData.answers[questionId] = { ...answer, savedAt: Date.now() };
  renderProgressNav();
  const payload = { examId: examData.exam.id, questionId, answer };
  const onSaved = (savedAt) => {
    $('#save-status').textContent = `저장됨 ${new Date(savedAt).toLocaleTimeString('ko-KR', { hour12: false })}`;
  };
  if (socket?.connected) {
    socket.emit('exam:answer', payload, (res) => {
      if (res?.ok) onSaved(res.savedAt);
      else if (res) $('#save-status').textContent = `⚠ ${res.error}`;
    });
  } else {
    // 소켓 끊김 시 HTTP 폴백
    api('POST', `/api/student/exams/${examData.exam.id}/answer`, { questionId, answer })
      .then((r) => onSaved(r.savedAt))
      .catch((err) => { $('#save-status').textContent = `⚠ 저장 실패: ${err.message}`; });
  }
}

function startTimer() {
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const remain = examData.exam.endsAt - (Date.now() + serverOffset);
    const el = $('#exam-timer');
    el.textContent = `남은 시간 ${fmtDur(remain)}`;
    el.classList.toggle('danger', remain < 5 * 60 * 1000);
    if (remain <= 0) {
      el.textContent = '시간 종료';
      clearInterval(timerHandle);
      $('#save-status').textContent = '시간 종료 — 자동 제출 처리 중';
    }
  }, 500);
}

async function submitExam() {
  const total = examData.questions.length;
  const answered = examData.questions.filter((q) => {
    const a = examData.answers[q.id];
    return a && (q.type === 'mc' ? a.choiceId != null : (a.text ?? '').trim() !== '');
  }).length;
  const warn = answered < total ? `\n(아직 안 푼 문제가 ${total - answered}개 있습니다!)` : '';
  if (!confirm(`시험을 제출할까요? 제출 후에는 수정할 수 없습니다.${warn}`)) return;

  const done = () => endExamScreen('제출 완료', '답안이 제출되었습니다. 수고했어요!');
  if (socket?.connected) {
    socket.emit('exam:submit', { examId: examData.exam.id }, (res) => {
      if (res?.ok) done();
      else toast(res?.error ?? '제출 실패');
    });
  } else {
    try {
      await api('POST', `/api/student/exams/${examData.exam.id}/submit`);
      done();
    } catch (err) { toast(`제출 실패: ${err.message}`); }
  }
}
$('#btn-submit-exam').addEventListener('click', submitExam);
$('#btn-submit-exam2').addEventListener('click', submitExam);

async function endExamScreen(title, msg) {
  clearInterval(timerHandle);
  examLocked = false;
  await window.classClient.unlock();
  $('#done-title').textContent = title;
  $('#done-msg').textContent = msg;
  showScreen('screen-done');
}

$('#btn-done-home').addEventListener('click', () => {
  showScreen('screen-home');
  loadAssignments();
});

// ── 종료/잠금 해제 ─────────────────────────────
function openUnlockModal() {
  $('#unlock-msg').textContent = '';
  $('#in-unlock').value = '';
  $('#unlock-modal').classList.remove('hidden');
  $('#in-unlock').focus();
}

$('#btn-exit').addEventListener('click', async () => {
  if (examLocked) { openUnlockModal(); return; }
  await window.classClient.quitApp();
});

$('#btn-unlock-cancel').addEventListener('click', () => $('#unlock-modal').classList.add('hidden'));
$('#btn-unlock-ok').addEventListener('click', async () => {
  const code = $('#in-unlock').value.trim().toUpperCase();
  try {
    const res = await fetch(`${serverUrl}/api/student/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? '해제 실패');
    await window.classClient.quitApp();
  } catch (err) {
    $('#unlock-msg').textContent = err.message;
  }
});

// ── 시작: 저장된 세션으로 자동 재접속 ─────────────────────────────
(async () => {
  if (serverUrl && token && student) {
    try {
      const health = await fetch(`${serverUrl}/api/health`).then((r) => r.json());
      serverOffset = health.serverNow - Date.now();
      await afterLogin();
      return;
    } catch { /* 서버 없음 → 접속 화면 */ }
  }
  showScreen('screen-connect');
})();
