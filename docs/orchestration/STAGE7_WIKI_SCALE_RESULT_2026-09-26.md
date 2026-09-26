# 단계 7 SCALE-01 합성 확대 결과 — 2026-09-26

상태: **증분 처리·처리량·검토부담 계측 구현 완료, 운영 파일럿 차단 요인 확인**. 실제 업무 DB와 Vault에는 쓰지 않았고 실제 사건 문서도 전환하지 않았다.

## 구현

- 전체 활성 디렉터리 목록은 매번 조사해 삭제·이동·중복을 놓치지 않는다.
- 파일 byte hash가 기존 인덱스와 같으면 YAML 파싱, history object 쓰기, Git 메타데이터 조회와 revision 생성을 생략한다.
- 스캔마다 전체·변경·재사용 문서 수와 elapsed time을 기록한다.
- `wiki_scale_run`에 문서 유효성, 이슈, Markdown/legacy 원본 수, 검토 대기, stale 제안, 시간 임계값과 blocker를 기록한다.
- 운영 준비도 조사는 SQLite를 read-only로 열고 본문 없이 스키마와 집계만 확인한다.

구현 파일:

- `dashboard/db/migrations/016_wiki_scale_metrics.sql`
- `dashboard/lib/wiki-scale.ts`
- `dashboard/lib/wiki-markdown.ts`
- `dashboard/scripts/wiki-scale-cli.ts`
- `dashboard/tests/wiki-stage7.test.ts`

## 합성 확대

- 합성 Markdown 40개를 최초 전체 처리했다.
- 무변경 재검색에서 40개를 모두 재사용하고 revision을 추가하지 않았다.
- 5개 수정 후 5개만 새 revision으로 기록하고 35개를 재사용했다.
- 마지막 준비도 평가에서 40개를 재사용했고 blocker 없이 통과했다.
- 최종 revision 수는 최초 40개와 변경 5개를 합한 45개다.

## 운영 준비도 읽기 전용 조사

2026-09-26 조사 결과:

- 운영 SQLite 파일은 존재한다.
- 계획한 업무 Wiki Vault `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_Wiki`는 존재하지 않는다.
- 운영 DB에는 아직 Markdown 전환 필수 스키마가 모두 적용되지 않았다.
- 따라서 인덱싱된 업무 Wiki 문서와 사람 검토가 끝난 컷오버 후보는 0개다.

운영 파일럿을 진행하려면 Vault 생성 위치·초기 문서·운영 DB migration·백업/편집 중지 시간을 별도로 확정해야 한다. 빈 Vault나 실제 사건 문서를 임의로 만들지 않았고 운영 차단도 해제하지 않았다.

## EVAL-04

- Runner는 별도 실행 루트에서 40문서 전체 → 무변경 → 5문서 변경 → 준비도 평가를 수행한다.
- Grader는 후보 clean 상태, DB/Vault/결과 hash, 스캔별 changed/unchanged 수, revision 45개, 운영 DB hash 불변을 독립 확인한다.
- 최종 clean commit 평가 결과는 구현 커밋 후 이 문서에 기록한다.

## 남은 범위

- 운영 파일럿은 현재 환경의 네 가지 blocker 때문에 미실행이다.
- `EDIT-01` 자동 적용은 별도 worktree에서 operation 원장·충돌·중단 복구를 합성 검증한다.
- `CLEANUP-01`은 legacy 소비자 조사와 삭제 없는 dry-run gate부터 구현한다.
