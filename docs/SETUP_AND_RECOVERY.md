# 설치 및 복구 안내

## 1. 필수 환경

- Windows
- Outlook (classic)
- Outlook에 연결된 Hiworks 계정 `jtjang@sspat.net`
- Node.js 22.13 이상
- Codex에 등록된 로컬 `easypat` MCP 서버와 Windows 자격 증명 관리자 `EasyPAT/Automation`

메일 자동분류는 Outlook (classic)이 실행 중이고 새 메일을 가져올 때 동작합니다. 대시보드는 메일을 직접 읽거나 외부로 전송하지 않습니다.

## 2. Outlook VBA 설치

1. Outlook (classic)에서 `Alt+F11`을 눌러 VBA 편집기를 엽니다.
2. `파일 > 파일 가져오기`에서 프로젝트 루트의 `HiworksAutoClassifier.bas`를 선택합니다.
3. 프로젝트 탐색기에서 `Microsoft Outlook Objects > ThisOutlookSession`을 엽니다.
4. 프로젝트 루트의 `ThisOutlookSession_Hiworks.txt` 내용을 `ThisOutlookSession`에 붙여 넣습니다.
5. `디버그 > VBAProject 컴파일`을 실행합니다.
6. Outlook을 완전히 종료한 뒤 다시 실행합니다.

모듈 이름은 `HiworksRulesFinal`이어야 하며, 대상 Outlook 저장소 표시 이름은 `jtjang@sspat.net`입니다.

### 업데이트 시 주의: 실제 실행 모듈 확인

- `ThisOutlookSession.Application_NewMailEx`는 `HiworksRulesFinal.ClassifyIncomingMail`을 호출합니다. 비슷한 이름의 `HiworksRules`만 수정하면 새 메일 규칙에 반영되지 않습니다.
- 기존 `HiworksRulesFinal`을 먼저 내보내 백업하고 그 모듈을 수정합니다. 파일을 중복 가져와 다른 이름의 모듈이 생기지 않았는지 확인합니다.
- 저장소의 `.bas`는 UTF-8입니다. 가져오기 후 한글 조건과 폴더명이 깨지지 않았는지 확인하고 컴파일·저장합니다.
- 대한변리사회 조건은 특정 주소와의 동등 비교가 아니라 `@kpaa.or.kr` 도메인 끝 일치여야 합니다. `edu@kpaa.or.kr` + `의무연수` 제목은 `대한변리사회 - 교육`입니다.
- `hjlee@sspat.net` 직접 발신은 별도 해외 단서 없이 해외 신호가 되어야 합니다. 해외 비용·디자인·상표·특허 규칙을 먼저 적용하고, 세부 단서가 없는 `[업무전달] 부재중 전화 전달의 건`은 `해외 기타`가 됩니다. 이 주소가 수신자나 참조자일 뿐인 경우에는 기존처럼 해외 단서가 필요합니다.
- `mslee@sspat.net` 직접 발신은 제목·본문의 비해외 템플릿보다 먼저 판정하여 반드시 해외 폴더 중 하나로 보냅니다. 중국 가출원·PI·비용·디자인·상표·특허 규칙을 순서대로 적용하고, 세부 단서가 없으면 `해외 기타`로 보냅니다.
- `P261937-US`, `P211758-PCT-EP`, `T261420-UA`, `D231154-JP`처럼 전체 관리번호에 국가 접미사가 있으면 해외관리팀 참여자 여부와 무관하게 해외 사건으로 판정합니다. `P241750-RE`, `P262000-S1`, `P241667-DIV1`처럼 국가 접미사가 없는 관계 접미사는 이 규칙의 대상이 아닙니다.
- 프로젝트 원본 테스트 통과와 Outlook 설치 완료는 별개입니다. 실제 호출 모듈의 조건을 확인한 뒤 설치 완료로 기록합니다. 기존 메일 재분류는 별도 요청이 있을 때만 실행합니다.

### 2026-09-16 해외 기타 규칙 실행본 적용 체크

1. 실제 호출 모듈 `HiworksRulesFinal`을 먼저 내보내 OTM 백업과 별도의 `.bas` 백업을 남깁니다.
2. 이번 변경은 실행 모듈의 `IsOverseasMail`에서 `Dim hasOverseasTeam As Boolean` 바로 다음에 아래 분기만 추가해도 됩니다. 모듈 전체를 가져와 중복 모듈을 만드는 것보다 이 방식이 안전합니다.

```vb
    ' A direct message from the overseas-management sender is an overseas
    ' signal by itself. GetDestinationName still evaluates finance, design,
    ' trademark and patent before falling back to overseas-other.
    If GetSenderSmtpAddress(mail) = "hjlee@sspat.net" Then
        IsOverseasMail = True
        Exit Function
    End If
```

3. 저장 전에 실제 호출 모듈 이름이 계속 `HiworksRulesFinal`인지 확인합니다.
4. `디버그 > VBAProject 컴파일` 후 저장합니다.
5. `ThisOutlookSession.Application_NewMailEx`가 계속 `HiworksRulesFinal.ClassifyIncomingMail`을 호출하는지 확인합니다.
6. `ReclassifySelectedHiworksMail`과 일괄 재분류 매크로는 실행하지 않습니다. 신규 수신 메일로만 종단간 이동을 확인합니다.

## 3. 필요한 Outlook 최상위 폴더

다음 폴더는 Hiworks Outlook 저장소의 최상위에 있어야 합니다. 코드가 폴더를 임의로 만들지는 않으며, 없는 폴더로 분류되는 메일은 받은 편지함에 남습니다.

- 해외 출원 자동 안내
- 입금 내역
- 결재
- 대한변리사회 - 경조사
- 대한변리사회 - 교육
- 대한변리사회 - 기타
- 과제 자동 안내
- 사건등록
- 중국 가출원
- 해외 특허
- 국내특허 OA/ 우선심사 보완
- 국내특허 등록결정
- 과제 관련
- 해외 견적/청구/정산
- 해외 디자인
- 해외 상표
- 국내 특허
- 국내 상표
- 국내 디자인
- 해외 기타

## 4. Outlook 동작 확인

- 선택한 메일만 다시 분류: `ReclassifySelectedHiworksMail`
- 오늘 받은 Hiworks 메일 다시 분류: `ReclassifyTodayHiworksMail`
- 과거 국내 시리즈 오분류 보정: `ReclassifyDomesticPatentSeriesMail`
- 과거 EASYPAT_S 국내 OA 오분류 보정: `ReclassifyDomesticOaAssignmentMail`

재분류 매크로는 실제 메일을 이동할 수 있으므로 대상과 폴더를 확인한 뒤 실행합니다.

## 5. 대시보드 실행

프로젝트의 `dashboard\대시보드 실행.cmd`를 더블클릭합니다. 스크립트가 소스를 실행 전용 폴더로 복사하고 필요한 의존성을 설치한 뒤 로컬 브라우저를 엽니다.

명령 창을 닫으면 로컬 대시보드 서버도 종료됩니다.

### EasyPAT 원본 확인

- EasyPAT MCP는 대시보드 브라우저가 아니라 사용자의 요청을 받은 Codex 주 작업이 호출합니다.
- 먼저 `easypat_status`로 준비 상태를 확인하고 전체 당소관리번호를 그대로 조회합니다.
- MCP 결과는 `npm run analysis -- easypat-record <JSON_PATH>`로 허용 필드만 운영 DB에 기록합니다.
- 대시보드 사건 화면의 `EasyPAT 원본 확인`에서 마지막 확인 시각과 관측값을 확인합니다.
- 상세 절차와 실패 처리 기준은 `docs/EASYPAT_SOURCE_VERIFICATION.md`를 따릅니다.

## 6. 복구 시 확인 순서

1. Outlook 저장소 표시 이름이 `jtjang@sspat.net`인지 확인합니다.
2. 위 20개 최상위 폴더가 존재하는지 확인합니다.
3. VBA 모듈 이름과 `Application_NewMailEx` 이벤트 연결을 확인합니다.
4. `dashboard\대시보드 실행.cmd`가 `http://127.0.0.1:4173/`을 여는지 확인합니다.
5. `dashboard`에서 `npm ci`, `npm run lint`, `npm run build`를 실행합니다.
6. EasyPAT 조회가 필요하면 `easypat_status`가 준비 상태인지 확인하고, 실패 시 Excel이나 메일 값을 EasyPAT 확인값으로 표시하지 않습니다.
