# 단계 6 CUTOVER-01·RECOVERY-01 합성 게이트 결과 — 2026-09-26

상태: **구현·합성 환경 검증 완료, 운영 전환 미실행**. 실제 사건 문서, 운영 DB/Vault, Outlook, EasyPAT은 변경하지 않았다. 운영 프로필의 원본 전환은 실제 대상 목록을 별도 승인하기 전까지 코드에서 차단한다.

## CUTOVER-01 — 문서별 원본 전환

- 한 실행의 대상은 1~5개 문서로 제한한다.
- 각 문서는 유효한 Markdown/index hash, 현재 revision, `applied_observed` 제안, 사람의 `accept_for_manual_apply`, 보존할 legacy revision이 모두 있어야 한다.
- 검토자 `장진태`, 승인 ID, 확인 문자열 `CUTOVER`를 요구한다.
- 전환 전 DB와 Vault 전체 사본을 만들고 snapshot 전·후 Vault tree hash가 다르면 중단한다. symlink/junction과 격리 루트 밖 경로는 거부한다.
- DB transaction에서 `legacy_db → markdown` 원본 모드와 `wiki.source_mode_changed` event를 함께 기록한다.
- 전환 자체는 활성 Markdown을 수정하지 않으며 legacy revision을 삭제하지 않는다.
- Markdown 원본으로 바뀐 엔티티는 기존 `prepareWiki`·`ingestWiki`·legacy publish 경로의 새 본문 쓰기를 fail-closed로 차단한다.
- Markdown 파일이 누락되거나 잘못되면 오류/누락 상태를 유지하고 legacy DB 본문으로 조용히 fallback하지 않는다.

구현 파일:

- `dashboard/db/migrations/015_wiki_cutover_and_recovery.sql`
- `dashboard/lib/wiki-cutover.ts`
- `dashboard/lib/wiki.ts`
- `dashboard/scripts/wiki-cutover-cli.ts`

## RECOVERY-01 — DB+Vault 사본 복원

- 전환 bundle에는 `database-before.db`, `database-after.db`, 미커밋 파일과 선택적 Git 이력을 포함한 Vault 사본, `cutover-manifest.json`을 보존한다.
- 복원 리허설은 격리 루트의 존재하지 않는 새 폴더만 허용하며 운영 경로를 덮어쓰지 않는다.
- 복원 DB의 quick check, source mode, 현재 Markdown revision, 적용 관측 제안, 사람 검토, source-mode event, 실제 파일 hash를 문서별로 대조한다.
- 복원 DB/Vault hash와 검증 결과를 `recovery-report.json` 및 `wiki_recovery_rehearsal` 원장에 기록한다.
- 단순 DB 복원으로 전환 이후 Markdown 변경을 되돌리는 운영 rollback은 이번 범위에 포함하지 않는다.

## EVAL-03

- 별도 Runner가 Stage 5의 고정 합성 문서 4개를 사용해 legacy revision 생성 → 원본 전환 → legacy 쓰기 차단 → 사본 복원을 실행한다.
- 별도 Grader는 DB/Vault/bundle/report hash, 4개 문서의 원본 모드·승인·event·legacy 보존·파일 hash와 복원 사본을 채점한다.
- 최신 사전 run `stage6-precommit-002`: 안전성 보강 후 **43/43 통과**.
- 사전 Grader 보고서: `상상업무자동화_EvalGrader/reports/stage6-precommit-002.json`.
- 깨끗한 후보 커밋 `5d4c12d7f84295d201b874844cbf9a745629c24e` 기준 최종 run `stage6-5d4c12d-001`: **43/43 통과** (`gitDirty=false`, 대상 4개, 차단된 legacy 쓰기 4건, 복원 검증 4개, 운영 변경 0건).
- 최종 Runner 산출물: `상상업무자동화_EvalRunner/runs/stage6-5d4c12d-001`.
- 최종 Grader 보고서: `상상업무자동화_EvalGrader/reports/stage6-5d4c12d-001.json`.

## 자동 검증

- `npm ci`: 성공, 208 packages.
- `npm run lint`: 성공. 기존 CJS escape 경고 1개만 유지된다.
- `npm run typecheck`: 성공.
- `npm run test:phase1` ~ `test:phase4`: 모두 성공.
- `npm run test:wiki-markdown`, `test:wiki-stage4`, `test:wiki-stage5`, `test:wiki-stage6`: 모두 성공.
- `npm run build`: 성공.
- 격리 test profile과 전용 DB/Vault/사건 루트에서 UI 6개와 API 7개를 점검해 모두 HTTP 200을 확인했다. 기존 포트와 분리해 4175를 사용했다.

## 운영 전환 전 남은 승인

1. 실제 전환 대상 1~3개 문서의 `doc_id`, 현재 hash, 관련 사건과 담당 검토자를 사람이 확정한다.
2. 업무 Vault 편집 중지 시간을 정하고 snapshot 안정성을 확인한다.
3. 운영 DB/Vault 최신 백업 경로와 여유 공간을 확인한다.
4. 합성용 운영 차단을 해제하는 별도 변경과 실제 실행을 승인한다.
5. 실제 전환 직후 같은 문서의 열람·Obsidian 편집·제안·검토와 사본 복원 리허설을 확인한다.

따라서 이번 결과는 운영 전환을 안전하게 수행할 도구와 합성 gate가 준비되었다는 뜻이며, 실제 문서가 이미 전환되었다는 뜻은 아니다.
