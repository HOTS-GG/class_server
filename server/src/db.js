import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const DEFAULT_DATA = {
  students: [],
  subjects: [],      // 과목/학급 구분: { id, name, color, createdAt } — 시험·과제에 subjectId로 연결
  assignments: [],
  submissions: [],
  exams: [],
  attempts: [],
  settings: {},
};

const MAX_BACKUPS = 20;
const DAILY_BACKUP_MS = 24 * 60 * 60 * 1000;
const EVENT_LOG_KEEP_DAYS = 30;          // 종료된 시험의 답안·이탈 로그 보관 기간 (DB에 이미 반영된 뒤)
const GENERAL_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

// lowdb(JSON) + append-only JSONL 이중 저장.
// - 세이브 파일(dbFile, 기본 dataDir/db.json): 명단·과목·과제·시험·응시 기록·설정 전체. 쓰기는 2초 디바운스.
// - secretsFile: OpenRouter API 키 등 비밀값. 세이브 파일과 분리해 교사 PC 프로필에 둔다(세이브를 복사해도 키가 따라가지 않도록).
// - dataDir/events/*.jsonl: 답안·이탈로그를 즉시 append → 서버가 죽어도 리플레이로 복구
// - dataDir/files/: 과제 배부 파일·제출물·답안 첨부
// - dataDir/backups/: 세이브 파일 사본 (시험 시작·종료, 하루 1회, 수동)
// 교사 앱에서는 "우리반.classdb"(dbFile) + "우리반.files/"(dataDir) 쌍으로 쓴다.
export async function openDb(dataDir, { dbFile, secretsFile } = {}) {
  for (const sub of ['events', path.join('files', 'assignments'), path.join('files', 'submissions'), path.join('files', 'exam-answers'), 'backups', 'tmp']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
  const file = dbFile ?? path.join(dataDir, 'db.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secretsPath = secretsFile ?? path.join(dataDir, 'secrets.json');
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });

  // 세이브 파일이 깨져 있으면(JSON 파싱 실패) 최신 백업으로 자동 복구를 시도한다.
  const low = new Low(new JSONFile(file), structuredClone(DEFAULT_DATA));
  let recoveredFrom = null;
  try {
    await low.read();
  } catch (err) {
    const backups = listBackupsIn(path.join(dataDir, 'backups'));
    if (!backups.length) throw new Error(`세이브 파일을 읽을 수 없습니다(${err.message}). 백업도 없습니다.`);
    fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    fs.copyFileSync(backups[0].path, file);
    recoveredFrom = backups[0].path;
    await low.read();
    console.error(`[db] 세이브 파일이 손상되어 백업으로 복구했습니다: ${recoveredFrom}`);
  }
  low.data = { ...structuredClone(DEFAULT_DATA), ...(low.data ?? {}) };

  const s = low.data.settings;
  if (!s.tokenSecret) s.tokenSecret = randomBytes(24).toString('hex');
  if (!s.serverName) s.serverName = '우리반 수업 서버';
  if (!s.ai) s.ai = { model: '', pdfEngine: 'pdf-text' };
  // 구버전 데이터 호환: 응시 기록에 AI/피드백 필드 보강
  for (const att of low.data.attempts) {
    att.aiGrades ??= {};
    att.feedback ??= {};
    att.manualGrades ??= {};
  }

  // ── 비밀값 (API 키): 세이브 파일 밖에 저장 ─────────────────────────────
  let secrets = {};
  try { secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) ?? {}; } catch { secrets = {}; }
  const writeSecrets = () => {
    try { fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2)); } catch (err) { console.error('[db] 비밀값 저장 실패:', err.message); }
  };
  // 마이그레이션: 예전 버전은 settings.ai.apiKey에 평문으로 있었다 → 비밀값 파일로 옮기고 세이브에서 지운다
  if (typeof s.ai.apiKey === 'string') {
    if (s.ai.apiKey.trim() && !secrets.openrouterApiKey) { secrets.openrouterApiKey = s.ai.apiKey.trim(); writeSecrets(); }
    delete s.ai.apiKey;
  }
  const getApiKey = () => String(secrets.openrouterApiKey ?? '').trim();
  const setApiKey = (key) => { secrets.openrouterApiKey = String(key ?? '').replace(/\s+/g, ''); writeSecrets(); };

  await low.write();

  let flushTimer = null;
  let writing = Promise.resolve();

  const doWrite = () => {
    writing = writing.then(() => low.write()).catch((err) => {
      console.error('[db] 저장 실패:', err.message);
    });
    return writing;
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; doWrite(); }, 2000);
  };

  const flushNow = async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await doWrite();
  };

  // ── 이벤트 로그 ─────────────────────────────
  const eventsDir = path.join(dataDir, 'events');
  const eventPath = (name) => path.join(eventsDir, `${name}.jsonl`);

  const appendEvent = (name, obj) => {
    fs.appendFile(eventPath(name), JSON.stringify(obj) + '\n', (err) => {
      if (err) console.error('[db] 이벤트 기록 실패:', err.message);
    });
  };

  const readEvents = (name) => {
    const p = eventPath(name);
    if (!fs.existsSync(p)) return [];
    const out = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* 손상 라인 무시 */ }
    }
    return out;
  };

  const deleteEvents = (name) => { try { fs.rmSync(eventPath(name), { force: true }); } catch { /* noop */ } };

  // 시험 삭제 시 로그도 함께 삭제. 시작 시에는 없는 시험의 로그, 오래전 종료된 시험의 로그, 큰 일반 로그를 정리한다.
  const pruneEvents = () => {
    const removed = [];
    let files = [];
    try { files = fs.readdirSync(eventsDir); } catch { return removed; }
    const examById = new Map(low.data.exams.map((e) => [e.id, e]));
    const cutoff = Date.now() - EVENT_LOG_KEEP_DAYS * DAILY_BACKUP_MS;
    for (const f of files) {
      const m = /^(answers|focus)-(ex_[^.]+)\.jsonl$/.exec(f); // 시험별 로그만 (focus-general은 아래에서 회전)
      if (m) {
        const exam = examById.get(m[2]);
        const stale = !exam || (exam.status === 'ended' && (exam.endedAt ?? 0) < cutoff);
        if (stale) { fs.rmSync(path.join(eventsDir, f), { force: true }); removed.push(f); }
        continue;
      }
      if (f === 'focus-general.jsonl') {
        try {
          if (fs.statSync(path.join(eventsDir, f)).size > GENERAL_LOG_ROTATE_BYTES) {
            fs.rmSync(path.join(eventsDir, 'focus-general.1.jsonl'), { force: true });
            fs.renameSync(path.join(eventsDir, f), path.join(eventsDir, 'focus-general.1.jsonl'));
            removed.push(`${f} (rotated)`);
          }
        } catch { /* noop */ }
      }
    }
    return removed;
  };

  // ── 백업 ─────────────────────────────
  const backupsDir = path.join(dataDir, 'backups');
  const baseName = path.basename(file).replace(/\.[^.]+$/, '');

  const backup = async (reason = 'manual') => {
    await flushNow();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeReason = String(reason).replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'manual';
    const dest = path.join(backupsDir, `${baseName}_${stamp}_${safeReason}.classdb`);
    fs.copyFileSync(file, dest);
    s.lastBackupAt = Date.now();
    scheduleFlush();
    // 오래된 것부터 정리 (최근 MAX_BACKUPS개 유지)
    for (const b of listBackupsIn(backupsDir).slice(MAX_BACKUPS)) fs.rmSync(b.path, { force: true });
    return dest;
  };
  const listBackups = () => listBackupsIn(backupsDir);

  // 하루 한 번 자동 백업 (열 때 확인)
  if (!s.lastBackupAt || Date.now() - s.lastBackupAt > DAILY_BACKUP_MS) {
    try { await backup('daily'); } catch (err) { console.error('[db] 자동 백업 실패:', err.message); }
  }
  const pruned = pruneEvents();
  if (pruned.length) console.log(`[db] 이벤트 로그 정리: ${pruned.length}건`);

  return {
    data: low.data, dataDir, file, secretsFile: secretsPath, recoveredFrom,
    scheduleFlush, flushNow, appendEvent, readEvents, deleteEvents, pruneEvents,
    backup, listBackups, getApiKey, setApiKey,
  };
}

// 백업 목록 (최신순). 파일명: <이름>_<시각>_<사유>.classdb
export function listBackupsIn(backupsDir) {
  let files = [];
  try { files = fs.readdirSync(backupsDir); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.classdb'))
    .map((f) => {
      const p = path.join(backupsDir, f);
      const st = fs.statSync(p);
      const m = /_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_([a-z0-9-]+)\.classdb$/i.exec(f);
      return { path: p, name: f, size: st.size, mtime: st.mtimeMs, reason: m?.[2] ?? '', stamp: m?.[1] ?? '' };
    })
    .sort((a, b) => b.mtime - a.mtime);
}
