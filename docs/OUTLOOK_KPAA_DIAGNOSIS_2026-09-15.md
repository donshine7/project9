# 대한변리사회 의무연수 안내 누락 원인과 조치

## 확인한 증거

- 사용자 지정 제목: `[재발송/안내] 변리사 의무연수 위반 과태료 국민비서 알림서비스 이용 안내`.
- Outlook 받은 편지함에서 원 안내(2026-09-15 17:00:45)와 재발송(17:21:41)을 확인했다. 두 메일의 SMTP 발신자는 `edu@kpaa.or.kr`, 표시명은 대한변리사회다.
- `대한변리사회 - 교육` 폴더는 해당 저장소 최상위에 존재한다.
- 저장된 OTM 소스를 읽기 전용으로 추출한 결과, `ThisOutlookSession.Application_NewMailEx`는 `HiworksRulesFinal.ClassifyIncomingMail`을 호출한다.
- `HiworksRules`에는 도메인 조건이 있지만 실제 호출되는 `HiworksRulesFinal`에는 `If senderAddress = "kpaa@kpaa.or.kr" Then`이 남아 있었다.

## 원인

수정한 모듈과 실제 이벤트가 호출하는 모듈이 달랐다. 실제 규칙은 `edu@kpaa.or.kr`을 허용하지 않았다. 제목의 재발송 접두사나 `연수` 키워드 부족, 대상 폴더 부재가 원인이 아니다. OTM 수정 시각만으로 결론을 내리지 않고 저장된 모듈과 이벤트 연결을 직접 비교했다.

## 반영

사용자의 화면 제어 승인 후 Computer Use로 실제 `HiworksRulesFinal`의 조건 한 줄을 아래와 같이 수정하고 VBA 프로젝트를 컴파일·저장했다.

```vb
If LCase$(Right$(Trim$(senderAddress), Len("@kpaa.or.kr"))) = "@kpaa.or.kr" Then
```

이후 기존 세부 분기를 유지한다: `경조사` → 경조사, `연수` → 교육, 나머지 → 기타. 따라서 지정 메일은 `대한변리사회 - 교육` 대상이다. 제목만으로 국민비서 또는 과태료 메일 전체를 분류하는 예외는 추가하지 않았다.

- 원본 VBA의 설명, 대시보드 규칙·이력, 정적 참고본, 구조도, 설치 안내와 회귀 테스트를 함께 갱신했다.
- 변경 전 OTM 백업: `.analysis-private/outlook-diagnostics/VbaProject-before-kpaa-20260915.OTM` (Git 제외).
- 저장 후 OTM을 다시 추출해 백업과 비교했다. 변경은 `HiworksRulesFinal` 조건 한 줄뿐이며, 다른 모듈과 이벤트 연결은 유지되었다.
- 기존 메일 이동·삭제·읽음 상태 변경·발송·일괄 재분류는 하지 않았다. 신규 수신을 통한 실제 자동 이동은 아직 관찰하지 않았다.
- 다른 과거 규칙의 설치 상태 전체를 이번 조치로 동기화한 것은 아니다.

## 검증

- `npm ci`, `npm run lint`, `npm run test:outlook-rules`, `npm run test:phase1`~`test:phase4`, `npm run build` 통과.
- 회귀 테스트는 안내·재발송, 교육 발신자, 대소문자·주소 앞뒤 공백, 경조사 우선순위, 일반 공지, 유사·확장 도메인 배제, 원본 모듈명과 이벤트 연결을 검증한다.
- 테스트의 JS 판정과 VBA 소스 구조 확인은 신규 메일 수신 이벤트의 종단간 검증과 구분한다.

## 2026-09-16 후속 동기화

경조사 제목 예외·기일관리 규칙·ChrW 한자 범위 보존을 포함한 원본 전체를 실제 `HiworksRulesFinal`에 반영하고 컴파일·저장했다. 저장된 OTM을 다시 읽어 원본과 일치를 확인했으며 다른 두 모듈 및 이벤트 연결은 보존했다. 기존 메일은 이동하지 않았다. 자세한 기록은 `OPERATIONAL_REFRESH_2026-09-16.md`를 참조한다.
