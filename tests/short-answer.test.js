import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTotalScore, isShortCorrect, normalizeShort } from '../shared/src/grading.js';

const EXAM = {
  id: 'ex1',
  questions: [
    { id: 'q1', type: 'mc', points: 5, answerChoiceId: 'c1', choices: [{ id: 'c1' }, { id: 'c2' }] },
    { id: 'q2', type: 'short', points: 5, acceptedAnswers: ['H2O', '에이치투오'] },
    { id: 'q3', type: 'essay', points: 10 },
  ],
};

test('단답형 정규화: 공백/대소문자 무시', () => {
  assert.equal(normalizeShort('  H 2 O  '), 'h2o');
  assert.ok(isShortCorrect(EXAM.questions[1], ' h2o '));
  assert.ok(isShortCorrect(EXAM.questions[1], '에이치 투오'));
  assert.ok(!isShortCorrect(EXAM.questions[1], 'CO2'));
  assert.ok(!isShortCorrect(EXAM.questions[1], ''));
});

test('단답형 자동 채점이 총점에 반영', () => {
  const r = computeTotalScore(EXAM, {
    q1: { choiceId: 'c1' },
    q2: { text: 'h2o' },
  });
  assert.equal(r.autoScore, 10);
  assert.equal(r.autoTotal, 10);
  assert.equal(r.total, 10);
  assert.equal(r.maxTotal, 20);
});

test('단답형 수동 정정: 오타 부분 인정', () => {
  const r = computeTotalScore(EXAM, { q2: { text: 'H20' } }, { q2: 3 }); // 숫자 0 오타 → 3점 인정
  assert.equal(r.perQuestion.q2, 3);
  assert.equal(r.autoScore, 3);
});

test('수동 정정 해제(빈 값)는 자동 채점으로 복귀', () => {
  const r = computeTotalScore(EXAM, { q2: { text: 'h2o' } }, { q2: '' });
  assert.equal(r.perQuestion.q2, 5);
});
