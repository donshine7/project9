import assert from 'node:assert/strict';
import { createWikiApprovalAdapter } from '../app/wiki/review-adapter';
import {
  approvalBlockReason,
  displayStatus,
  displayStatusMeta,
  matchesReviewFilter,
  type ApprovalAction,
  type ReviewStateInput,
} from '../app/wiki/review-model';
import { wikiOperationView } from '../app/wiki/operation-model';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const action: ApprovalAction = {
  allowed: true,
  code: null,
  reason: null,
  expectedRevisionId: 'synthetic-revision-1',
  expectedByteHash: hash,
  expectedTextHash: 'c'.repeat(64),
  expectedEvidenceSnapshotHash: 'd'.repeat(64),
};
const base: ReviewStateInput = {
  status: 'needs_review',
  parseStatus: 'valid',
  currentByteHash: hash,
  indexedByteHash: hash,
};

const cases: Array<[ReviewStateInput, string]> = [
  [{ ...base, status: 'up_to_date' }, 'up_to_date'],
  [base, 'needs_review'],
  [{ ...base, status: 'reviewed' }, 'proposal_reviewed'],
  [{ ...base, status: 'reviewed', documentApproval: { eventId: 'synthetic-approval', reviewer: '장진태', byteHash: hash, evidenceSnapshotHash: 'd'.repeat(64), approvedAt: '2026-09-29T00:00:00Z' } }, 'approved'],
  [{ ...base, status: 'reviewed', proposalUpdatedAt: '2026-09-29T01:00:00Z', documentApproval: { eventId: 'old-approval', reviewer: '장진태', byteHash: hash, evidenceSnapshotHash: 'd'.repeat(64), approvedAt: '2026-09-29T00:00:00Z' } }, 'proposal_reviewed'],
  [{ ...base, status: 'needs_review', documentApproval: { eventId: 'old-approval', reviewer: '장진태', byteHash: hash, evidenceSnapshotHash: 'd'.repeat(64), approvedAt: '2026-09-29T00:00:00Z' } }, 'needs_review'],
  [{ ...base, status: 'evidence_stale', documentApproval: { eventId: 'old-approval', reviewer: '장진태', byteHash: hash, evidenceSnapshotHash: 'old', approvedAt: '2026-09-28T00:00:00Z' } }, 'evidence_stale'],
  [{ ...base, status: 'missing' }, 'missing'],
  [{ ...base, status: 'duplicate_id' }, 'duplicate_id'],
  [{ ...base, status: 'conflict' }, 'conflict'],
  [{ ...base, status: 'indexing' }, 'recovering'],
  [{ ...base, recoveryStatus: 'running' }, 'recovering'],
];
for (const [input, expected] of cases) {
  assert.equal(displayStatus(input), expected);
  assert.ok(displayStatusMeta[displayStatus(input)].guidance);
}
assert.equal(approvalBlockReason(base, action), null);
assert.match(approvalBlockReason({ ...base, status: 'reviewed' }, null) ?? '', /API/);
assert.match(approvalBlockReason({ ...base, indexedByteHash: otherHash }, action) ?? '', /hash/);
assert.match(approvalBlockReason({ ...base, status: 'duplicate_id' }, action) ?? '', /중복/);
assert.match(approvalBlockReason({ ...base, status: 'evidence_stale' }, action) ?? '', /근거/);
assert.equal(matchesReviewFilter('approved', 'review'), true);
assert.equal(matchesReviewFilter('conflict', 'issues'), true);
assert.equal(matchesReviewFilter('up_to_date', 'review'), false);

const reviewedProposal = {
  id: 'proposal-1', status: 'reviewed', baseByteHash: hash, targetByteHash: otherHash,
  evidenceSnapshotHash: 'd'.repeat(64),
  evidence: [{ validationStatus: 'valid' }],
  reviews: [{ action: 'accept_for_manual_apply', reviewedBaseByteHash: hash, reviewedEvidenceSnapshotHash: 'd'.repeat(64) }],
};
assert.equal(wikiOperationView(reviewedProposal, hash)?.state, 'ApprovalReady');
assert.equal(wikiOperationView({ ...reviewedProposal, autoApproval: {
  reviewedBaseByteHash: hash, reviewedTargetByteHash: otherHash, reviewedEvidenceSnapshotHash: 'd'.repeat(64),
} }, hash)?.state, 'AutoApproved');
assert.equal(wikiOperationView({ ...reviewedProposal, applyOperation: {
  id: 'operation-1', status: 'file_applied', attemptCount: 1,
} }, hash)?.state, 'Recoverable');
assert.equal(wikiOperationView({ ...reviewedProposal, applyOperation: {
  id: 'operation-2', status: 'conflict', errorCode: 'WIKI_AUTO_APPLY_BASE_CONFLICT',
} }, hash)?.state, 'Conflict');
assert.equal(wikiOperationView({ ...reviewedProposal, status: 'stale_evidence' }, hash)?.state, 'Stale');
assert.equal(wikiOperationView({ ...reviewedProposal, status: 'prepared' }, hash, { runtimeProfile: 'operational' })?.state, 'OperationalBlocked');
assert.equal(wikiOperationView({ ...reviewedProposal, applyOperation: {
  id: 'operation-3', status: 'file_applied', attemptCount: 1,
} }, hash, { runtimeProfile: 'operational' })?.state, 'OperationalBlocked');
assert.equal(wikiOperationView({ ...reviewedProposal, status: 'prepared' }, hash, { runtimeProfile: 'test' }), null);
assert.equal(wikiOperationView(null, null, { batchReadiness: { status: 'passed', blockers: [] } })?.state, 'BatchReady');
assert.equal(wikiOperationView(null, null, { batchReadiness: { status: 'failed', blockers: ['synthetic'] } })?.state, 'BatchBlocked');
assert.equal(wikiOperationView(null, null, { batchReadiness: { readyForPilot: true, blockers: [] } })?.state, 'BatchReady');
assert.equal(wikiOperationView(null, null, { batchReadiness: { readyForPilot: false, blockers: ['synthetic'] } })?.state, 'BatchBlocked');

function response(status: number, payload: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

async function main() {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let postCount = 0;
  const adapter = createWikiApprovalAdapter(async (url, init) => {
    requests.push({ url, init });
    if (!init) return response(200, action);
    postCount += 1;
    if (postCount === 1) return response(409, { code: 'WIKI_EDIT_CONFLICT', message: '합성 동시 편집 충돌' });
    return response(201, { eventId: 'synthetic-approval', docId: 'wiki/synthetic 1', revisionId: action.expectedRevisionId, byteHash: hash, evidenceSnapshotHash: action.expectedEvidenceSnapshotHash, status: 'approved' });
  }, () => 'synthetic-idempotency-key');

  assert.deepEqual(await adapter.preflight('wiki/synthetic 1'), action);
  await assert.rejects(adapter.approve('wiki/synthetic 1', action), /WIKI_EDIT_CONFLICT.*동시 편집 충돌/);
  const result = await adapter.approve('wiki/synthetic 1', action);
  assert.equal(result.status, 'approved');
  assert.equal(result.revisionId, action.expectedRevisionId);
  assert.equal(requests[0].url, '/api/wiki-review/documents/wiki%2Fsynthetic%201/approvals');
  const first = JSON.parse(String(requests[1].init?.body));
  const retry = JSON.parse(String(requests[2].init?.body));
  assert.equal(first.idempotencyKey, retry.idempotencyKey);
  assert.equal(first.expectedRevisionId, action.expectedRevisionId);
  assert.equal(first.expectedByteHash, hash);
  assert.equal(first.expectedTextHash, action.expectedTextHash);
  assert.equal(first.expectedEvidenceSnapshotHash, action.expectedEvidenceSnapshotHash);
  assert.match(first.statement, /원문과 근거/);
  assert.equal('reviewer' in first, false);
  const unavailable = createWikiApprovalAdapter(async () => response(404, { error: 'not found' }), () => 'unused');
  assert.equal(await unavailable.preflight('synthetic'), null);
  for (const [status, code] of [[401, 'WIKI_UNAUTHORIZED'], [409, 'WIKI_STALE'], [423, 'WIKI_RECOVERY_IN_PROGRESS']] as const) {
    const blocked = createWikiApprovalAdapter(async () => response(status, { code, message: '합성 승인 차단' }), () => 'unused');
    const preflight = await blocked.preflight('synthetic');
    assert.equal(preflight?.allowed, false);
    assert.equal(preflight?.code, code);
    assert.equal(preflight?.reason, '합성 승인 차단');
    assert.match(approvalBlockReason(base, preflight) ?? '', new RegExp(code));
  }
  const networkFailure = createWikiApprovalAdapter(async () => { throw new Error('합성 연결 실패'); }, () => 'unused');
  assert.equal((await networkFailure.preflight('synthetic'))?.allowed, false);
  await assert.rejects(networkFailure.approve('synthetic', action), /WIKI_APPROVAL_NETWORK_ERROR.*합성 연결 실패/);
  console.log('Wiki review UI state and approval adapter tests passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
