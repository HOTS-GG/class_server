/* global io, csDialog */
// 학생 클라이언트 렌더러
// 브라우저 기본 alert/confirm은 Electron에서 창 제목에 exe 이름이 뜨고 닫힌 뒤 입력칸 포커스가 풀리므로 csDialog만 사용한다.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;', '>': '&gt;' }[c]));

// Electron 밖(일반 브라우저)에서 화면을 확인할 때를 위한 대체 API. 실제 배포에서는 preload가 제공한다.
window.classClient ??= {
  lock: async () => {}, unlock: async () => {}, quitApp: async () => window.close(),
  discoverServer: async () => null, isDev: async () => true,
  downloadFile: async () => ({ ok: false, error: '브라우저 모드에서는 다운로드할 수 없습니다.' }),
  onMainEvent: () => {}, onBlocked: () => {},
};

let serverUrl = localStorage.getItem('cs_server') ?? '';
let token = localStorage.getItem('cs_token') ?? '';
let student = JSON.parse(localStorage.getItem('cs_student') ?? 'null');
let socket = null;
let examData = null;       // /api/student/exams/active 응답
let serverOffset = 0;
let timerHandle = null;
let examLocked = false;
let viewingResultExamId = null;
let lastSavedAt = null;
let serverHealth = null;
const inExamScreen = () => $('#screen-exam').classList.contains('active');

const ATTACH_HELP = 'PDF · PNG/JPG/WEBP 이미지 · TXT/MD 파일, 10MB 이하. 컴퓨터로 작성한 파일만 첨부하세요. 종이에 쓴 답안을 사진·스캔한 파일은 정확히 채점되지 않습니다.';

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
const fmtKb = (n) => `${Math.max(1, Math.round((n ?? 0) / 1024))}KB`;

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
    $('#connect-msg').textContent = '';
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
  if (!hasExam) goHome();
}

// 홈 화면(과제/시험 탭)으로 이동하며 목록 갱신
function goHome() {
  showScreen('screen-home');
  loadAssignments();
  loadResults();
  renderExamTab();
}

// ── 홈 탭 (과제 / 시험) ─────────────────────────────
$$('.home-tabs button').forEach((btn) => btn.addEventListener('click', () => {
  $$('.home-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.home-tab').forEach((t) => t.classList.toggle('active', t.id === `home-${btn.dataset.homeTab}`));
  if (btn.dataset.homeTab === 'exams') { loadResults(); renderExamTab(); }
  else loadAssignments();
}));

// 시험 탭 상단: 진행 중 시험 상태 카드
async function renderExamTab() {
  const box = $('#exam-active-card');
  try {
    const data = await api('GET', '/api/student/exams/active');
    if (!data.exam) { box.innerHTML = ''; return; }
    if (data.submitted) {
      box.innerHTML = `<div class="notice info">📝 <b>${esc(data.exam.title)}</b> — 제출 완료. 시험이 끝나고 선생님이 성적을 공개하면 아래에 결과가 나타납니다.</div>`;
    } else {
      box.innerHTML = `<div class="notice">📝 <b>${esc(data.exam.title)}</b> 진행 중 <span class="sep"></span><button class="primary" id="btn-enter-exam">시험 화면으로</button></div>`;
      $('#btn-enter-exam').addEventListener('click', () => checkActiveExam());
    }
  } catch { box.innerHTML = ''; }
}

// ── 연결 상태 창 ─────────────────────────────
async function renderConnModal() {
  const rows = [];
  const ok = (b) => (b ? '<span class="pill on">정상</span>' : '<span class="pill off">끊김</span>');
  rows.push(['서버 주소', esc(serverUrl)]);
  rows.push(['내 정보', `${esc(student?.number)}번 ${esc(student?.name)}`]);
  rows.push(['실시간 연결(소켓)', `${ok(socket?.connected)} ${socket?.connected ? esc(socket.io.engine.transport.name) : '재연결 시도 중'}`]);
  let reach = null; let ms = null;
  try {
    const t0 = performance.now();
    serverHealth = await fetch(`${serverUrl}/api/health`).then((r) => r.json());
    ms = Math.round(performance.now() - t0);
    reach = true;
    serverOffset = serverHealth.serverNow - Date.now();
  } catch { reach = false; }
  rows.push(['서버 응답', reach ? `${ok(true)} ${ms}ms` : ok(false)]);
  if (serverHealth) {
    rows.push(['서버 이름', esc(serverHealth.name)]);
    rows.push(['서버 버전', esc(serverHealth.version)]);
    rows.push(['시계 차이', `${Math.round(serverOffset / 1000)}초 (서버 기준으로 타이머 보정)`]);
  }
  rows.push(['마지막 답안 저장', lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString('ko-KR', { hour12: false }) : '—']);
  rows.push(['미저장 답안', pending.size ? `<span class="pill warn">${pending.size}개 재시도 중</span>` : '없음']);
  rows.push(['시험 잠금', examLocked ? '잠금 중 (전체화면)' : '없음']);
  $('#conn-table').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}
$('#conn-status').addEventListener('click', async () => {
  $('#conn-modal').classList.remove('hidden');
  await renderConnModal();
});
$('#btn-conn-refresh').addEventListener('click', renderConnModal);
$('#btn-conn-close').addEventListener('click', () => $('#conn-modal').classList.add('hidden'));

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
    $('#conn-status').classList.add('on');
    // 재접속 시 진행 중 시험 복구 / 끊긴 사이에 끝난 시험 정리, 밀린 답안 재전송
    await checkActiveExam();
    flushPending();
  });

  socket.on('disconnect', () => {
    $('#conn-status').textContent = '연결 끊김';
    $('#conn-status').classList.add('off');
    $('#conn-status').classList.remove('on');
    if (examLocked) $('#save-status').textContent = '⚠ 서버 연결 끊김 — 자동 재연결 중';
  });

  socket.on('exam:started', () => checkActiveExam());

  // 교사 종료/시간 종료: 잠금 여부와 관계없이 시험 화면에 있으면 종료 화면으로
  socket.on('exam:ended', () => {
    if (inExamScreen()) endExamScreen('시험이 종료되었습니다', '답안이 제출되었습니다. 수고했어요!');
    else renderExamTab();
  });

  socket.on('assignment:published', (ev) => {
    toast(`새 과제: ${ev.title}`);
    if ($('#screen-home').classList.contains('active')) loadAssignments();
  });

  socket.on('assignment:closed', () => {
    if ($('#screen-home').classList.contains('active')) loadAssignments();
  });

  socket.on('assignment:updated', (ev) => {
    toast(`과제가 수정되었습니다: ${ev.title}`);
    if ($('#screen-home').classList.contains('active')) loadAssignments();
  });

  socket.on('exam:results-published', (ev) => {
    toast(`📊 "${ev.title}" 성적이 공개되었습니다. [시험] 탭에서 확인하세요.`);
    if ($('#screen-home').classList.contains('active')) { loadResults(); renderExamTab(); }
  });

  // 서술형 채점(AI 반영/교사 채점)으로 점수·피드백이 바뀌면 화면 갱신
  socket.on('exam:results-updated', (ev) => {
    if ($('#screen-home').classList.contains('active')) loadResults();
    if ($('#screen-result').classList.contains('active') && viewingResultExamId === ev.examId) {
      openResult(ev.examId, true);
      toast('채점 결과가 갱신되었습니다.');
    }
  });

  socket.on('session:kicked', async (ev) => {
    await csDialog.alert(ev.reason ?? '다른 자리에서 접속되었습니다.', { title: '접속 종료' });
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
    $('#asg-count').textContent = list.filter((a) => a.status === 'published' && !a.mySubmission).length || '';
    $('#assignment-list').innerHTML = list.length ? list.map((a) => `
      <div class="asg-card" data-id="${a.id}">
        <div class="title">${a.subjectName ? `<span class="pill">${esc(a.subjectName)}</span> ` : ''}${esc(a.title)}
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

// ── 시험 결과(성적 공개) ─────────────────────────────
async function loadResults() {
  try {
    const list = await api('GET', '/api/student/exams/results');
    $('#exam-count').textContent = list.length || '';
    if (!list.length) { $('#result-list').innerHTML = '<p class="muted">공개된 시험 결과가 없습니다.</p>'; return; }
    $('#result-list').innerHTML = list.map((r) => {
      const pending = r.essayTotal > r.essayGraded;
      return `<div class="result-card">
        <span class="title">${r.subjectName ? `<span class="pill">${esc(r.subjectName)}</span> ` : ''}${esc(r.title)}</span>
        ${pending ? `<span class="pill warn">서술형 채점 중 (${r.essayGraded}/${r.essayTotal})</span>` : ''}
        <span class="score">${r.total ?? '-'} / ${r.maxTotal ?? '-'}점</span>
        <button class="small" data-result="${r.examId}">자세히 보기</button>
      </div>`;
    }).join('');
  } catch { /* 서버 연결 문제 시 다음 새로고침에서 재시도 */ }
}

$('#result-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-result]');
  if (btn) openResult(btn.dataset.result);
});

async function openResult(examId, silent = false) {
  try {
    const r = await api('GET', `/api/student/exams/${examId}/result`);
    viewingResultExamId = examId;
    $('#result-title').textContent = r.exam.title;
    $('#result-total').textContent = `${r.total ?? '-'} / ${r.maxTotal ?? '-'}점`;
    const pendingNote = r.essayTotal > r.essayGraded
      ? `<div class="notice info result-summary">서술형 ${r.essayTotal - r.essayGraded}문항은 아직 채점 중입니다. 채점이 끝나면 점수와 피드백이 자동으로 갱신됩니다.</div>`
      : '';
    $('#result-content').innerHTML = pendingNote + r.questions.map((q) => {
      let mark;
      if (q.type === 'essay') {
        mark = q.earned == null ? '<span class="muted">채점 중</span>'
          : q.earned >= q.points ? '<span class="result-mark-o">⭕ 만점</span>'
            : q.earned > 0 ? `<span class="result-mark-p">△ ${q.earned}점</span>`
              : '<span class="result-mark-x">❌ 0점</span>';
      } else {
        mark = q.earned === q.points ? '<span class="result-mark-o">⭕ 정답</span>'
          : q.earned > 0 ? `<span class="result-mark-p">△ 부분점수 ${q.earned}점</span>`
            : '<span class="result-mark-x">❌ 오답</span>';
      }
      const myAnswer = q.myAnswer?.trim() ? esc(q.myAnswer) : (q.myFile ? '' : '무응답');
      return `<div class="question">
        <div class="q-text">${q.no}. ${esc(q.text)}
          <span class="q-points">[${q.points}점 중 ${q.earned ?? '-'}점]</span> ${mark}</div>
        <div class="result-answer">
          내 답: <b>${myAnswer}</b>${q.myFile ? ` <span class="muted">📎 첨부: ${esc(q.myFile)}</span>` : ''}
          ${q.correctAnswer != null ? `<br>정답: <b class="result-correct">${esc(q.correctAnswer)}</b>` : ''}
        </div>
        ${q.feedback ? `<div class="feedback-box"><b>선생님 피드백</b><br>${esc(q.feedback)}</div>` : ''}
      </div>`;
    }).join('');
    if (!silent) showScreen('screen-result');
  } catch (err) { toast(err.message); }
}

$('#btn-result-back').addEventListener('click', () => {
  viewingResultExamId = null;
  showScreen('screen-home');
  $$('.home-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.homeTab === 'exams'));
  $$('.home-tab').forEach((t) => t.classList.toggle('active', t.id === 'home-exams'));
  loadResults();
});

// ── 시험 ─────────────────────────────
async function checkActiveExam() {
  try {
    const data = await api('GET', '/api/student/exams/active');
    if (!data.exam || data.submitted) {
      if (inExamScreen()) {
        // 연결이 끊긴 사이에 시험이 끝났거나(교사 종료·시간 종료) 이미 제출 처리된 경우
        await endExamScreen('시험이 종료되었습니다', '답안이 제출되었습니다. 수고했어요!');
      } else if (examLocked) {
        // 시험이 이미 끝났는데 잠금 상태로 남아있으면 해제
        await window.classClient.unlock();
        examLocked = false;
      }
      return false;
    }
    serverOffset = data.serverNow - Date.now();
    if (inExamScreen() && examData?.exam?.id === data.exam.id) {
      // 재접속: 작성 중인 화면을 다시 그리지 않고 종료 시각만 동기화
      examData.exam.endsAt = data.exam.endsAt;
      return true;
    }
    examData = data;
    await enterExam();
    return true;
  } catch {
    return false;
  }
}

async function enterExam() {
  // 전체화면 잠금은 교사가 시험 시작 시 선택한 경우에만 (기본: 일반 창 유지)
  examLocked = examData.exam.lockdown === true;
  if (examLocked) await window.classClient.lock();
  $('#exam-title').textContent = examData.exam.title;
  renderExamQuestions();
  showScreen('screen-exam');
  startTimer();
  reportFocus('focus', { note: 'exam_enter' });
}

function attachRow(q, saved) {
  const f = saved?.file;
  return `<div class="attach-row" data-attach="${q.id}">
    ${f ? `<span class="file-chip">📎 ${esc(f.name)} (${fmtKb(f.size)})</span>
           <button class="small" data-attach-remove="${q.id}">첨부 삭제</button>
           <span class="muted">다른 파일을 올리면 교체됩니다.</span>`
    : '<span class="muted">첨부 파일 없음</span>'}
    <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md" data-attach-input="${q.id}">
    <button class="small primary" data-attach-upload="${q.id}">파일 첨부</button>
    <div class="attach-help">${ATTACH_HELP}</div>
  </div>`;
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
    if (q.type === 'short') {
      return `<div class="question" id="qbox-${q.id}">
        <div class="q-text">${q.no}. ${esc(q.text)}<span class="q-points">[${q.points}점] 단답형</span></div>
        <input type="text" class="short-input" data-shortq="${q.id}" value="${esc(saved?.text ?? '')}"
          placeholder="정답을 직접 입력하세요. (붙여넣기 사용 불가)">
      </div>`;
    }
    return `<div class="question" id="qbox-${q.id}">
      <div class="q-text">${q.no}. ${esc(q.text)}<span class="q-points">[${q.points}점] 서술형${q.allowFile ? ' · 파일 첨부 가능' : ''}</span></div>
      <textarea data-essay="${q.id}" placeholder="답안을 직접 입력하세요. (붙여넣기 사용 불가)">${esc(saved?.text ?? '')}</textarea>
      ${q.allowFile ? attachRow(q, saved) : ''}
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

  // 단답형/서술형 입력 (1초 디바운스 자동 저장)
  const debounces = {};
  const bindTextSave = (el, qid) => {
    el.addEventListener('input', () => {
      clearTimeout(debounces[qid]);
      $('#save-status').textContent = '입력 중...';
      debounces[qid] = setTimeout(() => saveAnswer(qid, { text: el.value }), 1000);
    });
  };
  $('#exam-questions').querySelectorAll('textarea[data-essay]').forEach((ta) => bindTextSave(ta, ta.dataset.essay));
  $('#exam-questions').querySelectorAll('input[data-shortq]').forEach((inp) => bindTextSave(inp, inp.dataset.shortq));
}

// 서술형 파일 첨부/삭제
$('#exam-questions').addEventListener('click', async (e) => {
  const up = e.target.closest('button[data-attach-upload]');
  const rm = e.target.closest('button[data-attach-remove]');
  if (!up && !rm) return;
  const qid = up ? up.dataset.attachUpload : rm.dataset.attachRemove;
  const q = examData.questions.find((x) => x.id === qid);
  if (!q) return;
  const btn = up ?? rm;
  btn.disabled = true;
  try {
    let r;
    if (up) {
      const input = $(`#exam-questions [data-attach-input="${qid}"]`);
      const file = input?.files?.[0];
      if (!file) { toast('첨부할 파일을 먼저 선택하세요.'); btn.disabled = false; return; }
      const fd = new FormData();
      fd.append('questionId', qid);
      fd.append('file', file);
      r = await api('POST', `/api/student/exams/${examData.exam.id}/answer-file`, fd, true);
      examData.answers[qid] = { ...(examData.answers[qid] ?? { text: '' }), file: r.file, savedAt: r.savedAt };
      toast(`첨부했습니다: ${file.name}`);
    } else {
      if (!await csDialog.confirm('첨부 파일을 삭제할까요?', { title: '첨부 삭제', danger: true, okText: '삭제' })) { btn.disabled = false; return; }
      r = await api('POST', `/api/student/exams/${examData.exam.id}/answer-file/remove`, { questionId: qid });
      const cur = { ...(examData.answers[qid] ?? { text: '' }), savedAt: r.savedAt };
      delete cur.file;
      examData.answers[qid] = cur;
      toast('첨부를 삭제했습니다.');
    }
    // 텍스트는 그대로 두고 첨부 영역만 다시 그림
    const row = $(`#exam-questions [data-attach="${qid}"]`);
    if (row) row.outerHTML = attachRow(q, examData.answers[qid]);
    lastSavedAt = r.savedAt;
    $('#save-status').textContent = `저장됨 ${new Date(r.savedAt).toLocaleTimeString('ko-KR', { hour12: false })}`;
    renderProgressNav();
  } catch (err) {
    toast(`첨부 실패: ${err.message}`);
    btn.disabled = false;
  }
});

const isAnswered = (q) => {
  const a = examData.answers[q.id];
  return !!a && (q.type === 'mc' ? a.choiceId != null : ((a.text ?? '').trim() !== '' || !!a.file));
};

function renderProgressNav() {
  $('#exam-progress').innerHTML = examData.questions.map((q) =>
    `<button class="${isAnswered(q) ? 'answered' : ''}" data-goto="${q.id}">${q.no}</button>`).join('');
  renderOmr();
}

// 답안 표기란(OMR): 문제 영역과 분리된 선택란. 클릭 시 해당 문항 답이 선택된다.
function renderOmr() {
  const typeShort = { short: '단답', essay: '서술' };
  $('#omr-panel').innerHTML = '<div class="omr-title">답안 표기란</div>' + examData.questions.map((q) => {
    if (q.type === 'mc') {
      const a = examData.answers[q.id];
      return `<div class="omr-row"><span class="omr-no">${q.no}</span>` +
        q.choices.map((c, ci) =>
          `<button class="omr-bubble ${a?.choiceId === c.id ? 'filled' : ''}"
            data-omr-q="${q.id}" data-omr-c="${c.id}" title="${q.no}번 ${ci + 1}번 보기">${ci + 1}</button>`).join('') +
        '</div>';
    }
    const done = isAnswered(q);
    return `<div class="omr-row"><span class="omr-no">${q.no}</span>
      <span class="omr-label ${done ? 'filled' : ''}" data-omr-goto="${q.id}">${typeShort[q.type]}${done ? ' ✓ 작성함' : ' — 미작성'}</span></div>`;
  }).join('');
}

$('#omr-panel').addEventListener('click', (e) => {
  const bubble = e.target.closest('button[data-omr-q]');
  if (bubble) {
    const radio = document.querySelector(`input[name="q-${bubble.dataset.omrQ}"][value="${bubble.dataset.omrC}"]`);
    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change')); // 문제 영역과 동기화 + 저장
    }
    $(`#qbox-${bubble.dataset.omrQ}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const label = e.target.closest('[data-omr-goto]');
  if (label) $(`#qbox-${label.dataset.omrGoto}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#exam-progress').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn?.dataset.goto) $(`#qbox-${btn.dataset.goto}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ── 답안 저장: 실패해도 잃지 않는다 ─────────────────────────────
// 저장 요청이 실패하면 pending에 남겨 두고 2초→4초→…최대 15초 간격으로 재시도한다.
// 소켓이 다시 붙으면 즉시 밀린 답안을 한꺼번에 보낸다. 제출 직전에는 전체 답안을 한 번 더 동기화한다.
const pending = new Map();   // questionId → { answer, savedAt }
let retryTimer = null;
let retryDelay = 2000;

function setSaveStatus() {
  const el = $('#save-status');
  if (pending.size) {
    el.textContent = `⚠ 미저장 ${pending.size}개 — 재시도 중`;
    el.classList.add('unsaved');
  } else {
    el.classList.remove('unsaved');
    el.textContent = lastSavedAt ? `저장됨 ${new Date(lastSavedAt).toLocaleTimeString('ko-KR', { hour12: false })}` : '';
  }
}

function markSaved(questionId, localSavedAt, serverSavedAt) {
  const p = pending.get(questionId);
  if (p && p.savedAt === localSavedAt) pending.delete(questionId); // 그 사이 더 새 답이 들어왔으면 그것은 남긴다
  lastSavedAt = serverSavedAt ?? Date.now();
  if (!pending.size) retryDelay = 2000;
  setSaveStatus();
}

// 한 답안을 서버로 보낸다. 서버가 "거부"(시험 종료·잘못된 선택지 등)하면 재시도하지 않는다.
function sendAnswer(questionId, answer, localSavedAt) {
  const examId = examData.exam.id;
  const reject = (msg) => { pending.delete(questionId); $('#save-status').textContent = `⚠ ${msg}`; };
  if (socket?.connected) {
    socket.emit('exam:answer', { examId, questionId, answer }, (res) => {
      if (res?.ok) markSaved(questionId, localSavedAt, res.savedAt);
      else if (res) reject(res.error);
      else scheduleRetry();
    });
    return;
  }
  api('POST', `/api/student/exams/${examId}/answer`, { questionId, answer })
    .then((r) => markSaved(questionId, localSavedAt, r.savedAt))
    .catch((err) => {
      if (/종료|제출한|대상이 아닙|존재하지|잘못된 선택지/.test(err.message)) reject(err.message);
      else scheduleRetry();
    });
}

function scheduleRetry() {
  setSaveStatus();
  if (retryTimer || !pending.size) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, 15000);
    flushPending();
  }, retryDelay);
}

// 밀린 답안 전부 재전송 (재접속 직후, 재시도 타이머)
function flushPending() {
  if (!examData || !pending.size) return;
  if (socket?.connected) {
    const answers = {};
    for (const [qid, p] of pending) answers[qid] = { ...p.answer, savedAt: p.savedAt };
    const sentAt = new Map([...pending].map(([qid, p]) => [qid, p.savedAt]));
    socket.emit('exam:sync', { examId: examData.exam.id, answers }, (res) => {
      if (res?.ok) { for (const [qid, at] of sentAt) markSaved(qid, at, Date.now()); setSaveStatus(); }
      else if (res && /종료|제출한|대상이 아닙/.test(res.error ?? '')) { pending.clear(); $('#save-status').textContent = `⚠ ${res.error}`; }
      else scheduleRetry();
    });
    return;
  }
  for (const [qid, p] of pending) sendAnswer(qid, p.answer, p.savedAt);
  scheduleRetry();
}

// 제출 직전: 현재 화면의 모든 답안을 서버와 맞춘다. 성공하면 true.
async function syncAllAnswers() {
  if (!examData) return true;
  const answers = {};
  for (const [qid, a] of Object.entries(examData.answers)) {
    if (a.choiceId != null || (a.text ?? '') !== '') answers[qid] = { choiceId: a.choiceId, text: a.text, savedAt: a.savedAt };
  }
  try {
    const r = socket?.connected
      ? await new Promise((resolve, reject) => socket.emit('exam:sync', { examId: examData.exam.id, answers }, (res) => (res?.ok ? resolve(res) : reject(new Error(res?.error ?? '동기화 실패')))))
      : await api('POST', `/api/student/exams/${examData.exam.id}/sync`, { answers });
    pending.clear();
    lastSavedAt = Date.now();
    setSaveStatus();
    return !r.errors?.length;
  } catch (err) {
    $('#save-status').textContent = `⚠ 동기화 실패: ${err.message}`;
    return false;
  }
}

function saveAnswer(questionId, answer) {
  const prev = examData.answers[questionId];
  const savedAt = Date.now();
  examData.answers[questionId] = { ...answer, savedAt, ...(prev?.file ? { file: prev.file } : {}) };
  renderProgressNav();
  pending.set(questionId, { answer, savedAt });
  setSaveStatus();
  sendAnswer(questionId, answer, savedAt);
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
  const answered = examData.questions.filter(isAnswered).length;
  const warn = answered < total ? `\n(아직 안 푼 문제가 ${total - answered}개 있습니다!)` : '';
  if (!await csDialog.confirm(`시험을 제출할까요? 제출 후에는 수정할 수 없습니다.${warn}`, { title: '시험 제출', okText: '제출' })) return;

  // 제출 전에 모든 답안을 서버와 한 번 더 맞춘다. 실패하면 학생이 선택.
  $('#save-status').textContent = '답안 확인 중…';
  const synced = await syncAllAnswers();
  if (!synced) {
    const go = await csDialog.confirm('일부 답안을 서버에 저장하지 못했습니다.\n선생님께 알리고 잠시 후 다시 시도하는 것을 권합니다.\n그래도 지금 제출할까요? (저장되지 않은 답은 빠질 수 있습니다)', { title: '저장 확인', danger: true, okText: '그래도 제출', cancelText: '다시 시도' });
    if (!go) { flushPending(); return; }
  }

  const instant = examData.exam.instantResults === true;
  const done = () => endExamScreen('제출 완료',
    instant ? '답안이 제출되었습니다. 시험이 끝나면 홈 화면의 [시험 결과]에서 점수를 바로 볼 수 있어요.'
      : '답안이 제출되었습니다. 수고했어요!');
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
  clearTimeout(retryTimer); retryTimer = null; pending.clear();
  examLocked = false;
  await window.classClient.unlock();
  $('#done-title').textContent = title;
  $('#done-msg').textContent = msg;
  showScreen('screen-done');
}

$('#btn-done-home').addEventListener('click', () => {
  goHome();
  $$('.home-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.homeTab === 'exams'));
  $$('.home-tab').forEach((t) => t.classList.toggle('active', t.id === 'home-exams'));
});

// ── 종료/잠금 해제 ─────────────────────────────
function openUnlockModal() {
  $('#unlock-msg').textContent = '';
  $('#in-unlock').value = '';
  $('#unlock-modal').classList.remove('hidden');
  $('#in-unlock').focus();
}

// 로그아웃: 저장된 학생 정보를 지우고 접속 화면으로 (공용 PC에서 다음 학생이 자기 코드로 접속하도록)
function clearSession() {
  socket?.disconnect();
  socket = null;
  token = '';
  student = null;
  examData = null;
  localStorage.removeItem('cs_token');
  localStorage.removeItem('cs_student');
  $('#in-code').value = '';
  $('#connect-msg').textContent = '';
  if (serverUrl) $('#in-server').value = serverUrl.replace(/^https?:\/\//, '');
  showScreen('screen-connect');
  $('#in-code').focus();
}

$('#btn-logout').addEventListener('click', async () => {
  if (examLocked) { openUnlockModal(); return; }
  if (!await csDialog.confirm(`${student?.number}번 ${student?.name} 계정에서 로그아웃할까요?\n다음 학생은 자기 접속 코드로 접속하면 됩니다.`, { title: '로그아웃', okText: '로그아웃' })) return;
  clearSession();
});

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

// ── 시작 ─────────────────────────────
// 자동 재접속은 "그 학생의 시험이 진행 중"일 때만 한다 (프로그램이 꺼져도 시험을 이어가기 위해).
// 그 외에는 공용 PC에서 이전 학생으로 자동 로그인되지 않도록 접속 화면을 보여 준다(서버 주소만 기억).
(async () => {
  if (serverUrl && token && student) {
    try {
      const health = await fetch(`${serverUrl}/api/health`).then((r) => r.json());
      serverOffset = health.serverNow - Date.now();
      const active = await api('GET', '/api/student/exams/active');
      if (active.exam && !active.submitted) {
        await afterLogin();
        return;
      }
    } catch { /* 서버 없음 또는 토큰 만료 → 접속 화면 */ }
    token = '';
    student = null;
    localStorage.removeItem('cs_token');
    localStorage.removeItem('cs_student');
  }
  if (serverUrl) $('#in-server').value = serverUrl.replace(/^https?:\/\//, '');
  showScreen('screen-connect');
})();
