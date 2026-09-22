# 협업 전환 계획 — 2026-09-22

상태: 채택됨. 단계별 게이트를 통과한 범위만 적용한다.

## 목표

현재 저장소와 운영 DB를 유지하면서 다음 계층을 추가한다.

1. 기존 `[ORCH] 전체 설계·배분·통합` 작업을 총괄로 유지한다.
2. 구현은 기능 단위 Git worktree로 격리한다.
3. Eval Runner와 Eval Grader는 별도 프로젝트로 운영하고 실행별 새 작업을 만든다.
4. 기존 `docs`는 개발용 Obsidian Vault로 활용한다.
5. DB에 게시된 LLM Wiki는 별도 업무 Vault에 단방향으로 내보낸다.
6. Figma는 반복되는 검토·승인·근거 UI부터 적용한다.

## 원본 구분

| 정보 | 원본 |
|---|---|
| 외부 사건 사실 | EasyPAT 정확 일치 조회와 원본 증거, 승인된 출처 정책 |
| 업무 상태·관계·Action·이력 | SQLite와 확정 이벤트 |
| 코드·스키마·프롬프트·설정 | 이 Git 저장소 |
| 승인된 개발 결정 | `docs`의 기준 문서와 ADR |
| 승인된 UI 설계 | Figma 승인 프레임과 코드 매핑 |
| 업무 Wiki | DB의 게시 개정과 근거. Obsidian은 파생 열람본 |
| 평가 정답·holdout | Grader 전용 영역. 개발 저장소와 Vault에 두지 않음 |

프로젝트·작업·Vault·worktree 분리는 그 자체로 접근 통제가 아니다. OS·샌드박스·도구 권한과 실행 경로 검사를 별도로 적용한다.

## 단계

| 단계 | 범위 | 통과 조건 |
|---|---|---|
| 0 | 진행 작업 인수인계 | 변경 소유권·미완료·검사·운영 영향 기록 |
| 1 | 기준선 보존 | 소스 체크포인트, 운영 DB 백업, 검사 결과와 제한 기록 |
| 2 | 개발 환경 격리 | worktree별 DB·사건 루트·포트·도구 경계 검사 |
| 3 | 독립 평가 | Runner/Grader 분리, 재현 manifest, 결정적 검사와 의미 평가 |
| 4 | Wiki→Vault 수직 기능 | 합성 대상 3~5개 단방향 export, 멱등·충돌·근거 검사 |
| 5 | Figma 기반 UI 연동 | 정상·미확정·실패·권한·stale 상태 승인 및 구현 검수 |
| 6 | 제한 운영·확대 | 비공개 holdout과 사람 승인 통과 |

단계 2 전에는 기능 worktree를 시작하지 않는다. worktree는 파일 체크아웃만 격리하며, 현재 DB 코드는 `SSPAT_WORK_DB_PATH` 미설정 시 운영 DB를 사용하고 DB open 시 migration을 실행한다.

## 역할

| 역할 | 기존 작업 또는 향후 작업 | 책임 |
|---|---|---|
| 총괄 | `[ORCH] 전체 설계·배분·통합` | 범위, 공용 파일, migration 번호, 통합과 승인 |
| EasyPAT | `[BUILD] Easypat tool 구현` | 프로토콜·MCP·안전·모의 검사 |
| 대응 업무 | `[BUILD] 기획 의견제출통지서 자동 다운로드` | 통지·다운로드·대응 프로젝트·승인 |
| 명세서 업무 | `[BUILD] 한국특허명세서작성 하네스 기획` | 초기화·진행 단계·산출물 |
| Wiki/Vault | 단계 4에서 생성 | 결정적 export와 근거·링크·충돌 처리 |
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
- 업무 Vault: 저장소 밖의 별도 폴더. 생성 Wiki와 사람 메모를 분리한다.
- 업무 Vault MVP는 DB→Markdown 단방향이다. Vault 편집은 업무 상태를 변경하지 않는다.
- Figma에는 합성 사건만 사용한다. 실제 고객·메일·사건 자료를 업로드하지 않는다.
- Code Connect는 안정된 공통 컴포넌트와 플랜·권한을 확인한 뒤 선택적으로 적용한다.

## 평가 원칙

- 기존 단위·통합 검사는 결정적 계층으로 재사용한다.
- 의미 평가는 당시 입력·원본 근거·출력·trace로 채점한다.
- 실제 사건군/메일 스레드 단위로 dev와 holdout을 분리한다.
- 구현 작업은 holdout 정답을 보지 않는다.
- 치명 오류(운영 무단 쓰기, 확정값 덮어쓰기, 사건 혼동, 정답 접근)는 0건을 요구한다.
- 미실행·미검토 결과를 통과로 세지 않는다.

## 현재 단계

단계 1의 근거와 제한은 [BASELINE_2026-09-22.md](BASELINE_2026-09-22.md)에 기록한다.
