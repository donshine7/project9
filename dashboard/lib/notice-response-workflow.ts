export type ResponseNoticeKind = 'opinion_submission' | 'rejection_decision';
export type ResponseStageStatus = '완료' | '현재' | '대기' | '차단' | '사용자 작업 필요';

export type ResponseStageDefinition = {
  number: number;
  key: string;
  title: string;
  detail: string;
  userAction: boolean;
  artifactKind?: string;
};

const commonStages: ResponseStageDefinition[] = [
  { number: 1, key: 'identity', title: '통지·프로젝트 정보 확인', detail: '사건번호, 종류, 차수, 통지일, 기일과 원본 ZIP을 확인합니다.', userAction: true },
  { number: 2, key: 'initialization', title: '프로젝트 초기화·연결', detail: '고정 루트에서 경로와 ZIP 해시를 검증한 뒤 새 프로젝트를 만들거나 기존 프로젝트를 연결합니다.', userAction: false },
  { number: 3, key: 'codex_link', title: 'Codex 프로젝트·접수 작업 연결', detail: '사건 폴더를 로컬 프로젝트로 추가하고 _shared와 접수 작업을 연결합니다.', userAction: true },
  { number: 4, key: 'intake', title: '원본 접수·무결성 점검', detail: '통지 원본, 기일, 최신 버전과 선행 절차 자료의 누락 여부를 점검합니다.', userAction: false, artifactKind: 'intake_check' },
  { number: 5, key: 'analysis', title: '종류별 쟁점 분석', detail: '통지 종류에 맞는 쟁점과 원문 근거를 분석합니다.', userAction: false, artifactKind: 'issue_analysis' },
  { number: 6, key: 'strategy_compare', title: '대응 전략 비교', detail: '대응 선택지, 근거, 위험과 필요한 추가 사실을 비교합니다.', userAction: false, artifactKind: 'strategy_comparison' },
  { number: 7, key: 'strategy_approval', title: '전략·대응 경로 선택', detail: '작성에 사용할 전략 또는 대응 경로와 승인 범위를 선택합니다.', userAction: true },
  { number: 8, key: 'drafting', title: '승인 범위의 초안 작성', detail: '승인된 범위에 따라 제출 문서 초안을 작성합니다.', userAction: false, artifactKind: 'draft' },
  { number: 9, key: 'self_review', title: '작성자 자체검수', detail: '원문 근거, 변경 대응과 형식 오류를 자체 점검합니다.', userAction: false, artifactKind: 'self_review' },
  { number: 10, key: 'independent_review', title: '독립 최종검수', detail: '별도 검수 관점에서 사건 혼입, 근거, 기일과 제출 위험을 확인합니다.', userAction: false, artifactKind: 'independent_review' },
  { number: 11, key: 'submission_approval', title: '제출본 승인', detail: '제출할 특정 파일의 경로, 버전과 SHA-256을 승인합니다.', userAction: true },
  { number: 12, key: 'dispatch', title: '최종본 승격·외부 제출', detail: '승인 해시와 같은 파일을 90_final로 승격하고 외부 제출 결과를 기록합니다.', userAction: true },
  { number: 13, key: 'receipt', title: '접수증·결과 기록', detail: '접수증, 실제 제출 시각과 최종 제출 파일을 기록합니다.', userAction: true, artifactKind: 'filing_receipt' },
];

const kindOverrides: Record<ResponseNoticeKind, Partial<Record<number, Pick<ResponseStageDefinition, 'title' | 'detail'>>>> = {
  opinion_submission: {
    4: { title: 'OA 원본 접수', detail: '통지서, 최신 청구항, 명세서, 인용문헌과 기일을 대조합니다.' },
    5: { title: '거절이유 분석', detail: '청구항별 구성요소와 진보성·기재불비·기타 거절이유의 원문 근거를 정리합니다.' },
    6: { title: '보정·주장 전략 비교', detail: '보정 문언, 원출원 근거, 거절 해소 논리와 권리범위 위험을 비교합니다.' },
    7: { title: '적용 전략·보정 문언 선택', detail: '사용할 전략과 초안에 반영할 보정 문언·주장 범위를 승인합니다.' },
    8: { title: '의견서·보정서 초안 작성', detail: '승인된 전략만 반영해 의견서와 보정서 초안을 작성합니다.' },
  },
  rejection_decision: {
    4: { title: '거절결정 절차자료 접수', detail: '거절결정서, 이전 OA, 제출 의견서·보정서, 접수증과 현재 기일을 대조합니다.' },
    5: { title: '거절결정 비교 분석', detail: '이전 거절이유와 결정의 유지·변경·신규 판단을 항목별로 비교합니다.' },
    6: { title: '대응 경로 비교', detail: '근거로 확인된 대응 경로별 목표, 절차·기일 위험과 필요한 자료를 비교합니다.' },
    7: { title: '대응 경로·목표 범위 선택', detail: '진행할 대응 경로와 목표 권리범위, 비용·기일 우선순위를 승인합니다.' },
    8: { title: '선택 경로의 문서 초안 작성', detail: '선택한 경로에 필요한 문서와 이전 제출 내용 대조표를 작성합니다.' },
  },
};

export function responseStages(kind: ResponseNoticeKind): ResponseStageDefinition[] {
  const overrides = kindOverrides[kind] ?? {};
  return commonStages.map((stage) => ({ ...stage, ...overrides[stage.number] }));
}

export function responseStageKey(number: number) {
  if (number <= 3) return 'project_created';
  if (number === 4) return 'intake';
  if (number === 5) return 'analysis';
  if (number <= 7) return 'strategy';
  if (number <= 9) return 'drafting';
  if (number === 10) return 'review';
  if (number === 11) return 'awaiting_submission_approval';
  if (number === 12) return 'approved';
  return 'submitted';
}

export function defaultResponseAction(number: number) {
  if (number === 1) return { code: 'confirm_project_identity', summary: '의뢰인식별명, 프로젝트명, 통지 종류와 차수를 확인하세요.' };
  if (number === 3) return { code: 'connect_codex_project', summary: '사건 폴더를 Codex 로컬 프로젝트로 추가하고 접수 작업을 연결하세요.' };
  if (number === 7) return { code: 'select_strategy', summary: '40_strategy의 대응안 또는 대응 경로를 선택하세요.' };
  if (number === 11) return { code: 'approve_submission_copy', summary: '제출할 파일의 경로, 버전과 SHA-256을 승인하세요.' };
  if (number === 12) return { code: 'external_dispatch_required', summary: '승인된 90_final 파일의 외부 제출 결과를 기록하세요.' };
  if (number === 13) return { code: 'record_filing_receipt', summary: '접수증, 실제 제출 시각과 제출 파일을 기록하세요.' };
  return { code: null, summary: null };
}

export function responseStageStatus(stageNumber: number, currentStage: number, options: { completed?: boolean; blocked?: boolean; userActionCode?: string | null } = {}): ResponseStageStatus {
  if (options.completed || stageNumber < currentStage) return '완료';
  if (stageNumber > currentStage) return '대기';
  if (options.blocked) return '차단';
  if (options.userActionCode || defaultResponseAction(stageNumber).code) return '사용자 작업 필요';
  return '현재';
}
