# 신규 운영 Wiki 문서 원본 등록 보완 — 2026-09-28

## 확인된 문제

레거시 Wiki 본문이 없는 사건에 새 Markdown 문서를 생성해 인덱싱하면 `wiki_document`와 revision은 만들어지지만 `wiki_document_source_mode`가 비어 있었다. 이 경우 기존 Wiki 상세 조회는 원본을 `legacy_db`로 간주하므로 유효한 Markdown이 활성 본문으로 표시되지 않을 수 있다.

## 변경

- 유효한 `entity_wiki` 문서에 원본 모드가 없고 같은 엔티티의 `entity_wiki_revision`도 없을 때만 `markdown` 원본 모드를 최초 등록한다.
- 최초 등록은 `wiki.source_mode_initialized` 이벤트와 같은 트랜잭션에 기록한다.
- 이미 원본 모드가 있거나 레거시 revision이 있는 엔티티는 변경하지 않는다.
- 원본 등록은 문서 내용 승인이 아니다. 새 문서는 기존 검토 규칙에 따라 계속 `검토 필요`로 표시된다.
- 반복 스캔은 같은 원본 모드나 이벤트를 추가하지 않는다.
- 상세 조회는 컷오버 문서의 legacy 연결뿐 아니라 신규 Markdown 문서 자체의 entity 연결도 사용한다.

## 검증

- `wiki-markdown.test.ts`: 신규 원본 모드·감사 이벤트·멱등성 통과
- `wiki-stage5.test.ts`: 검토 상태·수동 반영 흐름 회귀 통과
- `wiki-stage7.test.ts`: 증분 스캔·확대 처리 회귀 통과
- 변경 파일 `oxlint` 통과

## 운영 적용 대상

이번 보완으로 원본 모드가 필요한 신규 문서는 다음 3건이다.

- `P261250-US`
- `P261251-US`
- `P261252-US`

운영 적용 전 DB 백업을 만들고, 적용 후 세 문서만 `source_mode=markdown`인지와 SQLite 무결성·외래키를 확인한다.
