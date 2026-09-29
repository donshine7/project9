# BUILD-E: Wiki 자동 반영 운영 게이트

기준: `abc64145d1e21f66f8c7e6be5cd8d7db0168e316`. 실제 운영 DB·Vault, Outlook, EasyPAT에는 접근하거나 쓰지 않았다. 합성 OS temp DB/Vault와 checkpoint/restore 사본만 사용했다.

## 구현

- `dashboard/lib/wiki-auto-apply-gate.ts`: 운영 프로필의 실행별 승인, 신뢰된 서버 검토자 context, DB·Vault 절대경로 이중 확인, 작성기 중지 작업창, 검증된 BUILD-C 체크포인트와 별도 복원 리허설을 요구한다. manifest/report의 입력 SHA-256, 출처 경로 해시, DB·Vault 사본, Git HEAD를 재검증한다. 입력과 사본 경로 포함 관계·링크를 차단한다.
- `dashboard/lib/wiki-auto-apply.ts`: 운영에서도 위 게이트가 통과할 때만 별도 자동 승인, 적용, 복구를 허용한다. 적용은 `BEGIN IMMEDIATE`로 DB 쓰기 잠금을 잡은 구간에서 proposal `row_version`·base/target/evidence, 별도 승인 이벤트, 문서 경로·revision·source mode, 현재 파일 base hash와 제안 파일 target hash를 다시 대조한 뒤 교체한다. 적용 작업과 완료 이벤트에 승인·체크포인트·복원·검토자·멱등 결합을 남긴다. `conflict`/`failed`는 자동 복구하지 않는다. 운영 fault hook은 금지한다.
- migration `022_wiki_operational_auto_apply.sql`만 추가했다. 적용된 migration은 수정하지 않았다. `023`은 사용하지 않았다.
- 테스트는 temp 아래 명시한 DB/Vault/checkpoint/restore 경로를 사용하고 기본 운영 DB 경로와 다름을 확인한다. checkpoint 생성과 restore rehearsal도 이 합성 테스트 안에서만 실행한다.

## ORCH의 HTTP 연결 계약

공용 `dashboard/local-api.ts`, `package.json`/lock, `app/globals.css`, 기존 page는 BUILD-E에서 수정하지 않았다. 다음 연결은 ORCH 소유다.

1. `POST /api/wiki-auto-apply/approvals`: body는 `{ proposalId, expectedProposalVersion, gate: { authorizationId, confirmation, checkpoint, checkpointManifestSha256, restore, restoreReportSha256, database, vault, idempotencyKey } }`. 서버는 인증 경계에서 `AuthenticatedWikiReviewer` (`actorId='장진태'`, `authenticated=true`, 실제 인증 방법)를 만들고 `writersStopped`를 신뢰된 작업창 상태에서만 부여한다. body와 `gate`의 `reviewer`, `actorId`, `authenticated`, `authenticationMethod`, `writersStopped`는 거부한다. 서버가 `approveWikiAutoApply(proposalId, expectedProposalVersion, reviewer.actorId, { operationalGate, reviewerContext: reviewer })`를 호출한다.
2. `POST /api/wiki-auto-apply/proposals/:proposalId/apply`: 같은 `gate` 객체와 바깥 `confirmation: 'APPLY'`를 받아 `executeWikiAutoApply(proposalId, { confirmation: 'APPLY', operationalGate, reviewerContext })`를 호출한다. 운영 승인 ID/확인 문자열은 `gate.confirmation='AUTO_APPLY:<authorizationId>'`이며 서버 환경 `SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_AUTHORIZATION`과 일치해야 한다. 승인과 적용은 같은 checkpoint manifest·restore report·검토자 context에 결합된다.
3. `POST /api/wiki-auto-apply/operations/:operationId/recover`: 먼저 상태 조회를 요구하고, 원 operation과 **같은** authorization ID, checkpoint manifest SHA, restore report SHA, idempotency key, 검토자 context를 전달한다. 서버는 `recoverWikiAutoApply(operationId, { operationalGate, reviewerContext })`를 호출한다. `conflict`/`failed`는 버튼과 서버 양쪽에서 차단한다.
4. `GET /api/wiki-auto-apply/operations/:operationId`: 인증된 서버 검토자 context가 있을 때만 `wikiAutoApplyStatus(operationId)`를 호출한다. 응답의 감사 결합 필드와 오류 코드를 UI에 그대로 표시한다. 자동 승인과 적용 상태를 문서 검토 상태에 합치지 않는다.

통합 구현은 체크포인트의 `operationId`와 `authorizationId`를 같게 요구하고, 승인·적용 직전에 현재 Vault 전체가 체크포인트의 파일 목록·tree hash와 일치하는지 재검증한다. 복구에서는 대상 문서 한 경로만 base/target 변경을 허용하고 나머지 Vault 파일은 체크포인트와 같아야 한다.

게이트 서버 환경 변수는 `SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_AUTHORIZATION=AUTO_APPLY:<id>`, `SSPAT_OPERATIONAL_WIKI_WRITERS_STOPPED=<id>`, `SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_DATABASE=<절대 DB 경로>`, `SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_VAULT=<절대 Vault 경로>`다. `SSPAT_WORK_DB_PATH`와 `SSPAT_WIKI_VAULT_PATH`의 현재 해석 결과까지 각각 일치해야 한다. localhost 연결만으로는 인증되지 않는다. 새 HTTP 라우트와 Figma 9상태 UI 연결은 아직 없으며, 이 branch를 병합해도 버튼으로 운영 실행이 시작되지는 않는다.

Obsidian과 다른 외부 작성기는 이 코드의 SQLite 잠금을 따르지 않는다. 승인된 쓰기 중지 작업창은 실제로 중지·확인되어야 하며, 소프트웨어만으로 외부 작성기 중지를 증명하지 않는다. 체크포인트/복원 리허설을 실제 운영에서 만드는 작업도 이 변경에 포함되지 않는다.

## 검증

- `npm ci`, `npm run typecheck`, `npm run test:wiki-edit01` 통과.
- 합성 운영 테스트: 기본 차단, checkpoint·restore hash 검증, 경로 겹침·복원 사본 변조 차단, 운영 fault hook 거부, 승인·적용·멱등·감사 필드, 승인 후 사람 편집 보존.

## 통합 평가 회귀 수정

BUILD-E 이전 통합 후보의 외부 Stage 6 러너에서 `wiki_document_source_mode.doc_id` 중복 삽입이 재현되었다. Vertical 러너의 최초 색인이 새 entity Wiki의 source mode를 이미 `markdown`으로 초기화한 뒤, cutover 러너 fixture가 행이 없다고 가정하고 `legacy_db` 행을 다시 `INSERT`한 것이 원인이었다. 운영 cutover 로직의 실패가 아니라 평가 fixture의 단계 간 계약 불일치였다.

`wiki-eval-cutover-runner.ts`는 이제 동일 `doc_id`가 있으면 합성 legacy revision에 맞춰 명시적으로 `legacy_db`로 갱신한다. 새 OS temp 실행에서 4개 문서 cutover, legacy 쓰기 차단, bundle, 복원 리허설이 완료되었고 dev expected 채점 43/43을 통과했다. 이 수정은 합성 평가 DB에만 적용되며 운영 DB·Vault를 변경하지 않는다.
