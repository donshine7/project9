import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type FileRecord = { path: string; sha256: string; bytes: number };
type DbVerification = { quickCheck: string; foreignKeyViolations: number; schemaVersion: number; migrations: string[]; markdownDocuments: number };
export type CheckpointRequest = {
  operationId: string;
  profile: 'operational' | 'isolated';
  confirmation: string;
  database: string;
  vault: string;
  checkpointParent: string;
  faultAt?: 'after-database' | 'after-vault' | 'after-bundle';
};
export type RestoreRequest = { checkpoint: string; restoreParent: string; restoreName: string };

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (root: string, candidate: string) => {
  const relative = path.relative(normalized(root), normalized(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const overlaps = (left: string, right: string) => inside(left, right) || inside(right, left);
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function physicalExisting(candidate: string, directory: boolean) {
  const resolved = path.resolve(candidate);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    requireCondition(existsSync(current), `CHECKPOINT_PATH_MISSING:${current}`);
    requireCondition(!lstatSync(current).isSymbolicLink(), `CHECKPOINT_LINK_BLOCKED:${current}`);
  }
  const info = lstatSync(resolved);
  requireCondition(directory ? info.isDirectory() : info.isFile(), `CHECKPOINT_PATH_TYPE:${resolved}`);
  requireCondition(normalized(realpathSync(resolved)) === normalized(resolved), `CHECKPOINT_PATH_ALIAS:${resolved}`);
  return resolved;
}
function files(root: string): FileRecord[] {
  const found: FileRecord[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === root && name === '.git') continue; // The full Git object graph is stored in git-history.bundle.
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      requireCondition(!stat.isSymbolicLink(), `CHECKPOINT_LINK_BLOCKED:${file}`);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        const bytes = readFileSync(file);
        found.push({ path: path.relative(root, file).split(path.sep).join('/'), sha256: hash(bytes), bytes: bytes.length });
      } else requireCondition(false, `CHECKPOINT_SPECIAL_FILE:${file}`);
    }
  };
  visit(root);
  return found;
}
function treeHash(records: FileRecord[]) {
  return hash(records.map((item) => `${item.path}\0${item.sha256}\0${item.bytes}`).join('\n'));
}
function copyVault(source: string, destination: string, inventory: FileRecord[]) {
  mkdirSync(destination);
  for (const item of inventory) {
    const from = path.resolve(source, ...item.path.split('/'));
    const to = path.resolve(destination, ...item.path.split('/'));
    requireCondition(inside(source, from) && inside(destination, to), 'CHECKPOINT_RELATIVE_PATH');
    const stat = lstatSync(from);
    requireCondition(stat.isFile() && !stat.isSymbolicLink(), `CHECKPOINT_LINK_BLOCKED:${from}`);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}
function git(vault: string, args: string[]) {
  return execFileSync('git', args, { cwd: vault, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function tableExists(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function verifyDatabase(file: string, vault: string): DbVerification {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const quickCheck = String(Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] ?? 'missing');
    requireCondition(quickCheck === 'ok', 'CHECKPOINT_DB_INTEGRITY');
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    requireCondition(foreignKeyViolations === 0, 'CHECKPOINT_DB_FOREIGN_KEYS');
    const schemaVersion = Number(Object.values(db.prepare('PRAGMA schema_version').get() ?? {})[0]);
    const migrations = tableExists(db, 'schema_migration')
      ? (db.prepare('SELECT version FROM schema_migration ORDER BY version').all() as Array<{ version: string }>).map((row) => row.version)
      : [];
    let markdownDocuments = 0;
    if (tableExists(db, 'wiki_document_source_mode') && tableExists(db, 'wiki_document')) {
      const rows = db.prepare("SELECT d.doc_id,d.relative_path,d.byte_hash,d.current_revision_id FROM wiki_document d JOIN wiki_document_source_mode s ON s.doc_id=d.doc_id WHERE s.source_mode='markdown'").all() as Array<{ doc_id: string; relative_path: string; byte_hash: string; current_revision_id: string }>;
      for (const row of rows) {
        const document = path.resolve(vault, ...String(row.relative_path).split('/'));
        requireCondition(inside(vault, document) && existsSync(document), `CHECKPOINT_MARKDOWN_MISSING:${row.doc_id}`);
        const stat = lstatSync(document);
        requireCondition(stat.isFile() && !stat.isSymbolicLink() && hash(readFileSync(document)) === row.byte_hash, `CHECKPOINT_MARKDOWN_HASH:${row.doc_id}`);
        if (tableExists(db, 'wiki_markdown_revision')) {
          const revision = db.prepare('SELECT byte_hash FROM wiki_markdown_revision WHERE id=?').get(row.current_revision_id) as { byte_hash: string } | undefined;
          requireCondition(revision?.byte_hash === row.byte_hash, `CHECKPOINT_REVISION_HASH:${row.doc_id}`);
        }
      }
      markdownDocuments = rows.length;
    }
    return { quickCheck, foreignKeyViolations, schemaVersion, migrations, markdownDocuments };
  } finally { db.close(); }
}
function json(file: string) { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>; }
function writeJson(file: string, value: unknown) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }

export function checkpointReadiness(request: CheckpointRequest) {
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(request.operationId), 'CHECKPOINT_ID_INVALID');
  requireCondition(request.profile === 'operational' || request.profile === 'isolated', 'CHECKPOINT_PROFILE_INVALID');
  requireCondition(request.confirmation === `CHECKPOINT:${request.operationId}`, 'CHECKPOINT_CONFIRMATION_REQUIRED');
  requireCondition(request.profile !== 'operational' || !request.faultAt, 'CHECKPOINT_FAULT_OPERATIONAL_BLOCKED');
  const database = physicalExisting(request.database, false);
  const vault = physicalExisting(request.vault, true);
  const parent = physicalExisting(request.checkpointParent, true);
  requireCondition(!overlaps(database, vault) && !overlaps(parent, vault) && !overlaps(parent, database), 'CHECKPOINT_PATH_OVERLAP');
  const gitMarker = path.join(vault, '.git');
  requireCondition(existsSync(gitMarker) && !lstatSync(gitMarker).isSymbolicLink(), 'CHECKPOINT_VAULT_GIT_MARKER');
  const gitRoot = path.resolve(git(vault, ['rev-parse', '--show-toplevel']));
  requireCondition(normalized(gitRoot) === normalized(vault), 'CHECKPOINT_VAULT_GIT_ROOT');
  const head = git(vault, ['rev-parse', 'HEAD']);
  requireCondition(/^[a-f0-9]{40,64}$/.test(head), 'CHECKPOINT_GIT_HEAD');
  const final = path.join(parent, request.operationId);
  const staging = path.join(parent, `.staging-${request.operationId}`);
  requireCondition(!existsSync(final) && !existsSync(staging), 'CHECKPOINT_OUTPUT_EXISTS');
  const gitRefs = git(vault, ['for-each-ref', '--format=%(refname) %(objectname)']);
  return { database, vault, parent, final, staging, gitHead: head, gitRefsSha256: hash(gitRefs), gitDirty: Boolean(git(vault, ['status', '--porcelain', '--untracked-files=all'])) };
}

export function createOperationalCheckpoint(request: CheckpointRequest) {
  const ready = checkpointReadiness(request);
  mkdirSync(ready.staging);
  try {
    // The operator must stop all DB and Vault writers. data_version and tree hashes detect observed races.
    const liveDb = new DatabaseSync(ready.database, { readOnly: true });
    let databaseDataVersionBefore: number;
    let databaseDataVersionAfter: number;
    try {
      databaseDataVersionBefore = Number(Object.values(liveDb.prepare('PRAGMA data_version').get() ?? {})[0]);
      const output = path.join(ready.staging, 'work.db');
      liveDb.exec(`VACUUM INTO '${output.replace(/'/g, "''")}'`);
      if (request.faultAt === 'after-database') throw new Error('CHECKPOINT_FAULT_AFTER_DATABASE');
      const before = files(ready.vault);
      const vaultSnapshot = path.join(ready.staging, 'vault-snapshot');
      copyVault(ready.vault, vaultSnapshot, before);
      if (request.faultAt === 'after-vault') throw new Error('CHECKPOINT_FAULT_AFTER_VAULT');
      const bundleFile = path.join(ready.staging, 'git-history.bundle');
      git(ready.vault, ['bundle', 'create', bundleFile, '--all']);
      git(ready.vault, ['bundle', 'verify', bundleFile]);
      if (request.faultAt === 'after-bundle') throw new Error('CHECKPOINT_FAULT_AFTER_BUNDLE');
      databaseDataVersionAfter = Number(Object.values(liveDb.prepare('PRAGMA data_version').get() ?? {})[0]);
      const after = files(ready.vault);
      const copied = files(vaultSnapshot);
      requireCondition(databaseDataVersionBefore === databaseDataVersionAfter, 'CHECKPOINT_DB_CHANGED');
      requireCondition(treeHash(before) === treeHash(after) && treeHash(before) === treeHash(copied), 'CHECKPOINT_VAULT_CHANGED');
      requireCondition(git(ready.vault, ['rev-parse', 'HEAD']) === ready.gitHead, 'CHECKPOINT_GIT_CHANGED');
      requireCondition(hash(git(ready.vault, ['for-each-ref', '--format=%(refname) %(objectname)'])) === ready.gitRefsSha256, 'CHECKPOINT_GIT_CHANGED');
      const dbVerification = verifyDatabase(output, vaultSnapshot);
      const manifest = {
        schema: 'sspat-operational-checkpoint-v1', operationId: request.operationId,
        createdAt: new Date().toISOString(), profile: request.profile,
        sources: { databasePathSha256: hash(normalized(ready.database)), vaultPathSha256: hash(normalized(ready.vault)) },
        database: { path: 'work.db', sha256: hash(readFileSync(output)), bytes: lstatSync(output).size, dataVersionBefore: databaseDataVersionBefore, dataVersionAfter: databaseDataVersionAfter, verification: dbVerification },
        vault: { path: 'vault-snapshot', treeSha256: treeHash(copied), files: copied, includesUncommitted: true },
        git: { path: 'git-history.bundle', sha256: hash(readFileSync(bundleFile)), head: ready.gitHead, refsSha256: ready.gitRefsSha256, dirtyAtStart: ready.gitDirty, allRefs: true },
        coordination: { writersQuiescenceRequired: true, confirmedByRequest: true, automaticallyEnforced: false },
      };
      writeJson(path.join(ready.staging, 'operation-manifest.json'), manifest);
      verifyCheckpointDirectory(ready.staging);
      renameSync(ready.staging, ready.final);
      return { checkpoint: ready.final, manifestSha256: hash(readFileSync(path.join(ready.final, 'operation-manifest.json'))), database: dbVerification, vaultFiles: copied.length, gitHead: ready.gitHead };
    } finally { liveDb.close(); }
  } catch (error) {
    try { writeJson(path.join(ready.staging, 'failure.json'), { schema: 'sspat-checkpoint-failure-v1', operationId: request.operationId, failedAt: new Date().toISOString(), reason: String(error) }); } catch { /* preserve partial staging as found */ }
    throw error;
  }
}

export function verifyCheckpointDirectory(checkpointInput: string) {
  const checkpoint = physicalExisting(checkpointInput, true);
  const manifestFile = physicalExisting(path.join(checkpoint, 'operation-manifest.json'), false);
  const manifest = json(manifestFile);
  requireCondition(manifest.schema === 'sspat-operational-checkpoint-v1', 'CHECKPOINT_MANIFEST_SCHEMA');
  const database = physicalExisting(path.join(checkpoint, 'work.db'), false);
  const vault = physicalExisting(path.join(checkpoint, 'vault-snapshot'), true);
  const bundle = physicalExisting(path.join(checkpoint, 'git-history.bundle'), false);
  requireCondition(hash(readFileSync(database)) === manifest.database.sha256, 'CHECKPOINT_DB_HASH');
  requireCondition(hash(readFileSync(bundle)) === manifest.git.sha256, 'CHECKPOINT_BUNDLE_HASH');
  const inventory = files(vault);
  requireCondition(JSON.stringify(inventory) === JSON.stringify(manifest.vault.files) && treeHash(inventory) === manifest.vault.treeSha256, 'CHECKPOINT_VAULT_HASH');
  const checked = verifyDatabase(database, vault);
  requireCondition(JSON.stringify(checked) === JSON.stringify(manifest.database.verification), 'CHECKPOINT_DB_VERIFICATION');
  return { checkpoint, manifest, database, vault, bundle, verifiedFiles: inventory.length };
}

export function rehearseOperationalRestore(request: RestoreRequest) {
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(request.restoreName), 'RESTORE_NAME_INVALID');
  const source = verifyCheckpointDirectory(request.checkpoint);
  const parent = physicalExisting(request.restoreParent, true);
  requireCondition(!overlaps(parent, source.checkpoint), 'RESTORE_PATH_OVERLAP');
  const final = path.join(parent, request.restoreName);
  const staging = path.join(parent, `.staging-${request.restoreName}`);
  requireCondition(!existsSync(final) && !existsSync(staging), 'RESTORE_OUTPUT_EXISTS');
  mkdirSync(staging);
  try {
    const dbDirectory = path.join(staging, 'db');
    mkdirSync(dbDirectory);
    copyFileSync(source.database, path.join(dbDirectory, 'work.db'));
    const vault = path.join(staging, 'vault');
    execFileSync('git', ['clone', '--no-checkout', source.bundle, vault], { stdio: ['ignore', 'pipe', 'pipe'] });
    const restoredHead = git(vault, ['rev-parse', 'HEAD']);
    requireCondition(restoredHead === source.manifest.git.head, 'RESTORE_GIT_HEAD');
    git(vault, ['fsck', '--full', '--no-reflogs']);
    for (const name of readdirSync(vault)) if (name !== '.git') rmSync(path.join(vault, name), { recursive: true, force: true });
    copyVaultContents(source.vault, vault, source.manifest.vault.files as FileRecord[]);
    const restoredInventory = files(vault);
    requireCondition(treeHash(restoredInventory) === source.manifest.vault.treeSha256, 'RESTORE_VAULT_HASH');
    const restoredDatabase = path.join(dbDirectory, 'work.db');
    requireCondition(hash(readFileSync(restoredDatabase)) === source.manifest.database.sha256, 'RESTORE_DB_HASH');
    const checked = verifyDatabase(restoredDatabase, vault);
    const report = { schema: 'sspat-operational-restore-rehearsal-v1', operationId: source.manifest.operationId, completedAt: new Date().toISOString(), checkpointManifestSha256: hash(readFileSync(path.join(source.checkpoint, 'operation-manifest.json'))), restoredDatabaseSha256: hash(readFileSync(restoredDatabase)), restoredVaultTreeSha256: treeHash(restoredInventory), restoredGitHead: restoredHead, verifiedFiles: restoredInventory.length, verification: checked, productionModified: false };
    writeJson(path.join(staging, 'restore-report.json'), report);
    renameSync(staging, final);
    return { restore: final, ...report };
  } catch (error) {
    try { writeJson(path.join(staging, 'failure.json'), { schema: 'sspat-restore-failure-v1', failedAt: new Date().toISOString(), reason: String(error) }); } catch { /* preserve partial staging */ }
    throw error;
  }
}

function copyVaultContents(source: string, destination: string, inventory: FileRecord[]) {
  for (const item of inventory) {
    const from = path.resolve(source, ...item.path.split('/'));
    const to = path.resolve(destination, ...item.path.split('/'));
    requireCondition(inside(source, from) && inside(destination, to), 'RESTORE_RELATIVE_PATH');
    const stat = lstatSync(from);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && hash(readFileSync(from)) === item.sha256, `RESTORE_SOURCE_INVALID:${item.path}`);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}
