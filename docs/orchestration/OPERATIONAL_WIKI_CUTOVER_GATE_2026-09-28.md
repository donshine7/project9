# 운영 Wiki 원문 승인 컷오버 게이트 — 2026-09-28

## 목적

기존 Stage 6 컷오버는 AI 개정 제안의 사람 승인과 수동 반영이 관측된 문서만 지원했다. 운영 파일럿처럼 legacy 본문을 결정적으로 변환한 뒤 사람이 **원문 그대로 승인**한 문서도 별도 승인 유형으로 검증하되, 제안 승인으로 가장하지 않고 원래 사용자 이벤트를 보존한다.

## 승인 유형

- `proposal`: 기존 `wiki_proposal` + `wiki_proposal_review` + `applied_observed` 경로
- `document`: `wiki.document_approved` 이벤트 + 연결된 `user_feedback(accept, approved_as_is)` 경로

`document` 승인은 현재 Markdown byte hash, text hash, revision ID, 인용 event 목록과 각 event 내용 hash를 승인 시점 snapshot과 다시 비교한다. 문서나 근거가 바뀌면 `WIKI_CUTOVER_REVIEW_STALE`로 차단한다.

## 운영 실행 게이트

운영 프로필에서는 요청의 `authorizationId`와 다음 환경값이 모두 정확히 일치해야 한다.

- `SSPAT_OPERATIONAL_WIKI_CUTOVER_AUTHORIZATION=CUTOVER:<authorizationId>`
- `SSPAT_OPERATIONAL_WIKI_CUTOVER_ROOT`: DB·Vault와 겹치지 않는 전용 백업·복구 루트
- `SSPAT_OPERATIONAL_WIKI_CUTOVER_DATABASE`: 실제 실행 DB의 정확한 경로
- `SSPAT_OPERATIONAL_WIKI_CUTOVER_VAULT`: 실제 실행 Vault의 정확한 경로

드라이브 루트, DB·Vault와 겹치는 경로, symlink/junction, 이미 존재하는 실행·복구 산출물은 차단한다. 한 실행은 1~5개 문서만 허용한다.

## 스키마와 복구

`019_wiki_document_approval_cutover.sql`은 다음을 수행한다.

- 컷오버 실행 프로필에 `operational`을 추가한다.
- 컷오버 항목이 기존 제안 승인 또는 문서 원문 승인 중 정확히 하나만 참조하도록 한다.
- 기존 제안 승인 컷오버 행은 그대로 보존한다.

컷오버 전에 DB와 Vault 전체 사본을 묶음에 저장하고, 원본 Markdown은 수정하지 않는다. 전환 후 별도 복구 루트에 DB+Vault를 복원하여 문서 hash, Markdown revision, 승인 이벤트, source mode와 source-change event를 다시 검증한다.

## 회귀 검증

- 기존 Stage 6 제안 승인 컷오버·복구 경로 유지
- 운영 프로필의 실행별 승인 누락 차단
- 문서 원문 승인 컷오버·복구 성공
- 승인 후 근거 event 변경 시 차단
- 기존 Stage 4~7, 자동 반영, legacy 정리 평가와 호환

운영 파일럿 실행은 코드 커밋과 격리 사본 dry-run이 완료된 뒤 별도 결과 문서에 기록한다.
