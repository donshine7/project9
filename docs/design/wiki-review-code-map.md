# Wiki Review Figma ↔ 코드 매핑

## 기준

- Figma 파일: [Wiki Review UX](https://www.figma.com/design/Jza7Umf9gezhYcmleHJoAf)
- 화면: `Wiki Review / Desktop` — node `23:2`
- 운영 상태 확장: [Wiki 검토 운영 상태 · BUILD-B 핸드오프](wiki-operational-state-handoff.md) — 화면 흐름 `31:3`, 컴포넌트 세트 `32:47`
- 합성 데이터만 사용한다.
- CSS 원본은 `dashboard/app/globals.css`의 `:root` 변수다. Figma 변수의 WEB syntax도 같은 CSS 변수명을 사용한다.

## 컴포넌트

| Figma 컴포넌트 세트 | Node ID | React 구현 | 주요 속성 |
|---|---:|---|---|
| Button | `16:21` | `dashboard/app/wiki/components.tsx#Button` | `variant=primary/secondary/danger`, `disabled` |
| StatusBadge | `17:34` | `dashboard/app/wiki/components.tsx#StatusBadge` | `status` 8종, 상태 라벨은 변형에서 결정 |
| Tab | `18:16` | `dashboard/app/wiki/components.tsx#Tab` | `active`, children |
| DocumentListItem | `19:23` | `dashboard/app/wiki/components.tsx#DocumentListItem` | `active`, `warning`, `documentTitle`, `meta`, `status` |
| 문서 검토 패널 | 별도 Figma 승인 프레임 없음 | `dashboard/app/wiki/review-panels.tsx#ReviewStatePanel` | 문서 승인·AI 제안 검토를 9개 표시 상태로 구분 |
| WikiOperationStateCard | `32:47` | BUILD-E 이후 구현 예정 (`dashboard/app/wiki` 기능 전용) | 자동반영·복구·배치 `State` 9종, `Reason`, `Next action`; 문서 검토 상태와 별개 |

화면 구현은 `dashboard/app/wiki/page.tsx`, 집계 API는 `dashboard/lib/wiki-review.ts`, 로컬 HTTP 라우팅은 `dashboard/local-api.ts`에 있다.

## 상태 규칙

| UI 상태 | 결정 조건 |
|---|---|
| `indexing` | 최신 scan이 `running` |
| `missing` | `wiki_document.parse_status=missing` |
| `duplicate_id` | `parse_status=duplicate` |
| `conflict` | frontmatter/binding/index hash 충돌 또는 `stale_document` |
| `evidence_stale` | 최신 제안이 `stale_evidence` |
| `needs_review` | 제안 준비·검토 대기 또는 검토 hash 없음/불일치 |
| `reviewed` | 현재 파일이 검토된 base hash와 일치하고 수동 반영 대기 |
| `up_to_date` | 수동 반영 결과가 target hash로 관측됨 |

## 원본 경계

- SQLite: 사건·업무·Action·근거·제안/검토 이력의 원본.
- Obsidian Markdown: Wiki 본문의 원본.
- Dashboard: 두 원본을 hash로 비교해 표시하고 검토를 기록한다.
- 제안 승인 API는 활성 Markdown을 수정하지 않는다. 사람이 수동 반영한 뒤 재색인으로 관측한다.

## Code Connect 상태

현재 Figma 컴포넌트는 파일 내부 로컬 컴포넌트이며 아직 라이브러리로 게시되지 않았다. Figma Code Connect는 게시된 컴포넌트만 연결할 수 있으므로 이번 단계에서는 이 매핑 문서를 기준으로 삼는다. 라이브러리 게시 후 다음 React 경로를 단순 매핑으로 등록한다.

현재 연결 계정은 Code Connect에 필요한 Organization/Enterprise Dev 또는 Full 좌석도 없어 공식 연결 도구가 거절되었다. 게시와 좌석 조건이 해결되기 전에는 `.figma.ts`를 생성하지 않는다.

- `16:21` → `dashboard/app/wiki/components.tsx` / `Button`
- `17:34` → `dashboard/app/wiki/components.tsx` / `StatusBadge`
- `18:16` → `dashboard/app/wiki/components.tsx` / `Tab`
- `19:23` → `dashboard/app/wiki/components.tsx` / `DocumentListItem`

## 2026-09-29 승인·충돌 검토 확장

기존 Figma 화면의 8개 API 상태는 유지하고, `review-model.ts`가 문서 승인 이력과 AI 제안 검토 이력을 구분하는 9개 표시 상태로 변환한다. `review-panels.tsx`의 `ReviewStatePanel`, `DocumentApprovalPanel`, `WorkStateBoundary`는 화면에 추가된 기능별 컴포넌트이며 스타일은 `review-panels.module.css`에 한정한다. 이 확장에 대한 Figma 승인 프레임은 아직 없으므로 기존 `23:2`나 운영 상태 보드 `31:3`을 문서 승인 패널의 승인 디자인으로 간주하지 않는다. 데이터·API 연결 조건은 `docs/orchestration/BUILD_B_WIKI_REVIEW_UI_HANDOFF_2026-09-29.md`를 따른다.

Figma `31:3`·`32:47`의 9개 상태는 `ManualReviewed`, `ApprovalReady`, `AutoApproved`, `Stale`, `Conflict`, `Recoverable`, `OperationalBlocked`, `BatchReady`, `BatchBlocked`로, 자동반영·복구·배치 준비도를 위한 별도 축이다. React `review-model.ts`의 `approved`, `proposal_reviewed`, `needs_review` 등 문서 표시 상태 9개와 이름이나 의미가 같지 않다. BUILD-E 이후에도 두 축을 한 `status` 필드로 합치지 않는다.
