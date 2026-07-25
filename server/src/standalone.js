// Electron 없이 서버만 실행 (개발/테스트용): node server/src/standalone.js
import path from 'node:path';
import { createClassServer, lanAddresses } from './app.js';

const dataDir = process.env.CLASS_DATA_DIR ?? path.resolve('classdata');
const httpPort = Number(process.env.CLASS_HTTP_PORT ?? 3690);

const server = await createClassServer({ dataDir, httpPort });
await server.start();

console.log('─'.repeat(50));
console.log('교실 평가 서버 실행 중');
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
