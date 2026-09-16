# 사용자 수정 비교 및 개선 기록 설계

## 1. 목적

이 기록은 다음 네 가지를 분리해 보존한다.

1. 모델 또는 규칙이 **당시 무엇을 입력으로 받았는지**
2. 어떤 버전의 모델·프롬프트·업무 규칙이 **무엇을 판단했는지**
3. 장진태 님이 그 판단을 **수락·수정·거절하거나 빠진 항목을 추가했는지**
4. 그 차이를 바탕으로 어떤 개선안을 만들고, 회귀 테스트 후 적용했는지

사용자 수정은 곧바로 학습 데이터나 새 업무 규칙으로 확정하지 않는다. 새 증거가 뒤늦게 들어온 경우, 단순 표현 선호, 일회성 예외와 실제 모델 오류를 먼저 구분한다.

## 2. 기록의 기본 단위

한 번의 LLM 실행은 여러 판단을 포함할 수 있으므로 `실행 → 필드별 판단 → 사용자 피드백 → 확정 이벤트`의 네 단계로 나눈다.

```text
decision_run 1 ── N decision_item 1 ── N decision_evidence
                         │
                         └── N user_feedback ── 1 decision_comparison
                                      │
                                      └── 0..1 evaluation_case

policy_revision 1 ── N evaluation_run 1 ── N evaluation_result
        ▲
        └── improvement_proposal ── 사용자 승인
```

필드별 판단을 쓰는 이유는 한 메일에서 관리번호, 현재상태, 담당자, Action 필요 여부의 정확도가 서로 다를 수 있기 때문이다.

## 3. 테이블 구조

### `decision_run`: 판단 실행 원장

모델 호출 또는 결정적 규칙 실행 한 번을 재현하기 위한 상위 기록이다.

| 필드 | 형식 | 설명 |
|---|---|---|
| `id` | UUID | 실행 식별자 |
| `sync_run_id` | UUID, nullable | 어느 메일 갱신 실행에서 발생했는지 |
| `operation` | text | `mail_fact_extraction`, `matter_linking`, `action_judgement`, `high_risk_verification`, `wiki_revision`, `deterministic_rule` |
| `agent_name` | text, nullable | 사용한 역할 이름 |
| `model` | text, nullable | 실제 사용 모델. 규칙 실행이면 null |
| `reasoning_effort` | text, nullable | 실제 사용 추론 강도 |
| `prompt_version` | text, nullable | 프롬프트 버전 |
| `policy_revision_id` | UUID | 당시 사건번호·상태전이·Action 규칙 버전 |
| `routing_snapshot_json` | JSON | 당시 모델 라우팅 설정의 동결본 |
| `input_snapshot_id` | UUID | 동일 조건 비교용 입력 스냅샷 |
| `status` | enum | `started`, `succeeded`, `failed`, `cancelled` |
| `started_at`, `completed_at` | datetime | 실행 시간 |
| `error_code` | text, nullable | 실패 유형. 민감한 원문 오류는 별도 로컬 로그 참조 |
| `output_hash` | text, nullable | 원출력 무결성 확인용 해시 |

`model`은 라우팅 설정에 적힌 예정값이 아니라 실제 하위 작업에 전달된 값을 기록한다.

### `input_snapshot`: 당시 입력 동결본

사용자가 수정할 때 모델 실행 이후 새 메일이 추가됐는지 구분하기 위한 기록이다.

| 필드 | 형식 | 설명 |
|---|---|---|
| `id` | UUID | 스냅샷 식별자 |
| `matter_id` | UUID, nullable | 당시 연결된 사건 |
| `mail_ids_json` | JSON | 사용한 메일 ID와 각 본문 해시 |
| `entity_versions_json` | JSON | 사건·업무·Action·담당자 이벤트 버전 |
| `source_priority_version` | text | 출처 우선순위 버전 |
| `context_hash` | text | 전체 입력의 안정적 해시 |
| `created_at` | datetime | 생성 시각 |

원문 전체를 중복 저장하지 않고 `mail_item`과 `event`의 버전 및 해시를 참조한다.

### `decision_item`: 필드별 판단

비교와 품질 측정의 중심 테이블이다.

| 필드 | 형식 | 설명 |
|---|---|---|
| `id` | UUID | 판단 식별자 |
| `decision_run_id` | UUID | 상위 실행 |
| `subject_type` | enum | `matter`, `work_item`, `assignment`, `action`, `wiki_revision`, `person`, `organization`, `group` |
| `subject_key` | text | 기존 ID 또는 생성 후보 키 |
| `field_path` | text | 예: `matter.our_ref`, `work.current_status`, `action.assignee_id`, `action.required` |
| `decision_type` | enum | `create`, `update`, `link`, `unlink`, `close`, `no_change` |
| `previous_value_json` | JSON | 판단 전 값 |
| `proposed_value_json` | JSON | 모델·규칙이 제안한 값 |
| `normalized_value_json` | JSON | 비교용으로 정규화한 값 |
| `confidence` | real | 0~1. 모델 문구가 아니라 시스템 공통 척도 |
| `risk_level` | enum | `low`, `medium`, `high`, `critical` |
| `rationale` | text | 짧은 판단 이유 |
| `review_status` | enum | `pending`, `accepted`, `edited`, `rejected`, `superseded`, `not_reviewed` |
| `created_at` | datetime | 생성 시각 |

한 `decision_item`에는 한 필드 또는 한 원자적 관계만 넣는다. 예를 들어 Action 생성과 Action 담당자 지정은 별도 판단으로 저장한다.

### `decision_evidence`: 판단 근거

| 필드 | 형식 | 설명 |
|---|---|---|
| `id` | UUID | 근거 식별자 |
| `decision_item_id` | UUID | 대상 판단 |
| `source_type` | enum | `mail`, `excel`, `registration_mail`, `user_input`, `event`, `rule` |
| `source_id` | text | 원본 ID |
| `locator_json` | JSON | 제목·본문 문단·첨부파일 셀·규칙 번호 등 위치 |
| `excerpt` | text, nullable | 화면 표시용 최소 근거 문구 |
| `excerpt_hash` | text | 근거 변조 확인 |
| `supports` | enum | `support`, `contradict`, `context` |

근거가 없는 판단은 저장할 수 있지만 자동 확정할 수 없으며 검토함으로 보낸다.

### `user_feedback`: 사용자 입력·수정 이벤트

사용자가 직접 새 값을 입력한 경우도 모델 판단에 대한 수정과 같은 형식으로 기록한다.

| 필드 | 형식 | 설명 |
|---|---|---|
| `id` | UUID | 피드백 식별자 |
| `decision_item_id` | UUID, nullable | 비교 대상 판단. 모델이 빠뜨린 항목이면 null |
| `event_id` | UUID | 실제 업무 상태에 반영된 확정 이벤트 |
| `actor_id` | UUID | 장진태 사용자 ID |
| `feedback_action` | enum | `accept`, `edit`, `reject`, `create_missing`, `restore`, `merge`, `split` |
| `before_value_json` | JSON | 사용자 동작 직전 값 |
| `final_value_json` | JSON | 사용자가 확정한 값 |
| `reason_code` | enum | 아래 수정 이유 코드 |
| `note` | text, nullable | 선택 입력. 반복 오류 분석에 필요한 설명 |
| `new_evidence_ids_json` | JSON | 판단 이후 새로 확인한 메일·자료 |
| `created_at` | datetime | 확정 시각 |

수정 이유 코드는 다음으로 시작한다.

- `wrong_matter`, `wrong_work_type`, `wrong_service_type`
- `wrong_stage`, `wrong_status`, `wrong_assignee`, `wrong_due_date`
- `action_missing`, `action_unnecessary`, `wrong_action_owner`
- `insufficient_evidence`, `source_conflict`, `new_evidence`
- `formatting_only`, `user_preference`, `one_off_exception`
- `new_business_rule`, `other`

이유 입력은 기본적으로 선택 사항이다. 시스템이 차이를 보고 이유 후보를 제시하되, 사용자의 최종 선택을 별도로 보관한다.

### `decision_comparison`: 판단과 최종값의 비교 결과

| 필드 | 형식 | 설명 |
|---|---|---|
| `id` | UUID | 비교 식별자 |
| `user_feedback_id` | UUID | 원인 피드백 |
| `comparison_type` | enum | `exact`, `normalized_equal`, `partial`, `different`, `missing`, `extra`, `not_comparable` |
| `changed_paths_json` | JSON | 달라진 하위 필드 목록 |
| `model_error_class` | enum | `correct`, `false_positive`, `false_negative`, `wrong_value`, `stale_context`, `preference`, `unknown` |
| `eligible_for_eval` | boolean | 회귀 사례로 쓸 수 있는지 |
| `excluded_reason` | text, nullable | 새 증거·일회성 예외 등 제외 사유 |
| `compared_at` | datetime | 비교 시각 |

날짜·사건번호·담당자·상태처럼 구조화된 값은 정규화 후 정확 비교한다. Wiki·메모 같은 자유문은 자동으로 정오 판정하지 않고 변경 범위만 계산한 뒤 필요하면 사용자 검토를 받는다.

### `policy_revision`: 개선 대상 버전

| 필드 | 형식 | 설명 |
|---|---|---|
| `id` | UUID | 버전 식별자 |
| `revision_type` | enum | `rule`, `prompt`, `routing`, `schema`, `workflow` |
| `version` | text | 사람이 읽을 수 있는 버전 |
| `artifact_paths_json` | JSON | 변경한 설정·코드·프롬프트 경로 |
| `content_hash` | text | 적용 내용 해시 |
| `status` | enum | `draft`, `testing`, `approved`, `active`, `retired` |
| `approved_by`, `approved_at` | nullable | 장진태 승인 기록 |

### `evaluation_case`, `evaluation_run`, `evaluation_result`

사용자 수정 중 객관적인 정답과 입력 스냅샷이 확보된 항목만 회귀 사례로 승격한다.

| 테이블 | 주요 필드 |
|---|---|
| `evaluation_case` | `origin_feedback_id`, `operation`, `input_snapshot_id`, `expected_items_json`, `severity`, `active` |
| `evaluation_run` | `policy_revision_id`, `routing_snapshot_json`, `suite_hash`, `started_at`, `completed_at`, `status` |
| `evaluation_result` | `evaluation_run_id`, `evaluation_case_id`, `actual_items_json`, `passed`, `score`, `error_class` |

평가 사례는 원본 입력을 계속 따라가지 않고 당시 스냅샷을 고정한다. 개인정보가 포함된 전체 데이터는 로컬에 두고, 보고서에는 사건번호 마스킹 또는 집계값을 사용할 수 있다.

### `improvement_proposal`: 개선 승인 기록

| 필드 | 형식 | 설명 |
|---|---|---|
| `id` | UUID | 개선안 식별자 |
| `trigger_feedback_ids_json` | JSON | 개선안을 촉발한 피드백 |
| `target_type` | enum | `deterministic_rule`, `prompt`, `agent_instruction`, `model_route`, `workflow` |
| `proposed_diff` | text | 변경안 |
| `expected_effect` | text | 목표 지표와 예상 효과 |
| `evaluation_run_id` | UUID, nullable | 회귀 평가 결과 |
| `status` | enum | `proposed`, `testing`, `needs_review`, `approved`, `rejected`, `applied`, `rolled_back` |
| `decided_by`, `decided_at` | nullable | 장진태 결정 |

## 4. 비교 규칙

1. `input_snapshot.context_hash`가 같을 때만 모델과 사용자의 값을 직접 비교한다.
2. 모델 실행 후 새 메일이 들어왔다면 `stale_context` 또는 `new_evidence`로 분류하고 모델 오류율에서 제외한다.
3. 사건번호는 대소문자·공백을 정규화하되 접미사를 제거하지 않는다.
4. 날짜는 시간대와 날짜 정밀도를 맞춘 뒤 비교한다. 추정일과 확정일은 같은 값으로 보지 않는다.
5. Action은 필요 여부, 수행자, 기한, 상태를 각각 평가한다.
6. 자유문 수정은 맞고 틀림보다 `누락`, `근거 없는 추가`, `표현 변경`으로 나눈다.
7. 사용자가 되돌린 수정도 새 피드백 이벤트로 추가하며 과거 기록을 삭제하지 않는다.

## 5. 개선 루프

1. 모델·규칙 판단을 `decision_run`과 `decision_item`에 먼저 기록한다.
2. 장진태 님의 수락·수정·거절·추가를 `user_feedback`과 업무 `event`에 동시에 기록한다.
3. 비교기가 `decision_comparison`을 생성한다.
4. 반복되는 객관적 오류만 `evaluation_case` 후보로 만든다.
5. 주 Codex 작업이 규칙, 프롬프트, 역할 지침 또는 모델 라우팅 개선안을 제안한다.
6. 기존 회귀 사례 전체와 새 사례에서 평가한다.
7. 기존 중요 사례가 악화되지 않고 장진태 님이 승인한 경우에만 `policy_revision`을 활성화한다.
8. 적용 후 실제 피드백 지표를 이전 버전과 비교한다. 악화되면 이전 버전으로 되돌리고 이 사실도 기록한다.

자동으로 프롬프트나 규칙을 고치는 기능은 두지 않는다. 개선안 생성과 시험은 자동화할 수 있지만 운영 적용은 사용자 승인 대상이다.

## 6. 품질 지표

지표는 전체 평균뿐 아니라 `operation`, `field_path`, 모델, 프롬프트 버전, 정책 버전, 신뢰도 구간별로 계산한다.

- 무수정 수락률: `accept / 검토된 decision_item`
- 필드 수정률: `edit / 검토된 decision_item`
- Action 오탐률: `action_unnecessary / 제안 Action`
- Action 누락률: 분석 범위에서 사용자가 `create_missing`으로 만든 Action 비율
- 사건 연결 정확도: 확정된 `matter.our_ref` 중 무수정 수락 비율
- 고위험 반려율: `risk_verifier`가 확인한 후보 중 사용자 또는 후속 증거로 반려된 비율
- 신뢰도 보정: 각 confidence 구간과 실제 무수정 수락률의 차이
- 검토 부담: 메일 100건당 사용자 수정·검토 건수

검토되지 않은 판단을 정답으로 간주하지 않는다. 사용자가 수정하지 않았다는 이유만으로 자동 성공 처리하지 않고 `not_reviewed`로 남긴다.

## 7. 예시

메일 분석 결과가 다음과 같다고 가정한다.

```json
{
  "matter": "P251556",
  "work_type": "중간사건",
  "current_status": "의견통지",
  "action_required": true,
  "assignee": "황현우"
}
```

장진태 님이 사건·상태는 수락하고, Action 담당자를 장진태로 수정했다면 다음처럼 기록한다.

- `decision_item`: 관리번호, 업무종류, 상태, Action 필요, 담당자에 대해 각각 1행
- `user_feedback`: 앞의 네 판단은 `accept`, 담당자는 `edit`
- `decision_comparison`: 담당자 판단만 `wrong_value / wrong_action_owner`
- `event`: 실제 Action 담당자를 장진태로 변경한 확정 이벤트
- `evaluation_case`: 동일 입력에서 올바른 담당자를 판단할 객관적 근거가 있을 때만 생성

그 후 같은 오류가 반복되면 바로 모델을 바꾸지 않고 위임 문구·수신자·CC·보낸 메일의 약속 기준을 먼저 개선안으로 만들고 전체 회귀 사례에서 검증한다.

## 8. 대시보드 표시

각 자동 판단 옆에 다음 정보를 펼쳐볼 수 있게 한다.

- 모델 제안값과 신뢰도
- 사용자가 확정한 현재값
- 근거 메일·Excel·규칙
- 사용 모델, 추론 강도, 프롬프트·정책 버전
- 수락·수정·거절 버튼과 선택형 수정 이유
- 같은 유형의 최근 정확도와 반복 오류 여부

별도 `개선 검토` 화면에는 반복 오류, 제안된 개선안, 회귀 평가 전후 결과, 적용·보류·반려 버튼을 둔다.

