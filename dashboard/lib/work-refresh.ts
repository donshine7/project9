import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;

export const WORK_REFRESH_STAGES = [
  'collection',
  'mail_fact_extraction',
  'matter_linking',
  'action_judgement',
  'high_risk_verification',
  'easy_pat_verification',
  'wiki_revision',
  'application',
] as const;

export const WORK_REFRESH_OUTCOMES = ['no_change', 'candidate', 'applied', 'held', 'failed'] as const;
const REQUEST_CHANNELS = ['codex', 'dashboard', 'manual', 'scheduled'] as const;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const MAIL_STATUS_RANK: Record<string, number> = { pending: 0, reviewed_no_change: 1, candidate: 2, held: 3, failed: 3, applied: 4 };

export type WorkRefreshCreateInput = {
  requestChannel?: string;
  requestedBy?: string;
  requestedAt?: string;
  mailWindowFrom: string;
  mailWindowTo: string;
};

export type WorkRefreshResultInput = {
  stageId: string;
  subjectType: string;
  subjectKey: string;
  outcome: string;
  sourceType: string;
  sourceId: string;
  sourceAt?: string | null;
  decisionRunId?: string | null;
  eventId?: string | null;
  result?: unknown;
};

function stamp() { return new Date().toISOString(); }
function fail(message: string, status = 400, code = 'WORK_REFRESH_VALIDATION'): never { throw new WorkDbError(message, status, code); }
function required(value: unknown, label: string, max = 500) {
  const normalized = String(value ?? '').trim();
  if (!normalized) fail(`${label}을(를) 입력하세요.`);
  if (normalized.length > max) fail(`${label}은(는) ${max}자 이하여야 합니다.`);
  return normalized;
}
function instant(value: unknown, label: string) {
  const normalized = required(value, label, 100);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) fail(`${label}이(가) 올바른 시각이 아닙니다.`);
  return parsed.toISOString();
}
function count(value: unknown, label: string, fallback = 0) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) fail(`${label}은(는) 0 이상의 정수여야 합니다.`);
  return normalized;
}
function jsonValue(value: unknown, label: string) {
  const serialized = JSON.stringify(value ?? {});
  if (serialized === undefined || serialized.length > 100_000) fail(`${label}이(가) 너무 큽니다.`);
  return serialized;
}
function runRow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM work_refresh_run WHERE id=?').get(id) as Row | undefined;
  if (!row) fail('업무 정리 실행을 찾을 수 없습니다.', 404, 'WORK_REFRESH_NOT_FOUND');
  return row;
}
function stageRow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM work_refresh_stage WHERE id=?').get(id) as Row | undefined;
  if (!row) fail('업무 정리 단계를 찾을 수 없습니다.', 404, 'WORK_REFRESH_STAGE_NOT_FOUND');
  return row;
}
function mappedRun(row: Row) {
  const target = Number(row.target_mail_count);
  const reviewed = Number(row.reviewed_mail_count);
  return {
    id: row.id,
    requestChannel: row.request_channel,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    mailWindowFrom: row.mail_window_from,
    mailWindowTo: row.mail_window_to,
    reviewedMailFrom: row.reviewed_mail_from,
    reviewedMailTo: row.reviewed_mail_to,
    status: row.status,
    targetMailCount: target,
    reviewedMailCount: reviewed,
    pendingMailCount: Number(row.pending_mail_count),
    appliedItemCount: Number(row.applied_item_count),
    heldItemCount: Number(row.held_item_count),
    errorCount: Number(row.error_count),
    progressPercent: target === 0 ? 0 : Math.round((reviewed / target) * 100),
    collectionCompletedAt: row.collection_completed_at,
    completedAt: row.completed_at,
    lastErrorCode: row.last_error_code,
    lastAppliedSourceAt: row.last_applied_source_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mappedStage(row: Row) {
  return {
    id: row.id,
    workRefreshRunId: row.work_refresh_run_id,
    stageKey: row.stage_key,
    attempt: Number(row.attempt),
    status: row.status,
    inputCount: Number(row.input_count),
    processedCount: Number(row.processed_count),
    outputCount: Number(row.output_count),
    errorCount: Number(row.error_count),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    result: JSON.parse(row.result_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function refreshWorkRefreshAggregatesInDb(db: DatabaseSync, runId: string) {
  runRow(db, runId);
  const mail = db.prepare(`
    SELECT COUNT(*) AS target_count,
      COALESCE(SUM(CASE WHEN review_status != 'pending' THEN 1 ELSE 0 END), 0) AS reviewed_count,
      COALESCE(SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
      MIN(CASE WHEN review_status != 'pending' THEN mi.mail_at END) AS reviewed_from,
      MAX(CASE WHEN review_status != 'pending' THEN mi.mail_at END) AS reviewed_to
    FROM work_refresh_mail wrm
    JOIN mail_item mi ON mi.id=wrm.mail_id
    WHERE wrm.work_refresh_run_id=?
  `).get(runId) as Row;
  const result = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN outcome='applied' THEN 1 ELSE 0 END),0) AS applied_count,
      COALESCE(SUM(CASE WHEN outcome='held' THEN 1 ELSE 0 END),0) AS held_count,
      COALESCE(SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END),0) AS result_error_count,
      MAX(CASE WHEN outcome='applied' THEN source_at END) AS last_applied_source_at
    FROM work_refresh_result WHERE work_refresh_run_id=?
  `).get(runId) as Row;
  const stage = db.prepare(`SELECT COALESCE(SUM(error_count),0) AS error_count FROM work_refresh_stage WHERE work_refresh_run_id=?`).get(runId) as Row;
  db.prepare(`
    UPDATE work_refresh_run SET
      target_mail_count=?, reviewed_mail_count=?, pending_mail_count=?,
      reviewed_mail_from=?, reviewed_mail_to=?, applied_item_count=?, held_item_count=?,
      error_count=?, updated_at=?
    WHERE id=?
  `).run(
    mail.target_count, mail.reviewed_count, mail.pending_count, mail.reviewed_from, mail.reviewed_to,
    result.applied_count, result.held_count, Number(result.result_error_count) + Number(stage.error_count), stamp(), runId,
  );
}

export function createWorkRefresh(input: WorkRefreshCreateInput) {
  const requestChannel = String(input.requestChannel ?? 'codex');
  if (!REQUEST_CHANNELS.includes(requestChannel as any)) fail('업무 정리 요청 경로가 올바르지 않습니다.');
  const requestedBy = required(input.requestedBy ?? '장진태', '요청자', 100);
  const requestedAt = input.requestedAt ? instant(input.requestedAt, '요청 접수 시각') : stamp();
  if (Date.parse(requestedAt) > Date.now() + 5 * 60 * 1000) fail('요청 접수 시각은 미래일 수 없습니다.');
  const from = instant(input.mailWindowFrom, '검토 시작 시각');
  const to = instant(input.mailWindowTo, '검토 종료 시각');
  if (to <= from) fail('검토 종료 시각은 시작 시각보다 뒤여야 합니다.');
  if (Date.parse(to) - Date.parse(from) > 366 * 24 * 60 * 60 * 1000) fail('한 번의 검토 기간은 최대 366일입니다.');
  const id = randomUUID(), createdAt = stamp();
  return withDatabase(db => transaction(db, () => {
    db.prepare(`
      INSERT INTO work_refresh_run(
        id,request_channel,requested_by,requested_at,mail_window_from,mail_window_to,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'requested',?,?)
    `).run(id, requestChannel, requestedBy, requestedAt, from, to, createdAt, createdAt);
    return getWorkRefreshFromDb(db, id);
  }));
}

export function startWorkRefreshStage(runIdValue: unknown, stageKeyValue: unknown, inputCountValue: unknown = 0) {
  const runId = required(runIdValue, '업무 정리 실행 ID', 100);
  const stageKey = required(stageKeyValue, '단계', 80);
  if (!WORK_REFRESH_STAGES.includes(stageKey as any)) fail('지원하지 않는 업무 정리 단계입니다.');
  const inputCount = count(inputCountValue, '입력 건수');
  return withDatabase(db => transaction(db, () => {
    const run = runRow(db, runId);
    if (TERMINAL_STATUSES.has(String(run.status))) fail('완료되거나 취소된 실행에는 단계를 시작할 수 없습니다.', 409, 'WORK_REFRESH_TERMINAL');
    const running = db.prepare("SELECT id FROM work_refresh_stage WHERE work_refresh_run_id=? AND stage_key=? AND status='running'").get(runId, stageKey);
    if (running) fail('같은 단계가 이미 실행 중입니다.', 409, 'WORK_REFRESH_STAGE_RUNNING');
    const attempt = Number((db.prepare('SELECT COALESCE(MAX(attempt),0) AS n FROM work_refresh_stage WHERE work_refresh_run_id=? AND stage_key=?').get(runId, stageKey) as Row).n) + 1;
    const id = randomUUID(), startedAt = stamp();
    db.prepare(`
      INSERT INTO work_refresh_stage(
        id,work_refresh_run_id,stage_key,attempt,status,input_count,started_at,created_at,updated_at
      ) VALUES (?,?,?,?,'running',?,?,?,?)
    `).run(id, runId, stageKey, attempt, inputCount, startedAt, startedAt, startedAt);
    const nextStatus = stageKey === 'collection' ? 'collecting' : stageKey === 'application' ? 'applying' : 'analyzing';
    db.prepare('UPDATE work_refresh_run SET status=?,completed_at=NULL,last_error_code=NULL,updated_at=? WHERE id=?').run(nextStatus, startedAt, runId);
    return mappedStage(stageRow(db, id));
  }));
}

export function setWorkRefreshStageInputCount(stageIdValue: unknown, inputCountValue: unknown) {
  const stageId = required(stageIdValue, '업무 정리 단계 ID', 100);
  const inputCount = count(inputCountValue, '입력 건수');
  return withDatabase(db => transaction(db, () => {
    const stage = stageRow(db, stageId);
    if (stage.status !== 'running' || Number(stage.processed_count) !== 0) fail('처리 시작 전 실행 중인 단계만 입력 건수를 변경할 수 있습니다.', 409, 'WORK_REFRESH_STAGE_STATE');
    const updatedAt = stamp();
    db.prepare('UPDATE work_refresh_stage SET input_count=?,updated_at=? WHERE id=?').run(inputCount, updatedAt, stageId);
    return mappedStage(stageRow(db, stageId));
  }));
}

export function completeWorkRefreshStage(stageIdValue: unknown, input: { processedCount?: unknown; outputCount?: unknown; errorCount?: unknown; result?: unknown } = {}) {
  const stageId = required(stageIdValue, '업무 정리 단계 ID', 100);
  return withDatabase(db => transaction(db, () => {
    const stage = stageRow(db, stageId);
    if (stage.status !== 'running') fail('실행 중인 단계만 완료할 수 있습니다.', 409, 'WORK_REFRESH_STAGE_STATE');
    const processed = count(input.processedCount, '처리 건수', Number(stage.input_count));
    const output = count(input.outputCount, '출력 건수');
    const errors = count(input.errorCount, '오류 건수');
    if (processed > Number(stage.input_count)) fail('처리 건수는 입력 건수를 초과할 수 없습니다.');
    const completedAt = stamp(), status = errors ? 'partial' : 'completed';
    db.prepare(`
      UPDATE work_refresh_stage SET status=?,processed_count=?,output_count=?,error_count=?,
        completed_at=?,result_json=?,updated_at=? WHERE id=?
    `).run(status, processed, output, errors, completedAt, jsonValue(input.result, '단계 결과'), completedAt, stageId);
    const nextStatus = errors ? 'partial' : 'review_pending';
    db.prepare(`UPDATE work_refresh_run SET status=?,collection_completed_at=CASE WHEN ?='collection' THEN ? ELSE collection_completed_at END,updated_at=? WHERE id=?`)
      .run(nextStatus, stage.stage_key, completedAt, completedAt, stage.work_refresh_run_id);
    refreshWorkRefreshAggregatesInDb(db, stage.work_refresh_run_id);
    return mappedStage(stageRow(db, stageId));
  }));
}

export function failWorkRefreshStage(stageIdValue: unknown, errorCodeValue: unknown) {
  const stageId = required(stageIdValue, '업무 정리 단계 ID', 100);
  const errorCode = required(errorCodeValue, '오류 코드', 100);
  return withDatabase(db => transaction(db, () => {
    const stage = stageRow(db, stageId);
    if (stage.status !== 'running') fail('실행 중인 단계만 실패 처리할 수 있습니다.', 409, 'WORK_REFRESH_STAGE_STATE');
    const failedAt = stamp();
    db.prepare("UPDATE work_refresh_stage SET status='failed',error_count=1,error_code=?,completed_at=?,updated_at=? WHERE id=?").run(errorCode, failedAt, failedAt, stageId);
    db.prepare("UPDATE work_refresh_run SET status='failed',last_error_code=?,completed_at=?,updated_at=? WHERE id=?").run(errorCode, failedAt, failedAt, stage.work_refresh_run_id);
    refreshWorkRefreshAggregatesInDb(db, stage.work_refresh_run_id);
    return mappedStage(stageRow(db, stageId));
  }));
}

function resultMailStatus(outcome: string) {
  return ({ no_change: 'reviewed_no_change', candidate: 'candidate', applied: 'applied', held: 'held', failed: 'failed' } as Record<string, string>)[outcome];
}

export function recordWorkRefreshResultInDb(db: DatabaseSync, runId: string, input: WorkRefreshResultInput) {
  const run = runRow(db, runId), stage = stageRow(db, required(input.stageId, '단계 ID', 100));
  if (stage.work_refresh_run_id !== run.id) fail('단계와 업무 정리 실행이 일치하지 않습니다.', 409);
  const subjectType = required(input.subjectType, '결과 대상 유형', 80);
  const subjectKey = required(input.subjectKey, '결과 대상 식별자', 500);
  const outcome = required(input.outcome, '결과', 40);
  if (!WORK_REFRESH_OUTCOMES.includes(outcome as any)) fail('업무 정리 결과가 올바르지 않습니다.');
  const sourceType = required(input.sourceType, '근거 유형', 80);
  const sourceId = required(input.sourceId, '근거 식별자', 500);
  let sourceAt = input.sourceAt ? instant(input.sourceAt, '근거 시각') : null;
  if (sourceType === 'mail') {
    const mail = db.prepare('SELECT mail_at FROM mail_item WHERE id=?').get(sourceId) as Row | undefined;
    if (!mail) fail('결과 근거 메일을 찾을 수 없습니다.', 404);
    sourceAt ??= mail.mail_at;
  }
  if (input.decisionRunId) {
    const decision = db.prepare('SELECT work_refresh_run_id,work_refresh_stage_id FROM decision_run WHERE id=?').get(input.decisionRunId) as Row | undefined;
    if (!decision || decision.work_refresh_run_id !== runId || decision.work_refresh_stage_id !== stage.id) fail('판단 실행과 업무 정리 단계가 일치하지 않습니다.', 409);
  }
  const createdAt = stamp(), id = randomUUID();
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO work_refresh_result(
      id,work_refresh_run_id,work_refresh_stage_id,subject_type,subject_key,outcome,
      source_type,source_id,source_at,decision_run_id,event_id,result_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, runId, stage.id, subjectType, subjectKey, outcome, sourceType, sourceId, sourceAt, input.decisionRunId ?? null, input.eventId ?? null, jsonValue(input.result, '결과 상세'), createdAt);
  if (sourceType === 'mail') {
    const current = db.prepare('SELECT review_status FROM work_refresh_mail WHERE work_refresh_run_id=? AND mail_id=?').get(runId, sourceId) as Row | undefined;
    if (current) {
      const next = resultMailStatus(outcome);
      if (MAIL_STATUS_RANK[next] > MAIL_STATUS_RANK[String(current.review_status)]) {
        db.prepare('UPDATE work_refresh_mail SET review_status=?,reviewed_at=COALESCE(reviewed_at,?),updated_at=? WHERE work_refresh_run_id=? AND mail_id=?')
          .run(next, createdAt, createdAt, runId, sourceId);
      }
    }
  }
  return { id: Number(inserted.changes) ? id : null, duplicate: !Number(inserted.changes) };
}

export function recordWorkRefreshResult(runIdValue: unknown, input: WorkRefreshResultInput) {
  const runId = required(runIdValue, '업무 정리 실행 ID', 100);
  return withDatabase(db => transaction(db, () => {
    const result = recordWorkRefreshResultInDb(db, runId, input);
    refreshWorkRefreshAggregatesInDb(db, runId);
    return { ...result, run: getWorkRefreshFromDb(db, runId) };
  }));
}

export function recordWorkRefreshCoverageInDb(db: DatabaseSync, decisionRun: Row, coverage: Array<{ mailId: string; outcome: string; reason: string }>) {
  if (!decisionRun.work_refresh_run_id || !decisionRun.work_refresh_stage_id) return;
  const outcomeMap: Record<string, string> = { candidate: 'candidate', no_change: 'no_change', needs_review: 'held' };
  for (const item of coverage) {
    recordWorkRefreshResultInDb(db, decisionRun.work_refresh_run_id, {
      stageId: decisionRun.work_refresh_stage_id,
      subjectType: 'mail',
      subjectKey: item.mailId,
      outcome: outcomeMap[item.outcome],
      sourceType: 'mail',
      sourceId: item.mailId,
      decisionRunId: decisionRun.id,
      result: { coverageOutcome: item.outcome, reason: item.reason },
    });
  }
  refreshWorkRefreshAggregatesInDb(db, decisionRun.work_refresh_run_id);
}

export function reconcileWorkRefreshStageInDb(db: DatabaseSync, stageIdValue: unknown) {
  const stageId = required(stageIdValue, '업무 정리 단계 ID', 100);
  const stage = stageRow(db, stageId);
  if (stage.status !== 'running') return mappedStage(stage);
  const decisions = db.prepare('SELECT status FROM decision_run WHERE work_refresh_stage_id=?').all(stageId) as Row[];
  if (!decisions.length || decisions.some(item => ['prepared', 'started'].includes(String(item.status)))) return mappedStage(stage);
  const failed = decisions.filter(item => item.status === 'failed').length;
  const succeeded = decisions.filter(item => item.status === 'succeeded').length;
  const resultCounts = db.prepare(`
    SELECT COUNT(DISTINCT CASE WHEN source_type='mail' THEN source_id END) AS processed_count,
      COALESCE(SUM(CASE WHEN outcome='candidate' THEN 1 ELSE 0 END),0) AS output_count
    FROM work_refresh_result WHERE work_refresh_stage_id=?
  `).get(stageId) as Row;
  const completedAt = stamp();
  const status = failed ? (succeeded ? 'partial' : 'failed') : 'completed';
  db.prepare(`
    UPDATE work_refresh_stage SET status=?,processed_count=?,output_count=?,error_count=?,
      error_code=?,completed_at=?,updated_at=? WHERE id=?
  `).run(status, Math.min(Number(stage.input_count), Number(resultCounts.processed_count)), resultCounts.output_count, failed, failed ? 'ANALYSIS_RUN_FAILED' : null, completedAt, completedAt, stageId);
  const runStatus = status === 'failed' ? 'failed' : status === 'partial' ? 'partial' : 'review_pending';
  db.prepare('UPDATE work_refresh_run SET status=?,last_error_code=?,completed_at=?,updated_at=? WHERE id=?')
    .run(runStatus, failed ? 'ANALYSIS_RUN_FAILED' : null, failed ? completedAt : null, completedAt, stage.work_refresh_run_id);
  refreshWorkRefreshAggregatesInDb(db, stage.work_refresh_run_id);
  return mappedStage(stageRow(db, stageId));
}

export function finalizeWorkRefresh(runIdValue: unknown) {
  const runId = required(runIdValue, '업무 정리 실행 ID', 100);
  return withDatabase(db => transaction(db, () => {
    const run = runRow(db, runId);
    if (run.status === 'cancelled') fail('취소된 실행은 완료할 수 없습니다.', 409);
    const activeStages = Number((db.prepare("SELECT COUNT(*) AS n FROM work_refresh_stage WHERE work_refresh_run_id=? AND status='running'").get(runId) as Row).n);
    const activeDecisions = Number((db.prepare("SELECT COUNT(*) AS n FROM decision_run WHERE work_refresh_run_id=? AND status IN ('prepared','started')").get(runId) as Row).n);
    if (activeStages || activeDecisions) fail('실행 중인 단계 또는 판단 작업이 남아 있습니다.', 409, 'WORK_REFRESH_ACTIVE');
    refreshWorkRefreshAggregatesInDb(db, runId);
    const current = runRow(db, runId);
    const pendingCandidates = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM analysis_candidate c
      JOIN decision_run d ON d.id=c.run_id
      WHERE d.work_refresh_run_id=? AND c.review_status='pending' AND c.kind!='risk'
    `).get(runId) as Row).n);
    const unresolvedStageErrors = Number((db.prepare(`
      SELECT COUNT(*) AS n FROM work_refresh_stage current
      WHERE current.work_refresh_run_id=?
        AND current.attempt=(SELECT MAX(latest.attempt) FROM work_refresh_stage latest WHERE latest.work_refresh_run_id=current.work_refresh_run_id AND latest.stage_key=current.stage_key)
        AND current.status IN ('failed','partial')
    `).get(runId) as Row).n);
    let status: string, completedAt: string | null;
    if (pendingCandidates) { status = 'review_pending'; completedAt = null; }
    else if (Number(current.pending_mail_count) || unresolvedStageErrors) { status = 'partial'; completedAt = stamp(); }
    else { status = 'completed'; completedAt = stamp(); }
    db.prepare('UPDATE work_refresh_run SET status=?,completed_at=?,updated_at=? WHERE id=?').run(status, completedAt, stamp(), runId);
    return getWorkRefreshFromDb(db, runId);
  }));
}

export function getWorkRefreshFromDb(db: DatabaseSync, runId: string) {
  const run = db.prepare(`
    SELECT r.*,(SELECT MAX(source_at) FROM work_refresh_result x WHERE x.work_refresh_run_id=r.id AND x.outcome='applied') AS last_applied_source_at
    FROM work_refresh_run r WHERE r.id=?
  `).get(runId) as Row | undefined;
  if (!run) fail('업무 정리 실행을 찾을 수 없습니다.', 404, 'WORK_REFRESH_NOT_FOUND');
  const stages = (db.prepare('SELECT * FROM work_refresh_stage WHERE work_refresh_run_id=? ORDER BY created_at,attempt').all(runId) as Row[]).map(mappedStage);
  const targetCount = Number(run.target_mail_count);
  const targetMails = db.prepare(`
    SELECT wrm.mail_id AS mailId,wrm.source_sync_run_id AS sourceSyncRunId,wrm.review_status AS reviewStatus,
      wrm.reviewed_at AS reviewedAt,wrm.result_code AS resultCode,mi.subject,mi.mail_at AS mailAt,mi.direction
    FROM work_refresh_mail wrm JOIN mail_item mi ON mi.id=wrm.mail_id
    WHERE wrm.work_refresh_run_id=? ORDER BY mi.mail_at,mi.id LIMIT 200
  `).all(runId);
  return { ...mappedRun(run), stages, targetMails, targetMailsTruncated: targetCount > targetMails.length };
}

export function getWorkRefresh(runIdValue: unknown) {
  const runId = required(runIdValue, '업무 정리 실행 ID', 100);
  return withDatabase(db => getWorkRefreshFromDb(db, runId));
}

export function listWorkRefreshes(limitValue: unknown = 20) {
  const limit = Math.min(count(limitValue, '조회 건수', 20), 100);
  return withDatabase(db => (db.prepare(`
    SELECT r.*,(SELECT MAX(source_at) FROM work_refresh_result x WHERE x.work_refresh_run_id=r.id AND x.outcome='applied') AS last_applied_source_at
    FROM work_refresh_run r ORDER BY requested_at DESC,id DESC LIMIT ?
  `).all(limit) as Row[]).map(mappedRun));
}
