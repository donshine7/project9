import os from 'node:os';
import path from 'node:path';

export const RUNTIME_PROFILES = ['operational', 'development', 'eval', 'test'] as const;
export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];
export type RuntimeEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

const OPERATIONAL_NOTICE_ROOT = String.raw`C:\ChatGPT\AI-Work\10_특허\한국특허중간사건대응`;
const OPERATIONAL_SPEC_ROOT = String.raw`C:\ChatGPT\AI-Work\10_특허\한국특허명세서작성`;
const OPERATIONAL_PROVISIONAL_ROOT = String.raw`C:\ChatGPT\AI-Work\10_특허\한국특허가출원`;
const OPERATIONAL_WIKI_ROOT = String.raw`C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_Wiki`;

export class RuntimeEnvironmentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'RuntimeEnvironmentError';
  }
}

function localAppData(env: RuntimeEnvironment) {
  return env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

export function operationalDatabasePath(env: RuntimeEnvironment = process.env) {
  return path.join(localAppData(env), 'SSPAT', 'work-management', 'sspat-work.db');
}

function normalized(candidate: string) {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function pathIsInside(root: string, candidate: string) {
  const relative = path.relative(normalized(root), normalized(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function requiredPath(env: RuntimeEnvironment, name: string) {
  const value = String(env[name] ?? '').trim();
  if (!value) {
    throw new RuntimeEnvironmentError(`${name} 환경 변수를 명시해야 합니다.`, 'RUNTIME_PATH_REQUIRED');
  }
  return path.resolve(value);
}

export function runtimeProfile(env: RuntimeEnvironment = process.env): RuntimeProfile {
  const raw = String(env.SSPAT_RUNTIME_PROFILE ?? '').trim().toLowerCase();
  if (raw) {
    if (!RUNTIME_PROFILES.includes(raw as RuntimeProfile)) {
      throw new RuntimeEnvironmentError(
        `SSPAT_RUNTIME_PROFILE은 ${RUNTIME_PROFILES.join(', ')} 중 하나여야 합니다.`,
        'RUNTIME_PROFILE_INVALID',
      );
    }
    return raw as RuntimeProfile;
  }

  const explicitDatabase = String(env.SSPAT_WORK_DB_PATH ?? '').trim();
  if (explicitDatabase && pathIsInside(os.tmpdir(), explicitDatabase)) return 'test';

  throw new RuntimeEnvironmentError(
    'SSPAT_RUNTIME_PROFILE이 없습니다. 운영 실행은 operational을, 개발·평가는 격리 프로필을 명시하세요.',
    'RUNTIME_PROFILE_REQUIRED',
  );
}

function isolatedRoot(env: RuntimeEnvironment, databaseFile?: string) {
  const explicit = String(env.SSPAT_ISOLATED_ROOT ?? '').trim();
  if (explicit) return path.resolve(explicit);
  if (databaseFile && pathIsInside(os.tmpdir(), databaseFile)) return path.dirname(path.resolve(databaseFile));
  throw new RuntimeEnvironmentError(
    '격리 프로필에는 SSPAT_ISOLATED_ROOT를 명시해야 합니다.',
    'RUNTIME_ISOLATED_ROOT_REQUIRED',
  );
}

function assertIsolatedPath(
  env: RuntimeEnvironment,
  variableName: string,
  candidate: string,
  protectedRoot?: string,
  databaseFile?: string,
) {
  const root = isolatedRoot(env, databaseFile);
  if (!pathIsInside(root, candidate)) {
    throw new RuntimeEnvironmentError(
      `${variableName} 경로는 SSPAT_ISOLATED_ROOT 안에 있어야 합니다.`,
      'RUNTIME_PATH_OUTSIDE_ISOLATED_ROOT',
    );
  }
  if (protectedRoot && pathIsInside(protectedRoot, candidate)) {
    throw new RuntimeEnvironmentError(
      `${variableName} 경로가 보호된 운영 경로를 가리킵니다.`,
      'RUNTIME_OPERATIONAL_PATH_BLOCKED',
    );
  }
  return candidate;
}

export function resolveDatabasePath(env: RuntimeEnvironment = process.env) {
  const profile = runtimeProfile(env);
  if (profile === 'operational') {
    const configured = String(env.SSPAT_WORK_DB_PATH ?? '').trim();
    return configured ? path.resolve(configured) : operationalDatabasePath(env);
  }

  const candidate = requiredPath(env, 'SSPAT_WORK_DB_PATH');
  const operational = operationalDatabasePath(env);
  if (normalized(candidate) === normalized(operational)) {
    throw new RuntimeEnvironmentError(
      '격리 프로필은 운영 DB를 사용할 수 없습니다.',
      'RUNTIME_OPERATIONAL_DB_BLOCKED',
    );
  }
  return assertIsolatedPath(env, 'SSPAT_WORK_DB_PATH', candidate, path.dirname(operational), candidate);
}

function resolveDataPath(
  env: RuntimeEnvironment,
  variableName: string,
  operationalDefault: string,
) {
  const profile = runtimeProfile(env);
  const configured = String(env[variableName] ?? '').trim();
  if (profile === 'operational') return path.resolve(configured || operationalDefault);
  const candidate = requiredPath(env, variableName);
  const databaseFile = requiredPath(env, 'SSPAT_WORK_DB_PATH');
  return assertIsolatedPath(env, variableName, candidate, operationalDefault, databaseFile);
}

export function resolveWikiVaultPath(env: RuntimeEnvironment = process.env) {
  return resolveDataPath(env, 'SSPAT_WIKI_VAULT_PATH', OPERATIONAL_WIKI_ROOT);
}

export function resolveNoticeProjectRoot(env: RuntimeEnvironment = process.env) {
  return resolveDataPath(env, 'SSPAT_NOTICE_PROJECT_ROOT', OPERATIONAL_NOTICE_ROOT);
}

export function resolveSpecificationProjectRoot(env: RuntimeEnvironment = process.env) {
  return resolveDataPath(env, 'SSPAT_SPEC_PROJECT_ROOT', OPERATIONAL_SPEC_ROOT);
}

export function resolveProvisionalProjectRoot(env: RuntimeEnvironment = process.env) {
  return resolveDataPath(env, 'SSPAT_PROVISIONAL_PROJECT_ROOT', OPERATIONAL_PROVISIONAL_ROOT);
}

export function assertOperationalToolAccess(toolName: string, env: RuntimeEnvironment = process.env) {
  if (runtimeProfile(env) !== 'operational') {
    throw new RuntimeEnvironmentError(
      `${toolName}은(는) operational 프로필에서만 실행할 수 있습니다.`,
      'RUNTIME_EXTERNAL_TOOL_BLOCKED',
    );
  }
}

export function runtimeEnvironmentStatus(env: RuntimeEnvironment = process.env) {
  const profile = runtimeProfile(env);
  const database = resolveDatabasePath(env);
  return {
    profile,
    isolated: profile !== 'operational',
    isolatedRoot: profile === 'operational' ? null : isolatedRoot(env, database),
    databasePath: database,
    wikiVaultPath: resolveWikiVaultPath(env),
  };
}
