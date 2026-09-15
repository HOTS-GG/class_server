import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, listBackupsIn } from '../server/src/db.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'class-db-'));

test('API 키는 세이브 파일이 아니라 비밀값 파일에 저장되고, 구버전 키는 옮겨진다', async () => {
  const dir = tmp();
  const dbFile = path.join(dir, '반.classdb');
  fs.writeFileSync(dbFile, JSON.stringify({ settings: { ai: { apiKey: 'sk-or-old', model: 'm' } } }));
  const db = await openDb(path.join(dir, '반.files'), { dbFile, secretsFile: path.join(dir, 'profile', 'secrets.json') });
  assert.equal(db.getApiKey(), 'sk-or-old');
  assert.equal(db.data.settings.ai.apiKey, undefined);
  assert.equal(db.data.settings.ai.model, 'm');
  db.setApiKey('sk-or-new ');
  await db.flushNow();
  const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.ok(!JSON.stringify(saved).includes('sk-or-'), '세이브 파일에 키가 남으면 안 됨');
  const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'profile', 'secrets.json'), 'utf8'));
  assert.equal(secrets.openrouterApiKey, 'sk-or-new');
  await db.flushNow();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('열 때 일일 백업이 생기고, 수동 백업은 최근 20개만 남긴다', async () => {
  const dir = tmp();
  const dbFile = path.join(dir, '반.classdb');
  const db = await openDb(path.join(dir, '반.files'), { dbFile });
  const first = db.listBackups();
  assert.equal(first.length, 1);
  assert.equal(first[0].reason, 'daily');
  assert.ok(db.data.settings.lastBackupAt > 0);
  for (let i = 0; i < 25; i++) await db.backup('manual'); // 파일명 시각이 초 단위라 같은 이름은 덮어써질 수 있음
  const list = db.listBackups();
  assert.ok(list.length <= 20, `보관 개수 ${list.length}`);
  assert.ok(list.every((b) => b.name.endsWith('.classdb')));
  // 백업 내용은 세이브와 동일한 JSON
  const content = JSON.parse(fs.readFileSync(list[0].path, 'utf8'));
  assert.ok(content.settings.tokenSecret);
  // 다시 열면 24시간 안이므로 일일 백업이 추가되지 않는다
  const before = db.listBackups().length;
  const db2 = await openDb(path.join(dir, '반.files'), { dbFile });
  assert.equal(db2.listBackups().length, before);
  await db.flushNow(); await db2.flushNow();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('세이브 파일이 손상되면 최신 백업으로 자동 복구한다', async () => {
  const dir = tmp();
  const dbFile = path.join(dir, '반.classdb');
  const db = await openDb(path.join(dir, '반.files'), { dbFile });
  db.data.students.push({ id: 's1', number: 1, name: '복구확인', active: true });
  await db.backup('manual');
  fs.writeFileSync(dbFile, '{ this is not json');
  const db2 = await openDb(path.join(dir, '반.files'), { dbFile });
  assert.ok(db2.recoveredFrom, '복구 출처가 기록되어야 함');
  assert.equal(db2.data.students[0]?.name, '복구확인');
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), '손상 파일 사본 보존');
  await db.flushNow(); await db2.flushNow();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('이벤트 로그 정리: 없는 시험·오래전 종료 시험의 로그는 삭제, 진행 중·최근 종료는 유지', async () => {
  const dir = tmp();
  const dataDir = path.join(dir, '반.files');
  const dbFile = path.join(dir, '반.classdb');
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  fs.mkdirSync(path.join(dataDir, 'events'), { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify({ exams: [
    { id: 'ex_active', status: 'active', questions: [] },
    { id: 'ex_recent', status: 'ended', endedAt: Date.now() - 1000, questions: [] },
    { id: 'ex_old', status: 'ended', endedAt: old, questions: [] },
  ] }));
  for (const n of ['answers-ex_active', 'focus-ex_recent', 'answers-ex_old', 'focus-ex_gone']) {
    fs.writeFileSync(path.join(dataDir, 'events', `${n}.jsonl`), '{}\n');
  }
  fs.writeFileSync(path.join(dataDir, 'events', 'focus-general.jsonl'), 'x'.repeat(6 * 1024 * 1024));
  const db = await openDb(dataDir, { dbFile });
  const left = fs.readdirSync(path.join(dataDir, 'events')).sort();
  assert.deepEqual(left, ['answers-ex_active.jsonl', 'focus-ex_recent.jsonl', 'focus-general.1.jsonl']);
  db.deleteEvents('answers-ex_active');
  assert.ok(!fs.existsSync(path.join(dataDir, 'events', 'answers-ex_active.jsonl')));
  // 작은 일반 로그는 회전하지 않는다
  fs.writeFileSync(path.join(dataDir, 'events', 'focus-general.jsonl'), '{}\n');
  db.pruneEvents();
  assert.ok(fs.existsSync(path.join(dataDir, 'events', 'focus-general.jsonl')));
  await db.flushNow();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listBackupsIn: 없는 폴더는 빈 배열, 최신순 정렬', () => {
  assert.deepEqual(listBackupsIn(path.join(os.tmpdir(), 'no-such-dir-xyz')), []);
});
