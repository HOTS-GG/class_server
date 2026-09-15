# 학교 PC에 ClassServer 서명 인증서를 신뢰시키기 (관리자 권한 필요)
#   powershell -ExecutionPolicy Bypass -File tools\trust-cert.ps1 [-Cer "경로\codesign.cer"] [-Remove]
# 자체 서명 인증서(.cer, 공개키만)를 "신뢰할 수 있는 루트 인증 기관"과 "신뢰할 수 있는 게시자"에 넣습니다.
# 설치 후에는 exe 속성 → 디지털 서명이 "정상"으로, UAC 창에 "확인된 게시자: ClassServer Teacher Tools"로 표시됩니다.
# (SmartScreen 평판 경고는 별개이며, USB·공유폴더로 복사한 파일에는 원래 뜨지 않습니다. README 참고)
param(
  [string]$Cer = "",
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
if (-not $Cer) {
  $candidates = @(
    (Join-Path $PSScriptRoot "codesign.cer"),
    (Join-Path $PSScriptRoot "ClassServer-codesign.cer"),
    (Join-Path $env:USERPROFILE ".class_server\codesign.cer")
  )
  $Cer = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $Cer) { throw "인증서 파일(.cer)을 찾을 수 없습니다. -Cer 로 경로를 지정하세요." }
}
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (Resolve-Path $Cer).Path
if ($cert.HasPrivateKey) { throw "개인 키가 들어 있는 파일입니다. 공개키(.cer)만 배포하세요." }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "관리자 권한으로 다시 실행합니다..."
  $args = @("-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Cer", "`"$((Resolve-Path $Cer).Path)`"")
  if ($Remove) { $args += "-Remove" }
  Start-Process powershell -Verb RunAs -ArgumentList $args -Wait
  exit
}

foreach ($storeName in @("Root", "TrustedPublisher")) {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store $storeName, "LocalMachine"
  $store.Open("ReadWrite")
  $existing = $store.Certificates | Where-Object Thumbprint -eq $cert.Thumbprint
  if ($Remove) {
    if ($existing) { $store.Remove($existing[0]); Write-Host "제거: LocalMachine\$storeName" } else { Write-Host "없음: LocalMachine\$storeName" }
  } else {
    if ($existing) { Write-Host "이미 있음: LocalMachine\$storeName" } else { $store.Add($cert); Write-Host "설치: LocalMachine\$storeName" }
  }
  $store.Close()
}
Write-Host ""
Write-Host ("인증서: {0}  (지문 {1}, 만료 {2:yyyy-MM-dd})" -f $cert.Subject, $cert.Thumbprint, $cert.NotAfter)
if (-not $Remove) {
  # 같은 폴더의 exe가 인터넷에서 받은 파일로 표시되어 있으면 차단 해제 (SmartScreen 경고 방지)
  $exes = Get-ChildItem -Path $PSScriptRoot -Filter *.exe -ErrorAction SilentlyContinue
  foreach ($e in $exes) { Unblock-File $e.FullName -ErrorAction SilentlyContinue }
  if ($exes) { Write-Host "같은 폴더의 exe {0}개 차단 해제(Unblock)" -f $exes.Count }
  $signed = $exes | ForEach-Object { $s = Get-AuthenticodeSignature $_.FullName; "{0,-45} {1}" -f $_.Name, $s.Status }
  if ($signed) { Write-Host "서명 상태:"; $signed | ForEach-Object { Write-Host "  $_" } }
  Write-Host "완료. 이제 이 PC에서 ClassServer 설치 파일·실행 파일이 '확인된 게시자'로 표시됩니다."
}
