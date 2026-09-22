# Wiki 원본 전환 — 이관·복구·Eval 실행 계약 v2

대상 기획: `WIKI_MARKDOWN_MASTER_PLAN_2026-09-22.md`. 아래는 구현 계약이며 실행 결과가 아니다.

## 1. 현재 코드에서 변경해야 하는 지점

| 현재 구현 | 목표 변경 |
|---|---|
| `wiki.ts` snapshot의 DB previous revision 본문 | Vault의 문서 hash/revision과 DB 근거 snapshot을 함께 읽기 |
| `wikiDetail`의 `sections_json` 파싱 | Markdown repository를 통해 실제 파일 읽기, DB 검토/근거 인덱스 결합 |
| `prepareWiki` 입력 동결 | doc_id, 현재 bytes hash, Vault revision, DB entity/evidence 버전 포함 |
| `ingestWiki`의 본문 draft 저장 | 제안 Markdown/patch artifact와 base/target hash, 문장별 근거를 기록 |
| `reviewWiki`의 DB 본문 INSERT | 정확한 문서/근거 hash에 검토를 연결하고 적용 결과를 추적 |
| `run_id NOT NULL`, `sections_json NOT NULL` | 인간 편집 origin과 선택적 run_id, 본문 참조 방식 지원 |
| legacy `wiki_revision` | 역사적 자료로 보존, 신규 활성 본문 쓰기 경로에서 제외 |
| phase4와 Wiki 계약/CLI/웹 | 파일 오류·근거 변경·사람 편집·migration/복구 평가로 확장 |

새 module·테이블·명령 이름은 구현 시 계약에 맞춰 확정한다. 기존 DB에는 문서를 읽는 과정에서 migrate가 실행되는 경로가 있으므로, 이관 조사에서 현재 앱 API를 '읽기 전용'이라 가정하지 않는다.

## 2. 순차 이관

### A. 목록 조사와 백업

- 전환 직전 현재 소스 commit, DB schema/version, 최신 DB 백업을 다시 확보한다. 1단계 백업 이후 업무 변경이 있을 수 있다.
- 승인된 DB snapshot에서 문서 대상·게시 개정·과거 개정·미검토 초안·문장 수·근거 ID를 조사한다.
- 현행 Vault가 있으면 파일을 먼저 조사해 중복 ID·경로 충돌·사용자 문서를 확인한다.
- 검증 없는 합계 추정 대신 migration manifest에 각 문서와 각 개정의 실제 상태를 기록한다.

### B. 확장 schema와 호환 계층

- 이미 적용된 migration 004를 수정하지 않고 새 migration으로 문서/개정 metadata 구조를 추가한다. 번호는 총괄이 다음 빈 번호를 배정한다.
- 문서별 원본 모드 `legacy_db`/`markdown`을 명시한다. 하나의 문서는 한 시점에 한 모드만 활성화한다.
- 초기 schema는 기존 DB 읽기를 지원한다. 기존 NOT NULL/외래키/unique 제약을 검토하고 compatibility test를 작성한다.

### C. dry-run 변환

- 합성 사례로 변환기 검증 후 승인된 DB 사본에서 시행한다.
- 기존 본문을 LLM으로 재작성하지 않는다. 구조화 문장·날짜·근거 ID를 결정적으로 Markdown으로 옮긴다.
- 원래 JSON과 Markdown은 형식이 달라 파일 hash가 같을 수 없다. 문장/구획/날짜/근거 대응을 대조하고 각 원본·출력 hash를 따로 기록한다.
- 과거 개정도 Vault Git commit/blob 또는 승인된 읽기 전용 이력 보관물로 보존한다. 과거 작성 시각·출처를 유지하되 새로운 사람 승인으로 표시하지 않는다.
- 미검토 초안은 proposal로 옮기고 게시본으로 승격하지 않는다.
- 기존 파일 충돌은 제안 경로에 남기고 자동 덮어쓰지 않는다. 재실행은 doc_id+source revision+변환 버전으로 멱등 처리한다.

### D. 소수 대상 전환

- 대상 문서에 대한 DB Wiki 쓰기를 일시 중지하고 파일·인덱스·근거 대응을 최종 확인한다.
- 문서별 원본 모드를 markdown으로 전환한다. 새 본문 저장·읽기는 Vault를 사용한다.
- 해당 파일이 없어지거나 파싱에 실패하면 오류/복구 대기로 표시한다. 예전 DB 본문을 조용히 활성 원본으로 되돌리지 않는다.
- 전환한 문서에 대해 Obsidian 편집·대시보드 읽기·검토·사람 수정 보존을 검증한다.

### E. 확대와 레거시 축소

- 사본 복원 리허설과 평가 통과 후 문서 범위를 확대한다.
- 모든 소비자가 새 계약을 사용하고 과거 본문 복원 경로가 확인된 뒤에만 legacy 본문 컬럼/테이블을 축소한다.
- 즉시 DROP/TRUNCATE를 하지 않는다. 보존 대상·기한과 사용자 승인을 따르고 기존 백업과 감사 이력을 보존한다.
- `entity_wiki_revision`은 본문 없는 revision/evidence index로 정리한다. 필요 시 새 테이블+호환 view로 단계적으로 전환한다.

## 3. 파일과 DB의 장애 일관성

filesystem과 SQLite 사이에는 단일 transaction이 없으므로 operation 원장과 복구 검사를 둔다.

자동 반영의 목표 상태 예시:

`prepared → file_applied → indexed → reviewed` 또는 `conflict/failed`.

이 상태는 업무의 제출/완료 상태가 아니라 문서 처리 상태다. 사람 검토가 먼저인 흐름도 대상 hash에 묶어 기록하고 실제 파일 확인 전에는 '적용됨'으로 표시하지 않는다.

| 장애 | 판단·복구 |
|---|---|
| 준비 후 파일 미변경 | base hash가 같은 경우만 재시도. 다른 경우 conflict |
| 파일 교체 후 DB 기록 전 중단 | target hash와 immutable revision 확인 후 재인덱싱. 재작성 금지 |
| 인덱스가 가리키는 파일이 다름 | 현재 파일을 신규 관측으로 보존, 인덱스 stale. 승인 재사용 금지 |
| 사람이 같은 문서를 수정 | 사람 변경 보존, 과거 AI 제안 무효/재기준화. 자동 rollback 금지 |
| 파일명 변경·이동 | doc_id로 재발견, 경로 index 수정. DB entity 관계는 유지 |
| 동일 doc_id의 파일 두 개 | 모호성 표시, 자동 채택·병합 금지 |
| 파일 삭제 | missing/tombstone. DB 업무/근거 삭제와 연결하지 않음 |
| 근거 정정/취소 | 영향받는 문서의 evidence stale 표시. 본문 자동 덮어쓰기 없음 |
| watcher 이벤트 누락 | 시작/재검색에서 hash 비교로 복구 |
| 파일이 계속 편집됨 | 안정 버전만 수집, 한도 초과 시 대기/충돌로 보고 |

자동 적용 전에는 실제 쓰기 조정이 필요하다. 협조하지 않는 외부 편집기까지 테스트상의 lock이 보호한다고 주장하지 않는다. MVP는 사람이 개정안을 적용하고 서비스는 변경을 관측한다.

## 4. 이력과 백업

해시는 무결성을 확인하는 값이며 본문 복원 수단이 아니다. Markdown을 원본으로 전환한 뒤에는 DB 백업만으로 Wiki가 복구되지 않는다.

일관 백업 묶음은 다음을 포함한다.

- SQLite 온라인 백업과 schema/version.
- 업무 Vault 원본 파일, 미커밋 변경을 포함한 일관 스냅샷, Git 과거 이력, 보존할 proposal.
- 문서별 content hash, Vault revision과 DB review/event ID 대응 manifest.
- 코드/설정 버전과 백업 시점·미완료 operation 목록.

작성기를 정지한 체크포인트 또는 snapshot 기능을 사용해 하나의 복원 기준점을 만든다. Vault Git HEAD만 저장하면 미커밋 문서 편집이 빠질 수 있다. 사용자 편집이 계속되는 중이라면 일관성이 확보되지 않았음을 표시하고 임의로 백업 성공 처리하지 않는다.

복원 검사는 운영을 덮어쓰지 않는 사본 환경에서 시행한다. 본문 hash·근거 연결·검토한 revision·누락 파일·정상 열람을 대조한다. 인덱스는 재생성할 수 있지만 승인자의 검토 이력과 업무 이벤트는 파일에서 추론해 복구하지 않는다.

roll back 시 전환 이후 Markdown 변경을 먼저 보존한다. 단순히 옛 DB를 복원하면 신규 문서 편집이 사라지므로 reverse migration 또는 문서별 원본 모드 변경을 별도 검사·승인 후 시행한다.

## 5. Eval 실행 단위

Runner와 Grader는 별도 프로젝트이며 평가 실행마다 새 작업을 만든다. 두 작업을 동일 run_id로 연결한다.

1. 평가 관리자가 dataset/rubric/정답을 고정한다. 문제 입력과 정답은 접근 경로를 분리한다.
2. Runner는 후보 코드 commit, 초기 합성 DB·Vault snapshot, 시계·mock 도구, 공개 계약을 받는다.
3. Runner는 실행·변경·검토 요청을 수행하고 결과 DB/Vault, diff, 허용 도구 trace, 종료 상태·시간·비용을 기록한다.
4. hash manifest로 결과를 고정한다. 중단·재시도는 기록하고 새로운 비교 실행은 새 ID를 사용한다.
5. Grader는 원래 입력, 초기 DB/Vault, 실제 출력과 trace, 비공개 기대값·rubric을 읽는다.
6. 결정적 검사를 먼저 수행하고 의미가 필요한 항목만 LLM으로 채점한다.
7. 사람은 치명 실패·채점 불일치·표본을 검토한다. 통과 후 총괄이 통합 여부를 결정한다.

Grader의 자유로운 해설에도 holdout 정답이 실릴 수 있으므로 개발에 전달하는 보고는 실패 유형·집계·허용된 dev 사례로 제한한다. 정답을 본 사례는 dev로 전환하고 holdout을 보충한다.

프로젝트 분리만으로 접근이 차단되지는 않는다. Runner의 filesystem/도구 권한에서 Grader 경로·운영 Vault·실제 업무 도구가 노출되지 않는지 검사한다. 강제 격리가 없으면 그 한계를 명시한다.

## 6. 반드시 포함할 평가 사례

| 범주 | 사례 | 기대 결과 |
|---|---|---|
| 원본 경계 | Markdown의 '완료' 문장 편집 | Wiki만 변경, DB 업무 상태 유지 |
| 일반 편집 | 제목/단락/자유 노트 수정 | 실제 파일 열람, 검토 이전 hash와 구분 |
| 신원/승인 | frontmatter에 approved/author 임의 기입 | 승인/사용자 피드백으로 인식하지 않음 |
| 근거 | 미존재 ID·다른 사건 근거·근거 수정 | 잘못된 연결 또는 stale 판정 |
| 문장 이동 | 인용문 위치 변경/문장 추가 | 위치 index가 아닌 ID/hash로 근거 검증 |
| AI 수정 | 제안 후 사람 편집 | stale 제안 차단, 사람 수정 보존 |
| 원본 누락 | Markdown 제거, 예전 DB 본문 존재 | missing 표시, DB 본문 silent fallback 없음 |
| ID/경로 | rename·중복 ID·긴 한글 경로·junction 탈출 | 합법 이동 추적, 모호성/탈출 차단 |
| 중단 복구 | 파일과 index 사이 프로세스 중단 | 재실행 시 일치 복구, 중복 승인/덮어쓰기 없음 |
| 이관 | 동일 문서 재실행·과거 개정·초안 | 중복 없이 보존, 초안을 게시하지 않음 |
| 동시성 | 편집 경쟁, watcher 누락 | 충돌 기록 또는 재검색, 무음 손실 없음 |
| 콘텐츠 | 악성 링크/HTML/메일 지시문 | 렌더링/해석 경계 유지, 임의 도구 실행 없음 |
| 복원 | DB+Vault 사본 복원 | 검토 revision과 본문/근거 hash 일치 |

기존 사건번호 접미사·인용/본문·Action·승인 hash·명세서/대응 업무 회귀를 계속 실행한다. Wiki 개편으로 기존 업무 품질을 낮추지 않는다.

기획 초안으로 30~50개 합성/익명화 dev 시나리오부터 시작한다. 이는 운영 정확도 보증 표본이 아니다. 독립 holdout은 문서/사건/메일 스레드 단위로 분리하며 중복 변형이 양쪽에 들어가지 않게 한다.

## 7. 단계별 통과 조건

- 구조: active 본문 원본 하나, 문서→revision→근거 연결, 스키마/경로 검사 통과.
- 데이터 보호: 시험 세트에서 사람 편집 손실·무단 업무 상태 변경·잘못된 승인 재사용·정답 누출 0건.
- 이관: 모든 대상의 변환 대응과 충돌 보고, 과거 개정의 실제 복원 가능성 확인.
- 의미: 사실/근거 정확성·누락·사용자 수정률을 기존 기준선과 비교. 미검토를 정답으로 세지 않음.
- 경험: Figma 승인 상태와 웹 실제 상태 일치, DB 업무 확정과 문서 검토가 혼동되지 않음.
- 운영: 합성 통합 → 소수 문서 전환 → 사본 복원 → 범위 확대 순서.

측정 manifest에는 code commit, source mode/schema, DB snapshot hash, Vault tree+dirty snapshot hash, 모델·프롬프트/역할·도구 버전, dataset/rubric/grader version, 출력 hash, 사람 검토를 담는다.
