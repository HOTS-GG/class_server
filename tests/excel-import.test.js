import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseExamExcel, buildTemplateExcel } from '../server/src/services/excelImport.js';

test('양식 파일 라운드트립: 예시 4문항이 그대로 파싱된다', () => {
  const buf = buildTemplateExcel();
  const { questions, errors } = parseExamExcel(buf);
  assert.deepEqual(errors, []);
  assert.equal(questions.length, 4);
  assert.equal(questions[0].type, 'mc');
  assert.equal(questions[0].answerIndex, 1);
  assert.deepEqual(questions[0].choices, ['1', '2', '3', '4']);
  assert.equal(questions[2].type, 'short');
  assert.deepEqual(questions[2].acceptedAnswers, ['H2O', '에이치투오']);
  assert.equal(questions[3].type, 'essay');
  assert.equal(questions[3].points, 10);
});

const sheetOf = (rows) => {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '문제');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

test('오류 행은 건너뛰고 행 번호와 함께 보고한다', () => {
  const buf = sheetOf([
    ['유형', '문제', '배점', '정답', '보기1', '보기2'],
    ['객관식', '정상 문항', 5, 1, 'A', 'B'],
    ['객관식', '정답 범위 벗어남', 5, 9, 'A', 'B'],
    ['괴상한유형', '유형 오류', 5, '', '', ''],
    ['객관식', '', 5, 1, 'A', 'B'],
    ['단답형', '정답 없음', 5, '', '', ''],
  ]);
  const { questions, errors } = parseExamExcel(buf);
  assert.equal(questions.length, 1);
  assert.equal(errors.length, 4);
  assert.ok(errors[0].includes('3행'));
});

test('헤더가 없으면 안내 오류', () => {
  const buf = sheetOf([['아무', '내용', '없음']]);
  const { questions, errors } = parseExamExcel(buf);
  assert.equal(questions.length, 0);
  assert.ok(errors[0].includes('헤더'));
});

test('빈 행은 조용히 무시', () => {
  const buf = sheetOf([
    ['유형', '문제', '배점', '정답', '보기1', '보기2'],
    ['', '', '', '', '', ''],
    ['객관식', 'Q', 5, 2, 'A', 'B'],
  ]);
  const { questions, errors } = parseExamExcel(buf);
  assert.equal(questions.length, 1);
  assert.deepEqual(errors, []);
});
