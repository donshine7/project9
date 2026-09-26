# EDIT-01 검토된 AI 변경 자동 반영 합성 게이트 — 2026-09-26

상태: **별도 승인·충돌 차단·중단 복구 합성 검증 완료, 운영 자동 반영 차단 유지**.

## 구현

- 기존 `accept_for_manual_apply`를 자동 적용 권한으로 재사용하지 않는다.
- 인증된 검토자 `장진태`가 현재 base/target/evidence hash에 다시 결합한 `wiki_auto_apply_approval`을 별도로 만든다.
- 적용 전에 활성 파일과 제안 파일의 doc_id 및 hash를 확인한다.
- 활성 문서와 같은 디렉터리에 exclusive 임시파일을 쓰고 flush한 뒤, base hash를 한 번 더 확인하고 교체한다.
- 적용 상태를 `prepared → file_applied → indexed → succeeded`로 기록한다.
- 파일 교체 후 프로세스가 중단되면 target hash를 확인해 재작성 없이 재색인·마무리한다.
- 사람이 동시에 저장해 base hash가 바뀌면 `conflict`로 남기고 사람 파일을 보존한다.
- 자동 적용 revision은 `ai_applied`, 이벤트는 `wiki.proposal_auto_applied`로 구분한다.
- 동일 제안의 재실행은 멱등 처리한다.

구현 파일:

- `dashboard/db/migrations/017_wiki_auto_apply.sql`
- `dashboard/lib/wiki-auto-apply.ts`
- `dashboard/scripts/wiki-auto-apply-cli.ts`
- `dashboard/tests/wiki-edit01.test.ts`

## 안전 경계

- fault와 경쟁 편집 hook은 `test/eval`에서만 허용한다.
- 운영 프로필은 `WIKI_AUTO_APPLY_OPERATIONAL_BLOCKED`로 차단한다.
- 임시 lock 파일만으로 Obsidian이 협조한다고 가정하지 않는다. 운영 활성화에는 편집 중지/조정 방식과 실제 운영 리허설 승인이 필요하다.
- 충돌 또는 알 수 없는 현재 hash는 자동 rollback하지 않고 수동 복구 대상으로 남긴다.

## EVAL-05

- Runner는 사람 경쟁 편집을 주입해 충돌 차단과 사람 본문 보존을 확인한다.
- 별도 제안은 파일 적용 직후 중단을 주입하고 operation 원장에서 복구한다.
- Grader는 clean commit, DB/Vault/결과 hash, 승인 2건, 충돌 1건, 성공 1건, `ai_applied` revision 1건, 운영 DB 불변을 검사한다.
- 최종 clean commit 결과는 구현 커밋 후 기록한다.

따라서 자동 반영의 결정적 복구 구조는 준비됐지만 실제 업무 Vault가 없고 운영 편집 조정도 승인되지 않았으므로 운영 자동 반영은 아직 켜지 않는다.
