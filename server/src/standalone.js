// Electron 없이 서버만 실행 (개발/테스트용): node server/src/standalone.js
import path from 'node:path';
import { enableUtf8Console } from '../../shared/src/winConsole.js';
import { createClassServer, lanAddresses } from './app.js';

enableUtf8Console();

// CLASS_DB_FILE=우리반.classdb 를 주면 그 세이브 파일을 열고, 첨부 파일은 우리반.files/ 에 둔다.
const dbFile = process.env.CLASS_DB_FILE ? path.resolve(process.env.CLASS_DB_FILE) : null;
const dataDir = dbFile
  ? path.join(path.dirname(dbFile), `${path.basename(dbFile).replace(/\.[^.]+$/, '')}.files`)
  : (process.env.CLASS_DATA_DIR ?? path.resolve('classdata'));
const httpPort = Number(process.env.CLASS_HTTP_PORT ?? 3690);

const server = await createClassServer({ dataDir, dbFile, httpPort });
await server.start();

console.log('─'.repeat(50));
console.log('교실 평가 서버 실행 중');
console.log(`  세이브 파일 : ${server.workspace.file}`);
console.log(`  데이터 폴더 : ${dataDir}`);
console.log(`  교사 대시보드: http://localhost:${httpPort}/teacher/`);
for (const addr of lanAddresses()) {
  console.log(`  학생 접속 주소: ${addr}:${httpPort}`);
}
console.log('─'.repeat(50));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n서버를 종료합니다...');
    await server.stop();
    process.exit(0);
  });
}
