// 시드 기반 결정적 셔플: 같은 시드는 항상 같은 순서를 만든다.
// 문항 순서 시드: `${examId}|${studentId}`
// 선택지 순서 시드: `${examId}|${studentId}|${questionId}`

// cyrb53 문자열 해시 → 53bit 정수
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// mulberry32 PRNG
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates. 원본을 변경하지 않고 새 배열을 반환한다.
export function seededShuffle(array, seedString) {
  const rand = mulberry32(hashString(seedString) >>> 0);
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 시험 시작 시 학생별 문항/선택지 순서를 확정한다.
export function buildAttemptOrders(exam, studentId) {
  const questionIds = exam.questions.map((q) => q.id);
  const questionOrder = exam.shuffleQuestions
    ? seededShuffle(questionIds, `${exam.id}|${studentId}`)
    : questionIds;

  const choiceOrder = {};
  for (const q of exam.questions) {
    if (q.type !== 'mc' || !Array.isArray(q.choices)) continue;
    const choiceIds = q.choices.map((c) => c.id);
    choiceOrder[q.id] = exam.shuffleChoices
      ? seededShuffle(choiceIds, `${exam.id}|${studentId}|${q.id}`)
      : choiceIds;
  }
  return { questionOrder, choiceOrder };
}
