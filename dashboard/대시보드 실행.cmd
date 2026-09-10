@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python을 찾을 수 없어 대시보드를 시작하지 못했습니다.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:4173/"
echo 상상특허 업무 자동화 대시보드를 실행했습니다.
echo 이 창을 닫으면 대시보드가 종료됩니다.
python -m http.server 4173 --bind 127.0.0.1
