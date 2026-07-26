// 채점: 답안은 choiceId/text로 저장되므로 셔플 순서와 무관하게 채점된다.
// 유형: mc(객관식, 자동) / short(단답형, 자동 + 수동 정정 가능) / essay(서술형, 수동)

// 단답형 비교용 정규화: 앞뒤·중간 공백 제거, 대소문자 무시
export function normalizeShort(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

export function isShortCorrect(question, text) {
  const norm = normalizeShort(text);
  if (!norm) return false;
  return (question.acceptedAnswers ?? []).some((a) => normalizeShort(a) === norm);
}

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

// 총점 = 자동 채점(객관식+단답형) + 수동 채점(서술형).
// manualGrades[qid]가 있으면 해당 문항 점수를 수동 값으로 정정한다(단답형 오타 인정 등).
export function computeTotalScore(exam, answers, manualGrades = {}) {
  const perQuestion = {};
  let autoScore = 0;
  let autoTotal = 0;
  let manualScore = 0;
  let manualTotal = 0;

  for (const q of exam.questions) {
    const clamp = (n) => Math.max(0, Math.min(q.points, n));
    const overrideRaw = Number(manualGrades[q.id]);
    const hasOverride = manualGrades[q.id] !== undefined && manualGrades[q.id] !== null
      && manualGrades[q.id] !== '' && Number.isFinite(overrideRaw);
    const ans = answers?.[q.id];

    if (q.type === 'essay') {
      manualTotal += q.points;
      if (hasOverride) {
        const earned = clamp(overrideRaw);
        perQuestion[q.id] = earned;
        manualScore += earned;
      }
      continue;
    }

    autoTotal += q.points;
    let earned;
    if (hasOverride) {
      earned = clamp(overrideRaw);
    } else if (q.type === 'mc') {
      earned = ans && ans.choiceId === q.answerChoiceId ? q.points : 0;
    } else { // short
      earned = ans && isShortCorrect(q, ans.text) ? q.points : 0;
    }
    perQuestion[q.id] = earned;
    autoScore += earned;
  }

  return {
    perQuestion,
    autoScore,
    autoTotal,
    manualScore,
    manualTotal,
    // 하위 호환 별칭
    mcScore: autoScore,
    mcTotal: autoTotal,
    essayScore: manualScore,
    essayTotal: manualTotal,
    total: autoScore + manualScore,
    maxTotal: autoTotal + manualTotal,
  };
}
