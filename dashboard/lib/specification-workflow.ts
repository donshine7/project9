export const SPECIFICATION_STAGE_KEYS = [
  'intake',
  'analysis',
  'concretization',
  'points',
  'claims',
  'drafting',
  'review',
  'final',
] as const;

export type SpecificationStageKey = (typeof SPECIFICATION_STAGE_KEYS)[number];

export const specificationStages = [
  { key: 'intake', number: 1, title: '발명 자료 정리', detail: '원본 자료와 발명자 설명을 목록화하고 사실·추정·누락을 구분합니다.', humanAction: true },
  { key: 'analysis', number: 2, title: '자료 분석·방향 확정', detail: '해결 과제, 핵심 구성과 창작 방향을 확인합니다.', humanAction: true },
  { key: 'concretization', number: 3, title: '발명 창작 구체화', detail: '방법 발명은 입력·처리·출력·기능을 동작 순서로 연결하고 dangling 데이터를 제거합니다.', humanAction: false },
  { key: 'points', number: 4, title: '특허 포인트 창작', detail: '구체화된 구성에 차별화되는 기술적 수단과 효과를 만들고 필요한 수학식을 정의합니다.', humanAction: true },
  { key: 'claims', number: 5, title: '청구항 설계', detail: '독립항에서 종속항으로 구체화하며 종속항에는 수학식을 쓰지 않습니다.', humanAction: true },
  { key: 'drafting', number: 6, title: '명세서 초안 작성', detail: '확정된 구성과 청구항을 기준으로 설명·도면·요약서를 작성합니다.', humanAction: false },
  { key: 'review', number: 7, title: '검수', detail: '자체검수, 독립검수와 렌더링 검수를 수행하고 근거·참조·해시를 확인합니다.', humanAction: true },
  { key: 'final', number: 8, title: '최종본 확정', detail: '승인된 산출물을 동결하고 최종 사용본을 확정합니다.', humanAction: true },
] as const;

export const specificationSetupSteps = [
  { key: 'case_info', number: 1, title: '사건 정보 입력', detail: '사건번호, 의뢰인 식별명, 서비스·발명 유형, 담당자와 창작 방향을 입력합니다.', actor: '사용자' },
  { key: 'copy_preview', number: 2, title: '복사 계획 검증', detail: '프로젝트폴더샘플의 파일 목록과 목적지 중복 여부를 dry-run으로 확인합니다.', actor: '시스템' },
  { key: 'folder_creation', number: 3, title: '사건 폴더 생성', detail: '검증한 계획과 같은 샘플을 복사하고 case.yaml을 사건 값으로 초기화합니다.', actor: '시스템' },
  { key: 'codex_setup', number: 4, title: 'Codex 프로젝트 설정', detail: '사건 폴더를 기본 폴더로, _shared를 추가 폴더로 설정합니다.', actor: '사용자' },
  { key: 'source_materials', number: 5, title: '발명 자료 배치', detail: '원본은 10_source_original, 선행 자료는 20_prior_art에 넣고 파일을 확인합니다.', actor: '사용자' },
  { key: 'intake_start', number: 6, title: '첫 작업 시작', detail: '제공된 접수 프롬프트로 Codex 작업을 시작하고 작업 식별자를 기록합니다.', actor: '사용자' },
] as const;

export function specificationStageNumber(value: unknown) {
  const index = SPECIFICATION_STAGE_KEYS.indexOf(String(value ?? '') as SpecificationStageKey);
  return index < 0 ? 1 : index + 1;
}
export function specificationStageStatus(stageNumber: number, currentStage: number, completed = false) {
  if (completed || stageNumber < currentStage) return '완료' as const;
  if (stageNumber === currentStage) return '현재' as const;
  return '대기' as const;
}
