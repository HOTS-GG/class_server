import * as XLSX from 'xlsx';

// 엑셀 문제 양식:
//   1행(헤더): 유형 | 문제 | 배점 | 정답 | 보기1 | 보기2 | 보기3 | 보기4 | (보기 최대 10개)
//   유형: 객관식 / 단답형 / 서술형
//   정답: 객관식 → 정답 보기 번호(1~N), 단답형 → 인정 답안(여러 개면 ; 로 구분), 서술형 → 비움
const TYPE_MAP = {
  '객관식': 'mc', 'mc': 'mc', '선택형': 'mc',
  '단답형': 'short', 'short': 'short', '주관식': 'short',
  '서술형': 'essay', 'essay': 'essay', '논술형': 'essay',
};
const MAX_CHOICES = 10;

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
  const choiceCols = [];
  for (let i = 1; i <= MAX_CHOICES; i++) {
    const idx = col(`보기${i}`);
    if (idx >= 0) choiceCols.push(idx);
  }

  const questions = [];
  const errors = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1; // 엑셀 표시 행 번호
    const text = String(row[cText] ?? '').trim();
    const typeRaw = String(row[cType] ?? '').trim();
    if (!text && !typeRaw) continue; // 빈 행 무시

    const type = TYPE_MAP[typeRaw.toLowerCase()] ?? TYPE_MAP[typeRaw];
    if (!type) { errors.push(`${rowNo}행: 유형 "${typeRaw}"을(를) 알 수 없습니다. (객관식/단답형/서술형)`); continue; }
    if (!text) { errors.push(`${rowNo}행: 문제 내용이 비어 있습니다.`); continue; }

    const points = Number(row[cPoints]);
    if (!Number.isFinite(points) || points < 0) { errors.push(`${rowNo}행: 배점이 숫자가 아닙니다.`); continue; }

    const answerRaw = String(row[cAnswer] ?? '').trim();

    if (type === 'mc') {
      const choices = choiceCols.map((ci) => String(row[ci] ?? '').trim()).filter((c) => c !== '');
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
      questions.push({ type: 'essay', text, points });
    }
  }

  if (!questions.length && !errors.length) errors.push('문항이 없습니다.');
  return { questions, errors };
}

// 교사 배부용 양식 파일 생성
export function buildTemplateExcel() {
  const rows = [
    ['유형', '문제', '배점', '정답', '보기1', '보기2', '보기3', '보기4', '보기5'],
    ['객관식', '1+1은 얼마인가?', 5, 2, '1', '2', '3', '4', ''],
    ['객관식', '대한민국의 수도는?', 5, 1, '서울', '부산', '대전', '광주', '인천'],
    ['단답형', '물의 화학식을 쓰시오.', 5, 'H2O; 에이치투오', '', '', '', '', ''],
    ['서술형', '광합성 과정을 설명하시오.', 10, '', '', '', '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 8 }, { wch: 40 }, { wch: 6 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '문제');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
