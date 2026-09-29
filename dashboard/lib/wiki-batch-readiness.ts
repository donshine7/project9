import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { operationalDatabasePath, pathIsInside, resolveWikiVaultPath } from './runtime-environment';
import {
  canonicalWikiDocumentEvidence as canonical,
  citedWikiDocumentEventIds,
  wikiDocumentEvidenceSnapshot,
  WikiDocumentEvidenceMissingError,
  type WikiDocumentEvidenceEvent,
} from './wiki-document-evidence';

type Row = Record<string, any>;
type Approval = { kind: 'document' | 'proposal' | 'none'; id: string | null; approvedEvidenceSnapshotHash: string | null; currentEvidenceSnapshotHash: string | null; crossEntityEvidenceCount: number; diagnostics: Row | null; fresh: boolean; blockers: string[] };

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const one = (db: DatabaseSync, sql: string, ...params: any[]) => db.prepare(sql).get(...params) as Row | undefined;
const all = (db: DatabaseSync, sql: string, ...params: any[]) => db.prepare(sql).all(...params) as Row[];
const count = (db: DatabaseSync, sql: string, ...params: any[]) => Number(one(db, sql, ...params)?.n ?? 0);
const json = (value: unknown) => { try { return JSON.parse(String(value ?? 'null')) as Row | null; } catch { return null; } };

function citedEvents(db: DatabaseSync, document: Row, markdown: string, requireSameEntity: boolean) {
  const ids = citedWikiDocumentEventIds(markdown);
  if (!ids.length) return null;
  let crossEntityCount = 0;
  for (const id of ids) {
    const event = one(db, 'SELECT * FROM event WHERE id=?', id);
    if (!event) return { ids, hash: null, crossEntityCount };
    if (event.entity_type !== document.entity_type || event.entity_id !== document.entity_id) crossEntityCount++;
  }
  if (requireSameEntity && crossEntityCount) return { ids, hash: null, crossEntityCount };
  try {
    const snapshot = wikiDocumentEvidenceSnapshot(markdown, (id) => one(db, 'SELECT * FROM event WHERE id=?', id) as WikiDocumentEvidenceEvent | undefined);
    return { ids: snapshot.eventIds, hash: snapshot.evidenceSnapshotHash, crossEntityCount };
  } catch (error) {
    if (error instanceof WikiDocumentEvidenceMissingError) return { ids, hash: null, crossEntityCount };
    throw error;
  }
}

function documentApproval(db: DatabaseSync, document: Row, markdown: string, expectedSourceMode: string): Approval | null {
  const approval = one(db, `SELECT * FROM event WHERE event_type='wiki.document_approved' AND correlation_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, document.doc_id);
  if (!approval) return null;
  const blockers: string[] = [];
  const payload = json(approval.after_json);
  const feedback = one(db, `SELECT * FROM user_feedback WHERE event_id=? AND actor_id=? AND feedback_action='accept' AND reason_code='approved_as_is' ORDER BY created_at DESC,id DESC LIMIT 1`, approval.id, approval.actor);
  const finalValue = json(feedback?.final_value_json);
  const evidence = citedEvents(db, document, markdown, expectedSourceMode === 'legacy_db');
  const approvedIds = Array.isArray(payload?.evidenceEventIds) ? payload.evidenceEventIds.map(String) : [];
  const currentIds = evidence?.ids ?? [];
  const diagnostics = {
    hashRule: 'cutover-v1-canonical-event-snapshot',
    approvalHashRuleRecorded: false,
    eventFieldProjection: 'id,entityType,entityId,eventType,beforeJson,afterJson,actor,sourceType,correlationId,createdAt',
    approvedEventCount: approvedIds.length,
    currentCitedEventCount: currentIds.length,
    eventIdsExactMatch: canonical(approvedIds) === canonical(currentIds),
    eventIdsCaseFoldedMatch: canonical(approvedIds.map((id: string) => id.toLowerCase())) === canonical(currentIds.map((id) => id.toLowerCase())),
    approvedIdsSorted: canonical(approvedIds) === canonical([...approvedIds].sort()),
    currentIdsSorted: canonical(currentIds) === canonical([...currentIds].sort()),
    uppercaseUuidCount: [...approvedIds, ...currentIds].filter((id) => /[A-F]/.test(id)).length,
  };
  if (approval.entity_type !== document.entity_type || approval.entity_id !== document.entity_id || approval.source_type !== 'user_input' || approval.actor !== '장진태') blockers.push('APPROVAL_IDENTITY');
  if (payload?.schema !== 'wiki-document-approval-v1' || payload.approval !== 'approve_as_is' || payload.docId !== document.doc_id || payload.byteHash !== document.byte_hash || payload.textHash !== document.text_hash || payload.revisionId !== document.current_revision_id || payload.sourceMode !== expectedSourceMode || payload.automaticApply !== false || payload.sourceCutoverPerformed !== false) blockers.push('APPROVAL_STALE');
  if (!feedback || finalValue?.docId !== document.doc_id || finalValue?.byteHash !== document.byte_hash || finalValue?.approval !== 'approve_as_is') blockers.push('APPROVAL_FEEDBACK');
  if (!evidence?.hash || canonical(payload?.evidenceEventIds) !== canonical(evidence.ids) || payload?.evidenceSnapshotHash !== evidence.hash) blockers.push('EVIDENCE_HASH_MISMATCH');
  return { kind: 'document', id: approval.id, approvedEvidenceSnapshotHash: payload?.evidenceSnapshotHash ?? null, currentEvidenceSnapshotHash: evidence?.hash ?? null, crossEntityEvidenceCount: evidence?.crossEntityCount ?? 0, diagnostics, fresh: blockers.length === 0, blockers };
}

function proposalEvidence(db: DatabaseSync, entityType: string, entityId: string) {
  const records: Array<[string, string, string]> = [];
  for (const entry of all(db, `SELECT event_id FROM wiki_entry e WHERE entity_type=? AND entity_id=? AND NOT EXISTS(SELECT 1 FROM wiki_entry n WHERE n.supersedes_id=e.id) ORDER BY event_id`, entityType, entityId)) {
    const event = one(db, `SELECT id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at FROM event WHERE id=?`, entry.event_id);
    const wikiEntry = one(db, `SELECT id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,evidence_json,source_candidate_id,supersedes_id,created_at FROM wiki_entry e WHERE event_id=? AND NOT EXISTS(SELECT 1 FROM wiki_entry n WHERE n.supersedes_id=e.id)`, entry.event_id);
    if (event && wikiEntry) records.push(['event', entry.event_id, sha256(JSON.stringify({ event, entry: wikiEntry }))]);
  }
  for (const source of all(db, `SELECT id,entity_type,entity_id,field_path,observed_value_json,source_type,source_id,observed_at,confidence,user_confirmed FROM source_observation WHERE entity_type=? AND entity_id=? ORDER BY id`, entityType, entityId)) {
    if (!source.user_confirmed) {
      if (source.source_type !== 'easy_pat' || !source.source_id) continue;
      const verified = all(db, `SELECT after_json FROM event WHERE entity_type=? AND entity_id=? AND event_type='easy_pat_verified' AND source_type='easy_pat'`, entityType, entityId)
        .some((event) => json(event.after_json)?.sourceId === source.source_id);
      if (!verified) continue;
    }
    records.push(['source', source.id, sha256(JSON.stringify(source))]);
  }
  records.sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
  return { hash: sha256(JSON.stringify(records)), count: records.length };
}

function latestApproval(db: DatabaseSync, document: Row, markdown: string, expectedSourceMode: string): Approval {
  const direct = documentApproval(db, document, markdown, expectedSourceMode);
  if (direct) return direct;
  const proposal = one(db, 'SELECT * FROM wiki_proposal WHERE doc_id=? ORDER BY created_at DESC,id DESC LIMIT 1', document.doc_id);
  if (!proposal) return { kind: 'none', id: null, approvedEvidenceSnapshotHash: null, currentEvidenceSnapshotHash: null, crossEntityEvidenceCount: 0, diagnostics: null, fresh: false, blockers: ['APPROVAL_MISSING'] };
  const review = one(db, 'SELECT * FROM wiki_proposal_review WHERE proposal_id=? ORDER BY created_at DESC,id DESC LIMIT 1', proposal.id);
  const evidence = proposalEvidence(db, document.entity_type, document.entity_id);
  const blockers: string[] = [];
  if (proposal.status !== 'applied_observed' || proposal.target_byte_hash !== document.byte_hash || review?.action !== 'accept_for_manual_apply' || review.reviewer !== '장진태' || review.reviewed_base_byte_hash !== proposal.base_byte_hash) blockers.push('PROPOSAL_NOT_APPLIED');
  if (!evidence.count) blockers.push('PROPOSAL_EVIDENCE_MISSING');
  if (review?.reviewed_evidence_snapshot_hash !== proposal.evidence_snapshot_hash || evidence.hash !== proposal.evidence_snapshot_hash) blockers.push('EVIDENCE_HASH_MISMATCH');
  if (count(db, `SELECT COUNT(*) AS n FROM wiki_proposal_evidence WHERE proposal_id=? AND validation_status!='valid'`, proposal.id) > 0) blockers.push('PROPOSAL_EVIDENCE_INVALID');
  return { kind: 'proposal', id: proposal.id, approvedEvidenceSnapshotHash: proposal.evidence_snapshot_hash, currentEvidenceSnapshotHash: evidence.hash, crossEntityEvidenceCount: 0, diagnostics: { hashRule: 'wiki-proposal-v1-json-evidence-records', evidenceRecordCount: evidence.count }, fresh: blockers.length === 0, blockers };
}

function currentFile(vault: string, relativePath: string, expectedHash: string) {
  const file = path.resolve(vault, ...relativePath.split('/'));
  if (!pathIsInside(vault, file) || !existsSync(file)) return { hash: null, markdown: '', blocker: 'FILE_MISSING' };
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !pathIsInside(realpathSync(vault), realpathSync(file))) return { hash: null, markdown: '', blocker: 'FILE_PATH_UNSAFE' };
    const bytes = readFileSync(file);
    const hash = sha256(bytes);
    return { hash, markdown: Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), blocker: hash === expectedHash ? null : 'FILE_HASH_STALE' };
  } catch {
    return { hash: null, markdown: '', blocker: 'FILE_UNREADABLE' };
  }
}

export function inspectWikiBatchReadiness(input: { databasePath?: string; vaultPath?: string; batchSize?: number } = {}) {
  const startedAt = performance.now();
  const databasePath = path.resolve(input.databasePath ?? operationalDatabasePath());
  const vaultPath = path.resolve(input.vaultPath ?? resolveWikiVaultPath({ SSPAT_RUNTIME_PROFILE: 'operational' }));
  const batchSize = input.batchSize ?? 5;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5) throw new Error('batchSize는 1~5여야 합니다.');
  if (!existsSync(databasePath) || !lstatSync(databasePath).isFile()) throw new Error('DB 파일이 없습니다.');
  if (!existsSync(vaultPath) || !lstatSync(vaultPath).isDirectory() || lstatSync(vaultPath).isSymbolicLink()) throw new Error('실제 Vault 디렉터리가 없습니다.');
  if (existsSync(`${databasePath}-wal`)) throw new Error('활성 WAL이 있어 파일 단위 읽기 사본을 만들 수 없습니다.');
  const databaseSha256 = sha256(readFileSync(databasePath));
  const snapshot = path.join(os.tmpdir(), `sspat-wiki-batch-${randomUUID()}.db`);
  let db: DatabaseSync | undefined;
  try {
    copyFileSync(databasePath, snapshot);
    const snapshotDb = new DatabaseSync(snapshot, { readOnly: true });
    db = snapshotDb;
    snapshotDb.exec('PRAGMA query_only=ON');
    const required = ['wiki_document', 'wiki_document_source_mode', 'wiki_markdown_revision', 'wiki_markdown_scan', 'wiki_markdown_scan_issue', 'wiki_proposal', 'wiki_proposal_review', 'wiki_proposal_evidence', 'wiki_entry', 'source_observation', 'entity_wiki_revision', 'wiki_draft', 'wiki_cutover_run', 'wiki_cutover_item', 'wiki_recovery_rehearsal', 'event', 'user_feedback', 'action_item', 'matter'];
    const missing = required.filter((name) => !one(snapshotDb, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
    if (missing.length) throw new Error(`필수 스키마 누락: ${missing.join(',')}`);
    const quickCheck = one(snapshotDb, 'PRAGMA quick_check');
    if (Object.values(quickCheck ?? {})[0] !== 'ok') throw new Error('DB quick_check 실패');
    const scan = one(snapshotDb, 'SELECT id,status,issue_count,started_at,completed_at FROM wiki_markdown_scan ORDER BY started_at DESC,id DESC LIMIT 1');
    const documents = all(snapshotDb, `SELECT d.*,s.source_mode,s.legacy_entity_type,s.legacy_entity_id,s.changed_by_event_id,m.our_ref,m.archived_at AS matter_archived_at
      FROM wiki_document d LEFT JOIN wiki_document_source_mode s ON s.doc_id=d.doc_id
      LEFT JOIN matter m ON d.entity_type='matter' AND m.id=d.entity_id
      ORDER BY m.our_ref,d.doc_id`);
    const candidates = documents.filter((d) => d.document_type === 'entity_wiki' && d.entity_type === 'matter').map((document) => {
      const blockers: string[] = [];
      const file = currentFile(vaultPath, document.relative_path, document.byte_hash);
      if (document.parse_status !== 'valid') blockers.push(`PARSE_${String(document.parse_status).toUpperCase()}`);
      if (document.last_seen_scan_id !== scan?.id || scan?.status !== 'succeeded') blockers.push('SCAN_STALE');
      if (count(snapshotDb, 'SELECT COUNT(*) AS n FROM wiki_markdown_scan_issue WHERE scan_id=? AND (doc_id=? OR relative_path=?)', scan?.id, document.doc_id, document.relative_path) > 0) blockers.push('SCAN_ISSUE');
      if (file.blocker) blockers.push(file.blocker);
      const revision = one(snapshotDb, 'SELECT * FROM wiki_markdown_revision WHERE id=?', document.current_revision_id);
      if (!revision || revision.doc_id !== document.doc_id || revision.byte_hash !== document.byte_hash) blockers.push('REVISION_STALE');
      if (!document.our_ref || document.matter_archived_at) blockers.push('MATTER_UNAVAILABLE');
      const openActionCount = count(snapshotDb, 'SELECT COUNT(*) AS n FROM action_item WHERE matter_id=? AND archived_at IS NULL AND status!=?', document.entity_id, '완료');
      const legacyRevisionCount = count(snapshotDb, 'SELECT COUNT(*) AS n FROM entity_wiki_revision WHERE entity_type=? AND entity_id=?', document.entity_type, document.entity_id);
      const pendingDraftCount = count(snapshotDb, `SELECT COUNT(*) AS n FROM wiki_draft WHERE entity_type=? AND entity_id=? AND review_status='pending'`, document.entity_type, document.entity_id);
      const cutover = one(snapshotDb, `SELECT i.id,i.expected_byte_hash,i.markdown_revision_id,i.source_change_event_id,r.id AS run_id,r.status AS run_status
        FROM wiki_cutover_item i JOIN wiki_cutover_run r ON r.id=i.cutover_run_id
        WHERE i.doc_id=? ORDER BY i.created_at DESC,i.id DESC LIMIT 1`, document.doc_id);
      const recoveryCount = cutover ? count(snapshotDb, `SELECT COUNT(*) AS n FROM wiki_recovery_rehearsal WHERE cutover_run_id=? AND status='succeeded'`, cutover.run_id) : 0;
      const sourceMode = document.source_mode ?? 'missing';
      const approval = latestApproval(snapshotDb, document, file.markdown, cutover ? 'legacy_db' : sourceMode);
      if (!approval.fresh) blockers.push(...approval.blockers);
      if (sourceMode === 'legacy_db') {
        if (cutover) blockers.push('CUTOVER_SOURCE_CONFLICT');
        if (document.legacy_entity_type !== document.entity_type || document.legacy_entity_id !== document.entity_id) blockers.push('LEGACY_BINDING');
        if (!legacyRevisionCount) blockers.push('LEGACY_REVISION_MISSING');
        if (pendingDraftCount) blockers.push('PENDING_LEGACY_DRAFT');
        if (openActionCount) blockers.push('OPEN_ACTION');
      } else if (sourceMode === 'markdown') {
        if (legacyRevisionCount && (!cutover || cutover.run_status !== 'succeeded' || !recoveryCount || cutover.expected_byte_hash !== document.byte_hash || cutover.markdown_revision_id !== document.current_revision_id)) blockers.push('CUTOVER_RECOVERY_MISSING');
        if (!legacyRevisionCount && cutover) blockers.push('UNEXPECTED_CUTOVER');
        const sourceEvent = document.changed_by_event_id ? one(snapshotDb, 'SELECT * FROM event WHERE id=?', document.changed_by_event_id) : null;
        const sourcePayload = json(sourceEvent?.after_json);
        if (legacyRevisionCount) {
          if (!sourceEvent || sourceEvent.event_type !== 'wiki.source_mode_changed' || sourcePayload?.docId !== document.doc_id || sourcePayload?.sourceMode !== 'markdown' || sourcePayload?.byteHash !== document.byte_hash || cutover?.source_change_event_id !== sourceEvent.id) blockers.push('SOURCE_EVENT_INVALID');
        } else if (!sourceEvent || sourceEvent.event_type !== 'wiki.source_mode_initialized' || sourcePayload?.schema !== 'wiki-source-mode-initialization-v1' || sourcePayload?.docId !== document.doc_id || sourcePayload?.sourceMode !== 'markdown') blockers.push('SOURCE_EVENT_INVALID');
      } else blockers.push('SOURCE_MODE_MISSING');
      const status = sourceMode === 'legacy_db' ? (blockers.length ? 'blocked_cutover' : 'eligible_cutover')
        : sourceMode === 'markdown' && legacyRevisionCount ? (blockers.length ? 'blocked_observation' : 'recovered_cutover')
          : sourceMode === 'markdown' ? (blockers.length ? 'blocked_native' : 'native_markdown') : 'blocked_source';
      return {
        matterRef: document.our_ref ?? null, docId: document.doc_id, sourceMode, status,
        byteHash: document.byte_hash, fileByteHash: file.hash, revisionId: document.current_revision_id,
        approval: { kind: approval.kind, id: approval.id, approvedEvidenceSnapshotHash: approval.approvedEvidenceSnapshotHash, currentEvidenceSnapshotHash: approval.currentEvidenceSnapshotHash, crossEntityEvidenceCount: approval.crossEntityEvidenceCount, diagnostics: approval.diagnostics, fresh: approval.fresh },
        openActionCount, legacyRevisionCount, pendingDraftCount,
        cutover: cutover ? { runId: cutover.run_id, status: cutover.run_status, recoverySucceeded: recoveryCount > 0 } : null,
        blockers: [...new Set(blockers)].sort(),
      };
    });
    const globalBlockers: string[] = [];
    if (!scan || scan.status !== 'succeeded' || scan.issue_count !== 0) globalBlockers.push('LATEST_SCAN_NOT_CLEAN');
    if (candidates.some((item) => item.blockers.includes('PARSE_DUPLICATE'))) globalBlockers.push('DUPLICATE_DOCUMENT');
    const cutoverEligible = candidates.filter((item) => item.status === 'eligible_cutover');
    if (!cutoverEligible.length) globalBlockers.push('NO_ELIGIBLE_CUTOVER');
    const databaseSha256After = sha256(readFileSync(databasePath));
    if (databaseSha256After !== databaseSha256 || sha256(readFileSync(snapshot)) !== databaseSha256) globalBlockers.push('DATABASE_CHANGED_DURING_READ');
    const batches = {
      cutoverDryRun: (globalBlockers.length ? [] : cutoverEligible).slice(0, batchSize).map((item) => ({
        matterRef: item.matterRef, docId: item.docId, expectedByteHash: item.byteHash,
        ...(item.approval.kind === 'document' ? { documentApprovalEventId: item.approval.id } : { proposalId: item.approval.id }),
      })),
      postCutoverObservation: candidates.filter((item) => item.status === 'recovered_cutover').slice(0, batchSize).map((item) => item.docId),
      nativeMarkdownObservation: candidates.filter((item) => item.status === 'native_markdown').slice(0, batchSize).map((item) => item.docId),
      blockedReview: candidates.filter((item) => item.status.startsWith('blocked')).slice(0, batchSize).map((item) => ({ docId: item.docId, blockers: item.blockers })),
    };
    const payload = {
      schema: 'wiki-operational-batch-readiness-v1', readOnly: true, databaseSha256,
      latestScan: scan ? { id: scan.id, status: scan.status, issueCount: scan.issue_count, completedAt: scan.completed_at } : null,
      metrics: {
        indexedDocuments: documents.length, matterDocuments: candidates.length,
        eligibleCutover: cutoverEligible.length, recoveredCutover: candidates.filter((item) => item.status === 'recovered_cutover').length,
        nativeMarkdown: candidates.filter((item) => item.status === 'native_markdown').length,
        blocked: candidates.filter((item) => item.status.startsWith('blocked')).length,
        evidenceHashMismatch: candidates.filter((item) => item.blockers.includes('EVIDENCE_HASH_MISMATCH')).length,
        fileHashStale: candidates.filter((item) => item.blockers.includes('FILE_HASH_STALE')).length,
        cutoverRecoveryMissing: candidates.filter((item) => item.blockers.includes('CUTOVER_RECOVERY_MISSING')).length,
        openActions: candidates.reduce((sum, item) => sum + item.openActionCount, 0),
        pendingLegacyDrafts: candidates.reduce((sum, item) => sum + item.pendingDraftCount, 0),
      },
      readyForExpansion: globalBlockers.length === 0, globalBlockers, batches, candidates,
    };
    return { ...payload, manifestSha256: sha256(canonical(payload)), inspectedAt: new Date().toISOString(), inspectionElapsedMs: Math.round(performance.now() - startedAt) };
  } finally {
    db?.close();
    for (const file of [snapshot, `${snapshot}-shm`, `${snapshot}-wal`]) if (existsSync(file)) unlinkSync(file);
  }
}
