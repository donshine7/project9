# 상상특허 업무 자동화

Hiworks 메일을 Outlook (classic)에서 규칙에 따라 자동 분류하고, 로컬 웹 대시보드에서 메일 정책과 한국특허 가출원 작업 흐름을 관리하는 프로그램입니다.

이 저장소만으로 프로그램 소스, Outlook 연결 코드, 대시보드, 실행 스크립트, 샘플 이메일 및 복구 문서를 모두 관리합니다.

## 저장소 구조

```text
HiworksAutoClassifier.bas          Outlook 자동분류 규칙
ThisOutlookSession_Hiworks.txt     Outlook 수신 이벤트 연결
dashboard/
  app/                             로컬 대시보드 실행 소스
  db/migrations/                   SQLite 스키마 마이그레이션
  lib/                             사건번호 파서·업무 DB 서비스
  scripts/                         실행·프로젝트 초기화·Outlook 읽기 스크립트
  static-reference/                의존성 없는 정적 참고본
config/
  llm-routing.toml                 작업별 모델·추론 강도 원본
  agents/                          메일·사건·Action·검증·Wiki 역할 지침
docs/
  architecture.mmd                 현재 구조의 소스 다이어그램
  WORK_MANAGEMENT_ARCHITECTURE.md  당소관리번호 중심 목표 아키텍처
  DECISION_FEEDBACK_DESIGN.md      사용자 수정 비교·회귀 평가·개선 기록
  SETUP_AND_RECOVERY.md            설치·복구 절차
  assets/                          문서용 이미지
  history/                         완료된 이전·운영 기록
이메일_샘플/                       분류 규칙 검증용 원본 샘플
```

## 빠른 실행

1. Windows에서 Node.js 22.13 이상이 설치되어 있는지 확인합니다.
2. `dashboard\대시보드 실행.cmd`를 더블클릭합니다.
3. 최초 실행 시 필요한 패키지가 `%LOCALAPPDATA%\SSPAT\dashboard-runtime`에 설치됩니다.
4. 브라우저에서 `http://127.0.0.1:4173/`가 자동으로 열립니다.

대시보드의 주요 화면은 다음과 같습니다.

- `/`: 업무 자동화 허브
- `/mail`: Hiworks·Outlook 자동분류 운영판
- `/matters`: 당소관리번호 중심 사건·업무·메모·Action 관리
- `/provisional`: 한국특허 가출원 13단계 추적 및 안전한 프로젝트 초기화

## Outlook 자동분류 설치 또는 복구

Outlook 쪽 VBA가 이미 설치되어 있으면 프로젝트 이동 때문에 다시 설치할 필요는 없습니다. 새 PC에서 복구하거나 VBA가 사라진 경우에는 [설치 및 복구 안내](docs/SETUP_AND_RECOVERY.md)를 따르세요.

## 개발 검증

`dashboard` 폴더에서 다음 순서로 실행합니다.

```powershell
npm ci
npm run lint
npm run test:phase1
npm run test:phase2
npm run build
```

프로그램 구조는 [architecture.mmd](docs/architecture.mmd), 당소관리번호 중심의 목표 구조와 모델 라우팅은 [WORK_MANAGEMENT_ARCHITECTURE.md](docs/WORK_MANAGEMENT_ARCHITECTURE.md), 사용자 수정 비교와 개선 기록은 [DECISION_FEEDBACK_DESIGN.md](docs/DECISION_FEEDBACK_DESIGN.md), 이전 기록은 [MIGRATION_HANDOFF.md](docs/history/MIGRATION_HANDOFF.md)에 정리되어 있습니다. `docs/assets/legacy-workflow.png`는 초기 업무 파이프라인의 참고 스냅샷이며, 현재 구조의 원본은 Mermaid 문서입니다.
