# 교실 평가 시스템 (ClassServer)

교사 PC를 호스트로, 학생 PC를 클라이언트로 하는 LAN 기반 수업 평가 도구.

- **과제 배부/회수**: 모든 파일 형식. 제출물은 `출석번호_이름` 폴더 구조의 zip으로 일괄 회수
- **CBT 시험**: 객관식(자동 채점) + 서술형(수동 채점). **학생마다 문항/선택지 순서가 다르게** 출제
- **부정행위 방지**: 붙여넣기·복사·우클릭 차단, 시험 중 전체화면 잠금, 창 전환(이탈)·클립보드 변화 감지 및 교사 화면 실시간 표시
- **실시간 현황판**: 접속/이탈/제출 현황, 시험 타이머 + 시간 종료 시 자동 제출
- **결과 CSV**: 엑셀(한글) 호환 BOM 인코딩

## 구조

```
shared/          공용 유틸 (시드 셔플, 채점, CSV)
server/          Express + Socket.IO 서버 + 교사 대시보드(웹)
teacher-app/     교사용 Electron 앱 (서버 내장 + 대시보드 창)
student-client/  학생용 Electron 앱 (kiosk 잠금, 붙여넣기 차단)
tools/           가상 학생 시뮬레이터, 샘플 데이터
tests/           단위 테스트 (node:test)
docs/            교사용 사용설명서, 네트워크 설정 안내
```

## 개발 실행

```bash
npm install
```

| 명령 | 설명 |
|---|---|
| `npm test` | 단위 테스트 |
| `npm run server` | 서버만 실행 (브라우저에서 http://localhost:3690/teacher/ ) |
| `npm run teacher` | 교사용 Electron 앱 실행 |
| `npm run student` | 학생 클라이언트 실행 (`--dev` 모드: 잠금 해제, 다중 실행 허용) |
| `npm run simulate` | 가상 학생 접속/응시 부하 테스트 |

### 한 PC에서 학생 2명 시뮬레이션

```bash
npx electron student-client/src/main.js --dev --user-data=stu1
```

```bash
npx electron student-client/src/main.js --dev --user-data=stu2
```

## 패키징 (배포용 exe)

```bash
npm run build:teacher
```

```bash
npm run build:student
```

- 교사용: NSIS 원클릭 설치형 (`release/teacher/`) — 방화벽 인바운드 허용이 유지되도록 설치형 사용
- 학생용: 포터블 exe (`release/student/`) — USB/공유폴더로 배포

> **빌드가 `Cannot create symbolic link` 오류로 실패할 때** (Windows에서 개발자 모드가 꺼진 경우 흔함):
> winCodeSign 캐시의 macOS용 심링크를 만들지 못해 생기는 문제로, Windows 빌드에는 그 파일들이 필요 없습니다.
> 해결: ① Windows 설정에서 개발자 모드 켜기, 또는 ② 받아진 `.7z`를
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` 폴더로 직접 압축 해제(심링크 오류 무시)한 뒤
> `darwin\10.12\lib\libcrypto.1.0.0.dylib`를 `libcrypto.dylib`로, `libssl.1.0.0.dylib`를 `libssl.dylib`로 복사.

자세한 사용법은 [docs/teacher-guide.md](docs/teacher-guide.md), 네트워크 문제는 [docs/network-setup.md](docs/network-setup.md) 참고.
