import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approveWikiDocument, getWikiDocumentApproval, type AuthenticatedWikiReviewer } from '../lib/wiki-document-approval';
import { citedWikiDocumentEventIds, wikiDocumentEvidenceSnapshot } from '../lib/wiki-document-evidence';
import { scanWikiMarkdownVault } from '../lib/wiki-markdown';
import { withDatabase } from '../lib/work-db';

type Row = Record<string, any>;
const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-approval-'));
const vault = path.join(root, 'vault');
const directory = path.join(vault, '10_Matters');
const file = path.join(directory, 'P260701-KR.md');
const docId = 'wiki-approval-synthetic-001';
const matterId = 'approval-matter-001';
const evidenceId = '11111111-1111-4111-8111-111111111111';
const reviewer: AuthenticatedWikiReviewer = { actorId: '장진태', authenticated: true, authenticationMethod: 'test-session' };
const time = '2026-09-29T00:00:00.000Z';

function counts() {
  return withDatabase((db) => ({
    events: Number((db.prepare("SELECT count(*) AS n FROM event WHERE event_type='wiki.document_approved'").get() as Row).n),
    feedback: Number((db.prepare("SELECT count(*) AS n FROM user_feedback WHERE reason_code='approved_as_is'").get() as Row).n),
  }));
}

async function rejected(operation: () => Promise<unknown>, code: string) {
  await assert.rejects(operation, (error: any) => error?.code === code, code);
}

async function main() {
  try {
    const upperId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const lowerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const citations = `[^b]: event:${lowerId}\n[^a]: event:${upperId}\n[^again]: event:${upperId}\n`;
    assert.deepEqual(citedWikiDocumentEventIds(citations), [upperId, lowerId]);
    const syntheticEvents = new Map([upperId, lowerId].map((id) => [id, {
      id, entity_type: 'matter', entity_id: matterId, event_type: 'wiki.synthetic_fact',
      before_json: null, after_json: '{}', actor: '장진태', source_type: 'user_input',
      correlation_id: null, created_at: time,
    }]));
    const evidenceContract = wikiDocumentEvidenceSnapshot(citations, (id) => syntheticEvents.get(id));
    assert.deepEqual(evidenceContract.eventIds, [upperId, lowerId]);
    assert.equal(evidenceContract.evidenceSnapshotHash, '3154f38ccf82fbce0c3a737b5c0ea67883e5dc764c7441bfde1b8854dd203e6c');
    mkdirSync(directory, { recursive: true });
    process.env.SSPAT_RUNTIME_PROFILE = 'test';
    process.env.SSPAT_ISOLATED_ROOT = root;
    process.env.SSPAT_WORK_DB_PATH = path.join(root, 'work.db');
    process.env.SSPAT_WIKI_VAULT_PATH = vault;
    process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(root, 'notices');
    process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(root, 'specifications');
    process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(root, 'provisionals');
    const projectRoot = path.resolve(__dirname, '..', '..', 'dashboard', '..');
    process.env.SSPAT_PROJECT_ROOT = projectRoot;
    process.chdir(path.join(projectRoot, 'dashboard'));
    withDatabase((db) => {
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at)
        VALUES (?,'P260701-KR','상상특허','patent','KR','P260701','["KR"]','user_input',1,1,?,?)`).run(matterId, time, time);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at)
        VALUES (?,'matter',?,'wiki.synthetic_fact','{"fact":"확정 근거"}','장진태','user_input',?)`).run(evidenceId, matterId, time);
    });
    const markdown = `---\nschema_version: wiki-md-v1\ndoc_id: ${docId}\ndocument_type: entity_wiki\nentity_type: matter\nentity_id: ${matterId}\ntitle: 합성 원문 승인\n---\n\n# 합성 사건\n\n확정 근거에 연결된 문장입니다.[^ev-1]\n\n[^ev-1]: event:${evidenceId}\n`;
    writeFileSync(file, markdown, 'utf8');
    await scanWikiMarkdownVault();
    const revision = withDatabase((db) => {
      const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(docId) as Row;
      assert.equal(document.parse_status, 'valid');
      db.prepare(`UPDATE wiki_document_source_mode SET source_mode='legacy_db',legacy_entity_type='matter',legacy_entity_id=?,changed_at=? WHERE doc_id=?`)
        .run(matterId, time, docId);
      return document.current_revision_id;
    });
    const target = await getWikiDocumentApproval(docId);
    assert.equal(target.revisionId, revision);
    assert.equal(target.allowed, true);
    assert.equal(target.expectedRevisionId, revision);
    assert.equal(target.expectedByteHash, target.byteHash);
    assert.deepEqual(target.evidenceEventIds, [evidenceId]);
    assert.deepEqual(target.approvals, []);
    const input = {
      docId, expectedRevisionId: target.revisionId, expectedByteHash: target.byteHash,
      expectedTextHash: target.textHash, expectedEvidenceSnapshotHash: target.evidenceSnapshotHash,
      idempotencyKey: 'approval-request-001', statement: '원문 그대로 승인',
    };
    await rejected(() => approveWikiDocument(input, undefined as any), 'WIKI_DOCUMENT_APPROVAL_REVIEWER_INVALID');
    await rejected(() => approveWikiDocument(input, { actorId: '다른 사람', authenticated: true, authenticationMethod: 'test-session' }), 'WIKI_DOCUMENT_APPROVAL_REVIEWER_INVALID');
    assert.deepEqual(counts(), { events: 0, feedback: 0 });
    await rejected(() => approveWikiDocument({ ...input, expectedByteHash: '0'.repeat(64) }, reviewer), 'WIKI_DOCUMENT_APPROVAL_STALE');
    assert.deepEqual(counts(), { events: 0, feedback: 0 });

    const first = await approveWikiDocument(input, reviewer);
    assert.equal(first.duplicate, false);
    assert.equal(first.status, 'approved');
    assert.equal(first.revisionId, target.revisionId);
    assert.deepEqual(counts(), { events: 1, feedback: 1 });
    const stored = withDatabase((db) => ({
      event: db.prepare('SELECT * FROM event WHERE id=?').get(first.eventId) as Row,
      feedback: db.prepare('SELECT * FROM user_feedback WHERE id=?').get(first.feedbackId) as Row,
    }));
    assert.equal(stored.event.actor, reviewer.actorId);
    assert.equal(stored.event.source_type, 'user_input');
    assert.equal(stored.feedback.event_id, first.eventId);
    assert.equal(stored.feedback.actor_id, reviewer.actorId);
    assert.equal(JSON.parse(stored.event.after_json).automaticApply, false);
    assert.equal(JSON.parse(stored.feedback.final_value_json).evidenceSnapshotHash, target.evidenceSnapshotHash);
    assert.equal((await getWikiDocumentApproval(docId)).approvals[0].current, true);
    const second = await approveWikiDocument(input, reviewer);
    assert.equal(second.duplicate, true);
    assert.equal(second.status, 'already_approved');
    assert.equal(second.eventId, first.eventId);
    assert.deepEqual(counts(), { events: 1, feedback: 1 });
    await rejected(() => approveWikiDocument({ ...input, statement: '다른 문구' }, reviewer), 'WIKI_DOCUMENT_APPROVAL_IDEMPOTENCY_CONFLICT');
    await rejected(() => approveWikiDocument({ ...input, expectedByteHash: '0'.repeat(64) }, reviewer), 'WIKI_DOCUMENT_APPROVAL_IDEMPOTENCY_CONFLICT');
    await rejected(() => approveWikiDocument({ ...input, idempotencyKey: 'approval-request-002' }, reviewer), 'WIKI_DOCUMENT_APPROVAL_DUPLICATE');
    assert.equal((await getWikiDocumentApproval(docId)).approvals.length, 1);
    assert.equal((await getWikiDocumentApproval(docId)).code, 'WIKI_DOCUMENT_APPROVAL_DUPLICATE');

    withDatabase((db) => db.prepare('UPDATE event SET after_json=? WHERE id=?').run('{"fact":"변경된 근거"}', evidenceId));
    assert.equal((await getWikiDocumentApproval(docId)).approvals[0].current, false);
    await rejected(() => approveWikiDocument(input, reviewer), 'WIKI_DOCUMENT_APPROVAL_STALE');
    withDatabase((db) => db.prepare('UPDATE event SET after_json=? WHERE id=?').run('{"fact":"확정 근거"}', evidenceId));
    withDatabase((db) => db.prepare("UPDATE event SET entity_id='different-matter' WHERE id=?").run(evidenceId));
    await rejected(() => approveWikiDocument(input, reviewer), 'WIKI_DOCUMENT_APPROVAL_EVIDENCE_INVALID');
    withDatabase((db) => db.prepare('UPDATE event SET entity_id=? WHERE id=?').run(matterId, evidenceId));
    writeFileSync(file, `${markdown}\n사람이 추가한 문장\n`, 'utf8');
    await rejected(() => approveWikiDocument(input, reviewer), 'WIKI_DOCUMENT_APPROVAL_STALE');
    writeFileSync(file, markdown, 'utf8');

    // A failed feedback insert must roll back the audit event as well.
    withDatabase((db) => {
      db.exec('CREATE TRIGGER block_approval_feedback BEFORE INSERT ON user_feedback WHEN NEW.reason_code="approved_as_is" BEGIN SELECT RAISE(ABORT,"test feedback failure"); END');
      db.prepare('DELETE FROM user_feedback WHERE id=?').run(first.feedbackId);
      db.prepare('DELETE FROM event WHERE id=?').run(first.eventId);
    });
    await assert.rejects(() => approveWikiDocument({ ...input, idempotencyKey: 'approval-request-003' }, reviewer));
    assert.deepEqual(counts(), { events: 0, feedback: 0 });
    withDatabase((db) => db.exec('DROP TRIGGER block_approval_feedback'));
    withDatabase((db) => db.prepare("UPDATE wiki_document_source_mode SET source_mode='markdown' WHERE doc_id=?").run(docId));
    await rejected(() => approveWikiDocument(input, reviewer), 'WIKI_DOCUMENT_APPROVAL_SOURCE_MODE');
    assert.equal((await getWikiDocumentApproval(docId)).sourceMode, 'markdown');
    assert.equal((await getWikiDocumentApproval(docId)).allowed, false);
    assert.equal(existsSync(file), true);
    console.log('Wiki document approval service tests passed.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
