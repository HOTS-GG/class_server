/* global io */
// 학생 클라이언트 렌더러

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
  if (!hasExam) {
    showScreen('screen-home');
    loadAssignments();
    loadResults();
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
    $('#conn-status').classList.add('on');
    // 재접속 시 진행 중 시험 복구
    if (!examLocked) await checkActiveExam();
  });

  socket.on('disconnect', () => {
    $('#conn-status').textContent = '연결 끊김';
    $('#conn-status').classList.add('off');
    $('#conn-status').classList.remove('on');
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

  socket.on('exam:results-published', (ev) => {
    toast(`📊 "${ev.title}" 성적이 공개되었습니다. 홈 화면에서 확인하세요.`);
    if ($('#screen-home').classList.contains('active')) loadResults();
  });

  // 서술형 채점(AI 반영/교사 채점)으로 점수·피드백이 바뀌면 화면 갱신
  socket.on('exam:results-updated', (ev) => {
    if ($('#screen-home').classList.contains('active')) loadResults();
    if ($('#screen-result').classList.contains('active') && viewingResultExamId === ev.examId) {
      openResult(ev.examId, true);
      toast('채점 결과가 갱신되었습니다.');
    }
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

// ── 시험 결과(성적 공개) ─────────────────────────────
async function loadResults() {
  try {
    const list = await api('GET', '/api/student/exams/results');
    $('#results-section').classList.toggle('hidden', !list.length);
    $('#result-list').innerHTML = list.map((r) => {
      const pending = r.essayTotal > r.essayGraded;
      return `<div class="result-card">
        <span class="title">${esc(r.title)}</span>
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
  loadResults();
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
      if (!confirm('첨부 파일을 삭제할까요?')) { btn.disabled = false; return; }
      r = await api('POST', `/api/student/exams/${examData.exam.id}/answer-file/remove`, { questionId: qid });
      const cur = { ...(examData.answers[qid] ?? { text: '' }), savedAt: r.savedAt };
      delete cur.file;
      examData.answers[qid] = cur;
      toast('첨부를 삭제했습니다.');
    }
    // 텍스트는 그대로 두고 첨부 영역만 다시 그림
    const row = $(`#exam-questions [data-attach="${qid}"]`);
    if (row) row.outerHTML = attachRow(q, examData.answers[qid]);
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

function saveAnswer(questionId, answer) {
  const prev = examData.answers[questionId];
  examData.answers[questionId] = { ...answer, savedAt: Date.now(), ...(prev?.file ? { file: prev.file } : {}) };
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
  const answered = examData.questions.filter(isAnswered).length;
  const warn = answered < total ? `\n(아직 안 푼 문제가 ${total - answered}개 있습니다!)` : '';
  if (!confirm(`시험을 제출할까요? 제출 후에는 수정할 수 없습니다.${warn}`)) return;

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
  examLocked = false;
  await window.classClient.unlock();
  $('#done-title').textContent = title;
  $('#done-msg').textContent = msg;
  showScreen('screen-done');
}

$('#btn-done-home').addEventListener('click', () => {
  showScreen('screen-home');
  loadAssignments();
  loadResults();
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
