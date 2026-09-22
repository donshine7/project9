import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { matterReferenceTokens, parseMatterNumber } from './matter-number';
import { loadSourcePriorityPolicy, SOURCE_PRIORITY_VERSION } from './source-policy';

export const SOURCE_TYPES = ['user_input', 'easy_pat', 'registration_mail', 'excel', 'mail_inference'] as const;
export const WORK_TYPES = ['출원', '중간사건', '등록', '기타'] as const;
export const SERVICE_TYPES = ['일반출원', '우선심사출원', '메이킹', '기획', '가출원'] as const;
export const ACTION_STATUSES = ['대기', '진행중', '완료', '보류'] as const;
export const ACTION_PRIORITIES = ['낮음', '보통', '높음', '긴급'] as const;
export const TEAM_MEMBERS = ['장진태', '박준호', '황현우'] as const;
export const BUSINESS_TYPES = ['개인사업자', '법인', '미정'] as const;

const MAX_TEXT = 10_000;
const DEFAULT_DATA_ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SSPAT', 'work-management');

export type MatterCreateInput = {
  ourRef: string;
  note?: string | null;
  workType?: string;
  serviceType?: string | null;
  stage?: string;
  currentStatus?: string;
};

export type WorkItemInput = {
  workType: string;
  serviceType?: string | null;
  stage: string;
  currentStatus: string;
  costMethod?: string | null;
  fundingSource?: string | null;
  baseDate?: string | null;
  commencementDate?: string | null;
};

export type ActionInput = {
  workItemId?: string | null;
  title: string;
  assignee: string;
  status?: string;
  dueDate?: string | null;
  priority?: string;
  evidence?: string | null;
};

export type ConfirmedGroupEvidence = {
  sheet: string;
  range: string;
  excerpt: string;
};

export type ConfirmedGroupPlan = {
  groupRef: string;
  groupType: string;
  representativeRef: string;
  members: string[];
  note: string;
  confidence: number;
  evidence: ConfirmedGroupEvidence[];
};

export type ConfirmedGroupImport = {
  sourceName: string;
  sourceHash: string;
  sourceLastModified: string;
  groups: ConfirmedGroupPlan[];
};

export type OutlookMailRecord = {
  entryId: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  folderPath: string;
  direction: 'received' | 'sent';
  subject: string;
  senderName?: string | null;
  senderEmail?: string | null;
  to?: string | null;
  cc?: string | null;
  storeDisplayName?: string | null;
  recipients?: Array<{ type?: string; displayName?: string | null; smtpAddress?: string | null; resolved?: boolean }>;
  mailAt: string;
  body: string;
};

function dataRoot() {
  return process.env.SSPAT_WORK_DB_PATH ? path.dirname(path.resolve(process.env.SSPAT_WORK_DB_PATH)) : DEFAULT_DATA_ROOT;
}

export function databasePath() {
  return process.env.SSPAT_WORK_DB_PATH ? path.resolve(process.env.SSPAT_WORK_DB_PATH) : path.join(DEFAULT_DATA_ROOT, 'sspat-work.db');
}

export function backupDirectory() {
  return path.join(dataRoot(), 'backups');
}

export function mailStagingDirectory() {
  return path.join(dataRoot(), 'mail-staging');
}

function migrationDirectory() {
  return path.resolve(process.cwd(), 'db', 'migrations');
}

function openDatabase() {
  const file = databasePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const directory = migrationDirectory();
  const files = readdirSync(directory).filter((name) => /^\d+.*\.sql$/i.test(name)).sort();
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migration').all() as Array<{ version: string }>).map((row) => row.version),
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(directory, file), 'utf8');
    const foreignKeysOff = /^\s*--\s*@foreign-keys-off\b/m.test(sql);
    if (foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      if (foreignKeysOff) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new Error(`Migration ${file} left ${violations.length} foreign-key violation(s).`);
      }
      db.prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)').run(file, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      if (foreignKeysOff) db.exec('PRAGMA foreign_keys = ON;');
    }
  }
}

export function withDatabase<T>(operation: (db: DatabaseSync) => T): T {
  const db = openDatabase();
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function now() {
  return new Date().toISOString();
}

function requiredText(value: unknown, label: string, maxLength = 200) {
  const result = String(value ?? '').trim();
  if (!result) throw new WorkDbError(`${label}을(를) 입력하세요.`, 400);
  if (result.length > maxLength) throw new WorkDbError(`${label}은(는) ${maxLength}자 이하여야 합니다.`, 400);
  return result;
}

function optionalText(value: unknown, label: string, maxLength = 200) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return requiredText(value, label, maxLength);
}

function oneOf(value: unknown, values: readonly string[], label: string, fallback?: string) {
  const normalized = value === undefined && fallback ? fallback : String(value ?? '').trim();
  if (!values.includes(normalized)) throw new WorkDbError(`${label} 값이 올바르지 않습니다.`, 400);
  return normalized;
}

function optionalDate(value: unknown, label: string) {
  const normalized = optionalText(value, label, 10);
  if (normalized && !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new WorkDbError(`${label}은 YYYY-MM-DD 형식이어야 합니다.`, 400);
  return normalized;
}

function parseJson(value: unknown, fallback: unknown) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function event(
  db: DatabaseSync,
  entityType: string,
  entityId: string,
  eventType: string,
  before: unknown,
  after: unknown,
  correlationId = randomUUID(),
) {
  db.prepare(`
    INSERT INTO event(id, entity_type, entity_id, event_type, before_json, after_json, actor, source_type, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '장진태', 'user_input', ?, ?)
  `).run(randomUUID(), entityType, entityId, eventType, before === null ? null : JSON.stringify(before), JSON.stringify(after), correlationId, now());
}

export function transaction<T>(db: DatabaseSync, operation: () => T) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function matterRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    ourRef: row.our_ref,
    office: row.office,
    matterKind: row.matter_kind,
    countryCode: row.country_code,
    baseRef: row.base_ref,
    parentRef: row.parent_ref,
    relationType: row.relation_type,
    suffixes: parseJson(row.suffixes_json, []),
    note: row.note,
    sourceType: row.source_type,
    sourceId: row.source_id,
    confidence: row.confidence,
    userConfirmed: Boolean(row.user_confirmed),
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    matterId: row.matter_id,
    workType: row.work_type,
    serviceType: row.service_type,
    stage: row.stage,
    currentStatus: row.current_status,
    costMethod: row.cost_method,
    fundingSource: row.funding_source,
    baseDate: row.base_date,
    commencementDate: row.commencement_date,
    sourceType: row.source_type,
    confidence: row.confidence,
    userConfirmed: Boolean(row.user_confirmed),
    rowVersion: row.row_version,
    updatedAt: row.updated_at,
  };
}

function actionRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    matterId: row.matter_id,
    workItemId: row.work_item_id,
    title: row.title,
    assignee: row.assignee,
    manager: row.manager,
    status: row.status,
    dueDate: row.due_date,
    priority: row.priority,
    evidence: row.evidence,
    sourceType: row.source_type,
    confidence: row.confidence,
    userConfirmed: Boolean(row.user_confirmed),
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function noteRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    matterId: row.matter_id,
    noteType: row.note_type,
    content: row.content,
    author: row.author,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function organizationRow(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, businessType: row.business_type, role: row.role, note: row.note, rowVersion: row.row_version, updatedAt: row.updated_at };
}

function personRow(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, role: row.role, email: row.email, organizationId: row.organization_id, note: row.note, rowVersion: row.row_version, updatedAt: row.updated_at };
}

function groupRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    groupRef: row.group_ref,
    groupType: row.group_type,
    representativeMatterId: row.representative_matter_id,
    representativeOurRef: row.representative_our_ref ?? null,
    memberRefs: typeof row.member_refs === 'string' && row.member_refs ? row.member_refs.split(', ') : [],
    note: row.note,
    rowVersion: row.row_version,
    updatedAt: row.updated_at,
  };
}

export class WorkDbError extends Error {
  constructor(message: string, public readonly status = 500, public readonly code = 'WORK_DB_ERROR') {
    super(message);
    this.name = 'WorkDbError';
  }
}

export function databaseStatus() {
  return withDatabase((db) => {
    const integrity = db.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    const migrations = db.prepare('SELECT version, applied_at FROM schema_migration ORDER BY version').all();
    return { path: databasePath(), backupDirectory: backupDirectory(), integrity: Object.values(integrity)[0], migrations };
  });
}

export function listMatters(query = '') {
  const search = `%${String(query).trim().slice(0, 100)}%`;
  return withDatabase((db) => {
    const rows = db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM work_item w WHERE w.matter_id = m.id AND w.archived_at IS NULL) AS work_count,
        (SELECT COUNT(*) FROM action_item a WHERE a.matter_id = m.id AND a.archived_at IS NULL AND a.status != '완료') AS open_action_count
      FROM matter m
      WHERE m.archived_at IS NULL AND (? = '%%' OR m.our_ref LIKE ?)
      ORDER BY m.updated_at DESC, m.our_ref ASC
      LIMIT 200
    `).all(search, search) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...matterRow(row), workCount: row.work_count, openActionCount: row.open_action_count }));
  });
}

export function getMatter(id: string) {
  return withDatabase((db) => getMatterFromDb(db, id));
}

function getMatterFromDb(db: DatabaseSync, id: string) {
  const matter = db.prepare('SELECT * FROM matter WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
  if (!matter) throw new WorkDbError('사건을 찾을 수 없습니다.', 404, 'MATTER_NOT_FOUND');
  const works = (db.prepare('SELECT * FROM work_item WHERE matter_id = ? AND archived_at IS NULL ORDER BY updated_at DESC').all(id) as Array<Record<string, unknown>>).map(workRow);
  const notes = (db.prepare('SELECT * FROM matter_note WHERE matter_id = ? AND archived_at IS NULL ORDER BY updated_at DESC').all(id) as Array<Record<string, unknown>>).map(noteRow);
  const actions = (db.prepare('SELECT * FROM action_item WHERE matter_id = ? AND archived_at IS NULL ORDER BY status = \'완료\', due_date IS NULL, due_date, updated_at DESC').all(id) as Array<Record<string, unknown>>).map(actionRow);
  const organizations = (db.prepare(`SELECT o.*,mp.role FROM organization o JOIN matter_party mp ON mp.party_id = o.id AND mp.party_type = 'organization' WHERE mp.matter_id = ? AND o.archived_at IS NULL ORDER BY o.name`).all(id) as Array<Record<string, unknown>>).map(organizationRow);
  const people = (db.prepare(`SELECT p.*,mp.role FROM person p JOIN matter_party mp ON mp.party_id = p.id AND mp.party_type = 'person' WHERE mp.matter_id = ? AND p.archived_at IS NULL ORDER BY p.name`).all(id) as Array<Record<string, unknown>>).map(personRow);
  const groups = (db.prepare(`
    SELECT g.*, representative.our_ref AS representative_our_ref,
      (SELECT group_concat(member_ref.our_ref, ', ') FROM (
        SELECT member.our_ref
        FROM matter_group_member all_members
        JOIN matter member ON member.id = all_members.matter_id
        WHERE all_members.group_id = g.id AND member.archived_at IS NULL
        ORDER BY member.our_ref
      ) member_ref) AS member_refs
    FROM matter_group g
    JOIN matter_group_member gm ON gm.group_id = g.id
    LEFT JOIN matter representative ON representative.id = g.representative_matter_id
    WHERE gm.matter_id = ? AND g.archived_at IS NULL
    ORDER BY g.group_ref
  `).all(id) as Array<Record<string, unknown>>).map(groupRow);
  const mailSummaries = db.prepare(`SELECT id, summary_date AS summaryDate, content, summary_type AS summaryType, model, source_mail_ids_json AS sourceMailIdsJson, row_version AS rowVersion, updated_at AS updatedAt FROM mail_daily_summary WHERE matter_id = ? ORDER BY summary_date DESC LIMIT 90`).all(id).map((row: any) => ({ ...row, sourceMailIds: parseJson(row.sourceMailIdsJson, []) }));
  const easyPatObservations = (db.prepare(`SELECT id,field_path AS fieldPath,observed_value_json AS observedValueJson,source_id AS sourceId,observed_at AS observedAt,confidence FROM source_observation WHERE entity_type='matter' AND entity_id=? AND source_type='easy_pat' ORDER BY observed_at DESC,rowid DESC LIMIT 50`).all(id) as Array<Record<string, unknown>>)
    .map((row) => ({ ...row, observedValue: parseJson(String(row.observedValueJson), null) })) as Array<{ id: string; fieldPath: string; observedValue: unknown; sourceId: string; observedAt: string; confidence: number }>;
  const easyPat = { verified: easyPatObservations.length > 0, lastObservedAt: easyPatObservations[0]?.observedAt || null, observations: easyPatObservations };
  const events = (db.prepare('SELECT id, entity_type AS entityType, entity_id AS entityId, event_type AS eventType, actor, source_type AS sourceType, created_at AS createdAt FROM event WHERE (entity_type = \'matter\' AND entity_id = ?) OR entity_id IN (SELECT id FROM work_item WHERE matter_id = ?) OR entity_id IN (SELECT id FROM action_item WHERE matter_id = ?) OR entity_id IN (SELECT id FROM matter_note WHERE matter_id = ?) ORDER BY created_at DESC LIMIT 50').all(id, id, id, id));
  return { matter: matterRow(matter), works, notes, actions, organizations, people, groups, mailSummaries, easyPat, events };
}

export function createMatter(input: MatterCreateInput) {
  const parsed = parseMatterNumber(input.ourRef);
  return withDatabase((db) => transaction(db, () => {
    const existing = db.prepare('SELECT id FROM matter WHERE our_ref = ? COLLATE NOCASE AND archived_at IS NULL').get(parsed.normalized) as { id?: string } | undefined;
    if (existing?.id) throw new WorkDbError('이미 등록된 당소관리번호입니다.', 409, 'DUPLICATE_MATTER');
    const id = randomUUID();
    const timestamp = now();
    const stored = {
      id,
      ourRef: parsed.normalized,
      office: parsed.office,
      matterKind: parsed.kind,
      countryCode: parsed.countryCode,
      baseRef: parsed.baseRef,
      parentRef: parsed.parentRef,
      relationType: parsed.relationType,
      suffixes: parsed.suffixes,
      sourceType: 'user_input',
      confidence: 1,
      userConfirmed: true,
      note: optionalText(input.note, '사건 비고', MAX_TEXT),
    };
    db.prepare(`
      INSERT INTO matter(id, our_ref, office, matter_kind, country_code, base_ref, parent_ref, relation_type, suffixes_json, note, source_type, confidence, user_confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_input', 1, 1, ?, ?)
    `).run(id, parsed.normalized, parsed.office, parsed.kind, parsed.countryCode, parsed.baseRef, parsed.parentRef, parsed.relationType, JSON.stringify(parsed.suffixes), stored.note, timestamp, timestamp);
    event(db, 'matter', id, 'matter_created', null, stored);

    if (input.workType) {
      createWorkItemInDb(db, id, {
        workType: input.workType,
        serviceType: input.serviceType,
        stage: input.stage || input.workType,
        currentStatus: input.currentStatus || '미지정',
      });
    }
    return getMatterFromDb(db, id);
  }));
}

export function updateMatter(id: string, input: { ourRef?: string; note?: string | null; expectedVersion?: number }) {
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare('SELECT * FROM matter WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('사건을 찾을 수 없습니다.', 404);
    if (input.expectedVersion !== undefined && Number(before.row_version) !== Number(input.expectedVersion)) {
      throw new WorkDbError('다른 변경이 먼저 반영되었습니다. 화면을 새로고침하세요.', 409, 'VERSION_CONFLICT');
    }
    const parsed = parseMatterNumber(input.ourRef ?? before.our_ref);
    const note = input.note === undefined ? before.note as string | null : optionalText(input.note, '사건 비고', MAX_TEXT);
    const timestamp = now();
    try {
      db.prepare(`
        UPDATE matter SET our_ref = ?, office = ?, matter_kind = ?, country_code = ?, base_ref = ?, parent_ref = ?, relation_type = ?, suffixes_json = ?, note = ?,
          source_type = 'user_input', confidence = 1, user_confirmed = 1, row_version = row_version + 1, updated_at = ?
        WHERE id = ?
      `).run(parsed.normalized, parsed.office, parsed.kind, parsed.countryCode, parsed.baseRef, parsed.parentRef, parsed.relationType, JSON.stringify(parsed.suffixes), note, timestamp, id);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new WorkDbError('이미 등록된 당소관리번호입니다.', 409);
      throw error;
    }
    const after = db.prepare('SELECT * FROM matter WHERE id = ?').get(id);
    event(db, 'matter', id, 'matter_updated', matterRow(before), matterRow(after as Record<string, unknown>));
    return getMatterFromDb(db, id);
  }));
}

export function archiveMatter(id: string, expectedVersion?: number) {
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare('SELECT * FROM matter WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('사건을 찾을 수 없습니다.', 404);
    if (expectedVersion !== undefined && Number(before.row_version) !== Number(expectedVersion)) throw new WorkDbError('다른 변경이 먼저 반영되었습니다.', 409);
    const timestamp = now();
    db.prepare('UPDATE matter SET archived_at = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, timestamp, id);
    event(db, 'matter', id, 'matter_archived', matterRow(before), { archivedAt: timestamp });
    return { ok: true };
  }));
}

function validateWork(input: WorkItemInput) {
  return {
    workType: oneOf(input.workType, WORK_TYPES, '업무종류'),
    serviceType: input.serviceType ? oneOf(input.serviceType, SERVICE_TYPES, '서비스종류') : null,
    stage: requiredText(input.stage, '업무단계'),
    currentStatus: requiredText(input.currentStatus, '현재상태'),
    costMethod: optionalText(input.costMethod, '비용 처리 방식'),
    fundingSource: optionalText(input.fundingSource, '자금 출처'),
    baseDate: optionalDate(input.baseDate, '기산일'),
    commencementDate: optionalDate(input.commencementDate, '착수일'),
  };
}

function createWorkItemInDb(db: DatabaseSync, matterId: string, input: WorkItemInput) {
  const matter = db.prepare('SELECT id FROM matter WHERE id = ? AND archived_at IS NULL').get(matterId);
  if (!matter) throw new WorkDbError('사건을 찾을 수 없습니다.', 404);
  const value = validateWork(input);
  const id = randomUUID();
  const timestamp = now();
  db.prepare(`
    INSERT INTO work_item(id, matter_id, work_type, service_type, stage, current_status, cost_method, funding_source, base_date, commencement_date, source_type, confidence, user_confirmed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_input', 1, 1, ?, ?)
  `).run(id, matterId, value.workType, value.serviceType, value.stage, value.currentStatus, value.costMethod, value.fundingSource, value.baseDate, value.commencementDate, timestamp, timestamp);
  event(db, 'work_item', id, 'work_item_created', null, { ...value, matterId });
  db.prepare('UPDATE matter SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, matterId);
  return id;
}

export function createWorkItem(matterId: string, input: WorkItemInput) {
  return withDatabase((db) => transaction(db, () => {
    createWorkItemInDb(db, matterId, input);
    return getMatterFromDb(db, matterId);
  }));
}

export function updateWorkItem(id: string, input: Partial<WorkItemInput> & { expectedVersion?: number }) {
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare('SELECT * FROM work_item WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('업무를 찾을 수 없습니다.', 404);
    if (input.expectedVersion !== undefined && Number(before.row_version) !== Number(input.expectedVersion)) throw new WorkDbError('다른 변경이 먼저 반영되었습니다.', 409);
    const value = validateWork({
      workType: input.workType ?? String(before.work_type),
      serviceType: input.serviceType === undefined ? before.service_type as string | null : input.serviceType,
      stage: input.stage ?? String(before.stage),
      currentStatus: input.currentStatus ?? String(before.current_status),
      costMethod: input.costMethod === undefined ? before.cost_method as string | null : input.costMethod,
      fundingSource: input.fundingSource === undefined ? before.funding_source as string | null : input.fundingSource,
      baseDate: input.baseDate === undefined ? before.base_date as string | null : input.baseDate,
      commencementDate: input.commencementDate === undefined ? before.commencement_date as string | null : input.commencementDate,
    });
    const timestamp = now();
    db.prepare(`
      UPDATE work_item SET work_type = ?, service_type = ?, stage = ?, current_status = ?, cost_method = ?, funding_source = ?, base_date = ?, commencement_date = ?,
        source_type = 'user_input', confidence = 1, user_confirmed = 1, row_version = row_version + 1, updated_at = ? WHERE id = ?
    `).run(value.workType, value.serviceType, value.stage, value.currentStatus, value.costMethod, value.fundingSource, value.baseDate, value.commencementDate, timestamp, id);
    const after = db.prepare('SELECT * FROM work_item WHERE id = ?').get(id) as Record<string, unknown>;
    event(db, 'work_item', id, 'work_item_updated', workRow(before), workRow(after));
    db.prepare('UPDATE matter SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, String(before.matter_id));
    return getMatterFromDb(db, String(before.matter_id));
  }));
}

export function createNote(matterId: string, content: unknown) {
  const clean = requiredText(content, '메모', MAX_TEXT);
  return withDatabase((db) => transaction(db, () => {
    if (!db.prepare('SELECT id FROM matter WHERE id = ? AND archived_at IS NULL').get(matterId)) throw new WorkDbError('사건을 찾을 수 없습니다.', 404);
    const id = randomUUID();
    const timestamp = now();
    db.prepare(`INSERT INTO matter_note(id, matter_id, note_type, content, author, created_at, updated_at) VALUES (?, ?, 'user', ?, '장진태', ?, ?)`)
      .run(id, matterId, clean, timestamp, timestamp);
    event(db, 'matter_note', id, 'note_created', null, { matterId, content: clean });
    db.prepare('UPDATE matter SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, matterId);
    return getMatterFromDb(db, matterId);
  }));
}

export function updateNote(id: string, content: unknown, expectedVersion?: number) {
  const clean = requiredText(content, '메모', MAX_TEXT);
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare('SELECT * FROM matter_note WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('메모를 찾을 수 없습니다.', 404);
    if (expectedVersion !== undefined && Number(before.row_version) !== Number(expectedVersion)) throw new WorkDbError('다른 변경이 먼저 반영되었습니다.', 409);
    const timestamp = now();
    db.prepare('UPDATE matter_note SET content = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?').run(clean, timestamp, id);
    event(db, 'matter_note', id, 'note_updated', noteRow(before), { ...noteRow(before), content: clean });
    db.prepare('UPDATE matter SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, String(before.matter_id));
    return getMatterFromDb(db, String(before.matter_id));
  }));
}

export function archiveNote(id: string, expectedVersion?: number) {
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare('SELECT * FROM matter_note WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('메모를 찾을 수 없습니다.', 404);
    if (expectedVersion !== undefined && Number(before.row_version) !== Number(expectedVersion)) throw new WorkDbError('다른 변경이 먼저 반영되었습니다.', 409);
    const timestamp = now();
    db.prepare('UPDATE matter_note SET archived_at = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, timestamp, id);
    event(db, 'matter_note', id, 'note_archived', noteRow(before), { archivedAt: timestamp });
    db.prepare('UPDATE matter SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, String(before.matter_id));
    return getMatterFromDb(db, String(before.matter_id));
  }));
}

function validateAction(input: ActionInput) {
  return {
    workItemId: optionalText(input.workItemId, '연결 업무 ID'),
    title: requiredText(input.title, 'Action 제목', 300),
    assignee: oneOf(input.assignee, TEAM_MEMBERS, '수행자'),
    status: oneOf(input.status, ACTION_STATUSES, 'Action 상태', '대기'),
    dueDate: optionalDate(input.dueDate, '기한'),
    priority: oneOf(input.priority, ACTION_PRIORITIES, '중요도', '보통'),
    evidence: optionalText(input.evidence, '근거', 2_000),
  };
}

export function createAction(matterId: string, input: ActionInput) {
  const value = validateAction(input);
  return withDatabase((db) => transaction(db, () => {
    if (!db.prepare('SELECT id FROM matter WHERE id = ? AND archived_at IS NULL').get(matterId)) throw new WorkDbError('사건을 찾을 수 없습니다.', 404);
    if (value.workItemId && !db.prepare('SELECT id FROM work_item WHERE id = ? AND matter_id = ? AND archived_at IS NULL').get(value.workItemId, matterId)) {
      throw new WorkDbError('선택한 업무가 이 사건에 속하지 않습니다.', 400);
    }
    const id = randomUUID();
    const timestamp = now();
    db.prepare(`
      INSERT INTO action_item(id, matter_id, work_item_id, title, assignee, manager, status, due_date, priority, evidence, source_type, confidence, user_confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '장진태', ?, ?, ?, ?, 'user_input', 1, 1, ?, ?)
    `).run(id, matterId, value.workItemId, value.title, value.assignee, value.status, value.dueDate, value.priority, value.evidence, timestamp, timestamp);
    event(db, 'action_item', id, 'action_created', null, { ...value, matterId, manager: '장진태' });
    db.prepare('UPDATE matter SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, matterId);
    return getMatterFromDb(db, matterId);
  }));
}

export function updateAction(id: string, input: Partial<ActionInput> & { expectedVersion?: number }) {
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare('SELECT * FROM action_item WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('Action을 찾을 수 없습니다.', 404);
    if (input.expectedVersion !== undefined && Number(before.row_version) !== Number(input.expectedVersion)) throw new WorkDbError('다른 변경이 먼저 반영되었습니다.', 409);
    const value = validateAction({
      workItemId: input.workItemId === undefined ? before.work_item_id as string | null : input.workItemId,
      title: input.title ?? String(before.title),
      assignee: input.assignee ?? String(before.assignee),
      status: input.status ?? String(before.status),
      dueDate: input.dueDate === undefined ? before.due_date as string | null : input.dueDate,
      priority: input.priority ?? String(before.priority),
      evidence: input.evidence === undefined ? before.evidence as string | null : input.evidence,
    });
    const timestamp = now();
    db.prepare(`
      UPDATE action_item SET work_item_id = ?, title = ?, assignee = ?, status = ?, due_date = ?, priority = ?, evidence = ?,
        source_type = 'user_input', confidence = 1, user_confirmed = 1, row_version = row_version + 1, updated_at = ? WHERE id = ?
    `).run(value.workItemId, value.title, value.assignee, value.status, value.dueDate, value.priority, value.evidence, timestamp, id);
    const after = db.prepare('SELECT * FROM action_item WHERE id = ?').get(id) as Record<string, unknown>;
    event(db, 'action_item', id, 'action_updated', actionRow(before), actionRow(after));
    db.prepare('UPDATE matter SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, String(before.matter_id));
    return getMatterFromDb(db, String(before.matter_id));
  }));
}

export function archiveAction(id: string, expectedVersion?: number) {
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare('SELECT * FROM action_item WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('Action을 찾을 수 없습니다.', 404);
    if (expectedVersion !== undefined && Number(before.row_version) !== Number(expectedVersion)) throw new WorkDbError('다른 변경이 먼저 반영되었습니다.', 409);
    const timestamp = now();
    db.prepare('UPDATE action_item SET archived_at = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, timestamp, id);
    event(db, 'action_item', id, 'action_archived', actionRow(before), { archivedAt: timestamp });
    db.prepare('UPDATE matter SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(timestamp, String(before.matter_id));
    return getMatterFromDb(db, String(before.matter_id));
  }));
}

export function createBackup() {
  const backupRoot = backupDirectory();
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupRoot, `sspat-work-${stamp}.db`);
  return withDatabase((db) => {
    const escaped = destination.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    return { ok: true, file: destination, createdAt: now() };
  });
}

export function restoreBackup(backupFile: unknown, confirmation: unknown) {
  if (confirmation !== 'RESTORE') throw new WorkDbError('복구 확인 문자열이 올바르지 않습니다.', 400);
  const root = path.resolve(backupDirectory());
  const candidate = path.resolve(requiredText(backupFile, '백업 파일', 1_000));
  if (path.dirname(candidate) !== root || !/^sspat-work-[\w.-]+\.db$/i.test(path.basename(candidate)) || !existsSync(candidate)) {
    throw new WorkDbError('허용된 백업 폴더의 DB 파일만 복구할 수 있습니다.', 400);
  }

  const check = new DatabaseSync(candidate, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    if (Object.values(result)[0] !== 'ok') throw new WorkDbError('백업 DB 무결성 검사에 실패했습니다.', 400);
  } finally {
    check.close();
  }

  const current = databasePath();
  const safety = createBackup();
  rmSync(`${current}-wal`, { force: true });
  rmSync(`${current}-shm`, { force: true });
  copyFileSync(candidate, current);
  databaseStatus();
  return { ok: true, restoredFrom: candidate, safetyBackup: safety.file, restoredAt: now() };
}

type NotableEntity = 'matter' | 'organization' | 'person' | 'group';

export function updateEntityNote(entityType: NotableEntity, id: string, noteValue: unknown, expectedVersion?: number) {
  const tables: Record<NotableEntity, string> = { matter: 'matter', organization: 'organization', person: 'person', group: 'matter_group' };
  const table = tables[entityType];
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND archived_at IS NULL`).get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('비고 대상을 찾을 수 없습니다.', 404);
    if (expectedVersion !== undefined && Number(before.row_version) !== Number(expectedVersion)) throw new WorkDbError('다른 변경이 먼저 반영되었습니다.', 409);
    const note = optionalText(noteValue, '비고', MAX_TEXT);
    const timestamp = now();
    db.prepare(`UPDATE ${table} SET note = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?`).run(note, timestamp, id);
    event(db, entityType, id, 'note_updated', { note: before.note }, { note });
    const matterId = entityType === 'matter' ? id : null;
    if (matterId) return getMatterFromDb(db, matterId);
    return { ok: true, id, note, rowVersion: Number(before.row_version) + 1 };
  }));
}

export function createOrganization(matterId: string, input: { name?: unknown; businessType?: unknown; note?: unknown; role?: unknown }) {
  return withDatabase((db) => transaction(db, () => {
    if (!db.prepare('SELECT id FROM matter WHERE id = ? AND archived_at IS NULL').get(matterId)) throw new WorkDbError('사건을 찾을 수 없습니다.', 404);
    const name = requiredText(input.name, '회사명');
    const businessType = oneOf(input.businessType, BUSINESS_TYPES, '회사 구분', '미정');
    const note = optionalText(input.note, '회사 비고', MAX_TEXT);
    const role = optionalText(input.role, '회사 역할') || '고객';
    const timestamp = now();
    const existing = db.prepare('SELECT id,business_type,row_version FROM organization WHERE name = ? COLLATE NOCASE AND archived_at IS NULL').get(name) as { id?: string; business_type?: string; row_version?: number } | undefined;
    const id = existing?.id || randomUUID();
    if (!existing?.id) {
      db.prepare(`INSERT INTO organization(id, name, business_type, note, source_type, confidence, user_confirmed, created_at, updated_at) VALUES (?, ?, ?, ?, 'user_input', 1, 1, ?, ?)`).run(id, name, businessType, note, timestamp, timestamp);
      event(db, 'organization', id, 'organization_created', null, { name, businessType, note });
    } else if (businessType !== '미정' && existing.business_type !== businessType) {
      if (existing.business_type !== '미정') throw new WorkDbError('기존 회사의 회사 구분과 다릅니다. 회사 정보를 먼저 확인하세요.', 409, 'BUSINESS_TYPE_CONFLICT');
      db.prepare(`UPDATE organization SET business_type=?,source_type='user_input',confidence=1,user_confirmed=1,row_version=row_version+1,updated_at=? WHERE id=?`).run(businessType, timestamp, id);
      event(db, 'organization', id, 'organization_business_type_updated', { businessType: existing.business_type }, { businessType });
    }
    db.prepare(`INSERT OR IGNORE INTO matter_party(matter_id, party_type, party_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)`).run(matterId, id, role, timestamp);
    event(db, 'matter', matterId, 'organization_linked', null, { organizationId: id, role });
    return getMatterFromDb(db, matterId);
  }));
}

export function updateOrganizationBusinessType(id: string, businessTypeValue: unknown, expectedVersion?: number) {
  const businessType = oneOf(businessTypeValue, BUSINESS_TYPES, '회사 구분');
  return withDatabase((db) => transaction(db, () => {
    const before = db.prepare('SELECT * FROM organization WHERE id = ? AND archived_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!before) throw new WorkDbError('회사를 찾을 수 없습니다.', 404);
    if (expectedVersion !== undefined && Number(before.row_version) !== Number(expectedVersion)) throw new WorkDbError('다른 변경이 먼저 반영되었습니다.', 409);
    if (before.business_type === businessType) return { ok: true, id, businessType, rowVersion: Number(before.row_version), duplicate: true };
    const timestamp = now();
    db.prepare(`UPDATE organization SET business_type = ?, source_type = 'user_input', confidence = 1, user_confirmed = 1, row_version = row_version + 1, updated_at = ? WHERE id = ?`).run(businessType, timestamp, id);
    event(db, 'organization', id, 'organization_business_type_updated', { businessType: before.business_type }, { businessType });
    return { ok: true, id, businessType, rowVersion: Number(before.row_version) + 1, duplicate: false };
  }));
}

export function createPerson(matterId: string, input: { name?: unknown; email?: unknown; note?: unknown; organizationId?: unknown; role?: unknown }) {
  return withDatabase((db) => transaction(db, () => {
    if (!db.prepare('SELECT id FROM matter WHERE id = ? AND archived_at IS NULL').get(matterId)) throw new WorkDbError('사건을 찾을 수 없습니다.', 404);
    const name = requiredText(input.name, '자연인 이름');
    const email = optionalText(input.email, '이메일', 320)?.toLowerCase() || null;
    const note = optionalText(input.note, '자연인 비고', MAX_TEXT);
    const organizationId = optionalText(input.organizationId, '회사 ID', 100);
    if (organizationId && !db.prepare('SELECT id FROM organization WHERE id = ? AND archived_at IS NULL').get(organizationId)) throw new WorkDbError('연결할 회사를 찾을 수 없습니다.', 400);
    const role = optionalText(input.role, '자연인 역할') || '연락처';
    const timestamp = now();
    const existing = email ? db.prepare('SELECT id FROM person WHERE email = ? COLLATE NOCASE AND archived_at IS NULL').get(email) as { id?: string } | undefined : undefined;
    const id = existing?.id || randomUUID();
    if (!existing?.id) {
      db.prepare(`INSERT INTO person(id, name, email, organization_id, note, source_type, confidence, user_confirmed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'user_input', 1, 1, ?, ?)`).run(id, name, email, organizationId, note, timestamp, timestamp);
      event(db, 'person', id, 'person_created', null, { name, email, organizationId, note });
    }
    db.prepare(`INSERT OR IGNORE INTO matter_party(matter_id, party_type, party_id, role, created_at) VALUES (?, 'person', ?, ?, ?)`).run(matterId, id, role, timestamp);
    event(db, 'matter', matterId, 'person_linked', null, { personId: id, role });
    return getMatterFromDb(db, matterId);
  }));
}

export function createMatterGroup(matterId: string, input: { groupRef?: unknown; groupType?: unknown; note?: unknown }) {
  return withDatabase((db) => transaction(db, () => {
    if (!db.prepare('SELECT id FROM matter WHERE id = ? AND archived_at IS NULL').get(matterId)) throw new WorkDbError('사건을 찾을 수 없습니다.', 404);
    const groupRef = requiredText(input.groupRef, '그룹 식별번호', 100).toUpperCase();
    if (!/^G[A-Z0-9-]+$/.test(groupRef)) throw new WorkDbError('그룹 식별번호는 G로 시작해야 합니다.', 400);
    const note = optionalText(input.note, '그룹 비고', MAX_TEXT);
    const groupType = input.groupType === undefined ? undefined : requiredText(input.groupType, '그룹 종류', 100);
    const timestamp = now();
    const existing = db.prepare('SELECT id,group_type FROM matter_group WHERE group_ref = ? COLLATE NOCASE AND archived_at IS NULL').get(groupRef) as { id: string; group_type: string } | undefined;
    if (existing && groupType !== undefined && existing.group_type !== groupType) throw new WorkDbError('기존 그룹 종류와 다릅니다. 기존 그룹을 수정하거나 별도 식별번호를 사용하세요.', 409);
    const id = existing?.id || randomUUID();
    if (!existing?.id) {
      db.prepare('INSERT INTO matter_group(id, group_ref, group_type, representative_matter_id, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, groupRef, groupType || '미분류', matterId, note, timestamp, timestamp);
      event(db, 'group', id, 'group_created', null, { groupRef, groupType: groupType || '미분류', note, representativeMatterId: matterId });
    }
    db.prepare('INSERT OR IGNORE INTO matter_group_member(group_id, matter_id, created_at) VALUES (?, ?, ?)').run(id, matterId, timestamp);
    event(db, 'matter', matterId, 'group_linked', null, { groupId: id });
    return getMatterFromDb(db, matterId);
  }));
}

function operationalEvent(
  db: DatabaseSync,
  entityType: string,
  entityId: string,
  eventType: string,
  after: unknown,
  correlationId: string,
  sourceType: string,
) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO event(id, entity_type, entity_id, event_type, before_json, after_json, actor, source_type, correlation_id, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, 'Codex', ?, ?, ?)
  `).run(id, entityType, entityId, eventType, JSON.stringify(after), sourceType, correlationId, now());
  return id;
}

export function importConfirmedMatterGroups(input: ConfirmedGroupImport) {
  const sourceName = requiredText(input.sourceName, '원본 파일명', 500);
  const sourceHash = requiredText(input.sourceHash, '원본 해시', 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new WorkDbError('원본 해시는 SHA-256 형식이어야 합니다.', 400);
  const sourceLastModified = requiredText(input.sourceLastModified, '원본 수정시각', 100);
  if (!Array.isArray(input.groups) || !input.groups.length || input.groups.length > 100) throw new WorkDbError('확정 그룹 계획이 필요합니다.', 400);

  const groups = input.groups.map((raw) => {
    const groupRef = requiredText(raw.groupRef, '그룹 식별번호', 100).toUpperCase();
    if (!/^G[A-Z0-9-]+$/.test(groupRef)) throw new WorkDbError('그룹 식별번호는 G로 시작해야 합니다.', 400);
    const groupType = oneOf(raw.groupType, ['포트폴리오', '시리즈', '정부지원사업'], '그룹 종류');
    const representativeRef = parseMatterNumber(raw.representativeRef).normalized;
    const members = [...new Set((raw.members || []).map((value) => parseMatterNumber(value).normalized))];
    if (members.length < 2 || !members.includes(representativeRef)) throw new WorkDbError(`${groupRef}의 대표 사건은 2건 이상의 구성원에 포함되어야 합니다.`, 400);
    const note = requiredText(raw.note, '그룹 비고', MAX_TEXT);
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new WorkDbError('그룹 신뢰도 값이 올바르지 않습니다.', 400);
    if (!Array.isArray(raw.evidence) || !raw.evidence.length || raw.evidence.length > 20) throw new WorkDbError(`${groupRef}의 Excel 근거가 필요합니다.`, 400);
    const evidence = raw.evidence.map((item) => ({
      sheet: requiredText(item.sheet, '근거 시트', 200),
      range: requiredText(item.range, '근거 범위', 100),
      excerpt: requiredText(item.excerpt, '근거 인용', 4000),
    }));
    return { groupRef, groupType, representativeRef, members, note, confidence, evidence };
  });
  if (new Set(groups.map((group) => group.groupRef)).size !== groups.length) throw new WorkDbError('그룹 식별번호가 중복되었습니다.', 400);

  const context = { sourceName, sourceHash, sourceLastModified, groups };
  const contextJson = JSON.stringify(context);
  const contextHash = createHash('sha256').update(contextJson).digest('hex');
  const sourceId = `${sourceName}@sha256:${sourceHash}`;
  const timestamp = now();

  return withDatabase((db) => transaction(db, () => {
    const duplicate = db.prepare(`
      SELECT r.id
      FROM decision_run r
      JOIN input_snapshot s ON s.id = r.input_snapshot_id
      WHERE r.operation = 'group_reconciliation' AND r.status = 'succeeded' AND s.context_hash = ?
      LIMIT 1
    `).get(contextHash) as { id?: string } | undefined;
    if (duplicate?.id) return { runId: duplicate.id, duplicate: true, groupCount: groups.length, createdGroups: 0, createdMatters: 0, linkedMembers: 0 };

    const runId = randomUUID();
    const snapshotId = randomUUID();
    const sourcePolicy = loadSourcePriorityPolicy();
    const policyId = 'group-reconciliation-v2';
    const policyHash = createHash('sha256').update(`group-reconciliation-v2:${sourcePolicy.externalPriority.join('>')}:${sourcePolicy.contentHash}`).digest('hex');
    const entityVersions: Record<string, number> = {};
    for (const ref of new Set(groups.flatMap((group) => group.members))) {
      const existing = db.prepare('SELECT id,row_version FROM matter WHERE our_ref=? COLLATE NOCASE AND archived_at IS NULL').get(ref) as { id: string; row_version: number } | undefined;
      if (existing) entityVersions[`matter:${existing.id}`] = existing.row_version;
    }
    db.prepare(`INSERT OR IGNORE INTO policy_revision(id,revision_type,version,artifact_paths_json,content_hash,status,created_at) VALUES (?,'workflow','group-reconciliation-v2',? ,?,'active',?)`)
      .run(policyId, JSON.stringify(['config/source-priority.toml', 'docs/WORK_MANAGEMENT_ARCHITECTURE.md', 'docs/DECISION_FEEDBACK_DESIGN.md']), policyHash, timestamp);
    db.prepare(`INSERT INTO input_snapshot(id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,'[]',?,?,?,?,?)`)
      .run(snapshotId, JSON.stringify(entityVersions), SOURCE_PRIORITY_VERSION, contextHash, contextJson, timestamp);
    db.prepare(`INSERT INTO decision_run(id,operation,agent_name,prompt_version,policy_revision_id,routing_snapshot_json,input_snapshot_id,status,started_at) VALUES (?,'group_reconciliation','deterministic_group_reconciler','group-reconciliation-v2',?,? ,?,'started',?)`)
      .run(runId, policyId, JSON.stringify({ method: 'deterministic', sourcePriority: sourcePolicy.externalPriority, userConfirmedProtected: true, model: null, effort: null }), snapshotId, timestamp);

    let createdGroups = 0;
    let createdMatters = 0;
    let linkedMembers = 0;
    const matterIds = new Map<string, string>();
    for (const group of groups) {
      for (const ref of group.members) {
        if (matterIds.has(ref)) continue;
        const existing = db.prepare('SELECT id FROM matter WHERE our_ref=? COLLATE NOCASE AND archived_at IS NULL').get(ref) as { id: string } | undefined;
        if (existing) {
          matterIds.set(ref, existing.id);
          continue;
        }
        const parsed = parseMatterNumber(ref);
        const id = randomUUID();
        const evidence = groups.find((candidate) => candidate.members.includes(ref))!.evidence[0];
        const evidenceId = `${sourceId}#${evidence.sheet}!${evidence.range}`;
        db.prepare(`
          INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,parent_ref,relation_type,suffixes_json,source_type,source_id,confidence,user_confirmed,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'excel',?,?,0,?,?)
        `).run(id, parsed.normalized, parsed.office, parsed.kind, parsed.countryCode, parsed.baseRef, parsed.parentRef, parsed.relationType, JSON.stringify(parsed.suffixes), evidenceId, group.confidence, timestamp, timestamp);
        operationalEvent(db, 'matter', id, 'matter_created_from_excel_group_evidence', { ourRef: ref, sourceId: evidenceId, confidence: group.confidence }, runId, 'excel');
        matterIds.set(ref, id);
        createdMatters += 1;
      }

      const representativeId = matterIds.get(group.representativeRef)!;
      const existingGroup = db.prepare(`
        SELECT g.id,g.group_type,g.representative_matter_id,m.our_ref AS representative_ref
        FROM matter_group g LEFT JOIN matter m ON m.id=g.representative_matter_id
        WHERE g.group_ref=? COLLATE NOCASE AND g.archived_at IS NULL
      `).get(group.groupRef) as { id: string; group_type: string; representative_matter_id: string; representative_ref: string } | undefined;
      if (existingGroup && (existingGroup.group_type !== group.groupType || existingGroup.representative_ref !== group.representativeRef)) {
        throw new WorkDbError(`${group.groupRef}의 기존 종류 또는 대표 사건이 계획과 다릅니다.`, 409);
      }
      const groupId = existingGroup?.id || randomUUID();
      if (!existingGroup) {
        db.prepare('INSERT INTO matter_group(id,group_ref,group_type,representative_matter_id,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(groupId, group.groupRef, group.groupType, representativeId, group.note, timestamp, timestamp);
        operationalEvent(db, 'group', groupId, 'group_created_from_excel_evidence', { groupRef: group.groupRef, groupType: group.groupType, representativeRef: group.representativeRef, note: group.note }, runId, 'excel');
        createdGroups += 1;
      }

      for (const ref of group.members) {
        const matterId = matterIds.get(ref)!;
        const linked = db.prepare('INSERT OR IGNORE INTO matter_group_member(group_id,matter_id,created_at) VALUES (?,?,?)').run(groupId, matterId, timestamp);
        if (Number(linked.changes) > 0) {
          operationalEvent(db, 'matter', matterId, 'group_linked_from_excel_evidence', { groupId, groupRef: group.groupRef }, runId, 'excel');
          linkedMembers += 1;
        }
        db.prepare(`INSERT INTO source_observation(id,entity_type,entity_id,field_path,observed_value_json,source_type,source_id,observed_at,confidence,user_confirmed) VALUES (?,'matter',?,'groups.membership',?,'excel',?,?,?,0)`)
          .run(randomUUID(), matterId, JSON.stringify(group.groupRef), sourceId, timestamp, group.confidence);
      }

      const decisions = [
        ['group.type', group.groupType],
        ['group.representative', group.representativeRef],
        ['group.members', group.members],
      ] as const;
      for (const [fieldPath, value] of decisions) {
        const decisionId = randomUUID();
        const valueJson = JSON.stringify(value);
        db.prepare(`INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at) VALUES (?,?,'group',?,?,'create',?,?,?,'medium','Excel의 동일 업무행에 그룹 종류와 구성원이 직접 기재됨','not_reviewed',?)`)
          .run(decisionId, runId, groupId, fieldPath, valueJson, valueJson, group.confidence, timestamp);
        for (const evidence of group.evidence) {
          db.prepare(`INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'excel',?,?,?,?, 'support')`)
            .run(randomUUID(), decisionId, sourceId, JSON.stringify({ sheet: evidence.sheet, range: evidence.range }), evidence.excerpt, createHash('sha256').update(evidence.excerpt).digest('hex'));
        }
      }
    }

    const result = { runId, duplicate: false, groupCount: groups.length, createdGroups, createdMatters, linkedMembers };
    const resultJson = JSON.stringify(result);
    db.prepare(`UPDATE decision_run SET status='succeeded',completed_at=?,output_hash=?,result_json=? WHERE id=?`)
      .run(now(), createHash('sha256').update(resultJson).digest('hex'), resultJson, runId);
    return result;
  }));
}

export function updateGroupType(id: string, value: unknown, expectedVersion: unknown) {
  return withDatabase(db => transaction(db, () => {
    const current = db.prepare('SELECT * FROM matter_group WHERE id=? AND archived_at IS NULL').get(id);
    if (!current) throw new WorkDbError('그룹을 찾을 수 없습니다.', 404);
    if (current.row_version !== expectedVersion) throw new WorkDbError('그룹이 변경되었습니다. 새로고침하세요.', 409);
    const groupType = requiredText(value, '그룹 종류', 100);
    db.prepare('UPDATE matter_group SET group_type=?,row_version=row_version+1,updated_at=? WHERE id=?').run(groupType, now(), id);
    event(db, 'group', id, 'group_type_changed', { groupType: current.group_type }, { groupType });
    return groupRow(db.prepare('SELECT * FROM matter_group WHERE id=?').get(id)!);
  }));
}

function findMatterRefs(subject: string, body: string) {
  const candidates = new Map<string, 'subject' | 'body'>();
  for (const ref of matterReferenceTokens(subject)) candidates.set(ref, 'subject');
  for (const ref of matterReferenceTokens(body)) if (!candidates.has(ref)) candidates.set(ref, 'body');
  const result: Array<{ ref: string; source: 'subject' | 'body' }> = [];
  for (const [candidate, source] of candidates) {
    try { result.push({ ref: parseMatterNumber(candidate).normalized, source }); } catch { /* unknown patterns remain unlinked */ }
  }
  return result;
}

function ensureMailMatter(db: DatabaseSync, ref: string, source: 'subject' | 'body', mailId: string, timestamp: string) {
  const existing = db.prepare('SELECT id FROM matter WHERE our_ref = ? COLLATE NOCASE AND archived_at IS NULL').get(ref) as { id?: string } | undefined;
  if (existing?.id) return existing.id;
  const parsed = parseMatterNumber(ref);
  const id = randomUUID();
  const confidence = source === 'subject' ? 0.85 : 0.7;
  db.prepare(`INSERT INTO matter(id, our_ref, office, matter_kind, country_code, base_ref, parent_ref, relation_type, suffixes_json, source_type, source_id, confidence, user_confirmed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mail_inference', ?, ?, 0, ?, ?)`)
    .run(id, parsed.normalized, parsed.office, parsed.kind, parsed.countryCode, parsed.baseRef, parsed.parentRef, parsed.relationType, JSON.stringify(parsed.suffixes), mailId, confidence, timestamp, timestamp);
  return id;
}

function newMessageBody(body: string) {
  const cleaned = body.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return cleaned.split(/\n(?:From:|보낸 사람:|발신:|-----Original Message-----)/i)[0].trim() || cleaned;
}

function summaryExcerpt(body: string) {
  return newMessageBody(body).slice(0, 320);
}

function rebuildDailySummary(db: DatabaseSync, matterId: string, summaryDate: string) {
  const rows = db.prepare(`SELECT mi.id, mi.direction, mi.subject, mi.body_text FROM mail_item mi JOIN mail_matter_link l ON l.mail_id = mi.id WHERE l.matter_id = ? AND substr(mi.mail_at, 1, 10) = ? ORDER BY mi.mail_at ASC`).all(matterId, summaryDate) as Array<Record<string, unknown>>;
  const content = rows.slice(0, 20).map((row) => `- [${row.direction === 'sent' ? '보낸 메일' : '받은 메일'}] ${String(row.subject)}${summaryExcerpt(String(row.body_text)) ? ` — ${summaryExcerpt(String(row.body_text))}` : ''}`).join('\n');
  const sourceIds = rows.map((row) => String(row.id));
  const existing = db.prepare('SELECT id FROM mail_daily_summary WHERE matter_id = ? AND summary_date = ?').get(matterId, summaryDate) as { id?: string } | undefined;
  const timestamp = now();
  if (existing?.id) db.prepare(`UPDATE mail_daily_summary SET content = ?, source_mail_ids_json = ?, summary_type = 'deterministic', model = NULL, row_version = row_version + 1, updated_at = ? WHERE id = ?`).run(content, JSON.stringify(sourceIds), timestamp, existing.id);
  else db.prepare(`INSERT INTO mail_daily_summary(id, matter_id, summary_date, content, source_mail_ids_json, summary_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'deterministic', ?, ?)`).run(randomUUID(), matterId, summaryDate, content, JSON.stringify(sourceIds), timestamp, timestamp);
}

export function importOutlookMail(records: OutlookMailRecord[], range: {
  from: string;
  to: string;
  folders: string[];
  workRefreshRunId?: string;
  workRefreshStageId?: string;
}) {
  return withDatabase((db) => transaction(db, () => {
    const syncId = randomUUID();
    const startedAt = now();
    const tracked = Boolean(range.workRefreshRunId || range.workRefreshStageId);
    if (tracked && (!range.workRefreshRunId || !range.workRefreshStageId)) throw new WorkDbError('업무 정리 실행과 수집 단계 ID를 함께 지정하세요.', 400);
    if (tracked) {
      const stage = db.prepare(`
        SELECT s.stage_key,s.status,r.mail_window_from,r.mail_window_to
        FROM work_refresh_stage s JOIN work_refresh_run r ON r.id=s.work_refresh_run_id
        WHERE s.id=? AND s.work_refresh_run_id=?
      `).get(range.workRefreshStageId!, range.workRefreshRunId!) as Record<string, unknown> | undefined;
      if (!stage || stage.stage_key !== 'collection' || stage.status !== 'running') throw new WorkDbError('실행 중인 메일 수집 단계가 아닙니다.', 409, 'WORK_REFRESH_COLLECTION_STATE');
      if (stage.mail_window_from !== new Date(range.from).toISOString() || stage.mail_window_to !== new Date(range.to).toISOString()) throw new WorkDbError('업무 정리 실행과 수집 기간이 일치하지 않습니다.', 409, 'WORK_REFRESH_RANGE_MISMATCH');
    }
    db.prepare(`
      INSERT INTO sync_run(
        id,requested_from,requested_to,folder_scope_json,status,started_at,work_refresh_run_id,work_refresh_stage_id
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(syncId, range.from, range.to, JSON.stringify(range.folders), startedAt, range.workRefreshRunId ?? null, range.workRefreshStageId ?? null);
    let imported = 0;
    let skipped = 0;
    let linked = 0;
    let targeted = 0;
    const affected = new Set<string>();
    for (const raw of records) {
      const entryId = requiredText(raw.entryId, 'Outlook EntryID', 1_000);
      const existingMail = db.prepare('SELECT id FROM mail_item WHERE outlook_entry_id = ?').get(entryId) as { id?: string } | undefined;
      let mailId = existingMail?.id ?? randomUUID();
      const subject = String(raw.subject || '').trim().slice(0, 1_000);
      const body = String(raw.body || '').slice(0, 100_000);
      const mailAt = new Date(raw.mailAt).toISOString();
      if (existingMail?.id) skipped += 1;
      else {
        const bodyHash = createHash('sha256').update(body).digest('hex');
        const recipients = Array.isArray(raw.recipients) ? raw.recipients.slice(0, 200).map((recipient) => ({
          type: ['to', 'cc', 'bcc'].includes(String(recipient?.type).toLowerCase()) ? String(recipient.type).toLowerCase() : 'unknown',
          displayName: String(recipient?.displayName ?? '').trim().slice(0, 300) || null,
          smtpAddress: String(recipient?.smtpAddress ?? '').trim().toLowerCase().slice(0, 320) || null,
          resolved: Boolean(recipient?.resolved),
        })) : [];
        const recipientEvidence = { to: raw.to || null, cc: raw.cc || null, storeDisplayName: raw.storeDisplayName || null, recipients };
        const recipientSnapshotHash = createHash('sha256').update(JSON.stringify(recipientEvidence)).digest('hex');
        db.prepare(`INSERT INTO mail_item(id, outlook_entry_id, internet_message_id, conversation_id, folder_path, direction, subject, sender_name, sender_email, recipients_json, mail_at, body_text, body_hash, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(mailId, entryId, raw.internetMessageId || null, raw.conversationId || null, raw.folderPath, raw.direction, subject || '(제목 없음)', raw.senderName || null, raw.senderEmail || null, JSON.stringify({ ...recipientEvidence, recipientSnapshotHash }), mailAt, body, bodyHash, startedAt);
        imported += 1;
        for (const match of findMatterRefs(subject, newMessageBody(body))) {
          const matterId = ensureMailMatter(db, match.ref, match.source, mailId, startedAt);
          const confidence = match.source === 'subject' ? 0.85 : 0.7;
          const result = db.prepare('INSERT OR IGNORE INTO mail_matter_link(mail_id, matter_id, match_source, confidence, created_at) VALUES (?, ?, ?, ?, ?)').run(mailId, matterId, match.source, confidence, startedAt);
          if (Number(result.changes)) linked += 1;
          affected.add(`${matterId}|${mailAt.slice(0, 10)}`);
        }
      }
      if (tracked) {
        const result = db.prepare(`INSERT OR IGNORE INTO work_refresh_mail(
          work_refresh_run_id,mail_id,source_sync_run_id,review_status,created_at,updated_at
        ) VALUES (?,?,?,'pending',?,?)`).run(range.workRefreshRunId!, mailId, syncId, startedAt, startedAt);
        if (Number(result.changes)) targeted += 1;
        else db.prepare(`UPDATE work_refresh_mail SET
          source_sync_run_id=COALESCE(source_sync_run_id,?),updated_at=?
          WHERE work_refresh_run_id=? AND mail_id=?`).run(syncId, startedAt, range.workRefreshRunId!, mailId);
      }
    }
    for (const key of affected) {
      const [matterId, date] = key.split('|');
      rebuildDailySummary(db, matterId, date);
    }
    db.prepare(`UPDATE sync_run SET status = 'completed', processed_count = ?, error_count = 0, completed_at = ? WHERE id = ?`).run(imported + skipped, now(), syncId);
    if (tracked) {
      const targetCounts = db.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(CASE WHEN review_status='pending' THEN 1 ELSE 0 END),0) AS pending FROM work_refresh_mail WHERE work_refresh_run_id=?`).get(range.workRefreshRunId!) as { n: number; pending: number };
      db.prepare('UPDATE work_refresh_run SET target_mail_count=?,pending_mail_count=?,updated_at=? WHERE id=?')
        .run(Number(targetCounts.n), Number(targetCounts.pending), now(), range.workRefreshRunId!);
    }
    return { ok: true, syncId, received: records.length, imported, skipped, linked, targeted, affectedSummaries: affected.size };
  }));
}

export function listSyncRuns() {
  return withDatabase((db) => db.prepare(`SELECT id, requested_from AS requestedFrom, requested_to AS requestedTo, folder_scope_json AS folderScopeJson, status, processed_count AS processedCount, error_count AS errorCount, started_at AS startedAt, completed_at AS completedAt, work_refresh_run_id AS workRefreshRunId, work_refresh_stage_id AS workRefreshStageId FROM sync_run ORDER BY started_at DESC LIMIT 20`).all().map((row: any) => ({ ...row, folders: parseJson(row.folderScopeJson, []) })));
}
