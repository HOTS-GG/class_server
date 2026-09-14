# 교실 평가 시스템 (ClassServer)

교사 PC를 호스트로, 학생 PC를 클라이언트로 하는 LAN 기반 수업 평가 도구.

- **과제 배부/회수**: 모든 파일 형식. 제출물은 `출석번호_이름` 폴더 구조의 zip으로 일괄 회수
- **CBT 시험**: 객관식·단답형(자동 채점) + 서술형(**AI 채점 초안 → 교사 검토·반영**). **학생마다 문항/선택지 순서가 다르게** 출제. 엑셀 양식으로 문제 일괄 등록
- **AI 서술형 채점 (OpenRouter)**: 문항별 모범답안·채점기준을 근거로 항목별 점수·피드백·확신도 초안 생성. 객관식·단답형에는 AI를 쓰지 않음. 학생 이름·번호는 전송하지 않음. 최종 점수는 교사가 확정
- **답안 파일 첨부**: 서술형 문항에 PDF/이미지/텍스트 첨부 허용 가능 — AI가 내용을 요약·채점. (종이 스캔은 미지원)
- **부정행위 방지**: 붙여넣기·복사·우클릭 차단, 시험 중 전체화면 잠금, 창 전환(이탈)·클립보드 변화 감지 및 교사 화면 실시간 표시
- **실시간 현황판**: 접속/이탈/제출 현황, 시험 타이머 + 시간 종료 시 자동 제출
- **성적 돌려주기**: 성적 공개(또는 종료 즉시 공개) 시 학생이 점수·정오·정답·피드백 확인. 서술형 채점이 끝나면 학생 화면 자동 갱신
- **결과 내보내기**: 엑셀(점수 · 서술형 상세(AI 점수/피드백) · 문항) 및 CSV(BOM)
- **테마**: 라이트/다크, 화면 크기 조절 (교사·학생 동일 팔레트)
- **세이브 파일**: 교사 앱은 시작 시 `.classdb` 세이브 파일을 열어야 동작. 명단·과목·과제·시험·설정은 파일에, 첨부 파일은 `이름.files/` 폴더에 저장
- **과목/학급 구분**: 세이브 하나 안에서 시험·과제를 과목별로 필터

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
| `npm run smoke` | E2E 스모크 테스트 (가짜 OpenRouter로 AI 채점 흐름까지 검증) |
| `npm run server` | 서버만 실행 (브라우저에서 http://localhost:3690/teacher/ ). `CLASS_DB_FILE=우리반.classdb` 로 세이브 파일 지정 가능 |
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
