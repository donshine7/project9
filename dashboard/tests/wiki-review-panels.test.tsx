import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentApprovalPanel, ReviewStatePanel, WorkStateBoundary } from '../app/wiki/review-panels';
import type { ApprovalAction, ReviewStateInput } from '../app/wiki/review-model';

const hash = 'a'.repeat(64);
const input: ReviewStateInput = {
  status: 'needs_review',
  parseStatus: 'valid',
  currentByteHash: hash,
  indexedByteHash: hash,
};
const action: ApprovalAction = {
  allowed: true,
  code: null,
  reason: null,
  expectedRevisionId: 'synthetic-revision',
  expectedByteHash: hash,
  expectedTextHash: 'b'.repeat(64),
  expectedEvidenceSnapshotHash: 'c'.repeat(64),
};
const noOp = async () => {};

const pending = renderToStaticMarkup(createElement(ReviewStatePanel, { input }));
assert.match(pending, /data-review-status="needs_review"/);
assert.match(pending, /현재 Markdown을 검토해야 합니다/);

const approved = renderToStaticMarkup(createElement(ReviewStatePanel, {
  input: {
    ...input,
    status: 'reviewed',
    documentApproval: { eventId: 'synthetic-approval', reviewer: '장진태', byteHash: hash, evidenceSnapshotHash: 'c'.repeat(64), approvedAt: '2026-09-29T00:00:00Z' },
  },
}));
assert.match(approved, /data-review-status="approved"/);
assert.match(approved, /승인 이벤트 synthetic-approval/);

const proposalOnly = renderToStaticMarkup(createElement(ReviewStatePanel, { input: { ...input, status: 'reviewed' } }));
assert.match(proposalOnly, /제안 검토 완료/);
assert.doesNotMatch(proposalOnly, /data-review-status="approved"/);

const stale = renderToStaticMarkup(createElement(DocumentApprovalPanel, {
  input: { ...input, status: 'evidence_stale' }, action, busy: false, onApprove: noOp,
}));
assert.match(stale, /현재 근거를 다시 확인/);
assert.match(stale, /disabled=""/);

const eligible = renderToStaticMarkup(createElement(DocumentApprovalPanel, { input, action, busy: false, onApprove: noOp }));
assert.match(eligible, /현재 Markdown 원문과 근거를 직접 확인했습니다/);
assert.match(eligible, /disabled=""/, 'A confirmation is required before enabling document approval.');

const boundary = renderToStaticMarkup(createElement(WorkStateBoundary));
assert.match(boundary, /업무종류, 단계, 현재상태, Action/);
console.log('Wiki review panels synthetic rendering tests passed.');
