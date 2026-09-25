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
import { bindAnalysis } from '../lib/analysis';
import { scanWikiMarkdownVault } from '../lib/wiki-markdown';
import {
  ingestWikiMarkdownProposal,
  prepareWikiMarkdownProposal,
  reconcileWikiMarkdownProposal,
  reviewWikiMarkdownProposal,
  wikiMarkdownProposalDetail,
  wikiMarkdownProposalPacket,
  type WikiProposalInput,
} from '../lib/wiki-proposal';
import { wikiReviewIndex } from '../lib/wiki-review';
import { databasePath, withDatabase } from '../lib/work-db';

type CliOptions = { dataset: string; runRoot: string; runId: string };
type DatasetManifest = {
  schema: string;
  id: string;
  inputRoot: string;
  seed: string;
  scenarios: string;
};
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
  eventId: string;
  entryId: string;
  fact: string;
};
type Scenario = {
  id: string;
  docId: string;
  relativePath: string;
  entityId: string;
  eventId: string;
  editedBody: string;
  proposedBody: string;
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
      else if (info.isFile()) entries.push(`${path.relative(root, target).split(path.sep).join('/')}\0${sha256(readFileSync(target))}`);
      else fail(`지원하지 않는 평가 입력입니다: ${target}`);
    }
  };
  visit(root);
  return sha256(entries.join('\n'));
}

function copyTree(source: string, destination: string) {
  const sourceInfo = lstatSync(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) fail(`평가 입력 루트가 실제 디렉터리가 아닙니다: ${source}`);
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
  if (seed.schema !== 'wiki-vertical-eval-seed-v1' || !Array.isArray(seed.matters)) fail('지원하지 않는 수직 평가 seed입니다.');
  const timestamp = new Date().toISOString();
  withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const matterInsert = db.prepare(`
        INSERT INTO matter(
          id,our_ref,office,matter_kind,country_code,base_ref,parent_ref,relation_type,suffixes_json,
          source_type,source_id,confidence,user_confirmed,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'user_input','wiki-vertical-eval-seed',1,1,?,?)
      `);
      const eventInsert = db.prepare(`
        INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at)
        VALUES (?,'matter',?,'wiki.synthetic_fact',?,'장진태','user_input',?)
      `);
      const entryInsert = db.prepare(`
        INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,created_at)
        VALUES (?,'matter',?,'2026-09-25','user_date',?,'user_input',?,?)
      `);
      for (const matter of seed.matters) {
        matterInsert.run(
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
        eventInsert.run(matter.eventId, matter.id, JSON.stringify({ fact: matter.fact }), timestamp);
        entryInsert.run(matter.entryId, matter.id, matter.fact, matter.eventId, timestamp);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

function renderWithBody(original: string, body: string) {
  const normalized = original.replace(/\r\n?/g, '\n');
  const frontmatterEnd = normalized.indexOf('\n---\n', 4);
  if (!normalized.startsWith('---\n') || frontmatterEnd < 0) fail('평가 Markdown frontmatter를 읽을 수 없습니다.');
  const header = normalized.slice(0, frontmatterEnd + 5);
  const heading = normalized.slice(frontmatterEnd + 5).match(/^# .+$/m)?.[0] ?? '# Wiki';
  return `${header}\n${heading}\n\n${body}\n`;
}

async function main() {
  const cli = options(process.argv.slice(2));
  if (existsSync(cli.runRoot)) fail(`새 실행마다 존재하지 않는 --run-root를 사용해야 합니다: ${cli.runRoot}`);
  const datasetFile = path.join(cli.dataset, 'dataset.json');
  const dataset = readJson<DatasetManifest>(datasetFile);
  if (dataset.schema !== 'wiki-vertical-eval-dataset-v1') fail(`지원하지 않는 데이터셋 계약입니다: ${dataset.schema}`);
  const inputRoot = path.resolve(cli.dataset, dataset.inputRoot);
  const seedFile = path.resolve(cli.dataset, dataset.seed);
  const scenarioFile = path.resolve(cli.dataset, dataset.scenarios);
  for (const file of [inputRoot, seedFile, scenarioFile]) {
    if (!inside(cli.dataset, file) || !existsSync(file)) fail('데이터셋 파일은 데이터셋 루트 안에 있어야 합니다.');
  }
  const scenarioSet = readJson<{ schema: string; scenarios: Scenario[] }>(scenarioFile);
  if (scenarioSet.schema !== 'wiki-vertical-eval-scenarios-v1' || scenarioSet.scenarios.length < 3 || scenarioSet.scenarios.length > 5) {
    fail('수직 평가 시나리오는 3~5개여야 합니다.');
  }

  const workRoot = path.join(cli.runRoot, 'work');
  const outputRoot = path.join(cli.runRoot, 'output');
  mkdirSync(outputRoot, { recursive: true });
  copyTree(inputRoot, workRoot);
  const vaultPath = path.join(workRoot, 'vault');
  const dbPath = path.join(workRoot, 'db', 'work.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sourceRoot = path.resolve(process.cwd(), '..');

  process.env.SSPAT_RUNTIME_PROFILE = 'eval';
  process.env.SSPAT_ISOLATED_ROOT = workRoot;
  process.env.SSPAT_WORK_DB_PATH = dbPath;
  process.env.SSPAT_WIKI_VAULT_PATH = vaultPath;
  process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(workRoot, 'notice-projects');
  process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(workRoot, 'spec-projects');
  process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(workRoot, 'provisional-projects');
  process.env.SSPAT_PROJECT_ROOT = sourceRoot;

  const trace: Array<{ scenarioId?: string; step: string; status: 'succeeded'; detail: string }> = [
    { step: 'copy_input', status: 'succeeded', detail: '합성 입력을 격리 작업 루트로 복사했습니다.' },
  ];
  seedDatabase(seedFile);
  trace.push({ step: 'seed_database', status: 'succeeded', detail: '합성 DB seed와 근거 이벤트를 적용했습니다.' });

  const results: Row[] = [];
  for (const scenario of scenarioSet.scenarios) {
    const file = path.resolve(vaultPath, ...scenario.relativePath.split('/'));
    if (!inside(vaultPath, file) || !existsSync(file)) fail(`시나리오 파일이 Vault 안에 없습니다: ${scenario.relativePath}`);
    const original = readFileSync(file, 'utf8');
    const humanEdited = renderWithBody(original, scenario.editedBody);
    writeFileSync(file, humanEdited, 'utf8');
    trace.push({ scenarioId: scenario.id, step: 'human_edit', status: 'succeeded', detail: scenario.relativePath });

    const scanBeforeProposal = await scanWikiMarkdownVault();
    trace.push({ scenarioId: scenario.id, step: 'scan_after_edit', status: 'succeeded', detail: scanBeforeProposal.scanId });
    const prepared = await prepareWikiMarkdownProposal(scenario.docId);
    bindAnalysis(prepared.runId, {
      agentId: `fixture-${scenario.id}`,
      model: prepared.route.model,
      effort: prepared.route.effort,
    });
    const packet: any = wikiMarkdownProposalPacket(prepared.runId);
    const proposedMarkdown = renderWithBody(humanEdited, scenario.proposedBody);
    const input: WikiProposalInput = {
      schemaVersion: 1,
      runId: prepared.runId,
      docId: scenario.docId,
      baseByteHash: packet.context.wikiMarkdown.baseByteHash,
      evidenceSnapshotHash: packet.context.wikiMarkdown.evidenceSnapshotHash,
      changeSummary: `${scenario.id} 합성 근거 반영 제안`,
      proposedMarkdown,
      evidence: [{
        blockId: `${scenario.id}-fact`,
        sentence: scenario.proposedBody,
        references: [{ kind: 'event', id: scenario.eventId }],
      }],
    };
    const beforeProposalHash = sha256(readFileSync(file));
    const ingested: any = await ingestWikiMarkdownProposal(input);
    const afterProposalHash = sha256(readFileSync(file));
    if (beforeProposalHash !== afterProposalHash) fail(`${scenario.id}: 제안 생성이 활성 Markdown을 변경했습니다.`);
    trace.push({ scenarioId: scenario.id, step: 'proposal', status: 'succeeded', detail: ingested.proposal.id });

    const detail: any = wikiMarkdownProposalDetail(ingested.proposal.id);
    const review: any = await reviewWikiMarkdownProposal(
      ingested.proposal.id,
      'accept_for_manual_apply',
      detail.proposal.row_version,
    );
    const afterReviewHash = sha256(readFileSync(file));
    if (beforeProposalHash !== afterReviewHash || review.automaticApply !== false) {
      fail(`${scenario.id}: 검토 기록이 활성 Markdown을 자동 변경했습니다.`);
    }
    trace.push({ scenarioId: scenario.id, step: 'human_review', status: 'succeeded', detail: review.eventId });

    writeFileSync(file, proposedMarkdown.replace(/\r\n?/g, '\n'), 'utf8');
    const scanAfterApply = await scanWikiMarkdownVault();
    const reconciled: any = await reconcileWikiMarkdownProposal(ingested.proposal.id);
    if (reconciled.status !== 'applied_observed') fail(`${scenario.id}: 수동 반영을 관측하지 못했습니다.`);
    trace.push({ scenarioId: scenario.id, step: 'manual_apply_and_rescan', status: 'succeeded', detail: scanAfterApply.scanId });

    results.push({
      scenarioId: scenario.id,
      docId: scenario.docId,
      proposalId: ingested.proposal.id,
      reviewEventId: review.eventId,
      automaticApply: review.automaticApply,
      activeUnchangedBeforeManual: beforeProposalHash === afterProposalHash && beforeProposalHash === afterReviewHash,
      manualApplied: true,
      proposalStatus: reconciled.status,
      finalByteHash: sha256(readFileSync(file)),
      targetByteHash: ingested.proposal.target_byte_hash,
    });
  }

  const reviewIndex: any = await wikiReviewIndex();
  for (const result of results) {
    result.finalReviewStatus = reviewIndex.documents.find((item: any) => item.docId === result.docId)?.status ?? null;
  }
  const resultsFile = path.join(outputRoot, 'vertical-results.json');
  const reviewIndexFile = path.join(outputRoot, 'wiki-review-index.json');
  writeFrozenJson(resultsFile, { schema: 'wiki-vertical-eval-results-v1', results, trace });
  writeFrozenJson(reviewIndexFile, reviewIndex);
  withDatabase((db) => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'));

  const manifest = {
    schema: 'wiki-vertical-eval-run-v1',
    runId: cli.runId,
    createdAt: new Date().toISOString(),
    candidate: gitState(sourceRoot),
    dataset: {
      id: dataset.id,
      manifestSha256: sha256(readFileSync(datasetFile)),
      seedSha256: sha256(readFileSync(seedFile)),
      scenariosSha256: sha256(readFileSync(scenarioFile)),
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
      verticalResults: sha256(readFileSync(resultsFile)),
      wikiReviewIndex: sha256(readFileSync(reviewIndexFile)),
    },
    targetCount: results.length,
    trace,
  };
  writeFrozenJson(path.join(cli.runRoot, 'run-manifest.json'), manifest);
  process.stdout.write(`${JSON.stringify({ runRoot: cli.runRoot, manifest, results }, null, 2)}\n`);
}

type Row = Record<string, any>;

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
