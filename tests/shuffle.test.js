import test from 'node:test';
import assert from 'node:assert/strict';
import { seededShuffle, buildAttemptOrders } from '../shared/src/shuffle.js';

const ITEMS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'];

test('같은 시드는 항상 같은 순서를 만든다 (결정성)', () => {
  const a = seededShuffle(ITEMS, 'exam1|stu1');
  const b = seededShuffle(ITEMS, 'exam1|stu1');
  assert.deepEqual(a, b);
});

test('다른 학생은 (거의 항상) 다른 순서를 받는다', () => {
  const orders = new Set();
  for (let i = 1; i <= 30; i++) {
    orders.add(seededShuffle(ITEMS, `exam1|stu${i}`).join(','));
  }
  // 10! 가지 순열 중 30명이 3가지 이하로 겹칠 확률은 사실상 0
  assert.ok(orders.size > 25, `순서 다양성 부족: ${orders.size}`);
});

test('셔플 결과는 원소를 잃거나 더하지 않는다', () => {
  const shuffled = seededShuffle(ITEMS, 'seed-x');
  assert.deepEqual([...shuffled].sort(), [...ITEMS].sort());
  assert.equal(ITEMS[0], 'q1'); // 원본 불변
});

test('buildAttemptOrders: 옵션에 따라 문항/선택지 셔플', () => {
  const exam = {
    id: 'ex1',
    shuffleQuestions: true,
    shuffleChoices: true,
    questions: [
      { id: 'q1', type: 'mc', choices: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }] },
      { id: 'q2', type: 'essay' },
      { id: 'q3', type: 'mc', choices: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
    ],
  };
  const { questionOrder, choiceOrder } = buildAttemptOrders(exam, 'stuA');
  assert.deepEqual([...questionOrder].sort(), ['q1', 'q2', 'q3']);
  assert.deepEqual([...choiceOrder.q1].sort(), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(choiceOrder.q2, undefined); // 서술형은 선택지 없음
  // 결정성
  const again = buildAttemptOrders(exam, 'stuA');
  assert.deepEqual(again.questionOrder, questionOrder);
  assert.deepEqual(again.choiceOrder, choiceOrder);
});

test('buildAttemptOrders: 셔플 꺼짐이면 원래 순서', () => {
  const exam = {
    id: 'ex2',
    shuffleQuestions: false,
    shuffleChoices: false,
    questions: [
      { id: 'q1', type: 'mc', choices: [{ id: 'c1' }, { id: 'c2' }] },
      { id: 'q2', type: 'mc', choices: [{ id: 'c1' }, { id: 'c2' }] },
    ],
  };
  const { questionOrder, choiceOrder } = buildAttemptOrders(exam, 'stuA');
  assert.deepEqual(questionOrder, ['q1', 'q2']);
  assert.deepEqual(choiceOrder.q1, ['c1', 'c2']);
});
