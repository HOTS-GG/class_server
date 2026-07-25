import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, parseCsv, csvEscape } from '../shared/src/csv.js';

test('CSV는 UTF-8 BOM(U+FEFF)으로 시작한다', () => {
  const csv = toCsv([['이름', '점수'], ['김철수', 90]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const bytes = Buffer.from(csv, 'utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('행 구분은 CRLF', () => {
  const csv = toCsv([['a'], ['b']]);
  assert.ok(csv.includes('a\r\nb'));
  assert.ok(csv.endsWith('\r\n'));
});

test('쉼표/따옴표/줄바꿈 이스케이프', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape(null), '');
});

test('parseCsv 라운드트립 (BOM 제거 포함)', () => {
  const rows = [['번호', '이름'], ['1', '김, 철수'], ['2', '이"영"희']];
  const parsed = parseCsv(toCsv(rows));
  assert.deepEqual(parsed, rows);
});

test('parseCsv: 빈 줄 무시', () => {
  const parsed = parseCsv('a,b\r\n\r\n1,2\r\n');
  assert.deepEqual(parsed, [['a', 'b'], ['1', '2']]);
});
