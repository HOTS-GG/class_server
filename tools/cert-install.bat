@echo off
rem ClassServer signing certificate install (needs admin). Installs ClassServer-codesign.cer next to this file
rem into LocalMachine\Root + TrustedPublisher and unblocks exe files in this folder.
cd /d "%~dp0"
if not exist "%~dp0ClassServer-codesign.cer" (
  echo [ERROR] ClassServer-codesign.cer not found next to this file.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0trust-cert.ps1" -Cer "%~dp0ClassServer-codesign.cer"
echo.
pause
