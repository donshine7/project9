# 운영 업무 Wiki Vault 초기화 — 2026-09-26

경로: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_Wiki`

## 완료

- 계획된 `00_Home`~`90_Archive` 폴더와 `.obsidian` 설정을 생성했다.
- 원본 경계·문서 ID·승인·Eval 분리·금지 동작을 `AGENTS.md`에 기록했다.
- 실제 사건 정보가 없는 `00_Home/Home.md`만 초기 문서로 만들었다.
- 업무 Vault를 소스 저장소와 분리된 로컬 비공개 Git으로 초기화했다.
- 초기 commit: `0b3b080` (`chore: initialize operational wiki vault`).
- 원격 저장소는 연결하지 않았다.

## 읽기 전용 재점검

- 운영 DB 파일: 존재, 변경 없음.
- 업무 Vault: 존재.
- 운영 DB의 Markdown 전환 필수 schema: 미적용.
- 운영 Wiki 인덱스 문서: 0개.
- 사람 검토 완료 컷오버 후보: 0개.

따라서 Vault 골격은 준비됐지만 실제 운영 파일럿은 아직 실행할 수 없다. 운영 DB migration 전에 최신 일관 백업, 대시보드 중지/편집 중지 시간, 초기 1~3개 문서의 `doc_id`·entity 연결·현재 hash를 확정해야 한다.

## 변경하지 않은 범위

- 실제 사건 문서와 고객 자료를 생성·복사하지 않았다.
- 운영 DB migration을 실행하지 않았다.
- Outlook·EasyPAT을 호출하지 않았다.
- `_권순항` 폴더를 읽거나 수정하지 않았다.
