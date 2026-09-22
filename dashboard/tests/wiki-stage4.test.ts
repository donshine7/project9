import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindAnalysis } from '../lib/analysis';
import { runLegacyWikiMigrationDryRun } from '../lib/wiki-migration';
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
import { withDatabase } from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-stage4-'));
const vaultRoot = path.join(temporaryRoot, 'vault');
const matterDirectory = path.join(vaultRoot, '10_Matters');
const migrationParent = path.join(temporaryRoot, 'migration-runs');
const databaseFile = path.join(temporaryRoot, 'db', 'work.db');
const projectRoot = path.resolve(__dirname, '..', '..', 'dashboard', '..');

process.env.SSPAT_RUNTIME_PROFILE = 'test';
process.env.SSPAT_ISOLATED_ROOT = temporaryRoot;
process.env.SSPAT_WORK_DB_PATH = databaseFile;
process.env.SSPAT_WIKI_VAULT_PATH = vaultRoot;
process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(temporaryRoot, 'cases', 'notice');
process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(temporaryRoot, 'cases', 'specification');
process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(temporaryRoot, 'cases', 'provisional');
process.env.SSPAT_PROJECT_ROOT = projectRoot;
process.chdir(path.join(projectRoot, 'dashboard'));

const matterId = 'stage4-matter-001';
const docId = 'wiki-stage4-matter-001';
const eventId = 'stage4-event-001';
const matterFile = path.join(matterDirectory, 'P260401-KR.md');

function markdown(body: string, id = docId) {
  return `---\nschema_version: wiki-md-v1\ndoc_id: ${id}\ndocument_type: entity_wiki\nentity_type: matter\nentity_id: ${matterId}\ntitle: P260401-KR 합성 사건\ntags: [eval, stage4]\n---\n# P260401-KR\n\n${body}\n`;
}

function proposalInput(runId: string, body: string): WikiProposalInput {
  const packet: any = wikiMarkdownProposalPacket(runId);
  const frozen = packet.context.wikiMarkdown;
  return {
    schemaVersion: 1,
    runId,
    docId,
    baseByteHash: frozen.baseByteHash,
    evidenceSnapshotHash: frozen.evidenceSnapshotHash,
    changeSummary: '합성 근거에 따른 문장 개정 제안',
    proposedMarkdown: markdown(body),
    evidence: [{ blockId: 'stage4-fact-001', sentence: body, references: [{ kind: 'event', id: eventId }] }],
  };
}

function bind(run: { runId: string; route: { model: string; effort: string } }) {
  bindAnalysis(run.runId, { agentId: `fixture-${run.runId}`, model: run.route.model, effort: run.route.effort });
}

function seedLegacyWiki() {
  const sections = (text: string) => JSON.stringify([
    { key: 'overview', title: '현재 요약', sentences: [{ text, entryDate: null, eventIds: [eventId] }] },
    { key: 'timeline', title: '날짜별 중요내용', sentences: [{ text: `${text} 날짜 기록`, entryDate: '2026-09-22', eventIds: [eventId] }] },
  ]);
  withDatabase((db) => {
    const timestamp = '2026-09-22T01:00:00.000Z';
    for (const runId of ['legacy-run-001', 'legacy-run-002', 'legacy-draft-001']) {
      db.prepare(`INSERT INTO decision_run(id,operation,status,started_at) VALUES (?,'wiki_revision','succeeded',?)`).run(runId, timestamp);
    }
    for (const [version, runId] of [[1, 'legacy-run-001'], [2, 'legacy-run-002']] as const) {
      const publicationEvent = `legacy-publication-${version}`;
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES (?,'matter',?,'wiki.publish','{}','장진태','user_input',?)`)
        .run(publicationEvent, matterId, timestamp);
      db.prepare(`INSERT INTO entity_wiki_revision(id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at) VALUES (?,'matter',?,?,?,?,?,?,?,?)`)
        .run(`legacy-revision-${version}`, matterId, version, runId, sections(`게시 개정 ${version}`), `개정 ${version}`, `input-${version}`, publicationEvent, timestamp);
    }
    db.prepare(`INSERT INTO wiki_draft(run_id,entity_type,entity_id,base_version,sections_json,change_summary,review_status,created_at) VALUES (?,'matter',?,2,?,?,'pending',?)`)
      .run('legacy-draft-001', matterId, sections('미검토 초안'), '미검토 초안', timestamp);
  });
}

async function main() {
  try {
    mkdirSync(matterDirectory, { recursive: true });
    mkdirSync(migrationParent, { recursive: true });
    withDatabase((db) => {
      const timestamp = '2026-09-22T00:00:00.000Z';
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES (?,'P260401-KR','상상특허','patent','KR','P260401','["KR"]','user_input',1,1,?,?)`)
        .run(matterId, timestamp, timestamp);
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,created_at) VALUES (?,'matter',?,'wiki.synthetic_fact','{"fact":"최초 근거"}','장진태','user_input',?)`)
        .run(eventId, matterId, timestamp);
      db.prepare(`INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,created_at) VALUES ('stage4-entry-001','matter',?,'2026-09-22','user_date','사용자가 확인한 합성 사실','user_input',?,?)`)
        .run(matterId, eventId, timestamp);
    });
    writeFileSync(matterFile, markdown('활성 문서의 최초 본문입니다.'), 'utf8');
    await scanWikiMarkdownVault();

    const first = await prepareWikiMarkdownProposal(docId);
    bind(first);
    const firstBody = '사용자가 확인한 합성 사실을 반영한 제안 문장입니다.';
    const firstInput = proposalInput(first.runId, firstBody);
    const activeBefore = readFileSync(matterFile, 'utf8');
    const firstIngest: any = await ingestWikiMarkdownProposal(firstInput);
    assert.equal(firstIngest.duplicate, false);
    assert.equal(await ingestWikiMarkdownProposal(firstInput).then((value: any) => value.duplicate), true);
    assert.equal(readFileSync(matterFile, 'utf8'), activeBefore, '제안 생성은 활성 Markdown을 바꾸지 않아야 한다.');
    const firstId = firstIngest.proposal.id;
    const firstDetail: any = wikiMarkdownProposalDetail(firstId);
    assert.equal(firstDetail.proposal.status, 'ready_for_review');
    assert.ok(existsSync(path.join(vaultRoot, ...firstDetail.proposal.proposal_relative_path.split('/'))));
    withDatabase((db) => {
      const columns = db.prepare('PRAGMA table_info(wiki_proposal)').all() as Array<{ name: string }>;
      assert.equal(columns.some((column) => /(^|_)(body|content|markdown)(_|$)/i.test(column.name)), false);
    });
    await assert.rejects(
      () => reviewWikiMarkdownProposal(firstId, 'accept_for_manual_apply', firstDetail.proposal.row_version, '임의사용자'),
      /검토자는 인증된 사용자/,
    );
    const review: any = await reviewWikiMarkdownProposal(firstId, 'accept_for_manual_apply', firstDetail.proposal.row_version);
    assert.equal(review.automaticApply, false);
    assert.equal(readFileSync(matterFile, 'utf8'), activeBefore);

    writeFileSync(matterFile, markdown('사람이 Obsidian에서 별도로 수정한 본문입니다.'), 'utf8');
    const stale = await reconcileWikiMarkdownProposal(firstId);
    assert.equal(stale.status, 'stale_document');
    await assert.rejects(
      () => reviewWikiMarkdownProposal(firstId, 'accept_for_manual_apply', Number(firstDetail.proposal.row_version) + 2),
      /승인할 수 없습니다|변경되었습니다/,
    );
    assert.match(readFileSync(matterFile, 'utf8'), /사람이 Obsidian/);
    await scanWikiMarkdownVault();

    const second = await prepareWikiMarkdownProposal(docId);
    bind(second);
    const secondBody = '사람 편집을 기준으로 다시 만든 최신 제안 문장입니다.';
    const secondInput = proposalInput(second.runId, secondBody);
    const secondIngest: any = await ingestWikiMarkdownProposal(secondInput);
    const secondDetail: any = wikiMarkdownProposalDetail(secondIngest.proposal.id);
    await reviewWikiMarkdownProposal(secondIngest.proposal.id, 'accept_for_manual_apply', secondDetail.proposal.row_version);
    writeFileSync(matterFile, secondInput.proposedMarkdown.replace(/\r\n?/g, '\n'), 'utf8');
    await scanWikiMarkdownVault();
    const applied = await reconcileWikiMarkdownProposal(secondIngest.proposal.id);
    assert.equal(applied.status, 'applied_observed');

    const third = await prepareWikiMarkdownProposal(docId);
    bind(third);
    const thirdInput = proposalInput(third.runId, '근거 변경 감지를 확인하는 세 번째 제안입니다.');
    const thirdIngest: any = await ingestWikiMarkdownProposal(thirdInput);
    withDatabase((db) => db.prepare(`UPDATE event SET after_json='{"fact":"정정된 근거"}' WHERE id=?`).run(eventId));
    const evidenceStale = await reconcileWikiMarkdownProposal(thirdIngest.proposal.id);
    assert.equal(evidenceStale.status, 'stale_evidence');
    const evidenceDetail: any = wikiMarkdownProposalDetail(thirdIngest.proposal.id);
    assert.ok(evidenceDetail.evidence.some((item: any) => item.validation_status === 'changed'));

    const invalid = await prepareWikiMarkdownProposal(docId);
    bind(invalid);
    const invalidInput = proposalInput(invalid.runId, '문서 신원 변경을 시도하는 잘못된 제안입니다.');
    invalidInput.proposedMarkdown = markdown('문서 신원 변경을 시도하는 잘못된 제안입니다.', 'wiki-another-document-001');
    await assert.rejects(() => ingestWikiMarkdownProposal(invalidInput), /doc_id를 변경/);

    seedLegacyWiki();
    const legacyBefore = withDatabase((db) => ({
      revisions: db.prepare('SELECT * FROM entity_wiki_revision ORDER BY id').all(),
      drafts: db.prepare('SELECT * FROM wiki_draft ORDER BY run_id').all(),
    }));
    const outputRoot = path.join(migrationParent, 'legacy-dry-run-001');
    const migration: any = runLegacyWikiMigrationDryRun(outputRoot);
    assert.equal(migration.duplicate, false);
    assert.equal(migration.manifest.summary.publishedRevisionCount, 2);
    assert.equal(migration.manifest.summary.draftCount, 1);
    assert.equal(migration.manifest.summary.activeCandidateCount, 1);
    assert.equal(migration.manifest.guarantees.pendingDraftPromoted, false);
    assert.ok(migration.manifest.items.find((item: any) => item.sourceKind === 'pending_draft').outputRelativePath.includes('artifacts/proposals/'));
    assert.ok(migration.manifest.activeCandidates[0].suggestedVaultPath.startsWith('10_Matters/'));
    for (const item of migration.manifest.items) {
      const file = path.join(outputRoot, ...item.outputRelativePath.split('/'));
      assert.ok(existsSync(file));
      assert.equal(item.outputByteHash, (await import('node:crypto')).createHash('sha256').update(readFileSync(file)).digest('hex'));
    }
    const repeated: any = runLegacyWikiMigrationDryRun(outputRoot);
    assert.equal(repeated.duplicate, true);
    assert.equal(withDatabase((db) => Number((db.prepare('SELECT COUNT(*) count FROM wiki_migration_item').get() as any).count)), 3);
    const legacyAfter = withDatabase((db) => ({
      revisions: db.prepare('SELECT * FROM entity_wiki_revision ORDER BY id').all(),
      drafts: db.prepare('SELECT * FROM wiki_draft ORDER BY run_id').all(),
    }));
    assert.deepEqual(legacyAfter, legacyBefore, 'dry-run은 레거시 본문·초안을 수정하지 않아야 한다.');

    const collisionRoot = path.join(migrationParent, 'collision');
    mkdirSync(collisionRoot);
    writeFileSync(path.join(collisionRoot, 'keep.txt'), 'preserve', 'utf8');
    assert.throws(() => runLegacyWikiMigrationDryRun(collisionRoot), /manifest|기존 출력/);
    assert.equal(readFileSync(path.join(collisionRoot, 'keep.txt'), 'utf8'), 'preserve');

    process.env.SSPAT_RUNTIME_PROFILE = 'operational';
    assert.throws(() => runLegacyWikiMigrationDryRun(path.join(migrationParent, 'blocked')), /운영 프로필/);
    process.env.SSPAT_RUNTIME_PROFILE = 'test';

    console.log('Stage 4 Wiki proposal staleness, human edit preservation, evidence checks and legacy migration dry-run tests passed.');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
