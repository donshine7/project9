import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindAnalysis, failAnalysis, ingestAnalysis, prepareAnalysis } from '../lib/analysis';
import {
  completeWorkRefreshStage,
  createWorkRefresh,
  finalizeWorkRefresh,
  getWorkRefresh,
  listWorkRefreshes,
  recordWorkRefreshResult,
  startWorkRefreshStage,
} from '../lib/work-refresh';
import { importOutlookMail, withDatabase } from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-work-refresh-'));
process.env.SSPAT_WORK_DB_PATH = path.join(temporaryRoot, 'sspat-work.db');
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));

try {
  const range = { from: '2026-09-10T00:00:00.000Z', to: '2026-09-12T00:00:00.000Z', folders: ['받은 편지함', '보낸 편지함'] };
  const records = [
    { entryId: 'refresh-mail-1', folderPath: '받은 편지함', direction: 'received' as const, subject: '일반 안내', mailAt: '2026-09-10T01:00:00.000Z', body: '검토할 안내 메일입니다.' },
    { entryId: 'refresh-mail-2', folderPath: '보낸 편지함', direction: 'sent' as const, subject: '회신 안내', mailAt: '2026-09-11T02:00:00.000Z', body: '후속 회신입니다.' },
  ];
  const refresh = createWorkRefresh({
    requestChannel: 'codex', requestedBy: '장진태', requestedAt: '2026-09-12T03:00:00.000Z',
    mailWindowFrom: range.from, mailWindowTo: range.to,
  });
  assert.equal(refresh.status, 'requested');
  assert.equal(refresh.requestedAt, '2026-09-12T03:00:00.000Z');

  const collection = startWorkRefreshStage(refresh.id, 'collection', records.length);
  assert.equal(collection.status, 'running');
  const imported = importOutlookMail(records, { ...range, workRefreshRunId: refresh.id, workRefreshStageId: collection.id });
  assert.equal(imported.imported, 2);
  assert.equal(imported.targeted, 2);
  completeWorkRefreshStage(collection.id, { processedCount: 2, outputCount: 2, result: { syncId: imported.syncId } });
  let detail = getWorkRefresh(refresh.id);
  assert.equal(detail.status, 'review_pending');
  assert.equal(detail.targetMailCount, 2);
  assert.equal(detail.pendingMailCount, 2);
  assert.equal(detail.collectionCompletedAt !== null, true);
  assert.deepEqual(detail.targetMails.map((mail: any) => mail.subject), ['일반 안내', '회신 안내']);
  withDatabase(db => {
    const sync = db.prepare('SELECT work_refresh_run_id,work_refresh_stage_id FROM sync_run WHERE id=?').get(imported.syncId) as any;
    assert.equal(sync.work_refresh_run_id, refresh.id);
    assert.equal(sync.work_refresh_stage_id, collection.id);
  });

  const mailIds = detail.targetMails.map((mail: any) => String(mail.mailId));
  const factStage = startWorkRefreshStage(refresh.id, 'mail_fact_extraction', mailIds.length);
  const decision = prepareAnalysis('mail_fact_extraction', mailIds, { workRefreshRunId: refresh.id, workRefreshStageId: factStage.id });
  bindAnalysis(decision.runId, { agentId: 'work-refresh-fixture', model: decision.route.model, effort: decision.route.effort });
  const result = {
    schemaVersion: 1,
    runId: decision.runId,
    coverage: mailIds.map(mailId => ({ mailId, outcome: 'no_change', reason: '업무 상태를 변경할 새 사실이 없습니다.' })),
    candidates: [],
  };
  assert.equal(ingestAnalysis(result).duplicate, false);
  assert.equal(ingestAnalysis(result).duplicate, true);
  detail = getWorkRefresh(refresh.id);
  assert.equal(detail.stages.find((stage: any) => stage.id === factStage.id)?.status, 'completed');
  assert.equal(detail.reviewedMailCount, 2);
  assert.equal(detail.pendingMailCount, 0);
  assert.equal(detail.reviewedMailFrom, '2026-09-10T01:00:00.000Z');
  assert.equal(detail.reviewedMailTo, '2026-09-11T02:00:00.000Z');
  assert.equal(detail.targetMails.every((mail: any) => mail.reviewStatus === 'reviewed_no_change'), true);
  withDatabase(db => {
    const linked = db.prepare('SELECT work_refresh_run_id,work_refresh_stage_id FROM decision_run WHERE id=?').get(decision.runId) as any;
    assert.equal(linked.work_refresh_run_id, refresh.id);
    assert.equal(linked.work_refresh_stage_id, factStage.id);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM work_refresh_result WHERE work_refresh_stage_id=?').get(factStage.id) as any).n, 2);
    const pendingRiskPayload = JSON.stringify({
      key: 'pending-risk-fixture', kind: 'risk', entityType: 'candidate', entityId: 'source-fixture',
      fields: { verdict: { value: 'confirmed', confidence: 1, rationale: '검증 결과 fixture', evidence: [
        { mailId: mailIds[0], field: 'subject', quote: '일반 안내' },
      ] } },
    });
    db.prepare(`INSERT INTO analysis_candidate(
      id,run_id,candidate_key,kind,entity_type,entity_id,payload_json,risk_level,created_at
    ) VALUES ('pending-risk-fixture',?,'pending-risk-fixture','risk','candidate','source-fixture',?,'high','2026-09-12T03:00:00.000Z')`).run(decision.runId, pendingRiskPayload);
  });
  // Risk-verifier outputs are evidence for source candidates, not user-review
  // work. Their default pending status must not keep a refresh open forever.
  assert.equal(finalizeWorkRefresh(refresh.id).status, 'completed');
  assert.throws(() => startWorkRefreshStage(refresh.id, 'matter_linking', 1), /완료되거나 취소/);

  const retryRefresh = createWorkRefresh({ requestChannel: 'dashboard', mailWindowFrom: range.from, mailWindowTo: range.to });
  const retryCollection = startWorkRefreshStage(retryRefresh.id, 'collection', records.length);
  const replay = importOutlookMail(records, { ...range, workRefreshRunId: retryRefresh.id, workRefreshStageId: retryCollection.id });
  assert.equal(replay.imported, 0);
  assert.equal(replay.skipped, 2);
  assert.equal(replay.targeted, 2);
  completeWorkRefreshStage(retryCollection.id, { processedCount: 2, outputCount: 0 });
  const linkStage = startWorkRefreshStage(retryRefresh.id, 'matter_linking', 1);
  const failedDecision = prepareAnalysis('matter_linking', [String(getWorkRefresh(retryRefresh.id).targetMails[0].mailId)], { workRefreshRunId: retryRefresh.id, workRefreshStageId: linkStage.id });
  failAnalysis(failedDecision.runId, 'FIXTURE_FAILURE');
  assert.equal(getWorkRefresh(retryRefresh.id).stages.find((stage: any) => stage.id === linkStage.id)?.status, 'failed');
  assert.equal(getWorkRefresh(retryRefresh.id).status, 'failed');
  const secondAttempt = startWorkRefreshStage(retryRefresh.id, 'matter_linking', 1);
  assert.equal(secondAttempt.attempt, 2);
  recordWorkRefreshResult(retryRefresh.id, {
    stageId: secondAttempt.id, subjectType: 'mail', subjectKey: mailIds[0], outcome: 'held',
    sourceType: 'mail', sourceId: mailIds[0], result: { reason: '사용자 검토 필요' },
  });
  const duplicate = recordWorkRefreshResult(retryRefresh.id, {
    stageId: secondAttempt.id, subjectType: 'mail', subjectKey: mailIds[0], outcome: 'held',
    sourceType: 'mail', sourceId: mailIds[0], result: { reason: '사용자 검토 필요' },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(getWorkRefresh(retryRefresh.id).heldItemCount, 1);
  assert.equal(listWorkRefreshes().length, 2);

  console.log('Work refresh request, collection, stage, evidence, retry and finalization tests passed.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
