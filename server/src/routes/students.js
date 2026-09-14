import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { parseCsv, toCsv } from '../../../shared/src/csv.js';
import { newId, newAccessCode } from '../../../shared/src/id.js';

// 명단 양식(엑셀): 1행 헤더 "번호 | 이름", 2행부터 학생. 헤더 행은 "이름" 칸으로 찾는다.
export function buildStudentTemplateExcel() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['번호', '이름'],
    [1, '김민준'], [2, '이서연'], [3, '박도윤'], [4, '최지우'], [5, '정하은'],
  ]);
  ws['!cols'] = [{ wch: 8 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '명단');
  const guide = XLSX.utils.aoa_to_sheet([
    ['안내'],
    ['번호 열에 출석번호(1~999 정수), 이름 열에 학생 이름을 적습니다.'],
    ['예시 5명은 지우고 실제 학생으로 바꿔 주세요. 빈 행은 무시됩니다.'],
    ['같은 번호가 이미 등록되어 있으면 건너뜁니다. 접속 코드는 등록 시 자동 발급됩니다.'],
    ['CSV(번호,이름)로 저장한 파일도 같은 방법으로 불러올 수 있습니다.'],
  ]);
  guide['!cols'] = [{ wch: 80 }];
  XLSX.utils.book_append_sheet(wb, guide, '작성안내');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// 엑셀 명단 → [[번호, 이름], ...] (헤더 행 제외)
export function parseStudentExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headerIdx = rows.findIndex((row) => row.some((c) => String(c).trim() === '이름'));
  const header = headerIdx >= 0 ? rows[headerIdx].map((c) => String(c).trim()) : null;
  const cNum = header ? header.indexOf('번호') : 0;
  const cName = header ? header.indexOf('이름') : 1;
  return rows.slice(headerIdx + 1)
    .map((row) => [row[cNum >= 0 ? cNum : 0], row[cName >= 0 ? cName : 1]])
    .filter(([n, name]) => String(n ?? '').trim() !== '' || String(name ?? '').trim() !== '');
}

export function studentsRouter({ db, presence }) {
  const r = Router();

  const uniqueCode = () => {
    let code;
    do { code = newAccessCode(); }
    while (db.data.students.some((s) => s.code === code));
    return code;
  };

  const addStudent = (number, name) => {
    const stu = {
      id: newId('stu'),
      number: Number(number),
      name: String(name).trim(),
      code: uniqueCode(),
      active: true,
      createdAt: Date.now(),
    };
    db.data.students.push(stu);
    return stu;
  };

  r.get('/', (req, res) => {
    const list = db.data.students
      .filter((s) => s.active)
      .sort((a, b) => a.number - b.number)
      .map((s) => ({ ...s, presence: presence.snapshot(s.id) }));
    res.json(list);
  });

  r.post('/', (req, res) => {
    const { number, name } = req.body ?? {};
    const n = Number(String(number ?? '').trim());
    if (!String(name ?? '').trim() || !Number.isInteger(n) || n < 1 || n > 999) {
      return res.status(400).json({ error: '출석번호는 1~999 사이의 정수, 이름은 비어 있을 수 없습니다.' });
    }
    if (db.data.students.some((s) => s.active && s.number === n)) {
      return res.status(400).json({ error: `${n}번은 이미 등록되어 있습니다.` });
    }
    const stu = addStudent(n, name);
    db.scheduleFlush();
    res.json(stu);
  });

  // CSV 텍스트 업로드: "번호,이름" 형식 (헤더 행 자동 감지)
  // [번호, 이름] 행 목록을 명단에 추가. 헤더·잘못된 행·중복은 건너뛰고 사유와 함께 보고.
  const importRows = (rows) => {
    const added = [];
    const skipped = [];
    for (const row of rows) {
      const [numRaw, nameRaw] = row;
      const number = Number(String(numRaw ?? '').trim());
      const name = String(nameRaw ?? '').trim();
      if (String(numRaw ?? '').trim() === '번호' && name === '이름') continue; // 헤더 행
      if (!Number.isInteger(number) || number < 1 || number > 999 || !name) { skipped.push(`${row.join(',')} (형식 오류)`); continue; }
      if (db.data.students.some((s) => s.active && s.number === number)) {
        skipped.push(`${number},${name} (같은 번호 이미 등록)`);
        continue;
      }
      added.push(addStudent(number, name));
    }
    db.scheduleFlush();
    return { addedCount: added.length, skipped };
  };

  // 명단 양식(엑셀) 다운로드 (주의: '/:id' 라우트보다 먼저)
  r.get('/template.xlsx', (req, res) => {
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('학생명단양식.xlsx'));
    res.send(buildStudentTemplateExcel());
  });

  r.post('/import', (req, res) => {
    const csv = req.body?.csv;
    if (typeof csv !== 'string' || !csv.trim()) {
      return res.status(400).json({ error: 'CSV 내용이 비어 있습니다.' });
    }
    res.json(importRows(parseCsv(csv)));
  });

  // 엑셀 명단 업로드 (양식 파일 또는 번호/이름 열이 있는 시트)
  const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  r.post('/import-excel', excelUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '엑셀 파일이 필요합니다.' });
    try {
      const rows = parseStudentExcel(req.file.buffer);
      if (!rows.length) return res.status(400).json({ error: '시트에서 학생 행을 찾지 못했습니다. 양식 파일(번호 | 이름)을 사용하세요.' });
      res.json(importRows(rows));
    } catch (err) {
      res.status(400).json({ error: `엑셀 읽기 실패: ${err.message}` });
    }
  });

  r.post('/:id/code', (req, res) => {
    const stu = db.data.students.find((s) => s.id === req.params.id && s.active);
    if (!stu) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
    stu.code = uniqueCode();
    db.scheduleFlush();
    res.json(stu);
  });

  r.delete('/:id', (req, res) => {
    const stu = db.data.students.find((s) => s.id === req.params.id && s.active);
    if (!stu) return res.status(404).json({ error: '학생을 찾을 수 없습니다.' });
    stu.active = false;
    db.scheduleFlush();
    res.json({ ok: true });
  });

  // 학생 배부용 코드표
  r.get('/codes.csv', (req, res) => {
    const rows = [['출석번호', '이름', '접속코드']];
    for (const s of db.data.students.filter((x) => x.active).sort((a, b) => a.number - b.number)) {
      rows.push([s.number, s.name, s.code]);
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('접속코드.csv'));
    res.send(toCsv(rows));
  });

  return r;
}
