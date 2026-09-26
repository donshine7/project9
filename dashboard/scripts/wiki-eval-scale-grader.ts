import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new Error(message); };

function args(values: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) options.set(values[index], values[index + 1]);
  const runRoot = path.resolve(options.get('--run-root') ?? '');
  const expected = path.resolve(options.get('--expected') ?? '');
  const report = path.resolve(options.get('--report') ?? '');
  if (!runRoot || !expected || !report) fail('--run-root, --expected, --report가 필요합니다.');
  return { runRoot, expected, report };
}

function readJson(file: string) { return JSON.parse(readFileSync(file, 'utf8')) as Row; }
function inside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function safe(root: string, candidate: string) {
  const resolved = path.resolve(candidate);
  if (!inside(root, resolved) || !existsSync(resolved) || lstatSync(resolved).isSymbolicLink()) fail(`실행 폴더 밖이거나 안전하지 않은 경로입니다: ${resolved}`);
  return resolved;
}
function treeHash(root: string) {
  const entries: Array<[string, string, number]> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) fail(`symlink를 허용하지 않습니다: ${target}`);
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) { const bytes = readFileSync(target); entries.push([path.relative(root, target).split(path.sep).join('/'), sha256(bytes), bytes.length]); }
    }
  };
  visit(root);
  return sha256(JSON.stringify(entries));
}
function add(checks: Check[], id: string, passed: boolean, detail: string) { checks.push({ id, passed, detail }); }

function main() {
  const cli = args(process.argv.slice(2));
  if (existsSync(cli.report)) fail(`기존 보고서를 덮어쓰지 않습니다: ${cli.report}`);
  const manifest = readJson(path.join(cli.runRoot, 'run-manifest.json'));
  const expected = readJson(cli.expected);
  const resultsFile = path.join(cli.runRoot, 'output', 'scale-results.json');
  const results = readJson(resultsFile);
  const database = safe(cli.runRoot, manifest.environment.database);
  const vault = safe(cli.runRoot, manifest.environment.vault);
  const checks: Check[] = [];
  add(checks, 'schema.manifest', manifest.schema === 'wiki-scale-eval-run-v1', String(manifest.schema));
  add(checks, 'schema.results', results.schema === 'wiki-scale-eval-results-v1', String(results.schema));
  add(checks, 'candidate.clean', manifest.candidate.dirty === false, `dirty=${manifest.candidate.dirty}`);
  add(checks, 'environment.eval', manifest.environment.runtimeProfile === 'eval', String(manifest.environment.runtimeProfile));
  add(checks, 'artifact.database', sha256(readFileSync(database)) === manifest.artifacts.database, 'database SHA-256');
  add(checks, 'artifact.vault', treeHash(vault) === manifest.artifacts.vaultTree, 'vault tree SHA-256');
  add(checks, 'artifact.results', sha256(readFileSync(resultsFile)) === manifest.artifacts.results, 'results SHA-256');
  add(checks, 'scan.full', results.scans.full.changedCount === expected.documentCount && results.scans.full.unchangedCount === 0, JSON.stringify(results.scans.full));
  add(checks, 'scan.unchanged', results.scans.unchanged.changedCount === 0 && results.scans.unchanged.unchangedCount === expected.documentCount, JSON.stringify(results.scans.unchanged));
  add(checks, 'scan.delta', results.scans.delta.changedCount === expected.editedCount && results.scans.delta.unchangedCount === expected.documentCount - expected.editedCount, JSON.stringify(results.scans.delta));
  add(checks, 'scan.assessment', results.scans.assessment.changedCount === 0 && results.scans.assessment.unchangedCount === expected.documentCount, JSON.stringify(results.scans.assessment));
  add(checks, 'assessment.passed', results.assessment.status === 'passed' && results.assessment.blockers.length === 0, JSON.stringify(results.assessment));
  add(checks, 'safety.operational', results.operationalDatabaseModified === false, `modified=${results.operationalDatabaseModified}`);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const actual = {
      documents: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_document').get() as Row).count),
      revisions: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_markdown_revision').get() as Row).count),
      scans: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_markdown_scan').get() as Row).count),
      scaleRuns: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_scale_run').get() as Row).count),
    };
    add(checks, 'database.counts', actual.documents === expected.documentCount && actual.revisions === expected.revisionCount && actual.scans === expected.scanCount && actual.scaleRuns === 1, JSON.stringify(actual));
    const latest = db.prepare('SELECT * FROM wiki_scale_run ORDER BY created_at DESC LIMIT 1').get() as Row;
    add(checks, 'database.scale_run', latest.status === 'passed' && latest.document_count === expected.documentCount && latest.unchanged_document_count === expected.documentCount, JSON.stringify({ status: latest.status, documents: latest.document_count, unchanged: latest.unchanged_document_count }));
  } finally { db.close(); }
  const passed = checks.filter((item) => item.passed).length;
  const report = { schema: 'wiki-scale-eval-grade-v1', runId: manifest.runId, gradedAt: new Date().toISOString(), passed: passed === checks.length, score: { passed, total: checks.length }, checks };
  writeFileSync(cli.report, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
