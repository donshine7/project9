import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyCheckpointDirectory } from './operational-checkpoint';
import { operationalDatabasePath, pathIsInside, resolveDatabasePath, resolveWikiVaultPath, runtimeProfile } from './runtime-environment';
import type { AuthenticatedWikiReviewer } from './wiki-document-approval';
import { WorkDbError } from './work-db';

export type OperationalAutoApplyGate = {
  authorizationId: string;
  confirmation: string;
  checkpoint: string;
  checkpointManifestSha256: string;
  restore: string;
  restoreReportSha256: string;
  database: string;
  vault: string;
  idempotencyKey: string;
  writersStopped: true;
};

export type VerifiedOperationalAutoApplyGate = {
  authorizationId: string;
  checkpointManifestSha256: string;
  restoreReportSha256: string;
  idempotencyKey: string;
  reviewerContextJson: string;
  checkpointVaultFiles: Array<{ path: string; sha256: string; bytes: number }>;
  checkpointVaultTreeSha256: string;
};

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/;

type VaultFileRecord = { path: string; sha256: string; bytes: number };

function requireGate(value: unknown, code: string): asserts value {
  if (!value) throw new WorkDbError(code, 409, code);
}

function physical(file: string, directory: boolean) {
  requireGate(path.isAbsolute(file), 'WIKI_AUTO_APPLY_GATE_ABSOLUTE_PATH_REQUIRED');
  const resolved = path.resolve(file);
  requireGate(existsSync(resolved), 'WIKI_AUTO_APPLY_GATE_PATH_MISSING');
  const stat = lstatSync(resolved);
  requireGate(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'WIKI_AUTO_APPLY_GATE_PATH_INVALID');
  requireGate(normalized(realpathSync(resolved)) === normalized(resolved), 'WIKI_AUTO_APPLY_GATE_PATH_REDIRECTED');
  return resolved;
}

function overlaps(left: string, right: string) {
  return pathIsInside(left, right) || pathIsInside(right, left);
}

function vaultFiles(root: string) {
  const found: VaultFileRecord[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === root && name === '.git') continue;
      const child = path.join(directory, name);
      const stat = lstatSync(child);
      requireGate(!stat.isSymbolicLink(), 'WIKI_AUTO_APPLY_GATE_VAULT_CHANGED');
      if (stat.isDirectory()) visit(child);
      else {
        requireGate(stat.isFile(), 'WIKI_AUTO_APPLY_GATE_VAULT_CHANGED');
        const bytes = readFileSync(child);
        found.push({
          path: path.relative(root, child).split(path.sep).join('/'),
          sha256: sha256(bytes),
          bytes: bytes.length,
        });
      }
    }
  };
  visit(root);
  return found;
}

function vaultTreeHash(records: VaultFileRecord[]) {
  return sha256(records.map((item) => `${item.path}\0${item.sha256}\0${item.bytes}`).join('\n'));
}

export function verifyOperationalVaultMatchesCheckpoint(
  verified: VerifiedOperationalAutoApplyGate,
  allowedChangedPaths?: string | string[],
) {
  const vault = physical(resolveWikiVaultPath(), true);
  const current = vaultFiles(vault);
  const expected = verified.checkpointVaultFiles;
  const allowed = new Set((Array.isArray(allowedChangedPaths) ? allowedChangedPaths : [allowedChangedPaths])
    .filter((value): value is string => Boolean(value))
    .map((value) => value.split(path.sep).join('/')));
  const beforeByPath = new Map(expected.map((item) => [item.path, item]));
  const afterByPath = new Map(current.map((item) => [item.path, item]));
  for (const filePath of new Set([...beforeByPath.keys(), ...afterByPath.keys()])) {
    if (allowed.has(filePath)) continue;
    const before = beforeByPath.get(filePath);
    const after = afterByPath.get(filePath);
    requireGate(Boolean(before && after && before.sha256 === after.sha256 && before.bytes === after.bytes),
      'WIKI_AUTO_APPLY_GATE_VAULT_CHANGED');
  }
  if (!allowed.size) {
    requireGate(vaultTreeHash(current) === verified.checkpointVaultTreeSha256,
      'WIKI_AUTO_APPLY_GATE_VAULT_CHANGED');
  }
  return { vault, files: current };
}

export function verifyOperationalAutoApplyGate(
  gate: OperationalAutoApplyGate | undefined,
  reviewer: AuthenticatedWikiReviewer | undefined,
): VerifiedOperationalAutoApplyGate {
  requireGate(runtimeProfile() === 'operational', 'WIKI_AUTO_APPLY_GATE_PROFILE');
  requireGate(gate && typeof gate === 'object', 'WIKI_AUTO_APPLY_OPERATIONAL_BLOCKED');
  requireGate(reviewer?.authenticated === true && reviewer.actorId === '장진태'
    && typeof reviewer.authenticationMethod === 'string' && reviewer.authenticationMethod.length > 0,
  'WIKI_AUTO_APPLY_REVIEWER_INVALID');
  requireGate(idPattern.test(gate.authorizationId) && idPattern.test(gate.idempotencyKey), 'WIKI_AUTO_APPLY_GATE_ID_INVALID');
  requireGate(gate.confirmation === `AUTO_APPLY:${gate.authorizationId}`
    && process.env.SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_AUTHORIZATION === gate.confirmation,
  'WIKI_AUTO_APPLY_GATE_AUTHORIZATION_REQUIRED');
  requireGate(gate.writersStopped === true
    && process.env.SSPAT_OPERATIONAL_WIKI_WRITERS_STOPPED === gate.authorizationId,
  'WIKI_AUTO_APPLY_GATE_WRITERS_ACTIVE');
  const database = physical(gate.database, false);
  const vault = physical(gate.vault, true);
  const checkpoint = physical(gate.checkpoint, true);
  const restore = physical(gate.restore, true);
  requireGate(normalized(database) === normalized(resolveDatabasePath())
    && normalized(vault) === normalized(resolveWikiVaultPath())
    && path.isAbsolute(String(process.env.SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_DATABASE ?? ''))
    && path.isAbsolute(String(process.env.SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_VAULT ?? ''))
    && normalized(database) === normalized(String(process.env.SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_DATABASE))
    && normalized(vault) === normalized(String(process.env.SSPAT_OPERATIONAL_WIKI_AUTO_APPLY_VAULT)),
  'WIKI_AUTO_APPLY_GATE_PATH_MISMATCH');
  requireGate(!overlaps(database, vault) && !overlaps(checkpoint, database)
    && !overlaps(checkpoint, vault) && !overlaps(restore, checkpoint)
    && !overlaps(restore, database) && !overlaps(restore, vault),
  'WIKI_AUTO_APPLY_GATE_PATH_OVERLAP');
  requireGate(hashPattern.test(gate.checkpointManifestSha256) && hashPattern.test(gate.restoreReportSha256),
    'WIKI_AUTO_APPLY_GATE_HASH_INVALID');
  const verified = verifyCheckpointDirectory(checkpoint);
  const manifestFile = physical(path.join(checkpoint, 'operation-manifest.json'), false);
  const manifestHash = sha256(readFileSync(manifestFile));
  requireGate(manifestHash === gate.checkpointManifestSha256
    && verified.manifest.profile === 'operational'
    && verified.manifest.operationId === gate.authorizationId
    && verified.manifest.sources.databasePathSha256 === sha256(normalized(database))
    && verified.manifest.sources.vaultPathSha256 === sha256(normalized(vault))
    && verified.manifest.coordination.writersQuiescenceRequired === true,
  'WIKI_AUTO_APPLY_GATE_CHECKPOINT_INVALID');
  const reportFile = physical(path.join(restore, 'restore-report.json'), false);
  requireGate(sha256(readFileSync(reportFile)) === gate.restoreReportSha256, 'WIKI_AUTO_APPLY_GATE_RESTORE_HASH');
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, any>;
  const checkpointCreatedAt = Date.parse(String(verified.manifest.createdAt ?? ''));
  const restoreCompletedAt = Date.parse(String(report.completedAt ?? ''));
  requireGate(report.schema === 'sspat-operational-restore-rehearsal-v1'
    && report.operationId === verified.manifest.operationId
    && report.checkpointManifestSha256 === manifestHash
    && report.restoredDatabaseSha256 === verified.manifest.database.sha256
    && report.restoredVaultTreeSha256 === verified.manifest.vault.treeSha256
    && report.restoredGitHead === verified.manifest.git.head
    && report.productionModified === false
    && Number.isFinite(checkpointCreatedAt)
    && Number.isFinite(restoreCompletedAt)
    && restoreCompletedAt >= checkpointCreatedAt
    && checkpointCreatedAt <= Date.now() + 5 * 60 * 1000
    && JSON.stringify(report.verification) === JSON.stringify(verified.manifest.database.verification),
  'WIKI_AUTO_APPLY_GATE_RESTORE_INVALID');
  const restoredDatabase = physical(path.join(restore, 'db', 'work.db'), false);
  const restoredVault = physical(path.join(restore, 'vault'), true);
  const gitDirectory = physical(path.join(restoredVault, '.git'), true);
  requireGate(path.dirname(gitDirectory) === restoredVault, 'WIKI_AUTO_APPLY_GATE_RESTORE_INVALID');
  const restoredHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: restoredVault, encoding: 'utf8' }).trim();
  const restoredFiles: Array<{ path: string; sha256: string; bytes: number }> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === restoredVault && name === '.git') continue;
      const child = path.join(directory, name);
      const stat = lstatSync(child);
      requireGate(!stat.isSymbolicLink(), 'WIKI_AUTO_APPLY_GATE_RESTORE_INVALID');
      if (stat.isDirectory()) visit(child);
      else {
        requireGate(stat.isFile(), 'WIKI_AUTO_APPLY_GATE_RESTORE_INVALID');
        const bytes = readFileSync(child);
        restoredFiles.push({ path: path.relative(restoredVault, child).split(path.sep).join('/'), sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  };
  visit(restoredVault);
  requireGate(sha256(readFileSync(restoredDatabase)) === report.restoredDatabaseSha256
    && restoredHead === report.restoredGitHead
    && JSON.stringify(restoredFiles) === JSON.stringify(verified.manifest.vault.files),
  'WIKI_AUTO_APPLY_GATE_RESTORE_INVALID');
  // A synthetic operational test must explicitly use temp paths, never the default production location.
  if (pathIsInside(os.tmpdir(), database)) {
    requireGate(normalized(database) !== normalized(operationalDatabasePath()), 'WIKI_AUTO_APPLY_GATE_PRODUCTION_TEST_PATH');
  }
  return {
    authorizationId: gate.authorizationId,
    checkpointManifestSha256: manifestHash,
    restoreReportSha256: gate.restoreReportSha256,
    idempotencyKey: gate.idempotencyKey,
    reviewerContextJson: JSON.stringify({ actorId: reviewer.actorId, authenticationMethod: reviewer.authenticationMethod }),
    checkpointVaultFiles: verified.manifest.vault.files as VaultFileRecord[],
    checkpointVaultTreeSha256: String(verified.manifest.vault.treeSha256),
  };
}
