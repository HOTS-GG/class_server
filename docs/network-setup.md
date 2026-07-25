# 네트워크 설정 안내

## 기본 구조

- 교사 PC가 서버(호스트): **TCP 3690** (HTTP/WebSocket), **UDP 3691** (자동 탐색)
- 학생 PC는 교사 PC로 접속만 하므로 학생 쪽 방화벽 설정은 필요 없습니다.
- 교사 PC와 학생 PC가 **같은 네트워크(같은 공유기/스위치)** 에 있어야 합니다. `ping`이 되면 대부분 동작합니다.

## 학생이 접속하지 못할 때 (순서대로 확인)

1. **방화벽 허용 여부**
   교사 프로그램 첫 실행 때 "액세스 허용"을 눌렀는지 확인.
   놓쳤다면 관리자 PowerShell에서:

   ```powershell
   New-NetFirewallRule -DisplayName "ClassServer" -Direction Inbound -Protocol TCP -LocalPort 3690 -Action Allow
   New-NetFirewallRule -DisplayName "ClassServer-Discovery" -Direction Inbound -Protocol UDP -LocalPort 3691 -Action Allow
   ```

2. **네트워크 프로필이 "공용"으로 되어 있는 경우**
   설정 → 네트워크 및 인터넷 → 이더넷 → 네트워크 프로필을 **개인**으로 변경.

3. **자동 찾기가 안 될 때**
   학교 공유기/스위치가 UDP 브로드캐스트를 막는 경우가 있습니다.
   → 교사 화면 상단의 **접속 주소를 직접 입력**하면 됩니다. (자동 찾기는 편의 기능일 뿐)

4. **주소가 여러 개 표시될 때**
   교사 PC에 유선+무선이 같이 연결된 경우입니다. 학생과 같은 네트워크의 주소를 쓰세요.
   (보통 유선: `192.168.x.x`)

5. **ping은 되는데 접속이 안 될 때**
   교사 프로그램이 실제로 실행 중인지, 교사 PC 브라우저에서 `http://localhost:3690/teacher/` 가 열리는지 확인.

## 데이터와 보안

- 모든 데이터는 교실 LAN 안에서만 오가며 외부 인터넷을 사용하지 않습니다.
- 학생 인증은 학생별 접속 코드로 하며, 코드 유출 시 대시보드에서 재발급하세요.
