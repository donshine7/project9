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

function configureEnvironment(isolatedRoot: string, databaseFile: string, vaultRoot: string) {
  process.env.SSPAT_RUNTIME_PROFILE = 'test';
  process.env.SSPAT_ISOLATED_ROOT = isolatedRoot;
  process.env.SSPAT_WORK_DB_PATH = databaseFile;
  process.env.SSPAT_WIKI_VAULT_PATH = vaultRoot;
  process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(isolatedRoot, 'notice');
  process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(isolatedRoot, 'spec');
  process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(isolatedRoot, 'provisional');
}

configureEnvironment(root, database, vault);

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

function proposalApprovalBindingTests() {
  const proposalRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-build-f-proposal-'));
  const proposalDatabase = path.join(proposalRoot, 'db', 'work.db');
  const proposalVault = path.join(proposalRoot, 'vault');
  const proposalFile = path.join(proposalVault, '10_Matters', 'proposal.md');
  const proposalBundle = path.join(proposalRoot, 'cutover-bundle');
  const proposalRestore = path.join(proposalRoot, 'restore');
  try {
    configureEnvironment(proposalRoot, proposalDatabase, proposalVault);
    mkdirSync(path.dirname(proposalFile), { recursive: true });
    mkdirSync(proposalBundle);
    mkdirSync(proposalRestore);
    const markdown = '# Proposal Wiki\n';
    const markdownHash = hash(markdown);
    const baseHash = hash('# Before Proposal\n');
    const evidenceHash = hash('proposal-evidence');
    const canonicalReview = { proposalId: 'proposal', baseByteHash: baseHash, targetByteHash: markdownHash,
      evidenceSnapshotHash: evidenceHash, automaticApply: false };
    const verification = { docId: 'proposal-doc', byteHash: markdownHash, markdownRevisionId: 'proposal-md-current',
      sourceChangeEventId: 'proposal-changed', sourceMode: 'markdown', approvalKind: 'proposal',
      documentApprovalEventId: null, proposalReviewId: 'proposal-review' };
    writeFileSync(proposalFile, markdown);
    withDatabase((db) => {
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at)
        VALUES ('proposal-matter','P260902-KR','상상특허','patent','KR','P260902','["KR"]','user_input',1,1,?,?)`).run(at, at);
      db.prepare(`INSERT INTO decision_run(id,operation,status,started_at) VALUES ('proposal-revision-run','wiki_revision','succeeded',?)`).run(at);
      db.prepare(`INSERT INTO decision_run(id,operation,status,started_at) VALUES ('proposal-decision-run','wiki_synthesizer','succeeded',?)`).run(at);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at)
        VALUES ('proposal-published','matter','proposal-matter','wiki.publish','{}','장진태','user_input',?)`).run(at);
      db.prepare(`INSERT INTO entity_wiki_revision(id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at)
        VALUES ('proposal-legacy-revision','matter','proposal-matter',1,'proposal-revision-run','[]','legacy','input','proposal-published',?)`).run(at);
      db.prepare(`INSERT INTO wiki_markdown_scan(id,profile,vault_fingerprint,status,processing_mode,discovered_count,indexed_count,issue_count,changed_count,unchanged_count,elapsed_ms,snapshot_hash,started_at,completed_at)
        VALUES ('proposal-scan-base','test','vault-base','succeeded','full_parse',1,1,0,1,0,1,'snapshot-base',?,?)`).run(at, at);
      db.prepare(`INSERT INTO wiki_markdown_scan(id,profile,vault_fingerprint,status,processing_mode,discovered_count,indexed_count,issue_count,changed_count,unchanged_count,elapsed_ms,snapshot_hash,started_at,completed_at)
        VALUES ('proposal-scan','test','vault','succeeded','full_parse',1,1,0,1,0,1,'snapshot',?,?)`).run(at, at);
      db.prepare(`INSERT INTO wiki_document(doc_id,document_type,entity_type,entity_id,title,relative_path,byte_hash,text_hash,file_size,file_mtime_ms,parse_status,last_seen_scan_id,created_at,updated_at)
        VALUES ('proposal-doc','entity_wiki','matter','proposal-matter','proposal','10_Matters/proposal.md',?,?,?,1,'valid','proposal-scan',?,?)`)
        .run(markdownHash, markdownHash, Buffer.byteLength(markdown), at, at);
      db.prepare(`INSERT INTO wiki_markdown_revision(id,doc_id,revision_number,scan_id,relative_path,byte_hash,text_hash,file_size,history_object_path,git_status,origin,observed_at)
        VALUES ('proposal-md-base','proposal-doc',1,'proposal-scan-base','10_Matters/proposal.md',?,?,1,'.sspat-history/proposal-base','unavailable','human_observed',?)`).run(baseHash, baseHash, at);
      db.prepare(`INSERT INTO wiki_markdown_revision(id,doc_id,revision_number,scan_id,relative_path,byte_hash,text_hash,file_size,history_object_path,git_status,origin,observed_at)
        VALUES ('proposal-md-current','proposal-doc',2,'proposal-scan','10_Matters/proposal.md',?,?,?,'.sspat-history/proposal-current','unavailable','human_observed',?)`)
        .run(markdownHash, markdownHash, Buffer.byteLength(markdown), at);
      db.prepare(`UPDATE wiki_document SET current_revision_id='proposal-md-current' WHERE doc_id='proposal-doc'`).run();
      db.prepare(`INSERT INTO wiki_file_operation(id,operation_type,subject_id,status,base_byte_hash,target_byte_hash,relative_path,created_at,updated_at)
        VALUES ('proposal-operation','proposal_write','proposal','succeeded',?,?,'80_Proposals/proposal.md',?,?)`).run(baseHash, markdownHash, at, at);
      db.prepare(`INSERT INTO wiki_proposal(id,run_id,doc_id,operation_id,base_revision_id,base_byte_hash,base_text_hash,evidence_snapshot_hash,proposal_relative_path,proposal_byte_hash,target_byte_hash,change_summary,status,reviewer,reviewed_at,created_at,updated_at)
        VALUES ('proposal','proposal-decision-run','proposal-doc','proposal-operation','proposal-md-base',?,? ,?,'80_Proposals/proposal.md',?,?,'proposal','applied_observed','장진태',?,?,?)`)
        .run(baseHash, baseHash, evidenceHash, markdownHash, markdownHash, at, at, at);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at)
        VALUES ('proposal-review-event','matter','proposal-matter','wiki.proposal_reviewed',?,'장진태','user_input','proposal',?)`)
        .run(JSON.stringify(canonicalReview), at);
      db.prepare(`INSERT INTO wiki_proposal_review(id,proposal_id,action,reviewer,reviewed_base_byte_hash,reviewed_evidence_snapshot_hash,review_event_id,created_at)
        VALUES ('proposal-review','proposal','accept_for_manual_apply','장진태',?,?,'proposal-review-event',?)`).run(baseHash, evidenceHash, at);
      db.prepare(`INSERT INTO wiki_cutover_run(id,authorization_id,reviewer,runtime_profile,code_commit,bundle_path,status,target_count,created_at,completed_at)
        VALUES ('proposal-cutover','proposal-auth','장진태','test','commit',?,'succeeded',1,?,?)`).run(proposalBundle, at, at);
      const before = { docId: 'proposal-doc', sourceMode: 'legacy_db', legacyRevisionId: 'proposal-legacy-revision' };
      const after = { docId: 'proposal-doc', sourceMode: 'markdown', byteHash: markdownHash,
        markdownRevisionId: 'proposal-md-current', approvalKind: 'proposal', approvalId: 'proposal-review', automaticApply: false };
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at)
        VALUES ('proposal-changed','matter','proposal-matter','wiki.source_mode_changed',?,?,'장진태','user_input','proposal-auth',?)`)
        .run(JSON.stringify(before), JSON.stringify(after), at);
      db.prepare(`INSERT INTO wiki_document_source_mode(doc_id,source_mode,legacy_entity_type,legacy_entity_id,changed_by_event_id,changed_at)
        VALUES ('proposal-doc','markdown','matter','proposal-matter','proposal-changed',?)`).run(at);
      db.prepare(`INSERT INTO wiki_cutover_item(id,cutover_run_id,doc_id,entity_type,entity_id,previous_source_mode,new_source_mode,expected_byte_hash,markdown_revision_id,proposal_id,proposal_review_id,legacy_revision_id,source_change_event_id,created_at)
        VALUES ('proposal-cutover-item','proposal-cutover','proposal-doc','matter','proposal-matter','legacy_db','markdown',?,'proposal-md-current','proposal','proposal-review','proposal-legacy-revision','proposal-changed',?)`)
        .run(markdownHash, at);
      db.prepare(`INSERT INTO wiki_recovery_rehearsal(id,cutover_run_id,restore_root,restored_database_hash,restored_vault_hash,verification_hash,verified_document_count,status,created_at,completed_at)
        VALUES ('proposal-recovery','proposal-cutover',?,'dbhash','vaulthash',?,1,'succeeded',?,?)`)
        .run(proposalRestore, hash(JSON.stringify([verification])), at, at);
    });
    writeFileSync(path.join(proposalBundle, 'cutover-manifest.json'), JSON.stringify({ schema: 'wiki-cutover-bundle-v1',
      runId: 'proposal-cutover', authorizationId: 'proposal-auth', reviewer: '장진태', runtimeProfile: 'test',
      guarantees: { legacyRevisionDeleted: false, activeMarkdownModified: false },
      targets: [{ docId: 'proposal-doc', legacyRevisionId: 'proposal-legacy-revision', byteHash: markdownHash,
        markdownRevisionId: 'proposal-md-current', approvalKind: 'proposal', documentApprovalEventId: null,
        proposalReviewId: 'proposal-review', sourceMode: 'markdown' }] }));
    writeFileSync(path.join(proposalRestore, 'recovery-report.json'), JSON.stringify({ schema: 'wiki-recovery-rehearsal-v1',
      rehearsalId: 'proposal-recovery', cutoverRunId: 'proposal-cutover', restoredDatabaseHash: 'dbhash',
      restoredVaultHash: 'vaulthash', verificationHash: hash(JSON.stringify([verification])), verifiedDocumentCount: 1,
      productionModified: false, verifications: [verification] }));

    const valid = runWikiLegacyArchiveDryRun(path.join(proposalRoot, 'archive-valid'));
    assert.equal(valid.manifest.status, 'evidence_complete');
    const assertApprovalBlocked = (outputName: string) => {
      const result = runWikiLegacyArchiveDryRun(path.join(proposalRoot, outputName));
      assert.ok(result.manifest.items[0].blockers.includes('approval_audit_invalid'));
    };
    withDatabase((db) => db.prepare(`UPDATE event SET after_json=? WHERE id='proposal-review-event'`)
      .run(JSON.stringify({ ...canonicalReview, targetByteHash: 'tampered' })));
    assertApprovalBlocked('archive-target-tampered');
    withDatabase((db) => db.prepare(`UPDATE event SET after_json=?,correlation_id='wrong-proposal' WHERE id='proposal-review-event'`)
      .run(JSON.stringify(canonicalReview)));
    assertApprovalBlocked('archive-correlation-tampered');
    withDatabase((db) => db.prepare(`UPDATE event SET after_json=?,correlation_id='proposal' WHERE id='proposal-review-event'`)
      .run(JSON.stringify({ ...canonicalReview, automaticApply: true })));
    assertApprovalBlocked('archive-auto-apply-tampered');
    withDatabase((db) => db.prepare(`UPDATE event SET after_json=? WHERE id='proposal-review-event'`).run(JSON.stringify(canonicalReview)));
    assert.equal(verifyWikiLegacyArchive(path.join(proposalRoot, 'archive-valid')).duplicate, true);
  } finally {
    configureEnvironment(root, database, vault);
    rmSync(proposalRoot, { recursive: true, force: true });
  }
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
    const readyRunId = ready.run?.id;
    assert.ok(readyRunId);
    assert.throws(() => withDatabase((db) => db.prepare(`INSERT INTO wiki_legacy_archive_item(
      id,archive_run_id,source_kind,source_id,entity_type,entity_id,source_body_hash,
      archive_relative_path,archive_hash,evidence_hash,blockers_json
    ) VALUES ('late-item',?,'revision','late-source','matter','m1','body','late.json','archive','evidence','[]')`)
      .run(readyRunId)), /sealed wiki archive run cannot accept more items/);
    assert.deepEqual(withDatabase((db) => ({ revision: db.prepare('SELECT * FROM entity_wiki_revision').all(),
      mode: db.prepare('SELECT * FROM wiki_document_source_mode').all() })), original);
    errorCode(() => deleteWikiLegacyBodies(), 'WIKI_ARCHIVE_DELETION_UNSUPPORTED');
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'db', 'bad')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(vault, 'bad')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(bundle, 'bad')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(restore, 'bad')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    process.env.SSPAT_WIKI_VAULT_PATH = path.dirname(database);
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'archive-db-vault-overlap')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    process.env.SSPAT_WIKI_VAULT_PATH = vault;
    withDatabase((db) => db.prepare(`UPDATE wiki_cutover_run SET bundle_path=? WHERE id='cutover'`).run(vault));
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'archive-bundle-vault-overlap')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    withDatabase((db) => db.prepare(`UPDATE wiki_cutover_run SET bundle_path=? WHERE id='cutover'`).run(bundle));
    withDatabase((db) => db.prepare(`UPDATE wiki_recovery_rehearsal SET restore_root=? WHERE id='recovery'`).run(bundle));
    errorCode(() => runWikiLegacyArchiveDryRun(path.join(root, 'archive-bundle-recovery-overlap')), 'WIKI_ARCHIVE_PATH_BLOCKED');
    withDatabase((db) => db.prepare(`UPDATE wiki_recovery_rehearsal SET restore_root=? WHERE id='recovery'`).run(restore));
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
    proposalApprovalBindingTests();
    console.log('BUILD-F sealed archive, audit binding, tamper, stale, partial, path and no-delete tests passed.');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

run();
