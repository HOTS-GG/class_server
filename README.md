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

### 앱 아이콘

`assets/icons/teacher.svg`, `student.svg`(벡터)가 원본입니다. 원본을 바꾼 뒤 `npm run make-icons` 를 실행하면 Electron이 각 크기(16~256px)로 직접 렌더링해 `teacher.ico`, `student.ico`와 `*-256.png`를 다시 만듭니다(모서리 바깥은 투명). electron-builder(`win.icon`)와 각 앱의 BrowserWindow가 이 ico를 씁니다. `assets/icons/original/`은 처음 받은 PNG 내장 SVG(흰 배경)로, 참고용입니다.

### 코드 서명

서명 없는 exe는 Windows SmartScreen이 "알 수 없는 게시자"로 경고합니다. 서명을 붙이려면:

```bash
npm run make-cert
```

```bash
npm run build:signed
```

- `make-cert`(tools/make-signing-cert.ps1)는 **자체 서명 인증서**를 `%USERPROFILE%\.class_server\codesign.pfx`(기본 비밀번호 `classserver`)로 만듭니다. 자체 서명은 서명 자체는 붙지만 SmartScreen 경고는 그대로이고, 인증서를 신뢰하는 PC에서만 "확인된 게시자"로 보입니다. 학교 PC에 배포할 때는 `.cer`(공개키)를 각 PC의 "신뢰할 수 있는 게시자"에 넣거나 도메인 정책으로 배포하세요.
- 경고를 완전히 없애려면 공인 CA의 코드 서명 인증서(OV/EV)를 구해 같은 스크립트에 `-Cert 경로.pfx -Password …` 로 넘기면 됩니다(EV는 즉시, OV는 평판이 쌓인 뒤 SmartScreen 경고가 사라집니다).
- `build:signed`는 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 로 electron-builder에 인증서를 넘기고(SHA-256, DigiCert 타임스탬프), 빌드 뒤 `Get-AuthenticodeSignature` 결과를 출력합니다.

## 데이터와 보안

- 세이브 파일 `이름.classdb` + `이름.files/`(첨부·이벤트 로그·백업). API 키는 세이브가 아니라 `secrets.json`(Electron: `%APPDATA%\class-server-teacher\`, 서버 단독 실행: 데이터 폴더)에 저장.
- 백업: 시험 시작·종료·하루 1회·수동 → `이름.files/backups/`(20개 보관). 손상 시 자동 복구, 시작 화면에서 수동 복구.
- 학생 답안 전송은 미저장 큐 + 재시도 + 제출 전 동기화(`exam:sync`, 서버는 `savedAt`이 더 최신인 답안만 반영).
- AI 채점: 교사 확정 점수를 few-shot 예시로 활용, 일관성 검사(표본 재채점), 호출·토큰·비용 집계.

자세한 사용법은 [docs/teacher-guide.md](docs/teacher-guide.md), 네트워크 문제는 [docs/network-setup.md](docs/network-setup.md) 참고.
