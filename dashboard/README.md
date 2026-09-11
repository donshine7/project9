# 상상특허 로컬 운영 대시보드

`대시보드 실행.cmd`를 파일 탐색기에서 더블클릭하면 PowerShell 시작 스크립트가 실행됩니다. CMD에서는 npm을 직접 찾거나 호출하지 않습니다. PowerShell이 `Get-Command npm`으로 실제 `npm.ps1` 경로를 찾고, 현재 프로젝트의 소스 원본을 `%LOCALAPPDATA%\SSPAT\dashboard-runtime`으로 동기화한 뒤 그 위치에서 설치·실행합니다. `node_modules`, `dist`, `.vinext`, `.wrangler`, `.git`은 동기화하지 않으며, 실행 전용 경로에서 최초 1회 `npm install --legacy-peer-deps --no-audit --no-fund`를 실행합니다. 별도 브라우저 대기 스크립트가 `http://127.0.0.1:4173/` 응답을 최대 60초 기다린 뒤 브라우저를 열고, Vinext 로그는 현재 명령 창에 표시됩니다.

## 운영 갱신 원칙

업무 자동화 정책이 바뀔 때 다음 항목을 같은 작업에서 함께 갱신합니다.

1. 실제 실행 코드와 Outlook 연결 상태
2. `app/data.ts`의 규칙·폴더 데이터와 `/mail` 화면
3. `/` 업무 허브와 `/provisional` 진행 상태·초기화 흐름
4. 상위 `docs/architecture.mmd`의 전체 구조

`index.html`과 `dashboard-data.js`는 의존성 없이 열어보는 정적 참고본으로 함께 보존합니다.

대시보드는 로컬 Vinext 개발 서버에서 동작합니다. `/`는 업무 허브, `/mail`은 Hiworks·Outlook (classic) 운영판, `/provisional`은 한국특허 가출원 프로젝트 추적판입니다. Outlook 메일을 직접 읽거나 외부로 전송하지 않으며, 프로젝트 목록 API도 고정된 로컬 루트만 읽습니다.

`/provisional`의 초기화 버튼은 고정 PowerShell 스크립트를 localhost에서만 호출합니다. 프로젝트명과 `PT` + 숫자 6자리 사건번호를 검증하고, 기존 폴더는 덮어쓰지 않으며, `.staging-*`에서 만든 뒤 최종 폴더로 원자적으로 이동합니다. `검증만 실행(dry-run)`을 켜면 실제 폴더를 만들지 않고 입력과 경로만 확인합니다.
