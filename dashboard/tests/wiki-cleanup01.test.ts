import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWikiLegacyCleanupDryRun } from '../lib/wiki-cleanup';
import { withDatabase } from '../lib/work-db';

const externalRoot = String(process.env.SSPAT_CLEANUP_TEST_ROOT ?? '').trim();
const root = externalRoot ? path.resolve(externalRoot) : mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-cleanup01-'));
if (externalRoot) mkdirSync(root, { recursive: true });
const database = path.join(root, 'db', 'work.db');
process.env.SSPAT_RUNTIME_PROFILE = 'test';
process.env.SSPAT_ISOLATED_ROOT = root;
process.env.SSPAT_WORK_DB_PATH = database;
process.env.SSPAT_WIKI_VAULT_PATH = path.join(root, 'vault');
process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(root, 'notice');
process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(root, 'spec');
process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(root, 'provisional');

function seedEligible() {
  withDatabase((db) => {
    const at = '2026-09-26T00:00:00.000Z';
    db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES ('cleanup-matter-1','P260801-KR','상상특허','patent','KR','P260801','["KR"]','user_input',1,1,?,?)`).run(at, at);
    for (const [id, operation] of [['cleanup-legacy-run','wiki_revision'],['cleanup-proposal-run','wiki_markdown_proposal']] as const) db.prepare(`INSERT INTO decision_run(id,operation,status,started_at) VALUES (?,?,'succeeded',?)`).run(id, operation, at);
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES ('cleanup-publish-event','matter','cleanup-matter-1','wiki.publish','{}','장진태','user_input',?)`).run(at);
    db.prepare(`INSERT INTO entity_wiki_revision(id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at) VALUES ('cleanup-revision-1','matter','cleanup-matter-1',1,'cleanup-legacy-run','[{"key":"overview","title":"요약","sentences":[]}]','legacy','input','cleanup-publish-event',?)`).run(at);
    db.prepare(`INSERT INTO wiki_markdown_scan(id,profile,vault_fingerprint,status,processing_mode,discovered_count,indexed_count,issue_count,changed_count,unchanged_count,elapsed_ms,snapshot_hash,started_at,completed_at) VALUES ('cleanup-scan','test','vault','succeeded','full_parse',1,1,0,1,0,1,'snapshot',?,?)`).run(at, at);
    db.prepare(`INSERT INTO wiki_document(doc_id,document_type,entity_type,entity_id,title,relative_path,byte_hash,text_hash,file_size,file_mtime_ms,parse_status,last_seen_scan_id,created_at,updated_at) VALUES ('wiki-cleanup-1','entity_wiki','matter','cleanup-matter-1','cleanup','10_Matters/P260801-KR.md','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',10,1,'valid','cleanup-scan',?,?)`).run(at, at);
    db.prepare(`INSERT INTO wiki_markdown_revision(id,doc_id,revision_number,scan_id,relative_path,byte_hash,text_hash,file_size,history_object_path,git_status,origin,observed_at) VALUES ('cleanup-md-revision','wiki-cleanup-1',1,'cleanup-scan','10_Matters/P260801-KR.md','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',10,'.sspat-history/objects/aa/a.md','unavailable','migration',?)`).run(at);
    db.prepare(`UPDATE wiki_document SET current_revision_id='cleanup-md-revision' WHERE doc_id='wiki-cleanup-1'`).run();
    db.prepare(`INSERT INTO wiki_document_source_mode(doc_id,source_mode,changed_at) VALUES ('wiki-cleanup-1','markdown',?)`).run(at);
    db.prepare(`INSERT INTO wiki_file_operation(id,operation_type,subject_id,status,base_byte_hash,target_byte_hash,relative_path,created_at,updated_at) VALUES ('cleanup-file-op','proposal_write','cleanup-proposal','succeeded','base','target','80_Proposals/cleanup.md',?,?)`).run(at, at);
    db.prepare(`INSERT INTO wiki_proposal(id,run_id,doc_id,operation_id,base_byte_hash,base_text_hash,evidence_snapshot_hash,proposal_relative_path,proposal_byte_hash,target_byte_hash,change_summary,status,created_at,updated_at) VALUES ('cleanup-proposal','cleanup-proposal-run','wiki-cleanup-1','cleanup-file-op','base','text','evidence','80_Proposals/cleanup.md','proposal','target','cleanup','applied_observed',?,?)`).run(at, at);
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES ('cleanup-review-event','matter','cleanup-matter-1','wiki.proposal_reviewed','{}','장진태','user_input',?)`).run(at);
    db.prepare(`INSERT INTO wiki_proposal_review(id,proposal_id,action,reviewer,reviewed_base_byte_hash,reviewed_evidence_snapshot_hash,review_event_id,created_at) VALUES ('cleanup-review','cleanup-proposal','accept_for_manual_apply','장진태','base','evidence','cleanup-review-event',?)`).run(at);
    db.prepare(`INSERT INTO wiki_cutover_run(id,authorization_id,reviewer,runtime_profile,code_commit,bundle_path,status,target_count,created_at,completed_at) VALUES ('cleanup-cutover','cleanup-auth','장진태','test','commit',?,'succeeded',1,?,?)`).run(path.join(root, 'bundle'), at, at);
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES ('cleanup-source-event','matter','cleanup-matter-1','wiki.source_mode_changed','{}','장진태','user_input',?)`).run(at);
    db.prepare(`INSERT INTO wiki_cutover_item(id,cutover_run_id,doc_id,entity_type,entity_id,previous_source_mode,new_source_mode,expected_byte_hash,markdown_revision_id,proposal_id,proposal_review_id,legacy_revision_id,source_change_event_id,created_at) VALUES ('cleanup-cutover-item','cleanup-cutover','wiki-cleanup-1','matter','cleanup-matter-1','legacy_db','markdown','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','cleanup-md-revision','cleanup-proposal','cleanup-review','cleanup-revision-1','cleanup-source-event',?)`).run(at);
    db.prepare(`INSERT INTO wiki_recovery_rehearsal(id,cutover_run_id,restore_root,restored_database_hash,restored_vault_hash,verification_hash,verified_document_count,status,created_at,completed_at) VALUES ('cleanup-recovery','cleanup-cutover',?,'db','vault','verify',1,'succeeded',?,?)`).run(path.join(root, 'restore'), at, at);
  });
}

function addBlocked() {
  withDatabase((db) => {
    const at = '2026-09-26T01:00:00.000Z';
    db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES ('cleanup-matter-2','P260802-KR','상상특허','patent','KR','P260802','["KR"]','user_input',1,1,?,?)`).run(at, at);
    for (const [id, operation] of [['cleanup-blocked-run','wiki_revision'],['cleanup-draft-run','wiki_revision']] as const) db.prepare(`INSERT INTO decision_run(id,operation,status,started_at) VALUES (?,?,'succeeded',?)`).run(id, operation, at);
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES ('cleanup-blocked-event','matter','cleanup-matter-2','wiki.publish','{}','장진태','user_input',?)`).run(at);
    db.prepare(`INSERT INTO entity_wiki_revision(id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at) VALUES ('cleanup-revision-2','matter','cleanup-matter-2',1,'cleanup-blocked-run','[{"key":"overview","title":"미전환","sentences":[]}]','legacy','input','cleanup-blocked-event',?)`).run(at);
    db.prepare(`INSERT INTO wiki_draft(run_id,entity_type,entity_id,base_version,sections_json,change_summary,review_status,created_at) VALUES ('cleanup-draft-run','matter','cleanup-matter-2',1,'[{"key":"overview","title":"초안","sentences":[]}]','draft','pending',?)`).run(at);
  });
}

async function main() {
  try {
    seedEligible();
    const before = withDatabase((db) => db.prepare('SELECT * FROM entity_wiki_revision ORDER BY id').all());
    const ready: any = runWikiLegacyCleanupDryRun(path.join(root, 'cleanup-ready'));
    assert.equal(ready.run.status, 'ready');
    assert.equal(ready.manifest.summary.eligibleRevisionCount, 1);
    assert.equal(ready.manifest.guarantees.databaseBodyModified, false);
    assert.equal(existsSync(path.join(root, 'cleanup-ready', 'legacy-bodies', 'revisions', 'cleanup-revision-1.json')), true);
    assert.equal((runWikiLegacyCleanupDryRun(path.join(root, 'cleanup-ready')) as any).duplicate, true);
    assert.deepEqual(withDatabase((db) => db.prepare('SELECT * FROM entity_wiki_revision ORDER BY id').all()), before);

    addBlocked();
    const blocked: any = runWikiLegacyCleanupDryRun(path.join(root, 'cleanup-blocked'));
    assert.equal(blocked.run.status, 'blocked');
    assert.equal(blocked.manifest.summary.eligibleRevisionCount, 1);
    assert.equal(blocked.manifest.summary.blockedRevisionCount, 1);
    assert.equal(blocked.manifest.summary.draftCount, 1);
    assert.ok(blocked.manifest.items.find((item: any) => item.sourceId === 'cleanup-revision-2').blockers.includes('markdown_document_missing'));
    assert.ok(blocked.manifest.items.find((item: any) => item.sourceKind === 'draft').blockers.includes('draft_retention_or_resolution_required'));
    const archive = JSON.parse(readFileSync(path.join(root, 'cleanup-blocked', 'legacy-bodies', 'drafts', 'cleanup-draft-run.json'), 'utf8'));
    assert.equal(archive.source.review_status, 'pending');

    process.env.SSPAT_RUNTIME_PROFILE = 'operational';
    assert.throws(() => runWikiLegacyCleanupDryRun(path.join(root, 'blocked-operational')), (error: any) => error?.code === 'WIKI_CLEANUP_OPERATIONAL_BLOCKED');
    process.env.SSPAT_RUNTIME_PROFILE = 'test';
    const reportPath = String(process.env.SSPAT_CLEANUP_TEST_REPORT ?? '').trim();
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify({
      schema: 'wiki-cleanup-eval-results-v1',
      ready: ready.manifest.summary,
      blocked: blocked.manifest.summary,
      guarantees: blocked.manifest.guarantees,
      databaseCounts: withDatabase((db) => ({
        revisions: Number((db.prepare('SELECT COUNT(*) count FROM entity_wiki_revision').get() as any).count),
        drafts: Number((db.prepare('SELECT COUNT(*) count FROM wiki_draft').get() as any).count),
        cleanupRuns: Number((db.prepare('SELECT COUNT(*) count FROM wiki_legacy_cleanup_run').get() as any).count),
        cleanupItems: Number((db.prepare('SELECT COUNT(*) count FROM wiki_legacy_cleanup_item').get() as any).count),
      })),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log('CLEANUP-01 immutable archive, cutover/recovery eligibility, blocker and no-redaction tests passed.');
  } finally { if (process.env.SSPAT_CLEANUP_TEST_KEEP !== '1') rmSync(root, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
