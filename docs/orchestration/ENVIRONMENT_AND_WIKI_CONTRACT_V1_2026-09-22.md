# ENV-01 · DOC-01 계약 v1

상태: 구현 시작 계약. 운영 데이터 전환 전.

## 1. 실행 환경 계약

모든 DB 쓰기 경로는 `SSPAT_RUNTIME_PROFILE`로 실행 의도를 명시한다.

| 프로필 | 용도 | 경로 규칙 |
|---|---|---|
| `operational` | 승인된 로컬 대시보드 운영 | DB·사건·Wiki 운영 기본 경로 사용 가능 |
| `development` | 기능 개발·수동 검증 | DB·Vault·사건 루트 모두 격리 루트 안에 명시 |
| `eval` | Runner 후보 실행 | 실행별 격리 루트 안의 고정 fixture만 사용 |
| `test` | 자동 테스트 | 임시 디렉터리만 사용 |

격리 프로필에 필요한 변수:

```text
SSPAT_RUNTIME_PROFILE=development | eval | test
SSPAT_ISOLATED_ROOT=<실행 전용 루트>
SSPAT_WORK_DB_PATH=<격리 루트>/db/work.db
SSPAT_WIKI_VAULT_PATH=<격리 루트>/vault
SSPAT_NOTICE_PROJECT_ROOT=<격리 루트>/cases/notice
SSPAT_SPEC_PROJECT_ROOT=<격리 루트>/cases/specification
SSPAT_PROVISIONAL_PROJECT_ROOT=<격리 루트>/cases/provisional
```

- 변수 미지정, 격리 루트 밖의 경로, 알려진 운영 DB·사건·Vault 경로는 시작 전에 거부한다.
- 기존 자동 테스트와의 호환을 위해 OS 임시 디렉터리의 명시적 DB는 `test`로만 추론한다. 그 밖의 암묵적 프로필은 없다.
- 기본 운영 대시보드 실행 스크립트만 `operational`을 명시한다. worktree에서 `npm run dev`를 바로 실행하면 운영 DB로 떨어지지 않고 중단한다.
- 실제 Outlook 수집은 `operational`에서만 허용한다. 개발·평가에서는 fixture 또는 mock 출력만 사용한다.
- Git worktree는 코드 checkout만 격리한다. 이 계약이 DB·Vault·사건 자료의 별도 격리를 담당한다.
- 프로필 검사는 접근 권한을 대체하지 않는다. Eval Runner에는 Grader·운영 경로에 대한 filesystem 권한도 제공하지 않는다.

## 2. Wiki Markdown frontmatter 계약

기계 검증 원본은 `config/wiki-document.schema.json`이다.

```yaml
---
schema_version: wiki-md-v1
doc_id: wiki-synthetic-001
document_type: entity_wiki
entity_type: matter
entity_id: synthetic-matter-001
title: SAMPLE-CN(PA) 사건 검토
aliases: []
tags: [sample]
---
```

- `doc_id`는 불변이다. 파일명·제목·경로 변경의 식별 기준으로 사용한다.
- `entity_wiki`만 DB 엔티티와 연결한다. `knowledge`와 `note`는 자유 문서로 평가 기준을 분리한다.
- `entity_id` 변경은 파일 텍스트만으로 승인되지 않는다. DB 인덱스의 기존 연결과 검토 절차가 우선한다.
- `approved`, `reviewer`, `author`, `content_hash`, `source_mode`는 frontmatter에서 허용하지 않는다. 승인·작성 주체·대상 hash·원본 모드는 인증된 DB 이벤트가 원본이다.
- 본문은 UTF-8 Markdown이다. 원본 파일의 byte hash와 정규화 텍스트 hash는 구분해 저장한다.
- 사건 사실 문장은 `event:<id>` 또는 `source:<id>` 근거와 연결한다. 정확한 문법과 block ID는 WIKI-01 parser 구현 전에 fixture로 고정한다.
- 링크와 태그는 탐색 정보이며 DB 관계나 업무 상태를 직접 변경하지 않는다.

## 3. 구현 경계

ENV-01은 경로 선택 단계에서 운영 경로 접근을 차단한다. WIKI-01에서 파일 실경로 확인, symlink/junction 탈출 차단, Markdown parser와 변경 재검색을 추가한다. DOC-01은 frontmatter v1을 고정하지만 DB migration이나 기존 `sections_json` 제거를 수행하지 않는다.

현재 `entity_wiki_revision`과 `wiki_draft`는 전환 전 본문 저장소다. MIG-01 dry-run 및 복구 평가 전에는 수정·삭제하지 않는다.

## 4. 인수 조건

- 프로필 누락이 운영 DB로 fallback하지 않는다.
- 격리 프로필에서 운영 DB, 실제 중간사건 루트, 명세서 루트, 운영 Wiki Vault를 거부한다.
- 합성 DB·Vault·사건 루트는 하나의 격리 루트 아래에서 해석된다.
- 기존 자동 테스트는 명시적 임시 DB에서만 migration을 실행한다.
- 운영 시작 스크립트는 명시적으로 `operational` 프로필을 설정한다.
- Wiki frontmatter의 허용 필드와 금지된 권한 필드가 schema와 문서에서 일치한다.
