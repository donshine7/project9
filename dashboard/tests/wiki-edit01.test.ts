import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindAnalysis } from '../lib/analysis';
import { approveWikiAutoApply, executeWikiAutoApply, recoverWikiAutoApply, wikiAutoApplyStatus } from '../lib/wiki-auto-apply';
import { scanWikiMarkdownVault } from '../lib/wiki-markdown';
import {
  ingestWikiMarkdownProposal,
  prepareWikiMarkdownProposal,
  reviewWikiMarkdownProposal,
  wikiMarkdownProposalDetail,
  wikiMarkdownProposalPacket,
  type WikiProposalInput,
} from '../lib/wiki-proposal';
import { withDatabase } from '../lib/work-db';

const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-edit01-'));
const vault = path.join(root, 'vault');
const matters = path.join(vault, '10_Matters');
const database = path.join(root, 'db', 'work.db');
const projectRoot = path.resolve(__dirname, '..', '..', 'dashboard', '..');
const matterId = 'edit01-matter-001';
const docId = 'wiki-edit01-matter-001';
const eventId = 'edit01-event-001';
const matterFile = path.join(matters, 'P260701-KR.md');

process.env.SSPAT_RUNTIME_PROFILE = 'test';
process.env.SSPAT_ISOLATED_ROOT = root;
process.env.SSPAT_WORK_DB_PATH = database;
process.env.SSPAT_WIKI_VAULT_PATH = vault;
process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(root, 'notice');
process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(root, 'spec');
process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(root, 'provisional');
process.env.SSPAT_PROJECT_ROOT = projectRoot;
process.chdir(path.join(projectRoot, 'dashboard'));

function markdown(body: string) {
  return `---\nschema_version: wiki-md-v1\ndoc_id: ${docId}\ndocument_type: entity_wiki\nentity_type: matter\nentity_id: ${matterId}\ntitle: P260701-KR EDIT-01 합성 사건\ntags: [eval, edit01]\n---\n# P260701-KR\n\n${body}\n`;
}

async function reviewedProposal(body: string) {
  const prepared = await prepareWikiMarkdownProposal(docId);
  bindAnalysis(prepared.runId, { agentId: `fixture-${prepared.runId}`, model: prepared.route.model, effort: prepared.route.effort });
  const packet: any = wikiMarkdownProposalPacket(prepared.runId);
  const input: WikiProposalInput = {
    schemaVersion: 1,
    runId: prepared.runId,
    docId,
    baseByteHash: packet.context.wikiMarkdown.baseByteHash,
    evidenceSnapshotHash: packet.context.wikiMarkdown.evidenceSnapshotHash,
    changeSummary: 'EDIT-01 합성 자동 반영 제안',
    proposedMarkdown: markdown(body),
    evidence: [{ blockId: `edit01-${prepared.runId.slice(0, 8)}`, sentence: body, references: [{ kind: 'event', id: eventId }] }],
  };
  const ingested: any = await ingestWikiMarkdownProposal(input);
  const before: any = wikiMarkdownProposalDetail(ingested.proposal.id);
  await reviewWikiMarkdownProposal(ingested.proposal.id, 'accept_for_manual_apply', before.proposal.row_version);
  const reviewed: any = wikiMarkdownProposalDetail(ingested.proposal.id);
  return { id: ingested.proposal.id, input, detail: reviewed };
}

async function main() {
  try {
    mkdirSync(matters, { recursive: true });
    withDatabase((db) => {
      const timestamp = '2026-09-26T00:00:00.000Z';
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES (?,'P260701-KR','상상특허','patent','KR','P260701','["KR"]','user_input',1,1,?,?)`).run(matterId, timestamp, timestamp);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES (?,'matter',?,'wiki.synthetic_fact','{"fact":"EDIT-01 근거"}','장진태','user_input',?)`).run(eventId, matterId, timestamp);
      db.prepare(`INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,created_at) VALUES ('edit01-entry-001','matter',?,'2026-09-26','user_date','EDIT-01 근거','user_input',?,?)`).run(matterId, eventId, timestamp);
    });
    writeFileSync(matterFile, markdown('초기 사람 본문입니다.'), 'utf8');
    await scanWikiMarkdownVault();

    const racing = await reviewedProposal('경쟁 상황에서 적용하면 안 되는 AI 제안입니다.');
    await approveWikiAutoApply(racing.id, racing.detail.proposal.row_version);
    await assert.rejects(
      () => executeWikiAutoApply(racing.id, {
        confirmation: 'APPLY',
        beforeReplace: () => writeFileSync(matterFile, markdown('동시에 저장된 사람 편집입니다.'), 'utf8'),
      }),
      (error: any) => error?.code === 'WIKI_AUTO_APPLY_BASE_CONFLICT',
    );
    assert.match(readFileSync(matterFile, 'utf8'), /동시에 저장된 사람 편집/);
    await scanWikiMarkdownVault();

    const recoverable = await reviewedProposal('중단 후 복구되는 승인된 AI 제안입니다.');
    await assert.rejects(() => executeWikiAutoApply(recoverable.id, { confirmation: 'APPLY' }), (error: any) => error?.code === 'WIKI_AUTO_APPLY_APPROVAL_REQUIRED');
    const approval: any = await approveWikiAutoApply(recoverable.id, recoverable.detail.proposal.row_version);
    await assert.rejects(
      () => executeWikiAutoApply(recoverable.id, { confirmation: 'APPLY', faultAfterFileApplied: true }),
      (error: any) => error?.code === 'WIKI_AUTO_APPLY_TEST_FAULT',
    );
    assert.match(readFileSync(matterFile, 'utf8'), /중단 후 복구되는 승인된 AI 제안/);
    const operationId = withDatabase((db) => (db.prepare('SELECT id FROM wiki_apply_operation WHERE proposal_id=?').get(recoverable.id) as any).id);
    assert.equal(wikiAutoApplyStatus(operationId).operation.status, 'file_applied');
    const recovered: any = await recoverWikiAutoApply(operationId);
    assert.equal(recovered.operation.status, 'succeeded');
    const status: any = wikiAutoApplyStatus(operationId);
    assert.equal(status.proposal.status, 'applied_observed');
    assert.equal(status.approval.id, approval.approval.id);
    assert.equal(JSON.parse(status.event.after_json).automaticApply, true);
    assert.equal(withDatabase((db) => (db.prepare('SELECT origin FROM wiki_markdown_revision WHERE id=?').get(status.operation.applied_revision_id) as any).origin), 'ai_applied');
    assert.equal((await executeWikiAutoApply(recoverable.id, { confirmation: 'APPLY' }) as any).duplicate, true);

    process.env.SSPAT_RUNTIME_PROFILE = 'operational';
    await assert.rejects(() => executeWikiAutoApply(recoverable.id, { confirmation: 'APPLY' }), (error: any) => error?.code === 'WIKI_AUTO_APPLY_OPERATIONAL_BLOCKED');
    process.env.SSPAT_RUNTIME_PROFILE = 'test';

    console.log('EDIT-01 separate approval, concurrent human edit preservation, crash recovery and idempotency tests passed.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
