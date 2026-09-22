import { constants as fsConstants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { noticeProjectRoot } from './notice-downloads';
import { defaultResponseAction, responseStageKey, responseStages, type ResponseNoticeKind } from './notice-response-workflow';
import { transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;
type ResponseFilters = { q?: unknown; kind?: unknown; stage?: unknown; userAction?: unknown; limit?: unknown; offset?: unknown };

const responseKinds = new Set<ResponseNoticeKind>(['opinion_submission', 'rejection_decision']);
const kindLabels: Record<ResponseNoticeKind, string> = { opinion_submission: '의견제출통지서', rejection_decision: '거절결정서' };
const MAX_PAGE_SIZE = 100;

function now() { return new Date().toISOString(); }

function required(value: unknown, label: string, maximum = 500) {
  const result = String(value ?? '').trim();
  if (!result) throw new WorkDbError(`${label}을(를) 입력하세요.`, 400, 'RESPONSE_INPUT_REQUIRED');
  if (result.length > maximum) throw new WorkDbError(`${label}이(가) 너무 깁니다.`, 400, 'RESPONSE_INPUT_TOO_LONG');
  return result;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function safeInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function sha256(filePath: string) {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function responseBaseSql() {
  return `
    WITH latest_package AS (
      SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.notice_id ORDER BY p.package_version DESC) AS rn
      FROM download_package p
    )
    SELECT n.id AS notice_id,n.matter_reference,n.notice_kind,n.notice_date,n.due_date,
      n.oa_sequence,n.rejection_sequence,n.status AS notice_status,n.updated_at AS notice_updated_at,
      p.id AS package_id,p.file_name AS package_file_name,p.destination_path,p.sha256 AS package_sha256,
      p.item_count AS package_item_count,p.published_at,
      pl.id AS project_id,pl.project_name,pl.project_relative_path,pl.client_label,
      pl.creation_status,pl.row_version AS project_row_version,pl.updated_at AS project_updated_at,
      ps.stage_key,ps.stage_number,ps.status AS stage_status,ps.user_action_code,ps.action_summary,
      ps.blocked_reason,ps.last_reconciled_at,ps.row_version AS stage_row_version,ps.updated_at AS stage_updated_at
    FROM notice n
    JOIN latest_package p ON p.notice_id=n.id AND p.rn=1
    LEFT JOIN notice_project_link pl ON pl.notice_id=n.id
    LEFT JOIN notice_project_stage ps ON ps.project_id=pl.id
  `;
}

function sequence(row: Row) {
  return row.notice_kind === 'opinion_submission' ? Number(row.oa_sequence || 0) || null : Number(row.rejection_sequence || 0) || null;
}

function currentStage(row: Row) {
  if (!row.project_id) return 1;
  if (['previewed', 'creating'].includes(row.creation_status)) return 2;
  return integer(row.stage_number, 3, 1, 13);
}

function currentAction(row: Row, stageNumber: number) {
  if (row.user_action_code || row.action_summary) return { code: row.user_action_code ?? null, summary: row.action_summary ?? null };
  return defaultResponseAction(stageNumber);
}

function mapResponse(row: Row) {
  const kind = row.notice_kind as ResponseNoticeKind;
  const stageNumber = currentStage(row);
  const completed = row.stage_status === 'completed' || row.stage_key === 'completed';
  const blocked = row.stage_status === 'held' || Boolean(row.blocked_reason);
  const action = currentAction(row, stageNumber);
  const definitions = responseStages(kind);
  return {
    noticeId: row.notice_id,
    projectId: row.project_id ?? null,
    rowVersion: Number(row.stage_row_version ?? row.project_row_version ?? 1),
    matterReference: row.matter_reference,
    kind,
    kindLabel: kindLabels[kind],
    sequence: sequence(row),
    sequenceLabel: kind === 'opinion_submission' ? `${sequence(row) ?? '?'}OA` : `거절결정 ${sequence(row) ?? '?'}차`,
    noticeDate: row.notice_date,
    dueDate: row.due_date,
    package: { id: row.package_id, fileName: row.package_file_name, sha256: row.package_sha256, itemCount: Number(row.package_item_count), publishedAt: row.published_at },
    project: row.project_id ? { id: row.project_id, name: row.project_name, relativePath: row.project_relative_path, clientLabel: row.client_label, creationStatus: row.creation_status } : null,
    workflow: {
      currentStage: stageNumber,
      totalStages: 13,
      completed,
      blocked,
      blockedReason: row.blocked_reason ?? null,
      userActionCode: action.code,
      actionSummary: action.summary,
      lastReconciledAt: row.last_reconciled_at ?? null,
      stages: definitions.map((stage) => ({
        ...stage,
        status: completed || stage.number < stageNumber ? '완료' : stage.number > stageNumber ? '대기' : blocked ? '차단' : (action.code || stage.userAction) ? '사용자 작업 필요' : '현재',
      })),
    },
    updatedAt: row.stage_updated_at ?? row.project_updated_at ?? row.notice_updated_at,
  };
}

function getResponseRow(db: any, noticeId: string) {
  const row = db.prepare(`${responseBaseSql()} WHERE n.id=? AND n.notice_kind IN ('opinion_submission','rejection_decision')`).get(noticeId) as Row | undefined;
  if (!row) throw new WorkDbError('대응 프로젝트를 찾을 수 없습니다.', 404, 'RESPONSE_PROJECT_NOT_FOUND');
  return row;
}

export function getResponseSummary() {
  return withDatabase((db) => {
    const rows = db.prepare(`${responseBaseSql()} WHERE n.notice_kind IN ('opinion_submission','rejection_decision')`).all() as Row[];
    const mapped = rows.map(mapResponse);
    return {
      total: mapped.length,
      userAction: mapped.filter((item) => Boolean(item.workflow.userActionCode) && !item.workflow.completed).length,
      active: mapped.filter((item) => !item.workflow.completed && !item.workflow.blocked && !item.workflow.userActionCode).length,
      held: mapped.filter((item) => item.workflow.blocked).length,
      completed: mapped.filter((item) => item.workflow.completed).length,
    };
  });
}

export function listResponseProjects(filters: ResponseFilters = {}) {
  const q = String(filters.q ?? '').trim().slice(0, 100);
  const kind = String(filters.kind ?? '').trim();
  const stage = String(filters.stage ?? '').trim();
  const userAction = String(filters.userAction ?? '').trim();
  if (kind && !responseKinds.has(kind as ResponseNoticeKind)) throw new WorkDbError('대응 종류 필터가 올바르지 않습니다.', 400, 'RESPONSE_FILTER_INVALID');
  if (stage && (!Number.isInteger(Number(stage)) || Number(stage) < 1 || Number(stage) > 13)) throw new WorkDbError('단계 필터가 올바르지 않습니다.', 400, 'RESPONSE_FILTER_INVALID');
  if (userAction && !['true', 'false'].includes(userAction)) throw new WorkDbError('사용자 작업 필터가 올바르지 않습니다.', 400, 'RESPONSE_FILTER_INVALID');
  const limit = integer(filters.limit, 50, 1, MAX_PAGE_SIZE), offset = integer(filters.offset, 0, 0, 100_000);
  return withDatabase((db) => {
    const rows = db.prepare(`${responseBaseSql()} WHERE n.notice_kind IN ('opinion_submission','rejection_decision') ORDER BY COALESCE(ps.updated_at,pl.updated_at,n.updated_at) DESC`).all() as Row[];
    let items = rows.map(mapResponse).filter((item) => (!q || item.matterReference.toLocaleLowerCase().includes(q.toLocaleLowerCase()) || item.project?.name?.toLocaleLowerCase().includes(q.toLocaleLowerCase())) && (!kind || item.kind === kind) && (!stage || item.workflow.currentStage === Number(stage)) && (!userAction || Boolean(item.workflow.userActionCode) === (userAction === 'true')));
    const total = items.length;
    items = items.slice(offset, offset + limit);
    return { total, limit, offset, projects: items };
  });
}

export function getResponseProject(noticeIdValue: unknown) {
  const noticeId = required(noticeIdValue, '통지 ID', 100);
  return withDatabase((db) => {
    const row = getResponseRow(db, noticeId), response = mapResponse(row);
    if (!row.project_id) return { response, artifacts: [], approvals: [], taskLinks: [], events: [] };
    const artifacts = db.prepare(`SELECT id,stage_number AS stageNumber,artifact_kind AS artifactKind,relative_path AS relativePath,artifact_version AS version,sha256,state,source_type AS sourceType,created_at AS createdAt,updated_at AS updatedAt FROM notice_project_artifact WHERE project_id=? ORDER BY stage_number,updated_at DESC`).all(row.project_id);
    const approvals = db.prepare(`SELECT id,approval_kind AS approvalKind,decision,target_artifact_id AS targetArtifactId,target_relative_path AS targetRelativePath,target_version AS targetVersion,target_sha256 AS targetSha256,scope_json AS scopeJson,actor,created_at AS createdAt FROM notice_project_approval WHERE project_id=? ORDER BY created_at DESC`).all(row.project_id).map((approval: Row) => ({ ...approval, scope: JSON.parse(approval.scopeJson || '{}'), scopeJson: undefined }));
    const taskLinks = db.prepare(`SELECT id,task_kind AS taskKind,task_title AS taskTitle,external_task_id AS externalTaskId,status,created_at AS createdAt,updated_at AS updatedAt FROM notice_project_task_link WHERE project_id=? ORDER BY created_at`).all(row.project_id);
    const events = db.prepare(`SELECT id,event_type AS eventType,after_json AS afterJson,actor,created_at AS createdAt FROM notice_project_event WHERE project_id=? ORDER BY created_at DESC LIMIT 100`).all(row.project_id).map((event: Row) => ({ ...event, after: JSON.parse(event.afterJson || '{}'), afterJson: undefined }));
    return { response, artifacts, approvals, taskLinks, events };
  });
}

async function projectContext(noticeId: string) {
  const row = withDatabase((db) => getResponseRow(db, noticeId));
  if (!row.project_id || !['created', 'linked_existing'].includes(row.creation_status)) throw new WorkDbError('초기화 또는 연결이 완료된 프로젝트가 아닙니다.', 409, 'RESPONSE_PROJECT_NOT_READY');
  const root = noticeProjectRoot(), directory = path.join(root, row.project_relative_path);
  if (!safeInside(root, directory) || path.dirname(directory).toLocaleLowerCase('en-US') !== root.toLocaleLowerCase('en-US')) throw new WorkDbError('프로젝트 경로가 고정 루트를 벗어납니다.', 409, 'RESPONSE_PROJECT_PATH_REJECTED');
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new WorkDbError('프로젝트 폴더를 안전하게 확인할 수 없습니다.', 409, 'RESPONSE_PROJECT_PATH_INVALID');
  const actual = await realpath(directory);
  if (path.resolve(actual).toLocaleLowerCase('en-US') !== path.resolve(directory).toLocaleLowerCase('en-US')) throw new WorkDbError('프로젝트 폴더의 실제 경로가 다릅니다.', 409, 'RESPONSE_PROJECT_PATH_INVALID');
  return { row, root, directory };
}

function safeRelativePath(value: unknown) {
  const relative = required(value, '산출물 상대경로', 500).replaceAll('/', path.sep);
  if (path.isAbsolute(relative) || relative.split(path.sep).some((part) => part === '..' || !part)) throw new WorkDbError('프로젝트 내부 상대경로만 사용할 수 있습니다.', 400, 'RESPONSE_ARTIFACT_PATH_INVALID');
  return relative;
}

async function verifiedArtifact(directory: string, relativeValue: unknown) {
  const relativePath = safeRelativePath(relativeValue), candidate = path.resolve(directory, relativePath);
  if (!safeInside(directory, candidate)) throw new WorkDbError('산출물 경로가 프로젝트를 벗어납니다.', 400, 'RESPONSE_ARTIFACT_PATH_INVALID');
  const info = await lstat(candidate).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new WorkDbError('산출물 파일을 안전하게 확인할 수 없습니다.', 409, 'RESPONSE_ARTIFACT_MISSING');
  const actual = await realpath(candidate);
  if (!safeInside(directory, actual)) throw new WorkDbError('산출물 실제 경로가 프로젝트를 벗어납니다.', 409, 'RESPONSE_ARTIFACT_PATH_INVALID');
  return { relativePath: relativePath.split(path.sep).join('/'), fullPath: candidate, sha256: await sha256(candidate), size: info.size };
}

function insertArtifact(db: any, input: { projectId: string; stageNumber: number; artifactKind: string; relativePath: string; version?: string | null; sha256: string; state?: string; sourceType?: string }, timestamp: string) {
  const existing = db.prepare('SELECT id FROM notice_project_artifact WHERE project_id=? AND artifact_kind=? AND relative_path=? AND sha256=?').get(input.projectId, input.artifactKind, input.relativePath, input.sha256) as Row | undefined;
  if (existing) {
    db.prepare('UPDATE notice_project_artifact SET state=?,updated_at=? WHERE id=?').run(input.state ?? 'verified', timestamp, existing.id);
    return existing.id as string;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO notice_project_artifact(id,project_id,stage_number,artifact_kind,relative_path,artifact_version,sha256,state,source_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.projectId, input.stageNumber, input.artifactKind, input.relativePath, input.version ?? null, input.sha256, input.state ?? 'verified', input.sourceType ?? 'user', timestamp, timestamp);
  return id;
}

function stageRecord(db: any, projectId: string) {
  const stage = db.prepare('SELECT * FROM notice_project_stage WHERE project_id=?').get(projectId) as Row | undefined;
  if (!stage) throw new WorkDbError('프로젝트 단계 원장을 찾을 수 없습니다.', 409, 'RESPONSE_STAGE_MISSING');
  return stage;
}

function nextStageUpdate(db: any, projectId: string, nextNumber: number, timestamp: string, completed = false) {
  const action = completed ? { code: null, summary: null } : defaultResponseAction(nextNumber);
  db.prepare(`UPDATE notice_project_stage SET stage_key=?,stage_number=?,status=?,user_action_code=?,action_summary=?,blocked_reason=NULL,row_version=row_version+1,updated_at=? WHERE project_id=?`)
    .run(completed ? 'completed' : responseStageKey(nextNumber), nextNumber, completed ? 'completed' : 'active', action.code, action.summary, timestamp, projectId);
}

function yamlValue(value: string | null) { return value === null ? 'null' : JSON.stringify(value); }

function updateWorkflowYaml(content: string, stageNumber: number, stageKey: string, action: { code: string | null; summary: string | null }) {
  let result = content;
  if (!/^workflow:\s*$/m.test(result)) result = `${result.trimEnd()}\nworkflow:\n`;
  const values: Record<string, string> = {
    current_stage: stageKey,
    stage_number: String(stageNumber),
    user_action_required: action.code ? 'true' : 'false',
    user_action_code: yamlValue(action.code),
    action_summary: yamlValue(action.summary),
  };
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^(  ${key}:).*$`, 'm');
    if (pattern.test(result)) result = result.replace(pattern, `$1 ${value}`);
    else result = result.replace(/^workflow:\s*$/m, (line) => `${line}\n  ${key}: ${value}`);
  }
  return `${result.trimEnd()}\n`;
}

function updateStatusMarkdown(content: string, stageNumber: number, title: string, action: { code: string | null; summary: string | null }, timestamp: string) {
  const replacements: Array<[RegExp, string]> = [
    [/^- 현재 단계:.*$/m, `- 현재 단계: ${String(stageNumber).padStart(2, '0')}/13 ${title}`],
    [/^- 사용자 작업:.*$/m, `- 사용자 작업: ${action.summary ?? '없음'}`],
    [/^- 마지막 갱신:.*$/m, `- 마지막 갱신: ${timestamp}`],
  ];
  let result = content;
  for (const [pattern, line] of replacements) result = pattern.test(result) ? result.replace(pattern, line) : `${result.trimEnd()}\n${line}\n`;
  return `${result.trimEnd()}\n`;
}

async function syncStateFiles(context: Awaited<ReturnType<typeof projectContext>>, stageNumber: number, completed = false) {
  const kind = context.row.notice_kind as ResponseNoticeKind;
  const definition = responseStages(kind).find((stage) => stage.number === stageNumber)!;
  const stageKey = completed ? 'completed' : responseStageKey(stageNumber), action = completed ? { code: null, summary: null } : defaultResponseAction(stageNumber);
  const casePath = path.join(context.directory, 'case.yaml'), statusPath = path.join(context.directory, 'STATUS.md');
  for (const candidate of [casePath, statusPath]) {
    const info = await lstat(candidate).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new WorkDbError('case.yaml과 STATUS.md를 안전하게 확인할 수 없습니다.', 409, 'RESPONSE_STATE_FILE_MISSING');
  }
  const timestamp = now();
  const [caseContent, statusContent] = await Promise.all([readFile(casePath, 'utf8'), readFile(statusPath, 'utf8')]);
  await writeFile(casePath, updateWorkflowYaml(caseContent, stageNumber, stageKey, action), 'utf8');
  await writeFile(statusPath, updateStatusMarkdown(statusContent, stageNumber, definition.title, action, timestamp), 'utf8');
}

function recordProjectEvent(db: any, projectId: string, eventType: string, after: unknown, actor: string, timestamp: string) {
  db.prepare(`INSERT INTO notice_project_event(id,project_id,event_type,before_json,after_json,actor,idempotency_key,created_at) VALUES (?,?,?,NULL,?,?,?,?)`)
    .run(randomUUID(), projectId, eventType, JSON.stringify(after), actor, `${eventType}:${projectId}:${randomUUID()}`, timestamp);
}

async function markFileSyncFailure(projectId: string, error: unknown) {
  const timestamp = now();
  withDatabase((db) => transaction(db, () => {
    db.prepare(`UPDATE notice_project_stage SET status='held',blocked_reason='STATE_FILE_SYNC_FAILED',user_action_code='confirm_deadline_or_procedure',action_summary='case.yaml 또는 STATUS.md 갱신에 실패했습니다. 상태 파일을 확인하세요.',row_version=row_version+1,updated_at=? WHERE project_id=?`).run(timestamp, projectId);
    recordProjectEvent(db, projectId, 'state_file_sync_failed', { code: error instanceof Error ? error.message : 'STATE_FILE_SYNC_FAILED' }, 'automation', timestamp);
  }));
}

export async function linkResponseTask(noticeIdValue: unknown, input: Row) {
  const noticeId = required(noticeIdValue, '통지 ID', 100), context = await projectContext(noticeId);
  const taskTitle = required(input.taskTitle, '작업 제목', 200), externalTaskId = String(input.externalTaskId ?? '').trim().slice(0, 200) || null;
  const result = withDatabase((db) => transaction(db, () => {
    const stage = stageRecord(db, context.row.project_id);
    if (Number(input.expectedVersion) !== Number(stage.row_version)) throw new WorkDbError('프로젝트 단계가 변경되었습니다. 새로고침 후 다시 시도하세요.', 409, 'RESPONSE_VERSION_CONFLICT');
    if (Number(stage.stage_number) !== 3 || stage.status === 'completed') throw new WorkDbError('현재는 접수 작업 연결 단계가 아닙니다.', 409, 'RESPONSE_STAGE_CONFLICT');
    const timestamp = now(), id = (db.prepare(`SELECT id FROM notice_project_task_link WHERE project_id=? AND task_kind='intake'`).get(context.row.project_id) as Row | undefined)?.id ?? randomUUID();
    db.prepare(`INSERT INTO notice_project_task_link(id,project_id,task_kind,task_title,external_task_id,status,created_at,updated_at) VALUES (?,?,'intake',?,?,'linked',?,?) ON CONFLICT(project_id,task_kind) DO UPDATE SET task_title=excluded.task_title,external_task_id=excluded.external_task_id,status='linked',updated_at=excluded.updated_at`)
      .run(id, context.row.project_id, taskTitle, externalTaskId, timestamp, timestamp);
    nextStageUpdate(db, context.row.project_id, 4, timestamp);
    recordProjectEvent(db, context.row.project_id, 'intake_task_linked', { taskTitle, externalTaskId, nextStage: 4 }, '장진태', timestamp);
    return { projectId: context.row.project_id, currentStage: 4, taskTitle, externalTaskId };
  }));
  try { await syncStateFiles(context, 4); } catch (error) { await markFileSyncFailure(context.row.project_id, error); throw error; }
  return result;
}

export async function completeResponseStage(noticeIdValue: unknown, stageValue: unknown, input: Row) {
  const noticeId = required(noticeIdValue, '통지 ID', 100), stageNumber = integer(stageValue, 0, 0, 13), context = await projectContext(noticeId);
  const allowed = new Set([4, 5, 6, 8, 9, 10, 13]);
  if (!allowed.has(stageNumber)) throw new WorkDbError('이 단계는 전용 사용자 동작으로 완료해야 합니다.', 409, 'RESPONSE_STAGE_ACTION_REQUIRED');
  const definition = responseStages(context.row.notice_kind).find((stage) => stage.number === stageNumber)!;
  const artifact = await verifiedArtifact(context.directory, input.artifactPath);
  const result = withDatabase((db) => transaction(db, () => {
    const stage = stageRecord(db, context.row.project_id);
    if (Number(input.expectedVersion) !== Number(stage.row_version)) throw new WorkDbError('프로젝트 단계가 변경되었습니다. 새로고침 후 다시 시도하세요.', 409, 'RESPONSE_VERSION_CONFLICT');
    if (Number(stage.stage_number) !== stageNumber || stage.status === 'completed') throw new WorkDbError('현재 단계와 완료 요청이 일치하지 않습니다.', 409, 'RESPONSE_STAGE_CONFLICT');
    const timestamp = now();
    const artifactId = insertArtifact(db, { projectId: context.row.project_id, stageNumber, artifactKind: definition.artifactKind ?? definition.key, relativePath: artifact.relativePath, version: String(input.version ?? '').trim() || null, sha256: artifact.sha256 }, timestamp);
    const completed = stageNumber === 13, nextStage = completed ? 13 : stageNumber + 1;
    nextStageUpdate(db, context.row.project_id, nextStage, timestamp, completed);
    if (completed) db.prepare(`INSERT INTO notice_project_approval(id,project_id,approval_kind,decision,target_artifact_id,target_relative_path,target_version,target_sha256,scope_json,actor,created_at) VALUES (?,?,'filing_receipt','approved',?,?,?,?,?,'장진태',?)`).run(randomUUID(), context.row.project_id, artifactId, artifact.relativePath, String(input.version ?? '').trim() || null, artifact.sha256, JSON.stringify({ submittedAt: input.submittedAt ?? null }), timestamp);
    recordProjectEvent(db, context.row.project_id, completed ? 'response_completed' : 'response_stage_completed', { stageNumber, artifactId, relativePath: artifact.relativePath, sha256: artifact.sha256, nextStage }, '장진태', timestamp);
    return { projectId: context.row.project_id, completedStage: stageNumber, currentStage: nextStage, completed, artifact: { id: artifactId, ...artifact } };
  }));
  try { await syncStateFiles(context, result.currentStage, result.completed); } catch (error) { await markFileSyncFailure(context.row.project_id, error); throw error; }
  return result;
}

const approvalStage: Record<string, number> = { strategy_selection: 7, submission_copy: 11, external_dispatch: 12 };

export async function recordResponseApproval(noticeIdValue: unknown, input: Row) {
  const noticeId = required(noticeIdValue, '통지 ID', 100), approvalKind = required(input.approvalKind, '승인 종류', 50), context = await projectContext(noticeId);
  const expectedStage = approvalStage[approvalKind];
  if (!expectedStage) throw new WorkDbError('지원하지 않는 승인 종류입니다.', 400, 'RESPONSE_APPROVAL_KIND_INVALID');
  const artifact = await verifiedArtifact(context.directory, input.targetPath);
  const prefix = expectedStage === 7 ? '40_strategy/' : expectedStage === 11 ? '50_drafts/' : '90_final/';
  if (!artifact.relativePath.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) throw new WorkDbError(`승인 대상은 ${prefix} 아래 파일이어야 합니다.`, 400, 'RESPONSE_APPROVAL_PATH_INVALID');
  const selection = String(input.selection ?? '').trim();
  if (expectedStage === 7 && !selection) throw new WorkDbError('선택한 전략 또는 대응 경로를 입력하세요.', 400, 'RESPONSE_APPROVAL_SCOPE_REQUIRED');
  const submittedAt = String(input.submittedAt ?? '').trim();
  if (expectedStage === 12 && (!submittedAt || !Number.isFinite(Date.parse(submittedAt)))) throw new WorkDbError('실제 제출 시각을 입력하세요.', 400, 'RESPONSE_SUBMITTED_AT_REQUIRED');

  let promoted: { relativePath: string; fullPath: string; created: boolean } | null = null;
  if (expectedStage === 11) {
    const finalDirectory = path.join(context.directory, '90_final');
    await mkdir(finalDirectory, { recursive: true });
    const finalPath = path.join(finalDirectory, path.basename(artifact.fullPath));
    const finalRelative = `90_final/${path.basename(artifact.fullPath)}`;
    const existing = await lstat(finalPath).catch(() => null);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || await sha256(finalPath) !== artifact.sha256) throw new WorkDbError('90_final에 다른 내용의 같은 이름 파일이 있습니다.', 409, 'RESPONSE_FINAL_CONFLICT');
      promoted = { relativePath: finalRelative, fullPath: finalPath, created: false };
    } else {
      await copyFile(artifact.fullPath, finalPath, fsConstants.COPYFILE_EXCL);
      if (await sha256(finalPath) !== artifact.sha256) { await rm(finalPath, { force: true }); throw new WorkDbError('최종본 승격 파일의 해시가 다릅니다.', 409, 'RESPONSE_FINAL_HASH_MISMATCH'); }
      promoted = { relativePath: finalRelative, fullPath: finalPath, created: true };
    }
  }

  try {
    const result = withDatabase((db) => transaction(db, () => {
      const stage = stageRecord(db, context.row.project_id);
      if (Number(input.expectedVersion) !== Number(stage.row_version)) throw new WorkDbError('프로젝트 단계가 변경되었습니다. 새로고침 후 다시 시도하세요.', 409, 'RESPONSE_VERSION_CONFLICT');
      if (Number(stage.stage_number) !== expectedStage || stage.status === 'completed') throw new WorkDbError('현재 단계와 승인 종류가 일치하지 않습니다.', 409, 'RESPONSE_STAGE_CONFLICT');
      const timestamp = now();
      const artifactId = insertArtifact(db, { projectId: context.row.project_id, stageNumber: expectedStage, artifactKind: approvalKind, relativePath: artifact.relativePath, version: String(input.version ?? '').trim() || null, sha256: artifact.sha256, state: 'approved' }, timestamp);
      let promotedArtifactId: string | null = null;
      if (promoted) promotedArtifactId = insertArtifact(db, { projectId: context.row.project_id, stageNumber: 12, artifactKind: 'final_submission_copy', relativePath: promoted.relativePath, version: String(input.version ?? '').trim() || null, sha256: artifact.sha256, state: 'approved', sourceType: 'automation' }, timestamp);
      const approvalId = randomUUID(), scope = { selection: selection || null, submittedAt: submittedAt || null, promotedArtifactId, note: String(input.note ?? '').trim().slice(0, 2000) || null };
      db.prepare(`INSERT INTO notice_project_approval(id,project_id,approval_kind,decision,target_artifact_id,target_relative_path,target_version,target_sha256,scope_json,actor,created_at) VALUES (?,?,?,'approved',?,?,?,?,?,'장진태',?)`)
        .run(approvalId, context.row.project_id, approvalKind, artifactId, artifact.relativePath, String(input.version ?? '').trim() || null, artifact.sha256, JSON.stringify(scope), timestamp);
      const nextStage = expectedStage + 1;
      nextStageUpdate(db, context.row.project_id, nextStage, timestamp);
      recordProjectEvent(db, context.row.project_id, 'response_approval_recorded', { approvalId, approvalKind, target: artifact.relativePath, sha256: artifact.sha256, nextStage, promotedPath: promoted?.relativePath ?? null }, '장진태', timestamp);
      return { projectId: context.row.project_id, approvalId, approvalKind, currentStage: nextStage, targetPath: artifact.relativePath, targetSha256: artifact.sha256, promotedPath: promoted?.relativePath ?? null };
    }));
    try { await syncStateFiles(context, result.currentStage); } catch (error) { await markFileSyncFailure(context.row.project_id, error); throw error; }
    return result;
  } catch (error) {
    if (promoted?.created) await rm(promoted.fullPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function yamlStageNumber(content: string) {
  const explicit = /^\s*stage_number:\s*(\d{1,2})\s*$/m.exec(content)?.[1];
  if (explicit) return Number(explicit);
  const current = /^\s*current_stage:\s*['"]?([a-z_]+)['"]?\s*$/m.exec(content)?.[1];
  const mapping: Record<string, number> = { project_created: 3, intake: 4, analysis: 5, strategy: 7, drafting: 8, review: 10, awaiting_submission_approval: 11, approved: 12, submitted: 13, completed: 13 };
  return current ? mapping[current] ?? null : null;
}

export async function reconcileResponseProject(noticeIdValue: unknown, input: Row = {}) {
  const noticeId = required(noticeIdValue, '통지 ID', 100), context = await projectContext(noticeId);
  const casePath = path.join(context.directory, 'case.yaml'), statusPath = path.join(context.directory, 'STATUS.md');
  const [caseInfo, statusInfo] = await Promise.all([lstat(casePath).catch(() => null), lstat(statusPath).catch(() => null)]);
  if (!caseInfo?.isFile() || caseInfo.isSymbolicLink() || !statusInfo?.isFile() || statusInfo.isSymbolicLink()) throw new WorkDbError('case.yaml과 STATUS.md를 안전하게 확인할 수 없습니다.', 409, 'RESPONSE_STATE_FILE_MISSING');
  const [caseContent, statusContent] = await Promise.all([readFile(casePath, 'utf8'), readFile(statusPath, 'utf8')]);
  const caseStage = yamlStageNumber(caseContent), statusStage = Number(/현재 단계:\s*(\d{1,2})\/13/u.exec(statusContent)?.[1] ?? 0) || null;
  const dbStage = Number(context.row.stage_number || 3), mismatches: string[] = [];
  if (caseStage !== null && caseStage !== dbStage) mismatches.push(`case.yaml 단계 ${caseStage} / DB 단계 ${dbStage}`);
  if (statusStage !== null && statusStage !== dbStage) mismatches.push(`STATUS.md 단계 ${statusStage} / DB 단계 ${dbStage}`);

  const approvals = withDatabase((db) => db.prepare(`SELECT * FROM notice_project_approval a WHERE a.project_id=? AND a.decision='approved' AND a.created_at=(SELECT MAX(b.created_at) FROM notice_project_approval b WHERE b.project_id=a.project_id AND b.approval_kind=a.approval_kind)`).all(context.row.project_id) as Row[]);
  const invalidApprovals: Row[] = [];
  for (const approval of approvals) {
    if (!approval.target_relative_path || !approval.target_sha256) continue;
    try {
      const current = await verifiedArtifact(context.directory, approval.target_relative_path);
      if (current.sha256 !== approval.target_sha256) invalidApprovals.push(approval);
    } catch { invalidApprovals.push(approval); }
  }
  if (invalidApprovals.length) mismatches.push(`승인 파일 변경 또는 누락 ${invalidApprovals.length}건`);

  const timestamp = now();
  const result = withDatabase((db) => transaction(db, () => {
    const stage = stageRecord(db, context.row.project_id);
    if (input.expectedVersion != null && Number(input.expectedVersion) !== Number(stage.row_version)) throw new WorkDbError('프로젝트 단계가 변경되었습니다. 새로고침 후 다시 시도하세요.', 409, 'RESPONSE_VERSION_CONFLICT');
    let nextStage = Number(stage.stage_number), action = defaultResponseAction(nextStage);
    for (const approval of invalidApprovals) {
      const revert = approval.approval_kind === 'strategy_selection' ? 7 : approval.approval_kind === 'submission_copy' ? 11 : approval.approval_kind === 'external_dispatch' ? 12 : 13;
      nextStage = Math.min(nextStage, revert); action = defaultResponseAction(nextStage);
      db.prepare(`INSERT INTO notice_project_approval(id,project_id,approval_kind,decision,target_artifact_id,target_relative_path,target_version,target_sha256,scope_json,actor,created_at) VALUES (?,?,?,'revoked',?,?,?,?,?,'automation',?)`)
        .run(randomUUID(), context.row.project_id, approval.approval_kind, approval.target_artifact_id, approval.target_relative_path, approval.target_version, approval.target_sha256, JSON.stringify({ reason: 'TARGET_FILE_CHANGED_OR_MISSING', priorApprovalId: approval.id }), timestamp);
    }
    if (mismatches.length) {
      db.prepare(`UPDATE notice_project_stage SET stage_key=?,stage_number=?,status='held',blocked_reason='STATE_MISMATCH',user_action_code=?,action_summary=?,last_reconciled_at=?,row_version=row_version+1,updated_at=? WHERE project_id=?`)
        .run(responseStageKey(nextStage), nextStage, action.code ?? 'confirm_deadline_or_procedure', `프로젝트 상태 불일치: ${mismatches.join('; ')}`, timestamp, timestamp, context.row.project_id);
    } else {
      db.prepare(`UPDATE notice_project_stage SET status=CASE WHEN stage_key='completed' THEN 'completed' ELSE 'active' END,blocked_reason=NULL,user_action_code=?,action_summary=?,last_reconciled_at=?,row_version=row_version+1,updated_at=? WHERE project_id=?`)
        .run(action.code, action.summary, timestamp, timestamp, context.row.project_id);
    }
    recordProjectEvent(db, context.row.project_id, 'response_state_reconciled', { dbStage, caseStage, statusStage, mismatches, invalidApprovalIds: invalidApprovals.map((approval) => approval.id) }, 'automation', timestamp);
    return { projectId: context.row.project_id, consistent: mismatches.length === 0, dbStage, caseStage, statusStage, mismatches, invalidApprovalCount: invalidApprovals.length };
  }));
  return result;
}
