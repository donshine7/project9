# BUILD-D Wiki 운영 배치 readiness handoff

## 제공 범위

- `dashboard/lib/wiki-batch-readiness.ts`는 운영 DB와 Vault를 읽기 전용으로 조사해 결정적 `wiki-operational-batch-readiness-v1` manifest를 반환한다.
- `dashboard/scripts/wiki-batch-readiness-cli.ts`는 JSON을 표준 출력으로 내보낸다. source mode, DB, Vault, 승인, Action을 변경하지 않는다.
- 각 배치는 최대 5건이다. `cutoverDryRun`만 후속 컷오버 검토용이고, `postCutoverObservation`, `nativeMarkdownObservation`, `blockedReview`는 읽기 전용 관측 목록이다.
- 실행별 운영 식별자·hash·경로가 포함될 수 있는 manifest는 Git에 넣지 않는다. 이 handoff에는 운영 본문과 manifest 값을 넣지 않았다.

## 판정 기준

1. 최신 스캔 성공·이슈 0, 문서 parse 유효, 최신 scan 연결, Vault 실제 파일의 byte hash와 현재 revision hash 일치를 검사한다. duplicate 및 missing 상태와 scan issue는 차단한다.
2. 최신 원문 승인 이벤트와 연결된 수락 feedback을 확인한다. 승인 byte/text hash, revision, source mode, 인용 event IDs, 근거 snapshot hash를 현재 파일·DB와 대조한다. 원문 승인이 없을 때만 최신 적용 관측 제안의 검토·근거를 검사한다.
3. `legacy_db` 문서는 legacy 연결·revision, 미완료 Action, 미결 draft를 확인한다. 하나라도 위험 조건이면 컷오버 후보에서 제외한다.
4. `markdown` 문서는 source-mode 이벤트를 검증한다. legacy revision이 있으면 성공한 cutover 및 recovery rehearsal과 그 대상 hash를 확인한다. legacy revision이 없는 신규 문서는 초기화 이벤트를 확인한다. 신규 Markdown을 재컷오버 대상으로 취급하지 않는다.
5. DB hash가 조사 중 바뀌거나 활성 WAL이 있으면 안전한 결과를 만들 수 없으므로 중단 또는 차단한다. 운영 DB는 직접 수정하지 않는다. 읽기용 임시 사본은 OS 임시 폴더에 만들고 종료 시 삭제한다.

`readyForExpansion`은 최신 스캔이 깨끗하고 1건 이상의 컷오버 적격 문서가 있을 때만 참이다. 대상이 0건이면 `NO_ELIGIBLE_CUTOVER`로 보류한다. 관측 배치가 존재한다는 사실은 새 컷오버 허가가 아니다.

## 근거 hash 진단과 후속 계약

현재 재계산 규칙은 `wiki-cutover.ts`의 canonical event snapshot 방식이다. 인용 event ID를 정렬하고, event의 `id, entityType, entityId, eventType, beforeJson, afterJson, actor, sourceType, correlationId, createdAt`를 키 정렬 JSON으로 hash한 뒤 `{eventId,eventHash}` 배열을 다시 canonical hash한다. 승인 payload에는 이 계산 규칙의 버전과 승인 시점 event 필드 snapshot이 기록되지 않는다.

manifest의 `approval`에는 저장·재계산 hash와 다음 비본문 진단이 있다: 인용 event 수, 인용 ID 정확 일치 및 대소문자 무시 일치 여부, 각 ID 목록의 정렬 여부, 대문자 UUID 수, 다른 엔티티 근거 수, 현재 계산에 사용한 event 필드 목록. 이 정보로 입력 ID·정렬·UUID 차이를 배제하거나 확인할 수 있다. 저장 시점 event 필드와 계산 규격은 payload만으로 복원할 수 없어, 나머지 불일치를 근거 변경 또는 과거 계산 규격 차이 중 하나로 단정하지 않는다. 어느 경우에도 `EVIDENCE_HASH_MISMATCH`는 차단한다.

통합 시 ORCH는 승인 생성부, 기존 cutover, BUILD-D를 단일 canonical 함수로 묶어야 한다. 과거 계산 규격 차이로 확인되면 동일 사용자의 새 승인을 받아야 한다. 실제 근거 변경이면 새 revision과 재검토가 필요하다. 기존 승인 자동 보정·재사용은 금지한다.

## 실행과 검증

`dashboard`에 의존성을 설치한 환경에서 CLI와 테스트를 TypeScript로 빌드해 실행한다. CLI 인자는 순서대로 선택적 DB 경로, Vault 경로, 배치 크기(1~5)다. 기본 경로는 운영 DB·Vault이고 출력은 표준 출력이다. 실행 전에 출력 목적지가 추적 파일이 아닌지 확인한다.

합성 테스트는 적격 1건, 파일 hash 변화, 미완료 Action, event 근거 변화, 최신 승인 무효화, recovery 누락 및 성공을 검증한다. 운영 조사에서는 DB/Vault 쓰기나 source-mode 변경을 실행하지 않는다.

## ORCH 통합 요청

- 공용 `package.json`에 필요하면 CLI/test script를 추가한다. BUILD-D는 공용 package/lock 및 `local-api.ts`를 수정하지 않았다.
- 이 변경은 새 migration을 요구하지 않는다.
- 통합 전 승인 생성부의 snapshot 계산 구현을 확인하고 위 세 경로를 단일 함수로 통합한다.
