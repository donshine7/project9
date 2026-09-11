# 프로젝트 운영 지침

## 범위

- 이 저장소는 상상특허 업무 자동화 프로그램의 유일한 소스 원본이다.
- 현재 프로젝트 루트는 `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화`이다.
- 이전 경로인 `C:\Users\donsh\OneDrive\Documents\project9_workflow_automation`을 참조하거나 다시 만들지 않는다.

## 구성

- `HiworksAutoClassifier.bas`: Outlook (classic)용 Hiworks 메일 자동분류 모듈
- `ThisOutlookSession_Hiworks.txt`: Outlook 이벤트 연결 코드
- `dashboard`: 로컬 업무 허브와 가출원 프로젝트 추적 대시보드
- `docs`: 구조와 설치·복구 문서
- `이메일_샘플`: 분류 규칙 검증용 원본 샘플

## 변경 규칙

- Outlook 분류 정책을 바꾸면 VBA, `dashboard/app/data.ts`, 정적 참고본, `docs/architecture.mmd`를 함께 갱신한다.
- 원본 이메일 샘플은 수정하지 않는다.
- 사용자 메일을 읽거나 이동하는 Outlook 작업은 사용자의 명시적 요청 없이는 실행하지 않는다.
- 비밀정보와 로컬 캐시는 Git에 추가하지 않는다.
- 대시보드는 외부 서비스가 아니라 `127.0.0.1:4173`에서 동작하는 로컬 도구로 유지한다.

## 완료 조건

- `dashboard`에서 `npm ci`, `npm run lint`, `npm run build`가 성공해야 한다.
- `/`, `/mail`, `/provisional`, `/api/projects`가 로컬 서버에서 오류 없이 응답해야 한다.
- 새 프로젝트 초기화는 먼저 dry-run으로 검증하고 기존 폴더를 덮어쓰지 않아야 한다.
