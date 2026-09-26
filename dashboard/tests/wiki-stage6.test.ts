import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindAnalysis } from '../lib/analysis';
import { executeWikiCutover, rehearseWikiRecovery } from '../lib/wiki-cutover';
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
import { wikiReviewDocument } from '../lib/wiki-review';
import { ingestWiki, prepareWiki, reviewWiki, wikiDetail } from '../lib/wiki';
import { withDatabase } from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-stage6-'));
const vaultRoot = path.join(temporaryRoot, 'vault');
const matterDirectory = path.join(vaultRoot, '10_Matters');
const databaseFile = path.join(temporaryRoot, 'db', 'work.db');
const bundleRoot = path.join(temporaryRoot, 'cutover-bundles');
const restoreRoot = path.join(temporaryRoot, 'recovery-copy');
const projectRoot = path.resolve(__dirname, '..', '..', 'dashboard', '..');
const matterId = 'stage6-matter-001';
const docId = 'wiki-stage6-matter-001';
const eventId = 'stage6-event-001';
const matterFile = path.join(matterDirectory, 'P260601-KR.md');

process.env.SSPAT_RUNTIME_PROFILE = 'test';
process.env.SSPAT_ISOLATED_ROOT = temporaryRoot;
process.env.SSPAT_WORK_DB_PATH = databaseFile;
process.env.SSPAT_WIKI_VAULT_PATH = vaultRoot;
process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(temporaryRoot, 'notice-projects');
process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(temporaryRoot, 'spec-projects');
process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(temporaryRoot, 'provisional-projects');
process.env.SSPAT_PROJECT_ROOT = projectRoot;
process.chdir(path.join(projectRoot, 'dashboard'));

function markdown(body: string) {
  return `---
schema_version: wiki-md-v1
doc_id: ${docId}
document_type: entity_wiki
entity_type: matter
entity_id: ${matterId}
title: P260601-KR 합성 전환 사건
tags: [eval, stage6]
---
# P260601-KR

${body}
`;
}

function legacyResult(runId: string) {
  return {
    schemaVersion: 1,
    runId,
    changeSummary: 'Stage 6 전환 전 legacy 본문',
    sections: [{
      key: 'overview',
      title: '현재 요약',
      sentences: [{ text: '전환 전에 보존할 legacy DB 본문입니다.', entryDate: null, eventIds: [eventId] }],
    }],
  };
}

function proposalInput(runId: string, body: string): WikiProposalInput {
  const packet: any = wikiMarkdownProposalPacket(runId);
  return {
    schemaVersion: 1,
    runId,
    docId,
    baseByteHash: packet.context.wikiMarkdown.baseByteHash,
    evidenceSnapshotHash: packet.context.wikiMarkdown.evidenceSnapshotHash,
    changeSummary: 'Stage 6 원본 전환 승인 대상',
    proposedMarkdown: markdown(body),
    evidence: [{ blockId: 'stage6-fact-001', sentence: body, references: [{ kind: 'event', id: eventId }] }],
  };
}

async function main() {
  try {
    mkdirSync(matterDirectory, { recursive: true });
    withDatabase((db) => {
      const timestamp = '2026-09-25T00:00:00.000Z';
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES (?,'P260601-KR','상상특허','patent','KR','P260601','["KR"]','user_input',1,1,?,?)`)
        .run(matterId, timestamp, timestamp);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES (?,'matter',?,'wiki.synthetic_fact','{"fact":"합성 근거"}','장진태','user_input',?)`)
        .run(eventId, matterId, timestamp);
      db.prepare(`INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,created_at) VALUES ('stage6-entry-001','matter',?,'2026-09-25','user_date','Stage 6 합성 근거','user_input',?,?)`)
        .run(matterId, eventId, timestamp);
    });

    const legacyRun = prepareWiki('matter', matterId);
    bindAnalysis(legacyRun.runId, { agentId: 'fixture-stage6-legacy', model: legacyRun.route.model, effort: legacyRun.route.effort });
    ingestWiki(legacyResult(legacyRun.runId));
    reviewWiki(legacyRun.runId, 'publish', 1);

    writeFileSync(matterFile, markdown('전환 준비 전 Markdown 본문입니다.'), 'utf8');
    await scanWikiMarkdownVault();
    withDatabase((db) => db.prepare(`INSERT INTO wiki_document_source_mode(doc_id,source_mode,legacy_entity_type,legacy_entity_id,changed_at) VALUES (?,'legacy_db','matter',?,?)`)
      .run(docId, matterId, '2026-09-25T00:01:00.000Z'));

    const pendingLegacyRun = prepareWiki('matter', matterId);
    bindAnalysis(pendingLegacyRun.runId, { agentId: 'fixture-stage6-pending', model: pendingLegacyRun.route.model, effort: pendingLegacyRun.route.effort });

    const proposalRun = await prepareWikiMarkdownProposal(docId);
    bindAnalysis(proposalRun.runId, { agentId: 'fixture-stage6-proposal', model: proposalRun.route.model, effort: proposalRun.route.effort });
    const proposal = proposalInput(proposalRun.runId, '사람이 검토하고 수동 반영한 Markdown 원본입니다.');
    const ingested: any = await ingestWikiMarkdownProposal(proposal);
    const detail: any = wikiMarkdownProposalDetail(ingested.proposal.id);
    await reviewWikiMarkdownProposal(ingested.proposal.id, 'accept_for_manual_apply', detail.proposal.row_version);
    writeFileSync(matterFile, proposal.proposedMarkdown.replace(/\r\n?/g, '\n'), 'utf8');
    await scanWikiMarkdownVault();
    const reconciled: any = await reconcileWikiMarkdownProposal(ingested.proposal.id);
    assert.equal(reconciled.status, 'applied_observed');
    const approvedBytes = readFileSync(matterFile);
    const approvedHash = detail.proposal.target_byte_hash;

    withDatabase((db) => db.prepare('UPDATE event SET after_json=? WHERE id=?').run('{"fact":"변경된 합성 근거"}', eventId));
    await assert.rejects(
      () => executeWikiCutover({
        authorizationId: 'stage6-stale-evidence-001',
        reviewer: '장진태',
        confirmation: 'CUTOVER',
        bundleRoot,
        targets: [{ docId, expectedByteHash: approvedHash, proposalId: ingested.proposal.id }],
      }),
      (error: any) => error?.code === 'WIKI_CUTOVER_REVIEW_STALE',
    );
    withDatabase((db) => db.prepare('UPDATE event SET after_json=? WHERE id=?').run('{"fact":"합성 근거"}', eventId));

    const cutover: any = await executeWikiCutover({
      authorizationId: 'stage6-synthetic-authorization-001',
      reviewer: '장진태',
      confirmation: 'CUTOVER',
      bundleRoot,
      targets: [{ docId, expectedByteHash: approvedHash, proposalId: ingested.proposal.id }],
    });
    assert.equal(cutover.run.status, 'succeeded');
    assert.equal(cutover.items.length, 1);
    assert.equal(readFileSync(matterFile).equals(approvedBytes), true, '원본 전환은 활성 Markdown을 수정하면 안 된다.');
    assert.equal(existsSync(path.join(cutover.run.bundle_path, 'database-before.db')), true);
    assert.equal(existsSync(path.join(cutover.run.bundle_path, 'database-after.db')), true);
    assert.equal(existsSync(path.join(cutover.run.bundle_path, 'vault', '10_Matters', 'P260601-KR.md')), true);

    const switched: any = wikiDetail('matter', matterId);
    assert.equal(switched.sourceMode, 'markdown');
    assert.equal(switched.markdown.docId, docId);
    assert.equal(switched.previous, null, 'Markdown 원본에서 legacy previous를 활성 본문처럼 반환하면 안 된다.');
    assert.equal(switched.revisions.length, 0, 'legacy revision을 활성 본문으로 반환하면 안 된다.');
    assert.equal(switched.legacyRevisions.length, 1, 'legacy revision은 감사 이력으로 보존해야 한다.');
    assert.throws(() => prepareWiki('matter', matterId), (error: any) => error?.code === 'WIKI_LEGACY_WRITE_BLOCKED');
    assert.throws(() => ingestWiki(legacyResult(pendingLegacyRun.runId)), (error: any) => error?.code === 'WIKI_LEGACY_WRITE_BLOCKED');

    const recovery: any = rehearseWikiRecovery(cutover.run.id, restoreRoot);
    assert.equal(recovery.productionModified, false);
    assert.equal(recovery.verifiedDocumentCount, 1);
    assert.equal(existsSync(path.join(restoreRoot, 'recovery-report.json')), true);

    rmSync(matterFile);
    await scanWikiMarkdownVault();
    const missing: any = await wikiReviewDocument(docId);
    assert.equal(missing.item.status, 'missing');
    assert.equal(wikiDetail('matter', matterId).revisions.length, 0, 'Markdown 누락 시 legacy DB 본문으로 fallback하면 안 된다.');

    const priorProfile = process.env.SSPAT_RUNTIME_PROFILE;
    process.env.SSPAT_RUNTIME_PROFILE = 'operational';
    await assert.rejects(
      () => executeWikiCutover({ authorizationId: 'stage6-operational-block', reviewer: '장진태', confirmation: 'CUTOVER', bundleRoot, targets: [] }),
      (error: any) => error?.code === 'WIKI_CUTOVER_OPERATIONAL_BLOCKED',
    );
    process.env.SSPAT_RUNTIME_PROFILE = priorProfile;

    console.log('Stage 6 Wiki cutover, legacy-write blocking, missing-source fail-closed and DB+Vault recovery rehearsal tests passed.');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
