import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { stageStatus, workflowStages } from './app/workflow';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve('C:\\ChatGPT\\AI-Work\\10_특허\\한국특허가출원');
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
  const root = path.resolve(PROJECT_ROOT);
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
  const projectPath = path.join(PROJECT_ROOT, projectName);
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
  try {
    const entries = await readdir(PROJECT_ROOT, { withFileTypes: true });
    const candidates = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !EXCLUDED_PROJECT_NAMES.has(entry.name.toLowerCase()));
    const eligible = await Promise.all(candidates.map(async (entry) => ({ entry, eligible: await isProjectStructure(entry.name) })));
    const projects = await Promise.all(eligible.filter((item) => item.eligible).map((item) => projectSummary(item.entry.name)));
    return projects.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  } catch {
    return [];
  }
}

async function isProjectStructure(projectName: string) {
  const projectPath = path.join(PROJECT_ROOT, projectName);
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
  const ptCaseNumbers = [...new Set(rawCases.map((value: unknown) => String(value).trim().toUpperCase()).filter(Boolean))];

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

  const projectPath = path.join(PROJECT_ROOT, validated.projectName);
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'New-PatentProject.ps1');
  if (!isInsideRoot(projectPath) || !scriptPath.endsWith(path.join('scripts', 'New-PatentProject.ps1')) || !(await exists(scriptPath))) {
    return { status: 500, payload: { error: '고정 초기화 스크립트를 찾을 수 없습니다.' } };
  }
  if (await exists(projectPath)) {
    return { status: 409, payload: { error: '동일한 프로젝트 폴더가 이미 존재합니다. 덮어쓰지 않았습니다.' } };
  }

  const dryRun = body?.dryRun === true;
  const destination = path.join(PROJECT_ROOT, validated.projectName);
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
    const isApiRequest = requestUrl.pathname === '/api/projects' || requestUrl.pathname === '/api/projects/init';
    if (isApiRequest && !isLocalRequest(req)) return json(res, 403, { error: 'localhost 요청만 허용됩니다.' });

    if (req.method === 'GET' && requestUrl.pathname === '/api/projects') {
      return json(res, 200, { root: PROJECT_ROOT, projects: await listProjects() });
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
