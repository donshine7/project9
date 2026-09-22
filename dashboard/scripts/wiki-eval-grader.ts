import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type CliOptions = { runRoot: string; expected: string; report: string };
type Check = { id: string; passed: boolean; detail: string };
type ExpectedDocument = { docId: string; documentType: string; parseStatus: string };

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

function safeRunPath(runRoot: string, candidate: unknown, label: string) {
  const resolved = path.resolve(String(candidate ?? ''));
  if (!inside(runRoot, resolved)) fail(`${label} 경로가 고정 실행 폴더 밖을 가리킵니다.`);
  return resolved;
}

function main() {
  const cli = options(process.argv.slice(2));
  if (existsSync(cli.report)) fail(`기존 채점 보고서를 덮어쓰지 않습니다: ${cli.report}`);
  const manifestFile = path.join(cli.runRoot, 'run-manifest.json');
  const manifest = readJson<Record<string, any>>(manifestFile);
  const expected = readJson<Record<string, any>>(cli.expected);
  if (manifest.schema !== 'wiki-eval-run-v1') fail('지원하지 않는 실행 manifest입니다.');
  if (expected.schema !== 'wiki-eval-expected-v1') fail('지원하지 않는 expected 계약입니다.');

  const dbFile = safeRunPath(cli.runRoot, manifest.environment?.databasePath, 'database');
  const vaultRoot = safeRunPath(cli.runRoot, manifest.environment?.vaultPath, 'vault');
  const indexFile = path.join(cli.runRoot, 'output', 'wiki-index.json');
  const issuesFile = path.join(cli.runRoot, 'output', 'wiki-issues.json');
  const checks: Check[] = [];

  check(checks, 'dataset.identity', manifest.dataset?.id === expected.datasetId, `actual=${manifest.dataset?.id}`);
  check(checks, 'artifact.database_hash', sha256(readFileSync(dbFile)) === manifest.artifacts?.database, 'DB SHA-256');
  check(checks, 'artifact.vault_tree_hash', treeHash(vaultRoot) === manifest.artifacts?.vaultTree, 'Vault tree SHA-256');
  check(checks, 'artifact.index_hash', sha256(readFileSync(indexFile)) === manifest.artifacts?.wikiIndex, 'wiki-index.json SHA-256');
  check(checks, 'artifact.issues_hash', sha256(readFileSync(issuesFile)) === manifest.artifacts?.wikiIssues, 'wiki-issues.json SHA-256');

  const index = readJson<{ documents: Array<Record<string, any>> }>(indexFile);
  const issues = readJson<Array<Record<string, any>>>(issuesFile);
  const expectedValue = expected.expected as {
    documentCount: number;
    issueCount: number;
    revisionCount: number;
    documents: ExpectedDocument[];
  };
  check(checks, 'output.document_count', index.documents.length === expectedValue.documentCount, `actual=${index.documents.length}`);
  check(checks, 'output.issue_count', issues.length === expectedValue.issueCount, `actual=${issues.length}`);
  const byId = new Map(index.documents.map((document) => [document.docId, document]));
  for (const document of expectedValue.documents) {
    const actual = byId.get(document.docId);
    check(
      checks,
      `document.${document.docId}`,
      actual?.documentType === document.documentType && actual?.parseStatus === document.parseStatus,
      actual ? `type=${actual.documentType}, status=${actual.parseStatus}` : 'missing',
    );
  }

  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const quickCheck = db.prepare('PRAGMA quick_check').get() as { quick_check?: string };
    check(checks, 'database.quick_check', quickCheck.quick_check === 'ok', `actual=${quickCheck.quick_check}`);
    const documentColumns = (db.prepare('PRAGMA table_info(wiki_document)').all() as Array<{ name: string }>).map((row) => row.name);
    const forbiddenColumns = documentColumns.filter((name) => /(^|_)(body|content|markdown)(_|$)/i.test(name));
    check(checks, 'database.no_markdown_body', forbiddenColumns.length === 0, `forbidden=${forbiddenColumns.join(',') || 'none'}`);
    const revisionCount = Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_markdown_revision').get() as { count: number }).count);
    check(checks, 'database.revision_count', revisionCount === expectedValue.revisionCount, `actual=${revisionCount}`);
    const revisions = db.prepare('SELECT doc_id,byte_hash,history_object_path FROM wiki_markdown_revision ORDER BY doc_id').all() as Array<{
      doc_id: string;
      byte_hash: string;
      history_object_path: string;
    }>;
    for (const revision of revisions) {
      const objectFile = safeRunPath(vaultRoot, path.join(vaultRoot, ...revision.history_object_path.split('/')), 'history object');
      check(
        checks,
        `history.${revision.doc_id}`,
        existsSync(objectFile) && sha256(readFileSync(objectFile)) === revision.byte_hash,
        revision.history_object_path,
      );
    }
  } finally {
    db.close();
  }

  const passedCount = checks.filter((item) => item.passed).length;
  const report = {
    schema: 'wiki-eval-grade-report-v1',
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
