# SSPAT Eval Runner

이 폴더를 Codex의 별도 프로젝트 기본 폴더로 지정한다. 후보 구현은 별도 Git checkout/worktree에서 준비하고, 이 프로젝트에는 입력·계약·실행별 고정 산출물만 둔다.

1. 새 작업 이름을 `[EVAL-RUN] <dataset> - <candidate commit> - <run id>`로 만든다.
2. 후보 checkout의 `dashboard`에서 `npm run eval:wiki:runner`를 실행하되, `--dataset`은 이 프로젝트의 `datasets`, `--run-root`는 이 프로젝트의 새 `runs/<run-id>`로 지정한다.
3. 생성된 폴더를 수정하지 말고 Grader 프로젝트에 run 경로만 전달한다.

정답·rubric·holdout은 이 폴더에 복사하지 않는다.
