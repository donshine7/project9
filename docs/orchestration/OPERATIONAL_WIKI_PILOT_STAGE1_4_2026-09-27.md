# 운영 Wiki 파일럿 1~4단계 결과 — 2026-09-27

## 결과

운영 사건 3개를 저위험 파일럿으로 선정해 백업, Wiki schema 적용, Markdown 생성과 운영 인덱싱까지 완료했다. 실제 사건 식별자·문서 hash·레거시 revision 연결은 원격이 없는 로컬 업무 Vault의 `.sspat-pilot/manifests/wiki-pilot-bootstrap-2026-09-27.json`에만 기록했다.

파일럿 선정 조건은 다음과 같다.

- 활성 사건이며 보관 상태가 아닐 것
- 미완료 Action이 없을 것
- pending 또는 rejected Wiki draft가 없을 것
- 게시된 legacy Wiki revision이 있을 것
- 모든 문장에 근거 event가 있고 같은 사건에 연결될 것

## 1단계 — 안전 준비

- 대시보드 `127.0.0.1:4173` 미실행 상태를 확인했다.
- 마이그레이션 전 `PRAGMA integrity_check`: `ok`.
- 마이그레이션 전 운영 DB SHA-256: `A1D08446EA1F956C95F7F0E42F14A5FAB3995FEBB4C006851791794CA2110B7A`.
- 일관 백업: `C:\Users\donsh\AppData\Local\SSPAT\work-management\backups\sspat-work-pre-wiki-pilot-2026-09-27.db`.
- 마이그레이션 전 백업 SHA-256: `513AD223E45C1F4E89AFA45191C6B93DCFE96E1FD97326A0D902B90A7EDABD4F`.
- 백업 무결성: `ok`; 사건 364개, legacy Wiki revision 198개, migration 12개를 확인했다.

## 2단계 — 파일럿 선정

3개 사건은 서로 다른 legacy revision 깊이와 원천을 포함하도록 선정했다. 구체적인 사건번호·entity ID·`doc_id`는 로컬 업무 Vault manifest를 기준으로 한다. 세 사건 모두 선정 조건을 통과했다.

## 3단계 — 운영 DB schema

- migration `013_wiki_markdown_index.sql`부터 `018_wiki_legacy_cleanup.sql`까지 순서대로 적용했다.
- 전체 migration 수: 18.
- 적용 후 `PRAGMA integrity_check`: `ok`.
- 적용 후 `PRAGMA foreign_key_check`: 위반 0개.

## 4단계 — Markdown 생성·인덱싱

- 업무 Vault `10_Matters`에 파일럿 Markdown 3개를 생성했다.
- 기존 문장을 새로 추론하지 않고 각 사건의 최신 게시 legacy revision을 결정적으로 변환했다.
- 생성 파일 3개의 `wiki-md-v1` 파싱과 manifest SHA-256 일치를 확인했다.
- 전체 스캔 `f0a2817c-1e8e-4e81-9f9e-202f438e34cd`: 발견 4, 인덱스 4, 변경 4, 이슈 0.
- 반복 증분 스캔 `11b8c041-6cc3-4420-96f4-f637a7e7fb5c`: 변경 0, 재사용 4, 이슈 0.
- 홈 링크 반영 후 스캔 `dc68cb2f-205f-4176-9a62-34f2b6866319`: 변경 1, 재사용 3, 이슈 0.
- 최종 운영 인덱스: 유효 문서 4/4(Home 1, 파일럿 사건 3), Markdown revision 5개, 스캔 이슈 0개.
- 파일럿 사건 3개는 모두 `source_mode=legacy_db`다. Markdown 원본 컷오버는 수행하지 않았다.
- 파일럿 감사 event 3개를 `wiki.pilot_indexed`로 기록했다.

업무 Vault 로컬 Git 커밋은 다음과 같다.

- `d3792ff`: 파일럿 사건 3개와 생성 manifest
- `3ef31c2`: 초기 스캔 불변 이력 객체
- `dc40aee`: 홈 파일럿 링크와 source mode 안내
- `6a8c81e`: 홈 증분 revision 이력 객체

Vault에는 원격 저장소가 없고 최종 상태는 clean이다.

## 완료 후 복구 기준점

- 완료 후 백업: `C:\Users\donsh\AppData\Local\SSPAT\work-management\backups\sspat-work-post-wiki-pilot-2026-09-27.db`.
- 완료 후 백업 SHA-256: `EBC071632CEF33379D6C567F9335BBAD2A2CDF1FB2D38A3610FCE40450ABAB43`.
- 완료 후 백업 무결성: `ok`; 외래키 위반 0개; migration 18개; Wiki 문서 4개.
- 완료 시점 운영 DB SHA-256: `EA4B13FAA419C28F192CDFC0048CEBE0A11603BD9D87A08D68090AC7158FC4F9`.

## 유지한 차단

- 사람 검토와 Eval Grader 승인이 없으므로 컷오버 후보는 0개다.
- `source_mode=markdown` 전환, 운영 자동 적용, legacy 본문 정리는 실행하지 않았다.
- Outlook·EasyPAT을 호출하지 않았다.
- `외주\_모베이스\_권순항` 폴더를 읽거나 수정하지 않았다.

후속 합성 Runner/Grader 결과는 [OPERATIONAL_WIKI_PILOT_EVAL_2026-09-27.md](OPERATIONAL_WIKI_PILOT_EVAL_2026-09-27.md)에 기록했다. 후보 구현은 39/39를 통과했으며, 다음 단계는 실제 파일럿 사건 3개의 사람 검토다. 승인된 문서만 컷오버·복구 리허설 대상으로 올린다.
