import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { localApiMiddleware } from '../local-api';
import { scanWikiMarkdownVault } from '../lib/wiki-markdown';
import { withDatabase } from '../lib/work-db';

type Row = Record<string, any>;
const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-approval-api-'));
const vault = path.join(root, 'vault');
const matterDirectory = path.join(vault, '10_Matters');
const docId = 'wiki-approval-api-synthetic-001';
const matterId = 'approval-api-matter-001';
const evidenceId = '99999999-9999-4999-8999-999999999999';
const time = '2026-09-29T00:00:00.000Z';

function auditCounts() {
  return withDatabase((db) => ({
    events: Number((db.prepare("SELECT count(*) AS n FROM event WHERE event_type='wiki.document_approved'").get() as Row).n),
    feedback: Number((db.prepare("SELECT count(*) AS n FROM user_feedback WHERE reason_code='approved_as_is'").get() as Row).n),
  }));
}

async function request(method: string, url: string, body?: unknown) {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(bytes) as Readable & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = url;
  req.headers = {
    host: '127.0.0.1:4173',
    origin: 'http://127.0.0.1:4173',
    ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(bytes[0].length) }),
  };
  let responseBody = '';
  const responseHeaders = new Map<string, string>();
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), value); },
    end(value?: string) { responseBody = value ?? ''; },
  };
  let nextCalled = false;
  await localApiMiddleware()(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, `${method} ${url} was not handled`);
  return { status: res.statusCode, headers: responseHeaders, body: JSON.parse(responseBody) as Row };
}

async function main() {
  try {
    mkdirSync(matterDirectory, { recursive: true });
    process.env.SSPAT_RUNTIME_PROFILE = 'test';
    process.env.SSPAT_ISOLATED_ROOT = root;
    process.env.SSPAT_WORK_DB_PATH = path.join(root, 'work.db');
    process.env.SSPAT_WIKI_VAULT_PATH = vault;
    process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(root, 'notices');
    process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(root, 'specifications');
    process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(root, 'provisionals');
    process.env.SSPAT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');
    delete process.env.SSPAT_AUTHENTICATED_REVIEWER;
    delete process.env.SSPAT_REVIEWER_AUTH_METHOD;
    process.chdir(path.join(process.env.SSPAT_PROJECT_ROOT, 'dashboard'));

    withDatabase((db) => {
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at)
        VALUES (?,'P260901-KR','상상특허','patent','KR','P260901','["KR"]','user_input',1,1,?,?)`).run(matterId, time, time);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at)
        VALUES (?,'matter',?,'wiki.synthetic_fact','{"fact":"API 근거"}','장진태','user_input',?)`).run(evidenceId, matterId, time);
    });
    writeFileSync(path.join(matterDirectory, 'P260901-KR.md'), `---
schema_version: wiki-md-v1
doc_id: ${docId}
document_type: entity_wiki
entity_type: matter
entity_id: ${matterId}
title: 승인 API 합성 사건
---

# 승인 API

검증된 합성 사실입니다.[^api]

[^api]: event:${evidenceId}
`, 'utf8');
    await scanWikiMarkdownVault();
    withDatabase((db) => db.prepare(`UPDATE wiki_document_source_mode
      SET source_mode='legacy_db',legacy_entity_type='matter',legacy_entity_id=?,changed_at=? WHERE doc_id=?`)
      .run(matterId, time, docId));

    const route = `/api/wiki-review/documents/${encodeURIComponent(docId)}/approvals`;
    const anonymous = await request('GET', route);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.allowed, false);
    assert.equal(anonymous.body.code, 'WIKI_DOCUMENT_APPROVAL_AUTH_REQUIRED');
    assert.match(anonymous.body.expectedByteHash, /^[0-9a-f]{64}$/);

    const approvalBody = {
      expectedRevisionId: anonymous.body.expectedRevisionId,
      expectedByteHash: anonymous.body.expectedByteHash,
      expectedTextHash: anonymous.body.expectedTextHash,
      expectedEvidenceSnapshotHash: anonymous.body.expectedEvidenceSnapshotHash,
      idempotencyKey: 'approval-api-request-001',
      statement: '현재 Markdown 원문과 근거를 직접 확인하고 이 문서 개정을 승인합니다.',
    };
    const forbidden = await request('POST', route, approvalBody);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'WIKI_DOCUMENT_APPROVAL_AUTH_REQUIRED');
    assert.deepEqual(auditCounts(), { events: 0, feedback: 0 });

    process.env.SSPAT_AUTHENTICATED_REVIEWER = '장진태';
    process.env.SSPAT_REVIEWER_AUTH_METHOD = 'synthetic-server-session';
    const impersonation = await request('POST', route, { ...approvalBody, reviewer: '장진태' });
    assert.equal(impersonation.status, 400);
    assert.equal(impersonation.body.code, 'WIKI_DOCUMENT_APPROVAL_IDENTITY_FORBIDDEN');
    assert.deepEqual(auditCounts(), { events: 0, feedback: 0 });

    const stale = await request('POST', route, { ...approvalBody, expectedByteHash: '0'.repeat(64), idempotencyKey: 'approval-api-request-stale' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'WIKI_DOCUMENT_APPROVAL_STALE');
    assert.deepEqual(auditCounts(), { events: 0, feedback: 0 });

    const created = await request('POST', route, approvalBody);
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'approved');
    assert.equal(created.body.docId, docId);
    assert.deepEqual(auditCounts(), { events: 1, feedback: 1 });
    const duplicate = await request('POST', route, approvalBody);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.status, 'already_approved');
    assert.equal(duplicate.body.duplicate, true);
    assert.deepEqual(auditCounts(), { events: 1, feedback: 1 });

    const current = await request('GET', route);
    assert.equal(current.status, 200);
    assert.equal(current.body.allowed, false);
    assert.equal(current.body.code, 'WIKI_DOCUMENT_APPROVAL_DUPLICATE');
    assert.equal(current.body.approvals[0].current, true);
    assert.equal(current.body.approvals[0].eventId, created.body.eventId);
    console.log('Wiki document approval HTTP boundary tests passed.');
  } finally {
    delete process.env.SSPAT_AUTHENTICATED_REVIEWER;
    delete process.env.SSPAT_REVIEWER_AUTH_METHOD;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
