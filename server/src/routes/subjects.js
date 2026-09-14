import { Router } from 'express';
import { newId } from '../../../shared/src/id.js';

// 과목/학급 구분. 하나의 저장 파일(db.json) 안에서 시험·과제를 subjectId로 나눈다.
const COLORS = ['#007aff', '#34c759', '#ff9500', '#af52de', '#ff3b30', '#5ac8fa', '#ffcc00', '#ff2d55'];

export function subjectsRouter({ db }) {
  const r = Router();
  db.data.subjects ??= [];

  const counts = (id) => ({
    examCount: db.data.exams.filter((e) => e.subjectId === id).length,
    assignmentCount: db.data.assignments.filter((a) => a.subjectId === id).length,
    studentCount: db.data.students.filter((s) => s.active && s.subjectId === id).length,
  });

  r.get('/', (req, res) => {
    res.json(db.data.subjects.map((s) => ({ ...s, ...counts(s.id) })));
  });

  r.post('/', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: '과목(학급) 이름이 필요합니다.' });
    if (db.data.subjects.some((s) => s.name === name)) return res.status(400).json({ error: '같은 이름의 과목이 이미 있습니다.' });
    const subject = {
      id: newId('sub'),
      name: name.slice(0, 40),
      color: COLORS[db.data.subjects.length % COLORS.length],
      createdAt: Date.now(),
    };
    db.data.subjects.push(subject);
    db.scheduleFlush();
    res.json(subject);
  });

  r.put('/:id', (req, res) => {
    const s = db.data.subjects.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: '과목을 찾을 수 없습니다.' });
    const name = String(req.body?.name ?? '').trim();
    if (name) {
      if (db.data.subjects.some((x) => x.id !== s.id && x.name === name)) return res.status(400).json({ error: '같은 이름의 과목이 이미 있습니다.' });
      s.name = name.slice(0, 40);
    }
    if (typeof req.body?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.color)) s.color = req.body.color;
    db.scheduleFlush();
    res.json(s);
  });

  // 삭제: 소속 시험·과제·학생은 "과목 없음"으로 남긴다 (데이터는 지우지 않음)
  r.delete('/:id', (req, res) => {
    const idx = db.data.subjects.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '과목을 찾을 수 없습니다.' });
    const id = db.data.subjects[idx].id;
    db.data.subjects.splice(idx, 1);
    for (const e of db.data.exams) if (e.subjectId === id) delete e.subjectId;
    for (const a of db.data.assignments) if (a.subjectId === id) delete a.subjectId;
    for (const s of db.data.students) if (s.subjectId === id) delete s.subjectId;
    db.scheduleFlush();
    res.json({ ok: true });
  });

  return r;
}

// 라우터 밖에서도 쓰는 도우미: subjectId → 이름
export const subjectNameOf = (db, subjectId) =>
  db.data.subjects?.find((s) => s.id === subjectId)?.name ?? null;
export const validSubjectId = (db, subjectId) =>
  (subjectId && db.data.subjects?.some((s) => s.id === subjectId)) ? subjectId : undefined;

// 과목(학급) 소속 학생 목록. subjectId가 없으면(과목 없음) 전체 학생.
// 시험·과제도 같은 규칙: 과목이 지정된 시험/과제는 그 과목 학생에게만, 과목 없는 것은 전체에게.
export const studentsOf = (db, subjectId) =>
  db.data.students
    .filter((s) => s.active && (!subjectId || s.subjectId === subjectId))
    .sort((a, b) => a.number - b.number);
export const studentBelongs = (student, subjectId) => !subjectId || student.subjectId === subjectId;
