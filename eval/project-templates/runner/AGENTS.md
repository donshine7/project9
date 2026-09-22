# Eval Runner 프로젝트 규칙

이 프로젝트는 후보 구현을 합성 입력으로 실행하고 산출물을 고정하는 역할만 한다.

- `datasets/`의 공개 개발 입력 또는 별도로 전달받은 입력만 사용한다.
- `graders/`, `rubrics/`, `expected`, `answer`, `holdout` 이름의 정답 파일을 찾거나 읽지 않는다.
- 매 실행마다 존재하지 않는 `runs/<run-id>`를 사용하며 이전 실행을 덮어쓰지 않는다.
- `SSPAT_RUNTIME_PROFILE=eval`과 실행 폴더 안의 격리 DB/Vault만 사용한다.
- 운영 DB, 운영 업무 Vault, Outlook, EasyPAT에 접근하지 않는다.
- 후보 코드와 데이터셋은 실행 전에 Git commit과 SHA-256으로 식별한다.
- 실행이 끝나면 `run-manifest.json`, DB, Vault, 출력, trace를 그대로 보존하고 Grader에 전달한다.
- 채점 결과를 보고 후보 코드나 실행물을 이 프로젝트에서 수정하지 않는다.
