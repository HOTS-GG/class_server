import { randomBytes } from 'node:crypto';

export function newId(prefix = '') {
  const rand = randomBytes(6).toString('hex');
  return prefix ? `${prefix}_${Date.now().toString(36)}${rand}` : `${Date.now().toString(36)}${rand}`;
}

// 접속 코드: O/0, I/1/l 등 혼동 문자를 제외한 6자리
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newAccessCode(length = 6) {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}
