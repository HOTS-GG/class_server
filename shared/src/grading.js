// 채점: 답안은 choiceId로 저장되므로 셔플 순서와 무관하게 채점된다.

// 객관식 자동 채점. 문항별 획득 점수 맵과 객관식 합계를 반환.
export function gradeMultipleChoice(exam, answers) {
  const perQuestion = {};
  let mcScore = 0;
  let mcTotal = 0;
  for (const q of exam.questions) {
    if (q.type !== 'mc') continue;
    mcTotal += q.points;
    const ans = answers?.[q.id];
    const earned = ans && ans.choiceId === q.answerChoiceId ? q.points : 0;
    perQuestion[q.id] = earned;
    mcScore += earned;
  }
  return { perQuestion, mcScore, mcTotal };
}

// 총점 = 객관식 자동 채점 + 서술형 수동 채점(manualGrades)
export function computeTotalScore(exam, answers, manualGrades = {}) {
  const { perQuestion, mcScore, mcTotal } = gradeMultipleChoice(exam, answers);
  let essayScore = 0;
  let essayTotal = 0;
  for (const q of exam.questions) {
    if (q.type !== 'essay') continue;
    essayTotal += q.points;
    const g = Number(manualGrades[q.id]);
    if (Number.isFinite(g)) {
      const earned = Math.max(0, Math.min(q.points, g));
      perQuestion[q.id] = earned;
      essayScore += earned;
    }
  }
  return {
    perQuestion,
    mcScore,
    mcTotal,
    essayScore,
    essayTotal,
    total: mcScore + essayScore,
    maxTotal: mcTotal + essayTotal,
  };
}
