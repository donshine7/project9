import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { localApiMiddleware } from '../local-api';
import { withDatabase } from '../lib/work-db';

type Row = Record<string, any>;
const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-auto-api-'));
const database = path.join(root, 'work.db');
const vault = path.join(root, 'vault');

async function request(method: string, url: string, body?: unknown) {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(bytes) as Readable & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = url;
  req.headers = {
    host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
    ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(bytes[0].length) }),
  };
  let responseBody = '';
  const res = {
    statusCode: 0,
    setHeader() {},
    end(value?: string) { responseBody = value ?? ''; },
  };
  let nextCalled = false;
  await localApiMiddleware()(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, `${method} ${url} was not handled`);
  return { status: res.statusCode, body: JSON.parse(responseBody) as Row };
}

async function main() {
  try {
    mkdirSync(vault, { recursive: true });
    process.env.SSPAT_RUNTIME_PROFILE = 'test';
    process.env.SSPAT_ISOLATED_ROOT = root;
    process.env.SSPAT_WORK_DB_PATH = database;
    process.env.SSPAT_WIKI_VAULT_PATH = vault;
    process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(root, 'notices');
    process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(root, 'specifications');
    process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(root, 'provisionals');
    process.env.SSPAT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');
    process.chdir(path.join(process.env.SSPAT_PROJECT_ROOT, 'dashboard'));
    withDatabase((db) => assert.equal(String(Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0]), 'ok'));

    process.env.SSPAT_RUNTIME_PROFILE = 'operational';
    delete process.env.SSPAT_AUTHENTICATED_REVIEWER;
    delete process.env.SSPAT_REVIEWER_AUTH_METHOD;
    const route = '/api/wiki-auto-apply/approvals';
    const anonymous = await request('POST', route, {});
    assert.equal(anonymous.status, 403);
    assert.equal(anonymous.body.code, 'WIKI_AUTO_APPLY_REVIEWER_INVALID');

    process.env.SSPAT_AUTHENTICATED_REVIEWER = '장진태';
    process.env.SSPAT_REVIEWER_AUTH_METHOD = 'synthetic-server-session';
    process.env.SSPAT_OPERATIONAL_WIKI_WRITERS_STOPPED = 'synthetic-auth-001';
    process.env.SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_AUTHORIZATION = 'AUTO_APPLY:synthetic-auth-001';
    process.env.SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_DATABASE = database;
    process.env.SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_VAULT = vault;
    const gate = {
      authorizationId: 'synthetic-auth-001', confirmation: 'AUTO_APPLY:synthetic-auth-001',
      checkpoint: path.join(root, 'missing-checkpoint'), checkpointManifestSha256: 'a'.repeat(64),
      restore: path.join(root, 'missing-restore'), restoreReportSha256: 'b'.repeat(64),
      database, vault, idempotencyKey: 'synthetic-idempotency-001',
    };
    const forged = await request('POST', route, {
      proposalId: 'synthetic-proposal-001', expectedProposalVersion: 1, gate: { ...gate, writersStopped: true },
    });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.code, 'WIKI_AUTO_APPLY_IDENTITY_FORBIDDEN');
    const impersonated = await request('POST', route, {
      proposalId: 'synthetic-proposal-001', expectedProposalVersion: 1, actorId: '장진태', gate,
    });
    assert.equal(impersonated.status, 400);
    assert.equal(impersonated.body.code, 'WIKI_AUTO_APPLY_IDENTITY_FORBIDDEN');
    const missingCheckpoint = await request('POST', route, {
      proposalId: 'synthetic-proposal-001', expectedProposalVersion: 1, gate,
    });
    assert.equal(missingCheckpoint.status, 409);
    assert.equal(missingCheckpoint.body.code, 'WIKI_AUTO_APPLY_GATE_PATH_MISSING');
    const missingOperation = await request('GET', '/api/wiki-auto-apply/operations/synthetic-operation-001');
    assert.equal(missingOperation.status, 404);
    assert.equal(missingOperation.body.code, 'WIKI_AUTO_APPLY_OPERATION_NOT_FOUND');
    console.log('Wiki operational auto-apply HTTP boundary tests passed.');
  } finally {
    for (const name of [
      'SSPAT_AUTHENTICATED_REVIEWER', 'SSPAT_REVIEWER_AUTH_METHOD',
      'SSPAT_OPERATIONAL_WIKI_WRITERS_STOPPED', 'SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_AUTHORIZATION',
      'SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_DATABASE', 'SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_VAULT',
    ]) delete process.env[name];
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
