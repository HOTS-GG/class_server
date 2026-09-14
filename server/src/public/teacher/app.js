/* global io, csDialog */
// 교사 대시보드 — 빌드 스텝 없는 vanilla JS
// 브라우저 기본 alert/confirm/prompt는 Electron에서 창 제목·포커스 문제가 있어 csDialog(공용 모달)만 사용한다.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let students = [];           // [{id, number, name, code, presence}]
let subjects = [];           // [{id, name, color, examCount, assignmentCount}]
let currentSubjectId = localStorage.getItem('cs_subject') || '';  // '' = 전체
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
const hasVal = (v) => v !== undefined && v !== null && v !== '';
// 한글 IME가 켜진 상태에서는 type=number 입력이 씹히므로 text 입력을 숫자로 직접 해석한다.
const num = (v) => { const n = Number(String(v ?? '').trim().replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };
const subjectTag = (id, name) => {
  const s = subjects.find((x) => x.id === id);
  if (!s && !name) return '';
  return `<span class="subject-tag" style="background:${esc(s?.color ?? '#8e8e93')}">${esc(s?.name ?? name)}</span>`;
};

// ── 탭 ─────────────────────────────
$$('#tabs button[data-tab]').forEach((btn) => btn.addEventListener('click', () => {
  $$('#tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
  if (btn.dataset.tab === 'students') loadStudents();
  if (btn.dataset.tab === 'assignments') loadAssignments();
  if (btn.dataset.tab === 'exams') loadExams();
  if (btn.dataset.tab === 'tools') { loadServerInfo(); loadAiSettings(); }
}));

// ── 서버 정보 ─────────────────────────────
async function loadServerInfo() {
  try {
    const info = await api('GET', '/api/teacher/server-info');
    const addrText = info.addresses.map((a) => `${a}:${info.httpPort}`).join('  |  ');
    $('#server-info').innerHTML = `학생 접속 주소: <b>${esc(addrText) || '네트워크 없음'}</b>`;
    $('#header-ws').textContent = info.workspace ? `📁 ${info.workspace.name}` : '';
    $('#ws-name').textContent = info.workspace?.name ?? '';
    $('#ws-path').textContent = info.workspace?.file ?? '';
    $('#btn-ws-switch').disabled = !info.canSwitchWorkspace;
    $('#btn-ws-switch').title = info.canSwitchWorkspace ? '' : '교사용 프로그램(Electron)에서만 전환할 수 있습니다.';
    $('#tools-server-info').textContent =
      `서버 이름   : ${info.name}\n` +
      `세이브 파일 : ${info.workspace?.file ?? ''}\n` +
      `버전       : ${info.version}\n` +
      `HTTP 포트  : ${info.httpPort}\n` +
      `자동탐색 포트: ${info.udpPort} (UDP)\n` +
      `접속 주소   :\n${info.addresses.map((a) => `  - ${a}:${info.httpPort}`).join('\n')}`;
  } catch (err) { toast(err.message, 'warn'); }
}

// ── 과목/학급 ─────────────────────────────
async function loadSubjects() {
  try { subjects = await api('GET', '/api/teacher/subjects'); } catch { subjects = []; }
  if (currentSubjectId && !subjects.some((s) => s.id === currentSubjectId)) currentSubjectId = '';
  const opts = ['<option value="">전체 과목</option>']
    .concat(subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)).join('');
  $('#subject-select').innerHTML = opts;
  $('#subject-select').value = currentSubjectId;
  $('#ex-subject').innerHTML = '<option value="">(과목 없음)</option>'
    + subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const label = currentSubjectId ? `— ${subjects.find((s) => s.id === currentSubjectId)?.name ?? ''}` : '— 전체 과목';
  $('#asg-subject-label').textContent = label;
  $('#exam-subject-label').textContent = label;
}

$('#subject-select').addEventListener('change', () => {
  currentSubjectId = $('#subject-select').value;
  localStorage.setItem('cs_subject', currentSubjectId);
  loadSubjects();
  if ($('#tab-exams').classList.contains('active')) loadExams();
  if ($('#tab-assignments').classList.contains('active')) loadAssignments();
});

function renderSubjectList() {
  $('#subject-list').innerHTML = subjects.length ? subjects.map((s) => `
    <div class="subject-row">
      <span class="subject-tag" style="background:${esc(s.color)}">●</span>
      <input type="text" value="${esc(s.name)}" data-subject-name="${s.id}">
      <span class="muted">시험 ${s.examCount} · 과제 ${s.assignmentCount}</span>
      <button class="small" data-subject-save="${s.id}">이름 저장</button>
      <button class="small" data-subject-del="${s.id}">삭제</button>
    </div>`).join('') : '<p class="muted">아직 과목이 없습니다. 위에서 추가하세요.</p>';
}

$('#btn-subject-manage').addEventListener('click', async () => {
  await loadSubjects();
  renderSubjectList();
  $('#subject-modal').classList.remove('hidden');
  $('#subject-new-name').focus();
});
$('#btn-subject-close').addEventListener('click', () => $('#subject-modal').classList.add('hidden'));
$('#subject-new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-subject-add').click(); });
$('#btn-subject-add').addEventListener('click', async () => {
  const name = $('#subject-new-name').value.trim();
  if (!name) return;
  try {
    const s = await api('POST', '/api/teacher/subjects', { name });
    $('#subject-new-name').value = '';
    currentSubjectId = s.id;
    localStorage.setItem('cs_subject', currentSubjectId);
    await loadSubjects();
    renderSubjectList();
    toast(`"${s.name}" 과목을 추가했습니다. 이제 이 과목으로 시험·과제를 만들 수 있습니다.`);
  } catch (err) { toast(err.message, 'warn'); }
});
$('#subject-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.subjectSave) {
      const name = $(`#subject-list [data-subject-name="${btn.dataset.subjectSave}"]`).value;
      await api('PUT', `/api/teacher/subjects/${btn.dataset.subjectSave}`, { name });
      toast('과목 이름을 저장했습니다.');
    } else if (btn.dataset.subjectDel) {
      const s = subjects.find((x) => x.id === btn.dataset.subjectDel);
      if (!await csDialog.confirm(`"${s?.name}" 과목을 삭제할까요?\n소속 시험·과제는 삭제되지 않고 "과목 없음"으로 남습니다.`, { title: '과목 삭제', danger: true, okText: '삭제' })) return;
      await api('DELETE', `/api/teacher/subjects/${btn.dataset.subjectDel}`);
    } else return;
    await loadSubjects();
    renderSubjectList();
    if ($('#tab-exams').classList.contains('active')) loadExams();
    if ($('#tab-assignments').classList.contains('active')) loadAssignments();
  } catch (err) { toast(err.message, 'warn'); }
});

// ── AI 채점 설정 ─────────────────────────────
let aiSettings = null;
let aiModels = [];   // OpenRouter 동기화 목록

function fmtPrice(m) {
  if (m.promptPrice == null) return '';
  return `$${m.promptPrice}/1M 입력 · $${m.completionPrice ?? '-'}/1M 출력`;
}

function renderModelSelect() {
  const sel = $('#ai-model-select');
  const filter = $('#ai-model-filter').value.trim().toLowerCase();
  const chosen = sel.value === '__custom__' ? '__custom__' : (sel.value || aiSettings?.model || '');
  const presetIds = new Set(aiSettings.presets.map((p) => p.value));
  let html = '';
  if (aiModels.length) {
    const groups = new Map();
    for (const m of aiModels) {
      if (filter && !(`${m.id} ${m.name}`.toLowerCase().includes(filter))) continue;
      if (!groups.has(m.provider)) groups.set(m.provider, []);
      groups.get(m.provider).push(m);
    }
    const order = ['anthropic', 'openai', 'google', 'x-ai', 'meta-llama', 'mistralai', 'deepseek', 'qwen'];
    const keys = [...groups.keys()].sort((a, b) => {
      const ia = order.indexOf(a); const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    for (const k of keys) {
      html += `<optgroup label="${esc(k)}">` + groups.get(k).map((m) =>
        `<option value="${esc(m.id)}">${esc(m.name)}${presetIds.has(m.id) ? ' ★' : ''}</option>`).join('') + '</optgroup>';
    }
    if (!html) html = '<option value="" disabled>검색 결과 없음</option>';
  } else {
    html = aiSettings.presets.map((p) => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('');
  }
  html += '<option value="__custom__">직접 입력…</option>';
  sel.innerHTML = html;
  const values = [...sel.options].map((o) => o.value);
  if (values.includes(chosen)) sel.value = chosen;
  else if (chosen && chosen !== '__custom__') {
    // 목록에 없는 저장 모델은 직접 입력으로 표시
    sel.value = '__custom__';
    $('#ai-model-custom').value = chosen;
  }
  $('#ai-model-custom').classList.toggle('hidden', sel.value !== '__custom__');
  updateModelInfo();
}

function updateModelInfo() {
  const id = selectedModel();
  const m = aiModels.find((x) => x.id === id);
  const el = $('#ai-model-info');
  if (!id) { el.textContent = ''; return; }
  if (!m) { el.textContent = aiModels.length ? `${id} — 목록에 없는 모델 ID (직접 입력)` : `${id}`; return; }
  const bits = [id];
  if (m.contextLength) bits.push(`컨텍스트 ${Math.round(m.contextLength / 1000)}k`);
  const price = fmtPrice(m); if (price) bits.push(price);
  bits.push(`이미지 ${m.supportsImage ? '○' : '✕'} · PDF ${m.supportsFile ? '○' : '△(텍스트 추출)'}`);
  if (m.structured === false) bits.push('구조화 출력 미지원(일반 모드로 채점)');
  el.textContent = bits.join(' · ');
}

async function syncModels(force = false) {
  const btn = $('#btn-ai-models-sync');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '동기화 중…';
  try {
    const r = await api('GET', `/api/teacher/ai-settings/models${force ? '?refresh=1' : ''}`);
    aiModels = r.models;
    renderModelSelect();
    if (force) toast(`모델 ${aiModels.length}개를 받아왔습니다. (${new Date(r.fetchedAt).toLocaleTimeString('ko-KR')})`);
  } catch (err) {
    if (force) toast(err.message, 'warn');
    renderModelSelect();
  }
  btn.disabled = false;
  btn.textContent = prev;
}

async function loadAiSettings() {
  try {
    aiSettings = await api('GET', '/api/teacher/ai-settings');
    $('#ai-model-select').value = '';
    renderModelSelect();
    $('#ai-model-select').value = aiSettings.model;
    if ($('#ai-model-select').value !== aiSettings.model) {
      $('#ai-model-select').value = '__custom__';
      $('#ai-model-custom').value = aiSettings.model;
      $('#ai-model-custom').classList.remove('hidden');
    }
    updateModelInfo();
    $('#ai-pdf-engine').value = aiSettings.pdfEngine;
    $('#ai-key').value = '';
    $('#ai-key').placeholder = aiSettings.configured ? '저장된 키 유지 (바꾸려면 새 키 입력)' : 'sk-or-v1-...';
    $('#ai-key-hint').textContent = aiSettings.configured
      ? `저장됨: ${aiSettings.keyHint} (${aiSettings.keyLength}자)` : '저장된 키 없음 — 서술형 AI 채점을 쓰려면 입력하세요.';
    $('#ai-test-result').textContent = '';
    if (!aiModels.length) syncModels(false); // 최초 1회 자동 동기화 (실패해도 기본 목록 유지)
  } catch (err) { toast(err.message, 'warn'); }
}

$('#ai-model-select').addEventListener('change', () => {
  $('#ai-model-custom').classList.toggle('hidden', $('#ai-model-select').value !== '__custom__');
  updateModelInfo();
});
$('#ai-model-custom').addEventListener('input', updateModelInfo);
$('#ai-model-filter').addEventListener('input', renderModelSelect);
$('#btn-ai-models-sync').addEventListener('click', () => syncModels(true));
$('#btn-ai-key-show').addEventListener('click', () => {
  const inp = $('#ai-key');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  $('#btn-ai-key-show').textContent = inp.type === 'password' ? '보기' : '숨기기';
});

const selectedModel = () => {
  const v = $('#ai-model-select').value;
  return v === '__custom__' ? $('#ai-model-custom').value.trim() : v;
};

$('#btn-ai-save').addEventListener('click', async () => {
  const model = selectedModel();
  if (!model) { toast('모델을 선택하거나 입력하세요.', 'warn'); return; }
  try {
    await api('PUT', '/api/teacher/ai-settings', {
      apiKey: $('#ai-key').value, model, pdfEngine: $('#ai-pdf-engine').value,
    });
    toast('AI 채점 설정을 저장했습니다.');
    await loadAiSettings();
  } catch (err) { toast(err.message, 'warn'); }
});

$('#btn-ai-test').addEventListener('click', async () => {
  $('#ai-test-result').textContent = '확인 중...';
  try {
    const r = await api('POST', '/api/teacher/ai-settings/test', { apiKey: $('#ai-key').value });
    const parts = ['✅ 연결 성공'];
    if (r.label) parts.push(`키 이름: ${r.label}`);
    if (r.limit != null) parts.push(`한도: $${r.limit}${r.limitRemaining != null ? ` (남음 $${r.limitRemaining})` : ''}`);
    else if (r.usage != null) parts.push(`사용량: $${r.usage}`);
    $('#ai-test-result').textContent = parts.join(' · ');
  } catch (err) { $('#ai-test-result').textContent = `❌ ${err.message}`; }
});

$('#btn-ai-clear').addEventListener('click', async () => {
  if (!await csDialog.confirm('저장된 API 키를 삭제할까요? AI 채점을 다시 쓰려면 키를 다시 입력해야 합니다.', { title: 'API 키 삭제', danger: true, okText: '삭제' })) return;
  try {
    await api('PUT', '/api/teacher/ai-settings', { clearKey: true });
    toast('API 키를 삭제했습니다.');
    await loadAiSettings();
  } catch (err) { toast(err.message, 'warn'); }
});

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
      <td class="code-cell"><button class="code-btn" data-act="code" data-id="${s.id}" title="크게 보기">${s.code}</button>
        <button class="small" data-act="recode" data-id="${s.id}">재발급</button></td>
      <td>${s.presence?.online ? '🟢 접속' : '⚪ 미접속'}</td>
      <td><button class="small" data-act="del" data-id="${s.id}">삭제</button></td>
    </tr>`).join('');
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const stu = students.find((s) => s.id === btn.dataset.id);
    try {
      if (btn.dataset.act === 'code') {
        $('#code-modal-student').textContent = `${stu.number}번 ${stu.name}`;
        $('#code-modal-code').textContent = stu.code;
        $('#code-modal').classList.remove('hidden');
        return;
      }
      if (btn.dataset.act === 'recode') {
        if (!await csDialog.confirm(`${stu?.name} 학생의 접속 코드를 재발급할까요?\n기존 코드는 더 이상 쓸 수 없습니다.`, { title: '코드 재발급' })) return;
        await api('POST', `/api/teacher/students/${btn.dataset.id}/code`);
        toast('접속 코드를 재발급했습니다.');
      } else if (btn.dataset.act === 'del') {
        if (!await csDialog.confirm(`${stu?.name} 학생을 명단에서 삭제할까요?`, { title: '학생 삭제', danger: true, okText: '삭제' })) return;
        await api('DELETE', `/api/teacher/students/${btn.dataset.id}`);
      }
      await loadStudents();
    } catch (err) { toast(err.message, 'warn'); }
  };
}
$('#btn-code-close').addEventListener('click', () => $('#code-modal').classList.add('hidden'));
$('#code-modal').addEventListener('click', (e) => { if (e.target === $('#code-modal')) $('#code-modal').classList.add('hidden'); });

$('#btn-add-student').addEventListener('click', async () => {
  const n = num($('#stu-number').value);
  if (!Number.isInteger(n) || n < 1 || n > 999) { toast('출석번호는 1~999 사이의 정수여야 합니다.', 'warn'); $('#stu-number').focus(); return; }
  if (!$('#stu-name').value.trim()) { toast('이름을 입력하세요.', 'warn'); $('#stu-name').focus(); return; }
  try {
    await api('POST', '/api/teacher/students', { number: n, name: $('#stu-name').value });
    $('#stu-number').value = ''; $('#stu-name').value = '';
    $('#stu-number').focus();
    await loadStudents();
  } catch (err) { toast(err.message, 'warn'); }
});
$('#stu-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-add-student').click(); });

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
  await loadSubjects();
  const all = await api('GET', '/api/teacher/assignments');
  const list = currentSubjectId ? all.filter((a) => a.subjectId === currentSubjectId) : all;
  const label = { draft: '초안', published: '배부됨', closed: '마감' };
  $('#assignment-list').innerHTML = list.length ? list.map((a) => `
    <div class="asg-item">
      <span class="title">${esc(a.title)}</span>
      ${subjectTag(a.subjectId, a.subjectName)}
      <span class="muted">${a.files.length}개 파일 · 제출 ${a.submittedCount}명</span>
      <span class="status-pill ${a.status}">${label[a.status]}</span>
      ${a.status === 'draft' ? `<button class="small primary" data-act="publish" data-id="${a.id}">배부</button>` : ''}
      ${a.status === 'published' ? `<button class="small" data-act="close" data-id="${a.id}">마감</button>` : ''}
      <button class="small" data-act="detail" data-id="${a.id}" data-title="${esc(a.title)}">제출 현황</button>
      <button class="small" data-act="del" data-id="${a.id}" data-title="${esc(a.title)}" data-count="${a.submittedCount}">삭제</button>
    </div>`).join('') : `<p class="muted">${currentSubjectId ? '이 과목에는 아직 과제가 없습니다.' : '아직 과제가 없습니다.'}</p>`;

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
      } else if (btn.dataset.act === 'del') {
        const n = Number(btn.dataset.count);
        const msg = `"${btn.dataset.title}" 과제를 삭제할까요?\n배부 파일과 학생 제출물${n ? ` (${n}명)` : ''}도 함께 삭제됩니다. 필요하면 zip을 먼저 내려받으세요.`;
        if (!await csDialog.confirm(msg, { title: '과제 삭제', danger: true, okText: '삭제' })) return;
        await api('DELETE', `/api/teacher/assignments/${btn.dataset.id}`);
        toast('과제를 삭제했습니다.');
        $('#assignment-detail').classList.add('hidden');
        await loadAssignments();
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
  fd.set('subjectId', currentSubjectId);
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
  await loadSubjects();
  const all = await api('GET', '/api/teacher/exams');
  const list = currentSubjectId ? all.filter((e) => e.subjectId === currentSubjectId) : all;
  const label = { draft: '초안', active: '진행 중', ended: '종료' };
  $('#exam-list').innerHTML = list.length ? list.map((e) => `
    <div class="exam-item">
      <span class="title">${esc(e.title)}</span>
      ${subjectTag(e.subjectId, e.subjectName)}
      <span class="muted">${e.questionCount}문항${e.essayCount ? ` (서술형 ${e.essayCount})` : ''} · ${e.totalPoints}점 · ${e.durationMin ?? Math.round((e.durationSec ?? 1800) / 60)}분</span>
      <span class="status-pill ${e.status}">${label[e.status]}</span>
      ${e.instantResults ? '<span class="status-pill" title="시험 종료 즉시 학생에게 성적 공개">즉시 공개</span>' : ''}
      ${e.resultsPublished ? '<span class="status-pill published">성적 공개됨</span>' : ''}
      ${e.status === 'draft' ? `
        <button class="small" data-act="edit" data-id="${e.id}">수정</button>
        <button class="small primary" data-act="start" data-id="${e.id}">시작</button>` : ''}
      ${e.status !== 'draft' ? `<button class="small" data-act="monitor" data-id="${e.id}">감독/결과</button>` : ''}
      <button class="small" data-act="dup" data-id="${e.id}">복제</button>
      ${e.status !== 'active' ? `<button class="small" data-act="del" data-id="${e.id}">삭제</button>` : ''}
    </div>`).join('') : `<p class="muted">${currentSubjectId ? '이 과목에는 아직 시험이 없습니다.' : '아직 시험이 없습니다.'}</p>`;

  $('#exam-list').onclick = async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === 'edit') await openExamEditor(id);
      else if (btn.dataset.act === 'del') {
        if (!await csDialog.confirm('시험을 삭제할까요?\n종료된 시험은 학생 응시 기록과 점수도 함께 삭제됩니다. 필요하면 결과 파일을 먼저 내려받으세요.', { title: '시험 삭제', danger: true, okText: '삭제' })) return;
        await api('DELETE', `/api/teacher/exams/${id}`);
        toast('시험을 삭제했습니다.');
        await loadExams();
      } else if (btn.dataset.act === 'dup') {
        const copy = await api('POST', `/api/teacher/exams/${id}/duplicate`);
        toast(`"${copy.title}" 초안이 만들어졌습니다. 수정하거나 바로 시작할 수 있습니다.`);
        await loadExams();
      } else if (btn.dataset.act === 'start') {
        const exam = await api('GET', `/api/teacher/exams/${id}`);
        openStartModal(exam); // Electron은 prompt()를 지원하지 않으므로 모달 사용
      } else if (btn.dataset.act === 'monitor') {
        await openMonitor(id);
      }
    } catch (err) { toast(err.message, 'warn'); }
  };
}

// ── 시험 시작 모달 ─────────────────────────────
let startingExamId = null;

function openStartModal(exam) {
  startingExamId = exam.id;
  $('#start-title').textContent = `시험 시작 — ${exam.title}`;
  $('#start-duration').value = exam.durationMin ?? 30;
  $('#start-lockdown').checked = false;
  $('#start-modal').classList.remove('hidden');
  $('#start-duration').focus();
  $('#start-duration').select();
}

$('#btn-start-cancel').addEventListener('click', () => $('#start-modal').classList.add('hidden'));
$('#start-duration').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-start-ok').click(); });
$('#btn-start-ok').addEventListener('click', async () => {
  const min = num($('#start-duration').value);
  if (!Number.isFinite(min) || min < 1) { toast('시험 시간은 1분 이상이어야 합니다.', 'warn'); return; }
  const id = startingExamId;
  $('#btn-start-ok').disabled = true;
  try {
    await api('POST', `/api/teacher/exams/${id}/start`, { durationMin: min, lockdown: $('#start-lockdown').checked });
    $('#start-modal').classList.add('hidden');
    toast('시험을 시작했습니다.');
    await openMonitor(id);
  } catch (err) { toast(err.message, 'warn'); }
  $('#btn-start-ok').disabled = false;
});

const Q_TYPE_KO = { mc: '객관식', short: '단답형', essay: '서술형' };

function questionCard(q, idx) {
  const choices = (q.choices ?? []).map((c, ci) => `
    <div class="choice-row">
      <input type="radio" name="ans-${idx}" ${q.answerIndex === ci ? 'checked' : ''} data-q="${idx}" data-c="${ci}" data-role="answer" title="정답">
      <input type="text" value="${esc(c)}" data-q="${idx}" data-c="${ci}" data-role="choice" placeholder="보기 ${ci + 1}">
      <button class="small" data-role="del-choice" data-q="${idx}" data-c="${ci}">✕</button>
    </div>`).join('');
  const acceptedStr = Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers.join('; ') : (q.acceptedAnswers ?? '');
  return `<div class="q-card">
    <div class="q-head">
      <b>${idx + 1}번</b>
      <span class="status-pill">${Q_TYPE_KO[q.type]}</span>
      <label>배점 <input type="text" inputmode="numeric" value="${q.points}" style="width:60px" data-q="${idx}" data-role="points"></label>
      ${q.type === 'essay' ? `<label title="학생이 답안에 PDF/이미지/텍스트 파일을 첨부할 수 있게 합니다. 파일 내용도 AI가 요약·채점합니다."><input type="checkbox" ${q.allowFile ? 'checked' : ''} data-q="${idx}" data-role="allow-file"> 파일 첨부 허용</label>` : ''}
      <span class="sep"></span>
      <button class="small" data-role="del-q" data-q="${idx}">문항 삭제</button>
    </div>
    <textarea data-q="${idx}" data-role="text" placeholder="문항 내용">${esc(q.text)}</textarea>
    ${q.type === 'mc' ? `${choices}
      <button class="small" data-role="add-choice" data-q="${idx}">+ 보기</button>
      <div class="muted">왼쪽 라디오 버튼으로 정답을 지정하세요.</div>` : ''}
    ${q.type === 'short' ? `
      <div class="choice-row" style="margin-top:8px">
        <span>인정 답안</span>
        <input type="text" value="${esc(acceptedStr)}" data-q="${idx}" data-role="accepted"
          placeholder="예: H2O; 에이치투오  (여러 개면 ; 로 구분)">
      </div>
      <div class="muted">공백·대소문자는 무시하고 자동 채점됩니다. 채점 후 감독 화면에서 수동 정정도 가능합니다.</div>` : ''}
    ${q.type === 'essay' ? `
      <div class="field"><span>모범답안 <span class="muted">(AI 채점 기준 — 학생에게는 보이지 않음)</span></span>
        <textarea data-q="${idx}" data-role="model-answer" placeholder="이 문항의 예시 답안">${esc(q.modelAnswer ?? '')}</textarea></div>
      <div class="field"><span>채점기준 <span class="muted">(줄마다 한 항목, "항목 (n점)" 형태 권장 — 항목 점수의 합 = 배점)</span></span>
        <textarea data-q="${idx}" data-role="rubric" placeholder="예)\n핵심 개념을 정확히 설명 (4점)\n구체적인 예시 제시 (3점)\n논리적 구성 (3점)">${esc(q.rubric ?? '')}</textarea></div>
      <div class="muted">${(q.modelAnswer ?? '').trim() || (q.rubric ?? '').trim() ? 'AI 채점 초안을 만들 수 있습니다. 최종 점수는 교사가 확인 후 반영합니다.' : '⚠ 모범답안·채점기준이 없으면 AI 채점 정확도가 크게 떨어집니다.'}</div>` : ''}
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
  else if (t.dataset.role === 'points') q.points = num(t.value);
  else if (t.dataset.role === 'choice') q.choices[Number(t.dataset.c)] = t.value;
  else if (t.dataset.role === 'accepted') q.acceptedAnswers = t.value;
  else if (t.dataset.role === 'model-answer') q.modelAnswer = t.value;
  else if (t.dataset.role === 'rubric') q.rubric = t.value;
});
$('#question-editor').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.role === 'answer') {
    editQuestions[Number(t.dataset.q)].answerIndex = Number(t.dataset.c);
  } else if (t.dataset.role === 'allow-file') {
    editQuestions[Number(t.dataset.q)].allowFile = t.checked;
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
$('#btn-add-short').addEventListener('click', () => {
  editQuestions.push({ type: 'short', text: '', points: 5, acceptedAnswers: '' });
  renderQuestionEditor();
});
$('#btn-add-essay').addEventListener('click', () => {
  editQuestions.push({ type: 'essay', text: '', points: 10, modelAnswer: '', rubric: '', allowFile: false });
  renderQuestionEditor();
});

function showEditor(title, exam = null) {
  $('#exam-editor-title').textContent = title;
  $('#ex-title').value = exam?.title ?? '';
  $('#ex-subject').value = exam ? (exam.subjectId ?? '') : currentSubjectId;
  $('#ex-duration').value = exam?.durationMin ?? 30;
  $('#ex-shuffle-q').checked = exam ? exam.shuffleQuestions : true;
  $('#ex-shuffle-c').checked = exam ? exam.shuffleChoices : true;
  $('#ex-instant').checked = exam?.instantResults === true;
  renderQuestionEditor();
  $('#exam-list-view').classList.add('hidden');
  $('#exam-editor').classList.remove('hidden');
}

// ── 엑셀 문제 가져오기 ─────────────────────────────
$('#btn-import-excel').addEventListener('click', () => $('#excel-file').click());
$('#excel-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const { questions, errors } = await api('POST', '/api/teacher/exams/import-excel', fd);
    if (errors?.length) {
      await csDialog.alert(`엑셀에서 문제를 읽는 중 ${errors.length}건을 건너뛰었습니다:\n\n${errors.join('\n')}`, { title: '가져오기 안내' });
    }
    if (!questions?.length) { toast('가져올 수 있는 문항이 없습니다.', 'warn'); e.target.value = ''; return; }
    // 편집기에 채워서 검토 후 저장하도록
    editingExamId = null;
    editQuestions = questions.map((q) => ({
      ...q,
      acceptedAnswers: Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers.join('; ') : q.acceptedAnswers,
    }));
    showEditor('엑셀에서 가져온 시험 (검토 후 저장)');
    $('#ex-title').value = file.name.replace(/\.(xlsx|xls)$/i, '');
    toast(`${questions.length}개 문항을 가져왔습니다. 검토 후 [저장]을 누르세요.`);
  } catch (err) { toast(err.message, 'warn'); }
  e.target.value = '';
});

$('#btn-new-exam').addEventListener('click', () => {
  editingExamId = null;
  editQuestions = [];
  showEditor('새 시험');
});

async function openExamEditor(id) {
  const exam = await api('GET', `/api/teacher/exams/${id}`);
  editingExamId = id;
  editQuestions = exam.questions.map((q) => ({
    type: q.type, text: q.text, points: q.points,
    choices: q.choices?.map((c) => c.text),
    answerIndex: q.choices?.findIndex((c) => c.id === q.answerChoiceId) ?? 0,
    acceptedAnswers: q.acceptedAnswers?.join('; '),
    modelAnswer: q.modelAnswer ?? '', rubric: q.rubric ?? '', allowFile: q.allowFile === true,
  }));
  showEditor(`시험 수정 — ${exam.title}`, exam);
}

$('#btn-cancel-exam').addEventListener('click', () => {
  $('#exam-editor').classList.add('hidden');
  $('#exam-list-view').classList.remove('hidden');
});

$('#btn-save-exam').addEventListener('click', async () => {
  const payload = {
    title: $('#ex-title').value,
    subjectId: $('#ex-subject').value,
    durationMin: num($('#ex-duration').value),
    shuffleQuestions: $('#ex-shuffle-q').checked,
    shuffleChoices: $('#ex-shuffle-c').checked,
    instantResults: $('#ex-instant').checked,
    questions: editQuestions,
  };
  const weakEssays = editQuestions.filter((q) => q.type === 'essay' && !(q.modelAnswer ?? '').trim() && !(q.rubric ?? '').trim());
  if (weakEssays.length && !await csDialog.confirm(`서술형 ${weakEssays.length}문항에 모범답안·채점기준이 없습니다.\n이대로 저장하면 AI 채점 정확도가 낮아집니다. 계속할까요?`, { title: '저장 확인', okText: '저장' })) return;
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
  $('#results-xlsx-link').href = `/api/teacher/exams/${examId}/results.xlsx`;
  // 다른 탭에 있어도 감독 화면으로 이동
  $$('#tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'exams'));
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

$('#btn-publish-results').addEventListener('click', async () => {
  const publishing = !monitorData?.exam?.resultsPublished;
  if (publishing && !await csDialog.confirm('학생들에게 성적을 공개할까요?\n각 학생은 본인의 점수, 문항별 정오, 정답, 피드백을 볼 수 있게 됩니다.\n(서술형 채점을 먼저 마쳤는지 확인하세요. 나중에 채점하면 그때 학생 화면도 갱신됩니다.)', { title: '성적 공개', okText: '공개' })) return;
  try {
    await api('POST', `/api/teacher/exams/${monitorExamId}/publish-results`, { published: publishing });
    toast(publishing ? '성적을 공개했습니다.' : '성적 공개를 취소했습니다.');
    await refreshMonitor();
  } catch (err) { toast(err.message, 'warn'); }
});

$('#btn-stop-exam').addEventListener('click', async () => {
  if (!await csDialog.confirm('시험을 지금 종료할까요? 미제출 학생은 자동 제출됩니다.', { title: '시험 종료', danger: true, okText: '종료' })) return;
  try {
    await api('POST', `/api/teacher/exams/${monitorExamId}/stop`);
    await refreshMonitor();
  } catch (err) { toast(err.message, 'warn'); }
});

// AI 배치 채점
$('#btn-ai-grade').addEventListener('click', async () => {
  const ex = monitorData?.exam;
  if (!ex) return;
  if (!ex.aiConfigured) {
    toast('먼저 [도구 · 설정] 탭에서 OpenRouter API 키를 저장하세요.', 'warn');
    return;
  }
  const anyDone = monitorData.rows.some((r) => r.ai?.done);
  let regrade = false;
  if (anyDone) {
    regrade = await csDialog.confirm('이미 AI 채점된 답안이 있습니다.\n전부 다시 채점할까요? (비용 발생)\n[아니오]를 누르면 아직 채점되지 않은 답안만 채점합니다.', { title: 'AI 재채점', okText: '전부 다시', cancelText: '남은 것만' });
  }
  if (!await csDialog.confirm(`서술형 ${ex.essayCount}문항을 AI로 채점합니다. 제출된 학생 답안이 OpenRouter로 전송됩니다(이름·번호 제외).\n계속할까요?`, { title: 'AI 채점 실행', okText: '채점 시작' })) return;
  try {
    await api('POST', `/api/teacher/exams/${monitorExamId}/ai-grade`, { regrade });
    toast('AI 채점을 시작했습니다. 진행률이 표시됩니다.');
    await refreshMonitor();
  } catch (err) { toast(err.message, 'warn'); }
});

$('#btn-ai-apply').addEventListener('click', async () => {
  if (!await csDialog.confirm('AI가 매긴 서술형 점수와 피드백을 최종 점수로 반영할까요?\n\n- 교사가 이미 직접 입력한 점수는 그대로 유지됩니다.\n- 반영 후에도 [답안/채점]에서 학생별로 수정할 수 있습니다.', { title: 'AI 점수 전체 반영', okText: '반영' })) return;
  try {
    const r = await api('POST', `/api/teacher/exams/${monitorExamId}/apply-ai`);
    toast(`${r.attemptsTouched}명, ${r.gradesApplied}개 문항에 AI 점수를 반영했습니다.`);
    await refreshMonitor();
  } catch (err) { toast(err.message, 'warn'); }
});

function renderAiProgress(p) {
  const box = $('#ai-progress');
  if (!p) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
  box.innerHTML = p.finished
    ? `🤖 AI 채점 완료 — ${p.done}명 처리${p.failed ? `, <b>${p.failed}명 오류</b> (답안/채점에서 확인 후 재채점)` : ''}. 결과를 검토한 뒤 [AI 점수 전체 반영]을 누르세요.`
    : `🤖 AI 채점 진행 중… ${p.done}/${p.total}명${p.failed ? ` (오류 ${p.failed})` : ''}
       <div class="progress-bar"><div style="width:${pct}%"></div></div>`;
}

function aiCell(r) {
  if (!r.submitted) return '';
  const a = r.ai;
  if (!a) return '<span class="muted">—</span>';
  if (!a.done && !a.error) return '<span class="muted">대기</span>';
  const parts = [];
  if (a.done) parts.push(`<span class="status-pill ai">AI ${a.done}/${a.essayCount}</span>`);
  if (a.error) parts.push(`<span class="status-pill bad">오류 ${a.error}</span>`);
  if (a.applied) parts.push(`<span class="status-pill published">반영 ${a.applied}</span>`);
  if (a.lowConf) parts.push(`<span class="status-pill warn" title="AI 확신도가 낮은 답안 — 직접 확인 권장">검토 ${a.lowConf}</span>`);
  return `<span class="ai-cell">${parts.join(' ')}</span>`;
}

async function refreshMonitor() {
  if (!monitorExamId) return;
  try {
    monitorData = await api('GET', `/api/teacher/exams/${monitorExamId}/monitor`);
  } catch (err) {
    // 시험이 삭제되었거나 서버가 바뀐 경우: 목록으로 복귀
    toast(err.message, 'warn');
    $('#btn-monitor-back').click();
    return;
  }
  serverOffset = monitorData.serverNow - Date.now();
  const { exam, rows } = monitorData;
  $('#monitor-title').textContent = `${exam.title} — ${exam.status === 'active' ? '진행 중' : '종료됨'}`;
  $('#btn-stop-exam').classList.toggle('hidden', exam.status !== 'active');
  const pubBtn = $('#btn-publish-results');
  pubBtn.classList.toggle('hidden', exam.status !== 'ended');
  pubBtn.textContent = exam.resultsPublished ? '성적 공개 취소' : '성적 공개 (학생에게 점수 보내기)';
  pubBtn.classList.toggle('primary', !exam.resultsPublished);

  const showAi = exam.status === 'ended' && exam.essayCount > 0;
  $('#btn-ai-grade').classList.toggle('hidden', !showAi);
  $('#btn-ai-grade').disabled = !!exam.aiProgress && !exam.aiProgress.finished;
  const anyAiDone = rows.some((r) => r.ai?.done);
  $('#btn-ai-apply').classList.toggle('hidden', !showAi || !anyAiDone);
  if (exam.aiProgress) renderAiProgress(exam.aiProgress);
  else if (!lastAiProgress || lastAiProgress.examId !== exam.id) renderAiProgress(null);

  updateMonitorTimer();
  const typeLabel = { manual: '직접', auto: '시간종료', teacher: '교사종료' };
  $('#monitor-table tbody').innerHTML = rows.map((r) => {
    const p = r.presence;
    const conn = !p.online ? '⚪' : (p.focus === 'away' ? '🟡 이탈' : '🟢');
    const away = p.awayCount ? `${p.awayCount}회/${fmtDur(p.awayMs)}` : '—';
    return `<tr>
      <td>${r.number}</td>
      <td>${esc(r.name)}</td>
      <td>${conn}</td>
      <td>${r.answeredCount}/${r.questionCount}</td>
      <td>${away}</td>
      <td>${r.submitted ? `✅ ${typeLabel[r.submitType] ?? ''} ${fmtTime(r.submittedAt)}` : '—'}</td>
      <td>${r.score != null ? `${r.score}점` : '—'}</td>
      <td>${aiCell(r)}</td>
      <td>${r.submitted ? `<button class="small" data-attempt="${r.attemptId}">답안/채점</button>` : ''}</td>
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
let gradingExam = null;

function aiPanel(q, ai) {
  if (!ai) return '<div class="muted">AI 채점 전 — 감독 화면의 [AI 채점 실행] 또는 위의 [이 학생 AI 채점]을 누르세요.</div>';
  if (ai.status === 'error') {
    return `<div class="ai-panel error">🤖 AI 채점 실패: ${esc(ai.error)}<br><span class="muted">키·모델·네트워크를 확인하고 다시 시도하세요.</span></div>`;
  }
  const conf = ai.confidence == null ? '' : `확신도 ${Math.round(ai.confidence * 100)}%`;
  const low = ai.confidence != null && ai.confidence < 0.6;
  const crit = (ai.criteria ?? []).length
    ? `<ul>${ai.criteria.map((c) => `<li><b>${esc(c.name)}</b> ${c.score}/${c.max} — ${esc(c.reason)}</li>`).join('')}</ul>` : '';
  return `<div class="ai-panel">
    <div class="ai-head">🤖 AI 채점 초안 <span class="ai-score">${ai.score} / ${ai.maxScore ?? q.points}점</span>
      <span class="${low ? 'conf-low' : 'muted'}">${conf}${low ? ' — 직접 확인 권장' : ''}</span>
      <span class="muted">${esc(ai.model ?? '')}${ai.promptTokens ? ` · ${ai.promptTokens + (ai.completionTokens ?? 0)} tokens` : ''}</span>
      <span class="sep"></span>
      <button class="small ai" data-apply-q="${q.id}" title="AI 점수와 피드백을 아래 입력칸에 채웁니다">이 점수 적용</button>
    </div>
    ${ai.summary ? `<div class="fb"><b>첨부 요약:</b> ${esc(ai.summary)}</div>` : ''}
    ${crit}
    ${ai.feedback ? `<div class="fb"><b>피드백 제안:</b> ${esc(ai.feedback)}</div>` : ''}
  </div>`;
}

async function openGradeModal(attemptId) {
  const { exam, attempt, student } = await api('GET', `/api/teacher/exams/${monitorExamId}/attempts/${attemptId}`);
  gradingAttemptId = attemptId;
  gradingExam = exam;
  const hasEssay = exam.questions.some((q) => q.type === 'essay');
  $('#btn-ai-regrade').classList.toggle('hidden', !(hasEssay && exam.status === 'ended'));
  $('#grade-title').textContent = `답안 확인 — ${student?.number}번 ${student?.name}`;
  $('#grade-content').innerHTML = exam.questions.map((q, i) => {
    const a = attempt.answers[q.id];
    const cur = attempt.manualGrades?.[q.id] ?? '';
    if (q.type === 'mc') {
      const chosen = q.choices.find((c) => c.id === a?.choiceId);
      const correct = a?.choiceId === q.answerChoiceId;
      return `<div class="q-card">
        <b>Q${i + 1}. (객관식 ${q.points}점)</b> ${esc(q.text)}<br>
        답: ${esc(chosen?.text ?? '무응답')} ${correct ? '⭕' : '❌'}
      </div>`;
    }
    if (q.type === 'short') {
      const earned = attempt.scoreDetail?.perQuestion?.[q.id] ?? 0;
      return `<div class="q-card">
        <b>Q${i + 1}. (단답형 ${q.points}점)</b> ${esc(q.text)}
        <div class="answer-box">${esc(a?.text ?? '(무응답)')}</div>
        <div>자동 채점: ${earned}점 ${earned >= q.points ? '⭕' : '❌'}
          <span class="muted">인정 답안: ${(q.acceptedAnswers ?? []).map(esc).join(', ')}</span></div>
        <label>점수 정정 <input type="text" inputmode="decimal" value="${cur}" data-grade-q="${q.id}" data-max="${q.points}" style="width:70px"> / ${q.points}점
          <span class="muted">(비우면 자동 채점 유지)</span></label>
      </div>`;
    }
    const ai = attempt.aiGrades?.[q.id];
    const fb = attempt.feedback?.[q.id] ?? '';
    const fileLink = a?.file
      ? `<a class="file-chip" href="/api/teacher/exams/${exam.id}/attempts/${attempt.id}/files/${q.id}" download>📎 ${esc(a.file.name)} (${Math.max(1, Math.round((a.file.size ?? 0) / 1024))}KB)</a>`
      : '';
    return `<div class="q-card">
      <b>Q${i + 1}. (서술형 ${q.points}점)</b> ${esc(q.text)}
      ${(q.rubric || q.modelAnswer) ? `<details class="rubric"><summary>채점기준 · 모범답안 보기</summary>
        ${q.rubric ? `<div class="rubric-box"><b>채점기준</b><br>${esc(q.rubric)}</div>` : ''}
        ${q.modelAnswer ? `<div class="rubric-box"><b>모범답안</b><br>${esc(q.modelAnswer)}</div>` : ''}
      </details>` : '<div class="muted">채점기준·모범답안 없음</div>'}
      <div class="answer-box">${esc(a?.text?.trim() ? a.text : (a?.file ? '(텍스트 없음 — 첨부 파일로 제출)' : '(무응답)'))}</div>
      ${fileLink}
      ${aiPanel(q, ai)}
      <div class="grade-row">
        <label>최종 점수 <input type="text" inputmode="decimal" value="${cur}" data-grade-q="${q.id}" data-max="${q.points}"> / ${q.points}점</label>
        ${hasVal(cur) ? '' : '<span class="muted">미채점 — 점수를 직접 입력하거나 [이 점수 적용]을 누르세요</span>'}
      </div>
      <div class="feedback-area">
        <label class="muted">학생에게 보낼 피드백 (성적 공개 시 학생 화면에 표시)</label>
        <textarea data-feedback-q="${q.id}" placeholder="잘한 점과 보완할 점을 적어 주세요. AI 제안을 적용해 수정할 수도 있습니다.">${esc(fb)}</textarea>
      </div>
    </div>`;
  }).join('');
  $('#grade-modal').classList.remove('hidden');
}

// "이 점수 적용": AI 점수/피드백을 입력칸에 채운다 (저장은 교사가 [채점 저장]으로)
$('#grade-content').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-apply-q]');
  if (!btn) return;
  const qid = btn.dataset.applyQ;
  const { attempt } = await api('GET', `/api/teacher/exams/${monitorExamId}/attempts/${gradingAttemptId}`);
  const ai = attempt.aiGrades?.[qid];
  if (!ai || ai.status !== 'done') return;
  const inp = $(`#grade-content [data-grade-q="${qid}"]`);
  const ta = $(`#grade-content [data-feedback-q="${qid}"]`);
  if (inp) inp.value = ai.score;
  if (ta && ai.feedback) ta.value = ai.feedback;
  toast('AI 점수를 입력칸에 채웠습니다. 확인 후 [채점 저장]을 누르세요.');
});

$('#btn-ai-regrade').addEventListener('click', async () => {
  if (!await csDialog.confirm('이 학생의 서술형 답안을 AI로 (다시) 채점할까요? 답안이 OpenRouter로 전송됩니다(이름·번호 제외).', { title: 'AI 채점', okText: '채점' })) return;
  $('#btn-ai-regrade').disabled = true;
  $('#btn-ai-regrade').textContent = '채점 중…';
  try {
    const r = await api('POST', `/api/teacher/exams/${monitorExamId}/attempts/${gradingAttemptId}/ai-grade`);
    const errs = Object.values(r.aiGrades).filter((g) => g.status === 'error');
    toast(errs.length ? `AI 채점 중 ${errs.length}문항 오류: ${errs[0].error}` : 'AI 채점이 끝났습니다. 초안을 확인하세요.', errs.length ? 'warn' : '');
    await openGradeModal(gradingAttemptId);
    refreshMonitor();
  } catch (err) { toast(err.message, 'warn'); }
  $('#btn-ai-regrade').disabled = false;
  $('#btn-ai-regrade').textContent = '🤖 이 학생 AI 채점';
});

$('#btn-close-grades').addEventListener('click', () => $('#grade-modal').classList.add('hidden'));
$('#btn-save-grades').addEventListener('click', async () => {
  const manualGrades = {};
  const feedback = {};
  let bad = null;
  $$('#grade-content [data-grade-q]').forEach((inp) => {
    const raw = inp.value.trim();
    if (raw === '') { manualGrades[inp.dataset.gradeQ] = ''; return; } // 빈 값 = 수동 정정 해제
    const n = num(raw);
    const max = Number(inp.dataset.max);
    if (!Number.isFinite(n) || n < 0 || n > max) { bad = bad ?? { inp, max }; return; }
    manualGrades[inp.dataset.gradeQ] = n;
  });
  if (bad) {
    toast(`점수는 0~${bad.max} 사이의 숫자로 입력하세요.`, 'warn');
    bad.inp.focus();
    return;
  }
  $$('#grade-content [data-feedback-q]').forEach((ta) => { feedback[ta.dataset.feedbackQ] = ta.value; });
  try {
    await api('POST', `/api/teacher/exams/${monitorExamId}/attempts/${gradingAttemptId}/grade`, { manualGrades, feedback });
    toast('채점을 저장했습니다.');
    $('#grade-modal').classList.add('hidden');
    await refreshMonitor();
  } catch (err) { toast(err.message, 'warn'); }
});

// ── 도구 ─────────────────────────────
$('#btn-ws-switch').addEventListener('click', async () => {
  if (!await csDialog.confirm('다른 세이브 파일을 열까요?\n현재 세이브는 저장된 상태로 닫히고, 접속 중인 학생은 연결이 끊깁니다.', { title: '세이브 전환', okText: '열기' })) return;
  try {
    await api('POST', '/api/teacher/workspace/switch');
  } catch (err) { toast(err.message, 'warn'); }
});

$('#btn-unlock-code').addEventListener('click', async () => {
  try {
    const { code } = await api('POST', '/api/teacher/unlock-code');
    $('#unlock-code-display').textContent = code;
  } catch (err) { toast(err.message, 'warn'); }
});

$('#btn-unlock-all').addEventListener('click', async () => {
  if (!await csDialog.confirm('모든 학생의 화면 잠금을 해제할까요?', { title: '전체 잠금 해제' })) return;
  try {
    await api('POST', '/api/teacher/unlock-all');
    toast('전체 잠금 해제 신호를 보냈습니다.');
  } catch (err) { toast(err.message, 'warn'); }
});

// ── 실시간 소켓 ─────────────────────────────
const socket = io('/teacher');
let lastAiProgress = null;

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
    if (ev.reason) addFeed('시험이 종료되었습니다.', 'bad');
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

// AI 배치 채점 진행률
let aiRefreshPending = false;
socket.on('ai:progress', (p) => {
  lastAiProgress = p;
  if (monitorExamId !== p.examId) return;
  renderAiProgress(p);
  if (p.finished) {
    addFeed(`🤖 AI 채점 완료 (${p.done}명${p.failed ? `, 오류 ${p.failed}` : ''})`, p.failed ? 'warn' : 'good');
    refreshMonitor();
  } else if (!aiRefreshPending) {
    aiRefreshPending = true;
    setTimeout(() => { aiRefreshPending = false; refreshMonitor(); }, 2000);
  }
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
loadSubjects();
loadStudents();
