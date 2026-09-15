# 코드 서명이 붙은 exe 빌드
#   powershell -ExecutionPolicy Bypass -File tools\build-signed.ps1 -Cert "경로\codesign.pfx" -Password "비밀번호" [-Target teacher|student|all]
# electron-builder는 WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD 환경변수를 읽어 signtool로 서명하고 타임스탬프를 붙입니다.
param(
  [string]$Cert = (Join-Path $env:USERPROFILE ".class_server\codesign.pfx"),
  [string]$Password = "classserver",
  [ValidateSet("teacher", "student", "all")] [string]$Target = "all"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Cert)) { throw "인증서 파일이 없습니다: $Cert  (tools\make-signing-cert.ps1 로 먼저 만드세요)" }
$env:WIN_CSC_LINK = (Resolve-Path $Cert).Path
$env:WIN_CSC_KEY_PASSWORD = $Password
Set-Location (Join-Path $PSScriptRoot "..")
if ($Target -eq "teacher" -or $Target -eq "all") { npm run build:teacher; if ($LASTEXITCODE -ne 0) { throw "교사용 빌드 실패" } }
if ($Target -eq "student" -or $Target -eq "all") { npm run build:student; if ($LASTEXITCODE -ne 0) { throw "학생용 빌드 실패" } }
Write-Host ""
Write-Host "서명 확인:"
Get-ChildItem release\teacher\*.exe, release\student\*.exe -ErrorAction SilentlyContinue | ForEach-Object {
  $sig = Get-AuthenticodeSignature $_.FullName
  "{0,-45} {1,-12} {2}" -f $_.Name, $sig.Status, $sig.SignerCertificate.Subject
}
Write-Host "(자체 서명 인증서면 Status가 UnknownError/NotTrusted 로 나오지만 서명 자체는 붙어 있습니다. 공인 인증서면 Valid.)"
