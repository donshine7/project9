# 설치 및 복구 안내

## 1. 필수 환경

- Windows
- Outlook (classic)
- Outlook에 연결된 Hiworks 계정 `jtjang@sspat.net`
- Node.js 22.13 이상

메일 자동분류는 Outlook (classic)이 실행 중이고 새 메일을 가져올 때 동작합니다. 대시보드는 메일을 직접 읽거나 외부로 전송하지 않습니다.

## 2. Outlook VBA 설치

1. Outlook (classic)에서 `Alt+F11`을 눌러 VBA 편집기를 엽니다.
2. `파일 > 파일 가져오기`에서 프로젝트 루트의 `HiworksAutoClassifier.bas`를 선택합니다.
3. 프로젝트 탐색기에서 `Microsoft Outlook Objects > ThisOutlookSession`을 엽니다.
4. 프로젝트 루트의 `ThisOutlookSession_Hiworks.txt` 내용을 `ThisOutlookSession`에 붙여 넣습니다.
5. `디버그 > VBAProject 컴파일`을 실행합니다.
6. Outlook을 완전히 종료한 뒤 다시 실행합니다.

모듈 이름은 `HiworksRulesFinal`이어야 하며, 대상 Outlook 저장소 표시 이름은 `jtjang@sspat.net`입니다.

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

## 6. 복구 시 확인 순서

1. Outlook 저장소 표시 이름이 `jtjang@sspat.net`인지 확인합니다.
2. 위 20개 최상위 폴더가 존재하는지 확인합니다.
3. VBA 모듈 이름과 `Application_NewMailEx` 이벤트 연결을 확인합니다.
4. `dashboard\대시보드 실행.cmd`가 `http://127.0.0.1:4173/`을 여는지 확인합니다.
5. `dashboard`에서 `npm ci`, `npm run lint`, `npm run build`를 실행합니다.
