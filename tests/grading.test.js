import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeMultipleChoice, computeTotalScore } from '../shared/src/grading.js';

const EXAM = {
  id: 'ex1',
  questions: [
    { id: 'q1', type: 'mc', points: 5, answerChoiceId: 'c2', choices: [{ id: 'c1' }, { id: 'c2' }] },
    { id: 'q2', type: 'mc', points: 5, answerChoiceId: 'c1', choices: [{ id: 'c1' }, { id: 'c2' }] },
    { id: 'q3', type: 'essay', points: 10 },
  ],
};

test('객관식 자동 채점: 정답만 득점', () => {
  const { perQuestion, mcScore, mcTotal } = gradeMultipleChoice(EXAM, {
    q1: { choiceId: 'c2' },
    q2: { choiceId: 'c2' },
  });
  assert.equal(perQuestion.q1, 5);
  assert.equal(perQuestion.q2, 0);
  assert.equal(mcScore, 5);
  assert.equal(mcTotal, 10);
});

test('무응답은 0점', () => {
  const { mcScore } = gradeMultipleChoice(EXAM, {});
  assert.equal(mcScore, 0);
});

test('총점 = 객관식 + 서술형 수동 채점', () => {
  const r = computeTotalScore(EXAM, { q1: { choiceId: 'c2' } }, { q3: 7 });
  assert.equal(r.mcScore, 5);
  assert.equal(r.essayScore, 7);
  assert.equal(r.total, 12);
  assert.equal(r.maxTotal, 20);
});

test('서술형 점수는 배점을 초과할 수 없고 음수 불가', () => {
  const over = computeTotalScore(EXAM, {}, { q3: 999 });
  assert.equal(over.essayScore, 10);
  const neg = computeTotalScore(EXAM, {}, { q3: -3 });
  assert.equal(neg.essayScore, 0);
});
