import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executeWikiCutover, rehearseWikiRecovery } from '../lib/wiki-cutover';
import { resolveWikiVaultPath, runtimeProfile } from '../lib/runtime-environment';
import { prepareWiki } from '../lib/wiki';
import { databasePath, withDatabase } from '../lib/work-db';

type Row = Record<string, any>;

const authorizationId = String(process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_RUN_ID ?? 'wiki-pilot-human-approval-2026-09-28').trim();
const reviewer = '장진태';
const cutoverRoot = path.resolve(String(process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_ROOT ?? ''));
const bundleRoot = path.join(cutoverRoot, 'bundles');
const restoreRoot = path.join(cutoverRoot, 'recovery', authorizationId);
const reportFile = path.join(cutoverRoot, 'reports', `${authorizationId}.json`);
const vaultRoot = resolveWikiVaultPath();
const projectRoot = path.resolve(process.cwd(), '..');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const targets = [
  {
    matterRef: 'P261252',
    docId: 'wiki-legacy-8d3422ba5d29cddcb348649e',
    expectedByteHash: 'd11116fe7779ba0f46fb7960f6d14934f91792eb1d4f3927ffe53949c90e7a9d',
    documentApprovalEventId: 'wiki-document-approval-69cd719ff5cbf18db8af051d',
    relativePath: '10_Matters/P261252--b348649e.md',
  },
  {
    matterRef: 'P261016',
    docId: 'wiki-legacy-5ccf0513b8d6ab420a79d1e2',
    expectedByteHash: '90b29299d15fcf05c20271ccb3f674445c21b724e5988adc4602911344229856',
    documentApprovalEventId: 'wiki-document-approval-e217ccf49a10f7199e45732f',
    relativePath: '10_Matters/P261016--0a79d1e2.md',
  },
  {
    matterRef: 'P261687',
    docId: 'wiki-legacy-61ff937f7e89c944448dc418',
    expectedByteHash: '7a475018c9cb669388493f9d5c18950fad60c60a67f06456a5b0e687705cb99a',
    documentApprovalEventId: 'wiki-document-approval-74be2cf64ba91e2890b47372',
    relativePath: '10_Matters/P261687--448dc418.md',
  },
];

async function main() {
  assert.equal(runtimeProfile(), 'operational', '운영 프로필에서만 실행할 수 있습니다.');
  assert.match(authorizationId, /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/, '운영 컷오버 실행 ID 형식이 올바르지 않습니다.');
  assert.ok(String(process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_ROOT ?? '').trim(), '운영 컷오버 루트가 필요합니다.');
  assert.equal(process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_AUTHORIZATION, `CUTOVER:${authorizationId}`, '실행별 운영 승인이 다릅니다.');
  assert.equal(path.resolve(String(process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_DATABASE ?? '')), path.resolve(databasePath()), '운영 DB 이중 확인 경로가 다릅니다.');
  assert.equal(path.resolve(String(process.env.SSPAT_OPERATIONAL_WIKI_CUTOVER_VAULT ?? '')), path.resolve(vaultRoot), '운영 Vault 이중 확인 경로가 다릅니다.');
  const codeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const codeStatus = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  assert.equal(codeStatus, '', '운영 컷오버는 깨끗한 코드 작업트리에서만 실행할 수 있습니다.');
  assert.equal(existsSync(reportFile), false, `기존 운영 결과 보고서를 덮어쓰지 않습니다: ${reportFile}`);
  assert.equal(existsSync(restoreRoot), false, `기존 복구 리허설을 덮어쓰지 않습니다: ${restoreRoot}`);

  const before = targets.map((target) => {
    const file = path.join(vaultRoot, ...target.relativePath.split('/'));
    const byteHash = sha256(readFileSync(file));
    assert.equal(byteHash, target.expectedByteHash, `${target.matterRef} 파일 hash가 승인값과 다릅니다.`);
    return { ...target, file, byteHash };
  });

  const cutover = await executeWikiCutover({
    authorizationId,
    reviewer,
    confirmation: 'CUTOVER',
    bundleRoot,
    targets: targets.map(({ docId, expectedByteHash, documentApprovalEventId }) => ({ docId, expectedByteHash, documentApprovalEventId })),
  }) as Row;
  assert.equal(cutover.run.status, 'succeeded');
  assert.equal(cutover.run.runtime_profile, 'operational');
  assert.equal(cutover.items.length, targets.length);

  const recovery = rehearseWikiRecovery(cutover.run.id, restoreRoot) as Row;
  assert.equal(recovery.productionModified, false);
  assert.equal(recovery.verifiedDocumentCount, targets.length);

  const verification = withDatabase((db) => targets.map((target) => {
    const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(target.docId) as Row;
    const sourceMode = db.prepare('SELECT * FROM wiki_document_source_mode WHERE doc_id=?').get(target.docId) as Row;
    const legacyCount = Number((db.prepare('SELECT COUNT(*) AS count FROM entity_wiki_revision WHERE entity_type=? AND entity_id=?').get(document.entity_type, document.entity_id) as Row).count);
    const item = db.prepare('SELECT * FROM wiki_cutover_item WHERE cutover_run_id=? AND doc_id=?').get(cutover.run.id, target.docId) as Row;
    assert.equal(sourceMode.source_mode, 'markdown');
    assert.equal(document.byte_hash, target.expectedByteHash);
    assert.equal(item.document_approval_event_id, target.documentApprovalEventId);
    assert.equal(item.proposal_id, null);
    assert.ok(legacyCount >= 1);
    assert.throws(() => prepareWiki(document.entity_type, document.entity_id), (error: any) => error?.code === 'WIKI_LEGACY_WRITE_BLOCKED');
    const afterByteHash = sha256(readFileSync(path.join(vaultRoot, ...target.relativePath.split('/'))));
    assert.equal(afterByteHash, target.expectedByteHash);
    return {
      matterRef: target.matterRef,
      docId: target.docId,
      byteHash: afterByteHash,
      sourceMode: sourceMode.source_mode,
      legacyRevisionCount: legacyCount,
      approvalEventId: item.document_approval_event_id,
      sourceChangeEventId: item.source_change_event_id,
    };
  }));

  const report = {
    schema: 'wiki-operational-pilot-cutover-result-v1',
    authorizationId,
    reviewer,
    completedAt: new Date().toISOString(),
    codeCommit,
    databasePath: databasePath(),
    vaultPath: vaultRoot,
    cutoverRunId: cutover.run.id,
    cutoverBundle: cutover.run.bundle_path,
    recoveryRehearsalId: recovery.rehearsalId,
    recoveryRoot: recovery.restoreRoot,
    recoveryVerificationHash: recovery.verificationHash,
    markdownModified: before.some((item) => sha256(readFileSync(item.file)) !== item.byteHash),
    legacyWriteBlocked: true,
    verification,
  };
  assert.equal(report.markdownModified, false);
  mkdirSync(path.dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
