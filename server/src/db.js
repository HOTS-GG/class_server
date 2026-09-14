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

// lowdb(JSON) + append-only JSONL 이중 저장.
// - db.json: 전체 상태. 쓰기는 2초 디바운스(잦은 답안 저장으로 인한 전체 재기록 방지)
// - events/*.jsonl: 답안·이탈로그를 즉시 append → 서버가 죽어도 리플레이로 복구
export async function openDb(dataDir) {
  for (const sub of ['events', path.join('files', 'assignments'), path.join('files', 'submissions'), path.join('files', 'exam-answers'), 'tmp']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  const low = new Low(new JSONFile(path.join(dataDir, 'db.json')), structuredClone(DEFAULT_DATA));
  await low.read();
  low.data = { ...structuredClone(DEFAULT_DATA), ...(low.data ?? {}) };

  const s = low.data.settings;
  if (!s.tokenSecret) s.tokenSecret = randomBytes(24).toString('hex');
  if (!s.serverName) s.serverName = '우리반 수업 서버';
  // AI 채점 설정 (OpenRouter). 키는 교사 PC의 db.json에만 저장되고 학생에게는 절대 전달되지 않는다.
  if (!s.ai) s.ai = { apiKey: '', model: '', pdfEngine: 'pdf-text' };
  // 구버전 데이터 호환: 응시 기록에 AI/피드백 필드 보강
  for (const att of low.data.attempts) {
    att.aiGrades ??= {};
    att.feedback ??= {};
    att.manualGrades ??= {};
  }
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

  const eventPath = (name) => path.join(dataDir, 'events', `${name}.jsonl`);

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

  return { data: low.data, dataDir, scheduleFlush, flushNow, appendEvent, readEvents };
}
