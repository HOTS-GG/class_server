import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseExamExcel, buildTemplateExcel, buildResultsExcel } from '../server/src/services/excelImport.js';

test('양식 파일 라운드트립: 예시 5문항이 그대로 파싱된다', () => {
  const buf = buildTemplateExcel();
  const { questions, errors } = parseExamExcel(buf);
  assert.deepEqual(errors, []);
  assert.equal(questions.length, 5);
  assert.equal(questions[0].type, 'mc');
  assert.equal(questions[0].answerIndex, 1);
  assert.deepEqual(questions[0].choices, ['1', '2', '3', '4']);
  assert.equal(questions[2].type, 'short');
  assert.deepEqual(questions[2].acceptedAnswers, ['H2O', '에이치투오']);
  assert.equal(questions[3].type, 'essay');
  assert.equal(questions[3].points, 10);
  // 서술형 채점 근거(모범답안·채점기준)와 파일첨부 여부
  assert.ok(questions[3].modelAnswer.includes('포도당'));
  assert.ok(questions[3].rubric.includes('(3점)'));
  assert.equal(questions[3].allowFile, false);
  assert.equal(questions[4].allowFile, true);
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

test('구버전 양식(모범답안 열 없음): 서술형의 정답 칸을 모범답안으로 받는다', () => {
  const buf = sheetOf([
    ['유형', '문제', '배점', '정답', '보기1', '보기2'],
    ['서술형', '설명하시오', 10, '이것이 모범답안', '', ''],
  ]);
  const { questions, errors } = parseExamExcel(buf);
  assert.deepEqual(errors, []);
  assert.equal(questions[0].modelAnswer, '이것이 모범답안');
  assert.equal(questions[0].rubric, '');
  assert.equal(questions[0].allowFile, false);
});

test('파일첨부 열은 예/Y/yes/O 를 허용으로 본다', () => {
  const buf = sheetOf([
    ['유형', '문제', '배점', '정답', '모범답안', '채점기준', '파일첨부'],
    ['서술형', 'A', 10, '', '', '', '예'],
    ['서술형', 'B', 10, '', '', '', 'Y'],
    ['서술형', 'C', 10, '', '', '', '아니오'],
    ['서술형', 'D', 10, '', '', '', ''],
  ]);
  const { questions } = parseExamExcel(buf);
  assert.deepEqual(questions.map((q) => q.allowFile), [true, true, false, false]);
});

test('결과 엑셀: 점수/서술형 상세/문항 시트가 생성된다', () => {
  const exam = {
    title: 'T',
    questions: [
      { id: 'q1', type: 'mc', points: 5, text: '1+1', choices: [{ id: 'c1', text: '1' }, { id: 'c2', text: '2' }], answerChoiceId: 'c2' },
      { id: 'q2', type: 'essay', points: 10, text: '설명', modelAnswer: '모범', rubric: '기준 (10점)' },
    ],
  };
  const rows = [{
    number: 1, name: '김민준', status: '제출', submittedAt: '', submitType: '직접제출', awayCount: 0, awaySec: 0,
    autoScore: 5, manualScore: 8, total: 13, maxTotal: 15, perQuestion: { q1: 5, q2: 8 },
    essayDetail: { q2: { answerText: '답', fileName: '', aiScore: 8, aiConfidence: 0.9, aiCriteria: '기준: 8/10 — 좋음', aiSummary: '', finalScore: 8, feedback: '잘했어요' } },
  }];
  const buf = buildResultsExcel({ exam, rows, questionStats: [100, 80] });
  const wb = XLSX.read(buf, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['점수', '서술형 상세', '문항']);
  const score = XLSX.utils.sheet_to_json(wb.Sheets['점수'], { header: 1 });
  assert.equal(score[1][1], '김민준');
  assert.equal(score[1][9], 13);
  const essay = XLSX.utils.sheet_to_json(wb.Sheets['서술형 상세'], { header: 1 });
  assert.equal(essay[1][6], 8);
  assert.equal(essay[1][11], '잘했어요');
});
