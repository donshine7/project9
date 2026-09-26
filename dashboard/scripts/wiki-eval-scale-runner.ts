import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assessWikiScaleReadiness } from '../lib/wiki-scale';
import { scanWikiMarkdownVault } from '../lib/wiki-markdown';
import { operationalDatabasePath, pathIsInside } from '../lib/runtime-environment';
import { withDatabase } from '../lib/work-db';

type Options = { runRoot: string; runId: string };
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new Error(message); };

function options(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  const runRoot = path.resolve(values.get('--run-root') ?? '');
  const runId = String(values.get('--run-id') ?? '').trim();
  if (!runRoot || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/.test(runId)) fail('--run-root와 --run-id가 필요합니다.');
  return { runRoot, runId };
}

function markdown(index: number, version: number) {
  return `---\nschema_version: wiki-md-v1\ndoc_id: wiki-scale-${String(index).padStart(3, '0')}\ndocument_type: note\nentity_type: null\nentity_id: null\ntitle: Scale ${index}\ntags: [scale, eval]\n---\n# Scale ${index}\n\nversion ${version}\n`;
}

function treeHash(root: string) {
  const entries: Array<[string, string, number]> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) fail(`symlink를 허용하지 않습니다: ${target}`);
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) {
        const bytes = readFileSync(target);
        entries.push([path.relative(root, target).split(path.sep).join('/'), sha256(bytes), bytes.length]);
      }
    }
  };
  visit(root);
  return sha256(JSON.stringify(entries));
}

function gitState(root: string) {
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  };
}

async function main() {
  const cli = options(process.argv.slice(2));
  if (existsSync(cli.runRoot)) fail(`새 실행마다 존재하지 않는 --run-root를 사용해야 합니다: ${cli.runRoot}`);
  const work = path.join(cli.runRoot, 'work');
  const vault = path.join(work, 'vault');
  const notes = path.join(vault, '60_Notes');
  const database = path.join(work, 'db', 'work.db');
  const output = path.join(cli.runRoot, 'output');
  const sourceRoot = path.resolve(process.cwd(), '..');
  mkdirSync(notes, { recursive: true });
  mkdirSync(output, { recursive: true });
  if (!pathIsInside(cli.runRoot, work) || path.resolve(database) === path.resolve(operationalDatabasePath())) fail('격리 실행 경로가 올바르지 않습니다.');

  const operational = operationalDatabasePath();
  const operationalBefore = existsSync(operational) ? sha256(readFileSync(operational)) : null;
  process.env.SSPAT_RUNTIME_PROFILE = 'eval';
  process.env.SSPAT_ISOLATED_ROOT = work;
  process.env.SSPAT_WORK_DB_PATH = database;
  process.env.SSPAT_WIKI_VAULT_PATH = vault;
  process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(work, 'notice');
  process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(work, 'spec');
  process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(work, 'provisional');
  process.env.SSPAT_PROJECT_ROOT = sourceRoot;

  for (let index = 1; index <= 40; index += 1) writeFileSync(path.join(notes, `scale-${String(index).padStart(3, '0')}.md`), markdown(index, 1), 'utf8');
  const full = await scanWikiMarkdownVault({ forceFull: true });
  const unchanged = await scanWikiMarkdownVault();
  for (let index = 1; index <= 5; index += 1) writeFileSync(path.join(notes, `scale-${String(index).padStart(3, '0')}.md`), markdown(index, 2), 'utf8');
  const delta = await scanWikiMarkdownVault();
  const assessment = await assessWikiScaleReadiness({ thresholds: { minDocuments: 40, maxElapsedMs: 30_000 } });
  const databaseCounts = withDatabase((db) => ({
    documents: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_document').get() as any).count),
    revisions: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_markdown_revision').get() as any).count),
    scans: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_markdown_scan').get() as any).count),
    scaleRuns: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_scale_run').get() as any).count),
  }));
  const operationalAfter = existsSync(operational) ? sha256(readFileSync(operational)) : null;
  const results = {
    schema: 'wiki-scale-eval-results-v1',
    runId: cli.runId,
    scans: { full, unchanged, delta, assessment: assessment.scan },
    assessment: { status: assessment.status, blockers: assessment.blockers },
    databaseCounts,
    operationalDatabaseModified: operationalBefore !== operationalAfter,
  };
  const resultsFile = path.join(output, 'scale-results.json');
  writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const manifest = {
    schema: 'wiki-scale-eval-run-v1',
    runId: cli.runId,
    createdAt: new Date().toISOString(),
    candidate: gitState(sourceRoot),
    environment: { runtimeProfile: 'eval', work, database, vault },
    artifacts: { database: sha256(readFileSync(database)), vaultTree: treeHash(vault), results: sha256(readFileSync(resultsFile)) },
  };
  writeFileSync(path.join(cli.runRoot, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ runRoot: cli.runRoot, manifest, results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
