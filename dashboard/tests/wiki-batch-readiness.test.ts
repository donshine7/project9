import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectWikiBatchReadiness } from '../lib/wiki-batch-readiness';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-batch-test-'));
const databasePath = path.join(root, 'work.db');
const vaultPath = path.join(root, 'vault');
const docId = 'synthetic-wiki-matter';
const matterId = randomUUID();
const evidenceId = randomUUID();
const revisionId = randomUUID();
const scanId = randomUUID();
const markdown = `# Synthetic test\n\n[^proof]: event:${evidenceId}\n`;
const byteHash = hash(markdown);
mkdirSync(vaultPath);
writeFileSync(path.join(vaultPath, 'matter.md'), markdown);

function mutate(sql: string, ...params: any[]) {
  const db = new DatabaseSync(databasePath);
  try { db.prepare(sql).run(...params); } finally { db.close(); }
}

try {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE wiki_markdown_scan(id TEXT,status TEXT,issue_count INTEGER,started_at TEXT,completed_at TEXT);
    CREATE TABLE wiki_markdown_scan_issue(scan_id TEXT,doc_id TEXT,relative_path TEXT);
    CREATE TABLE wiki_document(doc_id TEXT,document_type TEXT,entity_type TEXT,entity_id TEXT,relative_path TEXT,byte_hash TEXT,text_hash TEXT,parse_status TEXT,current_revision_id TEXT,last_seen_scan_id TEXT);
    CREATE TABLE wiki_document_source_mode(doc_id TEXT,source_mode TEXT,legacy_entity_type TEXT,legacy_entity_id TEXT,changed_by_event_id TEXT);
    CREATE TABLE wiki_markdown_revision(id TEXT,doc_id TEXT,byte_hash TEXT);
    CREATE TABLE matter(id TEXT,our_ref TEXT,archived_at TEXT);
    CREATE TABLE action_item(matter_id TEXT,archived_at TEXT,status TEXT);
    CREATE TABLE entity_wiki_revision(id TEXT,entity_type TEXT,entity_id TEXT);
    CREATE TABLE wiki_draft(entity_type TEXT,entity_id TEXT,review_status TEXT);
    CREATE TABLE wiki_proposal(id TEXT,doc_id TEXT,created_at TEXT,status TEXT,target_byte_hash TEXT,evidence_snapshot_hash TEXT);
    CREATE TABLE wiki_proposal_review(proposal_id TEXT,created_at TEXT,action TEXT,reviewer TEXT,reviewed_evidence_snapshot_hash TEXT);
    CREATE TABLE wiki_proposal_evidence(proposal_id TEXT,validation_status TEXT);
    CREATE TABLE wiki_entry(event_id TEXT,entity_type TEXT,entity_id TEXT,supersedes_id TEXT);
    CREATE TABLE source_observation(id TEXT,entity_type TEXT,entity_id TEXT,user_confirmed INTEGER,source_type TEXT,source_id TEXT);
    CREATE TABLE event(id TEXT,entity_type TEXT,entity_id TEXT,event_type TEXT,before_json TEXT,after_json TEXT,actor TEXT,source_type TEXT,correlation_id TEXT,created_at TEXT);
    CREATE TABLE user_feedback(event_id TEXT,actor_id TEXT,feedback_action TEXT,reason_code TEXT,final_value_json TEXT,created_at TEXT,id TEXT);
    CREATE TABLE wiki_cutover_run(id TEXT,status TEXT);
    CREATE TABLE wiki_cutover_item(id TEXT,doc_id TEXT,cutover_run_id TEXT,expected_byte_hash TEXT,markdown_revision_id TEXT,source_change_event_id TEXT,created_at TEXT);
    CREATE TABLE wiki_recovery_rehearsal(cutover_run_id TEXT,status TEXT);
  `);
  db.prepare('INSERT INTO wiki_markdown_scan VALUES (?,?,?,?,?)').run(scanId, 'succeeded', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z');
  db.prepare('INSERT INTO wiki_document VALUES (?,?,?,?,?,?,?,?,?,?)').run(docId, 'entity_wiki', 'matter', matterId, 'matter.md', byteHash, byteHash, 'valid', revisionId, scanId);
  db.prepare('INSERT INTO wiki_document_source_mode VALUES (?,?,?,?,?)').run(docId, 'legacy_db', 'matter', matterId, null);
  db.prepare('INSERT INTO wiki_markdown_revision VALUES (?,?,?)').run(revisionId, docId, byteHash);
  db.prepare('INSERT INTO matter VALUES (?,?,NULL)').run(matterId, 'P999999');
  db.prepare('INSERT INTO entity_wiki_revision VALUES (?,?,?)').run(randomUUID(), 'matter', matterId);
  const evidenceEvent = {
    id: evidenceId, entity_type: 'matter', entity_id: matterId, event_type: 'test_evidence',
    before_json: null, after_json: '{}', actor: 'test', source_type: 'user_input',
    correlation_id: null, created_at: '2026-01-01T00:00:00Z',
  };
  db.prepare('INSERT INTO event VALUES (?,?,?,?,?,?,?,?,?,?)').run(...Object.values(evidenceEvent));
  const eventHash = hash(canonical({
    id: evidenceId, entityType: 'matter', entityId: matterId, eventType: 'test_evidence',
    beforeJson: null, afterJson: '{}', actor: 'test', sourceType: 'user_input',
    correlationId: null, createdAt: '2026-01-01T00:00:00Z',
  }));
  const evidenceSnapshotHash = hash(canonical([{ eventId: evidenceId, eventHash }]));
  const payload = {
    schema: 'wiki-document-approval-v1', approval: 'approve_as_is', docId,
    byteHash, textHash: byteHash, revisionId, sourceMode: 'legacy_db',
    automaticApply: false, sourceCutoverPerformed: false,
    evidenceEventIds: [evidenceId], evidenceSnapshotHash,
  };
  db.prepare('INSERT INTO event VALUES (?,?,?,?,?,?,?,?,?,?)').run('approval-1', 'matter', matterId, 'wiki.document_approved', null, JSON.stringify(payload), '장진태', 'user_input', docId, '2026-01-01T00:00:02Z');
  db.prepare('INSERT INTO user_feedback VALUES (?,?,?,?,?,?,?)').run('approval-1', '장진태', 'accept', 'approved_as_is', JSON.stringify({ docId, byteHash, approval: 'approve_as_is' }), '2026-01-01T00:00:03Z', 'feedback-1');
  db.close();

  const inspect = () => inspectWikiBatchReadiness({ databasePath, vaultPath });
  let result = inspect();
  assert.equal(result.readyForExpansion, true);
  assert.equal(result.metrics.eligibleCutover, 1);
  assert.equal(result.batches.cutoverDryRun.length, 1);

  writeFileSync(path.join(vaultPath, 'matter.md'), `${markdown}changed\n`);
  result = inspect();
  assert.equal(result.readyForExpansion, false);
  assert.deepEqual(result.candidates[0].blockers, ['FILE_HASH_STALE']);
  writeFileSync(path.join(vaultPath, 'matter.md'), markdown);

  mutate('INSERT INTO action_item VALUES (?,?,?)', matterId, null, '대기');
  result = inspect();
  assert.deepEqual(result.candidates[0].blockers, ['OPEN_ACTION']);
  mutate('DELETE FROM action_item');

  mutate('UPDATE event SET after_json=? WHERE id=?', '{"changed":true}', evidenceId);
  result = inspect();
  assert.deepEqual(result.candidates[0].blockers, ['EVIDENCE_HASH_MISMATCH']);
  mutate('UPDATE event SET after_json=? WHERE id=?', '{}', evidenceId);

  mutate('INSERT INTO event VALUES (?,?,?,?,?,?,?,?,?,?)', 'approval-2', 'matter', matterId, 'wiki.document_approved', null, JSON.stringify({ schema: 'wiki-document-approval-v1', approval: 'approve_as_is', docId, byteHash: '0'.repeat(64) }), '장진태', 'user_input', docId, '2026-01-01T00:00:05Z');
  result = inspect();
  assert.ok(result.candidates[0].blockers.includes('APPROVAL_STALE'));
  mutate('DELETE FROM event WHERE id=?', 'approval-2');

  mutate('UPDATE wiki_document_source_mode SET source_mode=? WHERE doc_id=?', 'markdown', docId);
  mutate('INSERT INTO wiki_cutover_run VALUES (?,?)', 'cutover-1', 'succeeded');
  mutate('INSERT INTO event VALUES (?,?,?,?,?,?,?,?,?,?)', 'source-1', 'matter', matterId, 'wiki.source_mode_changed', null, JSON.stringify({ docId, sourceMode: 'markdown', byteHash }), '장진태', 'user_input', 'cutover-1', '2026-01-01T00:00:04Z');
  mutate('UPDATE wiki_document_source_mode SET changed_by_event_id=? WHERE doc_id=?', 'source-1', docId);
  mutate('INSERT INTO wiki_cutover_item VALUES (?,?,?,?,?,?,?)', 'item-1', docId, 'cutover-1', byteHash, revisionId, 'source-1', '2026-01-01T00:00:04Z');
  result = inspect();
  assert.deepEqual(result.candidates[0].blockers, ['CUTOVER_RECOVERY_MISSING']);
  mutate('INSERT INTO wiki_recovery_rehearsal VALUES (?,?)', 'cutover-1', 'succeeded');
  result = inspect();
  assert.equal(result.candidates[0].status, 'recovered_cutover');
  assert.equal(result.metrics.recoveredCutover, 1);
  console.log('wiki batch readiness tests passed');
} finally {
  if (path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(root).startsWith('sspat-wiki-batch-test-')) rmSync(root, { recursive: true, force: true });
}
