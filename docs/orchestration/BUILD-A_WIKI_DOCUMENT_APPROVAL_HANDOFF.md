# BUILD-A: Wiki 원문 승인 서비스 인계

## 범위와 완료 상태

`dashboard/lib/wiki-document-approval.ts`는 현재 Markdown 파일, 인덱스, revision, 원본 모드와 인용된 event의 내용을 다시 확인한 뒤 원문 승인 감사를 기록한다. `dashboard/tests/wiki-document-approval.test.ts`는 운영 DB/Vault에 접근하지 않는 합성 fixture를 사용한다. 공용 라우터와 migration은 변경하지 않았다.

## ORCH 연결 계약

- `GET /api/wiki-review/documents/:docId/approvals` → `getWikiDocumentApproval(docId)`; `allowed`, `code`, `reason`, `expectedRevisionId`, `expectedByteHash`, `expectedTextHash`, `expectedEvidenceSnapshotHash`와 현재 대상·승인 이력(`current` 포함)을 반환한다. 파일·인덱스 또는 근거가 유효하지 않으면 안정적인 409 오류 코드를 반환하므로 ORCH 라우터에서 동일한 `allowed=false, code, reason` 모양으로 변환한다.
- `POST /api/wiki-review/documents/:docId/approvals` → `approveWikiDocument({ docId, expectedRevisionId, expectedByteHash, expectedTextHash, expectedEvidenceSnapshotHash, idempotencyKey, statement }, reviewerContext)`; 성공 시 `{ eventId, feedbackId, docId, revisionId, byteHash, evidenceSnapshotHash, status, duplicate }`를 반환한다. `status`는 `approved` 또는 `already_approved`이다. 최초 승인 201, 같은 요청 재시도 200이 적절하다.
- `docId`는 URL에서만 받는다. 본문의 `reviewer`, `actorId`, `authenticated`, `authenticationMethod` 값은 검토자 판단에 사용하지 않는다.
- `reviewerContext`는 **실제 인증된 서버 세션**에서만 만들어 `{ actorId: '장진태', authenticated: true, authenticationMethod: '<server-side method>' }`로 전달한다. 현재 `local-api.ts`의 localhost 검사만으로는 사용자 인증이 되지 않는다. 인증 컨텍스트가 없으면 운영 POST를 열지 말고 403으로 종료한다. 이 연결은 ORCH가 소유한다.
- 기존 local API의 `WorkDbError` 응답 처리에 따를 수 있다. 입력 본문 크기는 16 KiB 이하를 권장한다.

## 승인·감사 계약

- 승인 대상은 `legacy_db` 원본 모드의 유효한 entity Wiki 문서이다. 파일 byte SHA-256, 정규화 text SHA-256, 현재 Markdown revision ID, 인용 event 목록과 각 event snapshot SHA-256을 서버가 계산한다. 요청의 네 expected 값은 전부 현재값과 같아야 한다.
- 승인 event는 기존 `wiki.document_approved` / `wiki-document-approval-v1` payload를 사용한다. `approval='approve_as_is'`, `sourceMode='legacy_db'`, `automaticApply=false`, `sourceCutoverPerformed=false`를 포함해 `wiki-cutover.ts`의 검증과 호환된다. `statement`는 사용자의 승인 문구일 뿐 사실 근거로 사용하지 않는다.
- 같은 SQLite `BEGIN IMMEDIATE` transaction 안에서 `event`와 연결된 `user_feedback(accept, approved_as_is)`을 기록한다. 실패 시 둘 다 롤백된다. 기존 스키마로 충분하며 신규 migration은 필요하지 않다. 향후 대량 이력에서 조회 지연이 측정될 때만 `event(event_type,correlation_id)` 인덱스를 ORCH가 고려하면 된다.
- event ID는 `docId + reviewer + idempotencyKey + requestHash`로 결정된다. `requestHash`는 승인 대상의 revision/byte/text/evidence hash와 문구를 묶는다. 같은 키·동일 요청은 기존 event를 반환하고, 같은 키·상이 요청은 409 충돌, 다른 키로 같은 revision 재승인은 409 중복이다.
- 운영 Wiki 컷오버에는 반환된 `eventId`를 `documentApprovalEventId`로 전달한다. 컷오버의 별도 운영 게이트와 재검증은 유지한다.

## 근거 해시 공유 계약

`dashboard/lib/wiki-document-evidence.ts`의 `wikiDocumentEvidenceSnapshot(markdown, resolveEvent)`를 승인 서비스가 사용한다. ORCH는 컷오버와 D의 현재 해시 재계산도 이 함수로 수렴시켜야 한다. `resolveEvent`는 전체 `event` 행을 돌려준다.

- 입력 Markdown은 BOM 제거와 CRLF→LF 정규화가 끝난 **전체 문서 문자열**이다. `readWikiMarkdownSource(...).normalized`를 전달한다.
- 각주 정의의 `event:<36자 hex/hyphen ID>`만 추출한다. ID는 원문 대소문자를 그대로 유지하고, 정확한 문자열로 중복 제거한 후 JavaScript 기본 `.sort()` 순서로 정렬한다. UUID 대소문자를 자동 변환하지 않는다.
- 각 event의 snapshot은 `id, entityType, entityId, eventType, beforeJson, afterJson, actor, sourceType, correlationId, createdAt` 열 개 필드이다. DB의 nullable 값은 `null` 그대로 둔다. 임의의 선택 필드를 추가하거나 빠진 필드를 `undefined`로 대체하지 않는다.
- 객체 키를 사전순으로 정렬해 JSON 직렬화한 event snapshot의 SHA-256을 계산한다. 정렬된 `{ eventId, eventHash }[]`를 같은 방식으로 직렬화해 전체 SHA-256을 계산한다. 근거 event 누락은 `WikiDocumentEvidenceMissingError`로 반환하며 호출자가 자기 도메인 오류 코드로 바꾼다.
- 기존 운영 승인 event의 저장 해시와 현재 재계산 해시가 다른 경우 event/feedback 값을 수정하거나 자동 승계하지 않는다. GET 이력의 `current=false`로 두고 사람 재승인을 요구한다. 기존 `wiki-review.ts`의 byte hash만 보는 상태 판정도 ORCH/D가 이 결과에 맞춰 수정해야 한다.

## 오류 코드

| 코드 | 의미 |
| --- | --- |
| `WIKI_DOCUMENT_APPROVAL_REVIEWER_INVALID` | 인증 컨텍스트 부재 또는 허용 검토자 불일치 (403) |
| `WIKI_DOCUMENT_APPROVAL_STALE` | 파일·인덱스·revision·요청 snapshot 변경 (409) |
| `WIKI_DOCUMENT_APPROVAL_EVIDENCE_REQUIRED` | 인용 event 없음 (409) |
| `WIKI_DOCUMENT_APPROVAL_EVIDENCE_STALE` | 인용 event 누락 (409) |
| `WIKI_DOCUMENT_APPROVAL_EVIDENCE_INVALID` | 다른 엔티티 event 인용 (409) |
| `WIKI_DOCUMENT_APPROVAL_SOURCE_MODE` | 원본 모드 없음 또는 승인 가능한 legacy 문서가 아님 (409) |
| `WIKI_DOCUMENT_APPROVAL_IDEMPOTENCY_CONFLICT` | 동일 키로 다른 승인 요청 (409) |
| `WIKI_DOCUMENT_APPROVAL_DUPLICATE` | 다른 키로 같은 revision 재승인 (409) |
| `WIKI_DOCUMENT_APPROVAL_INVALID` | 입력 형식 오류 (400) |

## 통합 확인 항목

1. 인증 서버 컨텍스트가 없는 환경에서 POST가 403으로 닫히는지 확인한다.
2. 공용 라우터에 두 경로를 추가하고 URL `docId`를 서비스에 전달한다.
3. 승인 후 `wiki-review` 화면이 기존 `documentApproval` 요약 및 새 이력을 일관되게 보여주는지 확인한다. 기존 `wiki-review.ts`는 승인 상태를 주로 byte hash로 판단하므로 근거 변경 경고에는 새 서비스의 `current` 값을 사용해야 한다.
4. 운영 원본 전환 전에 컷오버의 기존 `verifiedDocumentApproval` 검증을 통과하는지 격리 사본에서 확인한다.

파일 시스템과 SQLite 사이에는 단일 원자 transaction이 없다. 승인 함수는 DB write transaction 안에서 파일을 다시 읽고 해시를 확인하며, 컷오버는 실행 시점에 재검증한다. 승인 직후 외부 편집이 발생하면 이력이 남아도 현재 승인으로 취급하지 않는다.

## 검증 명령

`dashboard`에서 `tsc tests/wiki-document-approval.test.ts lib/wiki-document-approval.ts lib/wiki-document-evidence.ts --outDir ../.wiki-document-approval-test --rootDir . --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --esModuleInterop` 후 `node ../.wiki-document-approval-test/tests/wiki-document-approval.test.js`. 테스트 산출물은 commit 전에 삭제한다.
