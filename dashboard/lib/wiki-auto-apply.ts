import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { pathIsInside, resolveWikiVaultPath, runtimeProfile } from './runtime-environment';
import { parseWikiMarkdown, readWikiMarkdownSource, scanWikiMarkdownVault } from './wiki-markdown';
import { reconcileWikiMarkdownProposal, wikiProposalEvidenceSnapshot } from './wiki-proposal';
import { transaction, withDatabase, WorkDbError } from './work-db';
import {
  verifyOperationalAutoApplyGate,
  verifyOperationalVaultMatchesCheckpoint,
  type OperationalAutoApplyGate,
  type VerifiedOperationalAutoApplyGate,
} from './wiki-auto-apply-gate';
import type { AuthenticatedWikiReviewer } from './wiki-document-approval';

type Row = Record<string, any>;
type ApplyOptions = {
  reviewer?: string;
  confirmation: string;
  faultAfterFileApplied?: boolean;
  beforeReplace?: () => void;
  operationalGate?: OperationalAutoApplyGate;
  reviewerContext?: AuthenticatedWikiReviewer;
};

const now = () => new Date().toISOString();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function check(value: unknown, message: string, status = 400, code = 'WIKI_AUTO_APPLY_VALIDATION'): asserts value {
  if (!value) throw new WorkDbError(message, status, code);
}
function identifier(value: unknown, label: string) {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/.test(value), `${label} 형식이 올바르지 않습니다.`);
  return value;
}
function executionProfile(gate?: OperationalAutoApplyGate, reviewer?: AuthenticatedWikiReviewer) {
  const profile = runtimeProfile();
  if (profile !== 'operational') return { profile, verified: undefined as VerifiedOperationalAutoApplyGate | undefined };
  return { profile, verified: verifyOperationalAutoApplyGate(gate, reviewer) };
}

function operationalAuditBinding(verified: VerifiedOperationalAutoApplyGate) {
  return {
    authorizationId: verified.authorizationId,
    checkpointManifestSha256: verified.checkpointManifestSha256,
    restoreReportSha256: verified.restoreReportSha256,
    idempotencyKey: verified.idempotencyKey,
    reviewerContextJson: verified.reviewerContextJson,
  };
}

export async function approveWikiAutoApply(proposalId: string, expectedProposalVersion: number, reviewer = '장진태', operational?: Pick<ApplyOptions, 'operationalGate' | 'reviewerContext'>) {
  const { verified } = executionProfile(operational?.operationalGate, operational?.reviewerContext);
  identifier(proposalId, 'proposalId');
  check(reviewer === '장진태', '자동 반영 승인자는 인증된 사용자 장진태여야 합니다.', 403, 'WIKI_AUTO_APPLY_REVIEWER_INVALID');
  const reconciled = await reconcileWikiMarkdownProposal(proposalId);
  check(reconciled.status === 'reviewed' && !reconciled.evidenceStale && !reconciled.activeFileChanged, '현재 문서·근거와 일치하는 수동 검토 완료 제안이 필요합니다.', 409, 'WIKI_AUTO_APPLY_STALE');
  return withDatabase((db) => transaction(db, () => {
    const existing = db.prepare('SELECT * FROM wiki_auto_apply_approval WHERE proposal_id=?').get(proposalId) as Row | undefined;
    const proposal = db.prepare(`
      SELECT p.*,d.entity_type,d.entity_id
      FROM wiki_proposal p JOIN wiki_document d ON d.doc_id=p.doc_id
      WHERE p.id=?
    `).get(proposalId) as Row | undefined;
    check(proposal?.status === 'reviewed', '자동 반영할 검토 완료 제안을 찾을 수 없습니다.', 409, 'WIKI_AUTO_APPLY_REVIEW_REQUIRED');
    check(proposal.row_version === expectedProposalVersion, '제안이 변경되었습니다. 다시 검토하세요.', 409, 'WIKI_AUTO_APPLY_VERSION_CONFLICT');
    const manualReview = db.prepare(`SELECT * FROM wiki_proposal_review WHERE proposal_id=? AND action='accept_for_manual_apply' ORDER BY created_at DESC,id DESC LIMIT 1`).get(proposalId) as Row | undefined;
    check(manualReview && manualReview.reviewed_base_byte_hash === proposal.base_byte_hash && manualReview.reviewed_evidence_snapshot_hash === proposal.evidence_snapshot_hash, '현재 hash에 결합된 사람 검토가 필요합니다.', 409, 'WIKI_AUTO_APPLY_REVIEW_REQUIRED');
    if (verified) {
      verifyOperationalVaultMatchesCheckpoint(verified);
      const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(proposal.doc_id) as Row | undefined;
      check(document?.parse_status === 'valid' && document.byte_hash === proposal.base_byte_hash
        && document.current_revision_id === proposal.base_revision_id,
      '승인 시점의 문서 revision이 제안 base와 다릅니다.', 409, 'WIKI_AUTO_APPLY_STALE');
      const basePath = path.resolve(resolveWikiVaultPath(), ...String(document.relative_path).split('/'));
      check(pathIsInside(resolveWikiVaultPath(), basePath) && existsSync(basePath),
        '승인 문서 경로가 안전하지 않습니다.', 409, 'WIKI_AUTO_APPLY_PATH_BLOCKED');
      const info = lstatSync(basePath);
      check(info.isFile() && !info.isSymbolicLink() && realpathSync(basePath) === basePath
        && sha256(readFileSync(basePath)) === proposal.base_byte_hash,
      '승인 직전 사람 편집이 감지되었습니다.', 409, 'WIKI_AUTO_APPLY_BASE_CONFLICT');
      check(sha256(proposalBytes(proposal)) === proposal.target_byte_hash,
        '승인 대상 파일이 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_TARGET_MISMATCH');
      const evidence = wikiProposalEvidenceSnapshot(db, document.entity_type, document.entity_id);
      check(evidence.records.length > 0 && evidence.snapshotHash === proposal.evidence_snapshot_hash,
        '승인 근거가 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_EVIDENCE_STALE');
    }
    if (existing) {
      check(existing.reviewer === reviewer
        && existing.reviewed_base_byte_hash === proposal.base_byte_hash
        && existing.reviewed_target_byte_hash === proposal.target_byte_hash
        && existing.reviewed_evidence_snapshot_hash === proposal.evidence_snapshot_hash,
      '기존 자동 승인이 현재 제안과 다릅니다.', 409, 'WIKI_AUTO_APPLY_APPROVAL_STALE');
      if (verified) verifyOperationalApprovalEvent(db, existing, proposal, verified);
      return { approval: existing, duplicate: true };
    }
    const timestamp = now();
    const approvalId = randomUUID();
    const eventId = randomUUID();
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at) VALUES (?,?,?,?,?,?,'user_input',?,?)`)
      .run(eventId, proposal.entity_type, proposal.entity_id, 'wiki.proposal_auto_apply_approved', JSON.stringify({ proposalId, baseByteHash: proposal.base_byte_hash, targetByteHash: proposal.target_byte_hash, evidenceSnapshotHash: proposal.evidence_snapshot_hash, rowVersion: proposal.row_version, automaticApply: true, operationalGate: verified ? operationalAuditBinding(verified) : null }), reviewer, proposalId, timestamp);
    db.prepare(`INSERT INTO wiki_auto_apply_approval(id,proposal_id,reviewer,reviewed_base_byte_hash,reviewed_target_byte_hash,reviewed_evidence_snapshot_hash,approval_event_id,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(approvalId, proposalId, reviewer, proposal.base_byte_hash, proposal.target_byte_hash, proposal.evidence_snapshot_hash, eventId, timestamp);
    return { approval: db.prepare('SELECT * FROM wiki_auto_apply_approval WHERE id=?').get(approvalId), duplicate: false };
  }));
}

function proposalState(proposalId: string) {
  return withDatabase((db) => {
    const row = db.prepare(`
      SELECT p.*,d.relative_path,d.parse_status,d.current_revision_id,d.entity_type,d.entity_id,
             a.id AS approval_id,a.reviewer AS approval_reviewer,a.approval_event_id,a.reviewed_base_byte_hash,a.reviewed_target_byte_hash,a.reviewed_evidence_snapshot_hash
      FROM wiki_proposal p
      JOIN wiki_document d ON d.doc_id=p.doc_id
      LEFT JOIN wiki_auto_apply_approval a ON a.proposal_id=p.id
      WHERE p.id=?
    `).get(proposalId) as Row | undefined;
    check(row, 'Wiki 제안을 찾을 수 없습니다.', 404, 'WIKI_AUTO_APPLY_NOT_FOUND');
    return row;
  });
}

function proposalBytes(state: Row) {
  const vault = resolveWikiVaultPath();
  const resolvedVault = realpathSync(vault);
  const target = path.resolve(vault, ...String(state.proposal_relative_path).split('/'));
  check(pathIsInside(resolvedVault, target) && existsSync(target), '제안 파일이 Vault 안에 없습니다.', 409, 'WIKI_AUTO_APPLY_PROPOSAL_MISSING');
  const info = lstatSync(target);
  check(info.isFile() && !info.isSymbolicLink() && pathIsInside(resolvedVault, realpathSync(target)), '제안 파일 경로가 안전하지 않습니다.', 409, 'WIKI_AUTO_APPLY_PATH_BLOCKED');
  const bytes = readFileSync(target);
  check(sha256(bytes) === state.target_byte_hash, '제안 파일 hash가 승인 대상과 다릅니다.', 409, 'WIKI_AUTO_APPLY_TARGET_MISMATCH');
  const parsed = parseWikiMarkdown(bytes);
  check(parsed.frontmatter.doc_id === state.doc_id, '제안 파일의 doc_id가 다릅니다.', 409, 'WIKI_AUTO_APPLY_IDENTITY_MISMATCH');
  return bytes;
}

function durableTemporaryWrite(file: string, bytes: Buffer) {
  const descriptor = openSync(file, 'wx');
  try {
    writeSync(descriptor, bytes, 0, bytes.length, 0);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function markOperation(operationId: string, status: string, values: { errorCode?: string | null; revisionId?: string | null; eventId?: string | null; completed?: boolean } = {}) {
  const timestamp = now();
  withDatabase((db) => db.prepare(`UPDATE wiki_apply_operation SET status=?,error_code=?,applied_revision_id=COALESCE(?,applied_revision_id),apply_event_id=COALESCE(?,apply_event_id),updated_at=?,completed_at=? WHERE id=?`)
    .run(status, values.errorCode ?? null, values.revisionId ?? null, values.eventId ?? null, timestamp, values.completed ? timestamp : null, operationId));
}

function verifyOperationalApprovalEvent(db: import('node:sqlite').DatabaseSync, approval: Row, proposal: Row, verified: VerifiedOperationalAutoApplyGate) {
  const event = db.prepare('SELECT * FROM event WHERE id=?').get(approval.approval_event_id) as Row | undefined;
  const document = db.prepare('SELECT entity_type,entity_id FROM wiki_document WHERE doc_id=?').get(proposal.doc_id) as Row | undefined;
  check(event?.event_type === 'wiki.proposal_auto_apply_approved' && event.actor === '장진태'
    && event.source_type === 'user_input'
    && event.entity_type === document?.entity_type
    && event.entity_id === document?.entity_id
    && event.correlation_id === proposal.id,
  '운영 별도 승인 이벤트가 없습니다.', 409, 'WIKI_AUTO_APPLY_APPROVAL_STALE');
  const payload = JSON.parse(String(event.after_json ?? 'null')) as Row | null;
  check(payload?.proposalId === proposal.id
    && payload?.rowVersion === proposal.row_version
    && payload?.baseByteHash === proposal.base_byte_hash
    && payload?.targetByteHash === proposal.target_byte_hash
    && payload?.evidenceSnapshotHash === proposal.evidence_snapshot_hash
    && payload?.automaticApply === true
    && payload?.operationalGate?.authorizationId === verified.authorizationId
    && payload?.operationalGate?.checkpointManifestSha256 === verified.checkpointManifestSha256
    && payload?.operationalGate?.restoreReportSha256 === verified.restoreReportSha256
    && payload?.operationalGate?.idempotencyKey === verified.idempotencyKey
    && payload?.operationalGate?.reviewerContextJson === verified.reviewerContextJson,
  '운영 별도 승인이 현재 제안·체크포인트와 다릅니다.', 409, 'WIKI_AUTO_APPLY_APPROVAL_STALE');
}

function operationalReplaceCheck(db: import('node:sqlite').DatabaseSync, operationId: string, state: Row, source: Awaited<ReturnType<typeof readWikiMarkdownSource>>, verified: VerifiedOperationalAutoApplyGate) {
  const operation = db.prepare('SELECT * FROM wiki_apply_operation WHERE id=?').get(operationId) as Row | undefined;
  check(operation?.status === 'prepared'
    && operation.authorization_id === verified.authorizationId
    && operation.checkpoint_manifest_sha256 === verified.checkpointManifestSha256
    && operation.restore_report_sha256 === verified.restoreReportSha256
    && operation.idempotency_key === verified.idempotencyKey
    && operation.reviewer_context_json === verified.reviewerContextJson,
  '작업 승인·체크포인트 결합이 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_GATE_BINDING_CHANGED');
  const proposal = db.prepare('SELECT * FROM wiki_proposal WHERE id=?').get(state.id) as Row | undefined;
  const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(state.doc_id) as Row | undefined;
  const mode = db.prepare('SELECT source_mode FROM wiki_document_source_mode WHERE doc_id=?').get(state.doc_id) as Row | undefined;
  const approval = db.prepare('SELECT * FROM wiki_auto_apply_approval WHERE id=?').get(state.approval_id) as Row | undefined;
  const manual = db.prepare("SELECT * FROM wiki_proposal_review WHERE proposal_id=? AND action='accept_for_manual_apply' ORDER BY created_at DESC,id DESC LIMIT 1").get(state.id) as Row | undefined;
  check(proposal?.status === 'reviewed' && proposal.row_version === operation.approved_row_version
    && proposal.base_byte_hash === operation.base_byte_hash
    && proposal.target_byte_hash === operation.target_byte_hash
    && proposal.evidence_snapshot_hash === operation.approved_evidence_snapshot_hash
    && proposal.base_revision_id === operation.approved_revision_id
    && proposal.proposal_relative_path === operation.approved_proposal_relative_path
    && proposal.doc_id === operation.doc_id,
  '제안 버전·hash가 준비 이후 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_STALE');
  check(document?.parse_status === 'valid' && document.relative_path === operation.relative_path
    && document.current_revision_id === operation.approved_revision_id
    && document.byte_hash === operation.base_byte_hash
    && mode?.source_mode === operation.approved_source_mode,
  '문서 경로·revision·원본 모드가 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_SOURCE_CHANGED');
  const revision = db.prepare('SELECT * FROM wiki_markdown_revision WHERE id=? AND doc_id=?').get(operation.approved_revision_id, operation.doc_id) as Row | undefined;
  check(revision?.relative_path === operation.relative_path && revision?.byte_hash === operation.base_byte_hash,
    '문서 revision이 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_SOURCE_CHANGED');
  check(approval?.proposal_id === proposal.id && approval?.reviewer === '장진태'
    && approval?.reviewed_base_byte_hash === proposal.base_byte_hash
    && approval?.reviewed_target_byte_hash === proposal.target_byte_hash
    && approval?.reviewed_evidence_snapshot_hash === proposal.evidence_snapshot_hash
    && manual?.reviewed_base_byte_hash === proposal.base_byte_hash
    && manual?.reviewed_evidence_snapshot_hash === proposal.evidence_snapshot_hash,
  '별도 자동 승인 또는 수동 검토가 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_APPROVAL_STALE');
  verifyOperationalApprovalEvent(db, approval!, proposal, verified);
  const evidence = wikiProposalEvidenceSnapshot(db, document.entity_type, document.entity_id);
  check(evidence.records.length > 0 && evidence.snapshotHash === proposal.evidence_snapshot_hash,
  '근거 스냅샷이 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_EVIDENCE_STALE');
  const invalid = db.prepare("SELECT COUNT(*) AS n FROM wiki_proposal_evidence WHERE proposal_id=? AND validation_status!='valid'").get(state.id) as Row;
  check(Number(invalid.n) === 0, '근거 항목이 유효하지 않습니다.', 409, 'WIKI_AUTO_APPLY_EVIDENCE_STALE');
  const currentPath = path.resolve(resolveWikiVaultPath(), ...String(document.relative_path).split('/'));
  check(pathIsInside(resolveWikiVaultPath(), currentPath) && currentPath === source.absolutePath,
    '파일 경로가 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_SOURCE_CHANGED');
  const info = lstatSync(currentPath);
  check(info.isFile() && !info.isSymbolicLink() && realpathSync(currentPath) === currentPath,
    '원본 파일 경로가 안전하지 않습니다.', 409, 'WIKI_AUTO_APPLY_PATH_BLOCKED');
  check(sha256(readFileSync(currentPath)) === proposal.base_byte_hash,
    '사람 편집으로 base hash가 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_BASE_CONFLICT');
  check(sha256(proposalBytes(proposal)) === proposal.target_byte_hash,
    '제안 target hash가 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_TARGET_MISMATCH');
  return currentPath;
}

async function finalizeOperation(operationId: string) {
  const operation = withDatabase((db) => db.prepare(`SELECT o.*,p.evidence_snapshot_hash,p.status AS proposal_status,d.entity_type,d.entity_id,d.current_revision_id,d.byte_hash,d.parse_status FROM wiki_apply_operation o JOIN wiki_proposal p ON p.id=o.proposal_id JOIN wiki_document d ON d.doc_id=o.doc_id WHERE o.id=?`).get(operationId) as Row | undefined);
  check(operation, '자동 반영 operation을 찾을 수 없습니다.', 404, 'WIKI_AUTO_APPLY_OPERATION_NOT_FOUND');
  if (operation.status === 'succeeded') return { operation, duplicate: true };
  const source = await readWikiMarkdownSource(operation.doc_id);
  check(!source.indexStale && source.byteHash === operation.target_byte_hash && operation.byte_hash === operation.target_byte_hash, '적용 파일과 인덱스가 target hash에 도달하지 않았습니다.', 409, 'WIKI_AUTO_APPLY_INDEX_MISMATCH');
  return withDatabase((db) => transaction(db, () => {
    const current = db.prepare('SELECT * FROM wiki_apply_operation WHERE id=?').get(operationId) as Row;
    if (current.status === 'succeeded') return { operation: current, duplicate: true };
    const revision = db.prepare('SELECT * FROM wiki_markdown_revision WHERE id=? AND doc_id=? AND byte_hash=?').get(source.document.current_revision_id, operation.doc_id, operation.target_byte_hash) as Row | undefined;
    check(revision, '자동 적용 revision을 찾을 수 없습니다.', 409, 'WIKI_AUTO_APPLY_REVISION_MISSING');
    db.prepare("UPDATE wiki_markdown_revision SET origin='ai_applied' WHERE id=?").run(revision.id);
    const timestamp = now();
    const eventId = randomUUID();
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at) VALUES (?,?,?,?,?,'장진태','user_input',?,?)`)
      .run(eventId, operation.entity_type, operation.entity_id, 'wiki.proposal_auto_applied', JSON.stringify({ proposalId: operation.proposal_id, operationId, baseByteHash: operation.base_byte_hash, targetByteHash: operation.target_byte_hash, revisionId: revision.id, automaticApply: true, authorizationId: operation.authorization_id ?? null, checkpointManifestSha256: operation.checkpoint_manifest_sha256 ?? null, restoreReportSha256: operation.restore_report_sha256 ?? null, reviewerContext: operation.reviewer_context_json ? JSON.parse(operation.reviewer_context_json) : null, idempotencyKey: operation.idempotency_key ?? null }), operationId, timestamp);
    db.prepare("UPDATE wiki_proposal SET status='applied_observed',row_version=row_version+1,updated_at=? WHERE id=?").run(timestamp, operation.proposal_id);
    db.prepare("UPDATE wiki_apply_operation SET status='succeeded',applied_revision_id=?,apply_event_id=?,error_code=NULL,updated_at=?,completed_at=? WHERE id=?")
      .run(revision.id, eventId, timestamp, timestamp, operationId);
    return { operation: db.prepare('SELECT * FROM wiki_apply_operation WHERE id=?').get(operationId), duplicate: false };
  }));
}

async function applyPreparedOperation(operationId: string, state: Row, source: Awaited<ReturnType<typeof readWikiMarkdownSource>>, bytes: Buffer, options: Pick<ApplyOptions, 'faultAfterFileApplied' | 'beforeReplace'> = {}, verified?: VerifiedOperationalAutoApplyGate) {
  const temporary = path.join(path.dirname(source.absolutePath), `.${path.basename(source.absolutePath)}.${operationId}.tmp`);
  try {
    if (verified) verifyOperationalVaultMatchesCheckpoint(verified);
    check(!existsSync(temporary), '기존 자동 반영 임시파일이 있습니다.', 409, 'WIKI_AUTO_APPLY_TEMP_EXISTS');
    durableTemporaryWrite(temporary, bytes);
    options.beforeReplace?.();
    if (verified) {
      withDatabase((db) => transaction(db, () => {
        operationalReplaceCheck(db, operationId, state, source, verified);
        // Keep the DB write lock through the last file check and atomic replacement.
        renameSync(temporary, source.absolutePath);
        check(sha256(readFileSync(source.absolutePath)) === state.target_byte_hash,
          '파일 교체 결과가 target hash와 다릅니다.', 409, 'WIKI_AUTO_APPLY_REPLACE_FAILED');
        db.prepare("UPDATE wiki_apply_operation SET status='file_applied',updated_at=? WHERE id=?").run(now(), operationId);
      }));
      const scan = await scanWikiMarkdownVault();
      markOperation(operationId, 'indexed');
      const finalized = await finalizeOperation(operationId);
      return { ...finalized, scanId: scan.scanId };
    }
    const currentHash = sha256(readFileSync(source.absolutePath));
    if (currentHash !== state.base_byte_hash) {
      rmSync(temporary, { force: true });
      markOperation(operationId, 'conflict', { errorCode: 'WIKI_AUTO_APPLY_BASE_CONFLICT', completed: true });
      throw new WorkDbError('사람 편집이 감지되어 자동 반영을 중단했습니다.', 409, 'WIKI_AUTO_APPLY_BASE_CONFLICT');
    }
    renameSync(temporary, source.absolutePath);
    check(sha256(readFileSync(source.absolutePath)) === state.target_byte_hash, '원자적 교체 결과 hash가 다릅니다.', 409, 'WIKI_AUTO_APPLY_REPLACE_FAILED');
    markOperation(operationId, 'file_applied');
    if (options.faultAfterFileApplied) throw new WorkDbError('합성 중단: 파일 적용 후 인덱싱 전', 500, 'WIKI_AUTO_APPLY_TEST_FAULT');
    const scan = await scanWikiMarkdownVault();
    markOperation(operationId, 'indexed');
    const finalized = await finalizeOperation(operationId);
    return { ...finalized, scanId: scan.scanId };
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    const current = withDatabase((db) => db.prepare('SELECT status FROM wiki_apply_operation WHERE id=?').get(operationId) as Row | undefined);
    if (current && !['file_applied', 'conflict', 'succeeded'].includes(current.status)) markOperation(operationId, 'failed', { errorCode: error instanceof WorkDbError ? error.code : 'WIKI_AUTO_APPLY_FAILED', completed: true });
    throw error;
  }
}

export async function executeWikiAutoApply(proposalId: string, options: ApplyOptions) {
  const { profile, verified } = executionProfile(options.operationalGate, options.reviewerContext);
  identifier(proposalId, 'proposalId');
  check((options.reviewer ?? '장진태') === '장진태', '자동 반영 실행자는 인증된 사용자 장진태여야 합니다.', 403, 'WIKI_AUTO_APPLY_REVIEWER_INVALID');
  check(options.confirmation === 'APPLY', '자동 반영 확인 문자열이 올바르지 않습니다.', 400, 'WIKI_AUTO_APPLY_CONFIRMATION_REQUIRED');
  check(['test', 'eval'].includes(profile) || (!options.faultAfterFileApplied && !options.beforeReplace), 'fault hook은 test/eval 프로필에서만 허용합니다.', 400, 'WIKI_AUTO_APPLY_TEST_HOOK_BLOCKED');
  const existing = withDatabase((db) => db.prepare('SELECT * FROM wiki_apply_operation WHERE proposal_id=?').get(proposalId) as Row | undefined);
  if (existing) {
    if (verified) check(existing.authorization_id === verified.authorizationId
      && existing.checkpoint_manifest_sha256 === verified.checkpointManifestSha256
      && existing.restore_report_sha256 === verified.restoreReportSha256
      && existing.idempotency_key === verified.idempotencyKey
      && existing.reviewer_context_json === verified.reviewerContextJson,
    '기존 작업의 운영 승인 결합이 다릅니다.', 409, 'WIKI_AUTO_APPLY_GATE_BINDING_CHANGED');
    if (existing.status === 'succeeded') return { operation: existing, duplicate: true };
    return recoverWikiAutoApply(existing.id, options);
  }
  const reconciled = await reconcileWikiMarkdownProposal(proposalId);
  check(reconciled.status === 'reviewed' && !reconciled.evidenceStale && !reconciled.activeFileChanged, '사람 편집 또는 근거 변경으로 자동 반영할 수 없습니다.', 409, 'WIKI_AUTO_APPLY_STALE');
  const state = proposalState(proposalId);
  check(state.approval_id && state.approval_reviewer === '장진태', '별도 자동 반영 승인이 필요합니다.', 409, 'WIKI_AUTO_APPLY_APPROVAL_REQUIRED');
  check(state.reviewed_base_byte_hash === state.base_byte_hash && state.reviewed_target_byte_hash === state.target_byte_hash && state.reviewed_evidence_snapshot_hash === state.evidence_snapshot_hash, '자동 반영 승인 hash가 현재 제안과 다릅니다.', 409, 'WIKI_AUTO_APPLY_APPROVAL_STALE');
  if (verified) withDatabase((db) => {
    const approval = db.prepare('SELECT * FROM wiki_auto_apply_approval WHERE id=?').get(state.approval_id) as Row;
    verifyOperationalApprovalEvent(db, approval, state, verified);
  });
  check(state.parse_status === 'valid', '유효한 활성 문서가 필요합니다.', 409, 'WIKI_AUTO_APPLY_DOCUMENT_INVALID');
  const source = await readWikiMarkdownSource(state.doc_id);
  check(!source.indexStale && source.byteHash === state.base_byte_hash, '활성 파일이 승인된 base hash와 다릅니다.', 409, 'WIKI_AUTO_APPLY_BASE_CONFLICT');
  const bytes = proposalBytes(state);
  const operationId = `wiki-auto-apply-${sha256(`${proposalId}:${state.approval_id}`).slice(0, 24)}`;
  const timestamp = now();
  withDatabase((db) => transaction(db, () => {
    const mode = db.prepare('SELECT source_mode FROM wiki_document_source_mode WHERE doc_id=?').get(state.doc_id) as Row | undefined;
    if (verified) check(mode?.source_mode && state.current_revision_id === source.document.current_revision_id,
      '문서 원본 모드 또는 revision이 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_SOURCE_CHANGED');
    db.prepare(`INSERT INTO wiki_apply_operation(id,proposal_id,approval_id,doc_id,status,base_byte_hash,target_byte_hash,relative_path,created_at,updated_at,authorization_id,checkpoint_manifest_sha256,restore_report_sha256,reviewer_context_json,idempotency_key,approved_row_version,approved_evidence_snapshot_hash,approved_source_mode,approved_revision_id,approved_proposal_relative_path)
      VALUES (?,?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(operationId, proposalId, state.approval_id, state.doc_id, state.base_byte_hash, state.target_byte_hash, state.relative_path, timestamp, timestamp,
        verified?.authorizationId ?? null, verified?.checkpointManifestSha256 ?? null, verified?.restoreReportSha256 ?? null,
        verified?.reviewerContextJson ?? null, verified?.idempotencyKey ?? null, verified ? state.row_version : null,
        verified ? state.evidence_snapshot_hash : null, verified ? mode?.source_mode : null,
        verified ? state.current_revision_id : null, verified ? state.proposal_relative_path : null);
  }));
  return applyPreparedOperation(operationId, state, source, bytes, options, verified);
}

export async function recoverWikiAutoApply(operationId: string, options: Pick<ApplyOptions, 'operationalGate' | 'reviewerContext'> = {}) {
  const { verified } = executionProfile(options.operationalGate, options.reviewerContext);
  identifier(operationId, 'operationId');
  const operation = withDatabase((db) => db.prepare('SELECT * FROM wiki_apply_operation WHERE id=?').get(operationId) as Row | undefined);
  check(operation, '자동 반영 operation을 찾을 수 없습니다.', 404, 'WIKI_AUTO_APPLY_OPERATION_NOT_FOUND');
  if (verified) check(operation.authorization_id === verified.authorizationId
    && operation.checkpoint_manifest_sha256 === verified.checkpointManifestSha256
    && operation.restore_report_sha256 === verified.restoreReportSha256
    && operation.idempotency_key === verified.idempotencyKey
    && operation.reviewer_context_json === verified.reviewerContextJson,
  '복구 요청의 운영 승인·체크포인트 결합이 다릅니다.', 409, 'WIKI_AUTO_APPLY_GATE_BINDING_CHANGED');
  if (operation.status === 'succeeded') return { operation, duplicate: true };
  check(!['conflict', 'failed'].includes(operation.status), '충돌 또는 실패한 operation은 자동 복구하지 않습니다.', 409, 'WIKI_AUTO_APPLY_MANUAL_RECOVERY_REQUIRED');
  const state = proposalState(operation.proposal_id);
  const source = await readWikiMarkdownSource(operation.doc_id);
  if (verified) {
    verifyOperationalVaultMatchesCheckpoint(verified, [
      String(operation.relative_path),
      String(source.revision?.history_object_path ?? ''),
    ]);
    check(operation.status === 'prepared' || operation.status === 'file_applied' || operation.status === 'indexed',
      '이 상태는 자동 복구할 수 없습니다.', 409, 'WIKI_AUTO_APPLY_MANUAL_RECOVERY_REQUIRED');
    withDatabase((db) => transaction(db, () => {
      const proposal = db.prepare('SELECT * FROM wiki_proposal WHERE id=?').get(operation.proposal_id) as Row | undefined;
      const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(operation.doc_id) as Row | undefined;
      const mode = db.prepare('SELECT source_mode FROM wiki_document_source_mode WHERE doc_id=?').get(operation.doc_id) as Row | undefined;
      const approval = db.prepare('SELECT * FROM wiki_auto_apply_approval WHERE id=?').get(operation.approval_id) as Row | undefined;
      const revision = document?.current_revision_id
        ? db.prepare('SELECT * FROM wiki_markdown_revision WHERE id=? AND doc_id=?').get(document.current_revision_id, operation.doc_id) as Row | undefined
        : undefined;
      check(proposal?.row_version === operation.approved_row_version
        && proposal?.evidence_snapshot_hash === operation.approved_evidence_snapshot_hash
        && proposal?.base_byte_hash === operation.base_byte_hash
        && proposal?.target_byte_hash === operation.target_byte_hash
        && proposal?.base_revision_id === operation.approved_revision_id
        && proposal?.proposal_relative_path === operation.approved_proposal_relative_path
        && document?.relative_path === operation.relative_path
        && mode?.source_mode === operation.approved_source_mode
        && approval?.reviewed_base_byte_hash === operation.base_byte_hash
        && approval?.reviewed_target_byte_hash === operation.target_byte_hash
        && approval?.reviewed_evidence_snapshot_hash === operation.approved_evidence_snapshot_hash,
      '복구 전 승인·문서 상태가 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_RECOVERY_STALE');
      verifyOperationalApprovalEvent(db, approval!, proposal!, verified);
      const evidence = wikiProposalEvidenceSnapshot(db, document!.entity_type, document!.entity_id);
      check(evidence.records.length > 0 && evidence.snapshotHash === operation.approved_evidence_snapshot_hash,
        '복구 전 근거가 변경되었습니다.', 409, 'WIKI_AUTO_APPLY_RECOVERY_STALE');
      if (source.byteHash === operation.target_byte_hash && !source.indexStale) {
        const historyPath = path.resolve(resolveWikiVaultPath(), ...String(revision?.history_object_path ?? '').split('/'));
        check(revision?.byte_hash === operation.target_byte_hash
          && pathIsInside(resolveWikiVaultPath(), historyPath)
          && existsSync(historyPath)
          && sha256(readFileSync(historyPath)) === operation.target_byte_hash,
        '복구 대상 revision 이력이 target hash와 다릅니다.', 409, 'WIKI_AUTO_APPLY_RECOVERY_STALE');
      }
      check(path.resolve(resolveWikiVaultPath(), ...String(operation.relative_path).split('/')) === source.absolutePath
        && [operation.base_byte_hash, operation.target_byte_hash].includes(source.byteHash),
      '복구 파일의 경로 또는 hash가 base/target과 다릅니다.', 409, 'WIKI_AUTO_APPLY_RECOVERY_CONFLICT');
    }));
  }
  if (source.byteHash === operation.base_byte_hash && !source.indexStale) {
    withDatabase((db) => db.prepare('UPDATE wiki_apply_operation SET attempt_count=attempt_count+1,updated_at=? WHERE id=?').run(now(), operationId));
    check(operation.status === 'prepared', 'file_applied operation의 파일이 base로 돌아갔습니다. 수동 복구가 필요합니다.', 409, 'WIKI_AUTO_APPLY_MANUAL_RECOVERY_REQUIRED');
    return applyPreparedOperation(operationId, state, source, proposalBytes(state), {}, verified);
  }
  if (source.byteHash !== operation.target_byte_hash) {
    markOperation(operationId, 'conflict', { errorCode: 'WIKI_AUTO_APPLY_RECOVERY_CONFLICT', completed: true });
    throw new WorkDbError('현재 파일이 base/target 어느 hash와도 일치하지 않습니다.', 409, 'WIKI_AUTO_APPLY_RECOVERY_CONFLICT');
  }
  if (source.indexStale || source.document.byte_hash !== operation.target_byte_hash) await scanWikiMarkdownVault();
  markOperation(operationId, 'indexed');
  return finalizeOperation(operationId);
}

export function wikiAutoApplyStatus(operationId: string) {
  identifier(operationId, 'operationId');
  return withDatabase((db) => {
    const operation = db.prepare('SELECT * FROM wiki_apply_operation WHERE id=?').get(operationId) as Row | undefined;
    check(operation, '자동 반영 operation을 찾을 수 없습니다.', 404, 'WIKI_AUTO_APPLY_OPERATION_NOT_FOUND');
    return {
      operation,
      approval: db.prepare('SELECT * FROM wiki_auto_apply_approval WHERE id=?').get(operation.approval_id),
      proposal: db.prepare('SELECT * FROM wiki_proposal WHERE id=?').get(operation.proposal_id),
      event: operation.apply_event_id ? db.prepare('SELECT * FROM event WHERE id=?').get(operation.apply_event_id) : null,
    };
  });
}
