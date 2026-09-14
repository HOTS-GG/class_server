import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { newId } from '../../../shared/src/id.js';
import { subjectNameOf, validSubjectId } from './subjects.js';

const FORBIDDEN_CHARS = /[\\/:*?"<>|]/g;

const sanitizeName = (name) => {
  const cleaned = name
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('')
    .replace(FORBIDDEN_CHARS, '_')
    .trim();
  return cleaned.slice(0, 150) || 'file';
};

// multer는 파일명을 latin1로 넘기므로 UTF-8로 복원
const fixName = (originalname) =>
  sanitizeName(Buffer.from(originalname, 'latin1').toString('utf8'));

export function assignmentRouters({ db, io }) {
  const upload = multer({
    dest: path.join(db.dataDir, 'tmp'),
    limits: { fileSize: 500 * 1024 * 1024, files: 20 },
  });

  const assignDir = (id) => path.join(db.dataDir, 'files', 'assignments', id);
  const submitDir = (aid, sid, version) =>
    path.join(db.dataDir, 'files', 'submissions', aid, sid, `v${version}`);

  const storeFiles = (files, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    return (files ?? []).map((f) => {
      const name = fixName(f.originalname);
      const fileId = newId('f');
      const dest = path.join(destDir, `${fileId}_${name}`);
      fs.renameSync(f.path, dest);
      return { fileId, name, size: f.size, storedName: `${fileId}_${name}` };
    });
  };

  const latestSubmission = (assignmentId, studentId) => {
    const subs = db.data.submissions.filter(
      (s) => s.assignmentId === assignmentId && s.studentId === studentId,
    );
    return subs.sort((a, b) => b.version - a.version)[0] ?? null;
  };

  // ── 교사용 ─────────────────────────────
  const teacher = Router();

  teacher.get('/', (req, res) => {
    const list = db.data.assignments.map((a) => {
      const submitters = new Set(
        db.data.submissions.filter((s) => s.assignmentId === a.id).map((s) => s.studentId),
      );
      return { ...a, submittedCount: submitters.size, subjectName: subjectNameOf(db, a.subjectId) };
    });
    res.json(list);
  });

  teacher.post('/', upload.array('files'), (req, res) => {
    const { title, description, allowResubmit, subjectId } = req.body ?? {};
    if (!title?.trim()) {
      for (const f of req.files ?? []) fs.rmSync(f.path, { force: true });
      return res.status(400).json({ error: '과제 제목이 필요합니다.' });
    }
    const id = newId('asg');
    const files = storeFiles(req.files, assignDir(id));
    const assignment = {
      id,
      title: title.trim(),
      description: description ?? '',
      status: 'draft',
      files,
      allowResubmit: allowResubmit !== 'false',
      subjectId: validSubjectId(db, subjectId),
      createdAt: Date.now(),
    };
    db.data.assignments.push(assignment);
    db.scheduleFlush();
    res.json(assignment);
  });

  // 과제 삭제 — 배부 파일과 제출물도 함께 삭제 (필요하면 zip을 먼저 내려받도록 UI에서 안내)
  teacher.delete('/:id', (req, res) => {
    const idx = db.data.assignments.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });
    const id = db.data.assignments[idx].id;
    db.data.assignments.splice(idx, 1);
    db.data.submissions = db.data.submissions.filter((s) => s.assignmentId !== id);
    fs.rmSync(assignDir(id), { recursive: true, force: true });
    fs.rmSync(path.join(db.dataDir, 'files', 'submissions', id), { recursive: true, force: true });
    db.scheduleFlush();
    io.of('/student').emit('assignment:closed', { assignmentId: id });
    res.json({ ok: true });
  });

  teacher.post('/:id/publish', (req, res) => {
    const a = db.data.assignments.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });
    a.status = 'published';
    a.publishedAt = Date.now();
    db.scheduleFlush();
    io.of('/student').emit('assignment:published', { assignmentId: a.id, title: a.title });
    res.json(a);
  });

  teacher.post('/:id/close', (req, res) => {
    const a = db.data.assignments.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });
    a.status = 'closed';
    db.scheduleFlush();
    io.of('/student').emit('assignment:closed', { assignmentId: a.id });
    res.json(a);
  });

  teacher.get('/:id/submissions', (req, res) => {
    const a = db.data.assignments.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });
    const rows = db.data.students
      .filter((s) => s.active)
      .sort((x, y) => x.number - y.number)
      .map((s) => {
        const sub = latestSubmission(a.id, s.id);
        return {
          studentId: s.id,
          number: s.number,
          name: s.name,
          submitted: !!sub,
          version: sub?.version ?? 0,
          submittedAt: sub?.submittedAt ?? null,
          files: sub?.files ?? [],
        };
      });
    res.json(rows);
  });

  // 제출물 원본 파일 열람
  teacher.get('/:id/submissions/:studentId/files/:fileId', (req, res) => {
    const sub = latestSubmission(req.params.id, req.params.studentId);
    const f = sub?.files.find((x) => x.fileId === req.params.fileId);
    if (!f) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    res.download(path.join(submitDir(sub.assignmentId, sub.studentId, sub.version), f.storedName), f.name);
  });

  // 전체 제출물을 "출석번호_이름/파일" 구조의 zip으로 회수
  teacher.get('/:id/submissions.zip', (req, res) => {
    const a = db.data.assignments.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(`제출물_${sanitizeName(a.title)}.zip`));
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    for (const s of db.data.students.filter((x) => x.active)) {
      const sub = latestSubmission(a.id, s.id);
      if (!sub) continue;
      const folder = `${String(s.number).padStart(2, '0')}_${sanitizeName(s.name)}`;
      for (const f of sub.files) {
        const p = path.join(submitDir(a.id, s.id, sub.version), f.storedName);
        if (fs.existsSync(p)) zip.file(p, { name: `${folder}/${f.name}` });
      }
    }
    zip.finalize();
  });

  // ── 학생용 ─────────────────────────────
  const student = Router();

  student.get('/', (req, res) => {
    const list = db.data.assignments
      .filter((a) => a.status !== 'draft')
      .map((a) => {
        const sub = latestSubmission(a.id, req.student.id);
        return {
          id: a.id,
          title: a.title,
          description: a.description,
          status: a.status,
          subjectName: subjectNameOf(db, a.subjectId),
          allowResubmit: a.allowResubmit,
          publishedAt: a.publishedAt,
          files: a.files.map((f) => ({ fileId: f.fileId, name: f.name, size: f.size })),
          mySubmission: sub
            ? { version: sub.version, submittedAt: sub.submittedAt, files: sub.files.map((f) => f.name) }
            : null,
        };
      });
    res.json(list);
  });

  student.get('/:id/files/:fileId', (req, res) => {
    const a = db.data.assignments.find((x) => x.id === req.params.id && x.status !== 'draft');
    const f = a?.files.find((x) => x.fileId === req.params.fileId);
    if (!f) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    res.download(path.join(assignDir(a.id), f.storedName), f.name);
  });

  student.post('/:id/submit', upload.array('files'), (req, res) => {
    const a = db.data.assignments.find((x) => x.id === req.params.id);
    if (!a || a.status !== 'published') {
      for (const f of req.files ?? []) fs.rmSync(f.path, { force: true });
      return res.status(400).json({ error: '제출을 받지 않는 과제입니다.' });
    }
    const prev = latestSubmission(a.id, req.student.id);
    if (prev && !a.allowResubmit) {
      for (const f of req.files ?? []) fs.rmSync(f.path, { force: true });
      return res.status(400).json({ error: '이미 제출했습니다. (재제출 불가 과제)' });
    }
    if (!req.files?.length) return res.status(400).json({ error: '제출할 파일이 없습니다.' });

    const version = (prev?.version ?? 0) + 1;
    const files = storeFiles(req.files, submitDir(a.id, req.student.id, version));
    const submission = {
      id: newId('sub'),
      assignmentId: a.id,
      studentId: req.student.id,
      version,
      files,
      submittedAt: Date.now(),
    };
    db.data.submissions.push(submission);
    db.scheduleFlush();
    io.of('/teacher').emit('submission:received', {
      assignmentId: a.id,
      studentId: req.student.id,
      number: req.student.number,
      name: req.student.name,
      version,
      fileNames: files.map((f) => f.name),
      submittedAt: submission.submittedAt,
    });
    res.json({ ok: true, version, submittedAt: submission.submittedAt });
  });

  return { teacher, student };
}
