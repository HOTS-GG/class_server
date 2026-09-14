import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import {
  APP_VERSION, MIN_CLIENT_VERSION, DEFAULT_HTTP_PORT, DEFAULT_UDP_PORT,
} from '../../shared/src/constants.js';
import { newAccessCode } from '../../shared/src/id.js';
import { openDb } from './db.js';
import { makeAuth } from './auth.js';
import { createPresence } from './services/presenceService.js';
import { createExamService } from './services/examService.js';
import {
  createAiGrader, verifyApiKey, AI_MODEL_PRESETS, DEFAULT_AI_MODEL, DEFAULT_PDF_ENGINE,
} from './services/aiGradingService.js';
import { startDiscovery } from './services/discovery.js';
import { attachSockets } from './sockets/index.js';
import { studentsRouter } from './routes/students.js';
import { assignmentRouters } from './routes/assignments.js';
import { examRouters } from './routes/exams.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function lanAddresses() {
  const out = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

export async function createClassServer({
  dataDir,
  httpPort = DEFAULT_HTTP_PORT,
  udpPort = DEFAULT_UDP_PORT,
  enableDiscovery = true,
  aiFetch = fetch, // 테스트에서 OpenRouter 호출을 가짜로 바꿀 때 사용
} = {}) {
  if (!dataDir) throw new Error('dataDir가 필요합니다.');
  const db = await openDb(dataDir);

  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: true, credentials: false },
    maxHttpBufferSize: 1e6,
  });

  const auth = makeAuth(db);
  const presence = createPresence();
  const examService = createExamService(db, io);
  examService.restore();
  const aiGrader = createAiGrader({ db, io, examService, fetchImpl: aiFetch });
  attachSockets({ io, db, auth, presence, examService });

  // CORS: 학생 Electron 렌더러(file://)와 향후 모바일 웹에서의 호출 허용
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Teacher-Pin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '5mb' }));

  // ── 공개 엔드포인트 ─────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      name: db.data.settings.serverName,
      version: APP_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      serverNow: Date.now(),
    });
  });

  app.post('/api/auth/student', (req, res) => {
    const code = String(req.body?.code ?? '').trim().toUpperCase();
    const stu = db.data.students.find((s) => s.active && s.code === code);
    if (!stu) return res.status(401).json({ error: '접속 코드가 올바르지 않습니다.' });
    res.json({
      token: auth.tokenFor(stu.id),
      student: { id: stu.id, number: stu.number, name: stu.name },
    });
  });

  // ── 학생 앱 잠금 해제 코드 ─────────────────────────────
  const unlockCodes = new Map(); // code -> expiresAt
  const UNLOCK_TTL_MS = 10 * 60 * 1000;

  app.post('/api/teacher/unlock-code', auth.teacherMiddleware, (req, res) => {
    const code = newAccessCode(4);
    unlockCodes.set(code, Date.now() + UNLOCK_TTL_MS);
    res.json({ code, expiresAt: Date.now() + UNLOCK_TTL_MS });
  });

  app.post('/api/teacher/unlock-all', auth.teacherMiddleware, (req, res) => {
    io.of('/student').emit('session:unlock', { reason: '교사가 수업을 종료했습니다.' });
    res.json({ ok: true });
  });

  app.post('/api/student/unlock', (req, res) => {
    const code = String(req.body?.code ?? '').trim().toUpperCase();
    const exp = unlockCodes.get(code);
    if (!exp || exp < Date.now()) return res.status(401).json({ error: '해제 코드가 올바르지 않거나 만료되었습니다.' });
    unlockCodes.delete(code);
    res.json({ ok: true });
  });

  // ── 교사 설정/정보 ─────────────────────────────
  app.get('/api/teacher/server-info', auth.teacherMiddleware, (req, res) => {
    res.json({
      name: db.data.settings.serverName,
      httpPort,
      udpPort,
      addresses: lanAddresses(),
      version: APP_VERSION,
    });
  });

  app.put('/api/teacher/settings', auth.teacherMiddleware, (req, res) => {
    const { serverName, teacherPin } = req.body ?? {};
    if (serverName?.trim()) db.data.settings.serverName = serverName.trim();
    if (teacherPin !== undefined) db.data.settings.teacherPin = String(teacherPin) || undefined;
    db.scheduleFlush();
    res.json({ ok: true });
  });

  // ── AI 채점 설정 (OpenRouter) ─────────────────────────────
  // 키 값은 절대 그대로 돌려주지 않는다 (앞 8자/뒤 4자만).
  const aiSettingsView = () => {
    const ai = db.data.settings.ai ?? {};
    const key = String(ai.apiKey ?? '');
    return {
      configured: key.length > 0,
      keyHint: key ? `${key.slice(0, 8)}…${key.slice(-4)}` : '',
      keyLength: key.length,
      model: ai.model || DEFAULT_AI_MODEL,
      pdfEngine: ai.pdfEngine || DEFAULT_PDF_ENGINE,
      presets: AI_MODEL_PRESETS,
      defaultModel: DEFAULT_AI_MODEL,
    };
  };

  app.get('/api/teacher/ai-settings', auth.teacherMiddleware, (req, res) => {
    res.json(aiSettingsView());
  });

  app.put('/api/teacher/ai-settings', auth.teacherMiddleware, (req, res) => {
    const { apiKey, model, pdfEngine, clearKey } = req.body ?? {};
    db.data.settings.ai ??= {};
    const ai = db.data.settings.ai;
    if (clearKey === true) ai.apiKey = '';
    else if (typeof apiKey === 'string' && apiKey.trim()) {
      ai.apiKey = apiKey.replace(/\s+/g, '');
    }
    if (model !== undefined) ai.model = String(model ?? '').trim();
    if (pdfEngine !== undefined) ai.pdfEngine = pdfEngine === 'mistral-ocr' ? 'mistral-ocr' : 'pdf-text';
    db.scheduleFlush();
    res.json({ ok: true, ...aiSettingsView() });
  });

  // 저장된 키(또는 입력 중인 키)로 OpenRouter 연결 확인
  app.post('/api/teacher/ai-settings/test', auth.teacherMiddleware, async (req, res) => {
    const candidate = String(req.body?.apiKey ?? '').replace(/\s+/g, '') || String(db.data.settings.ai?.apiKey ?? '');
    if (!candidate) return res.status(400).json({ error: 'API 키를 먼저 입력하세요.' });
    try {
      const info = await verifyApiKey(candidate, aiFetch);
      res.json({ ok: true, ...info });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/teacher/focus-logs', auth.teacherMiddleware, (req, res) => {
    const name = req.query.examId ? `focus-${req.query.examId}` : 'focus-general';
    res.json(db.readEvents(name));
  });

  // ── 라우터 마운트 ─────────────────────────────
  const assignments = assignmentRouters({ db, io });
  const exams = examRouters({ db, io, presence, examService, aiGrader });

  app.use('/api/teacher/students', auth.teacherMiddleware, studentsRouter({ db, presence }));
  app.use('/api/teacher/assignments', auth.teacherMiddleware, assignments.teacher);
  app.use('/api/teacher/exams', auth.teacherMiddleware, exams.teacher);
  app.use('/api/student/assignments', auth.studentMiddleware, assignments.student);
  app.use('/api/student/exams', auth.studentMiddleware, exams.student);

  // ── 교사 대시보드 정적 파일 ─────────────────────────────
  // 공통 테마(학생 클라이언트와 동일 팔레트)는 shared/에서 서빙
  const sharedDir = path.join(__dirname, '..', '..', 'shared');
  app.get('/teacher/theme.css', (req, res) => res.sendFile(path.join(sharedDir, 'theme.css')));
  app.get('/teacher/theme.js', (req, res) => res.sendFile(path.join(sharedDir, 'theme.js')));
  app.use('/teacher', express.static(path.join(__dirname, 'public', 'teacher')));
  app.get('/', (req, res) => res.redirect('/teacher/'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[server] 요청 처리 오류:', err.message);
    res.status(500).json({ error: err.message });
  });

  let stopDiscovery = null;

  const start = () => new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(httpPort, () => {
      if (enableDiscovery) {
        stopDiscovery = startDiscovery({ udpPort, httpPort, name: db.data.settings.serverName });
      }
      resolve({ httpPort, addresses: lanAddresses() });
    });
  });

  const stop = async () => {
    examService.stopAllTimers();
    stopDiscovery?.();
    io.close();
    await new Promise((r) => httpServer.close(r));
    await db.flushNow();
  };

  return { app, io, httpServer, db, auth, presence, examService, aiGrader, start, stop, httpPort };
}
