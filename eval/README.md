# Wiki 평가 운영 가이드

## 목적과 경계

EVAL-01과 EVAL-02는 `실제 사건`, `Eval Runner`, `Eval Grader`를 서로 다른 프로젝트로 운용한다. 이 저장소에는 평가 계약·도구·공개 개발 fixture만 둔다. 실제 사건 데이터와 holdout 정답은 저장소에 넣지 않는다.

프로젝트 분리는 작업 실수를 줄이는 운영 경계다. 같은 Windows 계정의 다른 폴더를 읽을 수 있다면 그 자체가 보안 경계는 아니다. 실제 holdout에는 별도 계정/ACL 또는 샌드박스 허용 경로를 적용하고, Runner에 Grader 경로를 마운트하거나 전달하지 않는다.

## 최초 1회: 별도 프로젝트 폴더 만들기

저장소 루트에서 다음을 실행한다. 기존 폴더는 덮어쓰지 않는다.

```powershell
.\eval\scripts\Initialize-WikiEvalProjects.ps1 `
  -RunnerRoot 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner' `
  -GraderRoot 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader'
```

ChatGPT/Codex에서는 각각을 별도 프로젝트 기본 폴더로 등록한다. 실제 사건 작업도 개별 사건 폴더를 기본 폴더로 하는 별도 프로젝트로 유지한다.

## 매 평가 실행

1. 평가할 코드 commit을 고정하고 깨끗한 Git worktree/check-out을 준비한다.
2. Runner에서 실행별 새 작업과 존재하지 않는 `runs/<run-id>`를 만든다.
3. 후보 저장소 `dashboard` 폴더에서 아래 명령을 실행한다.

```powershell
npm run eval:wiki:runner -- `
  --dataset 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\datasets\wiki-dev-v1' `
  --run-root 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\runs\wiki-dev-v1-001' `
  --run-id 'wiki-dev-v1-001'
```

Runner는 합성 입력을 실행 폴더로 복사하고 격리 DB/Vault를 만든다. `run-manifest.json`에 후보 commit/dirty 상태, 데이터셋 해시, DB·Vault·출력 해시와 trace를 고정한다. `--expected` 인수는 존재하지 않는다.

4. Grader에서 같은 실행 ID의 새 작업을 만들고 다음을 실행한다.

```powershell
npm run eval:wiki:grader -- `
  --run-root 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\runs\wiki-dev-v1-001' `
  --expected 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader\graders\dev\wiki-dev-v1.expected.json' `
  --report 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader\reports\wiki-dev-v1-001.json'
```

5. Grader는 먼저 DB 무결성, 산출물 해시, 문서 수·상태, 본문 DB 비저장, 이력 object의 정확한 byte hash를 검사한다. 이후에만 task-specific rubric과 사람 검토를 수행한다.

## EVAL-02 수직 흐름

`wiki-vertical-v1`은 합성 대상 4개에서 사람 편집 → 색인 → 제안 → 사람 검토 → 사람 수동 반영 → 재색인/적용 관측을 완주한다. Runner에는 입력·시나리오만 있고 기대값은 Grader 프로젝트에만 둔다.

Runner의 새 작업에서 실행:

```powershell
npm run eval:wiki:vertical:runner -- `
  --dataset 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\datasets\wiki-vertical-v1' `
  --run-root 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\runs\stage5-<commit>-001' `
  --run-id 'stage5-<commit>-001'
```

같은 run ID를 사용하는 Grader의 새 작업에서 실행:

```powershell
npm run eval:wiki:vertical:grader -- `
  --run-root 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\runs\stage5-<commit>-001' `
  --expected 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader\graders\dev\wiki-vertical-v1.expected.json' `
  --report 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader\reports\stage5-<commit>-001.json'
```

통과 기준은 4개 대상 모두 `automaticApply=false`, 수동 반영 전 활성 Markdown byte hash 불변, 제안 `applied_observed`, 최종 검토 상태 `up_to_date`, DB/Vault/출력 hash 일치다.

## EVAL-03 원본 전환·복원

Stage 5의 `wiki-vertical-v1` 합성 문서 4개를 고정 입력으로 재사용한다. Runner가 각 문서의 legacy revision을 합성하고 `legacy_db → markdown` 전환, legacy 본문 쓰기 차단, DB+Vault 사본 복원 리허설을 수행한다. Runner에는 기대값을 두지 않고 Grader의 `wiki-cutover-v1.expected.json`에서 독립 채점한다.

```powershell
npm run eval:wiki:cutover:runner -- `
  --dataset 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\datasets\wiki-vertical-v1' `
  --run-root 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\runs\stage6-<commit>-001' `
  --run-id 'stage6-<commit>-001'

npm run eval:wiki:cutover:grader -- `
  --run-root 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\runs\stage6-<commit>-001' `
  --expected 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader\graders\dev\wiki-cutover-v1.expected.json' `
  --report 'C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader\reports\stage6-<commit>-001.json'
```

통과 기준은 전환 대상 4개 모두 Markdown 원본 모드, legacy revision 보존, legacy 본문 쓰기 차단, 승인·event·hash 연결 유지, 복원 사본 DB/Vault hash 일치, 운영 경로 미변경이다.

## 개발 fixture와 holdout

- `wiki-dev-v1`과 `eval/graders/dev`는 도구 회귀를 위한 공개 fixture다. 모델 품질을 증명하는 비공개 holdout이 아니다.
- `wiki-vertical-v1`도 공개 합성 수직 회귀 fixture이며 운영 품질을 단독으로 증명하지 않는다.
- 실제 holdout은 실제 사건군/메일 스레드 단위로 dev와 겹치지 않게 나누고 Grader 프로젝트에만 둔다.
- 실제 고객 내용 대신 비식별화 또는 합성본을 우선한다.
- 자동 채점은 정확한 필드·해시·금지 동작을 우선하고, 의미 품질은 기준표와 사람 간 일치도를 보정한다.
- 오류·경계 사례를 포함하며 실제 운영 분포와 분리해 보고한다.
