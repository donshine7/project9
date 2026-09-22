# mslee@sspat.net 발신 메일 해외 폴더 강제 분류

## 정책

- `mslee@sspat.net`이 직접 보낸 메일은 모두 해외 폴더 중 하나로 분류한다.
- 중국 가출원, PI 사건, 해외 견적·청구·정산, 해외 디자인, 해외 상표, 해외 특허 단서를 순서대로 확인한다.
- 세부 분류 단서가 없으면 `해외 기타`로 보낸다.
- 경조사·기일관리·과제·사건등록·국내 OA 템플릿보다 먼저 판정하여 비해외 폴더로 빠지지 않게 한다.

## 반영 범위

- Outlook 원본: `HiworksAutoClassifier.bas`
- 대시보드 정책: `dashboard/app/data.ts`
- 정적 참고본: `dashboard/static-reference/dashboard-data.js`, `dashboard/static-reference/index.html`
- 구조도: `docs/architecture.mmd`
- 회귀 시험: `dashboard/tests/outlook-rules.test.cjs`

## 안전 범위

- 기존 메일을 이동하거나 일괄 재분류하지 않는다.
- Outlook `NewMailEx`가 호출하는 `HiworksRulesFinal`과 프로젝트 원본을 동일하게 유지한다.

## 반영 상태

- 프로젝트 원본·대시보드·정적 참고본·구조도·회귀 시험 반영을 완료했다.
- 2026-09-18 실제 Outlook 실행 모듈 `HiworksRulesFinal` 전체를 프로젝트 원본으로 교체하고 컴파일·저장·재시작했다.
- 저장된 OTM에서 `mslee@sspat.net` 직접 발신 분기와 `GetDirectOverseasDestination`을 다시 추출해 확인했다.
- 기존 메일은 이동하지 않았다. 실행본 반영 후 실제 신규 수신 메일의 종단간 이동 검증은 자연 수신 시점까지 대기한다.
