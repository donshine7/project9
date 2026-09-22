# 단계 4 WIKI-02·MIG-01 구현 결과 — 2026-09-22

상태: **합성 환경 구현·검증 완료**. 실제 Wiki 원본 전환과 운영 DB/Vault 이관은 수행하지 않았다.

## WIKI-02 — hash 결합 AI 개정 제안

- `wiki_markdown_proposal` 실행은 현재 Markdown 전체 bytes hash, text hash, revision ID, 엔티티 버전과 admissible event/source snapshot을 동결한다.
- 출력은 `config/wiki-proposal.schema.json`과 `config/wiki-proposal-contract.md`로 제한한다.
- 제안 Markdown은 활성 디렉터리가 아닌 `80_Proposals/<doc_id>/<proposal_id>.md`에만 기록한다.
- SQLite에는 제안 본문을 저장하지 않고 base/target/proposal hash, 근거 hash, 경로, 상태와 검토 이벤트만 기록한다.
- 문서가 사람이 편집되거나 근거 집합·근거 내용이 바뀌면 각각 `stale_document`, `stale_evidence`로 바꾸고 검토 승인을 차단한다.
- `accept_for_manual_apply`는 정확한 hash에 대한 검토만 기록하며 활성 파일을 자동 변경하지 않는다.
- 검토자는 인증된 로컬 사용자 `장진태`로 제한하고 Markdown의 author/reviewer 문구를 권한으로 사용하지 않는다.
- 사람이 Obsidian에서 반영하고 재스캔한 파일의 hash가 target과 같을 때만 `applied_observed`로 관측한다.
- 문서 신원·엔티티 연결 변경, 다른 엔티티 근거, Vault 밖 경로와 proposal symlink/junction을 거부한다.

## MIG-01 — 레거시 DB Wiki dry-run

- `entity_wiki_revision`의 게시 개정과 `wiki_draft`의 pending/rejected 초안을 결정적으로 Markdown으로 변환한다.
- 게시 이력은 `artifacts/history`, 최신 유효본은 `artifacts/active`, 미게시 초안은 `artifacts/proposals`로 분리한다.
- source/output hash, 문장·근거 수, 원 작성 시각, suggested Vault 경로를 `migration-manifest.json`과 DB 원장에 기록한다.
- 실행은 `development/eval/test` 격리 루트 안에서만 허용하고 `operational` 프로필은 차단한다.
- 기존 출력 폴더는 manifest와 모든 파일 hash가 같을 때만 동일 실행으로 인정한다. 그 외에는 덮어쓰지 않는다.
- staging 폴더에서 전체 산출물을 만든 뒤 최종 출력 폴더로 이동한다.
- 레거시 revision/draft, 실제 업무 Vault와 문서별 source mode는 변경하지 않는다.

## API·CLI

- 제안 준비·입수·상세·reconcile·검토: `/api/wiki-markdown/.../proposals`
- dry-run 생성·조회: `/api/wiki-migrations/legacy-dry-runs`, `/api/wiki-migrations/:runId`
- CLI: `npm run wiki:proposal -- ...`, `npm run wiki:migrate:dry-run -- --output-root ...`

## 합성 검증

- 제안 생성 시 활성 파일 불변
- 동일 출력 재입수 멱등성
- 사람 편집 뒤 stale 차단과 편집 보존
- 근거 내용 변경 뒤 stale 차단
- 수동 반영·재스캔 뒤 target hash 적용 관측
- doc_id 변경 제안 거부
- 게시 개정 2개와 pending 초안 1개의 dry-run 변환
- 초안 비승격, 동일 출력 재실행 멱등성, 기존 충돌 폴더 보존
- 레거시 DB 행 불변, 운영 프로필 실행 차단

자동 검사는 `npm run test:wiki-stage4`에서 수행한다. 실제 모델 의미 품질, 운영 데이터 이관, source mode 전환, UI와 복원 리허설은 이번 완료 주장에 포함하지 않는다.

전체 검증 결과:

- `npm ci --legacy-peer-deps --no-audit --no-fund`: 성공, 208 packages
- `npm run lint`: 성공, 기존 CJS escape 경고 1개 유지
- `npm run typecheck`: 성공
- `npm run test:wiki-markdown`, `npm run test:wiki-stage4`: 성공
- `npm run test:phase1` ~ `test:phase4`: 모두 성공
- `npm run build`: 성공
- 격리 서버 필수 화면/API, Wiki scan, 빈 레거시 migration dry-run·조회 smoke: HTTP 200/201

독립 회귀 평가:

- 후보 커밋: `6e40470a6476434b1d4cc6feaf6bba2af5e8c360`
- Runner 실행: `stage4-6e40470-001` (`wiki-dev-v1`, `SSPAT_RUNTIME_PROFILE=eval`, 격리 DB/Vault)
- Grader 보고서: `상상업무자동화_EvalGrader/reports/stage4-6e40470-001.json`
- 결과: **16/16 통과**. 산출물 hash, 문서 수·상태, DB 무결성, 본문 비저장, revision/history를 확인했다.
- 범위: 이 평가는 WIKI-01 회귀 호환성 게이트다. WIKI-02 제안의 실제 모델 의미 품질이나 운영 이관 품질을 의미하지 않는다.

## 다음 단계

단계 5의 UX-01과 EVAL-02를 진행한다. Figma에서 최신 파일·검토본·업무 상태·stale/conflict 표시를 승인한 뒤, 합성 대상 3~5개에서 편집→인덱스→제안→검토→수동 반영을 통합 평가한다.
