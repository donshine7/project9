import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeWikiCutover, rehearseWikiRecovery } from '../lib/wiki-cutover';
import { scanWikiMarkdownVault } from '../lib/wiki-markdown';
import { withDatabase } from '../lib/work-db';

type Row = Record<string, any>;

const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-document-approval-'));
const vault = path.join(root, 'vault');
const matterDirectory = path.join(vault, '10_Matters');
const database = path.join(root, 'db', 'work.db');
const cutoverRoot = path.join(root, 'operational-cutover');
const bundleRoot = path.join(cutoverRoot, 'bundles');
const restoreRoot = path.join(cutoverRoot, 'recovery');
const projectRoot = path.resolve(__dirname, '..', '..', 'dashboard', '..');
const matterId = 'document-approval-matter-001';
const docId = 'wiki-document-approval-matter-001';
const evidenceEventId = '11111111-1111-4111-8111-111111111111';
const approvalEventId = 'wiki-document-approval-test-001';
const authorizationId = 'operational-document-approval-001';
const matterFile = path.join(matterDirectory, 'P260701-KR.md');

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventSnapshot(event: Row) {
  return {
    id: event.id,
    entityType: event.entity_type,
    entityId: event.entity_id,
    eventType: event.event_type,
    beforeJson: event.before_json,
    afterJson: event.after_json,
    actor: event.actor,
    sourceType: event.source_type,
    correlationId: event.correlation_id,
    createdAt: event.created_at,
  };
}

async function main() {
  try {
    mkdirSync(matterDirectory, { recursive: true });
    mkdirSync(cutoverRoot, { recursive: true });
    process.env.SSPAT_RUNTIME_PROFILE = 'operational';
    process.env.SSPAT_WORK_DB_PATH = database;
    process.env.SSPAT_WIKI_VAULT_PATH = vault;
    process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(root, 'notices');
    process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(root, 'specifications');
    process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(root, 'provisionals');
    process.env.SSPAT_PROJECT_ROOT = projectRoot;
    process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_ROOT = cutoverRoot;
    process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_DATABASE = database;
    process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_VAULT = vault;
    process.chdir(path.join(projectRoot, 'dashboard'));

    const timestamp = '2026-09-28T00:00:00.000Z';
    withDatabase((db) => {
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES (?,'P260701-KR','상상특허','patent','KR','P260701','["KR"]','user_input',1,1,?,?)`)
        .run(matterId, timestamp, timestamp);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES (?,'matter',?,'wiki.synthetic_fact','{"fact":"원문 승인 근거"}','장진태','user_input',?)`)
        .run(evidenceEventId, matterId, timestamp);
      db.prepare(`INSERT INTO decision_run(id,operation,status,started_at,completed_at) VALUES ('document-approval-legacy-run','wiki_revision','succeeded',?,?)`).run(timestamp, timestamp);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES ('document-approval-publication','matter',?,'wiki.publish','{"synthetic":true}','장진태','user_input',?)`)
        .run(matterId, timestamp);
      db.prepare(`INSERT INTO entity_wiki_revision(id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at) VALUES ('document-approval-legacy-revision','matter',?,1,'document-approval-legacy-run','[]','합성 legacy 본문',?,'document-approval-publication',?)`)
        .run(matterId, sha256(docId), timestamp);
    });

    const markdown = `---
schema_version: wiki-md-v1
doc_id: ${docId}
document_type: entity_wiki
entity_type: matter
entity_id: ${matterId}
title: P260701-KR 원문 승인 합성 사건
tags: [test, approval]
---

# P260701-KR

## 현재 요약

- 사람이 원문 그대로 승인한 합성 문장입니다.[^ev-1]

[^ev-1]: event:${evidenceEventId}
`;
    writeFileSync(matterFile, markdown, 'utf8');
    await scanWikiMarkdownVault();

    const approved = withDatabase((db) => {
      const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(docId) as Row;
      const revision = db.prepare('SELECT * FROM wiki_markdown_revision WHERE id=?').get(document.current_revision_id) as Row;
      const evidenceEvent = db.prepare('SELECT * FROM event WHERE id=?').get(evidenceEventId) as Row;
      const evidence = [{ eventId: evidenceEventId, eventHash: sha256(canonical(eventSnapshot(evidenceEvent))) }];
      const evidenceSnapshotHash = sha256(canonical(evidence));
      const payload = {
        schema: 'wiki-document-approval-v1',
        approval: 'approve_as_is',
        docId,
        matterRef: 'P260701-KR',
        relativePath: '10_Matters/P260701-KR.md',
        revisionId: revision.id,
        byteHash: document.byte_hash,
        textHash: document.text_hash,
        evidenceEventIds: [evidenceEventId],
        evidenceSnapshotHash,
        sourceMode: 'legacy_db',
        automaticApply: false,
        sourceCutoverPerformed: false,
        userStatement: '원문 그대로 승인',
      };
      db.prepare(`INSERT INTO wiki_document_source_mode(doc_id,source_mode,legacy_entity_type,legacy_entity_id,changed_at) VALUES (?,'legacy_db','matter',?,?)`)
        .run(docId, matterId, timestamp);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at) VALUES (?,'matter',?,'wiki.document_approved',?,'장진태','user_input',?,?)`)
        .run(approvalEventId, matterId, JSON.stringify(payload), docId, timestamp);
      db.prepare(`INSERT INTO user_feedback(id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,created_at) VALUES ('document-approval-feedback',?,'장진태','accept',?,?, 'approved_as_is','원문 그대로 승인',?)`)
        .run(approvalEventId, JSON.stringify({ docId, byteHash: document.byte_hash }), JSON.stringify(payload), timestamp);
      return { byteHash: document.byte_hash };
    });

    await assert.rejects(
      () => executeWikiCutover({
        authorizationId,
        reviewer: '장진태',
        confirmation: 'CUTOVER',
        bundleRoot,
        targets: [{ docId, expectedByteHash: approved.byteHash, documentApprovalEventId: approvalEventId }],
      }),
      (error: any) => error?.code === 'WIKI_CUTOVER_OPERATIONAL_BLOCKED',
    );

    const staleAuthorizationId = 'operational-document-approval-stale';
    process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_AUTHORIZATION = `CUTOVER:${staleAuthorizationId}`;
    withDatabase((db) => db.prepare('UPDATE event SET after_json=? WHERE id=?').run('{"fact":"승인 후 변경된 근거"}', evidenceEventId));
    await assert.rejects(
      () => executeWikiCutover({
        authorizationId: staleAuthorizationId,
        reviewer: '장진태',
        confirmation: 'CUTOVER',
        bundleRoot,
        targets: [{ docId, expectedByteHash: approved.byteHash, documentApprovalEventId: approvalEventId }],
      }),
      (error: any) => error?.code === 'WIKI_CUTOVER_REVIEW_STALE',
    );
    withDatabase((db) => db.prepare('UPDATE event SET after_json=? WHERE id=?').run('{"fact":"원문 승인 근거"}', evidenceEventId));

    process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_AUTHORIZATION = `CUTOVER:${authorizationId}`;
    const beforeBytes = readFileSync(matterFile);
    const cutover: any = await executeWikiCutover({
      authorizationId,
      reviewer: '장진태',
      confirmation: 'CUTOVER',
      bundleRoot,
      targets: [{ docId, expectedByteHash: approved.byteHash, documentApprovalEventId: approvalEventId }],
    });
    assert.equal(cutover.run.runtime_profile, 'operational');
    assert.equal(cutover.run.status, 'succeeded');
    assert.equal(cutover.items[0].document_approval_event_id, approvalEventId);
    assert.equal(cutover.items[0].proposal_id, null);
    assert.equal(readFileSync(matterFile).equals(beforeBytes), true);

    const recovery: any = rehearseWikiRecovery(cutover.run.id, restoreRoot);
    assert.equal(recovery.verifiedDocumentCount, 1);
    assert.equal(recovery.verifications[0].approvalKind, 'document');
    assert.equal(recovery.verifications[0].documentApprovalEventId, approvalEventId);
    assert.equal(existsSync(path.join(restoreRoot, 'recovery-report.json')), true);

    console.log('Operational Wiki document approval cutover and recovery rehearsal tests passed.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
