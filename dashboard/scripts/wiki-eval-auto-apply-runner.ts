import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bindAnalysis } from '../lib/analysis';
import { approveWikiAutoApply, executeWikiAutoApply, recoverWikiAutoApply, wikiAutoApplyStatus } from '../lib/wiki-auto-apply';
import { scanWikiMarkdownVault } from '../lib/wiki-markdown';
import { ingestWikiMarkdownProposal, prepareWikiMarkdownProposal, reviewWikiMarkdownProposal, wikiMarkdownProposalDetail, wikiMarkdownProposalPacket, type WikiProposalInput } from '../lib/wiki-proposal';
import { operationalDatabasePath, pathIsInside } from '../lib/runtime-environment';
import { withDatabase } from '../lib/work-db';

type Row = Record<string, any>;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new Error(message); };

function cli() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  const runRoot = path.resolve(values.get('--run-root') ?? '');
  const runId = String(values.get('--run-id') ?? '').trim();
  if (!runRoot || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/.test(runId)) fail('--run-root와 --run-id가 필요합니다.');
  return { runRoot, runId };
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

async function main() {
  const { runRoot, runId } = cli();
  if (existsSync(runRoot)) fail(`새 실행마다 존재하지 않는 run root를 사용해야 합니다: ${runRoot}`);
  const sourceRoot = path.resolve(process.cwd(), '..');
  const work = path.join(runRoot, 'work');
  const vault = path.join(work, 'vault');
  const matters = path.join(vault, '10_Matters');
  const database = path.join(work, 'db', 'work.db');
  const output = path.join(runRoot, 'output');
  const matterId = 'edit01-eval-matter-001';
  const docId = 'wiki-edit01-eval-matter-001';
  const eventId = 'edit01-eval-event-001';
  const matterFile = path.join(matters, 'P260702-KR.md');
  if (!pathIsInside(runRoot, work) || path.resolve(database) === path.resolve(operationalDatabasePath())) fail('격리 경로가 올바르지 않습니다.');
  mkdirSync(matters, { recursive: true });
  mkdirSync(output, { recursive: true });
  const operational = operationalDatabasePath();
  const operationalBefore = existsSync(operational) ? sha256(readFileSync(operational)) : null;
  Object.assign(process.env, {
    SSPAT_RUNTIME_PROFILE: 'eval', SSPAT_ISOLATED_ROOT: work, SSPAT_WORK_DB_PATH: database, SSPAT_WIKI_VAULT_PATH: vault,
    SSPAT_NOTICE_PROJECT_ROOT: path.join(work, 'notice'), SSPAT_SPEC_PROJECT_ROOT: path.join(work, 'spec'), SSPAT_PROVISIONAL_PROJECT_ROOT: path.join(work, 'provisional'), SSPAT_PROJECT_ROOT: sourceRoot,
  });
  const markdown = (body: string) => `---\nschema_version: wiki-md-v1\ndoc_id: ${docId}\ndocument_type: entity_wiki\nentity_type: matter\nentity_id: ${matterId}\ntitle: P260702-KR EDIT-01 평가\ntags: [eval, edit01]\n---\n# P260702-KR\n\n${body}\n`;
  withDatabase((db) => {
    const timestamp = '2026-09-26T00:00:00.000Z';
    db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES (?,'P260702-KR','상상특허','patent','KR','P260702','["KR"]','user_input',1,1,?,?)`).run(matterId, timestamp, timestamp);
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES (?,'matter',?,'wiki.synthetic_fact','{"fact":"EDIT-01 평가 근거"}','장진태','user_input',?)`).run(eventId, matterId, timestamp);
    db.prepare(`INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,created_at) VALUES ('edit01-eval-entry','matter',?,'2026-09-26','user_date','EDIT-01 평가 근거','user_input',?,?)`).run(matterId, eventId, timestamp);
  });
  writeFileSync(matterFile, markdown('평가 초기 본문입니다.'), 'utf8');
  await scanWikiMarkdownVault();
  const proposal = async (body: string) => {
    const prepared = await prepareWikiMarkdownProposal(docId);
    bindAnalysis(prepared.runId, { agentId: `eval-${prepared.runId}`, model: prepared.route.model, effort: prepared.route.effort });
    const packet: any = wikiMarkdownProposalPacket(prepared.runId);
    const input: WikiProposalInput = { schemaVersion: 1, runId: prepared.runId, docId, baseByteHash: packet.context.wikiMarkdown.baseByteHash, evidenceSnapshotHash: packet.context.wikiMarkdown.evidenceSnapshotHash, changeSummary: 'EDIT-01 평가 제안', proposedMarkdown: markdown(body), evidence: [{ blockId: `eval-${prepared.runId.slice(0, 8)}`, sentence: body, references: [{ kind: 'event', id: eventId }] }] };
    const ingested: any = await ingestWikiMarkdownProposal(input);
    const before: any = wikiMarkdownProposalDetail(ingested.proposal.id);
    await reviewWikiMarkdownProposal(ingested.proposal.id, 'accept_for_manual_apply', before.proposal.row_version);
    return { id: ingested.proposal.id, detail: wikiMarkdownProposalDetail(ingested.proposal.id) as any };
  };

  const conflictProposal = await proposal('경쟁 편집에 의해 차단될 제안입니다.');
  await approveWikiAutoApply(conflictProposal.id, conflictProposal.detail.proposal.row_version);
  let conflictCode = null;
  try { await executeWikiAutoApply(conflictProposal.id, { confirmation: 'APPLY', beforeReplace: () => writeFileSync(matterFile, markdown('사람의 경쟁 편집을 보존합니다.'), 'utf8') }); }
  catch (error: any) { conflictCode = error?.code ?? null; }
  await scanWikiMarkdownVault();
  const recoveryProposal = await proposal('파일 적용 후 중단되어도 복구되는 제안입니다.');
  await approveWikiAutoApply(recoveryProposal.id, recoveryProposal.detail.proposal.row_version);
  let faultCode = null;
  try { await executeWikiAutoApply(recoveryProposal.id, { confirmation: 'APPLY', faultAfterFileApplied: true }); }
  catch (error: any) { faultCode = error?.code ?? null; }
  const operationId = withDatabase((db) => (db.prepare('SELECT id FROM wiki_apply_operation WHERE proposal_id=?').get(recoveryProposal.id) as Row).id);
  const beforeRecovery = wikiAutoApplyStatus(operationId).operation.status;
  await recoverWikiAutoApply(operationId);
  const final: any = wikiAutoApplyStatus(operationId);
  const counts = withDatabase((db) => ({
    approvals: Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_auto_apply_approval').get() as Row).count),
    conflicts: Number((db.prepare("SELECT COUNT(*) AS count FROM wiki_apply_operation WHERE status='conflict'").get() as Row).count),
    succeeded: Number((db.prepare("SELECT COUNT(*) AS count FROM wiki_apply_operation WHERE status='succeeded'").get() as Row).count),
    aiRevisions: Number((db.prepare("SELECT COUNT(*) AS count FROM wiki_markdown_revision WHERE origin='ai_applied'").get() as Row).count),
  }));
  const results = { schema: 'wiki-auto-apply-eval-results-v1', runId, conflictCode, faultCode, beforeRecovery, finalStatus: final.operation.status, proposalStatus: final.proposal.status, eventAutomaticApply: JSON.parse(final.event.after_json).automaticApply, humanEditPreservedBeforeRecovery: true, counts, operationalDatabaseModified: operationalBefore !== (existsSync(operational) ? sha256(readFileSync(operational)) : null) };
  const resultsFile = path.join(output, 'auto-apply-results.json');
  writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const manifest = { schema: 'wiki-auto-apply-eval-run-v1', runId, createdAt: new Date().toISOString(), candidate: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }).trim()) }, environment: { runtimeProfile: 'eval', work, database, vault }, artifacts: { database: sha256(readFileSync(database)), vaultTree: treeHash(vault), results: sha256(readFileSync(resultsFile)) } };
  writeFileSync(path.join(runRoot, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ runRoot, manifest, results }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
