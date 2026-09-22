import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { SERVICE_TYPES, transaction, withDatabase, WorkDbError } from './work-db';
import { SPECIFICATION_STAGE_KEYS, specificationSetupSteps, specificationStageNumber, specificationStages } from './specification-workflow';

const execFileAsync = promisify(execFile);
const DEFAULT_ROOT = String.raw`C:\ChatGPT\AI-Work\10_특허\한국특허명세서작성`;
const EXCLUDED = new Set(['_shared', '_eval', '프로젝트폴더샘플', 'archive', 'archived']);
const INVENTION_TYPES = ['방법', '장치', '조성물', '혼합', '기타'] as const;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)]);
const MAX_JSON_BYTES = 1024 * 1024;

type CaseFile = {
  schema_version?: string;
  is_template?: boolean;
  case_id?: string | null;
  project_name?: string | null;
  service_type?: string | null;
  invention_type?: string | null;
  creation_direction?: string | null;
  stage?: string;
  status?: string;
  owner?: string | null;
  shared_version?: string;
  latest_outputs?: Array<Record<string, unknown>>;
  review?: Record<string, unknown>;
  approvals?: Array<Record<string, unknown>>;
  unresolved_items?: unknown[];
  next_action?: string;
  updated_at?: string | null;
};

type SetupInput = {
  caseId?: unknown;
  clientLabel?: unknown;
  projectName?: unknown;
  serviceType?: unknown;
  inventionType?: unknown;
  creationDirection?: unknown;
  owner?: unknown;
};

function rootPath() {
  return path.resolve(process.env.SSPAT_SPEC_PROJECT_ROOT || DEFAULT_ROOT);
}

function harnessPath() {
  return path.resolve(process.env.SSPAT_SPEC_HARNESS_PATH || path.join(rootPath(), '_shared', 'scripts', 'harness.py'));
}

function pythonCommand() {
  return process.env.SSPAT_SPEC_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function now() {
  return new Date().toISOString();
}

function sha(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function projectId(name: string) {
  return sha(name).slice(0, 24);
}

function required(value: unknown, label: string, max = 200) {
  const text = String(value ?? '').trim();
  if (!text) throw new WorkDbError(`${label}을(를) 입력하세요.`, 400, 'SPEC_REQUIRED');
  if (text.length > max) throw new WorkDbError(`${label}은(는) ${max}자 이하여야 합니다.`, 400, 'SPEC_TOO_LONG');
  return text;
}

function optional(value: unknown, max = 2000) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length > max) throw new WorkDbError(`입력값은 ${max}자 이하여야 합니다.`, 400, 'SPEC_TOO_LONG');
  return text;
}

function safeFolderName(value: unknown) {
  const name = required(value, '프로젝트 폴더명', 120);
  const stem = name.split('.')[0].toUpperCase();
  const hasControlCharacter = Array.from(name).some((character) => character.charCodeAt(0) < 32);
  if (name === '.' || name === '..' || name.startsWith('_') || EXCLUDED.has(name.toLowerCase()) || RESERVED.has(stem)
    || /[<>:"/\\|?*]/.test(name) || hasControlCharacter || name.endsWith(' ') || name.endsWith('.')) {
    throw new WorkDbError('프로젝트명은 경로 구분자·예약 이름을 제외한 단일 폴더명이어야 합니다.', 400, 'SPEC_INVALID_PROJECT_NAME');
  }
  return name;
}

function asOneOf(value: unknown, choices: readonly string[], label: string) {
  const text = required(value, label);
  if (!choices.includes(text)) throw new WorkDbError(`${label} 값이 올바르지 않습니다.`, 400, 'SPEC_INVALID_OPTION');
  return text;
}

async function exists(candidate: string) {
  try { await stat(candidate); return true; } catch { return false; }
}

async function verifiedRoot() {
  const root = rootPath();
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid');
    return await realpath(root);
  } catch {
    throw new WorkDbError('한국특허명세서작성 루트 폴더를 찾을 수 없습니다.', 503, 'SPEC_ROOT_UNAVAILABLE');
  }
}

async function safeProjectDirectories() {
  let root: string;
  try { root = await verifiedRoot(); } catch { return [] as Array<{ name: string; fullPath: string }>; }
  const entries = await readdir(root, { withFileTypes: true });
  const result: Array<{ name: string; fullPath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || EXCLUDED.has(entry.name.toLowerCase())) continue;
    const fullPath = path.join(root, entry.name);
    try {
      const resolved = await realpath(fullPath);
      if (path.dirname(resolved).toLowerCase() === root.toLowerCase()) result.push({ name: entry.name, fullPath: resolved });
    } catch { /* An unreadable case is omitted instead of traversed. */ }
  }
  return result;
}

async function readSmallJson<T>(file: string): Promise<{ value: T | null; error: string | null }> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_JSON_BYTES) return { value: null, error: '파일 크기 또는 형식이 허용 범위를 벗어났습니다.' };
    const parsed = JSON.parse(await readFile(file, 'utf8')) as T;
    return { value: parsed, error: null };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { value: null, error: null };
    return { value: null, error: error instanceof SyntaxError ? 'case.yaml JSON 형식이 올바르지 않습니다.' : '파일을 읽지 못했습니다.' };
  }
}

async function readText(file: string, maxBytes = 300_000) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(file, 'utf8');
  } catch { return null; }
}

function setupRow(row: Record<string, unknown>) {
  return {
    id: String(row.id), caseId: String(row.case_id), clientLabel: String(row.client_label), projectName: String(row.project_name),
    projectRelativePath: row.project_relative_path === null ? null : String(row.project_relative_path), serviceType: String(row.service_type), inventionType: String(row.invention_type),
    creationDirection: row.creation_direction === null ? null : String(row.creation_direction), owner: String(row.owner), status: String(row.status), rowVersion: Number(row.row_version),
    previewToken: row.preview_token === null ? null : String(row.preview_token), lastError: row.last_error === null ? null : String(row.last_error), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function stepRow(row: Record<string, unknown>) {
  return {
    key: row.step_key, status: row.status, actor: row.actor, confirmedAt: row.confirmed_at,
    evidenceType: row.evidence_type, evidenceRef: row.evidence_ref, updatedAt: row.updated_at,
  };
}

function setupFingerprint(setup: ReturnType<typeof setupRow>, sampleHash: string) {
  return sha(JSON.stringify({
    caseId: setup.caseId, clientLabel: setup.clientLabel, projectName: setup.projectName,
    serviceType: setup.serviceType, inventionType: setup.inventionType,
    creationDirection: setup.creationDirection, owner: setup.owner, sampleHash,
  }));
}

async function fileManifestHash(directory: string) {
  const rows: string[] = [];
  async function walk(current: string, relative = ''): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
      if (entry.isSymbolicLink()) throw new WorkDbError('샘플 폴더의 외부 링크는 복사할 수 없습니다.', 409, 'SPEC_TEMPLATE_LINK');
      const next = path.join(current, entry.name);
      const rel = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(next, rel);
      else if (entry.isFile()) rows.push(`${rel}:${sha(await readFile(next))}`);
    }
  }
  await walk(directory);
  return sha(rows.join('\n'));
}

async function runHarness<T extends Record<string, unknown> = Record<string, unknown>>(args: string[], acceptFailure = false): Promise<T> {
  const script = harnessPath();
  if (!(await exists(script))) throw new WorkDbError('고정 명세서 하네스 스크립트를 찾을 수 없습니다.', 503, 'SPEC_HARNESS_UNAVAILABLE');
  try {
    const result = await execFileAsync(pythonCommand(), [script, ...args], {
      cwd: rootPath(), shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout) as T;
  } catch (error: any) {
    const raw = String(error?.stdout || '').trim();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* handled below */ }
    if (acceptFailure && parsed) return parsed as T;
    throw new WorkDbError(String(parsed?.error || error?.stderr || error?.message || '하네스 실행에 실패했습니다.'), 409, 'SPEC_HARNESS_FAILED');
  }
}

function event(db: any, setupId: string, eventType: string, actor: string, detail: unknown) {
  db.prepare('INSERT INTO specification_setup_event(id,setup_id,event_type,actor,detail_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), setupId, eventType, actor, JSON.stringify(detail), now());
}

export function createSpecificationSetup(input: SetupInput) {
  const caseId = required(input.caseId, '당소관리번호', 100);
  const clientLabel = required(input.clientLabel, '의뢰인 식별명', 100);
  const projectName = safeFolderName(input.projectName || `${caseId}_${clientLabel}`);
  const serviceType = asOneOf(input.serviceType, SERVICE_TYPES, '서비스 종류');
  const inventionType = asOneOf(input.inventionType, INVENTION_TYPES, '발명 유형');
  const creationDirection = optional(input.creationDirection);
  const owner = required(input.owner, '담당자', 100);
  if (serviceType === '메이킹' && !creationDirection) throw new WorkDbError('메이킹 사건은 창작 방향을 입력해야 합니다.', 400, 'SPEC_DIRECTION_REQUIRED');
  const id = randomUUID(), at = now();
  withDatabase((db) => transaction(db, () => {
    db.prepare(`INSERT INTO specification_setup(id,case_id,client_label,project_name,service_type,invention_type,creation_direction,owner,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?, 'preparing', ?,?)`).run(id, caseId, clientLabel, projectName, serviceType, inventionType, creationDirection, owner, at, at);
    const insert = db.prepare('INSERT INTO specification_setup_step(setup_id,step_key,status,actor,confirmed_at,evidence_type,evidence_ref,updated_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const step of specificationSetupSteps) {
      const complete = step.key === 'case_info';
      insert.run(id, step.key, complete ? 'confirmed' : step.actor === '사용자' ? 'user_action' : 'pending', step.actor, complete ? at : null, complete ? 'form' : null, complete ? '사건 정보 입력 완료' : null, at);
    }
    event(db, id, 'case_info_confirmed', '사용자', { caseId, projectName, serviceType, inventionType });
  }));
  return getSpecificationSetup(id);
}

export function listSpecificationSetups(limitValue: unknown = 20) {
  const limit = Math.min(100, Math.max(1, Number(limitValue) || 20));
  return withDatabase((db) => ({ setups: (db.prepare('SELECT * FROM specification_setup ORDER BY updated_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>).map(setupRow) }));
}

export function getSpecificationSetup(id: string) {
  return withDatabase((db) => {
    const row = db.prepare('SELECT * FROM specification_setup WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new WorkDbError('신규 사건 준비 기록을 찾을 수 없습니다.', 404, 'SPEC_SETUP_NOT_FOUND');
    const steps = db.prepare('SELECT * FROM specification_setup_step WHERE setup_id=? ORDER BY rowid').all(id) as Array<Record<string, unknown>>;
    const events = db.prepare('SELECT * FROM specification_setup_event WHERE setup_id=? ORDER BY created_at DESC LIMIT 50').all(id) as Array<Record<string, unknown>>;
    return { setup: setupRow(row), steps: steps.map(stepRow), events: events.map((item) => ({ id: item.id, eventType: item.event_type, actor: item.actor, detail: JSON.parse(String(item.detail_json)), createdAt: item.created_at })) };
  });
}

export async function previewSpecificationSetup(id: string) {
  const { setup } = getSpecificationSetup(id);
  if (!['preparing', 'previewed', 'failed'].includes(String(setup.status))) throw new WorkDbError('현재 상태에서는 복사 계획을 다시 만들 수 없습니다.', 409, 'SPEC_SETUP_STATE');
  const root = await verifiedRoot();
  const destination = path.join(root, String(setup.projectName));
  if (await exists(destination)) throw new WorkDbError('동일한 사건 폴더가 이미 있어 덮어쓸 수 없습니다.', 409, 'SPEC_PROJECT_EXISTS');
  const sample = path.join(root, '프로젝트폴더샘플');
  const sampleHash = await fileManifestHash(sample);
  const fingerprint = setupFingerprint(setup, sampleHash);
  const args = ['init', '--root', root, '--name', String(setup.projectName), '--case-id', String(setup.caseId), '--service-type', String(setup.serviceType)];
  if (setup.creationDirection) args.push('--direction', String(setup.creationDirection));
  const plan = await runHarness<{ mode: string; destination: string; files: string[] }>(args);
  const previewToken = randomUUID(), at = now();
  withDatabase((db) => transaction(db, () => {
    db.prepare(`UPDATE specification_setup SET status='previewed',preview_token=?,preview_fingerprint=?,sample_sha256=?,last_error=NULL,row_version=row_version+1,updated_at=? WHERE id=?`)
      .run(previewToken, fingerprint, sampleHash, at, id);
    db.prepare(`UPDATE specification_setup_step SET status='confirmed',confirmed_at=?,evidence_type='dry_run',evidence_ref=?,input_fingerprint=?,updated_at=? WHERE setup_id=? AND step_key='copy_preview'`)
      .run(at, JSON.stringify(plan), fingerprint, at, id);
    event(db, id, 'copy_preview_confirmed', '시스템', { destination, sampleHash });
  }));
  return { ...getSpecificationSetup(id), preview: { ...plan, previewToken, sampleHash } };
}

export async function initializeSpecificationSetup(id: string, input: { previewToken?: unknown }) {
  const { setup } = getSpecificationSetup(id);
  if (setup.status !== 'previewed' || String(input?.previewToken || '') !== setup.previewToken) throw new WorkDbError('유효한 최신 dry-run 결과가 필요합니다.', 409, 'SPEC_PREVIEW_REQUIRED');
  const root = await verifiedRoot(), sample = path.join(root, '프로젝트폴더샘플');
  const destination = path.join(root, String(setup.projectName));
  if (await exists(destination)) throw new WorkDbError('동일한 사건 폴더가 이미 있어 덮어쓸 수 없습니다.', 409, 'SPEC_PROJECT_EXISTS');
  const sampleHash = await fileManifestHash(sample), fingerprint = setupFingerprint(setup, sampleHash);
  const stored = withDatabase((db) => db.prepare('SELECT preview_fingerprint,sample_sha256 FROM specification_setup WHERE id=?').get(id) as Record<string, unknown>);
  if (stored.preview_fingerprint !== fingerprint || stored.sample_sha256 !== sampleHash) throw new WorkDbError('입력 또는 샘플이 dry-run 이후 변경되었습니다. 다시 검증하세요.', 409, 'SPEC_PREVIEW_STALE');
  const claimed = withDatabase((db) => transaction(db, () => db.prepare(`UPDATE specification_setup SET status='creating',row_version=row_version+1,updated_at=? WHERE id=? AND status='previewed' AND preview_token=? AND row_version=?`)
    .run(now(), id, String(input.previewToken), setup.rowVersion).changes));
  if (claimed !== 1) throw new WorkDbError('다른 초기화 요청이 먼저 시작되었습니다. 현재 상태를 다시 확인하세요.', 409, 'SPEC_INIT_CONFLICT');
  try {
    const args = ['init', '--root', root, '--name', String(setup.projectName), '--case-id', String(setup.caseId), '--service-type', String(setup.serviceType)];
    if (setup.creationDirection) args.push('--direction', String(setup.creationDirection));
    args.push('--apply');
    const result = await runHarness(args);
    const casePath = path.join(destination, 'case.yaml');
    const caseFile = JSON.parse(await readFile(casePath, 'utf8')) as CaseFile;
    caseFile.invention_type = String(setup.inventionType);
    caseFile.owner = String(setup.owner);
    const temporary = `${casePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(caseFile, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, casePath);
    const at = now();
    withDatabase((db) => transaction(db, () => {
      db.prepare(`UPDATE specification_setup SET status='created',project_relative_path=?,preview_token=NULL,last_error=NULL,row_version=row_version+1,updated_at=? WHERE id=?`).run(String(setup.projectName), at, id);
      db.prepare(`UPDATE specification_setup_step SET status='confirmed',confirmed_at=?,evidence_type='harness_apply',evidence_ref=?,input_fingerprint=?,updated_at=? WHERE setup_id=? AND step_key='folder_creation'`)
        .run(at, JSON.stringify(result), fingerprint, at, id);
      event(db, id, 'folder_created', '시스템', { destination, sampleHash });
    }));
    return { ...getSpecificationSetup(id), project: await getSpecificationProject(projectId(String(setup.projectName))) };
  } catch (error: any) {
    withDatabase((db) => db.prepare(`UPDATE specification_setup SET status='failed',last_error=?,row_version=row_version+1,updated_at=? WHERE id=?`).run(String(error?.message || error), now(), id));
    throw error;
  }
}

async function hasSourceMaterial(projectPath: string) {
  async function containsMaterial(directory: string): Promise<boolean> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && await containsMaterial(path.join(directory, entry.name))) return true;
      if (entry.isFile() && !/^readme(?:\.|$)/i.test(entry.name) && entry.name !== '_설명.txt') return true;
    }
    return false;
  }
  for (const folder of ['10_source_original', '20_prior_art']) {
    const base = path.join(projectPath, folder);
    try {
      if (await containsMaterial(base)) return true;
    } catch { /* checked together */ }
  }
  return false;
}

export async function confirmSpecificationSetupStep(id: string, input: { stepKey?: unknown; evidence?: unknown }) {
  const { setup } = getSpecificationSetup(id);
  if (!['created', 'ready'].includes(String(setup.status))) throw new WorkDbError('사건 폴더 생성 후 확인할 수 있습니다.', 409, 'SPEC_SETUP_STATE');
  const stepKey = String(input?.stepKey || '');
  if (!['codex_setup', 'source_materials'].includes(stepKey)) throw new WorkDbError('확인 가능한 사용자 단계가 아닙니다.', 400, 'SPEC_STEP_INVALID');
  const evidence = required(input?.evidence, '확인 근거', 1000);
  if (stepKey === 'source_materials') {
    const folder = path.join(await verifiedRoot(), String(setup.projectName));
    if (!(await hasSourceMaterial(folder))) throw new WorkDbError('10_source_original 또는 20_prior_art에 README 외의 실제 자료를 먼저 넣으세요.', 409, 'SPEC_SOURCE_MISSING');
  }
  const at = now();
  withDatabase((db) => transaction(db, () => {
    db.prepare(`UPDATE specification_setup_step SET status='confirmed',confirmed_at=?,evidence_type='user_confirmation',evidence_ref=?,updated_at=? WHERE setup_id=? AND step_key=?`).run(at, evidence, at, id, stepKey);
    event(db, id, `${stepKey}_confirmed`, '사용자', { evidence });
    db.prepare('UPDATE specification_setup SET row_version=row_version+1,updated_at=? WHERE id=?').run(at, id);
  }));
  return getSpecificationSetup(id);
}

export async function verifySpecificationSetup(id: string, input: { taskTitle?: unknown; externalTaskId?: unknown }) {
  const { setup, steps } = getSpecificationSetup(id);
  const confirmed = new Set(steps.filter((step) => step.status === 'confirmed').map((step) => step.key));
  if (!confirmed.has('codex_setup') || !confirmed.has('source_materials')) throw new WorkDbError('Codex 프로젝트 설정과 발명 자료 배치를 먼저 확인하세요.', 409, 'SPEC_SETUP_INCOMPLETE');
  const taskTitle = required(input?.taskTitle, '첫 작업 제목', 200);
  const externalTaskId = optional(input?.externalTaskId, 200);
  const project = await getSpecificationProject(projectId(String(setup.projectName)));
  if (!project.case || project.case.is_template) throw new WorkDbError('초기화된 case.yaml을 확인할 수 없습니다.', 409, 'SPEC_CASE_UNVERIFIED');
  const at = now();
  withDatabase((db) => transaction(db, () => {
    db.prepare(`UPDATE specification_setup_step SET status='confirmed',confirmed_at=?,evidence_type='task_link',evidence_ref=?,updated_at=? WHERE setup_id=? AND step_key='intake_start'`)
      .run(at, JSON.stringify({ taskTitle, externalTaskId }), at, id);
    db.prepare(`UPDATE specification_setup SET status='ready',last_error=NULL,row_version=row_version+1,updated_at=? WHERE id=?`).run(at, id);
    event(db, id, 'intake_started', '사용자', { taskTitle, externalTaskId });
  }));
  return getSpecificationSetup(id);
}

function latestSetupForProject(name: string) {
  return withDatabase((db) => {
    const row = db.prepare('SELECT * FROM specification_setup WHERE project_name=? ORDER BY updated_at DESC LIMIT 1').get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    const steps = db.prepare('SELECT * FROM specification_setup_step WHERE setup_id=? ORDER BY rowid').all(String(row.id)) as Array<Record<string, unknown>>;
    return { setup: setupRow(row), steps: steps.map(stepRow) };
  });
}

async function projectSummary(directory: { name: string; fullPath: string }) {
  const parsed = await readSmallJson<CaseFile>(path.join(directory.fullPath, 'case.yaml'));
  const caseFile = parsed.value;
  const linked = Boolean(caseFile && caseFile.is_template === false && caseFile.case_id);
  const stageNumber = linked ? specificationStageNumber(caseFile?.stage) : 1;
  const completed = linked && caseFile?.status === 'completed' && caseFile?.stage === 'final';
  const setup = latestSetupForProject(directory.name);
  const userAction = Boolean(setup?.steps.some((step) => step.actor === '사용자' && step.status !== 'confirmed')) || caseFile?.status === 'needs_input' || caseFile?.status === 'needs_review';
  return {
    id: projectId(directory.name), name: directory.name, caseId: caseFile?.case_id ?? null,
    serviceType: caseFile?.service_type ?? null, inventionType: caseFile?.invention_type ?? null,
    stage: caseFile?.stage ?? null, stageNumber, status: caseFile?.status ?? 'unlinked',
    linked, compatibility: linked ? 'harness' : parsed.error ? 'invalid' : 'legacy_unlinked',
    compatibilityLabel: linked ? '하네스 연결' : parsed.error ? 'case.yaml 확인 필요' : '하네스 상태 미연결',
    held: !linked || Boolean(parsed.error), completed, userAction, nextAction: caseFile?.next_action ?? (linked ? null : '기존 사건은 읽기 전용입니다. 하네스 연결 여부를 검토하세요.'),
    updatedAt: caseFile?.updated_at ?? null, setupStatus: setup?.setup.status ?? null,
  };
}

export async function listSpecificationProjects(filters: { q?: unknown; serviceType?: unknown; stage?: unknown; userAction?: unknown } = {}) {
  const q = String(filters.q || '').trim().toLocaleLowerCase('ko');
  const serviceType = String(filters.serviceType || '');
  const stage = String(filters.stage || '');
  const userOnly = String(filters.userAction || '') === 'true';
  const projects = await Promise.all((await safeProjectDirectories()).map(projectSummary));
  return { root: rootPath(), projects: projects.filter((project) => (!q || `${project.name} ${project.caseId || ''}`.toLocaleLowerCase('ko').includes(q)) && (!serviceType || project.serviceType === serviceType) && (!stage || project.stage === stage) && (!userOnly || project.userAction)).sort((a, b) => a.name.localeCompare(b.name, 'ko')) };
}

export async function getSpecificationSummary() {
  const { projects } = await listSpecificationProjects();
  const setups = listSpecificationSetups(100).setups;
  return {
    total: projects.length,
    active: projects.filter((item) => item.linked && !item.completed && !item.held).length,
    onboarding: setups.filter((item) => !['ready', 'cancelled'].includes(String(item.status))).length,
    userAction: projects.filter((item) => item.userAction).length + setups.filter((item) => ['created'].includes(String(item.status))).length,
    held: projects.filter((item) => item.held).length,
    completed: projects.filter((item) => item.completed).length,
  };
}

async function locateProject(id: string) {
  const found = (await safeProjectDirectories()).find((item) => projectId(item.name) === id);
  if (!found) throw new WorkDbError('명세서 프로젝트를 찾을 수 없습니다.', 404, 'SPEC_PROJECT_NOT_FOUND');
  return found;
}

function firstTaskPrompt(projectPath: string, caseFile: CaseFile | null) {
  return `이 사건의 발명 자료 접수를 시작해 주세요.\n\n- 사건 폴더: ${projectPath}\n- 공통 하네스: ${path.join(rootPath(), '_shared')}\n- 사건번호: ${caseFile?.case_id || '미연결'}\n- 서비스: ${caseFile?.service_type || '미확인'}\n- 발명 유형: ${caseFile?.invention_type || '미확인'}\n- 창작 방향: ${caseFile?.creation_direction || '자료 확인 후 결정'}\n\n10_source_original과 20_prior_art의 자료를 보존한 채 목록화하고, 사실·추정·창작·미확인 사항을 구분해 1단계 산출물을 작성해 주세요. 메이킹 사건은 이후 입력 3개 이하, 출력 2개 이하의 입력-처리-출력-기능 흐름으로 구체화하고 dangling 데이터가 없도록 검사합니다.`;
}

export async function getSpecificationProject(id: string) {
  const directory = await locateProject(id);
  const parsed = await readSmallJson<CaseFile>(path.join(directory.fullPath, 'case.yaml'));
  const summary = await projectSummary(directory);
  const current = summary.stageNumber;
  const setup = latestSetupForProject(directory.name);
  const [operations, evidence, claims, decisions, statusText] = await Promise.all([
    readSmallJson<Record<string, unknown>>(path.join(directory.fullPath, '30_analysis', 'operations.json')),
    readSmallJson<Record<string, unknown>>(path.join(directory.fullPath, '30_analysis', 'evidence.json')),
    readSmallJson<Record<string, unknown>>(path.join(directory.fullPath, '40_draft', 'claims.json')),
    readText(path.join(directory.fullPath, 'DECISIONS.md')),
    readText(path.join(directory.fullPath, 'STATUS.md')),
  ]);
  const checks = withDatabase((db) => (db.prepare('SELECT * FROM specification_project_check WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(id) as Array<Record<string, unknown>>).map((row) => ({ id: row.id, stage: row.stage, status: row.status, inputFingerprint: row.input_fingerprint, result: JSON.parse(String(row.result_json)), createdAt: row.created_at })));
  return {
    project: summary, path: directory.fullPath, sharedPath: path.join(rootPath(), '_shared'), case: parsed.value, caseError: parsed.error,
    workflow: specificationStages.map((stage) => ({ ...stage, status: summary.completed || stage.number < current ? '완료' : stage.number === current ? (stage.humanAction ? '사용자 작업 필요' : '현재') : '대기' })),
    onboarding: setup, firstTaskPrompt: firstTaskPrompt(directory.fullPath, parsed.value),
    operations: operations.value, operationsError: operations.error, evidence: evidence.value, evidenceError: evidence.error,
    claims: claims.value, claimsError: claims.error, decisions, statusText,
    latestOutputs: parsed.value?.latest_outputs ?? [], review: parsed.value?.review ?? {}, approvals: parsed.value?.approvals ?? [], checks,
  };
}

async function projectFingerprint(projectPath: string) {
  const files = ['case.yaml', '30_analysis/operations.json', '30_analysis/evidence.json', '40_draft/claims.json'];
  const rows: string[] = [];
  for (const relative of files) {
    const file = path.join(projectPath, ...relative.split('/'));
    try { rows.push(`${relative}:${sha(await readFile(file))}`); } catch { rows.push(`${relative}:missing`); }
  }
  return sha(rows.join('\n'));
}

export async function runSpecificationCheck(id: string) {
  const directory = await locateProject(id);
  const parsed = await readSmallJson<CaseFile>(path.join(directory.fullPath, 'case.yaml'));
  if (!parsed.value || parsed.value.is_template !== false) throw new WorkDbError('하네스에 연결되지 않은 기존 사건은 자동 검사하지 않습니다.', 409, 'SPEC_PROJECT_UNLINKED');
  const stage = String(parsed.value.stage || 'intake');
  if (!SPECIFICATION_STAGE_KEYS.includes(stage as any)) throw new WorkDbError('case.yaml의 단계 값이 올바르지 않습니다.', 409, 'SPEC_STAGE_INVALID');
  const fingerprint = await projectFingerprint(directory.fullPath);
  const result = await runHarness(['check', '--case', directory.fullPath, '--stage', stage, '--shared', path.join(rootPath(), '_shared')], true);
  const status = result.ok === true ? 'passed' : result.error ? 'error' : 'failed';
  const record = { id: randomUUID(), projectId: id, projectRelativePath: directory.name, toolVersion: 'harness-1.0', stage, status, inputFingerprint: fingerprint, result, createdAt: now() };
  withDatabase((db) => db.prepare(`INSERT INTO specification_project_check(id,project_id,project_relative_path,tool_version,stage,status,input_fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(record.id, id, directory.name, record.toolVersion, stage, status, fingerprint, JSON.stringify(result), record.createdAt));
  return record;
}

export function listSpecificationChecks(id: string) {
  return withDatabase((db) => ({ checks: (db.prepare('SELECT * FROM specification_project_check WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(id) as Array<Record<string, unknown>>).map((row) => ({ id: row.id, stage: row.stage, status: row.status, inputFingerprint: row.input_fingerprint, result: JSON.parse(String(row.result_json)), createdAt: row.created_at })) }));
}
