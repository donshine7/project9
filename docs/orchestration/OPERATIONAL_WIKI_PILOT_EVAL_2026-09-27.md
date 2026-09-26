# 운영 Wiki 파일럿 분리 EVAL 결과 — 2026-09-27

## 실행 분리

- Runner 루트: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner`
- Grader 루트: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader`
- 후보 commit: `59e33f175958f48356a1e7d36a485e184fda6310` (`gitDirty=false`)
- 데이터셋: `wiki-vertical-v1` 합성 데이터 4개

두 실행은 서로 다른 프로젝트 폴더와 새 실행 ID를 사용했다. Runner에는 Grader의 expected·rubric을 노출하지 않았고, 실제 사건 Markdown·운영 DB·운영 Vault를 복사하거나 읽지 않았다.

Codex 저장 프로젝트 목록에는 두 폴더가 아직 등록되지 않아 데스크톱 UI에서 사람이 한 번 등록해야 한다. 실행 격리 자체는 각 폴더의 `AGENTS.md` 계약대로 유지했다.

## Eval Runner

- 실행 ID: `pilot-stage5-59e33f1-001`
- 실행물: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalRunner\runs\pilot-stage5-59e33f1-001`
- 입력 복사, 격리 DB seed, 사람 편집, 제안 생성, 사람 검토, 수동 반영, 재스캔을 시나리오 4개에서 완료했다.
- 모든 시나리오에서 검토 전 활성 Markdown은 변경되지 않았다.
- 모든 시나리오에서 `automaticApply=false`, `proposalStatus=applied_observed`, `finalReviewStatus=up_to_date`를 확인했다.
- 최종 파일 hash는 각 제안 target hash와 일치했다.

## Eval Grader

- expected: `graders/dev/wiki-vertical-v1.expected.json`
- 보고서: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_EvalGrader\reports\pilot-stage5-59e33f1-001.json`
- 결과: `passed=true`, 39/39.
- 데이터셋 ID, 대상 수, DB·Vault·결과·검토 인덱스 hash, 문서별 수동 반영 흐름, trace, DB quick check와 원장 수를 모두 통과했다.

## 운영 안전 확인

- 평가 전후 운영 DB SHA-256: `EA4B13FAA419C28F192CDFC0048CEBE0A11603BD9D87A08D68090AC7158FC4F9`로 동일하다.
- 운영 Vault HEAD: `6a8c81e505b79a492256b25dac14d847b7ac7d4d`, clean.
- 운영 사건 3개는 계속 `source_mode=legacy_db`다.
- 실제 사건 내용에 대한 사람 검토와 컷오버는 수행하지 않았다.

## 판정

후보 구현의 제안→검토→수동 반영→재스캔 안전 흐름은 합성 EVAL을 통과했다. 이 결과는 실제 사건 내용의 법률·기술 정확성을 승인하는 것이 아니다. 다음 단계는 운영 Vault에서 파일럿 사건 3개를 사람이 직접 검토하고, 문서별 승인 기록을 만든 뒤 컷오버·복구 리허설 대상으로 올리는 것이다.
