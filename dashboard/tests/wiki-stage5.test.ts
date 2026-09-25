import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
import { deriveWikiReviewStatus, wikiReviewDocument, wikiReviewIndex } from '../lib/wiki-review';
import { withDatabase } from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-stage5-'));
const vaultRoot = path.join(temporaryRoot, 'vault');
const matterDirectory = path.join(vaultRoot, '10_Matters');
const databaseFile = path.join(temporaryRoot, 'db', 'work.db');
const projectRoot = path.resolve(__dirname, '..', '..', 'dashboard', '..');
const matterId = 'stage5-matter-001';
const docId = 'wiki-stage5-matter-001';
const eventId = 'stage5-event-001';
const matterFile = path.join(matterDirectory, 'P260501-KR.md');

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
title: P260501-KR 합성 사건
tags: [eval, stage5]
---
# P260501-KR

${body}
`;
}

function proposalInput(runId: string, body: string): WikiProposalInput {
  const packet: any = wikiMarkdownProposalPacket(runId);
  return {
    schemaVersion: 1,
    runId,
    docId,
    baseByteHash: packet.context.wikiMarkdown.baseByteHash,
    evidenceSnapshotHash: packet.context.wikiMarkdown.evidenceSnapshotHash,
    changeSummary: 'Stage 5 수직 흐름 합성 제안',
    proposedMarkdown: markdown(body),
    evidence: [{
      blockId: 'stage5-fact-001',
      sentence: body,
      references: [{ kind: 'event', id: eventId }],
    }],
  };
}

async function main() {
  try {
    assert.equal(deriveWikiReviewStatus({ latestScanStatus: 'running' }), 'indexing');
    assert.equal(deriveWikiReviewStatus({ parseStatus: 'missing' }), 'missing');
    assert.equal(deriveWikiReviewStatus({ parseStatus: 'duplicate' }), 'duplicate_id');
    assert.equal(deriveWikiReviewStatus({ parseStatus: 'binding_conflict' }), 'conflict');
    assert.equal(deriveWikiReviewStatus({ parseStatus: 'valid', proposalStatus: 'stale_evidence' }), 'evidence_stale');
    assert.equal(deriveWikiReviewStatus({
      parseStatus: 'valid',
      proposalStatus: 'reviewed',
      currentByteHash: 'base',
      reviewedBaseByteHash: 'base',
    }), 'reviewed');
    assert.equal(deriveWikiReviewStatus({
      parseStatus: 'valid',
      proposalStatus: 'applied_observed',
      currentByteHash: 'target',
      targetByteHash: 'target',
    }), 'up_to_date');

    mkdirSync(matterDirectory, { recursive: true });
    withDatabase((db) => {
      const timestamp = '2026-09-25T00:00:00.000Z';
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES (?,'P260501-KR','상상특허','patent','KR','P260501','["KR"]','user_input',1,1,?,?)`)
        .run(matterId, timestamp, timestamp);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES (?,'matter',?,'wiki.synthetic_fact','{"fact":"합성 근거"}','장진태','user_input',?)`)
        .run(eventId, matterId, timestamp);
      db.prepare(`INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,created_at) VALUES ('stage5-entry-001','matter',?,'2026-09-25','user_date','Stage 5 합성 근거','user_input',?,?)`)
        .run(matterId, eventId, timestamp);
    });
    writeFileSync(matterFile, markdown('활성 Markdown 최초 본문입니다.'), 'utf8');
    await scanWikiMarkdownVault();

    const initial: any = await wikiReviewIndex();
    assert.equal(initial.documents.find((item: any) => item.docId === docId).status, 'needs_review');

    const prepared = await prepareWikiMarkdownProposal(docId);
    bindAnalysis(prepared.runId, {
      agentId: 'fixture-stage5',
      model: prepared.route.model,
      effort: prepared.route.effort,
    });
    const input = proposalInput(prepared.runId, '검토 후 사람이 반영할 합성 제안입니다.');
    const activeBefore = readFileSync(matterFile, 'utf8');
    const ingested: any = await ingestWikiMarkdownProposal(input);
    assert.equal(readFileSync(matterFile, 'utf8'), activeBefore, '제안 생성이 활성 Markdown을 수정하면 안 된다.');

    const pending: any = await wikiReviewDocument(docId);
    assert.equal(pending.item.status, 'needs_review');
    assert.equal(pending.proposal.id, ingested.proposal.id);
    assert.equal(pending.proposal.evidence.length, 1);
    assert.equal(pending.database.entity.our_ref, 'P260501-KR');

    const proposal: any = wikiMarkdownProposalDetail(ingested.proposal.id);
    await reviewWikiMarkdownProposal(ingested.proposal.id, 'accept_for_manual_apply', proposal.proposal.row_version);
    const reviewed: any = await wikiReviewIndex();
    assert.equal(reviewed.documents.find((item: any) => item.docId === docId).status, 'reviewed');
    assert.equal(readFileSync(matterFile, 'utf8'), activeBefore, '검토 기록도 활성 Markdown을 자동 수정하면 안 된다.');

    writeFileSync(matterFile, input.proposedMarkdown.replace(/\r\n?/g, '\n'), 'utf8');
    await scanWikiMarkdownVault();
    const reconciled = await reconcileWikiMarkdownProposal(ingested.proposal.id);
    assert.equal(reconciled.status, 'applied_observed');
    const applied: any = await wikiReviewIndex();
    assert.equal(applied.documents.find((item: any) => item.docId === docId).status, 'up_to_date');

    console.log('Stage 5 Wiki review status, UI data contract, review and manual-apply flow tests passed.');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
