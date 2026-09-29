import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathIsInside, resolveDatabasePath, resolveWikiVaultPath, runtimeProfile } from './runtime-environment';
import { withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;
type ArchiveItem = {
  sourceKind: 'revision' | 'historic_revision' | 'draft'; sourceId: string; entityType: string; entityId: string;
  sourceBodyHash: string; archiveRelativePath: string; archiveHash: string;
  evidenceHash: string; blockers: string[]; evidence: Row;
};
type ArchiveManifest = {
  schema: string; runId: string; profile: string; outputRootHash: string;
  sourceSnapshotHash: string; status: 'evidence_complete' | 'blocked';
  summary: { revisionCount: number; historicRevisionCount: number; draftCount: number; blockedCount: number };
  items: ArchiveItem[]; guarantees: Row; createdAt: string;
};

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const fail = (code: string, message: string): never => { throw new WorkDbError(message, 409, code); };
function check(ok: unknown, code: string, message: string): asserts ok { if (!ok) fail(code, message); }
const json = (value: unknown): Row | null => { try { return JSON.parse(String(value ?? 'null')) as Row; } catch { return null; } };
const rowBy = (rows: Row[], key: string, value: unknown) => rows.find((row) => row[key] === value);
const rowsBy = (rows: Row[], key: string, value: unknown) => rows.filter((row) => row[key] === value);
function statIfPresent(target: string) {
  try { return lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
const tables = [
  'entity_wiki_revision', 'wiki_revision', 'wiki_draft', 'decision_run', 'event', 'user_feedback',
  'wiki_document', 'wiki_document_source_mode', 'wiki_markdown_revision',
  'wiki_cutover_item', 'wiki_cutover_run', 'wiki_recovery_rehearsal',
  'wiki_proposal', 'wiki_proposal_review', 'wiki_file_operation',
] as const;

function noLinkAncestors(target: string) {
  let cursor = path.resolve(target);
  while (true) {
    const stat = statIfPresent(cursor);
    if (stat) {
      check(!stat.isSymbolicLink(), 'WIKI_ARCHIVE_PATH_BLOCKED', `심볼릭 링크 또는 junction 경로: ${cursor}`);
      const actual = realpathSync(cursor);
      const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
      check(comparable(actual) === comparable(cursor), 'WIKI_ARCHIVE_PATH_BLOCKED', `실제 경로와 다른 경로: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function physicalFile(root: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  const file = path.resolve(root, ...relative.split('/'));
  if (!pathIsInside(root, file) || !statIfPresent(file)) return null;
  noLinkAncestors(file);
  return lstatSync(file).isFile() ? file : null;
}

function artifactJson(root: string, relative: string, expected: (data: Row) => boolean) {
  try {
    const file = physicalFile(root, relative);
    if (!file) return null;
    const bytes = readFileSync(file);
    const data = json(bytes.toString('utf8'));
    return data && expected(data) ? { data, sha256: sha256(bytes) } : null;
  } catch { return null; }
}

function environment(outputRootInput: string) {
  const profile = runtimeProfile();
  check(profile !== 'operational', 'WIKI_ARCHIVE_OPERATIONAL_BLOCKED', '운영 프로필의 legacy archive는 지원하지 않습니다.');
  const isolated = path.resolve(String(process.env.SSPAT_ISOLATED_ROOT ?? ''));
  const temp = path.resolve(os.tmpdir());
  const outputRoot = path.resolve(outputRootInput);
  const dbFile = resolveDatabasePath();
  const vault = resolveWikiVaultPath();
  check(Boolean(process.env.SSPAT_ISOLATED_ROOT) && isolated !== temp && pathIsInside(temp, isolated), 'WIKI_ARCHIVE_PATH_BLOCKED', '격리 루트는 OS temp 하위여야 합니다.');
  check(outputRoot !== isolated && pathIsInside(isolated, outputRoot), 'WIKI_ARCHIVE_PATH_BLOCKED', 'archive 출력은 격리 루트 하위여야 합니다.');
  check(pathIsInside(isolated, dbFile) && pathIsInside(isolated, vault), 'WIKI_ARCHIVE_PATH_BLOCKED', 'DB와 Vault는 격리 루트 하위여야 합니다.');
  const overlaps = (a: string, b: string) => pathIsInside(a, b) || pathIsInside(b, a);
  check(!overlaps(outputRoot, path.dirname(dbFile)) && !overlaps(outputRoot, vault), 'WIKI_ARCHIVE_PATH_BLOCKED', 'archive 출력은 DB 또는 Vault와 겹칠 수 없습니다.');
  for (const candidate of [isolated, outputRoot, `${outputRoot}.staging`, dbFile, vault]) noLinkAncestors(candidate);
  check(existsSync(isolated) && lstatSync(isolated).isDirectory(), 'WIKI_ARCHIVE_PATH_BLOCKED', '격리 루트가 없습니다.');
  return { profile, isolated, outputRoot, vault };
}

function snapshot(db: DatabaseSync): Record<string, Row[]> {
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  check(violations.length === 0, 'WIKI_ARCHIVE_REFERENCE_INVALID', 'DB 외래키 무결성이 깨졌습니다.');
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[]]));
}

function revisionEvidence(source: Record<string, Row[]>, revision: Row, vault: string) {
  const blockers: string[] = [];
  const add = (code: string, condition: unknown) => { if (!condition) blockers.push(code); };
  const publication = rowBy(source.event, 'id', revision.publication_event_id);
  const decisionRun = rowBy(source.decision_run, 'id', revision.run_id);
  add('publication_event_invalid', publication?.entity_type === revision.entity_type && publication?.entity_id === revision.entity_id && publication?.event_type === 'wiki.publish');
  add('decision_run_missing', decisionRun);
  const documents = source.wiki_document.filter((row) => row.document_type === 'entity_wiki' && row.entity_type === revision.entity_type && row.entity_id === revision.entity_id);
  add('document_missing_or_duplicate', documents.length === 1);
  const document = documents.length === 1 ? documents[0] : null;
  const mode = document ? rowBy(source.wiki_document_source_mode, 'doc_id', document.doc_id) : null;
  add('source_mode_invalid', mode?.source_mode === 'markdown' && mode?.legacy_entity_type === revision.entity_type && mode?.legacy_entity_id === revision.entity_id);
  add('markdown_document_invalid', document?.parse_status === 'valid');
  const markdownRevision = document ? rowBy(source.wiki_markdown_revision, 'id', document.current_revision_id) : null;
  add('markdown_revision_invalid', markdownRevision?.doc_id === document?.doc_id && markdownRevision?.byte_hash === document?.byte_hash && markdownRevision?.relative_path === document?.relative_path);
  let markdownHash: string | null = null;
  if (document) {
    try {
      const file = physicalFile(vault, document.relative_path);
      if (file) markdownHash = sha256(readFileSync(file));
    } catch { /* recorded as blocker */ }
  }
  add('markdown_file_missing_or_changed', markdownHash && markdownHash === document?.byte_hash);
  const cutovers = rowsBy(source.wiki_cutover_item, 'legacy_revision_id', revision.id);
  add('exact_legacy_cutover_missing_or_duplicate', cutovers.length === 1);
  const item = cutovers.length === 1 ? cutovers[0] : null;
  const cutover = item ? rowBy(source.wiki_cutover_run, 'id', item.cutover_run_id) : null;
  add('cutover_audit_invalid', cutover?.status === 'succeeded' && Boolean(cutover.authorization_id) && Boolean(cutover.reviewer)
    && item?.doc_id === document?.doc_id && item?.entity_type === revision.entity_type && item?.entity_id === revision.entity_id
    && item?.previous_source_mode === 'legacy_db' && item?.new_source_mode === 'markdown'
    && item?.markdown_revision_id === markdownRevision?.id && item?.expected_byte_hash === document?.byte_hash);
  const sourceEvent = item ? rowBy(source.event, 'id', item.source_change_event_id) : null;
  const before = json(sourceEvent?.before_json);
  const after = json(sourceEvent?.after_json);
  add('source_change_event_invalid', sourceEvent?.event_type === 'wiki.source_mode_changed'
    && sourceEvent?.entity_type === revision.entity_type && sourceEvent?.entity_id === revision.entity_id
    && sourceEvent?.actor === cutover?.reviewer && sourceEvent?.correlation_id === cutover?.authorization_id
    && mode?.changed_by_event_id === sourceEvent?.id && before?.docId === document?.doc_id
    && before?.legacyRevisionId === revision.id
    && before?.sourceMode === 'legacy_db' && after?.docId === document?.doc_id
    && after?.sourceMode === 'markdown' && after?.byteHash === document?.byte_hash
    && after?.markdownRevisionId === markdownRevision?.id && after?.automaticApply === false);
  const proposal = item?.proposal_id ? rowBy(source.wiki_proposal, 'id', item.proposal_id) : null;
  const review = item?.proposal_review_id ? rowBy(source.wiki_proposal_review, 'id', item.proposal_review_id) : null;
  const fileOperation = proposal ? rowBy(source.wiki_file_operation, 'id', proposal.operation_id) : null;
  const reviewEvent = review ? rowBy(source.event, 'id', review.review_event_id) : null;
  const approval = item?.document_approval_event_id ? rowBy(source.event, 'id', item.document_approval_event_id) : null;
  const approvalPayload = json(approval?.after_json);
  const feedback = approval ? source.user_feedback.find((row) => row.event_id === approval.id && row.actor_id === cutover?.reviewer && row.feedback_action === 'accept' && row.reason_code === 'approved_as_is') : null;
  const feedbackPayload = json(feedback?.final_value_json);
  const proposalValid = proposal?.doc_id === document?.doc_id && proposal?.status === 'applied_observed'
    && proposal?.target_byte_hash === document?.byte_hash && review?.proposal_id === proposal?.id
    && review?.action === 'accept_for_manual_apply' && review?.reviewer === cutover?.reviewer
    && review?.reviewed_base_byte_hash === proposal?.base_byte_hash
    && review?.reviewed_evidence_snapshot_hash === proposal?.evidence_snapshot_hash
    && reviewEvent?.entity_type === revision.entity_type && reviewEvent?.entity_id === revision.entity_id
    && reviewEvent?.event_type === 'wiki.proposal_reviewed'
    && reviewEvent?.actor === cutover?.reviewer && fileOperation?.status === 'succeeded';
  const documentValid = approval?.event_type === 'wiki.document_approved' && approval?.source_type === 'user_input'
    && approval?.entity_type === revision.entity_type && approval?.entity_id === revision.entity_id
    && approval?.actor === cutover?.reviewer && approval?.correlation_id === document?.doc_id
    && approvalPayload?.schema === 'wiki-document-approval-v1' && approvalPayload?.approval === 'approve_as_is'
    && approvalPayload?.docId === document?.doc_id && approvalPayload?.byteHash === document?.byte_hash
    && approvalPayload?.textHash === document?.text_hash
    && approvalPayload?.revisionId === markdownRevision?.id && approvalPayload?.sourceMode === 'legacy_db'
    && approvalPayload?.automaticApply === false && approvalPayload?.sourceCutoverPerformed === false
    && feedbackPayload?.docId === document?.doc_id && feedbackPayload?.byteHash === document?.byte_hash
    && feedbackPayload?.approval === 'approve_as_is';
  const acceptedProposal = Boolean(proposal && review && !approval && proposalValid);
  const acceptedDocument = Boolean(approval && !proposal && !review && documentValid);
  add('approval_audit_invalid', acceptedProposal !== acceptedDocument);
  add('source_event_approval_mismatch', after?.approvalId === (approval?.id ?? review?.id) && after?.approvalKind === (approval ? 'document' : 'proposal'));
  let bundle: ReturnType<typeof artifactJson> = null;
  if (cutover && pathIsInside(os.tmpdir(), cutover.bundle_path)) {
    bundle = artifactJson(cutover.bundle_path, 'cutover-manifest.json', (data) => data.schema === 'wiki-cutover-bundle-v1'
      && data.runId === cutover.id && data.authorizationId === cutover.authorization_id && data.reviewer === cutover.reviewer
      && data.runtimeProfile === cutover.runtime_profile
      && data.guarantees?.legacyRevisionDeleted === false && data.guarantees?.activeMarkdownModified === false
      && Array.isArray(data.targets) && data.targets.filter((target: Row) => target.docId === document?.doc_id).length === 1
      && data.targets.some((target: Row) => target.docId === document?.doc_id
        && target.legacyRevisionId === revision.id && target.byteHash === document?.byte_hash
        && target.markdownRevisionId === markdownRevision?.id && target.approvalKind === (approval ? 'document' : 'proposal')
        && target.sourceMode === 'markdown' && (target.documentApprovalEventId ?? null) === (approval?.id ?? null)
        && (target.proposalReviewId ?? null) === (review?.id ?? null)));
  }
  add('cutover_bundle_invalid', bundle);
  const recoveries = cutover ? source.wiki_recovery_rehearsal.filter((row) => row.cutover_run_id === cutover.id && row.status === 'succeeded') : [];
  const recovery = recoveries.at(-1) ?? null;
  let report: ReturnType<typeof artifactJson> = null;
  if (recovery && pathIsInside(os.tmpdir(), recovery.restore_root)) {
    report = artifactJson(recovery.restore_root, 'recovery-report.json', (data) => data.schema === 'wiki-recovery-rehearsal-v1'
      && data.rehearsalId === recovery.id && data.cutoverRunId === cutover?.id
      && data.restoredDatabaseHash === recovery.restored_database_hash && data.restoredVaultHash === recovery.restored_vault_hash
      && data.verificationHash === recovery.verification_hash && data.verifiedDocumentCount === recovery.verified_document_count
      && Array.isArray(data.verifications) && data.verifiedDocumentCount === data.verifications.length
      && data.verificationHash === sha256(JSON.stringify(data.verifications))
      && data.productionModified === false
      && data.verifications.filter((target: Row) => target.docId === document?.doc_id).length === 1
      && data.verifications.some((target: Row) => target.docId === document?.doc_id
        && target.byteHash === document?.byte_hash && target.markdownRevisionId === markdownRevision?.id
        && target.sourceChangeEventId === sourceEvent?.id && target.sourceMode === 'markdown'
        && target.approvalKind === (approval ? 'document' : 'proposal')
        && (target.documentApprovalEventId ?? null) === (approval?.id ?? null)
        && (target.proposalReviewId ?? null) === (review?.id ?? null)));
  }
  add('recovery_rehearsal_missing_or_invalid', report);
  return { blockers: [...new Set(blockers)].sort(), evidence: {
    publication, decisionRun, document, mode, markdownRevision, markdownHash,
    cutoverItem: item, cutoverRun: cutover, sourceEvent, proposal, review, reviewEvent,
    fileOperation, approval, feedback, recovery, bundleManifestHash: bundle?.sha256 ?? null,
    recoveryReportHash: report?.sha256 ?? null,
  } };
}

function plan(db: DatabaseSync, vault: string, outputRoot: string) {
  const source = snapshot(db);
  const overlaps = (a: string, b: string) => pathIsInside(a, b) || pathIsInside(b, a);
  for (const sourcePath of [
    ...source.wiki_cutover_run.map((row) => row.bundle_path),
    ...source.wiki_recovery_rehearsal.map((row) => row.restore_root),
  ]) {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) continue;
    const resolved = path.resolve(sourcePath);
    check(!overlaps(outputRoot, resolved) && !overlaps(`${outputRoot}.staging`, resolved),
      'WIKI_ARCHIVE_PATH_BLOCKED', 'archive 출력이 컷오버 묶음 또는 복구 사본과 겹칩니다.');
  }
  const entries: Array<{ item: ArchiveItem; bytes: Buffer }> = [];
  for (const revision of source.entity_wiki_revision) {
    const { blockers, evidence } = revisionEvidence(source, revision, vault);
    const relative = `legacy-bodies/revisions/${sha256(revision.id)}.json`;
    const bytes = Buffer.from(`${JSON.stringify({ schema: 'wiki-legacy-revision-archive-v2', source: revision, evidence }, null, 2)}\n`);
    entries.push({ item: { sourceKind: 'revision', sourceId: revision.id, entityType: revision.entity_type,
      entityId: revision.entity_id, sourceBodyHash: sha256(revision.sections_json), archiveRelativePath: relative,
      archiveHash: sha256(bytes), evidenceHash: sha256(JSON.stringify(evidence)), blockers, evidence }, bytes });
  }
  for (const revision of source.wiki_revision) {
    const citedIds = json(revision.evidence_event_ids_json);
    const events = Array.isArray(citedIds) ? citedIds.map((id) => rowBy(source.event, 'id', id)) : [];
    const evidence = { events, citedIds };
    const blockers = ['historic_revision_retention_required'];
    if (!Array.isArray(citedIds) || events.some((event) => event?.entity_type !== 'matter' || event?.entity_id !== revision.matter_id)) blockers.push('historic_revision_evidence_invalid');
    const relative = `legacy-bodies/historic-revisions/${sha256(revision.id)}.json`;
    const bytes = Buffer.from(`${JSON.stringify({ schema: 'wiki-historic-revision-archive-v2', source: revision, evidence }, null, 2)}\n`);
    entries.push({ item: { sourceKind: 'historic_revision', sourceId: revision.id, entityType: 'matter',
      entityId: revision.matter_id, sourceBodyHash: sha256(revision.content), archiveRelativePath: relative,
      archiveHash: sha256(bytes), evidenceHash: sha256(JSON.stringify(evidence)), blockers, evidence }, bytes });
  }
  for (const draft of source.wiki_draft) {
    const decisionRun = rowBy(source.decision_run, 'id', draft.run_id);
    const evidence = { decisionRun, reviewStatus: draft.review_status };
    const blockers = ['draft_retention_or_resolution_required', ...(!decisionRun ? ['decision_run_missing'] : [])];
    const relative = `legacy-bodies/drafts/${sha256(draft.run_id)}.json`;
    const bytes = Buffer.from(`${JSON.stringify({ schema: 'wiki-legacy-draft-archive-v2', source: draft, evidence }, null, 2)}\n`);
    entries.push({ item: { sourceKind: 'draft', sourceId: draft.run_id, entityType: draft.entity_type,
      entityId: draft.entity_id, sourceBodyHash: sha256(draft.sections_json), archiveRelativePath: relative,
      archiveHash: sha256(bytes), evidenceHash: sha256(JSON.stringify(evidence)), blockers, evidence }, bytes });
  }
  const paths = entries.map((entry) => entry.item.archiveRelativePath);
  check(new Set(paths).size === paths.length, 'WIKI_ARCHIVE_DUPLICATE', 'archive 출력 경로가 중복됩니다.');
  return { entries, sourceSnapshotHash: sha256(JSON.stringify({ source, items: entries.map((entry) => entry.item) })) };
}

function inventory(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string, prefix: string) {
    for (const child of readdirSync(dir).sort()) {
      const full = path.join(dir, child);
      const info = lstatSync(full);
      check(!info.isSymbolicLink(), 'WIKI_ARCHIVE_EXISTING_MISMATCH', 'archive에 링크가 포함되어 있습니다.');
      const relative = prefix ? `${prefix}/${child}` : child;
      if (info.isDirectory()) walk(full, relative);
      else { check(info.isFile(), 'WIKI_ARCHIVE_EXISTING_MISMATCH', 'archive에 일반 파일이 아닌 항목이 있습니다.'); found.push(relative); }
    }
  }
  walk(root, '');
  return found.sort();
}

function verifySealed(db: DatabaseSync, outputRoot: string, current: ReturnType<typeof plan>) {
  const run = db.prepare('SELECT * FROM wiki_legacy_archive_run WHERE output_root=?').get(outputRoot) as Row | undefined;
  check(run && existsSync(outputRoot) && lstatSync(outputRoot).isDirectory(), 'WIKI_ARCHIVE_PARTIAL_BLOCKED', 'archive와 원장 중 하나가 없습니다.');
  const manifestFile = physicalFile(outputRoot, 'archive-manifest.json');
  check(manifestFile, 'WIKI_ARCHIVE_EXISTING_MISMATCH', 'archive manifest가 없습니다.');
  const manifestBytes = readFileSync(manifestFile);
  check(sha256(manifestBytes) === run.manifest_hash, 'WIKI_ARCHIVE_EXISTING_MISMATCH', 'archive manifest hash가 원장과 다릅니다.');
  const manifest = json(manifestBytes.toString('utf8')) as ArchiveManifest | null;
  check(manifest?.schema === 'wiki-legacy-archive-v2' && manifest.runId === run.id && manifest.sourceSnapshotHash === current.sourceSnapshotHash
    && manifest.outputRootHash === sha256(outputRoot.toLowerCase()) && run.source_snapshot_hash === current.sourceSnapshotHash,
  'WIKI_ARCHIVE_EXISTING_MISMATCH', '현재 원본 또는 manifest가 봉인 기록과 다릅니다.');
  const expected = ['archive-manifest.json', ...manifest.items.map((item) => item.archiveRelativePath)].sort();
  check(JSON.stringify(inventory(outputRoot)) === JSON.stringify(expected), 'WIKI_ARCHIVE_EXISTING_MISMATCH', 'archive 파일 목록이 달라졌습니다.');
  const ledger = db.prepare('SELECT * FROM wiki_legacy_archive_item WHERE archive_run_id=? ORDER BY source_kind,source_id').all(run.id) as Row[];
  check(ledger.length === manifest.items.length && manifest.items.length === current.entries.length,
    'WIKI_ARCHIVE_EXISTING_MISMATCH', 'archive 항목 수가 다릅니다.');
  for (const entry of current.entries) {
    const item = manifest.items.find((candidate) => candidate.sourceKind === entry.item.sourceKind && candidate.sourceId === entry.item.sourceId);
    const record = ledger.find((candidate) => candidate.source_kind === entry.item.sourceKind && candidate.source_id === entry.item.sourceId);
    check(item && record && JSON.stringify(item) === JSON.stringify(entry.item)
      && record.archive_relative_path === item.archiveRelativePath && record.archive_hash === item.archiveHash
      && record.source_body_hash === item.sourceBodyHash && record.evidence_hash === item.evidenceHash
      && record.blockers_json === JSON.stringify(item.blockers),
    'WIKI_ARCHIVE_EXISTING_MISMATCH', 'archive 항목의 근거 또는 원장이 다릅니다.');
    const file = physicalFile(outputRoot, item.archiveRelativePath);
    check(file && sha256(readFileSync(file)) === item.archiveHash, 'WIKI_ARCHIVE_EXISTING_MISMATCH', 'archive 본문 hash가 다릅니다.');
  }
  return { run, manifest, duplicate: true };
}

export function runWikiLegacyArchiveDryRun(outputRootInput: string, options: { failAfterArtifact?: number } = {}) {
  const { profile, outputRoot, vault } = environment(outputRootInput);
  const staging = `${outputRoot}.staging`;
  check(!existsSync(staging), 'WIKI_ARCHIVE_PARTIAL_BLOCKED', '이전 archive staging이 남아 있습니다. 수동 조사 전 재시도를 차단합니다.');
  check(!options.failAfterArtifact || profile === 'test', 'WIKI_ARCHIVE_TEST_HOOK_BLOCKED', '실패 주입은 test 프로필에서만 가능합니다.');
  return withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = plan(db, vault, outputRoot);
      if (existsSync(outputRoot) || db.prepare('SELECT id FROM wiki_legacy_archive_run WHERE output_root=?').get(outputRoot)) {
        const result = verifySealed(db, outputRoot, current);
        db.exec('COMMIT');
        return result;
      }
      const timestamp = new Date().toISOString();
      const runId = `wiki-archive-${sha256(`${current.sourceSnapshotHash}:${outputRoot.toLowerCase()}`).slice(0, 24)}`;
      const blockedCount = current.entries.filter((entry) => entry.item.blockers.length).length;
      const manifest: ArchiveManifest = {
        schema: 'wiki-legacy-archive-v2', runId, profile, outputRootHash: sha256(outputRoot.toLowerCase()),
        sourceSnapshotHash: current.sourceSnapshotHash, status: blockedCount ? 'blocked' : 'evidence_complete',
        summary: { revisionCount: current.entries.filter((entry) => entry.item.sourceKind === 'revision').length,
          historicRevisionCount: current.entries.filter((entry) => entry.item.sourceKind === 'historic_revision').length,
          draftCount: current.entries.filter((entry) => entry.item.sourceKind === 'draft').length, blockedCount },
        items: current.entries.map((entry) => entry.item),
        guarantees: { legacyBodyModified: false, sourceModeModified: false, activeMarkdownModified: false,
          deletionSupported: false, operationalExecutionAllowed: false, archiveIsCopy: true }, createdAt: timestamp,
      };
      mkdirSync(staging);
      let written = 0;
      for (const entry of current.entries) {
        const file = path.join(staging, ...entry.item.archiveRelativePath.split('/'));
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, entry.bytes, { flag: 'wx' });
        if (options.failAfterArtifact && ++written === options.failAfterArtifact) fail('WIKI_ARCHIVE_INJECTED_FAILURE', '합성 실패 주입');
      }
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(path.join(staging, 'archive-manifest.json'), manifestBytes, { flag: 'wx' });
      check(plan(db, vault, outputRoot).sourceSnapshotHash === current.sourceSnapshotHash, 'WIKI_ARCHIVE_SOURCE_CHANGED', '봉인 중 원본 또는 근거가 변경되었습니다.');
      for (const entry of current.entries) {
        const file = physicalFile(staging, entry.item.archiveRelativePath);
        check(file && sha256(readFileSync(file)) === entry.item.archiveHash, 'WIKI_ARCHIVE_HASH_MISMATCH', 'archive 파일 검증에 실패했습니다.');
      }
      renameSync(staging, outputRoot);
      db.prepare(`INSERT INTO wiki_legacy_archive_run(id,profile,output_root,source_snapshot_hash,manifest_hash,status,revision_count,historic_revision_count,draft_count,blocked_count,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(runId, profile, outputRoot, current.sourceSnapshotHash, sha256(manifestBytes), manifest.status,
        manifest.summary.revisionCount, manifest.summary.historicRevisionCount, manifest.summary.draftCount, blockedCount, timestamp);
      const insert = db.prepare(`INSERT INTO wiki_legacy_archive_item(id,archive_run_id,source_kind,source_id,entity_type,entity_id,source_body_hash,archive_relative_path,archive_hash,evidence_hash,blockers_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const { item } of current.entries) insert.run(sha256(`${runId}:${item.sourceKind}:${item.sourceId}`), runId,
        item.sourceKind, item.sourceId, item.entityType, item.entityId, item.sourceBodyHash,
        item.archiveRelativePath, item.archiveHash, item.evidenceHash, JSON.stringify(item.blockers));
      db.exec('COMMIT');
      return { run: db.prepare('SELECT * FROM wiki_legacy_archive_run WHERE id=?').get(runId), manifest, duplicate: false };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

export function verifyWikiLegacyArchive(outputRootInput: string) {
  const { outputRoot, vault } = environment(outputRootInput);
  check(!existsSync(`${outputRoot}.staging`), 'WIKI_ARCHIVE_PARTIAL_BLOCKED', 'archive staging이 남아 있습니다.');
  return withDatabase((db) => verifySealed(db, outputRoot, plan(db, vault, outputRoot)));
}

export function deleteWikiLegacyBodies(): never {
  return fail('WIKI_ARCHIVE_DELETION_UNSUPPORTED', 'Legacy Wiki 본문 삭제는 구현되지 않았습니다. 보존 정책과 별도 승인이 필요합니다.');
}
