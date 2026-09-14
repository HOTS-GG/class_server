import * as XLSX from 'xlsx';

// 엑셀 문제 양식:
//   1행(헤더): 유형 | 문제 | 배점 | 정답 | 모범답안 | 채점기준 | 파일첨부 | 보기1 | 보기2 | ... (보기 최대 10개)
//   유형: 객관식 / 단답형 / 서술형
//   정답: 객관식 → 정답 보기 번호(1~N), 단답형 → 인정 답안(여러 개면 ; 로 구분), 서술형 → 비움
//   모범답안·채점기준: 서술형 전용 (AI 채점 근거). 채점기준은 줄바꿈으로 항목을 나누고 "항목 (n점)" 형태 권장.
//   파일첨부: 서술형 전용. "예"면 학생이 PDF/이미지/텍스트 파일을 답안에 첨부할 수 있음.
const TYPE_MAP = {
  '객관식': 'mc', 'mc': 'mc', '선택형': 'mc',
  '단답형': 'short', 'short': 'short', '주관식': 'short',
  '서술형': 'essay', 'essay': 'essay', '논술형': 'essay',
};
const MAX_CHOICES = 10;
const YES = new Set(['예', 'y', 'yes', 'o', 'true', '1', '허용']);

export function parseExamExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { questions: [], errors: ['시트를 찾을 수 없습니다.'] };
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // 헤더 행 탐색: "문제"라는 칸이 있는 첫 행
  const headerIdx = rows.findIndex((r) => r.some((c) => String(c).trim() === '문제'));
  if (headerIdx < 0) {
    return { questions: [], errors: ['헤더 행(유형/문제/배점/정답/보기1...)을 찾을 수 없습니다. 양식 파일을 사용하세요.'] };
  }
  const header = rows[headerIdx].map((c) => String(c).trim());
  const col = (name) => header.indexOf(name);
  const cType = col('유형');
  const cText = col('문제');
  const cPoints = col('배점');
  const cAnswer = col('정답');
  const cModel = col('모범답안');
  const cRubric = col('채점기준');
  const cFile = col('파일첨부');
  const choiceCols = [];
  for (let i = 1; i <= MAX_CHOICES; i++) {
    const idx = col(`보기${i}`);
    if (idx >= 0) choiceCols.push(idx);
  }
  const cell = (row, idx) => (idx >= 0 ? String(row[idx] ?? '').trim() : '');

  const questions = [];
  const errors = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1; // 엑셀 표시 행 번호
    const text = cell(row, cText);
    const typeRaw = cell(row, cType);
    if (!text && !typeRaw) continue; // 빈 행 무시

    const type = TYPE_MAP[typeRaw.toLowerCase()] ?? TYPE_MAP[typeRaw];
    if (!type) { errors.push(`${rowNo}행: 유형 "${typeRaw}"을(를) 알 수 없습니다. (객관식/단답형/서술형)`); continue; }
    if (!text) { errors.push(`${rowNo}행: 문제 내용이 비어 있습니다.`); continue; }

    const points = Number(row[cPoints]);
    if (!Number.isFinite(points) || points < 0) { errors.push(`${rowNo}행: 배점이 숫자가 아닙니다.`); continue; }

    const answerRaw = cell(row, cAnswer);

    if (type === 'mc') {
      const choices = choiceCols.map((ci) => cell(row, ci)).filter((c) => c !== '');
      if (choices.length < 2) { errors.push(`${rowNo}행: 객관식은 보기가 2개 이상 필요합니다.`); continue; }
      const answerNo = Number(answerRaw);
      if (!Number.isInteger(answerNo) || answerNo < 1 || answerNo > choices.length) {
        errors.push(`${rowNo}행: 정답은 1~${choices.length} 사이의 보기 번호여야 합니다. (입력값: "${answerRaw}")`);
        continue;
      }
      questions.push({ type: 'mc', text, points, choices, answerIndex: answerNo - 1 });
    } else if (type === 'short') {
      const accepted = answerRaw.split(';').map((s) => s.trim()).filter(Boolean);
      if (!accepted.length) { errors.push(`${rowNo}행: 단답형은 정답이 필요합니다. (여러 개면 ; 로 구분)`); continue; }
      questions.push({ type: 'short', text, points, acceptedAnswers: accepted });
    } else {
      // 서술형: 모범답안 열이 없으면 "정답" 열을 모범답안으로 받아준다.
      const modelAnswer = cell(row, cModel) || answerRaw;
      const rubric = cell(row, cRubric);
      const allowFile = YES.has(cell(row, cFile).toLowerCase());
      questions.push({ type: 'essay', text, points, modelAnswer, rubric, allowFile });
    }
  }

  if (!questions.length && !errors.length) errors.push('문항이 없습니다.');
  return { questions, errors };
}

// 교사 배부용 양식 파일 생성
export function buildTemplateExcel() {
  const header = ['유형', '문제', '배점', '정답', '모범답안', '채점기준', '파일첨부', '보기1', '보기2', '보기3', '보기4', '보기5'];
  const rows = [
    header,
    ['객관식', '1+1은 얼마인가?', 5, 2, '', '', '', '1', '2', '3', '4', ''],
    ['객관식', '대한민국의 수도는?', 5, 1, '', '', '', '서울', '부산', '대전', '광주', '인천'],
    ['단답형', '물의 화학식을 쓰시오.', 5, 'H2O; 에이치투오', '', '', '', '', '', '', '', ''],
    ['서술형', '광합성 과정을 설명하시오.', 10, '',
      '식물이 빛에너지를 이용해 이산화탄소와 물로부터 포도당과 산소를 만드는 과정이다. 엽록체에서 일어나며 명반응과 암반응(캘빈 회로)으로 나뉜다.',
      '빛·이산화탄소·물이 재료임을 언급 (3점)\n포도당과 산소가 생성됨을 언급 (3점)\n엽록체에서 일어남을 언급 (2점)\n명반응/암반응 구분 설명 (2점)',
      '아니오', '', '', '', '', ''],
    ['서술형', '조사한 자료를 바탕으로 우리 지역의 환경 문제와 해결 방안을 제안하시오. (보고서 파일 첨부 가능)', 20, '',
      '지역의 구체적 환경 문제를 하나 이상 자료와 함께 제시하고, 원인 분석과 실현 가능한 해결 방안을 논리적으로 제안한다.',
      '환경 문제를 구체적 근거(자료)와 함께 제시 (6점)\n원인 분석의 타당성 (5점)\n해결 방안의 실현 가능성과 구체성 (6점)\n글의 구성과 논리 (3점)',
      '예', '', '', '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 8 }, { wch: 44 }, { wch: 6 }, { wch: 18 }, { wch: 50 }, { wch: 50 }, { wch: 8 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '문제');

  const guide = XLSX.utils.aoa_to_sheet([
    ['열', '설명'],
    ['유형', '객관식 / 단답형 / 서술형'],
    ['문제', '문항 내용 (줄바꿈 가능)'],
    ['배점', '숫자'],
    ['정답', '객관식: 정답 보기 번호(1~N) · 단답형: 인정 답안(여러 개면 ; 로 구분) · 서술형: 비움'],
    ['모범답안', '서술형 전용. AI 채점의 기준이 되는 예시 답안'],
    ['채점기준', '서술형 전용. 줄바꿈으로 항목을 나누고 "항목 (n점)" 형태로 쓰면 AI가 항목별로 채점합니다. 항목 점수 합 = 배점'],
    ['파일첨부', '서술형 전용. "예"면 학생이 답안에 파일(PDF/이미지/TXT, 10MB 이하)을 첨부할 수 있습니다.'],
    ['보기1~보기10', '객관식 전용. 빈 칸은 무시'],
    [''],
    ['안내', '객관식·단답형은 AI 없이 자동 채점됩니다. 서술형만 [도구] 탭에서 설정한 OpenRouter AI가 채점 초안을 만들고, 교사가 검토 후 반영합니다.'],
    ['주의', '종이에 쓴 답안을 스캔/촬영한 파일은 지원하지 않습니다. 손글씨는 정확히 인식되지 않아 채점이 틀릴 수 있습니다. 답안은 반드시 컴퓨터로 작성하세요.'],
  ]);
  guide['!cols'] = [{ wch: 12 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, guide, '작성안내');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// 결과 엑셀 (점수 + AI 채점 + 피드백)
export function buildResultsExcel({ exam, rows, questionStats }) {
  const wb = XLSX.utils.book_new();

  const qTypeKo = { mc: '객관식', short: '단답형', essay: '서술형' };
  const qLabel = (q, i) => `Q${i + 1} ${qTypeKo[q.type]}(${q.points}점)`;

  // 시트1: 점수표
  const header = [
    '출석번호', '이름', '응시', '제출시각', '제출유형', '이탈횟수', '이탈시간(초)',
    '자동채점점수', '서술형점수', '총점', '만점',
    ...exam.questions.map(qLabel),
  ];
  const scoreRows = [header, ...rows.map((r) => [
    r.number, r.name, r.status, r.submittedAt, r.submitType, r.awayCount, r.awaySec,
    r.autoScore, r.manualScore, r.total, r.maxTotal,
    ...exam.questions.map((q) => r.perQuestion[q.id] ?? ''),
  ])];
  if (questionStats) scoreRows.push(['', '', '', '', '', '', '', '', '', '', '문항별 정답률(%)', ...questionStats]);
  const ws1 = XLSX.utils.aoa_to_sheet(scoreRows);
  ws1['!cols'] = [{ wch: 8 }, { wch: 10 }, { wch: 7 }, { wch: 20 }, { wch: 9 }, { wch: 8 }, { wch: 11 },
    { wch: 11 }, { wch: 10 }, { wch: 7 }, { wch: 7 }, ...exam.questions.map(() => ({ wch: 14 }))];
  XLSX.utils.book_append_sheet(wb, ws1, '점수');

  // 시트2: 서술형 상세 (답안 · AI 점수 · 확정 점수 · 피드백)
  const essayQs = exam.questions.map((q, i) => ({ q, i })).filter(({ q }) => q.type === 'essay');
  if (essayQs.length) {
    const eh = ['출석번호', '이름', '문항', '배점', '학생 답안', '첨부 파일', 'AI 점수', 'AI 확신도', 'AI 항목별 채점', 'AI 요약(첨부)', '확정 점수', '학생에게 보낸 피드백'];
    const erows = [eh];
    for (const r of rows) {
      for (const { q, i } of essayQs) {
        const d = r.essayDetail?.[q.id];
        if (!d) continue;
        erows.push([
          r.number, r.name, `Q${i + 1}`, q.points,
          d.answerText, d.fileName,
          d.aiScore, d.aiConfidence, d.aiCriteria, d.aiSummary,
          d.finalScore, d.feedback,
        ]);
      }
    }
    const ws2 = XLSX.utils.aoa_to_sheet(erows);
    ws2['!cols'] = [{ wch: 8 }, { wch: 10 }, { wch: 6 }, { wch: 6 }, { wch: 60 }, { wch: 18 },
      { wch: 8 }, { wch: 9 }, { wch: 50 }, { wch: 40 }, { wch: 9 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, ws2, '서술형 상세');
  }

  // 시트3: 문항 정보
  const qrows = [['번호', '유형', '배점', '문제', '정답/모범답안', '채점기준']];
  exam.questions.forEach((q, i) => {
    const ans = q.type === 'mc' ? (q.choices.findIndex((c) => c.id === q.answerChoiceId) + 1)
      : q.type === 'short' ? (q.acceptedAnswers ?? []).join('; ')
        : (q.modelAnswer ?? '');
    qrows.push([i + 1, qTypeKo[q.type], q.points, q.text, ans, q.rubric ?? '']);
  });
  const ws3 = XLSX.utils.aoa_to_sheet(qrows);
  ws3['!cols'] = [{ wch: 5 }, { wch: 7 }, { wch: 5 }, { wch: 50 }, { wch: 40 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws3, '문항');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
