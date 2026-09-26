# 전체 작업 기획 v2 — SQLite 업무 원본 · Obsidian Markdown Wiki 원본

작성: 2026-09-22. 사용자 지정 방향을 반영한 목표 설계. 본문 저장 방식의 실제 전환은 아직 시행하지 않았다.

## 1. 이번 결정과 기존 계획의 변경

핵심 결정은 **SQLite는 업무 운영 원본, Obsidian Markdown은 Wiki 본문 원본**이다. 기존 전환 계획의 DB→Vault 단방향 export를 최종 구조로 삼는 부분을 이 문서로 대체한다.

현재 구현은 `dashboard/lib/wiki.ts`에서 `entity_wiki_revision.sections_json`과 `wiki_draft.sections_json`을 사용한다. 목표 구조는 Wiki 문서를 Vault에서 직접 편집·읽고, SQLite가 문서 식별·버전·근거·검토 상태를 추적하는 방식이다.

인용된 ORCH 결론은 이번 사용자 메시지를 근거로 반영했다. ORCH 조회에서는 최근 작업 상태만 반환되어 대화 전문까지 검증한 것으로 표시하지 않는다.

이전에 완료한 1단계는 유효하다.

- 기준선 commit: `3cf5b0173922d8665638a3ba2ea2835fe7cafce1`
- 태그: `baseline-worktree-transition-2026-09-22`
- 소스·DB 백업과 당시 검사: `BASELINE_2026-09-22.md`
- 보류된 Fiddler 파일 4개, Dashboard 의존성 취약점 11개는 별도 미완료 항목이다.

이번에는 기획 문서만 갱신한다. 1단계 기록을 소급 변경하거나 `sections_json`을 바로 삭제하지 않는다.

## 2. 원본의 경계

| 데이터 | 유일한 활성 원본 | 다른 위치의 취급 |
|---|---|---|
| 사건 식별·업무 상태·기한·담당자·Action·관계 | SQLite와 확정 이벤트 | Wiki에서 참조하거나 기준 시점이 있는 서술로 설명 |
| Wiki 설명·분석·타임라인 서술·검토 의견 | 업무 Vault의 Markdown | 대시보드는 같은 파일을 읽어 렌더링 |
| 업무 판단의 근거 | 원본 메일·첨부·EasyPAT 관측과 기존 이벤트 | Wiki에는 근거 ID/링크·필요한 인용을 기록 |
| 문서 ID↔경로·관측 해시·검토 결과·버전 관계 | SQLite Wiki 인덱스 | Markdown에 붙인 승인 문구를 권한 근거로 사용하지 않음 |
| 검색 인덱스·요약 캐시 | 재생성 가능한 파생물 | 파일과 버전·hash가 일치할 때만 사용 |
| 과거 Wiki 본문 | 업무 Vault 전용 Git 이력과 백업 | 이전 버전 복원·감사 용도; 활성 본문을 별도로 편집하지 않음 |
| 코드·스키마·프롬프트·설정·개발 ADR | 기존 소스 Git | 기능 worktree에서 변경 후 통합 |
| UI 설계 | Figma 승인 프레임/컴포넌트 | Git에는 node/버전·코드 대응과 검수 결과 |
| 평가 정답·비공개 holdout | Grader 전용 영역 | 개발/업무 Vault·소스 Git·Runner에 제공하지 않음 |

Wiki의 자연어에 업무 사실이 언급되는 것까지 금지하는 설계는 아니다. 해당 문장은 기준 시점과 근거를 가진 서술이며, 최신 운영 상태를 바꾸는 권한은 갖지 않는다. 대시보드의 '현재 업무 상태' 카드에는 항상 DB 값을 사용한다.

예: Markdown의 '의견서 제출 완료' 문장을 수정해도 DB의 제출 여부·승인·Action은 바뀌지 않는다. 실제 반영이 필요하면 별도 상태 변경 요청을 검토하고 DB 이벤트를 만든다.

## 3. 목표 구조와 사용 경험

```text
원본 증거 ─→ 기존 분석·검증 ─→ SQLite 업무/근거 이벤트
                                    │
                                    ├─→ 대시보드 현재 업무 상태
                                    └─→ Wiki 작성에 필요한 증거 묶음

사람(Obsidian) ─→ Markdown Wiki 원본 ←─ 승인된 Wiki 개정 적용
                        │                        ↑
                        ├─→ 대시보드 Wiki 보기    AI 개정 제안
                        ├─→ 검색·링크·근거 검사
                        └─→ SQLite 버전/해시/검토 인덱스
```

사람은 Obsidian에서 문서와 연결된 근거를 읽고 본문을 수정한다. 대시보드는 사건별 최신 업무 상태, Wiki 본문, 근거, 최신 편집과 검토 버전을 함께 보여준다. AI는 관련 DB 증거와 현재 Markdown을 받아 수정 제안을 만든다.

문서의 세 가지 상태를 구분한다.

- 파일 최신본: 실제로 저장된 Markdown. 수정은 즉시 문서 원본에 반영된다.
- 검토 완료본: 특정 content hash에 결합된 검토 결과. 추가 편집하면 그대로 승계되지 않는다.
- 업무 확정값: DB의 상태·기한·담당자. 문서 검토와 별도 절차다.

기본 Wiki 화면에서 최신본의 검토 상태를 표시하고 마지막 검토본 비교를 제공한다. 고위험 자동 판단은 검토되지 않은 수정본을 확정 사실로 사용하지 않는다. 근거가 바뀌면 본문이 같아도 '근거 변경으로 재검토 필요'를 표시한다.

## 4. 폴더와 프로젝트

기존 소스 및 사건 폴더 경로를 유지한다. 아래 신규 영역은 구축 단계에서 생성한다.

```text
C:\ChatGPT\AI-Work\20_업무자동화\
├─ 상상업무자동화\                 기존 Codex 개발 프로젝트/소스 Git
│  ├─ AGENTS.md
│  ├─ dashboard\                   DB·Wiki API·웹 화면
│  ├─ easypat-automation\
│  ├─ config\                      업무·Wiki 계약/환경 설정
│  ├─ docs\                        개발 Obsidian Vault
│  │  ├─ orchestration\            전체 계획·계약·인수인계
│  │  ├─ adr\                      결정 이유·대체 이력
│  │  └─ design\                   Figma node·코드·승인 매핑
│  └─ eval\                        공개 검사 계약·합성 smoke
├─ 상상업무자동화_Wiki\             업무 Vault/독립된 로컬 비공개 Git
│  ├─ AGENTS.md
│  ├─ 00_Home\                     문서 탐색·운영 화면 링크
│  ├─ 10_Matters\                  사건 Wiki 원본 Markdown
│  ├─ 20_Organizations\            회사 Wiki 원본
│  ├─ 30_People\                   사람 Wiki 원본
│  ├─ 40_Groups\                   그룹 Wiki 원본
│  ├─ 50_Knowledge\                노하우·주제별 설명 문서
│  ├─ 60_Notes\                    자유 노트, 업무 사실 검토 대상과 구별
│  ├─ 80_Proposals\                AI 개정안·patch, 활성 본문과 구별
│  ├─ 90_Archive\                  보관된 문서, 삭제 전파 없음
│  ├─ .obsidian\                   로컬 UI 설정
│  └─ .git\                        본문 과거 버전 보존
├─ 상상업무자동화_EvalRunner\       별도 프로젝트
│  ├─ AGENTS.md
│  ├─ contracts\
│  └─ runs\<run_id>\               입력·합성 DB/Vault·후보·출력·trace
└─ 상상업무자동화_EvalGrader\       별도 프로젝트/권한 영역
   ├─ AGENTS.md
   ├─ datasets\                    기대값·비공개 holdout
   ├─ rubrics\
   ├─ graders\
   ├─ baselines\
   └─ runs\<run_id>\               입력·출력·정답 채점·보고
```

개발 Vault와 업무 Vault는 중첩하지 않는다. 소스 worktree에는 합성 업무 Vault만 둔다. 운영 업무 Vault를 symlink/junction으로 붙이거나 모든 개발 작업에 같은 쓰기 경로를 주지 않는다.

기본 Codex 프로젝트 구성은 기존 개발 프로젝트, Eval Runner, Eval Grader다. 업무 Vault를 별도 문서 편집 프로젝트로 등록할지는 활용 필요에 따라 결정하며 필수 프로젝트로 늘리지 않는다. 실제 사건은 기존 `10_특허` 아래 각 사건 프로젝트를 유지하고 문서/대시보드에서 ID로 연결한다.

## 5. Markdown 계약

`doc_id`를 불변 식별자로 사용한다. 파일명·제목·회사명이 바뀌어도 동일 문서로 인식한다. 사건의 전체 당소관리번호는 표시·참조 필드에 보존한다. 디렉터리 이동은 동일 doc_id의 경로 변경으로 기록하고, 같은 ID가 두 파일에 있으면 자동 병합하지 않는다.

예시 frontmatter와 본문:

```markdown
---
schema_version: wiki-md-v1
doc_id: wiki-synthetic-001
entity_type: matter
entity_id: synthetic-matter-001
title: SAMPLE-CN(PA) 사건 검토
---

# 사건 검토

2026-09-22 수신 메일에서 의견서 초안을 요청했다.[^ev-001]

## 검토 의견

추가 자료 확인 후 대응 방향을 정한다.

[^ev-001]: event:synthetic-event-001 / source:synthetic-mail-001
```

- doc_id와 entity 연결은 인덱스에서 검증한다. Markdown 수정만으로 연결 대상을 변경할 수 없게 한다.
- 중요한 사실 문장/구획에는 안정된 근거 참조를 둔다. 위치 index만 저장하면 문장 삽입 시 어긋나므로 block ID 또는 구획 ID + 텍스트 hash를 사용한다.
- 일반 지식/자유 노트에 억지로 사건 이벤트를 요구하지 않는다. 출처 종류와 검토 기준을 문서 종류별로 정한다.
- content_hash는 DB 또는 별도 manifest에 둔다. 파일이 자기 전체 hash를 포함하는 순환 구조를 만들지 않는다.
- `approved: true`, `author: 장진태` 같은 수동 텍스트는 승인/인증 증거가 아니다. 승인자·승인 시각·승인한 hash는 인증된 검토 이벤트로 기록한다.
- Markdown의 링크는 탐색 정보다. DB의 회사·사람·사건 관계를 자동 생성하지 않는다.
- 렌더링에서 실행 가능한 HTML/스크립트와 임의 파일 접근을 허용하지 않는다. 파일명·링크·frontmatter 파싱 오류는 본문을 삭제하지 않고 검사 결과로 표시한다.

## 6. SQLite Wiki 테이블 재설계

현재 `004_entity_wiki.sql`에는 본문 필수 컬럼과 `run_id NOT NULL` 제약이 있다. 사람이 직접 수정하는 Markdown은 LLM run이 없을 수 있으므로 본문 제거 외에도 출처·편집자·검토 모델을 바꿔야 한다.

목표 책임은 다음과 같다. 정확한 DDL과 migration 번호는 계약 티켓에서 정하고 이미 적용된 migration은 수정하지 않는다.

| 테이블/영역 | 목표 |
|---|---|
| `wiki_document` (추가 후보) | doc_id, entity, 경로, 관측 hash, 최신 revision, 삭제/경로/파싱 상태 |
| `entity_wiki_revision` | revision ID, parent, content hash, Vault commit/blob 참조, 근거 snapshot, 변경 요약, origin/actor, 선택적 run_id |
| `wiki_revision_evidence` (추가 후보) | revision/block ID, 문장 hash, event/source ID, 검증 결과 |
| `wiki_review` (추가 후보) | 검토자·시각·판정·대상 hash/근거 버전. 과거 판정 유지 |
| `wiki_draft` | 제안 경로/hash, base 문서 hash, DB 근거 버전, run_id, 검토 상태 |
| 게시/이관 operation 원장 | operation_id, 이전/목표 hash, 진행 상태, 실패·재시도 결과 |

`wiki_entry`와 decision/event는 원자적 관찰·판단 근거로 남긴다. 그 내용이 Wiki 문장과 유사하더라도 역할은 근거 원장이며 활성 Wiki 편집 저장소가 아니다. 기존 입력 스냅샷·LLM 출력·검토 기록도 감사 목적의 동결 자료다. 기존 감사 이력을 일괄 삭제해서 '한 번 저장'을 맞추지 않는다.

향후 실행 패킷은 가능하면 Vault revision/해시로 본문을 참조한다. 재현을 위해 보존한 입력 사본은 감사용임을 명시한다. 검색 인덱스에 텍스트가 들어가더라도 재생성 가능하고 편집할 수 없는 파생물로 한정한다.

## 7. 편집·AI 개정·파일과 DB의 일관성

사람 편집의 기본 흐름은 Obsidian 저장 → 파일 안정화 확인 → 구문/ID/경로 검사 → 버전 보존 → hash/근거 인덱스 갱신이다. 감시 이벤트만 믿지 않고 시작 시·주기적 재검색으로 누락을 복구한다. 각 키 입력 전체를 보존한다고 약속하지 않고 관측한 저장 버전 단위로 기록한다.

AI 개정은 현재 Markdown hash와 DB 근거 snapshot을 함께 고정하고 문서 전체 교체 대신 범위가 명확한 patch를 제안한다. 검토 시 문서나 근거가 바뀌었으면 오래된 제안을 적용하지 않는다.

MVP에서는 AI가 `80_Proposals`에 제안을 쓰고 사람이 Obsidian에서 반영한다. 사람과 AI가 활성 본문을 동시에 덮어쓰는 상황을 먼저 피한다. 자동 반영은 다음 조건을 충족한 후 추가한다.

- 편집 중지/쓰기 조정을 실제로 지키는 편집 세션 또는 Obsidian 연동을 구축한다.
- 승인한 정확한 base/target hash, 적용 operation ID, 이전 본문 버전을 보존한다.
- 파일 교체와 SQLite transaction은 하나의 원자적 transaction이 아니므로, 진행 원장으로 장애 후 재조정한다.
- 파일만 바뀐 경우, DB만 준비된 경우, 다른 편집이 들어온 경우를 구분해 다시 인덱싱하거나 충돌로 남긴다. 오류 시 임의로 사람 수정본을 rollback하지 않는다.

일반 파일에 대한 'hash 확인 후 rename'만으로는 외부 편집기와의 경쟁을 완전히 차단할 수 없다. 에이전트끼리만 지키는 lock을 Obsidian도 준수한다고 가정하지 않는다. 조정 장치가 없는 동안은 제안 방식이 기본이다.

구체적인 migration·장애 복구·평가 인수 조건은 `WIKI_MARKDOWN_MIGRATION_AND_EVAL_2026-09-22.md`를 따른다.

## 8. 작업 분업과 Git worktree

개발 총괄은 기존 `[ORCH] 전체 설계·배분·통합`을 유지한다. 아래 새 역할은 실행 승인 시 작업으로 만들며 이번 기획에서 생성하지 않는다.

| 역할 | 책임/산출물 | 파일 경계 |
|---|---|---|
| 총괄/통합 | 계약·ADR·우선순위·migration 번호·통합·운영 전환 승인 | work-db, local-api, package/lock, 공용 CSS·설정 조정 |
| 환경 격리 | DB/Vault/사건/도구/포트 guard와 모의 환경 | 전용 환경 모듈·launch·환경 tests |
| Wiki 저장·인덱스 | Markdown 저장 계약, 변경 감지, 근거/버전 인덱스 | 전용 Wiki repository/index 모듈·tests |
| Wiki 이관 | 기존 본문/이력 변환·검증·전환·복구 | 전용 migration 도구·fixture·이관 보고 |
| UX/Figma | Wiki 보기·검토·충돌 UI 승인과 구현 | Wiki page/components, design mapping |
| Eval Runner | 고정 후보·입력·DB/Vault fixture 실행 | 실행별 허용 디렉터리, 정답 접근 없음 |
| Eval Grader | 결정적·의미·복구 평가, 사람 검토 | 정답·rubric·보고, 구현 수정 없음 |
| 기존 EasyPAT/대응/명세서 | 기존 기능 유지·후속 개선, Wiki는 문서 API로 연결 | 기존 기능 전용 모듈, Wiki 본문 저장 직접 조작 금지 |

한 기능 작업에 한 worktree를 배정하고 초기에는 구현 2개를 병렬로 운영한다. 역할 수만큼 동시에 켜 두지 않는다. 환경 격리 전용 첫 checkout은 오프라인 소스 편집용으로 만들 수 있지만 DB/서버/운영 도구 실행은 환경 검사 후에만 허용한다. 이전 '단계 2 전 worktree 생성 금지'는 환경 격리를 구현하는 첫 checkout까지 막는 순환 조건으로 해석하지 않는다.

소스 worktree의 기본 출발점은 보존한 기준선과 승인된 기획 변경이다. 운영 Vault는 별도 로컬 Git 이력을 가지며 소스 브랜치 병합과 별개로 관리한다. 개발 테스트 Vault의 Git도 각 workspace/run 안에서 독립 생성한다.

각 작업 인수인계에는 작업 ID, base commit, 허용 파일, API/schema 버전, 테스트 결과, 미완료, DB/Vault 쓰기 여부를 기록한다. 문서·코드·운영 DB의 현재 상태는 작업 대화의 기억만으로 판단하지 않는다.

## 9. 전체 진행 순서와 티켓

| 단계 | 티켓 | 구체 작업 | 완료 기준 |
|---|---|---|---|
| 1 완료 | BASELINE | 기존 성과와 DB 보존 | commit/tag·백업·검사 기록 유지 |
| 2 완료 | ENV-01 | 환경 경로 계약·fail-closed guard·도구 프로필 | `ENV01_DOC01_RESULT_2026-09-22.md`의 자동·smoke 검사 통과 |
| 2 완료 | DOC-01 | v2 문서/근거/검토/이관 계약 확정 | `config/wiki-document.schema.json`과 v1 계약으로 고정 |
| 3 완료 | EVAL-01 | Runner/Grader 구성, 기존 검사+Wiki fixture | 별도 프로젝트에서 한 run의 코드·DB·Vault·출력 snapshot 고정, 16/16 결정적 채점 통과 |
| 3 완료 | WIKI-01 | Markdown 읽기·인덱스·버전 보존·재검색 | 사람 편집·이동·누락·복구·symlink 차단을 합성 데이터로 검증 |
| 4 완료 | WIKI-02 | AI 개정 제안과 근거 검사 | base/evidence hash 결합, 사람 수정 유지, stale 제안 차단, 수동 반영 관측 |
| 4 완료 | MIG-01 | DB Wiki→Markdown 일회성 변환·dry-run | 게시 이력/초안 분리, 원본·출력 hash 대조, 동일 출력 재실행 멱등성 |
| 5 완료 | UX-01 | Figma 승인 → 대시보드 Markdown 보기/검토 | 원본·최신본·검토본·DB 상태·충돌 의미 일치 |
| 5 완료 | EVAL-02 | 작은 수직 기능 통합 평가 | 합성 대상 4개에 편집→인덱스→제안→검토→수동 반영 완주, 39/39 통과 |
| 6 합성 게이트 완료 | CUTOVER-01 | 허용된 소수 문서부터 원본 전환 | 합성 4문서에서 DB 본문 쓰기 차단·조용한 fallback 없음 검증, 운영 대상 미전환 |
| 6 합성 게이트 완료 | RECOVERY-01 | DB+Vault 일관 백업·사본 복원 리허설 | 합성 4문서의 본문·review·event 연결과 hash 사본 복원 확인, 운영 리허설 미실행 |
| 7 | SCALE-01 | 운영 범위 확대·기존 기능 통합 | 증분 갱신·처리량·비용·검토 부담 목표 충족 |
| 후속 | EDIT-01 | 검토된 AI 변경 자동 반영 | 사람/AI 쓰기 조정과 crash/경쟁 테스트 통과 |
| 후속 | CLEANUP-01 | 레거시 본문 저장 축소 | 소비자 전환·이관·복구 확인 후 승인된 보존 정책 적용 |

단계 3 결과는 [STAGE3_WIKI_EVAL_RESULT_2026-09-22.md](STAGE3_WIKI_EVAL_RESULT_2026-09-22.md), 단계 4 결과는 [STAGE4_WIKI_PROPOSAL_MIGRATION_RESULT_2026-09-22.md](STAGE4_WIKI_PROPOSAL_MIGRATION_RESULT_2026-09-22.md), 단계 5 결과는 [STAGE5_WIKI_UX_EVAL_RESULT_2026-09-25.md](STAGE5_WIKI_UX_EVAL_RESULT_2026-09-25.md), 단계 6 합성 gate 결과는 [STAGE6_WIKI_CUTOVER_RECOVERY_RESULT_2026-09-26.md](STAGE6_WIKI_CUTOVER_RECOVERY_RESULT_2026-09-26.md)에 기록했다. 다음은 사용자가 허용한 실제 1~3개 문서의 대상 확정과 운영 사본 복원 리허설이며, 그 전에는 운영 원본을 전환하지 않는다.

기존 업무 개선은 다음 묶음으로 병행 관리한다.

- EasyPAT: 보류된 진단 스크립트 4개 정리·모의 검사, 업로드 readback/교차검증은 실제 실행 범위를 따로 확정.
- 대응/명세서: 승인·산출물·단계 추적 회귀 유지, 문서 연결을 새 Wiki API 계약으로 전환.
- 메일/Action: 현재 본문과 인용 분리, 사건별 귀속, 사용자 확정 범위 보호 개선안을 dev 평가 후 적용.
- 의존성: 기준선에서 보고된 취약점 11개의 영향과 호환성을 별도 조사. Wiki 작업에 일괄 업그레이드를 섞지 않음.

## 10. Figma의 활용

대상은 Wiki 편집·검토 흐름과 기존 대시보드의 연결이다. 먼저 다음 상태를 설계한다: 최신 문서, 검토 안 된 편집, 검토 완료, 근거 오래됨, 문서 없음, 중복 ID, 편집 충돌, 인덱스 복구 중.

대시보드 구성 제안:

- 사건의 현재 상태·기한·담당자는 DB 카드.
- Wiki 탭은 Markdown 본문과 마지막 저장/검토 시각.
- 근거 패널은 문장별 event/source 연결과 유효성.
- 개정 비교는 정확한 두 hash의 diff와 AI 제안 여부.
- '문서 검토'와 '업무 상태 변경'은 다른 동작·문구로 표시.
- 'Obsidian에서 열기'는 확인된 vault/doc 경로를 사용.

승인된 Figma file/node/버전과 실제 React component·상태 대응을 `docs/design`에 기록한다. 초기에 기존 컴포넌트를 재사용하고 Code Connect는 플랜·권한과 컴포넌트 안정성을 확인한 뒤 도입한다. Figma 자료에는 합성 사건을 사용한다.

## 11. 사람이 수행하는 순서

1. 총괄 작업에서 다음 범위를 ENV-01/DOC-01로 배정하고 작업별 완료 조건을 확인한다.
2. 합성 DB/Vault에서 Wiki를 수정해 대시보드 반영·검토 상태·근거 링크를 확인한다.
3. Runner 실행마다 새 작업, 동일 run_id의 Grader 새 작업으로 평가한다. 평가자가 수정 코드를 작성하지 않는다.
4. 사람은 치명 실패·판정 불일치와 Figma 승인 화면을 검수한다.
5. 이관 dry-run 보고에서 대상·누락·변환 차이·충돌을 확인한 후 소수 문서의 원본 전환을 결정한다.
6. 일상 운영에서는 설명 문서를 Obsidian에서, 기한/담당/Action은 대시보드에서 관리한다. AI는 근거가 있는 개정안을 제시한다.

## 12. 효율 기준과 이번 문서의 범위

DB 변경마다 전체 Wiki를 재작성하지 않는다. 영향을 받은 근거/문서만 재검토 대상으로 올리고 내용 개정은 필요할 때 수행한다. 파일 감지·파싱·링크·hash 검사는 코드로, 설명과 의미 검토는 LLM으로 처리한다. 정확한 doc/entity 검색부터 시작하고 검색 실패·규모 지표가 확인될 때 RAG를 추가한다.

측정 항목은 근거 오류, 사람 수정 손실, 문서/인덱스 불일치, 문서 반영 지연, 제안 수락/수정률, 문서당 LLM 비용·검토 시간이다. 숫자 목표는 합성 평가와 초기 기준선을 측정한 뒤 고정한다.

현재 기획의 완료는 문서 구조·작업 계약·이관·평가·복구 계획의 정합성이다. 운영 코드/DB/실제 Wiki 전환 완료를 뜻하지 않는다.

## 참고

- [Obsidian 데이터 저장](https://obsidian.md/help/Files+and+folders/How+Obsidian+stores+data): 로컬 Markdown 및 별도 Vault 특성을 사용한다.
- [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees): 코드 체크아웃 격리를 활용하며 DB/Vault/도구 격리를 별도로 구현한다.
- [OpenAI 평가 지침](https://developers.openai.com/api/docs/guides/evaluation-best-practices): 작업별 평가와 사람 채점 보정을 적용한다.
- [Figma Code Connect](https://developers.figma.com/docs/code-connect/): 선택적 설계/코드 대응 기능이다.
