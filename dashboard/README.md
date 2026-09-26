# 상상특허 로컬 운영 대시보드

`대시보드 실행.cmd`를 파일 탐색기에서 더블클릭하면 PowerShell 시작 스크립트가 실행됩니다. CMD에서는 npm을 직접 찾거나 호출하지 않습니다. PowerShell이 `Get-Command npm`으로 실제 `npm.ps1` 경로를 찾고, 현재 프로젝트의 소스 원본을 `%LOCALAPPDATA%\SSPAT\dashboard-runtime`으로 동기화한 뒤 그 위치에서 설치·실행합니다. `node_modules`, `dist`, `.next`, `.vinext`, `.wrangler`, `.git`과 검증용 비공개 작업 폴더는 동기화하지 않으며, 실행 전용 경로에서 최초 1회 `npm install --legacy-peer-deps --no-audit --no-fund`를 실행합니다. 별도 브라우저 대기 스크립트가 `http://127.0.0.1:4173/` 응답을 최대 60초 기다린 뒤 브라우저를 열고, Vinext 로그는 현재 명령 창에 표시됩니다.

## 운영 갱신 원칙

업무 자동화 정책이 바뀔 때 다음 항목을 같은 작업에서 함께 갱신합니다.

1. 실제 실행 코드와 Outlook 연결 상태
2. `app/data.ts`의 규칙·폴더 데이터와 `/mail` 화면
3. `/` 업무 허브와 `/provisional`·`/responses` 진행 상태·초기화 흐름
4. 상위 `docs/architecture.mmd`의 전체 구조

`static-reference/`에는 의존성 없이 파일 탐색기에서 열어볼 수 있는 정적 참고본(`index.html`, `dashboard-data.js`, `dashboard.js`)을 따로 보존합니다. 실제 운영 소스는 `app/`입니다.

대시보드는 로컬 Vinext 개발 서버에서 동작합니다. `/`는 업무 허브, `/mail`은 Hiworks·Outlook (classic) 운영판, `/matters`는 당소관리번호 중심 업무관리 화면, `/downloads`는 통지서 감지·ZIP 게시 현황, `/responses`는 의견제출통지서·거절결정서 대응 프로젝트의 13단계 추적판, `/provisional`은 한국특허 가출원 프로젝트 추적판입니다. Outlook 메일은 `/matters`에서 사용자가 갱신을 눌렀을 때만 읽기 전용으로 수집하며 외부로 전송하지 않습니다. 프로젝트 목록 API도 고정된 로컬 루트만 읽습니다.

`/downloads`는 로컬 원장만 읽어 5초 또는 60초 간격으로 갱신하며 화면 조회가 Outlook이나 EasyPAT 호출을 시작하지 않습니다. 자동화 플래그는 `config/notice-automation.json`에서 관리합니다. 현재 예약 감지와 자동 게시는 검증 전 상태로 꺼져 있고, 게시 완료 OA의 프로젝트 생성만 고정 중간사건 대응 루트와 검증된 ZIP을 사용해 실행할 수 있습니다.

`/responses`는 게시 완료된 의견제출통지서와 거절결정서를 프로젝트 초기화 전부터 표시합니다. 프로젝트 연결 뒤에는 접수·분석·전략·초안·검수·승인·외부 제출·접수 결과를 13단계로 추적합니다. 단계 완료 산출물은 프로젝트 내부 상대경로와 SHA-256으로 기록하며, 전략 선택과 제출본 승인은 별도 이력으로 보존합니다. 승인 파일이 변경되면 승인을 자동 무효화하고 사용자 확인 단계로 되돌립니다. 화면 조회만으로 단계나 파일을 변경하지 않습니다.

## 당소관리번호 업무관리

`/matters`에서 사건과 첫 업무를 등록하고, 업무단계·현재상태·비용·자금 출처·기산일·착수일을 수정할 수 있습니다. 장진태 님 본인과 박준호·황현우 팀원의 Action, 사용자 메모도 같은 화면에서 관리합니다. 모든 직접 입력은 확정값(`confidence=1`)으로 기록되며 변경 이벤트와 행 버전을 남깁니다.

사건·회사·자연인·그룹에는 각각 별도의 비고가 있습니다. 회사는 개인사업자·법인·미정으로 구분합니다. 회사·자연인·그룹은 선택한 사건에 연결해 등록하고 각 비고를 독립적으로 수정합니다.

`이메일 중요내용 갱신`에서 최근 1일·1주일·지정 기간을 선택할 수 있습니다. `jtjang@sspat.net` Outlook 저장소의 허용된 메일 폴더와 보낸편지함을 읽되, 대한변리사회·결재·해외 출원 자동 안내·과제 자동 안내 계열 폴더는 폴더 진입 전에 제외합니다. 메일은 이동·삭제하거나 읽음 상태를 변경하지 않습니다. 명시적 당소관리번호가 있는 메일만 사건에 연결하고 날짜별 규칙 기반 1차 요약과 근거 메일 수를 표시합니다. LLM 정제는 다음 분석 단계에서 별도 실행 기록과 함께 추가합니다.

운영 SQLite 파일은 기본적으로 `%LOCALAPPDATA%\SSPAT\work-management\sspat-work.db`에 저장됩니다. `SSPAT_WORK_DB_PATH` 환경 변수를 지정하면 검증용 DB를 분리할 수 있습니다. 화면의 `DB 백업`은 DB 옆 `backups` 폴더에 일관된 스냅샷을 만들며, 복구 API는 이 폴더 안의 백업만 허용합니다.

개발·평가 실행은 운영 DB로 자동 fallback하지 않습니다. 다음처럼 격리 실행 스크립트에 실행별 루트를 지정합니다.

```powershell
.\scripts\Start-Isolated-Dashboard.ps1 -IsolatedRoot "$env:TEMP\sspat-dev-run" -Profile development -Port 43173
```

이 스크립트는 DB, Wiki Vault, 중간사건·명세서·가출원 fixture 루트를 지정한 디렉터리 아래에 분리합니다. 개발·평가 프로필에서는 실제 Outlook 수집이 차단됩니다. 운영 실행은 기존 `대시보드 실행.cmd`를 사용하며 해당 시작 스크립트가 `operational` 프로필을 명시합니다. 상세 계약은 `docs/orchestration/ENVIRONMENT_AND_WIKI_CONTRACT_V1_2026-09-22.md`를 참고하세요.

데이터 기반 검증은 `npm run test:phase1`, 메일 수집·중복 방지·날짜별 요약 검증은 `npm run test:phase2`로 실행합니다.

## Markdown Wiki 인덱스와 독립 평가

업무 Wiki 본문은 Vault의 Markdown이 원본이며 SQLite에는 본문이 아니라 문서 식별자, 엔티티 연결, hash, scan·revision·issue만 저장합니다. `GET /api/wiki-markdown`은 인덱스, `POST /api/wiki-markdown/scans`는 명시적 재검색, `GET /api/wiki-markdown/documents/:docId`는 현재 파일 본문과 stale 여부, `GET /api/wiki-markdown/scans/:scanId/issues`는 검색 오류를 반환합니다. 기존 `/api/wiki`는 이 단계에서 유지합니다.

파서·수정·이동·누락·이력·경로 탈출 검사는 `npm run test:wiki-markdown`으로 실행합니다. 합성 평가는 `npm run eval:wiki:runner`가 정답 없이 실행물을 고정하고, 별도 프로젝트의 `npm run eval:wiki:grader`가 hash와 기대값을 검사합니다. 폴더 초기화와 매 실행 절차는 `../eval/README.md`를 따릅니다.

### AI 개정 제안

`npm run wiki:proposal -- prepare DOC_ID`로 현재 Markdown과 admissible event/source hash를 동결합니다. 반환된 run은 기존 `npm run analysis -- bind RUN_ID AGENT_ID MODEL EFFORT`로 실제 `wiki_synthesizer` 실행과 연결하고, `npm run wiki:proposal -- packet RUN_ID`를 입력으로 사용합니다. 모델 출력 JSON은 `npm run wiki:proposal -- ingest JSON_PATH`로 검증합니다.

제안은 `80_Proposals`에만 생성되며 활성 Markdown을 자동 수정하지 않습니다. `review PROPOSAL_ID accept_for_manual_apply EXPECTED_VERSION`은 사람이 반영할 수 있다는 검토만 기록합니다. 실제 적용은 Obsidian에서 수행하고 재스캔 후 `reconcile PROPOSAL_ID`로 target hash 일치를 확인합니다. base 문서나 근거가 바뀐 제안은 stale로 차단됩니다.

### 레거시 Wiki dry-run

승인된 격리 DB 사본에서만 다음을 실행합니다.

```powershell
npm run wiki:migrate:dry-run -- --output-root '<SSPAT_ISOLATED_ROOT>\migration-runs\legacy-v1'
```

게시 개정은 history/active 후보로, pending·rejected 초안은 proposals로 분리됩니다. 실제 업무 Vault와 레거시 DB 행, source mode는 바꾸지 않습니다. 기존 출력 폴더는 manifest와 모든 산출물 hash가 일치할 때만 멱등 재실행으로 인정합니다. 합성 회귀는 `npm run test:wiki-stage4`로 실행합니다.

### Wiki 원본 전환·복원 리허설

`npm run wiki:cutover -- cutover REQUEST.json`은 `development`·`eval`·`test` 격리 프로필에서만 실행됩니다. 요청에는 한 번에 1~5개 문서의 승인된 현재 byte hash와 `applied_observed` 제안 ID, 검토자 `장진태`, 확인 문자열 `CUTOVER`, 격리 루트 아래의 새 bundle 경로가 필요합니다. 전환 전에 DB와 Vault를 함께 스냅샷하고, 성공한 문서는 `markdown` 원본 모드로 바꾸며 legacy DB 본문 쓰기를 차단합니다.

`npm run wiki:cutover -- rehearse CUTOVER_RUN_ID RESTORE_ROOT`는 기존 경로를 덮어쓰지 않는 새 사본 폴더에서 DB quick check와 문서·revision·proposal review·source-mode event·파일 hash를 대조합니다. 운영 프로필 전환은 실제 대상 목록의 별도 승인 전까지 코드에서 차단됩니다. 합성 회귀는 `npm run test:wiki-stage6`, 독립 평가 명령은 `../eval/README.md`를 사용합니다.

### Wiki 증분 처리와 확대 준비도

`npm run wiki:scale -- assess`는 격리 프로필에서 전체 문서 목록을 확인하되 byte hash가 같은 파일의 파싱·Git 조회·revision 생성을 생략하고 처리량·검토부담 blocker를 `wiki_scale_run`에 기록합니다. `npm run test:wiki-stage7`은 40개 문서 중 5개만 바뀐 경우 5개 revision만 추가되는지 검사합니다.

`npm run wiki:scale -- operational-readiness`는 운영 DB를 read-only로 열어 schema와 집계만 출력합니다. 본문을 출력하거나 migration을 적용하지 않으며 운영 준비 승인을 만들지 않습니다. 별도 EVAL-04 실행 방법은 `../eval/README.md`를 따릅니다.

### 검토된 AI 제안 자동 반영

자동 반영은 수동 반영 검토와 별개 승인을 요구합니다. 격리 프로필에서 `npm run wiki:auto-apply -- approve PROPOSAL_ID ROW_VERSION`, `apply PROPOSAL_ID APPLY`, `recover OPERATION_ID`, `status OPERATION_ID` 순서로 사용합니다. base/target/evidence hash가 승인과 다르거나 사람이 동시에 저장하면 충돌로 중단합니다.

운영 프로필은 실제 Obsidian 편집 조정 승인 전까지 차단됩니다. 합성 경쟁·중단 복구 검사는 `npm run test:wiki-edit01`, 독립 평가는 `../eval/README.md`의 EVAL-05를 사용합니다.

### 레거시 Wiki 본문 정리 준비

`npm run wiki:cleanup -- dry-run OUTPUT_ROOT`는 격리 DB의 legacy revision/draft 본문을 불변 archive로 먼저 보존하고, 문서별 Markdown 전환·cutover·recovery 증거를 대조해 적격/차단 목록을 만듭니다. 이 명령은 DB 본문을 삭제하거나 수정하지 않습니다.

운영 실행과 실제 redaction은 보존정책 및 모든 소비자 전환 승인 전까지 제공하지 않습니다. 합성 검사는 `npm run test:wiki-cleanup01`, 독립 평가는 `../eval/README.md`의 EVAL-06을 사용합니다.

`/provisional`의 초기화 버튼은 고정 PowerShell 스크립트를 localhost에서만 호출합니다. 프로젝트명과 `PT` + 숫자 6자리 사건번호를 검증하고, 기존 폴더는 덮어쓰지 않으며, `.staging-*`에서 만든 뒤 최종 폴더로 원자적으로 이동합니다. `검증만 실행(dry-run)`을 켜면 실제 폴더를 만들지 않고 입력과 경로만 확인합니다.
# 3단계 분석·검토

`/analysis`는 사실·Action 후보와 모델 실행 이력을 표시한다. 이 프로젝트에서 Codex에 분석을 요청하면 `npm run analysis` CLI와 전문 에이전트로 실행한다. 별도 API 키는 필요 없다. 웹의 이메일 읽기 버튼만으로 LLM이 실행되지는 않는다.

분석 결과는 후보이며 사용자가 수락해야 업무 Action/확정 관찰로 저장된다. 고위험 후보는 Sol/high 독립 검증을 통과해야 수락할 수 있다. DB 변경과 사용자 피드백은 함께 기록된다. 원문 인용·라우팅·재수입 멱등성·고위험 차단·확정값 보호 테스트: `npm run test:phase3`.

전체 Wiki 설계와 실행 명령은 `../docs/LLM_WIKI_DESIGN.md`에 있다. 대상별 Wiki 게시·버전 화면은 4단계 시작 지시 후 진행한다.

## 검토함 및 안정화 검증

`/analysis`는 정보 확인·변경 제안·처리 이력으로 나뉘며 검색·필터·20개 단위 목록과 선택 항목 상세를 제공한다. 구현과 검증 기록은 `../docs/REVIEW_INBOX_DESIGN.md`를 따른다.

- 전체 타입 검사: `npm run typecheck`
- HTTP 오류·JSON 응답 형태 검사: `npm run test:client`
- 그룹 피드백 이력·중복 방지·원자적 취소: `npm run test:phase2`
- 감사 답변 최신값·승계·사용자 확정값 보호: `npm run test:phase3`

위 검증은 기존 lint·phase1~4·build를 대체하지 않는다. DB 테스트는 운영 DB와 분리된 임시 DB에서 실행한다.
