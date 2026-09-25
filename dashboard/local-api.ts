import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { stageStatus, workflowStages } from './app/workflow';
import { MatterNumberError } from './lib/matter-number';
import {
  assertOperationalToolAccess,
  resolveProvisionalProjectRoot,
  RuntimeEnvironmentError,
} from './lib/runtime-environment';
import {
  archiveAction,
  archiveMatter,
  archiveNote,
  createAction,
  createBackup,
  createMatterGroup,
  createMatter,
  createNote,
  createOrganization,
  createPerson,
  createWorkItem,
  databaseStatus,
  getMatter,
  importOutlookMail,
  listSyncRuns,
  listMatters,
  mailStagingDirectory,
  restoreBackup,
  updateAction,
  updateEntityNote,
  updateGroupType,
  updateMatter,
  updateNote,
  updateOrganizationBusinessType,
  updateWorkItem,
  WorkDbError,
} from './lib/work-db';
import type { OutlookMailRecord } from './lib/work-db';
import { analysisStatus, reviewCandidate } from './lib/analysis';
import { recordAuditFeedback } from './lib/audit-feedback';
import { recordGroupReviewFeedback } from './lib/group-review';
import { addWikiEntry, reviewWiki, wikiDetail, wikiEvidence, wikiIndex } from './lib/wiki';
import {
  scanWikiMarkdownVault,
  wikiMarkdownDetail,
  wikiMarkdownIndex,
  wikiMarkdownScanIssues,
} from './lib/wiki-markdown';
import {
  ingestWikiMarkdownProposal,
  prepareWikiMarkdownProposal,
  reconcileWikiMarkdownProposal,
  reviewWikiMarkdownProposal,
  wikiMarkdownProposalDetail,
} from './lib/wiki-proposal';
import { wikiReviewDocument, wikiReviewIndex } from './lib/wiki-review';
import { runLegacyWikiMigrationDryRun, wikiMigrationRun } from './lib/wiki-migration';
import {
  completeWorkRefreshStage,
  createWorkRefresh,
  failWorkRefreshStage,
  finalizeWorkRefresh,
  getWorkRefresh,
  listWorkRefreshes,
  recordWorkRefreshResult,
  setWorkRefreshStageInputCount,
  startWorkRefreshStage,
} from './lib/work-refresh';
import {
  createNoticeProject,
  getDownloadJobEvents,
  getDownloadNotice,
  getDownloadSummary,
  listDetectionRuns,
  listDownloadNotices,
  linkExistingNoticeProject,
  previewNoticeProject,
  requestJobResume,
  requestNoticeOperation,
} from './lib/notice-downloads';
import {
  completeResponseStage,
  getResponseProject,
  getResponseSummary,
  linkResponseTask,
  listResponseProjects,
  reconcileResponseProject,
  recordResponseApproval,
} from './lib/notice-response-projects';
import {
  confirmSpecificationSetupStep,
  createSpecificationSetup,
  getSpecificationProject,
  getSpecificationSetup,
  getSpecificationSummary,
  initializeSpecificationSetup,
  listSpecificationChecks,
  listSpecificationProjects,
  listSpecificationSetups,
  previewSpecificationSetup,
  runSpecificationCheck,
  verifySpecificationSetup,
} from './lib/specification-projects';

const execFileAsync = promisify(execFile);
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 _-]{1,79}$/;
const PT_PATTERN = /^PT\d{6}(?:-[A-Z0-9]+)*$/i;
const EXCLUDED_PROJECT_NAMES = new Set(['_shared', '_sample', 'archive', 'archived']);

type ProjectStatusFile = {
  currentStage?: number;
  blocked?: boolean;
  ptCaseNumbers?: string[];
  updatedAt?: string;
};

function json(res: any, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function isInsideRoot(candidate: string) {
  const root = resolveProvisionalProjectRoot();
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

async function exists(candidate: string) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function hasAnyFile(directory: string, extension?: string): Promise<boolean> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && (await hasAnyFile(entryPath, extension))) return true;
      if (entry.isFile() && (!extension || entry.name.toLowerCase().endsWith(extension))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function hasNamedFile(directory: string, matcher: (name: string) => boolean): Promise<boolean> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && (await hasNamedFile(entryPath, matcher))) return true;
      if (entry.isFile() && matcher(entry.name.toLowerCase())) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function inferStage(projectPath: string) {
  const draftRoot = path.join(projectPath, '40_draft');
  const outputRoot = path.join(projectPath, 'outputs');
  const original = await hasAnyFile(path.join(projectPath, '10_source_original'));
  // 초기화 시 생성되는 patent.project.json·harness.lock.json은 메타데이터다.
  // 실제 계약 산출물은 별도의 *contract*.json 또는 project_contract*.json만 인정한다.
  const contract = await hasNamedFile(draftRoot, (name) =>
    name.endsWith('.json') && (/(^|[-_.])contract([-. _]|$)/.test(name) || /^project_contract([-. _]|$)/.test(name)),
  );
  const draft = await hasAnyFile(draftRoot, '.hwpx');
  const audit = await hasNamedFile(draftRoot, (name) => /audit|감사|검사/.test(name) && /\.(json|md|txt|html)$/.test(name));
  const render = await hasNamedFile(outputRoot, (name) => name.endsWith('.pdf') && /render|rendered|검수|output|결과/.test(name));
  const output = await hasAnyFile(outputRoot, '.hwpx');

  if (output) return { currentStage: 13, original, contract, draft, audit, render, output };
  if (render) return { currentStage: 12, original, contract, draft, audit, render, output };
  if (audit) return { currentStage: 11, original, contract, draft, audit, render, output };
  if (draft) return { currentStage: 10, original, contract, draft, audit, render, output };
  if (contract) return { currentStage: 6, original, contract, draft, audit, render, output };
  if (original) return { currentStage: 4, original, contract, draft, audit, render, output };
  return { currentStage: 3, original, contract, draft, audit, render, output };
}

async function projectSummary(projectName: string) {
  const projectPath = path.join(resolveProvisionalProjectRoot(), projectName);
  const status = await readJsonFile<ProjectStatusFile>(path.join(projectPath, 'workflow-status.json'));
  const inferred = await inferStage(projectPath);
  const statusStage = status?.currentStage && status.currentStage >= 1 && status.currentStage <= 13 ? status.currentStage : 0;
  const currentStage = Math.max(statusStage, inferred.currentStage);
  const contract = await readJsonFile<{ ptCaseNumbers?: string[] }>(path.join(projectPath, 'patent.project.json'));
  const ptCaseNumbers = status?.ptCaseNumbers ?? contract?.ptCaseNumbers ?? [];

  return {
    id: projectName,
    name: projectName,
    currentStage,
    blocked: Boolean(status?.blocked),
    statusUpdatedAt: status?.updatedAt ?? null,
    ptCaseNumbers,
    artifacts: inferred,
    stages: workflowStages.map((stage) => ({ ...stage, status: stageStatus(stage.id, currentStage, Boolean(status?.blocked)) })),
  };
}

async function listProjects() {
  const projectRoot = resolveProvisionalProjectRoot();
  try {
    const entries = await readdir(projectRoot, { withFileTypes: true });
    const candidates = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !EXCLUDED_PROJECT_NAMES.has(entry.name.toLowerCase()));
    const eligible = await Promise.all(candidates.map(async (entry) => ({ entry, eligible: await isProjectStructure(entry.name) })));
    const projects = await Promise.all(eligible.filter((item) => item.eligible).map((item) => projectSummary(item.entry.name)));
    return projects.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  } catch {
    return [];
  }
}

async function isProjectStructure(projectName: string) {
  const projectPath = path.join(resolveProvisionalProjectRoot(), projectName);
  return (await exists(path.join(projectPath, 'workflow-status.json')))
    || (await exists(path.join(projectPath, 'patent.project.json')))
    || (await exists(path.join(projectPath, '10_source_original')) && await exists(path.join(projectPath, '40_draft')) && await exists(path.join(projectPath, 'outputs')));
}

async function readBody(req: any, maxBytes = 16 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.from(rawChunk);
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('요청 본문이 너무 큽니다.');
      (error as Error & { code?: string }).code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}

function validateInput(body: any) {
  const projectName = typeof body?.projectName === 'string' ? body.projectName.trim() : '';
  const rawCases = Array.isArray(body?.ptCaseNumbers)
    ? body.ptCaseNumbers
    : typeof body?.ptCaseNumbers === 'string'
      ? body.ptCaseNumbers.split(/[\s,;]+/)
      : [];
  const ptCaseNumbers: string[] = [...new Set<string>(rawCases.map((value: unknown) => String(value).trim().toUpperCase()).filter(Boolean))];

  if (!PROJECT_NAME_PATTERN.test(projectName) || projectName.includes('..')) {
    return { error: '프로젝트명은 2~80자의 한글·영문·숫자·공백·하이픈만 사용할 수 있습니다.' };
  }
  if (!ptCaseNumbers.length || ptCaseNumbers.some((value) => !PT_PATTERN.test(value))) {
    return { error: 'PT 사건번호는 PT + 숫자 6자리 형식이어야 하며, 선택적으로 -S1·-DIV1 같은 접미사를 사용할 수 있습니다.' };
  }
  return { projectName, ptCaseNumbers };
}

async function initializeProject(body: any) {
  const validated = validateInput(body);
  if ('error' in validated) return { status: 400, payload: validated };

  const projectRoot = resolveProvisionalProjectRoot();
  const projectPath = path.join(projectRoot, validated.projectName);
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'New-PatentProject.ps1');
  if (!isInsideRoot(projectPath) || !scriptPath.endsWith(path.join('scripts', 'New-PatentProject.ps1')) || !(await exists(scriptPath))) {
    return { status: 500, payload: { error: '고정 초기화 스크립트를 찾을 수 없습니다.' } };
  }
  if (await exists(projectPath)) {
    return { status: 409, payload: { error: '동일한 프로젝트 폴더가 이미 존재합니다. 덮어쓰지 않았습니다.' } };
  }

  const dryRun = body?.dryRun === true;
  const destination = path.join(projectRoot, validated.projectName);
  if (dryRun) {
    return {
      status: 200,
      payload: { ok: true, dryRun: true, projectName: validated.projectName, ptCaseNumbers: validated.ptCaseNumbers, destination, scriptPath },
    };
  }

  const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  try {
    await execFileAsync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-ProjectName',
        validated.projectName,
        '-PtCaseNumbersCsv',
        validated.ptCaseNumbers.join(','),
      ],
      { cwd: process.cwd(), shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return { status: 201, payload: { ok: true, dryRun: false, projectName: validated.projectName, destination } };
  } catch (error: any) {
    return { status: 500, payload: { error: error?.stderr || error?.message || '프로젝트 초기화에 실패했습니다.' } };
  }
}

export function localApiMiddleware() {
  return async (req: any, res: any, next: any) => {
    if (process.env.NODE_ENV === 'production') return next();
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const isApiRequest = requestUrl.pathname.startsWith('/api/');
    if (isApiRequest && !isLocalRequest(req)) return json(res, 403, { error: 'localhost 요청만 허용됩니다.' });

    const workApiResult = await handleWorkApi(req, requestUrl);
    if (workApiResult) return json(res, workApiResult.status, workApiResult.payload);

    if (req.method === 'GET' && requestUrl.pathname === '/api/projects') {
      return json(res, 200, { root: resolveProvisionalProjectRoot(), projects: await listProjects() });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/projects/init') {
      try {
        const declaredLength = Number(req.headers?.['content-length'] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
          return json(res, 413, { error: '요청 본문이 너무 큽니다.' });
        }
        const result = await initializeProject(await readBody(req));
        return json(res, result.status, result.payload);
      } catch (error: any) {
        if (error?.code === 'PAYLOAD_TOO_LARGE') return json(res, 413, { error: error.message });
        return json(res, 400, { error: '요청 본문이 올바른 JSON이 아닙니다.' });
      }
    }

    return next();
  };
}

async function handleWorkApi(req: any, requestUrl: URL): Promise<{ status: number; payload: unknown } | null> {
  const pathname = requestUrl.pathname;
  const analysisReviewRoute = pathname.match(/^\/api\/analysis\/candidates\/([^/]+)\/review$/);
  const analysisFeedbackRoute = pathname.match(/^\/api\/analysis\/decisions\/([^/]+)\/feedback$/);
  const wikiRoute = pathname.match(/^\/api\/wiki\/(matter|organization|person|group)\/([^/]+)(?:\/(entries))?$/);
  const wikiReviewRoute = pathname.match(/^\/api\/wiki\/drafts\/([^/]+)\/review$/);
  const wikiEvidenceRoute = pathname.match(/^\/api\/wiki\/evidence\/([^/]+)$/);
  const wikiMarkdownDocumentRoute = pathname.match(/^\/api\/wiki-markdown\/documents\/([^/]+)$/);
  const wikiMarkdownProposalPrepareRoute = pathname.match(/^\/api\/wiki-markdown\/documents\/([^/]+)\/proposals\/prepare$/);
  const wikiMarkdownProposalRoute = pathname.match(/^\/api\/wiki-markdown\/proposals\/([^/]+)$/);
  const wikiMarkdownProposalActionRoute = pathname.match(/^\/api\/wiki-markdown\/proposals\/([^/]+)\/(reconcile|reviews)$/);
  const wikiMarkdownScanIssuesRoute = pathname.match(/^\/api\/wiki-markdown\/scans\/([^/]+)\/issues$/);
  const wikiReviewDocumentRoute = pathname.match(/^\/api\/wiki-review\/documents\/([^/]+)$/);
  const wikiMigrationRoute = pathname.match(/^\/api\/wiki-migrations\/([^/]+)$/);
  const matterRoute = pathname.match(/^\/api\/matters\/([^/]+)$/);
  const matterChildRoute = pathname.match(/^\/api\/matters\/([^/]+)\/(work-items|notes|actions)$/);
  const relationRoute = pathname.match(/^\/api\/matters\/([^/]+)\/(organizations|people|groups)$/);
  const entityRoute = pathname.match(/^\/api\/(work-items|notes|actions)\/([^/]+)$/);
  const entityNoteRoute = pathname.match(/^\/api\/(matters|organizations|people|groups)\/([^/]+)\/note$/);
  const groupTypeRoute = pathname.match(/^\/api\/groups\/([^/]+)\/type$/);
  const organizationBusinessTypeRoute = pathname.match(/^\/api\/organizations\/([^/]+)\/business-type$/);
  const workRefreshRoute = pathname.match(/^\/api\/work-refresh\/([^/]+)$/);
  const workRefreshStageCreateRoute = pathname.match(/^\/api\/work-refresh\/([^/]+)\/stages$/);
  const workRefreshStageRoute = pathname.match(/^\/api\/work-refresh\/stages\/([^/]+)$/);
  const workRefreshResultRoute = pathname.match(/^\/api\/work-refresh\/([^/]+)\/results$/);
  const workRefreshFinalizeRoute = pathname.match(/^\/api\/work-refresh\/([^/]+)\/finalize$/);
  const downloadNoticeRoute = pathname.match(/^\/api\/downloads\/notices\/([^/]+)$/);
  const downloadNoticeRecheckRoute = pathname.match(/^\/api\/downloads\/notices\/([^/]+)\/recheck-requests$/);
  const downloadNoticePreviewRoute = pathname.match(/^\/api\/downloads\/notices\/([^/]+)\/project-previews$/);
  const downloadNoticeProjectRoute = pathname.match(/^\/api\/downloads\/notices\/([^/]+)\/projects$/);
  const downloadNoticeProjectLinkRoute = pathname.match(/^\/api\/downloads\/notices\/([^/]+)\/project-links$/);
  const downloadJobEventsRoute = pathname.match(/^\/api\/downloads\/jobs\/([^/]+)\/events$/);
  const downloadJobResumeRoute = pathname.match(/^\/api\/downloads\/jobs\/([^/]+)\/resume-requests$/);
  const responseProjectRoute = pathname.match(/^\/api\/responses\/projects\/([^/]+)$/);
  const responseReconcileRoute = pathname.match(/^\/api\/responses\/projects\/([^/]+)\/reconcile$/);
  const responseStageRoute = pathname.match(/^\/api\/responses\/projects\/([^/]+)\/stages\/(\d+)\/complete$/);
  const responseApprovalRoute = pathname.match(/^\/api\/responses\/projects\/([^/]+)\/approvals$/);
  const responseTaskRoute = pathname.match(/^\/api\/responses\/projects\/([^/]+)\/task-links$/);
  const specificationProjectRoute = pathname.match(/^\/api\/specifications\/projects\/([^/]+)$/);
  const specificationCheckRoute = pathname.match(/^\/api\/specifications\/projects\/([^/]+)\/checks$/);
  const specificationSetupRoute = pathname.match(/^\/api\/specifications\/setups\/([^/]+)$/);
  const specificationSetupActionRoute = pathname.match(/^\/api\/specifications\/setups\/([^/]+)\/(preview|initialize|confirm|verify)$/);
  const relevant = pathname === '/api/work-db/status'
    || pathname === '/api/work-db/backup'
    || pathname === '/api/work-db/restore'
    || pathname === '/api/matters'
    || pathname === '/api/mail-sync'
    || pathname === '/api/work-refresh'
    || pathname === '/api/analysis'
    || pathname === '/api/analysis/group-feedback'
    || pathname === '/api/downloads/summary'
    || pathname === '/api/downloads/runs'
    || pathname === '/api/downloads/notices'
    || pathname === '/api/responses/summary'
    || pathname === '/api/responses/projects'
    || pathname === '/api/specifications/summary'
    || pathname === '/api/specifications/projects'
    || pathname === '/api/specifications/setups'
    || Boolean(analysisReviewRoute)
    || Boolean(analysisFeedbackRoute)
    || pathname === '/api/wiki'
    || pathname === '/api/wiki-markdown'
    || pathname === '/api/wiki-markdown/scans'
    || pathname === '/api/wiki-markdown/proposals'
    || pathname === '/api/wiki-review'
    || pathname === '/api/wiki-migrations/legacy-dry-runs'
    || Boolean(wikiRoute || wikiReviewRoute || wikiEvidenceRoute)
    || Boolean(wikiMarkdownDocumentRoute || wikiMarkdownProposalPrepareRoute || wikiMarkdownProposalRoute || wikiMarkdownProposalActionRoute || wikiMarkdownScanIssuesRoute || wikiReviewDocumentRoute || wikiMigrationRoute)
    || Boolean(workRefreshRoute || workRefreshStageCreateRoute || workRefreshStageRoute || workRefreshResultRoute || workRefreshFinalizeRoute)
    || Boolean(downloadNoticeRoute || downloadNoticeRecheckRoute || downloadNoticePreviewRoute || downloadNoticeProjectRoute || downloadNoticeProjectLinkRoute || downloadJobEventsRoute || downloadJobResumeRoute)
    || Boolean(responseProjectRoute || responseReconcileRoute || responseStageRoute || responseApprovalRoute || responseTaskRoute)
    || Boolean(specificationProjectRoute || specificationCheckRoute || specificationSetupRoute || specificationSetupActionRoute)
    || Boolean(matterRoute || matterChildRoute || relationRoute || entityRoute || entityNoteRoute || groupTypeRoute || organizationBusinessTypeRoute);
  if (!relevant) return null;

  try {
    if (req.method === 'GET' && pathname === '/api/specifications/summary') return { status: 200, payload: await getSpecificationSummary() };
    if (req.method === 'GET' && pathname === '/api/specifications/projects') return { status: 200, payload: await listSpecificationProjects({ q: requestUrl.searchParams.get('q'), serviceType: requestUrl.searchParams.get('serviceType'), stage: requestUrl.searchParams.get('stage'), userAction: requestUrl.searchParams.get('userAction') }) };
    if (req.method === 'GET' && pathname === '/api/specifications/setups') return { status: 200, payload: listSpecificationSetups(requestUrl.searchParams.get('limit')) };
    if (req.method === 'POST' && pathname === '/api/specifications/setups') return { status: 201, payload: createSpecificationSetup(await readBody(req, 32 * 1024)) };
    if (req.method === 'GET' && specificationProjectRoute && !specificationCheckRoute) return { status: 200, payload: await getSpecificationProject(decodeURIComponent(specificationProjectRoute[1])) };
    if (req.method === 'GET' && specificationCheckRoute) return { status: 200, payload: listSpecificationChecks(decodeURIComponent(specificationCheckRoute[1])) };
    if (req.method === 'POST' && specificationCheckRoute) return { status: 201, payload: await runSpecificationCheck(decodeURIComponent(specificationCheckRoute[1])) };
    if (req.method === 'GET' && specificationSetupRoute && !specificationSetupActionRoute) return { status: 200, payload: getSpecificationSetup(decodeURIComponent(specificationSetupRoute[1])) };
    if (req.method === 'POST' && specificationSetupActionRoute) {
      const setupId = decodeURIComponent(specificationSetupActionRoute[1]);
      const action = specificationSetupActionRoute[2];
      if (action === 'preview') return { status: 200, payload: await previewSpecificationSetup(setupId) };
      if (action === 'initialize') return { status: 201, payload: await initializeSpecificationSetup(setupId, await readBody(req, 16 * 1024)) };
      if (action === 'confirm') return { status: 200, payload: await confirmSpecificationSetupStep(setupId, await readBody(req, 16 * 1024)) };
      return { status: 200, payload: await verifySpecificationSetup(setupId, await readBody(req, 16 * 1024)) };
    }
    if (req.method === 'GET' && pathname === '/api/downloads/summary') return { status: 200, payload: getDownloadSummary() };
    if (req.method === 'GET' && pathname === '/api/downloads/runs') return { status: 200, payload: { runs: listDetectionRuns(requestUrl.searchParams.get('limit') ?? 20) } };
    if (req.method === 'GET' && pathname === '/api/downloads/notices') {
      return { status: 200, payload: listDownloadNotices({ q: requestUrl.searchParams.get('q'), kind: requestUrl.searchParams.get('kind'), status: requestUrl.searchParams.get('status'), limit: requestUrl.searchParams.get('limit'), offset: requestUrl.searchParams.get('offset') }) };
    }
    if (req.method === 'GET' && downloadNoticeRoute) return { status: 200, payload: getDownloadNotice(decodeURIComponent(downloadNoticeRoute[1])) };
    if (req.method === 'GET' && downloadJobEventsRoute) return { status: 200, payload: { events: getDownloadJobEvents(decodeURIComponent(downloadJobEventsRoute[1])) } };
    if (req.method === 'POST' && downloadNoticeRecheckRoute) return { status: 202, payload: requestNoticeOperation(decodeURIComponent(downloadNoticeRecheckRoute[1]), 'recheck', await readBody(req, 16 * 1024)) };
    if (req.method === 'POST' && downloadJobResumeRoute) return { status: 202, payload: requestJobResume(decodeURIComponent(downloadJobResumeRoute[1]), await readBody(req, 16 * 1024)) };
    if (req.method === 'POST' && downloadNoticePreviewRoute) return { status: 200, payload: await previewNoticeProject(decodeURIComponent(downloadNoticePreviewRoute[1]), await readBody(req, 16 * 1024)) };
    if (req.method === 'POST' && downloadNoticeProjectRoute) return { status: 201, payload: await createNoticeProject(decodeURIComponent(downloadNoticeProjectRoute[1]), await readBody(req, 16 * 1024)) };
    if (req.method === 'POST' && downloadNoticeProjectLinkRoute) return { status: 200, payload: await linkExistingNoticeProject(decodeURIComponent(downloadNoticeProjectLinkRoute[1]), await readBody(req, 16 * 1024)) };
    if (req.method === 'GET' && pathname === '/api/responses/summary') return { status: 200, payload: getResponseSummary() };
    if (req.method === 'GET' && pathname === '/api/responses/projects') {
      return { status: 200, payload: listResponseProjects({ q: requestUrl.searchParams.get('q'), kind: requestUrl.searchParams.get('kind'), stage: requestUrl.searchParams.get('stage'), userAction: requestUrl.searchParams.get('userAction'), limit: requestUrl.searchParams.get('limit'), offset: requestUrl.searchParams.get('offset') }) };
    }
    if (req.method === 'GET' && responseProjectRoute) return { status: 200, payload: getResponseProject(decodeURIComponent(responseProjectRoute[1])) };
    if (req.method === 'POST' && responseReconcileRoute) return { status: 200, payload: await reconcileResponseProject(decodeURIComponent(responseReconcileRoute[1]), await readBody(req, 16 * 1024)) };
    if (req.method === 'POST' && responseStageRoute) return { status: 200, payload: await completeResponseStage(decodeURIComponent(responseStageRoute[1]), responseStageRoute[2], await readBody(req, 16 * 1024)) };
    if (req.method === 'POST' && responseApprovalRoute) return { status: 201, payload: await recordResponseApproval(decodeURIComponent(responseApprovalRoute[1]), await readBody(req, 32 * 1024)) };
    if (req.method === 'POST' && responseTaskRoute) return { status: 201, payload: await linkResponseTask(decodeURIComponent(responseTaskRoute[1]), await readBody(req, 16 * 1024)) };
    if (groupTypeRoute && req.method === 'PATCH') {
      const body = await readBody(req);
      return { status: 200, payload: updateGroupType(decodeURIComponent(groupTypeRoute[1]), body.groupType, body.expectedVersion) };
    }
    if (organizationBusinessTypeRoute && req.method === 'PATCH') {
      const body = await readBody(req);
      return { status: 200, payload: updateOrganizationBusinessType(decodeURIComponent(organizationBusinessTypeRoute[1]), body.businessType, body.expectedVersion) };
    }
    if (req.method === 'GET' && pathname === '/api/wiki') return { status: 200, payload: { entities: wikiIndex(requestUrl.searchParams.get('q') || '') } };
    if (req.method === 'GET' && pathname === '/api/wiki-markdown') return { status: 200, payload: wikiMarkdownIndex() };
    if (req.method === 'GET' && pathname === '/api/wiki-review') return { status: 200, payload: await wikiReviewIndex() };
    if (req.method === 'GET' && wikiReviewDocumentRoute) return { status: 200, payload: await wikiReviewDocument(decodeURIComponent(wikiReviewDocumentRoute[1])) };
    if (req.method === 'POST' && pathname === '/api/wiki-markdown/scans') return { status: 201, payload: await scanWikiMarkdownVault() };
    if (req.method === 'POST' && wikiMarkdownProposalPrepareRoute) return { status: 201, payload: await prepareWikiMarkdownProposal(decodeURIComponent(wikiMarkdownProposalPrepareRoute[1])) };
    if (req.method === 'POST' && pathname === '/api/wiki-markdown/proposals') return { status: 201, payload: await ingestWikiMarkdownProposal(await readBody(req, 3 * 1024 * 1024)) };
    if (req.method === 'GET' && wikiMarkdownProposalRoute && !wikiMarkdownProposalActionRoute) return { status: 200, payload: wikiMarkdownProposalDetail(decodeURIComponent(wikiMarkdownProposalRoute[1])) };
    if (req.method === 'POST' && wikiMarkdownProposalActionRoute) {
      const proposalId = decodeURIComponent(wikiMarkdownProposalActionRoute[1]);
      if (wikiMarkdownProposalActionRoute[2] === 'reconcile') return { status: 200, payload: await reconcileWikiMarkdownProposal(proposalId) };
      const body = await readBody(req, 16 * 1024);
      return { status: 200, payload: await reviewWikiMarkdownProposal(proposalId, body.action, body.expectedVersion, body.reviewer) };
    }
    if (req.method === 'POST' && pathname === '/api/wiki-migrations/legacy-dry-runs') {
      const body = await readBody(req, 16 * 1024);
      return { status: 201, payload: runLegacyWikiMigrationDryRun(body.outputRoot, body.conversionVersion) };
    }
    if (req.method === 'GET' && wikiMigrationRoute) return { status: 200, payload: wikiMigrationRun(decodeURIComponent(wikiMigrationRoute[1])) };
    if (req.method === 'GET' && wikiMarkdownDocumentRoute) return { status: 200, payload: await wikiMarkdownDetail(decodeURIComponent(wikiMarkdownDocumentRoute[1])) };
    if (req.method === 'GET' && wikiMarkdownScanIssuesRoute) return { status: 200, payload: { issues: wikiMarkdownScanIssues(decodeURIComponent(wikiMarkdownScanIssuesRoute[1])) } };
    if (req.method === 'GET' && wikiEvidenceRoute) return { status: 200, payload: wikiEvidence(decodeURIComponent(wikiEvidenceRoute[1])) };
    if (req.method === 'POST' && wikiReviewRoute) {
      const body = await readBody(req, 64 * 1024);
      return { status: 200, payload: reviewWiki(decodeURIComponent(wikiReviewRoute[1]), body.action, body.expectedVersion) };
    }
    if (wikiRoute) {
      if (req.method === 'GET' && !wikiRoute[3]) return { status: 200, payload: wikiDetail(wikiRoute[1], decodeURIComponent(wikiRoute[2])) };
      if (req.method === 'POST' && wikiRoute[3] === 'entries') return { status: 201, payload: addWikiEntry(wikiRoute[1], decodeURIComponent(wikiRoute[2]), await readBody(req, 64 * 1024)) };
    }
    if (req.method === 'GET' && pathname === '/api/analysis') return { status: 200, payload: analysisStatus() };
    if (req.method === 'POST' && pathname === '/api/analysis/group-feedback') {
      const body = await readBody(req, 64 * 1024);
      return { status: 200, payload: recordGroupReviewFeedback(body.runId, body.answers) };
    }
    if (req.method === 'POST' && analysisReviewRoute) return { status: 200, payload: reviewCandidate(decodeURIComponent(analysisReviewRoute[1]), await readBody(req, 64 * 1024)) };
    if (req.method === 'POST' && analysisFeedbackRoute) return { status: 200, payload: recordAuditFeedback(decodeURIComponent(analysisFeedbackRoute[1]), await readBody(req, 64 * 1024)) };
    if (req.method === 'GET' && pathname === '/api/work-db/status') return { status: 200, payload: databaseStatus() };
    if (req.method === 'POST' && pathname === '/api/work-db/backup') return { status: 201, payload: createBackup() };
    if (req.method === 'POST' && pathname === '/api/work-db/restore') {
      const body = await readBody(req, 64 * 1024);
      return { status: 200, payload: restoreBackup(body?.backupFile, body?.confirmation) };
    }
    if (req.method === 'GET' && pathname === '/api/matters') {
      return { status: 200, payload: { matters: listMatters(requestUrl.searchParams.get('q') ?? '') } };
    }
    if (req.method === 'GET' && pathname === '/api/work-refresh') return { status: 200, payload: { runs: listWorkRefreshes(requestUrl.searchParams.get('limit') ?? 20) } };
    if (req.method === 'POST' && pathname === '/api/work-refresh') return { status: 201, payload: createWorkRefresh(await readBody(req, 64 * 1024)) };
    if (req.method === 'GET' && workRefreshRoute) return { status: 200, payload: getWorkRefresh(decodeURIComponent(workRefreshRoute[1])) };
    if (req.method === 'POST' && workRefreshStageCreateRoute) {
      const body = await readBody(req, 64 * 1024);
      return { status: 201, payload: startWorkRefreshStage(decodeURIComponent(workRefreshStageCreateRoute[1]), body.stageKey, body.inputCount) };
    }
    if (req.method === 'PATCH' && workRefreshStageRoute) {
      const body = await readBody(req, 64 * 1024), stageId = decodeURIComponent(workRefreshStageRoute[1]);
      if (body.action === 'complete') return { status: 200, payload: completeWorkRefreshStage(stageId, body) };
      if (body.action === 'fail') return { status: 200, payload: failWorkRefreshStage(stageId, body.errorCode) };
      throw new WorkDbError('단계 처리 동작은 complete 또는 fail이어야 합니다.', 400);
    }
    if (req.method === 'POST' && workRefreshResultRoute) return { status: 201, payload: recordWorkRefreshResult(decodeURIComponent(workRefreshResultRoute[1]), await readBody(req, 64 * 1024)) };
    if (req.method === 'POST' && workRefreshFinalizeRoute) return { status: 200, payload: finalizeWorkRefresh(decodeURIComponent(workRefreshFinalizeRoute[1])) };
    if (req.method === 'GET' && pathname === '/api/mail-sync') return { status: 200, payload: { runs: listSyncRuns() } };
    if (req.method === 'POST' && pathname === '/api/mail-sync') return { status: 200, payload: await syncOutlookMail(await readBody(req, 64 * 1024)) };
    if (req.method === 'POST' && pathname === '/api/matters') {
      return { status: 201, payload: createMatter(await readBody(req, 64 * 1024)) };
    }

    if (matterRoute) {
      const id = decodeURIComponent(matterRoute[1]);
      if (req.method === 'GET') return { status: 200, payload: getMatter(id) };
      const body = await readBody(req, 64 * 1024);
      if (req.method === 'PATCH') return { status: 200, payload: updateMatter(id, body) };
      if (req.method === 'DELETE') return { status: 200, payload: archiveMatter(id, body?.expectedVersion) };
    }

    if (matterChildRoute && req.method === 'POST') {
      const id = decodeURIComponent(matterChildRoute[1]);
      const child = matterChildRoute[2];
      const body = await readBody(req, 64 * 1024);
      if (child === 'work-items') return { status: 201, payload: createWorkItem(id, body) };
      if (child === 'notes') return { status: 201, payload: createNote(id, body?.content) };
      if (child === 'actions') return { status: 201, payload: createAction(id, body) };
    }

    if (relationRoute && req.method === 'POST') {
      const id = decodeURIComponent(relationRoute[1]);
      const body = await readBody(req, 64 * 1024);
      if (relationRoute[2] === 'organizations') return { status: 201, payload: createOrganization(id, body) };
      if (relationRoute[2] === 'people') return { status: 201, payload: createPerson(id, body) };
      return { status: 201, payload: createMatterGroup(id, body) };
    }

    if (entityNoteRoute && req.method === 'PATCH') {
      const entityType = ({ matters: 'matter', organizations: 'organization', people: 'person', groups: 'group' } as const)[entityNoteRoute[1] as 'matters' | 'organizations' | 'people' | 'groups'];
      const body = await readBody(req, 64 * 1024);
      return { status: 200, payload: updateEntityNote(entityType, decodeURIComponent(entityNoteRoute[2]), body?.note, body?.expectedVersion) };
    }

    if (entityRoute) {
      const entity = entityRoute[1];
      const id = decodeURIComponent(entityRoute[2]);
      const body = await readBody(req, 64 * 1024);
      if (req.method === 'PATCH' && entity === 'work-items') return { status: 200, payload: updateWorkItem(id, body) };
      if (req.method === 'PATCH' && entity === 'notes') return { status: 200, payload: updateNote(id, body?.content, body?.expectedVersion) };
      if (req.method === 'DELETE' && entity === 'notes') return { status: 200, payload: archiveNote(id, body?.expectedVersion) };
      if (req.method === 'PATCH' && entity === 'actions') return { status: 200, payload: updateAction(id, body) };
      if (req.method === 'DELETE' && entity === 'actions') return { status: 200, payload: archiveAction(id, body?.expectedVersion) };
    }

    return { status: 405, payload: { error: '허용되지 않은 요청 방식입니다.' } };
  } catch (error: any) {
    if (error?.code === 'PAYLOAD_TOO_LARGE') return { status: 413, payload: { error: error.message } };
    if (error instanceof WorkDbError) return { status: error.status, payload: { error: error.message, code: error.code } };
    if (error instanceof RuntimeEnvironmentError) return { status: 409, payload: { error: error.message, code: error.code } };
    if (error instanceof MatterNumberError) return { status: 400, payload: { error: error.message, code: 'INVALID_MATTER_NUMBER' } };
    if (error instanceof SyntaxError) return { status: 400, payload: { error: '요청 본문이 올바른 JSON이 아닙니다.' } };
    console.error(error);
    return { status: 500, payload: { error: '업무 데이터 처리 중 오류가 발생했습니다.' } };
  }
}

async function syncOutlookMail(body: any) {
  assertOperationalToolAccess('Outlook 메일 수집');
  const requestedAt = new Date().toISOString();
  const mode = ['day', 'week', 'range'].includes(body?.mode) ? body.mode : 'day';
  const to = new Date();
  let from: Date;
  if (mode === 'range') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body?.from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(body?.to || ''))) throw new WorkDbError('기간은 YYYY-MM-DD 형식으로 입력하세요.', 400);
    from = new Date(`${body.from}T00:00:00`);
    const rangeEnd = new Date(`${body.to}T00:00:00`);
    rangeEnd.setDate(rangeEnd.getDate() + 1);
    to.setTime(rangeEnd.getTime());
  } else {
    from = new Date(to);
    from.setDate(from.getDate() - (mode === 'week' ? 7 : 1));
  }
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) throw new WorkDbError('수집 기간이 올바르지 않습니다.', 400);
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) throw new WorkDbError('한 번에 수집할 수 있는 기간은 최대 366일입니다.', 400);

  const stagingRoot = mailStagingDirectory();
  await mkdir(stagingRoot, { recursive: true });
  const outputPath = path.join(stagingRoot, `outlook-${randomUUID()}.json`);
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'Export-OutlookMail.ps1');
  const refresh = createWorkRefresh({ requestChannel: 'dashboard', requestedBy: '장진태', requestedAt, mailWindowFrom: from.toISOString(), mailWindowTo: to.toISOString() });
  const collectionStage = startWorkRefreshStage(refresh.id, 'collection', 0);
  try {
    if (!(await exists(scriptPath))) throw new WorkDbError('Outlook 읽기 스크립트를 찾을 수 없습니다.', 500);
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-From', from.toISOString(), '-To', to.toISOString(), '-OutputPath', outputPath], { cwd: process.cwd(), shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
    const extracted = JSON.parse((await readFile(outputPath, 'utf8')).replace(/^\uFEFF/, '')) as { records?: OutlookMailRecord[]; folders?: string[]; excludedFolders?: string[] };
    const records = Array.isArray(extracted.records) ? extracted.records : [];
    setWorkRefreshStageInputCount(collectionStage.id, records.length);
    const imported = importOutlookMail(records, {
      from: from.toISOString(), to: to.toISOString(), folders: extracted.folders || [],
      workRefreshRunId: refresh.id, workRefreshStageId: collectionStage.id,
    });
    completeWorkRefreshStage(collectionStage.id, { processedCount: imported.received, outputCount: imported.imported, result: { syncId: imported.syncId, folders: extracted.folders || [], excludedFolders: extracted.excludedFolders || [] } });
    return { ...imported, workRefreshRunId: refresh.id, refresh: getWorkRefresh(refresh.id), from: from.toISOString(), to: to.toISOString(), folders: extracted.folders || [], excludedFolders: extracted.excludedFolders || [] };
  } catch (error: any) {
    try { failWorkRefreshStage(collectionStage.id, error?.code || 'OUTLOOK_SYNC_FAILED'); } catch { /* preserve the original collection error */ }
    if (error instanceof WorkDbError) throw error;
    throw new WorkDbError(error?.stderr || error?.message || 'Outlook 메일 수집에 실패했습니다.', 500, 'OUTLOOK_SYNC_FAILED');
  } finally {
    await rm(outputPath, { force: true });
  }
}

function isLocalRequest(req: any) {
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const rawHost = String(req.headers?.host ?? '').toLowerCase().trim();
  const hostHeader = rawHost.startsWith('[::1]') ? '[::1]' : rawHost.split(':')[0];
  if (!allowedHosts.has(hostHeader)) return false;
  const originHeader = req.headers?.origin;
  if (!originHeader) return true;
  try {
    const originHost = new URL(originHeader).hostname.toLowerCase();
    return allowedHosts.has(originHost);
  } catch {
    return false;
  }
}
