import { Router } from 'express';
import { parseCsv, toCsv } from '../../../shared/src/csv.js';
import { newId, newAccessCode } from '../../../shared/src/id.js';

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
  r.post('/import', (req, res) => {
    const csv = req.body?.csv;
    if (typeof csv !== 'string' || !csv.trim()) {
      return res.status(400).json({ error: 'CSV 내용이 비어 있습니다.' });
    }
    const rows = parseCsv(csv);
    const added = [];
    const skipped = [];
    for (const row of rows) {
      const [numRaw, nameRaw] = row;
      const number = Number(String(numRaw).trim());
      const name = String(nameRaw ?? '').trim();
      if (!Number.isInteger(number) || number < 1 || number > 999 || !name) { skipped.push(row.join(',')); continue; }
      if (db.data.students.some((s) => s.active && s.number === number && s.name === name)) {
        skipped.push(`${number},${name} (중복)`);
        continue;
      }
      added.push(addStudent(number, name));
    }
    db.scheduleFlush();
    res.json({ addedCount: added.length, skipped });
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
