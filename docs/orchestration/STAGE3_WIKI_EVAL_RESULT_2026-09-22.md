# 단계 3 WIKI-01·EVAL-01 구현 결과 — 2026-09-22

상태: **구현·합성 평가 완료**. 운영 DB·운영 업무 Vault·Outlook·EasyPAT은 사용하지 않았다.

## 구현 범위

### WIKI-01

- 업무 Vault의 활성 디렉터리에서 Markdown frontmatter v1을 제한적으로 파싱한다.
- `doc_id`와 엔티티 연결을 불변 식별자로 사용하고 중복 ID, 연결 변경, 없는 엔티티, 경로 충돌을 차단한다.
- SQLite에는 본문을 저장하지 않고 문서 메타데이터, byte/text hash, scan·revision·issue만 기록한다.
- 관찰한 정확한 bytes는 Vault의 `.sspat-history/objects/<prefix>/<sha>.md`에 내용 주소 방식으로 보존한다.
- 파일 수정·이동·누락과 재검색을 추적하며 symlink/junction과 Vault 실경로 탈출을 차단한다.
- 기존 `/api/wiki`는 변경하지 않고 `/api/wiki-markdown` 조회·scan·detail·issue API를 별도로 추가했다.

### EVAL-01

- `wiki-dev-v1` 합성 DB/Vault fixture와 실행 manifest 계약을 추가했다.
- Runner는 정답 인수를 받지 않고 새 실행 폴더에 입력·DB·Vault·출력·trace와 SHA-256을 고정한다.
- Grader는 별도 expected를 받아 manifest·DB·Vault·출력 hash, SQLite 무결성, 문서 상태, 본문 비저장, 이력 object bytes를 결정적으로 검사한다.
- Runner/Grader 프로젝트 초기화 스크립트는 기존 폴더를 덮어쓰지 않고 Runner에 정답 계열 파일이 들어가면 초기화를 실패시킨다.
- 실제 holdout은 저장소의 공개 dev expected와 구분하며 Grader 전용 ACL/샌드박스 영역에 둔다.

## 생성된 별도 프로젝트

| 역할 | 기본 폴더 | 확인 결과 |
|---|---|---|
| Eval Runner | `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner` | 합성 입력·계약·실행 폴더만 존재, 정답 계열 파일 0개 |
| Eval Grader | `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader` | expected·rubric·baseline·report 전용 구조 |

프로젝트 분리는 운영상 경계이며 같은 Windows 계정에서의 기밀성은 별도 NTFS ACL 또는 실행 샌드박스 허용 경로로 보강해야 한다.

## 검증 결과

- `npm run test:wiki-markdown`: 통과
- `npm run test:environment`, `npm run test:phase1` ~ `test:phase4`: 모두 통과
- `npm run lint`: 통과, 기존 CJS escape 경고 1개 유지
- `npm run typecheck`: 통과
- `npm run build`: 통과
- 격리 서버 필수 화면/API와 새 Wiki Markdown API smoke: 모두 HTTP 200, scan은 HTTP 201
- 분리된 Runner 프로젝트 실행: 문서 3개 발견·3개 색인·issue 0개
- 분리된 Grader 프로젝트 채점: **16/16 통과**
- 평가한 구현 commit: `f5a134c5d802d060b36881f1ccd384d29a724166` (`gitDirty=false`)
- 최종 실행 ID: `stage3-f5a134c-001`
- 채점 보고서: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader\reports\stage3-f5a134c-001.json`

이 개발 fixture의 통과는 도구 계약과 결정적 회귀를 검증한 것이며, 모델 의미 품질이나 실제 사건 holdout 성능을 의미하지 않는다.

## 변경하지 않은 경계

- 레거시 `entity_wiki_revision`과 현재 `/api/wiki` 소비자는 그대로 유지했다.
- 실제 Wiki Markdown 원본 전환과 운영 migration은 수행하지 않았다.
- 실제 사건 폴더와 `외주\_모베이스\_권순항`은 읽거나 수정하지 않았다.
- AI 개정안 자동 적용, UI, 일회성 DB→Markdown 이관은 다음 단계 범위다.

## 다음 단계

단계 4의 WIKI-02와 MIG-01을 진행한다. 먼저 합성 문서에서 base hash가 오래된 제안을 차단하고 사람 편집을 보존하는 개정 제안 계약을 만든 뒤, 레거시 Wiki를 Markdown으로 변환하는 dry-run과 재실행 멱등성을 검증한다.
