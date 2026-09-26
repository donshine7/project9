import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathIsInside, runtimeProfile } from './runtime-environment';
import { transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function check(value: unknown, message: string, status = 400, code = 'WIKI_CLEANUP_VALIDATION'): asserts value {
  if (!value) throw new WorkDbError(message, status, code);
}
function writeExclusive(file: string, value: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, { flag: 'wx' });
}

function isolatedOutputRoot(outputRoot: string) {
  const profile = runtimeProfile();
  check(profile !== 'operational', '운영 프로필에서는 legacy cleanup을 실행할 수 없습니다.', 409, 'WIKI_CLEANUP_OPERATIONAL_BLOCKED');
  const isolated = path.resolve(String(process.env.SSPAT_ISOLATED_ROOT ?? ''));
  check(isolated && pathIsInside(isolated, outputRoot) && path.resolve(outputRoot) !== isolated, 'cleanup 출력은 격리 루트의 새 하위 폴더여야 합니다.', 409, 'WIKI_CLEANUP_PATH_BLOCKED');
  return profile;
}

function eligibility(entityType: string, entityId: string) {
  return withDatabase((db) => {
    const evidence = db.prepare(`
      SELECT d.doc_id,d.parse_status,s.source_mode,i.cutover_run_id,r.status AS cutover_status,
             EXISTS(SELECT 1 FROM wiki_recovery_rehearsal rr WHERE rr.cutover_run_id=i.cutover_run_id AND rr.status='succeeded') AS recovery_succeeded
      FROM wiki_document d
      JOIN wiki_document_source_mode s ON s.doc_id=d.doc_id
      LEFT JOIN wiki_cutover_item i ON i.doc_id=d.doc_id
      LEFT JOIN wiki_cutover_run r ON r.id=i.cutover_run_id
      WHERE d.entity_type=? AND d.entity_id=?
      ORDER BY i.created_at DESC LIMIT 1
    `).get(entityType, entityId) as Row | undefined;
    const blockers: string[] = [];
    if (!evidence) blockers.push('markdown_document_missing');
    else {
      if (evidence.parse_status !== 'valid') blockers.push('markdown_document_invalid');
      if (evidence.source_mode !== 'markdown') blockers.push('source_mode_not_markdown');
      if (evidence.cutover_status !== 'succeeded') blockers.push('cutover_not_succeeded');
      if (!evidence.recovery_succeeded) blockers.push('recovery_rehearsal_missing');
    }
    return { evidence: evidence ?? null, blockers };
  });
}

export function runWikiLegacyCleanupDryRun(outputRootInput: string) {
  const outputRoot = path.resolve(outputRootInput);
  const profile = isolatedOutputRoot(outputRoot);
  const existing = withDatabase((db) => db.prepare('SELECT * FROM wiki_legacy_cleanup_run WHERE output_root=?').get(outputRoot) as Row | undefined);
  if (existing) {
    const manifestFile = path.join(outputRoot, 'cleanup-manifest.json');
    check(existsSync(manifestFile) && sha256(readFileSync(manifestFile)) === existing.manifest_hash, '기존 cleanup manifest가 원장과 다릅니다.', 409, 'WIKI_CLEANUP_EXISTING_MISMATCH');
    return { run: existing, manifest: JSON.parse(readFileSync(manifestFile, 'utf8')), duplicate: true };
  }
  check(!existsSync(outputRoot), '기존 cleanup 출력 폴더를 덮어쓰지 않습니다.', 409, 'WIKI_CLEANUP_OUTPUT_EXISTS');
  const staging = `${outputRoot}.staging-${randomUUID()}`;
  mkdirSync(staging, { recursive: false });
  const snapshot = withDatabase((db) => ({
    revisions: db.prepare('SELECT id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at FROM entity_wiki_revision ORDER BY entity_type,entity_id,version,id').all() as Row[],
    drafts: db.prepare('SELECT run_id,entity_type,entity_id,base_version,sections_json,change_summary,review_status,created_at FROM wiki_draft ORDER BY entity_type,entity_id,run_id').all() as Row[],
  }));
  const sourceSnapshotHash = sha256(JSON.stringify(snapshot));
  const items: Row[] = [];
    for (const revision of snapshot.revisions) {
      const gate = eligibility(revision.entity_type, revision.entity_id);
      const body = `${JSON.stringify({ schema: 'legacy-wiki-revision-archive-v1', source: revision }, null, 2)}\n`;
      const relativePath = `legacy-bodies/revisions/${revision.id}.json`;
      writeExclusive(path.join(staging, ...relativePath.split('/')), body);
      items.push({ sourceKind: 'revision', sourceId: revision.id, entityType: revision.entity_type, entityId: revision.entity_id, eligibility: gate.blockers.length ? 'blocked' : 'eligible', bodyHash: sha256(revision.sections_json), archiveRelativePath: relativePath, archiveHash: sha256(body), blockers: gate.blockers, cutoverEvidence: gate.evidence });
    }
    for (const draft of snapshot.drafts) {
      const body = `${JSON.stringify({ schema: 'legacy-wiki-draft-archive-v1', source: draft }, null, 2)}\n`;
      const relativePath = `legacy-bodies/drafts/${draft.run_id}.json`;
      writeExclusive(path.join(staging, ...relativePath.split('/')), body);
      items.push({ sourceKind: 'draft', sourceId: draft.run_id, entityType: draft.entity_type, entityId: draft.entity_id, eligibility: 'blocked', bodyHash: sha256(draft.sections_json), archiveRelativePath: relativePath, archiveHash: sha256(body), blockers: ['draft_retention_or_resolution_required'], cutoverEvidence: null });
    }
    const eligibleRevisionCount = items.filter((item) => item.sourceKind === 'revision' && item.eligibility === 'eligible').length;
    const blockedRevisionCount = snapshot.revisions.length - eligibleRevisionCount;
    const status = blockedRevisionCount === 0 && snapshot.drafts.length === 0 ? 'ready' : 'blocked';
    const completedAt = now();
    const runId = `wiki-cleanup-${sha256(`${sourceSnapshotHash}:${outputRoot.toLowerCase()}`).slice(0, 24)}`;
    const manifest = {
      schema: 'wiki-legacy-cleanup-dry-run-v1', runId, profile, status, sourceSnapshotHash,
      summary: { revisionCount: snapshot.revisions.length, eligibleRevisionCount, blockedRevisionCount, draftCount: snapshot.drafts.length },
      items,
      guarantees: { databaseBodyModified: false, activeMarkdownModified: false, archiveVerifiedBeforeAnyRedaction: true, operationalExecutionAllowed: false },
      createdAt: completedAt,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    writeExclusive(path.join(staging, 'cleanup-manifest.json'), manifestText);
    const manifestHash = sha256(manifestText);
    renameSync(staging, outputRoot);
    withDatabase((db) => transaction(db, () => {
      db.prepare(`INSERT INTO wiki_legacy_cleanup_run(id,profile,output_root,status,revision_count,eligible_revision_count,blocked_revision_count,draft_count,source_snapshot_hash,manifest_hash,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(runId, profile, outputRoot, status, snapshot.revisions.length, eligibleRevisionCount, blockedRevisionCount, snapshot.drafts.length, sourceSnapshotHash, manifestHash, completedAt, completedAt);
      const insert = db.prepare(`INSERT INTO wiki_legacy_cleanup_item(id,cleanup_run_id,source_kind,source_id,entity_type,entity_id,eligibility,body_hash,archive_relative_path,archive_hash,blockers_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of items) insert.run(randomUUID(), runId, item.sourceKind, item.sourceId, item.entityType, item.entityId, item.eligibility, item.bodyHash, item.archiveRelativePath, item.archiveHash, JSON.stringify(item.blockers), completedAt);
    }));
    return { run: withDatabase((db) => db.prepare('SELECT * FROM wiki_legacy_cleanup_run WHERE id=?').get(runId)), manifest, duplicate: false };
}
