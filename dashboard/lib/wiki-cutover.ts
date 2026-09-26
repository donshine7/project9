import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathIsInside, resolveWikiVaultPath, runtimeProfile } from './runtime-environment';
import { readWikiMarkdownSource } from './wiki-markdown';
import { reconcileWikiMarkdownProposal } from './wiki-proposal';
import { databasePath, transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;

export type WikiCutoverTarget = {
  docId: string;
  expectedByteHash: string;
  proposalId: string;
};

export type WikiCutoverRequest = {
  authorizationId: string;
  reviewer: string;
  confirmation: string;
  bundleRoot: string;
  targets: WikiCutoverTarget[];
};

const now = () => new Date().toISOString();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function check(value: unknown, message: string, status = 400, code = 'WIKI_CUTOVER_VALIDATION'): asserts value {
  if (!value) throw new WorkDbError(message, status, code);
}

function normalizedRelative(root: string, candidate: string) {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function assertIdentifier(value: unknown, label: string) {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/.test(value), `${label} 형식이 올바르지 않습니다.`);
  return value;
}

function isolatedRoot() {
  const profile = runtimeProfile();
  check(profile !== 'operational', '운영 프로필의 원본 전환은 별도 대상 승인 전까지 차단됩니다.', 409, 'WIKI_CUTOVER_OPERATIONAL_BLOCKED');
  const value = String(process.env.SSPAT_ISOLATED_ROOT ?? '').trim();
  check(value, '격리 원본 전환에는 SSPAT_ISOLATED_ROOT가 필요합니다.', 409, 'WIKI_CUTOVER_ISOLATED_ROOT_REQUIRED');
  return { profile, root: path.resolve(value) };
}

function assertDirectory(root: string, candidate: string, label: string) {
  check(pathIsInside(root, candidate), `${label} 경로는 격리 루트 안에 있어야 합니다.`, 409, 'WIKI_CUTOVER_PATH_BLOCKED');
  const info = lstatSync(candidate);
  check(info.isDirectory() && !info.isSymbolicLink(), `${label}은 실제 디렉터리여야 합니다.`, 409, 'WIKI_CUTOVER_PATH_BLOCKED');
  check(pathIsInside(realpathSync(root), realpathSync(candidate)), `${label} 경로가 격리 루트를 벗어났습니다.`, 409, 'WIKI_CUTOVER_PATH_BLOCKED');
}

function visitFiles(root: string) {
  const files: Array<{ relativePath: string; absolutePath: string; hash: string; size: number }> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const target = path.join(directory, name);
      const info = lstatSync(target);
      check(!info.isSymbolicLink(), `스냅샷에서 symlink/junction을 허용하지 않습니다: ${target}`, 409, 'WIKI_CUTOVER_SYMLINK_BLOCKED');
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) {
        const bytes = readFileSync(target);
        files.push({ relativePath: normalizedRelative(root, target), absolutePath: target, hash: sha256(bytes), size: bytes.length });
      } else check(false, `지원하지 않는 Vault 항목입니다: ${target}`, 409, 'WIKI_CUTOVER_SPECIAL_FILE_BLOCKED');
    }
  };
  visit(root);
  return files;
}

function treeHash(root: string) {
  return sha256(visitFiles(root).map((file) => `${file.relativePath}\0${file.hash}\0${file.size}`).join('\n'));
}

function copyTree(source: string, destination: string) {
  const sourceInfo = lstatSync(source);
  check(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(), 'Vault 스냅샷 원본은 실제 디렉터리여야 합니다.', 409, 'WIKI_CUTOVER_PATH_BLOCKED');
  mkdirSync(destination, { recursive: true });
  for (const file of visitFiles(source)) {
    const target = path.resolve(destination, ...file.relativePath.split('/'));
    check(pathIsInside(destination, target), 'Vault 스냅샷 경로가 대상 루트를 벗어났습니다.', 409, 'WIKI_CUTOVER_PATH_BLOCKED');
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file.absolutePath, target);
  }
}

function databaseSnapshot(destination: string) {
  check(!existsSync(destination), `DB 스냅샷을 덮어쓰지 않습니다: ${destination}`, 409, 'WIKI_CUTOVER_OUTPUT_EXISTS');
  mkdirSync(path.dirname(destination), { recursive: true });
  withDatabase((db) => {
    const escaped = destination.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  });
  return sha256(readFileSync(destination));
}

function gitCommit() {
  const root = String(process.env.SSPAT_PROJECT_ROOT ?? '').trim() || path.resolve(process.cwd(), '..');
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, 'utf8')) as Row;
}

function writeExclusiveJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function runRows(db: DatabaseSync, runId: string) {
  const run = db.prepare('SELECT * FROM wiki_cutover_run WHERE id=?').get(runId) as Row | undefined;
  check(run, 'Wiki 원본 전환 실행을 찾을 수 없습니다.', 404, 'WIKI_CUTOVER_NOT_FOUND');
  const items = db.prepare(`
    SELECT i.*,d.relative_path,d.byte_hash,d.parse_status
    FROM wiki_cutover_item i JOIN wiki_document d ON d.doc_id=i.doc_id
    WHERE i.cutover_run_id=? ORDER BY i.doc_id
  `).all(runId) as Row[];
  const rehearsals = db.prepare('SELECT * FROM wiki_recovery_rehearsal WHERE cutover_run_id=? ORDER BY created_at DESC').all(runId) as Row[];
  return { run, items, rehearsals };
}

export function wikiCutoverRun(runId: string) {
  return withDatabase((db) => runRows(db, runId));
}

async function preflightTargets(targets: WikiCutoverTarget[]) {
  check(Array.isArray(targets) && targets.length >= 1 && targets.length <= 5, '원본 전환 대상은 한 번에 1~5개여야 합니다.');
  check(new Set(targets.map((target) => target.docId)).size === targets.length, '원본 전환 대상 doc_id가 중복되었습니다.');
  const prepared: Row[] = [];
  for (const target of targets) {
    assertIdentifier(target.docId, 'doc_id');
    assertIdentifier(target.proposalId, 'proposal_id');
    check(/^[a-f0-9]{64}$/.test(target.expectedByteHash), 'expectedByteHash는 SHA-256이어야 합니다.');
    const reconciliation = await reconcileWikiMarkdownProposal(target.proposalId);
    check(reconciliation.status === 'applied_observed' && !reconciliation.evidenceStale, '현재 파일과 근거에 다시 대조된 적용 관측 제안이 필요합니다.', 409, 'WIKI_CUTOVER_REVIEW_STALE');
    const source = await readWikiMarkdownSource(target.docId);
    check(!source.indexStale, `${target.docId}의 파일과 인덱스 hash가 다릅니다.`, 409, 'WIKI_CUTOVER_INDEX_STALE');
    check(source.byteHash === target.expectedByteHash, `${target.docId}의 현재 Markdown hash가 승인값과 다릅니다.`, 409, 'WIKI_CUTOVER_HASH_MISMATCH');
    const row = withDatabase((db) => {
      const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(target.docId) as Row | undefined;
      check(document?.parse_status === 'valid' && document.current_revision_id, `${target.docId}의 유효한 최신 Markdown revision이 필요합니다.`, 409, 'WIKI_CUTOVER_DOCUMENT_NOT_VALID');
      check(document.document_type === 'entity_wiki' && document.entity_type && document.entity_id, '원본 전환은 엔티티 Wiki 문서만 지원합니다.', 409, 'WIKI_CUTOVER_ENTITY_REQUIRED');
      const sourceMode = db.prepare('SELECT * FROM wiki_document_source_mode WHERE doc_id=?').get(target.docId) as Row | undefined;
      check(sourceMode?.source_mode === 'legacy_db', `${target.docId}가 legacy_db 원본 모드가 아닙니다.`, 409, 'WIKI_CUTOVER_SOURCE_MODE');
      check(sourceMode.legacy_entity_type === document.entity_type && sourceMode.legacy_entity_id === document.entity_id, 'legacy 원본 연결과 Markdown 엔티티 연결이 다릅니다.', 409, 'WIKI_CUTOVER_BINDING_MISMATCH');
      const revision = db.prepare('SELECT * FROM wiki_markdown_revision WHERE id=?').get(document.current_revision_id) as Row | undefined;
      check(revision?.byte_hash === target.expectedByteHash, '현재 Markdown revision hash가 승인값과 다릅니다.', 409, 'WIKI_CUTOVER_REVISION_MISMATCH');
      const proposal = db.prepare('SELECT * FROM wiki_proposal WHERE id=? AND doc_id=?').get(target.proposalId, target.docId) as Row | undefined;
      check(proposal?.status === 'applied_observed' && proposal.target_byte_hash === target.expectedByteHash, '현재 파일로 수동 반영이 관측된 제안이 필요합니다.', 409, 'WIKI_CUTOVER_REVIEW_REQUIRED');
      const review = db.prepare(`SELECT * FROM wiki_proposal_review WHERE proposal_id=? AND action='accept_for_manual_apply' ORDER BY created_at DESC,id DESC LIMIT 1`).get(target.proposalId) as Row | undefined;
      check(review, '사람의 수동 반영 승인 기록이 필요합니다.', 409, 'WIKI_CUTOVER_REVIEW_REQUIRED');
      check(review.reviewed_evidence_snapshot_hash === proposal.evidence_snapshot_hash, '사람이 검토한 근거 snapshot과 제안 근거가 다릅니다.', 409, 'WIKI_CUTOVER_REVIEW_STALE');
      const legacy = db.prepare('SELECT * FROM entity_wiki_revision WHERE entity_type=? AND entity_id=? ORDER BY version DESC LIMIT 1').get(document.entity_type, document.entity_id) as Row | undefined;
      check(legacy, '전환 전 보존할 legacy Wiki revision이 없습니다.', 409, 'WIKI_CUTOVER_LEGACY_REQUIRED');
      return { document, sourceMode, revision, proposal, review, legacy };
    });
    prepared.push({
      docId: target.docId,
      expectedByteHash: target.expectedByteHash,
      proposalId: target.proposalId,
      relativePath: row.document.relative_path,
      entityType: row.document.entity_type,
      entityId: row.document.entity_id,
      markdownRevisionId: row.revision.id,
      proposalReviewId: row.review.id,
      legacyRevisionId: row.legacy.id,
    });
  }
  return prepared;
}

export async function executeWikiCutover(request: WikiCutoverRequest) {
  const environment = isolatedRoot();
  const authorizationId = assertIdentifier(request.authorizationId, 'authorizationId');
  check(request.reviewer === '장진태', '인증된 원본 전환 검토자만 허용합니다.', 403, 'WIKI_CUTOVER_REVIEWER_FORBIDDEN');
  check(request.confirmation === 'CUTOVER', '원본 전환 확인 문자열이 올바르지 않습니다.', 400, 'WIKI_CUTOVER_CONFIRMATION_REQUIRED');
  const existing = withDatabase((db) => db.prepare('SELECT id,status FROM wiki_cutover_run WHERE authorization_id=?').get(authorizationId) as Row | undefined);
  if (existing) {
    check(existing.status === 'succeeded', '같은 승인 ID의 미완료 원본 전환이 있습니다.', 409, 'WIKI_CUTOVER_EXISTING_RUN');
    return { ...wikiCutoverRun(existing.id), duplicate: true };
  }

  const targets = await preflightTargets(request.targets);
  const vaultRoot = resolveWikiVaultPath();
  assertDirectory(environment.root, vaultRoot, 'Wiki Vault');
  const bundleParent = path.resolve(request.bundleRoot);
  check(bundleParent !== environment.root && pathIsInside(environment.root, bundleParent), '백업 묶음 루트는 격리 루트의 하위 폴더여야 합니다.', 409, 'WIKI_CUTOVER_PATH_BLOCKED');
  check(!pathIsInside(vaultRoot, bundleParent) && !pathIsInside(bundleParent, vaultRoot), '백업 묶음과 Wiki Vault는 서로 포함할 수 없습니다.', 409, 'WIKI_CUTOVER_PATH_BLOCKED');
  mkdirSync(bundleParent, { recursive: true });
  assertDirectory(environment.root, bundleParent, '백업 묶음 루트');

  const requestHash = sha256(JSON.stringify({ authorizationId, reviewer: request.reviewer, targets: targets.map((target) => [target.docId, target.expectedByteHash, target.proposalId]).sort() }));
  const runId = `wiki-cutover-${requestHash.slice(0, 24)}`;
  const finalBundle = path.join(bundleParent, runId);
  const stagingBundle = path.join(bundleParent, `.staging-${runId}`);
  check(!existsSync(finalBundle) && !existsSync(stagingBundle), '기존 원본 전환 백업 묶음을 덮어쓰지 않습니다.', 409, 'WIKI_CUTOVER_OUTPUT_EXISTS');

  mkdirSync(stagingBundle);
  const vaultBefore = treeHash(vaultRoot);
  const vaultSnapshot = path.join(stagingBundle, 'vault');
  copyTree(vaultRoot, vaultSnapshot);
  const vaultAfter = treeHash(vaultRoot);
  const vaultSnapshotHash = treeHash(vaultSnapshot);
  check(vaultBefore === vaultAfter && vaultBefore === vaultSnapshotHash, 'Vault가 스냅샷 중 변경되었거나 사본 hash가 다릅니다.', 409, 'WIKI_CUTOVER_VAULT_UNSTABLE');
  const databaseBefore = path.join(stagingBundle, 'database-before.db');
  const databaseBeforeHash = databaseSnapshot(databaseBefore);
  const createdAt = now();
  const codeCommit = gitCommit();

  try {
    withDatabase((db) => transaction(db, () => {
      db.prepare(`INSERT INTO wiki_cutover_run(id,authorization_id,reviewer,runtime_profile,code_commit,bundle_path,status,target_count,created_at) VALUES (?,?,?,?,?,?,'prepared',?,?)`)
        .run(runId, authorizationId, request.reviewer, environment.profile, codeCommit, finalBundle, targets.length, createdAt);
      for (const target of targets) {
        const eventId = randomUUID();
        db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(
            eventId,
            target.entityType,
            target.entityId,
            'wiki.source_mode_changed',
            JSON.stringify({ docId: target.docId, sourceMode: 'legacy_db', legacyRevisionId: target.legacyRevisionId }),
            JSON.stringify({ docId: target.docId, sourceMode: 'markdown', byteHash: target.expectedByteHash, markdownRevisionId: target.markdownRevisionId, automaticApply: false }),
            request.reviewer,
            'user_input',
            authorizationId,
            createdAt,
          );
        const changed = db.prepare(`UPDATE wiki_document_source_mode SET source_mode='markdown',changed_by_event_id=?,changed_at=? WHERE doc_id=? AND source_mode='legacy_db'`)
          .run(eventId, createdAt, target.docId);
        check(Number(changed.changes) === 1, `${target.docId}의 원본 모드가 동시에 변경되었습니다.`, 409, 'WIKI_CUTOVER_SOURCE_MODE_RACE');
        db.prepare(`INSERT INTO wiki_cutover_item(id,cutover_run_id,doc_id,entity_type,entity_id,previous_source_mode,new_source_mode,expected_byte_hash,markdown_revision_id,proposal_id,proposal_review_id,legacy_revision_id,source_change_event_id,created_at) VALUES (?,?,?,?,?,'legacy_db','markdown',?,?,?,?,?,?,?)`)
          .run(randomUUID(), runId, target.docId, target.entityType, target.entityId, target.expectedByteHash, target.markdownRevisionId, target.proposalId, target.proposalReviewId, target.legacyRevisionId, eventId, createdAt);
      }
      db.prepare(`UPDATE wiki_cutover_run SET status='applied' WHERE id=?`).run(runId);
    }));
    const completedAt = now();
    withDatabase((db) => db.prepare(`UPDATE wiki_cutover_run SET status='succeeded',completed_at=? WHERE id=? AND status='applied'`).run(completedAt, runId));
    const databaseAfter = path.join(stagingBundle, 'database-after.db');
    const databaseAfterHash = databaseSnapshot(databaseAfter);
    const manifest = {
      schema: 'wiki-cutover-bundle-v1',
      runId,
      authorizationId,
      reviewer: request.reviewer,
      runtimeProfile: environment.profile,
      codeCommit,
      createdAt,
      completedAt,
      sourceDatabasePathHash: sha256(databasePath().toLowerCase()),
      sourceVaultPathHash: sha256(path.resolve(vaultRoot).toLowerCase()),
      artifacts: {
        databaseBefore: { path: 'database-before.db', sha256: databaseBeforeHash },
        databaseAfter: { path: 'database-after.db', sha256: databaseAfterHash },
        vault: { path: 'vault', treeSha256: vaultSnapshotHash },
      },
      targets: targets.map((target) => ({
        docId: target.docId,
        entityType: target.entityType,
        entityId: target.entityId,
        relativePath: target.relativePath,
        byteHash: target.expectedByteHash,
        markdownRevisionId: target.markdownRevisionId,
        proposalId: target.proposalId,
        proposalReviewId: target.proposalReviewId,
        legacyRevisionId: target.legacyRevisionId,
        sourceMode: 'markdown',
      })),
      guarantees: {
        activeMarkdownModified: false,
        legacyRevisionDeleted: false,
        silentLegacyFallbackAllowed: false,
        vaultStableDuringSnapshot: true,
      },
    };
    writeExclusiveJson(path.join(stagingBundle, 'cutover-manifest.json'), manifest);
    renameSync(stagingBundle, finalBundle);
    return { ...wikiCutoverRun(runId), duplicate: false, bundle: { path: finalBundle, manifestSha256: sha256(readFileSync(path.join(finalBundle, 'cutover-manifest.json'))) } };
  } catch (error) {
    try {
      withDatabase((db) => db.prepare(`UPDATE wiki_cutover_run SET status='failed',error_code=?,completed_at=? WHERE id=?`).run(error instanceof WorkDbError ? error.code : 'WIKI_CUTOVER_FAILED', now(), runId));
    } catch {
      // The staging bundle is intentionally retained for manual recovery inspection.
    }
    throw error;
  }
}

function safeBundleItem(bundle: string, relative: unknown, label: string) {
  const candidate = path.resolve(bundle, ...String(relative ?? '').split('/'));
  check(pathIsInside(bundle, candidate) && existsSync(candidate), `${label}이 백업 묶음에 없습니다.`, 409, 'WIKI_RECOVERY_BUNDLE_INVALID');
  const info = lstatSync(candidate);
  check(!info.isSymbolicLink() && pathIsInside(realpathSync(bundle), realpathSync(candidate)), `${label}이 백업 묶음의 실제 경로를 벗어났습니다.`, 409, 'WIKI_RECOVERY_BUNDLE_INVALID');
  return candidate;
}

export function rehearseWikiRecovery(cutoverRunId: string, restoreRootInput: string) {
  const environment = isolatedRoot();
  const cutover = wikiCutoverRun(cutoverRunId);
  check(cutover.run.status === 'succeeded', '성공한 원본 전환 실행만 복원 리허설할 수 있습니다.', 409, 'WIKI_RECOVERY_CUTOVER_NOT_READY');
  const bundle = path.resolve(cutover.run.bundle_path);
  check(pathIsInside(environment.root, bundle) && existsSync(bundle), '원본 전환 백업 묶음 경로가 유효하지 않습니다.', 409, 'WIKI_RECOVERY_BUNDLE_INVALID');
  assertDirectory(environment.root, bundle, '원본 전환 백업 묶음');
  const manifestFile = safeBundleItem(bundle, 'cutover-manifest.json', '전환 manifest');
  const manifest = readJson(manifestFile);
  check(manifest.schema === 'wiki-cutover-bundle-v1' && manifest.runId === cutoverRunId, '전환 manifest 신원이 다릅니다.', 409, 'WIKI_RECOVERY_BUNDLE_INVALID');
  const sourceDatabase = safeBundleItem(bundle, manifest.artifacts?.databaseAfter?.path, '전환 후 DB');
  const sourceVault = safeBundleItem(bundle, manifest.artifacts?.vault?.path, 'Vault 스냅샷');
  check(sha256(readFileSync(sourceDatabase)) === manifest.artifacts.databaseAfter.sha256, '전환 후 DB hash가 다릅니다.', 409, 'WIKI_RECOVERY_HASH_MISMATCH');
  check(treeHash(sourceVault) === manifest.artifacts.vault.treeSha256, 'Vault 스냅샷 tree hash가 다릅니다.', 409, 'WIKI_RECOVERY_HASH_MISMATCH');

  const restoreRoot = path.resolve(restoreRootInput);
  check(restoreRoot !== environment.root && pathIsInside(environment.root, restoreRoot), '복원 리허설 루트는 격리 루트의 새 하위 폴더여야 합니다.', 409, 'WIKI_RECOVERY_PATH_BLOCKED');
  check(!existsSync(restoreRoot), '기존 복원 리허설 폴더를 덮어쓰지 않습니다.', 409, 'WIKI_RECOVERY_OUTPUT_EXISTS');
  const staging = `${restoreRoot}.staging-${randomUUID()}`;
  check(pathIsInside(environment.root, staging) && !existsSync(staging), '복원 staging 경로가 안전하지 않습니다.', 409, 'WIKI_RECOVERY_PATH_BLOCKED');
  mkdirSync(path.join(staging, 'db'), { recursive: true });
  const restoredDatabase = path.join(staging, 'db', 'work.db');
  const restoredVault = path.join(staging, 'vault');
  copyFileSync(sourceDatabase, restoredDatabase);
  copyTree(sourceVault, restoredVault);

  const verifications: Row[] = [];
  const restoredDb = new DatabaseSync(restoredDatabase, { readOnly: true });
  try {
    const quickCheck = restoredDb.prepare('PRAGMA quick_check').get() as Row;
    check(Object.values(quickCheck)[0] === 'ok', '복원 DB quick_check가 실패했습니다.', 409, 'WIKI_RECOVERY_DATABASE_INVALID');
    for (const target of manifest.targets as Row[]) {
      const sourceMode = restoredDb.prepare('SELECT * FROM wiki_document_source_mode WHERE doc_id=?').get(target.docId) as Row | undefined;
      const document = restoredDb.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(target.docId) as Row | undefined;
      const revision = restoredDb.prepare('SELECT * FROM wiki_markdown_revision WHERE id=?').get(target.markdownRevisionId) as Row | undefined;
      const proposal = restoredDb.prepare('SELECT * FROM wiki_proposal WHERE id=?').get(target.proposalId) as Row | undefined;
      const review = restoredDb.prepare('SELECT * FROM wiki_proposal_review WHERE id=?').get(target.proposalReviewId) as Row | undefined;
      const item = restoredDb.prepare('SELECT * FROM wiki_cutover_item WHERE cutover_run_id=? AND doc_id=?').get(cutoverRunId, target.docId) as Row | undefined;
      const event = item ? restoredDb.prepare('SELECT * FROM event WHERE id=?').get(item.source_change_event_id) as Row | undefined : undefined;
      const file = path.resolve(restoredVault, ...String(target.relativePath).split('/'));
      check(pathIsInside(restoredVault, file) && existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), `복원 문서가 없습니다: ${target.docId}`, 409, 'WIKI_RECOVERY_DOCUMENT_MISSING');
      const fileHash = sha256(readFileSync(file));
      const eventAfter = event?.after_json ? JSON.parse(event.after_json) : null;
      const passed = sourceMode?.source_mode === 'markdown'
        && document?.parse_status === 'valid'
        && document?.byte_hash === target.byteHash
        && document?.current_revision_id === target.markdownRevisionId
        && revision?.byte_hash === target.byteHash
        && proposal?.status === 'applied_observed'
        && proposal?.target_byte_hash === target.byteHash
        && review?.action === 'accept_for_manual_apply'
        && event?.event_type === 'wiki.source_mode_changed'
        && eventAfter?.sourceMode === 'markdown'
        && eventAfter?.byteHash === target.byteHash
        && eventAfter?.automaticApply === false
        && fileHash === target.byteHash;
      check(passed, `복원 문서의 원본·검토·이벤트·hash 연결이 다릅니다: ${target.docId}`, 409, 'WIKI_RECOVERY_DOCUMENT_INVALID');
      verifications.push({ docId: target.docId, byteHash: fileHash, sourceMode: sourceMode!.source_mode, markdownRevisionId: revision!.id, proposalId: proposal!.id, proposalReviewId: review!.id, sourceChangeEventId: event!.id });
    }
  } finally {
    restoredDb.close();
  }

  const restoredDatabaseHash = sha256(readFileSync(restoredDatabase));
  const restoredVaultHash = treeHash(restoredVault);
  check(restoredDatabaseHash === manifest.artifacts.databaseAfter.sha256 && restoredVaultHash === manifest.artifacts.vault.treeSha256, '복원 사본 hash가 원본 묶음과 다릅니다.', 409, 'WIKI_RECOVERY_HASH_MISMATCH');
  const rehearsalId = `wiki-recovery-${sha256(`${cutoverRunId}:${restoreRoot.toLowerCase()}`).slice(0, 24)}`;
  const verificationHash = sha256(JSON.stringify(verifications));
  const timestamp = now();
  const report = {
    schema: 'wiki-recovery-rehearsal-v1',
    rehearsalId,
    cutoverRunId,
    createdAt: timestamp,
    completedAt: timestamp,
    restoredDatabaseHash,
    restoredVaultHash,
    verificationHash,
    verifiedDocumentCount: verifications.length,
    productionModified: false,
    verifications,
  };
  writeExclusiveJson(path.join(staging, 'recovery-report.json'), report);
  renameSync(staging, restoreRoot);
  withDatabase((db) => db.prepare(`INSERT INTO wiki_recovery_rehearsal(id,cutover_run_id,restore_root,restored_database_hash,restored_vault_hash,verification_hash,verified_document_count,status,created_at,completed_at) VALUES (?,?,?,?,?,?,?,'succeeded',?,?)`)
    .run(rehearsalId, cutoverRunId, restoreRoot, restoredDatabaseHash, restoredVaultHash, verificationHash, verifications.length, timestamp, timestamp));
  return { ...report, restoreRoot };
}
