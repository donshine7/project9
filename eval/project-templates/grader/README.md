# SSPAT Eval Grader

이 폴더를 Runner와 다른 Codex 프로젝트의 기본 폴더로 지정한다. 개발용 expected는 공개 회귀 확인용이며, 실제 holdout 정답은 이 프로젝트 안의 비공개 영역에만 둔다.

1. 새 작업 이름을 `[EVAL-GRADE] <dataset> - <candidate commit> - <run id>`로 만든다.
2. 후보 저장소의 `dashboard`에서 `npm run eval:wiki:grader`를 실행한다.
3. `--run-root`는 Runner가 고정한 실행 폴더, `--expected`는 이 프로젝트의 정답, `--report`는 이 프로젝트의 새 `reports/<run-id>.json`으로 지정한다.
4. 자동 검사 결과와 사람 검토 결과를 구분해 기록한다.

Runner 작업에는 이 프로젝트 경로나 정답 내용을 전달하지 않는다.
