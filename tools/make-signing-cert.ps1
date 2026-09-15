# 코드 서명용 자체 서명 인증서 만들기 (테스트·교내 배포용)
#   powershell -ExecutionPolicy Bypass -File tools\make-signing-cert.ps1 [-Password "비밀번호"] [-Out "경로\codesign.pfx"]
#
# 주의: 자체 서명 인증서는 파일이 변조되지 않았음을 증명하지만, Windows SmartScreen 경고를 없애지는 못합니다.
# 경고까지 없애려면 공인 CA(Sectigo, DigiCert 등)의 코드 서명 인증서(.pfx)를 구입해 같은 방법으로 쓰면 됩니다.
param(
  [string]$Password = "classserver",
  [string]$Out = (Join-Path $env:USERPROFILE ".class_server\codesign.pfx"),
  [string]$Subject = "CN=ClassServer Teacher Tools, O=ClassServer"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject `
  -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(5) -FriendlyName "ClassServer code signing"
$sec = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $Out -Password $sec | Out-Null
Write-Host "인증서 생성: $Out"
Write-Host "지문(Thumbprint): $($cert.Thumbprint)"
Write-Host "다음 명령으로 서명 빌드: powershell -ExecutionPolicy Bypass -File tools\build-signed.ps1 -Cert `"$Out`" -Password `"$Password`""
