# 단계 5 UX-01·EVAL-02 구현 결과 — 2026-09-25

상태: **합성 환경 구현·검증 완료**. 실제 Wiki 원본 전환, 운영 DB/Vault 변경, 실제 사건·메일·고객 자료 사용은 수행하지 않았다.

## UX-01 — Figma 기반 Wiki 검토 화면

- 승인 기준 파일: [Wiki Review UX](https://www.figma.com/design/Jza7Umf9gezhYcmleHJoAf)
- 기준 화면: `Wiki Review / Desktop` (`23:2`, 1440×1024)
- 로컬 컴포넌트: Button (`16:21`), StatusBadge (`17:34`), Tab (`18:16`), DocumentListItem (`19:23`)
- 변수 64개, text style 7개, effect style 1개를 정의하고 색·크기·상태 의미를 React/CSS와 대응시켰다.
- 화면은 Markdown 최신본, SQLite 업무 상태, 현재/검토 hash, AI 제안 상태, 근거, 사람 검토 게이트를 분리해서 보여 준다.
- Figma와 코드의 상세 대응은 [wiki-review-code-map.md](../design/wiki-review-code-map.md), 재현용 node/variable ID는 [figma-stage5-state.json](../design/figma-stage5-state.json)에 고정했다.
- Figma 자료에는 합성 사건만 사용했다. Pretendard를 사용할 수 없는 Figma 환경에서는 제품 font fallback과 일치하는 Noto Sans KR을 사용했다.
- Code Connect는 컴포넌트가 아직 Figma 라이브러리로 게시되지 않아 보류했다. 게시 후 매핑 문서의 4개 React 경로를 연결한다.

## 코드와 원본 경계

- `dashboard/lib/wiki-review.ts`: Markdown 문서, scan, 제안, 검토, 근거, DB snapshot을 결합하고 8개 검토 상태를 결정한다.
- `dashboard/local-api.ts`: Wiki 검토 목록과 문서 상세 read API를 제공한다.
- `dashboard/app/wiki/page.tsx`, `components.tsx`, `globals.css`: Figma 승인 상태와 안전 동작을 구현한다.
- Obsidian Markdown은 Wiki 본문 원본이고 SQLite는 업무 상태와 hash·근거·제안·검토 이력 원본이다.
- `accept_for_manual_apply`는 승인 기록만 만든다. 활성 Markdown은 자동으로 바꾸지 않으며 사람이 반영한 뒤 scan/reconcile로 `applied_observed`를 관측한다.
- 대시보드는 Vault의 절대 경로를 브라우저에 노출하지 않는다.

## EVAL-02 — 수직 기능 통합 평가

- dataset: `eval/datasets/wiki-vertical-v1`, 합성 문서 4개
- Runner와 Grader는 별도 프로젝트를 유지하며 Runner에는 dataset만, Grader에는 expected 계약만 배치했다.
- 흐름: 초기 scan → 사람 편집 → 재scan → 제안 생성 → 사람 검토 → 수동 반영 → 재scan/reconcile → 검토 UI 상태 집계
- 치명 조건: 자동 원본 반영, 검토 전 활성 Markdown 변경, 산출물 hash 불일치, 문서/상태 누락은 실패로 판정한다.
- 사전 검증 run `stage5-precommit-001`: **39/39 통과**. `automaticApply=false`, 제안 4건 모두 `applied_observed`, 최종 UI 상태 4건 모두 `up_to_date`다.
- 깨끗한 후보 커밋 기준 최종 run: 첫 구현 커밋 후 별도 Runner/Grader에서 재실행해 이 문서에 기록한다.

## 자동·스모크 검증

- `npm ci`: 성공, 208 packages. 보고된 의존성 취약점 11개는 기존 계획대로 별도 작업으로 남겼고 자동 수정하지 않았다.
- `npm run typecheck`, `npm run lint`: 성공. lint의 기존 CJS escape 경고 1개만 유지된다.
- `npm run test:phase1` ~ `test:phase4`: 모두 성공.
- `npm run test:wiki-markdown`, `test:wiki-stage4`, `test:wiki-stage5`: 모두 성공.
- `npm run build`: 성공.
- 격리 test profile과 전용 DB/Vault/사건 루트로 `/`, `/mail`, `/matters`, `/analysis`, `/wiki`, `/provisional` 및 필수 API 7개를 검사해 모두 HTTP 200을 확인했다. 기존 4173 포트와 충돌하지 않도록 4174를 사용했다.

## 운영 전환 판단

단계 5는 UI와 합성 수직 흐름을 검증했지만 실제 문서의 원본 전환 승인은 아니다. 다음 단계는 CUTOVER-01·RECOVERY-01이며, 허용된 소수 문서만 대상으로 DB 본문 쓰기 중단과 DB+Vault 사본 복원 리허설을 먼저 수행한다.
