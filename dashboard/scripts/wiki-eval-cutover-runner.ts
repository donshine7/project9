import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executeWikiCutover, rehearseWikiRecovery } from '../lib/wiki-cutover';
import { prepareWiki } from '../lib/wiki';
import { databasePath, withDatabase } from '../lib/work-db';

type CliOptions = { dataset: string; runRoot: string; runId: string };
type Row = Record<string, any>;

function fail(message: string): never { throw new Error(message); }

function options(argv: string[]): CliOptions {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) fail('인수는 --dataset, --run-root, --run-id 쌍으로 지정하세요.');
    result[key.slice(2)] = value;
  }
  if (!result.dataset || !result['run-root'] || !result['run-id']) fail('--dataset, --run-root, --run-id가 모두 필요합니다.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/.test(result['run-id'])) fail('--run-id 형식이 올바르지 않습니다.');
  return { dataset: path.resolve(result.dataset), runRoot: path.resolve(result['run-root']), runId: result['run-id'] };
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = <T>(file: string) => JSON.parse(readFileSync(file, 'utf8')) as T;

function writeFrozenJson(file: string, value: unknown) {
  if (existsSync(file)) fail(`고정 산출물을 덮어쓸 수 없습니다: ${file}`);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function treeHash(root: string) {
  const entries: Array<[string, string, number]> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const target = path.join(directory, name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) fail(`고정 실행물의 심볼릭 링크를 따라가지 않습니다: ${target}`);
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) {
        const bytes = readFileSync(target);
        entries.push([path.relative(root, target).split(path.sep).join('/'), sha256(bytes), bytes.length]);
      } else fail(`지원하지 않는 고정 실행물입니다: ${target}`);
    }
  };
  visit(root);
  return sha256(JSON.stringify(entries));
}

function gitState(sourceRoot: string) {
  try {
    const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' });
    return { gitCommit, gitDirty: Boolean(status.trim()) };
  } catch {
    return { gitCommit: null, gitDirty: null };
  }
}

function seedLegacySources(results: Row[]) {
  withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const timestamp = new Date().toISOString();
      for (const [index, result] of results.entries()) {
        const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(result.docId) as Row | undefined;
        if (!document?.entity_type || !document.entity_id) fail(`엔티티 Wiki 문서가 아닙니다: ${result.docId}`);
        const runId = `stage6-legacy-run-${String(index + 1).padStart(3, '0')}`;
        const publicationEvent = `stage6-legacy-publication-${String(index + 1).padStart(3, '0')}`;
        const revisionId = `stage6-legacy-revision-${String(index + 1).padStart(3, '0')}`;
        const sections = [{ key: 'overview', title: '현재 요약', sentences: [{ text: `${result.docId} 전환 전 legacy 본문`, entryDate: null, eventIds: [] }] }];
        db.prepare(`INSERT INTO decision_run(id,operation,status,started_at,completed_at) VALUES (?,'wiki_revision','succeeded',?,?)`).run(runId, timestamp, timestamp);
        db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES (?,?,?,?,?,'장진태','user_input',?)`)
          .run(publicationEvent, document.entity_type, document.entity_id, 'wiki.publish', JSON.stringify({ synthetic: true }), timestamp);
        db.prepare(`INSERT INTO entity_wiki_revision(id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(revisionId, document.entity_type, document.entity_id, 1, runId, JSON.stringify(sections), 'Stage 6 합성 legacy 본문', sha256(result.docId), publicationEvent, timestamp);
        db.prepare(`INSERT INTO wiki_document_source_mode(doc_id,source_mode,legacy_entity_type,legacy_entity_id,changed_at) VALUES (?,'legacy_db',?,?,?)`)
          .run(result.docId, document.entity_type, document.entity_id, timestamp);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

async function main() {
  const cli = options(process.argv.slice(2));
  if (existsSync(cli.runRoot)) fail(`새 실행마다 존재하지 않는 --run-root를 사용해야 합니다: ${cli.runRoot}`);
  const sourceRoot = path.resolve(process.cwd(), '..');
  const baseRoot = path.join(cli.runRoot, 'base');
  const verticalRunner = path.join(__dirname, 'wiki-eval-vertical-runner.js');
  execFileSync(process.execPath, [verticalRunner, '--dataset', cli.dataset, '--run-root', baseRoot, '--run-id', `${cli.runId}-vertical`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  const baseManifest = readJson<Row>(path.join(baseRoot, 'run-manifest.json'));
  const baseResults = readJson<{ results: Row[] }>(path.join(baseRoot, 'output', 'vertical-results.json'));
  const workRoot = path.join(baseRoot, 'work');
  const vaultPath = path.join(workRoot, 'vault');
  const dbPath = path.join(workRoot, 'db', 'work.db');
  process.env.SSPAT_RUNTIME_PROFILE = 'eval';
  process.env.SSPAT_ISOLATED_ROOT = workRoot;
  process.env.SSPAT_WORK_DB_PATH = dbPath;
  process.env.SSPAT_WIKI_VAULT_PATH = vaultPath;
  process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(workRoot, 'notice-projects');
  process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(workRoot, 'spec-projects');
  process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(workRoot, 'provisional-projects');
  process.env.SSPAT_PROJECT_ROOT = sourceRoot;
  process.chdir(path.join(sourceRoot, 'dashboard'));

  seedLegacySources(baseResults.results);
  const targets = baseResults.results.map((result) => ({ docId: result.docId, expectedByteHash: result.targetByteHash, proposalId: result.proposalId }));
  const cutover = await executeWikiCutover({
    authorizationId: `${cli.runId}-authorization`,
    reviewer: '장진태',
    confirmation: 'CUTOVER',
    bundleRoot: path.join(workRoot, 'cutover-bundles'),
    targets,
  }) as Row;
  const recovery = rehearseWikiRecovery(cutover.run.id, path.join(workRoot, 'recovery-copy')) as Row;

  let blockedLegacyWrites = 0;
  for (const target of cutover.items as Row[]) {
    try {
      prepareWiki(target.entity_type, target.entity_id);
    } catch (error: any) {
      if (error?.code === 'WIKI_LEGACY_WRITE_BLOCKED') blockedLegacyWrites += 1;
      else throw error;
    }
  }

  const outputRoot = path.join(cli.runRoot, 'output');
  mkdirSync(outputRoot, { recursive: true });
  const resultFile = path.join(outputRoot, 'cutover-results.json');
  const results = {
    schema: 'wiki-cutover-eval-results-v1',
    cutoverRunId: cutover.run.id,
    targetCount: cutover.items.length,
    blockedLegacyWrites,
    recoveryRehearsalId: recovery.rehearsalId,
    recoveryVerifiedDocumentCount: recovery.verifiedDocumentCount,
    productionModified: recovery.productionModified,
    documents: (cutover.items as Row[]).map((item) => ({
      docId: item.doc_id,
      entityType: item.entity_type,
      entityId: item.entity_id,
      expectedByteHash: item.expected_byte_hash,
      proposalId: item.proposal_id,
      proposalReviewId: item.proposal_review_id,
      legacyRevisionId: item.legacy_revision_id,
      sourceChangeEventId: item.source_change_event_id,
      sourceMode: item.new_source_mode,
    })),
  };
  writeFrozenJson(resultFile, results);
  const cutoverManifest = path.join(cutover.run.bundle_path, 'cutover-manifest.json');
  const recoveryReport = path.join(recovery.restoreRoot, 'recovery-report.json');
  const manifest = {
    schema: 'wiki-cutover-eval-run-v1',
    runId: cli.runId,
    createdAt: new Date().toISOString(),
    candidate: gitState(sourceRoot),
    dataset: { id: baseManifest.dataset.id, baseManifestSha256: sha256(readFileSync(path.join(baseRoot, 'run-manifest.json'))) },
    environment: {
      runtimeProfile: 'eval',
      isolatedRoot: workRoot,
      databasePath: databasePath(),
      vaultPath,
      cutoverBundlePath: cutover.run.bundle_path,
      recoveryRoot: recovery.restoreRoot,
    },
    artifacts: {
      database: sha256(readFileSync(dbPath)),
      vaultTree: treeHash(vaultPath),
      cutoverManifest: sha256(readFileSync(cutoverManifest)),
      recoveryReport: sha256(readFileSync(recoveryReport)),
      cutoverResults: sha256(readFileSync(resultFile)),
    },
    targetCount: targets.length,
  };
  writeFrozenJson(path.join(cli.runRoot, 'run-manifest.json'), manifest);
  process.stdout.write(`${JSON.stringify({ runRoot: cli.runRoot, manifest, results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
