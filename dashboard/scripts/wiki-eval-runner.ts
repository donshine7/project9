import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { databasePath, withDatabase } from '../lib/work-db';
import { scanWikiMarkdownVault, wikiMarkdownIndex, wikiMarkdownScanIssues } from '../lib/wiki-markdown';

type CliOptions = { dataset: string; runRoot: string; runId: string };
type DatasetManifest = { schema: string; id: string; inputRoot: string; seed: string };
type MatterSeed = {
  id: string;
  ourRef: string;
  office: string;
  matterKind: string;
  countryCode: string | null;
  baseRef: string;
  parentRef: string | null;
  relationType: string | null;
  suffixes: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

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

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
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
      if (info.isSymbolicLink()) fail(`평가 입력에 심볼릭 링크를 둘 수 없습니다: ${target}`);
      if (info.isDirectory()) visit(target);
      else if (info.isFile()) {
        const relative = path.relative(root, target).split(path.sep).join('/');
        entries.push(`${relative}\0${sha256(readFileSync(target))}`);
      } else fail(`지원하지 않는 평가 입력입니다: ${target}`);
    }
  };
  visit(root);
  return sha256(entries.join('\n'));
}

function copyTree(source: string, destination: string) {
  const sourceInfo = lstatSync(source);
  if (sourceInfo.isSymbolicLink()) fail(`평가 입력의 심볼릭 링크를 복사하지 않습니다: ${source}`);
  if (!sourceInfo.isDirectory()) fail(`평가 입력 루트가 디렉터리가 아닙니다: ${source}`);
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source).sort((left, right) => left.localeCompare(right))) {
    const sourceItem = path.join(source, name);
    const destinationItem = path.join(destination, name);
    const info = lstatSync(sourceItem);
    if (info.isSymbolicLink()) fail(`평가 입력의 심볼릭 링크를 복사하지 않습니다: ${sourceItem}`);
    if (info.isDirectory()) copyTree(sourceItem, destinationItem);
    else if (info.isFile()) writeFileSync(destinationItem, readFileSync(sourceItem), { flag: 'wx' });
    else fail(`지원하지 않는 평가 입력입니다: ${sourceItem}`);
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeFrozenJson(file: string, value: unknown) {
  if (existsSync(file)) fail(`고정 산출물을 덮어쓸 수 없습니다: ${file}`);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
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

function seedDatabase(seedFile: string) {
  const seed = readJson<{ schema: string; matters: MatterSeed[] }>(seedFile);
  if (seed.schema !== 'wiki-eval-seed-v1' || !Array.isArray(seed.matters)) fail('지원하지 않는 평가 seed입니다.');
  const timestamp = new Date().toISOString();
  withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare(`
        INSERT INTO matter(
          id,our_ref,office,matter_kind,country_code,base_ref,parent_ref,relation_type,suffixes_json,
          source_type,source_id,confidence,user_confirmed,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'user_input','wiki-eval-seed',1,1,?,?)
      `);
      for (const matter of seed.matters) {
        insert.run(
          matter.id,
          matter.ourRef,
          matter.office,
          matter.matterKind,
          matter.countryCode,
          matter.baseRef,
          matter.parentRef,
          matter.relationType,
          JSON.stringify(matter.suffixes),
          timestamp,
          timestamp,
        );
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
  const datasetFile = path.join(cli.dataset, 'dataset.json');
  if (!existsSync(datasetFile)) fail(`dataset.json이 없습니다: ${datasetFile}`);
  const dataset = readJson<DatasetManifest>(datasetFile);
  if (dataset.schema !== 'wiki-eval-dataset-v1') fail(`지원하지 않는 데이터셋 계약입니다: ${dataset.schema}`);

  const inputRoot = path.resolve(cli.dataset, dataset.inputRoot);
  const seedFile = path.resolve(cli.dataset, dataset.seed);
  if (!inside(cli.dataset, inputRoot) || !inside(cli.dataset, seedFile)) fail('데이터셋 입력과 seed는 데이터셋 루트 안에 있어야 합니다.');
  if (!existsSync(inputRoot) || !existsSync(seedFile)) fail('데이터셋 입력 또는 seed가 없습니다.');
  const seedInfo = lstatSync(seedFile);
  if (!seedInfo.isFile() || seedInfo.isSymbolicLink()) fail('seed는 데이터셋 안의 실제 파일이어야 합니다.');

  const workRoot = path.join(cli.runRoot, 'work');
  const outputRoot = path.join(cli.runRoot, 'output');
  mkdirSync(outputRoot, { recursive: true });
  copyTree(inputRoot, workRoot);
  const vaultPath = path.join(workRoot, 'vault');
  const dbPath = path.join(workRoot, 'db', 'work.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.SSPAT_RUNTIME_PROFILE = 'eval';
  process.env.SSPAT_ISOLATED_ROOT = workRoot;
  process.env.SSPAT_WORK_DB_PATH = dbPath;
  process.env.SSPAT_WIKI_VAULT_PATH = vaultPath;
  process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(workRoot, 'notice-projects');
  process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(workRoot, 'spec-projects');
  process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(workRoot, 'provisional-projects');

  const trace: Array<{ step: string; status: 'succeeded'; detail: string }> = [
    { step: 'copy_input', status: 'succeeded', detail: '합성 입력을 격리 작업 루트로 복사했습니다.' },
  ];
  seedDatabase(seedFile);
  trace.push({ step: 'seed_database', status: 'succeeded', detail: '합성 DB seed를 적용했습니다.' });
  const scan = await scanWikiMarkdownVault();
  trace.push({ step: 'scan_wiki_markdown', status: 'succeeded', detail: `scan=${scan.scanId}` });

  const index = wikiMarkdownIndex();
  const issues = wikiMarkdownScanIssues(scan.scanId);
  const indexFile = path.join(outputRoot, 'wiki-index.json');
  const issuesFile = path.join(outputRoot, 'wiki-issues.json');
  writeFrozenJson(indexFile, index);
  writeFrozenJson(issuesFile, issues);
  withDatabase((db) => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'));
  trace.push({ step: 'freeze_outputs', status: 'succeeded', detail: '인덱스와 이슈를 불변 실행 폴더에 고정했습니다.' });

  const sourceRoot = path.resolve(process.cwd(), '..');
  const manifest = {
    schema: 'wiki-eval-run-v1',
    runId: cli.runId,
    createdAt: new Date().toISOString(),
    candidate: gitState(sourceRoot),
    dataset: {
      id: dataset.id,
      manifestSha256: sha256(readFileSync(datasetFile)),
      seedSha256: sha256(readFileSync(seedFile)),
      inputTreeSha256: treeHash(inputRoot),
    },
    environment: {
      runtimeProfile: 'eval',
      isolatedRoot: workRoot,
      databasePath: databasePath(),
      vaultPath,
      exposedPaths: [cli.dataset, workRoot],
    },
    artifacts: {
      database: sha256(readFileSync(dbPath)),
      vaultTree: treeHash(vaultPath),
      wikiIndex: sha256(readFileSync(indexFile)),
      wikiIssues: sha256(readFileSync(issuesFile)),
    },
    trace,
  };
  writeFrozenJson(path.join(cli.runRoot, 'run-manifest.json'), manifest);
  process.stdout.write(`${JSON.stringify({ runRoot: cli.runRoot, scan, manifest }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
