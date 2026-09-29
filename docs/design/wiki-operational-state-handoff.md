# Wiki 검토 운영 상태 · BUILD-B 핸드오프

## 범위와 Figma 기준

- 기존 화면: [Wiki Review / Desktop](https://www.figma.com/design/Jza7Umf9gezhYcmleHJoAf?node-id=23-2) (`23:2`). 기존 화면과 네 컴포넌트는 변경하지 않았다.
- 확장 보드: [Wiki Review / Approval · Conflict · Recovery](https://www.figma.com/design/Jza7Umf9gezhYcmleHJoAf?node-id=31-3) (`31:3`, 1600 × 871).
- 새 컴포넌트 세트: [WikiOperationStateCard](https://www.figma.com/design/Jza7Umf9gezhYcmleHJoAf?node-id=32-47) (`32:47`). `State` 9종과 `Reason`, `Next action` 텍스트 속성이 있다.
- Figma에는 `DOC-SYN-001`, `PR-SYN-001` 등 합성 식별자와 일반적인 상태 설명만 사용한다. 실제 사건명, 메일, 고객정보, Vault 본문은 없다.

이 설계는 현재 `/wiki`의 수동 검토 UI를 확장하기 위한 계약이다. `dashboard/app/wiki/page.tsx`와 `components.tsx`는 아직 이 운영 상태 카드를 렌더링하지 않는다. `dashboard/local-api.ts`에는 자동 반영 또는 Scale 준비도 HTTP 라우트가 없다. BUILD-B는 API 계약을 ORCH와 맞춘 후에만 실행 버튼을 연결한다.

## 상태 축과 우선순위

문서 검토, 자동 반영 작업, 배치 준비도는 **서로 다른 축**이다. 한 `status` 필드에 합치지 않는다.

| 축 | 현존 원본 | 화면 위치 |
|---|---|---|
| 문서 검토 | `WikiReviewStatus`, `wikiReviewIndex()` | 기존 목록·상세의 `StatusBadge` |
| 자동 반영 | `wiki_proposal`, `wiki_auto_apply_approval`, `wiki_apply_operation` | 상세의 `WikiOperationStateCard`와 작업 이력 |
| 배치 준비도 | `wiki_scale_run` 결과 또는 운영 읽기 전용 준비도 | 별도 배치 패널 |

선택 문서의 **주 경고** 우선순위는 `Conflict` → `Stale` → `OperationalBlocked` → `Recoverable` → `AutoApproved` → `ApprovalReady` → `ManualReviewed`다. 원인과 시각을 함께 표시한다. 배치 준비도는 문서 경고를 덮어쓰지 않고 별도 패널에 둔다. 기존 `indexing`, `missing`, `duplicate_id`, `conflict` 문서 상태는 지금처럼 목록에 남기고, 인덱스가 유효하지 않으면 승인·적용 행동을 막는다.

## 컴포넌트 상태 계약

| `State` / node | 의미와 결정 조건 | 톤 | 첫 행동 |
|---|---|---|---|
| `ManualReviewed` / `32:2` | `proposal.status=reviewed`, 현재 파일=검토 base, 수동 검토의 base·근거 hash 일치 | reviewed | 별도 자동 반영 승인 조건 검토 |
| `ApprovalReady` / `32:7` | 수동 검토·현재 base·target 제안 파일·근거·`rowVersion` 재검증 통과, 유효한 별도 자동 승인 없음, 비운영 프로필 | success | 현재 값 재대조 후 별도 승인 |
| `AutoApproved` / `32:12` | 별도 승인 기록의 base·target·evidence hash가 현 제안과 모두 일치 | success | 적용 직전 현재 파일 재검증 |
| `Stale` / `32:17` | 문서 또는 근거가 검토 후 변경됨; `stale_document`, `stale_evidence`, 승인 hash 불일치 포함 | danger | 재색인·재검토. 기존 승인 재사용 금지 |
| `Conflict` / `32:22` | 사람 편집으로 base hash 불일치, operation `conflict`·`failed`, 또는 알 수 없는 현재 hash | danger | 사람 파일 보존·상태 비교. 자동 복구 금지 |
| `Recoverable` / `32:27` | operation `prepared`·`file_applied`·`indexed` 중이며 현재 파일이 검증된 base 또는 target에 일치 | info | operation 상태 조회 후 같은 ID로 복구 |
| `OperationalBlocked` / `32:32` | `runtimeProfile()=operational`에서 자동 승인·적용·복구 차단 | warning | 읽기 전용 준비도와 편집 조정 조건 확인 |
| `BatchReady` / `32:37` | 합성 환경 `assessWikiScaleReadiness().status=passed` | success | 평가 수치·임계값·run 확인. 운영 허가는 아님 |
| `BatchBlocked` / `32:42` | 합성 평가 `failed` 또는 운영 읽기 전용 `readyForPilot=false` | warning | `blockers`를 수치와 함께 펼쳐 확인 |

`Stale`은 재검토로 돌아가는 상태이고 `Conflict`는 동시 편집 또는 적용 실패를 조사해 수동 해결해야 하는 상태다. 실패 원인을 사람 편집으로 단정하지 않는다. `Recoverable`은 같은 operation을 마무리할 수 있는 검증된 중단에만 사용한다. `succeeded`는 별도 승인 상태가 아니라 적용 완료 이력으로 표시하고, target hash가 재색인에서 관측되면 기존 `up_to_date` 배지를 사용한다.

### 행동 게이트

1. 수동 `accept_for_manual_apply`는 검토 이력만 만들며 활성 Markdown을 바꾸지 않는다. 이 이력은 자동 반영 권한이 아니다.
2. 자동 반영 승인은 인증된 검토자, 현 `rowVersion`, 수동 검토, base·target·evidence hash가 모두 일치할 때만 활성화한다. 저장 직전에 서버가 다시 검증한다.
3. 적용은 별도 승인 뒤에도 현재 문서와 제안 파일을 재대조하고 명시적 `APPLY` 확인을 요구한다. UI는 완료를 낙관적으로 표시하지 않고 서버 결과와 새 인덱스를 다시 읽는다.
4. 중단 복구는 `wikiAutoApplyStatus(operationId)`로 상태를 먼저 확인한다. `conflict`·`failed`는 `recoverWikiAutoApply()` 버튼을 제공하지 않는다. `prepared`에서 base가 유지되면 같은 operation으로 재개하고, `file_applied`·`indexed`에서 target이 확인되면 재작성 없이 색인·마무리한다.
5. 운영 프로필에서는 자동 승인·적용·복구와 합성 Scale 평가를 숨기거나 비활성화하고 차단 사유를 표시한다. 운영 준비도 조사는 읽기 전용이다. 합성 배치 `passed`는 운영 적용 권한으로 해석하지 않는다.

## BUILD-B 코드·데이터 매핑

| Figma / UI | 현존 코드·데이터 | 구현 연결점 |
|---|---|---|
| 기존 문서 목록·상세 `23:2` | `dashboard/app/wiki/page.tsx`, `dashboard/app/wiki/components.tsx` | 목록/상세의 기존 8개 `ReviewStatus`와 수동 검토 흐름 유지 |
| `WikiOperationStateCard` `32:47` | 현존 React 구현 없음 | 기능 전용 컴포넌트를 `/wiki` 내부에 추가하고 `state`, `reason`, `nextAction`을 명시적으로 전달. 문서 `StatusBadge`로 운영 상태를 가장하지 않음 |
| `ManualReviewed`·`ApprovalReady` | `wikiReviewDocument()`의 제안·검토 hash, `approveWikiAutoApply()` | `proposal.id`, `rowVersion`, `baseByteHash`, `targetByteHash`, `evidenceSnapshotHash`, 현재 byte hash를 비교 |
| `AutoApproved` | `wiki_auto_apply_approval`, `executeWikiAutoApply()` | 승인 기록의 세 hash와 현재 제안의 세 hash를 모두 비교. 승인 기록 존재만으로 활성화하지 않음 |
| `Stale`·`Conflict` | `reconcileWikiMarkdownProposal()`, `wiki_apply_operation.status/error_code` | 오류 코드와 현재/승인 hash를 함께 표시; 사람 편집 파일을 자동 덮어쓰지 않음 |
| `Recoverable` | `wikiAutoApplyStatus()`, `recoverWikiAutoApply()` | `operation.id`, `status`, `base_byte_hash`, `target_byte_hash`, `attempt_count` 표시 |
| `OperationalBlocked` | `runtimeProfile()`, `WIKI_AUTO_APPLY_OPERATIONAL_BLOCKED`, `WIKI_SCALE_OPERATIONAL_BLOCKED` | 서버 차단을 UI의 유일한 근거로 삼고 읽기 전용 안내 제공 |
| `BatchReady`·`BatchBlocked` | `assessWikiScaleReadiness()`, `inspectOperationalWikiReadiness()` | `documentCount`, `validDocumentCount`, `issueCount`, `elapsedMs`, `staleProposalCount`, `reviewReadyCount`, `thresholds`, `blockers` 표시 |

현재 HTTP로 제공되는 것은 `/api/wiki-review`, `/api/wiki-review/documents/:docId`, 기존 Markdown scan·proposal·review·reconcile이다. 자동 반영과 Scale은 현재 CLI/라이브러리 기능이다. UI에 새 라우트가 필요한 경우 ORCH 소유 `dashboard/local-api.ts`에서 서버가 프로필·인증·hash·버전을 검증하도록 합의한다. 브라우저가 CLI를 직접 실행하거나 승인 유효성을 단독 판정하지 않는다.

## 토큰과 접근성

| 의미 | Figma 변수 | CSS 원본 |
|---|---|---|
| 검토 이력 | `color/bg/reviewed`, `color/text/primary`, `color/border/focus` | `--violet-soft`, `--ink`, `--violet` |
| 통과·승인 | `color/bg/success`, `color/text/success`, `color/border/success` | `--mint-soft`, `--positive-text`, `--positive-border` |
| 복구 가능 | `color/bg/info`, `color/text/info`, `color/border/info` | `--blue-soft`, `--info-text`, `--info-border` |
| 차단·주의 | `color/bg/warning`, `color/text/warning`, `color/border/warning` | `--amber-soft`, `--warning-text`, `--amber` |
| stale·충돌 | `color/bg/danger`, `color/text/danger`, `color/border/danger` | `--danger-soft`, `--danger-text`, `--danger` |

상태는 색만으로 전달하지 않고 제목, 이유, 다음 행동을 항상 함께 표시한다. 오류는 `role="alert"`, 성공/진행 갱신은 `role="status"`로 알리고 포커스를 결과 제목에 옮길 수 있게 한다. 버튼에는 행동 이름과 대상 문서 ID를 접근 가능한 이름으로 제공한다. 신규 실행 버튼은 `--control-md`의 최소 44px 클릭 영역과 명확한 키보드 포커스를 사용한다. 비활성화 이유는 버튼 주변에 읽을 수 있는 문장으로 둔다. hash는 짧게 보여도 전체 값을 복사/검증할 수 있게 하고 서로 다른 hash를 색만으로 비교하지 않는다.

작은 텍스트의 토큰 대비는 success 4.98:1, info 5.82:1, warning 5.60:1, danger 6.02:1이다. 기존 reviewed 보라색 텍스트는 reviewed 배경에서 4.49:1이므로 새 카드의 11–12px 라벨과 다음 행동에는 `color/text/primary`를 사용한다.

## 검증·한계

- Figma 상태 카드 9종, 세 흐름, 기존 화면 보존을 구조와 화면으로 확인했다. 첫 시안의 카드 잘림과 변형별 문구 재사용을 수정했다.
- Figma Code Connect는 현재 계정의 Dev/Full Organization 또는 Enterprise 좌석 요구와 미게시 로컬 컴포넌트 때문에 연결할 수 없다. `.figma.ts`를 만들지 않고 이 문서에 node→React 매핑을 남긴다.
- 이 문서는 디자인·구현 계약이며 실제 운영 자동 반영 활성화나 운영 DB/Vault 변경을 승인하지 않는다.
