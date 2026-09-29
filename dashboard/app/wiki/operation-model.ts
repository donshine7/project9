export type WikiOperationState =
  | 'ManualReviewed'
  | 'ApprovalReady'
  | 'AutoApproved'
  | 'Stale'
  | 'Conflict'
  | 'Recoverable'
  | 'OperationalBlocked'
  | 'BatchReady'
  | 'BatchBlocked';

export type WikiOperationView = {
  state: WikiOperationState;
  label: string;
  reason: string;
  nextAction: string;
  tone: 'reviewed' | 'success' | 'danger' | 'info' | 'warning';
};

type Row = Record<string, any>;

export type WikiOperationContext = {
  runtimeProfile?: string | null;
  batchReadiness?: {
    status?: string | null;
    readyForPilot?: boolean | null;
    blockers?: unknown[] | null;
  } | null;
};

export function wikiBatchOperationView(context: WikiOperationContext = {}): WikiOperationView | null {
  const readiness = context.batchReadiness;
  if (!readiness) return null;
  const ready = readiness.status === 'passed' || readiness.readyForPilot === true;
  const blocked = readiness.status === 'failed' || readiness.readyForPilot === false;
  if (!ready && !blocked) return null;
  const blockerCount = Array.isArray(readiness.blockers) ? readiness.blockers.length : 0;
  return ready ? {
    state: 'BatchReady', label: '배치 준비 완료', tone: 'success',
    reason: '읽기 전용 준비도 검사가 통과했습니다. 이 상태만으로 운영 실행이 승인되지는 않습니다.',
    nextAction: '평가 수치·임계값·run을 확인한 뒤 별도 운영 승인을 받으세요.',
  } : {
    state: 'BatchBlocked', label: '배치 확대 차단', tone: 'warning',
    reason: blockerCount ? `준비도 검사에서 ${blockerCount}개 차단 사유가 확인됐습니다.` : '준비도 검사가 통과되지 않았습니다.',
    nextAction: '차단 사유를 해소하고 새 읽기 전용 준비도 검사를 실행하세요.',
  };
}

export function wikiOperationView(
  proposal: Row | null | undefined,
  currentByteHash?: string | null,
  context: WikiOperationContext = {},
): WikiOperationView | null {
  if (!proposal) return wikiBatchOperationView(context);
  const operation = proposal.applyOperation as Row | null | undefined;
  const approval = proposal.autoApproval as Row | null | undefined;
  if (operation && ['conflict', 'failed'].includes(String(operation.status))) return {
    state: 'Conflict', label: '자동 반영 충돌', tone: 'danger',
    reason: operation.errorCode ? `작업 ${operation.id} · ${operation.errorCode}` : `작업 ${operation.id}이 수동 확인을 요구합니다.`,
    nextAction: '현재 파일과 작업 이력을 비교하고 자동 복구하지 마세요.',
  };
  if (['stale_document', 'stale_evidence', 'failed'].includes(String(proposal.status))
    || (currentByteHash && proposal.baseByteHash && currentByteHash !== proposal.baseByteHash && operation?.status !== 'succeeded')) return {
    state: 'Stale', label: '승인 근거 변경', tone: 'danger',
    reason: '검토 뒤 문서 또는 근거가 변경되어 기존 승인을 재사용할 수 없습니다.',
    nextAction: '다시 색인하고 현재 문서·근거로 새 제안을 검토하세요.',
  };
  if (operation && ['prepared', 'file_applied', 'indexed'].includes(String(operation.status))) return {
    state: 'Recoverable', label: '검증 후 복구 가능', tone: 'info',
    reason: `작업 ${operation.id} · ${operation.status} · 시도 ${operation.attemptCount ?? 1}회`,
    nextAction: '같은 승인·체크포인트 결합으로 상태를 조회한 뒤 복구하세요.',
  };
  const approvalMatches = Boolean(approval
    && approval.reviewedBaseByteHash === proposal.baseByteHash
    && approval.reviewedTargetByteHash === proposal.targetByteHash
    && approval.reviewedEvidenceSnapshotHash === proposal.evidenceSnapshotHash);
  if (approvalMatches) return {
    state: 'AutoApproved',
    label: operation?.status === 'succeeded' ? '자동 반영 완료' : '자동 반영 별도 승인',
    tone: 'success',
    reason: operation?.status === 'succeeded'
      ? `작업 ${operation.id}이 완료되어 감사 이력에 기록되었습니다.`
      : 'base·target·근거 hash에 결합된 별도 승인이 있습니다.',
    nextAction: operation?.status === 'succeeded'
      ? '재색인된 target hash와 완료 이벤트를 확인하세요.'
      : '운영 작업창에서 현재 파일과 게이트를 다시 검증한 뒤 적용하세요.',
  };
  if (proposal.status === 'reviewed' && currentByteHash === proposal.baseByteHash
    && proposal.reviews?.some((review: Row) => review.action === 'accept_for_manual_apply'
      && review.reviewedBaseByteHash === proposal.baseByteHash
      && review.reviewedEvidenceSnapshotHash === proposal.evidenceSnapshotHash)
    && proposal.evidence?.every((item: Row) => item.validationStatus === 'valid')) return {
    state: 'ApprovalReady', label: '별도 승인 준비', tone: 'success',
    reason: '수동 검토, 현재 base, 제안 target, 근거 스냅샷이 일치합니다.',
    nextAction: '작성기 중지·체크포인트·복원 리허설을 갖춘 운영 작업창에서 별도 승인하세요.',
  };
  if (proposal.status === 'reviewed') return {
    state: 'ManualReviewed', label: '수동 검토 완료', tone: 'reviewed',
    reason: 'AI 제안의 수동 반영 검토 이력은 있으나 운영 자동반영 조건은 아직 충족되지 않았습니다.',
    nextAction: '현재 base·target·근거 hash를 다시 대조하세요.',
  };
  if (context.runtimeProfile === 'operational') return {
    state: 'OperationalBlocked', label: '자동 반영 차단', tone: 'warning',
    reason: '운영 프로필이며 이 제안은 수동 검토 완료 상태가 아닙니다.',
    nextAction: '문서와 근거를 검토하고 제안 상태를 확정하세요.',
  };
  return null;
}
