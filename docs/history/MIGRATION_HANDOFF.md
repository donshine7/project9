# 프로젝트 이전 기록

## 이전 범위

- 이전 원본: OneDrive에 있던 구 작업본(현재 사용 금지)
- 새 프로젝트: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화`
- 이전일: 2026-09-11
- 방식: 기존 Git 이력 보존, 미커밋 구현 포함, 새 위치에서 의존성·빌드·로컬 응답 검증

## 함께 이전된 구현

- Outlook VBA 자동분류 모듈과 `Application_NewMailEx` 연결 코드
- 국내 특허 시리즈 및 EASYPAT_S 국내 OA 예외 보정
- 로컬 업무 허브, 메일 운영판, 가출원 프로젝트 추적판
- 로컬 프로젝트 목록·초기화 API와 PowerShell 초기화 스크립트
- 정적 참고 대시보드, 이메일 샘플, Mermaid 구조 문서
- Git 커밋 이력과 원격 저장소 설정

## 독립 실행성

- 실행 스크립트는 자신의 위치를 기준으로 소스를 찾으므로 이전 원본 경로에 의존하지 않는다.
- 실행용 복제본은 `%LOCALAPPDATA%\SSPAT\dashboard-runtime`에 생성된다.
- 가출원 관리 대상 루트 `C:\ChatGPT\AI-Work\10_특허\한국특허가출원`은 프로그램의 업무 설정값이며 이전 원본 경로가 아니다.
- Outlook VBA는 Outlook 사용자 프로필에 설치되며 프로젝트 폴더 이동과 독립적이다. 저장소의 두 VBA 파일로 재설치할 수 있다.

## 검증 기준

- `npm ci`: 잠금 파일 기준 clean install 재현 완료
- `npm run lint`: 경고·오류 없이 통과
- `npm run build`: `/`, `/mail`, `/provisional` 빌드 완료
- 로컬 응답 확인: `/`, `/mail`, `/provisional`, `/api/projects` 모두 HTTP 200
- 초기화 안전성 확인: 복수 PT 사건번호 dry-run 성공, 대상 폴더가 생성되지 않음을 확인

## 전환 결과

- Git 이력은 하드링크 없이 새 프로젝트에 독립 복제했다.
- Git 원격은 이전 로컬 폴더가 아니라 `https://github.com/donshine7/project9.git`을 가리킨다.
- 이전 원본의 미커밋 구현을 새 프로젝트의 이전 완료 커밋으로 보존한다.
- 검증 완료 후 이전 Codex 작업은 보관하고 이전 프로젝트 폴더는 삭제한다.
