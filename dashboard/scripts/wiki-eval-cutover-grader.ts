import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type CliOptions = { runRoot: string; expected: string; report: string };
type Check = { id: string; passed: boolean; detail: string };
type Row = Record<string, any>;

function fail(message: string): never { throw new Error(message); }

function options(argv: string[]): CliOptions {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) fail('인수는 --run-root, --expected, --report 쌍으로 지정하세요.');
    result[key.slice(2)] = value;
  }
  if (!result['run-root'] || !result.expected || !result.report) fail('--run-root, --expected, --report가 모두 필요합니다.');
  return { runRoot: path.resolve(result['run-root']), expected: path.resolve(result.expected), report: path.resolve(result.report) };
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = <T>(file: string) => JSON.parse(readFileSync(file, 'utf8')) as T;

function inside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safePath(root: string, candidate: unknown, label: string) {
  const resolved = path.resolve(String(candidate ?? ''));
  if (!inside(root, resolved) || !existsSync(resolved)) fail(`${label} 경로가 고정 실행 폴더 밖이거나 없습니다.`);
  return resolved;
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

function cutoverTreeHash(root: string) {
  const entries: string[] = [];
  const separator = String.fromCharCode(0);
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const target = path.join(directory, name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) fail(`복원 Vault의 심볼릭 링크를 따라가지 않습니다: ${target}`);
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) {
        const bytes = readFileSync(target);
        entries.push(`${path.relative(root, target).split(path.sep).join('/')}${separator}${sha256(bytes)}${separator}${bytes.length}`);
      } else fail(`지원하지 않는 복원 Vault 항목입니다: ${target}`);
    }
  };
  visit(root);
  return sha256(entries.join('\n'));
}

function check(checks: Check[], id: string, passed: boolean, detail: string) { checks.push({ id, passed, detail }); }

function main() {
  const cli = options(process.argv.slice(2));
  if (existsSync(cli.report)) fail(`기존 채점 보고서를 덮어쓰지 않습니다: ${cli.report}`);
  const manifest = readJson<Row>(path.join(cli.runRoot, 'run-manifest.json'));
  const expected = readJson<Row>(cli.expected);
  if (manifest.schema !== 'wiki-cutover-eval-run-v1') fail('지원하지 않는 원본 전환 실행 manifest입니다.');
  if (expected.schema !== 'wiki-cutover-eval-expected-v1') fail('지원하지 않는 원본 전환 expected 계약입니다.');
  const resultsFile = path.join(cli.runRoot, 'output', 'cutover-results.json');
  const results = readJson<Row>(resultsFile);
  const database = safePath(cli.runRoot, manifest.environment.databasePath, 'database');
  const vault = safePath(cli.runRoot, manifest.environment.vaultPath, 'vault');
  const bundle = safePath(cli.runRoot, manifest.environment.cutoverBundlePath, 'cutover bundle');
  const recoveryRoot = safePath(cli.runRoot, manifest.environment.recoveryRoot, 'recovery root');
  const cutoverManifestFile = path.join(bundle, 'cutover-manifest.json');
  const recoveryReportFile = path.join(recoveryRoot, 'recovery-report.json');
  const cutoverManifest = readJson<Row>(cutoverManifestFile);
  const recoveryReport = readJson<Row>(recoveryReportFile);
  const checks: Check[] = [];

  check(checks, 'dataset.identity', manifest.dataset.id === expected.datasetId, `actual=${manifest.dataset.id}`);
  check(checks, 'target.count', manifest.targetCount === expected.targetCount && results.targetCount === expected.targetCount, `manifest=${manifest.targetCount}, results=${results.targetCount}`);
  check(checks, 'artifact.database_hash', sha256(readFileSync(database)) === manifest.artifacts.database, 'DB SHA-256');
  check(checks, 'artifact.vault_tree_hash', treeHash(vault) === manifest.artifacts.vaultTree, 'Vault tree SHA-256');
  check(checks, 'artifact.cutover_manifest_hash', sha256(readFileSync(cutoverManifestFile)) === manifest.artifacts.cutoverManifest, 'cutover manifest SHA-256');
  check(checks, 'artifact.recovery_report_hash', sha256(readFileSync(recoveryReportFile)) === manifest.artifacts.recoveryReport, 'recovery report SHA-256');
  check(checks, 'artifact.results_hash', sha256(readFileSync(resultsFile)) === manifest.artifacts.cutoverResults, 'cutover results SHA-256');
  const bundledDatabase = safePath(bundle, path.join(bundle, ...String(cutoverManifest.artifacts.databaseAfter.path).split('/')), 'bundled database');
  const bundledVault = safePath(bundle, path.join(bundle, ...String(cutoverManifest.artifacts.vault.path).split('/')), 'bundled vault');
  check(checks, 'bundle.database_hash', sha256(readFileSync(bundledDatabase)) === cutoverManifest.artifacts.databaseAfter.sha256, 'bundled DB SHA-256');
  check(checks, 'bundle.vault_hash', cutoverTreeHash(bundledVault) === cutoverManifest.artifacts.vault.treeSha256, 'bundled Vault tree SHA-256');
  check(checks, 'safety.legacy_writes_blocked', results.blockedLegacyWrites === expected.targetCount, `actual=${results.blockedLegacyWrites}`);
  check(checks, 'safety.production_untouched', results.productionModified === false && recoveryReport.productionModified === false, `results=${results.productionModified}`);
  check(checks, 'recovery.document_count', results.recoveryVerifiedDocumentCount === expected.targetCount && recoveryReport.verifiedDocumentCount === expected.targetCount, `actual=${recoveryReport.verifiedDocumentCount}`);
  check(checks, 'cutover.no_active_markdown_write', cutoverManifest.guarantees?.activeMarkdownModified === false, JSON.stringify(cutoverManifest.guarantees));
  check(checks, 'cutover.no_silent_fallback', cutoverManifest.guarantees?.silentLegacyFallbackAllowed === false, JSON.stringify(cutoverManifest.guarantees));
  check(checks, 'cutover.legacy_preserved', cutoverManifest.guarantees?.legacyRevisionDeleted === false, JSON.stringify(cutoverManifest.guarantees));

  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const quickCheck = db.prepare('PRAGMA quick_check').get() as Row;
    check(checks, 'database.quick_check', Object.values(quickCheck)[0] === 'ok', `actual=${Object.values(quickCheck)[0]}`);
    const run = db.prepare('SELECT * FROM wiki_cutover_run WHERE id=?').get(results.cutoverRunId) as Row | undefined;
    check(checks, 'database.cutover_succeeded', run?.status === 'succeeded', `status=${run?.status}`);
    const resultByDoc = new Map((results.documents as Row[]).map((item) => [item.docId, item]));
    for (const docId of expected.documents as string[]) {
      const result = resultByDoc.get(docId) as Row | undefined;
      const sourceMode = db.prepare('SELECT * FROM wiki_document_source_mode WHERE doc_id=?').get(docId) as Row | undefined;
      const item = db.prepare('SELECT * FROM wiki_cutover_item WHERE cutover_run_id=? AND doc_id=?').get(results.cutoverRunId, docId) as Row | undefined;
      const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(docId) as Row | undefined;
      const proposal = result ? db.prepare('SELECT * FROM wiki_proposal WHERE id=?').get(result.proposalId) as Row | undefined : undefined;
      const review = result ? db.prepare('SELECT * FROM wiki_proposal_review WHERE id=?').get(result.proposalReviewId) as Row | undefined : undefined;
      const legacy = result ? db.prepare('SELECT * FROM entity_wiki_revision WHERE id=?').get(result.legacyRevisionId) as Row | undefined : undefined;
      const event = result ? db.prepare('SELECT * FROM event WHERE id=?').get(result.sourceChangeEventId) as Row | undefined : undefined;
      check(checks, `document.${docId}.present`, Boolean(result && item && document), result ? 'present' : 'missing');
      check(checks, `document.${docId}.source_mode`, sourceMode?.source_mode === expected.sourceMode && item?.new_source_mode === expected.sourceMode, `actual=${sourceMode?.source_mode}`);
      check(checks, `document.${docId}.review`, proposal?.status === 'applied_observed' && review?.action === 'accept_for_manual_apply', `proposal=${proposal?.status}, review=${review?.action}`);
      check(checks, `document.${docId}.legacy_preserved`, Boolean(legacy), `legacy=${legacy?.id ?? 'missing'}`);
      check(checks, `document.${docId}.event`, event?.event_type === 'wiki.source_mode_changed' && JSON.parse(event?.after_json ?? '{}').automaticApply === false, `event=${event?.event_type}`);
      if (document && result) {
        const file = safePath(vault, path.join(vault, ...String(document.relative_path).split('/')), `active Markdown ${docId}`);
        check(checks, `document.${docId}.hash`, sha256(readFileSync(file)) === result.expectedByteHash && document.byte_hash === result.expectedByteHash, document.relative_path);
      } else check(checks, `document.${docId}.hash`, false, 'missing');
    }
  } finally {
    db.close();
  }

  const restoredDatabase = safePath(recoveryRoot, path.join(recoveryRoot, 'db', 'work.db'), 'restored database');
  const restoredVault = safePath(recoveryRoot, path.join(recoveryRoot, 'vault'), 'restored vault');
  check(checks, 'recovery.database_hash', sha256(readFileSync(restoredDatabase)) === recoveryReport.restoredDatabaseHash, 'restored DB SHA-256');
  check(checks, 'recovery.vault_hash', cutoverTreeHash(restoredVault) === recoveryReport.restoredVaultHash, 'restored Vault tree SHA-256');

  const passedCount = checks.filter((item) => item.passed).length;
  const report = {
    schema: 'wiki-cutover-eval-grade-report-v1',
    runId: manifest.runId,
    datasetId: manifest.dataset.id,
    gradedAt: new Date().toISOString(),
    passed: passedCount === checks.length,
    score: { passed: passedCount, total: checks.length },
    checks,
  };
  writeFileSync(cli.report, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
