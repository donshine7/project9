export type ApiReviewStatus =
  | 'reviewed' | 'needs_review' | 'evidence_stale' | 'missing'
  | 'duplicate_id' | 'conflict' | 'indexing' | 'up_to_date';

export type DisplayStatus =
  | 'approved' | 'proposal_reviewed' | 'needs_review' | 'evidence_stale'
  | 'missing' | 'duplicate_id' | 'conflict' | 'recovering' | 'up_to_date';

export type DocumentApproval = {
  eventId: string;
  reviewer: string;
  byteHash: string;
  evidenceSnapshotHash: string | null;
  approvedAt: string;
};

export type ApprovalAction = {
  allowed: boolean;
  code: string | null;
  reason: string | null;
  expectedRevisionId: string;
  expectedByteHash: string;
  expectedTextHash: string;
  expectedEvidenceSnapshotHash: string;
};

export type ReviewStateInput = {
  status: ApiReviewStatus;
  currentByteHash?: string | null;
  indexedByteHash?: string | null;
  indexStale?: boolean;
  parseStatus?: string | null;
  documentApproval?: DocumentApproval | null;
  proposalStatus?: string | null;
  proposalUpdatedAt?: string | null;
  recoveryStatus?: string | null;
};

export const displayStatusMeta: Record<DisplayStatus, { label: string; heading: string; guidance: string }> = {
  approved: {
    label: '문서 승인됨',
    heading: '현재 Markdown 원문이 승인되었습니다',
    guidance: '승인 이력은 현재 파일의 정확한 hash에만 적용됩니다. 업무 단계와 Action은 별도 DB 이력입니다.',
  },
  proposal_reviewed: {
    label: '제안 검토 완료',
    heading: 'AI 제안의 수동 반영을 검토했습니다',
    guidance: '이 기록은 현재 Markdown 원문 승인과 다릅니다. 파일 반영과 문서 원문 승인은 별도로 확인하세요.',
  },
  needs_review: {
    label: '검토 필요',
    heading: '현재 Markdown을 검토해야 합니다',
    guidance: '최신 파일과 근거를 확인한 뒤 문서 원문 승인 여부를 결정하세요.',
  },
  evidence_stale: {
    label: '근거 오래됨',
    heading: '제안에 사용한 근거가 바뀌었습니다',
    guidance: '현재 근거를 다시 확인하고 제안을 재생성한 뒤 검토하세요. 이전 승인을 재사용하지 않습니다.',
  },
  missing: {
    label: '문서 없음',
    heading: '색인된 경로에서 파일을 찾지 못했습니다',
    guidance: 'Vault의 경로와 파일을 확인하고 다시 색인하세요. 누락된 파일을 자동 생성하지 않습니다.',
  },
  duplicate_id: {
    label: 'ID 중복',
    heading: '같은 doc_id를 가진 파일이 둘 이상입니다',
    guidance: '중복 파일을 사람이 확인하고 각각의 doc_id를 정리한 뒤 다시 색인하세요.',
  },
  conflict: {
    label: '편집 충돌',
    heading: '현재 파일과 색인·검토 기준이 다릅니다',
    guidance: '사람이 편집한 파일을 보존하고 현재 내용, 색인 hash, 제안 기준을 대조하세요.',
  },
  recovering: {
    label: '복구 중',
    heading: '파일과 인덱스를 복구·대조하고 있습니다',
    guidance: '복구가 끝나고 최신 파일과 근거가 다시 검증될 때까지 승인할 수 없습니다.',
  },
  up_to_date: {
    label: '최신',
    heading: '최신 Markdown 파일이 색인되었습니다',
    guidance: '최신 표시는 문서 승인이나 업무 상태 확정을 뜻하지 않습니다.',
  },
};

export function displayStatus(input: ReviewStateInput): DisplayStatus {
  if (input.recoveryStatus === 'running' || input.status === 'indexing') return 'recovering';
  if (input.parseStatus === 'missing' || input.status === 'missing') return 'missing';
  if (input.parseStatus === 'duplicate' || input.status === 'duplicate_id') return 'duplicate_id';
  if (input.indexStale || input.status === 'conflict' || input.proposalStatus === 'stale_document') return 'conflict';
  if (input.status === 'evidence_stale' || input.proposalStatus === 'stale_evidence') return 'evidence_stale';
  if (input.status === 'reviewed'
    && input.documentApproval?.byteHash
    && input.documentApproval.byteHash === input.currentByteHash
    && (!input.proposalUpdatedAt || input.documentApproval.approvedAt >= input.proposalUpdatedAt)) return 'approved';
  if (input.status === 'reviewed') return 'proposal_reviewed';
  if (input.status === 'up_to_date') return 'up_to_date';
  return 'needs_review';
}

export function approvalBlockReason(input: ReviewStateInput, action?: ApprovalAction | null): string | null {
  const status = displayStatus(input);
  if (action && !action.allowed) {
    const message = action.reason || '현재 문서는 승인 조건을 충족하지 않습니다.';
    return action.code ? `[${action.code}] ${message}` : message;
  }
  if (status === 'approved') return '현재 파일은 이미 문서 승인되었습니다.';
  if (['recovering', 'missing', 'duplicate_id', 'conflict', 'evidence_stale'].includes(status)) {
    return displayStatusMeta[status].guidance;
  }
  if (!action) return '문서 원문 승인 API가 연결되면 승인할 수 있습니다.';
  if (!input.currentByteHash || input.currentByteHash !== input.indexedByteHash || input.currentByteHash !== action.expectedByteHash) {
    return '현재 파일 hash가 색인·승인 기준과 다릅니다. 다시 색인하세요.';
  }
  if (!action.expectedRevisionId || !action.expectedTextHash || !action.expectedEvidenceSnapshotHash) {
    return '검토할 개정 또는 근거 스냅샷이 없습니다.';
  }
  return null;
}

export function matchesReviewFilter(status: DisplayStatus, filter: 'all' | 'review' | 'issues'): boolean {
  if (filter === 'all') return true;
  if (filter === 'issues') return ['evidence_stale', 'missing', 'duplicate_id', 'conflict', 'recovering'].includes(status);
  return ['needs_review', 'proposal_reviewed', 'approved'].includes(status);
}
