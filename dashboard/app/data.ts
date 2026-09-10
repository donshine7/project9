export type RuleCategory = '고정' | '국내' | '해외' | '기타';

export type Rule = {
  id: string;
  priority: number;
  category: RuleCategory;
  condition: string;
  destination: string;
  note: string;
};

export const dashboardMeta = {
  title: '상상특허 업무 자동화',
  subtitle: 'Hiworks · Outlook (classic) 운영 대시보드',
  account: 'jtjang@sspat.net',
  module: 'HiworksRulesFinal',
  trigger: 'Application_NewMailEx',
  lastUpdated: '2026.09.10',
  scope: '새로 수신되는 메일',
};

export const rules: Rule[] = [
  {
    id: 'R01',
    priority: 1,
    category: '고정',
    condition: '발신자 sspat99@sspat.net + 제목에 “해외출원안내”',
    destination: '해외 출원 자동 안내',
    note: '사무소 자동발신 템플릿',
  },
  {
    id: 'R02',
    priority: 2,
    category: '고정',
    condition: '발신자 sspat99@sspat.net + 제목에 “입금내역이 추가되었습니다”',
    destination: '입금 내역',
    note: '사무소 자동발신 템플릿',
  },
  {
    id: 'R03',
    priority: 3,
    category: '고정',
    condition: '발신자 sspat99@sspat.net + 제목에 “EasyPAT 결재 시스템”',
    destination: '결재',
    note: '사무소 자동발신 템플릿',
  },
  {
    id: 'R04',
    priority: 4,
    category: '기타',
    condition: '발신자 kpaa@kpaa.or.kr + 제목에 “경조사”',
    destination: '대한변리사회 - 경조사',
    note: '대한변리사회 메일 세부 분기',
  },
  {
    id: 'R05',
    priority: 5,
    category: '기타',
    condition: '발신자 kpaa@kpaa.or.kr + 제목에 “연수”',
    destination: '대한변리사회 - 교육',
    note: '기존 “교육” 폴더 사용',
  },
  {
    id: 'R06',
    priority: 6,
    category: '기타',
    condition: '발신자 kpaa@kpaa.or.kr + R04·R05에 해당하지 않음',
    destination: '대한변리사회 - 기타',
    note: '동일 발신자의 잔여 메일',
  },
  {
    id: 'R07',
    priority: 7,
    category: '기타',
    condition: '발신자 1357@kised.or.kr 또는 제목에 모집/사업 공고',
    destination: '과제 자동 안내',
    note: '공백 유무 모두 인식',
  },
  {
    id: 'R08',
    priority: 8,
    category: '국내',
    condition: '제목에 “[업무전달]”과 “사건등록 완료”가 모두 있음',
    destination: '사건등록',
    note: '공백을 제거한 뒤 두 문구를 모두 확인',
  },
  {
    id: 'R09',
    priority: 9,
    category: '해외',
    condition: '제목에 “중국”과 “가출원”이 모두 있음',
    destination: '중국 가출원',
    note: '일반 해외 규칙보다 우선',
  },
  {
    id: 'R10',
    priority: 10,
    category: '해외',
    condition: '제목에 PI + 숫자 6자리 사건번호',
    destination: '해외 특허',
    note: '인커밍 사건이며 비용 문구보다 우선',
  },
  {
    id: 'R11',
    priority: 11,
    category: '국내',
    condition: '국내 P + 숫자 6자리 + “등록결정서 접수 보고”',
    destination: '국내특허 등록결정',
    note: 'PT·PI 사건번호는 국내 P로 보지 않음',
  },
  {
    id: 'R12',
    priority: 12,
    category: '국내',
    condition: '국내 P + 숫자 6자리 + 지정된 업무요청 제목 템플릿',
    destination: '국내특허 OA/ 우선심사 보완',
    note: '의견제출통지서 대응 또는 우선심사신청보완요구서',
  },
  {
    id: 'R13',
    priority: 13,
    category: '기타',
    condition: '과제팀 참여자 + 과제 관련 핵심어',
    destination: '과제 관련',
    note: '참여자만으로는 분류하지 않음',
  },
  {
    id: 'R14',
    priority: 14,
    category: '해외',
    condition: '해외 사건으로 확정 + 견적·청구·송금·정산 핵심어',
    destination: '해외 견적/청구/정산',
    note: 'PI 사건은 R10이 먼저 적용',
  },
  {
    id: 'R15',
    priority: 15,
    category: '해외',
    condition: '해외 사건으로 확정 + 디자인 관련 핵심어',
    destination: '해외 디자인',
    note: '제목과 새로 작성된 본문을 확인',
  },
  {
    id: 'R16',
    priority: 16,
    category: '해외',
    condition: '해외 사건으로 확정 + 상표 관련 핵심어',
    destination: '해외 상표',
    note: '제목과 새로 작성된 본문을 확인',
  },
  {
    id: 'R17',
    priority: 17,
    category: '해외',
    condition: '해외 사건으로 확정 + 특허 관련 핵심어',
    destination: '해외 특허',
    note: '제목과 새로 작성된 본문을 확인',
  },
  {
    id: 'R18',
    priority: 18,
    category: '국내',
    condition: '해외 사건이 아니고 P + 숫자 6자리만 존재',
    destination: '국내 특허',
    note: 'P/T/D 중 사건 종류가 하나로 명확해야 함',
  },
  {
    id: 'R19',
    priority: 19,
    category: '국내',
    condition: '해외 사건이 아니고 T + 숫자 6자리만 존재',
    destination: '국내 상표',
    note: 'P/T/D 중 사건 종류가 하나로 명확해야 함',
  },
  {
    id: 'R20',
    priority: 20,
    category: '국내',
    condition: '해외 사건이 아니고 D + 숫자 6자리만 존재',
    destination: '국내 디자인',
    note: 'P/T/D 중 사건 종류가 하나로 명확해야 함',
  },
  {
    id: 'R21',
    priority: 21,
    category: '해외',
    condition: '해외 사건으로 확정됐으나 분야를 특정할 수 없음',
    destination: '해외 기타',
    note: '최종 해외 안전망',
  },
];

export const folderGroups = [
  {
    name: '국내 사건',
    tone: 'blue',
    folders: [
      '국내 특허',
      '국내 상표',
      '국내 디자인',
      '국내특허 등록결정',
      '국내특허 OA/ 우선심사 보완',
      '입금 내역',
      '결재',
      '사건등록',
    ],
  },
  {
    name: '해외 사건',
    tone: 'violet',
    folders: [
      '해외 특허',
      '해외 상표',
      '해외 디자인',
      '해외 견적/청구/정산',
      '해외 출원 자동 안내',
      '중국 가출원',
      '해외 기타',
    ],
  },
  {
    name: '기타 메일',
    tone: 'amber',
    folders: [
      '과제 자동 안내',
      '과제 관련',
      '대한변리사회 - 교육',
      '대한변리사회 - 경조사',
      '대한변리사회 - 기타',
    ],
  },
];

export const overseasSignals = [
  'mslee@sspat.net · 이명삼 부장 · 해외관리팀',
  'hjlee@sspat.net · 이효정 과장 · 해외관리팀',
  'jtjang@sspat.net · 장진태 · 전자4팀/해외관리팀 (발신 시)',
  '제목과 인용·서명을 제외한 새 본문이 모두 영문',
];

export const executionMap = [
  {
    action: '메일 수신',
    location: 'Hiworks 메일 서버',
    detail: '메일 원본을 수신하고 POP3로 제공합니다.',
    condition: '서버 상시 운영',
  },
  {
    action: '새 메일 가져오기',
    location: '사용자 PC · Outlook (classic)',
    detail: 'POP3S 995 연결로 새 메일을 내려받습니다.',
    condition: 'Outlook (classic) 실행 및 보내기/받기',
  },
  {
    action: '신규 메일 감지',
    location: 'Outlook (classic) · ThisOutlookSession',
    detail: 'Application_NewMailEx 이벤트가 VBA를 호출합니다.',
    condition: 'Outlook 매크로 사용 허용',
  },
  {
    action: '분류 판단',
    location: 'Outlook (classic) 내부 VBA · HiworksRulesFinal',
    detail: '21단계 규칙을 위에서부터 판정합니다.',
    condition: '첫 일치 규칙 하나만 적용',
  },
  {
    action: '폴더 이동',
    location: '사용자 PC · Outlook 데이터 파일',
    detail: 'jtjang@sspat.net 저장소의 기존 최상위 폴더로 이동합니다.',
    condition: '대상 폴더가 존재할 때만 이동',
  },
  {
    action: '운영 현황 표시',
    location: '사용자 PC · 로컬 브라우저',
    detail: '127.0.0.1:4173에서 정책과 변경 이력을 표시합니다.',
    condition: '대시보드 로컬 서버 실행',
  },
  {
    action: '정책·이력 갱신',
    location: '사용자 PC · Codex 프로젝트 작업공간',
    detail: '실행 코드, 대시보드 데이터, 구조 문서를 함께 갱신합니다.',
    condition: '자동화 작업을 변경할 때마다',
  },
];

export const changeLog = [
  {
    date: '2026.09.10',
    title: '최종 Outlook 분류 정책 적용',
    detail: 'VBA 모듈 컴파일, NewMailEx 연결, 충돌 기본 규칙 4개 제거',
    status: '완료',
  },
  {
    date: '2026.09.10',
    title: '분류 경계조건 검증',
    detail: '샘플 13건 및 사건등록·PT·PI 예외조건 판정 확인',
    status: '완료',
  },
  {
    date: '2026.09.10',
    title: '로컬 운영 대시보드 구축',
    detail: '운영 상태, 규칙, 폴더, 구조, 변경 이력 통합',
    status: '완료',
  },
  {
    date: '2026.09.10',
    title: '동작별 실행 위치 명시',
    detail: 'Hiworks 서버, Outlook (classic), Outlook VBA, 로컬 대시보드의 역할을 분리 표기',
    status: '완료',
  },
  {
    date: '2026.09.10',
    title: '사건등록을 국내 사건으로 편입',
    detail: '사건등록 규칙과 폴더를 국내 사건 그룹으로 이동하고 기타 메일 수를 조정',
    status: '완료',
  },
];

export const roadmap = [
  {
    phase: '현재',
    title: 'Outlook (classic) 자동분류',
    detail: '사용자 PC의 classic 앱이 새 메일을 VBA 정책으로 기존 폴더에 이동',
    state: 'active',
  },
  {
    phase: '다음',
    title: '읽기 전용 운영 집계',
    detail: '분류 건수·미분류 건수·오류를 대시보드에 자동 반영',
    state: 'next',
  },
  {
    phase: '계획',
    title: '결정적 업무 파이프라인',
    detail: '사건번호, 날짜, 스레드, 상태를 도구 기반으로 정규화',
    state: 'planned',
  },
  {
    phase: '계획',
    title: '검토·Wiki 투영',
    detail: '고위험 항목은 사람 검토 후 업무 상태와 Wiki에 반영',
    state: 'planned',
  },
];
