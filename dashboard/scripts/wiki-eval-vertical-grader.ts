import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type CliOptions = { runRoot: string; expected: string; report: string };
type Check = { id: string; passed: boolean; detail: string };
type Expected = {
  schema: string;
  datasetId: string;
  targetCount: number;
  proposalStatus: string;
  finalReviewStatus: string;
  automaticApply: boolean;
  documents: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function options(argv: string[]): CliOptions {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) fail('인수는 --run-root, --expected, --report 쌍으로 지정하세요.');
    result[key.slice(2)] = value;
  }
  if (!result['run-root'] || !result.expected || !result.report) fail('--run-root, --expected, --report가 모두 필요합니다.');
  return {
    runRoot: path.resolve(result['run-root']),
    expected: path.resolve(result.expected),
    report: path.resolve(result.report),
  };
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function inside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeRunPath(runRoot: string, candidate: unknown, label: string) {
  const resolved = path.resolve(String(candidate ?? ''));
  if (!inside(runRoot, resolved)) fail(`${label} 경로가 고정 실행 폴더 밖을 가리킵니다.`);
  return resolved;
}

function treeHash(root: string) {
  const entries: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const target = path.join(directory, name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) fail(`고정 실행물의 심볼릭 링크를 따라가지 않습니다: ${target}`);
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) entries.push(`${path.relative(root, target).split(path.sep).join('/')}\0${sha256(readFileSync(target))}`);
      else fail(`지원하지 않는 고정 실행물입니다: ${target}`);
    }
  };
  visit(root);
  return sha256(entries.join('\n'));
}

function check(checks: Check[], id: string, passed: boolean, detail: string) {
  checks.push({ id, passed, detail });
}

function main() {
  const cli = options(process.argv.slice(2));
  if (existsSync(cli.report)) fail(`기존 채점 보고서를 덮어쓰지 않습니다: ${cli.report}`);
  const manifest = readJson<Record<string, any>>(path.join(cli.runRoot, 'run-manifest.json'));
  const expected = readJson<Expected>(cli.expected);
  if (manifest.schema !== 'wiki-vertical-eval-run-v1') fail('지원하지 않는 수직 실행 manifest입니다.');
  if (expected.schema !== 'wiki-vertical-eval-expected-v1') fail('지원하지 않는 수직 expected 계약입니다.');

  const dbFile = safeRunPath(cli.runRoot, manifest.environment?.databasePath, 'database');
  const vaultRoot = safeRunPath(cli.runRoot, manifest.environment?.vaultPath, 'vault');
  const resultsFile = path.join(cli.runRoot, 'output', 'vertical-results.json');
  const reviewIndexFile = path.join(cli.runRoot, 'output', 'wiki-review-index.json');
  const results = readJson<{ schema: string; results: Array<Record<string, any>>; trace: Array<Record<string, any>> }>(resultsFile);
  const reviewIndex = readJson<{ documents: Array<Record<string, any>> }>(reviewIndexFile);
  const checks: Check[] = [];

  check(checks, 'dataset.identity', manifest.dataset?.id === expected.datasetId, `actual=${manifest.dataset?.id}`);
  check(checks, 'target.count', manifest.targetCount === expected.targetCount && results.results.length === expected.targetCount, `manifest=${manifest.targetCount}, results=${results.results.length}`);
  check(checks, 'artifact.database_hash', sha256(readFileSync(dbFile)) === manifest.artifacts?.database, 'DB SHA-256');
  check(checks, 'artifact.vault_tree_hash', treeHash(vaultRoot) === manifest.artifacts?.vaultTree, 'Vault tree SHA-256');
  check(checks, 'artifact.results_hash', sha256(readFileSync(resultsFile)) === manifest.artifacts?.verticalResults, 'vertical-results.json SHA-256');
  check(checks, 'artifact.review_index_hash', sha256(readFileSync(reviewIndexFile)) === manifest.artifacts?.wikiReviewIndex, 'wiki-review-index.json SHA-256');

  const resultByDocument = new Map(results.results.map((result) => [result.docId, result]));
  const indexByDocument = new Map(reviewIndex.documents.map((document) => [document.docId, document]));
  for (const docId of expected.documents) {
    const result = resultByDocument.get(docId);
    const document = indexByDocument.get(docId);
    check(checks, `flow.${docId}.present`, Boolean(result && document), result ? result.scenarioId : 'missing');
    check(checks, `flow.${docId}.no_auto_apply`, result?.automaticApply === expected.automaticApply && result?.activeUnchangedBeforeManual === true, `automaticApply=${result?.automaticApply}, unchanged=${result?.activeUnchangedBeforeManual}`);
    check(checks, `flow.${docId}.manual_apply`, result?.manualApplied === true && result?.proposalStatus === expected.proposalStatus, `status=${result?.proposalStatus}`);
    check(checks, `flow.${docId}.review_status`, result?.finalReviewStatus === expected.finalReviewStatus && document?.status === expected.finalReviewStatus, `result=${result?.finalReviewStatus}, index=${document?.status}`);
    check(checks, `flow.${docId}.target_hash`, result?.finalByteHash === result?.targetByteHash, `final=${result?.finalByteHash}, target=${result?.targetByteHash}`);
    const steps = results.trace.filter((item) => item.scenarioId === result?.scenarioId).map((item) => item.step);
    const expectedSteps = ['human_edit', 'scan_after_edit', 'proposal', 'human_review', 'manual_apply_and_rescan'];
    check(checks, `flow.${docId}.trace`, expectedSteps.every((step) => steps.includes(step)), steps.join(','));
  }

  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const quickCheck = db.prepare('PRAGMA quick_check').get() as { quick_check?: string };
    check(checks, 'database.quick_check', quickCheck.quick_check === 'ok', `actual=${quickCheck.quick_check}`);
    const proposalCount = Number((db.prepare("SELECT COUNT(*) count FROM wiki_proposal WHERE status='applied_observed'").get() as { count: number }).count);
    const reviewCount = Number((db.prepare("SELECT COUNT(*) count FROM wiki_proposal_review WHERE action='accept_for_manual_apply'").get() as { count: number }).count);
    const operationCount = Number((db.prepare("SELECT COUNT(*) count FROM wiki_file_operation WHERE operation_type='proposal_write' AND status='succeeded'").get() as { count: number }).count);
    check(checks, 'database.proposal_count', proposalCount === expected.targetCount, `actual=${proposalCount}`);
    check(checks, 'database.review_count', reviewCount === expected.targetCount, `actual=${reviewCount}`);
    check(checks, 'database.operation_count', operationCount === expected.targetCount, `actual=${operationCount}`);
    const reviewEvents = db.prepare("SELECT after_json FROM event WHERE event_type='wiki.proposal_reviewed'").all() as Array<{ after_json: string }>;
    check(
      checks,
      'database.review_events_no_auto_apply',
      reviewEvents.length === expected.targetCount && reviewEvents.every((event) => JSON.parse(event.after_json).automaticApply === false),
      `actual=${reviewEvents.length}`,
    );
    const proposals = db.prepare(`
      SELECT p.doc_id,p.target_byte_hash,d.relative_path
      FROM wiki_proposal p
      JOIN wiki_document d ON d.doc_id=p.doc_id
      ORDER BY p.doc_id
    `).all() as Array<{ doc_id: string; target_byte_hash: string; relative_path: string }>;
    for (const proposal of proposals) {
      const file = safeRunPath(vaultRoot, path.join(vaultRoot, ...proposal.relative_path.split('/')), 'active Markdown');
      check(checks, `vault.${proposal.doc_id}.target_hash`, sha256(readFileSync(file)) === proposal.target_byte_hash, proposal.relative_path);
    }
  } finally {
    db.close();
  }

  const passedCount = checks.filter((item) => item.passed).length;
  const report = {
    schema: 'wiki-vertical-eval-grade-report-v1',
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

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
