export type WorkflowStatus = '완료' | '현재' | '대기' | '차단' | '사용자 작업 필요';

export type WorkflowStage = {
  id: number;
  title: string;
  detail: string;
  userAction?: boolean;
};

export const workflowStages: WorkflowStage[] = [
  { id: 1, title: '프로젝트 정보 입력', detail: '프로젝트명과 PT 사건번호 목록을 사용자가 입력합니다.', userAction: true },
  { id: 2, title: '프로젝트 초기화', detail: '고정 PowerShell 스크립트가 안전한 작업 뼈대를 생성합니다.' },
  { id: 3, title: '원본 자료 투입', detail: '사용자가 10_source_original에 자료를 넣습니다.', userAction: true },
  { id: 4, title: '소스 분석·포트폴리오 설계', detail: '원본 기술자료를 분석하고 출원 포트폴리오를 설계합니다.' },
  { id: 5, title: 'JSON 계약 확정', detail: '특허 작성 계약과 사건 메타데이터를 확정합니다.' },
  { id: 6, title: '청구항 1 설계', detail: '독립항의 핵심 구성과 권리범위를 설계합니다.' },
  { id: 7, title: '도 2 및 대응 설명', detail: '대표 도면과 구성요소 대응 설명을 확정합니다.' },
  { id: 8, title: '나머지 본문·도면 작성', detail: '명세서 본문과 나머지 도면을 작성합니다.' },
  { id: 9, title: 'HWPX 직접 생성', detail: 'DOCX 변환 없이 HWPX를 직접 생성합니다.' },
  { id: 10, title: '독립 구조·의미 검사', detail: '문서 구조와 기술 의미를 독립적으로 검사합니다.' },
  { id: 11, title: '한글 렌더링', detail: 'HWPX를 렌더링해 페이지 이미지를 만듭니다.' },
  { id: 12, title: '전 페이지 시각 검수', detail: '사용자가 모든 페이지를 눈으로 검수합니다.', userAction: true },
  { id: 13, title: '검수 완료본 승격', detail: '검수 완료본을 outputs에 승격합니다.' },
];

export function stageStatus(stageId: number, currentStage: number, blocked = false): WorkflowStatus {
  if (stageId < currentStage) return '완료';
  if (stageId === currentStage) {
    if (blocked) return '차단';
    return workflowStages.find((stage) => stage.id === stageId)?.userAction ? '사용자 작업 필요' : '현재';
  }
  return '대기';
}
