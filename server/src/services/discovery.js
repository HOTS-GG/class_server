import dgram from 'node:dgram';
import { DISCOVERY_MAGIC, DISCOVERY_REPLY } from '../../../shared/src/constants.js';

// 학생 클라이언트의 브로드캐스트 질의에 응답해 서버 주소를 알려준다.
export function startDiscovery({ udpPort, httpPort, name }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    if (msg.toString() !== DISCOVERY_MAGIC) return;
    const reply = JSON.stringify({ magic: DISCOVERY_REPLY, port: httpPort, name });
    sock.send(reply, rinfo.port, rinfo.address);
  });

  sock.on('error', (err) => {
    console.error('[discovery] UDP 오류:', err.message);
  });

  sock.bind(udpPort, () => {
    console.log(`[discovery] UDP ${udpPort} 포트에서 자동 탐색 응답 대기`);
  });

  return () => { try { sock.close(); } catch { /* already closed */ } };
}
