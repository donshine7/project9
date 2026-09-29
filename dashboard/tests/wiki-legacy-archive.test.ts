import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteWikiLegacyBodies, runWikiLegacyArchiveDryRun, verifyWikiLegacyArchive } from '../lib/wiki-legacy-archive';
import { withDatabase } from '../lib/work-db';

const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-build-f-'));
const database = path.join(root, 'db', 'work.db');
const vault = path.join(root, 'vault');
const file = path.join(vault, '10_Matters', 'one.md');
const bundle = path.join(root, 'cutover-bundle');
const restore = path.join(root, 'restore');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const at = '2026-09-29T00:00:00.000Z';
process.env.SSPAT_RUNTIME_PROFILE = 'test';
process.env.SSPAT_ISOLATED_ROOT = root;
process.env.SSPAT_WORK_DB_PATH = database;
process.env.SSPAT_WIKI_VAULT_PATH = vault;
process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(root, 'notice');
process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(root, 'spec');
process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(root, 'provisional');

function seed() {
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(bundle);
  mkdirSync(restore);
  const bytes = '# Synthetic Wiki\n';
  writeFileSync(file, bytes);
  const byteHash = hash(bytes);
  withDatabase((db) => {
    db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at)
      VALUES ('m1','P260901-KR','상상특허','patent','KR','P260901','["KR"]','user_input',1,1,?,?)`).run(at, at);
    db.prepare(`INSERT INTO decision_run(id,operation,status,started_at) VALUES ('r1','wiki_revision','succeeded',?)`).run(at);
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at)
      VALUES ('published','matter','m1','wiki.publish','{}','장진태','user_input',?)`).run(at);
    db.prepare(`INSERT INTO entity_wiki_revision(id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at)
      VALUES ('rev1','matter','m1',1,'r1','[{"key":"overview","sentences":[]}]','legacy','input','published',?)`).run(at);
    db.prepare(`INSERT INTO wiki_markdown_scan(id,profile,vault_fingerprint,status,processing_mode,discovered_count,indexed_count,issue_count,changed_count,unchanged_count,elapsed_ms,snapshot_hash,started_at,completed_at)
      VALUES ('scan','test','vault','succeeded','full_parse',1,1,0,1,0,1,'snapshot',?,?)`).run(at, at);
    db.prepare(`INSERT INTO wiki_document(doc_id,document_type,entity_type,entity_id,title,relative_path,byte_hash,text_hash,file_size,file_mtime_ms,parse_status,last_seen_scan_id,created_at,updated_at)
      VALUES ('doc1','entity_wiki','matter','m1','one','10_Matters/one.md',?,?,?,1,'valid','scan',?,?)`).run(byteHash, byteHash, Buffer.byteLength(bytes), at, at);
    db.prepare(`INSERT INTO wiki_markdown_revision(id,doc_id,revision_number,scan_id,relative_path,byte_hash,text_hash,file_size,history_object_path,git_status,origin,observed_at)
      VALUES ('mdrev1','doc1',1,'scan','10_Matters/one.md',?,?,?,'.sspat-history/one','unavailable','migration',?)`).run(byteHash, byteHash, Buffer.byteLength(bytes), at);
    db.prepare(`UPDATE wiki_document SET current_revision_id='mdrev1' WHERE doc_id='doc1'`).run();
    const approval = { schema: 'wiki-document-approval-v1', approval: 'approve_as_is', docId: 'doc1', byteHash,
      textHash: byteHash,
      revisionId: 'mdrev1', sourceMode: 'legacy_db', automaticApply: false, sourceCutoverPerformed: false };
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at)
      VALUES ('approved','matter','m1','wiki.document_approved',?,'장진태','user_input','doc1',?)`).run(JSON.stringify(approval), at);
    db.prepare(`INSERT INTO user_feedback(id,event_id,actor_id,feedback_action,final_value_json,reason_code,created_at)
      VALUES ('feedback','approved','장진태','accept',?,'approved_as_is',?)`).run(JSON.stringify(approval), at);
    db.prepare(`INSERT INTO wiki_cutover_run(id,authorization_id,reviewer,runtime_profile,code_commit,bundle_path,status,target_count,created_at,completed_at)
      VALUES ('cutover','auth','장진태','test','commit',?,'succeeded',1,?,?)`).run(bundle, at, at);
    const before = { docId: 'doc1', sourceMode: 'legacy_db', legacyRevisionId: 'rev1' };
    const after = { docId: 'doc1', sourceMode: 'markdown', byteHash, markdownRevisionId: 'mdrev1',
      approvalKind: 'document', approvalId: 'approved', automaticApply: false };
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at)
      VALUES ('changed','matter','m1','wiki.source_mode_changed',?,?,'장진태','user_input','auth',?)`).run(JSON.stringify(before), JSON.stringify(after), at);
    db.prepare(`INSERT INTO wiki_document_source_mode(doc_id,source_mode,legacy_entity_type,legacy_entity_id,changed_by_event_id,changed_at)
      VALUES ('doc1','markdown','matter','m1','changed',?)`).run(at);
    db.prepare(`INSERT INTO wiki_cutover_item(id,cutover_run_id,doc_id,entity_type,entity_id,previous_source_mode,new_source_mode,expected_byte_hash,markdown_revision_id,document_approval_event_id,legacy_revision_id,source_change_event_id,created_at)
      VALUES ('item','cutover','doc1','matter','m1','legacy_db','markdown',?,'mdrev1','approved','rev1','changed',?)`).run(byteHash, at);
    const verifications = [{ docId: 'doc1', byteHash, markdownRevisionId: 'mdrev1', sourceChangeEventId: 'changed',
      sourceMode: 'markdown', approvalKind: 'document', documentApprovalEventId: 'approved', proposalReviewId: null }];
    db.prepare(`INSERT INTO wiki_recovery_rehearsal(id,cutover_run_id,restore_root,restored_database_hash,restored_vault_hash,verification_hash,verified_document_count,status,created_at,completed_at)
      VALUES ('recovery','cutover',?,'dbhash','vaulthash',?,1,'succeeded',?,?)`).run(restore, hash(JSON.stringify(verifications)), at, at);
  });
  writeFileSync(path.join(bundle, 'cutover-manifest.json'), JSON.stringify({ schema: 'wiki-cutover-bundle-v1', runId: 'cutover',
    authorizationId: 'auth', reviewer: '장진태', runtimeProfile: 'test',
    guarantees: { legacyRevisionDeleted: false, activeMarkdownModified: false },
    targets: [{ docId: 'doc1', legacyRevisionId: 'rev1', byteHash, markdownRevisionId: 'mdrev1',
      approvalKind: 'document', documentApprovalEventId: 'approved', proposalReviewId: null, sourceMode: 'markdown' }] }));
  const verifications = [{ docId: 'doc1', byteHash, markdownRevisionId: 'mdrev1', sourceChangeEventId: 'changed',
    sourceMode: 'markdown', approvalKind: 'document', documentApprovalEventId: 'approved', proposalReviewId: null }];
  writeFileSync(path.join(restore, 'recovery-report.json'), JSON.stringify({ schema: 'wiki-recovery-rehearsal-v1',
    rehearsalId: 'recovery', cutoverRunId: 'cutover', restoredDatabaseHash: 'dbhash', restoredVaultHash: 'vaulthash',
    verificationHash: hash(JSON.stringify(verifications)), verifiedDocumentCount: 1, productionModified: false, verifications }));
}

function errorCode(operation: () => unknown, code: string) {
  assert.throws(operation, (error: any) => error?.code === code);
}

function run() {
  try {
    seed();
    const original = withDatabase((db) => ({ revision: db.prepare('SELECT * FROM entity_wiki_revision').all(),
      mode: db.prepare('SELECT * FROM wiki_document_source_mode').all() }));
    const readyRoot = path.join(root, 'archive-ready');
    const ready = runWikiLegacyArchiveDryRun(readyRoot);
    assert.equal(ready.manifest.status, 'evidence_complete');
    assert.equal(ready.manifest.summary.revisionCount, 1);
    assert.equal(ready.manifest.guarantees.deletionSupported, false);
    assert.equal(ready.manifest.items[0].evidence.cutoverItem.legacy_revision_id, 'rev1');
    assert.equal(runWikiLegacyArchiveDryRun(readyRoot).duplicate, true);
    assert.equal(verifyWikiLegacyArchive(readyRoot).duplicate, true);
    assert.deepEqual(withDatabase((db) => ({ revision: db.prepare('SELECT * FROM entity_wiki_revision').all(),
      mode: db.prepare('SELECT * FROM wiki_document_source_mode').all() })), original);
    errorCode(() => deleteWikiLegacyBodies(), 'WIKI_ARCHIVE_DELETION_UNSUPPORTED');
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'db', 'bad')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(vault, 'bad')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(bundle, 'bad')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(restore, 'bad')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    mkdirSync(path.join(root, 'unrecorded'));
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'unrecorded')), 'WIKI_ARCHIVE_PARTIAL_BLOCKED');
    process.env.SSPAT_RUNTIME_PROFILE = 'operational';
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'operational')), 'WIKI_ARCHIVE_OPERATIONAL_BLOCKED');
    process.env.SSPAT_RUNTIME_PROFILE = 'test';
    let symlinkCreated = false;
    try { symlinkSync(bundle, path.join(root, 'linked-bundle'), 'junction'); symlinkCreated = true; } catch { /* Windows symlink privilege may be absent. */ }
    if (symlinkCreated) errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'linked-bundle', 'archive')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    try {
      symlinkSync(path.join(root, 'missing-target'), path.join(root, 'broken-link'), 'junction');
      errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'broken-link')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOENT'].includes((error as any)?.code)) throw error;
    }
    const archivedFile = path.join(readyRoot, ...ready.manifest.items[0].archiveRelativePath.split('/'));
    writeFileSync(archivedFile, 'tampered');
    errorCode(() => runWikiLegacyArchiveDryRun(readyRoot), 'WIKI_ARCHIVE_EXISTING_MISMATCH');
    writeFileSync(archivedFile, `${JSON.stringify({ schema: 'wiki-legacy-revision-archive-v2',
      source: original.revision[0], evidence: ready.manifest.items[0].evidence }, null, 2)}\n`);
    assert.equal(runWikiLegacyArchiveDryRun(readyRoot).duplicate, true);
    const recoveryReport = path.join(restore, 'recovery-report.json');
    const recoveryOriginal = readFileSync(recoveryReport);
    writeFileSync(recoveryReport, '{}');
    const badRecovery = runWikiLegacyArchiveDryRun(path.join(root, 'archive-recovery-blocked'));
    assert.ok(badRecovery.manifest.items[0].blockers.includes('recovery_rehearsal_missing_or_invalid'));
    writeFileSync(recoveryReport, recoveryOriginal);
    const markdownOriginal = readFileSync(file);
    writeFileSync(file, 'changed');
    const badMarkdown = runWikiLegacyArchiveDryRun(path.join(root, 'archive-markdown-blocked'));
    assert.ok(badMarkdown.manifest.items[0].blockers.includes('markdown_file_missing_or_changed'));
    writeFileSync(file, markdownOriginal);
    assert.equal(verifyWikiLegacyArchive(readyRoot).duplicate, true);
    withDatabase((db) => {
      db.prepare(`INSERT INTO decision_run(id,operation,status,started_at) VALUES ('draft-run','wiki_revision','succeeded',?)`).run(at);
      db.prepare(`INSERT INTO wiki_draft(run_id,entity_type,entity_id,base_version,sections_json,change_summary,review_status,created_at)
        VALUES ('draft-run','matter','m1',1,'[]','draft','pending',?)`).run(at);
      db.prepare(`INSERT INTO wiki_revision(id,matter_id,version,content,evidence_event_ids_json,created_at)
        VALUES ('historic','m1',1,'old legacy text','["published"]',?)`).run(at);
    });
    const blocked = runWikiLegacyArchiveDryRun(path.join(root, 'archive-blocked'));
    assert.equal(blocked.manifest.status, 'blocked');
    assert.equal(blocked.manifest.summary.historicRevisionCount, 1);
    assert.ok(blocked.manifest.items.find((item) => item.sourceKind === 'draft')?.blockers.includes('draft_retention_or_resolution_required'));
    assert.ok(blocked.manifest.items.find((item) => item.sourceKind === 'historic_revision')?.blockers.includes('historic_revision_retention_required'));
    withDatabase((db) => {
      db.prepare(`INSERT INTO wiki_cutover_run(id,authorization_id,reviewer,runtime_profile,code_commit,bundle_path,status,target_count,created_at,completed_at)
        VALUES ('cutover2','auth2','장진태','test','commit',?,'succeeded',1,?,?)`).run(path.join(root, 'bundle2'), at, at);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at)
        VALUES ('changed2','matter','m1','wiki.source_mode_changed','{}','장진태','user_input',?)`).run(at);
      db.prepare(`INSERT INTO wiki_cutover_item(id,cutover_run_id,doc_id,entity_type,entity_id,previous_source_mode,new_source_mode,expected_byte_hash,markdown_revision_id,document_approval_event_id,legacy_revision_id,source_change_event_id,created_at)
        VALUES ('item2','cutover2','doc1','matter','m1','legacy_db','markdown',?,'mdrev1','approved','rev1','changed2',?)`)
        .run(hash(markdownOriginal), at);
    });
    const duplicateCutover = runWikiLegacyArchiveDryRun(path.join(root, 'archive-duplicate-cutover'));
    assert.ok(duplicateCutover.manifest.items.find((item) => item.sourceId === 'rev1')?.blockers.includes('exact_legacy_cutover_missing_or_duplicate'));
    errorCode(() => runWikiLegacyArchiveDryRun(readyRoot), 'WIKI_ARCHIVE_EXISTING_MISMATCH');
    const failedRoot = path.join(root, 'archive-partial');
    errorCode(() => runWikiLegacyArchiveDryRun(failedRoot, { failAfterArtifact: 1 }), 'WIKI_ARCHIVE_INJECTED_FAILURE');
    assert.equal(existsSync(`${failedRoot}.staging`), true);
    assert.equal(existsSync(failedRoot), false);
    errorCode(() => runWikiLegacyArchiveDryRun(failedRoot), 'WIKI_ARCHIVE_PARTIAL_BLOCKED');
    const rows = withDatabase((db) => db.prepare('SELECT * FROM wiki_legacy_archive_run').all());
    assert.equal(rows.length, 5);
    assert.throws(() => withDatabase((db) => db.prepare('DELETE FROM wiki_legacy_archive_run').run()), /sealed wiki archive run cannot be deleted/);
    console.log('BUILD-F sealed archive, audit binding, tamper, stale, partial, path and no-delete tests passed.');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

run();
