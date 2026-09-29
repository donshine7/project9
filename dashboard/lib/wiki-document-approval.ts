import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { pathIsInside } from './runtime-environment';
import {
  canonicalWikiDocumentEvidence as canonical,
  wikiDocumentEvidenceSnapshot,
  WikiDocumentEvidenceMissingError,
  type WikiDocumentEvidenceEvent,
} from './wiki-document-evidence';
import { parseWikiMarkdown, readWikiMarkdownSource } from './wiki-markdown';
import { transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;

export type WikiDocumentApprovalInput = {
  docId: string;
  expectedRevisionId: string;
  expectedByteHash: string;
  expectedTextHash: string;
  expectedEvidenceSnapshotHash: string;
  idempotencyKey: string;
  statement: string;
};

// This identity must be constructed by the HTTP authentication boundary, never from request JSON.
export type AuthenticatedWikiReviewer = {
  actorId: string;
  authenticated: true;
  authenticationMethod: string;
};

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/;

function check(value: unknown, message: string, status = 400, code = 'WIKI_DOCUMENT_APPROVAL_INVALID'): asserts value {
  if (!value) throw new WorkDbError(message, status, code);
}

function evidenceSnapshot(db: DatabaseSync, document: Row, markdown: string) {
  try {
    const snapshot = wikiDocumentEvidenceSnapshot(markdown, (id) => {
      const event = db.prepare('SELECT * FROM event WHERE id=?').get(id) as Row | undefined;
      if (!event) return undefined;
      check(event.entity_type === document.entity_type && event.entity_id === document.entity_id,
        `근거 이벤트가 다른 엔티티에 속합니다: ${id}`, 409, 'WIKI_DOCUMENT_APPROVAL_EVIDENCE_INVALID');
      return event as WikiDocumentEvidenceEvent;
    });
    check(snapshot.eventIds.length > 0, '원문 승인에는 인용된 근거 이벤트가 필요합니다.', 409, 'WIKI_DOCUMENT_APPROVAL_EVIDENCE_REQUIRED');
    return snapshot;
  } catch (error) {
    if (error instanceof WikiDocumentEvidenceMissingError) {
      throw new WorkDbError(`근거 이벤트가 없습니다: ${error.eventId}`, 409, 'WIKI_DOCUMENT_APPROVAL_EVIDENCE_STALE');
    }
    throw error;
  }
}

function sourceSnapshot(db: DatabaseSync, source: Awaited<ReturnType<typeof readWikiMarkdownSource>>, requireLegacyMode = false) {
  const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(source.document.doc_id) as Row | undefined;
  check(document?.parse_status === 'valid', '유효한 문서 인덱스가 필요합니다.', 409, 'WIKI_DOCUMENT_APPROVAL_STALE');
  const revision = document.current_revision_id
    ? db.prepare('SELECT * FROM wiki_markdown_revision WHERE id=? AND doc_id=?').get(document.current_revision_id, document.doc_id) as Row | undefined
    : undefined;
  check(revision, '현재 Markdown revision이 없습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_STALE');
  const mode = db.prepare('SELECT * FROM wiki_document_source_mode WHERE doc_id=?').get(document.doc_id) as Row | undefined;
  check(mode, '문서 원본 모드 기록이 없습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_SOURCE_MODE');
  check(!requireLegacyMode || (mode.source_mode === 'legacy_db' && mode.legacy_entity_type === document.entity_type && mode.legacy_entity_id === document.entity_id),
    '원문 승인은 legacy DB 원본 문서에만 허용됩니다.', 409, 'WIKI_DOCUMENT_APPROVAL_SOURCE_MODE');
  // Re-read inside the SQLite write transaction so an edit between preview and commit is rejected.
  let bytes: Buffer;
  let parsed: ReturnType<typeof parseWikiMarkdown>;
  try {
    const fileStat = lstatSync(source.absolutePath);
    check(fileStat.isFile() && !fileStat.isSymbolicLink()
      && pathIsInside(realpathSync(source.vaultRoot), realpathSync(source.absolutePath)),
    '문서 파일 경로가 변경되었습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_STALE');
    bytes = readFileSync(source.absolutePath);
    parsed = parseWikiMarkdown(bytes);
  } catch (error) {
    if (error instanceof WorkDbError) throw error;
    throw new WorkDbError('문서 파일을 다시 검증할 수 없습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_STALE');
  }
  const byteHash = sha256(bytes);
  const textHash = sha256(parsed.normalized);
  check(parsed.frontmatter.doc_id === document.doc_id
    && parsed.frontmatter.entity_type === document.entity_type
    && parsed.frontmatter.entity_id === document.entity_id
    && document.relative_path === revision.relative_path
    && document.byte_hash === revision.byte_hash
    && document.text_hash === revision.text_hash
    && document.byte_hash === byteHash
    && document.text_hash === textHash,
  '문서 파일·인덱스·revision이 일치하지 않습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_STALE');
  const evidence = evidenceSnapshot(db, document, parsed.normalized);
  return { document, revision, mode, byteHash, textHash, ...evidence };
}

async function loadSource(docId: string) {
  try {
    return await readWikiMarkdownSource(docId);
  } catch (error) {
    if (error instanceof WorkDbError && error.status === 404) throw error;
    throw new WorkDbError('문서 파일·인덱스를 다시 검증할 수 없습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_STALE');
  }
}

function validateInput(input: WikiDocumentApprovalInput, reviewer: AuthenticatedWikiReviewer) {
  check(reviewer?.authenticated === true && reviewer.actorId === '장진태'
    && typeof reviewer.authenticationMethod === 'string' && reviewer.authenticationMethod.trim().length > 0,
  '인증된 검토자 장진태만 원문을 승인할 수 있습니다.', 403, 'WIKI_DOCUMENT_APPROVAL_REVIEWER_INVALID');
  check(input && idPattern.test(input.docId), 'docId 형식 오류');
  check(idPattern.test(input.expectedRevisionId), 'revision ID 형식 오류');
  check(hashPattern.test(input.expectedByteHash) && hashPattern.test(input.expectedTextHash)
    && hashPattern.test(input.expectedEvidenceSnapshotHash), '승인 대상 hash 형식 오류');
  check(typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.idempotencyKey), '멱등 키 형식 오류');
  check(typeof input.statement === 'string' && input.statement.trim().length > 0 && input.statement.length <= 1000,
    '검토자 승인 문구는 1~1000자여야 합니다.');
}

function approvalHistory(db: DatabaseSync, document: Row) {
  const docId = String(document.doc_id);
  return (db.prepare(`SELECT e.id,e.after_json,e.actor,e.source_type,e.entity_type,e.entity_id,e.created_at,
      f.id AS feedback_id,f.final_value_json
    FROM event e LEFT JOIN user_feedback f ON f.event_id=e.id
      AND f.feedback_action='accept' AND f.reason_code='approved_as_is' AND f.actor_id=e.actor
    WHERE e.event_type='wiki.document_approved' AND e.correlation_id=?
    ORDER BY e.created_at DESC,e.id DESC`).all(docId) as Row[]).flatMap((row) => {
      try {
        const payload = JSON.parse(String(row.after_json ?? 'null')) as Row | null;
        if (payload?.schema !== 'wiki-document-approval-v1' || payload.approval !== 'approve_as_is' || payload.docId !== docId) return [];
        const finalValue = JSON.parse(String(row.final_value_json ?? 'null')) as Row | null;
        const auditComplete = row.source_type === 'user_input'
          && row.entity_type === document.entity_type && row.entity_id === document.entity_id
          && row.actor === '장진태' && Boolean(row.feedback_id)
          && finalValue?.docId === docId && finalValue?.byteHash === payload.byteHash
          && finalValue?.approval === 'approve_as_is';
        return [{ eventId: row.id, feedbackId: auditComplete ? row.feedback_id : null, reviewer: row.actor,
          approvedAt: row.created_at, revisionId: payload.revisionId, byteHash: payload.byteHash,
          textHash: payload.textHash, evidenceSnapshotHash: payload.evidenceSnapshotHash,
          idempotencyKey: payload.idempotencyKey ?? null, requestHash: payload.requestHash ?? null }];
      } catch { return []; }
    });
}

export async function getWikiDocumentApproval(docId: string) {
  check(idPattern.test(docId), 'docId 형식 오류');
  const source = await loadSource(docId);
  return withDatabase((db) => {
    const target = sourceSnapshot(db, source);
    const approvals = approvalHistory(db, target.document).map((approval) => ({
      ...approval,
      current: Boolean(approval.feedbackId && approval.revisionId === target.revision.id
        && approval.byteHash === target.byteHash && approval.textHash === target.textHash
        && approval.evidenceSnapshotHash === target.evidenceSnapshotHash),
    }));
    const code = target.mode.source_mode !== 'legacy_db' ? 'WIKI_DOCUMENT_APPROVAL_SOURCE_MODE'
      : approvals.some((approval) => approval.current) ? 'WIKI_DOCUMENT_APPROVAL_DUPLICATE' : null;
    return {
      docId, relativePath: target.document.relative_path, revisionId: target.revision.id,
      byteHash: target.byteHash, textHash: target.textHash,
      evidenceEventIds: target.eventIds, evidenceSnapshotHash: target.evidenceSnapshotHash,
      sourceMode: target.mode.source_mode,
      expectedRevisionId: target.revision.id, expectedByteHash: target.byteHash,
      expectedTextHash: target.textHash, expectedEvidenceSnapshotHash: target.evidenceSnapshotHash,
      allowed: code === null, code,
      reason: code === 'WIKI_DOCUMENT_APPROVAL_SOURCE_MODE' ? 'legacy DB 원본 문서만 승인할 수 있습니다.'
        : code === 'WIKI_DOCUMENT_APPROVAL_DUPLICATE' ? '현재 문서 revision은 이미 승인되었습니다.' : null,
      approvals,
    };
  });
}

export async function approveWikiDocument(input: WikiDocumentApprovalInput, reviewer: AuthenticatedWikiReviewer) {
  validateInput(input, reviewer);
  const source = await loadSource(input.docId);
  return withDatabase((db) => transaction(db, () => {
    const requestHash = sha256(canonical({ docId: input.docId, reviewer: reviewer.actorId,
      revisionId: input.expectedRevisionId, byteHash: input.expectedByteHash, textHash: input.expectedTextHash,
      evidenceSnapshotHash: input.expectedEvidenceSnapshotHash, statement: input.statement.trim() }));
    const eventId = `wiki-document-approval-${sha256(`${input.docId}\0${reviewer.actorId}\0${input.idempotencyKey}\0${requestHash}`).slice(0, 32)}`;
    const prior = approvalHistory(db, source.document);
    check(!prior.some((item) => item.idempotencyKey === input.idempotencyKey && item.eventId !== eventId),
      '멱등 키가 다른 승인에 사용되었습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_IDEMPOTENCY_CONFLICT');
    const target = sourceSnapshot(db, source, true);
    check(target.revision.id === input.expectedRevisionId
      && target.byteHash === input.expectedByteHash
      && target.textHash === input.expectedTextHash
      && target.evidenceSnapshotHash === input.expectedEvidenceSnapshotHash,
    '승인 대상 문서 또는 근거가 변경되었습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_STALE');
    const duplicate = prior.find((item) => item.eventId === eventId);
    if (duplicate) {
      check(duplicate.feedbackId && duplicate.reviewer === reviewer.actorId
        && duplicate.revisionId === target.revision.id && duplicate.byteHash === target.byteHash
        && duplicate.textHash === target.textHash && duplicate.evidenceSnapshotHash === target.evidenceSnapshotHash,
      '멱등 키가 다른 승인에 사용되었습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_IDEMPOTENCY_CONFLICT');
      const existing = db.prepare('SELECT after_json FROM event WHERE id=?').get(eventId) as Row;
      const payload = JSON.parse(existing.after_json) as Row;
      check(payload.requestHash === requestHash && payload.userStatement === input.statement.trim(),
        '멱등 키가 다른 승인에 사용되었습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_IDEMPOTENCY_CONFLICT');
      return { eventId, feedbackId: duplicate.feedbackId, docId: input.docId,
        revisionId: target.revision.id, byteHash: target.byteHash,
        evidenceSnapshotHash: target.evidenceSnapshotHash, status: 'already_approved' as const, duplicate: true };
    }
    check(!db.prepare('SELECT id FROM event WHERE id=?').get(eventId),
      '멱등 키에 연결된 감사 이벤트가 유효하지 않습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_IDEMPOTENCY_CONFLICT');
    check(!prior.some((item) => item.feedbackId && item.revisionId === target.revision.id
      && item.byteHash === target.byteHash && item.textHash === target.textHash
      && item.evidenceSnapshotHash === target.evidenceSnapshotHash),
    '현재 문서 revision은 이미 승인되었습니다.', 409, 'WIKI_DOCUMENT_APPROVAL_DUPLICATE');
    const timestamp = new Date().toISOString();
    const payload = {
      schema: 'wiki-document-approval-v1', approval: 'approve_as_is',
      docId: input.docId, relativePath: target.document.relative_path,
      revisionId: target.revision.id, byteHash: target.byteHash, textHash: target.textHash,
      evidenceEventIds: target.eventIds, evidenceSnapshotHash: target.evidenceSnapshotHash,
      sourceMode: 'legacy_db', automaticApply: false, sourceCutoverPerformed: false,
      userStatement: input.statement.trim(), idempotencyKey: input.idempotencyKey, requestHash,
    };
    const feedbackId = `${eventId}-feedback`;
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at)
      VALUES (?,?,?,'wiki.document_approved',?,?,'user_input',?,?)`)
      .run(eventId, target.document.entity_type, target.document.entity_id, JSON.stringify(payload), reviewer.actorId, input.docId, timestamp);
    db.prepare(`INSERT INTO user_feedback(id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,created_at)
      VALUES (?,?,?,'accept',?,?,'approved_as_is',?,?)`)
      .run(feedbackId, eventId, reviewer.actorId,
        JSON.stringify({ docId: input.docId, byteHash: target.byteHash, revisionId: target.revision.id }),
        JSON.stringify(payload), input.statement.trim(), timestamp);
    return { eventId, feedbackId, docId: input.docId,
      revisionId: target.revision.id, byteHash: target.byteHash,
      evidenceSnapshotHash: target.evidenceSnapshotHash, status: 'approved' as const, duplicate: false };
  }));
}
