# 프로젝트 정보

- 프로젝트명: 상상업무자동화
- 프로젝트 루트: `C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화`
- 운영 환경: Windows, Outlook (classic), Node.js 22.13 이상
- 대시보드 주소: `http://127.0.0.1:4173/`
- Git 원격 저장소: `https://github.com/donshine7/project9.git`

## 현재 구현 범위

- Hiworks POP3 메일의 Outlook 신규 수신 이벤트 연결
- 21단계 우선순위에 따른 사건·업무 메일 분류
- 기존 오분류 메일의 선택·당일·국내 시리즈·국내 OA 재분류 기능
- 메일 정책과 폴더 체계를 보여주는 로컬 운영판
- 한국특허 가출원 프로젝트 목록 및 13단계 진행 상태 표시
- 검증·스테이징·원자적 이동을 사용하는 가출원 프로젝트 초기화

## 소스 기준

- Outlook 실행 코드: `HiworksAutoClassifier.bas`, `ThisOutlookSession_Hiworks.txt`
- 대시보드 실행 코드: `dashboard/app`, `dashboard/local-api.ts`, `dashboard/scripts`
- 정책 데이터: `dashboard/app/data.ts`
- 구조 문서: `docs/architecture.mmd`
