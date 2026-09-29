# BUILD-F: Legacy Wiki 봉인 archive와 정리 차단 게이트

## 자산 분류와 보존 원칙

| 자산 | 역할 | BUILD-F 처리 |
| --- | --- | --- |
| `entity_wiki_revision.sections_json` | 사건별 게시 본문 revision | 전체 행과 근거를 행별 JSON으로 복사·봉인. **원본 유지** |
| `wiki_draft.sections_json` | pending·published·rejected 초안 | 상태와 전체 행을 복사·봉인. 모든 초안에 보존 정책 blocker |
| `wiki_revision.content` | 이전 구조의 사건 Wiki 본문 | 전체 행과 인용 이벤트를 복사·봉인. 별도 보존 정책 blocker |
| `wiki_entry`, `event`, `decision_run`, `user_feedback` | 문장·결정·사용자 감사 근거 | archive 근거에 참조. 원장 행은 삭제 대상 아님 |
| `wiki_document`, `wiki_markdown_revision`, Vault 파일·history | 활성 Markdown 및 버전 기록 | 읽기 검증만 수행. 파일과 source mode는 변경하지 않음 |

기존 CLEANUP-01의 dry-run 결과는 유지한다. BUILD-F는 별도 `wiki_legacy_archive_run/item` 원장과 `wiki-legacy-archive-v2` manifest를 추가한다. 두 원장은 본문 삭제 허가가 아니다. `evidence_complete`는 해당 archive의 연결 증거가 완전하다는 뜻만 가진다.

## 봉인 및 검증

- `dashboard/lib/wiki-legacy-archive.ts`의 `runWikiLegacyArchiveDryRun(outputRoot)`은 `test`·`eval`·`development` 프로필에서 **OS temp 내부의 격리 루트**만 허용한다. DB·Vault·출력은 모두 그 루트 안에 있어야 하고 출력과 DB/Vault는 겹칠 수 없다. 부모 경로의 symlink/junction을 차단한다.
- DB 외래키를 점검하고, 모든 legacy 본문 원본 행을 복사한다. 파일명에는 ID의 SHA-256을 사용하여 임의 ID가 경로가 될 수 없게 한다. 본문 hash, archive 파일 hash, 근거 hash를 manifest와 SQLite 원장에 기록한다.
- 각 `entity_wiki_revision`은 **그 revision ID를 직접 지목하는 정확히 하나의 컷오버 항목**만 인정한다. 문서의 현재 revision·byte hash·Vault 파일, `source_mode=markdown`과 source-change 이벤트, 컷오버 승인 유형 및 실행 감사, 컷오버 manifest와 성공한 복구 보고서의 ID·hash·대상 연결을 검사한다. 다른 revision의 컷오버 성공은 재사용하지 않는다.
- 컷오버 manifest와 복구 보고서는 OS temp 내부의 실제 파일이어야 한다. archive 출력은 컷오버 묶음·복구 사본과도 겹칠 수 없다. archive 항목에 두 파일의 hash를 보존하므로 이후 변경은 재검증에서 감지된다.
- 원본과 근거의 snapshot hash를 파일 봉인 전후에 비교한다. DB 원장은 파일 검증 뒤에 기록하며, 파일 또는 원장만 남은 부분 결과와 기존 staging은 차단한다. 재실행은 현재 원본 snapshot, manifest, 각 archive 파일, 파일 목록, 원장 항목을 다시 대조한 경우에만 멱등 결과를 돌려준다.
- migration `023_wiki_legacy_archive_gate.sql`의 트리거는 archive 원장 행의 UPDATE/DELETE를 거부한다. 파일 자체의 불변성은 SHA-256 검증과 재검증 절차로 확인한다.
- `verifyWikiLegacyArchive(outputRoot)`는 이미 봉인된 결과만 검증한다. CLI 명령은 `dry-run`과 `verify`만 제공한다. `deleteWikiLegacyBodies()`는 항상 `WIKI_ARCHIVE_DELETION_UNSUPPORTED` 오류를 낸다.

## 정리 전 계속 필요한 조건

이 구현은 redaction·DELETE·Vault 이동·운영 실행 경로를 제공하지 않는다. 실제 정리안을 다시 검토하려면 먼저 legacy reader/writer 전환, 모든 revision과 draft·과거 본문의 보존 기간·위치에 관한 사용자 결정, archive 별도 보관과 복원 검증, 운영 승인 및 별도 데이터 구조 변경이 필요하다. 부분 archive, 중복 컷오버, 잘못된 경로·참조·승인·복구는 자동 우회하지 않는다.

## ORCH 통합 계약

공용 `dashboard/local-api.ts`, lock, UI·CSS는 BUILD-F에서 수정하지 않았다. 최종 통합에서 검증·CLI용 npm script만 추가했다. ORCH가 상태를 표시한다면 `wiki_legacy_archive_run`의 `status`를 **삭제 가능 여부로 해석하지 말고** `manifest_hash`, `source_snapshot_hash`, `blocked_count`, `output_root` 및 항목별 `blockers_json`을 읽기 전용으로 제공한다. 외부 버튼이나 API에서 삭제 동작을 연결하지 않는다.

## 합성 검증

`dashboard/tests/wiki-legacy-archive.test.ts`는 OS temp에만 DB·Vault·컷오버 manifest·복구 보고서를 만들고, 정상 봉인·멱등 검증, 원본 본문/source mode 비변경, draft·과거 본문 차단, archive 변조·snapshot 변경·부분 실패, 경로 겹침·symlink, 운영 프로필·삭제 차단을 확인한다. 실제 운영 DB 또는 Vault는 열지 않았다.

`dashboard`에서 다음 명령으로 실행한다.

```powershell
npm run test:wiki-legacy-archive
npm run wiki:legacy-archive -- dry-run <OS-temp-하위-output-root>
npm run wiki:legacy-archive -- verify <기존-output-root>
```

2026-09-29 재검수 결과: 위 합성 테스트, `npm run lint`, `npm run typecheck`, `npm run test:phase1`~`test:phase4`, `npm run test:wiki-stage6`, `npm run test:wiki-cleanup01`, `npm run build`, `git diff --check` 모두 통과했다. lint에는 기존 `Inspect-MatterAssignmentEvidence.cjs`의 미사용 escape 경고 1건만 남았다. 검증은 temp 합성 DB·Vault에서 수행했으며 운영 DB·실제 Vault 접근과 삭제는 없었다.
