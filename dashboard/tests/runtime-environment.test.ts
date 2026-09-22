import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  operationalDatabasePath,
  assertOperationalToolAccess,
  resolveDatabasePath,
  resolveNoticeProjectRoot,
  resolveProvisionalProjectRoot,
  resolveSpecificationProjectRoot,
  resolveWikiVaultPath,
  runtimeEnvironmentStatus,
  runtimeProfile,
} from '../lib/runtime-environment';

function hasCode(code: string) {
  return (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

const isolatedRoot = path.join(os.tmpdir(), 'sspat-env-contract', 'run-001');
const isolatedEnvironment = {
  SSPAT_RUNTIME_PROFILE: 'eval',
  SSPAT_ISOLATED_ROOT: isolatedRoot,
  SSPAT_WORK_DB_PATH: path.join(isolatedRoot, 'db', 'work.db'),
  SSPAT_WIKI_VAULT_PATH: path.join(isolatedRoot, 'vault'),
  SSPAT_NOTICE_PROJECT_ROOT: path.join(isolatedRoot, 'cases', 'notice'),
  SSPAT_SPEC_PROJECT_ROOT: path.join(isolatedRoot, 'cases', 'specification'),
  SSPAT_PROVISIONAL_PROJECT_ROOT: path.join(isolatedRoot, 'cases', 'provisional'),
};

assert.throws(() => runtimeProfile({}), hasCode('RUNTIME_PROFILE_REQUIRED'));
assert.equal(runtimeProfile({ SSPAT_RUNTIME_PROFILE: 'development' }), 'development');
assert.throws(
  () => runtimeProfile({ SSPAT_RUNTIME_PROFILE: 'unknown' }),
  hasCode('RUNTIME_PROFILE_INVALID'),
);

assert.equal(runtimeProfile({ SSPAT_WORK_DB_PATH: path.join(os.tmpdir(), 'legacy-test.db') }), 'test');
assert.throws(
  () => resolveDatabasePath({ SSPAT_RUNTIME_PROFILE: 'development' }),
  hasCode('RUNTIME_PATH_REQUIRED'),
);

assert.equal(resolveDatabasePath(isolatedEnvironment), path.resolve(isolatedEnvironment.SSPAT_WORK_DB_PATH));
assert.equal(resolveWikiVaultPath(isolatedEnvironment), path.resolve(isolatedEnvironment.SSPAT_WIKI_VAULT_PATH));
assert.equal(resolveNoticeProjectRoot(isolatedEnvironment), path.resolve(isolatedEnvironment.SSPAT_NOTICE_PROJECT_ROOT));
assert.equal(
  resolveSpecificationProjectRoot(isolatedEnvironment),
  path.resolve(isolatedEnvironment.SSPAT_SPEC_PROJECT_ROOT),
);
assert.equal(
  resolveProvisionalProjectRoot(isolatedEnvironment),
  path.resolve(isolatedEnvironment.SSPAT_PROVISIONAL_PROJECT_ROOT),
);
assert.throws(
  () => assertOperationalToolAccess('Outlook', isolatedEnvironment),
  hasCode('RUNTIME_EXTERNAL_TOOL_BLOCKED'),
);
assert.doesNotThrow(() => assertOperationalToolAccess('Outlook', { SSPAT_RUNTIME_PROFILE: 'operational' }));

assert.throws(
  () => resolveDatabasePath({
    ...isolatedEnvironment,
    SSPAT_WORK_DB_PATH: path.join(os.tmpdir(), 'outside-isolated-root', 'work.db'),
  }),
  hasCode('RUNTIME_PATH_OUTSIDE_ISOLATED_ROOT'),
);

const operationalDb = operationalDatabasePath(process.env);
assert.throws(
  () => resolveDatabasePath({
    SSPAT_RUNTIME_PROFILE: 'development',
    SSPAT_ISOLATED_ROOT: path.dirname(operationalDb),
    SSPAT_WORK_DB_PATH: operationalDb,
  }),
  hasCode('RUNTIME_OPERATIONAL_DB_BLOCKED'),
);

assert.throws(
  () => resolveNoticeProjectRoot({
    ...isolatedEnvironment,
    SSPAT_ISOLATED_ROOT: path.parse(process.cwd()).root,
    SSPAT_NOTICE_PROJECT_ROOT: String.raw`C:\ChatGPT\AI-Work\10_특허\한국특허중간사건대응\외주`,
  }),
  hasCode('RUNTIME_OPERATIONAL_PATH_BLOCKED'),
);

const status = runtimeEnvironmentStatus(isolatedEnvironment);
assert.equal(status.profile, 'eval');
assert.equal(status.isolated, true);
assert.equal(status.databasePath, path.resolve(isolatedEnvironment.SSPAT_WORK_DB_PATH));
assert.equal(status.wikiVaultPath, path.resolve(isolatedEnvironment.SSPAT_WIKI_VAULT_PATH));

const operationalStatus = runtimeEnvironmentStatus({
  SSPAT_RUNTIME_PROFILE: 'operational',
  LOCALAPPDATA: path.join(isolatedRoot, 'operational-local-app-data'),
});
assert.equal(operationalStatus.profile, 'operational');
assert.equal(operationalStatus.isolated, false);

console.log('runtime environment contract tests passed');
