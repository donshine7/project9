# BUILD-C: SQLite·Obsidian Vault 체크포인트와 사본 복원

상태: 합성 환경 구현·검증. 운영 DB·Vault에 체크포인트를 실행하거나 복원하지 않았고 Git remote 생성·push도 하지 않았다.

## 구현 계약

- `dashboard/lib/operational-checkpoint.ts`의 `checkpointReadiness`, `createOperationalCheckpoint`, `verifyCheckpointDirectory`, `rehearseOperationalRestore`가 독립 진입점이다. 기존 Wiki cutover bundle과 별개이며 cutover 전후 전체 운영 체크포인트에 사용한다.
- 체크포인트는 SQLite 읽기 전용 연결의 `VACUUM INTO` 일관 사본, Vault 전체 파일 사본(추적·미추적·미커밋 파일), `git bundle --all` 이력, SHA-256 파일 목록과 DB schema/migration·무결성 검사 결과를 저장한다. `.git` 자체는 복사하지 않고 bundle로 보존한다.
- DB `data_version`, Vault 사전·사후·사본 트리 해시, Git HEAD와 모든 ref 해시를 비교한다. 작성기가 계속 작업하는 상황에 대한 완전한 원자성을 소프트웨어만으로 보증하지 않는다. **앱·Obsidian·Git의 해당 Vault/DB 쓰기를 중지한 작업창**이 선행 조건이다. `coordination.automaticallyEnforced=false`가 manifest에 남는다.
- 성공 시 `<checkpointParent>/<operationId>/operation-manifest.json`으로 묶음을 원자적 이름 변경한다. 실패/중단 시 `.staging-<operationId>`를 보존하고 같은 ID 재시도는 차단한다. 운영자가 원인을 조사한 뒤 새 ID를 써야 한다.
- 복원 리허설은 체크포인트·별도 복원 부모의 기존 실제 경로를 먼저 확인한다. bundle에서 Git 저장소를 새 폴더에 clone하고 사본의 Vault 파일을 덮어 놓는다. DB quick check·외래키·migration 목록·Markdown 원본 문서의 파일/현재 revision 해시와 Git fsck를 검사해 `restore-report.json`을 쓴다. 운영 원본에는 쓰지 않는다.
- 입력 경로의 링크/junction, 특수 파일, 출력과 입력의 포함 관계, 기존 결과 폴더, manifest/파일 해시 변조를 차단한다.

## CLI와 ORCH 통합

공용 `package.json`, lock, migration, `local-api.ts`는 수정하지 않았다. CLI를 사용하려면 dashboard에서 아래처럼 전용 파일을 컴파일한다.

```powershell
./node_modules/.bin/tsc scripts/operational-checkpoint-cli.ts --outDir ../.operational-checkpoint-cli --rootDir . --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --esModuleInterop
node ../.operational-checkpoint-cli/scripts/operational-checkpoint-cli.js readiness C:\secure\checkpoint-request.json
node ../.operational-checkpoint-cli/scripts/operational-checkpoint-cli.js checkpoint C:\secure\checkpoint-request.json
node ../.operational-checkpoint-cli/scripts/operational-checkpoint-cli.js verify C:\secure\checkpoints\checkpoint-20260929-001
node ../.operational-checkpoint-cli/scripts/operational-checkpoint-cli.js rehearse C:\secure\restore-request.json
```

체크포인트 요청 예시는 다음과 같다. 실제 운영 경로와 작업창은 ORCH가 확인해 채운다. `readiness`는 경로·Git 상태만 점검하고 출력물을 만들지 않는다.

```json
{
  "operationId": "checkpoint-20260929-001",
  "profile": "operational",
  "confirmation": "CHECKPOINT:checkpoint-20260929-001",
  "database": "C:\\Users\\<user>\\AppData\\Local\\SSPAT\\work-management\\sspat-work.db",
  "vault": "C:\\ChatGPT\\AI-Work\\20_업무자동화\\상상업무자동화_Wiki",
  "checkpointParent": "D:\\SSPAT-secure-backups"
}
```

복원 요청은 `{"checkpoint":"<완성된 체크포인트 절대 경로>","restoreParent":"<별도 격리 폴더>","restoreName":"rehearsal-001"}`이다. 체크포인트 상위 폴더와 복원 상위 폴더가 서로 포함되면 안 된다. 결과가 이미 있으면 덮어쓰지 않는다.

ORCH가 앱 호출을 붙일 때는 위 함수 계약을 사용하되 임의 HTTP 트리거로 운영 백업을 시작하지 말아야 한다. 현재 CLI에는 영구 원장 DB 쓰기가 없다. 불변 `operation-manifest.json`과 `restore-report.json`이 실행 기록이다. migration 020은 사용하지 않았다.

## Git 원격·오프사이트 보존

실행마다 `git-history.bundle`을 포함하므로 원격 저장소 없이도 현재 참조된 전체 Git 이력을 복원할 수 있다. 미커밋/미추적 파일은 bundle이 아닌 `vault-snapshot`에만 있으므로 **bundle과 스냅샷과 DB와 manifest를 한 세트로** 보존한다. 사본 복원이 통과한 뒤 체크포인트 폴더 전체를 접근 제한·암호화된 별도 매체/위치로 복제하고 원본과 SHA-256을 대조한다. 보존 주기와 매체 분리, 운영 원격 생성·push는 별도 승인에서 확정한다. Git remote만 보존하는 경우에도 Vault 미커밋 사본과 DB/manifest가 추가로 필요하다.

## 운영 실행 전 요구사항

1. 운영 DB/Vault 경로, Vault가 자체 Git 저장소인지, 외부 백업 폴더의 접근권한·여유 공간, 별도 복원 폴더를 확인한다.
2. 앱·Obsidian·Git 작성기를 중지하고 최신 Wiki 인덱스/승인 대조를 완료한다. Markdown 원본 파일과 DB 현재 revision 해시가 다르면 체크포인트는 실패한다.
3. 고유 `operationId`와 확인 문자열로 readiness → checkpoint → verify → 별도 폴더 rehearse를 순서대로 실행하고 네 결과를 보관한다.
4. 복원 사본에서 대시보드를 격리 프로필로 열어 문서와 사건을 확인한다. 실제 운영 복원은 이 도구의 범위 밖이며 기존 파일을 자동 덮어쓰지 않는다.
5. 이중 저장 위치의 물리적 분리와 암호화, 보존 기간, 매체 손상 시 교체 절차를 승인한다.

2026-09-29 읽기 전용 점검: 운영 DB 파일(112,988,160 byte)과 Vault 및 `.git` 디렉터리는 존재한다. 현재 Codex 샌드박스 계정에서 Vault Git 명령은 Git의 `dubious ownership` 검사로 거부됐다. 저장소 소유 계정으로 실행하거나 소유권을 확인한 뒤 실행 범위에 한정해 Git 신뢰 경로를 설정해야 한다. 전역 Git 설정은 변경하지 않았으며 Git refs/dirty 상태와 백업 저장 위치는 아직 확인하지 못했다.

## 합성 검증

`dashboard/tests/operational-checkpoint.test.ts`는 WAL SQLite, Git 커밋 후 수정 파일과 미추적 문서, 복원 사본의 DB 조회·Git HEAD/원래 커밋 본문·Vault 바이트 비교, 해시 변조, 기존 결과, 경로 겹침, 체크포인트·복원 중간 실패의 staging 보존과 동일 ID 재실행 거부를 검사한다. 운영 경로는 사용하지 않는다.
