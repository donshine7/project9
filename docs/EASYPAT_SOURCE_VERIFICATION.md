# EasyPAT 원본 확인 절차

## 목적과 우선순위

EasyPAT MCP의 전체 당소관리번호 정확 일치 조회를 외부 원본의 최우선 근거로 사용한다. 운영 우선순위는 `EasyPAT > 사건등록 완료 메일 > Excel > 일반 메일 추정`이다. 사용자 확정값은 별도의 보호된 최종값이므로 EasyPAT과 충돌해도 자동으로 덮어쓰지 않는다.

출처 정책의 원본은 `config/source-priority.toml`이며 새 실행은 `source-priority-v2`를 기록한다. 과거 실행의 정책 버전과 결과는 수정하지 않는다.

정책 변경 승인 후 운영 DB에는 먼저 `npm run analysis -- source-policy-activate`를 실행한다. 이 명령은 운영 DB 백업을 만든 뒤 활성 정책과 사용자 승인 이벤트를 기록하며, 같은 내용의 재실행은 중복 반영하지 않는다.

## Codex 실행 순서

1. 사용자가 메일 갱신·사건 확인을 요청하면 Codex가 연결된 `easypat` MCP의 `easypat_status`를 호출한다.
2. 상태가 준비됨이고 사건 요약 조회가 활성화된 경우에만 전체 당소관리번호를 `easypat_get_matter_summary`에 전달한다. 접미사를 삭제하거나 기본번호로 축약하지 않는다.
3. 업무 상태·기일·진행 근거가 필요할 때 `easypat_list_progress`를 추가 호출한다.
4. 문서 존재나 첨부 근거가 필요한 경우에만 `easypat_list_documents`, `easypat_list_progress_documents`를 호출한다.
5. 첨부 내용이 필요한 경우 최신 목록을 다시 검증한 뒤 `easypat_download_progress_document`를 사용한다. PDF만 `easypat_extract_progress_document_pdf`로 허용 업무 필드를 추출한다.
6. MCP 응답의 `structuredContent`와 실제 호출 인수를 아래 형식으로 로컬 임시 JSON에 담아 신뢰된 CLI 브리지로 기록한다.

```json
{
  "tool": "easypat_get_matter_summary",
  "arguments": { "matterReference": "P261793" },
  "structuredContent": {
    "matterReference": "P261793",
    "rightType": "특허",
    "applicationKind": null,
    "applicationDivision": null,
    "applicationDate": null,
    "applicationNumber": null,
    "titleKorean": null,
    "status": null
  },
  "observedAt": "2026-09-18T09:00:00.000Z"
}
```

```powershell
cd dashboard
npm run analysis -- easypat-record <검증된-임시-JSON-경로>
```

임시 JSON은 메일 원문과 같은 방식으로 Git에 추가하지 않는다. 브리지는 도구별 허용 필드만 남기며 다운로드 결과의 로컬 경로, EasyPAT 내부키, SQL, 쿠키, 자격 증명과 세션 값은 운영 DB에 저장하지 않는다.

## 기록과 충돌 처리

- `decision_run.operation`: `easypat_source_verification`
- `input_snapshot.source_priority_version`: `source-priority-v2`
- `source_observation.source_type`: `easy_pat`
- `event.event_type`: `easy_pat_verified`
- 근거 식별자: 도구명과 허용 결과의 SHA-256

사건 요약 필드는 `easy_pat.summary.*`, 진행기록은 `easy_pat.progress`, 문서 목록은 `easy_pat.documents` 또는 `easy_pat.progress_documents`로 기록한다. 조회 결과를 업무 단계·현재상태에 바로 복사하지 않는다. 기존 값과 충돌하면 `decision_item`과 검토함을 통해 판단하며 사용자 확정값은 유지한다.

EasyPAT에서 확인한 사건이 운영 DB에 없으면 자동 생성하지 않고 미등록 사건 검토를 먼저 진행한다. MCP 실패, 준비 상태 아님, 요청·응답 번호 불일치, 0건·복수 결과는 EasyPAT 확인 성공으로 기록하지 않는다. 이때 사건등록 완료 메일과 Excel은 각각 자기 출처로만 사용할 수 있으며 EasyPAT 값으로 승격하지 않는다.

## 허용 도구와 경계

허용 도구는 다음 7개로 고정한다.

- `easypat_status`
- `easypat_get_matter_summary`
- `easypat_list_progress`
- `easypat_list_documents`
- `easypat_list_progress_documents`
- `easypat_download_progress_document`
- `easypat_extract_progress_document_pdf`

EasyPAT 서버의 쓰기·수정, 임의 SQL, 자동 재시도, 내부키 입력은 허용하지 않는다. 회사·사람·그룹처럼 MCP가 제공하지 않는 사실은 사건등록 완료 메일, Excel, 일반 메일과 사용자 확인으로 보완한다.
