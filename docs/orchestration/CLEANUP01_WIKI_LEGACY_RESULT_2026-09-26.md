# CLEANUP-01 레거시 본문 축소 준비 게이트 — 2026-09-26

상태: **불변 archive·삭제 적격성·blocker 합성 검증 완료, 실제 본문 redaction/삭제 미실행**.

## 구현

- 모든 `entity_wiki_revision.sections_json`과 `wiki_draft.sections_json`을 행별 JSON archive로 먼저 고정한다.
- 원본 body hash와 archive hash를 manifest 및 SQLite cleanup 원장에 기록한다.
- revision이 삭제 후보가 되려면 같은 entity의 유효한 Markdown 문서, `source_mode=markdown`, 성공한 cutover와 성공한 recovery rehearsal이 모두 필요하다.
- 미전환 revision, 누락/잘못된 Markdown, 복구 리허설이 없는 revision은 blocker로 남긴다.
- pending/rejected를 포함한 모든 legacy draft는 보존·해결 정책이 확정될 때까지 차단한다.
- dry-run은 legacy DB 본문과 활성 Markdown을 수정하지 않으며 기존 출력 폴더를 덮어쓰지 않는다.
- 운영 프로필 실행은 차단한다.

구현 파일:

- `dashboard/db/migrations/018_wiki_legacy_cleanup.sql`
- `dashboard/lib/wiki-cleanup.ts`
- `dashboard/scripts/wiki-cleanup-cli.ts`
- `dashboard/tests/wiki-cleanup01.test.ts`

## 합성 결과

- 성공한 cutover와 recovery가 연결된 revision 1개는 `eligible`로 분류했다.
- 미전환 revision 1개는 `markdown_document_missing` blocker로 분류했다.
- pending draft 1개는 `draft_retention_or_resolution_required`로 차단했다.
- ready 계획과 blocked 계획 모두에서 모든 본문 archive를 생성했고 DB 본문은 그대로 보존했다.
- 동일 출력 재실행은 manifest hash가 일치할 때만 멱등 처리했다.

## EVAL-06

- Runner는 ready 1건과 blocked revision/draft를 포함한 계획을 별도 DB·archive에 고정한다.
- Grader는 clean commit, DB·ready/blocked archive·결과 hash, cleanup 원장 수, 본문 비변경, 운영 DB 불변을 검사한다.
- 최종 clean commit 결과는 구현 커밋 후 기록한다.

## 실제 정리 전 남은 조건

1. 실제 업무 Vault와 운영 Markdown 문서가 존재해야 한다.
2. 모든 대상 문서의 운영 cutover와 사본 복구 리허설이 성공해야 한다.
3. legacy writer/reader 소비자가 모두 새 계약으로 전환되어야 한다.
4. draft와 감사 이력의 보존기간·보존 위치를 사용자가 승인해야 한다.
5. 별도 migration으로 nullable/redacted 구조를 설계하고 운영 백업에서 복원 검증해야 한다.

현재 조건에서는 실제 삭제가 안전하지 않으므로 코드가 삭제 기능을 제공하지 않는 것이 의도된 결과다.
