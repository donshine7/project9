# Wiki 원본 전환 최종 통합 핸드오프 — 2026-09-29

## 통합 범위

- BUILD-A: 현재 Markdown revision과 근거 snapshot에 결합된 원문 승인, event와 user feedback의 단일 transaction, 멱등 재시도.
- BUILD-B: 문서 승인, AI 제안 검토, 업무 상태를 분리한 Wiki 검토 UI와 승인 adapter.
- BUILD-C: SQLite 일관 사본, Vault 전체 snapshot, Git bundle, 격리 복원 리허설.
- BUILD-D: 운영 DB/Vault를 수정하지 않는 최대 5건 배치 준비도 manifest.
- DESIGN: 기존 Wiki Review 화면을 보존한 자동반영·복구·배치 상태 보드와 코드 매핑.

신규 migration은 사용하지 않았다. 020과 021은 비어 있고, 후속 BUILD-E/F를 위해 022/023 예약만 유지한다.

## 통합 결정

문서 승인 생성, 배치 준비도, cutover 검증은 `wiki-document-evidence.ts`의 단일 canonical 계산을 사용한다. event ID는 대소문자를 보존해 중복 제거·정렬하고, 열 개 event 필드 snapshot과 전체 evidence 배열을 canonical JSON SHA-256으로 계산한다. 기존 운영 승인 hash가 현재 계산과 다르면 event/feedback을 수정하거나 자동 승계하지 않는다.

`wiki-review.ts`는 byte hash만으로 문서 승인을 표시하지 않는다. 동일한 Markdown이라도 인용 event 내용이 변경돼 evidence snapshot hash가 달라지면 `evidence_stale`로 표시한다.

승인 HTTP 계약은 다음과 같다.

- `GET /api/wiki-review/documents/:docId/approvals`: 현재 revision/hash/evidence와 승인 이력을 반환한다. 검토자 서버 문맥이 없으면 자료는 읽을 수 있지만 `allowed=false`, `WIKI_DOCUMENT_APPROVAL_AUTH_REQUIRED`이다. 문서·근거 409 도메인 오류도 UI가 표시할 수 있는 `allowed=false/code/reason` 형태로 바꾼다.
- `POST /api/wiki-review/documents/:docId/approvals`: 서버 환경의 신뢰된 검토자 문맥만 사용한다. `SSPAT_AUTHENTICATED_REVIEWER=장진태`와 비어 있지 않은 `SSPAT_REVIEWER_AUTH_METHOD`가 모두 필요하다. 본문의 `docId`, `reviewer`, `actor`, `actorId`, `authenticated`, `authenticationMethod`는 거절한다. 최초 성공은 201, 동일 멱등 재시도는 200이다.

Figma `31:3`·`32:47`의 9개 상태는 자동반영·복구·배치 축이다. React `review-model.ts`의 9개 문서 표시 상태와 별개이며 한 `status`로 합치지 않는다. Code Connect는 계정 좌석과 미게시 로컬 컴포넌트 제약 때문에 문서 매핑으로 유지한다.

## 검증 결과

격리 합성 DB/Vault에서 다음을 통과했다.

- `npm ci`, lint, typecheck, build.
- Wiki Markdown, stage4~7, 운영 승인 cutover, edit01, cleanup01.
- 문서 승인 서비스와 HTTP 경계, 배치 readiness, 운영 checkpoint·복원 리허설.
- phase1~4, client response, Wiki UI 렌더링·adapter.
- 4174 격리 서버의 `/`, `/mail`, `/matters`, `/analysis`, `/wiki`, `/provisional`, `/api/projects`, `/api/matters`, `/api/work-db/status`, `/api/mail-sync`, `/api/analysis`, `/api/wiki` 응답 200.
- 인증 문맥 없는 승인 POST의 403 fail-closed.

lint에는 기존 `scripts/Inspect-MatterAssignmentEvidence.cjs`의 불필요한 escape 경고 1건이 남지만 종료 코드는 0이다. `npm ci` 결과 알려진 의존성 취약점은 11건(낮음 1, 높음 10)이며 `npm audit fix --force`는 실행하지 않았다.

## 운영 차단과 후속 순서

운영 DB와 업무 Vault에는 이번 통합에서 쓰지 않았다. 다음 조건을 해결하기 전에는 BUILD-E 운영 자동반영이나 BUILD-F 정리를 실행하지 않는다.

1. 운영 Vault Git가 현재 실행 계정에서 `dubious ownership`으로 차단된다. 저장소 소유 계정에서 소유권을 확인하고, 필요한 경우 해당 경로만 신뢰하도록 별도 승인해야 한다.
2. 기존 운영 승인 중 현재 canonical evidence hash와 불일치하는 문서는 자동 보정하지 않고 사람 재승인을 받아야 한다.
3. checkpoint 저장 위치, 쓰기 중지 작업창, 별도 복원 위치를 확정한 뒤 readiness → checkpoint → verify → isolated restore rehearsal을 모두 통과해야 한다.
4. 고정된 통합 후보 커밋을 독립 Runner와 Grader가 검증한 뒤에만 BUILD-E를 시작한다.
5. BUILD-E도 먼저 합성 환경에서 구현·평가하며, 운영 적용은 별도의 명시적 승인과 실행별 hash·경로 확인을 요구한다. BUILD-F는 그 이후이며 실제 삭제는 하지 않고 불변 archive와 fail-closed 검사를 유지한다.
