# 협업 전환 계획 — 2026-09-22

상태: v5로 개정. 단계 7 SCALE-01의 합성 확대 gate 완료, 운영 Vault·전환 schema·검토 후보가 없어 운영 Wiki 본문 원본 전환은 아직 수행하지 않았다.

전체 작업의 현재 기준은 [Wiki Markdown 원본 전체 기획](WIKI_MARKDOWN_MASTER_PLAN_2026-09-22.md)과 [이관·복구·평가 계약](WIKI_MARKDOWN_MIGRATION_AND_EVAL_2026-09-22.md)이다. 사용자 요청에 따라 기존 단방향 export 목표를 대체한다. 아래는 개정 계획의 요약이다.

## 목표

현재 저장소와 운영 DB를 유지하면서 다음 계층을 추가한다.

1. 기존 `[ORCH] 전체 설계·배분·통합` 작업을 총괄로 유지한다.
2. 구현은 기능 단위 Git worktree로 격리한다.
3. Eval Runner와 Eval Grader는 별도 프로젝트로 운영하고 실행별 새 작업을 만든다.
4. 기존 `docs`는 개발용 Obsidian Vault로 활용한다.
5. Wiki 본문의 활성 원본은 업무 Vault의 Markdown으로 두고 대시보드가 같은 파일을 읽는다. SQLite는 업무와 문서의 버전·해시·근거·검토 인덱스를 맡는다.
6. Figma는 반복되는 검토·승인·근거 UI부터 적용한다.

## 원본 구분

| 정보 | 원본 |
|---|---|
| 외부 사건 사실 | EasyPAT 정확 일치 조회와 원본 증거, 승인된 출처 정책 |
| 업무 상태·관계·Action·이력 | SQLite와 확정 이벤트 |
| 코드·스키마·프롬프트·설정 | 이 Git 저장소 |
| 승인된 개발 결정 | `docs`의 기준 문서와 ADR |
| 승인된 UI 설계 | Figma 승인 프레임과 코드 매핑 |
| 업무 Wiki 본문 | Obsidian 업무 Vault의 Markdown |
| Wiki 근거·검토·버전 인덱스 | SQLite. 이전 본문은 Vault Git/백업으로 복원 |
| 평가 정답·holdout | Grader 전용 영역. 개발 저장소와 Vault에 두지 않음 |

프로젝트·작업·Vault·worktree 분리는 그 자체로 접근 통제가 아니다. OS·샌드박스·도구 권한과 실행 경로 검사를 별도로 적용한다.

## 단계

| 단계 | 범위 | 통과 조건 |
|---|---|---|
| 0 | 진행 작업 인수인계 | 변경 소유권·미완료·검사·운영 영향 기록 |
| 1 | 기준선 보존 | 소스 체크포인트, 운영 DB 백업, 검사 결과와 제한 기록 |
| 2 | 개발 환경 격리 | worktree별 DB·사건 루트·포트·도구 경계 검사 |
| 3 | 독립 평가·Markdown 기반 | Runner/Grader 분리, 파일 읽기·색인·버전·재검색 검사 |
| 4 | 개정 제안·일회성 이관 | 합성 대상 3~5개, 사람 편집 보존, 과거 본문/근거 대조 |
| 5 | Figma 기반 UI·통합 평가 | 최신 파일·검토본·업무 상태 구별, 충돌·복구 검사 |
| 6 | 소수 문서 원본 전환·복구 | 문서별 DB 쓰기 종료, Vault+DB 사본 복원, holdout/사람 검수 |
| 7 | 범위 확대·후속 개선 | 편집 조정 후 자동 적용, 이관 완료 후 레거시 본문 축소 |

환경 격리를 구현하는 첫 worktree는 오프라인 소스 편집용으로 만들 수 있다. 실제 서버·DB·도구 실행은 경로/권한 검사 후 허용한다. worktree는 파일 체크아웃만 격리하며, 현재 DB 코드는 `SSPAT_WORK_DB_PATH` 미설정 시 운영 DB를 사용하고 DB open 시 migration을 실행한다. 업무 Vault도 개발 worktree별 합성 경로를 사용한다.

## 역할

| 역할 | 기존 작업 또는 향후 작업 | 책임 |
|---|---|---|
| 총괄 | `[ORCH] 전체 설계·배분·통합` | 범위, 공용 파일, migration 번호, 통합과 승인 |
| EasyPAT | `[BUILD] Easypat tool 구현` | 프로토콜·MCP·안전·모의 검사 |
| 대응 업무 | `[BUILD] 기획 의견제출통지서 자동 다운로드` | 통지·다운로드·대응 프로젝트·승인 |
| 명세서 업무 | `[BUILD] 한국특허명세서작성 하네스 기획` | 초기화·진행 단계·산출물 |
| Wiki 저장/인덱스 | 단계 3에서 배정 | Markdown 읽기·버전·근거·변경 감지·재검색 |
| Wiki 이관/개정 | 단계 4에서 배정 | 개정 제안·이력 이관·원본 전환·복구 |
| UX/Figma | 필요한 화면 변경 때 생성 | 승인 설계·컴포넌트·코드 매핑·검수 |
| Eval Runner | 별도 프로젝트 | 입력·후보 실행, 출력·trace 고정. 정답 열람 금지 |
| Eval Grader | 별도 프로젝트 | 독립 채점·기준선 비교·사람 검토 |

개발 역할과 런타임 역할 `mail_intake`, `matter_linker`, `action_analyst`, `risk_verifier`, `wiki_synthesizer`를 구분한다. 이 계획만으로 운영 모델·프롬프트를 변경하지 않는다.

## 공용 파일 규칙

- `dashboard/local-api.ts`, `dashboard/lib/work-db.ts`, package/lock, 공용 layout/CSS와 migration 번호는 총괄이 조정한다.
- EasyPAT, 통지, 명세서, Wiki 기능은 전용 lib/page/test에서 먼저 구현한다.
- 동일 파일을 여러 worktree가 동시에 소유하지 않는다.
- 통합은 diff 검토 → 관련 검사 → 전체 필수 검사 → Eval → 사람 승인 순서다.
- 실제 Outlook·EasyPAT 쓰기, 운영 DB migration, 운영 서버 재시작은 별도 승인을 받는다.

## Obsidian과 Figma 경계

- 개발 Vault: 기존 `docs` 폴더. 중복 문서 저장소를 만들지 않는다.
- 업무 Vault: 저장소 밖의 별도 폴더와 독립된 로컬 비공개 Git. Markdown 본문과 AI 제안을 구분한다.
- Obsidian 편집은 Wiki 원본 수정이다. 업무 상태·기한·담당자 변경은 DB 검토 절차를 따른다.
- MVP에서 AI는 개정 제안을 만들고 사람이 반영한다. 자동 적용은 외부 편집기와의 쓰기 조정·장애 복구 검증 후 추가한다.
- Figma에는 합성 사건만 사용한다. 실제 고객·메일·사건 자료를 업로드하지 않는다.
- Code Connect는 안정된 공통 컴포넌트와 플랜·권한을 확인한 뒤 선택적으로 적용한다.

## 평가 원칙

- 기존 단위·통합 검사는 결정적 계층으로 재사용한다.
- 의미 평가는 당시 입력·원본 근거·출력·trace로 채점한다.
- 실제 사건군/메일 스레드 단위로 dev와 holdout을 분리한다.
- 구현 작업은 holdout 정답을 보지 않는다.
- 치명 오류(운영 무단 쓰기, 확정값 덮어쓰기, 사건 혼동, 정답 접근)는 0건을 요구한다.
- 미실행·미검토 결과를 통과로 세지 않는다.
- Markdown/DB 원본 경계, 사람 편집 보존, 인덱스 누락 복구, 원본 전환과 DB+Vault 사본 복원을 평가한다.

## 현재 단계

단계 1의 근거와 제한은 [BASELINE_2026-09-22.md](BASELINE_2026-09-22.md)에 기록한다.

단계 2의 ENV-01·DOC-01 구현과 검사 결과는 [ENV01_DOC01_RESULT_2026-09-22.md](ENV01_DOC01_RESULT_2026-09-22.md)에 기록한다.

단계 3의 WIKI-01·EVAL-01 구현, 별도 Runner/Grader 프로젝트와 합성 평가 결과는 [STAGE3_WIKI_EVAL_RESULT_2026-09-22.md](STAGE3_WIKI_EVAL_RESULT_2026-09-22.md)에 기록한다.

단계 4의 hash 결합 AI 제안과 레거시 Wiki dry-run 결과는 [STAGE4_WIKI_PROPOSAL_MIGRATION_RESULT_2026-09-22.md](STAGE4_WIKI_PROPOSAL_MIGRATION_RESULT_2026-09-22.md)에 기록한다.

단계 5의 Figma 기반 Wiki 검토 화면과 합성 수직 흐름 39/39 결과는 [STAGE5_WIKI_UX_EVAL_RESULT_2026-09-25.md](STAGE5_WIKI_UX_EVAL_RESULT_2026-09-25.md)에 기록한다. 다음 단계는 허용된 소수 문서를 대상으로 하는 CUTOVER-01과 DB+Vault 사본 복원 RECOVERY-01이다.

단계 6의 원본 전환 도구, legacy 쓰기 차단, DB+Vault 사본 복원과 합성 EVAL-03 결과는 [STAGE6_WIKI_CUTOVER_RECOVERY_RESULT_2026-09-26.md](STAGE6_WIKI_CUTOVER_RECOVERY_RESULT_2026-09-26.md)에 기록한다. 운영 전환은 실제 대상 1~3개 문서와 편집 중지 시간, 최신 백업을 사람이 별도로 승인한 뒤 진행한다.

단계 7의 내용 hash 기반 증분 처리, 처리량·검토부담 계측과 합성 EVAL-04 결과는 [STAGE7_WIKI_SCALE_RESULT_2026-09-26.md](STAGE7_WIKI_SCALE_RESULT_2026-09-26.md)에 기록한다. 읽기 전용 운영 조사에서 업무 Vault와 필수 schema 및 검토 완료 후보가 없음을 확인했으므로 운영 파일럿은 차단 상태를 유지한다.
