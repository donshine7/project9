# 프로젝트 정보

- 프로젝트명: 상상업무자동화
- 프로젝트 루트: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화`
- 운영 환경: Windows, Outlook (classic), Node.js 22.13 이상
- 대시보드 주소: `http://127.0.0.1:4173/`
- Git 원격 저장소: `https://github.com/donshine7/project9.git`

## 현재 구현 범위

- Hiworks POP3 메일의 Outlook 신규 수신 이벤트 연결
- 21단계 우선순위에 따른 사건·업무 메일 분류
- 기존 오분류 메일의 선택·당일·국내 시리즈·국내 OA 재분류 기능
- 메일 정책과 폴더 체계를 보여주는 로컬 운영판
- 한국특허 가출원 프로젝트 목록 및 13단계 진행 상태 표시
- 검증·스테이징·원자적 이동을 사용하는 가출원 프로젝트 초기화
- 작업별 모델·추론 강도와 역할을 정의한 Codex 라우팅 설정
- 로컬 SQLite 스키마·자동 마이그레이션·무결성 검사·백업/복구
- 당소관리번호 파서와 관리 사무소·국가·특수 접미사 분류
- `/matters` 사건·업무 상태·메모·본인/팀원 Action CRUD와 감사 이벤트
- 사건·회사·자연인·그룹별 비고와 연결 레코드
- 회사/자연인 구분과 회사의 개인사업자·법인·미정 분류
- 감사 항목별 사용자 피드백, 원문 발췌, 이전 감사 답변 승계 표시
- Outlook 허용 폴더·보낸편지함 읽기 전용 수집, 중복 방지와 날짜별 메일 중요내용 1차 요약

## 다음 구현 범위

3·4단계의 작업별 모델 라우팅, 판단 검토함, 네 대상 Wiki 및 재처리·버전 관리 기능은 구현되었다. 운영 메일의 실제 처리 범위는 `docs/OPERATIONAL_BATCH_2026-09-11.md`를 따른다.

2026-09-14 그룹 종류 저장·수정, 기존 번호 연결 감사, 회사·자연인 관계 후보 및 독립 검증을 추가했다. 잘못된 기존 메일 연결 20건을 전체 관리번호 기준으로 모두 정리했다. 사용자 확정 규칙에 따라 `-DIV1`, 복수 시리즈 전체 연결, 완료 EasyPAT 번호 우선을 적용했고 최종 기존 연결 재검토는 0건이다. 실제 처리·대기 범위는 `docs/OPERATIONAL_BATCH_2026-09-14.md`를 따른다. 검토 후보를 확정 관계로 집계하지 않는다.

2026-09-15 당사자를 회사·자연인으로 구분하고 회사 구분을 개인사업자·법인·미정으로 세분화했다. 디멘필은 기존 `Demenpil Inc.` 회사에 중복 없이 연결하고 회사 구분을 미정으로 확정했다. 감사 항목에 사용자 피드백과 원문 발췌를 추가했으며, 두 단계 LLM 검증과 운영 DB 사본 dry-run을 거쳐 기존 사건 연결 누락 16건을 모두 처리했다. 미등록·미지원 번호는 자동 생성하지 않고 사용자 검토함에 유지한다. 상세 이력은 `docs/OPERATIONAL_BATCH_2026-09-15.md`를 따른다.

- 실제 그룹의 대표 사건·구성원 확인 및 그룹 생성
- 미검증 사실 후보의 독립 검증 및 반려 요약 재작성
- 2026-09-15 후속: 기존 미검증 72건 검증과 기존 반려 4건 재작성·독립 검증 완료. 9개 사건 Wiki 날짜 기록 14건 추가. 새 반려 7건과 날짜 충돌 2건은 후속 검토. `docs/FACT_REVIEW_2026-09-15.md` 참고.
- 회사·자연인·그룹 실제 정보와 관계 확인 및 대상별 Wiki 연결

2026-09-15 검토함을 정보 확인·변경 제안·처리 이력으로 개편하고 후속 안정화를 완료했다. 전체 타입 오류를 해결했으며 동일 시각의 최신 피드백 선택과 그룹 답변 변경 전 이력을 보완했다. 필수 테스트에 더해 `npm run typecheck`, `npm run test:client`가 통과했다. 상세 구현·검증은 `docs/REVIEW_INBOX_DESIGN.md`를 따른다. 이 단계에서는 운영 사건·메일·사용자 답변을 변경하지 않았다.

## 소스 기준

- Outlook 실행 코드: `HiworksAutoClassifier.bas`, `ThisOutlookSession_Hiworks.txt`
- 대시보드 실행 코드: `dashboard/app`, `dashboard/local-api.ts`, `dashboard/scripts`
- 정적 참고본: `dashboard/static-reference`
- 정책 데이터: `dashboard/app/data.ts`
- 구조 문서: `docs/architecture.mmd`
- 목표 업무관리 설계: `docs/WORK_MANAGEMENT_ARCHITECTURE.md`
- 판단·사용자 수정·회귀 평가 설계: `docs/DECISION_FEEDBACK_DESIGN.md`
- LLM 라우팅: `config/llm-routing.toml`, `config/agents`
- 설치·복구 및 이력 문서: `docs/SETUP_AND_RECOVERY.md`, `docs/history`
