import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseMatterNumber } from './matter-number';
import { EASY_PAT_TOOLS, loadSourcePriorityPolicy, SOURCE_PRIORITY_VERSION, type EasyPatTool } from './source-policy';
import { transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;
type VerificationEnvelope = {
  tool: EasyPatTool;
  arguments?: Record<string, unknown>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  observedAt?: string;
};

const summaryFields = ['rightType', 'applicationKind', 'applicationDivision', 'applicationDate', 'applicationNumber', 'titleKorean', 'status'] as const;
const progressFields = ['sequence', 'recordDate', 'noticeDate', 'document', 'division', 'description', 'briefDueDate', 'opinionDueDate', 'processDate', 'dueDate', 'assignee', 'department', 'method'] as const;
const documentFields = ['position', 'documentName', 'registeredAt', 'fileName', 'fileSizeBytes'] as const;
const extractedFields = ['applicationType', 'applicant', 'inventorInstruction', 'practitioner', 'assignee', 'databaseManager', 'introducer', 'fee', 'estimateAndPowerOfAttorney', 'note'] as const;
const allowedArguments: Record<EasyPatTool, readonly string[]> = {
  easypat_status: [],
  easypat_get_matter_summary: ['matterReference'],
  easypat_list_progress: ['matterReference'],
  easypat_list_documents: ['matterReference'],
  easypat_list_progress_documents: ['matterReference', 'progressDocument'],
  easypat_download_progress_document: ['matterReference', 'progressDocument', 'position', 'expectedFileName'],
  easypat_extract_progress_document_pdf: ['matterReference', 'fileName'],
};
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const object = (value: unknown, message: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkDbError(message, 400, 'EASYPAT_RESULT_INVALID');
  return value as Record<string, unknown>;
};
const list = (value: unknown, message: string) => {
  if (!Array.isArray(value)) throw new WorkDbError(message, 400, 'EASYPAT_RESULT_INVALID');
  return value;
};
const pick = (value: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
const exactReference = (value: unknown) => {
  if (typeof value !== 'string') throw new WorkDbError('EasyPAT 전체 당소관리번호가 없습니다.', 400, 'EASYPAT_RESULT_INVALID');
  const parsed = parseMatterNumber(value);
  if (parsed.normalized !== value) throw new WorkDbError('EasyPAT 당소관리번호는 정규화된 전체 문자열이어야 합니다.', 400, 'EASYPAT_RESULT_INVALID');
  return parsed.normalized;
};
const verifiedTime = (value: unknown) => {
  const date = value === undefined ? new Date() : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new WorkDbError('EasyPAT 확인 시각이 올바르지 않습니다.', 400, 'EASYPAT_RESULT_INVALID');
  return date.toISOString();
};

function sanitizeToolResult(envelope: VerificationEnvelope) {
  const tool = envelope.tool;
  if (!EASY_PAT_TOOLS.includes(tool)) throw new WorkDbError('허용되지 않은 EasyPAT 도구입니다.', 400, 'EASYPAT_TOOL_NOT_ALLOWED');
  if (envelope.isError) throw new WorkDbError('실패한 EasyPAT 결과는 원본 확인으로 기록할 수 없습니다.', 409, 'EASYPAT_RESULT_FAILED');
  const result = object(envelope.structuredContent, 'EasyPAT 구조화 결과가 없습니다.');
  const args = object(envelope.arguments || {}, 'EasyPAT 입력이 올바르지 않습니다.');
  const unexpectedArguments = Object.keys(args).filter((key) => !allowedArguments[tool].includes(key));
  if (unexpectedArguments.length) throw new WorkDbError('EasyPAT 도구에 허용되지 않은 입력이 포함되었습니다.', 400, 'EASYPAT_ARGUMENT_NOT_ALLOWED');

  if (tool === 'easypat_status') {
    if (result.status !== 'ready') throw new WorkDbError('EasyPAT MCP 서버가 준비 상태가 아닙니다.', 409, 'EASYPAT_NOT_READY');
    return {
      matterReference: null,
      arguments: {},
      result: pick(result, ['status', 'automaticAuthenticationReady', 'sessionRefreshEnabled', 'enabledTemplateCount', 'genericMatterSummaryEnabled', 'genericProgressListingEnabled', 'genericDocumentListingEnabled', 'genericProgressDocumentListingEnabled', 'genericProgressDocumentDownloadEnabled', 'genericProgressDocumentExtractionEnabled', 'documentMatterBindingVerified', 'allowedOperations']),
      observations: [['easy_pat.status', pick(result, ['automaticAuthenticationReady', 'enabledTemplateCount', 'allowedOperations'])]] as Array<[string, unknown]>,
    };
  }

  const argumentReference = exactReference(args.matterReference);
  const resultReference = exactReference(result.matterReference);
  if (argumentReference !== resultReference) throw new WorkDbError('EasyPAT 요청과 결과의 전체 당소관리번호가 다릅니다.', 409, 'EASYPAT_IDENTITY_MISMATCH');
  const safeArguments: Record<string, unknown> = { matterReference: argumentReference };
  for (const key of ['progressDocument', 'expectedFileName', 'fileName']) if (Object.hasOwn(args, key)) {
    if (typeof args[key] !== 'string' || !String(args[key]).trim()) throw new WorkDbError('EasyPAT 문자열 입력이 올바르지 않습니다.', 400, 'EASYPAT_RESULT_INVALID');
    safeArguments[key] = args[key];
  }
  if (Object.hasOwn(args, 'position')) {
    if (!Number.isInteger(args.position) || Number(args.position) < 1) throw new WorkDbError('EasyPAT 문서 위치가 올바르지 않습니다.', 400, 'EASYPAT_RESULT_INVALID');
    safeArguments.position = args.position;
  }

  if (tool === 'easypat_get_matter_summary') {
    const safe: Record<string, unknown> = { matterReference: resultReference, ...pick(result, summaryFields) };
    return { matterReference: resultReference, arguments: safeArguments, result: safe, observations: summaryFields.filter((key) => safe[key] !== null && safe[key] !== undefined).map((key) => [`easy_pat.summary.${key}`, safe[key]] as [string, unknown]) };
  }
  if (tool === 'easypat_list_progress') {
    const items = list(result.items, 'EasyPAT 진행기록 목록이 올바르지 않습니다.').map((item) => pick(object(item, 'EasyPAT 진행기록 항목이 올바르지 않습니다.'), progressFields));
    if (result.count !== items.length) throw new WorkDbError('EasyPAT 진행기록 건수가 목록과 다릅니다.', 409, 'EASYPAT_RESULT_INVALID');
    const safe = { matterReference: resultReference, count: items.length, items };
    return { matterReference: resultReference, arguments: safeArguments, result: safe, observations: [['easy_pat.progress', safe]] as Array<[string, unknown]> };
  }
  if (tool === 'easypat_list_documents' || tool === 'easypat_list_progress_documents') {
    const items = list(result.items, 'EasyPAT 문서 목록이 올바르지 않습니다.').map((item) => pick(object(item, 'EasyPAT 문서 항목이 올바르지 않습니다.'), documentFields));
    if (result.count !== items.length) throw new WorkDbError('EasyPAT 문서 건수가 목록과 다릅니다.', 409, 'EASYPAT_RESULT_INVALID');
    const safe = { matterReference: resultReference, ...(tool === 'easypat_list_progress_documents' ? { progressDocument: result.progressDocument } : {}), count: items.length, items };
    const field = tool === 'easypat_list_documents' ? 'easy_pat.documents' : 'easy_pat.progress_documents';
    return { matterReference: resultReference, arguments: safeArguments, result: safe, observations: [[field, safe]] as Array<[string, unknown]> };
  }
  if (tool === 'easypat_download_progress_document') {
    const safe = { matterReference: resultReference, ...pick(result, ['position', 'fileName', 'fileSizeBytes', 'contentType', 'sha256', 'downloaded', 'alreadyPresent', 'overwritten', 'automaticRetryPerformed', 'serverMutationPerformed', 'serverUploadPathReturned']) };
    return { matterReference: resultReference, arguments: safeArguments, result: safe, observations: [['easy_pat.download', safe]] as Array<[string, unknown]> };
  }
  const fields = pick(object(result.fields, 'EasyPAT PDF 추출 필드가 올바르지 않습니다.'), extractedFields);
  const relatedMatterReferences = list(result.relatedMatterReferences, 'EasyPAT 관련 사건번호가 올바르지 않습니다.').map(exactReference);
  const safe = { matterReference: resultReference, ...pick(result, ['sourceFileName', 'sourceSha256', 'pageCount', 'requestedMatterCount', 'requestedMatterPrefix', 'rawTextReturned', 'emailAddressesReturned', 'contactDetailsReturned', 'externalUploadPerformed']), fields, relatedMatterReferences };
  return { matterReference: resultReference, arguments: safeArguments, result: safe, observations: [['easy_pat.pdf_fields', safe]] as Array<[string, unknown]> };
}

function insertEvidence(db: DatabaseSync, runId: string, subjectType: string, subjectKey: string, fieldPath: string, value: unknown, sourceId: string, timestamp: string) {
  const itemId = randomUUID();
  const valueJson = JSON.stringify(value);
  const risk = fieldPath.endsWith('.status') || fieldPath === 'easy_pat.progress' ? 'high' : 'medium';
  db.prepare(`INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at) VALUES (?,?,?,?,?,'observe',?,?,1,?,'EasyPAT MCP의 전체 사건번호 정확 일치 조회','not_reviewed',?)`)
    .run(itemId, runId, subjectType, subjectKey, fieldPath, valueJson, valueJson, risk, timestamp);
  const excerpt = valueJson.slice(0, 4000);
  db.prepare(`INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'easy_pat',?,'{}',?,?,'support')`)
    .run(randomUUID(), itemId, sourceId, excerpt, hash(excerpt));
}

export function recordEasyPatVerification(value: unknown) {
  const envelope = object(value, 'EasyPAT 확인 결과가 올바르지 않습니다.') as VerificationEnvelope;
  const sanitized = sanitizeToolResult(envelope);
  const timestamp = verifiedTime(envelope.observedAt);
  const sourcePolicy = loadSourcePriorityPolicy();
  const context = { tool: envelope.tool, arguments: sanitized.arguments, result: sanitized.result, observedAt: timestamp };
  const contextHash = hash(context);

  return withDatabase((db) => transaction(db, () => {
    const matter = sanitized.matterReference
      ? db.prepare('SELECT id,our_ref,row_version,user_confirmed,source_type FROM matter WHERE our_ref=? COLLATE NOCASE AND archived_at IS NULL').get(sanitized.matterReference) as Row | undefined
      : undefined;
    if (sanitized.matterReference && !matter) throw new WorkDbError('EasyPAT에서 확인한 사건이 운영 DB에 없습니다. 미등록 사건 검토를 먼저 진행하세요.', 404, 'EASYPAT_MATTER_NOT_REGISTERED');
    const prior = db.prepare(`SELECT r.id,r.result_json FROM decision_run r JOIN input_snapshot s ON s.id=r.input_snapshot_id WHERE r.operation='easypat_source_verification' AND r.status='succeeded' AND s.context_hash=? LIMIT 1`).get(contextHash) as Row | undefined;
    if (prior) return { ...JSON.parse(prior.result_json), duplicate: true };

    const runId = randomUUID();
    const snapshotId = randomUUID();
    const policyId = SOURCE_PRIORITY_VERSION;
    const sourceId = `mcp:${envelope.tool}:sha256:${hash(sanitized.result)}`;
    db.prepare(`INSERT OR IGNORE INTO policy_revision(id,revision_type,version,artifact_paths_json,content_hash,status,approved_by,approved_at,created_at) VALUES (?,'source_priority',?,? ,?,'active','장진태',?,?)`)
      .run(policyId, SOURCE_PRIORITY_VERSION, JSON.stringify([sourcePolicy.artifactPath, 'docs/EASYPAT_SOURCE_VERIFICATION.md']), sourcePolicy.contentHash, timestamp, timestamp);
    db.prepare(`INSERT INTO input_snapshot(id,matter_id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,?,'[]',?,?,?,?,?)`)
      .run(snapshotId, matter?.id || null, JSON.stringify(matter ? { [`matter:${matter.id}`]: matter.row_version } : {}), SOURCE_PRIORITY_VERSION, contextHash, JSON.stringify(context), timestamp);
    const result = { runId, tool: envelope.tool, matterReference: sanitized.matterReference, observedAt: timestamp, sourceId, observationCount: sanitized.observations.length };
    db.prepare(`INSERT INTO decision_run(id,operation,agent_name,prompt_version,policy_revision_id,routing_snapshot_json,input_snapshot_id,status,started_at,completed_at,output_hash,result_json) VALUES (?,'easypat_source_verification','easypat_mcp','easypat-source-verification-v1',?,? ,?,'succeeded',?,?,?,?)`)
      .run(runId, policyId, JSON.stringify({ method: 'mcp-read-only', tool: envelope.tool, model: null, reasoningEffort: null, sourcePriority: sourcePolicy.externalPriority, userConfirmedProtected: true }), snapshotId, timestamp, timestamp, hash(result), JSON.stringify(result));

    const subjectType = matter ? 'matter' : 'system';
    const subjectKey = matter?.id || 'easypat';
    for (const [fieldPath, observed] of sanitized.observations) {
      insertEvidence(db, runId, subjectType, subjectKey, fieldPath, observed, sourceId, timestamp);
      if (matter) db.prepare(`INSERT INTO source_observation(id,entity_type,entity_id,field_path,observed_value_json,source_type,source_id,observed_at,confidence,user_confirmed) VALUES (?,'matter',?,?,?,?,?,?,1,0)`)
        .run(randomUUID(), matter.id, fieldPath, JSON.stringify(observed), 'easy_pat', sourceId, timestamp);
    }
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at) VALUES (?,?,?,?,?,'Codex','easy_pat',?,?)`)
      .run(randomUUID(), subjectType, subjectKey, 'easy_pat_verified', JSON.stringify({ tool: envelope.tool, matterReference: sanitized.matterReference, sourceId, observationCount: sanitized.observations.length }), runId, timestamp);
    return { ...result, duplicate: false };
  }));
}

export function activateSourcePriorityPolicy(actor = '장진태') {
  const sourcePolicy = loadSourcePriorityPolicy();
  const timestamp = new Date().toISOString();
  return withDatabase((db) => transaction(db, () => {
    const existing = db.prepare('SELECT id,content_hash FROM policy_revision WHERE id=?').get(SOURCE_PRIORITY_VERSION) as Row | undefined;
    if (existing && existing.content_hash !== sourcePolicy.contentHash) throw new WorkDbError('같은 출처 정책 버전에 다른 내용이 이미 기록되어 있습니다.', 409, 'SOURCE_POLICY_CONFLICT');
    if (existing) return { policyId: SOURCE_PRIORITY_VERSION, version: SOURCE_PRIORITY_VERSION, duplicate: true };
    db.prepare(`INSERT INTO policy_revision(id,revision_type,version,artifact_paths_json,content_hash,status,approved_by,approved_at,created_at) VALUES (?,'source_priority',?,?,?,'active',?,?,?)`)
      .run(SOURCE_PRIORITY_VERSION, SOURCE_PRIORITY_VERSION, JSON.stringify([sourcePolicy.artifactPath, 'docs/EASYPAT_SOURCE_VERIFICATION.md', 'docs/WORK_MANAGEMENT_ARCHITECTURE.md']), sourcePolicy.contentHash, actor, timestamp, timestamp);
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at) VALUES (?,'system',?,'source_priority.activated',?,?, 'user_input',?,?)`)
      .run(randomUUID(), SOURCE_PRIORITY_VERSION, JSON.stringify({ version: SOURCE_PRIORITY_VERSION, externalPriority: sourcePolicy.externalPriority, userConfirmedProtected: true, contentHash: sourcePolicy.contentHash }), actor, SOURCE_PRIORITY_VERSION, timestamp);
    return { policyId: SOURCE_PRIORITY_VERSION, version: SOURCE_PRIORITY_VERSION, duplicate: false };
  }));
}
