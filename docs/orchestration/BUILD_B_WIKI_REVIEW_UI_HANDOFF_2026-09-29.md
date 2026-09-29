# BUILD-B Wiki 승인·충돌 검토 UI handoff

## 구현 경계

- `dashboard/app/wiki/page.tsx`는 기존 Wiki 목록·상세 API를 계속 사용한다.
- 문서 원문 승인 준비·기록은 `dashboard/app/wiki/review-adapter.ts`에만 연결한다. `local-api.ts`는 BUILD-A/ORCH 소유이므로 이 작업에서 수정하지 않았다.
- 문서 원문 승인은 현재 Markdown 파일의 정확한 개정과 근거를 기록하는 일이다. AI 제안의 `accept_for_manual_apply` 검토나 사건의 업무종류·단계·현재상태·Action 변경과 별개다.
- 고객 데이터, 운영 DB, 실제 Vault는 사용하지 않았다.

## UI 상태 결정

`review-model.ts`가 기존 `wiki-review` 응답을 표시 상태로 변환한다. 우선순위는 복구 중 → 파일 누락 → 중복 ID → 편집 충돌 → 근거 오래됨 → 현재 파일 hash와 일치하고 최신 제안보다 늦은 문서 승인 → 제안 검토 완료 → 최신 → 검토 필요다. 승인 이벤트의 hash가 현재 파일과 다르거나 승인 이후 새 제안이 생기면 승인됨으로 표시하지 않는다. `reviewed`가 AI 제안 검토만 뜻하는 경우 `제안 검토 완료`로 표시한다.

| 표시 | 근거 | 승인 버튼 |
|---|---|---|
| 최신 | `up_to_date`이며 승인 이력 없음 | 서버 사전검사에 따름 |
| 검토 필요 | 새 파일 또는 제안 검토 대기 | 서버 사전검사에 따름 |
| 문서 승인됨 | `reviewed`, 승인 hash 일치, 승인 시각이 최신 제안 이후 | 비활성 |
| 제안 검토 완료 | `reviewed`이며 현재 파일의 문서 승인 이력 없음 | 서버 사전검사에 따름 |
| 근거 오래됨 | `evidence_stale` 또는 제안 `stale_evidence` | 비활성 |
| 문서 없음 | `missing` | 비활성 |
| ID 중복 | `duplicate_id` | 비활성 |
| 편집 충돌 | `conflict`, `indexStale`, 제안 `stale_document` | 비활성 |
| 복구 중 | `indexing` 또는 상세 `recovery.status=running` | 비활성 |

## BUILD-A API 계약

### GET `/api/wiki-review/documents/:docId/approvals`

문서 원문 승인 가능 여부와 현재 읽기 전용 비교 기준을 반환한다. `docId`는 URL 인코딩한다.

```json
{
  "allowed": true,
  "code": null,
  "reason": null,
  "expectedRevisionId": "synthetic-revision-1",
  "expectedByteHash": "64-character-lowercase-sha256",
  "expectedTextHash": "64-character-lowercase-sha256",
  "expectedEvidenceSnapshotHash": "64-character-lowercase-sha256"
}
```

승인 불가일 때도 같은 형태로 `allowed:false`, 안정적인 기계 판정용 `code`, 사람이 이해할 수 있는 `reason`을 반환한다. 네 expected 필드는 문자열로 유지한다. 이 경로가 404이면 승인 버튼을 비활성화하고 `문서 원문 승인 API가 연결되면 승인할 수 있습니다`를 표시한다. 401/403, stale, conflict, recovery in progress 및 네트워크 오류도 승인 버튼을 비활성화하고 코드·이유를 표시한다.

### POST `/api/wiki-review/documents/:docId/approvals`

확인 체크 후 아래 body를 보낸다. UI는 reviewer를 입력받거나 body에 넣지 않는다. 서버가 인증된 검토자를 결정하고 현재 파일·개정·근거와 expected 값을 원자적으로 다시 비교해야 한다.

```json
{
  "expectedRevisionId": "synthetic-revision-1",
  "expectedByteHash": "64-character-lowercase-sha256",
  "expectedTextHash": "64-character-lowercase-sha256",
  "expectedEvidenceSnapshotHash": "64-character-lowercase-sha256",
  "idempotencyKey": "client-uuid",
  "statement": "현재 Markdown 원문과 근거를 직접 확인하고 이 문서 개정을 승인합니다."
}
```

성공 응답은 `{ "eventId": "...", "docId": "...", "revisionId": "...", "byteHash": "...", "evidenceSnapshotHash": "...", "status": "approved" }`다. 이미 승인된 경우 `status:"already_approved"`와 선택적인 `duplicate:true`를 반환할 수 있다. 실패 응답은 안정적인 `code`와 사람이 읽을 `message`를 포함한다. 같은 파일 hash의 실패 재시도에는 같은 idempotency key를 쓴다. 성공 후 목록·상세·GET 사전검사를 다시 읽어 화면 상태를 결정한다. 충돌 오류 후에도 다시 읽고 원래 코드·메시지를 표시한다. 서버는 승인 `event`와 연결된 `user_feedback`을 원자적으로 기록하고, 업무 상태를 변경하지 않아야 한다.

## 통합 확인

1. BUILD-A GET 응답 필드·POST 성공 응답이 위 형태인지 확인한다. 차이가 있으면 `review-adapter.ts` 한 곳에서 변환한다.
2. BUILD-A가 인덱스 복구 상태를 제공한다면 상세 응답의 `recovery.status=running`으로 연결한다. 현재 `indexing`도 복구 중 안내를 표시한다.
3. 파일 hash, 개정 또는 근거가 승인 직전에 바뀐 409 응답을 합성 데이터로 확인하고, 승인 이벤트가 생성되지 않는지 검증한다.
4. `npm run lint`, `npm run test:wiki-stage5`, 합성 UI 테스트, `npx tsc --noEmit --incremental false`, `npm run build`를 통합 브랜치에서 재실행한다.

## 이번 작업의 검증

- `dashboard/tests/wiki-review-ui.test.ts`: 상태 우선순위, 승인 차단, URL/body, reviewer 부재, 재시도 key.
- `dashboard/tests/wiki-review-panels.test.tsx`: 합성 데이터로 검토·승인·근거 오래됨 패널과 업무 상태 경계를 렌더링.
- `dashboard`에서 `node tests/run-wiki-review-ui.cjs`로 두 테스트를 실행한다. `npm run typecheck`로 전체 타입을 별도 확인한다.
- 통합 전에는 기존 `local-api.ts`에 승인 GET/POST가 없으므로 실제 승인 버튼은 비활성 상태다.
