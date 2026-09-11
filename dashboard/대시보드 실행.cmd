@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "START_SCRIPT=%~dp0scripts\Start-Dashboard.ps1"
if not exist "%START_SCRIPT%" (
  echo 대시보드 시작 스크립트를 찾을 수 없습니다: %START_SCRIPT%
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%START_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo 대시보드가 시작되지 않았습니다. 실제 종료 코드: %EXIT_CODE%
  pause
)

endlocal & exit /b %EXIT_CODE%
