import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkpointReadiness, createOperationalCheckpoint, rehearseOperationalRestore, verifyCheckpointDirectory, type CheckpointRequest } from '../lib/operational-checkpoint';

const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-checkpoint-test-'));
const vault = path.join(root, 'vault');
const dbFile = path.join(root, 'db', 'work.db');
const checkpoints = path.join(root, 'checkpoints');
const restores = path.join(root, 'restores');
const runGit = (args: string[]) => execFileSync('git', args, { cwd: vault, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
const request = (operationId: string): CheckpointRequest => ({ operationId, profile: 'isolated', confirmation: `CHECKPOINT:${operationId}`, database: dbFile, vault, checkpointParent: checkpoints });

try {
  mkdirSync(path.dirname(dbFile));
  mkdirSync(vault);
  mkdirSync(checkpoints);
  mkdirSync(restores);
  runGit(['init', '-q']);
  runGit(['config', 'user.name', 'Synthetic']);
  runGit(['config', 'user.email', 'synthetic@example.invalid']);
  writeFileSync(path.join(vault, 'tracked.md'), 'committed version\n');
  runGit(['add', 'tracked.md']);
  runGit(['commit', '-qm', 'Synthetic baseline']);
  writeFileSync(path.join(vault, 'tracked.md'), 'uncommitted edit\n');
  writeFileSync(path.join(vault, 'untracked.md'), 'untracked note\n');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE schema_migration(version TEXT PRIMARY KEY); INSERT INTO schema_migration VALUES (\'synthetic-001\'); CREATE TABLE record(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO record(value) VALUES (\'first\');');
  db.prepare('INSERT INTO record(value) VALUES (?)').run('uncheckpointed WAL row');

  assert.equal(checkpointReadiness(request('main-checkpoint')).gitDirty, true);
  assert.throws(() => checkpointReadiness({ ...request('overlap'), checkpointParent: vault }), /CHECKPOINT_PATH_OVERLAP/);
  assert.throws(() => checkpointReadiness({ ...request('bad-confirmation'), confirmation: 'CHECKPOINT:other' }), /CHECKPOINT_CONFIRMATION_REQUIRED/);
  assert.throws(() => checkpointReadiness({ ...request('operational-fault'), profile: 'operational', faultAt: 'after-vault' }), /CHECKPOINT_FAULT_OPERATIONAL_BLOCKED/);

  const created = createOperationalCheckpoint(request('main-checkpoint'));
  db.close();
  const verified = verifyCheckpointDirectory(created.checkpoint);
  assert.equal(verified.verifiedFiles, 2);
  assert.equal(verified.manifest.git.dirtyAtStart, true);
  assert.equal(verified.manifest.database.verification.migrations[0], 'synthetic-001');
  assert.equal(verified.manifest.database.verification.quickCheck, 'ok');
  assert.equal(readFileSync(path.join(created.checkpoint, 'vault-snapshot', 'tracked.md'), 'utf8'), 'uncommitted edit\n');
  assert.equal(readFileSync(path.join(created.checkpoint, 'vault-snapshot', 'untracked.md'), 'utf8'), 'untracked note\n');
  assert.throws(() => createOperationalCheckpoint(request('main-checkpoint')), /CHECKPOINT_OUTPUT_EXISTS/);
  assert.throws(() => rehearseOperationalRestore({ checkpoint: created.checkpoint, restoreParent: checkpoints, restoreName: 'overlap' }), /RESTORE_PATH_OVERLAP/);

  const restored = rehearseOperationalRestore({ checkpoint: created.checkpoint, restoreParent: restores, restoreName: 'restored-main' });
  assert.equal(restored.productionModified, false);
  assert.equal(restored.restoredGitHead, verified.manifest.git.head);
  assert.equal(readFileSync(path.join(restored.restore, 'vault', 'tracked.md'), 'utf8'), 'uncommitted edit\n');
  assert.equal(readFileSync(path.join(restored.restore, 'vault', 'untracked.md'), 'utf8'), 'untracked note\n');
  assert.equal(execFileSync('git', ['show', 'HEAD:tracked.md'], { cwd: path.join(restored.restore, 'vault'), encoding: 'utf8' }), 'committed version\n');
  const restoredDb = new DatabaseSync(path.join(restored.restore, 'db', 'work.db'), { readOnly: true });
  assert.equal((restoredDb.prepare('SELECT value FROM record').get() as { value: string }).value, 'first');
  assert.equal((restoredDb.prepare('SELECT COUNT(*) AS n FROM record').get() as { n: number }).n, 2);
  restoredDb.close();
  assert.throws(() => rehearseOperationalRestore({ checkpoint: created.checkpoint, restoreParent: restores, restoreName: 'restored-main' }), /RESTORE_OUTPUT_EXISTS/);

  writeFileSync(path.join(created.checkpoint, 'vault-snapshot', 'tracked.md'), 'tampered\n');
  assert.throws(() => verifyCheckpointDirectory(created.checkpoint), /CHECKPOINT_VAULT_HASH/);
  assert.throws(() => rehearseOperationalRestore({ checkpoint: created.checkpoint, restoreParent: restores, restoreName: 'tampered-restore' }), /CHECKPOINT_VAULT_HASH/);
  assert.equal(readdirSync(restores).includes('tampered-restore'), false);

  const bundleFailure = createOperationalCheckpoint(request('invalid-bundle'));
  const bundleFile = path.join(bundleFailure.checkpoint, 'git-history.bundle');
  writeFileSync(bundleFile, 'not a git bundle');
  const manifestFile = path.join(bundleFailure.checkpoint, 'operation-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.git.sha256 = createHash('sha256').update(readFileSync(bundleFile)).digest('hex');
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => rehearseOperationalRestore({ checkpoint: bundleFailure.checkpoint, restoreParent: restores, restoreName: 'failed-clone' }));
  assert.equal(readdirSync(restores).includes('failed-clone'), false);
  assert.equal(JSON.parse(readFileSync(path.join(restores, '.staging-failed-clone', 'failure.json'), 'utf8')).schema, 'sspat-restore-failure-v1');

  assert.throws(() => createOperationalCheckpoint({ ...request('interrupted'), faultAt: 'after-vault' }), /CHECKPOINT_FAULT_AFTER_VAULT/);
  assert.equal(readdirSync(checkpoints).includes('interrupted'), false);
  assert.equal(JSON.parse(readFileSync(path.join(checkpoints, '.staging-interrupted', 'failure.json'), 'utf8')).operationId, 'interrupted');
  assert.throws(() => createOperationalCheckpoint(request('interrupted')), /CHECKPOINT_OUTPUT_EXISTS/);
  process.stdout.write('operational checkpoint synthetic tests passed\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
