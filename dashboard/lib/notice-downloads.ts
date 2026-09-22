import { execFile } from 'node:child_process';
import { constants as fsConstants, createReadStream, readFileSync } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveNoticeProjectRoot } from './runtime-environment';
import { transaction, withDatabase, WorkDbError } from './work-db';

const execFileAsync = promisify(execFile);
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 _().-]{1,119}$/;
const CLIENT_LABEL_PATTERN = /^[A-Za-z0-9가-힣(][A-Za-z0-9가-힣 _().-]{0,79}$/;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_PAGE_SIZE = 100;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

const kindLabels: Record<string, string> = {
  opinion_submission: '의견제출통지서',
  rejection_decision: '거절결정서',
  priority_exam_supplement_request: '우선심사 보완',
};

const userActionLabels: Record<string, string> = {
  confirm_project_identity: '의뢰인식별명, 프로젝트명, 통지 종류와 차수를 확인하세요.',
  connect_codex_project: '생성된 폴더를 Codex 로컬 프로젝트로 추가하고 _shared를 연결하세요.',
  create_intake_task: '표시된 제목으로 접수 작업을 만들고 접수 명령을 입력하세요.',
  provide_missing_sources: '표시된 누락 원본 또는 최신 버전을 제공하세요.',
  confirm_deadline_or_procedure: '현재 기일과 절차 상태를 원문 또는 EasyPAT 근거로 확인하세요.',
  select_strategy: '40_strategy의 대응안 또는 대응 경로를 선택하세요.',
  approve_draft_scope: '초안에 반영할 문언·주장 또는 보완 답변·첨부 구성을 승인하세요.',
  approve_submission_copy: '제출할 파일의 경로·버전·해시를 승인하세요.',
  external_dispatch_required: '승인된 제출본을 특허청에 제출하거나 별도 전송 지시를 하세요.',
  record_filing_receipt: '접수증, 제출 시각과 실제 제출 파일을 기록하세요.',
};

type Row = Record<string, any>;

type NoticeAutomationConfig = {
  schemaVersion: number;
  timezone: string;
  dailyRunTime: string;
  schedulerEnabled: boolean;
  outlookDetectionEnabled: boolean;
  features: Record<string, { detectionEnabled: boolean; automaticPublishEnabled: boolean; projectCreationEnabled: boolean }>;
};

function now() {
  return new Date().toISOString();
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function required(value: unknown, label: string, maxLength = 200) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new WorkDbError(`${label}을(를) 입력하세요.`, 400, 'NOTICE_INPUT_REQUIRED');
  if (normalized.length > maxLength) throw new WorkDbError(`${label}은(는) ${maxLength}자 이하여야 합니다.`, 400, 'NOTICE_INPUT_TOO_LONG');
  return normalized;
}

function safeInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function yamlString(value: string | null) {
  return value === null ? 'null' : JSON.stringify(value);
}

function sequenceFor(row: Row) {
  if (row.notice_kind === 'opinion_submission') return Number(row.oa_sequence || 0) || null;
  if (row.notice_kind === 'rejection_decision') return Number(row.rejection_sequence || 0) || null;
  return Number(row.supplement_sequence || 0) || null;
}

function sequenceLabel(row: Row) {
  const sequence = sequenceFor(row);
  if (!sequence) return '차수 미확정';
  return row.notice_kind === 'opinion_submission' ? `${sequence}OA` : `${sequence}차`;
}

function noticeStage(row: Row) {
  if (row.package_id && row.job_status === 'published') return { key: 'published', label: '게시 완료' };
  if (row.job_status === 'verified') return { key: 'verified', label: 'ZIP 검증 완료' };
  if (row.job_status === 'staged') return { key: 'staged', label: 'ZIP 생성 완료' };
  if (row.job_status === 'running') return { key: 'downloading', label: '파일 다운로드' };
  if (row.job_status === 'queued') return { key: 'queued', label: '다운로드 대기' };
  if (row.notice_status === 'held' || row.job_status === 'held') return { key: 'held', label: '확인 필요' };
  if (row.notice_status === 'failed' || row.job_status === 'failed') return { key: 'failed', label: '실패' };
  if (row.notice_status === 'ready') return { key: 'ready', label: '원본 확인 완료' };
  return { key: 'candidate', label: '메일 감지' };
}

function projectStage(row: Row) {
  if (!row.project_id) {
    return row.package_id
      ? { key: 'not_created', label: '프로젝트 생성 준비', userActionCode: 'confirm_project_identity', actionSummary: userActionLabels.confirm_project_identity }
      : { key: 'unavailable', label: 'ZIP 게시 전', userActionCode: null, actionSummary: null };
  }
  const code = row.user_action_code ?? (row.project_creation_status === 'created' ? 'connect_codex_project' : null);
  return {
    key: row.project_stage_key ?? row.project_creation_status,
    label: row.project_stage_status === 'completed' ? '대응 완료' : row.project_stage_status === 'held' ? '사용자 대기' : row.project_creation_status === 'created' ? '폴더 생성 완료' : '생성 점검',
    userActionCode: code,
    actionSummary: row.action_summary ?? (code ? userActionLabels[code] : null),
  };
}

function mapNotice(row: Row) {
  const stage = noticeStage(row);
  const project = projectStage(row);
  const total = Number(row.attachment_total || 0);
  const verified = Number(row.attachment_verified || 0);
  return {
    id: row.id,
    rowVersion: Number(row.row_version || 1),
    matterId: row.matter_id,
    matterReference: row.matter_reference,
    kind: row.notice_kind,
    kindLabel: kindLabels[row.notice_kind] ?? row.notice_kind,
    sequence: sequenceFor(row),
    progressSequence: row.progress_sequence,
    noticeDate: row.notice_date,
    dueDate: row.due_date,
    noticeStatus: row.notice_status,
    stage,
    mailCount: Number(row.mail_count || 0),
    attachmentTotal: total,
    attachmentVerified: verified,
    progress: total ? { processed: verified, total } : null,
    job: row.job_id ? {
      id: row.job_id,
      status: row.job_status,
      attempt: Number(row.package_version || 0),
      expectedFileName: row.expected_file_name,
      errorCode: row.error_code,
      requestedAt: row.requested_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    } : null,
    package: row.package_id ? {
      id: row.package_id,
      fileName: row.package_file_name,
      sha256: row.package_sha256,
      fileSizeBytes: Number(row.package_size || 0),
      itemCount: Number(row.package_item_count || 0),
      publishedAt: row.published_at,
    } : null,
    project: {
      id: row.project_id ?? null,
      name: row.project_name ?? null,
      relativePath: row.project_relative_path ?? null,
      creationStatus: row.project_creation_status ?? null,
      ...project,
    },
    updatedAt: row.updated_at,
  };
}

function baseNoticeSql() {
  return `
    WITH latest_job AS (
      SELECT j.* FROM download_job j
      WHERE j.package_version = (SELECT MAX(j2.package_version) FROM download_job j2 WHERE j2.notice_id = j.notice_id)
    ), latest_package AS (
      SELECT p.* FROM download_package p
      WHERE p.package_version = (SELECT MAX(p2.package_version) FROM download_package p2 WHERE p2.notice_id = p.notice_id)
    )
    SELECT n.id, n.notice_key, n.matter_id, n.matter_reference, n.notice_kind,
      n.progress_sequence, n.notice_date, n.due_date, n.oa_sequence,
      n.rejection_sequence, n.supplement_sequence, n.status AS notice_status,
      n.row_version, n.updated_at,
      (SELECT COUNT(*) FROM notice_mail_link ml WHERE ml.notice_id=n.id) AS mail_count,
      j.id AS job_id, j.status AS job_status, j.package_version, j.expected_file_name,
      j.error_code, j.requested_at, j.started_at, j.completed_at,
      p.id AS package_id, p.file_name AS package_file_name, p.destination_path,
      p.sha256 AS package_sha256, p.file_size_bytes AS package_size,
      p.item_count AS package_item_count, p.published_at,
      (SELECT COUNT(*) FROM notice_attachment a WHERE a.notice_id=n.id AND a.attachment_version=COALESCE(j.attachment_version, 1)) AS attachment_total,
      (SELECT COUNT(*) FROM notice_attachment a WHERE a.notice_id=n.id AND a.attachment_version=COALESCE(j.attachment_version, 1) AND a.state='verified') AS attachment_verified,
      pl.id AS project_id, pl.project_name, pl.project_relative_path,
      pl.creation_status AS project_creation_status,
      ps.stage_key AS project_stage_key, ps.status AS project_stage_status,
      ps.user_action_code, ps.action_summary
    FROM notice n
    LEFT JOIN latest_job j ON j.notice_id=n.id
    LEFT JOIN latest_package p ON p.notice_id=n.id
    LEFT JOIN notice_project_link pl ON pl.notice_id=n.id
    LEFT JOIN notice_project_stage ps ON ps.project_id=pl.id
  `;
}

function loadConfig(): NoticeAutomationConfig {
  const configPath = path.resolve(process.cwd(), 'config', 'notice-automation.json');
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as NoticeAutomationConfig;
  if (parsed.schemaVersion !== 1 || parsed.timezone !== 'Asia/Seoul' || !/^\d{2}:\d{2}$/.test(parsed.dailyRunTime)) {
    throw new WorkDbError('통지 자동화 설정이 올바르지 않습니다.', 500, 'NOTICE_CONFIG_INVALID');
  }
  return parsed;
}

function nextScheduledIso(hourMinute: string) {
  const [hour, minute] = hourMinute.split(':').map(Number);
  const current = new Date();
  const kst = new Date(current.getTime() + 9 * 60 * 60 * 1000);
  let candidate = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), hour - 9, minute, 0));
  if (candidate.getTime() <= current.getTime()) candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  return candidate.toISOString();
}

function kstDayStartIso() {
  const current = new Date();
  const kst = new Date(current.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), -9, 0, 0)).toISOString();
}

export function noticeProjectRoot() {
  return resolveNoticeProjectRoot();
}

export function getDownloadSummary() {
  const config = loadConfig();
  const dayStart = kstDayStartIso();
  return withDatabase((db) => {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN n.status IN ('candidate','ready') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN n.status='downloading' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN n.status='held' THEN 1 ELSE 0 END) AS held,
        SUM(CASE WHEN n.status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM download_package p WHERE p.notice_id=n.id AND p.published_at >= ?) THEN 1 ELSE 0 END) AS published_today
      FROM notice n
    `).get(dayStart) as Row;
    const lastRun = db.prepare('SELECT * FROM notice_detection_run ORDER BY COALESCE(started_at, scheduled_for) DESC LIMIT 1').get() as Row | undefined;
    const earliest = db.prepare(`
      SELECT MIN(mi.mail_at) AS recovery_from
      FROM notice n
      LEFT JOIN notice_mail_link ml ON ml.notice_id=n.id
      LEFT JOIN mail_item mi ON mi.id=ml.mail_id
      WHERE n.status NOT IN ('published','superseded')
    `).get() as Row;
    return {
      automation: {
        schedulerEnabled: config.schedulerEnabled,
        outlookDetectionEnabled: config.outlookDetectionEnabled,
        timezone: config.timezone,
        dailyRunTime: config.dailyRunTime,
        nextScheduledAt: nextScheduledIso(config.dailyRunTime),
        features: config.features,
      },
      lastRun: lastRun ? mapDetectionRun(lastRun) : null,
      recoveryFrom: earliest?.recovery_from ?? lastRun?.recovery_from ?? null,
      counts: {
        total: Number(counts.total || 0),
        pending: Number(counts.pending || 0),
        active: Number(counts.active || 0),
        held: Number(counts.held || 0),
        failed: Number(counts.failed || 0),
        publishedToday: Number(counts.published_today || 0),
      },
    };
  });
}

function mapDetectionRun(row: Row) {
  return {
    id: row.id,
    scheduledFor: row.scheduled_for,
    scheduleDate: row.schedule_date,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    recoveryFrom: row.recovery_from,
    scanTo: row.scan_to,
    status: row.status,
    lastSafeStage: row.last_safe_stage,
    attemptNumber: Number(row.attempt_number),
    detectedMailCount: Number(row.detected_mail_count),
    candidateCount: Number(row.candidate_count),
    resumedCount: Number(row.resumed_count),
    publishedCount: Number(row.published_count),
    heldCount: Number(row.held_count),
    failedCount: Number(row.failed_count),
    errorCode: row.error_code,
  };
}

export function listDetectionRuns(limitValue: unknown = 20) {
  const limit = integer(limitValue, 20, 1, 100);
  return withDatabase((db) => (db.prepare('SELECT * FROM notice_detection_run ORDER BY COALESCE(started_at, scheduled_for) DESC LIMIT ?').all(limit) as Row[]).map(mapDetectionRun));
}

export function listDownloadNotices(filters: { q?: unknown; kind?: unknown; status?: unknown; limit?: unknown; offset?: unknown } = {}) {
  const q = String(filters.q ?? '').trim().slice(0, 100);
  const kind = String(filters.kind ?? '').trim();
  const status = String(filters.status ?? '').trim();
  const allowedKinds = ['', ...Object.keys(kindLabels)];
  const allowedStatuses = ['', 'candidate', 'ready', 'held', 'downloading', 'packaged', 'published', 'failed', 'superseded'];
  if (!allowedKinds.includes(kind) || !allowedStatuses.includes(status)) throw new WorkDbError('다운로드 필터가 올바르지 않습니다.', 400, 'NOTICE_FILTER_INVALID');
  const limit = integer(filters.limit, 50, 1, MAX_PAGE_SIZE);
  const offset = integer(filters.offset, 0, 0, 100_000);
  return withDatabase((db) => {
    const where = ` WHERE (?='' OR n.matter_reference LIKE ?) AND (?='' OR n.notice_kind=?) AND (?='' OR n.status=?)`;
    const values = [q, `%${q}%`, kind, kind, status, status];
    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM notice n${where}`).get(...values) as Row;
    const rows = db.prepare(`${baseNoticeSql()}${where}
      ORDER BY CASE
        WHEN COALESCE(j.status,'') IN ('running','staged','verified') THEN 0
        WHEN n.status IN ('held','failed') THEN 1
        WHEN n.status IN ('candidate','ready') THEN 2
        ELSE 3 END,
        n.updated_at DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as Row[];
    return { total: Number(countRow.n), limit, offset, notices: rows.map(mapNotice) };
  });
}

export function getDownloadNotice(idValue: unknown) {
  const id = required(idValue, '통지 ID', 100);
  return withDatabase((db) => {
    const row = db.prepare(`${baseNoticeSql()} WHERE n.id=?`).get(id) as Row | undefined;
    if (!row) throw new WorkDbError('통지 작업을 찾을 수 없습니다.', 404, 'NOTICE_NOT_FOUND');
    const attachments = db.prepare(`
      SELECT id, attachment_version AS attachmentVersion, source_position AS sourcePosition,
        document_name AS documentName, registered_at AS registeredAt, file_name AS fileName,
        file_size_bytes AS fileSizeBytes, sha256, state, updated_at AS updatedAt
      FROM notice_attachment
      WHERE notice_id=? AND attachment_version=COALESCE((
        SELECT attachment_version FROM download_job WHERE notice_id=?
        ORDER BY package_version DESC LIMIT 1
      ), 1)
      ORDER BY source_position ASC
    `).all(id, id);
    const mails = db.prepare(`
      SELECT mi.id, mi.subject, mi.mail_at AS mailAt, mi.sender_name AS senderName,
        mi.direction, ml.mail_role AS role
      FROM notice_mail_link ml JOIN mail_item mi ON mi.id=ml.mail_id
      WHERE ml.notice_id=? ORDER BY mi.mail_at ASC
    `).all(id);
    const jobs = db.prepare(`
      SELECT id, attachment_version AS attachmentVersion, package_version AS packageVersion,
        expected_file_name AS expectedFileName, status, error_code AS errorCode,
        requested_at AS requestedAt, started_at AS startedAt, completed_at AS completedAt,
        updated_at AS updatedAt
      FROM download_job WHERE notice_id=? ORDER BY package_version DESC
    `).all(id);
    const events = db.prepare(`
      SELECT id, download_job_id AS downloadJobId, run_id AS runId, stage_key AS stageKey,
        status, attempt_number AS attemptNumber, processed_count AS processedCount,
        total_count AS totalCount, error_code AS errorCode, occurred_at AS occurredAt
      FROM notice_pipeline_event WHERE notice_id=? ORDER BY occurred_at ASC
    `).all(id);
    return { notice: mapNotice(row), attachments, mails, jobs, events };
  });
}

export function getDownloadJobEvents(idValue: unknown) {
  const id = required(idValue, '다운로드 작업 ID', 100);
  return withDatabase((db) => {
    const job = db.prepare('SELECT id FROM download_job WHERE id=?').get(id);
    if (!job) throw new WorkDbError('다운로드 작업을 찾을 수 없습니다.', 404, 'DOWNLOAD_JOB_NOT_FOUND');
    return db.prepare(`SELECT id, notice_id AS noticeId, run_id AS runId, stage_key AS stageKey,
      status, attempt_number AS attemptNumber, processed_count AS processedCount,
      total_count AS totalCount, error_code AS errorCode, occurred_at AS occurredAt
      FROM notice_pipeline_event WHERE download_job_id=? ORDER BY occurred_at ASC`).all(id);
  });
}

export function requestNoticeOperation(noticeIdValue: unknown, requestKind: 'recheck' | 'resume', input: Row) {
  const noticeId = required(noticeIdValue, '통지 ID', 100);
  if (!['recheck', 'resume'].includes(requestKind)) throw new WorkDbError('요청 종류가 올바르지 않습니다.', 400, 'NOTICE_REQUEST_KIND_INVALID');
  return withDatabase((db) => transaction(db, () => {
    const notice = db.prepare('SELECT id, status, row_version FROM notice WHERE id=?').get(noticeId) as Row | undefined;
    if (!notice) throw new WorkDbError('통지 작업을 찾을 수 없습니다.', 404, 'NOTICE_NOT_FOUND');
    const expectedVersion = Number(input.expectedVersion);
    if (expectedVersion !== Number(notice.row_version)) throw new WorkDbError('통지 상태가 변경되었습니다. 새로고침 후 다시 요청하세요.', 409, 'NOTICE_VERSION_CONFLICT');
    if (requestKind === 'recheck' && notice.status !== 'held') throw new WorkDbError('확인 필요 상태에서만 다시 검증할 수 있습니다.', 409, 'NOTICE_RECHECK_STATE');
    const job = input.jobId ? db.prepare('SELECT id, status FROM download_job WHERE id=? AND notice_id=?').get(String(input.jobId), noticeId) as Row | undefined : undefined;
    if (requestKind === 'resume' && (!job || !['failed', 'held'].includes(job.status))) throw new WorkDbError('재개 가능한 실패 작업이 아닙니다.', 409, 'NOTICE_RESUME_STATE');
    const id = randomUUID(), timestamp = now();
    try {
      db.prepare(`INSERT INTO notice_operator_request(id,notice_id,download_job_id,request_kind,expected_row_version,input_hash,status,requested_at)
        VALUES (?,?,?,?,?,?,'pending',?)`).run(id, noticeId, job?.id ?? null, requestKind, expectedVersion, input.inputHash ?? null, timestamp);
    } catch (error: any) {
      if (String(error?.message).includes('UNIQUE')) throw new WorkDbError('같은 요청이 이미 처리 대기 중입니다.', 409, 'NOTICE_REQUEST_DUPLICATE');
      throw error;
    }
    return { id, noticeId, jobId: job?.id ?? null, requestKind, status: 'pending', requestedAt: timestamp };
  }));
}

export function requestJobResume(jobIdValue: unknown, input: Row) {
  const jobId = required(jobIdValue, '다운로드 작업 ID', 100);
  const noticeId = withDatabase((db) => {
    const row = db.prepare('SELECT notice_id FROM download_job WHERE id=?').get(jobId) as Row | undefined;
    if (!row) throw new WorkDbError('다운로드 작업을 찾을 수 없습니다.', 404, 'DOWNLOAD_JOB_NOT_FOUND');
    return row.notice_id as string;
  });
  return requestNoticeOperation(noticeId, 'resume', { ...input, jobId });
}

export function createNoticeDetectionRun(input: Row) {
  const scheduledFor = required(input.scheduledFor, '예약 시각', 40);
  const scheduleDate = required(input.scheduleDate, '예약일', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate) || !Number.isFinite(Date.parse(scheduledFor))) throw new WorkDbError('예약 실행 날짜가 올바르지 않습니다.', 400, 'NOTICE_RUN_DATE_INVALID');
  const id = randomUUID(), timestamp = now();
  return withDatabase((db) => {
    db.prepare(`INSERT INTO notice_detection_run(id,scheduled_for,schedule_date,started_at,recovery_from,scan_to,status,last_safe_stage,attempt_number,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'running','enumerating_mail',?,?,?)`).run(id, scheduledFor, scheduleDate, timestamp, input.recoveryFrom ?? null, input.scanTo ?? timestamp, integer(input.attemptNumber, 1, 1, 1000), timestamp, timestamp);
    return mapDetectionRun(db.prepare('SELECT * FROM notice_detection_run WHERE id=?').get(id) as Row);
  });
}

export function recordNoticePipelineEvent(input: Row) {
  const noticeId = required(input.noticeId, '통지 ID', 100);
  const stageKey = required(input.stageKey, '단계', 80);
  const status = required(input.status, '단계 상태', 20);
  if (!['started', 'progress', 'completed', 'held', 'failed', 'reconciled'].includes(status)) throw new WorkDbError('단계 상태가 올바르지 않습니다.', 400, 'NOTICE_EVENT_STATUS_INVALID');
  const idempotencyKey = required(input.idempotencyKey, '멱등 키', 200);
  const id = randomUUID(), timestamp = input.occurredAt && Number.isFinite(Date.parse(input.occurredAt)) ? String(input.occurredAt) : now();
  return withDatabase((db) => {
    db.prepare(`INSERT OR IGNORE INTO notice_pipeline_event(id,notice_id,download_job_id,run_id,stage_key,status,attempt_number,processed_count,total_count,error_code,detail_json,idempotency_key,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, noticeId, input.downloadJobId ?? null, input.runId ?? null, stageKey, status,
        integer(input.attemptNumber, 1, 1, 1000), integer(input.processedCount, 0, 0, 100000), input.totalCount == null ? null : integer(input.totalCount, 0, 0, 100000),
        input.errorCode ?? null, JSON.stringify(input.detail ?? {}), idempotencyKey, timestamp);
    const row = db.prepare('SELECT * FROM notice_pipeline_event WHERE idempotency_key=?').get(idempotencyKey) as Row;
    return { id: row.id, noticeId: row.notice_id, stageKey: row.stage_key, status: row.status, occurredAt: row.occurred_at };
  });
}

function projectSuffix(row: Row) {
  const sequence = sequenceFor(row);
  if (!sequence) throw new WorkDbError('통지 차수가 확정되지 않아 프로젝트를 만들 수 없습니다.', 409, 'NOTICE_SEQUENCE_REQUIRED');
  if (row.notice_kind === 'opinion_submission') return `${sequence}OA`;
  if (row.notice_kind === 'rejection_decision') return `거절결정_${sequence}차`;
  return `우선심사보완_${sequence}차`;
}

function normalizedClientLabel(value: unknown) {
  const label = required(value, '의뢰인식별명', 80).replace(/\s+/g, ' ').trim();
  if (!CLIENT_LABEL_PATTERN.test(label) || label.includes('..') || RESERVED_WINDOWS_NAMES.test(label)) throw new WorkDbError('의뢰인식별명에 사용할 수 없는 문자가 있습니다.', 400, 'PROJECT_CLIENT_LABEL_INVALID');
  return label;
}

function normalizedProjectName(value: unknown, fallback: string, matterReference: string) {
  const name = String(value ?? '').trim() || fallback;
  if (!PROJECT_NAME_PATTERN.test(name) || name.includes('..') || RESERVED_WINDOWS_NAMES.test(name) || !name.toLocaleUpperCase('en-US').startsWith(`${matterReference.toLocaleUpperCase('en-US')}_`)) {
    throw new WorkDbError('프로젝트명은 전체 사건번호로 시작하고 한글·영문·숫자·공백·밑줄·하이픈·괄호·마침표만 사용해야 합니다.', 400, 'PROJECT_NAME_INVALID');
  }
  return name;
}

async function fileSha256(filePath: string) {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function assertPlainDirectory(directory: string, code: string) {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new WorkDbError('프로젝트 기본 폴더를 안전하게 확인할 수 없습니다.', 409, code);
  const actual = await realpath(directory);
  if (path.resolve(actual).toLocaleLowerCase('en-US') !== path.resolve(directory).toLocaleLowerCase('en-US')) throw new WorkDbError('프로젝트 기본 폴더가 예상 경로와 다릅니다.', 409, code);
}

async function rejectReparsePoints(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new WorkDbError('프로젝트 템플릿에 링크 파일이 있어 초기화를 중단했습니다.', 409, 'PROJECT_TEMPLATE_LINK_REJECTED');
    if (entry.isDirectory()) await rejectReparsePoints(candidate);
  }
}

function topLevelYamlValue(content: string, key: string) {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(content);
  if (!match) return null;
  const value = match[1].trim();
  if (value === 'null' || value === '~') return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return null; }
  }
  return value.replace(/^'|'$/g, '').trim();
}

async function inspectExistingProject(directory: string, row: Row, projectName: string) {
  await assertPlainDirectory(directory, 'PROJECT_EXISTING_PATH_INVALID');
  const casePath = path.join(directory, 'case.yaml');
  const caseInfo = await lstat(casePath).catch(() => null);
  if (!caseInfo?.isFile() || caseInfo.isSymbolicLink()) throw new WorkDbError('기존 폴더의 case.yaml을 안전하게 확인할 수 없습니다.', 409, 'PROJECT_EXISTING_CASE_MISSING');
  const content = await readFile(casePath, 'utf8');
  if (topLevelYamlValue(content, 'case_id')?.toLocaleUpperCase('en-US') !== row.matter_reference.toLocaleUpperCase('en-US')) throw new WorkDbError('기존 프로젝트의 사건번호가 통지와 다릅니다.', 409, 'PROJECT_EXISTING_MATTER_MISMATCH');
  const recordedName = topLevelYamlValue(content, 'project_name');
  if (recordedName && recordedName !== projectName) throw new WorkDbError('기존 프로젝트의 case.yaml 프로젝트명이 폴더명과 다릅니다.', 409, 'PROJECT_EXISTING_NAME_MISMATCH');
  const noticeDate = topLevelYamlValue(content, 'office_action_date');
  if (noticeDate && noticeDate !== row.notice_date) throw new WorkDbError('기존 프로젝트의 통지일이 다운로드 원장과 다릅니다.', 409, 'PROJECT_EXISTING_NOTICE_DATE_MISMATCH');
  for (const folder of ['10_source', '30_analysis', '40_strategy', '50_drafts', '60_review', '90_final']) await assertPlainDirectory(path.join(directory, folder), 'PROJECT_EXISTING_STRUCTURE_INVALID');
  return { status: topLevelYamlValue(content, 'status') ?? 'intake' };
}

function existingProjectStage(status: string) {
  if (status === 'completed') return { stageKey: 'completed', stageNumber: 13, stageStatus: 'completed', userActionCode: null, actionSummary: null };
  if (status === 'submitted') return { stageKey: 'submitted', stageNumber: 13, stageStatus: 'active', userActionCode: 'record_filing_receipt', actionSummary: userActionLabels.record_filing_receipt };
  if (status === 'review') return { stageKey: 'review', stageNumber: 10, stageStatus: 'active', userActionCode: 'approve_submission_copy', actionSummary: userActionLabels.approve_submission_copy };
  if (status === 'drafting') return { stageKey: 'drafting', stageNumber: 8, stageStatus: 'active', userActionCode: null, actionSummary: null };
  if (status === 'strategy') return { stageKey: 'strategy', stageNumber: 7, stageStatus: 'active', userActionCode: 'select_strategy', actionSummary: userActionLabels.select_strategy };
  if (status === 'analysis') return { stageKey: 'analysis', stageNumber: 5, stageStatus: 'active', userActionCode: 'confirm_deadline_or_procedure', actionSummary: userActionLabels.confirm_deadline_or_procedure };
  return { stageKey: 'intake', stageNumber: 4, stageStatus: 'active', userActionCode: 'create_intake_task', actionSummary: userActionLabels.create_intake_task };
}

function noticeForProject(db: any, noticeId: string) {
  const row = db.prepare(`${baseNoticeSql()} WHERE n.id=?`).get(noticeId) as Row | undefined;
  if (!row) throw new WorkDbError('통지 작업을 찾을 수 없습니다.', 404, 'NOTICE_NOT_FOUND');
  if (!row.package_id || row.job_status !== 'published' || !row.destination_path || !row.package_sha256) throw new WorkDbError('검증된 ZIP 게시가 완료된 통지만 프로젝트를 만들 수 있습니다.', 409, 'NOTICE_PACKAGE_REQUIRED');
  return row;
}

export async function previewNoticeProject(noticeIdValue: unknown, input: Row) {
  const noticeId = required(noticeIdValue, '통지 ID', 100);
  const clientLabel = normalizedClientLabel(input.clientLabel);
  const root = noticeProjectRoot();
  const template = path.join(root, '_sample_case_project');
  await assertPlainDirectory(root, 'NOTICE_PROJECT_ROOT_INVALID');
  await assertPlainDirectory(template, 'NOTICE_PROJECT_TEMPLATE_INVALID');
  await rejectReparsePoints(template);
  const row = withDatabase((db) => noticeForProject(db, noticeId));
  const fallback = `${row.matter_reference}_${clientLabel.replace(/\s+/g, '')}_${projectSuffix(row)}`;
  const projectName = normalizedProjectName(input.projectName, fallback, row.matter_reference);
  const destination = path.join(root, projectName);
  if (!safeInside(root, destination) || path.dirname(destination).toLocaleLowerCase('en-US') !== root.toLocaleLowerCase('en-US')) throw new WorkDbError('프로젝트 경로가 고정 루트를 벗어납니다.', 400, 'PROJECT_PATH_REJECTED');
  const existingInfo = await lstat(destination).catch(() => null);
  const existingProject = Boolean(existingInfo);
  if (existingProject) await inspectExistingProject(destination, row, projectName);
  else {
    const feature = loadConfig().features[row.notice_kind];
    if (!feature?.projectCreationEnabled) throw new WorkDbError('이 통지 종류의 프로젝트 자동 생성은 검증 전이라 비활성화돼 있습니다.', 409, 'PROJECT_KIND_NOT_ENABLED');
  }
  const packageInfo = await lstat(row.destination_path).catch(() => null);
  if (!packageInfo?.isFile() || packageInfo.isSymbolicLink()) throw new WorkDbError('게시 ZIP을 안전하게 읽을 수 없습니다.', 409, 'PROJECT_PACKAGE_MISSING');
  const actualPackageSha = await fileSha256(row.destination_path);
  if (actualPackageSha !== row.package_sha256) throw new WorkDbError('게시 ZIP의 해시가 원장과 다릅니다.', 409, 'PROJECT_PACKAGE_HASH_MISMATCH');
  const token = randomUUID(), tokenHash = createHash('sha256').update(token).digest('hex'), timestamp = now();
  const project = withDatabase((db) => transaction(db, () => {
    const existing = db.prepare('SELECT * FROM notice_project_link WHERE notice_id=?').get(noticeId) as Row | undefined;
    if (existing && ['created', 'linked_existing', 'creating'].includes(existing.creation_status)) throw new WorkDbError('이 통지는 이미 프로젝트와 연결돼 있습니다.', 409, 'NOTICE_PROJECT_ALREADY_LINKED');
    const id = existing?.id ?? randomUUID();
    if (existing) {
      db.prepare(`UPDATE notice_project_link SET project_name=?,project_relative_path=?,client_label=?,creation_status='previewed',creation_manifest_sha256=NULL,preview_token_hash=?,source_package_sha256=?,row_version=row_version+1,updated_at=? WHERE id=?`)
        .run(projectName, projectName, clientLabel, tokenHash, actualPackageSha, timestamp, id);
    } else {
      db.prepare(`INSERT INTO notice_project_link(id,notice_id,project_name,project_relative_path,client_label,creation_status,preview_token_hash,source_package_sha256,created_at,updated_at)
        VALUES (?,?,?,?,?,'previewed',?,?,?,?)`).run(id, noticeId, projectName, projectName, clientLabel, tokenHash, actualPackageSha, timestamp, timestamp);
    }
    return { id, noticeId, projectName, clientLabel, relativePath: projectName };
  }));
  return {
    ...project,
    previewToken: token,
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    destination,
    template,
    sourcePackage: { fileName: path.basename(row.destination_path), sha256: actualPackageSha, itemCount: Number(row.package_item_count || 0) },
    existingProject,
    notice: { matterReference: row.matter_reference, kind: row.notice_kind, kindLabel: kindLabels[row.notice_kind], sequence: sequenceFor(row), noticeDate: row.notice_date, dueDate: row.due_date },
    codex: { taskTitle: `[CASE] ${row.matter_reference} - 접수`, sharedDirectory: path.join(root, '_shared') },
  };
}

export async function linkExistingNoticeProject(noticeIdValue: unknown, input: Row) {
  const noticeId = required(noticeIdValue, '통지 ID', 100);
  const previewToken = required(input.previewToken, '프로젝트 미리보기 토큰', 100);
  const tokenHash = createHash('sha256').update(previewToken).digest('hex');
  const prepared = withDatabase((db) => {
    const row = noticeForProject(db, noticeId);
    const project = db.prepare('SELECT * FROM notice_project_link WHERE notice_id=?').get(noticeId) as Row | undefined;
    if (!project || project.creation_status !== 'previewed' || project.preview_token_hash !== tokenHash) throw new WorkDbError('프로젝트 미리보기가 만료됐거나 현재 상태와 다릅니다.', 409, 'PROJECT_PREVIEW_INVALID');
    if (Date.now() - Date.parse(project.updated_at) > PREVIEW_TTL_MS) throw new WorkDbError('프로젝트 미리보기가 만료됐습니다. 다시 확인하세요.', 409, 'PROJECT_PREVIEW_EXPIRED');
    if (project.source_package_sha256 !== row.package_sha256) throw new WorkDbError('게시 ZIP이 미리보기 이후 변경됐습니다.', 409, 'PROJECT_PACKAGE_CHANGED');
    return { row, project };
  });
  const root = noticeProjectRoot(), destination = path.join(root, prepared.project.project_relative_path);
  if (!safeInside(root, destination) || path.dirname(destination).toLocaleLowerCase('en-US') !== root.toLocaleLowerCase('en-US')) throw new WorkDbError('프로젝트 경로가 고정 루트를 벗어납니다.', 409, 'PROJECT_PATH_REJECTED');
  const existing = await inspectExistingProject(destination, prepared.row, prepared.project.project_name);
  const stage = existingProjectStage(existing.status);
  return withDatabase((db) => transaction(db, () => {
    const timestamp = now();
    db.prepare(`UPDATE notice_project_link SET creation_status='linked_existing',preview_token_hash=NULL,row_version=row_version+1,updated_at=? WHERE id=? AND creation_status='previewed'`).run(timestamp, prepared.project.id);
    db.prepare(`INSERT INTO notice_project_stage(project_id,stage_key,stage_number,status,user_action_code,action_summary,row_version,updated_at)
      VALUES (?,?,?,?,?,?,1,?)
      ON CONFLICT(project_id) DO UPDATE SET stage_key=excluded.stage_key,stage_number=excluded.stage_number,status=excluded.status,user_action_code=excluded.user_action_code,action_summary=excluded.action_summary,blocked_reason=NULL,row_version=notice_project_stage.row_version+1,updated_at=excluded.updated_at`)
      .run(prepared.project.id, stage.stageKey, stage.stageNumber, stage.stageStatus, stage.userActionCode, stage.actionSummary, timestamp);
    db.prepare(`INSERT OR IGNORE INTO notice_project_event(id,project_id,event_type,before_json,after_json,actor,idempotency_key,created_at)
      VALUES (?,?,'existing_project_linked',NULL,?,'automation',?,?)`)
      .run(randomUUID(), prepared.project.id, JSON.stringify({ relativePath: prepared.project.project_relative_path, caseStatus: existing.status }), `existing-project-linked:${prepared.project.id}`, timestamp);
    return { id: prepared.project.id, noticeId, projectName: prepared.project.project_name, relativePath: prepared.project.project_relative_path, path: destination, status: 'linked_existing', currentStage: stage.stageKey, userActionCode: stage.userActionCode, actionSummary: stage.actionSummary };
  }));
}

function replaceYamlLine(content: string, key: string, value: string) {
  const pattern = new RegExp(`^${key}:.*$`, 'm');
  if (!pattern.test(content)) throw new WorkDbError(`프로젝트 템플릿의 ${key} 필드를 찾을 수 없습니다.`, 409, 'PROJECT_TEMPLATE_SCHEMA_INVALID');
  return content.replace(pattern, `${key}: ${value}`);
}

function initialStatus(row: Row, projectName: string, packageName: string) {
  return `# 사건 상태\n\n- 사건 ID: ${row.matter_reference}\n- 프로젝트: ${projectName}\n- 통지 종류·차수: ${kindLabels[row.notice_kind]} ${sequenceLabel(row)}\n- 통지일 / 마감기일: ${row.notice_date} / ${row.due_date ?? '미확인'}\n- 현재 단계: project_created\n- 자동 다운로드 원본: 00_inbox/${packageName}\n- 사용자 작업: 생성된 폴더를 Codex 로컬 프로젝트로 추가하고 _shared를 연결하세요.\n- 마지막 갱신: ${now()}\n\n## 수신 자료 및 최신 산출물\n\n- 10_source: 자동 다운로드 ZIP의 검증된 추출본\n- 접수 점검: 미작성\n- 90_final 승인 파일: 없음\n\n## 미확인·누락 사항\n\n- 최신 명세서·청구항·선행 대응서 또는 우선심사 신청자료는 접수 작업에서 확인\n- 현재 기일과 절차 상태는 원문 또는 EasyPAT 근거로 확인\n\n## 사람 결정 및 승인 기록\n\n- 프로젝트 폴더 생성 외 전략·문언·제출본·외부 전송 승인 없음\n`;
}

function caseNoticeYaml(row: Row, packageName: string) {
  return `\nnotice:\n  kind: ${row.notice_kind}\n  sequence: ${sequenceFor(row)}\n  notice_date: ${yamlString(row.notice_date)}\n  response_deadline: ${yamlString(row.due_date)}\n  progress_sequence: ${yamlString(row.progress_sequence)}\n  source_package: ${yamlString(`00_inbox/${packageName}`)}\n  source_package_sha256: ${yamlString(row.package_sha256)}\n  source_notice_id: ${yamlString(row.id)}\nworkflow:\n  current_stage: project_created\n  user_action_required: true\n  user_action_code: connect_codex_project\n  action_summary: ${yamlString(userActionLabels.connect_codex_project)}\n`;
}

async function buildProjectFilesystem(row: Row, project: Row) {
  const root = noticeProjectRoot(), template = path.join(root, '_sample_case_project');
  const finalPath = path.join(root, project.project_name);
  const stagingPath = path.join(root, `.${project.project_name}.${randomUUID()}.staging`);
  if (!safeInside(root, stagingPath) || !safeInside(root, finalPath)) throw new WorkDbError('프로젝트 생성 경로가 고정 루트를 벗어납니다.', 409, 'PROJECT_PATH_REJECTED');
  if (await lstat(finalPath).catch(() => null)) throw new WorkDbError('동일한 프로젝트 폴더가 이미 있습니다.', 409, 'PROJECT_DESTINATION_EXISTS');
  const packageName = path.basename(row.destination_path);
  try {
    await cp(template, stagingPath, { recursive: true, force: false, errorOnExist: true });
    const inbox = path.join(stagingPath, '00_inbox'), source = path.join(stagingPath, '10_source');
    await mkdir(inbox, { recursive: true });
    await mkdir(source, { recursive: true });
    if (row.notice_kind === 'rejection_decision') await mkdir(path.join(stagingPath, '30_analysis', 'rejection-decision'), { recursive: true });
    if (row.notice_kind === 'priority_exam_supplement_request') await mkdir(path.join(stagingPath, '30_analysis', 'priority-supplement'), { recursive: true });
    const packageCopy = path.join(inbox, packageName);
    await copyFile(row.destination_path, packageCopy, fsConstants.COPYFILE_EXCL);
    if (await fileSha256(packageCopy) !== row.package_sha256) throw new WorkDbError('프로젝트 ZIP 복사본의 해시가 원장과 다릅니다.', 409, 'PROJECT_PACKAGE_COPY_MISMATCH');
    const script = path.resolve(process.cwd(), 'scripts', 'Expand-VerifiedNoticePackage.ps1');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ZipPath', packageCopy, '-OutputDirectory', source, '-ExpectedSha256', row.package_sha256, '-ExpectedMatterReference', row.matter_reference, '-ExpectedNoticeKind', row.notice_kind], {
      cwd: process.cwd(), windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    const extraction = JSON.parse(stdout.trim());
    let caseYaml = await readFile(path.join(stagingPath, 'case.yaml'), 'utf8');
    caseYaml = replaceYamlLine(caseYaml, 'case_id', yamlString(row.matter_reference));
    caseYaml = replaceYamlLine(caseYaml, 'project_name', yamlString(project.project_name));
    caseYaml = replaceYamlLine(caseYaml, 'client', yamlString(project.client_label));
    caseYaml = replaceYamlLine(caseYaml, 'office_action_date', yamlString(row.notice_date));
    caseYaml = replaceYamlLine(caseYaml, 'response_deadline', yamlString(row.due_date));
    caseYaml = replaceYamlLine(caseYaml, 'status', 'intake');
    caseYaml += caseNoticeYaml(row, packageName);
    await writeFile(path.join(stagingPath, 'case.yaml'), caseYaml, { encoding: 'utf8', flag: 'w' });
    await writeFile(path.join(stagingPath, 'STATUS.md'), initialStatus(row, project.project_name, packageName), { encoding: 'utf8', flag: 'w' });
    const logDir = path.join(stagingPath, '99_logs');
    await mkdir(logDir, { recursive: true });
    const date = now().slice(0, 10);
    await writeFile(path.join(logDir, `${date}_프로젝트초기화.md`), `# 프로젝트 초기화\n\n- 통지 ID: ${row.id}\n- 사건번호: ${row.matter_reference}\n- 통지 종류: ${row.notice_kind}\n- 원본 ZIP: ${packageName}\n- ZIP SHA-256: ${row.package_sha256}\n- 추출 항목 수: ${extraction.itemCount}\n- 생성 시각: ${now()}\n- 외부 제출·전송: 수행하지 않음\n`, { encoding: 'utf8', flag: 'wx' });
    const manifest = {
      schemaVersion: 1,
      noticeId: row.id,
      noticeKey: row.notice_key,
      matterReference: row.matter_reference,
      noticeKind: row.notice_kind,
      sequence: sequenceFor(row),
      sourcePackage: packageName,
      sourcePackageSha256: row.package_sha256,
      extractedItemCount: extraction.itemCount,
      createdAt: now(),
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = path.join(stagingPath, 'project-creation-manifest.json');
    await writeFile(manifestPath, manifestText, { encoding: 'utf8', flag: 'wx' });
    const manifestSha256 = createHash('sha256').update(manifestText).digest('hex');
    await rename(stagingPath, finalPath);
    return { finalPath, manifestSha256, extraction };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createNoticeProject(noticeIdValue: unknown, input: Row) {
  const noticeId = required(noticeIdValue, '통지 ID', 100);
  const previewToken = required(input.previewToken, '프로젝트 미리보기 토큰', 100);
  const tokenHash = createHash('sha256').update(previewToken).digest('hex');
  const prepared = withDatabase((db) => transaction(db, () => {
    const row = noticeForProject(db, noticeId);
    const project = db.prepare('SELECT * FROM notice_project_link WHERE notice_id=?').get(noticeId) as Row | undefined;
    if (!project || project.creation_status !== 'previewed' || project.preview_token_hash !== tokenHash) throw new WorkDbError('프로젝트 미리보기가 만료됐거나 현재 상태와 다릅니다.', 409, 'PROJECT_PREVIEW_INVALID');
    if (Date.now() - Date.parse(project.updated_at) > PREVIEW_TTL_MS) throw new WorkDbError('프로젝트 미리보기가 만료됐습니다. 다시 확인하세요.', 409, 'PROJECT_PREVIEW_EXPIRED');
    if (project.source_package_sha256 !== row.package_sha256) throw new WorkDbError('게시 ZIP이 미리보기 이후 변경됐습니다.', 409, 'PROJECT_PACKAGE_CHANGED');
    db.prepare(`UPDATE notice_project_link SET creation_status='creating',row_version=row_version+1,updated_at=? WHERE id=?`).run(now(), project.id);
    return { row, project };
  }));
  try {
    const result = await buildProjectFilesystem(prepared.row, prepared.project);
    return withDatabase((db) => transaction(db, () => {
      const timestamp = now();
      db.prepare(`UPDATE notice_project_link SET creation_status='created',creation_manifest_sha256=?,preview_token_hash=NULL,row_version=row_version+1,updated_at=? WHERE id=? AND creation_status='creating'`)
        .run(result.manifestSha256, timestamp, prepared.project.id);
      db.prepare(`INSERT INTO notice_project_stage(project_id,stage_key,stage_number,status,user_action_code,action_summary,row_version,updated_at)
        VALUES (?,'project_created',3,'active','connect_codex_project',?,1,?)
        ON CONFLICT(project_id) DO UPDATE SET stage_key='project_created',stage_number=3,status='active',user_action_code='connect_codex_project',action_summary=excluded.action_summary,blocked_reason=NULL,row_version=notice_project_stage.row_version+1,updated_at=excluded.updated_at`)
        .run(prepared.project.id, userActionLabels.connect_codex_project, timestamp);
      const eventKey = `project-created:${prepared.project.id}:${result.manifestSha256}`;
      db.prepare(`INSERT OR IGNORE INTO notice_project_event(id,project_id,event_type,before_json,after_json,actor,idempotency_key,created_at)
        VALUES (?,?, 'project_created', NULL, ?, 'automation', ?, ?)`)
        .run(randomUUID(), prepared.project.id, JSON.stringify({ relativePath: prepared.project.project_relative_path, manifestSha256: result.manifestSha256 }), eventKey, timestamp);
      return {
        id: prepared.project.id,
        noticeId,
        projectName: prepared.project.project_name,
        relativePath: prepared.project.project_relative_path,
        path: result.finalPath,
        status: 'created',
        currentStage: 'project_created',
        userActionCode: 'connect_codex_project',
        actionSummary: userActionLabels.connect_codex_project,
        taskTitle: `[CASE] ${prepared.row.matter_reference} - 접수`,
      };
    }));
  } catch (error) {
    withDatabase((db) => db.prepare(`UPDATE notice_project_link SET creation_status='failed',preview_token_hash=NULL,row_version=row_version+1,updated_at=? WHERE id=?`).run(now(), prepared.project.id));
    throw error;
  }
}
